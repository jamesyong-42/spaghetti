# RFC 002: Full Session Mirror Chat

**Status:** Draft
**Date:** 2026-04-16
**Author:** James + Claude

## Problem

The chat view (`chat-view.tsx`) connects to active channel sessions via `ChannelManager` but shows an empty transcript. The channel plugin is a WS bridge for *injecting* messages and relaying permissions — it was never designed to mirror the actual Claude Code conversation. Users expect to open the chat view and see the full ongoing conversation: user prompts, Claude responses, tool activity, permission prompts, and status — like a remote terminal.

## Goal

Build a chat app experience that fully mirrors any active Claude Code session:

1. **Full history** — see all past messages (user prompts + Claude responses) on connect
2. **Live messages** — see new user/assistant turns appear in real time
3. **Real-time status** — see what Claude is doing (thinking, running tools, idle)
4. **Permission prompts** — approve/deny tool use remotely
5. **Send messages** — inject prompts into the session via channel bridge
6. **Answer elicitations** — respond to Claude's questions remotely

## Inventory: What Already Exists

### SDK (`@vibecook/spaghetti-sdk`)

| Component | Location | What it does |
|---|---|---|
| `readJsonlStreaming()` | `io/streaming-jsonl-reader.ts` | Buffer-based JSONL reader with `fromBytePosition` for incremental reads |
| `ClaudeCodeParser` | `parser/claude-code-parser.ts` | Parses transcript JSONLs into typed `SessionMessage[]` |
| `SpaghettiAPI.getSessionMessages()` | `api.ts:93` | Paginated session message reads (projectSlug + sessionId) |
| `SessionMessage` types | `types/projects.ts:50-80` | 14 message types: user, assistant, system, progress, attachment, etc. |
| `UserMessage` | `types/projects.ts:153-174` | User prompts with content blocks (text, tool_result, image, document) |
| `AssistantMessage` | `types/projects.ts:241-250` | Claude responses with text, thinking, tool_use blocks |
| `ToolUseBlock` | `types/projects.ts:283-288` | Tool invocations (name, input, id) |
| `ChannelManager` | `io/channel-manager.ts` | Fleet of WS clients, one per live session, session switching |
| `ChannelRegistry` | `io/channel-registry.ts` | Watches `~/.spaghetti/channel/sessions/` for live sessions (15s heartbeat) |
| `ChannelClient` | `io/channel-client.ts` | Per-session WS client with reconnect, send/receive, history from JSONL |
| `HookEventWatcher` | `io/hook-event-watcher.ts` | Real-time tail of `~/.spaghetti/hooks/events.jsonl` with incremental reads |
| `HookEvent` | `types/hook-events.ts:80-90` | Has `sessionId`, `transcriptPath`, `event`, `payload` |
| `FileService.watchDirectory()` | `io/file-service.ts:160` | Chokidar-based dir watcher with awaitWriteFinish |
| `FileService.watchFile()` | `io/file-service.ts:178` | Native fs.watch on single files |
| `SessionIndexEntry` | `types/projects.ts:400-412` | Session discovery: sessionId, fullPath, fileMtime, firstPrompt |

### Channel Plugin (`claude-code-channels-plugin`)

| API | Direction | Purpose |
|---|---|---|
| `notifications/claude/channel` | server → Claude | Push external messages into session |
| `notifications/claude/channel/permission` | server → Claude | Relay permission verdicts |
| `notifications/claude/channel/permission_request` | Claude → server | Receive permission prompts |
| `reply` tool | Claude calls | Send reply text to WS clients |
| `edit_message` tool | Claude calls | Edit a previously sent reply |
| WS `message` | client → server | External client sends message |
| WS `permission_verdict` | client → server | External client approves/denies |
| WS `ping`/`pong` | bidirectional | Keepalive |

### Hooks Plugin (`claude-code-hooks-plugin`)

Captures 24 hook events. Every event includes `sessionId` + `transcriptPath` + `cwd` + `agentId`.
Key events for mirroring:

