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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use crossbeam_channel::{bounded, unbounded};
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Status, Task};
use napi_derive::napi;
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags};

use crate::fingerprint::{self, FingerprintStore, SourceFingerprint};
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

/// Channel capacity per parser worker. The total channel size is this
/// multiplied by `parallelism`, so a fleet of 8 parsers gets 32k slots.
/// Each slot is one `IngestEvent` (≈ 1KB for a Message variant), so the
/// memory ceiling scales with parallelism up to ~32MB — well inside the
/// desktop-app envelope.
const CHANNEL_CAPACITY_PER_WORKER: usize = 4_096;

/// Ceiling on parsing parallelism. Beyond this, contention on the single
/// SQLite writer makes additional parsers wait on `sender.send` rather
/// than doing useful CPU work.
const MAX_PARALLELISM: usize = 8;

/// Resolve the effective parser-thread count.
///
/// - `None` or `Some(0)` → `min(available_parallelism, MAX_PARALLELISM)`.
/// - `Some(n)` → clamp to `[1, MAX_PARALLELISM]`.
fn resolve_parallelism(requested: Option<u32>) -> usize {
    let default = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(MAX_PARALLELISM);
    match requested {
        None | Some(0) => default,
        Some(n) => (n as usize).clamp(1, MAX_PARALLELISM),
    }
}

/// Fatal ingest errors — these reject the NAPI promise. Non-fatal
/// per-project errors are reported via `IngestStats.errors`.
#[derive(Debug, thiserror::Error)]
pub enum IngestInternalError {
    #[error("unsupported ingest mode: {0}; expected 'cold' or 'warm'")]
    UnsupportedMode(String),

