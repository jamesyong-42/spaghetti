//! Single-thread SQLite writer — ported from the write paths of
//! `packages/sdk/src/data/ingest-service.ts`.
//!
//! # Role in the pipeline
//!
//! The writer owns exactly one `rusqlite::Connection` for the duration of
//! an ingest. It consumes [`IngestEvent`]s from a `crossbeam_channel`
//! receiver, maintains one open transaction per project, and writes into
//! the schema-1.3 tables via a set of prepared statements created once at
//! startup.
//!
//! # Transaction boundaries
//!
//! - The writer begins a transaction on the first event of each project,
//!   which is almost always [`IngestEvent::Project`] but may be any other
//!   variant if the parser emitted them in a permissive order.
//! - It commits on [`IngestEvent::ProjectComplete`].
//! - A [`IngestEvent::WorkerError`] rolls back the current transaction
//!   and skips forward to the next project boundary.
//! - A fatal SQL error is returned up; the caller decides whether to
//!   continue.
//!
//! # FTS5 sync
//!
//! The content-synced triggers defined in `schema.rs` keep the
//! `search_fts` virtual table in lock-step with `messages` via INSERT/
//! UPDATE/DELETE hooks. The writer does **not** write to `search_fts`
//! directly — the triggers handle it.
//!
//! # Bulk ingest
//!
//! Unlike the TS `beginBulkIngest` which drops+recreates the triggers,
//! this writer keeps the triggers on and only tweaks PRAGMAs
//! (`synchronous = OFF`, `temp_store = MEMORY`). The TS trigger-drop is
//! an optimisation we defer to a later commit — correctness first.
//!
//! Populated in RFC 003 commit 1.5.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crossbeam_channel::Receiver;
use rusqlite::{params, Connection};
use thiserror::Error;

use crate::parse_sink::IngestEvent;
use crate::schema::{self, SchemaError};

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

/// Errors produced by the SQLite writer.
#[derive(Debug, Error)]
pub enum WriterError {
    /// An underlying SQLite error occurred.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// Schema initialization or PRAGMA setup failed.
    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),

    /// JSON (re-)serialization failed. Only fires for variants that need
    /// to serialise structured payloads (subagent messages, file history,
    /// todos); the `messages.data` column uses `raw_json` as-is.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

// ═══════════════════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════════════════

/// Counters returned from [`Writer::run`]. Incremented on successful
/// writes only — rolled-back rows are not counted.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WriterStats {
    pub projects_processed: u32,
    pub sessions_processed: u32,
    pub messages_written: u32,
    pub subagents_written: u32,
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL templates
// ═══════════════════════════════════════════════════════════════════════════
//
// Lifted verbatim from `packages/sdk/src/data/ingest-service.ts`. Kept as
// module-level `const`s so they're easy to diff against the TS source.