| Event | What it tells us |
|---|---|
| `SessionStart` | New session began (with transcriptPath) |
| `SessionEnd` | Session ended |
| `UserPromptSubmit` | User just submitted a prompt |
| `PreToolUse` | Claude is about to use a tool (name, input) |
| `PostToolUse` | Tool execution completed (with result) |
| `PermissionRequest` | Claude is waiting for permission |
| `Stop` | Claude finished a turn |
| `SubagentStart/Stop` | Subagent lifecycle |
| `Elicitation` | Claude is asking the user a question |
| `ElicitationResult` | User answered the question |
| `PreCompact/PostCompact` | Context compaction happening |

### CLI (`packages/cli`)

| Component | Location | Relevance |
|---|---|---|
| `ChatView` | `views/chat-view.tsx` | Current chat — renders channel messages only (empty) |
| `MessagesView` | `views/messages-view.tsx` | Renders full transcript with user/assistant/tool/thinking blocks |
| `HooksMonitorView` | `views/hooks-monitor-view.tsx` | Real-time hook event stream |
| `display-items.ts` | `views/display-items.ts` | Flattens `SessionMessage[]` into renderable `DisplayItem[]` |
| Shell view stack | `views/shell.tsx` | Push/pop navigation, breadcrumbs |

## Architecture

### Core Insight

We have two independent real-time data sources that, combined, give us everything:

```
Transcript JSONL (file watch)     →  Full message history + new messages
  ~/.claude/projects/*/session.jsonl

Hooks Events JSONL (watcher)      →  Real-time status + session identity mapping
  ~/.spaghetti/hooks/events.jsonl

Channel WS Bridge (existing)      →  Send messages + permission relay
  ws://127.0.0.1:<port>
```

The missing link is a **session identity bridge** that correlates:
- Hook `sessionId` + `transcriptPath` (from every hook event)
- Channel `SessionInfo.id` + `port` (from discovery files)
- Claude Code session transcript file

### Data Flow

```
┌──────────────────────────────────────────────────────────┐
│                    Chat View (TUI/Web)                   │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Transcript   │  │ Status Bar   │  │ Input Bar      │  │
│  │ (scrollable) │  │ (live)       │  │ (send/approve) │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
└─────────┼────────────────┼──────────────────┼────────────┘
          │                │                  │
          │ read           │ subscribe        │ send
          │                │                  │
┌─────────▼────────┐ ┌────▼──────────┐ ┌────▼──────────────┐
│ TranscriptStream │ │ SessionStatus │ │ ChannelClient      │
│ (new component)  │ │ (from hooks)  │ │ (existing)         │
│                  │ │               │ │                    │
│ - Cold: parse    │ │ - PreToolUse  │ │ - sendMessage()    │
│   full JSONL     │ │ - PostToolUse │ │ - sendVerdict()    │
│ - Live: tail     │ │ - Stop        │ │ - notifications/   │
│   new lines      │ │ - Elicitation │ │   claude/channel   │
└─────────┬────────┘ └──────┬───────┘ └────────────────────┘
          │                 │
          │ file watch      │ event stream
          │                 │
    ┌─────▼─────┐    ┌─────▼──────────────┐
    │ Transcript │    │ ~/.spaghetti/hooks │
    │ JSONL file │    │ /events.jsonl      │
    └───────────┘    └────────────────────┘
```

## Design: 5 Components

---

### Component 1: Session Identity Bridge

**Problem:** Channel sessions have their own UUID (`server.ts:38`) with no link to the Claude Code session (`claudeSessionId: null`). The hooks plugin knows `sessionId` + `transcriptPath` for every event but has no link to the channel session either.

**Solution:** Use process tree correlation.

Each channel discovery file has `pid` (channel MCP process) and `parentPid` (Claude Code process). Each hook event has `sessionId` and is emitted by the same Claude Code process. We can correlate:

```
Channel SessionInfo.parentPid  ←→  Hook event source process
```

**Implementation:**

