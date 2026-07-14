//! Claude Code agent source — layout discovery, parsers, typed messages.
//!
//! Everything here assumes `~/.claude` path shapes and Anthropic-style
//! JSONL envelopes. The multi-agent store/writer lives in [`crate::core`];
//! this module is the first (and currently only) producer for the native
//! cold/warm path.

/// On-disk fingerprint discovery + `source_files` store helpers.
///
/// The walk is Claude-layout-specific; `FingerprintStore` itself is a
/// thin SQLite accessor and is a candidate to lift into `core` in a
/// later phase if a second source needs the same table API.
pub mod fingerprint;
pub mod fts_text;
pub mod project_parser;
pub mod types;

pub use project_parser::ProjectParser;
