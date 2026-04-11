/**
 * Doctor report — pure data collection for spaghetti's health check.
 *
 * Both the `doctor` CLI command (text) and the `DoctorView` TUI view (Ink)
 * call `collectDoctorReport(version)` and render the same shape differently.
 * Keeping the collection pure means adding a new field anywhere shows up in
 * both surfaces at once.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHookEventWatcher, getChannelSessionsDir } from '@vibecook/spaghetti-core';
import { PLUGINS, PLUGINS_DIR, SETTINGS_PATH, getPluginState, type PluginState } from './plugins.js';

export const CLAUDE_DIR = join(homedir(), '.claude');

export interface PathStatus {
  path: string;
  exists: boolean;
}

export interface EnvironmentReport {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  claudeBin: string | null;
  claudeDir: PathStatus;
  settings: PathStatus;
  pluginsDir: PathStatus;
}

export interface PluginReport {
  name: string;
  description: string;
  state: PluginState;
}

export type HookEventsReport =
  | { kind: 'ok'; path: string; count: number; mtimeMs: number }
  | { kind: 'missing'; path: string }
  | { kind: 'error'; message: string };

export type ChannelSessionsReport =
  | { kind: 'ok'; path: string; activeCount: number }
  | { kind: 'absent'; path: string };

export interface DoctorReport {
  version: string;
  environment: EnvironmentReport;
  plugins: PluginReport[];
  hookEvents: HookEventsReport;
  channelSessions: ChannelSessionsReport;
}

function findClaudeBinary(): string | null {
  try {
    const out = execSync('command -v claude', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function collectEnvironment(): EnvironmentReport {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    claudeBin: findClaudeBinary(),
    claudeDir: { path: CLAUDE_DIR, exists: existsSync(CLAUDE_DIR) },
    settings: { path: SETTINGS_PATH, exists: existsSync(SETTINGS_PATH) },
    pluginsDir: { path: PLUGINS_DIR, exists: existsSync(PLUGINS_DIR) },
  };
}

function collectHookEvents(): HookEventsReport {
  try {
    const watcher = createHookEventWatcher();
    const path = watcher.getEventsPath();
    if (!existsSync(path)) return { kind: 'missing', path };
    const stats = statSync(path);
    const history = watcher.getHistory();
    return { kind: 'ok', path, count: history.length, mtimeMs: stats.mtimeMs };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function collectChannelSessions(): ChannelSessionsReport {
  const path = getChannelSessionsDir();
  if (!existsSync(path)) return { kind: 'absent', path };
  let activeCount = 0;
  try {
    activeCount = readdirSync(path).filter((f) => f.endsWith('.json')).length;
  } catch {
    /* swallow — shown as 0 */
  }
  return { kind: 'ok', path, activeCount };
}

export function collectDoctorReport(version: string): DoctorReport {
  return {
    version,
    environment: collectEnvironment(),
    plugins: PLUGINS.map((p) => ({
      name: p.name,
      description: p.description,
      state: getPluginState(p.name),
    })),
    hookEvents: collectHookEvents(),
    channelSessions: collectChannelSessions(),
  };
}

// ─── Shared helpers for rendering (used by CLI text + TUI Ink) ──────────

export function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export type PluginStatusKind = 'ok' | 'disabled' | 'path-missing' | 'not-installed';

export function pluginStatusKind(state: PluginState): PluginStatusKind {
  if (!state.installed) return 'not-installed';
  if (!state.pathExists) return 'path-missing';
  if (!state.enabled) return 'disabled';
  return 'ok';
}

export const PLUGIN_STATUS_LABEL: Record<PluginStatusKind, string> = {
  ok: 'installed & enabled',
  disabled: 'installed, disabled',
  'path-missing': 'registered, path missing',
  'not-installed': 'not installed',
};
