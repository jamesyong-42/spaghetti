/**
 * Messages command — read messages from a session
 */

import type { SpaghettiAPI } from '@spaghetti/core';
import { theme } from '../lib/color.js';
import { formatTokens, formatRelativeTime, formatDuration, formatNumber, totalTokens } from '../lib/format.js';
import { resolveProject, resolveSession, suggestProjects } from '../lib/resolve.js';
import { UserError, noProjectMatch, noSessionMatch } from '../lib/error.js';
import { renderMessages, filterDisplayableMessages } from '../lib/message-render.js';
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
  const requestedLimit = opts.limit ?? 50;
  let offset = opts.offset ?? 0;

  if (opts.last) {
    // Show last N messages: over-fetch from the end to account for internal types
    const total = session.messageCount;
    const overfetch = opts.last * 3;
    offset = Math.max(total - overfetch, 0);
  }

  // The effective display limit: --last N overrides --limit
  const displayLimit = opts.last ?? requestedLimit;

  // JSON/raw: fetch with exact limit, no filtering
  if (opts.json) {
    const page = api.getSessionMessages(project.slug, session.sessionId, displayLimit, offset);
    process.stdout.write(JSON.stringify(page, null, 2) + '\n');
    return;
  }

  if (opts.raw) {
    const page = api.getSessionMessages(project.slug, session.sessionId, displayLimit, offset);
    for (const msg of page.messages) {
      process.stdout.write(JSON.stringify(msg) + '\n');
    }
    return;
  }

  // Over-fetch to account for internal message types (progress, file-history-snapshot,
  // saved_hook_context, queue-operation, last-prompt) that get filtered during rendering.
  // Fetch limit*3 initially, filter, and retry up to 2 times if still short.
  const OVER_FETCH_MULTIPLIER = 3;
  const MAX_RETRIES = 2;

  let page = api.getSessionMessages(project.slug, session.sessionId, displayLimit * OVER_FETCH_MULTIPLIER, offset);
  let displayMessages = filterDisplayableMessages(page.messages);
  let totalRaw = page.total;
  let lastHasMore = page.hasMore;
  let fetchOffset = offset + page.messages.length;

  for (let retry = 0; retry < MAX_RETRIES && displayMessages.length < displayLimit && lastHasMore; retry++) {
    const morePage = api.getSessionMessages(project.slug, session.sessionId, displayLimit * OVER_FETCH_MULTIPLIER, fetchOffset);
    displayMessages = displayMessages.concat(filterDisplayableMessages(morePage.messages));
    totalRaw = morePage.total;
    lastHasMore = morePage.hasMore;
    fetchOffset += morePage.messages.length;
  }

  // Trim to the requested limit: for --last, take the tail; otherwise take the head
  if (opts.last) {
    displayMessages = displayMessages.slice(-displayLimit);
  } else {
    displayMessages = displayMessages.slice(0, displayLimit);
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

  // Render messages (displayMessages is already filtered, renderMessages will be a no-op filter)
  const rendered = renderMessages(displayMessages, {
    compact: opts.compact,
    noTools: opts.noTools,
    noThinking: opts.noThinking,
    width,
  });

  // Pagination footer — reflect filtered count
  const footerParts: string[] = [];
  if (offset > 0) {
    footerParts.push(`offset ${offset}`);
  }
  footerParts.push(`${displayMessages.length}/${totalRaw} messages`);
  if (lastHasMore || displayMessages.length >= displayLimit) {
    footerParts.push('more available (use --offset or --last)');
  }
  const footer = theme.muted(`  ${footerParts.join(' \u00b7 ')}`);

  const output = headerLines.join('\n') + rendered + '\n\n' + footer + '\n';

  outputWithPager(output);
}
