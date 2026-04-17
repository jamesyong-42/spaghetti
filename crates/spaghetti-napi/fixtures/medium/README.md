# medium/ — rare-variant fixture

A deterministic, committed medium `~/.claude` directory used by the
**Rust-ingest correctness gate** (RFC 004 Item 1 — `pnpm test:ingest-diff:medium`).

Where the small fixture covers the hot path (`user` / `assistant` / `summary`
with `text` / `tool_use` / `thinking` content blocks), this one exercises
every rare `SessionMessage` variant and content-block shape the Rust types
support — so that a broken deserializer for `progress`, `attachment`,
`system` subtypes, `redacted_thinking`, etc. fails the diff harness on PR
rather than slipping through to a user bug report.

## Generating / regenerating

```bash
node -e "require('fs').rmSync('crates/spaghetti-napi/fixtures/medium', { recursive: true, force: true })"
node scripts/generate-medium-fixture.mjs \
  --out crates/spaghetti-napi/fixtures/medium \
  --seed 43
```

Deterministic per (`--out`, `--seed`) pair. Regeneration is byte-identical:
verified in-repo with a SHA-256 tree-hash round-trip. File mtimes are pinned
to `2026-04-01T00:00:00Z` so `git status` stays clean across regenerations.

Do not hand-edit files under `.claude/` — they will drift from the generator
and any diff-harness failure will be confusing to track down. Always change
the generator, then regenerate.

## At a glance

| Metric              | Count |
|---------------------|------:|
| Projects            |    9  |
| Sessions            |   32  |
| Messages            |  712  |
| Subagents           |    1  |
| Tool-result files   |    2  |
| Size on disk        | ~612 KB |

## What each project exercises

Every rare variant from the `SessionMessage` union and the `UserContentBlock`
/ `AssistantContentBlock` unions appears in at least one fixture file. The
projects group them by theme so you can open a single JSONL when hunting a
diff.

| Project slug                 | Sessions | What's exercised                                                                                          |
|------------------------------|---------:|-----------------------------------------------------------------------------------------------------------|
| `-Users-test-medium1`        |     3    | **User content shapes**: plain string, `tool_result` string-form, `tool_result` block-array w/ text+image sub-blocks, top-level `image` block, top-level `document` block. Also has `memory/MEMORY.md`. |
| `-Users-test-medium2`        |     3    | **Assistant content shapes**: `redacted_thinking` alone, `thinking` + `tool_use` in the same message. Includes on-disk `tool-results/*.txt` files. |
| `-Users-test-medium3`        |     2    | **All 7 `system` subtypes** in one session: `stop_hook_summary`, `turn_duration`, `api_error`, `compact_boundary`, `microcompact_boundary`, `local_command`, `bridge_status`. |
| `-Users-test-medium4`        |     2    | **`progress` variants**: `bash_progress`, `agent_progress` (with nested assistant snapshot), `mcp_progress`. |
| `-Users-test-medium5`        |     2    | **`attachment`**, **`saved_hook_context`**, **`last-prompt`** message variants.                           |
| `-Users-test-medium6`        |     2    | **`queue-operation`** (enqueue + dequeue), **`permission-mode`**, **`custom-title`**, **`pr-link`**, **`agent-name`**, **`file-history-snapshot`** message variants. |
| `-Users-test-medium7`        |     2    | Session flagged **`isSidechain: true`** in `sessions-index.json`, with a matching subagent transcript at `<session>/subagents/agent-alpha7.jsonl`. |
| `-Users-test-medium8`        |     2    | Two sessions whose UUIDs share the **same 8-char prefix** (`5ace5ace…`) — exercises the `^[0-9a-f]{8}-…` UUID regex anchor in `discover_session_entries`. |
| `-Users-test-medium9`        |    14    | Bulk realistic sessions padding the fixture toward the RFC Item 1 size target. No rare variants.          |

## Claude-level artifacts

