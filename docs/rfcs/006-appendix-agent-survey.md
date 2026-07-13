# RFC 006 — Appendix: cross-agent data-model survey

**Status:** Findings (input to RFC 006)
**Created:** 2026-07-12
**Method:** five parallel research passes, each disambiguating the product, inspecting a **real local install** where present, and otherwise reading **primary source** (repo code / community reverse-engineering). Agents surveyed: OpenAI **Codex CLI**, Google **Gemini CLI**, **Grok Build** (xAI), **OpenCode** (anomalyco/opencode), **Cursor**. **Claude Code** is included as the baseline Spaghetti already ingests.

This appendix exists to answer one question RFC 006 was asserting rather than proving: **is `{role, text, tokens, timestamp}` + raw passthrough actually the common set, or does it just look common through a Claude-shaped lens?** The survey both confirms the thin-core instinct *and* surfaces a layer RFC 006 assumed away.

---

## 1. Headline findings

1. **The thin core is directionally right, but two of its four fields are not universal.** `role` and `text` exist (in some form) in 6/6. **Per-message `tokens` exist in only 3/6.** **Reliable per-message `timestamp` exists in 4/6.** So `tokens` and `timestamp` are genuinely optional — the RFC already types them `?`, but its *justification* ("role, text, tokens, time are universal", §4) is empirically half-true and should be softened.

2. **No source's role field can be copied verbatim (0/6).** Field name diverges (`role` vs `type`), encoding diverges (string vs **numeric enum** vs variant-name), and value sets diverge (`user/model`, `user/assistant`, `developer`, `system/reasoning/tool_result`, `info/error/warning`, `1/2`). This *vindicates* the RFC's normalized-`msgType`-enum decision: a raw copy would be wrong for every non-Claude agent.

3. **No source stores the turn as a single clean prose string (0/6).** Text is always split across content blocks / parts / merged fields, and in coding agents the *majority* of semantic content lives in non-text structures (tool calls, diffs, subtasks). This *vindicates* the flatten-to-`text` + keep-raw-lossless split — and sharpens it: raw passthrough must be the **full native record (message + its parts)**, not merely "the JSONL line."

4. **The biggest finding is below extraction: 2 of 5 agents have no "raw line" at all.** **OpenCode migrated its transcript to SQLite** (`opencode.db`, Drizzle/WAL — the old JSON-per-record files now exist only as one-time migration source), and **Cursor never used files** (chat lives in `state.vscdb` KV blobs). RFC 006's `MessageExtractor.extract(rawLine)` presumes the engine reads files and hands over lines. For these two, the **source must own record production** (SQL query / KV scan), not just path declaration. This is a new seam the RFC should name explicitly. See §4 of this appendix.

5. **Good news for the chopsticks/spaghetti split: all 5 persist a durable, complete transcript.** None needs a live runtime bridge to reconstruct *history* — Grok Build (which I feared might be ephemeral) writes a canonical `chat_history.jsonl`. Every one is a legitimate **static `AgentSource`** ("reads bytes on disk → spaghetti" holds; SQLite files are bytes on disk). The runtime bridge (chopsticks) remains purely a *live observation/control* concern, exactly as designed.

6. **Ordering cannot always rely on `timestamp`.** Cursor orders by array position (no reliable per-message time); Codex is adding an `ordinal`; OpenCode uses monotonic IDs. The core needs a **source-supplied sequence** so cross-source and within-source ordering is deterministic where time is absent.

---

## 2. Master matrix

### 2.1 Storage & primary record

