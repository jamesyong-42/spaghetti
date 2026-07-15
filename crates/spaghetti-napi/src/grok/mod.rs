//! Grok CLI (xAI) source — native cold/warm ingest.
//!
//! Layout: `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/chat_history.jsonl`
//! with sibling `summary.json` for cwd / id / title / times. Conversational
//! turns (`system`/`user`/`assistant`/`reasoning`) become message rows; tool
//! I/O lines are skipped at extraction.

pub mod message_extractor;
pub mod reader;

pub use message_extractor::{project_jsonl_line, MessageProjection};
pub use reader::GrokReader;
