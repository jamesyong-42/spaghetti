/**
 * Chat command — list active channel sessions, send messages, and follow
 * message streams for the spaghetti-channel plugin.
 *
 * This command is fully non-interactive (no Ink UI), designed for scripting
 * and agents. It speaks to each Claude Code session's channel MCP server via
 * the WebSocket protocol defined in @vibecook/spaghetti-core.
 */

import {
  createChannelRegistry,
  createChannelClient,
  createChannelManager,
  type SessionInfo,
  type ChannelIncoming,
  type ChannelMessage,
} from '@vibecook/spaghetti-core';
import { theme } from '../lib/color.js';
import { formatRelativeTime, formatNumber } from '../lib/format.js';
import { renderTable } from '../lib/table.js';
import type { Column } from '../lib/table.js';

export interface ChatOptions {
  follow?: boolean;
  session?: string;
  all?: boolean;
  json?: boolean;
  limit?: number;
  cleanup?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const MESSAGE_TYPE_COLORS: Record<string, string> = {
  message_echo: 'blue',
  message: 'blue',
  reply: 'green',
  permission_request: 'yellow',
  status: 'gray',
  edit: 'cyan',
  pong: 'gray',
  permission_verdict: 'gray',
  ping: 'gray',
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

/**
 * Discover sessions once. Starts a registry, waits briefly for the initial
 * watch to settle, snapshots, then stops.
 */
async function discoverSessionsOnce(): Promise<SessionInfo[]> {
  const registry = createChannelRegistry();
  registry.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const sessions = registry.getSessions();
  registry.stop();
  return sortSessions(sessions);
}

/**
 * Resolve a session by prefix UUID or 1-based integer index.
 * Throws with a helpful message on miss / ambiguity.
 */
function resolveSession(sessions: SessionInfo[], selector: string): SessionInfo {
  const sorted = sortSessions(sessions);

  // Integer index (1-based)
  if (/^\d+$/.test(selector)) {
    const idx = parseInt(selector, 10);
    if (idx < 1 || idx > sorted.length) {
      const err = new Error(`Session index ${idx} out of range (1..${sorted.length}).`);
      (err as Error & { candidates?: SessionInfo[] }).candidates = sorted;
      throw err;
    }
    return sorted[idx - 1]!;
  }

  // UUID prefix
  const prefix = selector.toLowerCase();
  if (prefix.length < 4) {
    throw new Error(`Session prefix "${selector}" is too short (need at least 4 chars).`);
  }

  const matches = sorted.filter((s) => s.id.toLowerCase().startsWith(prefix));
  if (matches.length === 0) {
    const err = new Error(`No session matches prefix "${selector}".`);
    (err as Error & { candidates?: SessionInfo[] }).candidates = sorted;
    throw err;
  }
  if (matches.length > 1) {
    const err = new Error(`Prefix "${selector}" is ambiguous (${matches.length} matches).`);
    (err as Error & { candidates?: SessionInfo[] }).candidates = matches;
    throw err;
  }
  return matches[0]!;
}

function writeCandidates(sessions: SessionInfo[]): void {
  if (sessions.length === 0) return;
  process.stderr.write(theme.muted('\n  Candidates:\n'));
  sessions.forEach((s, i) => {
    process.stderr.write(
      `    ${theme.muted(String(i + 1).padStart(2))}  ${theme.accent(shortId(s.id))}  ${theme.project(s.projectName)}\n`,
    );
  });
  process.stderr.write('\n');
}

/**
 * Format a single message line in follow mode.
 *
 *   14:32:45  spaghetti/7f52  reply     Claude's response text...
 */
function formatMessageLine(sessionInfo: SessionInfo, msg: ChannelMessage): string {
  const tsRaw = extractTimestamp(msg) ?? new Date().toISOString();
  const time = tsRaw.slice(11, 23);
  const color = MESSAGE_TYPE_COLORS[msg.type] ?? 'white';
  const tag = `${sessionInfo.projectName}/${shortId(sessionInfo.id)}`;

  let kind: string;
  let body: string;
  switch (msg.type) {
    case 'reply': {
      kind = 'reply';
      body = msg.text;
      break;
    }
    case 'message_echo': {
      kind = msg.sender === 'cli' || msg.sender === 'tui' ? 'you' : msg.sender;
      body = msg.text;
      break;
    }
    case 'message': {
      // outgoing (shouldn't normally appear, but handle for completeness)
      kind = 'you';
      body = msg.text;
      break;
    }
    case 'edit': {
      kind = 'edit';
      body = `[${msg.messageId.slice(0, 6)}] ${msg.text}`;
      break;
    }
    case 'permission_request': {
      kind = 'permission';
      body = `${msg.toolName}  ${msg.inputPreview}  [id=${msg.requestId.slice(0, 6)}]`;
      break;
    }
    case 'status': {
      kind = 'status';
      body = msg.connected ? 'connected' : 'disconnected';
      break;
    }
    case 'pong': {
      kind = 'pong';
      body = '';
      break;
    }
    default: {
      kind = (msg as { type: string }).type;
      body = '';
      break;
    }
  }

  const kindStr = kind.padEnd(10);
  const bodyStr = body ? `  ${body}` : '';

  return `  ${theme.muted(time)}  ${theme.accent(tag.padEnd(24))}  ${theme.colorize(color, kindStr)}${bodyStr}`;
}

function extractTimestamp(msg: ChannelMessage): string | null {
  if ('timestamp' in msg && typeof (msg as { timestamp?: unknown }).timestamp === 'string') {
    return (msg as { timestamp: string }).timestamp;
  }
  return null;
}

// ─── Modes ───────────────────────────────────────────────────────────────

async function runCleanup(opts: ChatOptions): Promise<void> {
  const registry = createChannelRegistry();
  const removed = registry.cleanupStale();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, removed }) + '\n');
    return;
  }
  if (removed === 0) {
    process.stdout.write(theme.muted('\n  No stale session files found.\n\n'));
  } else {
    process.stdout.write(theme.success(`\n  Removed ${removed} stale session file(s).\n\n`));
  }
}

