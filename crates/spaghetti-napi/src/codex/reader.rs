//! CodexReader — walk `sessions/**/rollout-*.jsonl` → [`IngestEvent`] stream.
//!
//! Mirrors `packages/sdk/src/sources/codex/reader.ts` + token attribution
//! from `ingest-service.ts` (ccusage-style last_token_usage onto previous
//! assistant). Tiktoken estimate for missing token_count is TS-only for now.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crossbeam_channel::{SendError, Sender};
use once_cell::sync::Lazy;
use regex::Regex;

use crate::claude::types::{SessionIndexEntry, SessionsIndex};
use crate::codex::message_extractor::{self, MessageProjection};
use crate::core::event::IngestEvent;
use crate::core::jsonl::read_jsonl_streaming;

static ROLLOUT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^rollout-.*\.jsonl$").expect("rollout regex"));
static UUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").expect("uuid")
});

const FIRST_PROMPT_MAX: usize = 200;
const PEEK_LINE_LIMIT: u32 = 100;

#[derive(Debug, thiserror::Error)]
pub enum CodexReadError {
    #[error("event channel closed")]
    ChannelClosed(#[source] Box<SendError<IngestEvent>>),
}

impl From<SendError<IngestEvent>> for CodexReadError {
    fn from(e: SendError<IngestEvent>) -> Self {
        Self::ChannelClosed(Box::new(e))
    }
}

#[derive(Debug, Clone)]
struct PeekMeta {
    cwd: String,
    session_id: String,
    timestamp: Option<String>,
    first_prompt: String,
}

/// Encode cwd → project slug (Claude-compatible `/` → `-`).
pub fn encode_slug(cwd: &str) -> String {
    cwd.replace('/', "-")
}

struct SessionFile {
    path: PathBuf,
    meta: PeekMeta,
    mtime_ms: f64,
    size: u64,
}

/// Discover + stream Codex rollouts into the ingest event channel.
pub struct CodexReader;

impl CodexReader {
    /// Full cold-style read of every rollout under `sessions_dir`.
    ///
    /// Emits Project / Session / Message* / SessionComplete / ProjectComplete
    /// plus Fingerprint events for each file (caller should ClearSourceFiles
    /// first for a clean codex-scoped fingerprint set).
    pub fn read_all(
        sessions_dir: &Path,
        events: &Sender<IngestEvent>,
    ) -> Result<CodexReadStats, CodexReadError> {
        let files = discover(sessions_dir);
        let mut by_project: BTreeMap<String, (String, Vec<SessionFile>)> = BTreeMap::new();

        for path in files {
            let Some(meta) = peek(&path) else { continue };
            let slug = encode_slug(&meta.cwd);
            let (mtime_ms, size) = file_stats(&path);
            by_project
                .entry(slug)
                .or_insert_with(|| (meta.cwd.clone(), Vec::new()))
                .1
                .push(SessionFile {
                    path,
                    meta,
                    mtime_ms,
                    size,
                });
        }

        let mut stats = CodexReadStats {
            projects: by_project.len() as u32,
            ..Default::default()
        };

        for (slug, (original_path, sessions)) in by_project {
            let entries: Vec<SessionIndexEntry> = sessions.iter().map(session_entry).collect();
            let sessions_index = SessionsIndex {
                version: 1,
                original_path: Some(original_path.clone()),
                entries: entries.clone(),
            };
            let sessions_index_json =
                serde_json::to_string(&sessions_index).unwrap_or_else(|_| "{}".into());

            events.send(IngestEvent::Project {
                slug: slug.clone(),
                original_path,
                sessions_index_json,
            })?;

            for (i, sess) in sessions.iter().enumerate() {
                events.send(IngestEvent::Session {
                    slug: slug.clone(),
                    entry: entries[i].clone(),
                })?;
                let (msg_count, last_byte) = stream_session(&slug, sess, events)?;
                stats.sessions += 1;
                stats.messages += msg_count;

                events.send(IngestEvent::SessionComplete {
                    slug: slug.clone(),
                    session_id: sess.meta.session_id.clone(),
                    message_count: msg_count,
                    last_byte_position: last_byte,
                })?;

                events.send(IngestEvent::Fingerprint {
                    path: sess.path.to_string_lossy().into_owned(),
                    mtime_ms: sess.mtime_ms,
                    size: sess.size,
                    byte_position: Some(last_byte),
                    category: "session".into(),
                    project_slug: Some(slug.clone()),
                    session_id: Some(sess.meta.session_id.clone()),
                })?;
            }

            events.send(IngestEvent::ProjectComplete {
                slug,
                duration_ms: 0,
            })?;
        }

        Ok(stats)
    }

