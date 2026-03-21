# Spaghetti CLI Design

**Status**: Design complete, ready for implementation
**Created**: 2026-03-21

See the full design document in the agent output. Key decisions below.

## Command Hierarchy

```
spaghetti                              # Dashboard overview (default)
spaghetti projects       (p)           # List all projects
spaghetti sessions       (s)  [proj]   # List sessions for a project
spaghetti messages       (m)  [proj] [session]  # Read messages
spaghetti search         (?)  <query>  # Full-text search
spaghetti stats          (st)          # Usage statistics
spaghetti memory         (mem) [proj]  # View project MEMORY.md
spaghetti export         (x)  [proj]   # Export to JSON/Markdown
spaghetti todos          (t)  [proj] [session]  # View todos
spaghetti subagents      (sub) [proj] [session] # View subagents
spaghetti plan           (pl) [proj] [session]  # View plans
```

Short alias: `spag` works identically to `spaghetti`.

## Smart Resolution

- Projects: numeric index, folder name, fuzzy match, path match, `.` for cwd
- Sessions: numeric index (1=latest), `latest`, partial UUID, full UUID
- Time: `today`, `yesterday`, `this week`, `3 days ago`, ISO dates

## Key Interactions

| Action | Shortest Form | Keystrokes |
|--------|---------------|------------|
| Dashboard | `spag` | 4 |
| Search | `spag ? q` | 8+q |
| Latest messages | `spag m . 1` | 10 |
| List projects | `spag p` | 6 |
| Sessions for cwd | `spag s` | 6 |

## Package Structure

```
packages/cli/
  src/
    bin.ts                # Entry point with hashbang
    index.ts              # Command registration
    commands/             # One file per command
    lib/
      resolve.ts          # Fuzzy project/session resolution
      format.ts           # Token, time, table formatting
      color.ts            # Color theme
      pager.ts            # Pipe to less/more
      time.ts             # Natural language time parsing
      init.ts             # Service init with progress bar
  package.json
  tsconfig.json
```

## Dependencies
- `commander` or `citty` for command parsing
- `chalk` or `picocolors` for colors
- `cli-table3` for tables
