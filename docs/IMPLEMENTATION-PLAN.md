# Spaghetti Implementation Plan
**Status**: Core implementation complete (Architecture C)
**Created**: 2026-03-16
**Updated**: 2026-03-21 — Type audit, parser fixes, Architecture C cache redesign (all 4 phases)

---

## 1. Package Structure

**Recommendation: Two packages** -- `@spaghetti/core` and `@spaghetti/ui`.

Rationale: The core backend (parsers, segment store, SQLite, file watching) has Node.js-only dependencies (better-sqlite3, chokidar, fs). The UI is a React component tree. Consumers who only want programmatic access (e.g., a CLI tool, a server) should not pull in React. Consumers who want the UI (e.g., vibe-ctl, a standalone Electron/Tauri app, a dev server with a web UI) import both.

```
/Users/jamesyong/Projects/project100/p008/spaghetti/
├── package.json              # Root workspace config
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── packages/
│   ├── core/
│   │   ├── package.json      # @spaghetti/core
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts    # Library mode build
│   │   └── src/
│   │       ├── index.ts      # Public API barrel
│   │       ├── types/        # Layer 6: All shared types (moved from shared package)
│   │       │   ├── index.ts
│   │       │   ├── projects.ts
│   │       │   ├── tasks.ts
│   │       │   ├── todos.ts
│   │       │   ├── debug.ts
│   │       │   ├── session-env.ts
│   │       │   ├── file-history-data.ts
│   │       │   ├── plans-data.ts
│   │       │   ├── shell-snapshots-data.ts
│   │       │   ├── paste-cache-data.ts
│   │       │   ├── plugins-data.ts
│   │       │   ├── telemetry-data.ts
│   │       │   ├── statsig-data.ts
│   │       │   ├── ide-data.ts
│   │       │   ├── cache-data.ts
│   │       │   ├── toplevel-files-data.ts
│   │       │   └── aggregates.ts    # ClaudeCodeAgentData, Project, Session, AgentConfig, AgentAnalytic (from index.ts)
│   │       ├── io/           # Layer 7: Foundation IO
│   │       │   ├── index.ts
│   │       │   ├── file-service.ts
│   │       │   ├── sqlite-service.ts
│   │       │   └── msgpack-service.ts
│   │       ├── parser/       # Layer 5: Parsers
│   │       │   ├── index.ts
│   │       │   ├── claude-code-parser.ts
│   │       │   ├── project-parser.ts
│   │       │   ├── config-parser.ts
│   │       │   └── analytics-parser.ts
│   │       ├── data/         # Layer 4: Backend services
│   │       │   ├── index.ts
│   │       │   ├── agent-data-service.ts
│   │       │   ├── segment-store.ts
│   │       │   ├── search-indexer.ts
│   │       │   ├── segment-types.ts
│   │       │   └── summary-types.ts
│   │       ├── app-service.ts    # Layer 4: ClaudeCodeAppService (the facade)
│   │       ├── api.ts            # Layer 3: AgentDataAPI interface + event types
│   │       ├── create.ts         # Factory: createSpaghettiService() one-liner
│   │       └── __tests__/
│   │           ├── segment-store.test.ts
│   │           ├── search-indexer.test.ts
│   │           ├── file-service.test.ts
│   │           ├── sqlite-service.test.ts
│   │           ├── msgpack-service.test.ts
│   │           ├── project-parser.test.ts
│   │           ├── config-parser.test.ts
│   │           ├── analytics-parser.test.ts
│   │           ├── agent-data-service.test.ts
│   │           └── app-service.test.ts
│   └── ui/
│       ├── package.json      # @spaghetti/ui
│       ├── tsconfig.json
│       ├── vite.config.ts    # Library mode build
│       └── src/
│           ├── index.ts      # Public API barrel
│           ├── context.tsx           # SpaghettiProvider + useSpaghettiAPI hook
│           ├── AgentDataPlayground.tsx  # Main component (refactored)
│           ├── components/
│           │   ├── ProjectCard.tsx
│           │   ├── SessionCard.tsx
│           │   ├── MessageEntry.tsx
│           │   ├── DetailOverlay.tsx
│           │   ├── MetaRow.tsx
│           │   ├── Badge.tsx
│           │   ├── SearchBar.tsx
│           │   └── LoadingScreen.tsx
│           ├── hooks/
│           │   ├── useProjects.ts
│           │   ├── useSessions.ts
│           │   ├── useMessages.ts
│           │   └── useSearch.ts
│           └── utils/
│               └── formatters.ts     # formatTokenCount, formatRelativeTime, etc.
```

## 2. File Migration Map

### 2.1 Layer 6: Shared Types (16 files)

