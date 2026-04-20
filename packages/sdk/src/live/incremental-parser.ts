/**
 * incremental-parser.ts — Per-file delta parsing for LiveUpdates (RFC 005).
 *
 * Fourth component of Phase 2 (C2.4). Given a path and its previous
 * Checkpoint (if any), emits the rows that have appeared since the
 * last read, shaped so the writer (C2.6) can dispatch each row
 * directly to the existing `IngestService.onX(...)` methods without
 * any runtime reshaping.
 *
 * The `ParsedRow` discriminated union below is the contract between
 * this parser and `IngestService.writeBatch`. Each variant's payload
 * maps 1:1 onto the corresponding `onX` method's third argument and
 * onto the `Change` variant the writer emits afterwards — there are
 * no adapter types in between.
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
 *     after the last `\n` we actually saw by re-reading a small tail
 *     window. The next call then picks up the partial line as a
 *     whole entry once it's completed.
 *
 * Missing file:
 *   - Returns an empty result with `rewrite: false`. The checkpoint
 *     is carried forward as-is (or zeroed if none existed). Callers
 *     decide how to react to disappearance.
 */

import { stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { FileService } from '../io/file-service.js';
import type {
  SessionMessage,
  SessionsIndex,
  SubagentTranscript,
  SubagentType,
  PersistedToolResult,
  FileHistorySession,
  FileHistorySnapshotFile,
  TodoFile,
  TodoItem,
  TaskEntry,
  PlanFile,
} from '../types/index.js';
import {
  parseSubagentFilename,
  inferSubagentType as inferSubagentTypeShared,
  parseTodoFilename,
  parseFileHistoryFilename,
  parsePlanFilename,
} from '../parser/filename-conventions.js';
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

/**
 * Discriminated union of the parser's emit shapes. Each variant's
 * payload fields are pre-shaped so the writer's per-category `onX`
 * dispatch is a thin pass-through (TS narrows the variant from
 * `row.category` and reads the payload fields directly — no `as`
 * casts, no adapters).
 *
 * Fields derived from the filename (e.g. `agentId` for todos,
 * `hash/version` for file-history) are extracted here using the
 * same conventions `project-parser.ts` uses during cold-start, so
 * live + cold ingests produce row-identical writes.
 *
 * `msgIndex` + `byteOffset` on `message` rows are forwarded straight
 * from `readJsonlStreaming`'s per-line callback; see `startMsgIndex`
 * on `ParseFileDeltaParams` for how tail mode continues the
 * monotonic message index across successive parse calls.
 */
export type ParsedRow =
  | {
      category: 'message';
      slug: string;
      sessionId: string;
      message: SessionMessage;
      msgIndex: number;
      byteOffset: number;
    }
  | {
      category: 'subagent';
      slug: string;
      sessionId: string;
      transcript: SubagentTranscript;
    }
  | {
      category: 'tool_result';
      slug: string;
      sessionId: string;
      result: PersistedToolResult;
    }
  | {
      category: 'file_history';
      sessionId: string;
      history: FileHistorySession;
    }
  | {
      category: 'todo';
      sessionId: string;
      todo: TodoFile;
    }
  | {
      category: 'task';
      sessionId: string;
      task: TaskEntry;
    }
  | {
      category: 'plan';
      slug: string;
      plan: PlanFile;
    }
  | {
      category: 'project_memory';
      slug: string;
      content: string;
    }
  | {
      category: 'session_index';
      slug: string;
      originalPath: string;
      sessionsIndex: SessionsIndex;
    };

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
  /**
   * For JSONL message files only: the monotonic `msg_index` of the
   * first row emitted from this delta. The orchestrator (C2.7) passes
   * the session's current row count so `onMessage` writes land on
   * successive `(session_id, msg_index)` pairs. Ignored on rewrite —
   * rewrites restart at 0. Defaults to 0 when absent.
   */
  startMsgIndex?: number;
  /**
   * For `task` rows only: the `~/.claude` root, needed so we can read
   * `tasks/<sessionId>/.lock` + `.highwatermark` to build the
   * `TaskEntry`. The watcher event's path points inside that
   * directory — the parser walks up to the session's task dir from
   * there. When omitted, task rows are skipped.
   */
  claudeDir?: string;
}

