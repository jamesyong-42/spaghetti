/**
 * watchSessionTranscript — scoped single-session transcript tail.
 *
 * A lightweight alternative to the full live plane for consumers that already
 * know which session they care about (e.g. an agent runtime that generated
 * the session id itself and passed `--session-id`): no directory watcher
 * fan-out, no SQLite, no store — just byte-offset tailing of one JSONL
 * transcript through the same incremental parser the live plane uses, so
 * message parity with cold ingest is inherited rather than re-implemented.
 *
 * Change detection is a poll interval plus an explicit `poll()`: the primary
 * consumer holds a lower-latency signal than any file watcher (Claude Code
 * hook events fire 1:1 with transcript appends and carry `transcript_path`),
 * so it calls `poll()` on that signal and the interval is only a fallback.
 * The transcript may not exist yet — missing files are quietly skipped until
 * they appear. Truncation/rewrite is handled by the checkpoint inode/size
 * logic; after a rewrite, message indexes restart at 0 with `rewrite: true`.
 */

import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createIncrementalParser } from './incremental-parser.js';
import type { Checkpoint } from './checkpoints.js';
import type { Dispose } from '../../../live/change-events.js';
import { createFileService } from '../../../io/file-service.js';
import type { FileService } from '../../../io/file-service.js';
import type { SessionMessage } from '../../../types/index.js';

export interface SessionTranscriptEvent {
  message: SessionMessage;
  msgIndex: number;
  byteOffset: number;
  /** True when this message follows a file rewrite (indexes restarted at 0). */
  rewrite: boolean;
}

export interface WatchSessionTranscriptOptions {
  /** Fallback poll cadence; `poll()` is the low-latency path. Default 500ms. */
  pollIntervalMs?: number;
  /** After a parse error, polls pause this long (explicit poll() overrides). Default 5s. */
  errorBackoffMs?: number;
  fileService?: FileService;
}

export interface SessionTranscriptTail {
  onMessage(listener: (event: SessionTranscriptEvent) => void): Dispose;
  onError(listener: (error: Error) => void): Dispose;
  /** Force an immediate delta parse. Serialized with interval polls. */
  poll(): Promise<void>;
  stop(): void;
}

export function watchSessionTranscript(
  transcriptPath: string,
  options: WatchSessionTranscriptOptions = {},
): SessionTranscriptTail {
  const fileService = options.fileService ?? createFileService();
  const parser = createIncrementalParser({ fileService });
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const errorBackoffMs = options.errorBackoffMs ?? 5000;

  // Slug/session identity follow the ~/.claude layout: <slug>/<sessionId>.jsonl.
  const slug = path.basename(path.dirname(transcriptPath));
  const sessionId = path.basename(transcriptPath).replace(/\.jsonl$/, '');

  const messageListeners = new Set<(e: SessionTranscriptEvent) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  let checkpoint: Checkpoint | undefined;
  let nextMsgIndex = 0;
  let stopped = false;
  let backoffUntil = 0;
  let chain: Promise<void> = Promise.resolve();

  async function runDelta(): Promise<void> {
    if (stopped) return;
    try {
      await stat(transcriptPath);
    } catch {
      return; // not written yet — keep waiting
    }
    try {
      const result = await parser.parseFileDelta({
        path: transcriptPath,
        category: 'message',
        slug,
        sessionId,
        checkpoint,
        startMsgIndex: nextMsgIndex,
      });
      checkpoint = result.newCheckpoint;
      for (const row of result.rows) {
        if (row.category !== 'message') continue;
        nextMsgIndex = row.msgIndex + 1;
        const event: SessionTranscriptEvent = {
          message: row.message,
          msgIndex: row.msgIndex,
          byteOffset: row.byteOffset,
          rewrite: result.rewrite,
        };
        for (const listener of messageListeners) {
          try {
            listener(event);
          } catch {
            // Listener faults must not break the tail.
          }
        }
      }
    } catch (err) {
      backoffUntil = Date.now() + errorBackoffMs;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const listener of errorListeners) listener(error);
    }
  }

  // Serialize all delta parses — checkpoint state must never race.
  function poll(): Promise<void> {
    const next = chain.then(runDelta);
    chain = next.catch(() => undefined);
    return next;
  }

  const timer = setInterval(() => {
    if (stopped || Date.now() < backoffUntil) return;
    void poll();
  }, pollIntervalMs);
  timer.unref?.();

  return {
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    poll,
    stop() {
      stopped = true;
      clearInterval(timer);
      messageListeners.clear();
      errorListeners.clear();
    },
  };
}
