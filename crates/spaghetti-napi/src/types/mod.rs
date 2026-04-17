//! Rust mirrors of the core SDK types used during ingest.
//!
//! Populated in RFC 003 commit 1.2. Ports the TS shapes that the ingest
//! pipeline actually reads from `packages/sdk/src/types/`. Skipped everything
//! not needed for ingest (hook events, channel messages, query result types,
//! agent config/analytic aggregations, etc.).
//!
//! All JSONL payloads are lenient: unknown fields are accepted silently via
//! serde's default behaviour, and most optional fields use `#[serde(default)]`
//! so missing keys don't break deserialization.

pub mod artifacts;
pub mod content;
pub mod project;
pub mod session;

pub use artifacts::*;
pub use content::*;
pub use project::*;
pub use session::*;

#[cfg(test)]
mod tests;
