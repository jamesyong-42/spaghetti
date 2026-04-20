//! `live_ingest_batch` — NAPI entrypoint for RFC 005 Phase 4.
//!
//! # Role
//!
//! This is the Rust side of the live-ingest path. When the SDK is
//! constructed with `engine: 'rs'` and a live update arrives, the
//! TS-side `IngestService.writeBatch` serialises each `ParsedRow`
//! to a [`LiveRow`] and calls [`live_ingest_batch`] here.
//!
//! We open a `rusqlite::Connection` against the cold-start DB file
//! (applying the same pragmas + schema initialization so we behave
//! identically to the cold-start writer), convert each [`LiveRow`]
//! into the matching [`IngestEvent`] variant, and call the shared
//! [`write_batch_with_tx`] (extracted in C4.1).
//!
//! # Category → event mapping
//!
//! | `category`        | `IngestEvent` variant   | `payload_json` is…              |
//! |-------------------|-------------------------|----------------------------------|
//! | `message`         | `Message`               | `LiveMessagePayload`             |
//! | `subagent`        | `Subagent`              | `SubagentTranscript`             |
//! | `tool_result`     | `ToolResult`            | `PersistedToolResult`            |
//! | `file_history`    | `FileHistory`           | `FileHistorySession`             |
//! | `todo`            | `Todo`                  | `TodoFile`                       |
//! | `task`            | `Task`                  | `TaskEntry`                      |
//! | `plan`            | `Plan`                  | `PlanFile`                       |
//! | `project_memory`  | `ProjectMemory`         | `{ content: String }`            |
//! | `session_index`   | `Project`               | `LiveSessionIndexPayload`        |
//!
//! The `message` category needs a few extra TS-side projections
//! (pre-extracted `msg_type` / `uuid` / `fts_text` / token counters) so
//! the write is a pure bind; those ride on [`LiveMessagePayload`].
//!
//! # Transaction semantics
//!
//! One `BEGIN IMMEDIATE` / `COMMIT` per batch, via
//! [`write_batch_with_tx`]. Any single-row conversion failure (bad
//! JSON, unknown category) surfaces as `napi::Error::from_reason(...)`
//! — the whole batch is rolled back and the TS side falls back to its
//! own writer for this batch (see C4.3).
//!
//! Empty input short-circuits before we even open a connection; there's
//! no reason to acquire the write lock to do nothing.

use napi::bindgen_prelude::{Error, Result, Status};
use napi_derive::napi;
use rusqlite::Connection;
use std::time::Instant;

use crate::parse_sink::IngestEvent;
use crate::schema;
use crate::types::{
    FileHistorySession, PersistedToolResult, PlanFile, SessionsIndex, SubagentTranscript,
    TaskEntry, TodoFile,
};
use crate::writer::{write_batch_with_tx, WriteBatchStats, WriterError};

// ═══════════════════════════════════════════════════════════════════════════
// Internal error type
// ═══════════════════════════════════════════════════════════════════════════

/// Errors produced by the internal [`live_ingest_batch_inner`] function.
/// Converted into `napi::Error` at the NAPI boundary so the JS side can
/// catch + fall back to the TS path.
#[derive(Debug, thiserror::Error)]
pub enum LiveIngestError {
    #[error("unknown LiveRow category: {0}")]
    UnknownCategory(String),

    #[error("category '{category}' requires {field}")]
    MissingField {
        category: String,
        field: &'static str,
    },

    #[error("failed to deserialize '{category}' payload: {source}")]
    PayloadDeserialize {
        category: String,
        source: serde_json::Error,
    },

    #[error("session_index re-serialize failed: {0}")]
    SessionIndexSerialize(#[source] serde_json::Error),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("writer error: {0}")]
    Writer(#[from] WriterError),
}

// ═══════════════════════════════════════════════════════════════════════════
// NAPI-exposed types
// ═══════════════════════════════════════════════════════════════════════════

/// One row the TS live-update writer wants persisted.
///
/// `payload_json` is a JSON-encoded payload whose shape depends on
/// `category`; see the module-level table for the mapping.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct LiveRow {
    /// One of: `message` | `subagent` | `tool_result` | `file_history` |
    /// `todo` | `task` | `plan` | `project_memory` | `session_index`.
    pub category: String,
    /// Project slug, when the row is project-scoped. Absent for
    /// session-only rows (file_history / todo / task).
    pub slug: Option<String>,
    /// Session UUID, when the row is session-scoped. Absent for
    /// project-only rows (plan / project_memory / session_index).
    pub session_id: Option<String>,
    /// JSON-encoded payload. The Rust side deserialises per `category`.
    pub payload_json: String,
}

/// Identifier of a row the batch successfully wrote. The TS side
/// uses this to reconstruct the matching `Change` event on the
/// live-updates subscriber path.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct LiveRowId {
    pub category: String,
    pub slug: Option<String>,
    pub session_id: Option<String>,
    /// Unique key for the row within its category. For `message` this
    /// is the message uuid; for `tool_result` the tool_use_id; for
    /// `subagent` the agent_id; for `file_history` the session id;
    /// for `todo` the agent_id; for `task` the session id; for `plan`
    /// the plan slug; for `project_memory` / `session_index` the
    /// project slug.
    pub row_key: String,
}

