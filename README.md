# Spaghetti

**Untangle your Claude Code history.**

Browse, search, and analyze every Claude Code conversation stored on your machine -- all from the terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

---

```
$ spag

  Spaghetti v0.1.0                               28ms

  38 projects   1,247 sessions   86,412 messages

  Recent activity
  ──────────────────────────────────────────────────
  #1  spaghetti          12 sessions    3,841 msgs
  #2  voyager            8 sessions     2,104 msgs
  #3  jabali-editor      6 sessions     1,887 msgs
  #4  study-portfolio    4 sessions       943 msgs
  #5  duke-os            3 sessions       612 msgs

  spag p · projects    spag s · sessions    spag m · messages
```

---

## Features

- **Full-text search** across all conversations with FTS5
- **Usage statistics** with token counts and bar charts
- **Color-coded message viewer** with pager support
- **Smart resolution** -- fuzzy project/session matching, `.` for cwd
- **Fast** -- 28ms warm start, sub-millisecond search
- **Data recovery** from old Claude Code cache databases
- **JSON output** on every command (`--json`) for scripting
- **Monorepo** -- CLI, core library, and React UI

## Quick Start

```bash
# Install globally
npm install -g @spaghetti/cli

# Or use npx
npx @spaghetti/cli

# Browse your Claude Code data
spaghetti                    # Dashboard overview
spag p                       # List all projects
spag s spaghetti             # Sessions for a project
spag m . 1                   # Messages from latest session
spag search "error handling" # Full-text search
spag st                      # Usage statistics
```

`spag` is a built-in alias for `spaghetti`.

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `spaghetti` | | Dashboard overview |
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

Every command supports `--json` for machine-readable output.

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
| Cold start (first run) | ~6s |
| Warm start (no changes) | 28ms |
| Search (FTS5) | <1ms |
| Peak memory | ~30MB |

Benchmarked against ~500MB of Claude Code data across 38 projects.

## Project Structure

```
spaghetti/
  packages/
    core/          @spaghetti/core — SQLite store, parser, search, API
    cli/           @spaghetti/cli — Terminal interface (commander + picocolors)
    ui/            @spaghetti/ui  — React web interface (planned)
  docs/            Design documents and architecture notes
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