async function runList(opts: ChatOptions): Promise<void> {
  const sessions = await discoverSessionsOnce();

  if (sessions.length === 0) {
    if (opts.json) {
      process.stdout.write('[]\n');
      return;
    }
    process.stderr.write(
      theme.muted(
        '\n  No active channel sessions. Start a Claude Code session with the spaghetti-channel plugin installed.\n\n',
      ),
    );
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    return;
  }

  const columns: Column[] = [
    {
      key: '_index',
      label: '#',
      width: 4,
      align: 'right',
      format: (v: unknown) => theme.muted(String(v)),
    },
    {
      key: 'id',
      label: 'id',
      width: 10,
      format: (v: unknown) => theme.accent(shortId(String(v))),
    },
    {
      key: 'projectName',
      label: 'project',
      format: (v: unknown) => theme.project(String(v)),
    },
    {
      key: 'messageCount',
      label: 'messages',
      width: 10,
      align: 'right',
      format: (v: unknown) => formatNumber(Number(v)),
    },
    {
      key: 'startedAt',
      label: 'started',
      width: 12,
      align: 'right',
      format: (v: unknown) => theme.time(formatRelativeTime(String(v))),
    },
    {
      key: 'port',
      label: 'port',
      width: 6,
      align: 'right',
      format: (v: unknown) => theme.muted(String(v)),
    },
  ];

  const rows = sessions.map((s, i) => ({ ...s, _index: i + 1 }));

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${theme.heading('Channel Sessions')}  ${theme.muted(`(${sessions.length} active)`)}`);
  lines.push('');
  lines.push(renderTable(rows, columns));
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

async function runSend(message: string, opts: ChatOptions): Promise<void> {
  if (!opts.session) {
    process.stderr.write(theme.error('\n  --session <id> is required when sending a message.\n\n'));
    process.exit(1);
  }

  const sessions = await discoverSessionsOnce();
  if (sessions.length === 0) {
    process.stderr.write(theme.error('\n  No active channel sessions.\n\n'));
    process.exit(1);
  }

  let target: SessionInfo;
  try {
    target = resolveSession(sessions, opts.session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(theme.error(`\n  ${msg}\n`));
    const candidates = (err as Error & { candidates?: SessionInfo[] }).candidates;
    if (candidates) writeCandidates(candidates);
    process.exit(1);
  }

  const client = createChannelClient(target, { sender: 'cli' });

  try {
    await client.connect();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      theme.error(`\n  Failed to connect to session ${shortId(target.id)} at ws://127.0.0.1:${target.port}\n`) +
        theme.muted(`  ${errMsg}\n\n`),
    );
    process.exit(1);
  }

  // Capture a message id via a small hack: we track the last sent id by wrapping
  // a single-shot send. Since sendMessage doesn't return an id, we synthesize
  // our own uuid for the response but the client generates its own internally.
  // For the --json output we report the echo id if we see one within a short
  // window; otherwise fall back to a placeholder "sent".
  let echoedId: string | null = null;
  const unsub = client.onMessage((m) => {
    if (m.type === 'message_echo' && (m.sender === 'cli' || m.text === message)) {
      echoedId = m.id;
    }
  });

  client.sendMessage(message, 'cli');

  // Give the WS write + server echo a moment to flush.
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  unsub();
  client.disconnect();

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, sessionId: target.id, messageId: echoedId }) + '\n');
  } else {
    process.stdout.write(
      `${theme.success('Sent.')}  ${theme.muted(`→ ${target.projectName}/${shortId(target.id)}`)}\n`,
    );
  }
}

