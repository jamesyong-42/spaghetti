//! NAPI-RS bindings for the spaghetti ingest core.
//!
//! This crate is the Rust side of `@vibecook/spaghetti-sdk-native`. It
//! currently exposes only a version accessor used to verify that the native
//! addon loads correctly. The ingest pipeline (RFC 003, Phase 1+) will land
//! in subsequent commits.

use napi_derive::napi;

/// Returns the semver of the native addon.
///
/// Used as a smoke test during Phase 0 to confirm the addon loads and
/// NAPI bindings work end-to-end on each platform.
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
