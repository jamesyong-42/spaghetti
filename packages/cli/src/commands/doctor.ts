/**
 * Doctor command — text health check for spaghetti, its plugins, and
 * related data paths.
 *
 * The data is gathered by `collectDoctorReport()` in lib/doctor-report.ts
 * so the same snapshot can be rendered by the TUI's DoctorView.
 */

import { theme } from '../lib/color.js';
import {
  PLUGIN_STATUS_LABEL,
  collectDoctorReport,
  formatRelative,
  pluginStatusKind,
  tildify,
  type DoctorReport,
  type PluginStatusKind,
} from '../lib/doctor-report.js';

const OK = theme.success('✓');
const WARN = theme.warning('!');
const BAD = theme.error('✗');
const DOT = theme.muted('·');
const LABEL_WIDTH = 18;
const INDENT = '  ';

function row(icon: string, label: string, value: string): string {
  return `${INDENT}${icon} ${theme.muted(label.padEnd(LABEL_WIDTH))}  ${value}`;
}

function sub(value: string): string {
  return `${INDENT}  ${' '.repeat(LABEL_WIDTH)}  ${theme.muted(value)}`;
}

function heading(title: string): string {
  return `${INDENT}${theme.heading(title)}`;
}

function statusIconAndText(kind: PluginStatusKind): { icon: string; text: string } {
  switch (kind) {
    case 'ok':
      return { icon: OK, text: theme.success(PLUGIN_STATUS_LABEL.ok) };
    case 'disabled':
      return { icon: WARN, text: theme.warning(PLUGIN_STATUS_LABEL.disabled) };
    case 'path-missing':
      return { icon: WARN, text: theme.warning(PLUGIN_STATUS_LABEL['path-missing']) };
    case 'not-installed':
      return { icon: BAD, text: theme.error(PLUGIN_STATUS_LABEL['not-installed']) };
  }
}

function renderReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${INDENT}${theme.heading('Spaghetti Doctor')}  ${theme.muted(`v${report.version}`)}`);
  lines.push('');

  // ─── Environment ────────────────────────────────────────────────────
  const env = report.environment;
  lines.push(heading('Environment'));
  lines.push(row(OK, 'Node', `${env.node} (${env.platform} ${env.arch})`));
  if (env.claudeBin) {
    lines.push(row(OK, 'claude CLI', env.claudeBin));
  } else {
    lines.push(row(BAD, 'claude CLI', theme.error('not found in PATH')));
  }
  lines.push(row(env.claudeDir.exists ? OK : BAD, '~/.claude', tildify(env.claudeDir.path)));
  lines.push(row(env.settings.exists ? OK : WARN, 'settings.json', tildify(env.settings.path)));
  lines.push(row(env.pluginsDir.exists ? OK : WARN, 'plugins dir', tildify(env.pluginsDir.path)));
  lines.push('');

  // ─── Plugins ────────────────────────────────────────────────────────
  lines.push(heading('Plugins'));
  for (const p of report.plugins) {
    const kind = pluginStatusKind(p.state);
    const { icon, text } = statusIconAndText(kind);
    const version = p.state.version ? theme.muted(`v${p.state.version}`) : '';
    lines.push(row(icon, p.name, `${text}${version ? '  ' + version : ''}`));
    lines.push(sub(p.description));
    if (kind === 'not-installed') {
      lines.push(sub(theme.accent(`→ spag plugin install ${p.name}`)));
    } else if (kind === 'disabled') {
      lines.push(sub('→ enable in ~/.claude/settings.json (enabledPlugins)'));
    } else if (kind === 'path-missing' && p.state.installPath) {
      lines.push(sub(`path: ${tildify(p.state.installPath)}`));
    }
  }
  lines.push('');

  // ─── Hook events ────────────────────────────────────────────────────
  lines.push(heading('Hook events'));
  const he = report.hookEvents;
  if (he.kind === 'ok') {
    lines.push(row(OK, 'events file', tildify(he.path)));
    lines.push(sub(`${he.count.toLocaleString()} event(s), updated ${formatRelative(he.mtimeMs)}`));
  } else if (he.kind === 'missing') {
    lines.push(row(BAD, 'events file', theme.error('none')));
    lines.push(sub(`expected at ${tildify(he.path)}`));
    lines.push(sub(theme.accent('→ spag plugin install spaghetti-hooks')));
  } else {
    lines.push(row(BAD, 'events file', theme.error(`read error: ${he.message}`)));
  }
  lines.push('');

  // ─── Channel sessions ───────────────────────────────────────────────
  lines.push(heading('Channel sessions'));
  const cs = report.channelSessions;
  if (cs.kind === 'ok') {
    lines.push(row(OK, 'sessions dir', tildify(cs.path)));
    lines.push(sub(`${cs.activeCount} active session file(s)`));
  } else {
    lines.push(row(DOT, 'sessions dir', theme.muted(tildify(cs.path))));
    lines.push(sub('not created yet — start a Claude Code session with spaghetti-channel'));
  }
  lines.push('');

  return lines.join('\n') + '\n';
}

export async function doctorCommand(version: string): Promise<void> {
  const report = collectDoctorReport(version);
  process.stdout.write(renderReport(report));
}