export interface IncrementalParser {
  parseFileDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult>;
}

export interface CreateIncrementalParserOptions {
  fileService: FileService;
}

// ═══════════════════════════════════════════════════════════════════════════
// FILENAME HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filename conventions live in `parser/filename-conventions.ts`.
 * Cold-start (`project-parser.ts`) and the live tail share that
 * module so divergence here can't drift.
 *
 * tool-result files (`<toolUseId>.txt`) and the cold-start fallback
 * for unmatched subagent transcripts (`fileName.replace(/\.jsonl$/, '')`)
 * are inline below — they're trivial enough not to warrant their own
 * exported helper.
 */

function extractSubagentAgentId(fileName: string): string {
  const parsed = parseSubagentFilename(fileName);
  // Cold-start parity: when the strict `agent-<id>.jsonl` shape
  // doesn't match, fall back to stripping the `.jsonl` extension so
  // bespoke transcript filenames still get an identity.
  return parsed ? parsed.agentId : fileName.replace(/\.jsonl$/, '');
}

function inferSubagentType(fileName: string): SubagentType {
  return inferSubagentTypeShared(fileName);
}

function extractTodoAgentId(fileName: string): string | null {
  return parseTodoFilename(fileName)?.agentId ?? null;
}

function extractFileHistoryParts(fileName: string): { hash: string; version: number } | null {
  const parsed = parseFileHistoryFilename(fileName);
  if (!parsed) return null;
  return { hash: parsed.hash, version: parsed.version };
}

function extractToolUseId(fileName: string): string {
  return fileName.replace(/\.txt$/, '');
}

function extractPlanSlug(fileName: string): string {
  return parsePlanFilename(fileName)?.slug ?? fileName;
}

/**
 * Derive the plan `title` using the same rule project-parser uses:
 * the first markdown H1 line, falling back to the slug when absent.
 */
