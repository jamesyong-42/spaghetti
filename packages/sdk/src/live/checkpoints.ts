/**
 * checkpoints.ts — Per-file byte-offset persistence for LiveUpdates (RFC 005).
 *
 * Second component of Phase 2 (C2.2). LiveUpdates (C2.7) uses this to
 * resume JSONL tailing across process restarts and watcher reattaches:
 * each entry records where we stopped reading a file so the next delta
 * parse picks up at exactly the right byte offset.
 *
 * Persistence strategy:
 *   - In-memory `Map<string, Checkpoint>` is the source of truth during
 *     a run. Insertion order is preserved so snapshots are deterministic
 *     for tests.
 *   - `flush()` writes JSON to `<filePath>.tmp` then `rename`s over
 *     `<filePath>`. The rename is atomic on the same filesystem, so a
 *     crash mid-write leaves either the old file or the new — never a
 *     partial write.
 *   - `scheduleFlush()` debounces writes (2 s trailing edge) so bursts
 *     of `set()` calls don't thrash the disk. The debounce timer is
 *     `.unref()`ed so it can't keep the process alive.
 *   - `stop()` cancels the pending debounce and forces a final flush.
 *
 * Load behavior: any IO or parse error on `load()` is swallowed with a
 * `console.warn` and we start empty. LiveUpdates must always be able to
 * start — a corrupt checkpoint file just means we re-read from offset 0,
 * which is wasteful but correct.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-file tail state. Mirrors `docs/LIVE-UPDATES-DESIGN.md` §2.5 — keep
 * in sync if the design doc changes.
 */
export interface Checkpoint {
  path: string;
  inode: number;
  size: number;
  lastOffset: number;
  lastMtimeMs: number;
}

/**
 * Persisted file schema:
 *
 *   {
 *     "version": 1,
 *     "checkpoints": [ {path, inode, size, lastOffset, lastMtimeMs}, ... ]
 *   }
 */
interface PersistedState {
  version: 1;
  checkpoints: Checkpoint[];
}

const STATE_VERSION = 1 as const;

/**
 * The debounce interval for `scheduleFlush()`. Exported via the
 * factory's test hook would be overkill — the single consumer hard-codes
 * 2 s per RFC 005.
 */
const FLUSH_DEBOUNCE_MS = 2000;

export interface CheckpointStore {
  /** Read-only accessor; returns `undefined` for unknown paths. */
  get(path: string): Checkpoint | undefined;
  /** Insert or overwrite. Does NOT auto-flush — caller must schedule/force. */
  set(path: string, cp: Checkpoint): void;
  /** Remove a path's checkpoint (e.g. when a file is deleted). */
  delete(path: string): void;
  /** Readonly view of every tracked checkpoint. Insertion-ordered. */
  all(): ReadonlyMap<string, Checkpoint>;

  /**
   * Load state from disk into the in-memory map. Missing file or any
   * parse/shape error → empty map + `console.warn`, never throws.
   * Calling `load()` replaces whatever's in memory.
   */
  load(): Promise<void>;

  /**
   * Persist the in-memory map to disk via atomic rename. Safe to call
   * concurrently — overlapping calls are serialized via an internal
   * `flushing` promise so writes can't interleave.
   */
  flush(): Promise<void>;

  /**
   * Schedule a trailing-edge debounced flush: if no further
   * `scheduleFlush()` call happens within 2 s, `flush()` runs.
   * Idempotent — subsequent calls within the window reset the timer.
   */
  scheduleFlush(): void;

  /**
   * Cancel any pending debounced flush and force one final flush.
   * Resolves once the final flush completes.
   */
  stop(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateCheckpointStoreOptions {
  /** Absolute path to the JSON state file (e.g. ~/.claude/.spaghetti-live-state.json). */
  filePath: string;
}

export function createCheckpointStore(options: CreateCheckpointStoreOptions): CheckpointStore {
  const { filePath } = options;
  const tmpPath = `${filePath}.tmp`;

  // ── Private state ───────────────────────────────────────────────────────

  const map = new Map<string, Checkpoint>();

  /** Pending debounce timer; `null` means "no flush scheduled". */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * In-flight flush promise. `flush()` chains onto this so two
   * concurrent callers can't both be mid-`writeFile`. `null` means
   * "no flush running".
   */
  let flushing: Promise<void> | null = null;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function clearFlushTimer(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  /** The atomic write itself — only called from inside `flush()`. */
  async function performFlush(): Promise<void> {
    const snapshot: PersistedState = {
      version: STATE_VERSION,
      checkpoints: Array.from(map.values()),
    };
    const json = JSON.stringify(snapshot, null, 2);
    await writeFile(tmpPath, json, 'utf8');
    await rename(tmpPath, filePath);
  }

  // ── Public surface ──────────────────────────────────────────────────────

  const store: CheckpointStore = {
    get(path) {
      return map.get(path);
    },

    set(path, cp) {
      map.set(path, cp);
    },

    delete(path) {
      map.delete(path);
    },

    all() {
      return map;
    },

    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        // Missing file is the expected first-run case — stay silent.
        // Anything else is noteworthy but still non-fatal.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[CheckpointStore] Failed to read state file at ${filePath}: ${String(err)}. Starting empty.`);
        }
        map.clear();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(
          `[CheckpointStore] Corrupt state file at ${filePath} (JSON parse error): ${String(err)}. Starting empty.`,
        );
        map.clear();
        return;
      }

      if (!isPersistedState(parsed)) {
        console.warn(`[CheckpointStore] State file at ${filePath} has unexpected shape. Starting empty.`);
        map.clear();
        return;
      }

      map.clear();
      for (const cp of parsed.checkpoints) {
        map.set(cp.path, cp);
      }
    },

    async flush() {
      // Chain onto any in-flight flush so the two writes serialize.
      // We always create a fresh promise so the *next* `flush()` sees
      // the most recent state (not whatever was queued mid-write).
      const previous = flushing ?? Promise.resolve();
      const next = previous.then(performFlush);
      flushing = next;
      try {
        await next;
      } finally {
        // Only clear if nothing chained on after us.
        if (flushing === next) {
          flushing = null;
        }
      }
    },

    scheduleFlush() {
      clearFlushTimer();
      flushTimer = setTimeout(() => {
        flushTimer = null;
        // Fire-and-forget — errors are logged but not surfaced to the
        // scheduler. Callers that need to observe failures use
        // `flush()` directly. Call through the closure-captured `store`
        // rather than `this` so a destructured / detached invocation of
        // `scheduleFlush` still works correctly.
        void store.flush().catch((err: unknown) => {
          console.warn(`[CheckpointStore] Debounced flush failed: ${String(err)}`);
        });
      }, FLUSH_DEBOUNCE_MS);
      flushTimer.unref();
    },

    async stop() {
      clearFlushTimer();
      await store.flush();
    },
  };

  return store;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL TYPE GUARDS
// ═══════════════════════════════════════════════════════════════════════════

function isCheckpoint(value: unknown): value is Checkpoint {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    typeof v.inode === 'number' &&
    typeof v.size === 'number' &&
    typeof v.lastOffset === 'number' &&
    typeof v.lastMtimeMs === 'number'
  );
}

function isPersistedState(value: unknown): value is PersistedState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== STATE_VERSION) return false;
  if (!Array.isArray(v.checkpoints)) return false;
  return v.checkpoints.every(isCheckpoint);
}