| Source (vibe-ctl) | Destination (spaghetti) | Changes |
|---|---|---|
| `packages/shared/src/agent/claude-code/types/projects.ts` | `packages/core/src/types/projects.ts` | None -- pure types, no imports to change |
| `packages/shared/src/agent/claude-code/types/tasks.ts` | `packages/core/src/types/tasks.ts` | None |
| `packages/shared/src/agent/claude-code/types/todos.ts` | `packages/core/src/types/todos.ts` | None |
| `packages/shared/src/agent/claude-code/types/debug.ts` | `packages/core/src/types/debug.ts` | None |
| `packages/shared/src/agent/claude-code/types/session-env.ts` | `packages/core/src/types/session-env.ts` | None |
| `packages/shared/src/agent/claude-code/types/file-history-data.ts` | `packages/core/src/types/file-history-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/plans-data.ts` | `packages/core/src/types/plans-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/shell-snapshots-data.ts` | `packages/core/src/types/shell-snapshots-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/paste-cache-data.ts` | `packages/core/src/types/paste-cache-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/plugins-data.ts` | `packages/core/src/types/plugins-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/telemetry-data.ts` | `packages/core/src/types/telemetry-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/statsig-data.ts` | `packages/core/src/types/statsig-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/ide-data.ts` | `packages/core/src/types/ide-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/cache-data.ts` | `packages/core/src/types/cache-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/toplevel-files-data.ts` | `packages/core/src/types/toplevel-files-data.ts` | None |
| `packages/shared/src/agent/claude-code/types/index.ts` | `packages/core/src/types/index.ts` | Remove `.js` extensions from re-exports (Vite handles resolution) |
| `packages/shared/src/agent/claude-code/index.ts` (aggregate interfaces only) | `packages/core/src/types/aggregates.ts` | Extract `ClaudeCodeAgentData`, `Project`, `Session`, `SubagentTranscript`, `AgentConfig`, `AgentAnalytic` interfaces. Change all imports from `'./types/foo.js'` to `'./foo.js'` (relative within same directory). Re-export from `types/index.ts`. |

### 2.2 Layer 7: Foundation IO (3 files)

| Source | Destination | Changes |
|---|---|---|
| `packages/desktop/src/main/services/foundation/io/file-service.ts` | `packages/core/src/io/file-service.ts` | No changes needed. Already uses only Node.js `fs`, `path`, and `chokidar`. No Electron imports. |
| `packages/desktop/src/main/services/foundation/io/sqlite-service.ts` | `packages/core/src/io/sqlite-service.ts` | No changes needed. Already uses only `better-sqlite3` and `fs`/`path`. |
| `packages/desktop/src/main/services/foundation/io/msgpack-service.ts` | `packages/core/src/io/msgpack-service.ts` | No changes needed. Already uses only `@msgpack/msgpack` and `fs`. |
| `packages/desktop/src/main/services/foundation/io/index.ts` | `packages/core/src/io/index.ts` | Copy verbatim. Same re-export structure. |

### 2.3 Layer 5: Parsers (4 files + barrel)

| Source | Destination | Changes |
|---|---|---|
| `packages/desktop/.../parser/claude-code-parser.ts` | `packages/core/src/parser/claude-code-parser.ts` | Change `import type { FileService } from '../../../foundation'` to `import type { FileService } from '../io'`. Change `import type { ClaudeCodeAgentData } from '@claude-code-on-the-go/shared/agent/claude-code'` to `import type { ClaudeCodeAgentData } from '../types'`. |
| `packages/desktop/.../parser/project-parser.ts` | `packages/core/src/parser/project-parser.ts` | Same two import path changes: `../../../foundation` to `../io`, and `@claude-code-on-the-go/shared/agent/claude-code` to `../types`. |
| `packages/desktop/.../parser/config-parser.ts` | `packages/core/src/parser/config-parser.ts` | Same two import path changes. Also: `import * as fs from 'node:fs'` stays (used in analytics-parser, not this file). |
| `packages/desktop/.../parser/analytics-parser.ts` | `packages/core/src/parser/analytics-parser.ts` | Same two import path changes. Keep `import * as fs from 'node:fs'` (used for `readlinkSync`). |
| `packages/desktop/.../parser/index.ts` | `packages/core/src/parser/index.ts` | Copy verbatim -- only re-exports local modules. |

### 2.4 Layer 4: Backend Services (5 files + facade)

| Source | Destination | Changes |
|---|---|---|
| `packages/desktop/.../data/segment-types.ts` | `packages/core/src/data/segment-types.ts` | No changes -- pure types, zero imports. |
| `packages/desktop/.../data/summary-types.ts` | `packages/core/src/data/summary-types.ts` | No changes -- pure types, zero imports. |
| `packages/desktop/.../data/search-indexer.ts` | `packages/core/src/data/search-indexer.ts` | Change `import type { SegmentType } from './segment-types'` -- stays the same (relative). |
| `packages/desktop/.../data/segment-store.ts` | `packages/core/src/data/segment-store.ts` | Change `import type { SqliteService } from '../../../foundation'` to `import type { SqliteService } from '../io'`. Change `import type { MessagePackService } from '../../../foundation'` to `import type { MessagePackService } from '../io'`. |
| `packages/desktop/.../data/claude-code-agent-data-service.ts` | `packages/core/src/data/agent-data-service.ts` | **Significant changes**: (1) `import type { FileService, FileChange, SqliteService, MessagePackService } from '../../../foundation'` becomes `from '../io'`. (2) `import type { ... } from '@claude-code-on-the-go/shared/agent/claude-code'` becomes `from '../types'`. (3) `import { createClaudeCodeParser } from '../parser'` becomes `from '../parser'`. (4) All other relative imports stay the same (within `./data/`). (5) Rename class `ClaudeCodeAgentDataServiceImpl` to `AgentDataServiceImpl` and interface to `AgentDataService` (shorter, no longer namespaced). (6) Change `DB_RELATIVE_PATH` default from `'.claude-on-the-go/cache/agent-claude-code-segments.db'` to `'.spaghetti/cache/segments.db'`. |
| `packages/desktop/.../claude-code-app-service.ts` | `packages/core/src/app-service.ts` | Change import `from './data/claude-code-agent-data-service'` to `from './data/agent-data-service'`. Change import `from '@claude-code-on-the-go/shared/agent/claude-code'` to `from './types'`. Replace `EventEmitter` from `events` with own typed EventEmitter or keep Node.js `events` (acceptable for Node package). |

