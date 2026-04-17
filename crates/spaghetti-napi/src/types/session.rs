//! SessionMessage enum and its variants.
//!
//! Mirrors the TS `SessionMessage` discriminated union from
//! `packages/sdk/src/types/projects.ts`. The outer discriminator is the
//! `type` field. Some variants (e.g. `user`, `assistant`, attachment, system,
//! progress) also carry the `BaseMessageFields` — we flatten those via a
//! shared struct referenced from each variant.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::content::{AssistantMessagePayload, UserMessagePayload};

// ─────────────────────────────────────────────────────────────────────────
// SessionMessage (outer discriminated union)
// ─────────────────────────────────────────────────────────────────────────

/// One line of a session JSONL file. TS `SessionMessage`.
///
/// Uses `#[serde(tag = "type")]` to dispatch on the `type` field. Unknown
/// types would fail to deserialize — callers in the ingest pipeline wrap
/// per-line parsing in error handlers, so that's acceptable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SessionMessage {
    AgentName(AgentNameMessage),
    Attachment(AttachmentMessage),
    CustomTitle(CustomTitleMessage),
    FileHistorySnapshot(FileHistorySnapshotMessage),
    PrLink(PrLinkMessage),
    Progress(ProgressMessage),
    PermissionMode(PermissionModeMessage),
    #[serde(rename = "saved_hook_context")]
    SavedHookContext(SavedHookContextMessage),
    User(UserMessage),
    Assistant(AssistantMessage),
    #[serde(rename = "system")]
    System(SystemMessage),
    #[serde(rename = "summary")]
    Summary(SummaryMessage),
    QueueOperation(QueueOperationMessage),
    LastPrompt(LastPromptMessage),
}

// ─────────────────────────────────────────────────────────────────────────
// Shared BaseMessageFields — flattened into variants that include it
// ─────────────────────────────────────────────────────────────────────────

