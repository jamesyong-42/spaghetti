/**
 * IngestService — Write layer for the Phase 3 dedicated-table schema
 *
 * Implements ProjectParseSink so it can receive streaming data directly
 * from the parser. All frequent INSERTs use prepared statements.
 */

import type { SqliteService, PreparedStatement } from '../io/index.js';
import type { ProjectParseSink } from '../parser/parse-sink.js';
import type {
  SessionsIndex,
  SessionIndexEntry,
  SessionMessage,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
  WorkflowRun,
} from '../types/index.js';
import type { Change } from '../live/change-events.js';
import type { ParsedRow, ParsedRowCategory } from '../live/incremental-parser.js';
import type { NativeAddon } from '../native.js';
import type { IngestEngine } from '../settings.js';
import type { MessageExtractor } from '../sources/types.js';
import { claudeCodeMessageExtractor } from '../sources/claude-code/message-extractor.js';
import { parseCodexTokenCount, type CodexTokenUsage } from '../sources/codex/token-usage.js';
import type { SourceFingerprint } from './segment-types.js';
import { initializeSchema } from './schema.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface IngestService extends ProjectParseSink {
  open(dbPath: string): void;
  close(): void;

  // Fingerprints
  getFingerprint(path: string): SourceFingerprint | null;
  getAllFingerprints(): SourceFingerprint[];
  upsertFingerprint(fp: SourceFingerprint): void;
  deleteFingerprint(path: string): void;

  /**
   * Next `msg_index` for a session — `MAX(msg_index) + 1`, or 0 for a
   * session with no rows. Incremental appenders (warm-start grown-file
   * path, live tailer) MUST base their indexes here: the streaming
   * reader's line index restarts at 0 when resuming from a byte
   * position, and messages upsert on `(session_id, msg_index)` — an
   * unbased index overwrites the head of the session.
   */
  getNextMessageIndex(sessionId: string): number;

  // Schema meta — small key/value markers (one-shot heals, migrations)
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // Transactions
  beginTransaction(): void;
  commitTransaction(): void;
  rollbackTransaction(): void;

  // Bulk ingest optimization
  /** Disable FTS triggers and set aggressive PRAGMAs for bulk ingestion. */
  beginBulkIngest(): void;
  /** Re-enable FTS triggers, rebuild the FTS index, and restore PRAGMAs. */
  endBulkIngest(): void;

  /**
   * Write a batch of rows as a single live-update transaction.
   * Used by LiveUpdates (C2.7) on the hot path after parsing a
   * filesystem delta.
   *
   * Opens a BEGIN IMMEDIATE, dispatches each ParsedRow to the
   * existing per-category `onX()` methods, commits, and returns
   * the set of Change events the caller should emit.
   *
   * Each returned Change is stamped with `ts = Date.now()` and
   * `seq = 0` as a placeholder — the store (`AgentDataStore.emit`)
   * owns the monotonic `seq` counter and overwrites it on emit. See
   * RFC 005 §Event sequence numbering and C3.1 for the rationale.
   *
   * **Not safe to call concurrently on the same instance.** The
   * underlying `better-sqlite3` handle is synchronous and `writeBatch`
   * manages transaction state via a boolean flag on the impl; two
   * overlapping calls would silently nest and the outer one could
   * persist rows outside the transaction opened by the inner. The
   * live-update writer loop in `LiveUpdates` awaits each call
   * serially, which is the only production caller today — external
   * consumers must do the same.
   */
  writeBatch(rows: ParsedRow[]): Promise<WriteResult>;

  // Maintenance
  vacuum(): void;
  rebuildFts(): void;
  deleteAllData(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC RESULT TYPE
// ═══════════════════════════════════════════════════════════════════════════

export interface WriteResult {
  changes: Change[];
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL ROW TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface SourceFileRow {
  path: string;
  mtime_ms: number;
  size: number;
  byte_position: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════
//
// Relocated to `sources/claude-code/message-extractor.ts` (RFC 006). The stored
// projection (msg_type / text_content / token columns / uuid / timestamp) is now
// produced by `source.messages.extract(record)` — see IngestServiceImpl's
// `messageExtractor` field, which defaults to `claudeCodeMessageExtractor`.

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

class IngestServiceImpl implements IngestService {
  private db: SqliteService;
  private opened = false;

  // Prepared statements (created once on open, reused for all inserts)
  private stmtInsertProject!: PreparedStatement;
  private stmtInsertMemory!: PreparedStatement;
  private stmtInsertSession!: PreparedStatement;
  private stmtInsertMessage!: PreparedStatement;
  private stmtInsertSubagent!: PreparedStatement;
  private stmtInsertWorkflow!: PreparedStatement;
  private stmtInsertToolResult!: PreparedStatement;
  private stmtInsertFileHistory!: PreparedStatement;
  private stmtInsertTodo!: PreparedStatement;
  private stmtInsertTask!: PreparedStatement;
  private stmtInsertPlan!: PreparedStatement;
  private stmtUpsertFingerprint!: PreparedStatement;
  private stmtUpdateMessageTokens!: PreparedStatement;

  private inTransaction = false;

  /**
   * Codex: last assistant message written per session, so a following
   * `token_count` can attribute `last_token_usage` to that turn (ccusage style).
   */
  private lastAssistantBySession = new Map<string, { slug: string; msgIndex: number }>();
  /** Codex: latest cumulative `total_token_usage` seen for a session. */
  private lastTotalBySession = new Map<string, CodexTokenUsage>();
  /** Codex: whether any per-turn attribution was applied for a session. */
  private attributedTurnBySession = new Set<string>();

  // RFC 005 C4.3: engine pin + native addon handle for the live-ingest
  // native route. When `engine === 'rs'` and `native` is loaded,
  // `writeBatch` dispatches through `native.liveIngestBatch(dbPath,
  // rows)`; otherwise it stays on the TS path. `dbPath` is captured
  // on `open()` so the native call can re-open its own short-lived
  // connection against the same file.
  private readonly engine: IngestEngine;
  private readonly native: NativeAddon | null;
  private readonly messageExtractor: MessageExtractor;
  private readonly sourceId: string;
  private dbPath: string | null = null;

  /**
   * Process-lifetime flag: after the first native live-ingest failure we
   * log a one-shot warning and silently fall back to the TS path for
   * subsequent batches. Keeps live-updates resilient to transient
   * rusqlite hiccups without spamming the console.
   */
  private nativeFallbackLogged = false;

  // NOTE(RFC 005 C3.1): the seq counter used to live here. It now
  // belongs to `AgentDataStore` — the store owns fan-out and stamps
  // every emitted Change on its way through `emit()`. `writeBatch`
  // returns Changes with `seq: 0` as a placeholder; the live-updates
  // writer loop passes them to `store.emit()`, which overwrites.

  constructor(sqliteServiceFactory: () => SqliteService, options?: CreateIngestServiceOptions) {
    this.db = sqliteServiceFactory();
    this.engine = options?.engine ?? 'ts';
    this.native = options?.native ?? null;
    this.messageExtractor = options?.messages ?? claudeCodeMessageExtractor;
    this.sourceId = options?.sourceId ?? 'claude-code';
  }

  open(dbPath: string): void {
    // If the underlying SqliteService is already open (shared connection),
    // skip opening again to avoid "Database already open" errors.
    if (!this.db.isOpen()) {
      this.db.open({ path: dbPath });
    }
    initializeSchema(this.db);
    this.prepareStatements();
    this.opened = true;
    this.dbPath = dbPath;
  }

  close(): void {
    if (this.opened) {
      if (this.inTransaction) {
        // Rollback on close rather than commit — if we're closing with an
        // open transaction, something went wrong and we should not persist
        // potentially partial/corrupt data.
        this.rollbackTransaction();
      }
      this.db.close();
      this.opened = false;
    }
  }

  private prepareStatements(): void {
    this.stmtInsertProject = this.db.prepare(
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at, source_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, slug) DO UPDATE SET
         original_path = excluded.original_path,
         sessions_index = excluded.sessions_index,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertMemory = this.db.prepare(
      `INSERT INTO project_memories (project_slug, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertSession = this.db.prepare(
      `INSERT INTO sessions (id, project_slug, full_path, first_prompt, summary, git_branch, project_path, is_sidechain, created_at, modified_at, file_mtime, plan_slug, has_task, updated_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_slug = excluded.project_slug,
         full_path = excluded.full_path,
         first_prompt = excluded.first_prompt,
         summary = excluded.summary,
         git_branch = excluded.git_branch,
         project_path = excluded.project_path,
         is_sidechain = excluded.is_sidechain,
         created_at = excluded.created_at,
         modified_at = excluded.modified_at,
         file_mtime = excluded.file_mtime,
         plan_slug = excluded.plan_slug,
         has_task = excluded.has_task,
         updated_at = excluded.updated_at`,
    );

    this.stmtUpdateMessageTokens = this.db.prepare(
      `UPDATE messages
       SET input_tokens = ?,
           output_tokens = ?,
           cache_creation_tokens = ?,
           cache_read_tokens = ?
       WHERE session_id = ? AND msg_index = ?`,
    );

    this.stmtInsertMessage = this.db.prepare(
      `INSERT INTO messages (project_slug, session_id, msg_index, msg_type, uuid, timestamp, data, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, text_content, byte_offset, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, msg_index) DO UPDATE SET
         project_slug = excluded.project_slug,
         msg_type = excluded.msg_type,
         uuid = excluded.uuid,
         timestamp = excluded.timestamp,
         data = excluded.data,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         text_content = excluded.text_content,
         byte_offset = excluded.byte_offset`,
    );

    this.stmtInsertSubagent = this.db.prepare(
      `INSERT INTO subagents (project_slug, session_id, agent_id, agent_type, file_name, messages, message_count, workflow_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_slug, session_id, workflow_id, agent_id) DO UPDATE SET
         agent_type = excluded.agent_type,
         file_name = excluded.file_name,
         messages = excluded.messages,
         message_count = excluded.message_count,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertWorkflow = this.db.prepare(
      `INSERT INTO workflows (project_slug, session_id, workflow_id, name, status, agent_count, total_tokens, total_tool_calls, duration_ms, subagent_count, data, journal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_slug, session_id, workflow_id) DO UPDATE SET
         name = excluded.name,
         status = excluded.status,
         agent_count = excluded.agent_count,
         total_tokens = excluded.total_tokens,
         total_tool_calls = excluded.total_tool_calls,
         duration_ms = excluded.duration_ms,
         subagent_count = excluded.subagent_count,
         data = excluded.data,
         journal = excluded.journal,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertToolResult = this.db.prepare(
      `INSERT INTO tool_results (project_slug, session_id, tool_use_id, content, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_slug, session_id, tool_use_id) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertFileHistory = this.db.prepare(
      `INSERT INTO file_history (session_id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertTodo = this.db.prepare(
      `INSERT INTO todos (session_id, agent_id, items, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET
         items = excluded.items,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertTask = this.db.prepare(
      `INSERT INTO tasks (session_id, has_highwatermark, highwatermark, lock_exists, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         has_highwatermark = excluded.has_highwatermark,
         highwatermark = excluded.highwatermark,
         lock_exists = excluded.lock_exists,
         updated_at = excluded.updated_at`,
    );

    this.stmtInsertPlan = this.db.prepare(
      `INSERT INTO plans (slug, title, content, size, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         size = excluded.size,
         updated_at = excluded.updated_at`,
    );

    this.stmtUpsertFingerprint = this.db.prepare(
      `INSERT INTO source_files (path, mtime_ms, size, byte_position, source_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         byte_position = excluded.byte_position`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ProjectParseSink implementation
  // ─────────────────────────────────────────────────────────────────────────

  onProject(slug: string, originalPath: string, sessionsIndex: SessionsIndex): void {
    const now = Date.now();
    this.stmtInsertProject.run(slug, originalPath, JSON.stringify(sessionsIndex), now, this.sourceId);
  }

  onProjectMemory(slug: string, content: string): void {
    const now = Date.now();
    this.stmtInsertMemory.run(slug, content, now);
  }

  onSession(slug: string, entry: SessionIndexEntry): void {
    const now = Date.now();
    // Reset Codex attribution state for this session (re-ingest / new session).
    this.lastAssistantBySession.delete(entry.sessionId);
    this.lastTotalBySession.delete(entry.sessionId);
    this.attributedTurnBySession.delete(entry.sessionId);
    this.stmtInsertSession.run(
      entry.sessionId,
      slug,
      entry.fullPath,
      entry.firstPrompt,
      entry.summary,
      entry.gitBranch,
      entry.projectPath,
      entry.isSidechain ? 1 : 0,
      entry.created,
      entry.modified,
      entry.fileMtime,
      null, // plan_slug — set later if found
      0, // has_task — set later if found
      now,
      this.sourceId,
    );
  }

  onMessage(slug: string, sessionId: string, message: SessionMessage, index: number, byteOffset: number): void {
    const extracted = this.messageExtractor.extract(message);
    // null = the source's extractor declared this record a non-message row.
    // Claude Code stores a row per line, so this never fires for claude-code.
    // Codex: non-message lines include token_count events — handle those.
    if (!extracted) {
      if (this.sourceId === 'codex') {
        this.applyCodexTokenCount(slug, sessionId, message);
      }
      return;
    }
    const data = JSON.stringify(message);

    this.stmtInsertMessage.run(
      slug,
      sessionId,
      index,
      extracted.msgType,
      extracted.uuid,
      extracted.timestamp,
      data,
      extracted.tokens.inputTokens,
      extracted.tokens.outputTokens,
      extracted.tokens.cacheCreationTokens,
      extracted.tokens.cacheReadTokens,
      extracted.text,
      byteOffset,
      this.sourceId,
    );

    // Codex attributes the next token_count's last_token_usage to this turn.
    if (this.sourceId === 'codex' && extracted.msgType === 'assistant') {
      this.lastAssistantBySession.set(sessionId, { slug, msgIndex: index });
    }
  }

  /**
   * Codex: stamp turn tokens onto the most recent assistant message.
   * Prefer `last_token_usage` (per-turn); keep cumulative total for
   * session-complete fallback when no turn was attributed.
   */
  private applyCodexTokenCount(slug: string, sessionId: string, raw: unknown): void {
    const parsed = parseCodexTokenCount(raw);
    if (!parsed) return;

    if (parsed.total) {
      this.lastTotalBySession.set(sessionId, parsed.total);
    }

    const usage = parsed.last ?? parsed.total;
    if (!usage) return;

    const target = this.lastAssistantBySession.get(sessionId);
    if (!target) {
      // token_count before any assistant turn (or only rate-limits earlier).
      // Remember total for onSessionComplete fallback.
      return;
    }

    this.stmtUpdateMessageTokens.run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens,
      sessionId,
      target.msgIndex,
    );
    this.attributedTurnBySession.add(sessionId);
    // Avoid double-applying the same cumulative total if another token_count
    // arrives before the next assistant message (duplicate snapshots).
    // last_token_usage on a duplicate with unchanged totals is still fine to
    // re-apply (same values); we clear the pointer only when we used total as
    // a fallback without last.
    if (!parsed.last && parsed.total) {
      this.lastAssistantBySession.delete(sessionId);
    }
  }

  private applyCodexSessionTotalFallback(sessionId: string): void {
    if (this.attributedTurnBySession.has(sessionId)) return;
    const total = this.lastTotalBySession.get(sessionId);
    if (!total) return;
    const target = this.lastAssistantBySession.get(sessionId);
    if (!target) return;
    this.stmtUpdateMessageTokens.run(
      total.inputTokens,
      total.outputTokens,
      total.cacheCreationTokens,
      total.cacheReadTokens,
      sessionId,
      target.msgIndex,
    );
    this.attributedTurnBySession.add(sessionId);
  }

  onSubagent(slug: string, sessionId: string, transcript: SubagentTranscript): void {
    const now = Date.now();
    // Prefer the sidecar's real agent type (general-purpose, Explore, …)
    // over the filename-inferred kind (task/prompt_suggestion/compact).
    const agentType = transcript.meta?.agentType ?? transcript.agentType;
    this.stmtInsertSubagent.run(
      slug,
      sessionId,
      transcript.agentId,
      agentType,
      transcript.fileName,
      JSON.stringify(transcript.messages),
      transcript.messages.length,
      transcript.workflowId,
      now,
    );
  }

  onWorkflow(slug: string, sessionId: string, workflow: WorkflowRun): void {
    const now = Date.now();
    this.stmtInsertWorkflow.run(
      slug,
      sessionId,
      workflow.workflowId,
      workflow.name,
      workflow.status,
      workflow.agentCount,
      workflow.totalTokens,
      workflow.totalToolCalls,
      workflow.durationMs,
      workflow.subagentCount,
      JSON.stringify(workflow.data),
      JSON.stringify(workflow.journal),
      now,
    );
  }

  onToolResult(slug: string, sessionId: string, toolResult: PersistedToolResult): void {
    const now = Date.now();
    this.stmtInsertToolResult.run(slug, sessionId, toolResult.toolUseId, toolResult.content, now);
  }

  onFileHistory(sessionId: string, history: FileHistorySession): void {
    const now = Date.now();
    this.stmtInsertFileHistory.run(sessionId, JSON.stringify(history), now);
  }

  onTodo(sessionId: string, todo: TodoFile): void {
    const now = Date.now();
    this.stmtInsertTodo.run(sessionId, todo.agentId, JSON.stringify(todo.items), now);
  }

  onTask(sessionId: string, task: TaskEntry): void {
    const now = Date.now();
    this.stmtInsertTask.run(sessionId, task.hasHighwatermark ? 1 : 0, task.highwatermark, task.lockExists ? 1 : 0, now);

    // Also update the session's has_task flag
    this.db.run('UPDATE sessions SET has_task = 1 WHERE id = ?', sessionId);
  }

  onPlan(slug: string, plan: PlanFile): void {
    const now = Date.now();
    this.stmtInsertPlan.run(slug, plan.title, plan.content, plan.size, now);
  }

  onSessionComplete(_slug: string, sessionId: string, _messageCount: number, _lastBytePosition: number): void {
    // Codex: if no per-turn last_token_usage was applied (sparse events),
    // stamp the final cumulative total onto the last assistant message so
    // session/project SUM(token columns) still reflects real usage.
    if (this.sourceId === 'codex') {
      this.applyCodexSessionTotalFallback(sessionId);
      this.lastAssistantBySession.delete(sessionId);
      this.lastTotalBySession.delete(sessionId);
      this.attributedTurnBySession.delete(sessionId);
    }
  }

  onProjectComplete(_slug: string): void {
    // No-op for now. Could be used for summary recomputation.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fingerprints
  // ─────────────────────────────────────────────────────────────────────────

  getFingerprint(filePath: string): SourceFingerprint | null {
    const row = this.db.get<SourceFileRow>(
      'SELECT path, mtime_ms, size, byte_position FROM source_files WHERE path = ?',
      filePath,
    );
    if (!row) return null;
    return this.rowToFingerprint(row);
  }

  getAllFingerprints(): SourceFingerprint[] {
    const rows = this.db.all<SourceFileRow>('SELECT path, mtime_ms, size, byte_position FROM source_files');
    return rows.map((row) => this.rowToFingerprint(row));
  }

  upsertFingerprint(fp: SourceFingerprint): void {
    this.stmtUpsertFingerprint.run(fp.path, fp.mtimeMs, fp.size, fp.bytePosition ?? null, this.sourceId);
  }

  deleteFingerprint(filePath: string): void {
    this.db.run('DELETE FROM source_files WHERE path = ?', filePath);
  }

  getNextMessageIndex(sessionId: string): number {
    const row = this.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(msg_index) + 1, 0) AS next FROM messages WHERE session_id = ?',
      sessionId,
    );
    return row?.next ?? 0;
  }

  getMeta(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transactions
  // ─────────────────────────────────────────────────────────────────────────

  beginTransaction(): void {
    if (!this.inTransaction) {
      this.db.exec('BEGIN TRANSACTION');
      this.inTransaction = true;
    }
  }

  commitTransaction(): void {
    if (this.inTransaction) {
      this.db.exec('COMMIT');
      this.inTransaction = false;
    }
  }

  rollbackTransaction(): void {
    if (this.inTransaction) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore errors during rollback — the transaction may already be
        // rolled back (e.g., if the DB connection was lost).
      }
      this.inTransaction = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk ingest optimization
  // ─────────────────────────────────────────────────────────────────────────

  private inBulkMode = false;

  beginBulkIngest(): void {
    if (this.inBulkMode) return;
    this.inBulkMode = true;

    // Drop FTS auto-sync triggers to avoid per-row overhead during bulk insert
    try {
      this.db.exec('DROP TRIGGER IF EXISTS messages_ai');
    } catch {
      /* ignore */
    }
    try {
      this.db.exec('DROP TRIGGER IF EXISTS messages_ad');
    } catch {
      /* ignore */
    }
    try {
      this.db.exec('DROP TRIGGER IF EXISTS messages_au');
    } catch {
      /* ignore */
    }

    // Aggressive PRAGMAs for bulk write performance
    try {
      this.db.exec('PRAGMA synchronous = OFF');
      this.db.exec('PRAGMA cache_size = -64000'); // 64MB cache
    } catch {
      /* ignore */
    }
  }

  endBulkIngest(): void {
    if (!this.inBulkMode) return;
    this.inBulkMode = false;

    // Recreate FTS triggers
    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO search_fts(rowid, text_content) VALUES (new.id, new.text_content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO search_fts(search_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO search_fts(search_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
          INSERT INTO search_fts(rowid, text_content) VALUES (new.id, new.text_content);
        END;
      `);
    } catch {
      /* ignore — triggers may already exist */
    }

    // Rebuild the FTS index in one shot (much faster than per-row trigger inserts)
    try {
      this.rebuildFts();
    } catch {
      /* ignore */
    }

    // Restore safe PRAGMAs
    try {
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA cache_size = -2000'); // default ~2MB
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live-updates write path (RFC 005 C2.6)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write a batch of `ParsedRow`s as a single live-update transaction.
   *
   * Atomicity: wraps the whole batch in `BEGIN IMMEDIATE` (via the
   * existing `beginTransaction`/`commitTransaction`/`rollbackTransaction`
   * helpers) so either all rows land or none do. A throw mid-batch
   * rolls back and rethrows — the checkpoint is not advanced by the
   * caller so the orchestrator will retry.
   *
   * Dispatch: each row's `category` discriminates the union and
   * routes to the matching `on*` method. TS narrows the variant so
   * payload fields are read directly without any `as` casts.
   *
   * Change events: after commit we walk the rows again and translate
   * each into the matching `Change` variant (see `live/change-events.ts`).
   * `project_memory` + `session_index` rows mutate SQLite but emit no
   * `Change` — the union has no matching variants (see RFC 005 §2.9).
   * Each returned `Change` is stamped `ts = Date.now()` and `seq = 0`;
   * the real monotonic `seq` is assigned inside `AgentDataStore.emit()`
   * when the writer loop fans the change out. See RFC 005 §Event
   * sequence numbering (counter is not persisted).
   */
  async writeBatch(rows: ParsedRow[]): Promise<WriteResult> {
    const startedAt = Date.now();

    // Empty batch: no-op. Do NOT open a transaction; callers hit this
    // when the coalescing queue drains with nothing to write.
    if (rows.length === 0) {
      return { changes: [], durationMs: Date.now() - startedAt };
    }

    // RFC 005 C4.3: when this instance is pinned to the `rs` engine and
    // the native addon loaded, dispatch through
    // `native.liveIngestBatch` so the live path writes via the same
    // Rust writer the cold-start engine uses. On any failure — native
    // addon throws, DB locked, etc. — fall back to the TS path for
    // *this* batch (same process, subsequent batches try native again
    // if they were transient). We log once per process to keep the
    // fallback visible without spamming.
    if (this.engine === 'rs' && this.native && this.dbPath) {
      try {
        this.native.liveIngestBatch(
          this.dbPath,
          rows.map((r) => parsedRowToNativeLiveRow(r, this.messageExtractor)),
        );
        return { changes: buildChangesFromRows(rows), durationMs: Date.now() - startedAt };
      } catch (err) {
        if (!this.nativeFallbackLogged) {
          console.warn(
            '[spaghetti-sdk] native live-ingest failed; falling back to TS writer. ' +
              `Further native failures this session will be silent. Error: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
          this.nativeFallbackLogged = true;
        }
        // Fall through to the TS path.
      }
    }

    // `BEGIN IMMEDIATE` equivalent: the shared `beginTransaction` uses
    // `BEGIN TRANSACTION` (deferred by default in SQLite). For live-
    // update semantics we want the write lock acquired up front so
    // concurrent readers can't block the commit indefinitely. Use
    // `BEGIN IMMEDIATE` directly when we're the first to open the tx.
    const weOpenedTx = !this.inTransaction;
    if (weOpenedTx) {
      this.db.exec('BEGIN IMMEDIATE');
      this.inTransaction = true;
    }

    try {
      // Pass `this` directly as the RowWriteContext — IngestServiceImpl
      // implements the context surface structurally, so no alias needed.
      for (const row of rows) {
        applyRowHandler(row, this);
      }

      if (weOpenedTx) {
        this.db.exec('COMMIT');
        this.inTransaction = false;
      }
    } catch (err) {
      if (weOpenedTx && this.inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Ignore — the tx may already be rolled back.
        }
        this.inTransaction = false;
      }
      throw err;
    }

    return { changes: buildChangesFromRows(rows), durationMs: Date.now() - startedAt };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────────────

  vacuum(): void {
    this.db.vacuum();
  }

  rebuildFts(): void {
    this.db.exec(`INSERT INTO search_fts(search_fts) VALUES('rebuild')`);
  }

  deleteAllData(): void {
    const tables = [
      'messages',
      'subagents',
      'workflows',
      'tool_results',
      'todos',
      'tasks',
      'plans',
      'sessions',
      'project_memories',
      'projects',
      'file_history',
      'config',
      'analytics',
      'source_files',
    ];
    for (const table of tables) {
      this.db.exec(`DELETE FROM ${table}`);
    }
    // Rebuild FTS after deleting all content
    this.rebuildFts();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private rowToFingerprint(row: SourceFileRow): SourceFingerprint {
    const fp: SourceFingerprint = { path: row.path, mtimeMs: row.mtime_ms, size: row.size };
    if (row.byte_position != null) fp.bytePosition = row.byte_position;
    return fp;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createIngestService(
  sqliteServiceFactory: () => SqliteService,
  options?: CreateIngestServiceOptions,
): IngestService {
  return new IngestServiceImpl(sqliteServiceFactory, options);
}

/**
 * Options accepted by {@link createIngestService}.
 *
 * Introduced in RFC 005 Phase 4 C4.3 to thread the engine pin + native
 * addon handle into `IngestServiceImpl`. Both default to "no native
 * routing" (`engine: 'ts'`, `native: null`) so call sites that don't
 * opt in — tests, non-live paths — keep the existing TS-only behaviour.
 */
export interface CreateIngestServiceOptions {
  /**
   * Which engine this service was built for. Only `'rs'` enables the
   * native live-ingest route in {@link IngestService.writeBatch}; any
   * other value keeps the TS path.
   */
  engine?: IngestEngine;
  /**
   * The loaded native addon, or `null` when unavailable. When `engine
   * === 'rs'` but `native === null` (addon missing on this platform),
   * `writeBatch` stays on the TS path.
   */
  native?: NativeAddon | null;
  /**
   * The source's message extractor (RFC 006). Defaults to
   * {@link claudeCodeMessageExtractor}. A second `AgentSource` passes its own so
   * the ingest writer never learns that source's message envelope.
   */
  messages?: MessageExtractor;
  /**
   * The `AgentSource.id` this service writes for. Bound into the `source_id`
   * column of every row (RFC 006 §5.1 — one index, source_id column). Defaults
   * to `'claude-code'`, matching the schema DEFAULT, so the claude-code path and
   * the Rust writer (which still relies on the DEFAULT) stay byte-identical.
   */
  sourceId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE-PATH HELPERS (shared by TS + native write paths)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serialize a {@link ParsedRow} for the Rust live-ingest entry
 * (`liveIngestBatch`).
 *
 * The wire contract is defined in `crates/spaghetti-napi/src/live_ingest.rs`
 * — each `category` carries a `payload_json` whose shape matches the
 * corresponding `IngestEvent` variant fields. For `message` we flatten a
 * handful of projections (msgType / uuid / timestamp / token counters /
 * ftsText) that the Rust side would otherwise have to re-derive from the
 * raw JSONL — pre-extracting on the TS side keeps the Rust path a pure
 * parameter bind.
 */
function parsedRowToNativeLiveRow(
  row: ParsedRow,
  extractor: MessageExtractor,
): {
  category: string;
  slug?: string;
  sessionId?: string;
  payloadJson: string;
} {
  switch (row.category) {
    case 'message': {
      // Mirrors the per-field extraction `onMessage` performs for the TS path
      // — the source's extractor runs once here so the Rust writer can bind
      // directly without re-parsing the raw JSONL. The `??` fallbacks are dead
      // code for claude-code (its extractor yields a projection per line); they
      // guard a future source whose extractor skips non-message rows.
      const extracted = extractor.extract(row.message);
      const msgType = extracted?.msgType ?? 'unknown';
      const uuid = extracted?.uuid ?? null;
      const timestamp = extracted?.timestamp ?? null;
      const tokens = extracted?.tokens ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      const ftsText = extracted?.text ?? '';
      const payload = {
        msgIndex: row.msgIndex,
        byteOffset: row.byteOffset,
        // Raw JSONL line isn't available on ParsedRow; the Rust writer
        // stores `JSON.stringify(message)` into `messages.data`, matching
        // what the TS writer does via `data = JSON.stringify(message)` in
        // `onMessage`. Keeping the same stringifier means round-tripping
        // produces identical bytes.
        rawJson: JSON.stringify(row.message),
        msgType,
        uuid,
        timestamp,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        ftsText,
      };
      return {
        category: 'message',
        slug: row.slug,
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(payload),
      };
    }
    case 'subagent':
      return {
        category: 'subagent',
        slug: row.slug,
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(row.transcript),
      };
    case 'tool_result':
      return {
        category: 'tool_result',
        slug: row.slug,
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(row.result),
      };
    case 'file_history':
      return {
        category: 'file_history',
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(row.history),
      };
    case 'todo':
      return {
        category: 'todo',
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(row.todo),
      };
    case 'task':
      return {
        category: 'task',
        sessionId: row.sessionId,
        payloadJson: JSON.stringify(row.task),
      };
    case 'plan':
      return {
        category: 'plan',
        slug: row.slug,
        payloadJson: JSON.stringify(row.plan),
      };
    case 'project_memory':
      return {
        category: 'project_memory',
        slug: row.slug,
        payloadJson: JSON.stringify({ content: row.content }),
      };
    case 'session_index':
      return {
        category: 'session_index',
        slug: row.slug,
        payloadJson: JSON.stringify({
          originalPath: row.originalPath,
          sessionsIndex: row.sessionsIndex,
        }),
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROW HANDLER TABLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subset of `IngestService` the row handlers need to write a row.
 * Keeping this structural rather than passing the full implementation
 * lets the table stay outside the class (no `this` capture) while the
 * impl class still satisfies the shape via duck-typing.
 *
 * `session_index` reuses `onProject(slug, originalPath, sessionsIndex)`
 * — that signature is identical to the `applySessionIndex` helper
 * the live path used to call.
 */
interface RowWriteContext {
  onMessage(slug: string, sessionId: string, message: SessionMessage, index: number, byteOffset: number): void;
  onSubagent(slug: string, sessionId: string, transcript: SubagentTranscript): void;
  onToolResult(slug: string, sessionId: string, toolResult: PersistedToolResult): void;
  onFileHistory(sessionId: string, history: FileHistorySession): void;
  onTodo(sessionId: string, todo: TodoFile): void;
  onTask(sessionId: string, task: TaskEntry): void;
  onPlan(slug: string, plan: PlanFile): void;
  onProjectMemory(slug: string, content: string): void;
  onProject(slug: string, originalPath: string, sessionsIndex: SessionsIndex): void;
}

/** Narrow a `ParsedRow` to the variant matching its `category`. */
type RowOf<C extends ParsedRowCategory> = Extract<ParsedRow, { category: C }>;

/**
 * One entry per `ParsedRow.category`. `apply` drives the SQLite write
 * via `RowWriteContext`; `toChange` builds the matching `Change`
 * variant or returns `null` for SQLite-only rows that have no
 * corresponding event (`project_memory`, `session_index`, plus
 * `file_history` when the snapshot list is empty).
 *
 * Adding a new category means adding ONE entry here — the dispatch
 * loop in `writeBatch` and the change-fan-out loop in
 * `buildChangesFromRows` consult this table directly so neither needs
 * a parallel switch.
 */
interface RowHandler<C extends ParsedRowCategory> {
  apply(row: RowOf<C>, ctx: RowWriteContext): void;
  toChange(row: RowOf<C>, ts: number): Change | null;
}

type RowHandlers = { [C in ParsedRowCategory]: RowHandler<C> };

/**
 * Identity helper that pins the per-category entry to its narrowed
 * `RowHandler<C>` type. Without the helper, TypeScript widens each
 * record value to the union over every category and the per-row
 * field reads (`r.slug`, `r.sessionId`, …) lose their narrowing.
 */
function handler<C extends ParsedRowCategory>(h: RowHandler<C>): RowHandler<C> {
  return h;
}

const ROW_HANDLERS: RowHandlers = {
  message: handler<'message'>({
    apply: (r, c) => c.onMessage(r.slug, r.sessionId, r.message, r.msgIndex, r.byteOffset),
    toChange: (r, ts) => ({
      type: 'session.message.added',
      seq: 0,
      ts,
      slug: r.slug,
      sessionId: r.sessionId,
      message: r.message,
      byteOffset: r.byteOffset,
    }),
  }),
  subagent: handler<'subagent'>({
    apply: (r, c) => c.onSubagent(r.slug, r.sessionId, r.transcript),
    toChange: (r, ts) => ({
      type: 'subagent.updated',
      seq: 0,
      ts,
      slug: r.slug,
      sessionId: r.sessionId,
      agentId: r.transcript.agentId,
      transcript: r.transcript,
    }),
  }),
  tool_result: handler<'tool_result'>({
    apply: (r, c) => c.onToolResult(r.slug, r.sessionId, r.result),
    toChange: (r, ts) => ({
      type: 'tool-result.added',
      seq: 0,
      ts,
      slug: r.slug,
      sessionId: r.sessionId,
      toolUseId: r.result.toolUseId,
    }),
  }),
  file_history: handler<'file_history'>({
    apply: (r, c) => c.onFileHistory(r.sessionId, r.history),
    toChange: (r, ts) => {
      // `apply` persists every snapshot in the ParsedRow to SQLite,
      // but this `toChange` emits only ONE `file-history.added` event
      // — for `snapshots[0]`. Multi-snapshot rows (produced by
      // cold-start / rewrite re-ingest) therefore surface a single
      // event referencing the first snapshot; the other snapshots
      // are persisted silently. This matches pre-dispatch-table
      // behavior and the common case from live-tail (one snapshot
      // per ParsedRow). Fanning out one event per snapshot is a
      // follow-up when consumers need per-snapshot granularity.
      const snap = r.history.snapshots[0];
      if (!snap) return null;
      return {
        type: 'file-history.added',
        seq: 0,
        ts,
        sessionId: r.sessionId,
        hash: snap.hash,
        version: snap.version,
      };
    },
  }),
  todo: handler<'todo'>({
    apply: (r, c) => c.onTodo(r.sessionId, r.todo),
    toChange: (r, ts) => ({
      type: 'todo.updated',
      seq: 0,
      ts,
      sessionId: r.sessionId,
      agentId: r.todo.agentId,
      items: r.todo.items,
    }),
  }),
  task: handler<'task'>({
    apply: (r, c) => c.onTask(r.sessionId, r.task),
    toChange: (r, ts) => ({
      type: 'task.updated',
      seq: 0,
      ts,
      sessionId: r.sessionId,
      task: r.task,
    }),
  }),
  plan: handler<'plan'>({
    apply: (r, c) => c.onPlan(r.slug, r.plan),
    toChange: (r, ts) => ({
      type: 'plan.upserted',
      seq: 0,
      ts,
      slug: r.slug,
      plan: r.plan,
    }),
  }),
  project_memory: handler<'project_memory'>({
    apply: (r, c) => c.onProjectMemory(r.slug, r.content),
    // SQLite-only write, no Change emission (no matching union
    // variant — see RFC 005 §2.9).
    toChange: () => null,
  }),
  session_index: handler<'session_index'>({
    // No public `onSessionIndex(slug, originalPath, sessionsIndex)` on
    // `ProjectParseSink` — cold-start uses `onProject(slug,
    // originalPath, sessionsIndex)` with the same signature, which
    // is exactly what the live path needs too.
    apply: (r, c) => c.onProject(r.slug, r.originalPath, r.sessionsIndex),
    // SQLite-only write (ditto).
    toChange: () => null,
  }),
};

/**
 * Dispatch one row to its handler. Index access into `ROW_HANDLERS`
 * loses the discriminated-union → variant correspondence, so the
 * `as never` widens the row to satisfy each variant's `apply`
 * signature. Soundness comes from the `RowHandlers` type ensuring
 * every category has a matching apply.
 */
function applyRowHandler(row: ParsedRow, ctx: RowWriteContext): void {
  (ROW_HANDLERS[row.category] as RowHandler<typeof row.category>).apply(row as never, ctx);
}

/**
 * Build the `Change[]` the subscriber registry should fan out after a
 * successful batch. Shared between the TS and native paths so that
 * subscribers see the exact same events regardless of engine.
 *
 * Each returned Change carries `seq: 0` — the store's `emit()` stamps
 * the real monotonic counter on the way through fan-out. Doing it
 * here would divorce the counter from fan-out order; see C3.1 for the
 * history.
 */
function buildChangesFromRows(rows: ParsedRow[]): Change[] {
  const changes: Change[] = [];
  for (const row of rows) {
    const ts = Date.now();
    const change = (ROW_HANDLERS[row.category] as RowHandler<typeof row.category>).toChange(row as never, ts);
    if (change !== null) changes.push(change);
  }
  return changes;
}
