/**
 * Channel Manager — high-level orchestrator for the channel client fleet.
 *
 * Wraps a `ChannelRegistry` for discovery and maintains one `ChannelClient`
 * per live session. Automatically connects new clients as sessions appear
 * and disconnects them as sessions drop. Tracks a "current" session id so
 * UIs can switch between active channels.
 */

import { createChannelRegistry, type ChannelRegistry } from './channel-registry.js';
import { createChannelClient, type ChannelClient } from './channel-client.js';
import type { ChannelIncoming, SessionInfo } from '../types/channel-messages.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ChannelManagerOptions {
  /** Default sender name passed to each `ChannelClient`. */
  sender?: string;
}

export interface ChannelManager {
  /** Start discovery and connect clients for every live session. */
  start(): Promise<void>;
  /** Disconnect all clients and stop discovery. */
  stop(): void;
  /** Snapshot of the currently-live sessions. */
  getSessions(): SessionInfo[];
  /** Get the client for a specific session id, or null if unknown. */
  getClient(sessionId: string): ChannelClient | null;
  /** The currently-focused session id (for UIs), or null. */
  getCurrentSessionId(): string | null;
  /** Set the currently-focused session id. */
  setCurrentSession(sessionId: string): void;
  /** Subscribe to session-list changes. */
  onSessionsChanged(cb: (sessions: SessionInfo[]) => void): () => void;
  /** Subscribe to every incoming message from any client, tagged with session id. */
  onAnyMessage(cb: (sessionId: string, msg: ChannelIncoming) => void): () => void;
}

// ─── Implementation ──────────────────────────────────────────────────────

export function createChannelManager(options?: ChannelManagerOptions): ChannelManager {
  const sender = options?.sender;

  const clients: Map<string, ChannelClient> = new Map();
  const clientUnsubs: Map<string, () => void> = new Map();
  const sessionListeners: Set<(sessions: SessionInfo[]) => void> = new Set();
  const anyMessageListeners: Set<(sessionId: string, msg: ChannelIncoming) => void> = new Set();

  let registry: ChannelRegistry | null = null;
  let unsubRegistry: (() => void) | null = null;
  let currentSessionId: string | null = null;
  let started = false;

  function attachClient(info: SessionInfo): void {
    if (clients.has(info.id)) return;
    const client = createChannelClient(info, sender ? { sender } : undefined);
    clients.set(info.id, client);

    const unsub = client.onMessage((msg) => {
      for (const listener of anyMessageListeners) {
        listener(info.id, msg);
      }
    });
    clientUnsubs.set(info.id, unsub);

    // Kick off the connection; errors are handled by the client's internal
    // reconnect loop, so we just swallow the initial rejection here.
    client.connect().catch(() => {
      /* retries are handled inside the client */
    });
  }

  function detachClient(sessionId: string): void {
    const client = clients.get(sessionId);
    if (!client) return;

    const unsub = clientUnsubs.get(sessionId);
    if (unsub) {
      unsub();
      clientUnsubs.delete(sessionId);
    }

    try {
      client.disconnect();
    } catch {
      // ignore
    }
    clients.delete(sessionId);

    if (currentSessionId === sessionId) {
      currentSessionId = null;
    }
  }

  function syncSessions(sessions: SessionInfo[]): void {
    const liveIds = new Set(sessions.map((s) => s.id));

    // Remove clients whose sessions are no longer live.
    for (const id of Array.from(clients.keys())) {
      if (!liveIds.has(id)) {
        detachClient(id);
      }
    }

    // Attach clients for any newly-discovered sessions.
    for (const info of sessions) {
      if (!clients.has(info.id)) {
        attachClient(info);
      }
    }

    for (const listener of sessionListeners) {
      listener(sessions);
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;

      registry = createChannelRegistry();
      unsubRegistry = registry.onChange((sessions) => {
        syncSessions(sessions);
      });
      registry.start();

      // Seed immediately for any sessions already present at startup.
      syncSessions(registry.getSessions());
    },

    stop(): void {
      if (!started) return;
      started = false;

      if (unsubRegistry) {
        unsubRegistry();
        unsubRegistry = null;
      }
      if (registry) {
        registry.stop();
        registry = null;
      }

      for (const id of Array.from(clients.keys())) {
        detachClient(id);
      }
      sessionListeners.clear();
      anyMessageListeners.clear();
      currentSessionId = null;
    },

    getSessions(): SessionInfo[] {
      return registry ? registry.getSessions() : [];
    },

    getClient(sessionId: string): ChannelClient | null {
      return clients.get(sessionId) ?? null;
    },

    getCurrentSessionId(): string | null {
      return currentSessionId;
    },

    setCurrentSession(sessionId: string): void {
      if (clients.has(sessionId)) {
        currentSessionId = sessionId;
      }
    },

    onSessionsChanged(cb: (sessions: SessionInfo[]) => void): () => void {
      sessionListeners.add(cb);
      return () => {
        sessionListeners.delete(cb);
      };
    },

    onAnyMessage(cb: (sessionId: string, msg: ChannelIncoming) => void): () => void {
      anyMessageListeners.add(cb);
      return () => {
        anyMessageListeners.delete(cb);
      };
    },
  };
}
