//! Session-scoped artifacts: file history, todos, tasks, plans.
//!
//! Mirrors shapes from:
//! - `packages/sdk/src/types/file-history-data.ts`
//! - `packages/sdk/src/types/todos.ts`
//! - `packages/sdk/src/types/tasks.ts`
//! - `packages/sdk/src/types/plans-data.ts`

use serde::{Deserialize, Serialize};

use super::session::TodoItem;

// ─────────────────────────────────────────────────────────────────────────
// File history
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistorySession {
    pub session_id: String,
    #[serde(default)]
    pub snapshots: Vec<FileHistorySnapshotFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistorySnapshotFile {
    pub hash: String,
    pub version: u64,
    pub file_name: String,
    pub content: String,
    #[serde(default)]
    pub size: u64,
}

// ─────────────────────────────────────────────────────────────────────────
// Todos
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoFile {
    pub session_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub items: Vec<TodoItem>,
}

// ─────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEntry {
    pub task_id: String,
    #[serde(default)]
    pub has_highwatermark: bool,
    #[serde(default)]
    pub highwatermark: Option<i64>,
    #[serde(default)]
    pub lock_exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<TaskItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub subject: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// TS: `'pending' | 'in_progress' | 'completed'`. Kept as `String`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
}

// ─────────────────────────────────────────────────────────────────────────
// Plans
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub slug: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub size: u64,
}