### 2.5 New File: `api.ts` (The Interface Contract)

This is the **key abstraction** that replaces `window.desktopAPI.agentData`. Create new at `packages/core/src/api.ts`.

### 2.6 New File: `create.ts` (One-line Factory)

Create new at `packages/core/src/create.ts`. Wires all services together.

### 2.7 Layer 1: UI (1 monolith becomes ~12 files)

| Source | Destination | Changes |
|---|---|---|
| `AgentDataPlayground.tsx` lines 17-53 (formatters) | `packages/ui/src/utils/formatters.ts` | Extract 4 functions. Pure, no deps. |
| `AgentDataPlayground.tsx` lines 60-106 (message context) | `packages/ui/src/utils/formatters.ts` (append) | Extract `buildMessageContext`, `isToolResultOnlyMessage`. |
| `AgentDataPlayground.tsx` lines 118-165 (ProjectCard) | `packages/ui/src/components/ProjectCard.tsx` | Import types from `@spaghetti/core`. Import formatters from `../utils/formatters`. Replace `AgentDataProjectListItem` with `ProjectListItem` from core. |
| `AgentDataPlayground.tsx` lines 169-249 (SessionCard) | `packages/ui/src/components/SessionCard.tsx` | Same pattern. |
| `AgentDataPlayground.tsx` lines 254-271 (MetaRow, Badge) | `packages/ui/src/components/MetaRow.tsx`, `Badge.tsx` | Extract as standalone components. |
| `AgentDataPlayground.tsx` lines 275-846 (MessageEntry) | `packages/ui/src/components/MessageEntry.tsx` | Largest piece. Import MetaRow, Badge. Import types from core. |
| `AgentDataPlayground.tsx` lines 850-875 (DetailOverlay) | `packages/ui/src/components/DetailOverlay.tsx` | Remove `WebkitAppRegion` CSS and `drag-region` div (Electron coupling). Accept a `className` prop for host-specific styling instead. |
| `AgentDataPlayground.tsx` lines 879-1587 (main component) | `packages/ui/src/AgentDataPlayground.tsx` | Remove `window.desktopAPI.agentData` access. Instead, call `useSpaghettiAPI()` from context. Remove `drag-region` divs. Import sub-components. |
| (new) | `packages/ui/src/context.tsx` | React context providing `SpaghettiAPI`. |
| (new) | `packages/ui/src/hooks/useProjects.ts` | Extract project-fetching logic from main component. |
| (new) | `packages/ui/src/hooks/useSessions.ts` | Extract session-fetching logic. |
| (new) | `packages/ui/src/hooks/useMessages.ts` | Extract message pagination logic. |
| (new) | `packages/ui/src/hooks/useSearch.ts` | Extract search logic. |

## 3. Interface Abstraction: `SpaghettiAPI`

This is the contract that replaces `window.desktopAPI.agentData`. It lives in `@spaghetti/core` so both core and UI can import it.

File: `packages/core/src/api.ts`