New SDK module: `io/session-bridge.ts`

```typescript
export interface BridgedSession {
  /** Channel discovery info (WS port, pid, etc.) */
  channel: SessionInfo;
  /** Claude Code session ID (from hooks) */
  claudeSessionId: string | null;
  /** Path to transcript JSONL */
  transcriptPath: string | null;
  /** Real project cwd (from hooks, not the plugin cache dir) */
  projectCwd: string | null;
  /** Real project name derived from cwd */
  projectName: string;
  /** Last known status from hooks */
  lastStatus: SessionActivityStatus;
}

export type SessionActivityStatus =
  | { state: 'idle' }
  | { state: 'thinking' }
  | { state: 'tool_use'; toolName: string; toolInput?: Record<string, unknown> }
  | { state: 'permission_pending'; toolName: string; requestId: string }
  | { state: 'elicitation_pending'; question: string }
  | { state: 'compact' }
  | { state: 'stopped'; stopReason?: string };

export interface SessionBridge {
  start(): void;
  stop(): void;
  /** All currently bridged sessions */
  getSessions(): BridgedSession[];
  /** Get bridge info by channel session ID */
  getByChannelId(channelSessionId: string): BridgedSession | null;
  /** Subscribe to session list changes */
  onChange(cb: (sessions: BridgedSession[]) => void): () => void;
}
```

**Correlation algorithm:**

1. `ChannelRegistry` provides live channel sessions with `parentPid`
2. `HookEventWatcher` streams hook events with `sessionId` + `transcriptPath`
3. On each hook event, check if `os.ppid` or process ancestry matches a channel's `parentPid`

Simpler approach (no process tree walking): maintain a map of `transcriptPath → last hook event timestamp`. On `SessionStart` events, the hooks provide both `sessionId` and `transcriptPath`. Store this mapping. When a new channel session appears, read the first few hook events to find a `SessionStart` whose timestamp is close to the channel's `startedAt`.

**Simplest viable approach:** Use the hooks stream to build a `sessionId → transcriptPath` lookup. The channel plugin can be extended to query this on boot, or the TUI can maintain the lookup and match channel sessions to Claude Code sessions by comparing `parentPid` against the PID that spawned the Claude Code process.

**Recommended approach:** Extend the hooks plugin to write a small sidecar file:

```
~/.spaghetti/hooks/sessions/<sessionId>.json
```

```json
{
  "sessionId": "f790a550-...",
  "transcriptPath": "/Users/.../<sessionId>.jsonl",
  "cwd": "/Users/.../project",
  "startedAt": "2026-04-16T01:14:...",
  "pid": 12345
}
```

The hook handler (`hook-handler.mjs`) already receives `session_id`, `transcript_path`, and `cwd` on every event. On `SessionStart`, write this file. On `SessionEnd`, delete it. The session bridge then reads both `~/.spaghetti/channel/sessions/` and `~/.spaghetti/hooks/sessions/`, correlating by PID ancestry or by startedAt proximity.

**Effort:** Small — ~20 lines added to `hook-handler.mjs`, ~150 lines for `session-bridge.ts`.

---

### Component 2: Transcript Streamer

**Problem:** Need to read the full transcript JSONL for history and tail it for live updates.

**Solution:** Build on existing `readJsonlStreaming()` which already supports `fromBytePosition`.

New SDK module: `io/transcript-streamer.ts`

```typescript
export interface TranscriptStreamerOptions {
  /** Path to the session transcript JSONL */
  transcriptPath: string;
  /** How many recent messages to load on cold start (default: 200) */
  initialLimit?: number;
  /** Debounce interval for file change detection (default: 100ms) */
  debounceMs?: number;
}

export interface TranscriptStreamer {
  start(): void;
  stop(): void;
  /** Get all messages loaded so far */
  getMessages(): SessionMessage[];
  /** Subscribe to new messages as they arrive */
  onMessage(cb: (msg: SessionMessage) => void): () => void;
  /** Subscribe to message list changes (batch, e.g., on cold load) */
  onBatch(cb: (msgs: SessionMessage[]) => void): () => void;
}
```

