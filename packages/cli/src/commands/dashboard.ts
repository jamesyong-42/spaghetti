/**
 * Dashboard command — default view when running `spaghetti` with no args
 */

import type { SpaghettiAPI, ProjectListItem } from '@vibecook/spaghetti-sdk';
import { theme } from '../lib/color.js';
import { formatTokens, formatBytes, formatRelativeTime, formatNumber, totalTokens } from '../lib/format.js';
import { getTerminalWidth } from '../lib/terminal.js';

function renderHeader(version: string): string {
  return theme.heading(`  Spaghetti v${version}`) + '  ' + theme.muted('Claude Code data explorer');
}

function renderSummary(api: SpaghettiAPI): string {
  const projects = api.getProjectList();
  const stats = api.getStats();

  const projectCount = projects.length;
  let totalSessions = 0;
  let totalTok = 0;
  for (const p of projects) {
    totalSessions += p.sessionCount;
    totalTok += totalTokens(p.tokenUsage);
  }

  const parts = [
    theme.accent(`${projectCount} projects`),
    theme.value(`${formatNumber(totalSessions)} sessions`),
    theme.tokens(`${formatTokens(totalTok)} tokens`),
    theme.muted(`DB ${formatBytes(stats.dbSizeBytes)}`),
  ];

  return '  ' + parts.join(theme.muted(' \u00b7 '));
}

function renderRecentActivity(projects: ProjectListItem[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  ' + theme.heading('Recent Activity'));
  lines.push('');

  // Sort by lastActiveAt descending and take top 5
  const recent = [...projects]
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);

  if (recent.length === 0) {
    lines.push('  ' + theme.muted('No projects found'));
    return lines.join('\n');
  }

  // Find the longest project name for alignment
  const maxNameLen = Math.min(Math.max(...recent.map((p) => p.folderName.length)), 30);

  for (const p of recent) {
    const name = theme.project(p.folderName.padEnd(maxNameLen));
    const time = theme.time(formatRelativeTime(p.lastActiveAt).padStart(10));
    const branch = p.latestGitBranch ? theme.muted(` on ${p.latestGitBranch}`) : '';
    const sessions = theme.label(`${p.sessionCount} sessions`);
    lines.push(`  ${name}  ${time}  ${sessions}${branch}`);
  }

  return lines.join('\n');
}

function renderQuickCommands(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  ' + theme.heading('Quick Commands'));
  lines.push('');

  const cmds = [
    ['spaghetti projects', 'List all projects'],
    ['spaghetti sessions .', 'Sessions for current directory'],
    ['spaghetti search <query>', 'Full-text search'],
    ['spaghetti stats', 'Usage statistics'],
  ];

  for (const [cmd, desc] of cmds) {
    lines.push(`  ${theme.accent(cmd!.padEnd(30))}  ${theme.muted(desc!)}`);
  }

  return lines.join('\n');
}

/**
 * Output a machine-readable JSON summary to stdout.
 * Used when `spag` is piped (not a TTY).
 */
export async function summaryJSON(api: SpaghettiAPI): Promise<void> {
  const projects = api.getProjectList();
  const stats = api.getStats();

  let totalSessions = 0;
  let totalMessages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  for (const p of projects) {
    totalSessions += p.sessionCount;
    totalMessages += p.messageCount;
    totalInputTokens += p.tokenUsage.inputTokens;
    totalOutputTokens += p.tokenUsage.outputTokens;
    totalCacheCreationTokens += p.tokenUsage.cacheCreationTokens;
    totalCacheReadTokens += p.tokenUsage.cacheReadTokens;
  }

  const summary = {
    projectCount: projects.length,
    sessionCount: totalSessions,
    messageCount: totalMessages,
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
      total: totalTokens({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        cacheReadTokens: totalCacheReadTokens,
      }),
    },
    dbSizeBytes: stats.dbSizeBytes,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

export async function dashboardCommand(api: SpaghettiAPI, version: string): Promise<void> {
  const width = getTerminalWidth();
  const divider = theme.muted('\u2500'.repeat(Math.min(width, 60)));

  const projects = api.getProjectList();

  const output = [
    '',
    renderHeader(version),
    '  ' + divider,
    renderSummary(api),
    renderRecentActivity(projects),
    renderQuickCommands(),
    '',
  ].join('\n');

  process.stdout.write(output + '\n');
}
