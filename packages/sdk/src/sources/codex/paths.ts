/**
 * Default filesystem roots for the OpenAI Codex CLI agent source.
 *
 * `AgentSourcePaths` is currently Claude-shaped (it names todos/plans/tasks/…
 * that Codex has no equivalent for). Codex only really has `sessionsDir`
 * (the rollout tree, `~/.codex/sessions`); the Claude-specific subtrees are
 * filled best-effort under the root so the interface is satisfied, and are not
 * read by the Codex ingest path. The spaghetti-state paths (hooks/channel) come
 * from `stateDir`, same as Claude — they are Spaghetti's own state, not the
 * agent's.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentSourcePaths } from '../types.js';

/** Default Codex data directory: `~/.codex`. */
export function defaultCodexDir(): string {
  return path.join(os.homedir(), '.codex');
}

/** Default Spaghetti state directory: `~/.spaghetti`. */
export function defaultSpaghettiStateDir(): string {
  return path.join(os.homedir(), '.spaghetti');
}

/** Build the path map for a Codex installation. Only `sessionsDir` is load-bearing. */
export function buildCodexPaths(rootDir: string, stateDir: string): AgentSourcePaths {
  return {
    // Codex's rollout transcripts live here: sessions/YYYY/MM/DD/rollout-*.jsonl.
    sessionsDir: path.join(rootDir, 'sessions'),
    // Claude-only subtrees — no Codex analogue; filled best-effort, unused.
    projectsDir: path.join(rootDir, 'projects'),
    todosDir: path.join(rootDir, 'todos'),
    plansDir: path.join(rootDir, 'plans'),
    tasksDir: path.join(rootDir, 'tasks'),
    fileHistoryDir: path.join(rootDir, 'file-history'),
    settingsFile: path.join(rootDir, 'config.toml'),
    // Spaghetti-owned state (source-independent).
    hookEventsFile: path.join(stateDir, 'hooks', 'events.jsonl'),
    channelSessionsDir: path.join(stateDir, 'channel', 'sessions'),
    channelMessagesDir: path.join(stateDir, 'channel', 'messages'),
  };
}
