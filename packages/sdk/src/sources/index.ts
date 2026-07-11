/**
 * Agent sources — adapters for local agent products.
 */

export type { AgentSource, AgentSourceId, AgentSourcePaths } from './types.js';
export {
  createClaudeCodeSource,
  defaultClaudeDir,
  defaultSpaghettiStateDir,
  buildClaudeCodePaths,
  type ClaudeCodeSourceOptions,
} from './claude-code/index.js';
