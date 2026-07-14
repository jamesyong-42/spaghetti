/**
 * Agent sources — adapters for local agent products.
 */

export type { AgentSource, AgentSourceId, AgentSourcePaths, ExtractedMessage, MessageExtractor } from './types.js';
export {
  createClaudeCodeSource,
  defaultClaudeDir,
  defaultSpaghettiStateDir,
  buildClaudeCodePaths,
  ClaudeCodeLifecycleOwner,
  createClaudeCodeParser,
  createProjectParser,
  type ClaudeCodeSourceOptions,
  type ClaudeCodeParser,
  type ClaudeCodeParserOptions,
} from './claude-code/index.js';
export {
  createCodexSource,
  createCodexReader,
  codexMessageExtractor,
  CodexReader,
  CodexLifecycleOwner,
  defaultCodexDir,
  buildCodexPaths,
  parseCodexTokenCount,
  countTextTokens,
  estimateTokensFromMessageRows,
  type CodexSourceOptions,
  type CodexTokenUsage,
  type ParsedCodexTokenCount,
  type EstimatedMessageTokens,
} from './codex/index.js';
export { sourceReportsPerMessageTokens, sourceDisplayName, sourceDisplayRoot } from './capabilities.js';
