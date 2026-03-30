# RFC 002: Menu Home, Tabs, and Search Bar Redesign

**Status**: Draft
**Created**: 2026-03-30
**Supersedes**: Parts of RFC 001 (slash command system)

---

## Summary

Simplify the TUI interaction model by replacing the slash command system with three patterns:

1. **Menu-based home screen** — Projects, Stats, Help as selectable items
2. **Tab navigation** — `←→` switches between related content at the project and session levels
3. **`/` search bar** — context-aware search replaces the command autocomplete overlay

---

## Motivation

The slash command system (RFC 001) works but has friction:
- Users must learn `/memory`, `/todos`, `/plan`, `/subagents` commands
- Context errors ("navigate to a project first") are confusing
- Session-level features are invisible until you type `/help`
- The autocomplete overlay is complex machinery for ~8 commands

The list navigation (`↑↓ Enter Esc`) is already intuitive. Lean into it:
- Menu items for top-level features (Stats, Help)
- Tabs for context-level features (visible, one `←→` away)
- `/` for the one thing that needs text input: search

---

## Design

### Home Screen: Menu

The home screen shows a menu with 3 items instead of jumping straight to the project list.

```
╭ Spaghetti v0.2.1 ──────────────────────────────────────────────────────────────╮
│  ...wordmark + stats...                                                        │
╰────────────────────────────────────────────────────────────────────────────────╯

  ▎ Projects                                                          79 projects
    Browse all Claude Code project conversations

    Stats                                                         66.3M tokens
    Usage statistics, token counts, top projects

    Help                                                          ? keybindings
    Navigation, commands, and keyboard shortcuts

──────────────────────────────────────────────────────────────────────────────────
  ↑↓ navigate  ⏎ open  / search  q quit
──────────────────────────────────────────────────────────────────────────────────
```

- Projects is auto-selected (first item) — one Enter to start browsing
- Stats pushes StatsView (existing)
- Help pushes HelpView (existing)
- `q` quits
- `/` enters search mode (global search)

### Project Level: Sessions + Memory Tabs

After selecting a project, the view has two tabs: Sessions and Memory.

```
  truffle
  Sessions │ Memory
  ──────────────────────────────────────────────────────────────────────────────

  ▎ #1  main                                                          a1b2c3d4
    "please onboard yourself to this project..."
    247 msgs · 156k tokens · 45m · 2h ago

    #2  feat/browse                                                   e5f6g7h8
    "add interactive browser to spag p..."
    89 msgs · 52k tokens · 20m · yesterday

  ──────────────────────────────────────────────────────────────────────────────
  ←→ tab  ↑↓ navigate  ⏎ open  / search  Esc back  q quit
  ──────────────────────────────────────────────────────────────────────────────
```

Pressing `→` switches to Memory tab:

```
  truffle
  Sessions │ Memory
  ──────────────────────────────────────────────────────────────────────────────

  # Memory Index

  - project_spaghetti_audit_2026-03-20.md
    Full audit results: type gaps, new .claude dirs...

  - project_cli_redesign_direction.md
    CLI redesign: TUI as default, slash commands...

  ──────────────────────────────────────────────────────────────────────────────
  ←→ tab  ↑↓ scroll  / search  Esc back  q quit
  ──────────────────────────────────────────────────────────────────────────────
```

**Tab rendering**: Active tab is bold/white, inactive tab is dim. Separated by ` │ `.

### Session Level: Messages + Todos + Plan + Subagents Tabs

After entering a session, 4 tabs:

```
  truffle › #1
  Messages │ Todos │ Plan │ Subagents
  1:user  2:claude  3:thinking  4:tools  5:system  6:internal  (284/335)
  ──────────────────────────────────────────────────────────────────────────────

  [message content]

  ──────────────────────────────────────────────────────────────────────────────
  ←→ tab  ↑↓ navigate  1-6 filter  ⏎ open  / search  Esc back  q quit
  ──────────────────────────────────────────────────────────────────────────────
```

- **Messages** (default): existing MessagesView content with filter chips
- **Todos**: existing TodosView content
- **Plan**: existing PlanView content
- **Subagents**: existing SubagentsView content

Filter chips (1-6) only show on the Messages tab.

`←→` switches tabs. `↑↓` navigates within the active tab. `Esc` goes back to the sessions list (not back to the previous tab).

### Search: `/` Key

Press `/` from any list view. A search input appears at the bottom:

```
  ──────────────────────────────────────────────────────────────────────────────
  ❯ search: █                                                        Esc cancel
  ──────────────────────────────────────────────────────────────────────────────
```

**Context-aware scope**:
- From home menu or project list: searches all projects (global)
- From sessions list: searches within the current project
- From messages: searches within the current session

Type query → Enter → pushes SearchView with results. Esc cancels.

No autocomplete dropdown — it's just a text input. Much simpler than the command palette.

---

## Navigation Flow (revised)

