# Three-Plane Ingest Architecture

**Status:** North-star + current-state map  
**Created:** 2026-07-10  
**Scope:** How Spaghetti ingests local agent data today (Claude Code first), and how the three ingest planes fit the long-term goal: a tool and a set of well-designed APIs for indexing, querying, and reacting to agent history and live state.

**Related:**

- `docs/PR-PLAN-THREE-PLANE-SHAPE.md` — **implementation PR stack** (AgentSource + plane façades)
- `docs/PARSER-PIPELINE.md` — what static disk data is parsed
- `docs/PARSER-UNPARSED-DATA.md` — coverage gaps on disk
- `docs/rfcs/005-live-updates.md` / `docs/LIVE-UPDATES-DESIGN.md` — Plane 2 design
- `packages/sdk/src/api.ts` — public query + live surface
- `packages/cli/src/lib/plugins.ts` — Claude Code plugins (Plane 3)

---

## 1. Ultimate goal

Provide a **local-first agent-data platform**:

1. **Ingest** local agent data (currently Claude Code’s `~/.claude` and related Spaghetti state).
2. **Organize** it into a searchable, durable dataset (SQLite + FTS5).
3. **Expose well-designed APIs** so users and apps can query history, follow updates, and observe live agent activity.

Claude Code is the first **agent source**, not the permanent identity of the system. Multi-agent support is a later adapter problem once the three planes are coherent.

---

## 2. The three planes

| Plane | Name | Question it answers | Time scale | Source of truth |
|---|---|---|---|---|
| **1** | Static disk | What has this agent ever done on this machine? | Historical, bulk | Files already on disk (e.g. `~/.claude`) |
| **2** | Live disk Δ | What just changed in those files? | Seconds / sub-second | Same files, as they grow or rewrite |
| **3** | Live agent state | What is the agent doing *right now*? | Realtime | Process-side plugins (hooks, channels, lifecycle) |

Planes **1** and **2** share the same data model: paths under the agent home → normalized rows in SQLite.  
Plane **3** is a different channel: events that often never become durable Claude files, or arrive before/alongside files.

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Consumer surfaces                            │
│         CLI / TUI · SDK · React · (future apps / MCP)               │
└───────────────────────────────▲─────────────────────────────────────┘
                                │  SpaghettiAPI  (+ api.live, hooks, chat)
┌───────────────────────────────┴─────────────────────────────────────┐
│                     Local index + event bus                         │
│              SQLite (searchable, durable)  ·  typed Change events   │
└───────▲───────────────────▲──────────────────────────▲──────────────┘
        │                   │                          │
   ┌────┴────┐         ┌────┴────┐              ┌──────┴──────┐
   │ Plane 1 │         │ Plane 2 │              │   Plane 3   │
   │ Static  │         │  Live   │              │ Live agent  │
   │  disk   │         │  disk Δ │              │   states    │
   │ ~/.xxx  │         │ watchers│              │ hooks/chans │
   └─────────┘         └─────────┘              └─────────────┘
        cold/warm              incremental           push / IPC
        full reparse           file deltas           lifecycle
```

---

## 3. Target architecture (north star)

```text
                    ┌──────────────────────────┐
                    │   AgentSource adapter    │  (claude-code today)
                    │  roots, formats, plugins │
                    └────────────┬─────────────┘
           ┌─────────────────────┼─────────────────────┐
           ▼                     ▼                     ▼
    StaticIngest            LiveDiskIngest        RuntimeBridge
    cold/warm/full          watch+delta           hooks/channels
           │                     │                     │
           └──────────┬──────────┴──────────┬──────────┘
                      ▼                     ▼
                 DurableStore          EventBus
                 (SQLite+FTS)     (typed Change + RuntimeEvent)
                      │                     │
                      └──────────┬──────────┘
                                 ▼
                           SpaghettiAPI
