# RFC 004: Rust Ingest Core — Follow-ups

**Status**: Draft v1
**Created**: 2026-04-17
**Author**: James Yong + Claude

---

## Summary

Three optional follow-up items left over from [RFC 003](./003-rust-ingest-core.md). Each is independently scoped, independently valuable, and can land on its own schedule — none blocks daily use of the shipped native ingest (0.5.7).

1. **Medium fixture + diff-harness coverage expansion** — stronger correctness gate for rare message variants.
2. **Writer PRAGMA / batch tuning** — close the gap between current cold-start perf (~8.5s on a 1.1GB `~/.claude`) and the RFC 003 target (~4s proportional).
3. **CI perf gate** — catch future regressions in ingest time before they ship.

---

## Motivation

RFC 003 shipped cold + warm ingest on the Rust path, with a small fixture diff harness that proved Rust and TS produce bit-identical output on the hot path (user / assistant / summary messages, text / tool_use / thinking content blocks).

Three gaps remain, none severe enough to block shipping, but each worth closing when convenient:

- The diff harness doesn't exercise rare message variants, so a broken Rust deserialization for `system` / `progress` / `attachment` / etc. would slip past CI and only surface as a user bug report. (Precedent: James caught two real regressions in Phase 4 — `discover_session_entries` missing timestamps, and `slug_to_path_naive` botching hyphenated dirs — that the current harness fixture couldn't have caught.)
- Cold-start on a 1.1GB real `~/.claude` takes ~8.5s — a 3× speedup over TS but still slow in absolute terms. PRAGMA / FTS-trigger tuning could roughly halve it.
- Nothing in CI prevents a future PR from silently doubling ingest time.

---

## Non-Goals

