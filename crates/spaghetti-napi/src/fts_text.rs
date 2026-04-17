//! FTS text extraction — ported from the `extractTextContent` and
//! `truncate` helpers in `packages/sdk/src/data/ingest-service.ts`.
//!
//! Produces the blob stored in `messages.text_content` and fed to the FTS5
//! virtual table. Behavioural parity with TS is preserved — only
//! `user`, `assistant`, and `summary` variants contribute text; all other
//! variants yield an empty string.
//!
//! Populated in RFC 003 commit 1.6.

use crate::types::content::{
    AssistantContentBlock, ToolResultContent, UserContentBlock, UserMessageContent,
};
use crate::types::SessionMessage;

/// Maximum number of bytes of extracted text stored per message.
///
/// Matches the TS constant `MAX_TEXT_LENGTH = 2_000`. The TS version measures
/// this in JS string units (UTF-16 code units), but in practice the writer
/// simply passes the string to SQLite, which stores it as UTF-8 — so
/// truncating by bytes here is the pragmatic equivalent. Callers must pass
/// through `truncate` to honour this bound on UTF-8 boundaries.
pub const MAX_TEXT_LENGTH: usize = 2_000;

/// Truncate `text` to at most `MAX_TEXT_LENGTH` bytes, without splitting a
/// multi-byte UTF-8 codepoint. Returns a borrowed slice when possible.
///
/// If the naive byte cut would land inside a codepoint, the slice is
/// shortened to the nearest preceding char boundary.
pub fn truncate(text: &str) -> &str {
    if text.len() <= MAX_TEXT_LENGTH {
        return text;
    }
    let mut end = MAX_TEXT_LENGTH;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Extract searchable text content from a [`SessionMessage`] for FTS
/// indexing.
///
/// Handles:
/// - `user` messages: plain string content, or `UserContentBlock[]` where
///   `text` and `tool_result` blocks contribute text (tool_result content
///   may itself be a string or an array of text sub-blocks).
/// - `assistant` messages: `text` blocks contribute their text, `tool_use`
///   blocks contribute a marker of the form `[tool:NAME]`.
/// - `summary` messages: the `summary` field contributes directly.
///
/// All other variants (attachment, progress, system, saved_hook_context,
/// queue_operation, last_prompt, agent_name, custom_title, permission_mode,
/// pr_link, file_history_snapshot) return an empty string — matching the
/// TS behaviour where those discriminator values don't match any branch.
///
/// Parts are joined with `\n` and the result is clamped to
/// `MAX_TEXT_LENGTH` bytes via [`truncate`].
pub fn extract_message_text(msg: &SessionMessage) -> String {
    let mut parts: Vec<&str> = Vec::new();

    match msg {
        SessionMessage::User(user) => match &user.message.content {
            UserMessageContent::Text(s) => parts.push(s.as_str()),
            UserMessageContent::Blocks(blocks) => {
                for block in blocks {
                    match block {
                        UserContentBlock::Text(t) => parts.push(t.text.as_str()),
                        UserContentBlock::ToolResult(tr) => match &tr.content {
                            ToolResultContent::Text(s) => parts.push(s.as_str()),
                            ToolResultContent::Blocks(sub_blocks) => {
                                for sub in sub_blocks {
                                    // TS checks `type === 'text'` && `typeof text === 'string'`.
                                    if sub.kind == "text" {
                                        if let Some(t) = sub.text.as_deref() {
                                            parts.push(t);
                                        }
                                    }
                                }
                            }
                        },
                        // Image / Document blocks contribute no searchable text.
                        UserContentBlock::Image(_) | UserContentBlock::Document(_) => {}
                    }
                }
            }
        },
        SessionMessage::Assistant(asst) => {
            // We need owned strings for the `[tool:NAME]` markers, so
            // switch to an owned-strings accumulator for this branch.
            let mut owned: Vec<String> = Vec::new();
            for block in &asst.message.content {
                match block {
                    AssistantContentBlock::Text(t) => owned.push(t.text.clone()),
                    AssistantContentBlock::ToolUse(tu) => {
                        // TS: `if (toolName) textParts.push(`[tool:${toolName}]`);`
                        // — only emit when the name is non-empty.
                        if !tu.name.is_empty() {
                            owned.push(format!("[tool:{}]", tu.name));
                        }
                    }
                    // Thinking / RedactedThinking are excluded in TS.
                    AssistantContentBlock::Thinking(_)
                    | AssistantContentBlock::RedactedThinking(_) => {}
                }
            }
            return truncate(&owned.join("\n")).to_owned();
        }
        SessionMessage::Summary(summary) => {
            // TS: `if (summary) textParts.push(summary);` — push even though
            // the field is always a `String` in Rust (empty string joins to
            // empty and is a no-op after truncation).
            parts.push(summary.summary.as_str());
        }
        // All other variants contribute nothing to the FTS blob.
        SessionMessage::AgentName(_)
        | SessionMessage::Attachment(_)
        | SessionMessage::CustomTitle(_)
        | SessionMessage::FileHistorySnapshot(_)
        | SessionMessage::PrLink(_)
        | SessionMessage::Progress(_)
        | SessionMessage::PermissionMode(_)
        | SessionMessage::SavedHookContext(_)
        | SessionMessage::System(_)
        | SessionMessage::QueueOperation(_)
        | SessionMessage::LastPrompt(_) => {}
    }

    truncate(&parts.join("\n")).to_owned()
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SessionMessage;

    // ─── truncate ──────────────────────────────────────────────────────────

    #[test]
    fn truncate_short_text_is_unchanged() {
        let s = "hello world";
        assert_eq!(truncate(s), "hello world");
    }

    #[test]
    fn truncate_exactly_at_limit_is_unchanged() {
        let s = "a".repeat(MAX_TEXT_LENGTH);
        let out = truncate(&s);
        assert_eq!(out.len(), MAX_TEXT_LENGTH);
        assert_eq!(out, s.as_str());
    }

    #[test]
    fn truncate_oversized_ascii_cuts_at_limit() {
        let s = "b".repeat(MAX_TEXT_LENGTH + 100);
        let out = truncate(&s);
        assert_eq!(out.len(), MAX_TEXT_LENGTH);
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        // Construct a string where a naive byte cut at MAX_TEXT_LENGTH would
        // land in the middle of a multi-byte codepoint.
        //
        // '€' is 3 bytes in UTF-8 (E2 82 AC). Prefix with (MAX-1) ASCII bytes
        // so the '€' starts at byte index MAX-1, meaning naive slicing at
        // MAX would split it.
        let prefix = "a".repeat(MAX_TEXT_LENGTH - 1);
        let s = format!("{prefix}€tail");
        let out = truncate(&s);
        // The cut must back off to the preceding char boundary at MAX-1.
        assert_eq!(out.len(), MAX_TEXT_LENGTH - 1);
        assert_eq!(out, prefix.as_str());
        // And the output must still be valid UTF-8 / slicing must not have
        // panicked — implicit from returning a &str.
    }

    #[test]
    fn truncate_empty_is_empty() {
        assert_eq!(truncate(""), "");
    }

    // ─── extract_message_text ──────────────────────────────────────────────

    // Shared BaseMessageFields JSON fragment to keep fixtures compact.
    const BASE: &str = r#"
        "uuid": "u1",
        "timestamp": "2024-01-01T00:00:00Z",
        "sessionId": "s1",
        "cwd": "/tmp",
        "version": "1",
        "gitBranch": "main",
        "isSidechain": false,
        "userType": "external"
    "#;

    #[test]
    fn extract_user_plain_string_content() {
        let json = format!(
            r#"{{
                "type": "user",
                {BASE},
                "message": {{
                    "role": "user",
                    "content": "hello there"
                }}
            }}"#
        );
        let msg: SessionMessage = serde_json::from_str(&json).expect("parse user plain");
        assert_eq!(extract_message_text(&msg), "hello there");
    }

    #[test]
    fn extract_user_content_blocks() {
        // Mix text + tool_result (string) + tool_result (array of text blocks)
        // + image (ignored).
        let json = format!(
            r#"{{
                "type": "user",
                {BASE},
                "message": {{
                    "role": "user",
                    "content": [
                        {{ "type": "text", "text": "first" }},
                        {{ "type": "tool_result", "tool_use_id": "t1", "content": "second" }},
                        {{ "type": "tool_result", "tool_use_id": "t2", "content": [
                            {{ "type": "text", "text": "third" }},
                            {{ "type": "image", "source": {{}} }},
                            {{ "type": "text", "text": "fourth" }}
                        ]}},
                        {{ "type": "image", "source": {{
                            "type": "base64", "media_type": "image/png", "data": "AA=="
                        }}}}
                    ]
                }}
            }}"#
        );
        let msg: SessionMessage = serde_json::from_str(&json).expect("parse user blocks");
        assert_eq!(extract_message_text(&msg), "first\nsecond\nthird\nfourth");
    }

    #[test]
    fn extract_assistant_mixed_text_and_tool_use() {
        // Plus a thinking block that must be ignored.
        let json = format!(
            r#"{{
                "type": "assistant",
                {BASE},
                "requestId": "r1",
                "message": {{
                    "model": "claude-sonnet",
                    "id": "m1",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {{ "type": "thinking", "thinking": "hidden" }},
                        {{ "type": "text", "text": "reasoning output" }},
                        {{ "type": "tool_use", "id": "tu1", "name": "Read", "input": {{"path": "/x"}} }},
                        {{ "type": "text", "text": "done" }}
                    ],
                    "stop_reason": "end_turn",
                    "usage": {{
                        "input_tokens": 10,
                        "output_tokens": 20,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0
                    }}
                }}
            }}"#
        );
        let msg: SessionMessage = serde_json::from_str(&json).expect("parse assistant");
        assert_eq!(
            extract_message_text(&msg),
            "reasoning output\n[tool:Read]\ndone"
        );
    }

    #[test]
    fn extract_summary_message() {
        let json = r#"{
            "type": "summary",
            "summary": "this is the summary text",
            "leafUuid": "leaf-1"
        }"#;
        let msg: SessionMessage = serde_json::from_str(json).expect("parse summary");
        assert_eq!(extract_message_text(&msg), "this is the summary text");
    }

    #[test]
    fn extract_truncates_long_output() {
        // Build a user message whose plain-string content exceeds the cap.
        let big = "x".repeat(MAX_TEXT_LENGTH + 500);
        let json = format!(
            r#"{{
                "type": "user",
                {BASE},
                "message": {{
                    "role": "user",
                    "content": {big:?}
                }}
            }}"#
        );
        let msg: SessionMessage = serde_json::from_str(&json).expect("parse big user");
        let out = extract_message_text(&msg);
        assert_eq!(out.len(), MAX_TEXT_LENGTH);
        assert!(out.chars().all(|c| c == 'x'));
    }
}
