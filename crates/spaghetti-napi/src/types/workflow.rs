//! Workflow run record — TS `WorkflowRun` (types/index.ts).
//!
//! One agent-orchestration run at
//! `projects/{slug}/{sessionId}/workflows/{runId}.json`. Session-scoped;
//! its nested subagent transcripts group to it via
//! `SubagentTranscript.workflow_id`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub workflow_id: String,
    pub name: String,
    pub status: String,
    pub agent_count: f64,
    pub total_tokens: f64,
    pub total_tool_calls: f64,
    pub duration_ms: f64,
    pub subagent_count: f64,
    /// The full raw `{runId}.json` run record.
    pub data: Value,
    /// Parsed `journal.jsonl` entries (started/result events).
    #[serde(default)]
    pub journal: Vec<Value>,
}
