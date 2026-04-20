# Unparsed `.claude/` Data

**Status:** Gap inventory for the spaghetti parsing library.
**Updated:** 2026-04-19
**Scope:** `~/.claude/` on-disk state written by Claude Code that the spaghetti library does **not** currently ingest (or ingests incompletely). Separate doc: `PARSER-PIPELINE.md` for what *is* parsed.

Two axes are tracked per entry:

- **TS status**: ground-truth pipeline (`packages/sdk/src/`). Gaps here mean the data simply isn't in the system.
- **RS status**: performance port (`crates/spaghetti-napi/src/`). Gaps here mean the fast path is incomplete even if TS has coverage.

Severity uses this scale:

- **Critical** — actively used Claude Code feature, data now missing from every downstream surface (CLI, UI).
- **High** — frequently-written state, noticeable gap in search/analytics.
- **Medium** — niche but real data, or types already defined with no parser wired.
- **Low** — rarely read; can be deferred.

---

## 1. Directories / files with zero coverage

### 1.1 `~/.claude/teams/` — agent-teams infrastructure
- **Severity:** Critical (new product area).
- **Gated by:** `settings.json.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- **Shape:**
  - `teams/{team-name}/config.json`: `{ name, description, createdAt, leadAgentId, leadSessionId, members[] }`. Each `member` has `{ agentId, name, agentType, model, prompt, color, planModeRequired, joinedAt, tmuxPaneId, cwd, subscriptions[], backendType }`.
  - `teams/{team-name}/inboxes/{agent-name}.json`: per-agent message queue (JSONL-shaped).
- **TS status:** Types exist at `packages/sdk/src/types/teams-data.ts` (`TeamDirectory`, `TeamConfig`, `TeamMember`) but **no parser** wires them. `config-parser.ts` does not walk `teams/`.
- **RS status:** No types, no parser.
- **Impact:** Agent team membership, per-agent prompts, inbox message history — entirely invisible.

### 1.2 `~/.claude/backups/` — `.claude.json` state snapshots
- **Severity:** Medium.
- **Shape:** Timestamped `.json.backup` files (5 snapshots observed). Mirrors the global `.claude.json` schema at point-in-time.
- **TS status:** Type `ClaudeGlobalStateBackup` exists at `packages/sdk/src/types/backups-data.ts`, no parser wired in `analytics-parser.ts`.
- **RS status:** No types, no parser.
- **Impact:** No ability to diff or surface historical changes to global state.

### 1.3 `~/.claude/hooks/` — hook implementation scripts
- **Severity:** Medium (High if plugin dev is a primary use case).
- **Shape:** Arbitrary executables referenced from `settings.json.hooks[].command` (e.g. `claude-island-state.py`).
- **TS status:** Not read. `settings.json`'s hooks section is captured as a raw object, but the referenced scripts are never loaded, hashed, or cross-referenced.
- **RS status:** Not read.
- **Impact:** Cannot validate hook definitions, surface broken references, or display hook source in the UI.

### 1.4 `~/.claude/sessions/` — active-session PID registry
- **Severity:** Medium.
- **Shape:** `~/.claude/sessions/{pid}.json` with `{ pid, sessionId, cwd, startedAt, kind?, entrypoint?, name? }` (type `ActiveSessionFile` already defined at `packages/sdk/src/types/toplevel-files-data.ts`).
- **TS status:** Type defined, no reader. Nothing populates a live-session list.
- **RS status:** Not read.
- **Impact:** No way to know which sessions are currently running from within the library.

### 1.5 `~/.claude/settings.local.json`
- **Severity:** High.
- **Shape:** Same schema as `settings.json`; overrides global permissions/hooks/env per-project.
- **TS status:** **Not parsed.** `config-parser.ts` only reads `settings.json`.
- **RS status:** Not read.
- **Impact:** Displayed permissions don't reflect real effective permissions in a working directory.

### 1.6 `~/.claude/CLAUDE.md` (root-level, not per-project)
- **Severity:** Low.
- **Shape:** Markdown with user's global instructions.
- **TS status:** Not indexed. (Per-project `memory/MEMORY.md` under `projects/{slug}/` is parsed.)
- **RS status:** Not read.
- **Impact:** User's global Claude instructions never surface in search or UI.

### 1.7 `~/.claude/vercel-plugin-*` and `~/.claude/.idea/`
- **Severity:** Low.
- **TS status:** Not read.
- **RS status:** Not read.
- **Impact:** Minor. `.idea/` is IntelliJ-private; `vercel-plugin-device-id` / `vercel-plugin-telemetry-preference` are a few bytes each. Document as out-of-scope unless Vercel integration becomes first-class.

### 1.8 `~/.claude/.credentials.json`
- **Severity:** Must-not-parse.
- **TS status:** Correctly ignored.
- **RS status:** Correctly ignored.
- **Impact:** None. Flag in docs so future contributors don't "fix" the omission.

---

## 2. Partial coverage (data is read, but fields/records are lost)

### 2.1 Session JSONL — new fields since March 2026
- **Severity:** High.
- **Observed new fields** on live session lines:
  - `isSidechain: boolean` — flags subagent / sidechannel output.
  - `parentUuid: string | null` — parent session reference for sidechains.
  - `entrypoint: 'cli' | 'web' | 'mobile' | …` — origin of the session.
  - nested `attachment.{hookName, hookEvent, content, stdout, stderr, exitCode, command, durationMs}` — hook-result attachments.
- **TS status:** `SessionMessage` union (`packages/sdk/src/types/projects.ts`) has fields present but verify they flow through `IngestService.onMessage()` and land in `messages.data`. Nested `attachment` hook fields look incomplete in the current type — double-check.
- **RS status:** `BaseMessageFields` at `crates/spaghetti-napi/src/types/session.rs:52` includes `is_sidechain`, `parent_uuid`, `entrypoint`. The `attachment` variant lives in the enum but the nested `attachment` payload is stored as raw JSON — not promoted to dedicated columns.
- **Impact:** Sidechain/subagent tree rendering, hook-result drill-down, and entrypoint filtering can't be implemented reliably against the DB as-is.

### 2.2 Subagent `.meta.json` sidecar
- **Severity:** Medium.
- **Shape:** `projects/{slug}/{sessionId}/subagents/agent-{id}.meta.json` with `{ agentType, description }`.
- **TS status:** Type `SubagentMeta` is defined at `packages/sdk/src/types/projects.ts:88`, and `SubagentTranscript.meta` is optional, but `ProjectParserImpl.parseSubagents()` at `project-parser.ts:433` does not read the sidecar. Subagent type is inferred from filename regex (`task` / `prompt_suggestion` / `compact`) — loses new variants.
- **RS status:** `SubagentTranscript.meta?: SubagentMeta` exists in `types/project.rs`, but `project_parser.rs` doesn't populate it either.
- **Impact:** Subagent type detection is brittle, description is lost.

### 2.3 `~/.claude/tasks/{sessionId}/` — items never loaded
- **Severity:** Medium.
- **Shape:** Directory contains `.lock`, `.highwatermark`, and numbered `{N}.json` files (actual task items).
- **TS status:** `ProjectParserImpl.parseTasks()` at `project-parser.ts:571` captures only `{ lockExists, hasHighwatermark, highwatermark }`. The numbered item files are **never read**, despite `TaskItem` existing in `packages/sdk/src/types/tasks.ts`.
- **RS status:** `TaskEntry.items?: Vec<TaskItem>` is defined in `types/artifacts.rs:55` but `project_parser.rs` populates only the lock/hwm fields.
- **Impact:** Tasks appear as metadata-only stubs; task body text is invisible to both query and search.

### 2.4 `settings.json` hook matchers
- **Severity:** High.
- **Shape:** Rich tree of `{ event: 'PreToolUse'|..., matcher: {...}, command|prompt: string }` entries under `settings.json.hooks`.
- **TS status:** The parent `SettingsFile.hooks` field exists, but matchers/commands are not promoted to first-class rows, not joined against `hooks/` script files, and not surfaced individually in the query layer.
- **RS status:** Settings aren't parsed at all (see §3.1).
- **Impact:** "What hooks run on SessionStart?" cannot be answered from SQL today.

### 2.5 `settings.json` new top-level fields
- **Severity:** Medium.
- **Fields:** `extraKnownMarketplaces`, `skipAutoPermissionPrompt`, `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- **TS status:** `SettingsFile` type at `packages/sdk/src/types/toplevel-files-data.ts` needs fresh audit; any missing fields fall into `unknown` / dropped.
- **RS status:** N/A (settings unparsed).
- **Impact:** Plugin marketplace discovery, experimental-feature gating, and permission-prompt behaviour aren't visible to consumers.

