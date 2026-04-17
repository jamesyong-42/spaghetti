//! Top-level ingest orchestrator — NAPI `ingest()` entry point.
//!
//! # Role
//!
//! Glues together the pieces built in commits 1.1–1.6 into a single sync
//! function that runs a full cold-start ingest end-to-end, and exposes it
//! to Node via an `AsyncTask` so callers await a `Promise<IngestStats>`.
//!
//! # Pipeline
//!
//! ```text
//!   scan <claude_dir>/projects/*   (main thread)
//!             │
//!             ▼
//!   for each slug: ProjectParser::parse_project(…, &sender)
//!             │
//!             │   crossbeam_channel<IngestEvent>
//!             ▼
//!   Writer::run drains channel (writer thread)
//!             │
//!             ▼
//!   Drop sender → writer sees disconnect → returns WriterStats
//!             │
//!             ▼
//!   IngestStats (main thread)
//! ```
//!
//! Commit 1.7 is single-threaded on the parser side — projects are parsed
//! sequentially. Phase 2 parallelises that with rayon.
//!
//! Warm-start (mode: 'warm') is a Phase 3 concern and is intentionally
//! not implemented here; requesting `mode: "warm"` returns an error.
//!
//! Populated in RFC 003 commit 1.7.

use std::path::{Path, PathBuf};
use std::time::Instant;

use crossbeam_channel::bounded;
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Status, Task};
use napi_derive::napi;

use crate::parse_sink::IngestEvent;
use crate::project_parser::ProjectParser;
use crate::writer::{Writer, WriterStats};

// ═══════════════════════════════════════════════════════════════════════════
// NAPI-exposed types
// ═══════════════════════════════════════════════════════════════════════════

/// Options for [`ingest`].
///
/// Mirrors the RFC 003 `IngestOptions` TypeScript shape. Fields that RFC
/// marks optional are `Option<T>` here and get defaulted in
/// [`IngestOptions::resolved`].
#[napi(object)]
#[derive(Debug, Clone)]
pub struct IngestOptions {
    pub claude_dir: String,
    pub db_path: String,
    /// `"cold"` is the only value supported in Phase 1. `"warm"` lands in
    /// Phase 3 and currently errors.
    pub mode: String,
    pub progress_interval_ms: Option<u32>,
    pub parallelism: Option<u32>,
}

/// Stats returned on successful ingest.
///
/// Mirrors the RFC 003 `IngestStats` shape. Errors accumulated during
/// ingest (e.g. bad JSONL lines) are returned in `errors`; fatal errors
/// reject the promise instead.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct IngestStats {
    pub duration_ms: u32,
    pub projects_processed: u32,
    pub sessions_processed: u32,
    pub messages_written: u32,
    pub subagents_written: u32,
    /// Non-fatal errors collected during ingest — parse failures, missing
    /// session files, etc.
    pub errors: Vec<IngestError>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct IngestError {
    pub slug: String,
    pub message: String,
}

// ═══════════════════════════════════════════════════════════════════════════
// NAPI entry point
// ═══════════════════════════════════════════════════════════════════════════

/// Run a full ingest of `claude_dir`, writing into the SQLite file at
/// `db_path`. Returns a Promise that resolves to [`IngestStats`] or
/// rejects with a fatal error.
///
/// Only `mode: "cold"` is implemented in Phase 1.
#[napi(ts_return_type = "Promise<IngestStats>")]
pub fn ingest(opts: IngestOptions) -> AsyncTask<IngestTask> {
    AsyncTask::new(IngestTask { opts })
}

/// Libuv worker-thread task that runs [`run_ingest`] off the JS thread.
pub struct IngestTask {
    opts: IngestOptions,
}

impl Task for IngestTask {
    type Output = IngestStats;
    type JsValue = IngestStats;

