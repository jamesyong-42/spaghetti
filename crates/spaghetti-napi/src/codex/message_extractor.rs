//! Codex MessageExtractor — thin projection of one RolloutLine.
//!
//! Behaviour-aligned with `packages/sdk/src/sources/codex/message-extractor.ts`:
//! only `response_item` / `message` turns produce a projection; everything
//! else returns `None` (including token_count, which the reader handles).

use serde_json::Value;

/// FTS/preview text cap — matches Claude extractor + TS Codex.
const MAX_TEXT_LENGTH: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageProjection {
    pub msg_type: String,
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    pub fts_text: Option<String>,
}

fn truncate(text: &str) -> &str {
    if text.len() <= MAX_TEXT_LENGTH {
        return text;
    }
    let mut end = MAX_TEXT_LENGTH;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn extract_text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut parts: Vec<&str> = Vec::new();
    for block in arr {
        let Some(obj) = block.as_object() else { continue };
        let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(ty, "input_text" | "output_text" | "text") {
            if let Some(t) = obj.get("text").and_then(Value::as_str) {
                parts.push(t);
            }
        }
    }
    parts.join("\n")
}

/// Project one JSONL line. `Ok(None)` = not a chat message (skip).
pub fn project_jsonl_line(line: &str) -> Result<Option<MessageProjection>, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    let obj = match value.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };
    if obj.get("type").and_then(Value::as_str) != Some("response_item") {
        return Ok(None);
    }
    let payload = match obj.get("payload").and_then(Value::as_object) {
        Some(p) => p,
        None => return Ok(None),
    };
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return Ok(None);
    }
    let role = payload
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let text = payload
        .get("content")
        .map(extract_text)
        .unwrap_or_default();
    let fts = {
        let t = truncate(&text);
        if t.is_empty() {
            None
        } else {
            Some(t.to_owned())
        }
    };
    Ok(Some(MessageProjection {
        msg_type: role,
        uuid: payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        timestamp: obj
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned),
        fts_text: fts,
    }))
}

/// Parse `event_msg` / `token_count` → (input, output, cache_creation, cache_read).
/// Prefers `last_token_usage`; falls back to `total_token_usage`.
pub fn parse_token_count(line: &str) -> Option<(u64, u64, u64, u64)> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?.as_object()?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?.as_object()?;
    let map_usage = |raw: &Value| -> Option<(u64, u64, u64, u64)> {
        let o = raw.as_object()?;
        let pick = |k: &str| o.get(k).and_then(Value::as_u64).unwrap_or(0);
        let input = pick("input_tokens");
        let cached = pick("cached_input_tokens");
        let output = pick("output_tokens");
        let reasoning = pick("reasoning_output_tokens");
        Some((input, output + reasoning, 0, cached))
    };
    if let Some(last) = info.get("last_token_usage") {
        if let Some(u) = map_usage(last) {
            return Some(u);
        }
    }
    if let Some(total) = info.get("total_token_usage") {
        return map_usage(total);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_assistant_message() {
        let line = r#"{
          "timestamp":"2026-01-01T00:00:00.000Z",
          "type":"response_item",
          "payload":{
            "type":"message",
            "role":"assistant",
            "id":"msg_1",
            "content":[{"type":"output_text","text":"hello world"}]
          }
        }"#;
        let p = project_jsonl_line(line).unwrap().expect("message");
        assert_eq!(p.msg_type, "assistant");
        assert_eq!(p.uuid.as_deref(), Some("msg_1"));
        assert_eq!(p.fts_text.as_deref(), Some("hello world"));
    }

    #[test]
    fn skips_function_call() {
        let line = r#"{"type":"response_item","payload":{"type":"function_call","name":"shell"}}"#;
        assert!(project_jsonl_line(line).unwrap().is_none());
    }

    #[test]
    fn parses_token_count() {
        let line = r#"{
          "type":"event_msg",
          "payload":{
            "type":"token_count",
            "info":{
              "last_token_usage":{
                "input_tokens":10,
                "cached_input_tokens":2,
                "output_tokens":5,
                "reasoning_output_tokens":3,
                "total_tokens":20
              }
            }
          }
        }"#;
        let (i, o, c, r) = parse_token_count(line).unwrap();
        assert_eq!(i, 10);
        assert_eq!(o, 8); // 5+3
        assert_eq!(c, 0);
        assert_eq!(r, 2);
    }
}
