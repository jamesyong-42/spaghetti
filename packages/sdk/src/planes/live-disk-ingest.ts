/**
 * @deprecated Claude-only live disk façade.
 * Prefer `createClaudeCodeLiveDiskIngest` from `sources/claude-code/live`.
 */
export {
  createClaudeCodeLiveDiskIngest,
  createClaudeCodeLiveDiskIngest as createLiveDiskIngest,
  type ClaudeCodeLiveDiskIngest,
  type ClaudeCodeLiveDiskIngest as LiveDiskIngest,
  type ClaudeCodeLiveDiskIngestOptions,
  type ClaudeCodeLiveDiskIngestOptions as LiveDiskIngestOptions,
} from '../sources/claude-code/live/disk-ingest.js';
