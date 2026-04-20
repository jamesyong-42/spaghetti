/**
 * live-updates.ts — Orchestrator that wires C2.1-C2.6 together.
 *
 * Seventh and final component of RFC 005 Phase 2 (C2.7). Composes the
 * Watcher, CheckpointStore, CoalescingQueue, IncrementalParser, Router,
 * and IngestService.writeBatch into a single end-to-end live-update
 * pipeline keyed on `~/.claude/projects/` and `~/.claude/todos/`.
 *
 * Phase 2 contract: events flow through, SQLite gets updated, but
 * `store.emit()` is still a no-op stub — subscribers don't receive
 * `Change` events until Phase 3 lands `subscriber-registry.ts`. This
 * module is designed so Phase 3 only changes the `store.emit` site,
 * not the pipeline topology.
 *
 * Flow per event:
 *
 *   watcher -> classify(path, claudeDir) -> queue.enqueue(path, reason)
 *     -> queue.drain(windowMs, maxRows) -> parseFileDelta(category,...)
 *     -> ingestService.writeBatch(rows) -> store.emit(change)
 *
 * See `docs/LIVE-UPDATES-DESIGN.md` §2.3 for the full interface and
 * §3.1-§3.2 for the startup + single-append sequence diagrams.
 */

import * as path from 'node:path';

import type { FileService } from '../io/file-service.js';
import type { IngestService } from './../data/ingest-service.js';
import type { AgentDataStore } from './../data/agent-data-store.js';

import { createCheckpointStore, type Checkpoint, type CheckpointStore } from './checkpoints.js';
import { createCoalescingQueue, type CoalescingQueue, type QueuedReason } from './coalescing-queue.js';
import {
  createIncrementalParser,
  type IncrementalParser,
  type ParsedRow,
  type ParsedRowCategory,
} from './incremental-parser.js';
import { classify, type Category, type RouteResult } from './router.js';
import {
  createParcelWatcher,
  createChokidarWatcher,
  type Watcher,
  type WatchEvent,
  type Unsubscribe,
} from './watcher.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface LiveUpdatesOptions {
  claudeDir: string;
  /** Absolute path to the checkpoint JSON. Defaults to `<claudeDir>/.spaghetti-live-state.json`. */
  stateFilePath?: string;
  /** Time-window batching window, ms. Default 75. */
  batchWindowMs?: number;
  /** Hard cap on rows per drain. Default 200. */
  maxBatchRows?: number;
  /** Trailing-edge debounce (append only), ms. Default 30. */
  debounceMs?: number;
  /** Trailing-edge hard flush (append only), ms. Default 200. */
  hardFlushMs?: number;
  /** Saturation detection threshold on the queue, ms. Default 5000. */
  saturationThresholdMs?: number;
  /**
   * Observed error sink. Errors from the watcher (e.g. "directory missing")
   * and from `writeBatch` (e.g. transient SQLite busy) land here; the
   * pipeline keeps running. When unset, errors are swallowed silently.
   */
  onError?: (err: Error) => void;
  /**
   * Watcher factory override — defaults to `createParcelWatcher()`.
   * Tests inject `createChokidarWatcher()` or a custom `Watcher` stub.
   */
  watcherFactory?: () => Watcher;
  /**
   * Force the chokidar fallback without touching env vars. Ignored when
   * `watcherFactory` is set.
   */
  useChokidarFallback?: boolean;
}

export interface LiveUpdates {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isSaturated(): boolean;
}

/**
 * Dependencies the orchestrator composes. Passed in so tests can wire
 * up everything with a shared SQLite connection.
 */