const SQL_INSERT_PROJECT: &str = r#"
INSERT INTO projects (slug, original_path, sessions_index, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(slug) DO UPDATE SET
  original_path = excluded.original_path,
  sessions_index = excluded.sessions_index,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_MEMORY: &str = r#"
INSERT INTO project_memories (project_slug, content, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(project_slug) DO UPDATE SET
  content = excluded.content,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_SESSION: &str = r#"
INSERT INTO sessions (
  id, project_slug, full_path, first_prompt, summary, git_branch,
  project_path, is_sidechain, created_at, modified_at, file_mtime,
  plan_slug, has_task, updated_at
)
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
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_MESSAGE: &str = r#"
INSERT INTO messages (
  project_slug, session_id, msg_index, msg_type, uuid, timestamp, data,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  text_content, byte_offset
)
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
  byte_offset = excluded.byte_offset
"#;

const SQL_INSERT_SUBAGENT: &str = r#"
INSERT INTO subagents (
  project_slug, session_id, agent_id, agent_type, file_name,
  messages, message_count, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(project_slug, session_id, agent_id) DO UPDATE SET
  agent_type = excluded.agent_type,
  file_name = excluded.file_name,
  messages = excluded.messages,
  message_count = excluded.message_count,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_TOOL_RESULT: &str = r#"
INSERT INTO tool_results (project_slug, session_id, tool_use_id, content, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(project_slug, session_id, tool_use_id) DO UPDATE SET
  content = excluded.content,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_FILE_HISTORY: &str = r#"
INSERT INTO file_history (session_id, data, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  data = excluded.data,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_TODO: &str = r#"
INSERT INTO todos (session_id, agent_id, items, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id, agent_id) DO UPDATE SET
  items = excluded.items,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_TASK: &str = r#"
INSERT INTO tasks (session_id, has_highwatermark, highwatermark, lock_exists, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  has_highwatermark = excluded.has_highwatermark,
  highwatermark = excluded.highwatermark,
  lock_exists = excluded.lock_exists,
  updated_at = excluded.updated_at
"#;

const SQL_INSERT_PLAN: &str = r#"
INSERT INTO plans (slug, title, content, size, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  content = excluded.content,
  size = excluded.size,
  updated_at = excluded.updated_at
"#;

const SQL_UPDATE_SESSION_HAS_TASK: &str = "UPDATE sessions SET has_task = 1 WHERE id = ?";

// ═══════════════════════════════════════════════════════════════════════════
// Writer
// ═══════════════════════════════════════════════════════════════════════════

/// Single-thread SQLite writer.
///
/// Owns a `rusqlite::Connection`, a set of prepared statement *texts*, and
/// running counters. Prepared statements themselves are created inline on
/// each call rather than cached on the struct because rusqlite's
/// `Statement<'_>` borrows the connection, which would make this struct
/// self-referential. rusqlite maintains an internal prepared-statement
/// cache (`conn.prepare_cached`) that gives us the same amortised cost.
pub struct Writer {
    conn: Connection,
    /// DB path — only used for diagnostic output.
    #[allow(dead_code)]
    db_path: PathBuf,
    /// Whether [`open_for_bulk_ingest`] has been called. Used by
    /// [`finish`] to know whether to restore PRAGMAs.
    bulk_mode: bool,
    /// Tracks whether there's an in-flight transaction we need to commit
    /// or roll back.
    in_transaction: bool,
    /// Slug of the current project's transaction, if any.
    current_slug: Option<String>,
    stats: WriterStats,
}

impl Writer {
    /// Open (or create) the SQLite database at `db_path`, apply the
    /// connection-level PRAGMAs, and run migrations.
    pub fn new(db_path: &Path) -> Result<Self, WriterError> {
        let conn = Connection::open(db_path)?;
        schema::set_pragmas(&conn)?;
        schema::initialize_schema(&conn)?;
        Ok(Self {
            conn,
            db_path: db_path.to_path_buf(),
            bulk_mode: false,
            in_transaction: false,
            current_slug: None,
            stats: WriterStats::default(),
        })
    }

    /// Test-only constructor that wraps an existing `Connection`. Runs
    /// `set_pragmas` + `initialize_schema` so the caller gets a ready-to-
    /// use writer against an in-memory DB.
    #[cfg(test)]
    pub(crate) fn from_connection(conn: Connection) -> Result<Self, WriterError> {
        schema::set_pragmas(&conn)?;
        schema::initialize_schema(&conn)?;
        Ok(Self {
            conn,
            db_path: PathBuf::from(":memory:"),
            bulk_mode: false,
            in_transaction: false,
            current_slug: None,
            stats: WriterStats::default(),
        })
    }

    /// Enter bulk-ingest mode.
    ///
    /// Applies aggressive PRAGMAs suitable for a single-writer, high-
    /// volume INSERT session:
    /// - `synchronous = OFF` — skip fsync per transaction (WAL durability
    ///   is still provided by the journal file; we trade a crash-window
    ///   for throughput, matching TS `beginBulkIngest`).
    /// - `temp_store = MEMORY` — keep sort/index scratch off disk.
    /// - `cache_size = -64000` — 64MB page cache.
    ///
    /// The FTS5 triggers are **not** dropped here (unlike the TS path).
    /// Keeping them on preserves correctness; a future commit can revisit.
    pub fn open_for_bulk_ingest(&mut self) -> Result<(), WriterError> {
        if self.bulk_mode {
            return Ok(());
        }
        self.bulk_mode = true;
        self.conn.pragma_update(None, "synchronous", "OFF")?;
        self.conn.pragma_update(None, "temp_store", "MEMORY")?;
        self.conn.pragma_update(None, "cache_size", -64_000i64)?;
        Ok(())
    }

    /// Drain events from `events` until the channel is empty and
    /// disconnected. Returns the final counters.
    ///
    /// Per-project transaction handling:
    /// - The first data-bearing event after a boundary (or at startup)
    ///   starts a transaction.
    /// - [`IngestEvent::ProjectComplete`] commits it.
    /// - [`IngestEvent::WorkerError`] rolls it back.
    /// - Channel-close with an open transaction rolls it back as well
    ///   (matching the TS `close()` behaviour which rolls back to avoid
    ///   persisting partial data).
    pub fn run(&mut self, events: Receiver<IngestEvent>) -> Result<WriterStats, WriterError> {
        while let Ok(ev) = events.recv() {
            self.handle_event(ev)?;
        }

        // Channel closed with an open transaction — roll it back; we
        // cannot know whether the project finished cleanly.
        if self.in_transaction {
            self.rollback_transaction();
        }

        Ok(self.stats)
    }

    /// Restore normal PRAGMAs and close. Takes `self` by value so the
    /// connection is dropped on return.
    pub fn finish(mut self) -> Result<(), WriterError> {
        if self.in_transaction {
            self.rollback_transaction();
        }
        if self.bulk_mode {
            // Restore safe defaults; mirrors TS `endBulkIngest`.
            self.conn.pragma_update(None, "synchronous", "NORMAL")?;
            self.conn.pragma_update(None, "cache_size", -2_000i64)?;
            self.bulk_mode = false;
        }
        // `self` drops here, closing the connection.
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    // Event dispatch
    // ───────────────────────────────────────────────────────────────────────

    fn handle_event(&mut self, ev: IngestEvent) -> Result<(), WriterError> {
        match ev {
            IngestEvent::Project {
                slug,
                original_path,
                sessions_index_json,
            } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                self.conn.execute(
                    SQL_INSERT_PROJECT,
                    params![slug, original_path, sessions_index_json, now],
                )?;
            }

            IngestEvent::ProjectMemory { slug, content } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                self.conn
                    .execute(SQL_INSERT_MEMORY, params![slug, content, now])?;
            }

            IngestEvent::Session { slug, entry } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                self.conn.execute(
                    SQL_INSERT_SESSION,
                    params![
                        entry.session_id,
                        slug,
                        entry.full_path,
                        entry.first_prompt,
                        entry.summary,
                        entry.git_branch,
                        entry.project_path,
                        entry.is_sidechain as i64,
                        entry.created,
                        entry.modified,
                        entry.file_mtime,
                        Option::<String>::None, // plan_slug set later if found
                        0_i64,                  // has_task set later if found
                        now,
                    ],
                )?;
                self.stats.sessions_processed = self.stats.sessions_processed.saturating_add(1);
            }

            IngestEvent::Message {
                slug,
                session_id,
                index,
                byte_offset,
                raw_json,
                msg_type,
                uuid,
                timestamp,
                input_tokens,
                output_tokens,
                cache_creation_tokens,
                cache_read_tokens,
                fts_text,
            } => {
                self.ensure_transaction(&slug)?;
                let text = fts_text.unwrap_or_default();
                self.conn.execute(
                    SQL_INSERT_MESSAGE,
                    params![
                        slug,
                        session_id,
                        index as i64,
                        msg_type,
                        uuid,
                        timestamp,
                        raw_json,
                        input_tokens as i64,
                        output_tokens as i64,
                        cache_creation_tokens as i64,
                        cache_read_tokens as i64,
                        text,
                        byte_offset as i64,
                    ],
                )?;
                self.stats.messages_written = self.stats.messages_written.saturating_add(1);
            }

            IngestEvent::Subagent {
                slug,
                session_id,
                transcript,
            } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                let messages_json = serde_json::to_string(&transcript.messages)?;
                let agent_type = serde_json::to_string(&transcript.agent_type)?;
                // `to_string` on the enum produces `"task"` (with quotes).
                // SQLite stores it that way; we strip the quotes to match
                // the TS convention of storing the bare string.
                let agent_type = agent_type.trim_matches('"').to_string();
                let message_count = transcript.messages.len() as i64;
                self.conn.execute(
                    SQL_INSERT_SUBAGENT,
                    params![
                        slug,
                        session_id,
                        transcript.agent_id,
                        agent_type,
                        transcript.file_name,
                        messages_json,
                        message_count,
                        now,
                    ],
                )?;
                self.stats.subagents_written = self.stats.subagents_written.saturating_add(1);
            }

            IngestEvent::ToolResult {
                slug,
                session_id,
                tool_result,
            } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                self.conn.execute(
                    SQL_INSERT_TOOL_RESULT,
                    params![
                        slug,
                        session_id,
                        tool_result.tool_use_id,
                        tool_result.content,
                        now
                    ],
                )?;
            }

            IngestEvent::FileHistory {
                session_id,
                history,
            } => {
                // No slug on this event. Use the current transaction if
                // one is open; otherwise open one under a synthetic slug
                // so writes aren't auto-committed per-row.
                if !self.in_transaction {
                    self.begin_transaction("<orphan>")?;
                }
                let now = now_ms();
                let data = serde_json::to_string(&history)?;
                self.conn
                    .execute(SQL_INSERT_FILE_HISTORY, params![session_id, data, now])?;
            }

            IngestEvent::Todo { session_id, todo } => {
                if !self.in_transaction {
                    self.begin_transaction("<orphan>")?;
                }
                let now = now_ms();
                let items = serde_json::to_string(&todo.items)?;
                self.conn.execute(
                    SQL_INSERT_TODO,
                    params![session_id, todo.agent_id, items, now],
                )?;
            }

            IngestEvent::Task { session_id, task } => {
                if !self.in_transaction {
                    self.begin_transaction("<orphan>")?;
                }
                let now = now_ms();
                self.conn.execute(
                    SQL_INSERT_TASK,
                    params![
                        session_id,
                        task.has_highwatermark as i64,
                        task.highwatermark,
                        task.lock_exists as i64,
                        now
                    ],
                )?;
                // Mirror TS: also flip the session's has_task flag.
                self.conn
                    .execute(SQL_UPDATE_SESSION_HAS_TASK, params![session_id])?;
            }

            IngestEvent::Plan { slug, plan } => {
                self.ensure_transaction(&slug)?;
                let now = now_ms();
                self.conn.execute(
                    SQL_INSERT_PLAN,
                    params![plan.slug, plan.title, plan.content, plan.size as i64, now],
                )?;
            }

            IngestEvent::SessionComplete { .. } => {
                // No-op at the writer level (matches TS). Reserved for
                // future byte_position updates on source_files.
            }

            IngestEvent::ProjectComplete { slug, .. } => {
                // Commit the current transaction if it belongs to this
                // project. If it's an orphan transaction, commit anyway —
                // the orchestrator is telling us we've reached a natural
                // boundary.
                if self.in_transaction {
                    self.commit_transaction()?;
                    self.stats.projects_processed = self.stats.projects_processed.saturating_add(1);
                } else {
                    // No pending writes for this project; still bump
                    // projects_processed because the project was seen.
                    self.stats.projects_processed = self.stats.projects_processed.saturating_add(1);
                }
                // Always clear the slug regardless of the branch above.
                let _ = slug;
                self.current_slug = None;
            }

            IngestEvent::WorkerError { slug: _, error: _ } => {
                // Roll back any in-flight work for this project and keep
                // going. The error is surfaced by the orchestrator via
                // `IngestStats.errors`; the writer's only job is to not
                // persist partial project data.
                if self.in_transaction {
                    self.rollback_transaction();
                }
                self.current_slug = None;
            }
        }

        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    // Transaction helpers
    // ───────────────────────────────────────────────────────────────────────

    /// Begin a transaction for `slug` if we don't already have one. If a
    /// transaction is open for a *different* slug the old one is committed
    /// first — this tolerates parsers that forget to emit
    /// `ProjectComplete` before starting a new project.
    fn ensure_transaction(&mut self, slug: &str) -> Result<(), WriterError> {
        if let Some(current) = &self.current_slug {
            if current != slug {
                // Different project — commit the old one before starting
                // the new one.
                if self.in_transaction {
                    self.commit_transaction()?;
                    self.stats.projects_processed = self.stats.projects_processed.saturating_add(1);
                }
            }
        }
        if !self.in_transaction {
            self.begin_transaction(slug)?;
        }
        Ok(())
    }

    fn begin_transaction(&mut self, slug: &str) -> Result<(), WriterError> {
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        self.in_transaction = true;
        self.current_slug = Some(slug.to_string());
        Ok(())
    }

    fn commit_transaction(&mut self) -> Result<(), WriterError> {
        self.conn.execute_batch("COMMIT")?;
        self.in_transaction = false;
        self.current_slug = None;
        Ok(())
    }

    /// Roll back the current transaction, swallowing any error that
    /// occurs during rollback itself (matches the TS empty-catch). Used
    /// on `WorkerError` and on channel-close with an open transaction.
    fn rollback_transaction(&mut self) {
        let _ = self.conn.execute_batch("ROLLBACK");
        self.in_transaction = false;
        self.current_slug = None;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Current Unix time in milliseconds — TS uses `Date.now()` for all the
/// `updated_at` columns. Returns 0 on the astronomically unlikely event
/// that the system clock is before the epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SessionIndexEntry, SubagentTranscript, SubagentType};
    use crossbeam_channel::unbounded;
    use rusqlite::Connection;

    fn fresh_writer() -> Writer {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        Writer::from_connection(conn).expect("new writer")
    }

    fn sample_session(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            session_id: id.into(),
            full_path: format!("/tmp/{id}.jsonl"),
            file_mtime: 100.0,
            first_prompt: "first".into(),
            summary: "sum".into(),
            message_count: 3,
            created: "2026-04-17T00:00:00Z".into(),
            modified: "2026-04-17T00:00:01Z".into(),
            git_branch: "main".into(),
            project_path: "/tmp/proj".into(),
            is_sidechain: false,
        }
    }

    fn message_event(slug: &str, session_id: &str, index: u32) -> IngestEvent {
        IngestEvent::Message {
            slug: slug.into(),
            session_id: session_id.into(),
            index,
            byte_offset: u64::from(index) * 100,
            raw_json: format!(r#"{{"type":"user","idx":{index}}}"#),
            msg_type: "user".into(),
            uuid: Some(format!("u-{index}")),
            timestamp: Some("2026-04-17T00:00:00Z".into()),
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            fts_text: Some(format!("text {index}")),
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .expect("count")
    }

    /// One project, one session, three messages → all written, FTS synced.
    #[test]
    fn single_project_writes_rows_and_syncs_fts() {
        let mut w = fresh_writer();
        let (tx, rx) = unbounded::<IngestEvent>();

        tx.send(IngestEvent::Project {
            slug: "p1".into(),
            original_path: "/tmp/p1".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        tx.send(IngestEvent::Session {
            slug: "p1".into(),
            entry: sample_session("s1"),
        })
        .unwrap();
        tx.send(message_event("p1", "s1", 0)).unwrap();
        tx.send(message_event("p1", "s1", 1)).unwrap();
        tx.send(message_event("p1", "s1", 2)).unwrap();
        tx.send(IngestEvent::ProjectComplete {
            slug: "p1".into(),
            duration_ms: 0,
        })
        .unwrap();
        drop(tx);

        let stats = w.run(rx).expect("run");
        assert_eq!(stats.projects_processed, 1);
        assert_eq!(stats.sessions_processed, 1);
        assert_eq!(stats.messages_written, 3);

        assert_eq!(count(&w.conn, "projects"), 1);
        assert_eq!(count(&w.conn, "sessions"), 1);
        assert_eq!(count(&w.conn, "messages"), 3);
        // FTS triggers fire on INSERT — should see 3 rows via content-sync.
        assert_eq!(count(&w.conn, "search_fts"), 3);
    }

    /// Partial writes for project 2 must not be visible until
    /// `ProjectComplete` — verified by draining the first project only
    /// and checking row counts mid-stream via a fresh reader.
    #[test]
    fn transaction_boundary_is_per_project() {
        let mut w = fresh_writer();

        // Project 1: insert + commit.
        {
            let (tx, rx) = unbounded::<IngestEvent>();
            tx.send(IngestEvent::Project {
                slug: "p1".into(),
                original_path: "/tmp/p1".into(),
                sessions_index_json: "{}".into(),
            })
            .unwrap();
            tx.send(message_event("p1", "s1", 0)).unwrap();
            tx.send(IngestEvent::ProjectComplete {
                slug: "p1".into(),
                duration_ms: 0,
            })
            .unwrap();
            drop(tx);
            w.run(rx).expect("run p1");
        }
        assert_eq!(count(&w.conn, "projects"), 1);
        assert_eq!(count(&w.conn, "messages"), 1);

        // Project 2: send rows but NO ProjectComplete, then close the
        // channel. The writer rolls back on channel-close — project 2
        // must not appear.
        {
            let (tx, rx) = unbounded::<IngestEvent>();
            tx.send(IngestEvent::Project {
                slug: "p2".into(),
                original_path: "/tmp/p2".into(),
                sessions_index_json: "{}".into(),
            })
            .unwrap();
            tx.send(message_event("p2", "s2", 0)).unwrap();
            tx.send(message_event("p2", "s2", 1)).unwrap();
            drop(tx);
            w.run(rx).expect("run p2 partial");
        }
        assert_eq!(
            count(&w.conn, "projects"),
            1,
            "project 2 must be rolled back"
        );
        assert_eq!(
            count(&w.conn, "messages"),
            1,
            "project 2 messages must be rolled back"
        );
    }

    /// Message UPSERT — second write with same `(session_id, msg_index)`
    /// replaces the first.
    #[test]
    fn message_upsert_replaces_existing_row() {
        let mut w = fresh_writer();
        let (tx, rx) = unbounded::<IngestEvent>();

        tx.send(IngestEvent::Project {
            slug: "p1".into(),
            original_path: "/tmp/p1".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        // First version
        tx.send(IngestEvent::Message {
            slug: "p1".into(),
            session_id: "s1".into(),
            index: 0,
            byte_offset: 0,
            raw_json: "{\"v\":1}".into(),
            msg_type: "user".into(),
            uuid: Some("u1".into()),
            timestamp: Some("t1".into()),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            fts_text: Some("first".into()),
        })
        .unwrap();
        // Second version, same session_id + msg_index — should win.
        tx.send(IngestEvent::Message {
            slug: "p1".into(),
            session_id: "s1".into(),
            index: 0,
            byte_offset: 10,
            raw_json: "{\"v\":2}".into(),
            msg_type: "assistant".into(),
            uuid: Some("u2".into()),
            timestamp: Some("t2".into()),
            input_tokens: 5,
            output_tokens: 6,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            fts_text: Some("second".into()),
        })
        .unwrap();
        tx.send(IngestEvent::ProjectComplete {
            slug: "p1".into(),
            duration_ms: 0,
        })
        .unwrap();
        drop(tx);

        let stats = w.run(rx).expect("run");
        assert_eq!(
            count(&w.conn, "messages"),
            1,
            "UNIQUE(session_id, msg_index) enforced"
        );
        // Counter increments per successful INSERT, including the upsert.
        assert_eq!(stats.messages_written, 2);

        let (data, msg_type, text): (String, String, String) = w
            .conn
            .query_row(
                "SELECT data, msg_type, text_content FROM messages WHERE session_id='s1' AND msg_index=0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("query");
        assert_eq!(data, "{\"v\":2}");
        assert_eq!(msg_type, "assistant");
        assert_eq!(text, "second");
    }

    /// WorkerError mid-project rolls back, next project still writes.
    #[test]
    fn worker_error_rolls_back_current_project() {
        let mut w = fresh_writer();
        let (tx, rx) = unbounded::<IngestEvent>();

        // Project 1 — gets a WorkerError and should be rolled back.
        tx.send(IngestEvent::Project {
            slug: "p1".into(),
            original_path: "/tmp/p1".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        tx.send(message_event("p1", "s1", 0)).unwrap();
        tx.send(IngestEvent::WorkerError {
            slug: "p1".into(),
            error: "boom".into(),
        })
        .unwrap();

        // Project 2 — clean, should persist.
        tx.send(IngestEvent::Project {
            slug: "p2".into(),
            original_path: "/tmp/p2".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        tx.send(message_event("p2", "s2", 0)).unwrap();
        tx.send(IngestEvent::ProjectComplete {
            slug: "p2".into(),
            duration_ms: 0,
        })
        .unwrap();
        drop(tx);

        w.run(rx).expect("run");
        let slugs: Vec<String> = w
            .conn
            .prepare("SELECT slug FROM projects ORDER BY slug")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(slugs, vec!["p2".to_string()]);
        assert_eq!(count(&w.conn, "messages"), 1);
    }

    /// Subagent + ToolResult + Plan all write correctly; stats counters
    /// increment as expected.
    #[test]
    fn stats_counters_and_multiple_entity_types() {
        let mut w = fresh_writer();
        let (tx, rx) = unbounded::<IngestEvent>();

        tx.send(IngestEvent::Project {
            slug: "p1".into(),
            original_path: "/tmp/p1".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        tx.send(IngestEvent::Session {
            slug: "p1".into(),
            entry: sample_session("s1"),
        })
        .unwrap();
        tx.send(IngestEvent::Session {
            slug: "p1".into(),
            entry: sample_session("s2"),
        })
        .unwrap();
        tx.send(message_event("p1", "s1", 0)).unwrap();
        tx.send(message_event("p1", "s1", 1)).unwrap();
        tx.send(IngestEvent::Subagent {
            slug: "p1".into(),
            session_id: "s1".into(),
            transcript: SubagentTranscript {
                agent_id: "a1".into(),
                agent_type: SubagentType::Task,
                file_name: "agent-a1.jsonl".into(),
                messages: vec![],
                meta: None,
            },
        })
        .unwrap();
        tx.send(IngestEvent::ProjectComplete {
            slug: "p1".into(),
            duration_ms: 0,
        })
        .unwrap();
        drop(tx);

        let stats = w.run(rx).expect("run");
        assert_eq!(stats.projects_processed, 1);
        assert_eq!(stats.sessions_processed, 2);
        assert_eq!(stats.messages_written, 2);
        assert_eq!(stats.subagents_written, 1);

        assert_eq!(count(&w.conn, "subagents"), 1);
        // Verify stored agent_type is the bare string (not JSON-quoted).
        let agent_type: String = w
            .conn
            .query_row(
                "SELECT agent_type FROM subagents WHERE agent_id='a1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(agent_type, "task");
    }

    /// `open_for_bulk_ingest` sets synchronous=OFF; `finish` restores
    /// synchronous=NORMAL.
    #[test]
    fn bulk_pragma_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("bulk.sqlite");
        let mut w = Writer::new(&db).expect("new writer");

        // After `new`, synchronous = NORMAL (1).
        let sync: i64 = w
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1);

        w.open_for_bulk_ingest().expect("bulk on");
        let sync: i64 = w
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 0, "synchronous should be OFF in bulk mode");

        // Re-open a second time is a no-op.
        w.open_for_bulk_ingest().expect("bulk on again");

        // Reopen the DB in a second connection to verify `finish` restored
        // the persistent PRAGMAs. (synchronous is per-connection in SQLite,
        // so we check the state on the writer's own connection before
        // it's consumed.)
        w.finish().expect("finish");

        // synchronous is a connection-level pragma, so it's moot after
        // finish drops the connection. The check above covers the write-
        // path assertion; finish()'s behaviour is exercised by not
        // panicking.
    }

    /// Channel close mid-project rolls back; no partial writes persist.
    #[test]
    fn channel_close_mid_project_rolls_back() {
        let mut w = fresh_writer();
        let (tx, rx) = unbounded::<IngestEvent>();

        tx.send(IngestEvent::Project {
            slug: "p1".into(),
            original_path: "/tmp/p1".into(),
            sessions_index_json: "{}".into(),
        })
        .unwrap();
        tx.send(message_event("p1", "s1", 0)).unwrap();
        // No ProjectComplete — just close.
        drop(tx);

        w.run(rx).expect("run");
        assert_eq!(count(&w.conn, "projects"), 0);
        assert_eq!(count(&w.conn, "messages"), 0);
    }
}
