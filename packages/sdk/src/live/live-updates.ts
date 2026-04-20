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
import type { SqliteService } from '../io/sqlite-service.js';
import type { IngestService } from './../data/ingest-service.js';
import type { AgentDataStore } from './../data/agent-data-store.js';
import type { ChangeTopic, Dispose } from './change-events.js';
import { createIdleMaintenance, type IdleMaintenance } from '../data/idle-maintenance.js';

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
  /**
   * Knobs for the idle-window WAL + FTS5 maintenance loop (RFC 005
   * C5.1). Only consulted when `deps.sqlite` + `deps.dbPath` are set;
   * otherwise idle maintenance is disabled regardless.
   */
  idleMaintenance?: {
    idleMs?: number;
    walCheckpointThresholdBytes?: number;
    ftsMergeChunk?: number;
    checkIntervalMs?: number;
  };
}

export interface LiveUpdates {
  /**
   * Load checkpoints + spawn the writer loop. As of C3.2 this does NOT
   * attach any filesystem watchers — attachment is driven on demand by
   * `prewarm()` / consumer subscriptions hitting `api.live.onChange`.
   * A consumer that calls neither pays zero watcher overhead.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isSaturated(): boolean;

  /**
   * Register interest in a scope. The underlying `~/.claude/` subtree
   * is watched for as long as at least one `prewarm` or subscription
   * holds a ref on it. The returned `Dispose` drops that ref; when the
   * last ref goes away, the watcher detaches.
   *
   * Topics whose category is not yet live-wired in Phase 2/3 (e.g.
   * `task`, `file-history`, `plan`, `settings`) register the ref but
   * defer actual watcher attachment to Phase 5 — `prewarm` still
   * returns a valid Dispose so callers can wire up future-proof
   * subscriptions today.
   */
  prewarm(topic: ChangeTopic): Dispose;

  /**
   * Hook the store into the writer loop's emit path. Called once from
   * `create.ts` after construction. The writer loop already calls
   * `store.emit(change)` — `attachStore` simply retains the reference
   * so future instrumentation (e.g. "skip emit when listenerCount is
   * zero") has a hook. Currently a no-op beyond the reference store;
   * present as a seam the later phases can grow into.
   */
  attachStore(store: AgentDataStore): void;
}

/**
 * Dependencies the orchestrator composes. Passed in so tests can wire
 * up everything with a shared SQLite connection.
 *
 * `sqlite` + `dbPath` are optional but land together: when both are
 * set, `LiveUpdates` constructs an `IdleMaintenance` (RFC 005 C5.1)
 * and ticks it across writer-loop activity. Omitting either disables
 * the idle maintenance loop cleanly — useful for tests that don't
 * care about WAL reclamation and for the engine=rs path where the
 * writer runs inside the native addon.
 */