    /// Warm-start: true when every known rollout is unchanged vs `stored`
    /// fingerprints (path → mtime) and there are no new/deleted rollouts.
    pub fn warm_unchanged(
        sessions_dir: &Path,
        stored: &std::collections::HashMap<String, crate::claude::fingerprint::SourceFingerprint>,
    ) -> bool {
        let files = discover(sessions_dir);
        if files.is_empty() && stored.is_empty() {
            return true;
        }
        let mut seen = std::collections::HashSet::new();
        for path in &files {
            let key = path.to_string_lossy().into_owned();
            seen.insert(key.clone());
            let (mtime_ms, size) = file_stats(path);
            match stored.get(&key) {
                None => return false,
                Some(fp) if (fp.mtime_ms - mtime_ms).abs() > 0.5 || fp.size != size => {
                    return false
                }
                Some(_) => {}
            }
        }
        // Any stored fingerprint under sessions_dir missing on disk?
        let prefix = sessions_dir.to_string_lossy();
        for path in stored.keys() {
            if path.starts_with(prefix.as_ref()) && !seen.contains(path) {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct CodexReadStats {
    pub projects: u32,
    pub sessions: u32,
    pub messages: u32,
}

fn discover(sessions_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !sessions_dir.is_dir() {
        return out;
    }
    let walker = walkdir::WalkDir::new(sessions_dir).follow_links(false);
    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if ROLLOUT_RE.is_match(&name) {
            out.push(entry.path().to_path_buf());
        }
    }
    out.sort();
    out
}

fn peek(path: &Path) -> Option<PeekMeta> {
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut timestamp: Option<String> = None;
    let mut first_prompt = String::new();

    let _ = read_jsonl_streaming(path, 0, |line, index, _| {
        if index >= PEEK_LINE_LIMIT {
            return;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if ty == "session_meta" {
                if let Some(p) = v.get("payload") {
                    if cwd.is_none() {
                        if let Some(c) = p.get("cwd").and_then(|x| x.as_str()) {
                            cwd = Some(c.to_owned());
                        }
                    }
                    if session_id.is_none() {
                        if let Some(id) = p.get("id").and_then(|x| x.as_str()) {
                            session_id = Some(id.to_owned());
                        }
                    }
                }
                if timestamp.is_none() {
                    if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                        timestamp = Some(ts.to_owned());
                    }
                }
            } else if first_prompt.is_empty() {
                if let Ok(Some(proj)) = message_extractor::project_jsonl_line(line) {
                    if proj.msg_type == "user" {
                        if let Some(t) = proj.fts_text {
                            first_prompt = t.chars().take(FIRST_PROMPT_MAX).collect();
                        }
                    }
                }
            }
        }
    });

    let cwd = cwd?;
    let session_id = session_id
        .or_else(|| {
            let name = path.file_name()?.to_str()?;
            UUID_RE.find(name).map(|m| m.as_str().to_owned())
        })
        .unwrap_or_else(|| path.file_name().unwrap().to_string_lossy().into_owned());

    Some(PeekMeta {
        cwd,
        session_id,
        timestamp,
        first_prompt,
    })
}

fn session_entry(s: &SessionFile) -> SessionIndexEntry {
    let modified = if s.mtime_ms > 0.0 {
        ms_to_iso(s.mtime_ms)
    } else {
        s.meta.timestamp.clone().unwrap_or_default()
    };
    SessionIndexEntry {
        session_id: s.meta.session_id.clone(),
        full_path: s.path.to_string_lossy().into_owned(),
        file_mtime: s.mtime_ms,
        first_prompt: if s.meta.first_prompt.is_empty() {
            "No prompt".into()
        } else {
            s.meta.first_prompt.clone()
        },
        summary: String::new(),
        message_count: 0,
        created: s.meta.timestamp.clone().unwrap_or_else(|| modified.clone()),
        modified,
        git_branch: String::new(),
        project_path: s.meta.cwd.clone(),
        is_sidechain: false,
    }
}

fn stream_session(
    slug: &str,
    sess: &SessionFile,
    events: &Sender<IngestEvent>,
) -> Result<(u32, u64), CodexReadError> {
    let session_id = &sess.meta.session_id;
    let mut message_count: u32 = 0;
    let mut last_byte: u64 = 0;
    // Absolute line index in file (including skipped lines) — matches TS CodexReader
    let mut line_index: u32 = 0;
    // Last assistant message for token attribution
    let mut last_assistant: Option<(u32, String, MessageProjection)> = None;
    let mut send_err: Option<SendError<IngestEvent>> = None;

    let stream = read_jsonl_streaming(&sess.path, 0, |line, _idx, byte_offset| {
        if send_err.is_some() {
            return;
        }
        last_byte = byte_offset;
        let idx = line_index;
        line_index = line_index.saturating_add(1);

        match message_extractor::project_jsonl_line(line) {
            Ok(Some(proj)) => {
                let ev = IngestEvent::Message {
                    slug: slug.to_owned(),
                    session_id: session_id.clone(),
                    index: idx,
                    byte_offset,
                    raw_json: line.to_owned(),
                    msg_type: proj.msg_type.clone(),
                    uuid: proj.uuid.clone(),
                    timestamp: proj.timestamp.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 0,
                    fts_text: proj.fts_text.clone(),
                };
                if proj.msg_type == "assistant" {
                    last_assistant = Some((idx, line.to_owned(), proj));
                }
                if let Err(e) = events.send(ev) {
                    send_err = Some(e);
                    return;
                }
                message_count = message_count.saturating_add(1);
            }
            Ok(None) => {
                // token_count attribution
                if let Some((in_t, out_t, cc, cr)) = message_extractor::parse_token_count(line) {
                    if let Some((a_idx, raw, proj)) = last_assistant.as_ref() {
                        let ev = IngestEvent::Message {
                            slug: slug.to_owned(),
                            session_id: session_id.clone(),
                            index: *a_idx,
                            byte_offset: 0,
                            raw_json: raw.clone(),
                            msg_type: proj.msg_type.clone(),
                            uuid: proj.uuid.clone(),
                            timestamp: proj.timestamp.clone(),
                            input_tokens: in_t,
                            output_tokens: out_t,
                            cache_creation_tokens: cc,
                            cache_read_tokens: cr,
                            fts_text: proj.fts_text.clone(),
                        };
                        if let Err(e) = events.send(ev) {
                            send_err = Some(e);
                        }
                    }
                }
            }
            Err(_) => {
                // bad JSON line — skip (TS swallows)
            }
        }
    });

    if let Some(e) = send_err {
        return Err(e.into());
    }
    if let Ok(r) = stream {
        last_byte = r.final_byte_position.max(last_byte);
    }
    Ok((message_count, last_byte))
}

fn file_stats(path: &Path) -> (f64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            (mtime_ms, m.len())
        }
        Err(_) => (0.0, 0),
    }
}

fn ms_to_iso(mtime_ms: f64) -> String {
    let secs = (mtime_ms / 1000.0).floor() as u64;
    let nanos = ((mtime_ms % 1000.0) * 1_000_000.0) as u32;
    let t = UNIX_EPOCH + std::time::Duration::new(secs, nanos);
    // Prefer time crate if available — use simple RFC3339 via SystemTime debug fallback
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => {
            let s = d.as_secs();
            let ms = d.subsec_millis();
            // Manual UTC format without chrono
            format_utc(s, ms)
        }
        Err(_) => String::new(),
    }
}

