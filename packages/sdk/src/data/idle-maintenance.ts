/**
 * idle-maintenance.ts — Idle-window WAL + FTS5 maintenance (RFC 005 C5.1).
 *
 * First piece of Phase 5. A background timer owned by `LiveUpdates`
 * that notices when the writer loop has been quiet for long enough and
 * reclaims disk + index overhead accumulated during bursts:
 *
 *   1. `PRAGMA wal_checkpoint(TRUNCATE)` — hand pages from the -wal
 *      sidecar back to the main DB file so the next writer has a
 *      cold-ish starting point. Gated on the -wal file actually being
 *      large enough to bother (default 4 MB); missing WAL sidecar (no
 *      writes since open, or journal_mode ≠ WAL) is a no-op.
 *
 *   2. `INSERT INTO messages_fts(messages_fts) VALUES('merge', N)` —
 *      incremental FTS5 compaction. `merge` walks at most N segment
 *      pages per call so long runs don't stall the DB; defaults to
 *      200 which lines up with SQLite's documented "small chunk"
 *      recommendation.
 *
 *   3. `PRAGMA optimize` — lightweight ANALYZE refresh. SQLite's own
 *      planner recommendation for connections that have done sizable
 *      inserts; safe to fire repeatedly, skips work when the stats are
 *      already current.
 *
 * All three run under a single `try { … } catch` and never throw out of
 * the timer; the worst case is a warn log via `onError`. The pipeline
 * continues either way — maintenance is best-effort by design.
 *
 * See `docs/rfcs/005-live-updates.md` §SQLite & FTS5 Configuration →
 * "Idle maintenance" and `docs/LIVE-UPDATES-DESIGN.md` §7 (Phase 5
 * checklist, Idle maintenance bullet).
 */

import { statSync } from 'node:fs';

import type { SqliteService } from '../io/sqlite-service.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface IdleMaintenanceOptions {
  /**
   * Idle-detection window in ms. Maintenance fires on the first tick
   * after `Date.now() - lastActivityAt >= idleMs` holds. Default
   * 60_000 — small enough that a paused session reclaims its WAL
   * within a minute, large enough that tight live-append bursts never
   * pay the cost of a checkpoint mid-conversation.
   */
  idleMs?: number;
  /**
   * Skip `wal_checkpoint(TRUNCATE)` when the `-wal` sidecar is smaller
   * than this many bytes. Default 4 MB — matches the default
   * `wal_autocheckpoint` threshold SQLite uses internally.
   */
  walCheckpointThresholdBytes?: number;
  /**
   * Chunk size passed to the FTS5 `merge` command. Default 200 —
   * keeps each maintenance tick bounded in wall time even on a large
   * FTS index with many pending segments.
   */
  ftsMergeChunk?: number;
  /**
   * Interval between idleness checks in ms. Default 30_000. Tests
   * override to 10–30 ms so the idle check fires quickly. The timer
   * is `.unref()`-ed so it never blocks process exit.
   */
  checkIntervalMs?: number;
  /**
   * Error sink. Any throw inside the maintenance pipeline is caught
   * and routed here; the timer keeps running. Defaults to
   * `console.warn`.
   */
  onError?: (err: Error) => void;
}

export interface IdleMaintenance {
  /** Start the idle-check timer. Idempotent — a second call is a no-op. */
  start(): void;
  /**
   * Stop the idle-check timer and abandon any further maintenance.
   * Subsequent `noteActivity()` calls are no-ops; a subsequent
   * `start()` re-arms the timer with a fresh activity stamp.
   */
  stop(): void;
  /**
   * Bump the "last write" timestamp. `LiveUpdates` calls this after
   * each successful `writeBatch` commit so ongoing bursts push the
   * idle deadline forward.
   */
  noteActivity(): void;
}

export interface IdleMaintenanceDeps {
  /**
   * The same `SqliteService` used by the writer loop. Maintenance
   * dispatches through `run` / `exec` — no private DB handle is held.
   */
  sqlite: SqliteService;
  /**
   * Absolute path to the SQLite database file. Used to derive the
   * `-wal` sidecar path for the size-threshold check. Derived from
   * `sqliteService.getFileSize`-style lookup at construction time so
   * the maintenance loop doesn't need to re-open the service config.
   */
  dbPath: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_WAL_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DEFAULT_FTS_MERGE_CHUNK = 200;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build an `IdleMaintenance` instance bound to a `SqliteService`.
 *
 * No side effects until `start()` is called. The returned handle owns
 * a single `setInterval`; `.unref()` is applied on start so the timer
 * never keeps the event loop alive on its own.
 */
export function createIdleMaintenance(
  deps: IdleMaintenanceDeps,
  options: IdleMaintenanceOptions = {},
): IdleMaintenance {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const walThreshold = options.walCheckpointThresholdBytes ?? DEFAULT_WAL_THRESHOLD_BYTES;
  const ftsMergeChunk = options.ftsMergeChunk ?? DEFAULT_FTS_MERGE_CHUNK;
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const onError =
    options.onError ??
    ((err: Error) => {
      console.warn(`[spaghetti-sdk] IdleMaintenance error: ${err.message}`);
    });

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastActivityAt = Date.now();
  let stopped = false;

  function walPath(): string {
    return `${deps.dbPath}-wal`;
  }

  function walSize(): number {
    try {
      return statSync(walPath()).size;
    } catch (err) {
      // ENOENT is the common case — fresh DB, journal_mode ≠ WAL, or
      // no writes since open. Anything else (EACCES, etc.) is also
      // non-fatal; maintenance is best-effort.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 0;
      return 0;
    }
  }

  function runMaintenance(): void {
    // All three stages share one try/catch — any failure halts the
    // current tick but never the timer. Individual stages don't
    // benefit from per-step isolation: a checkpoint failure usually
    // implies a locked DB, in which case FTS merge + optimize would
    // also fail; one catch is enough.
    try {
      const size = walSize();
      if (size > walThreshold) {
        deps.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }

      // `messages_fts` is the sole FTS5 virtual table in the schema.
      // `merge` is a no-op when there is nothing to merge, so gating
      // it on WAL size or activity is unnecessary. The two-column
      // `(fts, rank) VALUES('merge', N)` form is the one FTS5 actually
      // accepts on the `better-sqlite3`-bundled SQLite — an earlier
      // review flagged the single-column `'merge=N'` string form as
      // "more standard", but it returns SQL logic error on the bundled
      // build (confirmed by the `missing -wal sidecar` test).
      deps.sqlite.run(`INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)`, ftsMergeChunk);

      deps.sqlite.exec('PRAGMA optimize');
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function onTick(): void {
    if (stopped) return;
    const waited = Date.now() - lastActivityAt;
    if (waited < idleMs) return;
    runMaintenance();
    // Push the activity stamp forward by one idle window so a long
    // idle doesn't fire maintenance on every single check tick. The
    // next fire will happen idleMs after this one unless noteActivity()
    // resets earlier.
    lastActivityAt = Date.now();
  }

  return {
    start(): void {
      if (timer !== null || stopped) return;
      lastActivityAt = Date.now();
      timer = setInterval(onTick, checkIntervalMs);
      // Don't keep the process alive just for maintenance ticks —
      // the watcher + writer loop already pin the loop when they
      // have work to do.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    noteActivity(): void {
      if (stopped) return;
      lastActivityAt = Date.now();
    },
  };
}