/// Result of one `live_ingest_batch` call.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct LiveBatchResult {
    /// One `LiveRowId` per input row, in input order. Empty on empty input.
    pub written_rows: Vec<LiveRowId>,
    /// Wall-clock duration of the whole call (ms).
    pub duration_ms: u32,
}

// ═══════════════════════════════════════════════════════════════════════════
// Payload shapes (internal, not NAPI)
// ═══════════════════════════════════════════════════════════════════════════

/// `payload_json` shape for `category == "message"`.
///
/// Mirrors the fields `IngestService.onMessage` and the TS writer
/// extract inline from a `SessionMessage`. Pre-extracting on the TS
/// side keeps the Rust path from having to serde the full
/// SessionMessage variant-by-variant — we just bind columns.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveMessagePayload {
    msg_index: u32,
    byte_offset: u64,
    /// The raw JSONL line bytes. Stored verbatim in `messages.data`.
    raw_json: String,
    msg_type: String,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    fts_text: Option<String>,
}

/// `payload_json` shape for `category == "project_memory"`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveProjectMemoryPayload {
    content: String,
}

/// `payload_json` shape for `category == "session_index"`.
///
/// Maps onto `IngestEvent::Project` (the cold-start "project" event
/// already carries the `sessions_index_json` payload — the live path
/// uses the exact same row write).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveSessionIndexPayload {
    original_path: String,
    /// The sessions-index as a structured value. We re-serialize it
    /// inside `live_ingest_batch` so `IngestEvent::Project.sessions_index_json`
    /// carries the stringified form the cold-start path expects.
    sessions_index: SessionsIndex,
}

// ═══════════════════════════════════════════════════════════════════════════
// NAPI entry point
// ═══════════════════════════════════════════════════════════════════════════

/// Write a batch of live-update rows to the SQLite DB at `db_path`.
///
/// Thin NAPI wrapper that delegates to [`live_ingest_batch_inner`] and
/// marshals the error back across the boundary. Keeping the logic in
/// an internal function means `cargo test` can exercise it without
/// linking against Node runtime symbols (`napi_delete_reference` et al.).
#[napi]
pub fn live_ingest_batch(db_path: String, rows: Vec<LiveRow>) -> Result<LiveBatchResult> {
    live_ingest_batch_inner(&db_path, rows).map_err(to_napi_err)
}

