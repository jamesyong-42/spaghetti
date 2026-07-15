# small-grok/ — canonical small Grok fixture

A deterministic mini `~/.grok` tree used by the **Grok native cold-ingest
correctness gate** (`pnpm test:ingest-diff:grok`).

The harness in `scripts/ingest-diff.ts` runs both the TS ingest
(`GrokReader` via `@vibecook/spaghetti-sdk`) and the Rust ingest
(`@vibecook/spaghetti-sdk-native` with `sourceId: 'grok'`) against
`.grok/` and requires zero semantic diffs between the resulting SQLite
databases.

## Generating / regenerating

```bash
rm -rf crates/spaghetti-napi/fixtures/small-grok
node scripts/generate-grok-fixture.mjs \
  --out crates/spaghetti-napi/fixtures/small-grok
```

File mtimes are pinned to `2026-04-01T00:00:00Z` so `file_mtime` matches
across engines and regenerations stay git-stable.

Do not edit files under `.grok/` by hand — always change the generator,
then regenerate.

## What's in here

Three projects, four sessions, mixed conversational turns + tool I/O to skip.

| Project slug | Sessions | Notable content |
|---|---:|---|
| `-tmp-grok-proj-a` | 2 | system/user/assistant/reasoning + `tool_result` skip |
| `-tmp-grok-proj-b` | 1 | multi-block user text, `backend_tool_call` skip |
| `-Users-test-grok-long` | 1 | 2500-char assistant line (FTS truncate at 2000) |

Layout per session:

```text
.grok/sessions/<url-encoded-cwd>/<session-uuid>/
  chat_history.jsonl   ← canonical transcript (only file ingested as messages)
  summary.json         ← cwd / id / title / times / branch
  signals.json         ← noise (ignored by cold v1 reader)
  updates.jsonl        ← noise (ignored)
```
