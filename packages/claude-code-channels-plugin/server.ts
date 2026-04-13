#!/usr/bin/env bun
/**
 * Spaghetti Channel — Universal chat bridge for Claude Code sessions.
 *
 * Each Claude Code session spawns its own instance of this MCP server. Every
 * instance allocates a loopback WebSocket port and writes a discovery file to
 * ~/.spaghetti/channel/sessions/<uuid>.json so external clients (TUI, web,
 * mobile) can find and connect to the running session.
 *
 * Phase 1 scope:
 *  - MCP server declaring the claude/channel + permission capabilities
 *  - Bidirectional bridge: WS client ↔ notifications/claude/channel
 *  - Permission request relay from Claude Code to WS clients and back
 *  - Reply + edit_message tools
 *  - JSONL message persistence
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync, rmSync, appendFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { ServerWebSocket, Server as BunHttpServer } from 'bun';

// --- Paths ------------------------------------------------------------------

const STATE_DIR = join(homedir(), '.spaghetti', 'channel');
const SESSIONS_DIR = join(STATE_DIR, 'sessions');
const MESSAGES_DIR = join(STATE_DIR, 'messages');

const SESSION_ID = randomUUID();
const SESSION_FILE = join(SESSIONS_DIR, `${SESSION_ID}.json`);
const MESSAGES_FILE = join(MESSAGES_DIR, `${SESSION_ID}.jsonl`);

try {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(MESSAGES_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(
    `spaghetti-channel: failed to create state dirs: ${String(err)}\n`,
  );
}

// --- Port allocation --------------------------------------------------------

const PORT_START = 9888;
const PORT_END = 9988; // inclusive

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => {
      resolve(true);
    });
    sock.setTimeout(250, () => {
      sock.destroy();
      resolve(true);
    });
  });
}

async function allocatePort(): Promise<number> {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(
    `no free port in range ${PORT_START}..${PORT_END} for spaghetti-channel`,
  );
}

// --- Session registry file --------------------------------------------------

interface SessionInfo {
  id: string;
  port: number;
  pid: number;
  parentPid: number;
  cwd: string;
  projectName: string;
  startedAt: string;
  lastHeartbeat: string;
  messageCount: number;
  claudeSessionId: null;
}

let sessionInfo: SessionInfo = {
  id: SESSION_ID,
  port: 0,
  pid: process.pid,
  parentPid: process.ppid,
  cwd: process.cwd(),
  projectName: basename(process.cwd()) || 'unknown',
  startedAt: new Date().toISOString(),
  lastHeartbeat: new Date().toISOString(),
  messageCount: 0,
  claudeSessionId: null,
};

function writeSessionFile(): void {
  // Atomic write: write to a temp file, then rename. Prevents TUI clients
  // from reading a half-written file during the 5s heartbeat interval.
  const tmp = `${SESSION_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(sessionInfo, null, 2)}\n`);
    renameSync(tmp, SESSION_FILE);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    process.stderr.write(`spaghetti-channel: failed to write session file: ${String(err)}\n`);
  }
}

function removeSessionFile(): void {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: failed to remove session file: ${String(err)}\n`,
    );
  }
}

// --- Message persistence ----------------------------------------------------

interface PersistedEntry {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

function persistMessage(entry: Omit<PersistedEntry, 'timestamp'> & { timestamp?: string }): void {
  const full: PersistedEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    ...entry,
  };
  try {
    appendFileSync(MESSAGES_FILE, `${JSON.stringify(full)}\n`);
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: failed to persist message: ${String(err)}\n`,
    );
  }
}

// --- WebSocket bookkeeping --------------------------------------------------

type WsData = { clientId: string };
const clients = new Set<ServerWebSocket<WsData>>();

interface OutboundMessageEcho {
  type: 'message_echo';
  id: string;
  text: string;
  timestamp: string;
  sender: string;
}
interface OutboundReply {
  type: 'reply';
  id: string;
  text: string;
  timestamp: string;
  inReplyTo?: string;
  files?: Array<{ path: string; name?: string }>;
}
interface OutboundEdit {
  type: 'edit';
  messageId: string;
  text: string;
  timestamp: string;
}
interface OutboundPermissionRequest {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}
interface OutboundStatus {
  type: 'status';
  connected: boolean;
  sessionInfo: SessionInfo;
}
interface OutboundPong {
  type: 'pong';
}

type OutboundWire =
  | OutboundMessageEcho
  | OutboundReply
  | OutboundEdit
  | OutboundPermissionRequest
  | OutboundStatus
  | OutboundPong;

function broadcast(msg: OutboundWire): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch (err) {
        process.stderr.write(
          `spaghetti-channel: ws send failed: ${String(err)}\n`,
        );
      }
    }
  }
}

function sendTo(ws: ServerWebSocket<WsData>, msg: OutboundWire): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: ws send failed: ${String(err)}\n`,
    );
  }
}

// --- MCP server -------------------------------------------------------------

const mcp = new Server(
  { name: 'spaghetti-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: `Events from spaghetti-channel arrive as <channel source="spaghetti-channel" ...>.
Each event has a 'sender' meta attribute identifying the client (tui, web, cli).

When you receive a channel message, treat it like a user prompt and act on it.
Use the 'reply' tool to send your response back to the sender.

For permission requests, users reply with 'y <id>' or 'n <id>' where <id> is the
5-letter request ID you issued. Match the ID to the correct request.

You can optionally attach files to replies using the 'files' parameter.`,
  },
);

// --- Tools ------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a reply to all connected channel clients. Use inReplyTo for quote-reply and files for attachments.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The reply text.' },
          inReplyTo: {
            type: 'string',
            description: 'Optional ID of the message being replied to.',
          },
          files: {
            type: 'array',
            description: 'Optional file attachments.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['path'],
            },
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description:
        'Edit a previously sent message. Clients decide how to render the edit.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'ID of the message to edit.',
          },
          text: { type: 'string', description: 'The new text.' },
        },
        required: ['messageId', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = String(args.text ?? '');
        const inReplyTo =
          typeof args.inReplyTo === 'string' ? args.inReplyTo : undefined;
        const files = Array.isArray(args.files)
          ? (args.files as Array<{ path: string; name?: string }>)
          : undefined;
        const id = randomUUID();
        const timestamp = new Date().toISOString();

        const wire: OutboundReply = {
          type: 'reply',
          id,
          text,
          timestamp,
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(files ? { files } : {}),
        };
        broadcast(wire);
        persistMessage({
          type: 'reply',
          timestamp,
          id,
          text,
          inReplyTo,
          files,
        });
        sessionInfo.messageCount++;

        return {
          content: [{ type: 'text', text: 'Reply delivered.' }],
        };
      }

      case 'edit_message': {
        const messageId = String(args.messageId ?? '');
        const text = String(args.text ?? '');
        const timestamp = new Date().toISOString();

        const wire: OutboundEdit = {
          type: 'edit',
          messageId,
          text,
          timestamp,
        };
        broadcast(wire);
        persistMessage({
          type: 'edit',
          timestamp,
          messageId,
          text,
        });

        return {
          content: [{ type: 'text', text: 'Edit delivered.' }],
        };
      }

      default:
        return {
          content: [
            { type: 'text', text: `unknown tool: ${req.params.name}` },
          ],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `${req.params.name} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      isError: true,
    };
  }
});

// --- Permission relay -------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Track pending permission requests with a TTL. This prevents:
//   (a) unbounded growth if a verdict never arrives
//   (b) forwarding arbitrary/unknown verdicts to Claude Code
const PENDING_PERMISSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_PERMISSIONS = 100;
const pendingPermissions = new Map<string, { expiresAt: number }>();

function evictExpiredPermissions(): void {
  const now = Date.now();
  for (const [id, entry] of pendingPermissions) {
    if (entry.expiresAt <= now) pendingPermissions.delete(id);
  }
  // Hard cap: if we're still over the limit, drop oldest entries.
  if (pendingPermissions.size > MAX_PENDING_PERMISSIONS) {
    const excess = pendingPermissions.size - MAX_PENDING_PERMISSIONS;
    const keys = pendingPermissions.keys();
    for (let i = 0; i < excess; i++) {
      const k = keys.next().value;
      if (k !== undefined) pendingPermissions.delete(k);
    }
  }
}

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  evictExpiredPermissions();
  pendingPermissions.set(params.request_id, {
    expiresAt: Date.now() + PENDING_PERMISSION_TTL_MS,
  });
  const wire: OutboundPermissionRequest = {
    type: 'permission_request',
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
  };
  broadcast(wire);
  persistMessage({
    type: 'permission_request',
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
  });
});

// --- Inbound WS message handling -------------------------------------------

const InboundMessageSchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  text: z.string(),
  sender: z.string(),
});

const InboundPermissionVerdictSchema = z.object({
  type: z.literal('permission_verdict'),
  requestId: z.string(),
  behavior: z.union([z.literal('allow'), z.literal('deny')]),
});

const InboundPingSchema = z.object({
  type: z.literal('ping'),
});

const InboundSchema = z.union([
  InboundMessageSchema,
  InboundPermissionVerdictSchema,
  InboundPingSchema,
]);

async function handleInbound(
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    process.stderr.write('spaghetti-channel: malformed ws payload\n');
    return;
  }

  const result = InboundSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(
      `spaghetti-channel: rejected ws payload: ${result.error.message}\n`,
    );
    return;
  }
  const msg = result.data;

  if (msg.type === 'ping') {
    sendTo(ws, { type: 'pong' });
    return;
  }

  if (msg.type === 'permission_verdict') {
    // Drop verdicts for unknown / expired request IDs to avoid forwarding
    // arbitrary responses to Claude Code.
    evictExpiredPermissions();
    if (!pendingPermissions.has(msg.requestId)) {
      process.stderr.write(
        `spaghetti-channel: dropping unknown permission verdict: ${msg.requestId}\n`,
      );
      return;
    }
    pendingPermissions.delete(msg.requestId);
    persistMessage({
      type: 'permission_verdict',
      requestId: msg.requestId,
      behavior: msg.behavior,
    });
    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: msg.requestId,
          behavior: msg.behavior,
        },
      });
    } catch (err) {
      process.stderr.write(`spaghetti-channel: permission notify failed: ${String(err)}\n`);
    }
    return;
  }

  // msg.type === 'message'
  const timestamp = new Date().toISOString();
  persistMessage({
    type: 'message',
    id: msg.id,
    text: msg.text,
    sender: msg.sender,
    timestamp,
  });
  sessionInfo.messageCount++;

  broadcast({
    type: 'message_echo',
    id: msg.id,
    text: msg.text,
    timestamp,
    sender: msg.sender,
  });

  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: msg.text,
        meta: {
          sender: msg.sender,
          message_id: msg.id,
          client_timestamp: timestamp,
        },
      },
    });
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: channel notify failed: ${String(err)}\n`,
    );
  }
}

// --- HTTP + WebSocket server ------------------------------------------------

let httpServer: BunHttpServer | null = null;

async function startHttpServer(): Promise<number> {
  const port = await allocatePort();
  httpServer = Bun.serve<WsData, unknown>({
    port,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url);

      // Any path may be upgraded to WS.
      const upgraded = server.upgrade(req, {
        data: { clientId: randomUUID() },
      });
      if (upgraded) return undefined;

      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(
          JSON.stringify({
            server: 'spaghetti-channel',
            id: SESSION_ID,
            port,
            messageCount: sessionInfo.messageCount,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        sendTo(ws, {
          type: 'status',
          connected: true,
          sessionInfo,
        });
      },
      close(ws) {
        clients.delete(ws);
      },
      async message(ws, raw) {
        await handleInbound(ws, raw);
      },
    },
  });
  return port;
}

// --- Heartbeat --------------------------------------------------------------

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    sessionInfo = {
      ...sessionInfo,
      lastHeartbeat: new Date().toISOString(),
    };
    writeSessionFile();
  }, 5000);
}

// --- Shutdown ---------------------------------------------------------------

let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  removeSessionFile();
  try {
    httpServer?.stop(true);
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: http stop failed: ${String(err)}\n`,
    );
  }
  // Close WS clients.
  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
  // Let pending writes flush, then exit.
  setTimeout(() => process.exit(code), 50);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('exit', () => {
  // exit handlers must be synchronous — do the minimum.
  if (!shuttingDown) {
    shuttingDown = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    removeSessionFile();
  }
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `spaghetti-channel: unhandledRejection: ${String(reason)}\n`,
  );
});
process.on('uncaughtException', (err) => {
  process.stderr.write(
    `spaghetti-channel: uncaughtException: ${err.stack ?? String(err)}\n`,
  );
});

// Stdin close → parent (Claude Code) is gone.
process.stdin.on('close', () => shutdown(0));
process.stdin.on('end', () => shutdown(0));

// --- Boot -------------------------------------------------------------------

async function main(): Promise<void> {
  let port: number;
  try {
    port = await startHttpServer();
  } catch (err) {
    process.stderr.write(
      `spaghetti-channel: failed to start http server: ${String(err)}\n`,
    );
    process.exit(1);
  }

  sessionInfo = { ...sessionInfo, port };
  writeSessionFile();
  startHeartbeat();

  process.stderr.write(
    `spaghetti-channel: id=${SESSION_ID} port=${port} pid=${process.pid}\n`,
  );

  // Connect stdio transport last — only now will Claude Code start sending
  // us requests and notifications.
  await mcp.connect(new StdioServerTransport());
}

await main();
