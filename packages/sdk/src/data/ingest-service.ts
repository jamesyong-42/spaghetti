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
} from '../types/index.js';
import type { Change } from '../live/change-events.js';
import type { ParsedRow } from '../live/incremental-parser.js';
import type { NativeAddon } from '../native.js';
import type { IngestEngine } from '../settings.js';
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
// TEXT EXTRACTION (for FTS)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TEXT_LENGTH = 2_000;

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.substring(0, MAX_TEXT_LENGTH);
}

/**
 * Extract searchable text content from a SessionMessage for FTS indexing.
 * Handles user messages (text content), assistant messages (text blocks),
 * and tool_use blocks (tool name + input summary).
 */
function extractTextContent(message: SessionMessage): string {
  const textParts: string[] = [];
  const msg = message as unknown as Record<string, unknown>;
  const msgType = msg.type as string | undefined;

  if (msgType === 'user') {
    const payload = msg.message as Record<string, unknown> | undefined;
    if (payload) {
      const content = payload.content;
      if (typeof content === 'string') {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
          } else if (b.type === 'tool_result') {
            const rc = b.content;
            if (typeof rc === 'string') {
              textParts.push(rc);
            } else if (Array.isArray(rc)) {
              for (const r of rc) {
                const rb = r as Record<string, unknown>;
                if (rb.type === 'text' && typeof rb.text === 'string') {
                  textParts.push(rb.text);
                }
              }
            }
          }
        }
      }
    }
  } else if (msgType === 'assistant') {
    const payload = msg.message as Record<string, unknown> | undefined;
    if (payload) {
      const content = payload.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
          } else if (b.type === 'tool_use') {
            const toolName = b.name as string | undefined;
            if (toolName) textParts.push(`[tool:${toolName}]`);
          }
        }
      }
    }
  } else if (msgType === 'summary') {
    const summary = msg.summary as string | undefined;
    if (summary) textParts.push(summary);
  }

  return truncate(textParts.join('\n'));
}

/**
 * Extract token usage from an assistant message.
 */
function extractTokens(message: SessionMessage): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
} {
  const msg = message as unknown as Record<string, unknown>;
  const defaults = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

  if (msg.type !== 'assistant') return defaults;

  const payload = msg.message as Record<string, unknown> | undefined;
  if (!payload) return defaults;

  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage) return defaults;

  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    cacheCreationTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
    cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
  };
}

/**
 * Extract the message type string from a SessionMessage.
 */
function extractMsgType(message: SessionMessage): string {
  const msg = message as unknown as Record<string, unknown>;
  return typeof msg.type === 'string' ? msg.type : 'unknown';
}

/**
 * Extract uuid from a SessionMessage.
 */
function extractUuid(message: SessionMessage): string | null {
  const msg = message as unknown as Record<string, unknown>;
  return typeof msg.uuid === 'string' ? msg.uuid : null;
}

/**
 * Extract timestamp from a SessionMessage.
 */
