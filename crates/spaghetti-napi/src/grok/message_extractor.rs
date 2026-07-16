//! Grok MessageExtractor — thin projection of one chat_history.jsonl line.
//!
//! Behaviour-aligned with `packages/sdk/src/sources/grok/message-extractor.ts`:
//! keep conversational turns (`system` / `user` / `assistant` / `reasoning`);
//! skip tool I/O (`tool_result` / `backend_tool_call`) and unknowns.

use serde_json::Value;

use crate::core::text::truncate_utf16;

/// FTS/preview text cap in UTF-16 code units — matches the other extractors.
const MAX_TEXT_LENGTH: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageProjection {
    pub msg_type: String,
    pub uuid: Option<String>,
    /// Flattened, truncated FTS/preview text. Empty string when no prose.
    pub fts_text: String,
}

fn truncate(text: &str) -> &str {
    truncate_utf16(text, MAX_TEXT_LENGTH)
}

/// Collect readable text from a bare string or an array of `{ text }` blocks
/// (`type: 'text' | 'summary_text'`, etc.).
fn collect_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_owned();
    }
    let Some(arr) = value.as_array() else {
        return String::new();
    };
    let mut parts: Vec<&str> = Vec::new();
    for block in arr {
        if let Some(t) = block.get("text").and_then(Value::as_str) {
            parts.push(t);
        }
    }
    parts.join("\n")
}

/// Project one JSONL line. `Ok(None)` = not a conversational message (skip).
pub fn project_jsonl_line(line: &str) -> Result<Option<MessageProjection>, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");

    let (text_src, uuid) = match ty {
        "system" | "user" | "assistant" => {
            let text = obj.get("content").map(collect_text).unwrap_or_default();
            (text, None)
        }
        "reasoning" => {
            let text = obj.get("summary").map(collect_text).unwrap_or_default();
            let uuid = obj.get("id").and_then(Value::as_str).map(str::to_owned);
            (text, uuid)
        }
        // tool_result / backend_tool_call / unknown
        _ => return Ok(None),
    };

    Ok(Some(MessageProjection {
        msg_type: ty.to_owned(),
        uuid,
        fts_text: truncate(&text_src).to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_system_string_content() {
        let line = r#"{"type":"system","content":"You are Grok."}"#;
        let p = project_jsonl_line(line).unwrap().expect("system");
        assert_eq!(p.msg_type, "system");
        assert_eq!(p.fts_text, "You are Grok.");
        assert!(p.uuid.is_none());
    }

    #[test]
    fn extracts_user_block_array() {
        let line = r#"{"type":"user","content":[{"type":"text","text":"hello grok"}]}"#;
        let p = project_jsonl_line(line).unwrap().expect("user");
        assert_eq!(p.msg_type, "user");
        assert_eq!(p.fts_text, "hello grok");
    }

    #[test]
    fn extracts_assistant_string() {
        let line = r#"{"type":"assistant","content":"I'll look.","tool_calls":[]}"#;
        let p = project_jsonl_line(line).unwrap().expect("assistant");
        assert_eq!(p.msg_type, "assistant");
        assert_eq!(p.fts_text, "I'll look.");
    }

    #[test]
    fn extracts_reasoning_summary() {
        let line = r#"{
          "type":"reasoning",
          "id":"rs_1",
          "summary":[{"type":"summary_text","text":"thinking aloud"}],
          "encrypted_content":"xxx"
        }"#;
        let p = project_jsonl_line(line).unwrap().expect("reasoning");
        assert_eq!(p.msg_type, "reasoning");
        assert_eq!(p.fts_text, "thinking aloud");
        assert_eq!(p.uuid.as_deref(), Some("rs_1"));
    }

    #[test]
    fn skips_tool_result() {
        let line = r#"{"type":"tool_result","tool_call_id":"c1","content":"a/\nb/"}"#;
        assert!(project_jsonl_line(line).unwrap().is_none());
    }

    #[test]
    fn skips_backend_tool_call() {
        let line = r#"{"type":"backend_tool_call","kind":{"tool_type":"web_search"}}"#;
        assert!(project_jsonl_line(line).unwrap().is_none());
    }

    #[test]
    fn truncates_long_text() {
        let long = "x".repeat(3_000);
        let line = format!(r#"{{"type":"assistant","content":"{long}"}}"#);
        let p = project_jsonl_line(&line).unwrap().expect("assistant");
        assert_eq!(p.fts_text.len(), MAX_TEXT_LENGTH);
    }
}