```typescript
/**
 * SpaghettiAPI — The transport-agnostic interface for agent data access.
 *
 * Consumers provide an implementation of this interface.
 * - In Electron: implemented via IPC bridge (thin adapter in vibe-ctl)
 * - In standalone/dev: implemented by DirectSpaghettiAPI wrapping AppService
 * - In web: could be implemented via HTTP/WebSocket
 */

import type { ProjectListItem, SessionListItem, MessagePage, SubagentListItem, SubagentMessagePage } from './app-service';
import type { SearchQuery, SearchResultSet, StoreStats, InitProgress, SegmentChangeBatch } from './data/segment-types';

// Re-export response types consumers will need
export type { ProjectListItem, SessionListItem, MessagePage, SubagentListItem, SubagentMessagePage };
export type { SearchQuery, SearchResultSet, StoreStats, InitProgress, SegmentChangeBatch };

export interface TodoItem {
  content: string;
  status: string;
  priority?: string;
  [key: string]: unknown;
}

export interface PlanFile {
  slug: string;
  title: string;
  content: string;
  size: number;
}

export interface TaskEntry {
  taskId: string;
  hasHighwatermark: boolean;
  highwatermark: number | null;
  lockExists: boolean;
}

export interface SpaghettiAPI {
  // === Data Queries ===
  getProjectList(): Promise<ProjectListItem[]>;
  getSessionList(projectSlug: string): Promise<SessionListItem[]>;
  getSessionMessages(
    projectSlug: string,
    sessionId: string,
    limit?: number,
    offset?: number,
  ): Promise<MessagePage>;
  getProjectMemory(projectSlug: string): Promise<string | null>;
  getSessionTodos(projectSlug: string, sessionId: string): Promise<TodoItem[]>;
  getSessionPlan(projectSlug: string, sessionId: string): Promise<PlanFile | null>;
  getSessionTask(projectSlug: string, sessionId: string): Promise<TaskEntry | null>;
  getToolResult(
    projectSlug: string,
    sessionId: string,
    toolUseId: string,
  ): Promise<string | null>;
  getSessionSubagents(
    projectSlug: string,
    sessionId: string,
  ): Promise<SubagentListItem[]>;
  getSubagentMessages(
    projectSlug: string,
    sessionId: string,
    agentId: string,
    limit?: number,
    offset?: number,
  ): Promise<SubagentMessagePage>;
  search(query: SearchQuery): Promise<SearchResultSet>;
  getStats(): Promise<StoreStats>;

  // === Lifecycle Events ===
  /** Subscribe to initialization progress. Returns unsubscribe function. */
  onProgress(cb: (progress: InitProgress) => void): () => void;
  /** Subscribe to service readiness. Returns unsubscribe function. */
  onReady(cb: (info: { durationMs: number }) => void): () => void;
  /** Subscribe to data changes. Returns unsubscribe function. */
  onChange(cb: (batch: SegmentChangeBatch) => void): () => void;
}
```

### 3.1 Direct Implementation (in-process, no IPC)

File: `packages/core/src/create.ts`

```typescript
import { createFileService } from './io/file-service';
import { createSqliteService } from './io/sqlite-service';
import { createMessagePackService } from './io/msgpack-service';
import { createAgentDataService } from './data/agent-data-service';
import { createAppService } from './app-service';
import type { SpaghettiAPI, InitProgress } from './api';
import type { SegmentChangeBatch } from './data/segment-types';
import type { AppService } from './app-service';

export interface SpaghettiServiceOptions {
  /** Override ~/.claude directory path */
  claudeDir?: string;
  /** Override database storage path */
  dbPath?: string;
}

export interface SpaghettiService {
  /** The API interface (pass this to UI or use directly) */
  api: SpaghettiAPI;
  /** Start parsing and watching ~/.claude/ */
  initialize(): Promise<void>;
  /** Stop watchers, close database */
  shutdown(): void;
}

export function createSpaghettiService(
  options?: SpaghettiServiceOptions,
): SpaghettiService {
  const fileService = createFileService();
  const dataService = createAgentDataService(
    fileService,
    createSqliteService,
    createMessagePackService(),
    options,
  );
  const appService = createAppService(dataService);

  const api: SpaghettiAPI = {
    getProjectList: async () => {
      if (!appService.isReady()) return [];
      return appService.getProjectList();
    },
    getSessionList: async (projectSlug) => {
      if (!appService.isReady()) return [];
      return appService.getSessionList(projectSlug);
    },
    getSessionMessages: async (projectSlug, sessionId, limit, offset) => {
      if (!appService.isReady()) return { messages: [], total: 0, offset: 0, hasMore: false };
      return appService.getSessionMessages(projectSlug, sessionId, limit, offset);
    },
    getProjectMemory: async (projectSlug) => {
      if (!appService.isReady()) return null;
      return appService.getProjectMemory(projectSlug);
    },
    getSessionTodos: async (projectSlug, sessionId) => {
      if (!appService.isReady()) return [];
      return appService.getSessionTodos(projectSlug, sessionId) as any;
    },
    getSessionPlan: async (projectSlug, sessionId) => {
      if (!appService.isReady()) return null;
      return appService.getSessionPlan(projectSlug, sessionId) as any;
    },
    getSessionTask: async (projectSlug, sessionId) => {
      if (!appService.isReady()) return null;
      return appService.getSessionTask(projectSlug, sessionId) as any;
    },
    getToolResult: async (projectSlug, sessionId, toolUseId) => {
      if (!appService.isReady()) return null;
      return appService.getPersistedToolResult(projectSlug, sessionId, toolUseId);
    },
    getSessionSubagents: async (projectSlug, sessionId) => {
      if (!appService.isReady()) return [];
      return appService.getSessionSubagents(projectSlug, sessionId);
    },
    getSubagentMessages: async (projectSlug, sessionId, agentId, limit, offset) => {
      if (!appService.isReady()) return { messages: [], total: 0, offset: 0, hasMore: false };
      return appService.getSubagentMessages(projectSlug, sessionId, agentId, limit, offset);
    },
    search: async (query) => {
      if (!appService.isReady()) return { results: [], total: 0, hasMore: false };
      return appService.search(query);
    },
    getStats: async () => {
      if (!appService.isReady()) return { totalSegments: 0, segmentsByType: {}, totalFingerprints: 0, dbSizeBytes: 0, searchIndexed: 0 };
      return appService.getStoreStats();
    },
    onProgress: (cb) => {
      appService.on('progress', cb);
      return () => appService.removeListener('progress', cb);
    },
    onReady: (cb) => {
      appService.on('ready', cb);
      return () => appService.removeListener('ready', cb);
    },
    onChange: (cb) => {
      appService.on('change', cb);
      return () => appService.removeListener('change', cb);
    },
  };

  return {
    api,
    initialize: () => appService.initialize(),
    shutdown: () => appService.shutdown(),
  };
}
```

