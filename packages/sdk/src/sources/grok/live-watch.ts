/**
 * GrokLiveWatch — Plane 2 (live disk ingest) for Grok (RFC 006 / M6 A6).
 *
 * Sibling of `CodexLiveWatch`. Claude's `LiveUpdates` pipeline derives a project
 * slug from the file PATH; Grok can't (its cwd lives in `summary.json`, not the
 * chat_history path shape we key on), so Grok gets a focused watcher:
 *
 *   watcher(sessionsDir) → debounce → for each changed chat_history.jsonl:
 *     incremental read from the last byte offset → writeBatch(grokIngest)
 *     → store.emit(change)
 *
 * `msg_index` is the ABSOLUTE file line index (same convention the cold reader
 * uses), tracked per file in memory — critical because messages upsert on
 * `(session_id, msg_index)`; a divergent live index would leave duplicates after
 * a restart. A file not yet seen in this watch session is picked up from its
 * current on-disk offset on first event: the cold ingest already wrote the
 * existing lines, so live only appends what arrives after start. The per-file
 * `nextIndex` is seeded from the cold-ingested row count so appended rows keep
 * the same absolute indices a cold re-ingest would assign.
 */

import * as path from 'node:path';

import type { FileService } from '../../io/file-service.js';
import type { ErrorSink } from '../../io/error-sink.js';
import type { IngestService } from '../../data/ingest-service.js';
import type { AgentDataStore } from '../../data/agent-data-store.js';
import type { ParsedRow } from '../../live/parsed-row.js';
import type { SessionIndexEntry, SessionsIndex } from '../../types/index.js';
import { createParcelWatcher, createChokidarWatcher, type Watcher, type Unsubscribe } from '../../live/watcher.js';
import type { LiveWatch } from '../../live/live-watch.js';
import { readGrokSessionMeta, encodeGrokSlug } from './reader.js';
import { applyGrokSidecars } from './sidecars.js';

const CHAT_HISTORY_FILE = 'chat_history.jsonl';
const DEBOUNCE_MS = 50;

interface FileState {
  byteOffset: number;
  nextIndex: number;
  slug: string;
  sessionId: string;
}

export interface GrokLiveWatchDeps {
  fileService: FileService;
  sessionsDir: string;
  /** Grok-configured IngestService (sourceId='grok' + grok extractor). */
  ingestService: IngestService;
  /** Shared store — emits reach `api.live`. */
  store: AgentDataStore;
  errorSink: ErrorSink;
}

/** Grok's {@link LiveWatch} — a plain whole-tree watcher (no prewarm scopes). */
export interface GrokLiveWatch extends LiveWatch {
  readonly sourceId: 'grok';
}

function isChatHistory(file: string): boolean {
  return path.basename(file) === CHAT_HISTORY_FILE;
}

export function createGrokLiveWatch(deps: GrokLiveWatchDeps): GrokLiveWatch {
  const state = new Map<string, FileState>();
  const pending = new Set<string>();
  let watcher: Watcher | null = null;
  let unsubscribe: Unsubscribe | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(file: string): void {
    pending.add(file);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = [...pending];
      pending.clear();
      for (const f of batch) void ingestChanged(f);
    }, DEBOUNCE_MS);
  }

  function buildEntry(meta: NonNullable<ReturnType<typeof readGrokSessionMeta>>, file: string): SessionIndexEntry {
    const stats = deps.fileService.getStats(file);
    const iso = stats ? new Date(stats.mtimeMs).toISOString() : (meta.updated ?? '');
    return {
      sessionId: meta.sessionId,
      fullPath: file,
      fileMtime: stats?.mtimeMs ?? 0,
      firstPrompt: meta.title || 'No prompt',
      summary: meta.summary,
      messageCount: 0,
      created: meta.created ?? iso,
      modified: meta.updated ?? iso,
      gitBranch: meta.gitBranch,
      projectPath: meta.cwd,
      isSidechain: false,
    };
  }

  async function ingestChanged(file: string): Promise<void> {
    if (!isChatHistory(file)) return;
    try {
      let st = state.get(file);
      if (!st) {
        const meta = readGrokSessionMeta(deps.fileService, file);
        if (!meta) return;
        const slug = encodeGrokSlug(meta.cwd);
        const entry = buildEntry(meta, file);
        // Was this session already in the DB (cold-ingested)? Only decides whether
        // to announce session.created; NOT the index (see below).
        const existed = deps.store.getSessionMessages(slug, meta.sessionId, 1, 0).total > 0;
        const sessionsIndex: SessionsIndex = { version: 1, originalPath: meta.cwd, entries: [entry] };
        deps.ingestService.onProject(slug, meta.cwd, sessionsIndex);
        deps.ingestService.onSession(slug, entry);

        // Read from byte 0 with absolute msg_index 0 on first event (like Codex):
        // messages upsert on (session_id, msg_index), so re-reading the already
        // cold-ingested lines is idempotent and appended lines get their true
        // absolute index. Seeding from a fingerprint offset + row count would
        // double-offset the indices and duplicate rows.
        st = { byteOffset: 0, nextIndex: 0, slug, sessionId: meta.sessionId };
        state.set(file, st);
        if (!existed) {
          deps.store.emit({
            type: 'session.created',
            seq: 0,
            ts: Date.now(),
            slug,
            sessionId: meta.sessionId,
            entry,
          });
        }
      }

      // Incremental read from the last offset; msg_index = absolute file line.
      const rows: ParsedRow[] = [];
      const res = deps.fileService.readJsonlStreaming<unknown>(
        file,
        (line, idx, byteOffset) => {
          rows.push({
            category: 'message',
            slug: st!.slug,
            sessionId: st!.sessionId,
            message: line as never,
            msgIndex: st!.nextIndex + idx,
            byteOffset,
          });
        },
        { fromBytePosition: st.byteOffset },
      );
      st.byteOffset = res.finalBytePosition;
      st.nextIndex += rows.length;

      if (rows.length > 0) {
        const result = await deps.ingestService.writeBatch(rows);
        for (const change of result.changes) deps.store.emit(change);
      }

      // Re-apply events.jsonl / signals.json after each chat_history delta so
      // timestamps and session tokens stay current while the agent runs.
      try {
        const meta = readGrokSessionMeta(deps.fileService, file);
        applyGrokSidecars(deps.fileService, file, st.sessionId, deps.ingestService.getSessionWriteApi(), {
          fallbackCreated: meta?.created ?? null,
        });
      } catch {
        /* sidecar best-effort */
      }
    } catch (err) {
      deps.errorSink.error(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const onEvents = (events: { type: string; path: string }[]): void => {
    for (const e of events) {
      if ((e.type === 'create' || e.type === 'update') && isChatHistory(e.path)) schedule(e.path);
    }
  };

  return {
    sourceId: 'grok',
    async start(): Promise<void> {
      if (watcher) return;
      watcher = createParcelWatcher();
      try {
        unsubscribe = await watcher.subscribe(deps.sessionsDir, onEvents, { ignore: [], recursive: true });
      } catch {
        // Fall back to chokidar if parcel's native watcher is unavailable.
        watcher = createChokidarWatcher();
        unsubscribe = await watcher.subscribe(deps.sessionsDir, onEvents, { ignore: [], recursive: true });
      }
    },

    async stop(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      if (unsubscribe) {
        await unsubscribe();
        unsubscribe = null;
      }
      watcher = null;
      state.clear();
    },
  };
}