/// Non-NAPI core of [`live_ingest_batch`] — plain Rust `Result` so
/// unit tests can call it directly. See that function's doc for the
/// behavioural contract.
pub fn live_ingest_batch_inner(
    db_path: &str,
    rows: Vec<LiveRow>,
) -> std::result::Result<LiveBatchResult, LiveIngestError> {
    // Short-circuit on empty input — don't open the DB for nothing.
    if rows.is_empty() {
        return Ok(LiveBatchResult {
            written_rows: vec![],
            duration_ms: 0,
        });
    }

    let started = Instant::now();

    let conn = Connection::open(db_path)?;
    schema::set_pragmas(&conn).map_err(|e| LiveIngestError::Writer(WriterError::from(e)))?;
    schema::initialize_schema(&conn).map_err(|e| LiveIngestError::Writer(WriterError::from(e)))?;

    // Convert rows → events. Build the row-id list in lockstep so the
    // caller gets identifiers in the same order as input. If any row
    // fails to parse, we surface the error and never open the write
    // transaction — the TS side falls back to the TS writer for this
    // batch (C4.3).
    let mut events: Vec<IngestEvent> = Vec::with_capacity(rows.len());
    let mut row_ids: Vec<LiveRowId> = Vec::with_capacity(rows.len());

    for row in rows {
        let (event, row_key) = row_to_event(&row)?;
        events.push(event);
        row_ids.push(LiveRowId {
            category: row.category,
            slug: row.slug,
            session_id: row.session_id,
            row_key,
        });
    }

    // Actual write — shared with cold-start ingest via the C4.1 helper.
    let _stats: WriteBatchStats = write_batch_with_tx(&conn, &events)?;

    let duration_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);

    Ok(LiveBatchResult {
        written_rows: row_ids,
        duration_ms,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Row → Event conversion
// ═══════════════════════════════════════════════════════════════════════════

/// Convert one [`LiveRow`] into the matching [`IngestEvent`] variant,
/// plus the `row_key` to report back to the caller.
///
/// Parse failures, unknown categories, and missing-required-field
/// failures all surface as typed [`LiveIngestError`] variants; the
/// NAPI wrapper stringifies them into an `napi::Error` so the JS side
/// can catch + fall back to the TS writer.
fn row_to_event(row: &LiveRow) -> std::result::Result<(IngestEvent, String), LiveIngestError> {
    match row.category.as_str() {
        "message" => {
            let slug = require_slug(row)?;
            let session_id = require_session_id(row)?;
            let p: LiveMessagePayload = deser_payload(row)?;
            let row_key = p
                .uuid
                .clone()
                .unwrap_or_else(|| format!("{}:{}", session_id, p.msg_index));
            let ev = IngestEvent::Message {
                slug,
                session_id,
                index: p.msg_index,
                byte_offset: p.byte_offset,
                raw_json: p.raw_json,
                msg_type: p.msg_type,
                uuid: p.uuid,
                timestamp: p.timestamp,
                input_tokens: p.input_tokens,
                output_tokens: p.output_tokens,
                cache_creation_tokens: p.cache_creation_tokens,
                cache_read_tokens: p.cache_read_tokens,
                fts_text: p.fts_text,
            };
            Ok((ev, row_key))
        }

        "subagent" => {
            let slug = require_slug(row)?;
            let session_id = require_session_id(row)?;
            let transcript: SubagentTranscript = deser_payload(row)?;
            let row_key = transcript.agent_id.clone();
            Ok((
                IngestEvent::Subagent {
                    slug,
                    session_id,
                    transcript,
                },
                row_key,
            ))
        }

        "tool_result" => {
            let slug = require_slug(row)?;
            let session_id = require_session_id(row)?;
            let tool_result: PersistedToolResult = deser_payload(row)?;
            let row_key = tool_result.tool_use_id.clone();
            Ok((
                IngestEvent::ToolResult {
                    slug,
                    session_id,
                    tool_result,
                },
                row_key,
            ))
        }

        "file_history" => {
            let session_id = require_session_id(row)?;
            let history: FileHistorySession = deser_payload(row)?;
            let row_key = session_id.clone();
            Ok((
                IngestEvent::FileHistory {
                    session_id,
                    history,
                },
                row_key,
            ))
        }

        "todo" => {
            let session_id = require_session_id(row)?;
            let todo: TodoFile = deser_payload(row)?;
            let row_key = todo.agent_id.clone();
            Ok((IngestEvent::Todo { session_id, todo }, row_key))
        }

        "task" => {
            let session_id = require_session_id(row)?;
            let task: TaskEntry = deser_payload(row)?;
            let row_key = session_id.clone();
            Ok((IngestEvent::Task { session_id, task }, row_key))
        }

        "plan" => {
            let slug = require_slug(row)?;
            let plan: PlanFile = deser_payload(row)?;
            let row_key = plan.slug.clone();
            Ok((IngestEvent::Plan { slug, plan }, row_key))
        }

        "project_memory" => {
            let slug = require_slug(row)?;
            let p: LiveProjectMemoryPayload = deser_payload(row)?;
            let row_key = slug.clone();
            Ok((
                IngestEvent::ProjectMemory {
                    slug,
                    content: p.content,
                },
                row_key,
            ))
        }

        "session_index" => {
            let slug = require_slug(row)?;
            let p: LiveSessionIndexPayload = deser_payload(row)?;
            // Re-serialise the sessions_index — the cold-start writer
            // stores the stringified JSON verbatim into
            // `projects.sessions_index`.
            let sessions_index_json = serde_json::to_string(&p.sessions_index)
                .map_err(LiveIngestError::SessionIndexSerialize)?;
            let row_key = slug.clone();
            Ok((
                IngestEvent::Project {
                    slug,
                    original_path: p.original_path,
                    sessions_index_json,
                },
                row_key,
            ))
        }

        other => Err(LiveIngestError::UnknownCategory(other.to_string())),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

fn require_slug(row: &LiveRow) -> std::result::Result<String, LiveIngestError> {
    row.slug
        .clone()
        .ok_or_else(|| LiveIngestError::MissingField {
            category: row.category.clone(),
            field: "slug",
        })
}

fn require_session_id(row: &LiveRow) -> std::result::Result<String, LiveIngestError> {
    row.session_id
        .clone()
        .ok_or_else(|| LiveIngestError::MissingField {
            category: row.category.clone(),
            field: "sessionId",
        })
}

fn deser_payload<T: for<'de> serde::Deserialize<'de>>(
    row: &LiveRow,
) -> std::result::Result<T, LiveIngestError> {
    serde_json::from_str::<T>(&row.payload_json).map_err(|e| LiveIngestError::PayloadDeserialize {
        category: row.category.clone(),
        source: e,
    })
}

fn to_napi_err(e: LiveIngestError) -> Error {
    // Pick a status that makes the error distinguishable from a panic
    // on the JS side. `InvalidArg` for the conversion errors
    // (malformed input), `GenericFailure` for SQL/writer errors.
    let status = match &e {
        LiveIngestError::UnknownCategory(_)
        | LiveIngestError::MissingField { .. }
        | LiveIngestError::PayloadDeserialize { .. }
        | LiveIngestError::SessionIndexSerialize(_) => Status::InvalidArg,
        LiveIngestError::Sqlite(_) | LiveIngestError::Writer(_) => Status::GenericFailure,
    };
    Error::new(status, e.to_string())
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════
//
// Unit tests cover every category variant. They bypass NAPI entirely
// (the function is called with plain Rust types) and use a tempfile
// SQLite DB so we get the same pragmas + schema the NAPI caller would.

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn db_path(tmp: &TempDir) -> String {
        tmp.path()
            .join("live.sqlite")
            .to_string_lossy()
            .into_owned()
    }

    fn count(db_path: &str, table: &str) -> i64 {
        let c = Connection::open(db_path).unwrap();
        c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn empty_batch_short_circuits() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);
        let res = live_ingest_batch_inner(&path, vec![]).unwrap();
        assert_eq!(res.written_rows.len(), 0);
        assert_eq!(res.duration_ms, 0);
        // No DB file created — we never opened a connection.
        assert!(!std::path::Path::new(&path).exists());
    }

    #[test]
    fn message_row_writes_and_updates_fts() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let payload = serde_json::json!({
            "msgIndex": 0,
            "byteOffset": 0,
            "rawJson": r#"{"type":"user","content":"hello"}"#,
            "msgType": "user",
            "uuid": "u-1",
            "timestamp": "2026-04-20T00:00:00Z",
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "ftsText": "hello spaghetti"
        });

        let rows = vec![LiveRow {
            category: "message".into(),
            slug: Some("p1".into()),
            session_id: Some("s1".into()),
            payload_json: payload.to_string(),
        }];

        let res = live_ingest_batch_inner(&path, rows).unwrap();
        assert_eq!(res.written_rows.len(), 1);
        assert_eq!(res.written_rows[0].category, "message");
        assert_eq!(res.written_rows[0].row_key, "u-1");

        assert_eq!(count(&path, "messages"), 1);
        // FTS triggers synced
        assert_eq!(count(&path, "search_fts"), 1);
    }

    #[test]
    fn subagent_tool_result_plan_rows_write() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let subagent_payload = serde_json::json!({
            "agentId": "a-1",
            "agentType": "task",
            "fileName": "agent-a-1.jsonl",
            "messages": [],
            "meta": null
        });
        let tool_result_payload = serde_json::json!({
            "toolUseId": "t-1",
            "content": "out"
        });
        let plan_payload = serde_json::json!({
            "slug": "plan-a",
            "title": "Plan A",
            "content": "# Plan",
            "size": 6
        });

        let rows = vec![
            LiveRow {
                category: "subagent".into(),
                slug: Some("p1".into()),
                session_id: Some("s1".into()),
                payload_json: subagent_payload.to_string(),
            },
            LiveRow {
                category: "tool_result".into(),
                slug: Some("p1".into()),
                session_id: Some("s1".into()),
                payload_json: tool_result_payload.to_string(),
            },
            LiveRow {
                category: "plan".into(),
                slug: Some("p1".into()),
                session_id: None,
                payload_json: plan_payload.to_string(),
            },
        ];

        let res = live_ingest_batch_inner(&path, rows).unwrap();
        assert_eq!(res.written_rows.len(), 3);
        assert_eq!(res.written_rows[0].row_key, "a-1");
        assert_eq!(res.written_rows[1].row_key, "t-1");
        assert_eq!(res.written_rows[2].row_key, "plan-a");

        assert_eq!(count(&path, "subagents"), 1);
        assert_eq!(count(&path, "tool_results"), 1);
        assert_eq!(count(&path, "plans"), 1);
    }

    #[test]
    fn file_history_todo_task_rows_write() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let file_history = serde_json::json!({
            "sessionId": "s1",
            "snapshots": []
        });
        let todo = serde_json::json!({
            "sessionId": "s1",
            "agentId": "a-todo",
            "items": []
        });
        let task = serde_json::json!({
            "taskId": "s1",
            "hasHighwatermark": true,
            "highwatermark": 42,
            "lockExists": false
        });

        let rows = vec![
            LiveRow {
                category: "file_history".into(),
                slug: None,
                session_id: Some("s1".into()),
                payload_json: file_history.to_string(),
            },
            LiveRow {
                category: "todo".into(),
                slug: None,
                session_id: Some("s1".into()),
                payload_json: todo.to_string(),
            },
            LiveRow {
                category: "task".into(),
                slug: None,
                session_id: Some("s1".into()),
                payload_json: task.to_string(),
            },
        ];

        let res = live_ingest_batch_inner(&path, rows).unwrap();
        assert_eq!(res.written_rows.len(), 3);
        assert_eq!(res.written_rows[0].row_key, "s1");
        assert_eq!(res.written_rows[1].row_key, "a-todo");
        assert_eq!(res.written_rows[2].row_key, "s1");

        assert_eq!(count(&path, "file_history"), 1);
        assert_eq!(count(&path, "todos"), 1);
        assert_eq!(count(&path, "tasks"), 1);
    }

    #[test]
    fn project_memory_and_session_index_rows_write() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let memory = serde_json::json!({ "content": "# memory body" });
        let session_index = serde_json::json!({
            "originalPath": "/Users/x/proj",
            "sessionsIndex": {
                "version": 1,
                "originalPath": "/Users/x/proj",
                "entries": []
            }
        });

        let rows = vec![
            LiveRow {
                category: "project_memory".into(),
                slug: Some("p1".into()),
                session_id: None,
                payload_json: memory.to_string(),
            },
            LiveRow {
                category: "session_index".into(),
                slug: Some("p1".into()),
                session_id: None,
                payload_json: session_index.to_string(),
            },
        ];

        let res = live_ingest_batch_inner(&path, rows).unwrap();
        assert_eq!(res.written_rows.len(), 2);
        assert_eq!(res.written_rows[0].row_key, "p1");
        assert_eq!(res.written_rows[1].row_key, "p1");

        assert_eq!(count(&path, "project_memories"), 1);
        assert_eq!(count(&path, "projects"), 1);
    }

    #[test]
    fn unknown_category_errors_and_rolls_back() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let rows = vec![
            LiveRow {
                category: "message".into(),
                slug: Some("p1".into()),
                session_id: Some("s1".into()),
                payload_json: serde_json::json!({
                    "msgIndex": 0,
                    "byteOffset": 0,
                    "rawJson": "{}",
                    "msgType": "user",
                })
                .to_string(),
            },
            // Second row with unknown category — whole batch must fail
            // before any writes land.
            LiveRow {
                category: "mystery".into(),
                slug: Some("p1".into()),
                session_id: Some("s1".into()),
                payload_json: "{}".into(),
            },
        ];

        let err = live_ingest_batch_inner(&path, rows).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("unknown LiveRow category"), "got: {msg}");

        // DB was opened (first row triggered open + pragmas + schema),
        // but the write tx never committed — tables exist, zero rows.
        assert_eq!(count(&path, "messages"), 0);
    }

    #[test]
    fn malformed_payload_errors() {
        let tmp = TempDir::new().unwrap();
        let path = db_path(&tmp);

        let rows = vec![LiveRow {
            category: "message".into(),
            slug: Some("p1".into()),
            session_id: Some("s1".into()),
            // Missing required `msgIndex`/`rawJson`/`msgType` fields.
            payload_json: "{}".into(),
        }];

        let err = live_ingest_batch_inner(&path, rows).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("failed to deserialize"), "got: {msg}");
    }
}
