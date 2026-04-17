//! Per-project streaming parser — ported from
//! `packages/sdk/src/parser/project-parser.ts`.
//!
//! Single-threaded: given one `<claude_dir>/projects/<slug>/` directory,
//! walks every artifact (sessions index, MEMORY.md, JSONL session files,
//! subagent transcripts, tool-result .txt files, todos, tasks, file-history
//! snapshots) and pushes one [`IngestEvent`] per discovered artifact into a
//! [`crossbeam_channel::Sender`].
//!
//! Parse errors inside an individual session or file are swallowed and
//! re-emitted as [`IngestEvent::WorkerError`] — this matches the TS
//! parser's behaviour of wrapping each sub-parse in its own `try/catch`.
//! The only error the caller sees is a channel-send failure, which is
//! fatal (the writer has gone away).
//!
//! Populated in RFC 003 commit 1.4.

use std::path::{Path, PathBuf};
use std::time::Instant;

use crossbeam_channel::{SendError, Sender};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use crate::fts_text;
use crate::jsonl_reader::read_jsonl_streaming;
use crate::parse_sink::IngestEvent;
use crate::types::{
    FileHistorySession, FileHistorySnapshotFile, PersistedToolResult, SessionIndexEntry,
    SessionMessage, SessionsIndex, SubagentTranscript, SubagentType, TaskEntry, TodoFile, TodoItem,
};

// ─── Regex patterns — copied verbatim from project-parser.ts ────────────────

/// Matches canonical session file names `<uuid>.jsonl` — identical to the
/// `UUID_JSONL` regex in `discoverSessionEntries`.
static UUID_JSONL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$")
        .expect("UUID_JSONL regex compiles")
});

/// Matches `agent-<id>.jsonl` where `<id>` starts with `a`. Port of
/// `extractAgentId`'s `^agent-(a.+)\.jsonl$` pattern.
static SUBAGENT_FILE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^agent-(a.+)\.jsonl$").expect("SUBAGENT_FILE regex compiles"));

/// Matches file-history snapshot file names `<hash>@v<version>`. Port of
/// `parseFileHistory`'s `^([0-9a-f]+)@v(\d+)$` pattern.
static FILE_HISTORY_SNAPSHOT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([0-9a-f]+)@v(\d+)$").expect("FILE_HISTORY_SNAPSHOT regex compiles")
});

/// Matches todo file names `<session-id>-agent-<agent-id>.json`. Port of
/// `parseTodos`'s `^(.+?)-agent-(.+)\.json$` pattern.
static TODO_FILE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(.+?)-agent-(.+)\.json$").expect("TODO_FILE regex compiles"));

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// The writer channel was dropped — no point in continuing work.
    ///
    /// The inner error is boxed to keep `ParseError` small (the
    /// `SendError` payload is a full `IngestEvent`, which can be ~250
    /// bytes); clippy's `result_large_err` flags anything over ~128.
    #[error("event channel closed")]
    ChannelClosed(#[source] Box<SendError<IngestEvent>>),
}

