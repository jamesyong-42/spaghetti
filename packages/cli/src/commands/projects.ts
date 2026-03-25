/**
 * Projects command — list all projects with usage stats
 */

import type { SpaghettiAPI, ProjectListItem } from '@vibecook/spaghetti-core';
import { theme } from '../lib/color.js';
import { formatTokens, formatRelativeTime, formatNumber, totalTokens } from '../lib/format.js';
import { renderTable } from '../lib/table.js';
import type { Column } from '../lib/table.js';
import { browseCommand } from './browse.js';
import { TUINotAvailableError } from '../lib/tui.js';

export interface ProjectsOptions {
  sort?: string;
  limit?: number;
  interactive?: boolean;
  json?: boolean;
}

type SortKey = 'active' | 'sessions' | 'messages' | 'tokens' | 'name';

function sortProjects(projects: ProjectListItem[], key: SortKey): ProjectListItem[] {
  const sorted = [...projects];
  switch (key) {
    case 'active':
      return sorted.sort((a: ProjectListItem, b: ProjectListItem) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    case 'sessions':
      return sorted.sort((a: ProjectListItem, b: ProjectListItem) => b.sessionCount - a.sessionCount);
    case 'messages':
      return sorted.sort((a: ProjectListItem, b: ProjectListItem) => b.messageCount - a.messageCount);
    case 'tokens':
      return sorted.sort((a: ProjectListItem, b: ProjectListItem) => totalTokens(b.tokenUsage) - totalTokens(a.tokenUsage));
    case 'name':
      return sorted.sort((a: ProjectListItem, b: ProjectListItem) => a.folderName.localeCompare(b.folderName));
    default:
      return sorted;
  }
}

export async function projectsCommand(api: SpaghettiAPI, opts: ProjectsOptions): Promise<void> {
  // Interactive mode: delegate to browse command when TTY and not explicitly disabled
  const interactive = opts.interactive !== false && !opts.json && !opts.limit;
  if (interactive) {
    try {
      await browseCommand(api);
      return;
    } catch (err) {
      if (err instanceof TUINotAvailableError) {
        // Fall through to static output
      } else {
        throw err;
      }
    }
  }

  let projects = api.getProjectList();

  // Sort
  const sortKey = (opts.sort ?? 'active') as SortKey;
  projects = sortProjects(projects, sortKey);

  // Limit
  if (opts.limit && opts.limit > 0) {
    projects = projects.slice(0, opts.limit);
  }

  // JSON output
  if (opts.json) {
    process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
    return;
  }

  if (projects.length === 0) {
    process.stdout.write(theme.muted('\n  No projects found.\n\n'));
    return;
  }

  const columns: Column[] = [
    {
      key: '_index',
      label: '#',
      width: 4,
      align: 'right',
      format: (v: any) => theme.muted(String(v)),
    },
    {
      key: 'folderName',
      label: 'Project',
      format: (v: any) => theme.project(String(v)),
    },
    {
      key: 'sessionCount',
      label: 'Sessions',
      width: 10,
      align: 'right',
      format: (v: any) => formatNumber(Number(v)),
    },
    {
      key: 'messageCount',
      label: 'Messages',
      width: 10,
      align: 'right',
      format: (v: any) => formatNumber(Number(v)),
    },
    {
      key: 'tokenUsage',
      label: 'Tokens',
      width: 10,
      align: 'right',
      format: (v: any) => {
        const usage = v as ProjectListItem['tokenUsage'];
        return theme.tokens(formatTokens(totalTokens(usage)));
      },
    },
    {
      key: 'lastActiveAt',
      label: 'Last Active',
      width: 12,
      align: 'right',
      format: (v: any) => theme.time(formatRelativeTime(String(v))),
    },
  ];

  // Add index to data
  const rows = projects.map((p: any, i: number) => ({ ...p, _index: i + 1 }));

  const table = renderTable(rows, columns);

  // Summary footer
  let totalSessions = 0;
  let totalMessages = 0;
  let totalTok = 0;
  for (const p of projects) {
    totalSessions += p.sessionCount;
    totalMessages += p.messageCount;
    totalTok += totalTokens(p.tokenUsage);
  }

  const footer = theme.muted(
    `  ${projects.length} projects \u00b7 ${formatNumber(totalSessions)} sessions \u00b7 ${formatNumber(totalMessages)} messages \u00b7 ${formatTokens(totalTok)} tokens`,
  );

  process.stdout.write('\n' + table + '\n\n' + footer + '\n\n');
}
