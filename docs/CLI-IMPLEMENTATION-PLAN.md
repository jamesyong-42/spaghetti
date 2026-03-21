# Spaghetti CLI — Implementation Plan

**Status**: Ready for implementation
**Created**: 2026-03-21

---

## Tech Stack (decided)

| Component | Choice | Size | Rationale |
|-----------|--------|------|-----------|
| Command parsing | **commander v13** | 52KB | Battle-tested, aliases, auto-help |
| Colors | **picocolors v1** | 3KB | 14x smaller than chalk, NO_COLOR support |
| Tables | **Custom + string-width** | 5KB | Full control, Unicode box drawing |
| Truncation | **cli-truncate v4** | 3KB | ANSI-safe truncation |
| Progress | **nanospinner v1** | 3KB | Stderr spinner for cold start |
| Pager | **child_process → $PAGER** | 0 | Unix convention |
| Time formatting | **Custom (~40 lines)** | 0 | Port from UI package |
| Build | **tsup v8** | dev | Single-file ESM output with shebang |
| **Total runtime deps** | | **~66KB** | |

## 4 Implementation Phases

### Phase 1: Scaffold + Dashboard + Projects (MVP)
- `spaghetti` → dashboard overview
- `spaghetti projects` (`p`) → project list
- Lib: init.ts (service + spinner), format.ts, table.ts, color.ts, terminal.ts
- Package scaffold: package.json, tsconfig, tsup.config

### Phase 2: Sessions + Messages + Search
- `spaghetti sessions` (`s`) + fuzzy project resolution
- `spaghetti messages` (`m`) + color-coded message renderer
- `spaghetti search` (`?`) + FTS5 search
- Lib: resolve.ts (fuzzy matching), pager.ts, message-render.ts

### Phase 3: Stats + Memory + Todos + Export
- `spaghetti stats` (`st`) + bar charts
- `spaghetti memory` (`mem`)
- `spaghetti todos` (`t`)
- `spaghetti subagents` (`sub`)
- `spaghetti plan` (`pl`)
- `spaghetti export` (`x`) → JSON/Markdown

### Phase 4: Polish + Distribution
- Unified error handling
- Shell completions (bash/zsh)
- Smoke tests + unit tests
- npm pack / global install validation

## Package Structure (final)

```
packages/cli/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    bin.ts
    index.ts
    commands/
      dashboard.ts, projects.ts, sessions.ts, messages.ts,
      search.ts, stats.ts, memory.ts, export.ts,
      todos.ts, subagents.ts, plan.ts
    lib/
      init.ts, resolve.ts, format.ts, color.ts,
      table.ts, terminal.ts, pager.ts,
      message-render.ts, error.ts
    __tests__/
      format.test.ts, resolve.test.ts, table.test.ts, smoke.test.ts
```

## Key Design Decisions

- **Bundle core into CLI binary** (`noExternal: ['@spaghetti/core']`) for self-contained global install
- **Spinner writes to stderr**, not stdout — piped output stays clean
- **Auto-detect cwd project** — `spaghetti s .` resolves from working directory
- **--json on every command** — machine-readable output for scripting
- **Graceful SIGINT** — shutdown() closes SQLite cleanly
