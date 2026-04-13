# Spaghetti

**Inspect, search, and navigate Claude Code data from the terminal.**

Spaghetti is a TypeScript monorepo centered on a local-first data pipeline for Claude Code artifacts. It parses `~/.claude`, stores a normalized SQLite index, exposes a queryable core library, and ships a terminal app with both a full-screen TUI and one-shot CLI commands.

[![npm version](https://img.shields.io/npm/v/@vibecook/spaghetti.svg)](https://www.npmjs.com/package/@vibecook/spaghetti)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml)

```text
╭ Spaghetti v0.4.0 ──────────────────────────────────────────────────────╮
│                                                                        │
│  ▄▀▀ █▀█ ▄▀▄ █▀▀ █ █ █▀▀ ▀█▀ ▀█▀ █      Projects           79         │
│  ▀▄▄ █▀▀ █▀█ █ █ █▀█ █▀   █   █  █      Sessions        1,247         │
│  ▄▄▀ █   █ █ ▀▀▀ ▀ ▀ ▀▀▀  ▀   ▀  ▀      Messages       86,412         │
│                                            Tokens          66.3M      │
│  untangle your claude code history         ──────────────────────      │
│                                            /search  /stats  /help      │
│  ~/.claude · 512 MB · 28ms                                             │
│                                                                        │
╰────────────────────────────────────────────────────────────────────────╯
```

| Surface | Current State | Notes |
|---|---|---|
| Terminal app | Primary interface | Ink TUI plus one-shot CLI commands |
| Core library | Reusable | Public API over parsed/indexed Claude Code data |
| Hook monitoring | Working | Reads `~/.spaghetti/hooks/events.jsonl` |
| Live chat channel | Experimental | Bun MCP/WebSocket bridge |
| React UI package | Experimental | Component playground, not main product |

## What It Does

Spaghetti is built around four related use cases:

- Browse Claude Code projects, sessions, messages, plans, todos, memory files, and subagent transcripts.
- Run fast full-text search over indexed message content with SQLite FTS5.
- Surface operational tooling around Claude Code plugins, hook events, and active channel sessions.
- Reuse the same indexed data through a standalone SDK that ships both a core API and a React component layer.

In practice, the CLI is the primary product today. The SDK is reusable and stable enough to script against. Its React export is more of a playground than a finished app.

> **Breaking change (0.5.0):** `@vibecook/spaghetti-core` and the private `@vibecook/spaghetti-ui` have been merged into a single published package `@vibecook/spaghetti-sdk`. Import core API from `@vibecook/spaghetti-sdk`; import React components from `@vibecook/spaghetti-sdk/react`. The old `@vibecook/spaghetti-core` package is deprecated on npm.

## Packages

This repo is a `pnpm` workspace with four packages:

- `packages/cli` — `@vibecook/spaghetti`, the published terminal app.
- `packages/sdk` — `@vibecook/spaghetti-sdk`, the parsing/indexing/query library plus React components (subpath export `/react`).
- `packages/claude-code-hooks-plugin` — Claude Code plugin assets for hook capture.
- `packages/claude-code-channels-plugin` — a Bun-based MCP/WebSocket bridge for live chat with running Claude Code sessions.

## Architecture

The codebase has a fairly clean layered split:

1. `@vibecook/spaghetti-sdk`
   Reads Claude Code files from `~/.claude`, parses them into domain types, ingests them into SQLite, and exposes query APIs. Ships React components under the `/react` subpath.
2. `@vibecook/spaghetti`
   Wraps the SDK in a command-driven terminal experience: Ink TUI for interactive use, Commander-based subcommands for scripts.
3. Plugin and channel packages
   Extend Claude Code itself so Spaghetti can monitor hook events and interact with live sessions.

```text
             Claude Code local data
                    ~/.claude
                        │
                        ▼
         ┌──────────────────────────────┐
         │ @vibecook/spaghetti-sdk      │
         │ parser + ingest + query      │
         └──────────────┬───────────────┘
                        │
            ~/.spaghetti/cache/spaghetti.db
                        │
        ┌───────────────┼──────────────────┐
        ▼               ▼                  ▼
   Ink TUI         CLI commands       Core library API
        │               │                  │
        └─────── shared summaries/search/messages ───────┘
```

### Core Data Flow

At initialization, the core service:

- discovers project/session files under `~/.claude`
- parses project data in streaming mode
- writes normalized rows into a SQLite database at `~/.spaghetti/cache/spaghetti.db` by default
- builds and maintains FTS5 search indexes over message text
- stores config and analytics snapshots separately from session data

Key implementation details from the code:

- Cold starts can parse projects in worker threads, with a sequential fallback when workers are unavailable.
- Query and ingest share one SQLite connection to avoid `SQLITE_BUSY` conflicts.
- Source file fingerprints are tracked so warm starts can skip unnecessary reprocessing.
- The schema is purpose-built: projects, sessions, messages, subagents, tool results, todos, tasks, plans, config, analytics, and file history all have dedicated tables.

### Data Shapes Indexed Today

| Category | Examples |
|---|---|
| Project/session data | sessions, messages, MEMORY files, summaries |
| Agent artifacts | subagents, plans, todos, persisted tool results |
| Local Claude state | settings, plugins, statsig, telemetry, active sessions |
| Extra observability | hook events, channel session discovery, exportable transcripts |

## CLI Modes

The published CLI supports three usage styles:

- Bare `spag` in a TTY launches the Ink TUI.
- Bare `spag --json` or piped `spag` prints a JSON summary.
- Subcommands such as `projects`, `messages`, or `search` run as one-off terminal commands.

### TUI

The TUI is driven by a shell/view-stack model in `packages/cli/src/views`. It currently includes:

- Home menu
- Projects view
- Project tabs: `Sessions | Memory`
- Session tabs: `Messages | Todos | Plan | Subagents`
- Search flow
- Stats view
- Help view
- Hooks Monitor
- Chat
- Doctor

The TUI initializes the core service lazily and shows a boot screen with progress while the parser/indexer runs.

```text
Home
 ├─ Projects
 │   ├─ Sessions
 │   │   ├─ Messages
 │   │   ├─ Todos
 │   │   ├─ Plan
 │   │   └─ Subagents
 │   └─ Memory
 ├─ Hooks Monitor
 ├─ Stats
 ├─ Help
 ├─ Chat
 └─ Doctor
```

### One-Off Commands

Current command surface:

| Command | Alias | Purpose |
|---|---|---|
| `projects` | `p` | List indexed projects |
| `sessions [project]` | `s` | List sessions for a project |
| `messages [project] [session]` | `m` | Read session messages |
| `search <query>` |  | Full-text search |
| `stats` | `st` | Aggregate usage and store stats |
| `memory [project]` | `mem` | Show project `MEMORY.md` |
| `todos [project] [session]` | `t` | Show session todos |
| `subagents [project] [session] [agent]` | `sub` | Inspect subagent transcripts |
| `plan [project] [session]` | `pl` | Show a session plan |
| `export [project]` | `x` | Export project/session data as JSON or Markdown |
| `hooks` | `h` | View captured hook events |
| `chat` | `c` | Chat with active Claude Code sessions |
| `plugin <action> [plugin]` |  | Install/uninstall/check Spaghetti plugins |
| `doctor` |  | Health-check data paths and plugin state |
| `update` |  | Check for and install updates |
| `uninstall` |  | Show uninstall instructions |

Project and session resolution is intentionally flexible. The CLI accepts:

- exact names
- fuzzy prefixes
- numeric indexes
- `.` for current working directory
- `latest` / `last` for the newest session
- partial UUIDs for session selection

Examples:

```bash
spag projects
spag sessions .
spag messages . latest
spag search "refactor parser"
spag export . --format markdown --output session.md
spag hooks --follow
spag chat --follow
spag doctor
```

## Quick Start

```bash
# global install
npm install -g @vibecook/spaghetti

# launch the TUI
spag

# or use a one-shot command
spag search "worker pool"
```

## Plugins And Live Integrations

Spaghetti is not only a reader of static Claude Code files.

### `spaghetti-hooks`

The hook plugin writes structured JSONL events to `~/.spaghetti/hooks/events.jsonl`. The CLI can read those events directly through `spag hooks`, and the TUI exposes them via Hooks Monitor.

### `spaghetti-channel`

The channel package is a Bun-based MCP server plus WebSocket bridge. Each running Claude Code session can publish a discovery file under `~/.spaghetti/channel/sessions/<uuid>.json` and stream message traffic through a local socket. The CLI `chat` command and the TUI chat view are built around that channel registry.

### `doctor`

The doctor command checks:

- Claude Code binary availability
- `~/.claude` and plugin directories
- installed/enabled Spaghetti plugins
- hook event file presence
- channel session directory state

```text
spaghetti-hooks   -> ~/.spaghetti/hooks/events.jsonl      -> hooks view / hooks monitor
spaghetti-channel -> ~/.spaghetti/channel/sessions/*.json -> chat command / chat view
doctor            -> filesystem + plugin state probes     -> health report
```

## Library Usage

The SDK can be used directly:

```ts
import { createSpaghettiService } from '@vibecook/spaghetti-sdk';

const spaghetti = createSpaghettiService();
await spaghetti.initialize();

const projects = spaghetti.getProjectList();
const sessions = spaghetti.getSessionList(projects[0].slug);
const messages = spaghetti.getSessionMessages(projects[0].slug, sessions[0].sessionId);
const results = spaghetti.search({ text: 'worker thread' });

spaghetti.shutdown();
```

Useful API entry points include:

- `getProjectList()`
- `getSessionList(projectSlug)`
- `getSessionMessages(projectSlug, sessionId, limit?, offset?)`
- `getProjectMemory(projectSlug)`
- `getSessionTodos(projectSlug, sessionId)`
- `getSessionPlan(projectSlug, sessionId)`
- `getSessionSubagents(projectSlug, sessionId)`
- `search(query)`
- `getStats()`
- `onProgress()` / `onReady()` / `onChange()`

## React Components

The SDK exports a React component playground under the `/react` subpath:

```ts
import { SpaghettiProvider, AgentDataPlayground } from '@vibecook/spaghetti-sdk/react';
```

Available exports include a provider/context wrapper, project and session cards, message rendering components, a detail overlay, and the `AgentDataPlayground`. It is not the primary interface of the repo today.

## Project Structure

```text
spaghetti/
  packages/
    cli/                           Published terminal app
    sdk/                           SDK: parsing, storage, query API + React components
    claude-code-hooks-plugin/      Claude Code plugin assets for hook capture
    claude-code-channels-plugin/   Bun-based live chat bridge
  docs/        Design notes, implementation plans, RFCs
  scripts/     Validation utilities against real ~/.claude data
```

## Requirements

- Node.js `>=18` for the main workspace and published packages
- `pnpm` for workspace development
- a local Claude Code data directory at `~/.claude` for real usage

Additional package-specific note:

- `packages/claude-code-channels-plugin` uses Bun for local development of the channel server

## Install

For end users:

```bash
npm install -g @vibecook/spaghetti
spag
```

Or run without installing globally:

```bash
npx @vibecook/spaghetti
```

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

`pnpm test` currently runs:

- workspace typechecking
- schema/type validation scripts against real Claude Code data
- package test suites for `core` and `cli`

## Releases

This repo relies on `release-please` for releases.

- Do not manually bump versions in `package.json` files.
- Do not manually edit `.release-please-manifest.json`.
- Do not manually cut release tags as part of the normal workflow.
- Merge feature/fix/chore commits to `main`, let `release-please` open the release PR, then merge that PR to release.

See [RELEASING.md](RELEASING.md) for the expected flow.

## Status

The codebase is most mature in:

- local indexing of Claude Code data
- terminal browsing/search flows
- plugin health and observability tooling

More experimental areas are:

- the React UI package
- live chat/channel workflows
- the long-tail of Claude Code data formats, which the repo actively validates against real local data

## License

[MIT](LICENSE) — James Yong
