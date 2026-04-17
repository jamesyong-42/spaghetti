//! Fingerprint diff — populated in RFC 003 commit 3.1.
//!
//! Compares on-disk state of `<claude_dir>` against `source_files`
//! fingerprints stored during the last ingest, producing the
//! added / modified / deleted change set that drives the warm-start
//! incremental ingest.