**Implementation:**

1. **Cold start:** Call `readJsonlStreaming(transcriptPath, cb)` to load existing messages. Parse each line into `SessionMessage` using the existing project parser logic. Store in array, track `finalBytePosition`.

2. **Live tail:** Use `fs.watch()` on the transcript file (same pattern as `HookEventWatcher`). On change, call `readJsonlStreaming(transcriptPath, cb, { fromBytePosition: lastBytePos })` to read only new lines. Emit each new `SessionMessage` to listeners.

3. **Debouncing:** 100ms debounce on file watch events (transcript writes can be rapid during tool use).

**Key detail:** The transcript JSONL is append-only during a session. Lines are never modified or deleted. This makes incremental tailing safe — `fromBytePosition` always reads only new content.

**Message type handling:** The streamer emits raw `SessionMessage` objects. The chat view's renderer decides how to display each type:

| SessionMessage.type | Chat view rendering |
|---|---|
| `user` | Right-aligned user bubble (extract text from content blocks) |
| `assistant` | Left-aligned Claude bubble (text blocks), tool cards (tool_use blocks), thinking indicator (thinking blocks) |
| `system` | Inline system notice (compact boundary, API error, etc.) |
| `progress` | Status bar update (tool progress, agent progress) |
| `attachment` | Context attachment (hook context, tool results) |
| `summary` | Compacted summary notice |

**Effort:** ~200 lines. Heavily reuses `readJsonlStreaming()` and `fs.watch()` patterns from `HookEventWatcher`.

---

### Component 3: Session Status Tracker

**Problem:** Need real-time "Claude is thinking / running Bash / waiting for permission" status.

**Solution:** Derive status from hook events, which already fire on every state transition.

This is part of the **Session Bridge** (Component 1). The bridge subscribes to `HookEventWatcher.onEvent()` and maintains a `SessionActivityStatus` per session:

```
UserPromptSubmit  → { state: 'thinking' }
PreToolUse        → { state: 'tool_use', toolName: event.payload.tool_name }
PermissionRequest → { state: 'permission_pending', toolName, requestId }
PostToolUse       → { state: 'thinking' }  (Claude may call another tool)
Stop              → { state: 'idle' }
Elicitation       → { state: 'elicitation_pending', question }
ElicitationResult → { state: 'thinking' }
PreCompact        → { state: 'compact' }
PostCompact       → { state: 'thinking' }
SessionEnd        → remove session
```

The chat view reads `bridgedSession.lastStatus` and renders a status bar:

```
● Thinking...
● Running Bash: "npm test"
● Waiting for permission: Read /etc/passwd
● Idle
```

**Effort:** ~50 lines in session-bridge.ts (state machine on hook events). ~30 lines in chat view (status bar component).

---

### Component 4: Enhanced Chat View

**Problem:** Current `chat-view.tsx` only renders channel WS messages (empty). Need to render the full transcript + status + channel overlay.

**Solution:** Rewrite `ChatView` to compose three data sources:

```
ChatView
  ├── SessionBridge          → session list, identity, status
  ├── TranscriptStreamer     → message history + live messages (per session)
  ├── ChannelManager         → send messages, permission verdicts (existing)
  └── HookEventWatcher       → status updates (via bridge)
```

**Layout (unchanged structure, new data):**

```
┌─────────────────────────────────────────────┐
│ Header: Chat — projectName · sessionId[:4]  │
│ ● 6 sessions  ● ● ○ ○ ● ○  ←→ switch      │
├─────────────────────────────────────────────┤
│                                             │
│         ┌──────────────────────┐            │
│         │ What files changed?  │  ← user    │
│         └──────────────────────┘            │
│                                             │
│  3 files were modified:                     │  ← claude
│  - src/app.tsx (added header)               │
│  - src/lib/utils.ts (new helper)            │
│  - package.json (bumped version)            │
│                                             │
│  ┌─ Tool: Bash ──────────────────────────┐  │  ← tool use
│  │ npm test                              │  │
│  │ ✓ 42 tests passed                    │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Permission ─────────────── [abcde] ──┐  │  ← perm
│  │ Write  src/app.tsx                    │  │
│  │ [y abcde] allow   [n abcde] deny     │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ● Running Bash: "npm run build"            │  ← status
├─────────────────────────────────────────────┤
│ ❯ Type a message...                   █     │
└─────────────────────────────────────────────┘
```