fn format_utc(unix_secs: u64, ms: u32) -> String {
    // Use time crate (already a dependency)
    use time::OffsetDateTime;
    match OffsetDateTime::from_unix_timestamp(unix_secs as i64) {
        Ok(dt) => {
            let dt = dt + time::Duration::milliseconds(ms as i64);
            dt.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::unbounded;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn encode_slug_replaces_slashes() {
        assert_eq!(encode_slug("/Users/me/proj"), "-Users-me-proj");
    }

    #[test]
    fn read_all_emits_project_session_messages() {
        let tmp = TempDir::new().unwrap();
        let day = tmp.path().join("sessions/2026/01/01");
        std::fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-01-01T00-00-00-019aaaaaaaaaaaaaaaaaaaaaaaa.jsonl");
        let mut f = std::fs::File::create(&file).unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{{"id":"sess-1","cwd":"/tmp/demo"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"hi"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-01-01T00:00:02.000Z","type":"response_item","payload":{{"type":"message","role":"assistant","id":"a1","content":[{{"type":"output_text","text":"hello"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":3,"output_tokens":7,"cached_input_tokens":0,"reasoning_output_tokens":0,"total_tokens":10}}}}}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"response_item","payload":{{"type":"function_call","name":"shell"}}}}"#
        )
        .unwrap();

        let (tx, rx) = unbounded();
        let stats = CodexReader::read_all(tmp.path().join("sessions").as_path(), &tx).unwrap();
        drop(tx);
        let events: Vec<_> = rx.iter().collect();

        assert_eq!(stats.projects, 1);
        assert_eq!(stats.sessions, 1);
        assert_eq!(stats.messages, 2); // user + assistant (token re-upsert not counted as new)

        let msgs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                IngestEvent::Message {
                    msg_type,
                    input_tokens,
                    output_tokens,
                    fts_text,
                    ..
                } => Some((
                    msg_type.as_str(),
                    *input_tokens,
                    *output_tokens,
                    fts_text.clone(),
                )),
                _ => None,
            })
            .collect();
        // user, assistant (0 tokens), assistant re-upsert with tokens
        assert!(msgs.iter().any(|(t, _, _, _)| *t == "user"));
        assert!(msgs
            .iter()
            .any(|(t, i, o, _)| *t == "assistant" && *i == 3 && *o == 7));
        assert!(msgs
            .iter()
            .any(|(_, _, _, f)| f.as_deref() == Some("hello")));
    }
}