## 4. Build Configuration

### 4.1 Root `package.json`

```json
{
  "name": "spaghetti",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "clean": "pnpm -r clean"
  },
  "devDependencies": {
    "typescript": "~5.9.3",
    "vitest": "^3.2.1"
  }
}
```

### 4.2 Root `pnpm-workspace.yaml`

```yaml
packages:
  - packages/*

onlyBuiltDependencies:
  - better-sqlite3
```

### 4.3 Root `tsconfig.base.json`

Copy from vibe-ctl's `tsconfig.base.json` verbatim:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

### 4.4 `@spaghetti/core` Package

**`packages/core/package.json`**:
```json
{
  "name": "@spaghetti/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./types": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/types/index.js",
      "require": "./dist/types/index.cjs"
    },
    "./api": {
      "types": "./dist/api.d.ts",
      "import": "./dist/api.js",
      "require": "./dist/api.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "dev": "vite build --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@msgpack/msgpack": "^3.1.3",
    "better-sqlite3": "^11.10.0",
    "chokidar": "^3.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.10.1",
    "typescript": "~5.9.3",
    "vite": "^7.0.0",
    "vite-plugin-dts": "^4.5.0"
  },
  "peerDependencies": {},
  "engines": {
    "node": ">=18"
  }
}
```

**`packages/core/vite.config.ts`**:
```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        api: resolve(__dirname, 'src/api.ts'),
        'types/index': resolve(__dirname, 'src/types/index.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'better-sqlite3',
        'chokidar',
        '@msgpack/msgpack',
        'events',
        'fs',
        'fs/promises',
        'path',
        'os',
        'node:os',
        'node:path',
        'node:fs',
      ],
    },
    outDir: 'dist',
    sourcemap: true,
  },
});
```

**`packages/core/tsconfig.json`**:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

### 4.5 `@spaghetti/ui` Package

**`packages/ui/package.json`**:
```json
{
  "name": "@spaghetti/ui",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "dev": "vite build --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@spaghetti/core": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.5",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^4.5.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "tailwindcss": "^4.1.11",
    "@tailwindcss/vite": "^4.1.11",
    "typescript": "~5.9.3",
    "vite": "^7.0.0",
    "vite-plugin-dts": "^4.5.0"
  }
}
```

**`packages/ui/vite.config.ts`**:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: './src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', '@spaghetti/core'],
    },
    outDir: 'dist',
    sourcemap: true,
    cssCodeSplit: false,
  },
});
```

## 5. Testing Strategy

### 5.1 What to Test

| Test File | Scope | Approach |
|---|---|---|
| `sqlite-service.test.ts` | DB open/close, CRUD, transactions, WAL mode | **Migrate** existing test from vibe-ctl. Uses real tmpdir SQLite. No mocks. |
| `msgpack-service.test.ts` | encode/decode roundtrip, file I/O | **Migrate** existing test. Uses real tmpdir files. |
| `file-service.test.ts` | File read/write, JSONL parsing, directory scanning, incremental read, pattern matching | **Migrate** existing test. Uses real tmpdir. |
| `search-indexer.test.ts` | **New**. Extract search entries from each segment type. | Unit test, pure functions. Pass mock data, assert returned `SearchIndexEntry`. No I/O. |
| `segment-store.test.ts` | **New**. Segment CRUD, fingerprints, FTS5 search, batch ops. | Integration test. Real SQLite in tmpdir. Exercises the full store surface. |
| `project-parser.test.ts` | **New**. Parse projects from a mock `.claude/` directory. | Create a fixture directory in tmpdir with known JSONL/JSON files. Assert parsed `Project[]`. |
| `config-parser.test.ts` | **New**. Parse config from a mock `.claude/` directory. | Same fixture approach. |
| `analytics-parser.test.ts` | **New**. Parse analytics data. | Same fixture approach. |
| `agent-data-service.test.ts` | **New**. Cold start, warm start, incremental updates, file watcher integration. | Integration test with real tmpdir `.claude/` fixture. Exercises full lifecycle. |
| `app-service.test.ts` | **New**. Verify DTO mapping from data service to API response types. | Unit test. Mock the `AgentDataService` interface. Assert that `getProjectList()` returns correctly shaped `ProjectListItem[]`. |

### 5.2 How to Test Without Electron

All services use **dependency injection via interfaces**. The `FileService`, `SqliteService`, and `MessagePackService` are all interface-based with factory functions. Tests either:

1. Use the **real implementations** with tmpdir (preferred for IO services) -- no Electron dependency exists in these files.
2. Create **mock implementations** of the interfaces for unit testing higher layers.

The `chokidar` file watcher works identically outside Electron. The `better-sqlite3` native module works in plain Node.js (it's not Electron-specific). No test requires Electron.

### 5.3 Test Configuration

**Root `vitest.workspace.ts`**:
```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/core',
  'packages/ui',
]);
```

Each package gets a `vitest.config.ts` that extends the root config.

## 6. vibe-ctl Integration (Post-Extraction)

### 6.1 Files That Stay in vibe-ctl as Thin Adapters

| File | Role After Extraction |
|---|---|
| `packages/desktop/src/main/ipc/agent-data-handlers.ts` | **Adapter**: imports `createSpaghettiService` from `@spaghetti/core`, wires events to `BrowserWindow.webContents.send()`, registers `ipcMain.handle()` calls. ~80 lines total (down from 295). |
| `packages/desktop/src/preload/index.ts` (lines 728-882) | **Adapter**: Type declarations for `AgentDataAPI` become `import type { SpaghettiAPI } from '@spaghetti/core/api'`. The IPC bridge implementation at lines 1712-1771 stays but uses imported types. |
| `packages/desktop/src/renderer/components/AgentDataPlayground.tsx` | **Deleted entirely**. Replaced with: `import { AgentDataPlayground, SpaghettiProvider } from '@spaghetti/ui'` |

### 6.2 How vibe-ctl Consumes Spaghetti

**New `agent-data-handlers.ts`** (approximately):

```typescript
import { ipcMain, type BrowserWindow } from 'electron';
import { createSpaghettiService, type SpaghettiService } from '@spaghetti/core';