function derivePlanTitle(planSlug: string, content: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1] : planSlug;
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
function emptyCheckpoint(filePath: string, previous: Checkpoint | undefined): Checkpoint {
  if (previous) return previous;
  return {
    path: filePath,
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

  // ── Message JSONL (byte-offset tail) ────────────────────────────────────

  async function parseMessageDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, slug, sessionId, checkpoint, startMsgIndex = 0 } = params;
    if (!slug || !sessionId) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }
    const { size, inode, mtimeMs } = statInfo;

    const rewrite = !checkpoint || checkpoint.inode !== inode || size < checkpoint.lastOffset;
    const fromBytePosition = rewrite ? 0 : checkpoint!.lastOffset;
    const indexBase = rewrite ? 0 : startMsgIndex;

    if (size === fromBytePosition) {
      return {
        rows: [],
        newCheckpoint: { path: filePath, inode, size, lastOffset: fromBytePosition, lastMtimeMs: mtimeMs },
        rewrite,
      };
    }

    const rows: ParsedRow[] = [];
    // Advance `lastCompleteLineEnd` only on properly newline-terminated
    // lines; the reader also emits a final "leftover" entry when a
    // file has no trailing newline (partial mid-write). Live tailers
    // must not consume the leftover — we drop both the row and any
    // offset advance, so the next tail re-reads the unfinished line
    // once a `\n` arrives.
    let lastCompleteLineEnd = fromBytePosition;
    let leftoverCount = 0;

    fileService.readJsonlStreaming<SessionMessage>(
      filePath,
      (message, lineIndex, byteOffset, endByteOffset, terminated) => {
        if (terminated) {
          rows.push({
            category: 'message',
            slug,
            sessionId,
            message,
            msgIndex: indexBase + lineIndex,
            byteOffset,
          });
          lastCompleteLineEnd = endByteOffset;
        } else {
          // Leftover partial line — skip entirely. Don't push the row,
          // don't advance the offset.
          leftoverCount += 1;
        }
      },
      { fromBytePosition },
    );
    void leftoverCount; // only tracked for future observability

    const finalOffset = lastCompleteLineEnd;

    return {
      rows,
      newCheckpoint: { path: filePath, inode, size, lastOffset: finalOffset, lastMtimeMs: mtimeMs },
      rewrite,
    };
  }

  // ── Subagent JSONL (aggregate full file) ────────────────────────────────

  async function parseSubagentDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, slug, sessionId, checkpoint } = params;
    if (!slug || !sessionId) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }
    const { size, inode, mtimeMs } = statInfo;

    // Subagent files are small; whole-file re-parse keeps correctness
    // trivial across appends (the writer upserts on the aggregated
    // transcript anyway).
    const fileName = path.basename(filePath);
    const agentId = extractSubagentAgentId(fileName);
    const agentType = inferSubagentType(fileName);

    const messages: SessionMessage[] = [];
    try {
      fileService.readJsonlStreaming<SessionMessage>(filePath, (message) => {
        messages.push(message);
      });
    } catch {
      // Unreadable — treat as empty transcript; writer upserts and
      // later passes will overwrite with a full read.
    }

    const transcript: SubagentTranscript = { agentId, agentType, fileName, messages };

    const rows: ParsedRow[] = [{ category: 'subagent', slug, sessionId, transcript }];
    const rewrite = !checkpoint || checkpoint.inode !== inode || size < checkpoint.lastOffset;

    return {
      rows,
      newCheckpoint: { path: filePath, inode, size, lastOffset: size, lastMtimeMs: mtimeMs },
      rewrite,
    };
  }

  // ── tool_result ──────────────────────────────────────────────────────────

  async function parseToolResultDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, slug, sessionId, checkpoint } = params;
    if (!slug || !sessionId) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const fileName = path.basename(filePath);
    const toolUseId = extractToolUseId(fileName);
    const result: PersistedToolResult = { toolUseId, content };

    return {
      rows: [{ category: 'tool_result', slug, sessionId, result }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── file_history ─────────────────────────────────────────────────────────

  async function parseFileHistoryDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, sessionId, checkpoint } = params;
    if (!sessionId) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const fileName = path.basename(filePath);
    const parts = extractFileHistoryParts(fileName);
    if (!parts) {
      // Doesn't match the `{hash}@v{N}` convention → skip quietly.
      return {
        rows: [],
        newCheckpoint: {
          path: filePath,
          inode: statInfo.inode,
          size: statInfo.size,
          lastOffset: statInfo.size,
          lastMtimeMs: statInfo.mtimeMs,
        },
        rewrite: true,
      };
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const snapshot: FileHistorySnapshotFile = {
      hash: parts.hash,
      version: parts.version,
      fileName,
      content,
      size: statInfo.size,
    };
    const history: FileHistorySession = { sessionId, snapshots: [snapshot] };

    return {
      rows: [{ category: 'file_history', sessionId, history }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── todo ────────────────────────────────────────────────────────────────

  async function parseTodoDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, sessionId, checkpoint } = params;
    if (!sessionId) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const fileName = path.basename(filePath);
    const agentId = extractTodoAgentId(fileName);
    if (!agentId) {
      return {
        rows: [],
        newCheckpoint: {
          path: filePath,
          inode: statInfo.inode,
          size: statInfo.size,
          lastOffset: statInfo.size,
          lastMtimeMs: statInfo.mtimeMs,
        },
        rewrite: true,
      };
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let items: TodoItem[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        items = parsed as TodoItem[];
      }
    } catch {
      items = [];
    }

    const todo: TodoFile = { sessionId, agentId, items };

    return {
      rows: [{ category: 'todo', sessionId, todo }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── task ────────────────────────────────────────────────────────────────

  async function parseTaskDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, sessionId, checkpoint, claudeDir } = params;
    if (!sessionId || !claudeDir) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    // Any watcher event inside `tasks/<sid>/` re-reads the whole task
    // directory. Numbered `N.json` task items are explicitly left
    // unparsed (see `docs/PARSER-UNPARSED-DATA.md`) — we just check
    // `.lock` + `.highwatermark` presence, matching cold-start parity.
    const taskDir = path.join(claudeDir, 'tasks', sessionId);
    const lockPath = path.join(taskDir, '.lock');
    const hwPath = path.join(taskDir, '.highwatermark');

    const lockExists = fileService.exists(lockPath);
    let hasHighwatermark = false;
    let highwatermark: number | null = null;
    if (fileService.exists(hwPath)) {
      try {
        const raw = fileService.readFileSync(hwPath).trim();
        hasHighwatermark = true;
        const n = parseInt(raw, 10);
        highwatermark = isNaN(n) ? null : n;
      } catch {
        // hw missing between exists() + read — leave as not-present.
      }
    }

    // We still stat `filePath` for checkpoint bookkeeping; when the
    // watcher event was a delete we fall back to `emptyCheckpoint`.
    const statInfo = await safeStat(filePath);
    const cp = statInfo
      ? {
          path: filePath,
          inode: statInfo.inode,
          size: statInfo.size,
          lastOffset: statInfo.size,
          lastMtimeMs: statInfo.mtimeMs,
        }
      : emptyCheckpoint(filePath, checkpoint);

    const task: TaskEntry = {
      taskId: sessionId,
      hasHighwatermark,
      highwatermark,
      lockExists,
    };

    return {
      rows: [{ category: 'task', sessionId, task }],
      newCheckpoint: cp,
      rewrite: true,
    };
  }

  // ── plan ────────────────────────────────────────────────────────────────

  async function parsePlanDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, checkpoint } = params;

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const fileName = path.basename(filePath);
    const slug = extractPlanSlug(fileName);
    const title = derivePlanTitle(slug, content);
    const plan: PlanFile = { slug, title, content, size: content.length };

    return {
      rows: [{ category: 'plan', slug, plan }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── project_memory ──────────────────────────────────────────────────────

  async function parseProjectMemoryDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, slug, checkpoint } = params;
    if (!slug) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    return {
      rows: [{ category: 'project_memory', slug, content }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── session_index ───────────────────────────────────────────────────────

  async function parseSessionIndexDelta(params: ParseFileDeltaParams): Promise<IncrementalParseResult> {
    const { path: filePath, slug, checkpoint } = params;
    if (!slug) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    const statInfo = await safeStat(filePath);
    if (!statInfo) {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { rows: [], newCheckpoint: emptyCheckpoint(filePath, checkpoint), rewrite: false };
    }

    let sessionsIndex: SessionsIndex;
    try {
      sessionsIndex = JSON.parse(raw) as SessionsIndex;
    } catch {
      return {
        rows: [],
        newCheckpoint: {
          path: filePath,
          inode: statInfo.inode,
          size: statInfo.size,
          lastOffset: statInfo.size,
          lastMtimeMs: statInfo.mtimeMs,
        },
        rewrite: true,
      };
    }

    const originalPath = sessionsIndex.originalPath ?? '';

    return {
      rows: [{ category: 'session_index', slug, originalPath, sessionsIndex }],
      newCheckpoint: {
        path: filePath,
        inode: statInfo.inode,
        size: statInfo.size,
        lastOffset: statInfo.size,
        lastMtimeMs: statInfo.mtimeMs,
      },
      rewrite: true,
    };
  }

  // ── Public surface ──────────────────────────────────────────────────────

  return {
    async parseFileDelta(params) {
      switch (params.category) {
        case 'message':
          return parseMessageDelta(params);
        case 'subagent':
          return parseSubagentDelta(params);
        case 'tool_result':
          return parseToolResultDelta(params);
        case 'file_history':
          return parseFileHistoryDelta(params);
        case 'todo':
          return parseTodoDelta(params);
        case 'task':
          return parseTaskDelta(params);
        case 'plan':
          return parsePlanDelta(params);
        case 'project_memory':
          return parseProjectMemoryDelta(params);
        case 'session_index':
          return parseSessionIndexDelta(params);
      }
    },
  };

  // ── stat helper (captures inode + mtime in one await) ──────────────────

  async function safeStat(filePath: string): Promise<{ size: number; inode: number; mtimeMs: number } | null> {
    try {
      const s = await stat(filePath);
      return { size: s.size, inode: s.ino, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }
}

// Keep the category-check helper exported for parity with the router
// (no external consumer today but useful for test fixtures).
export { isJsonlCategory };
