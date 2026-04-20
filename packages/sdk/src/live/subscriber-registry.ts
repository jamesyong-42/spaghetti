/**
 * subscriber-registry.ts — Typed Change fan-out (RFC 005 C3.1).
 *
 * First piece of Phase 3. `AgentDataStore` used to carry a pair of no-op
 * `emit`/`subscribe` stubs; this module provides the real topic-matcher
 * + throttle-aware dispatcher behind them. See
 * `docs/LIVE-UPDATES-DESIGN.md` §2.2 for the store-level contract and
 * §2.3 for how `LiveUpdates` composes this with lazy-attached watchers.
 *
 * Design notes:
 *
 *  - Two internal collections. A `Set<Entry>` for firehose subscribers
 *    (topic omitted on `subscribe()`) and a `Map<TopicKey, Set<Entry>>`
 *    for scoped ones. `TopicKey` is a flat canonical string (e.g.
 *    `'session:slug:'`, `'session:slug:sessionId'`,
 *    `'subagent:slug:sessionId:agentId'`) so lookups are O(1) regardless
 *    of how many listeners a scope holds.
 *
 *  - A subscribe call with a partial topic registers under exactly one
 *    key. Matching on `emit` constructs every candidate key for the
 *    change — for a `session.message.added`: the concrete
 *    `session:slug:sessionId` plus its broader ancestors `session:slug:`
 *    and `session::` — and unions the listener sets. Partial wildcards
 *    (e.g. "all sessions for slug X, any sessionId") Just Work.
 *
 *  - Throttling is per-entry state, not global. `throttleMs` gates
 *    listener invocations; `latest: true` (default when `throttleMs` is
 *    set) drops intermediates and only delivers the most recent change
 *    at each window boundary. `latest: false` coalesces into an array
 *    and delivers once per window. Non-throttled deliveries are
 *    synchronous inside `emit()` so ordering matches the producer.
 *
 *  - `emit()` is re-entrant safe. A listener that calls
 *    `subscribe`/`dispose` mid-fanout must not corrupt the Set being
 *    iterated; we snapshot the target set before invoking listeners.
 *
 *  - Listener errors are trapped and routed to the optional
 *    `onListenerError` callback so one bad subscriber can't starve the
 *    rest of the loop — matches the `opts.onError` discipline described
 *    in RFC 005 §4 (Backpressure & failure semantics).
 */

import type { Change, ChangeTopic, Dispose, SubscribeOptions } from './change-events.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SubscriberRegistry {
  /**
   * Register a listener for changes matching `topic` (or the firehose
   * when `topic` is `undefined`). Returns a `Dispose` that deregisters
   * the listener and drops any pending throttle state.
   *
   * Multiple subscribes for the same topic + listener stack
   * independently — the returned dispose is the only handle that
   * removes them.
   */
  subscribe(topic: ChangeTopic | undefined, listener: (e: Change) => void, options?: SubscribeOptions): Dispose;

  /**
   * Publish a Change to every firehose listener plus every scoped
   * listener whose topic matches. Synchronous for non-throttled
   * listeners; throttled listeners are scheduled via `setTimeout`.
   */
  emit(change: Change): void;

  /** Total number of live listeners across firehose + all topic keys. */
  listenerCount(): number;

  /**
   * Tear down the whole registry. Pending throttle timers cleared,
   * every entry marked disposed (so any in-flight `emit()` sees them
   * as no-ops), internal Maps/Sets dropped. Idempotent.
   */
  dispose(): void;
}

export interface SubscriberRegistryOptions {
  /**
   * Invoked when a listener throws. The thrown value is passed through
   * along with the Change that provoked it so a downstream sink can
   * log context-rich errors. When omitted, listener errors are
   * swallowed silently — matches the public `onError` philosophy in
   * `LiveUpdates` (errors degrade, they don't crash the host).
   */
  onListenerError?: (err: unknown, change: Change) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flat canonical string used as the key into the topic→listeners map.
 * Ordering of fields in the key matches the order of qualifiers on
 * `ChangeTopic` so partial keys (e.g. `session:slug:`) sort alongside
 * the more-specific ones for human readability during debugging.
 */
type TopicKey = string;

/**
 * Per-subscription state. `disposed` is checked at the top of every
 * delivery path so an in-flight `emit()` that dispatches to an entry
 * which was just unsubscribed turns into a no-op.
 */
interface Entry {
  readonly listener: (e: Change) => void;
  readonly options: SubscribeOptions | undefined;
  disposed: boolean;

