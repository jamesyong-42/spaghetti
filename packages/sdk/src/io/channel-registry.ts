/**
 * Channel Registry — discovery service for spaghetti channel MCP servers.
 *
 * Watches `~/.spaghetti/channel/sessions/` for per-session JSON discovery
 * files written by running channel servers. Filters out stale entries whose
 * heartbeat has expired, debounces rapid filesystem changes, and notifies
 * subscribers with the current live session list.
 */

import { watch, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { getChannelSessionsDir, type SessionInfo } from '../types/channel-messages.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ChannelRegistryOptions {
  /** Directory where channel session discovery files live. */
  sessionsDir?: string;
  /** Heartbeat expiry in milliseconds. Default: 15000. */
  heartbeatTimeoutMs?: number;
}

export interface ChannelRegistry {
  /** Start watching the sessions directory. */
  start(): void;
  /** Stop watching and clear the internal listener set. */
  stop(): void;
  /** Snapshot of the currently-live sessions. */
  getSessions(): SessionInfo[];
  /** Subscribe to the live session list. Returns an unsubscribe function. */
  onChange(cb: (sessions: SessionInfo[]) => void): () => void;
  /** Delete discovery files whose heartbeat has expired. Returns the count removed. */
  cleanupStale(): number;
}

// ─── Implementation ──────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEBOUNCE_MS = 100;
const RESCAN_INTERVAL_MS = 5_000;

export function createChannelRegistry(options?: ChannelRegistryOptions): ChannelRegistry {
  const sessionsDir = options?.sessionsDir ?? getChannelSessionsDir();
  const heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  const listeners: Set<(sessions: SessionInfo[]) => void> = new Set();
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let currentSessions: SessionInfo[] = [];

  function ensureDir(): void {
    if (!existsSync(sessionsDir)) {
      try {
        mkdirSync(sessionsDir, { recursive: true });
      } catch {
        // ignore — may be a permissions issue; scan will just return []
      }
    }
  }

  function isLive(info: SessionInfo): boolean {
    const hb = new Date(info.lastHeartbeat).getTime();
    if (Number.isNaN(hb)) return false;
    return Date.now() - hb < heartbeatTimeoutMs;
  }

  function readAllSessions(): SessionInfo[] {
    if (!existsSync(sessionsDir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(sessionsDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return [];
      return [];
    }

    const sessions: SessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(sessionsDir, entry);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SessionInfo;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.port === 'number') {
          sessions.push(parsed);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') continue;
        // malformed JSON — skip
      }
    }
    return sessions;
  }

  function sessionsEqual(a: SessionInfo[], b: SessionInfo[]): boolean {
    if (a.length !== b.length) return false;
    // Compare by id + lastHeartbeat so we notify on heartbeat updates too.
    const keyA = a
      .map((s) => `${s.id}@${s.lastHeartbeat}`)
      .sort()
      .join('|');
    const keyB = b
      .map((s) => `${s.id}@${s.lastHeartbeat}`)
      .sort()
      .join('|');
    return keyA === keyB;
  }

  function refresh(): void {
    const all = readAllSessions();
    const live = all.filter(isLive);
    if (!sessionsEqual(live, currentSessions)) {
      currentSessions = live;
      for (const listener of listeners) {
        listener(currentSessions);
      }
    }
  }

  function onDirChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh();
    }, DEBOUNCE_MS);
  }

  return {
    start(): void {
      ensureDir();

      // Seed current state.
      refresh();

      try {
        watcher = watch(sessionsDir, () => {
          onDirChange();
        });
        watcher.on('error', () => {
          // Silently ignore watch errors.
        });
      } catch {
        // fs.watch not available — rely on periodic rescan.
      }

      // Periodic rescan catches stale files whose heartbeat has simply stopped
      // updating (no filesystem event to trigger fs.watch).
      rescanTimer = setInterval(() => {
        refresh();
      }, RESCAN_INTERVAL_MS);
    },

    stop(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      listeners.clear();
      currentSessions = [];
    },

    getSessions(): SessionInfo[] {
      return currentSessions.slice();
    },

    onChange(cb: (sessions: SessionInfo[]) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    cleanupStale(): number {
      if (!existsSync(sessionsDir)) return 0;

      let removed = 0;
      let entries: string[];
      try {
        entries = readdirSync(sessionsDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') return 0;
        return 0;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = join(sessionsDir, entry);
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(raw) as SessionInfo;
          if (!isLive(parsed)) {
            try {
              unlinkSync(filePath);
              removed++;
            } catch {
              // ignore
            }
          }
        } catch {
          // Unparseable / unreadable — treat as stale and try to delete.
          try {
            unlinkSync(filePath);
            removed++;
          } catch {
            // ignore
          }
        }
      }

      if (removed > 0) {
        refresh();
      }
      return removed;
    },
  };
}
