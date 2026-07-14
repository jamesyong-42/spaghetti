/**
 * Default filesystem roots for the Grok CLI (xAI) agent source.
 *
 * Like Codex, `AgentSourcePaths` is Claude-shaped (todos/plans/tasks/… that Grok
 * has no analogue for). Grok only has `sessionsDir` (`~/.grok/sessions`); the
 * Claude-specific subtrees are filled best-effort under the root to satisfy the
 * interface and are never read by the Grok ingest path. The spaghetti-state
 * paths (hooks/channel) come from `stateDir`, same as every source.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentSourcePaths } from '../types.js';

/** Default Grok data directory: `~/.grok`. */
export function defaultGrokDir(): string {
  return path.join(os.homedir(), '.grok');
}

/** Default Spaghetti state directory: `~/.spaghetti`. */
export function defaultSpaghettiStateDir(): string {
  return path.join(os.homedir(), '.spaghetti');
}

/** Build the path map for a Grok installation. Only `sessionsDir` is load-bearing. */
export function buildGrokPaths(rootDir: string, stateDir: string): AgentSourcePaths {
  return {
    // Grok's per-session directories live here:
    //   sessions/<url-encoded-abs-cwd>/<session-uuid>/chat_history.jsonl
    sessionsDir: path.join(rootDir, 'sessions'),
    // Claude-only subtrees — no Grok analogue; filled best-effort, unused.
    projectsDir: path.join(rootDir, 'projects'),
    todosDir: path.join(rootDir, 'todos'),
    plansDir: path.join(rootDir, 'plans'),
    tasksDir: path.join(rootDir, 'tasks'),
    fileHistoryDir: path.join(rootDir, 'file-history'),
    settingsFile: path.join(rootDir, 'user-settings.json'),
    // Spaghetti-owned state (source-independent).
    hookEventsFile: path.join(stateDir, 'hooks', 'events.jsonl'),
    channelSessionsDir: path.join(stateDir, 'channel', 'sessions'),
    channelMessagesDir: path.join(stateDir, 'channel', 'messages'),
  };
}
