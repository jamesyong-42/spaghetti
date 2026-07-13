# RFC 006 — Normalized Message Model (multi-agent, step 3/3)

**Status:** Proposed
**Created:** 2026-07-13
**Depends on:** step 1 (source dimension, schema v5 — shipped) · step 2 (classifier is a property of `AgentSource` — shipped)
**Companion:** `docs/THREE-PLANE-INGEST-ARCHITECTURE.md` §8 (longer-term multi-agent)

---

## 1. Why this RFC exists

Steps 1 and 2 gave the index a **source dimension** and moved **file classification** behind `AgentSource`. Two agents' files can now be stored side by side and routed by source-declared rules. What remains Claude-shaped is the thing those two steps deliberately did not touch: **how a raw transcript line becomes the extracted columns the product reads** (`msg_type`, `text_content`, the token counts). Today that extraction assumes Anthropic's message envelope and content-block kinds, in two engines.

This is the decision that sets the cost of every future adapter. Get the normalized/raw boundary right and a Codex or Gemini source is a small extractor. Get it wrong — over-normalize to Claude's shape, or under-normalize so the product can't read a second agent — and every adapter fights the schema. So this is an RFC, not a patch.

## 2. What is already generic (don't re-solve)

- **The `messages` table** stores the verbatim source line in `data TEXT` plus extracted columns (`msg_type`, `uuid`, `timestamp`, the four token columns, `text_content`, `byte_offset`). Storage is already format-agnostic — a raw line of any shape fits.
- **`source_id`** (step 1) tags every row, so extraction can dispatch on it.
- **`Category`** (step 2, `live/router.ts`) is already the normalized bucket every source maps into (`session`/`subagent`/`tool_result`/…).

The gap is not storage and not routing. It is **extraction**: the function `raw line → { msg_type, text_content, tokens }`, which lives inside `parser/project-parser.ts` (TS) and `project_parser.rs` / `parse_sink.rs` (Rust) and knows Claude's content blocks.

## 3. The decision: a thin normalized core over a raw passthrough

**Normalize the minimum the product actually queries; keep everything else raw.**

Two layers, explicit:

1. **Raw passthrough (unchanged).** `data TEXT` stays the verbatim source line. Any consumer needing full fidelity (rendering a specific agent's content blocks, tool-call structure, thinking blocks) parses `data` itself *knowing `source_id`*. Spaghetti does not normalize rich structure — that is where Claude-shape leaked in, and it is the leak we are stopping.

2. **Normalized core (formalized).** A small, agent-agnostic shape every source must produce per message, because the product's cross-agent surfaces (list, search/FTS, token stats, timelines) depend on exactly these and nothing more:

   ```ts
   interface NormalizedMessage {
     msgType: 'user' | 'assistant' | 'system' | 'summary' | 'other';
     text: string;          // FTS/preview text, already flattened
     uuid?: string;
     timestamp?: string;
     tokens?: { input: number; output: number; cacheCreation: number; cacheRead: number };
     // raw line retained separately as `data`
   }
   ```

   `msgType` is a **normalized enum**, not Claude's 14-variant union — Claude's app-specific variants (`bridge-session`, `pr-link`, `custom-title`, `permission-mode`, …) collapse to `system`/`other` in the core and stay fully available in `data` for anyone who wants them.

The seam is a per-source **`MessageExtractor`**, owned by the `AgentSource` (the same way `classify` is now):

```ts
interface MessageExtractor {
  extract(rawLine: unknown): NormalizedMessage | null; // null = skip (not a message row)
}
// AgentSource gains: readonly messages: MessageExtractor
```

`createClaudeCodeSource` provides today's Anthropic-envelope extractor (lifted verbatim from `project-parser.ts`, behavior-identical). A second source provides its own. The ingest engines call `source.messages.extract(line)` and write the returned core columns + the raw `data`; they stop knowing what a content block is.

## 4. Why thin, not rich

The tempting alternative is a rich normalized model (normalize tool calls, content-block kinds, thinking, attachments into shared tables). Rejected, for three reasons:

1. **It re-centers on Claude.** A "generic" rich model is inevitably Claude's model with the serial numbers filed off; the next agent whose structure differs then fights it. The thin core has nothing to fight — role, text, tokens, time are universal.
2. **The raw line already has it.** `data` is lossless. Rich cross-agent structure is a *query-time* concern for the rare consumer that wants it, not an ingest-time normalization tax on every row.
3. **It keeps adapters cheap.** A new source implements one small `extract()` returning five fields. That is the whole point of the exercise.

The cost we accept: cross-agent features that need rich structure (e.g. a unified tool-call timeline spanning Claude + Codex) parse `data` per source at query time. That is the right place for that cost — paid only when used, by the feature that wants it.

## 5. Schema impact — likely none

The v5 `messages` columns already match the normalized core (`msg_type`, `text_content`, the token columns, `data`). This RFC is mostly a **code relocation**, not a migration: the extraction logic moves from the parsers into a source-owned `MessageExtractor`. If the core enum for `msg_type` is tightened, that is a value convention, not a DDL change. **No schema version bump is expected** — which is a sign the boundary is falling where the storage layer already anticipated it.

## 6. The Rust question

The Rust crate re-implements Claude extraction for the bulk path (`project_parser.rs`, `types/`). Two honest options:

- **(A) Rust stays Claude-only; second sources are TS-only first.** A new `AgentSource` ships with a TS `MessageExtractor` and no native path; its ingest runs on the TS engine (correct, just slower on large histories). Native parity is a later, per-source add. **Recommended** — it unblocks a second adapter now without a Rust extractor-trait refactor.
- **(B) Generalize the Rust extractor into a trait up front.** Cleaner long-term, but it is speculative work before a second source's shape is even known. Defer until a second source exists and its volume justifies native ingest.

Either way, the parity harness (`test:ingest-diff`) continues to compare the two engines **for `claude-code`**; a TS-only source is simply outside its scope until it gets a native path.

## 7. Plan (when this RFC is accepted)

1. Define `NormalizedMessage` + `MessageExtractor` in `sources/types.ts`; add `messages: MessageExtractor` to `AgentSource`.
2. Extract Claude's logic from `parser/project-parser.ts` into `sources/claude-code/message-extractor.ts` — behavior-identical, verified by the existing parser tests + `test:ingest-diff` staying zero-diff.
3. Route the TS ingest/live writers through `source.messages.extract`.
4. Leave Rust as the `claude-code` native path (option A).
5. Only then: write a second `AgentSource` (Codex) — classifier rules (step 2 seam) + `MessageExtractor` (this seam) + its `source_id` (step 1 seam). No engine or schema change.

## 8. Open questions

- **`msgType` enum membership.** Is `summary` core or does it collapse to `system`? (Leaning: keep `summary` — it is cross-agent meaningful for list previews.)
- **Token model.** Cache tokens are an Anthropic concept; a source without them returns zeros. Fine — the columns already default to 0. Confirm no consumer treats absent cache tokens as an error.
- **Projects PK.** `projects.slug` is still the PK; two sources with a colliding slug would clash. Out of scope here (step-1 follow-up: composite `(source_id, slug)`), but note it before a second source lands on overlapping paths.

## 9. One-line charter

> **Normalize only role/text/tokens/time; keep the raw line lossless in `data`; make extraction a per-source `MessageExtractor` the way classification is already a per-source `classify` — so a new agent is one small extractor, not a schema fight.**