let service: SpaghettiService | null = null;

export async function initializeAgentDataService(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  service = createSpaghettiService();

  service.api.onProgress((data) => {
    getMainWindow()?.webContents.send('agentData:progress', data);
  });
  service.api.onReady((data) => {
    getMainWindow()?.webContents.send('agentData:ready', data);
  });
  service.api.onChange((data) => {
    getMainWindow()?.webContents.send('agentData:change', data);
  });

  await service.initialize();
}

export function shutdownAgentDataService(): void {
  service?.shutdown();
  service = null;
}

export function setupAgentDataHandlers(): void {
  ipcMain.handle('agentData:projectList', () => service?.api.getProjectList() ?? []);
  ipcMain.handle('agentData:sessionList', (_, slug) => service?.api.getSessionList(slug) ?? []);
  ipcMain.handle('agentData:sessionMessages', (_, slug, sid, limit, offset) =>
    service?.api.getSessionMessages(slug, sid, limit, offset) ?? { messages: [], total: 0, offset: 0, hasMore: false });
  ipcMain.handle('agentData:search', (_, query) => service?.api.search(query) ?? { results: [], total: 0, hasMore: false });
  ipcMain.handle('agentData:stats', () => service?.api.getStats() ?? { totalSegments: 0, segmentsByType: {}, totalFingerprints: 0, dbSizeBytes: 0, searchIndexed: 0 });
  ipcMain.handle('agentData:projectMemory', (_, slug) => service?.api.getProjectMemory(slug) ?? null);
  ipcMain.handle('agentData:sessionTodos', (_, slug, sid) => service?.api.getSessionTodos(slug, sid) ?? []);
  ipcMain.handle('agentData:sessionPlan', (_, slug, sid) => service?.api.getSessionPlan(slug, sid) ?? null);
  ipcMain.handle('agentData:sessionTask', (_, slug, sid) => service?.api.getSessionTask(slug, sid) ?? null);
  ipcMain.handle('agentData:toolResult', (_, slug, sid, toolUseId) => service?.api.getToolResult(slug, sid, toolUseId) ?? null);
  ipcMain.handle('agentData:sessionSubagents', (_, slug, sid) => service?.api.getSessionSubagents(slug, sid) ?? []);
  ipcMain.handle('agentData:subagentMessages', (_, slug, sid, agentId, limit, offset) =>
    service?.api.getSubagentMessages(slug, sid, agentId, limit, offset) ?? { messages: [], total: 0, offset: 0, hasMore: false });
}
```

**Renderer side** -- the existing preload IPC bridge stays, but the component changes to:

```tsx
import { SpaghettiProvider, AgentDataPlayground } from '@spaghetti/ui';

