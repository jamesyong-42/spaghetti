/**
 * Channel Client — per-session WebSocket client for a channel MCP server.
 *
 * Connects to `ws://127.0.0.1:<port>` using the `ws` package, reconnects with
 * exponential backoff on disconnect, keeps the connection warm with pings,
 * and exposes a typed event surface for incoming messages and status changes.
 * Also reads the per-session JSONL history from
 * `~/.spaghetti/channel/messages/<id>.jsonl`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { readJsonlStreaming } from './streaming-jsonl-reader.js';
import {
  getChannelMessagesDir,
  type ChannelIncoming,
  type ChannelMessage,
  type ClientMessage,
  type ClientPermissionVerdict,
  type ClientPing,
  type SessionInfo,
} from '../types/channel-messages.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ChannelClientOptions {
  /** Directory where per-session JSONL history lives. */
  messagesDir?: string;
  /** Default sender name used when `sendMessage` is called without one. */
  sender?: string;
}

export interface ChannelClient {
  /** Open the WebSocket connection. Resolves when `open` fires. */
  connect(): Promise<void>;
  /** Close the connection and stop reconnecting. */
  disconnect(): void;
  /** True if the socket is currently OPEN. */
  isConnected(): boolean;
  /** Send a chat message. */
  sendMessage(text: string, sender?: string): void;
  /** Respond to a server `permission_request`. */
  sendPermissionVerdict(requestId: string, behavior: 'allow' | 'deny'): void;
  /** Subscribe to incoming (server → client) messages. */
  onMessage(cb: (msg: ChannelIncoming) => void): () => void;
  /** Subscribe to connection status changes. */
  onStatusChange(cb: (connected: boolean) => void): () => void;
  /** Read the most recent `limit` entries from the persisted transcript. */
  getHistory(limit?: number): ChannelMessage[];
  /** The `SessionInfo` this client was constructed with. */
  getSessionInfo(): SessionInfo;
}

// ─── Implementation ──────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
const MAX_RECONNECT_DELAY_MS = 10_000;

const INCOMING_TYPE_SET = new Set<ChannelIncoming['type']>([
  'message_echo',
  'reply',
  'edit',
  'permission_request',
  'status',
  'pong',
]);

export function createChannelClient(sessionInfo: SessionInfo, options?: ChannelClientOptions): ChannelClient {
  const messagesDir = options?.messagesDir ?? getChannelMessagesDir();
  const defaultSender = options?.sender ?? 'tui';

  const messageListeners: Set<(msg: ChannelIncoming) => void> = new Set();
  const statusListeners: Set<(connected: boolean) => void> = new Set();

  let socket: WebSocket | null = null;
  let connected = false;
  let manuallyClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let connectPromise: Promise<void> | null = null;

  function setConnected(next: boolean): void {
    if (connected === next) return;
    connected = next;
    for (const listener of statusListeners) {
      listener(next);
    }
  }

  function clearPing(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing(): void {
    clearPing();
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const ping: ClientPing = { type: 'ping' };
        try {
          socket.send(JSON.stringify(ping));
        } catch {
          // ignore — next reconnect cycle will pick this up
        }
      }
    }, PING_INTERVAL_MS);
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (manuallyClosed) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

    const delay =
      RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)] ?? MAX_RECONNECT_DELAY_MS;
    reconnectAttempts++;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket().catch(() => {
        // Errors flow through onclose → scheduleReconnect.
      });
    }, delay);
  }

  function handleIncoming(raw: WebSocket.RawData): void {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf-8');
    } else if (Array.isArray(raw)) {
      text = Buffer.concat(raw as Buffer[]).toString('utf-8');
    } else {
      text = Buffer.from(raw as ArrayBuffer).toString('utf-8');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;
    const maybe = parsed as { type?: unknown };
    if (typeof maybe.type !== 'string') return;
    if (!INCOMING_TYPE_SET.has(maybe.type as ChannelIncoming['type'])) return;

    const msg = parsed as ChannelIncoming;
    for (const listener of messageListeners) {
      listener(msg);
    }
  }

  function openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${sessionInfo.port}`);
        socket = ws;

        const handleOpen = (): void => {
          reconnectAttempts = 0;
          setConnected(true);
          startPing();
          resolve();
        };
        const handleError = (err: Error): void => {
          // If we never opened, reject the connect promise so callers see it.
          if (!connected) {
            reject(err);
          }
        };
        const handleClose = (): void => {
          clearPing();
          setConnected(false);
          socket = null;
          // Reset connectPromise so the next connect() can attempt a fresh
          // socket rather than returning the already-resolved/rejected one.
          connectPromise = null;
          if (!manuallyClosed) {
            scheduleReconnect();
          }
        };

        ws.on('open', handleOpen);
        ws.on('error', handleError);
        ws.on('close', handleClose);
        ws.on('message', handleIncoming);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function send(payload: object): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // swallow — reconnect loop will handle connection issues
    }
  }

  return {
    connect(): Promise<void> {
      // If there's an in-flight or completed connect attempt, return it.
      // handleClose resets connectPromise to null so the next call can try again.
      if (connectPromise) return connectPromise;
      manuallyClosed = false;
      connectPromise = openSocket();
      return connectPromise;
    },

    disconnect(): void {
      manuallyClosed = true;
      clearReconnect();
      clearPing();
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
      connectPromise = null;
      setConnected(false);
    },

    isConnected(): boolean {
      return connected;
    },

    sendMessage(text: string, sender?: string): void {
      const msg: ClientMessage = {
        type: 'message',
        id: randomUUID(),
        text,
        sender: sender ?? defaultSender,
      };
      send(msg);
    },

    sendPermissionVerdict(requestId: string, behavior: 'allow' | 'deny'): void {
      const msg: ClientPermissionVerdict = {
        type: 'permission_verdict',
        requestId,
        behavior,
      };
      send(msg);
    },

    onMessage(cb: (msg: ChannelIncoming) => void): () => void {
      messageListeners.add(cb);
      return () => {
        messageListeners.delete(cb);
      };
    },

    onStatusChange(cb: (connected: boolean) => void): () => void {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },

    getHistory(limit?: number): ChannelMessage[] {
      const historyPath = join(messagesDir, `${sessionInfo.id}.jsonl`);
      if (!existsSync(historyPath)) return [];

      const entries: ChannelMessage[] = [];
      readJsonlStreaming<unknown>(historyPath, (entry) => {
        if (entry && typeof entry === 'object' && typeof (entry as { type?: unknown }).type === 'string') {
          entries.push(entry as ChannelMessage);
        }
      });

      if (limit && entries.length > limit) {
        return entries.slice(-limit);
      }
      return entries;
    },

    getSessionInfo(): SessionInfo {
      return sessionInfo;
    },
  };
}