export interface LiveUpdatesDeps {
  fileService: FileService;
  ingestService: IngestService;
  store: AgentDataStore;
  /** Shared SqliteService for idle WAL + FTS maintenance (RFC 005 C5.1). */
  sqlite?: SqliteService;
  /** Absolute DB path — used to stat the `-wal` sidecar during idle ticks. */
  dbPath?: string;
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

/**
 * Canonical string key for a watch scope (a particular `~/.claude/`
 * subtree). A ref-count map is keyed on these so "sessions in slug
 * foo" and "sessions in slug foo, sessionId bar" collapse onto the
 * same projects/-root watcher in Phase 2/3.
 */
type WatchScopeKey =
  | 'projects' // projects/**: covers session / subagent / tool-result / project-memory / session-index
  | 'todos' // todos/** (flat)
  | 'tasks' // tasks/** (Phase 5)
  | 'file-history' // file-history/** (Phase 5)
  | 'plans' // plans/** (Phase 5)
  | 'settings'; // settings.json + settings.local.json (Phase 5)

/** Per-scope ref-count state. */
interface ScopeState {
  /**
   * Number of live `prewarm` / subscription refs holding this scope.
   * Attach fires on 0 → 1, detach fires on 1 → 0.
   */
  refCount: number;
  /**
   * Live `Unsubscribe` handle for the current watcher attach — unset
   * while the attach is in-flight (pending promise) or the scope is
   * Phase 5-only. Carries the responsibility of tearing down the
   * parcel/chokidar subscription when the ref count drops back to 0.
   */
  unsubscribe: Unsubscribe | null;
  /**
   * In-flight attach promise. Serialised against disposes so a
   * refcount bounce (0 → 1 → 0) during a slow attach cleanly tears
   * down once the attach lands.
   */
  pending: Promise<void> | null;
  /**
   * `true` for scopes whose Phase 2/3 wiring actually attaches a
   * watcher (projects/, todos/). `false` for scopes whose attachment
   * defers to Phase 5 — we still track the ref count so callers can
   * prewarm a future-proof `{ kind: 'task' }` topic today.
   */
  attachable: boolean;
}

/**
 * Map a `ChangeTopic` onto the watch scopes it depends on. Every topic
 * today resolves to exactly one scope, but the return type is an
 * array so a future topic that spans subtrees (e.g. a firehose-ish
 * "all sessions across all projects plus their tool-results") doesn't
 * require a signature change.
 *
 * Note: `project-memory` isn't exposed as a ChangeTopic kind — it's
 * emitted as a lower-level SQLite-only mutation, so there's no
 * caller-facing topic for it. The projects/ scope subsumes it anyway.
 */
function topicToScopes(topic: ChangeTopic): WatchScopeKey[] {
  switch (topic.kind) {
    case 'session':
    case 'subagent':
    case 'tool-result':
      return ['projects'];
    case 'todo':
      return ['todos'];
    case 'task':
      return ['tasks'];
    case 'file-history':
      return ['file-history'];
    case 'plan':
      return ['plans'];
    case 'settings':
      return ['settings'];
  }
}

export function createLiveUpdates(deps: LiveUpdatesDeps, options: LiveUpdatesOptions): LiveUpdates {
  const { fileService, ingestService } = deps;
  let store: AgentDataStore = deps.store;

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
  let writerLoopDone: Promise<void> | null = null;
  /**
   * Idle-window WAL + FTS5 maintenance handle (RFC 005 C5.1). Built
   * only when `deps.sqlite` + `deps.dbPath` are both provided; its
   * lifetime matches the running state of the pipeline.
   */
  let idleMaintenance: IdleMaintenance | null = null;

  /** Per-scope ref-count + attachment state (RFC 005 C3.2). */
  const scopes = new Map<WatchScopeKey, ScopeState>();

  /**
   * Which scopes Phase 2/3 wires to real watchers. TODO(RFC 005 phase
   * 5): add `'tasks'`, `'file-history'`, `'plans'`, and `'settings'`
   * once each category has a router + incremental parser landing.
   */
  const ATTACHABLE_SCOPES: ReadonlySet<WatchScopeKey> = new Set(['projects', 'todos']);

  /** Subpath under claudeDir for each attachable scope. */
  const SCOPE_SUBPATH: Record<WatchScopeKey, string> = {
    projects: 'projects',
    todos: 'todos',
    tasks: 'tasks',
    'file-history': 'file-history',
    plans: 'plans',
    settings: '.',
  };

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
        // Reset the idle deadline on every successful batch — a
        // steady stream of live appends keeps the pipeline "active"
        // and pushes the WAL/FTS maintenance pass out of the hot
        // path. (No-op when idle maintenance is disabled.)
        idleMaintenance?.noteActivity();
        for (const change of result.changes) {
          // As of C3.1, `store.emit()` stamps the change's seq and
          // fans out through the subscriber registry. `attachStore`
          // (C3.2) is how `create.ts` hands us the canonical store
          // reference; we call that instance here.
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

  // ── scope ref-count + attach/detach ────────────────────────────────────

  function getOrCreateScope(scope: WatchScopeKey): ScopeState {
    let state = scopes.get(scope);
    if (!state) {
      state = {
        refCount: 0,
        unsubscribe: null,
        pending: null,
        attachable: ATTACHABLE_SCOPES.has(scope),
      };
      scopes.set(scope, state);
    }
    return state;
  }

  async function attachScope(scope: WatchScopeKey, state: ScopeState): Promise<void> {
    if (!watcher || !state.attachable) return;
    const subPath = SCOPE_SUBPATH[scope];
    const fullPath = path.join(claudeDir, subPath);
    try {
      const unsub = await watcher.subscribe(fullPath, handleWatchEvents, {
        ignore: WATCHER_IGNORE_GLOBS,
        recursive: true,
      });
      // If the refcount dropped back to zero during the attach
      // (prewarm + dispose raced faster than parcel could bind), tear
      // down immediately instead of retaining a watcher nobody wants.
      if (state.refCount === 0) {
        try {
          await unsub();
        } catch {
          /* best-effort */
        }
        return;
      }
      state.unsubscribe = unsub;
    } catch (err) {
      onError(
        err instanceof Error
          ? new Error(`[LiveUpdates] failed to attach watcher on ${scope}/ (${fullPath}): ${err.message}`)
          : new Error(`[LiveUpdates] failed to attach watcher on ${scope}/ (${fullPath}): ${String(err)}`),
      );
    }
  }

  async function detachScope(state: ScopeState): Promise<void> {
    const unsub = state.unsubscribe;
    state.unsubscribe = null;
    if (unsub) {
      try {
        await unsub();
      } catch {
        /* best-effort — watcher may already be torn down */
      }
    }
  }

  /**
   * Bump the ref count for one scope. On 0 → 1 we kick off an attach;
   * the promise is stored on the scope state so `stop()` and the
   * dispose path can serialise against in-flight attaches.
   */
  function acquireScope(scope: WatchScopeKey): void {
    const state = getOrCreateScope(scope);
    state.refCount += 1;
    if (state.refCount !== 1) return;
    if (!state.attachable) return; // Phase 5: just track the ref.
    if (!running || !watcher) return; // start() will attach on its own.
    const pending = attachScope(scope, state).finally(() => {
      if (state.pending === pending) state.pending = null;
    });
    state.pending = pending;
  }

  /**
   * Drop one ref from a scope. On 1 → 0 we detach. Runs async (we
   * return the detach promise via a fire-and-forget pattern — the
   * caller keeps using the sync `Dispose` handle; `stop()` separately
   * awaits any remaining work).
   */
  function releaseScope(scope: WatchScopeKey): void {
    const state = scopes.get(scope);
    if (!state || state.refCount <= 0) return;
    state.refCount -= 1;
    if (state.refCount !== 0) return;
    if (!state.attachable) return;
    // If a pending attach is still in flight, let it see refCount=0
    // and tear itself down. Otherwise detach right now.
    if (state.pending) return;
    void detachScope(state);
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

      // 5. Flip running BEFORE spawning the writer loop so the event
      //    handler sees `running === true` on the very first batch.
      running = true;

      // 6. Start the writer loop (detached — stored for `stop()` await).
      writerLoopDone = writerLoop();

      // 6a. Idle maintenance (RFC 005 C5.1). Only wired up when the
      //     caller supplied a SqliteService + dbPath — otherwise the
      //     handle stays null and noteActivity()/stop() paths no-op.
      if (deps.sqlite && deps.dbPath) {
        idleMaintenance = createIdleMaintenance(
          { sqlite: deps.sqlite, dbPath: deps.dbPath },
          {
            ...(options.idleMaintenance?.idleMs !== undefined && {
              idleMs: options.idleMaintenance.idleMs,
            }),
            ...(options.idleMaintenance?.walCheckpointThresholdBytes !== undefined && {
              walCheckpointThresholdBytes: options.idleMaintenance.walCheckpointThresholdBytes,
            }),
            ...(options.idleMaintenance?.ftsMergeChunk !== undefined && {
              ftsMergeChunk: options.idleMaintenance.ftsMergeChunk,
            }),
            ...(options.idleMaintenance?.checkIntervalMs !== undefined && {
              checkIntervalMs: options.idleMaintenance.checkIntervalMs,
            }),
            onError,
          },
        );
        idleMaintenance.start();
      }

      // C3.2: watchers are NOT attached here. `prewarm()` or a
      //       subscription landing via `api.live.onChange` will
      //       ref-bump the scope and trigger attach. A process that
      //       never calls either pays zero watcher/FS-event overhead.
      //
      // If any scopes were prewarm()'d before start() resolved
      // (exotic, but legal — we accept bumps at any time), bring them
      // online now.
      for (const [scope, state] of scopes) {
        if (state.attachable && state.refCount > 0 && !state.unsubscribe && !state.pending) {
          const pending = attachScope(scope, state).finally(() => {
            if (state.pending === pending) state.pending = null;
          });
          state.pending = pending;
        }
      }
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      // Halt idle maintenance first so a tick racing stop() can't
      // try to run SQL against a DB that's about to close.
      if (idleMaintenance) {
        idleMaintenance.stop();
        idleMaintenance = null;
      }

      // Let any in-flight attaches resolve (so their unsub handles
      // land on state.unsubscribe), then detach every scope. This is
      // the C3.2 equivalent of the old `unsubscribes[]` teardown.
      const pendings = Array.from(scopes.values())
        .map((s) => s.pending)
        .filter((p): p is Promise<void> => p !== null);
      if (pendings.length > 0) {
        try {
          await Promise.all(pendings);
        } catch {
          /* errors already routed via onError during attach */
        }
      }
      for (const state of scopes.values()) {
        await detachScope(state);
      }
      // Leave the ref-count entries in place — callers can re-acquire
      // after a re-start. Just drop the watcher handle.
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

    prewarm(topic: ChangeTopic): Dispose {
      const acquired = topicToScopes(topic);
      for (const scope of acquired) acquireScope(scope);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        for (const scope of acquired) releaseScope(scope);
      };
    },

    attachStore(next: AgentDataStore): void {
      // Retain a reference. The writer loop closes over `store` via
      // the enclosing `let`, so reassignment here is all that's
      // needed for future emits to go through the attached store.
      store = next;
    },
  };
}