impl From<SendError<IngestEvent>> for ParseError {
    fn from(e: SendError<IngestEvent>) -> Self {
        Self::ChannelClosed(Box::new(e))
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Per-project streaming parser. Stateless; one `ProjectParser` can parse
/// any number of projects sequentially (or be cloned cheaply across rayon
/// workers — there's no interior state).
#[derive(Debug, Default, Clone, Copy)]
pub struct ProjectParser;

impl ProjectParser {
    pub fn new() -> Self {
        Self
    }

    /// Parse a single project and push its [`IngestEvent`]s into `events`.
    ///
    /// Errors surfaced by sub-parsers (bad JSON lines, missing files inside
    /// a session) are emitted as [`IngestEvent::WorkerError`] rather than
    /// returned, matching the TS parser's inline `try/catch` behaviour.
    /// The only error returned is a fatal [`ParseError::ChannelClosed`].
    pub fn parse_project(
        &self,
        claude_dir: &Path,
        slug: &str,
        events: &Sender<IngestEvent>,
    ) -> Result<(), ParseError> {
        let start = Instant::now();
        let project_dir = claude_dir.join("projects").join(slug);

        // 1. Read sessions-index.json (or synthesise an empty one on miss)
        let (sessions_index, sessions_index_json) = read_sessions_index(&project_dir);
        let original_path = sessions_index
            .original_path
            .clone()
            .unwrap_or_else(|| slug_to_path_naive(slug));

        // 2. Emit the Project event
        events.send(IngestEvent::Project {
            slug: slug.to_owned(),
            original_path,
            sessions_index_json,
        })?;

        // 3. MEMORY.md (optional)
        if let Some(memory) = read_project_memory(&project_dir) {
            events.send(IngestEvent::ProjectMemory {
                slug: slug.to_owned(),
                content: memory,
            })?;
        }

        // 4. Merge index entries with anything on disk that the index
        //    doesn't already know about — matches TS `mergeWithDiscoveredEntries`.
        let entries = merge_with_discovered_entries(
            sessions_index.entries,
            &project_dir,
            sessions_index.original_path.as_deref(),
        );

        // 5. Walk sessions. The only error returned from `parse_one_session`
        //    is `ChannelClosed` — propagate it immediately so we don't spin
        //    over a dead channel.
        for entry in entries {
            parse_one_session(claude_dir, &project_dir, slug, &entry, events)?;
        }

        // 6. Final project-complete marker
        let duration_ms = u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX);
        events.send(IngestEvent::ProjectComplete {
            slug: slug.to_owned(),
            duration_ms,
        })?;

        Ok(())
    }
}

// ─── Session parsing ────────────────────────────────────────────────────────

fn parse_one_session(
    claude_dir: &Path,
    project_dir: &Path,
    slug: &str,
    entry: &SessionIndexEntry,
    events: &Sender<IngestEvent>,
) -> Result<(), ParseError> {
    let session_id = entry.session_id.clone();

    events.send(IngestEvent::Session {
        slug: slug.to_owned(),
        entry: entry.clone(),
    })?;

    // Canonical path, with fallback to entry.full_path if the canonical
    // file doesn't exist (handles stale indices pointing at relocated
    // JSONL files). Port of the TS `filePath` ternary.
    let canonical_path = project_dir.join(format!("{session_id}.jsonl"));
    let file_path: PathBuf = if canonical_path.exists() {
        canonical_path.clone()
    } else if !entry.full_path.is_empty() && Path::new(&entry.full_path).exists() {
        PathBuf::from(&entry.full_path)
    } else {
        canonical_path.clone()
    };

    let mut message_count: u32 = 0;
    let mut last_byte_position: u64 = 0;

    // Collect send errors from inside the closure. read_jsonl_streaming
    // calls the closure in a loop — we can't propagate channel failures
    // through a `?` inside the closure, so we stash them.
    let mut send_error: Option<SendError<IngestEvent>> = None;

    let stream_result = read_jsonl_streaming(&file_path, 0, |line, index, byte_offset| {
        if send_error.is_some() {
            // A previous send failed; skip further work. The outer loop
            // will still run but do nothing.
            return;
        }
        match build_message_event(slug, &session_id, line, index, byte_offset) {
            Ok(ev) => {
                if let Err(e) = events.send(ev) {
                    send_error = Some(e);
                    return;
                }
                message_count = message_count.saturating_add(1);
                last_byte_position = byte_offset;
            }
            Err(parse_err) => {
                // Mirror the TS parser: swallow the bad line but record it
                // as a WorkerError so the orchestrator can surface it.
                if let Err(e) = events.send(IngestEvent::WorkerError {
                    slug: slug.to_owned(),
                    error: format!("session {session_id} line {index}: {parse_err}"),
                }) {
                    send_error = Some(e);
                }
            }
        }
    });

    if let Some(e) = send_error {
        return Err(ParseError::from(e));
    }

    match stream_result {
        Ok(r) => {
            // read_jsonl_streaming reports the final byte position past the
            // last byte read, even if no complete lines were yielded.
            last_byte_position = r.final_byte_position.max(last_byte_position);
        }
        Err(e) => {
            events.send(IngestEvent::WorkerError {
                slug: slug.to_owned(),
                error: format!("session {session_id} read error: {e}"),
            })?;
        }
    }

    // Subagents
    for transcript in read_subagents(project_dir, &session_id) {
        events.send(IngestEvent::Subagent {
            slug: slug.to_owned(),
            session_id: session_id.clone(),
            transcript,
        })?;
    }

    // Tool results
    for tool_result in read_tool_results(project_dir, &session_id) {
        events.send(IngestEvent::ToolResult {
            slug: slug.to_owned(),
            session_id: session_id.clone(),
            tool_result,
        })?;
    }

    events.send(IngestEvent::SessionComplete {
        slug: slug.to_owned(),
        session_id: session_id.clone(),
        message_count,
        last_byte_position,
    })?;

    // File history (always parsed, not gated by skipMessages — matching TS)
    if let Some(history) = read_file_history(claude_dir, &session_id) {
        events.send(IngestEvent::FileHistory {
            session_id: session_id.clone(),
            history,
        })?;
    }

    // Todos
    for todo in read_todos(claude_dir, &session_id) {
        events.send(IngestEvent::Todo {
            session_id: session_id.clone(),
            todo,
        })?;
    }

    // Task
    if let Some(task) = read_task(claude_dir, &session_id) {
        events.send(IngestEvent::Task { session_id, task })?;
    }

    Ok(())
}

/// Parse one JSONL line into an `IngestEvent::Message`, pre-extracting the
/// columns the writer needs. Matches the TS `extractMsgType`,
/// `extractUuid`, `extractTimestamp`, `extractTokens`, and the
/// `extractTextContent` call from `ingest-service.ts`.
fn build_message_event(
    slug: &str,
    session_id: &str,
    line: &str,
    index: u32,
    byte_offset: u64,
) -> Result<IngestEvent, serde_json::Error> {
    // Two parses: first a loose Value for top-level field extraction
    // (matches the TS `msg as Record<string, unknown>` cast), then a
    // typed SessionMessage for fts_text. The loose parse is the canonical
    // source of truth for msg_type so we don't have to reverse-engineer
    // the serde tag-rename mapping (kebab-case + explicit renames).
    let value: Value = serde_json::from_str(line)?;

    let msg_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let uuid = value.get("uuid").and_then(Value::as_str).map(str::to_owned);
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_owned);

