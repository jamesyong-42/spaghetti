/**
 * Hook Event Watcher — watches the hook events JSONL file for new entries
 *
 * Uses fs.watch() to detect appends to the events file, then reads new entries
 * incrementally using the streaming JSONL reader's fromBytePosition support.
 */

import { watch, existsSync, statSync, realpathSync, writeFileSync, mkdirSync, type FSWatcher } from 'fs';
import { dirname } from 'path';
import { readJsonlStreaming } from './streaming-jsonl-reader.js';
import type { HookEvent } from '../types/spaghetti/hook-events.js';
import { createClaudeCodeSource } from '../sources/claude-code/index.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface HookEventWatcherOptions {
  /** Path to the hook events JSONL file. Default: Claude Code source `paths.hookEventsFile` */
  eventsPath?: string;
}

export interface HookEventWatcher {
  /** Start watching the events file for new entries */
  start(): void;
  /** Stop watching */
  stop(): void;
  /** Read all events from the file (for initial load) */
  getHistory(limit?: number): HookEvent[];
  /** Subscribe to new events. Returns unsubscribe function. */
  onEvent(cb: (event: HookEvent) => void): () => void;
  /** Truncate the events file */
  clear(): void;
  /** Get the events file path */
  getEventsPath(): string;
}

// ─── Default path ────────────────────────────────────────────────────────

/** Default hook events path for the Claude Code agent source. */
export function getDefaultHookEventsPath(): string {
  return createClaudeCodeSource().paths.hookEventsFile;
}

// ─── Implementation ──────────────────────────────────────────────────────

export function createHookEventWatcher(options?: HookEventWatcherOptions): HookEventWatcher {
  const eventsPath = options?.eventsPath ?? getDefaultHookEventsPath();
  const listeners: Set<(event: HookEvent) => void> = new Set();

  let watcher: FSWatcher | null = null;
  let lastBytePosition = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function readNewEvents(): void {
    if (!existsSync(eventsPath)) return;

    // Truncation/rotation recovery: if the file shrank below our cursor,
    // an external process rewrote it — re-read from the top instead of
    // wedging forever past EOF.
    try {
      if (statSync(eventsPath).size < lastBytePosition) {
        lastBytePosition = 0;
      }
    } catch {
      return;
    }

    // Only deliver newline-terminated events and resume from
    // lastTerminatedPosition: an unterminated tail is a row mid-write,
    // and advancing past it would permanently drop that event.
    const newEvents: HookEvent[] = [];
    const result = readJsonlStreaming<HookEvent>(
      eventsPath,
      (entry, _idx, _off, _end, terminated) => {
        if (terminated) newEvents.push(entry);
      },
      { fromBytePosition: lastBytePosition },
    );
    lastBytePosition = result.lastTerminatedPosition;

    for (const event of newEvents) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  function onFileChange(): void {
    // Debounce: hooks can fire in rapid succession
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      readNewEvents();
    }, 50);
  }

  return {
    start(): void {
      // Ensure directory exists so fs.watch doesn't fail
      const dir = dirname(eventsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // If file exists, seek past existing events so we only get new ones.
      // Seek to the last terminated line: an unterminated tail at start is
      // a write in flight and should be delivered once it completes.
      if (existsSync(eventsPath)) {
        const seekResult = readJsonlStreaming<HookEvent>(eventsPath, () => {}, { fromBytePosition: 0 });
        lastBytePosition = seekResult.lastTerminatedPosition;
      }

      // Watch the directory (more reliable than watching a file that may not exist yet).
      // realpathSync first: on Windows, handing fs.watch an 8.3 short-form
      // path (e.g. C:\Users\RUNNER~1\...) trips a fatal libuv assertion
      // (fs-event.c "!_wcsnicmp(filename, dir, dirlen)") that aborts the
      // whole process. Canonicalising expands short names.
      let watchDir = dir;
      try {
        watchDir = realpathSync(dir);
      } catch {
        // Keep the raw path — watch() below has its own error handling.
      }
      try {
        watcher = watch(watchDir, (eventType, filename) => {
          // Some platforms report a null filename — fall through to a
          // read rather than dropping the wakeup (readNewEvents no-ops
          // when nothing new landed).
          if (filename === 'events.jsonl' || filename === null) {
            onFileChange();
          }
        });
        watcher.on('error', () => {
          // Silently handle watch errors
        });
      } catch {
        // fs.watch not available on some platforms
      }
    },

    stop(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },

    getHistory(limit?: number): HookEvent[] {
      if (!existsSync(eventsPath)) return [];

      const events: HookEvent[] = [];
      readJsonlStreaming<HookEvent>(eventsPath, (entry) => {
        events.push(entry);
      });

      if (limit && events.length > limit) {
        return events.slice(-limit);
      }
      return events;
    },

    onEvent(cb: (event: HookEvent) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    clear(): void {
      const dir = dirname(eventsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(eventsPath, '');
      lastBytePosition = 0;
    },

    getEventsPath(): string {
      return eventsPath;
    },
  };
}