export interface LiveUpdatesDeps {
  fileService: FileService;
  ingestService: IngestService;
  store: AgentDataStore;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_BATCH_WINDOW_MS = 75;
const DEFAULT_MAX_BATCH_ROWS = 200;
const DEFAULT_DEBOUNCE_MS = 30;
const DEFAULT_HARD_FLUSH_MS = 200;
const DEFAULT_SATURATION_THRESHOLD_MS = 5000;

/**
 * Hard-ignore globs handed to the watcher. Mirrors `HARD_IGNORE_SEGMENTS`
 * + `HARD_IGNORE_SUFFIXES` in `router.ts` — the router is the authority
 * but the watcher-side ignores let parcel drop traffic at the source
 * (cheaper than classify-then-reject). The two layers are belt-and-
 * braces on purpose: anything that slips through still hits
 * `classify()` and returns `{ category: 'ignored' }`.
 */
const WATCHER_IGNORE_GLOBS = [
  '**/debug/**',
  '**/telemetry/**',
  '**/paste-cache/**',
  '**/session-env/**',
  '**/*.tmp',
  '**/.DS_Store',
];

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Map a router `Category` onto the parser's `ParsedRowCategory`. The
 * two enums match for every live category except `session` (router
 * says "session", parser says "message"), and the router's
 * `settings` / `settings_local` buckets are Phase 5 and skipped here.
 *
 * Returns `null` for categories the Phase 2 pipeline does not yet
 * handle — those events drop on the floor.
 */
function routerCategoryToParserCategory(category: Category): ParsedRowCategory | null {
  switch (category) {
    case 'session':
      return 'message';
    case 'session_index':
      return 'session_index';
    case 'subagent':
      return 'subagent';
    case 'tool_result':
      return 'tool_result';
    case 'project_memory':
      return 'project_memory';
    case 'file_history':
      return 'file_history';
    case 'todo':
      return 'todo';
    case 'task':
      return 'task';
    case 'plan':
      return 'plan';
    case 'settings':
    case 'settings_local':
    case 'ignored':
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createLiveUpdates(deps: LiveUpdatesDeps, options: LiveUpdatesOptions): LiveUpdates {
  const { fileService, ingestService, store } = deps;

  // ── resolve options with defaults ──────────────────────────────────────
  const claudeDir = options.claudeDir;
  const stateFilePath = options.stateFilePath ?? path.join(claudeDir, '.spaghetti-live-state.json');
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatchRows = options.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const hardFlushMs = options.hardFlushMs ?? DEFAULT_HARD_FLUSH_MS;
  const saturationThresholdMs = options.saturationThresholdMs ?? DEFAULT_SATURATION_THRESHOLD_MS;
  const onError = options.onError ?? (() => {});

  // ── internal state ─────────────────────────────────────────────────────

  let running = false;
  let checkpoints: CheckpointStore | null = null;
  let queue: CoalescingQueue | null = null;
  let parser: IncrementalParser | null = null;
  let watcher: Watcher | null = null;
  const unsubscribes: Unsubscribe[] = [];
  let writerLoopDone: Promise<void> | null = null;

  /**
   * Per-path trailing-edge debounce for `append` events. On every
   * update fsevent we reset the debounce timer; a separate hard-flush
   * timer is set on the first update and fires regardless of further
   * activity so a steady stream of updates can't starve the enqueue.
   */
  type DebounceState = {
    debounceTimer: ReturnType<typeof setTimeout> | null;
    hardFlushTimer: ReturnType<typeof setTimeout> | null;
  };
  const debounceByPath = new Map<string, DebounceState>();

  /**
   * Per-session `msg_index` high-water mark, so successive `update`
   * events on the same session JSONL continue the monotonic row index
   * the cold-start ingest established. Keyed by absolute file path so
   * two sessions in different projects don't collide.
   */
  const nextMsgIndexByPath = new Map<string, number>();

  // ── helpers ────────────────────────────────────────────────────────────

  function clearDebounceForPath(p: string): void {
    const state = debounceByPath.get(p);
    if (!state) return;
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    if (state.hardFlushTimer !== null) clearTimeout(state.hardFlushTimer);
    debounceByPath.delete(p);
  }

  function clearAllDebounces(): void {
    for (const state of debounceByPath.values()) {
      if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
      if (state.hardFlushTimer !== null) clearTimeout(state.hardFlushTimer);
    }
    debounceByPath.clear();
  }

  function enqueueNow(evtPath: string, reason: QueuedReason): void {
    if (!queue) return;
    clearDebounceForPath(evtPath);
    queue.enqueue({ path: evtPath, reason });
  }

  /**
   * Debounce an `append` event: restart the trailing timer on every
   * call; set a one-shot hard-flush timer on the first call so
   * continuous activity can't starve enqueue forever.
   */
  function scheduleDebouncedAppend(evtPath: string): void {
    if (!queue) return;
    let state = debounceByPath.get(evtPath);
    if (!state) {
      state = { debounceTimer: null, hardFlushTimer: null };
      debounceByPath.set(evtPath, state);
    }

    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      const s = debounceByPath.get(evtPath);
      if (!s) return;
      if (s.hardFlushTimer !== null) clearTimeout(s.hardFlushTimer);
      debounceByPath.delete(evtPath);
      if (queue) queue.enqueue({ path: evtPath, reason: 'append' });
    }, debounceMs);
    // Let the debounce timer keep the loop alive so tests awaiting an
    // eventual SQLite write don't return early. Watcher sub is already
    // pinning the loop anyway; this is a no-op in practice.

    if (state.hardFlushTimer === null) {
      state.hardFlushTimer = setTimeout(() => {
        const s = debounceByPath.get(evtPath);
        if (!s) return;
        if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
        debounceByPath.delete(evtPath);
        if (queue) queue.enqueue({ path: evtPath, reason: 'append' });
      }, hardFlushMs);
    }
  }

  // ── watcher event dispatch ─────────────────────────────────────────────

  function handleWatchEvents(events: WatchEvent[]): void {
    if (!running) return;
    for (const event of events) {
      const route: RouteResult = classify(event.path, claudeDir);
      if (route.category === 'ignored') continue;

      // create + delete are rare; enqueue immediately so priority
      // collapse can't strand them behind a debounced append.
      if (event.type === 'delete') {
        enqueueNow(event.path, 'delete');
      } else if (event.type === 'create') {
        enqueueNow(event.path, 'rewrite');
      } else {
        // 'update' → trailing-edge debounced append.
        scheduleDebouncedAppend(event.path);
      }
    }
  }

  // ── writer loop ────────────────────────────────────────────────────────

  async function processEvent(evtPath: string, reason: QueuedReason): Promise<ParsedRow[]> {
    if (!parser || !checkpoints) return [];

    const route = classify(evtPath, claudeDir);
    const parserCategory = routerCategoryToParserCategory(route.category);
    if (!parserCategory) return [];

    // Delete: drop the checkpoint, emit nothing. (Phase 5 may surface
    // this as a `session.rewritten` for JSONL deletes; Phase 2 is
    // ingest-only so we just drop state.)
    if (reason === 'delete') {
      checkpoints.delete(evtPath);
      checkpoints.scheduleFlush();
      nextMsgIndexByPath.delete(evtPath);
      return [];
    }

    const priorCheckpoint: Checkpoint | undefined = checkpoints.get(evtPath);
    const startMsgIndex = nextMsgIndexByPath.get(evtPath) ?? 0;

    const parseResult = await parser.parseFileDelta({
      path: evtPath,
      category: parserCategory,
      slug: route.slug,
      sessionId: route.sessionId,
      checkpoint: priorCheckpoint,
      startMsgIndex,
      claudeDir,
    });

    // Update checkpoint + persisted-index bookkeeping.
    checkpoints.set(evtPath, parseResult.newCheckpoint);
    checkpoints.scheduleFlush();

    // TODO(RFC 005 Phase 5): when `parseResult.rewrite === true` and
    // the category is `message`, the new JSONL may be shorter than
    // the previous one — stale rows for `(session_id, msg_index >= N)`
    // can leak. The writer's upsert-by-`(session_id, msg_index)`
    // correctly overwrites overlapping rows. Truncated rewrites are
    // not yet repaired; Phase 5 adds a targeted DELETE before write.

    if (parserCategory === 'message') {
      if (parseResult.rewrite) {
        nextMsgIndexByPath.set(evtPath, parseResult.rows.length);
      } else {
        nextMsgIndexByPath.set(evtPath, startMsgIndex + parseResult.rows.length);
      }
    }

    return parseResult.rows;
  }

  async function writerLoop(): Promise<void> {
    if (!queue || !parser || !ingestService) return;

    while (running) {
      let batch: Awaited<ReturnType<CoalescingQueue['drain']>>;
      try {
        batch = await queue.drain(maxBatchRows, batchWindowMs);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        continue;
      }

      if (!running) break;
      if (batch.length === 0) continue;

      // Parse each queued event into parsed rows. Parser errors are
      // reported via onError and the event is skipped — the pipeline
      // must not crash on a malformed JSONL.
      const rows: ParsedRow[] = [];
      for (const evt of batch) {
        try {
          const evtRows = await processEvent(evt.path, evt.reason);
          for (const r of evtRows) rows.push(r);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }

      if (rows.length === 0) continue;

      try {
        const result = await ingestService.writeBatch(rows);
        for (const change of result.changes) {
          // Phase 2: store.emit() is a no-op. Phase 3 wires the real
          // subscriber registry; the call-site here is the single
          // seam that changes.
          store.emit(change);
        }
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        // Do NOT advance state beyond what processEvent already set —
        // checkpoints have been persisted for the delta, which is the
        // current contract even on write failure. Retry loop is a
        // Phase 5 concern; Phase 2 just surfaces the error.
      }
    }
  }

  // ── watcher attach helper ──────────────────────────────────────────────

  async function attachWatcher(subPath: string, label: string): Promise<void> {
    if (!watcher) return;
    const fullPath = path.join(claudeDir, subPath);
    try {
      const unsub = await watcher.subscribe(fullPath, handleWatchEvents, {
        ignore: WATCHER_IGNORE_GLOBS,
        recursive: true,
      });
      unsubscribes.push(unsub);
    } catch (err) {
      onError(
        err instanceof Error
          ? new Error(`[LiveUpdates] failed to attach watcher on ${label} (${fullPath}): ${err.message}`)
          : new Error(`[LiveUpdates] failed to attach watcher on ${label} (${fullPath}): ${String(err)}`),
      );
    }
  }

  // ── public surface ─────────────────────────────────────────────────────

  return {
    async start(): Promise<void> {
      if (running) return;

      // 1. Checkpoints (never throw — corrupt/missing state → empty).
      checkpoints = createCheckpointStore({ filePath: stateFilePath });
      await checkpoints.load();

      // 2. Queue.
      queue = createCoalescingQueue({ saturationThresholdMs });

      // 3. Parser (holds a ref to fileService).
      parser = createIncrementalParser({ fileService });

      // 4. Watcher factory.
      if (options.watcherFactory) {
        watcher = options.watcherFactory();
      } else if (options.useChokidarFallback) {
        watcher = createChokidarWatcher();
      } else {
        watcher = createParcelWatcher();
      }

      // 5. Flip running BEFORE attaching watchers so the event handler
      //    sees `running === true` on the very first batch.
      running = true;

      // 6. Start the writer loop (detached — stored for `stop()` await).
      writerLoopDone = writerLoop();

      // 7. Attach watchers eagerly on projects/ and todos/. Phase 3 flips
      //    this to lazy / ref-counted. If a subdir doesn't exist the
      //    watcher factory reports via onError and we continue — an
      //    empty ~/.claude/ must not block start().
      await attachWatcher('projects', 'projects/');
      await attachWatcher('todos', 'todos/');
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      // Unsubscribe from watchers first so no further events enqueue
      // while we drain.
      for (const unsub of unsubscribes) {
        try {
          await unsub();
        } catch {
          /* watcher already torn down — ignore */
        }
      }
      unsubscribes.length = 0;
      watcher = null;

      // Wake the drain loop.
      if (queue) queue.stop();

      // Wait for the writer loop to exit so in-flight writes complete.
      if (writerLoopDone) {
        try {
          await writerLoopDone;
        } catch {
          /* writer errors already surfaced via onError */
        }
        writerLoopDone = null;
      }

      // Force a final checkpoint flush.
      if (checkpoints) {
        try {
          await checkpoints.stop();
        } catch {
          /* best-effort */
        }
        checkpoints = null;
      }

      queue = null;
      parser = null;

      clearAllDebounces();
      nextMsgIndexByPath.clear();
    },

    isRunning(): boolean {
      return running;
    },

    isSaturated(): boolean {
      return queue?.saturated() ?? false;
    },
  };
}