    // Tokens: only present on assistant messages with a `message.usage` block.
    // Matches TS `extractTokens` exactly.
    let (input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) =
        if msg_type == "assistant" {
            extract_tokens(&value)
        } else {
            (0, 0, 0, 0)
        };

    // fts_text — only user / assistant / summary contribute. We do a
    // typed parse here; if it fails we still emit the Message with
    // fts_text=None rather than dropping the row. The writer tolerates
    // a missing fts blob.
    let fts_text = match serde_json::from_str::<SessionMessage>(line) {
        Ok(msg) => {
            let s = fts_text::extract_message_text(&msg);
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        Err(_) => None,
    };

    Ok(IngestEvent::Message {
        slug: slug.to_owned(),
        session_id: session_id.to_owned(),
        index,
        byte_offset,
        raw_json: line.to_owned(),
        msg_type,
        uuid,
        timestamp,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        fts_text,
    })
}

fn extract_tokens(value: &Value) -> (u64, u64, u64, u64) {
    let Some(usage) = value.get("message").and_then(|m| m.get("usage")) else {
        return (0, 0, 0, 0);
    };
    let pick = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    (
        pick("input_tokens"),
        pick("output_tokens"),
        pick("cache_creation_input_tokens"),
        pick("cache_read_input_tokens"),
    )
}

// ─── sessions-index.json ────────────────────────────────────────────────────

/// Read `sessions-index.json` from `<project_dir>/sessions-index.json`.
///
/// Returns `(parsed_index, raw_json_string)` where `raw_json_string` is
/// what the writer stores verbatim in `projects.sessions_index`. On any
/// failure we fall back to a synthetic empty index (matches TS behaviour).
fn read_sessions_index(project_dir: &Path) -> (SessionsIndex, String) {
    let path = project_dir.join("sessions-index.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return (empty_sessions_index(), "{}".to_owned()),
    };

    match serde_json::from_str::<SessionsIndex>(&raw) {
        Ok(parsed) => (parsed, raw),
        // Malformed index — fall back to empty, but hold on to the raw
        // string so the writer still stores whatever was there.
        Err(_) => (empty_sessions_index(), raw),
    }
}

fn empty_sessions_index() -> SessionsIndex {
    SessionsIndex {
        version: 1,
        original_path: None,
        entries: Vec::new(),
    }
}

/// Port of TS `mergeWithDiscoveredEntries` — appends any on-disk JSONL
/// files whose session IDs aren't already present in the index.
fn merge_with_discovered_entries(
    index_entries: Vec<SessionIndexEntry>,
    project_dir: &Path,
    original_path: Option<&str>,
) -> Vec<SessionIndexEntry> {
    let mut indexed: std::collections::HashSet<String> =
        index_entries.iter().map(|e| e.session_id.clone()).collect();
    let mut merged = index_entries;

    for entry in discover_session_entries(project_dir, original_path) {
        if indexed.insert(entry.session_id.clone()) {
            merged.push(entry);
        }
    }
    merged
}

/// Port of TS `discoverSessionEntries` — scans the project dir for
/// canonical `<uuid>.jsonl` files and builds a stub entry for each.
///
/// We skip the TS "peek at first user prompt" streaming read here: the
/// real parser reads the whole file immediately afterwards anyway, so
/// re-reading just to extract a 200-char prompt is wasteful. The entry's
/// `first_prompt` stays empty — the writer fills it in from the first
/// user message it ingests.
fn discover_session_entries(
    project_dir: &Path,
    original_path: Option<&str>,
) -> Vec<SessionIndexEntry> {
    let Ok(read_dir) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };

