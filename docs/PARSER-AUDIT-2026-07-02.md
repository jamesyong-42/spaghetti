# Parser Coverage Re-Audit — 2026-07-02

**Method:** 7-track multi-agent fan-out (51 agents) ground-truthing the current `~/.claude/` tree against the spaghetti TS SDK + Rust crate parsers, with adversarial per-finding verification. 41 findings survived verification (2 refuted, plus scope corrections); 20 distinct issues after dedup.

**Companion:** `PARSER-UNPARSED-DATA.md` (the running gap inventory — this report's status changes fold into it).

## Summary

Two months on, the parser core is healthy — TS/Rust SQLite DDL is byte-identical (v3), and the recently-landed plans-emitter, ToolUseResult-loosening, warm-start, and teams/ cold-start fixes all verify at parity — but an entire new class of workflow-orchestration artifacts has drifted out of coverage. Both engines' subagent readers (and the live watcher) are one level deep, so the now-dominant nested transcripts under subagents/workflows/wf_*/ (~50 MB, 12,600+ real conversation messages across 6 sessions), their per-workflow journal.jsonl (started/result with verbatim StructuredOutput findings), and the session-level workflows/wf_*.json run records (token/tool/agent analytics) are ingested by NEITHER engine — this is the only genuine data-loss tier and the top priority. A second, lower tier is type-model drift: three high-frequency new session message types (ai-title, mode, bridge-session) and three new system subtypes (away_summary/informational/scheduled_task_fire) are unmodeled in both the TS union and Rust enum, but loose-parse + raw-column fallbacks preserve every row, so the real cost is type-completeness plus minor FTS gaps (ai-title session titles and away_summary recap prose are unsearchable), not lost data. The rest is a long tail of low-severity, runtime-retained type gaps across settings.json (4 new keys), plugin/marketplace manifests, telemetry, history.jsonl (a content→contentHash migration), and orphaned types (ActiveSessionFile, mcp-needs-auth-cache). The one documented HIGH gap still genuinely unfixed is settings.local.json — read in the live path but never promoted into effective config, so displayed permissions still don't reflect reality.

## Prioritized fix list

- Recursively ingest nested subagent transcripts (subagents/workflows/wf_*/agent-*.jsonl) on both engines + fingerprint scan + live watcher — recovers ~12,600 dropped conversation messages (HIGH; the only true data loss).
- Promote settings.local.json into effective AgentConfig at cold start (documented §1.5 / fix #2) so displayed permissions match reality (HIGH; security-relevant).
- Add a WorkflowRun reader/table for session-level workflows/wf_*.json run analytics on both engines (MEDIUM; non-reconstructable token/tool/finding rollups).
- Ingest per-workflow journal.jsonl started/result (or fold result payloads into WorkflowRun) — recovers subagents' verbatim StructuredOutput findings text (MEDIUM).
- Model ai-title/mode/bridge-session in both unions and surface + index ai-title as the session title into FTS (MEDIUM; ai-title is the value driver, mode/bridge-session trivial).
- Add the 4 new settings.json keys (+ skipAutoPermissionPrompt) to SettingsFile (MEDIUM; typed-consumer visibility).
- Model system subtypes away_summary/informational/scheduled_task_fire + serde(other), and index system.content into FTS so away_summary recap prose is searchable (LOW; FTS win).
- Type the 3 untyped teams inbox payloads and name shutdown_request/shutdown_approved in doc §1.1 (LOW).
- Refresh ActiveSessionFile (sessions/{pid}.json) with status/updatedAt/... before wiring the §1.4 live-session reader (LOW; latent).
- Wire an mcp-needs-auth-cache.json reader + add the missing id field (LOW; orphaned type).
- Fix the SubagentMeta sidecar type (optional description, add spawnDepth, free-form agentType) + refresh doc §2.2 (LOW; unblocks fix-item 6).
- Refresh telemetry types (new event names, email, env keys, object auth) (LOW).
- Fix HistoryPastedContent for the content→contentHash migration (make content optional, add contentHash) (LOW).
- Correct PluginManifest commands/skills to string|string[] and add agents (LOW).
- Add Marketplace manifest displayName/startupTimeout/keywords/skills (LOW).
- Add a PluginBlocklistFile type + reader for plugins/blocklist.json (LOW).
- Add apiErrorStatus?:number / promptSource?:string to the message structs (LOW; data already retained).
- Add QueueOperationMessage.operation + McpProgress.status to the §4 Rust-enum-narrowing list (LOW).
- Read or explicitly skip session-env sessionstart-hook-*.sh scripts (LOW; ephemeral).
- Optional LastUpdateResult type/reader for .last-update-result.json; .last-cleanup trivial (LOW).
- Document projects/{slug}/vercel-plugin/skill-injections.jsonl as an out-of-scope project sidecar (LOW).
- Note plugins/data/ in the gaps doc; add a reader only when CC populates it (LOW).

## Recommended PR split

### feat(sdk,napi): recursively ingest nested workflow subagent transcripts
Prioritized #1 — recursive discovery of subagents/workflows/wf_*/agent-*.jsonl on both engines (parseSubagents recursive walk + Rust read_subagents + fingerprint scan_subagents), agentId namespacing to avoid the (project_slug, session_id, agent_id) PK collision, and a live-router rule for the nested path. Skip journal.jsonl. The headline data-loss fix; ships independently.

### feat(sdk,napi): capture workflow run analytics (workflows/wf_*.json + journal.jsonl)
Prioritized #3 + #4 — new WorkflowRun type, workflows table, parseWorkflows reader for session-level workflows/wf_*.json + IngestEvent/sink on both engines; ingest per-workflow journal.jsonl started/result folded into the run record. Coherent 'workflow run analytics' feature; independently shippable after PR 1.

### feat(sdk,napi): complete the session message-type model (both engines)
Prioritized #5 + #7 + #17 + #18 — add ai-title/mode/bridge-session to the TS union and Rust enum, add away_summary/informational/scheduled_task_fire system subtypes + serde(other) guard, surface ai-title as session title and index ai-title/system.content into FTS on both extractors, add apiErrorStatus?/promptSource? fields, and add operation/McpProgress.status Rust enums. All touch projects.ts + session.rs + fts extractors symmetrically.

### fix(sdk): promote settings.local.json into effective AgentConfig
Prioritized #2 — add a settingsLocal slot to AgentConfig, read settings.local.json at cold start (not just the live transient event), and merge permissions so effective/displayed permissions are correct. Documented HIGH fix #2; TS-only; security-relevant.

### feat(sdk): settings + plugin config type coverage (TS)
Prioritized #6 + #14 + #15 + #16 + #10 + the code half of #8 — 4 new settings.json keys; PluginManifest commands/skills/agents; Marketplace displayName/startupTimeout/keywords/skills; PluginBlocklistFile type+reader; mcp-needs-auth-cache reader + id field; optional teams InboxPayload interfaces. All config-domain, TS-only.

### feat(sdk): analytics + top-level file type coverage (TS)
Prioritized #12 + #13 + #9 + #19 + #20 — telemetry type refresh (event names/email/env/object auth); history.jsonl content→contentHash fix; ActiveSessionFile stale-shape refresh; session-env inner-script read-or-skip; optional LastUpdateResult type. All analytics/top-level-domain, TS-only.

### docs: refresh PARSER-UNPARSED-DATA.md gap inventory
All statusChanges + the doc halves of #8/#11/#21/#22 — refresh §2.2 sidecar shape (+ projects.ts:88→types/index.ts:89 cite), §1.4 ActiveSessionFile shape, §1.5 settings.local live-path clarification, §2.5 (extraKnownMarketplaces resolved, 4 new keys), §4 (add operation/McpProgress.status), §1.1:28 (name shutdown_*); add new entries for the two workflows subtrees, skill-injections.jsonl, plugins/data/, mcp-needs-auth-cache, blocklist, and .last-update-result. Docs-only.

## Findings (verified)

### Nested workflow subagent transcripts (subagents/workflows/wf_*/agent-*.jsonl) are ingested by neither engine nor the live watcher — both subagent readers are one level deep
- **Severity:** high  |  **Kind:** coverage-gap
- **TS:** GAP. parseSubagents (project-parser.ts:445) calls scanDirectorySync(subagentsDir,{pattern:'*.jsonl'}) with no recursive flag; scanDirectorySync only descends when options.recursive is set (io/file-service.ts:472). Live router regex (live/router.ts:113) only matches subagents/agent-[^/]+.jsonl.
- **RS:** GAP. read_subagents (project_parser.rs:499) does a one-level std::fs::read_dir filtering .jsonl; the workflows/ dir entry is skipped. fingerprint.rs scan_subagents is also non-recursive, so warm-start is blind too.
- **Evidence:** ~323-344 nested agent-*.jsonl (~50 MB, 12,600+ real user/assistant/attachment messages across 6 sessions), now 82% of recent subagent files; nested agentIds have zero overlap with the ingested top-level set (comm -12 empty), so they are distinct transcripts, not duplicates.
- **Fix:** Recurse subagents/workflows/wf_*/ (skip journal.jsonl) on both engines and namespace agentId with the wf id to avoid (project_slug, session_id, agent_id) PK collisions; add a live-router rule for the nested path.

### Session-level workflows/wf_*.json run records (agent-orchestration run analytics) + scripts/*.js are read by neither engine
- **Severity:** medium  |  **Kind:** new-dir
- **TS:** GAP. The per-session artifact walk (project-parser.ts:197-229, buildSession :300-311) enumerates only subagents/tool-results/file-history/todos/task — never <sid>/workflows/. No type, no reader, no sink event.
- **RS:** GAP. parse_one_session (project_parser.rs:236-280) mirrors the same allow-list; fingerprint.rs scan_project_sessions never discovers workflows/, so warm-start is blind.
- **Evidence:** ~29 projects/{slug}/{sid}/workflows/wf_*.json (~2.9 MB) carry non-reconstructable run rollups (agentCount, totalTokens up to 304840, totalToolCalls, durationMs, phases, result{confirmed,refuted_count,uncertain}, status, workflowProgress[]) plus a scripts/ sibling; grep 'workflow'/'wf_' across packages+crates = 0. (Mislabeled 'Vercel Workflow DevKit' by one track — payload is Claude agent-orchestration telemetry.)
- **Fix:** Add a WorkflowRun type + parseWorkflows reader keyed by sessionId (mirror parseSubagents), a workflows table, and a sink event on both engines; promote runId/workflowName/status/tokens/toolCalls/agentCount/durationMs to columns, store workflowProgress+result as JSON.

### Per-workflow journal.jsonl (started/result events with verbatim subagent StructuredOutput) is unparsed; started/result unknown to both engines
- **Severity:** medium  |  **Kind:** new-file
- **TS:** GAP. journal.jsonl sits under the un-recursed workflows/ subtree (see nested-transcript finding); SessionMessageType/SessionMessage lack started/result.
- **RS:** GAP. Not read; enum lacks Started/Result. Asymmetry: read_subagents pushes only lines passing the typed serde parse (project_parser.rs:519), so if journals were routed through it these lines would be silently dropped — a nested reader must handle them explicitly.
- **Evidence:** 30 subagents/workflows/wf_*/journal.jsonl (started ~323 / result ~315); result lines embed a subagent's final StructuredOutput (findings/analysis text) verbatim — the richest record of each subagent's conclusion, never ingested; started/result appear ONLY here, never in agent-*.jsonl.
- **Fix:** When walking wf_*/, ingest journal.jsonl as a workflow-journal artifact (or fold its result payloads into the WorkflowRun record); add Started/Result variants with Result.result as an opaque object.

### Three new session message types (ai-title, mode, bridge-session) are unmodeled in both the TS union and Rust enum
- **Severity:** medium  |  **Kind:** new-message-type
- **TS:** Rows preserved — onMessage stores data=JSON.stringify(message) with msg_type from raw .type (ingest-service.ts:221,479) — but the three are absent from SessionMessageType/SessionMessage (projects.ts:50-80); extractTextContent has no ai-title arm, so session titles never reach FTS.
- **RS:** Rows preserved via loose Value parse (project_parser.rs:301-344), but the typed SessionMessage parse fails on ~4900+ real lines (no serde(other) on the enum, session.rs:25-43), leaving fts_text=None; ai-title title text is unsearchable.
- **Evidence:** Recent volume ai-title x2300+, mode x1865, bridge-session x757; shapes {aiTitle,sessionId,type} / {mode,sessionId,type} / {bridgeSessionId,lastSequenceNum,sessionId,type}; all absent from both unions; repo grep for aiTitle/bridgeSessionId = 0. ai-title is additive to (not a rename of) custom-title.
- **Fix:** Add AiTitle/Mode/BridgeSession variants to both unions (keep custom-title for legacy files). ai-title is the value driver: surface aiTitle as the session title and index it into FTS on both extractors. mode (always 'normal') and bridge-session (opaque IDs) are trivial type-completeness only.

### settings.json has 4 new top-level keys absent from SettingsFile (tui, autoCompactEnabled, agentPushNotifEnabled, skipWorkflowUsageWarning)
- **Severity:** medium  |  **Kind:** new-field
- **TS:** Parsed as a whole-object cast so values survive at runtime, but SettingsFile has no index signature so typed consumers can't read them; config is in-memory only.
- **RS:** N/A — settings/config domain is TS-only (RFC 003 / doc §3).
- **Evidence:** jq: tui='fullscreen', autoCompactEnabled=false, agentPushNotifEnabled=true, skipWorkflowUsageWarning=true — all present, none in SettingsFile (toplevel-files-data.ts:33-43); grep across packages+crates = 0.
- **Fix:** Add tui?:string, autoCompactEnabled?:boolean, agentPushNotifEnabled?:boolean, skipWorkflowUsageWarning?:boolean (+ skipAutoPermissionPrompt?:boolean, still missing per §2.5) to SettingsFile.

### system subtypes away_summary + informational (+ scheduled_task_fire) are unmodeled and FTS-invisible on both engines
- **Severity:** low  |  **Kind:** new-message-type
- **TS:** No data loss (raw kept in messages.data), but system.content is never indexed into FTS (extractTextContent handles only user/assistant/summary), so away_summary recap prose is unsearchable.
- **RS:** Typed SystemMessagePayload parse fails on these subtypes (no serde(other)) → fts_text=None, but the row is still emitted; symmetric with TS. FTS-exclusion of system messages is an intentional, symmetric class-wide choice.
- **Evidence:** type:system subtypes away_summary (~705 lines, real recap prose e.g. 'Recovering your deleted voyager-web project... Next: re-auth AWS...') + informational (content+level) + scheduled_task_fire (~31) are absent from SystemMessagePayload's 7 variants (session.rs:328) and the TS SystemMessage union (projects.ts:351); no serde(other).
- **Fix:** Add away_summary/informational/scheduled_task_fire variants + a serde(other) guard on SystemMessagePayload; optionally index SystemMessage.content into FTS on both extractors so recap/status prose becomes searchable.

### Teams inbox `text` payloads: 3 of 4 variants untyped; shutdown_request/shutdown_approved undocumented
- **Severity:** low  |  **Kind:** new-message-type
- **TS:** No data loss — parseTeamInboxes keeps text verbatim as a raw string (config-parser.ts:331) — but 3 of 4 payload variants are untyped and doc §1.1:28 names only 'idle notifications, task assignments'.
- **RS:** N/A — no Rust teams parser exists (documented pending, doc §1.1 / fix-item 8).
- **Evidence:** Inbox text strings decode to 4 payload types (idle_notification 60, task_assignment 6, shutdown_request 3, shutdown_approved 3); only TaskAssignmentPayload is typed (teams-data.ts:45) and it's never even wired; idleReason/reason/requestId/paneId/backendType have no typed home.
- **Fix:** Add IdleNotification/ShutdownRequest/ShutdownApproved interfaces (or an InboxPayload union keyed on type) beside TaskAssignmentPayload; at minimum name shutdown_request/shutdown_approved in doc §1.1. (Highest-value part is the doc patch — no consumer decodes text today.)

### sessions/{pid}.json ActiveSessionFile type is materially stale (6 always-present new fields + 2 partial)
- **Severity:** low  |  **Kind:** new-field
- **TS:** No reader exists (documented §1.4), so no active data loss; but the recorded type/shape is now stale — status/updatedAt are exactly the fields a live-session list needs, and the doc §1.4:50 shape mirrors the stale type.
- **RS:** N/A — top-level files TS-only.
- **Evidence:** jq over all 7 sessions/*.json: procStart/version/peerProtocol/status/updatedAt/statusUpdatedAt present 7/7 (status ∈ busy|idle|shell), + nameSource(2/7), bridgeSessionId(1/7) — none in ActiveSessionFile (toplevel-files-data.ts:118-126).
- **Fix:** Extend ActiveSessionFile with status/updatedAt/statusUpdatedAt/procStart/version/peerProtocol + nameSource?/bridgeSessionId? BEFORE wiring the §1.4 reader; update the doc §1.4 shape.

### mcp-needs-auth-cache.json: type McpNeedsAuthCache defined but never wired to any parser, and the value type omits the real `id` field
- **Severity:** low  |  **Kind:** coverage-gap
- **TS:** Type-only, never wired (not in config-parser or analytics-parser); value type {timestamp} omits id. Latent — unwired, so no active loss today.
- **RS:** N/A — top-level files TS-only.
- **Evidence:** ~/.claude/mcp-needs-auth-cache.json (4 entries); 3 claude.ai entries carry id:'mcpsrv_...' absent from the value type; McpNeedsAuthCache (toplevel-files-data.ts:113) is defined but grep finds no reader and it's absent from the TopLevelFiles aggregate.
- **Fix:** Widen the value type to {timestamp:number; id?:string} and add a small reader surfaced on AgentConfig/AgentAnalytic.

### SubagentMeta .meta.json sidecar shape and agentType vocabulary have drifted (doc §2.2 is stale)
- **Severity:** low  |  **Kind:** type-mismatch
- **TS:** Sidecar still unread (documented §2.2) but the doc's shape {agentType, description} no longer holds — description absent for workflow metas, spawnDepth new; mismatch is dead today (meta always None).
- **RS:** Rust SubagentMeta.description is REQUIRED with no serde default (types/project.rs:81) — it would error deserializing the description-less metas and drop spawnDepth if a reader were wired.
- **Evidence:** All 322 nested workflow metas are {agentType[,spawnDepth]} with NO description (agentType ∈ workflow-subagent/general-purpose/Explore); flat metas add name/model/taskKind/teamName/toolUseId/color/permissionMode/planModeRequired; 22+ agentType values, none in the 3-value filename-inferred enum.
- **Fix:** Make description optional, add spawnDepth, treat agentType as a free-form string (source of truth, not filename-inferred); refresh doc §2.2 shape and fix its projects.ts:88 → types/index.ts:89 cite. (Ships with the §2.2 fix-item 6 sidecar reader.)

### telemetry types stale: new event_name values + event_data.email + new env keys, and auth mistyped as string
- **Severity:** low  |  **Kind:** type-mismatch
- **TS:** Data retained at runtime (readJsonlSync bare cast); the union/interfaces are stale and auth is actively mistyped.
- **RS:** N/A — telemetry TS-only.
- **Evidence:** Recent telemetry/*.json add event_name tengu_feature_ok / tengu_file_suggestions_git_ls_files (not in TelemetryEventName), event_data.email, env keys build_time/is_local_agent_mode/platform_raw/shell/vcs; and auth is an object {organization_uuid,account_uuid} but is typed string (telemetry-data.ts:73).
- **Fix:** Add the new event names (or widen TelemetryEventName to `... | string`), add email? + the 5 env keys, and change auth to an object type.

### history.jsonl pastedContents is a content→contentHash migration; HistoryPastedContent type is wrong for 56% of entries
- **Severity:** low  |  **Kind:** type-mismatch
- **TS:** Retained at runtime via parseHistory; type stale — content is falsely required (absent on 56% of entries) and contentHash is undeclared.
- **RS:** N/A — history.jsonl TS-only.
- **Evidence:** 686 pastedContents entries: 386 have contentHash+no content, 300 have content+no contentHash (strictly mutually exclusive migration, 0 both); HistoryPastedContent (toplevel-files-data.ts:89-93) declares content:string (required) + no contentHash.
- **Fix:** Change to content?:string; contentHash?:string (not just add contentHash? — must also make content optional).

### PluginManifest.commands/skills typed `string` but real data is `string[]`; `agents` field absent
- **Severity:** low  |  **Kind:** type-mismatch
- **TS:** Manifest stored whole so arrays survive at runtime, but commands typed string breaks any string op and agents is invisible to typed access; no consumer reads them today.
- **RS:** N/A — plugin config TS-only.
- **Evidence:** vercel 0.44.0 plugin.json has commands=array(5) and agents=array(3); PluginManifest (plugins-data.ts:64-65) declares commands?/skills? as string and has no agents field (1 of 18 cached manifests is array-shaped).
- **Fix:** Type commands/skills as string|string[] and add agents?:string|string[] (skills-as-array is spec-inferred; commands+agents confirmed array on disk).

### Marketplace manifest: MarketplacePluginEntry.displayName/keywords/skills and LspServerConfig.startupTimeout missing from types
- **Severity:** low  |  **Kind:** new-field
- **TS:** Manifest stored whole so fields survive at runtime; undeclared in the types.
- **RS:** N/A — plugin config TS-only.
- **Evidence:** marketplace.json: plugins.N.displayName (1 entry 'Convex'), lspServers.jdtls/kotlin-lsp.startupTimeout=120000, plus undeclared keywords/skills; none in MarketplacePluginEntry (plugins-data.ts:76-87) / LspServerConfig (:70-74).
- **Fix:** Add displayName?:string, keywords?:string[], skills?:string to MarketplacePluginEntry and startupTimeout?:number to LspServerConfig.

### plugins/blocklist.json — new file with no type and no parser
- **Severity:** low  |  **Kind:** new-file
- **TS:** Not read; no type; PluginsDirectory has no index signature so no passthrough.
- **RS:** N/A — plugin config TS-only.
- **Evidence:** ~/.claude/plugins/blocklist.json = {fetchedAt, plugins:[{plugin, added_at, reason, text}]}; parsePlugins (config-parser.ts:82-97) reads 5 other plugin files but never blocklist.json; PluginsDirectory has no blocklist field; schema already validated by scripts/validate_config_and_settings.py.
- **Fix:** Add a PluginBlocklistFile type ({fetchedAt; plugins:[{plugin, added_at, reason, text}]}) and read it into PluginsDirectory.blocklist (reuse the validator's inferred schema).

### New top-level apiErrorStatus (assistant) and promptSource (user) fields absent from the typed structs
- **Severity:** low  |  **Kind:** new-field
- **TS:** Not a data gap — onMessage stores data=JSON.stringify(message) so both survive verbatim in messages.data; AssistantMessage/UserMessage just omit them (no index signature).
- **RS:** Not a data gap — serde ignores unknown fields (no deny_unknown_fields), raw line preserved in messages.data; typed structs omit them.
- **Evidence:** apiErrorStatus on assistant lines (36 occ; values 429/400/401/404/529 — numbers), promptSource on user lines (280 occ; typed/system/queued/suggestion_accepted); neither string appears in projects.ts or session.rs.
- **Fix:** Add apiErrorStatus?:number (NOT string — on-disk values are HTTP status numbers) to AssistantMessage and promptSource?:string to UserMessage.

### session-env/{uuid}/sessionstart-hook-*.sh scripts are never read; parser captures only the directory name
- **Severity:** low  |  **Kind:** coverage-gap
- **TS:** Partial — session ids captured, inner hook scripts unread; not documented (session-env is in the live HARD_IGNORE list, low-value/ephemeral).
- **RS:** N/A — session-env TS-only.
- **Evidence:** parseSessionEnv (analytics-parser.ts:248-250) maps each dir to {sessionId} only; find -mindepth 2 = 268 real sessionstart-hook-*.sh (Vercel-plugin env exports) never read; SessionEnvEntry (session-env.ts:5-7) has only sessionId.
- **Fix:** Optionally read scripts into SessionEnvEntry.scripts[]{name,size} OR add a docs note that inner scripts are intentionally skipped.

### New top-level status files .last-update-result.json and .last-cleanup are unmodeled
- **Severity:** low  |  **Kind:** new-file
- **TS:** Not parsed; no type. The update-failure signal is also captured via telemetry (tengu_native_auto_updater_fail), so low value.
- **RS:** N/A — top-level files TS-only.
- **Evidence:** ~/.claude/.last-update-result.json = {timestamp, path:native, outcome:failed, status:install_failed, version_from:2.1.198, version_to:null, error_code:null}; .last-cleanup = bare ISO timestamp; no type, grep = 0.
- **Fix:** Optional: add a LastUpdateResult type + reader (version_from/version_to/status/outcome) in analytics-parser; .last-cleanup is a trivial timestamp — or just record as §1.7-style trivia in the doc.

### projects/{slug}/vercel-plugin/skill-injections.jsonl (per-project plugin telemetry) has zero coverage
- **Severity:** low  |  **Kind:** new-file
- **TS:** Not read — the per-project vercel-plugin/ dir sits beside session files and is never scanned; filename doesn't match UUID_JSONL so it isn't even mistaken for a session.
- **RS:** Not read (mirrors TS).
- **Evidence:** 74 per-project vercel-plugin/skill-injections.jsonl (events prompt-skill-injection/skill-injection; keys matchedSkills/injectedSkills/droppedByCap/toolName/toolTarget/contextChunks); grep skill-injections across packages+crates = 0.
- **Fix:** Out-of-scope unless Vercel-plugin analytics are wanted; document as a known project-level sidecar (like doc §1.7).

### plugins/data/{plugin}-{marketplace}/ directories have zero mention (CC-managed, empty today)
- **Severity:** low  |  **Kind:** new-dir
- **TS:** Not scanned; empty today but a new CC-managed plugin-scoped data root.
- **RS:** N/A — plugin config TS-only.
- **Evidence:** ~/.claude/plugins/data/ has 10 {plugin}-{marketplace} subdirs (all 0 bytes today); parsePlugins knows cache/ and marketplaces/ but not data/; grep = 0; absent from the gaps doc.
- **Fix:** Add a one-line note to PARSER-UNPARSED-DATA.md §1; add a reader only once CC populates the dir.

## Status changes to the gap inventory

- §1.5 settings.local.json: still the top unfixed HIGH gap, but 'Not parsed' is now imprecise — settings-handler.ts DOES read + JSON.parse it in the live path (transient settings.changed event); it is deliberately not promoted into AgentConfig (no settingsLocal slot) and never runs at cold start, so effective/displayed permissions still omit all 19 entries.
- §1.4 sessions/{pid}.json: the recorded ActiveSessionFile shape is now materially stale — 6 always-present new fields (status/updatedAt/statusUpdatedAt/procStart/version/peerProtocol) plus nameSource/bridgeSessionId; the 'type defined, no reader' status is otherwise unchanged.
- §2.2 subagent .meta.json: the documented shape {agentType, description} no longer holds — nested workflow metas are {agentType, spawnDepth} with description absent, flat metas carry ~10 more fields, and agentType has 22+ real values vs the 3-value inferred enum; the Rust type's required `description` would now fail to deserialize. (Doc also cites the type at projects.ts:88; it lives at types/index.ts:89.)
- §2.5 settings.json new fields: partially resolved — extraKnownMarketplaces is now in SettingsFile — but the promised 'fresh audit' surfaces 4 more missing keys (tui, autoCompactEnabled, agentPushNotifEnabled, skipWorkflowUsageWarning), with skipAutoPermissionPrompt still absent.
- §4 string-vs-union drift: two more same-class instances beyond tool_name/stop_reason/TodoItem.status — QueueOperationMessage.operation (session.rs:586) and McpProgress.status (session.rs:519); still Low, still no data loss (raw line stored whole). (Doc's stop_reason cite session.rs:362 is imprecise; the union's stop_reason is content.rs:155.)
- §1.1 teams/: cold-start parser re-confirmed matching current on-disk shape (config.json/members/inbox/orphaned-dir/empty-array all handled); the only delta is that the inbox-text enumeration at line 28 should also name shutdown_request/shutdown_approved. Rust port + live-watch + inbox-FTS remain pending as documented.
- §2.7 plans/ (Rust emitter) and §3.1 ToolUseResult/FTS: verified resolved and holding — Rust now emits plans and accepts opaque string|object toolUseResult at parity, and the TS/Rust SQLite DDL is byte-identical (SCHEMA_VERSION=3). No regression.

## Refuted / scope-corrected (do not chase)

- Non-.txt tool-result sidecars (.json/images) are NOT dropped: the 4 .json files are all Agent subagent results whose full text is already ingested and FTS-indexed via subagents/agent-*.jsonl, and the inline parent tool_result preview is separately FTS-indexed — present-but-not-promoted, and promoting them would add zero FTS coverage.
- started/result are NOT a messages-table/FTS gap: they exist ONLY in workflow journal.jsonl and never enter the main-session message pipeline on either engine, so adding union/enum variants alone is inert — the real gap is that journal.jsonl is unread (tracked as the journal.jsonl finding), which needs a dedicated nested reader.
- apiErrorStatus is a number (HTTP status 429/400/401/404/529), not a string — the suggested `apiErrorStatus?: string` fix is mistyped; use number.
- The 'history.jsonl / telemetry listed Not parsed but actually parsed' doc-inconsistency claims are misreads of the §3.1 table's Rust-status column — both ARE parsed in TS and correctly Not parsed in Rust; there is no doc error at lines 164/166.
- Scope inflation to ignore: artifacts-2's '345 wf_*.json' is ~12x over (actual ~29), and artifacts-1's 'total blackout for every workflow session' holds for only 1 of 6 sessions (the other 5 also have parsed top-level transcripts) — the workflow gap is real but narrower than first stated.
- The 'single nested file with 1598 assistant + 705 user messages' figure is mislabeled — the largest nested transcript is ~134 lines; that number is an inflated/aggregate value (true all-sessions aggregate ~7505/4106/1031).
