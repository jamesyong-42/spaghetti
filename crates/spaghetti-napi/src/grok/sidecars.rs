//! Grok sidecar enrichment — timestamps (events.jsonl) + session tokens (signals.json).
//!
//! Behaviour-aligned with `packages/sdk/src/sources/grok/sidecars.ts`.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

/// Absolute chat_history line index → ISO timestamp.
pub type TimestampMap = HashMap<u32, String>;

#[derive(Debug, Clone, Default)]
pub struct GrokSignals {
    pub context_tokens_used: u64,
}

/// Parse events.jsonl text into (type, ts, conversation_message_count?) triples.
fn parse_events(text: &str) -> Vec<(String, String, Option<u32>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
        let ts = v.get("ts").and_then(Value::as_str).unwrap_or("").to_owned();
        if ty.is_empty() || ts.is_empty() {
            continue;
        }
        let count = v
            .get("conversation_message_count")
            .and_then(Value::as_u64)
            .map(|n| n as u32);
        out.push((ty, ts, count));
    }
    out
}

/// Collect `type` for each non-empty chat_history line.
pub fn collect_line_types(chat_text: &str) -> Vec<String> {
    let mut types = Vec::new();
    for line in chat_text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => types.push(
                v.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
            ),
            Err(_) => types.push("unknown".into()),
        }
    }
    types
}

/// Build absolute-line-index → timestamp map (mirrors TS `buildTimestampMap`).
pub fn build_timestamp_map(
    line_types: &[String],
    events_text: &str,
    fallback_created: Option<&str>,
) -> TimestampMap {
    let events = parse_events(events_text);
    let mut map: TimestampMap = HashMap::new();

    // 1) turn_started with conversation_message_count → user at that index.
    for (ty, ts, count) in &events {
        if ty != "turn_started" {
            continue;
        }
        if let Some(mut idx) = *count {
            while (idx as usize) < line_types.len() && line_types[idx as usize] != "user" {
                idx += 1;
            }
            if (idx as usize) < line_types.len() {
                map.entry(idx).or_insert_with(|| ts.clone());
            }
        }
    }

    let leftover_turns: Vec<&str> = events
        .iter()
        .filter(|(t, _, _)| t == "turn_started")
        .map(|(_, ts, _)| ts.as_str())
        .collect();
    let stamped_users = map
        .keys()
        .filter(|&&i| line_types.get(i as usize).map(|s| s.as_str()) == Some("user"))
        .count();
    let mut turn_i = stamped_users.min(leftover_turns.len());

    let loop_starts: Vec<&str> = events
        .iter()
        .filter(|(t, _, _)| t == "loop_started")
        .map(|(_, ts, _)| ts.as_str())
        .collect();
    let first_tokens: Vec<&str> = events
        .iter()
        .filter(|(t, _, _)| t == "first_token")
        .map(|(_, ts, _)| ts.as_str())
        .collect();
    let mut loop_i = 0usize;
    let mut first_i = 0usize;

    for (i, t) in line_types.iter().enumerate() {
        let idx = i as u32;
        if map.contains_key(&idx) {
            continue;
        }
        match t.as_str() {
            "system" => {
                if let Some(fb) = fallback_created {
                    map.insert(idx, fb.to_owned());
                }
            }
            "user" => {
                if turn_i < leftover_turns.len() {
                    map.insert(idx, leftover_turns[turn_i].to_owned());
                    turn_i += 1;
                } else if let Some(fb) = fallback_created {
                    map.insert(idx, fb.to_owned());
                }
            }
            "reasoning" => {
                if loop_i < loop_starts.len() {
                    map.insert(idx, loop_starts[loop_i].to_owned());
                    loop_i += 1;
                } else if first_i < first_tokens.len() {
                    map.insert(idx, first_tokens[first_i].to_owned());
                    first_i += 1;
                }
            }
            "assistant" => {
                if first_i < first_tokens.len() {
                    map.insert(idx, first_tokens[first_i].to_owned());
                    first_i += 1;
                }
            }
            _ => {}
        }
    }

    map
}

pub fn parse_signals(text: &str) -> Option<GrokSignals> {
    let v: Value = serde_json::from_str(text).ok()?;
    let used = v
        .get("contextTokensUsed")
        .or_else(|| v.get("context_tokens_used"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if used == 0 {
        return None;
    }
    Some(GrokSignals {
        context_tokens_used: used,
    })
}

/// Load timestamp map + signals from sibling files next to chat_history.
pub fn load_sidecars(
    chat_history: &Path,
    fallback_created: Option<&str>,
) -> (TimestampMap, Option<GrokSignals>, Vec<String>) {
    let session_dir = match chat_history.parent() {
        Some(p) => p,
        None => return (HashMap::new(), None, Vec::new()),
    };

    let chat_text = std::fs::read_to_string(chat_history).unwrap_or_default();
    let line_types = collect_line_types(&chat_text);

    let events_text =
        std::fs::read_to_string(session_dir.join("events.jsonl")).unwrap_or_default();
    let ts_map = build_timestamp_map(&line_types, &events_text, fallback_created);

    let signals = std::fs::read_to_string(session_dir.join("signals.json"))
        .ok()
        .and_then(|t| parse_signals(&t));

    (ts_map, signals, line_types)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_turn_and_token_timestamps() {
        let types = vec![
            "system".into(),
            "user".into(),
            "reasoning".into(),
            "assistant".into(),
            "tool_result".into(),
            "assistant".into(),
        ];
        let events = r#"
{"ts":"2026-04-01T10:00:00.000Z","type":"turn_started","conversation_message_count":1}
{"ts":"2026-04-01T10:00:01.000Z","type":"loop_started"}
{"ts":"2026-04-01T10:00:02.000Z","type":"first_token"}
{"ts":"2026-04-01T10:00:05.000Z","type":"first_token"}
"#;
        let map = build_timestamp_map(&types, events, Some("2026-04-01T09:00:00.000Z"));
        assert_eq!(map.get(&0).map(String::as_str), Some("2026-04-01T09:00:00.000Z")); // system fallback
        assert_eq!(map.get(&1).map(String::as_str), Some("2026-04-01T10:00:00.000Z")); // user
        assert_eq!(map.get(&2).map(String::as_str), Some("2026-04-01T10:00:01.000Z")); // reasoning
        assert_eq!(map.get(&3).map(String::as_str), Some("2026-04-01T10:00:02.000Z")); // assistant
        assert_eq!(map.get(&5).map(String::as_str), Some("2026-04-01T10:00:05.000Z")); // 2nd assistant
        assert!(!map.contains_key(&4)); // tool_result skipped
    }

    #[test]
    fn parses_signals_context_tokens() {
        let s = parse_signals(r#"{"contextTokensUsed":106352,"contextWindowTokens":500000}"#).unwrap();
        assert_eq!(s.context_tokens_used, 106352);
    }
}
