/**
 * @vibecook/spaghetti-sdk — Standalone library for browsing and analyzing Claude Code agent data
 */

// Types
export * from './types/index.js';

// I/O services
export * from './io/index.js';

// Parsers
export * from './parser/index.js';

// Data layer (segments, search, summaries)
export * from './data/segment-types.js';
export * from './data/summary-types.js';
export { createSearchIndexer, type SearchIndexer, type SearchIndexEntry } from './data/search-indexer.js';
export { createSegmentStore, type SegmentStore } from './data/segment-store.js';
export {
  type ClaudeCodeAgentDataService,
  AgentDataServiceImpl,
  type AgentDataServiceOptions,
} from './data/agent-data-service.js';

// Schema
export { SCHEMA_VERSION, initializeSchema } from './data/schema.js';

// Query & Ingest services
export { createQueryService, type QueryService } from './data/query-service.js';
export { createIngestService, type IngestService } from './data/ingest-service.js';

// Workers
export {
  type WorkerPool,
  type WorkerPoolOptions,
  type WorkerToMainMessage,
  type MainToWorkerMessage,
  createWorkerPool,
  isWorkerThreadsAvailable,
} from './workers/index.js';

// API
export * from './api.js';

// Factory
export { createSpaghettiService, type SpaghettiServiceOptions } from './create.js';
export { createSpaghettiAppService } from './app-service.js';

// Native addon bridge (RFC 003)
export { loadNativeAddon, isNativeIngestEnabled, type NativeAddon } from './native.js';

// Settings (engine selection, etc.)
export {
  type IngestEngine,
  type SpaghettiSettings,
  readSettings,
  writeSettings,
  resolveEngine,
  defaultDbPathForEngine,
  settingsPath,
} from './settings.js';

// Live updates (RFC 005 Phase 3) — public surface + event types.
export type { SpaghettiLive } from './live/spaghetti-live.js';
export type { Change, ChangeType, ChangeTopic, SubscribeOptions, Dispose } from './live/change-events.js';
export {
  isSessionMessageAdded,
  isSessionCreated,
  isSessionRewritten,
  isSubagentUpdated,
  isToolResultAdded,
  isFileHistoryAdded,
  isTodoUpdated,
  isTaskUpdated,
  isPlanUpserted,
  isSettingsChanged,
} from './live/change-events.js';
