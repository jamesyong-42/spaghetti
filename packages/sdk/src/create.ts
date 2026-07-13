/**
 * Factory — createSpaghettiService()
 *
 * Wires AgentSource → DurableStore → StaticIngest / LiveDiskIngest → SpaghettiAPI.
 * See `docs/THREE-PLANE-INGEST-ARCHITECTURE.md` and `docs/PR-PLAN-THREE-PLANE-SHAPE.md`.
 */

import { createFileService } from './io/file-service.js';
import { createSqliteService } from './io/sqlite-service.js';
import { createConsoleErrorSink, type ErrorSink } from './io/error-sink.js';
import { createSpaghettiAppService } from './app-service.js';
import { createClaudeCodeParser } from './parser/claude-code-parser.js';
import { AgentDataServiceImpl } from './data/agent-data-service.js';
import type { ClaudeCodeAgentDataService } from './data/agent-data-service.js';
import { SpaghettiDataService } from './data/multi-source-service.js';
import { loadNativeAddon } from './native.js';
import { defaultDbPathForEngine, resolveEngine, type IngestEngine } from './settings.js';
import type { SpaghettiAPI } from './api.js';
import { createClaudeCodeSource, type AgentSource } from './sources/index.js';
import { createDurableStore } from './store/durable-store.js';
import { toLifecycleOptions } from './planes/static-ingest.js';
import { createLiveDiskIngest } from './planes/live-disk-ingest.js';
import { createRuntimeBridge } from './planes/runtime-bridge.js';

export interface SpaghettiServiceOptions {
  /** Override the data service implementation (for testing or custom setups) */
  dataService?: ClaudeCodeAgentDataService;
  /** Override the default DB path */
  dbPath?: string;
  /**
   * Override the Claude data directory (defaults to ~/.claude).
   * Ignored when {@link source} is provided.
   */
  claudeDir?: string;
  /**
   * Explicit agent source adapter. Defaults to Claude Code using
   * `claudeDir` (or `~/.claude`) as the root.
   */
  source?: AgentSource;
  /**
   * Pin the ingest engine for this service. When set, takes precedence
   * over the process-wide `SPAG_ENGINE` env var and the persisted
   * `~/.spaghetti/config.json` engine setting — useful when an app wants
   * to carry its own engine preference independent of the shared
   * user-level config.
   */
  engine?: IngestEngine;
  /**
   * Opt in to Plane 2 (live disk ingest). When `true`, `initialize()`
   * starts the filesystem watcher pipeline on the agent source root
   * and exposes `api.live`.
   *
   * Defaults to `false`: CLI one-shots and cold-start-only consumers
   * pay zero watcher/queue/parser overhead.
   */
  live?: boolean;
  /**
   * Override the unified error sink (RFC 005). Every internal live
   * component routes through this sink. Defaults to a console.warn
   * variant prefixed with `[spaghetti-sdk]`.
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
  const errorSink = options?.errorSink ?? createConsoleErrorSink('[spaghetti-sdk]');

  if (options?.dataService) {
    return createSpaghettiAppService(options.dataService, errorSink);
  }

  // ── AgentSource (claude-code today) ────────────────────────────────────
  const source =
    options?.source ??
    createClaudeCodeSource({
      rootDir: options?.claudeDir,
    });

  // ── Shared I/O ─────────────────────────────────────────────────────────
  const fileService = createFileService();
  // CRITICAL: Share a single SqliteService between query and ingest
  // to prevent SQLITE_BUSY. Two connections to the same DB conflict
  // when ingest holds an open transaction.
  const sharedSqlite = createSqliteService();

  const resolvedEngine = options?.engine ?? resolveEngine();
  const nativeAddon = resolvedEngine === 'rs' ? loadNativeAddon() : null;

  // ── DurableStore (SQLite + FTS) ────────────────────────────────────────
  const store = createDurableStore({
    sqlite: sharedSqlite,
    errorSink,
    engine: resolvedEngine,
    native: nativeAddon,
  });

  // Align StaticIngest + LiveDiskIngest on the same DB file (was a bug:
  // live defaulted to ~/.spaghetti/cache.db while lifecycle used
  // spaghetti-{rs,ts}.db).
  const dbPath = options?.dbPath ?? defaultDbPathForEngine(resolvedEngine);

  // ── Plane 2: LiveDiskIngest (opt-in) ───────────────────────────────────
  const liveDisk = options?.live
    ? createLiveDiskIngest({
        source,
        store,
        fileService,
        dbPath,
        errorSink,
      })
    : undefined;

  // ── Plane 1: StaticIngest — one LifecycleOwner per source ──────────────
  const parser = createClaudeCodeParser(fileService);
  const claudeOwner = new AgentDataServiceImpl(
    fileService,
    parser,
    store.query,
    store.ingest,
    store.data,
    toLifecycleOptions({
      source,
      engine: options?.engine,
      dbPath,
    }),
    liveDisk,
  );

  // The app's data service: reads from the shared store, lifecycle fanned
  // across owners. Single source today; a second owner (Codex) plugs in here.
  const dataService = new SpaghettiDataService(store.data, [claudeOwner]);

  // Plane 3: RuntimeBridge — always attached on the default factory path.
  // Watchers start lazily on first api.runtime subscribe.
  const runtimeBridge = createRuntimeBridge(source, { errorSink });

  return createSpaghettiAppService(dataService, errorSink, runtimeBridge);
}

// Re-export the service factories for manual wiring
export { createFileService } from './io/file-service.js';
export { createSqliteService } from './io/sqlite-service.js';
export { createSpaghettiAppService } from './app-service.js';
