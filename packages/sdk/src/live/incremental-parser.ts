/**
 * incremental-parser.ts — Per-file delta parsing for LiveUpdates (RFC 005).
 *
 * Fourth component of Phase 2 (C2.4). Given a path and its previous
 * Checkpoint (if any), emits the rows that have appeared since the
 * last read. For JSONL categories this is a byte-offset tail on top
 * of `readJsonlStreaming`; for single-file categories it's a full
 * re-read.
 *
 * The parser stays *dumb*: it does not classify, re-shape, or split
 * payloads. It just hands the raw parsed JSON (or file contents) to
 * the downstream writer (C2.6) as a `ParsedRow`, tagged with
 * `category`, `slug`, `sessionId`.
 *
 * Rewrite detection (JSONL only):
 *   - No prior checkpoint → rewrite (cold start).
 *   - inode differs → rewrite (file was replaced).
 *   - current size < checkpoint.lastOffset → rewrite (truncation).
 *
 * Partial-line safety:
 *   - `readJsonlStreaming` returns `finalBytePosition` at EOF, which
 *     may sit past the last complete `\n` if the file is still being
 *     written. We clamp the new checkpoint's `lastOffset` to just
 *     after the last `\n` we actually saw (via the byteOffset param
 *     of the line callback + the line's byte length). The next call
 *     then picks up the partial line as a whole entry once it's
 *     completed.
 *
 * Missing file:
 *   - Returns an empty result with `rewrite: false`. The checkpoint
 *     is carried forward as-is (or zeroed if none existed). Callers
 *     decide how to react to disappearance.
 */

import { stat, readFile } from 'node:fs/promises';

import type { FileService } from '../io/file-service.js';
import type { Checkpoint } from './checkpoints.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Category tags mirror `docs/LIVE-UPDATES-DESIGN.md` §2.7. Keep in
 * sync with the Router's classification output — the writer (C2.6)
 * dispatches on this value.
 */
export type ParsedRowCategory =
  | 'message'
  | 'subagent'
  | 'tool_result'
  | 'file_history'
  | 'todo'
  | 'task'
  | 'plan'
  | 'project_memory'
  | 'session_index';

export interface ParsedRow {
  category: ParsedRowCategory;
  slug?: string;
  sessionId?: string;
  /** Raw parsed JSON (JSONL categories) or file contents (single-file categories). */
  payload: unknown;
}

export interface IncrementalParseResult {
  rows: ParsedRow[];
  newCheckpoint: Checkpoint;
  /** True when the file was treated as a full-rewrite (cold start, inode change, or size decrease). */
  rewrite: boolean;
}

export interface ParseFileDeltaParams {
  path: string;
  category: ParsedRowCategory;
  slug?: string;
  sessionId?: string;
  checkpoint: Checkpoint | undefined;
}

export interface IncrementalParser {
  parseFileDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult>;
}