    let slug_fallback = project_dir
        .file_name()
        .and_then(|s| s.to_str())
        .map(slug_to_path_naive);
    let project_path = original_path
        .map(str::to_owned)
        .or(slug_fallback)
        .unwrap_or_default();

    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !UUID_JSONL.is_match(name) {
            continue;
        }
        let path = entry.path();
        let session_id = name.trim_end_matches(".jsonl").to_owned();

        let file_mtime = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);

        // Port of the TS discoverSessionEntries: set `created` and
        // `modified` from file mtime as ISO-8601 (matches what
        // `new Date(mtimeMs).toISOString()` produces), and peek at the
        // file's first user message for `first_prompt`. Without these,
        // projects that have no sessions-index.json end up with blank
        // timestamps (UI sort-by-modified breaks) and all sessions
        // labeled "No prompt".
        let modified_iso = epoch_ms_to_iso8601(file_mtime);
        let first_prompt = peek_first_user_prompt(&path).unwrap_or_else(|| "No prompt".to_owned());

        out.push(SessionIndexEntry {
            session_id,
            full_path: path.to_string_lossy().into_owned(),
            file_mtime,
            first_prompt,
            summary: String::new(),
            message_count: 0,
            created: modified_iso.clone(),
            modified: modified_iso,
            git_branch: String::new(),
            project_path: project_path.clone(),
            is_sidechain: false,
        });
    }
    out
}

// ─── MEMORY.md ──────────────────────────────────────────────────────────────

fn read_project_memory(project_dir: &Path) -> Option<String> {
    let path = project_dir.join("memory").join("MEMORY.md");
    std::fs::read_to_string(path).ok()
}

// ─── Subagents ──────────────────────────────────────────────────────────────

fn read_subagents(project_dir: &Path, session_id: &str) -> Vec<SubagentTranscript> {
    let dir = project_dir.join(session_id).join("subagents");
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }

        let agent_id = extract_agent_id(name);
        let agent_type = infer_agent_type(name);
        let path = entry.path();

        let mut messages: Vec<SessionMessage> = Vec::new();
        let _ = read_jsonl_streaming(&path, 0, |line, _idx, _off| {
            if let Ok(msg) = serde_json::from_str::<SessionMessage>(line) {
                messages.push(msg);
            }
        });

        out.push(SubagentTranscript {
            agent_id,
            agent_type,
            file_name: name.to_owned(),
            messages,
            meta: None,
        });
    }
    out
}

/// TS: `const match = fileName.match(/^agent-(a.+)\.jsonl$/);`
fn extract_agent_id(file_name: &str) -> String {
    if let Some(caps) = SUBAGENT_FILE.captures(file_name) {
        caps.get(1)
            .map(|m| m.as_str().to_owned())
            .unwrap_or_else(|| file_name.trim_end_matches(".jsonl").to_owned())
    } else {
        file_name.trim_end_matches(".jsonl").to_owned()
    }
}

