/**
 * Channel Message Types — WebSocket protocol and session discovery types
 * for the spaghetti channel MCP server.
 *
 * The channel server writes a per-session discovery file to
 * ~/.spaghetti/channel/sessions/<uuid>.json and exposes a WebSocket on an
 * auto-allocated loopback port. Clients (e.g. the TUI) read discovery files
 * and connect via WebSocket to exchange chat messages and permission
 * verdicts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Session discovery ───────────────────────────────────────────────────

/**
 * Contents of a session discovery file, written by the channel MCP server
 * to `~/.spaghetti/channel/sessions/<uuid>.json`. Each running server
 * refreshes this file periodically (heartbeat).
 */
export interface SessionInfo {
  id: string;
  port: number;
  pid: number;
  parentPid: number;
  cwd: string;
  projectName: string;
  /** ISO-8601 timestamp when the server started. */
  startedAt: string;
  /** ISO-8601 timestamp of the most recent heartbeat write. */
  lastHeartbeat: string;
  messageCount: number;
  claudeSessionId: string | null;
}

/** File reference used for attachments on channel messages. */
export interface FileRef {
  path: string;
  name?: string;
}

// ─── Client → Server messages ────────────────────────────────────────────

/** Chat message sent by the client (TUI) to the server. */
export interface ClientMessage {
  type: 'message';
  id: string;
  text: string;
  sender: string;
}

/** Verdict in response to a server permission request. */
export interface ClientPermissionVerdict {
  type: 'permission_verdict';
  requestId: string;
  behavior: 'allow' | 'deny';
}

/** Keep-alive ping. Server responds with a `pong`. */
export interface ClientPing {
  type: 'ping';
}

/** Union of every message a client can send. */
export type ChannelOutgoing = ClientMessage | ClientPermissionVerdict | ClientPing;

// ─── Server → Client messages ────────────────────────────────────────────

/** Server echoes back a client message so it appears in history. */
export interface MessageEcho {
  type: 'message_echo';
  id: string;
  text: string;
  timestamp: string;
  sender: string;
}

/** Reply produced by the server / Claude session. */
export interface ReplyMessage {
  type: 'reply';
  id: string;
  text: string;
  timestamp: string;
  inReplyTo?: string;
  files?: FileRef[];
}

/** Edit of an existing message in the transcript. */
export interface EditMessage {
  type: 'edit';
  messageId: string;
  text: string;
  timestamp: string;
}

/** Permission request from the server awaiting a verdict from the client. */
export interface PermissionRequestMessage {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

/** Connection status update with full session info. */
export interface StatusMessage {
  type: 'status';
  connected: boolean;
  sessionInfo: SessionInfo;
}

/** Response to a client ping. */
export interface PongMessage {
  type: 'pong';
}

/** Union of every message the server can send. */
export type ChannelIncoming =
  | MessageEcho
  | ReplyMessage
  | EditMessage
  | PermissionRequestMessage
  | StatusMessage
  | PongMessage;

/** Union of every channel message (useful for JSONL history). */
export type ChannelMessage = ChannelIncoming | ChannelOutgoing;

// ─── Type guards ─────────────────────────────────────────────────────────

const INCOMING_TYPES = new Set<ChannelIncoming['type']>([
  'message_echo',
  'reply',
  'edit',
  'permission_request',
  'status',
  'pong',
]);

const OUTGOING_TYPES = new Set<ChannelOutgoing['type']>(['message', 'permission_verdict', 'ping']);

/** True if `msg` is a server → client message. */
export function isIncoming(msg: ChannelMessage): msg is ChannelIncoming {
  return INCOMING_TYPES.has(msg.type as ChannelIncoming['type']);
}

/** True if `msg` is a client → server message. */
export function isOutgoing(msg: ChannelMessage): msg is ChannelOutgoing {
  return OUTGOING_TYPES.has(msg.type as ChannelOutgoing['type']);
}

// ─── Default paths ───────────────────────────────────────────────────────

/** Absolute path to the channel session discovery directory. */
export function getChannelSessionsDir(): string {
  return join(homedir(), '.spaghetti', 'channel', 'sessions');
}

/** Absolute path to the channel messages (JSONL history) directory. */
export function getChannelMessagesDir(): string {
  return join(homedir(), '.spaghetti', 'channel', 'messages');
}
