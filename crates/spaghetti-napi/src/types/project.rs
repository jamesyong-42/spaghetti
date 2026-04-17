//! Project-level types: sessions index, subagent transcripts, persisted
//! tool results, project memory. Mirrors the relevant shapes from
//! `packages/sdk/src/types/projects.ts`.

use serde::{Deserialize, Serialize};

use super::session::SessionMessage;

// ─────────────────────────────────────────────────────────────────────────
// SessionsIndex
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsIndex {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(default)]
    pub entries: Vec<SessionIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    #[serde(default)]
    pub full_path: String,
    #[serde(default)]
    pub file_mtime: f64,
    #[serde(default)]
    pub first_prompt: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub git_branch: String,
    #[serde(default)]
    pub project_path: String,
    #[serde(default)]
    pub is_sidechain: bool,
}

// ─────────────────────────────────────────────────────────────────────────
// Subagents
// ─────────────────────────────────────────────────────────────────────────

/// TS `SubagentType = 'task' | 'prompt_suggestion' | 'compact'`. Kept as a
/// string-backed enum so serde can deserialize the literal values directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentType {
    Task,
    PromptSuggestion,
    Compact,
}

/// TS `SubagentTranscript`. The parser never serialises this back out, but
/// we derive `Serialize` anyway so the writer can re-emit it as JSON when
/// storing the aggregate `messages` blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTranscript {
    pub agent_id: String,
    pub agent_type: SubagentType,
    pub file_name: String,
    #[serde(default)]
    pub messages: Vec<SessionMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<SubagentMeta>,
}

/// `agent-{id}.meta.json` — TS `SubagentMeta`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    pub agent_type: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Persisted tool result (session-scoped, on-disk .txt file)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedToolResult {
    pub tool_use_id: String,
    pub content: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Project memory (MEMORY.md)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub project_slug: String,
    pub content: String,
}
