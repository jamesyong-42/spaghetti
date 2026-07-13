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
  type CodexSourceOptions,
} from './codex/index.js';
