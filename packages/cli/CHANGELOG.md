# @vibecook/spaghetti

## 0.2.2

### Patch Changes

- [`0b1f98f`](https://github.com/jamesyong-42/spaghetti/commit/0b1f98f0c59aa7ffa872f93e24d6c027b69481f7) Thanks [@jamesyong-42](https://github.com/jamesyong-42)! - Interactive TUI browser for `spag p` with arrow-key navigation through projects, sessions, and messages. Features include tool_use/tool_result merging, thinking block visualization, message type filters (1-6 keys), ANSI 256-color message blocks, and chat-app style layout.

- Updated dependencies []:
  - @vibecook/spaghetti-core@0.2.2

## 0.2.1

### Patch Changes

- [`a2944a1`](https://github.com/jamesyong-42/spaghetti/commit/a2944a18261f9e40426a51a850839e4cdd57053d) Thanks [@jamesyong-42](https://github.com/jamesyong-42)! - Truffle-style update command, cross-platform fixes, eslint + prettier
  - `spaghetti update` command — checks npm registry and installs latest version
  - Background update check notifies on startup (24h interval, non-blocking)
  - Windows cross-platform compatibility (path.sep, CRLF, pager fallback)
  - ESLint + Prettier configured with CI integration
  - Cross-platform CI matrix (ubuntu, macOS, Windows)

- Updated dependencies [[`a2944a1`](https://github.com/jamesyong-42/spaghetti/commit/a2944a18261f9e40426a51a850839e4cdd57053d)]:
  - @vibecook/spaghetti-core@0.2.1

## 0.2.0

### Minor Changes

- Initial public release of Spaghetti CLI and core library.
  - 10 CLI commands: projects, sessions, messages, search, stats, memory, todos, subagents, plan, export
  - Architecture C: dedicated SQLite tables, persistent FTS5, streaming parser, worker threads
  - Auto-update, cross-platform (macOS, Linux, Windows)
  - Data recovery from legacy databases

### Patch Changes

- Updated dependencies []:
  - @vibecook/spaghetti-core@0.2.0
