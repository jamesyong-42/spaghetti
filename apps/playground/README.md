# @vibecook/spaghetti-playground

Private Electron desktop app demonstrating `@vibecook/spaghetti-sdk` end-to-end.

## Commands

```bash
pnpm -F @vibecook/spaghetti-playground dev     # run in dev (Vite HMR + Electron)
pnpm -F @vibecook/spaghetti-playground build   # produce out/{main,preload,renderer}
pnpm -F @vibecook/spaghetti-playground start   # preview a built bundle
```

The `postinstall` script runs `electron-rebuild` to recompile `better-sqlite3`
against Electron's ABI. This fails fast if your toolchain is missing (Xcode
CLT, Python 3, node-gyp prerequisites) — fix the error rather than skipping.

## Architecture

```
┌──────────────┐   ipcMain.handle   ┌─────────────────┐
│   renderer   │ ─────────────────▶ │      main       │
│  React 19    │  window.spaghetti  │ SpaghettiService│
│  SDK /react  │ ◀───── events ──── │ (~/.claude DB)  │
└──────────────┘                    └─────────────────┘
        ▲           contextBridge           ▲
        │                                   │
        └───── preload (typed) ─────────────┘
```

- **main** owns a single `SpaghettiService` (SQLite over `~/.claude`) and
  forwards progress/ready/change events to all windows.
- **preload** exposes `window.spaghetti`, a typed surface defined in
  `src/shared/ipc.ts` (one method per SDK query).
- **renderer** uses `SpaghettiProvider` from `@vibecook/spaghetti-sdk/react`
  fed by an IPC adapter (`src/renderer/src/ipc-api.ts`).

## Notes

The renderer does **not** mount `<AgentDataPlayground />` directly — that
component assumes synchronous SDK calls, but over IPC every call is a
Promise. The shell in `App.tsx` is a minimal read-only project/session
browser built on the provider.