function extractTimestamp(message: SessionMessage): string | null {
  const msg = message as unknown as Record<string, unknown>;
  return typeof msg.timestamp === 'string' ? msg.timestamp : null;
}

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
  private stmtInsertToolResult!: PreparedStatement;
  private stmtInsertFileHistory!: PreparedStatement;
  private stmtInsertTodo!: PreparedStatement;
  private stmtInsertTask!: PreparedStatement;
  private stmtInsertPlan!: PreparedStatement;
  private stmtUpsertFingerprint!: PreparedStatement;

  private inTransaction = false;

  // RFC 005 C4.3: engine pin + native addon handle for the live-ingest
  // native route. When `engine === 'rs'` and `native` is loaded,
  // `writeBatch` dispatches through `native.liveIngestBatch(dbPath,
  // rows)`; otherwise it stays on the TS path. `dbPath` is captured
  // on `open()` so the native call can re-open its own short-lived
  // connection against the same file.
  private readonly engine: IngestEngine;
  private readonly native: NativeAddon | null;
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
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
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
      `INSERT INTO sessions (id, project_slug, full_path, first_prompt, summary, git_branch, project_path, is_sidechain, created_at, modified_at, file_mtime, plan_slug, has_task, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    this.stmtInsertMessage = this.db.prepare(
      `INSERT INTO messages (project_slug, session_id, msg_index, msg_type, uuid, timestamp, data, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, text_content, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      `INSERT INTO subagents (project_slug, session_id, agent_id, agent_type, file_name, messages, message_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_slug, session_id, agent_id) DO UPDATE SET
         agent_type = excluded.agent_type,
         file_name = excluded.file_name,
         messages = excluded.messages,
         message_count = excluded.message_count,
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
      `INSERT INTO source_files (path, mtime_ms, size, byte_position)
       VALUES (?, ?, ?, ?)
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
    this.stmtInsertProject.run(slug, originalPath, JSON.stringify(sessionsIndex), now);
  }

  onProjectMemory(slug: string, content: string): void {
    const now = Date.now();
    this.stmtInsertMemory.run(slug, content, now);
  }

  onSession(slug: string, entry: SessionIndexEntry): void {
    const now = Date.now();
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
    );
  }

  onMessage(slug: string, sessionId: string, message: SessionMessage, index: number, byteOffset: number): void {
    const msgType = extractMsgType(message);
    const uuid = extractUuid(message);
    const timestamp = extractTimestamp(message);
    const textContent = extractTextContent(message);
    const tokens = extractTokens(message);
    const data = JSON.stringify(message);

    this.stmtInsertMessage.run(
      slug,
      sessionId,
      index,
      msgType,
      uuid,
      timestamp,
      data,
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheCreationTokens,
      tokens.cacheReadTokens,
      textContent,
      byteOffset,
    );
  }

  onSubagent(slug: string, sessionId: string, transcript: SubagentTranscript): void {
    const now = Date.now();
    this.stmtInsertSubagent.run(
      slug,
      sessionId,
      transcript.agentId,
      transcript.agentType,
      transcript.fileName,
      JSON.stringify(transcript.messages),
      transcript.messages.length,
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

  onSessionComplete(_slug: string, _sessionId: string, _messageCount: number, _lastBytePosition: number): void {
    // No-op for now. Could be used to update byte_position on source_files.
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
    this.stmtUpsertFingerprint.run(fp.path, fp.mtimeMs, fp.size, fp.bytePosition ?? null);
  }

  deleteFingerprint(filePath: string): void {
    this.db.run('DELETE FROM source_files WHERE path = ?', filePath);
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
        this.native.liveIngestBatch(this.dbPath, rows.map(parsedRowToNativeLiveRow));
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
      for (const row of rows) {
        switch (row.category) {
          case 'message':
            this.onMessage(row.slug, row.sessionId, row.message, row.msgIndex, row.byteOffset);
            break;
          case 'subagent':
            this.onSubagent(row.slug, row.sessionId, row.transcript);
            break;
          case 'tool_result':
            this.onToolResult(row.slug, row.sessionId, row.result);
            break;
          case 'file_history':
            this.onFileHistory(row.sessionId, row.history);
            break;
          case 'todo':
            this.onTodo(row.sessionId, row.todo);
            break;
          case 'task':
            this.onTask(row.sessionId, row.task);
            break;
          case 'plan':
            this.onPlan(row.slug, row.plan);
            break;
          case 'project_memory':
            // SQLite write, no Change emission (no matching union
            // variant — see RFC 005 §2.9).
            this.onProjectMemory(row.slug, row.content);
            break;
          case 'session_index':
            // SQLite write, no Change emission (ditto).
            this.applySessionIndex(row.slug, row.originalPath, row.sessionsIndex);
            break;
        }
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

  /**
   * SQLite-only upsert for `session_index` rows. There is no public
   * `onSessionIndex(slug, originalPath, sessionsIndex)` on `ProjectParseSink`
   * — cold-start uses `onProject(slug, originalPath, sessionsIndex)`
   * with the same signature, which is exactly what we need. Using a
   * distinct private helper keeps the public sink surface untouched
   * while the live path gets a clear call site.
   */
  private applySessionIndex(slug: string, originalPath: string, sessionsIndex: SessionsIndex): void {
    this.onProject(slug, originalPath, sessionsIndex);
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
function parsedRowToNativeLiveRow(row: ParsedRow): {
  category: string;
  slug?: string;
  sessionId?: string;
  payloadJson: string;
} {
  switch (row.category) {
    case 'message': {
      // Mirrors the per-field extraction `onMessage` performs for the
      // TS path — we compute once here so the Rust writer can bind
      // directly without re-parsing the raw JSONL.
      const msgType = extractMsgType(row.message);
      const uuid = extractUuid(row.message);
      const timestamp = extractTimestamp(row.message);
      const tokens = extractTokens(row.message);
      const ftsText = extractTextContent(row.message);
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

/**
 * Build the `Change[]` the subscriber registry should fan out after a
 * successful batch. Shared between the TS and native paths so that
 * subscribers see the exact same events regardless of engine.
 *
 * Each returned Change carries `seq: 0` — the store's `emit()` stamps
 * the real monotonic counter on the way through fan-out. Doing it here
 * would divorce the counter from fan-out order; see C3.1 for the
 * history.
 */
function buildChangesFromRows(rows: ParsedRow[]): Change[] {
  const changes: Change[] = [];
  for (const row of rows) {
    const ts = Date.now();
    switch (row.category) {
      case 'message':
        changes.push({
          type: 'session.message.added',
          seq: 0,
          ts,
          slug: row.slug,
          sessionId: row.sessionId,
          message: row.message,
          byteOffset: row.byteOffset,
        });
        break;
      case 'subagent':
        changes.push({
          type: 'subagent.updated',
          seq: 0,
          ts,
          slug: row.slug,
          sessionId: row.sessionId,
          agentId: row.transcript.agentId,
          transcript: row.transcript,
        });
        break;
      case 'tool_result':
        changes.push({
          type: 'tool-result.added',
          seq: 0,
          ts,
          slug: row.slug,
          sessionId: row.sessionId,
          toolUseId: row.result.toolUseId,
        });
        break;
      case 'file_history': {
        const snap = row.history.snapshots[0];
        if (snap) {
          changes.push({
            type: 'file-history.added',
            seq: 0,
            ts,
            sessionId: row.sessionId,
            hash: snap.hash,
            version: snap.version,
          });
        }
        // No snapshots → no Change emitted (store owns the counter).
        break;
      }
      case 'todo':
        changes.push({
          type: 'todo.updated',
          seq: 0,
          ts,
          sessionId: row.sessionId,
          agentId: row.todo.agentId,
          items: row.todo.items,
        });
        break;
      case 'task':
        changes.push({
          type: 'task.updated',
          seq: 0,
          ts,
          sessionId: row.sessionId,
          task: row.task,
        });
        break;
      case 'plan':
        changes.push({
          type: 'plan.upserted',
          seq: 0,
          ts,
          slug: row.slug,
          plan: row.plan,
        });
        break;
      case 'project_memory':
      case 'session_index':
        // SQLite-only write, no Change emission (no matching union
        // variant — see RFC 005 §2.9).
        break;
    }
  }
  return changes;
}
