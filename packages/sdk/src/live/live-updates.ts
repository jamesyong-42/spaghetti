/**
 * @deprecated Import from `sources/claude-code/live` — Claude-only pipeline.
 * Kept as a re-export so existing paths keep compiling.
 */
export {
  createClaudeCodeLiveUpdates,
  createClaudeCodeLiveUpdates as createLiveUpdates,
  coalescePath,
  TASK_COALESCE_FILENAME,
  type ClaudeCodeLiveUpdates,
  type ClaudeCodeLiveUpdates as LiveUpdates,
  type ClaudeCodeLiveUpdatesOptions,
  type ClaudeCodeLiveUpdatesOptions as LiveUpdatesOptions,
  type ClaudeCodeLiveUpdatesDeps,
  type ClaudeCodeLiveUpdatesDeps as LiveUpdatesDeps,
} from '../sources/claude-code/live/live-updates.js';