```
HOME (Menu: Projects / Stats / Help)
  │
  ├── Projects → ProjectsView (list)
  │     │
  │     └── Enter → ProjectTabView
  │           ├── Sessions tab (default) → list of sessions
  │           │     └── Enter → SessionTabView
  │           │           ├── Messages tab (default) → message list with filters
  │           │           │     └── Enter → DetailView (message/tool/thinking)
  │           │           ├── Todos tab → todo list
  │           │           ├── Plan tab → plan content
  │           │           └── Subagents tab → subagent list
  │           │                 └── Enter → subagent transcript
  │           └── Memory tab → project MEMORY.md
  │
  ├── Stats → StatsView
  └── Help → HelpView

/ (search) → SearchView → Enter on result → navigates to message in context
```

---

## File Changes

### New files

| File | Purpose |
|------|---------|
| `views/menu-view.tsx` | Home menu (Projects / Stats / Help) |
| `views/project-tab-view.tsx` | Tab container for Sessions + Memory at project level |
| `views/session-tab-view.tsx` | Tab container for Messages + Todos + Plan + Subagents at session level |
| `views/tab-bar.tsx` | Shared `<TabBar>` component for rendering tab headers |
| `views/search-input.tsx` | Simple search input (replaces command-input.tsx) |

### Modified files

| File | Change |
|------|--------|
| `views/shell.tsx` | Replace command mode with search mode. Initial view = MenuView instead of ProjectsView. Remove slash command handling. Remove `setSubtitle`. |
| `views/types.ts` | Remove `setSubtitle` from ViewNav. Add search mode flag. |
| `views/chrome.tsx` | May need to support tab bar in header area |
| `views/messages-view.tsx` | Remove subtitle/filter-chip push to shell — render filter chips locally (below tab bar). Accept as a panel within SessionTabView. |
| `views/help-view.tsx` | Update keybinding docs (tabs, search) |

### Deleted files

| File | Reason |
|------|--------|
| `views/command-input.tsx` | Replaced by simpler search-input.tsx |
| `views/commands.ts` | No more slash commands |
| `views/memory-view.tsx` | Content absorbed into project-tab-view.tsx (Memory tab) |
| `views/todos-view.tsx` | Content absorbed into session-tab-view.tsx (Todos tab) |
| `views/plan-view.tsx` | Content absorbed into session-tab-view.tsx (Plan tab) |
| `views/subagents-view.tsx` | Content absorbed into session-tab-view.tsx (Subagents tab) |

### Unchanged files

| File | Reason |
|------|--------|
| `views/boot-view.tsx` | No change |
| `views/welcome-panel.tsx` | No change |
| `views/wordmark.tsx` | No change |
| `views/projects-view.tsx` | Stays as-is — just the project list |
| `views/sessions-view.tsx` | Stays as-is — just the session list |
| `views/detail-view.tsx` | Stays as-is |
| `views/search-view.tsx` | Stays as-is (results list) |
| `views/stats-view.tsx` | Stays as-is |
| `views/display-items.ts` | No change |
| `views/hooks.ts` | No change |
| `views/context.tsx` | No change |

---

## Implementation Plan

### Phase A: Tab infrastructure + Search input

1. Create `views/tab-bar.tsx` — shared component
2. Create `views/search-input.tsx` — simple text input (no autocomplete)
3. Update `views/types.ts` — remove `setSubtitle`, add search mode
4. Update `views/shell.tsx` — replace command mode with search mode

### Phase B: Menu home screen

1. Create `views/menu-view.tsx` — 3-item menu
2. Update `views/shell.tsx` — initial view = MenuView
3. Update `views/welcome-panel.tsx` — shown above menu instead of projects

### Phase C: Project-level tabs (Sessions + Memory)

1. Create `views/project-tab-view.tsx` — wraps SessionsView + memory content
2. Update navigation: ProjectsView Enter → pushes ProjectTabView instead of SessionsView
3. Delete `views/memory-view.tsx` — absorbed into ProjectTabView

### Phase D: Session-level tabs (Messages + Todos + Plan + Subagents)

1. Create `views/session-tab-view.tsx` — wraps MessagesView + todo/plan/subagent content
2. Update navigation: SessionsView Enter → pushes SessionTabView instead of MessagesView
3. Move filter chips back inside MessagesView (local, not pushed to shell subtitle)
4. Delete `views/todos-view.tsx`, `views/plan-view.tsx`, `views/subagents-view.tsx`

### Phase E: Cleanup

1. Delete `views/command-input.tsx` and `views/commands.ts`
2. Update `views/help-view.tsx` with new keybindings
3. Update `views/index.ts` barrel exports
4. Verify typecheck + build + tests

---

## Comparison

| Aspect | RFC 001 (slash commands) | RFC 002 (menu + tabs) |
|--------|------------------------|----------------------|
| Feature discovery | Must type `/help` | Visible menu + tabs |
| Access to memory | `/memory` from project context | `→` tab at project level |
| Access to todos | `/todos` from session context | `→` tab at session level |
| Search | `/search <query>` | `/` then type query |
| Stats | `/stats` slash command | Menu item on home |
| Help | `/help` or `?` | Menu item on home |
| Concepts to learn | Push/pop + slash commands + autocomplete | Push/pop + tabs + search |
| Key bindings | `↑↓ Enter Esc / q 1-6` | `↑↓ ←→ Enter Esc / q 1-6` |
| Extra keypress to projects | 0 (direct) | 1 (Enter on Projects menu) |
| Files | 23 | ~20 (fewer, simpler) |
