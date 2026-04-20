/**
 * coalescing-queue.ts — dedup-by-path, drain-windowed work queue.
 *
 * Third component of RFC 005 Phase 2. Sits between `Watcher` events
 * and the `LiveUpdates` writer loop. Its job is to collapse rapid
 * bursts of per-path filesystem events (Claude Code streams into one
 * session JSONL every few hundred ms during a conversation) into a
 * single logical work item, so the writer sees one tail-parse + one
 * SQLite transaction per flush window, not one per fsevent.
 *
 * Semantics (verbatim from RFC 005 §SQLite & FTS5 Configuration →
 * "Time-windowed batching" and §Backpressure, plus
 * `docs/LIVE-UPDATES-DESIGN.md` §2.6):
 *
 * - Dedup by `path`. If a path is already enqueued, reason collapses
 *   by priority: `delete` (3) > `rewrite` (2) > `append` (1). Higher
 *   priority wins; lower priority arrivals are a no-op against the
 *   stored reason.
 * - `enqueuedAt` resets on escalation. The queue should not "remember"
 *   a stale `append` after a `rewrite` superseded it — saturation is
 *   measured against the most recent real prompt to do work.
 * - `drain(maxRows, windowMs)` returns either when the queue has at
 *   least one entry AND `windowMs` elapsed since the oldest
 *   `enqueuedAt`, OR when the queue hits `maxRows`, OR when `stop()`
 *   was called. Returned entries are removed from the queue.
 * - `saturated()` is true when the oldest entry has been waiting
 *   longer than `saturationThresholdMs` (default 5000ms). The
 *   orchestrator uses this to trigger the "fall back to warm-start
 *   re-ingest" path described in RFC 005 Backpressure.
 *
 * Standalone on purpose — no imports from `watcher.ts`, `checkpoints.ts`,
 * or the rest of `live/`. Composes cleanly from `LiveUpdates` in C2.7.
 */

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reason tag for a queued path. `append` = fsevent on an existing file
 * with growing size; `rewrite` = inode change or size decrease (file
 * was truncated or replaced); `delete` = unlink event.
 */
export type QueuedReason = 'append' | 'rewrite' | 'delete';

/**
 * The per-path entry stored in the queue. `enqueuedAt` is
 * `Date.now()` at initial insert OR at the moment the stored reason
 * was escalated by a later enqueue — see `enqueue()` below.
 */
export interface QueuedEvent {
  path: string;
  reason: QueuedReason;
  enqueuedAt: number;
}

/**
 * Write-side interface surfaced to `LiveUpdates` (C2.7). Readers
 * never touch the queue directly.
 */
export interface CoalescingQueue {
  /**
   * Enqueue a path+reason pair. Dedupes by `path`:
   *
   *  - If `path` is not already present, inserts a new entry with
   *    `enqueuedAt = Date.now()`.
   *  - If `path` is present and the new `reason` has *higher* priority
   *    than the stored one, the stored reason is upgraded AND
   *    `enqueuedAt` is refreshed to `Date.now()` so saturation
   *    detection tracks the most recent prompt.
   *  - Otherwise it is a no-op (same or lower-priority reason on an
   *    existing path — already covered).
   *
   * After `stop()` this call becomes a no-op.
   */
  enqueue(evt: { path: string; reason: QueuedReason }): void;

  /**
   * Block until one of the drain-completion conditions holds, then
   * remove and return the front of the queue (up to `maxRows`).
   *
   * Resolution conditions (whichever fires first):
   *   a) queue has ≥1 entry AND `Date.now() - oldestEnqueuedAt ≥ windowMs`
   *   b) queue has ≥ `maxRows` entries
   *   c) `stop()` is called
   *
   * After `stop()`, any pending `drain` resolves immediately with
   * whatever is currently queued (possibly `[]`), and every future
   * call returns `[]` after also draining any residual entries.
   */
  drain(maxRows: number, windowMs: number): Promise<QueuedEvent[]>;

  /** Current queued entry count. */
  size(): number;

  /**
   * True iff the oldest entry has been waiting longer than
   * `saturationThresholdMs` (default 5000). Used by `LiveUpdates`
   * to downgrade a misbehaving file to a warm-start re-ingest.
   */
  saturated(): boolean;

  /**
   * Permanent shutdown. Wakes any awaiting `drain` so it returns
   * early with whatever is currently queued; flips the queue into a
   * terminal state where further `enqueue` calls are ignored.
   */
  stop(): void;

  /** False iff `stop()` has been called. */
  running(): boolean;
}

