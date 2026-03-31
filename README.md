# Spaghetti

**Untangle your Claude Code history.**

An interactive terminal UI for browsing, searching, and analyzing every Claude Code conversation on your machine.

[![npm version](https://img.shields.io/npm/v/@vibecook/spaghetti.svg)](https://www.npmjs.com/package/@vibecook/spaghetti)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml)

---

```
╭ Spaghetti v0.3.0 ──────────────────────────────────────────────────────╮
│                                                                        │
│  ▄▀▀ █▀█ ▄▀▄ █▀▀ █ █ █▀▀ ▀█▀ ▀█▀ █      Projects           79 │
│  ▀▄▄ █▀▀ █▀█ █ █ █▀█ █▀   █   █  █      Sessions        1,247 │
│  ▄▄▀ █   █ █ ▀▀▀ ▀ ▀ ▀▀▀  ▀   ▀  ▀      Messages       86,412 │
│                                            Tokens          66.3M │
│  untangle your claude code history         ────────────────────── │
│                                            /search  /stats  /help │
│  ~/.claude · 512 MB · 28ms                                        │
│                                                                        │
╰────────────────────────────────────────────────────────────────────────╯

  ▎ Projects                                                  79 projects
    Browse all Claude Code project conversations

    Stats                                                 66.3M tokens
    Usage statistics, token counts, top projects

    Help                                                  ? keybindings
    Navigation, commands, and keyboard shortcuts

──────────────────────────────────────────────────────────────────────────
  ↑↓ navigate  ⏎ open  / search  q quit
──────────────────────────────────────────────────────────────────────────
```

---

## Interactive TUI

Running `spag` launches a full-screen interactive terminal UI built with Ink and React.

**Menu home screen** -- Projects, Stats, and Help are selectable from the home menu. A branded welcome panel shows aggregate stats and boot time.

**Project-level tabs** -- Select a project to see `Sessions | Memory` tabs. Arrow keys (`<- ->`) switch between viewing sessions and the project's MEMORY.md.

**Session-level tabs** -- Enter a session to see `Messages | Todos | Plan | Subagents` tabs. Each tab displays its content inline; no extra commands to memorize.

**Pill-style tab badges** -- Active tabs render with a filled background; inactive tabs show dim rounded borders using ANSI 256-color sequences.

**Context-aware search** -- Press `/` from any view to open a search bar. Scope narrows automatically: global from home, per-project from the project view, per-session from the session view.

**256-color message blocks** -- User and assistant messages render with distinct background colors and timestamps. Full-width color blocks with right-aligned metadata.

**Boot screen with progress bar** -- On first run (cold start), a progress bar tracks JSONL parsing across all projects. Warm starts skip straight to the menu.

**Scrollbar and filtering** -- Long lists show a scrollbar indicator. Message views support type filters (user, assistant, thinking, tools, system, internal) via number keys `1-6`.

**Alternate screen buffer** -- The TUI renders in the terminal's alternate screen, leaving your shell history clean on exit.

## Quick Start

```bash
# Install globally
npm install -g @vibecook/spaghetti

# Or use npx
npx @vibecook/spaghetti

# Launch the interactive TUI
spag
```

`spag` is a built-in alias for `spaghetti`.

## CLI Commands (scripting / agents)

The one-off subcommands still work for scripts, pipelines, and AI agents that need structured output. Every command supports `--json`.

| Command | Alias | Description |
|---------|-------|-------------|
| `spaghetti` | | Launch interactive TUI |
| `projects` | `p` | List all projects with stats |
| `sessions [project]` | `s` | List sessions for a project |
| `messages [project] [session]` | `m` | Read conversation messages |
| `search <query>` | | Full-text search across all data |
| `stats` | `st` | Usage statistics and token counts |
| `memory [project]` | `mem` | View a project's MEMORY.md |
| `todos [project] [session]` | `t` | View session todo lists |
| `subagents [project] [session]` | `sub` | View subagent transcripts |
| `plan [project] [session]` | `pl` | View session plan |
| `export [project]` | `x` | Export to JSON or Markdown |

### Smart Resolution

Projects and sessions are resolved flexibly:

```bash
spag s spaghetti     # Fuzzy match by name
spag s 1             # By index number
spag s .             # Current working directory
spag m . latest      # Latest session
spag m . 3           # Third most recent session
spag s --since today # Filter by time
```

## Architecture

Spaghetti uses a layered architecture optimized for fast reads over large local datasets.

**Ink v6 + React 19 TUI** -- The interactive interface is a React app rendered to the terminal via Ink. A view stack manages navigation (push/pop), with a shell component handling breadcrumbs, search mode, and keyboard dispatch. Tab containers at the project and session levels wrap related views without extra navigation depth.

**SQLite with dedicated tables** -- not a generic blob store. Projects, sessions, messages, and metadata each have purpose-built schemas with proper indexes.

**Persistent FTS5 with auto-sync triggers** -- full-text search indexes are content-synced to the messages table. Inserts, updates, and deletes stay in sync automatically. No rebuild on warm start.

**Streaming JSONL parser** -- Claude Code stores conversations as large JSONL files. Spaghetti reads them line-by-line with byte offset tracking, never loading entire files into memory.

**Worker threads** -- multiple projects are parsed in parallel across worker threads. The main thread owns the single SQLite writer; workers send pre-extracted batches.

## Library Usage

`@spaghetti/core` can be used as a standalone library:

```typescript
import { createSpaghettiService } from '@spaghetti/core';

const spaghetti = createSpaghettiService();
await spaghetti.initialize();

// List all projects
const projects = spaghetti.getProjectList();

// Full-text search
const results = spaghetti.search({ text: 'refactor' });

// Read messages from a session
const page = spaghetti.getSessionMessages(projectSlug, sessionId);

// Clean up
spaghetti.shutdown();
```

## Performance

| Metric | Value |
|--------|-------|
| Cold start (first run, with progress bar) | ~6s |
| Warm start (no changes) | 28ms |
| Search (FTS5) | <1ms |
| Peak memory | ~30MB |

Benchmarked against ~500MB of Claude Code data across 38 projects.

## Project Structure

```
spaghetti/
  packages/
    core/          @spaghetti/core -- SQLite store, parser, search, API
    cli/           @vibecook/spaghetti -- Interactive TUI (Ink v6 + React 19)
      src/
        commands/    One-off CLI subcommands (commander)
        views/       TUI view components
          shell.tsx            Root component, view stack, search mode
          boot-view.tsx        Progress bar during cold start
          menu-view.tsx        Home menu (Projects / Stats / Help)
          welcome-panel.tsx    Branded header with stats
          projects-view.tsx    Project list
          project-tab-view.tsx Sessions | Memory tabs
          sessions-view.tsx    Session list
          session-tab-view.tsx Messages | Todos | Plan | Subagents tabs
          messages-view.tsx    Message viewer with type filters
          search-view.tsx      Search results
          tab-bar.tsx          Pill-style tab badge component
          chrome.tsx           Header, footer, horizontal rules
    ui/            @spaghetti/ui -- React web interface (planned)
  docs/            Design documents and RFCs
  scripts/         Build and validation scripts
```

Managed with [pnpm workspaces](https://pnpm.io/workspaces).

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Type-check
pnpm typecheck

# Run tests
pnpm test
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) -- James Yong