function AgentDataPage() {
  return (
    <SpaghettiProvider api={window.desktopAPI.agentData}>
      <AgentDataPlayground />
    </SpaghettiProvider>
  );
}
```

### 6.3 vibe-ctl's `package.json` Changes

```json
{
  "dependencies": {
    "@spaghetti/core": "workspace:*",
    "@spaghetti/ui": "workspace:*"
  }
}
```

Remove from desktop `dependencies`:
- `@msgpack/msgpack` (now in `@spaghetti/core`)
- `better-sqlite3` (now in `@spaghetti/core`)
- `chokidar` (now in `@spaghetti/core`)

Remove from desktop `devDependencies`:
- `@types/better-sqlite3` (now in `@spaghetti/core`)

## 7. Implementation Order

### Phase 1: Scaffold (no logic yet)

1. Create `/Users/jamesyong/Projects/project100/p008/spaghetti/` directory.
2. Create root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`.
3. Create `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vite.config.ts`.
4. Create `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vite.config.ts`.
5. Run `pnpm install`. Verify workspace resolves.

### Phase 2: Types (zero-risk, pure copy)

6. Copy all 16 type files from `packages/shared/src/agent/claude-code/types/` into `packages/core/src/types/`.
7. Create `packages/core/src/types/aggregates.ts` extracting aggregate interfaces from `packages/shared/src/agent/claude-code/index.ts`.
8. Create `packages/core/src/types/index.ts` barrel.
9. Run `pnpm --filter @spaghetti/core typecheck`. Fix any `.js` extension issues in re-exports.

### Phase 3: Foundation IO (low risk)

10. Copy `file-service.ts`, `sqlite-service.ts`, `msgpack-service.ts` into `packages/core/src/io/`.
11. Create `packages/core/src/io/index.ts` barrel.
12. Run typecheck. (These files have zero cross-references to other vibe-ctl code.)
13. Copy and adapt existing tests for these three services.
14. Run `pnpm --filter @spaghetti/core test`.

### Phase 4: Parsers (medium risk -- import rewrites)

15. Copy 4 parser files + barrel into `packages/core/src/parser/`.
16. In each file, change **two import paths**:
    - `'../../../foundation'` becomes `'../io'`
    - `'@claude-code-on-the-go/shared/agent/claude-code'` becomes `'../types'`
17. Run typecheck. Fix any missing type re-exports in `types/index.ts`.
18. Write fixture-based parser tests.
19. Run tests.

### Phase 5: Data Layer (higher risk -- largest file)

20. Copy `segment-types.ts`, `summary-types.ts`, `search-indexer.ts`, `segment-store.ts` into `packages/core/src/data/`.
21. Fix `segment-store.ts` imports (`'../../../foundation'` becomes `'../io'`).
22. Copy `claude-code-agent-data-service.ts` as `agent-data-service.ts`. Apply all 6 import/naming changes listed in section 2.4.
23. Create `packages/core/src/data/index.ts` barrel.
24. Run typecheck.
25. Write segment-store and search-indexer tests.
26. Write agent-data-service integration test with tmpdir fixture.

### Phase 6: App Service + API + Factory

27. Copy `claude-code-app-service.ts` as `packages/core/src/app-service.ts`. Fix imports.
28. Create `packages/core/src/api.ts` (the `SpaghettiAPI` interface).
29. Create `packages/core/src/create.ts` (the `createSpaghettiService` factory).
30. Create `packages/core/src/index.ts` barrel exporting everything.
31. Run typecheck.
32. Write app-service unit test with mock data service.
33. Run full test suite: `pnpm --filter @spaghetti/core test`.

### Phase 7: Build Verification

34. Run `pnpm --filter @spaghetti/core build`.
35. Verify `dist/` contains `.js`, `.cjs`, `.d.ts` files.
36. Verify exports resolve: create a test script that `import { createSpaghettiService } from '@spaghetti/core'` and call the factory.

### Phase 8: UI Package

37. Create `packages/ui/src/utils/formatters.ts` -- extract from `AgentDataPlayground.tsx`.
38. Create `packages/ui/src/context.tsx` -- `SpaghettiProvider` + `useSpaghettiAPI`.
39. Extract `ProjectCard`, `SessionCard`, `MetaRow`, `Badge`, `DetailOverlay`, `MessageEntry`, `SearchBar`, `LoadingScreen` into `packages/ui/src/components/`.
40. Refactor `AgentDataPlayground.tsx`:
    - Remove `window.desktopAPI.agentData` -- use `useSpaghettiAPI()` context.
    - Remove all `drag-region` divs and `WebkitAppRegion` CSS.
    - Import sub-components.
41. Create `packages/ui/src/index.ts` barrel: export `SpaghettiProvider`, `AgentDataPlayground`, `useSpaghettiAPI`, all component types.
42. Run typecheck.
43. Run `pnpm --filter @spaghetti/ui build`.

### Phase 9: vibe-ctl Integration

44. Add `@spaghetti/core` and `@spaghetti/ui` to vibe-ctl's `pnpm-workspace.yaml` and desktop `package.json`.
45. Rewrite `agent-data-handlers.ts` as thin IPC adapter (section 6.2).
46. Replace `AgentDataPlayground.tsx` usage in renderer with `SpaghettiProvider` + `AgentDataPlayground` from `@spaghetti/ui`.
47. Remove migrated files from vibe-ctl's source tree (services, parsers, types).
48. Run vibe-ctl's typecheck and test suite.
49. Run `pnpm --filter claude-code-on-the-go-desktop dev:agent-data` to verify the playground works end-to-end through the IPC bridge.