### 2.6 `cache/` — only `changelog.md` is read
- **Severity:** Low.
- **TS status:** `config-parser.ts:286-299` reads only `cache/changelog.md`. Other files under `cache/` (3 subdirs observed) are ignored.
- **RS status:** Not read.
- **Impact:** Changelog is surfaced; other cache contents are not triaged — unknown whether any are useful.

### 2.7 `plans/` in Rust — event defined but never emitted
- **Severity:** High (Rust drift — active bug).
- **Shape:** `~/.claude/plans/*.md`.
- **TS status:** Parsed by `ProjectParserImpl.buildPlanIndex()` at `project-parser.ts:596`.
- **RS status:** `IngestEvent::Plan` exists in `parse_sink.rs` and `SQL_INSERT_PLAN` exists in `writer.rs`, but **no code emits it** — `project_parser.rs` has no `read_plan` function. The `plans` table is created empty and stays empty when the Rust engine runs.
- **Impact:** Switching from TS engine to Rust engine silently drops plan data.

---

## 3. Covered in TS, absent in Rust (pure drift)

The Rust crate is intentionally scoped to project-sessions ingest (RFC 003). Until parity work lands, using the Rust engine loses everything below. Table form for density:

| Data | TS parser | Rust status | Severity |
|---|---|---|---|
| `settings.json` | `ConfigParserImpl.parseSettings` (`config-parser.ts:70`) | Not parsed | High |
| `settings.local.json` | Not parsed in TS either — see §1.5 | Not parsed | High (when TS adds it) |
| `plugins/` (installed, marketplaces, cache, manifests) | `ConfigParserImpl.parsePlugins` (`config-parser.ts:74-171`) | Not parsed | Medium |
| `statsig/` | `ConfigParserImpl.parseStatsig` (`config-parser.ts:173-204`) | Not parsed | Low |
| `ide/*.lock` | `ConfigParserImpl.parseIde` (`config-parser.ts:206-221`) | Not parsed | Medium |
| `shell-snapshots/` | `ConfigParserImpl.parseShellSnapshots` (`config-parser.ts:223-244`) | Not parsed | Medium |
| `cache/changelog.md` | `ConfigParserImpl.parseCache` (`config-parser.ts:286-299`) | Not parsed | Low |
| `statusline-command.sh` | `ConfigParserImpl.parseStatusLine` (`config-parser.ts:301-310`) | Not parsed | Low |
| `history.jsonl` | `AnalyticsParserImpl.parseHistory` (`analytics-parser.ts:79-87`) | Not parsed | High |
| `stats-cache.json` | `AnalyticsParserImpl.parseStatsCache` (`analytics-parser.ts:70-77`) | Not parsed | High |
| `telemetry/` | `AnalyticsParserImpl.parseTelemetry` (`analytics-parser.ts:89-110`) | Not parsed | Medium |
| `debug/` | `AnalyticsParserImpl.parseDebugLogs` (`analytics-parser.ts:128-164`) | Not parsed | Medium |
| `paste-cache/` | `AnalyticsParserImpl.parsePasteCache` (`analytics-parser.ts:219-241`) | Not parsed | Low |
| `session-env/` | `AnalyticsParserImpl.parseSessionEnv` (`analytics-parser.ts:243-255`) | Not parsed | Low |
| `plans/` | `ProjectParserImpl.buildPlanIndex` (`project-parser.ts:596`) | Event defined, **no emitter** — see §2.7 | High (drift) |