**Message rendering approach:**

Reuse the existing `display-items.ts` logic from `MessagesView` which already handles all 14 message types. The `buildDisplayItems()` function flattens `SessionMessage[]` into `DisplayItem[]` (user text, assistant text, tool call summaries, thinking blocks, system notices). Adapt its output for chat bubble rendering:

- `DisplayItem.type === 'user'` → right-aligned blue bubble (reuse `renderUserBubble` pattern)
- `DisplayItem.type === 'assistant'` → left-aligned white text (reuse `renderClaudeBubble` pattern)
- `DisplayItem.type === 'tool_use'` → compact tool card (tool name + truncated input)
- `DisplayItem.type === 'tool_result'` → inline result summary (success/error + truncated output)
- `DisplayItem.type === 'thinking'` → dim italic "thinking..." indicator (collapsed by default)
- `DisplayItem.type === 'system'` → centered dim notice

**State management changes:**

```typescript
// Old: single data source
const [messagesBySession, setMessagesBySession] =
  useState<Map<string, ChannelMessage[]>>(() => new Map());

// New: transcript as primary, channel as overlay
const [transcriptBySession, setTranscriptBySession] =
  useState<Map<string, SessionMessage[]>>(() => new Map());
const [streamerBySession] =
  useState<Map<string, TranscriptStreamer>>(() => new Map());
```

On session switch:
1. If no streamer exists for this session, create one using `bridgedSession.transcriptPath`
2. Streamer loads history (cold start) → `setTranscriptBySession`
3. Streamer tails new messages (live) → append to transcript
4. Channel client remains for sending messages + permission verdicts

**Keyboard controls (unchanged):**
- `←/→` switch sessions
- `↑/↓` scroll transcript
- `Enter` send message or permission verdict
- `Esc` exit

**Effort:** ~300 lines changed in `chat-view.tsx`. Mostly replacing `ChannelMessage` rendering with `SessionMessage` rendering via adapted `display-items.ts`.

---

### Component 5: Elicitation Relay (Stretch)

**Problem:** Claude sometimes asks questions via elicitations (structured form inputs, not just text). The hooks plugin captures `Elicitation` events but there's no way to relay them to external clients or collect answers.

**Current state:** Claude Code handles elicitations locally in the terminal. The `Elicitation` hook event contains the question schema but no mechanism exists to forward it over WS and relay the answer back.

**Solution options:**

**Option A: Channel capability extension**
Add `claude/channel/elicitation` experimental capability to the channel plugin. When Claude Code emits an elicitation notification, the channel server broadcasts it to WS clients. WS clients send back an `elicitation_result` message. The channel server relays the result back to Claude Code.

This requires Claude Code to support `claude/channel/elicitation` — need to verify this exists in the MCP spec.

**Option B: Approximate with channel messages**
When the hooks plugin captures an `Elicitation` event, the session bridge detects it and sets status to `elicitation_pending`. The chat view renders the question. The user types an answer as a regular channel message. Claude sees it via `notifications/claude/channel` and treats it as input.

This is imprecise (Claude may not associate the channel message with the pending elicitation) but requires no new MCP capabilities.

**Recommendation:** Start with Option B (status indicator + user answers via channel message). Upgrade to Option A when `claude/channel/elicitation` is confirmed in the MCP spec.

**Effort:** Option B is ~0 extra work (just status rendering). Option A is ~100 lines in channel plugin + SDK types.

---

## Implementation Plan

