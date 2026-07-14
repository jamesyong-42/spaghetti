//! Source-agnostic ingest core: I/O, schema, event bus, SQLite writer.
//!
//! These modules do not know Claude Code's on-disk layout or Anthropic
//! message envelopes. Producers (today: [`crate::claude`]) push
//! [`event::IngestEvent`]s; the writer commits them into the shared store.
//!
//! Phase A keeps Claude-shaped *payload types* on some event variants
//! (subagent, todo, …) — those live under [`crate::claude::types`] and
//! will thin out as more sources land.

pub mod event;
pub mod jsonl;
pub mod schema;
pub mod writer;

pub use event::IngestEvent;
pub use jsonl::{read_jsonl_streaming, JsonlError, StreamingResult};