## 4. Type-level drift (values parsed but collapsed to `String`)

- **`tool_name` field** — TS narrows to a discriminated union (~30 tools + `mcp__${string}`) at `packages/sdk/src/types/projects.ts:290`. Rust stores `String` in `types/content.rs:45`. New tools don't fail the type but also don't get narrowed — downstream consumers can't exhaustively match.
- **`stop_reason` field** — TS has `'end_turn' | 'tool_use' | 'stop_sequence' | 'max_tokens' | null`. Rust uses `String` (`types/session.rs:362`).
- **`TodoItem.status`** — TS uses `'pending' | 'in_progress' | 'completed'`. Rust keeps it as `String`.

Severity: Low individually, but accumulates — all three would benefit from Rust enums with `#[serde(rename_all)]`.

---

## 5. Resolved since March 2026 audit

Keep for institutional memory:

- `RedactedThinkingBlock` content type — present.
- `max_tokens` stop_reason — present in TS union.
- Tool-name enum includes `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `SendMessage`, `CronCreate`/`CronDelete`/`CronList`, `LSP`, `TeamCreate`, `TeamDelete`, `TaskGet`.
- `SettingsFile` gained `effortLevel`, `enabledPlugins`, `alwaysThinkingEnabled`.
- 14 session-message variants at parity between TS and Rust.

---

## 6. Prioritized fix list

1. **Critical** — Add `teams/` parser (TS first: wire `teams-data.ts` types into `config-parser.ts`; then port to Rust).
2. **High** — Parse `settings.local.json` and merge into effective settings.
3. **High** — Fix Rust `plans/` — add `read_plan` call-site that emits the existing `IngestEvent::Plan`.
4. **High** — Promote session-JSONL new fields (`isSidechain`, `parentUuid`, `entrypoint`, nested `attachment`) to dedicated columns / writer fields.
5. **High** — First-class hook matchers from `settings.json.hooks[]`.
6. **Medium** — Subagent `.meta.json` sidecar reader (both pipelines).
7. **Medium** — `tasks/{sessionId}/{N}.json` item files (both pipelines).
8. **Medium** — Rust parity sprint: analytics pipeline, settings, plugins, statsig, ide, cache, shell-snapshots.
9. **Low/Medium** — `backups/`, `sessions/{pid}.json`, `hooks/` directory, root `CLAUDE.md`.
10. **Low** — Enum-narrow `tool_name`, `stop_reason`, `TodoItem.status` in Rust.
