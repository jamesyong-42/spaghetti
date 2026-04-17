# small/ — canonical small fixture

A deterministic, committed mini `~/.claude` directory used by the
**Rust-ingest correctness gate** (RFC 003 commit 1.8 — `pnpm test:ingest-diff`).

The diff harness in `scripts/ingest-diff.ts` runs both the TS ingest
(`@vibecook/spaghetti-sdk`) and the Rust ingest
(`@vibecook/spaghetti-sdk-native`) against this fixture and requires zero
semantic diffs between the resulting SQLite databases.

## Generating / regenerating

```bash
rm -rf crates/spaghetti-napi/fixtures/small
node scripts/generate-ingest-fixture.mjs \
  --out crates/spaghetti-napi/fixtures/small \
  --seed 42
```

The generator is deterministic per (`--out`, `--seed`) pair. Regeneration is
safe: re-running with the same flags produces byte-for-byte identical files.
File mtimes are pinned to `2026-04-01T00:00:00Z` so `git status` stays clean
across regenerations.

Do not edit files under `.claude/` by hand — they will drift from the
generator and any diff-harness failure will be confusing to track down.
Always change the generator, then regenerate.

## What's in here

Three projects, 13 sessions, ~194 messages, ~200 KB on disk.

| Project slug            | Sessions | Notable artifacts                                       |
|-------------------------|---------:|---------------------------------------------------------|
| `-Users-test-project1`  |   3–5    | `memory/MEMORY.md`, todos entry (`todos/…`)             |
| `-Users-test-project2`  |   3–5    | subagent transcript, tool-result `.txt` files, task    |
| `-Users-test-project3`  |   2–4    | file-history snapshot                                   |

Each session JSONL mixes `user`, `assistant` (text + `tool_use`),
`thinking`, `summary`, and `tool_result` messages — exercising every
fts_text branch and the token-usage extraction path.

Claude-level directories under `.claude/`:

- `projects/<slug>/sessions-index.json` — real index with one entry per JSONL
- `projects/<slug>/<session>.jsonl` — session messages
- `projects/<slug>/memory/MEMORY.md` — project 1 only
- `projects/<slug>/<session>/subagents/agent-a*.jsonl` — project 2 only
- `projects/<slug>/<session>/tool-results/<tool_use_id>.txt` — project 2 only
- `todos/<session>-agent-<agent>.json` — project 1, one session
- `tasks/<session>/.lock` + `.highwatermark` — project 2, one session
- `file-history/<session>/<hash>@v<version>` — project 3, one session

## Deliberately omitted

The small fixture skips a couple of artifact types to keep the diff harness
clean against the Phase 1 Rust port:

- **`plans/` directory.** The Rust `project_parser.rs` (commit 1.7) does not
  emit `IngestEvent::Plan`. Adding plan files would show up as TS-only rows
  in the `plans` table and fail the diff. Plans land in a later commit.
- **Multi-version `file-history` snapshots.** `readdir` ordering is not
  portable across filesystems / platforms, and the TS and Rust parsers store
  snapshots in the order `readdir` yields them. A single snapshot per
  session side-steps a spurious order-only diff. If the schema grows a stable
  sort key we can revisit.
- **Legacy `source_files` fingerprints.** The Rust Phase 1 writer doesn't
  populate `source_files`; the TS `saveAllFingerprints()` path does. The
  diff harness ignores that table entirely.

These omissions are documented in `scripts/ingest-diff.ts` as well.