/** Options for {@link createCoalescingQueue}. */
export interface CoalescingQueueOptions {
  /** Threshold that flips `saturated()` to `true`. Default 5000 ms. */
  saturationThresholdMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIORITY TABLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reason priority: higher wins on dedup. `delete` beats `rewrite`
 * beats `append`. Stored as a const object rather than an enum so
 * the emitted JS is trivially tree-shakable.
 */
const REASON_PRIORITY: Record<QueuedReason, number> = {
  append: 1,
  rewrite: 2,
  delete: 3,
};

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a new `CoalescingQueue`. No side effects; nothing runs until
 * the first `enqueue` / `drain` call.
 */
export function createCoalescingQueue(options: CoalescingQueueOptions = {}): CoalescingQueue {
  const saturationThresholdMs = options.saturationThresholdMs ?? 5000;

  /**
   * The backing store. `Map` preserves insertion order, so iterating
   * gives us FIFO-by-first-enqueue. Even on reason escalation we do
   * NOT reinsert — order stays tied to the original arrival, which
   * matches "oldest entry drives the flush window" semantics.
   */
  const queue = new Map<string, QueuedEvent>();

  let stopped = false;

  /**
   * Single shared resolver, triggered on: (a) empty → non-empty
   * transition, (b) queue crossing the `maxRows` threshold during a
   * wait, (c) `stop()`. Reset after every `drain` so the next wait
   * starts from a fresh signal.
   */
  let signalResolve: (() => void) | null = null;
  let signalPromise: Promise<void> = new Promise((resolve) => {
    signalResolve = resolve;
  });

  function raiseSignal(): void {
    if (signalResolve) {
      const r = signalResolve;
      signalResolve = null;
      r();
    }
  }

  function resetSignal(): void {
    signalPromise = new Promise((resolve) => {
      signalResolve = resolve;
    });
  }

  // ── public methods ────────────────────────────────────────────────────

  function enqueue(evt: { path: string; reason: QueuedReason }): void {
    if (stopped) return;

    const existing = queue.get(evt.path);
    if (existing === undefined) {
      queue.set(evt.path, {
        path: evt.path,
        reason: evt.reason,
        enqueuedAt: Date.now(),
      });
      // empty → non-empty (or first arrival since last drain): wake
      // any waiter so it can (re)start its window timer against a
      // valid `oldestEnqueuedAt`.
      raiseSignal();
      return;
    }

    const nextPriority = REASON_PRIORITY[evt.reason];
    const curPriority = REASON_PRIORITY[existing.reason];
    if (nextPriority > curPriority) {
      existing.reason = evt.reason;
      existing.enqueuedAt = Date.now();
      // Escalation can matter to a waiting drainer whose window was
      // measured from a now-replaced stamp; wake it so it can recompute.
      raiseSignal();
    }
    // else: same-or-lower priority for an already-known path → no-op.
  }

  async function drain(maxRows: number, windowMs: number): Promise<QueuedEvent[]> {
    // Fast path: if stopped, flush whatever's left and bail.
    if (stopped) {
      return takeFront(maxRows);
    }

    while (true) {
      // (b) hit size limit — flush immediately.
      if (queue.size >= maxRows) {
        return takeFront(maxRows);
      }

      // (a) have work AND window has already elapsed for the oldest entry.
      const oldest = firstEntry();
      if (oldest) {
        const waited = Date.now() - oldest.enqueuedAt;
        const remainingWindow = windowMs - waited;
        if (remainingWindow <= 0) {
          return takeFront(maxRows);
        }

        // Wait either for a signal or for the window to close.
        await waitFor(signalPromise, remainingWindow);
      } else {
        // Empty — block on signal only, no timer.
        await signalPromise;
      }

      if (stopped) {
        return takeFront(maxRows);
      }
      // Loop: re-check size, oldest timestamp, etc.
    }
  }

  function size(): number {
    return queue.size;
  }

  function saturated(): boolean {
    const oldest = firstEntry();
    if (!oldest) return false;
    return Date.now() - oldest.enqueuedAt > saturationThresholdMs;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    raiseSignal();
  }

  function running(): boolean {
    return !stopped;
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Remove and return the first `n` entries in insertion order.
   * Also resets the signal so the next `drain` gets a fresh promise
   * to await.
   */
  function takeFront(n: number): QueuedEvent[] {
    const out: QueuedEvent[] = [];
    for (const entry of queue.values()) {
      if (out.length >= n) break;
      out.push(entry);
    }
    for (const entry of out) {
      queue.delete(entry.path);
    }
    // Next wait should start from a clean slate: if the queue is now
    // empty, the next enqueue will raise a brand-new signal.
    resetSignal();
    return out;
  }

  /** First entry in insertion order, or undefined if empty. */
  function firstEntry(): QueuedEvent | undefined {
    const it = queue.values().next();
    return it.done ? undefined : it.value;
  }

  /**
   * Race a promise against a `setTimeout`. The timer is `.unref()`-ed
   * so it never holds the event loop open, and is cleared as soon as
   * the signal wins.
   */
  function waitFor(p: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve();
      }, ms);
      // Don't keep the process alive just because a drain is idling.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
      p.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    enqueue,
    drain,
    size,
    saturated,
    stop,
    running,
  };
}