export interface CreateIncrementalParserOptions {
  fileService: FileService;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The JSONL categories use byte-offset tailing. Everything else is
 * whole-file on each call.
 */
const JSONL_CATEGORIES: ReadonlySet<ParsedRowCategory> = new Set(['message', 'subagent']);

function isJsonlCategory(category: ParsedRowCategory): boolean {
  return JSONL_CATEGORIES.has(category);
}

/**
 * Build a Checkpoint for a file we couldn't read (missing / stat
 * failure). We preserve any existing checkpoint to avoid clobbering
 * state on a transient ENOENT; only cold-start paths synthesize zeros.
 */
function emptyCheckpoint(path: string, previous: Checkpoint | undefined): Checkpoint {
  if (previous) return previous;
  return {
    path,
    inode: 0,
    size: 0,
    lastOffset: 0,
    lastMtimeMs: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createIncrementalParser(options: CreateIncrementalParserOptions): IncrementalParser {
  const { fileService } = options;

  // ── JSONL path ──────────────────────────────────────────────────────────

  async function parseJsonlDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path, category, slug, sessionId, checkpoint } = params;

    // fstat via fs/promises — we need inode, which FileService.getStats
    // doesn't expose. Any error (ENOENT, EACCES, etc.) → empty result.
    let size: number;
    let inode: number;
    let mtimeMs: number;
    try {
      const s = await stat(path);
      size = s.size;
      inode = s.ino;
      mtimeMs = s.mtimeMs;
    } catch {
      return {
        rows: [],
        newCheckpoint: emptyCheckpoint(path, checkpoint),
        rewrite: false,
      };
    }

    // Rewrite when cold-starting, when the inode changed (rotation /
    // delete+recreate), or when the file shrank (truncation).
    const rewrite = !checkpoint || checkpoint.inode !== inode || size < checkpoint.lastOffset;

    const fromBytePosition = rewrite ? 0 : checkpoint!.lastOffset;

    // Nothing new to read: no bytes past fromBytePosition.
    if (size === fromBytePosition) {
      return {
        rows: [],
        newCheckpoint: {
          path,
          inode,
          size,
          lastOffset: fromBytePosition,
          lastMtimeMs: mtimeMs,
        },
        rewrite,
      };
    }

    const rows: ParsedRow[] = [];
    // Track the byte offset just past the last complete `\n` we
    // actually parsed. The streaming reader's `finalBytePosition`
    // equals EOF and can overshoot when a partial final line exists;
    // we always trust our own high-water mark instead.
    let highWater = fromBytePosition;

    fileService.readJsonlStreaming<unknown>(
      path,
      (entry, _lineIndex, byteOffset) => {
        rows.push({ category, slug, sessionId, payload: entry });
        // byteOffset points at the start of this line; compute the
        // position just past its terminating `\n` by measuring the
        // JSON payload's byte length + 1. Because `readJsonlStreaming`
        // only invokes the callback on successfully parsed lines that
        // ended in `\n` or on a trailing EOF line, and we re-encode
        // from the parsed value to size it, we'd risk drift — instead,
        // re-serialize is not right. We compute bytes used by the
        // *original* line via a conservative estimate: we advance to
        // the byte after the newline by scanning from byteOffset.
        //
        // But we don't have the raw buffer here. The streaming reader
        // doesn't expose it. So we fall back to `JSON.stringify(entry)`
        // *only* to catch the far-ish upper bound — no, that's wrong
        // because whitespace-padded / compact formats differ.
        //
        // Simpler: update highWater lazily after the call using the
        // streaming reader's `finalBytePosition` and clamp to the
        // last `\n` we found by re-reading a tiny window. See below.
        //
        // To keep this callback O(1) and correct, we just record the
        // per-line byte offset — the actual clamp happens post-loop.
        const lastLineStart = byteOffset;
        if (lastLineStart >= highWater) {
          // We'll refine past-newline below.
          highWater = lastLineStart;
        }
      },
      { fromBytePosition },
    );

    // Refine `highWater` to point just past the final complete `\n`
    // in the file. We scan backwards from EOF until we find one.
    // For an empty/tail-less file, falls back to `size` (no partial).
    let finalOffset = size;
    if (rows.length === 0) {
      // No complete lines parsed from this delta → keep previous
      // offset so we can try again once more bytes arrive.
      finalOffset = fromBytePosition;
    } else {
      // We need the offset just past the last `\n`. Read the tail
      // buffer from highWater (start of last line) to EOF and find
      // the last newline. This buffer is bounded in practice by one
      // JSONL entry's size (the last one we saw), since prior lines
      // were already consumed.
      //
      // In the common case where the writer appends whole lines with
      // trailing `\n`, the last newline is at `size - 1`. When a
      // partial line exists, the last `\n` is somewhere before the
      // tail, and we clamp there so next pass re-reads it as one
      // complete entry.
      let buf: Buffer;
      try {
        buf = fileService.readBytes(path, { start: highWater, length: size - highWater });
      } catch {
        // If we somehow can't re-read, fall back to fromBytePosition
        // to be safe (next pass will rewrite the delta).
        return {
          rows: [],
          newCheckpoint: emptyCheckpoint(path, checkpoint),
          rewrite,
        };
      }
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        // The last line we saw had no trailing `\n` (EOF-terminated
        // partial). Drop it from `rows` and keep offset at highWater.
        // This matches the task's "partial last line" contract: the
        // parser should not advance past an incomplete line.
        rows.pop();
        finalOffset = highWater;
      } else {
        finalOffset = highWater + lastNl + 1;
      }
    }

    return {
      rows,
      newCheckpoint: {
        path,
        inode,
        size,
        lastOffset: finalOffset,
        lastMtimeMs: mtimeMs,
      },
      rewrite,
    };
  }

  // ── Single-file path ────────────────────────────────────────────────────

  async function parseSingleFileDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path, category, slug, sessionId, checkpoint } = params;

    let size: number;
    let inode: number;
    let mtimeMs: number;
    try {
      const s = await stat(path);
      size = s.size;
      inode = s.ino;
      mtimeMs = s.mtimeMs;
    } catch {
      return {
        rows: [],
        newCheckpoint: emptyCheckpoint(path, checkpoint),
        rewrite: false,
      };
    }

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return {
        rows: [],
        newCheckpoint: emptyCheckpoint(path, checkpoint),
        rewrite: false,
      };
    }

    // JSON-ish categories get parsed; text-ish categories (`plan`,
    // `project_memory`, `tool_result`) pass through as raw strings.
    // The writer decides what to do — we just hand over the payload.
    let payload: unknown = raw;
    const isJsonCategory =
      category === 'todo' || category === 'task' || category === 'file_history' || category === 'session_index';
    if (isJsonCategory) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // Malformed JSON — emit the raw text and let the writer
        // decide. Never throw: LiveUpdates would otherwise stall.
        payload = raw;
      }
    }

    const rows: ParsedRow[] = [{ category, slug, sessionId, payload }];

    return {
      rows,
      newCheckpoint: {
        path,
        inode,
        size,
        lastOffset: size,
        lastMtimeMs: mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── Public surface ──────────────────────────────────────────────────────

  return {
    parseFileDelta(params) {
      if (isJsonlCategory(params.category)) {
        return parseJsonlDelta(params);
      }
      return parseSingleFileDelta(params);
    },
  };
}
