/**
 * Hook Event Watcher — watches the hook events JSONL file for new entries
 *
 * Uses fs.watch() to detect appends to the events file, then reads new entries
 * incrementally using the streaming JSONL reader's fromBytePosition support.
 */

import { watch, existsSync, writeFileSync, mkdirSync, type FSWatcher } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { readJsonlStreaming } from './streaming-jsonl-reader.js';
import type { HookEvent } from '../types/hook-events.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface HookEventWatcherOptions {
  /** Path to the hook events JSONL file. Default: ~/.spaghetti/hooks/events.jsonl */
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

export function getDefaultHookEventsPath(): string {
  return join(homedir(), '.spaghetti', 'hooks', 'events.jsonl');
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

    const newEvents: HookEvent[] = [];
    const result = readJsonlStreaming<HookEvent>(
      eventsPath,
      (entry) => {
        newEvents.push(entry);
      },
      { fromBytePosition: lastBytePosition },
    );
    lastBytePosition = result.finalBytePosition;

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

      // If file exists, seek to end so we only get new events
      if (existsSync(eventsPath)) {
        const seekResult = readJsonlStreaming<HookEvent>(eventsPath, () => {}, { fromBytePosition: 0 });
        lastBytePosition = seekResult.finalBytePosition;
      }

      // Watch the directory (more reliable than watching a file that may not exist yet)
      try {
        watcher = watch(dir, (eventType, filename) => {
          if (filename === 'events.jsonl') {
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
