/**
 * RuntimeBridge — Plane 3 (hooks, channels, live agent state).
 *
 * Owns the hook-event JSONL watcher and channel session discovery registry.
 * Watchers start lazily on first subscriber; stop() tears them down.
 * Public consumers use {@link SpaghettiRuntime} via `api.runtime`.
 *
 * See `docs/THREE-PLANE-INGEST-ARCHITECTURE.md`.
 */

import type { AgentSource } from '../sources/types.js';
import type { ErrorSink } from '../io/error-sink.js';
import { createHookEventWatcher, type HookEventWatcher } from '../io/hook-event-watcher.js';
import { createChannelRegistry, type ChannelRegistry } from '../io/channel-registry.js';
import type { HookEvent } from '../types/hook-events.js';
import type { SessionInfo } from '../types/channel-messages.js';
import type { ActiveSessionFile } from '../types/toplevel-files-data.js';
import type { RuntimeEvent } from '../events/runtime-event.js';
import type { Dispose } from '../live/change-events.js';
import { listActiveSessionsFromDir } from './active-sessions.js';

export interface RuntimeBridge {
  readonly source: AgentSource;

  /** Start watchers if not already running (idempotent). */
  start(): void;
  /** Stop watchers and clear internal listeners. */
  stop(): void;
  isRunning(): boolean;

  /** Subscribe to runtime events (hooks + channel session refreshes). Lazy-starts. */
  onEvent(listener: (e: RuntimeEvent) => void): Dispose;

  /** Async iterable of runtime events. Lazy-starts. */
  events(options?: { bufferSize?: number; onDrop?: (dropped: RuntimeEvent) => void }): AsyncIterable<RuntimeEvent>;

  /** Historical hook events from the JSONL log. */
  getHookHistory(limit?: number): HookEvent[];
  clearHooks(): void;

  /** Snapshot of live channel sessions (heartbeat-filtered). */
  listChannelSessions(): SessionInfo[];
  /** Subscribe to channel session list changes. Lazy-starts. */
  onChannelSessions(listener: (sessions: SessionInfo[]) => void): Dispose;

  /**
   * Claude Code active-session PID registry (`~/.claude/sessions/{pid}.json`).
   * By default only returns processes that are still alive.
   */
  listActiveSessions(options?: { requireAlive?: boolean }): ActiveSessionFile[];

  hookEventsPath(): string;
  channelSessionsDir(): string;
  channelMessagesDir(): string;
  /** Claude Code active-session registry directory. */
  activeSessionsDir(): string;
}

export interface CreateRuntimeBridgeOptions {
  errorSink?: ErrorSink;
}

/**
 * Create a runtime bridge bound to an agent source.
 */
export function createRuntimeBridge(source: AgentSource, options?: CreateRuntimeBridgeOptions): RuntimeBridge {
  const errorSink = options?.errorSink;
  const hookWatcher: HookEventWatcher = createHookEventWatcher({
    eventsPath: source.paths.hookEventsFile,
  });
  const channelRegistry: ChannelRegistry = createChannelRegistry({
    sessionsDir: source.paths.channelSessionsDir,
  });

  let running = false;
  const eventListeners = new Set<(e: RuntimeEvent) => void>();
  let unsubHook: (() => void) | null = null;
  let unsubChannel: (() => void) | null = null;

  function emit(event: RuntimeEvent): void {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        errorSink?.error(e, { component: 'RuntimeBridge', eventType: event.type });
      }
    }
  }

  function hookToRuntime(event: HookEvent): RuntimeEvent {
    const parsed = Date.parse(event.timestamp);
    return {
      type: 'hook',
      name: event.event,
      payload: event,
      ts: Number.isFinite(parsed) ? parsed : Date.now(),
      sessionId: event.sessionId ?? undefined,
    };
  }

  function ensureStarted(): void {
    if (running) return;
    running = true;

    try {
      hookWatcher.start();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      errorSink?.error(e, { component: 'RuntimeBridge', phase: 'hook-start' });
    }

    try {
      channelRegistry.start();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      errorSink?.error(e, { component: 'RuntimeBridge', phase: 'channel-start' });
    }

    unsubHook = hookWatcher.onEvent((event) => {
      emit(hookToRuntime(event));
    });

    unsubChannel = channelRegistry.onChange((sessions) => {
      const ts = Date.now();
      emit({ type: 'channel.sessions', sessions, ts });
      for (const s of sessions) {
        emit({
          type: 'session.active',
          sessionId: s.claudeSessionId ?? s.id,
          pid: s.pid,
          ts,
        });
      }
    });
  }

  function stop(): void {
    if (!running) return;
    running = false;

    if (unsubHook) {
      unsubHook();
      unsubHook = null;
    }
    if (unsubChannel) {
      unsubChannel();
      unsubChannel = null;
    }

    try {
      hookWatcher.stop();
    } catch {
      /* ignore */
    }
    try {
      channelRegistry.stop();
    } catch {
      /* ignore */
    }
  }

  return {
    source,

    start: ensureStarted,
    stop,
    isRunning: () => running,

    onEvent(listener: (e: RuntimeEvent) => void): Dispose {
      ensureStarted();
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    events(options?: { bufferSize?: number; onDrop?: (dropped: RuntimeEvent) => void }): AsyncIterable<RuntimeEvent> {
      const bufferSize = options?.bufferSize ?? 500;
      const onDrop = options?.onDrop;
      const buffer: RuntimeEvent[] = [];
      let resolveWait: (() => void) | null = null;
      let done = false;

      const dispose = (() => {
        ensureStarted();
        const listener = (e: RuntimeEvent) => {
          if (buffer.length >= bufferSize) {
            const dropped = buffer.shift();
            if (dropped && onDrop) onDrop(dropped);
          }
          buffer.push(e);
          if (resolveWait) {
            const r = resolveWait;
            resolveWait = null;
            r();
          }
        };
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
          done = true;
          if (resolveWait) {
            const r = resolveWait;
            resolveWait = null;
            r();
          }
        };
      })();

      return {
        [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
          return {
            async next(): Promise<IteratorResult<RuntimeEvent>> {
              while (buffer.length === 0 && !done) {
                await new Promise<void>((resolve) => {
                  resolveWait = resolve;
                });
              }
              if (buffer.length === 0) {
                return { done: true, value: undefined };
              }
              return { done: false, value: buffer.shift()! };
            },
            async return(): Promise<IteratorResult<RuntimeEvent>> {
              dispose();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    getHookHistory(limit?: number): HookEvent[] {
      const all = hookWatcher.getHistory(limit);
      return all;
    },

    clearHooks(): void {
      hookWatcher.clear();
    },

    listChannelSessions(): SessionInfo[] {
      // Ensure dir is scanned at least once without full start if possible.
      // ChannelRegistry only refreshes after start(); call start for a snapshot.
      ensureStarted();
      return channelRegistry.getSessions();
    },

    onChannelSessions(listener: (sessions: SessionInfo[]) => void): Dispose {
      ensureStarted();
      return channelRegistry.onChange(listener);
    },

    listActiveSessions(options?: { requireAlive?: boolean }): ActiveSessionFile[] {
      return listActiveSessionsFromDir(source.paths.sessionsDir, options);
    },

    hookEventsPath: () => source.paths.hookEventsFile,
    channelSessionsDir: () => source.paths.channelSessionsDir,
    channelMessagesDir: () => source.paths.channelMessagesDir,
    activeSessionsDir: () => source.paths.sessionsDir,
  };
}