### Phase 1: Session Identity (1-2 hours)

1. **Extend hook handler** (`hook-handler.mjs`): On `SessionStart`, write `~/.spaghetti/hooks/sessions/<sessionId>.json` with `{ sessionId, transcriptPath, cwd, pid, startedAt }`. On `SessionEnd`, delete it.

2. **Build session bridge** (`sdk/src/io/session-bridge.ts`): Watch both dirs, correlate by PID, expose `BridgedSession[]` with `claudeSessionId`, `transcriptPath`, `projectCwd`, `lastStatus`.

3. **Export from SDK**: Add to `io/index.ts` exports.

### Phase 2: Transcript Streaming (1-2 hours)

1. **Build transcript streamer** (`sdk/src/io/transcript-streamer.ts`): Cold read with `readJsonlStreaming`, live tail with `fs.watch` + `fromBytePosition`, emit `SessionMessage` events.

2. **Test with existing sessions**: Verify cold load produces correct `SessionMessage[]`, live tail picks up new messages during an active session.

### Phase 3: Chat View Rewrite (2-3 hours)

1. **Replace data source**: Swap `ChannelManager` message history with `TranscriptStreamer` per session.

2. **Adapt rendering**: Use `display-items.ts` logic to render `SessionMessage` types as chat bubbles/cards.

3. **Add status bar**: Render `BridgedSession.lastStatus` as a live status indicator below the message area.

4. **Keep channel for input**: `ChannelClient.sendMessage()` for sending messages, `sendPermissionVerdict()` for approvals.

### Phase 4: Polish (1-2 hours)

1. **Stale session cleanup**: Session bridge auto-removes dead sessions (hooks `SessionEnd` + channel heartbeat timeout).

2. **Session bar improvements**: Show project name + cwd (from bridge, not channel's plugin cache dir), connection state per session.

3. **Tool use cards**: Render tool invocations as compact inline cards with name + truncated input/output.

4. **Performance**: Cap transcript at last N messages in memory, lazy-load older messages on scroll-up.

### Phase 5: Elicitation Relay (stretch, 1 hour)

1. Render elicitation questions in chat view when status is `elicitation_pending`.
2. User answers via regular message input (Option B).

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Transcript JSONL can be large (10k+ lines) | Slow cold start, high memory | Cap initial load at 200 messages, lazy-load on scroll-up |
| File watch reliability varies by OS | Missed live updates | Periodic rescan fallback (same pattern as channel registry's 5s rescan) |
| PID correlation may fail (race on startup) | Missing transcript link | Fallback: match by startedAt timestamp proximity (<5s) |
| Multiple Claude Code sessions in same project | Ambiguous transcript match | Each has unique sessionId — bridge tracks all independently |
| Transcript format changes across Claude Code versions | Parse failures | Spaghetti-core parser already handles unknown message types gracefully (skips them) |
| Channel plugin not installed on some sessions | No WS bridge for sending | Show read-only mode indicator; user can still view transcript |

## Files Changed

### New files
- `packages/sdk/src/io/session-bridge.ts` (~200 lines)
- `packages/sdk/src/io/transcript-streamer.ts` (~200 lines)

### Modified files
- `packages/claude-code-hooks-plugin/scripts/hook-handler.mjs` (~20 lines — write session sidecar)
- `packages/sdk/src/io/index.ts` (export new modules)
- `packages/sdk/src/types/channel-messages.ts` (add `BridgedSession`, `SessionActivityStatus` types)
- `packages/cli/src/views/chat-view.tsx` (~300 lines changed — new data sources + rendering)

### Unchanged
- `packages/claude-code-channels-plugin/server.ts` (no changes needed — channel bridge works as-is)
- `packages/cli/src/views/messages-view.tsx` (unchanged — but its `display-items.ts` logic is reused)
- `packages/sdk/src/io/channel-manager.ts` (unchanged — still used for sending)
- `packages/sdk/src/io/hook-event-watcher.ts` (unchanged — consumed by session bridge)