    #[error("claude_dir not found or not a directory: {0}")]
    ClaudeDirMissing(PathBuf),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("writer error: {0}")]
    Writer(#[from] crate::writer::WriterError),

    #[error("fingerprint error: {0}")]
    Fingerprint(#[from] crate::fingerprint::FingerprintError),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("writer thread panicked")]
    WriterPanic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Cold,
    Warm,
}

/// Resolve the owned / defaulted version of `IngestOptions` for internal use.
struct ResolvedOptions {
    claude_dir: PathBuf,
    db_path: PathBuf,
    mode: Mode,
}

impl ResolvedOptions {
    fn from(opts: &IngestOptions) -> std::result::Result<Self, IngestInternalError> {
        let mode = match opts.mode.as_str() {
            "cold" => Mode::Cold,
            "warm" => Mode::Warm,
            other => return Err(IngestInternalError::UnsupportedMode(other.to_string())),
        };
        let claude_dir = PathBuf::from(&opts.claude_dir);
        if !claude_dir.is_dir() {
            return Err(IngestInternalError::ClaudeDirMissing(claude_dir));
        }
        Ok(Self {
            claude_dir,
            db_path: PathBuf::from(&opts.db_path),
            mode,
        })
    }
}

/// Run an ingest synchronously. Visible to integration tests.
///
/// On `Mode::Warm`: stat-checks the claude dir against the stored
/// fingerprints first. If nothing changed, returns empty stats
/// immediately (this is the common case — opening the app with a fresh
/// ~/.claude). If anything changed, falls through to a full re-ingest
/// (cold path). Future work (Phase 2 perf) may incrementalise the
/// N-changes case to touch only affected projects.
pub(crate) fn run_ingest(
    opts: &IngestOptions,
) -> std::result::Result<IngestStats, IngestInternalError> {
    let start = Instant::now();
    let resolved = ResolvedOptions::from(opts)?;

    // Warm-start fast path: nothing changed since last ingest → return.
    if resolved.mode == Mode::Warm && warm_has_no_changes(&resolved)? {
        return Ok(IngestStats {
            duration_ms: u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX),
            ..IngestStats::default()
        });
    }

    let slugs = scan_project_slugs(&resolved.claude_dir)?;
    let parallelism = resolve_parallelism(opts.parallelism);

    // Channel scales with parallelism so parsers don't constantly block
    // on a saturated buffer. The writer is still single-threaded (SQLite
    // single-writer constraint), so beyond ~8 parsers the buffer mostly
    // queues work rather than unlocking additional throughput.
    let capacity = CHANNEL_CAPACITY_PER_WORKER.saturating_mul(parallelism);
    let (sender, receiver) = bounded::<IngestEvent>(capacity);
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

    // Parse projects in parallel via a dedicated rayon pool. Using a
    // local pool (not the global one) means we control the thread count
    // precisely and don't contend with whatever else might be using the
    // global rayon pool (e.g. later rayon-using code in the same crate).
    //
    // Parser errors below the project-boundary level are already emitted
    // as IngestEvent::WorkerError inside parse_project; here we only
    // collect ChannelClosed / other unrecoverable failures. `filter_map`
    // lets every parser finish its own project before we reduce to a
    // Vec<IngestError>.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(parallelism)
        .thread_name(|i| format!("spaghetti-parser-{i}"))
        .build()
        .map_err(|e| {
            IngestInternalError::Io(std::io::Error::other(format!(
                "failed to build rayon pool: {e}"
            )))
        })?;

    // Serialize per-project event streams onto the shared channel so the
    // writer sees each project's events contiguously. Without this, events
    // from N parallel parsers interleave, forcing the writer to commit+
    // re-open the per-project transaction on every slug switch — which
    // both inflates the `projects_processed` counter and triggers one
    // fsync per slug flip instead of one per project.
    //
    // Each parser builds its full event stream in a local unbounded
    // channel (memory cost is bounded by project size, typically a few
    // MB), then drains it into the shared channel while holding a mutex.
    // The drain is fast — just a tight loop of enum moves — so the lock
    // is held only briefly.
    let drain_lock: Mutex<()> = Mutex::new(());
    let errors: Vec<IngestError> = pool.install(|| {
        slugs
            .par_iter()
            .filter_map(|slug| {
                let parser = ProjectParser::new();
                let (local_tx, local_rx) = unbounded::<IngestEvent>();
                let parse_result = parser.parse_project(&resolved.claude_dir, slug, &local_tx);
                drop(local_tx);

                // Drain local → shared. Holding the drain_lock keeps this
                // project's events contiguous on the shared channel. If the
                // shared sender is disconnected (writer died), we abandon
                // remaining events rather than error — the orchestrator
                // reports the parse error regardless.
                let _guard = drain_lock.lock().expect("drain_lock poisoned");
                for ev in local_rx.iter() {
                    if sender.send(ev).is_err() {
                        break;
                    }
                }
                drop(_guard);

                parse_result.err().map(|e| IngestError {
                    slug: slug.clone(),
                    message: e.to_string(),
                })
            })
            .collect()
    });

    // Emit fingerprints for every tracked file we saw. The writer clears
    // source_files first so stale fingerprints from prior runs (for files
    // that no longer exist) don't linger. `compute_diff` with an empty
    // store returns every discovered file in `added`, which is exactly
    // the set we need to fingerprint.
    let empty_store: HashMap<String, SourceFingerprint> = HashMap::new();
    let diff = fingerprint::compute_diff(&resolved.claude_dir, &empty_store)?;
    let _ = sender.send(IngestEvent::ClearSourceFiles);
    for discovered in diff.added {
        let ev = IngestEvent::Fingerprint {
            path: discovered.path,
            mtime_ms: discovered.mtime_ms,
            size: discovered.size,
            byte_position: None,
            category: discovered.category,
            project_slug: discovered.project_slug,
            session_id: discovered.session_id,
        };
        if sender.send(ev).is_err() {
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

/// Warm-start pre-check: read the stored `source_files` fingerprints
/// and diff them against the current filesystem state. Returns `true`
/// iff nothing changed (no added, no modified, no deleted files).
///
/// Opens a short-lived read-only connection so this runs on the calling
/// thread without conflicting with the writer thread (which hasn't
/// started yet). If the DB file doesn't exist or can't be opened, treat
/// as "has changes" so the caller falls through to a full cold ingest.
fn warm_has_no_changes(
    resolved: &ResolvedOptions,
) -> std::result::Result<bool, IngestInternalError> {
    if !resolved.db_path.exists() {
        return Ok(false);
    }

    let conn = Connection::open_with_flags(
        &resolved.db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let store = FingerprintStore::new(&conn);
    let stored = match store.load_all() {
        Ok(s) if s.is_empty() => return Ok(false), // nothing persisted yet
        Ok(s) => s,
        Err(_) => return Ok(false), // treat any read failure as "has changes"
    };

    let diff = fingerprint::compute_diff(&resolved.claude_dir, &stored)?;
    Ok(diff.added.is_empty() && diff.modified.is_empty() && diff.deleted.is_empty())
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
    fn rejects_unsupported_mode() {
        let opts = IngestOptions {
            claude_dir: "/tmp".into(),
            db_path: "/tmp/out.db".into(),
            mode: "incremental".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let err = run_ingest(&opts).expect_err("unknown mode must be rejected");
        assert!(matches!(err, IngestInternalError::UnsupportedMode(_)));
    }

    #[test]
    fn warm_mode_with_no_existing_db_falls_through_to_full_ingest() {
        let claude = fake_claude_dir();
        let db_dir = TempDir::new().unwrap();
        let db = db_dir.path().join("spaghetti.db");

        let opts = IngestOptions {
            claude_dir: claude.path().to_string_lossy().into(),
            db_path: db.to_string_lossy().into(),
            mode: "warm".into(),
            progress_interval_ms: None,
            parallelism: None,
        };

        // DB doesn't exist yet — warm mode should fall through to a cold
        // ingest rather than error.
        let stats = run_ingest(&opts).expect("warm ingest against fresh DB should succeed");
        assert_eq!(stats.projects_processed, 1);
        assert_eq!(stats.messages_written, 2);
    }

    #[test]
    fn warm_mode_repeat_with_no_changes_is_a_noop() {
        let claude = fake_claude_dir();
        let db_dir = TempDir::new().unwrap();
        let db = db_dir.path().join("spaghetti.db");

        // First pass — populate the DB and source_files fingerprints.
        let first_opts = IngestOptions {
            claude_dir: claude.path().to_string_lossy().into(),
            db_path: db.to_string_lossy().into(),
            mode: "cold".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let first = run_ingest(&first_opts).expect("cold ingest should succeed");
        assert_eq!(first.messages_written, 2);

        // Second pass — warm, fixture unchanged. Fast path should fire:
        // zero work reported in stats.
        let warm_opts = IngestOptions {
            claude_dir: claude.path().to_string_lossy().into(),
            db_path: db.to_string_lossy().into(),
            mode: "warm".into(),
            progress_interval_ms: None,
            parallelism: None,
        };
        let second = run_ingest(&warm_opts).expect("warm ingest should succeed");
        assert_eq!(second.projects_processed, 0);
        assert_eq!(second.sessions_processed, 0);
        assert_eq!(second.messages_written, 0);
        assert!(second.errors.is_empty());
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