```

### Design principles (already aligned with shipped work)

1. **One durable store for disk-derived truth** (planes 1–2).
2. **Events after commit**, not instead of commit (plane 2) — no reliance on SQLite update hooks.
3. **Runtime events as a separate stream** that can *reference* session/project IDs and optionally materialize into the store when useful (plane 3).
4. **Source adapters** later so “agent data folder” is not hardcoded forever.

### Non-goals (keep these)

- Do not force hooks into the JSONL parser.
- Do not make filesystem watching simulate process lifecycle.
- Do not require chat/runtime features to depend on a full re-ingest.
- Do not build a multi-process CRDT / sync layer for v1.

---

## 4. Plane 1 — Static local agent data

### Intent

Parse the agent home directory into a searchable, well-organized dataset.

Examples: `~/.claude/projects/**/*.jsonl`, memory, todos, plans, subagents, workflows, config, analytics.

### Current status: **strong / product-ready core**

This is Spaghetti’s mature center of gravity.

| Piece | Status |
|---|---|
| Streaming JSONL parse | Done (TS + Rust) |
| Dedicated SQLite schema + FTS5 | Done (schema v4) |
| Cold start / warm start + fingerprints | Done |
| Dual engine (`rs` default, `ts` fallback + parity harness) | Done |
| Public query API (`getProjectList`, `search`, messages, subagents, workflows, …) | Done |
| CLI + TUI consumers | Done |
| Coverage | Strong on sessions / messages / subagents / workflows / todos / memory; config & analytics **TS-only**; residual gaps in `PARSER-UNPARSED-DATA.md` |

**Key modules**

- `packages/sdk/src/create.ts` — service wiring
- `packages/sdk/src/data/lifecycle-owner.ts` — cold/warm/native init
- `packages/sdk/src/parser/*` — project / config / analytics
- `packages/sdk/src/data/query-service.ts` + `ingest-service.ts`
- `crates/spaghetti-napi/` — native bulk ingest

**Strengths**

- Stream → single writer → durable FTS
- Performance path (native) without abandoning TS as ground truth
- Stable `SpaghettiAPI` for consumers of the index

**Gaps**

- Not yet a multi-agent abstraction (Claude Code–shaped types and paths)
- Incomplete disk coverage (teams live-watch, backups, active-session PID files, some config corners)
- Rust path intentionally scoped to project/session bulk ingest, not full config/analytics
- APIs are strong for **read/query**; less formal for **ingest control** (cancel, multi-root, pluggable sources)

**API maturity:** high for consumers of the index; medium for operators of ingest.

---

## 5. Plane 2 — Live increments of static data

### Intent

Watch the agent folder; notify callers of updates; write deltas into SQLite promptly so search and UI stay warm.

### Current status: **implemented as infrastructure, under-adopted as product default**

RFC 005 is largely built in the SDK:

```text
@parcel/watcher → classify → coalesce → incremental parse
    → writeBatch (TS or native liveIngestBatch) → store.emit(Change)
    → api.live.onChange / events() / React live hooks
```

| Piece | Status |
|---|---|
| Watcher + coalescing queue + checkpoints | Done |
| Incremental JSONL (byte-offset resume) | Done |
| Scopes: projects, todos, tasks, file-history, plans, settings | Wired |
| Typed `Change` union + `api.live` | Done |
| React `useLive*` hooks | Done |
| Opt-in `createSpaghettiService({ live: true })` | Done |
| Default for CLI one-shots / bare TUI | **Off** (by design today) |

**Key modules**

- `packages/sdk/src/live/*` — watcher, queue, parser, router, `spaghetti-live.ts`
- `packages/sdk/src/create.ts` — constructs `LiveUpdates` only when `live: true`
- `crates/spaghetti-napi/src/live_ingest.rs` — native batch writer for live path

**Strengths**

- Post-COMMIT application-layer events (portable across TS/Rust writers)
- Shared writer semantics with cold ingest
- Explicit non-goals respected (not a CRDT, not multi-process sync)

**Gaps**

- Still opt-in — most `spag` invocations never enable live path
- Watched set ≠ full `~/.claude` (e.g. teams; noisy analytics intentionally skipped)
- No first-class “always-on daemon” product mode yet
- Delivery is fire-and-forget for UI (`seq` is in-memory); restart reconciliation is warm-start
- Saturation / lag signals exist more in design than in polished product UX

**API maturity:** high when `live: true`; low as a default end-user experience.

---

## 6. Plane 3 — Live agent states (hooks, channels, lifecycle)

### Intent

Plug into the agent process for events that are not “a file grew by N bytes”: lifecycle hooks, permissions, realtime channel messages, session liveness.

### Current status: **two working plugins, parallel to the index — not unified into the core data plane**

| Mechanism | Role | Integration today |
|---|---|---|
| **spaghetti-hooks** | Capture Claude Code hook lifecycle events | JSONL under `~/.spaghetti/hooks`; CLI `spag hooks` / TUI monitor; `hook-event-watcher` in SDK IO |
| **spaghetti-channel** | MCP + loopback WebSocket chat bridge | Discovery under `~/.spaghetti/channel/`; CLI `spag chat` |

**Key modules**

- `packages/claude-code-hooks-plugin/`
- `packages/claude-code-channels-plugin/`
- `packages/cli/src/commands/hooks.ts`, `chat.ts`
- `packages/cli/src/lib/plugins.ts`
- `packages/sdk/src/io/hook-event-watcher.ts`, `channel-*`

**Strengths**

- Real product surfaces for observability and interactive chat
- Correct separation: process-adjacent runtime vs pure filesystem archaeology

**Gaps**

- Runtime events are not first-class citizens of the same SQLite agent index as messages
- Two storage roots (`~/.claude` vs `~/.spaghetti/hooks|channel`) without a single query model
- No clean, versioned “runtime bus” on `SpaghettiAPI` (hooks/chat remain mostly CLI-centric)
- No abstract agent-runtime adapter — Claude Code plugins are hardcoded
- Weak correlation: hard to join “hook PreToolUse X” ↔ “session message Y” ↔ “JSONL append just landed”
- Active session PID registry (`~/.claude/sessions/{pid}.json`) still unparsed — see unparsed-data doc

**API maturity:** useful tools; not yet a platform API.

---

## 7. Scorecard (honest snapshot)

| Plane | Capability | Productization | API cleanliness | Multi-agent readiness |
|---|---|---|---|---|
| **1 Static** | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★☆☆☆ |
| **2 Live disk** | ★★★★☆ | ★★☆☆☆ | ★★★★☆ | ★★☆☆☆ |
| **3 Runtime** | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★☆☆☆☆ |

**One-line summary**

> Spaghetti has a **production-grade static index**, a **real live-disk pipeline that is not yet the default product path**, and **Claude-specific runtime bridges that work as features but are not yet the third pillar of the platform API**.

```text
  [████████████████████░░░░]  Plane 1  — core product; harden coverage
  [████████████░░░░░░░░░░░░]  Plane 2  — built; needs defaultization + UX
  [██████░░░░░░░░░░░░░░░░░░]  Plane 3  — features exist; not platformized
  [██░░░░░░░░░░░░░░░░░░░░░░]  Multi-agent / pluggable sources
```

---

## 8. Strategic priorities

### Near term — sharpen the platform story

1. **Keep this three-plane model** in product docs (this file, SDK README, public docs site when ready).
2. **Promote Plane 2** for long-lived consumers only:
   - TUI, Electron playground, any “monitor” mode → `live: true` by default
   - One-shot CLI commands stay cold/warm only (no watcher overhead)
3. **Formalize API layers** in naming and docs:
   - **Ingest:** `initialize`, `rebuildIndex`, engine selection, progress
   - **Query:** lists, messages, search, stats, artifacts
   - **Live disk:** `api.live`
   - **Runtime:** still ad hoc — design `api.runtime` (or equivalent) next

### Medium term — unify Plane 3

4. **Runtime event model** in the SDK:
   - `RuntimeEvent` types (hook, permission, channel message, session start/end, …)
   - Optional persistence (tables or append-only log under `~/.spaghetti`)
   - Join keys: `sessionId`, `projectSlug`, `toolUseId`, timestamps
5. **Correlation** across planes: timeline that can stitch JSONL appends + hook events + channel messages
6. **Active sessions** from `~/.claude/sessions/{pid}.json` — “what’s running” without relying only on channel discovery files

### Longer term — multi-agent

7. **`AgentSource` interface:** roots, file categories, runtime plugin IDs
8. Second agent source only after Claude Code planes 1–3 feel coherent on one API surface

---

## 9. Suggested public API shape (sketch, not implemented)

```ts
// Conceptual — direction only
interface SpaghettiAPI {
  // Plane 1 (and shared lifecycle)
  initialize(): Promise<void>;
  rebuildIndex(): Promise<{ durationMs: number }>;
  // … query methods …

  // Plane 2
  readonly live?: SpaghettiLive; // present when { live: true }

  // Plane 3 (future)
  readonly runtime?: SpaghettiRuntime;
}

interface SpaghettiRuntime {
  /** Hook / permission / channel / session-liveness stream */
  onEvent(listener: (e: RuntimeEvent) => void): Dispose;
  events(options?: { bufferSize?: number }): AsyncIterable<RuntimeEvent>;
  listActiveSessions(): ActiveSession[];
}
```

Plane 2 and Plane 3 both fan out events, but:

- Plane 2 events imply **store mutation** (or reconciliation with store).
- Plane 3 events are **runtime observations** that may or may not write rows.

---

## 10. What “done” looks like for the platform story

| Plane | Done means |
|---|---|
| **1** | Cold/warm ingest of Claude Code disk is complete enough that search + browse cover the workflows users care about; gaps are documented and low severity |
| **2** | Long-lived apps get live disk updates by default; search stays current within ~100ms of append; API is boring and reliable |
| **3** | Hooks and channels (and session liveness) are queryable/subscribable through the same SDK mental model, with join keys into sessions/messages |
| **Platform** | A new consumer can build a tool using only published APIs, without knowing internal parser modules or CLI plugin paths |

---

## 11. Implementation map (code)

| Diagram box | Module(s) |
|---|---|
| AgentSource | `packages/sdk/src/sources/` (`createClaudeCodeSource`) |
| StaticIngest | `packages/sdk/src/planes/static-ingest.ts` → `LifecycleOwner` |
| LiveDiskIngest | `packages/sdk/src/planes/live-disk-ingest.ts` → `live/live-updates.ts` |
| RuntimeBridge | `packages/sdk/src/planes/runtime-bridge.ts` (+ hooks/channel IO) |
| DurableStore | `packages/sdk/src/store/durable-store.ts` |
| EventBus (disk) | `live/change-events.ts` + `api.live` |
| EventBus (runtime) | `events/runtime-event.ts` + `api.runtime` (`runtime/spaghetti-runtime.ts`) |
| Factory | `packages/sdk/src/create.ts` |

**Product defaults (2026-07):** CLI TUI and Electron playground construct the service with `{ live: true }`. One-shot CLI commands remain pull-only. `api.runtime` is always attached on the default factory path (lazy-start watchers). Doctor reports engine, index DB, live defaults, and Claude Code active-session counts (`listActiveSessions`).

PR stack: `docs/PR-PLAN-THREE-PLANE-SHAPE.md`.

---

## 12. Bottom line

The hard architectural bets for planes **1** and **2** are already correct: streaming parse, single SQLite writer, dual engines, live updates as strictly additive.

The main strategic work is no longer “more parsers alone.” It is:

1. **Productizing live disk** for always-on surfaces  
2. **Lifting hooks/channels into a first-class runtime API** beside query + live  
3. **Keeping Claude Code as Adapter #1**, not the permanent name of the system  

This document is the shared map for that work.
