# @vibecook/spaghetti-sdk

Local-first SDK for Claude Code data — parse `~/.claude`, index into SQLite, query sessions/messages/memory/todos/plans/subagents, and run full-text search.

Part of [Spaghetti](https://github.com/jamesyong-42/spaghetti).

[![npm](https://img.shields.io/npm/v/@vibecook/spaghetti-sdk.svg)](https://www.npmjs.com/package/@vibecook/spaghetti-sdk)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

## Install

```bash
npm install @vibecook/spaghetti-sdk
# or
pnpm add @vibecook/spaghetti-sdk
```

React components are shipped under the `/react` subpath and require React 19 (peer).

## Core API

```ts
import { createSpaghettiService } from '@vibecook/spaghetti-sdk';

const spaghetti = createSpaghettiService();
await spaghetti.initialize();

const projects = spaghetti.getProjectList();
const sessions = spaghetti.getSessionList(projects[0].slug);
const messages = spaghetti.getSessionMessages(projects[0].slug, sessions[0].sessionId);
const results = spaghetti.search({ text: 'worker thread' });

spaghetti.shutdown();
```

### Key methods

- `getProjectList()`
- `getSessionList(projectSlug)`
- `getSessionMessages(projectSlug, sessionId, limit?, offset?)`
- `getProjectMemory(projectSlug)`
- `getSessionTodos(projectSlug, sessionId)`
- `getSessionPlan(projectSlug, sessionId)`
- `getSessionSubagents(projectSlug, sessionId)`
- `search(query)`
- `getStats()`
- `onProgress()` / `onReady()` / `onChange()`

## React components

```tsx
import { SpaghettiProvider, AgentDataPlayground } from '@vibecook/spaghetti-sdk/react';

export default function App() {
  return (
    <SpaghettiProvider api={api}>
      <AgentDataPlayground />
    </SpaghettiProvider>
  );
}
```

Exports include `SpaghettiProvider`, `useSpaghettiAPI`, `AgentDataPlayground`, `ProjectCard`, `SessionCard`, `MessageEntry`, `DetailOverlay`, `MetaRow`, `Badge`, and formatter utilities (`formatTokenCount`, `formatRelativeTime`, `formatDuration`, `formatBytes`).

## Data flow

At init, the service:

- discovers project/session files under `~/.claude`
- parses projects in streaming mode (worker threads when available, sequential fallback)
- writes normalized rows into a SQLite database at `~/.spaghetti/cache/spaghetti.db`
- builds and maintains FTS5 search indexes
- tracks file fingerprints so warm starts skip unchanged work

Query and ingest share one SQLite connection to avoid `SQLITE_BUSY` conflicts.

## Native dependency

Uses `better-sqlite3` (N-API). Binary prebuilds are available for Node 18+ on common platforms; source build falls back via `node-gyp` if no prebuild matches.

## Migration from `@vibecook/spaghetti-core`

`@vibecook/spaghetti-sdk` replaces the deprecated `@vibecook/spaghetti-core` and the private `@vibecook/spaghetti-ui`.

```diff
- import { createSpaghettiService } from '@vibecook/spaghetti-core';
+ import { createSpaghettiService } from '@vibecook/spaghetti-sdk';

- import { SpaghettiProvider } from '@vibecook/spaghetti-ui';
+ import { SpaghettiProvider } from '@vibecook/spaghetti-sdk/react';
```

The public API is unchanged.

## License

[MIT](https://github.com/jamesyong-42/spaghetti/blob/main/LICENSE) — James Yong