  // ── Throttle bookkeeping ───────────────────────────────────────────
  /**
   * Active trailing-edge timer. `null` when no boundary is pending.
   */
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Latest change seen this window (used when `latest !== false`).
   * Cleared on flush.
   */
  pendingLatest: Change | null;
  /**
   * Coalesce buffer (used when `latest === false`). Cleared on flush.
   */
  pendingCoalesce: Change[] | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPIC KEY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serialize a `ChangeTopic` to a flat key. Empty strings denote
 * "wildcard for that qualifier" so subscribers for the same kind at
 * different granularities produce distinct keys.
 */
function topicToKey(topic: ChangeTopic): TopicKey {
  switch (topic.kind) {
    case 'session':
      return `session:${topic.slug ?? ''}:${topic.sessionId ?? ''}`;
    case 'subagent':
      return `subagent:${topic.slug ?? ''}:${topic.sessionId ?? ''}:${topic.agentId ?? ''}`;
    case 'tool-result':
      return `tool-result:${topic.slug ?? ''}:${topic.sessionId ?? ''}`;
    case 'file-history':
      return `file-history:${topic.sessionId ?? ''}`;
    case 'todo':
      return `todo:${topic.sessionId ?? ''}`;
    case 'task':
      return `task:${topic.sessionId ?? ''}`;
    case 'plan':
      return `plan:${topic.slug ?? ''}`;
    case 'settings':
      return `settings:`;
  }
}

/**
 * Construct the list of candidate topic keys a given `Change` matches,
 * widest-first. A subscriber registered under any of these keys (or
 * the firehose) must receive the event.
 *
 * For `session.message.added`: `['session::', 'session:slug:', 'session:slug:sessionId']`.
 * For `settings.changed`: `['settings:']`.
 */
function candidateKeysFor(change: Change): TopicKey[] {
  switch (change.type) {
    case 'session.message.added':
    case 'session.created':
    case 'session.rewritten':
      return [`session::`, `session:${change.slug}:`, `session:${change.slug}:${change.sessionId}`];
    case 'subagent.updated':
      return [
        `subagent:::`,
        `subagent:${change.slug}::`,
        `subagent:${change.slug}:${change.sessionId}:`,
        `subagent:${change.slug}:${change.sessionId}:${change.agentId}`,
      ];
    case 'tool-result.added':
      return [`tool-result::`, `tool-result:${change.slug}:`, `tool-result:${change.slug}:${change.sessionId}`];
    case 'file-history.added':
      return [`file-history:`, `file-history:${change.sessionId}`];
    case 'todo.updated':
      return [`todo:`, `todo:${change.sessionId}`];
    case 'task.updated':
      return [`task:`, `task:${change.sessionId}`];
    case 'plan.upserted':
      return [`plan:`, `plan:${change.slug}`];
    case 'settings.changed':
      return [`settings:`];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

class SubscriberRegistryImpl implements SubscriberRegistry {
  private readonly firehose = new Set<Entry>();
  private readonly byTopic = new Map<TopicKey, Set<Entry>>();
  private readonly onListenerError: ((err: unknown, change: Change) => void) | undefined;
  private disposed = false;

  constructor(options: SubscriberRegistryOptions | undefined) {
    this.onListenerError = options?.onListenerError;
  }

  subscribe(topic: ChangeTopic | undefined, listener: (e: Change) => void, options?: SubscribeOptions): Dispose {
    // Subscribe-after-dispose is a no-op returning a no-op dispose —
    // matches the "disposed registry no-op" testing contract from
    // `docs/LIVE-UPDATES-DESIGN.md` §6.1.
    if (this.disposed) {
      return () => {};
    }

    const entry: Entry = {
      listener,
      options,
      disposed: false,
      pendingTimer: null,
      pendingLatest: null,
      pendingCoalesce: null,
    };

    const target = this.targetSetFor(topic, /* createIfMissing */ true);
    target.add(entry);

    return () => {
      if (entry.disposed) return;
      entry.disposed = true;
      if (entry.pendingTimer !== null) {
        clearTimeout(entry.pendingTimer);
        entry.pendingTimer = null;
      }
      entry.pendingLatest = null;
      entry.pendingCoalesce = null;
      target.delete(entry);
      // Opportunistic cleanup: drop empty scoped buckets so
      // `listenerCount()` stays cheap and debug prints stay readable.
      if (topic !== undefined && target.size === 0) {
        this.byTopic.delete(topicToKey(topic));
      }
    };
  }

  emit(change: Change): void {
    if (this.disposed) return;

    // Snapshot-before-iterate: a listener that calls `subscribe` or a
    // dispose during fan-out mutates the same Set we're walking.
    // Allocating Array.from(...) per emit is cheap relative to the
    // parse + SQLite round-trip that produced the Change; no early
    // optimisation needed.
    if (this.firehose.size > 0) {
      const snapshot = Array.from(this.firehose);
      for (const entry of snapshot) {
        if (!entry.disposed) this.deliver(entry, change);
      }
    }

    const keys = candidateKeysFor(change);
    for (const key of keys) {
      const bucket = this.byTopic.get(key);
      if (!bucket || bucket.size === 0) continue;
      const snapshot = Array.from(bucket);
      for (const entry of snapshot) {
        if (!entry.disposed) this.deliver(entry, change);
      }
    }
  }

  listenerCount(): number {
    let n = this.firehose.size;
    for (const bucket of this.byTopic.values()) n += bucket.size;
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const clearEntry = (e: Entry): void => {
      e.disposed = true;
      if (e.pendingTimer !== null) {
        clearTimeout(e.pendingTimer);
        e.pendingTimer = null;
      }
      e.pendingLatest = null;
      e.pendingCoalesce = null;
    };
    for (const e of this.firehose) clearEntry(e);
    for (const bucket of this.byTopic.values()) {
      for (const e of bucket) clearEntry(e);
      bucket.clear();
    }
    this.firehose.clear();
    this.byTopic.clear();
  }

  // ── private ──────────────────────────────────────────────────────────

  private targetSetFor(topic: ChangeTopic | undefined, createIfMissing: boolean): Set<Entry> {
    if (topic === undefined) return this.firehose;
    const key = topicToKey(topic);
    let bucket = this.byTopic.get(key);
    if (!bucket) {
      if (!createIfMissing) return new Set();
      bucket = new Set();
      this.byTopic.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Dispatch a single change to one entry, honouring throttle config.
   * Errors in the user callback are trapped; ordering guarantees only
   * hold per-entry (two entries can observe different delivery orders
   * under throttling, but the same entry always sees events in emit
   * order).
   */
  private deliver(entry: Entry, change: Change): void {
    const throttleMs = entry.options?.throttleMs;
    if (!throttleMs || throttleMs <= 0) {
      this.invokeSafely(entry, change);
      return;
    }

    // Default `latest: true` when throttleMs is set but `latest` is
    // omitted. Explicit `false` opts into the coalesce-array path.
    const latestMode = entry.options?.latest !== false;

    if (latestMode) {
      entry.pendingLatest = change;
    } else {
      if (entry.pendingCoalesce === null) entry.pendingCoalesce = [];
      entry.pendingCoalesce.push(change);
    }

    if (entry.pendingTimer !== null) return;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = null;
      if (entry.disposed) return;
      if (latestMode) {
        const next = entry.pendingLatest;
        entry.pendingLatest = null;
        if (next !== null) this.invokeSafely(entry, next);
      } else {
        const batch = entry.pendingCoalesce;
        entry.pendingCoalesce = null;
        if (batch && batch.length > 0) {
          // Coalesce mode delivers the batch as a single call. The
          // public type is `(e: Change) => void`; the batched array is
          // cast through `unknown` to match the documented RFC shape
          // — consumers opting in to `latest: false` are responsible
          // for reading the array form. (No breaking change to the
          // single-change path.)
          try {
            (entry.listener as unknown as (e: Change[]) => void)(batch);
          } catch (err) {
            if (this.onListenerError) {
              // Surface the first change so the sink has some context.
              this.onListenerError(err, batch[0]!);
            }
          }
        }
      }
    }, throttleMs);
  }

  private invokeSafely(entry: Entry, change: Change): void {
    try {
      entry.listener(change);
    } catch (err) {
      if (this.onListenerError) this.onListenerError(err, change);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createSubscriberRegistry(options?: SubscriberRegistryOptions): SubscriberRegistry {
  return new SubscriberRegistryImpl(options);
}
