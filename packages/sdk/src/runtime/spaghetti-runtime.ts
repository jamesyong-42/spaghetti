/**
 * SpaghettiRuntime — public `api.runtime` surface (Plane 3).
 *
 * Thin façade over {@link RuntimeBridge}. Always present when the service
 * is built through `createSpaghettiService` (unlike `api.live`, which
 * requires `{ live: true }`).
 */

import type { RuntimeBridge } from '../planes/runtime-bridge.js';
import type { RuntimeEvent } from '../events/runtime-event.js';
import type { Dispose } from '../live/change-events.js';
import type { HookEvent } from '../types/spaghetti/hook-events.js';
import type { SessionInfo } from '../types/spaghetti/channel-messages.js';
import type { ActiveSessionFile } from '../types/claude/toplevel-files-data.js';

/**
 * Public runtime surface for hooks + channel session discovery +
 * Claude Code active-session registry.
 */
export interface SpaghettiRuntime {
  /** Subscribe to runtime events (hooks + channel session updates). */
  onEvent(listener: (e: RuntimeEvent) => void): Dispose;

  /**
   * Async iterable of runtime events. Bounded buffer with drop-oldest
   * on overflow.
   */
  events(options?: { bufferSize?: number; onDrop?: (dropped: RuntimeEvent) => void }): AsyncIterable<RuntimeEvent>;

  /** Historical hook events from the JSONL log. */
  getHookHistory(limit?: number): HookEvent[];

  /** Truncate the hook events log. */
  clearHooks(): void;

  /** Live channel sessions (heartbeat-filtered). */
  listChannelSessions(): SessionInfo[];

  /** Subscribe to channel session list changes. */
  onChannelSessions(listener: (sessions: SessionInfo[]) => void): Dispose;

  /**
   * Claude Code PID registry (`~/.claude/sessions/{pid}.json`).
   * Defaults to processes that are still alive.
   */
  listActiveSessions(options?: { requireAlive?: boolean }): ActiveSessionFile[];

  hookEventsPath(): string;
  channelSessionsDir(): string;
  channelMessagesDir(): string;
  activeSessionsDir(): string;

  /**
   * Explicit start (usually unnecessary — first subscribe lazy-starts).
   * Exposed for apps that want watchers up before any listener.
   */
  start(): void;

  /** Stop watchers. Called from `api.dispose()`. */
  stop(): void;

  isRunning(): boolean;
}

export function createSpaghettiRuntime(bridge: RuntimeBridge): SpaghettiRuntime {
  return {
    onEvent: (listener) => bridge.onEvent(listener),
    events: (options) => bridge.events(options),
    getHookHistory: (limit) => bridge.getHookHistory(limit),
    clearHooks: () => bridge.clearHooks(),
    listChannelSessions: () => bridge.listChannelSessions(),
    onChannelSessions: (listener) => bridge.onChannelSessions(listener),
    listActiveSessions: (options) => bridge.listActiveSessions(options),
    hookEventsPath: () => bridge.hookEventsPath(),
    channelSessionsDir: () => bridge.channelSessionsDir(),
    channelMessagesDir: () => bridge.channelMessagesDir(),
    activeSessionsDir: () => bridge.activeSessionsDir(),
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    isRunning: () => bridge.isRunning(),
  };
}
