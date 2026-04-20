/**
 * Factory — createSpaghettiService()
 *
 * Wires up all internal services and returns a SpaghettiAPI instance.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createFileService } from './io/file-service.js';
import { createSqliteService } from './io/sqlite-service.js';
import { createConsoleErrorSink, type ErrorSink } from './io/error-sink.js';
import { createSpaghettiAppService } from './app-service.js';
import { createClaudeCodeParser } from './parser/claude-code-parser.js';
import { createQueryService } from './data/query-service.js';
import { createIngestService } from './data/ingest-service.js';
import { createAgentDataStore } from './data/agent-data-store.js';
import { AgentDataServiceImpl } from './data/agent-data-service.js';
import { createLiveUpdates } from './live/live-updates.js';
import { loadNativeAddon } from './native.js';
import { resolveEngine } from './settings.js';
import type { SpaghettiAPI } from './api.js';
import type { ClaudeCodeAgentDataService, AgentDataServiceOptions } from './data/agent-data-service.js';
import type { IngestEngine } from './settings.js';

export interface SpaghettiServiceOptions {
  /** Override the data service implementation (for testing or custom setups) */
  dataService?: ClaudeCodeAgentDataService;
  /** Override the default DB path */
  dbPath?: string;
  /** Override the Claude data directory (defaults to ~/.claude) */
  claudeDir?: string;
  /**
   * Pin the ingest engine for this service. When set, takes precedence
   * over the process-wide `SPAG_ENGINE` env var and the persisted
   * `~/.spaghetti/config.json` engine setting — useful when an app wants
   * to carry its own engine preference independent of the shared
   * user-level config.
   */
  engine?: IngestEngine;
  /**
   * Opt in to the RFC 005 live-updates pipeline. When `true`,
   * `initialize()` starts a filesystem watcher on
   * `<claudeDir>/projects/` and `<claudeDir>/todos/` that keeps SQLite
   * warm as Claude Code writes files.
   *
   * Defaults to `false`: CLI one-shots and cold-start-only consumers
   * pay zero watcher/queue/parser overhead. Phase 2 updates SQLite but
   * does not yet emit typed `Change` events to subscribers — that
   * lands in Phase 3 via `api.live`.
   */
  live?: boolean;
  /**
   * Override the unified error sink (RFC 005). Every internal live
   * component — `LiveUpdates`, `IdleMaintenance`, `SubscriberRegistry`,
   * the `events()` `onDrop` swallow — routes through this sink so
   * callers can install one telemetry pipe without threading multiple
   * callbacks. Defaults to a console.warn variant prefixed with
   * `[spaghetti-sdk]`.
   */
  errorSink?: ErrorSink;
}

/**
 * Create a fully wired SpaghettiAPI instance.
 *
 * Usage:
 *   import { createSpaghettiService } from '@vibecook/spaghetti-sdk';
 *
 *   const spaghetti = createSpaghettiService();
 *   await spaghetti.initialize();
 *   const projects = spaghetti.getProjectList();
 */