1. **Not deleting the TS ingest path** (RFC 003's Phase 5). Explicitly out of scope. TS remains the iteration + ground-truth path for the foreseeable future, and the diff harness depends on both sides existing. Revisit only after multiple successful release cycles without Rust regressions *and* after the medium fixture proves long-tail parity.
2. **Not expanding Rust ingest's capability surface.** No new message variants, no new file categories, no new NAPI exports. Purely correctness + perf.
3. **Not touching the SDK query path or UI.** All work lives in `crates/spaghetti-napi/`, `scripts/`, and `.github/workflows/`.

---

## Item 1 — Medium fixture + diff-harness expansion

### What

Expand `scripts/generate-ingest-fixture.mjs` (or fork it to `generate-medium-fixture.mjs`) to emit a ~1MB fixture at `crates/spaghetti-napi/fixtures/medium/.claude/` that exercises every variant the Rust types support:

- All `SessionMessage` variants currently missing from the small fixture:
  - `system` — with every subtype (compact-boundary, init, etc.)
  - `saved_hook_context`
  - `progress` (with at least two of the seven progress-data subtypes)
  - `attachment`
  - `queue_operation`
  - `permission_mode`
  - `custom_title`
  - `pr_link`
  - `file_history_snapshot`
  - `agent_name`
  - `last_prompt`
- Content blocks currently missing:
  - `user_content_block` → `tool_result` (string form and block-array form)
  - `user_content_block` → `image`
  - `user_content_block` → `document`
  - `assistant_content_block` → `redacted_thinking`
- Edge shapes:
  - An assistant message with a `thinking` block followed by a `tool_use` block
  - A user message with a `tool_result` whose inner blocks include both `text` and `image` sub-blocks
  - A session with a sidechain (`isSidechain: true`) + matching subagent transcript
  - A project with ≥ 2 sessions sharing the same session_id prefix (to exercise the UUID regex anchor)

Target: **3× projects** over the small fixture (so ~9 projects, ~30 sessions, ~500 messages), with an explicit README listing which variant each fixture file exercises.

### Success criteria

- `pnpm test:ingest-diff --fixture crates/spaghetti-napi/fixtures/medium/.claude` returns `zero diffs`.
- Both CI matrix (`rust-check` + `check`) gain a second row running diff against the medium fixture.
- When a future schema / variant change breaks parity, the medium diff harness fails on PR before merge.

### Scope

Touches:

- `scripts/generate-ingest-fixture.mjs` — extend or fork
- `crates/spaghetti-napi/fixtures/medium/` — new committed dir (~1MB, acceptable git churn)
- `crates/spaghetti-napi/fixtures/medium/README.md` — document what's exercised
- `.github/workflows/ci.yml` — add a second diff-harness step against medium

Does **not** touch Rust ingest code. If the medium fixture surfaces real bugs in Rust deserialization, fix them as follow-up commits — they're out of scope for this item, which only ships the test.

### Effort

~3–5 hours. Most of it is hand-crafting representative JSONL payloads for each rare variant by studying the TS types in `packages/sdk/src/types/`.

Good candidate for an agent: self-contained, deterministic, verifiable.

---

## Item 2 — Writer PRAGMA / batch tuning

### What

Close the gap between `~8.5s` cold start (observed on 1.1GB `~/.claude`) and the RFC 003 scaled target of `~4s`. The bulk is SQLite write throughput — ~175k messages × INSERT + FTS5 trigger fires.

Concrete optimizations to explore, in rough order of expected impact:

1. **Drop FTS5 triggers during bulk ingest, rebuild index at finalize.** TS `beginBulkIngest` / `endBulkIngest` already does this. The Rust writer kept triggers live for correctness. Dropping the three `messages_ai` / `messages_ad` / `messages_au` triggers and calling `INSERT INTO search_fts(search_fts) VALUES('rebuild')` at finalize should be 2–3× write speedup on the hot path.
2. **`PRAGMA cache_size = -256000`** (256MB page cache) during bulk ingest. Current default is 2MB. With ~1GB JSONL input producing ~1GB SQLite output, page-cache thrashing is a real cost.
3. **`PRAGMA temp_store = MEMORY`** — already applied, but verify it's taking effect.
4. **`PRAGMA mmap_size = 30_000_000_000`** — lets SQLite memory-map large parts of the DB file. Read path benefits too.
5. **Larger transaction batches.** Currently we commit per-project. For a ≥100-project ingest, batching into ~4-project transactions reduces fsync count without losing much crash-recovery granularity.
6. **`sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0)`** — disable internal memory bookkeeping. Minor but measurable.
7. **Consider `PRAGMA journal_mode = OFF`** for the duration of bulk ingest (not just `WAL`). Restore to `WAL` in `finish()`. Trades durability for speed; acceptable because the DB is a rebuild-from-source cache.

Methodology: profile first with `samply`, commit one change at a time, run `pnpm bench:ingest --fixture ~/.claude` between each. Stop when marginal improvement < 10%.

### Success criteria

- Cold start on real 1.1GB `~/.claude` drops from ~8.5s to **≤4s** median over 5 runs. (If realistic ceiling turns out to be ~6s, that's still a win — close the RFC item at whatever level diminishing returns hits.)
- Warm-start time unchanged or improved.
- Zero regressions in `pnpm test:ingest-diff` against small + medium fixtures.

### Scope

Touches:

- `crates/spaghetti-napi/src/writer.rs` — `open_for_bulk_ingest()` + `finish()` paths, maybe `handle_event` for batch flushes
- `crates/spaghetti-napi/src/schema.rs` — if triggers need schema-level changes
- `scripts/bench-ingest.ts` — possibly extend to record per-PRAGMA comparison runs

Does **not** touch query path, public API, or SDK integration.

### Effort

~1 day for the full loop: profile → tune PRAGMAs → measure → repeat → land. Half-day if only the FTS-trigger-drop optimization (the biggest expected win) is done.

Me-driven, not agent-delegated. Tight profile-measure-tune loops need iteration too fast for the agent dispatch roundtrip.

---

## Item 3 — CI perf gate

### What

A scheduled GitHub Actions workflow that runs `pnpm bench:ingest` on a committed large fixture and fails if cold/warm ingest time exceeds a threshold. Prevents future PRs from silently regressing ingest speed.

### Design sketch

```
.github/workflows/bench-gate.yml
  trigger: pull_request + weekly schedule
  runs-on: ubuntu-latest-8-core  (predictable perf; shared runners are too noisy)
  steps:
    - checkout + setup toolchain
    - build SDK + native (release)
    - fetch large fixture from GH Releases / S3 (not committed — too big)
    - pnpm bench:ingest --fixture <path> --runs 5 --warmup 1
    - parse output, compare against committed baseline in
      `.github/bench-baselines.json`
    - fail if median regresses by >25%
```

### Thresholds

Baselines (from the tuning in Item 2 once it lands) committed to `.github/bench-baselines.json`. Example format:

```json
{
  "cold_start_ms_p50": { "target": 4000, "regression_threshold_pct": 25 },
  "warm_start_ms_p50": { "target": 150, "regression_threshold_pct": 50 }
}
```

Threshold of +25% is generous (absorbs GitHub runner noise) but tight enough to catch 2× regressions immediately.

### Fixture hosting

The 500MB+ fixture is too large to commit. Options:

- **GitHub Releases asset** on a dedicated `bench-fixture` tag, downloaded in CI via `gh release download`. Simplest, free, but the artifact is one-time-upload.
- **S3 / R2 bucket** with a pinned URL. More flexible but introduces auth.

Lean toward Releases asset. The fixture can be regenerated from the small-fixture generator with `--scale 50` or similar; re-uploaded quarterly is enough.

### Success criteria

- A PR that intentionally regresses cold start by 50% fails the gate.
- A PR that has no ingest impact takes ≤ 2 min of CI time on the bench job.
- Baseline numbers are published in the repo and auto-updated on releases (release-please bump triggers baseline re-measure).

### Scope

Touches:

- `.github/workflows/bench-gate.yml` — new workflow
- `.github/bench-baselines.json` — new file
- `scripts/bench-ingest.ts` — add `--compare-to <baseline.json>` option that exits 1 on regression
- A one-time upload of the fixture tarball to a GitHub Release

Does **not** touch Rust or SDK source.

### Effort

~2–4 hours. The workflow itself is straightforward; most effort goes into picking runner hardware that produces repeatable numbers and hosting the fixture.

Good agent candidate if you're happy accepting minor infra churn (re-run to converge thresholds).

---

## Sequencing

The three items have a natural dependency:

```
   Item 2 (perf tuning)
      │ produces stable numbers
      ▼
   Item 3 (CI gate)
      │ locks in the numbers
      ▼
   Item 1 (medium fixture)
      │ independent — can land anytime
```

Item 1 is fully independent. Items 2 and 3 pair well: tune first, then lock in.

**Recommended order if you tackle all three**: 1 → 2 → 3. Medium fixture first because it's the easiest to ship and has the clearest correctness payoff. Then perf tuning while protected by broader test coverage. Then CI gate to prevent future slips.

**Recommended order if you do only one**: pick based on pain:
- Rare-variant bug reports → Item 1
- Cold start feels slow → Item 2
- Worried about future regressions → Item 3

---

## Success criteria for closing this RFC

All three items either:
- Merged (committed, deployed, verified), OR
- Explicitly dropped with a one-sentence rationale in this doc

No partial-ship states. Each item is self-contained enough to land on its own PR.
