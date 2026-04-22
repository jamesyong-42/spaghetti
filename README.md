# Spaghetti

**Turn your local Claude Code history into a searchable workspace.**

Spaghetti is a local-first CLI and SDK for Claude Code data. It indexes `~/.claude` into SQLite so you can search conversations, inspect projects and sessions, review plans/todos/subagents, and build your own tools on top of the same data.

[![npm version](https://img.shields.io/npm/v/@vibecook/spaghetti.svg?label=@vibecook/spaghetti)](https://www.npmjs.com/package/@vibecook/spaghetti)
[![npm version](https://img.shields.io/npm/v/@vibecook/spaghetti-sdk.svg?label=@vibecook/spaghetti-sdk)](https://www.npmjs.com/package/@vibecook/spaghetti-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/spaghetti/actions/workflows/ci.yml)

```text
╭ Spaghetti v0.5.0 ──────────────────────────────────────────────────────╮
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

## Why people use it

- **Find anything fast** with full-text search over your Claude Code message history.
- **Browse the important artifacts**: projects, sessions, messages, plans, todos, memory files, and subagents.
- **Stay local-first** with a SQLite index stored on your machine.
- **Build on top of it** with a reusable TypeScript SDK and optional React exports.

## Quick start

```bash
npm install -g @vibecook/spaghetti
spag
```

Or run a one-off command without installing globally:

```bash
npx @vibecook/spaghetti search "worker pool"
```

## What you get

| Surface | Best for |
|---|---|
| `@vibecook/spaghetti` | Interactive terminal browsing plus one-shot CLI commands |
| `@vibecook/spaghetti-sdk` | Scripts, apps, and custom tooling over indexed Claude Code data |
| Native Rust ingest | Faster cold starts by default, with automatic TypeScript fallback |

## Common commands

```bash
spag                         # launch the TUI
spag projects                # list indexed projects
spag sessions .              # sessions for the current repo
spag messages . latest       # latest session transcript
spag search "refactor parser"
spag plan . latest
spag todos . latest
spag doctor
```

## What Spaghetti indexes

- Claude Code projects and sessions from `~/.claude`
- Messages, plans, todos, memory files, and subagent transcripts
- Hook events and active channel sessions for observability workflows
- A local SQLite cache under `~/.spaghetti/cache`

## Built for two audiences

### Terminal users

Launch `spag` for the full-screen TUI, or use subcommands when you just want a fast answer in the shell.

### Tool builders

Use the SDK directly when you want to query the same indexed data from scripts or apps:

```ts
import { createSpaghettiService } from '@vibecook/spaghetti-sdk';

const spaghetti = createSpaghettiService();
await spaghetti.initialize();

const results = spaghetti.search({ text: 'worker thread' });

spaghetti.shutdown();
```

## Repo map

- [`packages/cli`](packages/cli) — published CLI package
- [`packages/sdk`](packages/sdk) — parsing, indexing, query APIs, and React exports
- [`crates/spaghetti-napi`](crates/spaghetti-napi) — native Rust ingest engine
- [`apps/playground`](apps/playground) — Electron demo app
- [`docs`](docs) — RFCs, design notes, and deeper implementation details

## Requirements

- Node.js `>=18` for end users
- `~/.claude` for real data
- `pnpm` + Node.js 24 for local workspace development

## Learn more

- [CLI README](packages/cli/README.md)
- [SDK README](packages/sdk/README.md)
- [Releasing guide](RELEASING.md)

## License

[MIT](LICENSE) — James Yong
