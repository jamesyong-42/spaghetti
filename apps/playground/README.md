# @vibecook/spaghetti-playground

Private Electron desktop app demonstrating `@vibecook/spaghetti-sdk` end-to-end.

## Requirements

Node 24 (see root `.nvmrc`). `nvm use` before working in this directory.

## Commands

```bash
pnpm -F @vibecook/spaghetti-playground dev     # run in dev (Vite HMR + Electron)
pnpm -F @vibecook/spaghetti-playground build   # produce out/{main,preload,renderer}
pnpm -F @vibecook/spaghetti-playground start   # preview a built bundle
```

## Native module (`better-sqlite3`) ABI note

`better-sqlite3` is a native module and only has **one** copy in the pnpm
store, shared between `packages/sdk` (tested under Node) and this app (runs
under Electron). Node and Electron use different V8 ABIs, so the binary
can't satisfy both at once.

The workflow:

- `pnpm install` builds the binary for **Node** (via prebuild-install).
  `pnpm test:packages` works out of the box.
- `pnpm -F @vibecook/spaghetti-playground dev` (or `start`) has a `predev`
  hook that runs `electron-rebuild`, which recompiles the binary for
  **Electron**'s ABI. The app then launches.
- After running the app, the binary is Electron-ABI. To run SDK tests
  again, rebuild for Node:
  ```bash
  pnpm -F @vibecook/spaghetti-playground rebuild:node
  # or from anywhere:
  pnpm rebuild better-sqlite3
  ```

Requires Xcode CLT (macOS) / Python 3 / node-gyp prerequisites to compile
from source if the prebuild isn't available.

## Architecture

```
┌──────────────┐   ipcMain.handle   ┌─────────────────────────┐
│   renderer   │ ─────────────────▶ │         main            │
│  React 19    │  window.spaghetti  │   SpaghettiService      │
│  SDK /react  │ ◀───── events ──── │   source: ~/.claude     │
└──────────────┘                    │   db: <userData>/cache  │
        ▲           contextBridge   └────────────┬────────────┘
        │                                        │
        └─ preload (typed) ──────────────────────┘
```

- **main** owns a single `SpaghettiService`. Source data is read from
  `~/.claude`; the SQLite index lives inside Electron's platform-specific
  `userData` folder (`app.getPath('userData')/cache/spaghetti-<engine>.db`)
  rather than the SDK's home-relative default, so the desktop app keeps
  its data in the OS-sanctioned app-data location. Progress/ready/change
  events are forwarded to all renderer windows.
- **preload** exposes `window.spaghetti`, a typed surface defined in
  `src/shared/ipc.ts` (one method per SDK query + lifecycle/event helpers).
- **renderer** uses `SpaghettiProvider` from `@vibecook/spaghetti-sdk/react`
  fed by an IPC adapter (`src/renderer/src/ipc-api.ts`). The shell
  subscribes to `onChange` to live-update when `~/.claude` changes, shows
  the active ingest engine (`rs` native vs `ts`) in the header, and
  surfaces the SDK's `rebuildIndex()` via a toolbar button.

## Notes

The renderer does **not** mount `<AgentDataPlayground />` directly — that
component assumes synchronous SDK calls, but over IPC every call is a
Promise. The shell in `App.tsx` is a minimal read-only project/session
browser built on the provider.