/// TS:
/// ```ts
/// if (fileName.includes('prompt_suggestion')) return 'prompt_suggestion';
/// if (fileName.includes('compact')) return 'compact';
/// return 'task';
/// ```
fn infer_agent_type(file_name: &str) -> SubagentType {
    if file_name.contains("prompt_suggestion") {
        SubagentType::PromptSuggestion
    } else if file_name.contains("compact") {
        SubagentType::Compact
    } else {
        SubagentType::Task
    }
}

// ─── Tool results ───────────────────────────────────────────────────────────

fn read_tool_results(project_dir: &Path, session_id: &str) -> Vec<PersistedToolResult> {
    let dir = project_dir.join(session_id).join("tool-results");
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.ends_with(".txt") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let tool_use_id = name.trim_end_matches(".txt").to_owned();
        out.push(PersistedToolResult {
            tool_use_id,
            content,
        });
    }
    out
}

// ─── File history ───────────────────────────────────────────────────────────

fn read_file_history(claude_dir: &Path, session_id: &str) -> Option<FileHistorySession> {
    let dir = claude_dir.join("file-history").join(session_id);
    let read_dir = std::fs::read_dir(&dir).ok()?;

    let mut snapshots = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(caps) = FILE_HISTORY_SNAPSHOT.captures(name) else {
            continue;
        };
        let hash = caps.get(1)?.as_str().to_owned();
        let Ok(version) = caps.get(2)?.as_str().parse::<u64>() else {
            continue;
        };
        let path = entry.path();
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        snapshots.push(FileHistorySnapshotFile {
            hash,
            version,
            file_name: name.to_owned(),
            content,
            size,
        });
    }

    if snapshots.is_empty() {
        None
    } else {
        Some(FileHistorySession {
            session_id: session_id.to_owned(),
            snapshots,
        })
    }
}

// ─── Todos ──────────────────────────────────────────────────────────────────