export function createSpaghettiService(options?: SpaghettiServiceOptions): SpaghettiAPI {
  // Unified error sink (RFC 005). Defaults to console.warn with the
  // `[spaghetti-sdk]` prefix the four pre-extraction sites used to
  // print on their own; callers can swap in their own telemetry pipe
  // by passing `options.errorSink`.
  const errorSink = options?.errorSink ?? createConsoleErrorSink('[spaghetti-sdk]');

  if (options?.dataService) {
    return createSpaghettiAppService(options.dataService, errorSink);
  }

  // Default wiring: create all services from scratch
  const fileService = createFileService();
  // CRITICAL: Share a single SqliteService instance between query and ingest
  // services to prevent SQLITE_BUSY errors. Two separate connections to the
  // same DB can conflict when ingestService holds an open transaction.
  const sharedSqlite = createSqliteService();
  const sqliteFactory = () => sharedSqlite;
  const queryService = createQueryService(sqliteFactory);
  // RFC 005 C4.3: thread the resolved engine + native addon into the
  // ingest service so its live-updates `writeBatch` can route through
  // `liveIngestBatch` when the service is pinned to `engine='rs'`.
  // Explicit `options.engine` wins over env + persisted config, mirroring
  // `LifecycleOwner`'s own resolution order.
  const resolvedEngine = options?.engine ?? resolveEngine();
  const nativeAddon = resolvedEngine === 'rs' ? loadNativeAddon() : null;
  const ingestService = createIngestService(sqliteFactory, {
    engine: resolvedEngine,
    native: nativeAddon,
  });
  const parser = createClaudeCodeParser(fileService);
  // RFC 005 Phase 1: the store owns read delegations + config/analytics
  // caches. The service still owns lifecycle (cold/warm start, engine
  // selection, progress events). Sharing the same `QueryService` keeps
  // a single SQLite connection, matching the comment above.
  //
  // TODO(RFC 005 phase 2): the design doc §1 has the store compose its
  // own `QueryService` once the store owns `open()`/`close()`. Today we
  // pass the same instance into both `ingestService` and the store so
  // all writers + readers share one SQLite connection.
  const store = createAgentDataStore(queryService, { errorSink });

  const dataServiceOptions: AgentDataServiceOptions = {};
  if (options?.dbPath) dataServiceOptions.dbPath = options.dbPath;
  if (options?.claudeDir) dataServiceOptions.claudeDir = options.claudeDir;
  if (options?.engine) dataServiceOptions.engine = options.engine;

  // RFC 005 C2.7: construct the live-updates orchestrator only when the
  // caller opted in. When `options.live` is falsy we pass `undefined` so
  // `LifecycleOwner.initialize()` / `shutdown()` skip the start/stop
  // calls entirely — no watcher, no checkpoint persistence, no writer
  // loop. The `claudeDir` fallback mirrors `LifecycleOwner`'s own
  // resolution so both sides agree on the watched root.
  const resolvedClaudeDir = options?.claudeDir ?? path.join(os.homedir(), '.claude');
  // Resolve dbPath the same way AgentDataServiceImpl does so
  // LiveUpdates' idle-maintenance loop operates on the exact file the
  // writer loop is committing to. Kept in sync with
  // `AgentDataServiceImpl`'s own default resolution.
  const resolvedDbPath = options?.dbPath ?? path.join(os.homedir(), '.spaghetti', 'cache.db');
  const liveUpdates = options?.live
    ? createLiveUpdates(
        {
          fileService,
          ingestService,
          store,
          // RFC 005 C5.1: hand the shared SqliteService + dbPath to
          // LiveUpdates so it can run idle WAL + FTS maintenance.
          sqlite: sharedSqlite,
          dbPath: resolvedDbPath,
        },
        {
          claudeDir: resolvedClaudeDir,
          // RFC 005: route every internal LiveUpdates error through
          // the shared sink so log scrapers + telemetry pipes see one
          // consistent surface across watcher / writer / settings /
          // scope-attacher / idle-maintenance.
          errorSink,
        },
      )
    : undefined;

  // C3.2: hand the store reference to LiveUpdates so the writer loop
  // can emit through the canonical subscriber registry. Safe to call
  // before `start()` — `attachStore` just retains the reference; the
  // writer loop doesn't exist yet.
  if (liveUpdates) liveUpdates.attachStore(store);

  const dataService = new AgentDataServiceImpl(
    fileService,
    parser,
    queryService,
    ingestService,
    store,
    dataServiceOptions,
    liveUpdates,
  );

  return createSpaghettiAppService(dataService, errorSink);
}

// Re-export the service factories for manual wiring
export { createFileService } from './io/file-service.js';
export { createSqliteService } from './io/sqlite-service.js';
export { createSpaghettiAppService } from './app-service.js';