| Agent | Primary transcript format | Location | Primary record unit |
|---|---|---|---|
| Claude Code | JSONL files (append) | `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` | one JSON line per event |
| Codex CLI | JSONL files (append) | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl` | `RolloutLine` per line |
| Gemini CLI | JSONL (new) · JSON (legacy) | `~/.gemini/tmp/<sha256(cwd)>/chats/session-*.jsonl` | `MessageRecord` per line |
| Grok Build | JSONL + JSON sidecars | `~/.grok/sessions/<pct-enc-cwd>/<uuid7>/chat_history.jsonl` | typed record per line |
| **OpenCode** | **SQLite** (Drizzle/WAL) | `<xdgData>/opencode/opencode.db` | `message` row + `part` rows |
| **Cursor** | **SQLite** (KV blobs) | `~/…/Cursor/User/globalStorage/state.vscdb` | `bubbleId:<c>:<b>` KV rows |

**Split: 4 file-based, 2 database-based.** Also note a trap: Codex and Grok *also* ship **derived** SQLite (`state_*.sqlite`, `session_search.sqlite`) that must be **ignored** — whereas OpenCode/Cursor SQLite **is** the source of truth. "SQLite" ≠ "skip"; the source must know which stores are canonical.

### 2.2 Role / author discriminator

| Agent | Field | Encoding | Observed values |
|---|---|---|---|
| Claude Code | `type`/`role` | string | `user`/`assistant` + app-specific variants |
| Codex CLI | `role` | open string | `developer`, `user`, `assistant` (event stream encodes via variant name) |
| Gemini CLI | `type` (disk) / `role` (API) | string | disk: `user`/`gemini`/`info`/`error`/`warning`; API: `user`/`model` |
| Grok Build | `type` | string | `system`/`user`/`assistant`/`reasoning`/`tool_result` |
| OpenCode | `role` | string union | `user`/`assistant` — **no `system` role** (system prompt is a field on the user message) |
| Cursor | `type` | **numeric enum** | `1`=user, `2`=assistant |

**0/6 copyable verbatim.** Universal reducible set is `{user, assistant}` (`model`/`gemini`/type-`2` ≡ assistant). `system` is inconsistent; `tool_result` and `reasoning` are first-class "roles" in some agents.

### 2.3 Text content

| Agent | Native shape | Single prose string? |
|---|---|---|
| Claude Code | content-block array | no |
| Codex CLI | `Vec<ContentItem>` (`input_text`/`output_text`/`input_image`) | no |
| Gemini CLI | `PartListUnion` (`string \| Part \| Part[]`) | no — `content` often `""` with everything in `toolCalls[]` |
| Grok Build | mixed: `string` (assistant/system) vs `[{text}]` (user) | inconsistent within one file |
| OpenCode | split across `parts[]` (12 part types) | no |
| Cursor | `text` + `codeBlocks[]` + `thinking.text` + `richText` | partial — must merge |

**0/6 store a clean string.** `text` is always a *derived* flatten. Rule the extractor must follow: concatenate prose parts only; **exclude reasoning and tool payloads** from `text` (keep them in raw).

### 2.4 Tokens

| Agent | Granularity | Buckets | Cost ($) |
|---|---|---|---|
| Claude Code | per-message | input/output/cacheCreation/cacheRead (4) | — |
| Codex CLI | **not per-message** — periodic `token_count` events | input/cached_input/output/reasoning_output/total (5) | rate-limits (billing-shaped) |
| Gemini CLI | per-message (`gemini`-type only) | input/output/cached/thoughts/tool/total (6) | — |
| Grok Build | **session aggregate only** (`signals.json`) | contextTokensUsed / window | — |
| OpenCode | per-step + per-message + per-session (SQL cols) | input/output/reasoning/cache{read,write} | **yes — USD** |
| Cursor | **absent/unreliable** (`tokenCount` sparse) | — | — |

**Per-message tokens: only 3/6** (Claude, Gemini, OpenCode). Bucket schemas all differ (4 vs 5 vs 6 named sub-buckets). **Cost in USD** appears (OpenCode explicit; Codex/Grok billing-shaped) — a dimension Claude's model lacks entirely. Implication: `tokens` is optional; **absent ≠ zero**; the Anthropic 4-bucket shape is source-specific.

### 2.5 Timestamp

| Agent | Per-message? | Format | Ordering fallback |
|---|---|---|---|
| Claude Code | yes | ISO-8601 | timestamp |
| Codex CLI | yes (top-level on every `RolloutLine`) | ISO-8601 ms UTC | new `ordinal:u64` |
| Gemini CLI | yes | ISO-8601 | timestamp |
| Grok Build | **no — on side streams** (`events.jsonl`/`updates.jsonl`); needs cross-file join by `turn_number`/`tool_call_id` | ISO / unix-epoch | turn boundaries |
| OpenCode | yes (SQL `time_created`) | epoch ms | monotonic `msg_`/`prt_` IDs |
| Cursor | **weak/often absent**; fallback chain then array position | epoch ms when present | **array index (implicit)** |

**Reliable per-message time: 4/6.** Formats diverge (ISO string vs epoch ms → normalize to one unit). Two agents can't be ordered by time alone → the core needs a source-supplied `seq`.

### 2.6 Tool calls / results

| Agent | Structural pattern | Linkage |
|---|---|---|
| Claude Code | inline content blocks (`tool_use`/`tool_result`) | within message |
| Codex CLI | **separate** `function_call` / `function_call_output` records | `call_id`; args = raw JSON string; output **polymorphic** (string \| content array) |
| Gemini CLI | `toolCalls[]` attached to the `gemini` message | inline; result is a `functionResponse` Part |
| Grok Build | **separate** `tool_result` records | `tool_call_id`; args = JSON-encoded string |
| OpenCode | **separate** `ToolPart` rows with a state machine (`pending→running→completed\|error`) | `callID`; streaming deltas not persisted |
| Cursor | inline `toolFormerData` on the assistant bubble | within bubble |

Three patterns (inline blocks / separate records / separate part rows). Universal shape underneath: `call_id` + `name` + `arguments` (often a raw JSON string) + `result/output` (often polymorphic) + `status`. **Not foldable into `text`; not uniformly structured → keep raw; a unified tool timeline is a query-time concern.**

### 2.7 Reasoning / thinking

| Agent | Shape | CoT encrypted? |
|---|---|---|
| Claude Code | thinking blocks | no |
| Codex CLI | `reasoning` item: `summary[]` legible + `encrypted_content` | **yes (opaque blob)** |
| Gemini CLI | `thoughts[]` `{subject, description}` | no |
| Grok Build | `reasoning` type: `summary[]` legible + `encrypted_content` | **yes (opaque blob)** |
| OpenCode | `ReasoningPart` (kept distinct from text) | no |
| Cursor | `thinking.text` + `thinkingDurationMs` | no |

**6/6 keep reasoning separate from prose. 2/6 encrypt the actual CoT** (only a summary is legible). → never fold into `text`; keep raw; sometimes only `summary` survives.

### 2.8 Session lineage / sub-agents

| Agent | Mechanism |
|---|---|
| Claude Code | separate subagent transcripts (already handled by Spaghetti) |
| Codex CLI | fork DAG (`forked_from_id`/`parent_thread_id`) + `InterAgentCommunication` + `multi_agent_*` first-class |
| Gemini CLI | separate **sibling** subagent files nested under parent dir; `kind: main\|subagent` |
| Grok Build | child session **directories**; `session_relationship` |
| OpenCode | `session.parent_id` tree + `SubtaskPart` |
| Cursor | weak |

**5/6 model sub-agents/forks as cross-container relationships** (parent IDs / separate files), never flattened into one linear transcript. The source must preserve lineage; this generalizes Spaghetti's existing Claude subagent handling.

### 2.9 Canonical vs projection streams (operational trap)

Several agents keep a **canonical model-facing transcript** *and* a fatter **UI/streaming projection** of the same turns:

- **Codex:** `response_item` (source of truth) vs `event_msg` (UI/telemetry projection — same turns, flattened, images lost).
- **Grok:** `chat_history.jsonl` (truth) vs `updates.jsonl` (ACP UI stream, **~10× larger** — 26 MB vs 2 MB in the sampled session).
- **Gemini:** full recording vs `logs.json` (thin user-prompt-only log).

An adapter must select the canonical stream and **ignore projections and derived indexes**, or it ingests an order of magnitude of redundant UI noise.

---

## 3. Per-agent one-line verdicts

- **Codex CLI** — closest to Claude's shape but *records-not-blocks*: `role` is an open string (`developer`/`user`/`assistant`), text is a `ContentItem[]` decode, tool calls are separate `call_id`-joined records, tokens are periodic (`token_count`) not per-message, and **`timestamp` is the cleanest field in the whole survey** (top-level on every line). Fork/compaction lineage is first-class. Extractor: prefer `response_item` over `event_msg`; backfill tokens from nearest `token_count`.
- **Gemini CLI** — `type: gemini` (not `role: model`) on disk, `content: PartListUnion` where tool calls dominate and prose is often empty, **6-bucket per-message tokens**, ISO per-message time, subagents as separate sibling files, and a `$rewindTo`/`$set` edit-log (not purely append-only).
- **Grok Build** — xAI's official CLI, **durably persisted** (`chat_history.jsonl` canonical). `type` discriminator with a distinct `reasoning` (encrypted) and `tool_result` type, **no per-message tokens** (session aggregate only), **no per-message timestamp** (decoupled to side streams — needs a cross-file join). Uploads transcripts to xAI GCS.
- **OpenCode** — **now SQLite**, not JSON files. Clean `role: user|assistant` union but **no `system` role**; text split across a 12-variant `parts[]`; per-message + per-session tokens **and cost in USD**; monotonic `msg_`/`prt_` IDs; sub-agents as `session.parent_id` + `SubtaskPart`. Raw passthrough must be the full `{info, parts[]}`.
- **Cursor** — the hard case, and a genuine architecture challenge. Content in **SQLite KV blobs** (`state.vscdb` `cursorDiskKV`), **not tailable files**. `type` is a **numeric enum** (1/2), **tokens effectively absent**, **timestamps weak/often absent** (order by array position), text spread across `text`+`codeBlocks`+`thinking`+`richText`, schema drifts every release (`_v` bumps). Breaks 3 of 4 core assumptions and the file-ingest premise.

*(Confidence: Codex/Gemini/Grok/OpenCode from primary source + real files where installed — HIGH. Cursor from community reverse-engineering only — no local install to inspect — MEDIUM-HIGH on key/table names, MEDIUM on exact bubble sub-fields.)*

---

## 4. What this means for RFC 006

**Confirmed as-is:**
- Thin normalized core over a lossless raw passthrough — **yes.** 0/6 store clean prose text; most content is non-text structure. Flatten-to-`text` for FTS/preview + keep raw is the only correct call.
- `msgType` as a **normalized enum, not a copied field** — **yes.** 0/6 role fields are copyable (string vs numeric vs variant-name).
- Per-source `MessageExtractor`, one small `extract()` per adapter — **yes**, mirrors the `classify` seam cleanly.
- Rust stays claude-only (RFC §6 option A) — **strongly confirmed.** No second source has volume justifying native ingest, and two are SQLite (entirely different native readers). TS-first per source.

**Amendments the evidence forces:**

1. **Name the seam below extraction: source-owned record production.** RFC 006's `extract(rawLine: unknown)` assumes the engine reads files and yields lines. Two of five sources have **no lines** (SQLite). The `AgentSource` must own *how raw records are produced* — `JSONL-tail` | `SQL-query` | `KV-scan` — and hand the engine an abstract stream of source-native records. Extraction then operates on a **record**, not a line. This is the single most important gap; RFC 006 is *necessary but not sufficient* without it. (See RFC 006 §3/§7 amendment.)

2. **Add a `seq` to the normalized core.** Ordering can't rely on `timestamp` (Cursor has none; Grok's is on a side stream). Every source can supply a monotonic ordinal (line number / rowid / `ordinal` / monotonic ID). Make ordering source-supplied and deterministic.

3. **Downgrade the token/time universality claim.** `tokens` and `timestamp` are optional-and-often-absent (per-message tokens 3/6; reliable per-message time 4/6). Keep the `?` types; add a per-source **granularity hint** (`tokens: 'message'|'session'|'none'`, `time: 'message'|'derived'|'none'`) so token-stat and timeline UIs don't silently mislead. Document **absent ≠ zero** (Grok/Cursor/Codex per-message zeros are "not attributed", not "0 tokens used").

4. **Strengthen the `text` rule.** `text` is *always* derived (0/6 native), and must **exclude reasoning and tool payloads** — both are universally kept separate, and reasoning CoT is encrypted in 2/6. Raw passthrough = full native record (message + parts), not "the line."

5. **Note cost (USD) as an out-of-core dimension.** OpenCode tracks it first-class; Codex/Grok are billing-shaped. Claude's model has no cost. Leave in raw for now; flag as a candidate column only if a cross-agent cost view is wanted.

**Beyond RFC 006 (ingest-plane, not extraction):**

6. **`LiveDiskIngest` needs a per-source incremental strategy.** File-tail works for the 4 JSONL agents (append-only lines — except Gemini's `$rewindTo`/`$set` edits). For SQLite sources you watch the DB/WAL and re-query deltas by monotonic id/rowid. The "what changed" computation belongs to the source, not the engine.

7. **Source must select canonical streams and preserve lineage.** Ignore UI projections (Codex `event_msg`, Grok `updates.jsonl`) and derived indexes (Grok `session_search.sqlite`, Codex `state_*.sqlite`); preserve sub-agent/fork relationships as cross-container links.

---

## 5. The corrected common set (one line)

> Across six agents, the **only** truly universal per-message facts are an **author discriminator** (never copyable — always a normalized enum) and **prose text** (never native — always a derived flatten excluding reasoning/tools). **Timestamp** (4/6) and **tokens** (3/6) are common-but-optional, format-divergent, and sometimes only session-level. Ordering needs a source-supplied **seq**. And the real cost of a second adapter is set not by extraction but by **record production**: two of five agents keep their transcript in SQLite, not files — so the `AgentSource` must own *how records are read*, not just *where they live*.
