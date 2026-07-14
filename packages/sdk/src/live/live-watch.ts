/**
 * LiveWatch — the general per-source live-ingest contract (RFC 006 Plane 2).
 *
 * Every agent source's live pipeline implements this: it watches that source's
 * on-disk data and streams deltas into the shared store.
 *
 * Implementations (product-owned):
 * - Claude Code → `ClaudeCodeLiveUpdates` (`sources/claude-code/live/`)
 * - Codex → `CodexLiveWatch` (`sources/codex/live-watch.ts`)
 * - Grok → `GrokLiveWatch` (`sources/grok/live-watch.ts`)
 *
 * Lifecycle owners expose theirs via `getLiveWatch()`.
 *
 * `prewarm` and `isSaturated` are OPTIONAL (Claude multi-scope attach + queue
 * backpressure). Whole-tree watchers omit them; `api.live` treats missing
 * `prewarm` as no-op and missing `isSaturated` as `false`.
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