/// Fields shared by JSONL lines that live inside a threaded conversation.
/// TS `BaseMessageFields`. Included via `#[serde(flatten)]` in the variants
/// that need it (user, assistant, attachment, progress, system, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseMessageFields {
    pub uuid: String,
    #[serde(default)]
    pub parent_uuid: Option<String>,
    pub timestamp: String,
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub git_branch: String,
    #[serde(default)]
    pub is_sidechain: bool,
    /// TS literal `'external'`; kept as `String` for forward compat.
    #[serde(default)]
    pub user_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: agent-name
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNameMessage {
    pub agent_name: String,
    pub session_id: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: custom-title
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTitleMessage {
    pub custom_title: String,
    pub session_id: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: permission-mode
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeMessage {
    pub permission_mode: String,
    pub session_id: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: pr-link
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLinkMessage {
    pub session_id: String,
    pub pr_number: u64,
    pub pr_url: String,
    pub pr_repository: String,
    pub timestamp: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: attachment
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    pub attachment: AttachmentPayload,
}

/// Catch-all attachment payload. TS uses a loose shape with `[key: string]:
/// unknown`, so we only type the fields we care about and stash the rest in
/// `extra` via `serde(flatten)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_name: Option<String>,
    #[serde(default, rename = "toolUseID", skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, Value>,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: file-history-snapshot
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistorySnapshotMessage {
    pub message_id: String,
    #[serde(default)]
    pub is_snapshot_update: bool,
    pub snapshot: FileHistorySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistorySnapshot {
    pub message_id: String,
    pub timestamp: String,
    #[serde(default)]
    pub tracked_file_backups: std::collections::HashMap<String, FileBackupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBackupEntry {
    pub backup_file_name: Option<String>,
    pub version: u64,
    pub backup_time: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: user
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    pub message: UserMessagePayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_metadata: Option<ThinkingMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todos: Option<Vec<TodoItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_result: Option<ToolUseResult>,
    #[serde(
        default,
        rename = "sourceToolAssistantUUID",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_tool_assistant_uuid: Option<String>,
    #[serde(
        default,
        rename = "sourceToolUseID",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_meta: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_compact_summary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_visible_in_transcript_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_paste_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_thinking_tokens: Option<u64>,
}

/// Inline todo item — matches TS `TodoItem` inside a `UserMessage`.
/// The standalone `TodoFile` items have the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    /// TS: `'pending' | 'in_progress' | 'completed'`. Kept as `String`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// TS `toolUseResult?: string | ToolUseResultObject`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolUseResult {
    Text(String),
    Object(ToolUseResultObject),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseResultObject {
    /// TS literal `'text'`; kept as `String` for forward compat.
    #[serde(rename = "type")]
    pub kind: String,
    pub file: ToolUseResultFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseResultFile {
    pub file_path: String,
    pub content: String,
    pub num_lines: u64,
    pub start_line: u64,
    pub total_lines: u64,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: assistant
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    pub request_id: String,
    pub message: AssistantMessagePayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_api_error_message: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: system
// ─────────────────────────────────────────────────────────────────────────

/// System messages carry a `subtype` field that further discriminates them.
/// We flatten `BaseMessageFields` in, then tag on `subtype`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_meta: Option<bool>,
    #[serde(flatten)]
    pub payload: SystemMessagePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemMessagePayload {
    StopHookSummary(StopHookSummary),
    TurnDuration(TurnDuration),
    ApiError(ApiErrorPayload),
    CompactBoundary(CompactBoundary),
    MicrocompactBoundary(MicrocompactBoundary),
    LocalCommand(LocalCommand),
    BridgeStatus(BridgeStatus),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopHookSummary {
    #[serde(default)]
    pub hook_count: u64,
    #[serde(default)]
    pub hook_infos: Vec<HookInfo>,
    #[serde(default)]
    pub hook_errors: Vec<Value>,
    #[serde(default)]
    pub prevented_continuation: bool,
    #[serde(default)]
    pub stop_reason: String,
    #[serde(default)]
    pub has_output: bool,
    #[serde(default, rename = "toolUseID")]
    pub tool_use_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInfo {
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDuration {
    #[serde(default)]
    pub duration_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorPayload {
    #[serde(default)]
    pub cause: Value,
    #[serde(default)]
    pub error: Value,
    #[serde(default)]
    pub retry_in_ms: f64,
    #[serde(default)]
    pub retry_attempt: u64,
    #[serde(default)]
    pub max_retries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactBoundary {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub logical_parent_uuid: String,
    pub compact_metadata: CompactMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactMetadata {
    #[serde(default)]
    pub trigger: String,
    #[serde(default, rename = "preTokens")]
    pub pre_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrocompactBoundary {
    #[serde(default)]
    pub content: String,
    pub microcompact_metadata: MicrocompactMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrocompactMetadata {
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub pre_tokens: u64,
    #[serde(default)]
    pub tokens_saved: u64,
    #[serde(default)]
    pub compacted_tool_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCommand {
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: progress
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    pub data: ProgressData,
    #[serde(default, rename = "toolUseID")]
    pub tool_use_id: String,
    #[serde(default, rename = "parentToolUseID")]
    pub parent_tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgressData {
    HookProgress(HookProgress),
    BashProgress(BashProgress),
    AgentProgress(AgentProgress),
    McpProgress(McpProgress),
    QueryUpdate(QueryUpdate),
    SearchResultsReceived(SearchResultsReceived),
    WaitingForTask(WaitingForTask),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookProgress {
    #[serde(default)]
    pub hook_event: String,
    #[serde(default)]
    pub hook_name: String,
    #[serde(default)]
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashProgress {
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub full_output: String,
    #[serde(default)]
    pub elapsed_time_seconds: f64,
    #[serde(default)]
    pub total_lines: u64,
}

/// AgentProgress.message is a nested user/assistant snapshot; we keep it as
/// raw JSON since ingest doesn't introspect it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProgress {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub normalized_messages: Vec<Value>,
    #[serde(default)]
    pub message: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProgress {
    #[serde(default)]
    pub server_name: String,
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_time_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryUpdate {
    #[serde(default)]
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultsReceived {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub result_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingForTask {
    #[serde(default)]
    pub task_description: String,
    #[serde(default)]
    pub task_type: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: saved_hook_context
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHookContextMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    #[serde(default)]
    pub content: Vec<String>,
    #[serde(default)]
    pub hook_name: String,
    #[serde(default)]
    pub hook_event: String,
    #[serde(default, rename = "toolUseID")]
    pub tool_use_id: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: summary
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryMessage {
    pub summary: String,
    pub leaf_uuid: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: queue-operation
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueOperationMessage {
    /// TS: `'enqueue' | 'dequeue' | 'popAll' | 'remove'`. Kept as `String`.
    pub operation: String,
    pub timestamp: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Variant: last-prompt
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPromptMessage {
    #[serde(flatten)]
    pub base: BaseMessageFields,
    pub last_prompt: String,
}