## 8. Risk Mitigation

### 8.1 `better-sqlite3` Native Dependency

**Risk**: `better-sqlite3` requires native compilation. Consumers using Electron need to rebuild for their Electron version. Consumers using plain Node.js need the standard build.

**Mitigation**:
- Keep `better-sqlite3` as a **regular dependency** (not a peer dependency) so it's installed automatically.
- Document `onlyBuiltDependencies: [better-sqlite3]` in the root `pnpm-workspace.yaml`.
- For Electron consumers, document the need for `electron-rebuild` or `@electron/rebuild`.
- Long-term, consider adding a `SqliteService` adapter that accepts an externally-provided database instance, so consumers can bring their own SQLite binding. This is a future enhancement, not required for v0.1.

### 8.2 Monolithic `AgentDataPlayground.tsx` Decomposition

**Risk**: The 1,586-line component has deeply intertwined state. Extracting sub-components could introduce regressions.

**Mitigation**:
- Phase 8 (UI extraction) is done **after** core is verified working (Phases 2-7).
- Sub-component extraction follows clear boundaries already visible in the source (each section is delimited by comment headers like `// --- Project card --`).
- The `MessageEntry` component (lines 275-846) is the largest sub-component but is already a standalone function component -- it can be moved verbatim.
- State management stays in `AgentDataPlayground.tsx`. Hooks are optional sugar extracted later. The first pass can keep all state in the top component and just import visual sub-components.
- The 3 Electron coupling points are isolated:
  - `window.desktopAPI.agentData` (line 936) -- replaced by `useSpaghettiAPI()` context.
  - `drag-region` divs (lines 1267, 1309) -- removed; host provides its own title bar.
  - `WebkitAppRegion` inline styles (lines 860, 867) -- removed from `DetailOverlay`; accept className prop instead.

### 8.3 Foundation Service Extraction

**Risk**: `FileService`, `SqliteService`, and `MessagePackService` are used extensively throughout vibe-ctl's other services (mesh, pty, store, etc.). Extracting them could break those imports.

**Mitigation**:
- **Copy, don't move** during extraction. The spaghetti package gets its own copies of these three files. vibe-ctl keeps its originals intact.
- The foundation services in vibe-ctl's `packages/desktop/src/main/services/foundation/io/` are **not deleted** from vibe-ctl. They continue to serve vibe-ctl's non-agent-data needs (mesh networking, pty, store sync, etc.).
- The only files removed from vibe-ctl are the agent-data-specific ones: `claude-code/` subtree, agent data handlers, and the playground component.
- This means there is temporary code duplication of the IO layer. If in the future vibe-ctl wants to use `@spaghetti/core`'s IO services for other purposes, it can, but that is a separate refactor.

### 8.4 Missing Tests

**Risk**: The agent data system currently has **zero tests** (the existing tests in `__tests__/` cover other services like claude-stats, claude-analytics, etc., not the segment-based data system).

**Mitigation**:
- Tests are written **during** extraction (Phases 3, 4, 5, 6) rather than after.
- Priority order for tests:
  1. `segment-store.test.ts` -- the data integrity layer (SQLite CRUD + FTS5) is the highest-value test.
  2. `file-service.test.ts` -- already exists in vibe-ctl, migrate it.
  3. `sqlite-service.test.ts` -- already exists in vibe-ctl, migrate it.
  4. `project-parser.test.ts` -- validates correct parsing of the `~/.claude/` directory structure.
  5. `agent-data-service.test.ts` -- integration test for the full pipeline.
- Each test phase is a build gate: don't proceed to the next phase until the current phase's tests pass.

### 8.5 Shared Type Duplication

**Risk**: The 16 type files are currently in `@claude-code-on-the-go/shared` and imported by multiple vibe-ctl packages. After extraction, there are two copies of these types.

**Mitigation**:
- In Phase 9, update vibe-ctl's `@claude-code-on-the-go/shared` to re-export from `@spaghetti/core/types` instead of maintaining its own copy. This is a one-line change per re-export:
  ```typescript
  // packages/shared/src/agent/claude-code/index.ts
  export * from '@spaghetti/core/types';
  ```
- This eliminates duplication and makes `@spaghetti/core` the single source of truth for Claude Code data types.

### 8.6 DB Path Migration

**Risk**: Existing vibe-ctl users have a SQLite cache at `~/.claude-on-the-go/cache/agent-claude-code-segments.db`. The new default path is `~/.spaghetti/cache/segments.db`. Switching paths forces a cold start (full re-parse).

**Mitigation**:
- The `SpaghettiServiceOptions.dbPath` option allows overriding the default path.
- vibe-ctl's integration adapter can pass the old path to maintain backward compatibility:
  ```typescript
  createSpaghettiService({ dbPath: '~/.claude-on-the-go/cache/agent-claude-code-segments.db' });
  ```
- For fresh installs, the new default path is used.
- A cold start on a typical `~/.claude/` directory takes 2-5 seconds, so this is not a critical issue even if the path changes.
