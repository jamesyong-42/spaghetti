//! NAPI orchestration — cold/warm `ingest` and live batch write.
//!
//! Wires [`crate::claude`] producers into the [`crate::core`] writer and
//! exposes the Node-facing API. No Claude layout knowledge beyond what
//! the Claude modules already own; this layer is mostly plumbing +
//! progress reporting.

pub mod ingest;
pub mod live_ingest;