Same categories as the small fixture. The session chosen for each is the
**first** session of the respective project (so UUIDs stay deterministic as
the generator's RNG stream is consumed in a fixed order).

- `todos/<project1-session0>-agent-agent_main.json` — three items, mixed statuses.
- `tasks/<project2-session0>/.lock` + `.highwatermark` (value `99`).
- `file-history/<project3-session0>/abc123@v1` — single snapshot.

## Variant coverage checklist

Cross-checked against `crates/spaghetti-napi/src/types/session.rs` and
`content.rs`. If the Rust types gain a new variant, add a fixture row
here and regenerate.

### `SessionMessage` variants (all 14)

- [x] `user` — plain string, content-blocks, tool_result sub-blocks
- [x] `assistant` — text / tool_use / thinking / redacted_thinking
- [x] `summary`
- [x] `system` — all 7 subtypes below
- [x] `progress` — 3 of 7 data subtypes (see below)
- [x] `attachment`
- [x] `queue-operation`
- [x] `permission-mode`
- [x] `custom-title`
- [x] `pr-link`
- [x] `file-history-snapshot`
- [x] `agent-name`
- [x] `last-prompt`
- [x] `saved_hook_context` (note: underscores in wire tag, unlike the others)

### `system.subtype` payloads (all 7)

- [x] `stop_hook_summary`
- [x] `turn_duration`
- [x] `api_error`
- [x] `compact_boundary`
- [x] `microcompact_boundary`
- [x] `local_command`
- [x] `bridge_status`

### `progress.data.type` payloads (3 of 7)

- [x] `bash_progress`
- [x] `agent_progress`
- [x] `mcp_progress`
- [ ] `hook_progress` *(see omissions)*
- [ ] `query_update` *(see omissions)*
- [ ] `search_results_received` *(see omissions)*
- [ ] `waiting_for_task` *(see omissions)*

### `UserContentBlock` variants (all 4)

- [x] `text`
- [x] `tool_result` (string form)
- [x] `tool_result` (block-array form, inner blocks mix `text` + `image`)
- [x] `image` (top-level, base64 source)
- [x] `document` (top-level, base64 source)

### `AssistantContentBlock` variants (all 4)

- [x] `text`
- [x] `tool_use`
- [x] `thinking`
- [x] `redacted_thinking`

### Edge shapes

- [x] Assistant message with `thinking` followed by `tool_use` in the **same** message (project 2, session 2b).
- [x] User message with a `tool_result` whose inner blocks include both `text` and `image` sub-blocks (project 1, session 1b).
- [x] Session with `isSidechain: true` + matching subagent transcript (project 7).
- [x] Two sessions sharing the same 8-char UUID prefix in the same project (project 8).

## Deliberately omitted

- **`plans/` directory.** The Rust parser does not emit Plan events yet
  (same reason as the small fixture — see
  `crates/spaghetti-napi/fixtures/small/README.md`). Adding plan files would
  produce TS-only rows in the `plans` table and fail the diff.
- **Multi-version `file-history` snapshots.** `readdir` order is not
  portable, so we only emit one snapshot to avoid spurious order-only diffs.
- **Legacy `source_files` fingerprints.** The Rust writer doesn't populate
  them; the diff harness ignores the whole table.
- **Four of the seven `progress.data.type` subtypes** (`hook_progress`,
  `query_update`, `search_results_received`, `waiting_for_task`). The RFC
  Item 1 bullet asks for "at least 2 of 7" — we picked the three with
  meaningfully distinct shapes (bash output vs nested assistant snapshot vs
  MCP status). The remaining four are structural near-duplicates of these
  three. If a specific Rust-side bug is suspected in one of the omitted
  subtypes, add a one-line variant to the generator rather than rebuilding
  this note.
- **`analytics` and `config` tables.** The medium fixture doesn't write
  top-level `config.json` or analytics logs; both tables stay empty on
  both sides of the diff. Covered by the small-fixture path implicitly
  (both tables are written from claude-code-parser, not the project
  parser).