    fn compute(&mut self) -> Result<Self::Output> {
        run_ingest(&self.opts).map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Orchestration (no NAPI types below)
// ═══════════════════════════════════════════════════════════════════════════

/// Channel capacity between parser(s) and writer. Large enough to absorb
/// a few parser bursts without blocking; small enough to bound memory.
const EVENT_CHANNEL_CAPACITY: usize = 4_096;

/// Fatal ingest errors — these reject the NAPI promise. Non-fatal
/// per-project errors are reported via `IngestStats.errors`.
#[derive(Debug, thiserror::Error)]
pub enum IngestInternalError {
    #[error("unsupported ingest mode: {0}; only 'cold' is implemented")]
    UnsupportedMode(String),

    #[error("claude_dir not found or not a directory: {0}")]
    ClaudeDirMissing(PathBuf),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("writer error: {0}")]
    Writer(#[from] crate::writer::WriterError),

    #[error("writer thread panicked")]
    WriterPanic,
}

/// Resolve the owned / defaulted version of `IngestOptions` for internal use.
struct ResolvedOptions {
    claude_dir: PathBuf,
    db_path: PathBuf,
}

impl ResolvedOptions {
    fn from(opts: &IngestOptions) -> std::result::Result<Self, IngestInternalError> {
        if opts.mode != "cold" {
            return Err(IngestInternalError::UnsupportedMode(opts.mode.clone()));
        }
        let claude_dir = PathBuf::from(&opts.claude_dir);
        if !claude_dir.is_dir() {
            return Err(IngestInternalError::ClaudeDirMissing(claude_dir));
        }
        Ok(Self {
            claude_dir,
            db_path: PathBuf::from(&opts.db_path),
        })
    }
}

/// Run a full cold ingest synchronously. Visible to integration tests.
pub(crate) fn run_ingest(
    opts: &IngestOptions,
) -> std::result::Result<IngestStats, IngestInternalError> {
    let start = Instant::now();
    let resolved = ResolvedOptions::from(opts)?;

    let slugs = scan_project_slugs(&resolved.claude_dir)?;

    // Writer gets its own thread so parser work can overlap with SQLite
    // writes. Channel is bounded so a fast parser can't exhaust memory.
    let (sender, receiver) = bounded::<IngestEvent>(EVENT_CHANNEL_CAPACITY);
    let db_path = resolved.db_path.clone();

    let writer_handle = std::thread::Builder::new()
        .name("spaghetti-writer".into())
        .spawn(
            move || -> std::result::Result<WriterStats, crate::writer::WriterError> {
                let mut writer = Writer::new(&db_path)?;
                writer.open_for_bulk_ingest()?;
                let stats = writer.run(receiver)?;
                writer.finish()?;
                Ok(stats)
            },
        )
        .map_err(IngestInternalError::Io)?;

    // Parse each project sequentially (Phase 2 parallelises with rayon).
    // Parser errors below the project-boundary level are already emitted
    // as IngestEvent::WorkerError inside the parser, so here we only
    // surface unrecoverable channel-closed errors.
    let parser = ProjectParser::new();
    let mut errors: Vec<IngestError> = Vec::new();
    for slug in &slugs {
        if let Err(e) = parser.parse_project(&resolved.claude_dir, slug, &sender) {
            errors.push(IngestError {
                slug: slug.clone(),
                message: e.to_string(),
            });
            // Channel closed means the writer has died; no point continuing.
            break;
        }
    }
    drop(sender);

    let writer_stats: WriterStats = writer_handle
        .join()
        .map_err(|_| IngestInternalError::WriterPanic)??;

    let duration_ms = u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX);

    Ok(IngestStats {
        duration_ms,
        projects_processed: writer_stats.projects_processed,
        sessions_processed: writer_stats.sessions_processed,
        messages_written: writer_stats.messages_written,
        subagents_written: writer_stats.subagents_written,
        errors,
    })
}

/// List immediate subdirectories of `<claude_dir>/projects/`. Each dir
/// name is a project slug. Non-directory entries (e.g. `.DS_Store`) are
/// skipped silently.
fn scan_project_slugs(claude_dir: &Path) -> std::result::Result<Vec<String>, std::io::Error> {
    let projects_dir = claude_dir.join("projects");
    if !projects_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut slugs: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&projects_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            slugs.push(name.to_owned());
        }
    }
    slugs.sort();
    Ok(slugs)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use tempfile::TempDir;

    /// Build a minimal fake `~/.claude` with one project, one session, and
    /// two messages. Returns the root tempdir (keep alive for the test).
    fn fake_claude_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let slug = "-Users-me-proj";
        let project_dir = dir.path().join("projects").join(slug);
        fs::create_dir_all(&project_dir).unwrap();

        // sessions.json with one entry
        let session_id = "11111111-2222-3333-4444-555555555555";
        let sessions_index = format!(
            r#"{{
              "originalPath": "/Users/me/proj",
              "entries": [{{
                "sessionId": "{session_id}",
                "fullPath": "{}",
                "fileMtime": 0.0,
                "firstPrompt": "hi",
                "summary": "",
                "messageCount": 2,
                "created": "2026-04-17T00:00:00Z",
                "modified": "2026-04-17T00:00:01Z",
                "gitBranch": "main",
                "projectPath": "/Users/me/proj",
                "isSidechain": false
              }}]
            }}"#,
            project_dir.join(format!("{session_id}.jsonl")).display()
        );
        fs::write(project_dir.join("sessions-index.json"), sessions_index).unwrap();

        // Session JSONL with two user messages.
        let jsonl = r#"{"type":"user","uuid":"u1","timestamp":"2026-04-17T00:00:00Z","sessionId":"11111111-2222-3333-4444-555555555555","isSidechain":false,"userType":"external","cwd":"/","version":"1","gitBranch":"main","message":{"role":"user","content":"hello"}}
{"type":"user","uuid":"u2","timestamp":"2026-04-17T00:00:01Z","sessionId":"11111111-2222-3333-4444-555555555555","isSidechain":false,"userType":"external","cwd":"/","version":"1","gitBranch":"main","message":{"role":"user","content":"world"}}
"#;
        fs::write(project_dir.join(format!("{session_id}.jsonl")), jsonl).unwrap();

        dir
    }

    #[test]
    fn rejects_unsupported_warm_mode() {
        let opts = IngestOptions {
            claude_dir: "/tmp".into(),
            db_path: "/tmp/out.db".into(),
            mode: "warm".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let err = run_ingest(&opts).expect_err("warm mode must be rejected");
        assert!(matches!(err, IngestInternalError::UnsupportedMode(_)));
    }

    #[test]
    fn rejects_missing_claude_dir() {
        let opts = IngestOptions {
            claude_dir: "/definitely/not/here".into(),
            db_path: "/tmp/out.db".into(),
            mode: "cold".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let err = run_ingest(&opts).expect_err("missing dir must error");
        assert!(matches!(err, IngestInternalError::ClaudeDirMissing(_)));
    }

    #[test]
    fn empty_claude_dir_produces_empty_stats() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("spaghetti.db");
        let opts = IngestOptions {
            claude_dir: tmp.path().to_string_lossy().into(),
            db_path: db.to_string_lossy().into(),
            mode: "cold".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let stats = run_ingest(&opts).unwrap();
        assert_eq!(stats.projects_processed, 0);
        assert_eq!(stats.sessions_processed, 0);
        assert_eq!(stats.messages_written, 0);
        assert!(stats.errors.is_empty());
    }

    #[test]
    fn end_to_end_ingest_writes_rows_and_fts() {
        let claude = fake_claude_dir();
        let db_dir = TempDir::new().unwrap();
        let db = db_dir.path().join("spaghetti.db");

        let opts = IngestOptions {
            claude_dir: claude.path().to_string_lossy().into(),
            db_path: db.to_string_lossy().into(),
            mode: "cold".into(),
            progress_interval_ms: None,
            parallelism: None,
        };

        let stats = run_ingest(&opts).expect("ingest should succeed");
        assert_eq!(stats.projects_processed, 1);
        assert_eq!(stats.sessions_processed, 1);
        assert_eq!(stats.messages_written, 2);
        assert!(stats.errors.is_empty());

        // Independent read-only connection verifies persistence.
        let conn = Connection::open(&db).unwrap();
        let project_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        let message_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project_count, 1);
        assert_eq!(session_count, 1);
        assert_eq!(message_count, 2);
        assert_eq!(fts_count, 2, "FTS triggers should have synced the messages");
    }
}
