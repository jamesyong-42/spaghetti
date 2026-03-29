---
"@vibecook/spaghetti-core": patch
"@vibecook/spaghetti": patch
---

Truffle-style update command, cross-platform fixes, eslint + prettier

- `spaghetti update` command — checks npm registry and installs latest version
- Background update check notifies on startup (24h interval, non-blocking)
- Windows cross-platform compatibility (path.sep, CRLF, pager fallback)
- ESLint + Prettier configured with CI integration
- Cross-platform CI matrix (ubuntu, macOS, Windows)
