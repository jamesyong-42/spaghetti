/**
 * Claude Code AgentSource factory.
 */

import type { AgentSource } from '../types.js';
import { classify } from '../../live/router.js';
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
    // Claude Code's path→category rules live in live/router.ts (the classifier
    // engine + this source's ruleset). Binding rootDir here makes classification
    // a source responsibility: a second AgentSource supplies its own classify.
    classify: (absPath: string) => classify(absPath, rootDir),
  };
}
