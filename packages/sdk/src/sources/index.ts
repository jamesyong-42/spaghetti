/**
 * Agent sources — adapters for local agent products.
 */

export type { AgentSource, AgentSourceId, AgentSourcePaths, ExtractedMessage, MessageExtractor } from './types.js';
export {
  createClaudeCodeSource,
  defaultClaudeDir,
  defaultSpaghettiStateDir,
  buildClaudeCodePaths,
  type ClaudeCodeSourceOptions,
} from './claude-code/index.js';
export {
  createCodexSource,
  createCodexReader,
  codexMessageExtractor,
  CodexReader,
  defaultCodexDir,
  buildCodexPaths,
  parseCodexTokenCount,
  type CodexSourceOptions,
  type CodexTokenUsage,
  type ParsedCodexTokenCount,
} from './codex/index.js';
export { sourceReportsPerMessageTokens, sourceDisplayName, sourceDisplayRoot } from './capabilities.js';