fn read_todos(claude_dir: &Path, session_id: &str) -> Vec<TodoFile> {
    let dir = claude_dir.join("todos");
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let prefix = format!("{session_id}-agent-");
    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        // TS glob equivalent: `${sessionId}-agent-*.json`
        if !name.starts_with(&prefix) || !name.ends_with(".json") {
            continue;
        }
        let Some(caps) = TODO_FILE.captures(name) else {
            continue;
        };
        let match_session = caps
            .get(1)
            .map(|m| m.as_str().to_owned())
            .unwrap_or_default();
        let match_agent = caps
            .get(2)
            .map(|m| m.as_str().to_owned())
            .unwrap_or_default();

        let items = match std::fs::read_to_string(entry.path()) {
            Ok(raw) => serde_json::from_str::<Vec<TodoItem>>(&raw).unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        out.push(TodoFile {
            session_id: match_session,
            agent_id: match_agent,
            items,
        });
    }
    out
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

fn read_task(claude_dir: &Path, session_id: &str) -> Option<TaskEntry> {
    let task_dir = claude_dir.join("tasks").join(session_id);
    let lock_path = task_dir.join(".lock");
    if !lock_path.exists() {
        return None;
    }

    let (has_highwatermark, highwatermark) =
        match std::fs::read_to_string(task_dir.join(".highwatermark")) {
            Ok(raw) => (true, raw.trim().parse::<i64>().ok()),
            Err(_) => (false, None),
        };

    Some(TaskEntry {
        task_id: session_id.to_owned(),
        has_highwatermark,
        highwatermark,
        lock_exists: true,
        items: None,
    })
}

// ─── Slug → path (best-effort) ──────────────────────────────────────────────

/// Naive port of TS `slugToPath` — replaces leading `-` with `/` and every
/// remaining `-` with `/`. The TS version also probes the filesystem to
/// resolve legitimate hyphens in directory names; we skip that here
/// because (a) the parser only uses `original_path` for display, and
/// (b) the probing is inherently racy and adds I/O we'd rather avoid on
/// the hot ingest path.
fn slug_to_path_naive(slug: &str) -> String {
    let trimmed = slug.strip_prefix('-').unwrap_or(slug);
    let mut out = String::with_capacity(slug.len() + 1);
    if slug.starts_with('-') {
        out.push('/');
    }
    for ch in trimmed.chars() {
        if ch == '-' {
            out.push('/');
        } else {
            out.push(ch);
        }
    }
    out
}

/// Format an epoch-millisecond timestamp as an ISO 8601 string matching
/// what JS `new Date(ms).toISOString()` produces (e.g. `2026-04-17T14:36:40.342Z`).
/// Used to populate `created` / `modified` on discovered sessions so the
/// SDK's sort-by-modified-at queries work when sessions-index.json is
/// absent.
fn epoch_ms_to_iso8601(ms: f64) -> String {
    use time::format_description::well_known::{iso8601, Iso8601};

    // Clamp to the representable range; negative or absurd values just
    // fall back to the epoch, matching how JS rounds NaN → "Invalid Date".
    let nanos = (ms * 1_000_000.0) as i128;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);

    // JS's toISOString() renders milliseconds (3 digits) in UTC with a
    // trailing 'Z'. `Iso8601::DEFAULT` would emit nanoseconds, so use a
    // 3-digit subsecond config to match JS byte-for-byte.
    const CFG: iso8601::EncodedConfig = iso8601::Config::DEFAULT
        .set_time_precision(iso8601::TimePrecision::Second {
            decimal_digits: std::num::NonZeroU8::new(3),
        })
        .encode();
    dt.format(&Iso8601::<CFG>)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// Read the first "user" message from a JSONL session file and return
/// its first 200 characters as a first-prompt candidate. Returns None
/// if the file can't be opened, has no user message, or the content
/// can't be extracted. Matches the behaviour of the TS parser's
/// `discoverSessionEntries` peek.
fn peek_first_user_prompt(path: &Path) -> Option<String> {
    use std::cell::RefCell;

    let found: RefCell<Option<String>> = RefCell::new(None);
    let _ = crate::jsonl_reader::read_jsonl_streaming(path, 0, |line, _, _| {
        if found.borrow().is_some() {
            return;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("user") {
            return;
        }
        let Some(message) = val.get("message") else {
            return;
        };
        let content = message.get("content");
        let text = match content {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Array(blocks)) => blocks.iter().find_map(|block| {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    block
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            }),
            _ => None,
        };
        if let Some(t) = text {
            *found.borrow_mut() = Some(t.chars().take(200).collect());
        }
    });
    found.into_inner()
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::{bounded, Receiver};
    use std::fs;
    use tempfile::{tempdir, TempDir};

    /// Fully drain the receiver into a vec. The project parser always
    /// finishes (it's single-threaded) before we inspect, so `try_iter`
    /// is sufficient.
    fn drain(rx: &Receiver<IngestEvent>) -> Vec<IngestEvent> {
        rx.try_iter().collect()
    }

    fn run_parser(claude_dir: &Path, slug: &str) -> Vec<IngestEvent> {
        let (tx, rx) = bounded::<IngestEvent>(1024);
        let parser = ProjectParser::new();
        parser
            .parse_project(claude_dir, slug, &tx)
            .expect("parse_project should succeed");
        drop(tx);
        drain(&rx)
    }

    /// Build `<claude_dir>/projects/<slug>/` and return the project dir.
    fn mk_project(claude_dir: &Path, slug: &str) -> PathBuf {
        let p = claude_dir.join("projects").join(slug);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn mk_tempdir() -> TempDir {
        tempdir().expect("tempdir")
    }

    // ── 1. Empty project directory ────────────────────────────────────────

    #[test]
    fn empty_project_emits_only_project_and_complete() {
        let dir = mk_tempdir();
        mk_project(dir.path(), "proj-a");
        let events = run_parser(dir.path(), "proj-a");
        assert_eq!(events.len(), 2, "got: {events:#?}");
        assert!(matches!(events[0], IngestEvent::Project { .. }));
        assert!(matches!(events[1], IngestEvent::ProjectComplete { .. }));
    }

    // ── 2. Single session, 3 messages ─────────────────────────────────────

    fn user_line(uuid: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"2026-04-17T00:00:00Z","sessionId":"s1","cwd":"/tmp","version":"1","gitBranch":"main","isSidechain":false,"userType":"external","message":{{"role":"user","content":"hi {uuid}"}}}}"#
        )
    }

    #[test]
    fn single_session_three_messages_sequence() {
        let dir = mk_tempdir();
        let session_id = "11111111-1111-1111-1111-111111111111";
        let project_dir = mk_project(dir.path(), "proj-b");

        // sessions-index.json listing one session
        let idx = format!(
            r#"{{"version":1,"originalPath":"/orig/path","entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"hi","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"/orig/path","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();

        // Three user lines
        let body = format!(
            "{}\n{}\n{}\n",
            user_line("u1"),
            user_line("u2"),
            user_line("u3")
        );
        fs::write(project_dir.join(format!("{session_id}.jsonl")), body).unwrap();

        let events = run_parser(dir.path(), "proj-b");
        // Expected sequence: Project, Session, Message×3, SessionComplete,
        // ProjectComplete — seven total.
        assert_eq!(events.len(), 7, "got: {events:#?}");
        assert!(matches!(events[0], IngestEvent::Project { .. }));
        assert!(matches!(events[1], IngestEvent::Session { .. }));
        for (i, ev) in events.iter().enumerate().skip(2).take(3) {
            match ev {
                IngestEvent::Message {
                    session_id: sid,
                    msg_type,
                    index,
                    ..
                } => {
                    assert_eq!(sid, session_id);
                    assert_eq!(msg_type, "user");
                    assert_eq!(*index, (i - 2) as u32);
                }
                other => panic!("expected Message, got {other:?}"),
            }
        }
        assert!(matches!(events[5], IngestEvent::SessionComplete { .. }));
        assert!(matches!(events[6], IngestEvent::ProjectComplete { .. }));
    }

    // ── 3. MEMORY.md present ──────────────────────────────────────────────

    #[test]
    fn memory_md_emits_project_memory_event() {
        let dir = mk_tempdir();
        let project_dir = mk_project(dir.path(), "proj-mem");
        fs::create_dir_all(project_dir.join("memory")).unwrap();
        fs::write(
            project_dir.join("memory").join("MEMORY.md"),
            "# memory body",
        )
        .unwrap();

        let events = run_parser(dir.path(), "proj-mem");
        assert!(events.iter().any(|ev| matches!(
            ev,
            IngestEvent::ProjectMemory { content, .. } if content == "# memory body"
        )));
    }

    // ── 4. Subagent transcript ────────────────────────────────────────────

    #[test]
    fn subagent_transcript_emits_subagent_event() {
        let dir = mk_tempdir();
        let session_id = "22222222-2222-2222-2222-222222222222";
        let project_dir = mk_project(dir.path(), "proj-sub");

        // Minimal sessions-index so the parser visits this session
        let idx = format!(
            r#"{{"version":1,"entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();

        // Empty session file + a subagent transcript
        fs::write(project_dir.join(format!("{session_id}.jsonl")), "").unwrap();
        let subagents_dir = project_dir.join(session_id).join("subagents");
        fs::create_dir_all(&subagents_dir).unwrap();
        let transcript = user_line("sub1");
        fs::write(
            subagents_dir.join("agent-abc123.jsonl"),
            format!("{transcript}\n"),
        )
        .unwrap();

        let events = run_parser(dir.path(), "proj-sub");
        let hit = events.iter().find_map(|ev| match ev {
            IngestEvent::Subagent { transcript, .. } => Some(transcript),
            _ => None,
        });
        let transcript = hit.expect("expected Subagent event");
        // TS regex `^agent-(a.+)\.jsonl$` requires the id to start with `a`
        // and captures it verbatim — so the capture here is "abc123".
        assert_eq!(transcript.agent_id, "abc123");
        assert_eq!(transcript.agent_type, SubagentType::Task);
        assert_eq!(transcript.messages.len(), 1);
    }

    // ── 5. Todo file ──────────────────────────────────────────────────────

    #[test]
    fn todo_file_emits_todo_event() {
        let dir = mk_tempdir();
        let session_id = "33333333-3333-3333-3333-333333333333";
        let project_dir = mk_project(dir.path(), "proj-todo");

        let idx = format!(
            r#"{{"version":1,"entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();
        fs::write(project_dir.join(format!("{session_id}.jsonl")), "").unwrap();

        // todos live under <claude_dir>/todos/<session>-agent-<agent>.json
        let todos_dir = dir.path().join("todos");
        fs::create_dir_all(&todos_dir).unwrap();
        let todo_file = todos_dir.join(format!("{session_id}-agent-xyz.json"));
        fs::write(&todo_file, r#"[{"content":"buy milk","status":"pending"}]"#).unwrap();

        let events = run_parser(dir.path(), "proj-todo");
        let todo = events.iter().find_map(|ev| match ev {
            IngestEvent::Todo { todo, .. } => Some(todo),
            _ => None,
        });
        let todo = todo.expect("expected Todo event");
        assert_eq!(todo.session_id, session_id);
        assert_eq!(todo.agent_id, "xyz");
        assert_eq!(todo.items.len(), 1);
        assert_eq!(todo.items[0].content, "buy milk");
    }

    // ── 6. Malformed JSONL line ───────────────────────────────────────────

    #[test]
    fn malformed_jsonl_line_emits_worker_error_and_skips() {
        let dir = mk_tempdir();
        let session_id = "44444444-4444-4444-4444-444444444444";
        let project_dir = mk_project(dir.path(), "proj-bad");

        let idx = format!(
            r#"{{"version":1,"entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();

        // One good line + one garbage line + one good line.
        let body = format!("{}\nnot-valid-json\n{}\n", user_line("a"), user_line("b"));
        fs::write(project_dir.join(format!("{session_id}.jsonl")), body).unwrap();

        let events = run_parser(dir.path(), "proj-bad");
        let msgs: Vec<_> = events
            .iter()
            .filter(|ev| matches!(ev, IngestEvent::Message { .. }))
            .collect();
        assert_eq!(msgs.len(), 2, "bad line should be skipped");
        assert!(
            events
                .iter()
                .any(|ev| matches!(ev, IngestEvent::WorkerError { .. })),
            "bad line should emit WorkerError"
        );
    }

    // ── 7. Assistant message with usage → token extraction ────────────────

    #[test]
    fn assistant_usage_block_extracts_tokens() {
        let dir = mk_tempdir();
        let session_id = "55555555-5555-5555-5555-555555555555";
        let project_dir = mk_project(dir.path(), "proj-tokens");

        let idx = format!(
            r#"{{"version":1,"entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();

        let assistant = r#"{"type":"assistant","uuid":"a1","timestamp":"2026-04-17T00:00:00Z","sessionId":"s1","cwd":"/tmp","version":"1","gitBranch":"main","isSidechain":false,"userType":"external","requestId":"r1","message":{"model":"claude","id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"hey"}],"usage":{"input_tokens":11,"output_tokens":22,"cache_creation_input_tokens":33,"cache_read_input_tokens":44}}}"#;
        fs::write(
            project_dir.join(format!("{session_id}.jsonl")),
            format!("{assistant}\n"),
        )
        .unwrap();

        let events = run_parser(dir.path(), "proj-tokens");
        let msg = events
            .iter()
            .find_map(|ev| match ev {
                IngestEvent::Message {
                    msg_type,
                    input_tokens,
                    output_tokens,
                    cache_creation_tokens,
                    cache_read_tokens,
                    ..
                } if msg_type == "assistant" => Some((
                    *input_tokens,
                    *output_tokens,
                    *cache_creation_tokens,
                    *cache_read_tokens,
                )),
                _ => None,
            })
            .expect("assistant message event");
        assert_eq!(msg, (11, 22, 33, 44));
    }

    // ── 8. fts_text populated on a plain-text user message ────────────────

    #[test]
    fn user_message_populates_fts_text() {
        let dir = mk_tempdir();
        let session_id = "66666666-6666-6666-6666-666666666666";
        let project_dir = mk_project(dir.path(), "proj-fts");

        let idx = format!(
            r#"{{"version":1,"entries":[{{"sessionId":"{session_id}","fullPath":"","fileMtime":0,"firstPrompt":"","summary":"","messageCount":0,"created":"","modified":"","gitBranch":"","projectPath":"","isSidechain":false}}]}}"#
        );
        fs::write(project_dir.join("sessions-index.json"), idx).unwrap();
        fs::write(
            project_dir.join(format!("{session_id}.jsonl")),
            format!("{}\n", user_line("u1")),
        )
        .unwrap();

        let events = run_parser(dir.path(), "proj-fts");
        let fts = events.iter().find_map(|ev| match ev {
            IngestEvent::Message { fts_text, .. } => fts_text.clone(),
            _ => None,
        });
        assert_eq!(fts.as_deref(), Some("hi u1"));
    }
}
