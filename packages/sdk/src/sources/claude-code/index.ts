/**
 * Claude Code AgentSource factory.
 */

import type { AgentSource } from '../types.js';
import { buildClaudeCodePaths, defaultClaudeDir, defaultSpaghettiStateDir } from './paths.js';

export { buildClaudeCodePaths, defaultClaudeDir, defaultSpaghettiStateDir } from './paths.js';

export interface ClaudeCodeSourceOptions {
  /** Override agent data root (default `~/.claude`). */
  rootDir?: string;
  /** Override Spaghetti state root (default `~/.spaghetti`). */
  stateDir?: string;
}

/**
 * Create the Claude Code agent source adapter.
 *
 * This is the only AgentSource implementation today. Callers that
 * previously passed `claudeDir` into `createSpaghettiService` map to
 * `{ rootDir: claudeDir }`.
 */
export function createClaudeCodeSource(options?: ClaudeCodeSourceOptions): AgentSource {
  const rootDir = options?.rootDir ?? defaultClaudeDir();
  const stateDir = options?.stateDir ?? defaultSpaghettiStateDir();
  return {
    id: 'claude-code',
    rootDir,
    stateDir,
    paths: buildClaudeCodePaths(rootDir, stateDir),
  };
}
