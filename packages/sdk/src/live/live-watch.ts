/**
 * LiveWatch — the general per-source live-ingest contract (RFC 006 Plane 2).
 *
 * Every agent source's live pipeline implements this: it watches that source's
 * on-disk data and streams deltas into the shared store. Claude Code's rich
 * implementation is `LiveUpdates` (with `prewarm` scope ref-counting +
 * `isSaturated` backpressure); Codex's is `CodexLiveWatch`. The lifecycle owner
 * exposes whichever one it has via `getLiveWatch()`, so the app treats them
 * uniformly instead of special-casing one agent.
 *
 * `prewarm` and `isSaturated` are OPTIONAL: they model Claude Code's multi-scope
 * watcher (lazily attach a subtree per subscribed topic) and its coalescing
 * queue. A source that simply watches its whole tree (Codex) omits them; the
 * `api.live` surface treats an absent `prewarm` as a no-op and absent
 * `isSaturated` as `false`.
 */

import type { ChangeTopic, Dispose } from './change-events.js';

export interface LiveWatch {
  /** The `AgentSource.id` this pipeline watches for (matches its owner). */
  readonly sourceId: string;
  /** Begin watching + writing. Idempotent. */
  start(): Promise<void>;
  /** Stop watching and release resources. Idempotent. */
  stop(): Promise<void>;
  /**
   * Optional (Claude Code): register interest in a scope so its subtree is
   * watched while at least one ref is held. Sources that watch everything omit
   * this — callers treat its absence as "already watching".
   */
  prewarm?(topic: ChangeTopic): Dispose;
  /** Optional (Claude Code): true when the write queue is backed up. */
  isSaturated?(): boolean;
}