async function runFollow(opts: ChatOptions): Promise<void> {
  const limit = opts.limit ?? 20;

  const manager = createChannelManager({ sender: 'cli' });
  await manager.start();

  // Settle the initial watch.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  // Determine target sessions (filtered if --session is given).
  const allSessions = sortSessions(manager.getSessions());
  let targetSessions: SessionInfo[];
  let targetIds: Set<string> | null = null;

  if (opts.session) {
    let chosen: SessionInfo;
    try {
      chosen = resolveSession(allSessions, opts.session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(theme.error(`\n  ${msg}\n`));
      const candidates = (err as Error & { candidates?: SessionInfo[] }).candidates;
      if (candidates) writeCandidates(candidates);
      manager.stop();
      process.exit(1);
    }
    targetSessions = [chosen];
    targetIds = new Set([chosen.id]);
  } else {
    targetSessions = allSessions;
  }

  // Initial history block for each targeted session.
  if (!opts.json) {
    process.stderr.write('\n');
    if (targetSessions.length === 0) {
      process.stderr.write(theme.muted('  No active channel sessions yet. Waiting...\n\n'));
    } else {
      const scope = opts.session ? 'session' : 'sessions';
      process.stderr.write(
        `  ${theme.heading(`Following ${targetSessions.length} ${scope}`)}  ${theme.muted(`(last ${limit} messages)`)}\n\n`,
      );
    }
  }

  for (const info of targetSessions) {
    const client = manager.getClient(info.id);
    if (!client) continue;
    const history = client.getHistory(limit);
    if (history.length === 0) continue;

    if (opts.json) {
      for (const entry of history) {
        process.stdout.write(JSON.stringify({ sessionId: info.id, ...entry }) + '\n');
      }
    } else {
      for (const entry of history) {
        process.stdout.write(formatMessageLine(info, entry) + '\n');
      }
    }
  }

  if (!opts.json) {
    process.stderr.write(`\n  ${theme.accent('●')} ${theme.muted('Streaming messages... (Ctrl+C to stop)')}\n\n`);
  }

  // Subscribe to live messages.
  manager.onAnyMessage((sessionId, msg: ChannelIncoming) => {
    if (targetIds && !targetIds.has(sessionId)) return;
    const info = manager.getSessions().find((s) => s.id === sessionId);
    if (!info) return;

    if (opts.json) {
      process.stdout.write(JSON.stringify({ sessionId, ...msg }) + '\n');
    } else {
      process.stdout.write(formatMessageLine(info, msg) + '\n');
    }
  });

  // Notice session joins/leaves.
  manager.onSessionsChanged((sessions) => {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          type: '_session_change',
          sessions: sessions.map((s) => ({ id: s.id, projectName: s.projectName })),
        }) + '\n',
      );
      return;
    }
    process.stderr.write(theme.muted(`  ${theme.accent('●')} sessions changed — ${sessions.length} active\n`));
  });

  // Wait for Ctrl+C.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      manager.stop();
      resolve();
    });
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function chatCommand(message: string | undefined, opts: ChatOptions): Promise<void> {
  try {
    if (opts.cleanup) {
      await runCleanup(opts);
      return;
    }

    if (opts.follow) {
      await runFollow(opts);
      return;
    }

    if (message !== undefined && message !== '') {
      await runSend(message, opts);
      return;
    }

    await runList(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(theme.error(`\n  chat: ${msg}\n\n`));
    process.exit(1);
  }
}
