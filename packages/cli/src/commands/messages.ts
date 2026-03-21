/**
 * Messages command — read messages from a session
 */

import type { SpaghettiAPI } from '@spaghetti/core';
import { theme } from '../lib/color.js';
import { formatTokens, formatRelativeTime, formatDuration, formatNumber, totalTokens } from '../lib/format.js';
import { resolveProject, resolveSession, suggestProjects } from '../lib/resolve.js';
import { UserError, noProjectMatch, noSessionMatch } from '../lib/error.js';
import { renderMessages } from '../lib/message-render.js';
import { outputWithPager } from '../lib/pager.js';
import { getTerminalWidth } from '../lib/terminal.js';

export interface MessagesOptions {
  limit?: number;
  offset?: number;
  last?: number;
  compact?: boolean;
  noTools?: boolean;
  noThinking?: boolean;
  raw?: boolean;
  json?: boolean;
}

export async function messagesCommand(
  api: SpaghettiAPI,
  projectInput: string | undefined,
  sessionInput: string | undefined,
  opts: MessagesOptions,
): Promise<void> {
  const projects = api.getProjectList();

  // Resolve project
  const projStr = projectInput ?? '.';
  const project = resolveProject(projStr, projects);

  if (!project) {
    throw noProjectMatch(projStr, suggestProjects(projStr, projects));
  }

  // Resolve session
  const sessions = api.getSessionList(project.slug);

  if (sessions.length === 0) {
    throw new UserError(
      `No sessions found for "${project.folderName}"`,
      `  Run \`spaghetti projects\` to verify the project has sessions.`,
    );
  }

  const sesStr = sessionInput ?? '1'; // default to latest
  const session = resolveSession(sesStr, sessions);

  if (!session) {
    throw noSessionMatch(sesStr, project.folderName);
  }

  // Calculate offset and limit
  let limit = opts.limit ?? 50;
  let offset = opts.offset ?? 0;

  if (opts.last) {
    // Show last N messages: compute offset from total
    const total = session.messageCount;
    offset = Math.max(total - opts.last, 0);
    limit = opts.last;
  }

  // Fetch messages
  const page = api.getSessionMessages(project.slug, session.sessionId, limit, offset);

  // JSON output
  if (opts.json) {
    process.stdout.write(JSON.stringify(page, null, 2) + '\n');
    return;
  }

  // Raw output
  if (opts.raw) {
    for (const msg of page.messages) {
      process.stdout.write(JSON.stringify(msg) + '\n');
    }
    return;
  }

  const width = getTerminalWidth();
  const divider = theme.muted('\u2500'.repeat(Math.min(width, 60)));

  // Session header
  const headerLines: string[] = [];
  headerLines.push('');
  headerLines.push(`  ${theme.project(project.folderName)} ${theme.muted('\u203a')} ${theme.accent('Session')}`);
  headerLines.push('');

  const metaParts: string[] = [];
  if (session.gitBranch) {
    metaParts.push(`${theme.label('Branch:')} ${theme.accent(session.gitBranch)}`);
  }
  metaParts.push(`${theme.label('Messages:')} ${formatNumber(session.messageCount)}`);
  metaParts.push(`${theme.label('Tokens:')} ${theme.tokens(formatTokens(totalTokens(session.tokenUsage)))}`);
  metaParts.push(`${theme.label('Duration:')} ${formatDuration(session.lifespanMs)}`);
  metaParts.push(`${theme.label('Last active:')} ${formatRelativeTime(session.lastUpdate)}`);

  for (const part of metaParts) {
    headerLines.push(`  ${part}`);
  }

  if (session.summary) {
    headerLines.push('');
    headerLines.push(`  ${theme.label('Summary:')} ${session.summary}`);
  }

  headerLines.push('');
  headerLines.push(`  ${divider}`);
  headerLines.push('');

  // Render messages
  const rendered = renderMessages(page.messages, {
    compact: opts.compact,
    noTools: opts.noTools,
    noThinking: opts.noThinking,
    width,
  });

  // Pagination footer
  const footerParts: string[] = [];
  if (page.offset > 0) {
    footerParts.push(`offset ${page.offset}`);
  }
  footerParts.push(`${page.messages.length}/${page.total} messages`);
  if (page.hasMore) {
    footerParts.push('more available (use --offset or --last)');
  }
  const footer = theme.muted(`  ${footerParts.join(' \u00b7 ')}`);

  const output = headerLines.join('\n') + rendered + '\n\n' + footer + '\n';

  outputWithPager(output);
}
