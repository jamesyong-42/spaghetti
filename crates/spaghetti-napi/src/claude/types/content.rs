//! Content blocks for assistant/user message payloads.
//!
//! Mirrors the TS discriminated unions `AssistantContentBlock` and
//! `UserContentBlock` from `packages/sdk/src/types/projects.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─────────────────────────────────────────────────────────────────────────
// Assistant content blocks
// ─────────────────────────────────────────────────────────────────────────

/// One block inside an assistant message's `content` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantContentBlock {
    Thinking(ThinkingBlock),
    RedactedThinking(RedactedThinkingBlock),
    Text(AssistantTextBlock),
    ToolUse(ToolUseBlock),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingBlock {
    pub thinking: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedactedThinkingBlock {
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantTextBlock {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUseBlock {
    pub id: String,
    /// Tool name. TS narrows to a union incl. `mcp__${string}`, but the
    /// ingest pipeline only reads it as a string, so we keep it as `String`.
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

// ─────────────────────────────────────────────────────────────────────────
// User content blocks
// ─────────────────────────────────────────────────────────────────────────

/// One block inside a user message's `content` array (when it's an array
/// rather than a bare string).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserContentBlock {
    ToolResult(ToolResultBlock),
    Text(UserTextBlock),
    Document(DocumentBlock),
    Image(ImageBlock),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserTextBlock {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ToolResultBlock {
    pub tool_use_id: String,
    pub content: ToolResultContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// Tool result content is either a bare string or an array of text-like
/// blocks. TS: `string | Array<{ type: string; text?: string; ... }>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<ToolResultSubBlock>),
}

/// One element of a `ToolResultBlock` array content. The TS shape uses
/// `type: string` rather than a fixed union, so we keep the type as a
/// free-form string and stash anything extra into `extra` via flatten.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultSubBlock {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentBlock {
    pub source: Base64Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBlock {
    pub source: Base64Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Base64Source {
    /// TS: `'base64'`, kept as `String` to tolerate future variants.
    #[serde(rename = "type")]
    pub kind: String,
    pub media_type: String,
    pub data: String,
}

// ─────────────────────────────────────────────────────────────────────────
// User message payload & helpers
// ─────────────────────────────────────────────────────────────────────────

/// Payload inside a user message — TS `UserMessagePayload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessagePayload {
    /// TS literal `'user'`; kept as `String` to avoid a single-variant enum.
    pub role: String,
    pub content: UserMessageContent,
}

/// TS `string | UserContentBlock[]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserMessageContent {
    Text(String),
    Blocks(Vec<UserContentBlock>),
}

/// Payload inside an assistant message — TS `AssistantMessagePayload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AssistantMessagePayload {
    pub model: String,
    pub id: String,
    /// Always literal `'message'` in TS; kept as `String` for forward compat.
    #[serde(rename = "type")]
    pub kind: String,
    pub role: String,
    #[serde(default)]
    pub content: Vec<AssistantContentBlock>,
    /// TS union: `'end_turn' | 'tool_use' | 'stop_sequence' | 'max_tokens' | null`.
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
    pub usage: TokenUsage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_management: Option<ContextManagement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<Value>,
}

// ─────────────────────────────────────────────────────────────────────────
// Token usage
// ─────────────────────────────────────────────────────────────────────────

/// Matches TS `TokenUsage`. Field names are deliberately snake_case because
/// the Anthropic API emits them that way.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation: Option<CacheCreationTokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference_geo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_tool_use: Option<ServerToolUse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheCreationTokens {
    #[serde(default)]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    pub ephemeral_1h_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServerToolUse {
    #[serde(default)]
    pub web_search_requests: u64,
    #[serde(default)]
    pub web_fetch_requests: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextManagement {
    #[serde(default)]
    pub applied_edits: Vec<Value>,
}
