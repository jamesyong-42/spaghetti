//! NAPI orchestration — cold/warm `ingest` and live batch write.
//!
//! Wires [`crate::claude`] producers into the [`crate::core`] writer and
//! exposes the Node-facing API. No Claude layout knowledge beyond what
//! the Claude modules already own; this layer is mostly plumbing +
//! progress reporting.
//!
//! # Concurrency contract (DEFERRED — caller-enforced)
//!
//! [`ingest::ingest`] and [`live_ingest`]'s `live_ingest_batch` are **not**
//! internally serialized against each other on the same `db_path`. Callers
//! must not run a cold/warm `ingest` and a live batch write concurrently
//! against the same database: `ingest` flips `journal_mode` (WAL ⇄ MEMORY)
//! around its bulk phase, and a concurrent live writer on a different
//! journal_mode can error or corrupt the in-flight bulk transaction. The
//! desktop app already funnels both through one owner, so an in-process lock
//! is deferred rather than added here.

pub mod ingest;
pub mod live_ingest;
