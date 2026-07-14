/**
 * live/router.ts — live-plane route types + backward-compat re-exports.
 *
 * **Types** (`Category`, `RouteResult`) are the live plane's normalized
 * buckets for watcher events. **Classification rules** are product-owned:
 *
 * - Claude Code → `sources/claude-code/classify.ts`
 * - Codex → `sources/codex/index.ts` (`classifyCodex`)
 *
 * Live code should call `source.classify(path)` (already wired in
 * `createLiveDiskIngest`). Direct `classify(path, root)` remains for tests
 * and legacy call-sites via re-export from the Claude ruleset.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES (live plane — agent-agnostic shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every bucket a filesystem event can land in. Claude Code populates the
 * full set; other sources (e.g. Codex) only use a subset (`session` /
 * `ignored`).
 */
export type Category =
  | 'session'
  | 'session_index'
  | 'subagent'
  | 'tool_result'
  | 'project_memory'
  | 'file_history'
  | 'todo'
  | 'task'
  | 'plan'
  | 'settings'
  | 'settings_local'
  | 'ignored';

/**
 * Result of a source's `classify()`. `slug` / `sessionId` / `workflowId`
 * are populated only when the source's layout encodes them.
 */
export interface RouteResult {
  category: Category;
  slug?: string;
  sessionId?: string;
  workflowId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Claude Code rules — re-exported for backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

export {
  classify,
  classifyClaudePath,
  HARD_IGNORE_SEGMENTS,
  HARD_IGNORE_SUFFIXES,
} from '../sources/claude-code/classify.js';
