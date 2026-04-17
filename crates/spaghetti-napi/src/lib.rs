//! NAPI-RS bindings for the spaghetti ingest core.
//!
//! This crate is the Rust side of `@vibecook/spaghetti-sdk-native`. It
//! hosts the ingest pipeline (RFC 003): streaming JSONL readers, SQLite
//! schema + writer, project parser, FTS text extraction, and the NAPI
//! `ingest()` entry point.
//!
//! During Phase 1 most modules are being ported from the existing
//! TypeScript implementation in `packages/sdk/src/`. Incomplete modules
//! are still declared here so the crate compiles at every commit.

// Dead code is expected until Phase 1 finishes wiring the orchestrator.
#![allow(dead_code)]

use napi_derive::napi;

pub mod fingerprint;
pub mod fts_text;
pub mod ingest;
pub mod jsonl_reader;
pub mod parse_sink;
pub mod project_parser;
pub mod schema;
pub mod types;
pub mod writer;

/// Returns the semver of the native addon.
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
