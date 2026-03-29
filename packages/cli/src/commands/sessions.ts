/**
 * Sessions command — list sessions for a project
 */

import type { SpaghettiAPI, SessionListItem } from '@vibecook/spaghetti-core';
import { theme } from '../lib/color.js';
import { formatTokens, formatDuration, formatNumber, totalTokens } from '../lib/format.js';
import { renderTable } from '../lib/table.js';
import type { Column } from '../lib/table.js';
import { resolveProject, suggestProjects } from '../lib/resolve.js';
import { noProjectMatch } from '../lib/error.js';

export interface SessionsOptions {
  sort?: string;
  limit?: number;
  all?: boolean;
  since?: string;
  json?: boolean;
}

type SortKey = 'recent' | 'tokens' | 'messages' | 'duration';

function sortSessions(sessions: SessionListItem[], key: SortKey): SessionListItem[] {
  const sorted = [...sessions];
  switch (key) {
    case 'recent':
      return sorted.sort(
        (a: SessionListItem, b: SessionListItem) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime(),
      );
    case 'tokens':
      return sorted.sort(
        (a: SessionListItem, b: SessionListItem) => totalTokens(b.tokenUsage) - totalTokens(a.tokenUsage),
      );
    case 'messages':
      return sorted.sort((a: SessionListItem, b: SessionListItem) => b.messageCount - a.messageCount);
    case 'duration':
      return sorted.sort((a: SessionListItem, b: SessionListItem) => b.lifespanMs - a.lifespanMs);
    default:
      return sorted;
  }
}

function parseSince(since: string): Date | null {
  const lower = since.toLowerCase().trim();

  if (lower === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // "N days ago" / "N hours ago"
  const agoMatch = lower.match(/^(\d+)\s*(day|days|hour|hours|h|d)\s*ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1]!, 10);
    const unit = agoMatch[2]!;
    const d = new Date();
    if (unit.startsWith('h')) {
      d.setHours(d.getHours() - n);
    } else {
      d.setDate(d.getDate() - n);
    }
    return d;
  }

  // "this week"
  if (lower === 'this week') {
    const d = new Date();
    const dayOfWeek = d.getDay();
    d.setDate(d.getDate() - dayOfWeek);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Try ISO date parse
  const parsed = new Date(since);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

export async function sessionsCommand(
  api: SpaghettiAPI,
  projectInput: string | undefined,
  opts: SessionsOptions,
): Promise<void> {
  const projects = api.getProjectList();

  // Resolve project
  const input = projectInput ?? '.';
  const project = resolveProject(input, projects);

  if (!project) {
    throw noProjectMatch(input, suggestProjects(input, projects));
  }

  let sessions = api.getSessionList(project.slug);

  // Filter by --since
  if (opts.since) {
    const sinceDate = parseSince(opts.since);
    if (sinceDate) {
      const sinceMs = sinceDate.getTime();
      sessions = sessions.filter((s: any) => new Date(s.lastUpdate).getTime() >= sinceMs);
    } else {
      process.stderr.write(theme.warning(`\n  Could not parse time: "${opts.since}"\n\n`));
    }
  }

  // Sort
  const sortKey = (opts.sort ?? 'recent') as SortKey;
  sessions = sortSessions(sessions, sortKey);

  // Limit
  if (!opts.all) {
    const limit = opts.limit ?? 20;
    sessions = sessions.slice(0, limit);
  }

  // JSON output
  if (opts.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write('\n  ' + theme.project(project.folderName) + '\n' + theme.muted('  No sessions found.\n\n'));
    return;
  }

  // Header
  const totalSessions = api.getSessionList(project.slug).length;
  const header = `  ${theme.project(project.folderName)} ${theme.muted(`(${totalSessions} sessions)`)}`;

  const columns: Column[] = [
    {
      key: '_index',
      label: '#',
      width: 4,
      align: 'right',
      format: (v: any) => theme.muted(String(v)),
    },
    {
      key: 'gitBranch',
      label: 'Branch',
      format: (v: any) => {
        const branch = String(v || '');
        return branch ? theme.accent(branch) : theme.muted('-');
      },
    },
    {
      key: 'messageCount',
      label: 'Msgs',
      width: 6,
      align: 'right',
      format: (v: any) => formatNumber(Number(v)),
    },
    {
      key: 'tokenUsage',
      label: 'Tokens',
      width: 9,
      align: 'right',
      format: (v: any) => {
        const usage = v as SessionListItem['tokenUsage'];
        return theme.tokens(formatTokens(totalTokens(usage)));
      },
    },
    {
      key: 'lifespanMs',
      label: 'Duration',
      width: 10,
      align: 'right',
      format: (v: any) => theme.muted(formatDuration(Number(v))),
    },
    {
      key: '_summary',
      label: 'Summary',
      format: (v: any) => String(v || ''),
    },
  ];

  // Add index and summary to data
  const rows = sessions.map((s: any, i: number) => ({
    ...s,
    _index: i + 1,
    _summary: s.summary || s.firstPrompt || '',
  }));

  const table = renderTable(rows, columns);

  // Footer
  let totalTok = 0;
  let totalMsgs = 0;
  for (const s of sessions) {
    totalTok += totalTokens(s.tokenUsage);
    totalMsgs += s.messageCount;
  }

  const showing =
    sessions.length < totalSessions ? `showing ${sessions.length}/${totalSessions}` : `${sessions.length} sessions`;

  const footer = theme.muted(
    `  ${showing} \u00b7 ${formatNumber(totalMsgs)} messages \u00b7 ${formatTokens(totalTok)} tokens`,
  );

  process.stdout.write('\n' + header + '\n\n' + table + '\n\n' + footer + '\n\n');
}
