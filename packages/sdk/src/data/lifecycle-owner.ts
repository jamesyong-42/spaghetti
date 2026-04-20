/**
 * LifecycleOwner — Interface + lifecycle-owning implementation.
 *
 * Formerly `AgentDataServiceImpl` in `agent-data-service.ts`. The class
 * is renamed to clarify responsibility (cold/warm start, engine
 * selection, progress events, start/stop of the live subsystem); all
 * read methods now delegate to `AgentDataStore`. The old public name
 * `AgentDataServiceImpl` (and the `ClaudeCodeAgentDataService`
 * interface) are re-exported verbatim from `./agent-data-service.ts`
 * so no consumer needs to change its imports — see RFC 005 / Phase 1.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'events';
import type {
  SegmentType,
  SegmentKey,
  Segment,
  SegmentChangeBatch,
  InitProgress,
  PaginatedSegmentQuery,
  PaginatedSegmentResult,
  SearchQuery,
  SearchResultSet,
  StoreStats,
} from './segment-types.js';
import type { SessionSummaryData, ProjectSummaryData } from './summary-types.js';
import type {
  Project,
  Session,
  SessionMessage,
  AgentConfig,
  AgentAnalytic,
  SessionsIndex,
  SessionIndexEntry,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
} from '../types/index.js';
import type { QueryService } from './query-service.js';
import type { IngestService } from './ingest-service.js';
import type { AgentDataStore } from './agent-data-store.js';
import type { ClaudeCodeParser } from '../parser/claude-code-parser.js';
import type { FileService } from '../io/index.js';
import type { LiveUpdates } from '../live/live-updates.js';
import { createWorkerPool, isWorkerThreadsAvailable, type WorkerToMainMessage } from '../workers/index.js';
import { loadNativeAddon } from '../native.js';
import { defaultDbPathForEngine, resolveEngine, type IngestEngine } from '../settings.js';

// Re-export types used by app-service
export {
  type SegmentType,
  type SegmentKey,
  type Segment,
  type SegmentChangeBatch,
  type InitProgress,
  type PaginatedSegmentQuery,
  type PaginatedSegmentResult,
  type SearchQuery,
  type SearchResultSet,
  type StoreStats,
  segmentKey,
  parseSegmentKey,
} from './segment-types.js';

export type { SearchIndexEntry } from './search-indexer.js';
export { type SearchIndexer, createSearchIndexer } from './search-indexer.js';
export type { SegmentStore } from './segment-store.js';
export { createSegmentStore } from './segment-store.js';
export type { TokenUsageSummary, SessionSummaryData, ProjectSummaryData } from './summary-types.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeAgentDataService extends EventEmitter {
  initialize(): Promise<void>;
  shutdown(): void;
  /** Force a full cold rebuild — wipes the DB file and re-ingests. */
  rebuildIndex(): Promise<{ durationMs: number }>;
  isReady(): boolean;

  getSegment<T>(key: SegmentKey): Segment<T> | null;
  getSegmentsByType<T>(type: SegmentType): Segment<T>[];
  getSegmentsPaginated<T>(query: PaginatedSegmentQuery): PaginatedSegmentResult<T>;

  getProjectSlugs(): string[];
  getProject(slug: string): Segment<Project> | null;
  getProjectSessions(slug: string): Segment<Session>[];
  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage>;
  getConfig(): AgentConfig;
  getAnalytics(): AgentAnalytic;

  getProjectSummaries(): ProjectSummaryData[];
  getSessionSummaries(projectSlug: string): SessionSummaryData[];

  getProjectMemory(slug: string): string | null;
  getSessionTodos(slug: string, sessionId: string): unknown[];
  getSessionPlan(slug: string, sessionId: string): unknown | null;
  getSessionTask(slug: string, sessionId: string): unknown | null;
  getPersistedToolResult(slug: string, sessionId: string, toolUseId: string): string | null;
  getSessionSubagents(
    slug: string,
    sessionId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }>;
  getSubagentMessages(
    slug: string,
    sessionId: string,
    agentId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage>;

  search(query: SearchQuery): SearchResultSet;
  rebuild(): Promise<void>;
  getStoreStats(): StoreStats;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentDataServiceOptions {
  dbPath?: string;
  claudeDir?: string;
  /**
   * Ingest engine to use for this service. When set, takes precedence over
   * the process-wide `SPAG_ENGINE` env var and the persisted
   * `~/.spaghetti/config.json` engine setting — useful for apps that want
   * to carry their own engine preference without touching the shared
   * user-level config.
   */
  engine?: IngestEngine;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT DB PATH
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultDbPath(engine: IngestEngine): string {
  // Each ingest engine keeps its own DB file so switching engines
  // doesn't force a re-ingest, and results are comparable side-by-side.
  return defaultDbPathForEngine(engine);
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

export class LifecycleOwner extends EventEmitter implements ClaudeCodeAgentDataService {
  private fileService: FileService;
  private parser: ClaudeCodeParser;
  private queryService: QueryService;
  private ingestService: IngestService;
  private store: AgentDataStore;
  private options: AgentDataServiceOptions;
  /**
   * RFC 005 C2.7: the live-updates orchestrator, composed in `create.ts`
   * only when the caller opted in via `SpaghettiServiceOptions.live`.
   * `undefined` means "no live pipeline" — `initialize()` / `shutdown()`
   * skip the start/stop calls and the service behaves identically to
   * the pre-RFC-005 build.
   */
  private liveUpdates: LiveUpdates | undefined;

  private ready = false;
  private dbPath: string;
  private claudeDir: string;
  /**
   * Engine selected for this service instance — explicit option if the
   * caller provided one, otherwise the resolution chain in
   * [`resolveEngine`](../settings.ts) (env vars → persisted config →
   * default `rs`). Fixed at construction time so every `initialize()` and
   * `rebuildIndex()` on this instance picks the same path.
   */
  private engine: IngestEngine;

  constructor(
    fileService: FileService,
    parser: ClaudeCodeParser,
    queryService: QueryService,
    ingestService: IngestService,
    store: AgentDataStore,
    options?: AgentDataServiceOptions,
    liveUpdates?: LiveUpdates,
  ) {
    super();
    this.fileService = fileService;
    this.parser = parser;
    this.queryService = queryService;
    this.ingestService = ingestService;
    this.store = store;
    this.options = options ?? {};
    this.liveUpdates = liveUpdates;
    this.engine = this.options.engine ?? resolveEngine();
    this.dbPath = this.options.dbPath ?? getDefaultDbPath(this.engine);
    this.claudeDir = this.options.claudeDir ?? path.join(os.homedir(), '.claude');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const startTime = Date.now();

    try {
      // Ensure the DB directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Use the Rust ingest core when this instance is configured for the
      // `rs` engine and the native addon loads; fall back to the TS path
      // otherwise. The engine is fixed in the constructor (explicit option
      // wins over env vars and the persisted config file), so `initialize()`
      // and `rebuildIndex()` on the same instance always take the same path.
      const native = this.engine === 'rs' ? loadNativeAddon() : null;

      if (native) {
        await this.initializeWithNative(native);
      } else {
        await this.initializeWithTypeScript();
      }

      // Parse config and analytics (small data, always sync — not covered
      // by the native ingest yet).
      this.emitProgress('parsing', 'Parsing config and analytics...');
      const fullData = this.parser.parseSync({
        claudeDir: this.claudeDir,
        skipProjects: true,
        skipSessionMessages: true,
      });
      this.store.setConfig(fullData.config);
      this.store.setAnalytics(fullData.analytics);

      // RFC 005 C2.7: with the SQLite baseline caught up, spin up the
      // live-updates pipeline so subsequent filesystem activity keeps
      // the DB warm. A failure here is non-fatal for reads — the store
      // is already populated; we surface the error via the service's
      // event emitter and continue.
      if (this.liveUpdates) {
        try {
          await this.liveUpdates.start();
        } catch (err) {
          this.emit('error', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      this.ready = true;
      const durationMs = Date.now() - startTime;
      this.emit('ready', { durationMs });
    } catch (error) {
      this.emit('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Native-ingest path: delegate the heavy lifting to `@vibecook/spaghetti-sdk-native`.
   *
   * The native addon runs the full cold/warm ingest in Rust on its own
   * write connection, then closes cleanly. We open read + write services
   * against the same DB file afterwards for subsequent queries and any
   * live update writes (hooks, channel messages, etc.).
   *
   * We always pass `mode: 'warm'` — the Rust orchestrator self-detects
   * a missing/empty DB and falls through to a full cold ingest, so
   * callers don't have to pre-check.
   */
  private async initializeWithNative(native: NonNullable<ReturnType<typeof loadNativeAddon>>): Promise<void> {
    this.emitProgress('parsing', `Running native ingest (${native.nativeVersion()})...`);

    await native.ingest(
      {
        claudeDir: this.claudeDir,
        dbPath: this.dbPath,
        mode: 'warm',
      },
      (progress) => {
        // Map native phases to the SDK's user-facing progress events.
        // 'parsing' ticks per-project-complete so the UI shows steady
        // movement (e.g. "Parsing project 12/112...").
        switch (progress.phase) {
          case 'scanning':
            this.emitProgress(
              'parsing',
              `Scanning ${progress.projectsTotal} projects...`,
              progress.projectsDone,
              progress.projectsTotal,
            );
            break;
          case 'parsing':
            this.emitProgress(
              'parsing',
              `Parsing projects... ${progress.projectsDone}/${progress.projectsTotal}`,
              progress.projectsDone,
              progress.projectsTotal,
            );
            break;
          case 'finalizing':
            this.emitProgress('storing', 'Writing fingerprints...', progress.projectsDone, progress.projectsTotal);
            break;
        }
      },
    );

    // Open both services against the (now-populated) DB. The ingest
    // service stays open for post-init writes like hook-event appends;
    // the query service serves reads.
    this.queryService.open(this.dbPath);
    this.ingestService.open(this.dbPath);
  }

  /**
   * Fallback TS-ingest path. Used when the native addon isn't installed
   * or when `SPAG_NATIVE_INGEST=0`.
   */
  private async initializeWithTypeScript(): Promise<void> {
    this.emitProgress('parsing', 'Opening database...');
    this.queryService.open(this.dbPath);
    this.ingestService.open(this.dbPath);

    const fingerprints = this.ingestService.getAllFingerprints();
    const isColdStart = fingerprints.length === 0;

    if (isColdStart) {
      await this.performColdStart();
    } else {
      await this.performWarmStart(fingerprints);
    }
  }

  /**
   * Force a full cold rebuild of the index.
   *
   * Closes any open write connection, deletes the SQLite file, then
   * re-ingests from scratch. Callable from the UI (e.g. a "rebuild
   * index" command) when the user suspects their DB is out of sync
   * with `~/.claude` — or when a schema bump requires a clean slate.
   *
   * Uses the native path when available; falls back to deleting + re-
   * invoking the TS ingest otherwise.
   */
  async rebuildIndex(): Promise<{ durationMs: number }> {
    const start = Date.now();

    // Close any open connections so we can safely delete the file.
    this.queryService.close();
    this.ingestService.close();
    this.ready = false;

    // Delete the DB and its WAL side-files.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = this.dbPath + suffix;
      if (existsSync(p)) {
        try {
          // Use rmSync via require('fs') to avoid adding a new top-level import.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('node:fs') as typeof import('node:fs');
          fs.rmSync(p, { force: true });
        } catch {
          // Best-effort: if we can't remove a leftover side-file, ingest
          // will still succeed against the main file.
        }
      }
    }

    // Re-initialize from scratch.
    await this.initialize();

    return { durationMs: Date.now() - start };
  }

  private async performColdStart(): Promise<void> {
    // Discover project slugs to decide on parallel vs sequential
    const slugs = this.discoverProjectSlugs();

    // Enable bulk ingest optimizations: disable FTS triggers and use
    // aggressive SQLite PRAGMAs for maximum write throughput.
    this.ingestService.beginBulkIngest();

    try {
      if (slugs.length >= 4 && isWorkerThreadsAvailable()) {
        try {
          await this.coldStartParallel(slugs);
        } catch {
          // Worker threads may fail in bundled environments (e.g., tsup inlines
          // the worker script as a data URL which isn't a valid worker path).
          // Fall back to sequential parsing gracefully.
          this.emitProgress('parsing', 'Workers unavailable, falling back to sequential...');
          await this.coldStartSequential();
        }
      } else {
        await this.coldStartSequential();
      }
    } finally {
      // Restore FTS triggers, rebuild FTS index, restore safe PRAGMAs
      this.ingestService.endBulkIngest();
    }

    // Save fingerprints for all session JSONL files we can find
    this.emitProgress('storing', 'Saving file fingerprints...');
    this.saveAllFingerprints();

    this.emitProgress('indexing', 'Cold start complete.');
  }

  private async coldStartSequential(): Promise<void> {
    // Discover slugs to report progress count
    const slugs = this.discoverProjectSlugs();
    const totalProjects = slugs.length;

    this.emitProgress('parsing', `Parsing ${totalProjects} projects...`, 0, totalProjects);

    // Parse project by project, yielding the event loop between each so
    // consumers (e.g. Ink TUI) can re-render progress updates.
    // Previously this was a single blocking parseStreaming() call that
    // starved the event loop for the entire duration.
    this.ingestService.beginTransaction();
    try {
      for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        this.parser.parseProjectStreaming(this.claudeDir, slug, this.ingestService);
        this.ingestService.onProjectComplete(slug);
        this.emitProgress('parsing', `Parsed ${slug}`, i + 1, totalProjects);

        // Yield to the event loop so UI can render progress updates
        if (i < slugs.length - 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    }
  }

  private async coldStartParallel(slugs: string[]): Promise<void> {
    let completedProjects = 0;
    const totalProjects = slugs.length;
    this.emitProgress('parsing', `Parsing ${totalProjects} projects...`, 0, totalProjects);

    const pool = createWorkerPool();

    this.ingestService.beginTransaction();

    try {
      await pool.parseProjects(this.claudeDir, slugs, (msg: WorkerToMainMessage) => {
        // Route each message type to the appropriate IngestService method.
        // Workers send pre-serialized JSON strings — we parse them on the main thread
        // and call the existing sink methods to reuse all extraction logic.
        switch (msg.type) {
          case 'project-result': {
            const sessionsIndex = JSON.parse(msg.sessionsIndexJson) as SessionsIndex;
            this.ingestService.onProject(msg.slug, msg.originalPath, sessionsIndex);
            break;
          }
          case 'project-memory': {
            this.ingestService.onProjectMemory(msg.slug, msg.content);
            break;
          }
          case 'session-result': {
            const entry = JSON.parse(msg.indexEntryJson) as SessionIndexEntry;
            this.ingestService.onSession(msg.slug, entry);
            break;
          }
          case 'message-batch': {
            // Each message in the batch is a JSON string — parse and insert
            for (let i = 0; i < msg.messages.length; i++) {
              const message = JSON.parse(msg.messages[i]) as SessionMessage;
              const index = msg.startIndex + i;
              const byteOffset = msg.byteOffsets[i];
              this.ingestService.onMessage(msg.slug, msg.sessionId, message, index, byteOffset);
            }
            break;
          }
          case 'subagent-result': {
            const messages = JSON.parse(msg.messagesJson) as SessionMessage[];
            const transcript: SubagentTranscript = {
              agentId: msg.agentId,
              agentType: msg.agentType as SubagentTranscript['agentType'],
              fileName: msg.fileName,
              messages,
            };
            this.ingestService.onSubagent(msg.slug, msg.sessionId, transcript);
            break;
          }
          case 'tool-result': {
            const toolResult: PersistedToolResult = {
              toolUseId: msg.toolUseId,
              content: msg.content,
            };
            this.ingestService.onToolResult(msg.slug, msg.sessionId, toolResult);
            break;
          }
          case 'file-history': {
            const history = JSON.parse(msg.dataJson) as FileHistorySession;
            this.ingestService.onFileHistory(msg.sessionId, history);
            break;
          }
          case 'todo-result': {
            const items = JSON.parse(msg.itemsJson) as TodoFile['items'];
            const todo: TodoFile = {
              sessionId: msg.sessionId,
              agentId: msg.agentId,
              items,
            };
            this.ingestService.onTodo(msg.sessionId, todo);
            break;
          }
          case 'task-result': {
            const task = JSON.parse(msg.taskJson) as TaskEntry;
            this.ingestService.onTask(msg.sessionId, task);
            break;
          }
          case 'plan-result': {
            const plan: PlanFile = {
              slug: msg.slug,
              title: msg.title,
              content: msg.content,
              size: msg.size,
            };
            this.ingestService.onPlan(msg.slug, plan);
            break;
          }
          case 'session-complete': {
            this.ingestService.onSessionComplete(msg.slug, msg.sessionId, msg.messageCount, msg.lastBytePosition);
            break;
          }
          case 'project-complete': {
            this.ingestService.onProjectComplete(msg.slug);
            completedProjects++;
            this.emitProgress('parsing', `Parsed ${msg.slug}`, completedProjects, totalProjects);
            break;
          }
          case 'worker-error': {
            console.error(`[cold-start] Worker error for project "${msg.slug}": ${msg.error}`);
            break;
          }
        }
      });

      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    } finally {
      pool.shutdown();
    }
  }

  /**
   * Discover all project slugs from the claude directory.
   */
  private discoverProjectSlugs(): string[] {
    const projectsDir = path.join(this.claudeDir, 'projects');
    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true,
      });
      return projectPaths.map((p) => path.basename(p));
    } catch {
      return [];
    }
  }

  private async performWarmStart(
    existingFingerprints: Array<{ path: string; mtimeMs: number; size: number; bytePosition?: number }>,
  ): Promise<void> {
    this.emitProgress('reconciling', 'Warm start: checking for changes...');

    // Build a lookup map from path → fingerprint for efficient access
    const fpMap = new Map<string, { path: string; mtimeMs: number; size: number; bytePosition?: number }>();
    for (const fp of existingFingerprints) {
      fpMap.set(fp.path, fp);
    }

    // Check which files have changed since last parse
    // Skip recovery:// fingerprints — those track imported legacy data
    const changedFiles: string[] = [];
    const removedFiles: string[] = [];
    // Track JSONL files that only grew (appended) — eligible for incremental parse
    const grownFiles: Array<{ path: string; oldSize: number; oldBytePosition: number }> = [];

    for (const fp of existingFingerprints) {
      if (fp.path.startsWith('recovery://')) continue;
      const stats = this.fileService.getStats(fp.path);
      if (!stats) {
        removedFiles.push(fp.path);
      } else if (stats.mtimeMs !== fp.mtimeMs || stats.size !== fp.size) {
        // Detect append-only growth: mtime changed, size grew, and we have a byte position
        if (
          fp.path.endsWith('.jsonl') &&
          stats.size > fp.size &&
          fp.bytePosition !== undefined &&
          fp.bytePosition > 0
        ) {
          grownFiles.push({ path: fp.path, oldSize: fp.size, oldBytePosition: fp.bytePosition });
        } else {
          changedFiles.push(fp.path);
        }
      }
    }

    // Also detect new JSONL files on disk that we don't have fingerprints for
    const newFiles: string[] = [];
    const projectsDir = path.join(this.claudeDir, 'projects');
    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, { includeDirectories: true });
      for (const projectPath of projectPaths) {
        try {
          const files = this.fileService.scanDirectorySync(projectPath, { pattern: '*.jsonl' });
          for (const filePath of files) {
            if (!fpMap.has(filePath)) {
              newFiles.push(filePath);
            }
          }
        } catch {
          // skip bad project directory
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    // Recovery check: detect projects that have sessions in the DB but 0
    // messages.  This happens when a previous cold start silently failed
    // to parse JSONL files (e.g. stale sessions-index.json).  If we find
    // any, force a full re-parse to recover the lost data.
    let needsRecovery = false;
    const hasNoChanges =
      changedFiles.length === 0 && removedFiles.length === 0 && grownFiles.length === 0 && newFiles.length === 0;
    if (hasNoChanges) {
      needsRecovery = this.hasProjectsWithMissingMessages();
      if (!needsRecovery) {
        this.emitProgress('reconciling', 'No changes detected, using cached data.');
        return;
      }
      this.emitProgress('reconciling', 'Detected projects with 0 messages — triggering recovery re-parse...');
    }

    if (needsRecovery) {
      // Full re-parse needed for recovery
      await this.warmStartFullReparse('Recovery re-parse: fixing projects with missing messages...');
      return;
    }

    // If only JSONL files grew (most common warm-start scenario: active session
    // appended new messages), do incremental parsing instead of full re-parse.
    // We also handle new files by doing a full parse of just those sessions.
    if (changedFiles.length === 0 && removedFiles.length === 0) {
      // Only grown + new files — incremental warm start
      const totalFiles = grownFiles.length + newFiles.length;
      this.emitProgress(
        'parsing',
        `Incremental update: ${grownFiles.length} grown, ${newFiles.length} new files...`,
        0,
        totalFiles,
      );

      this.ingestService.beginTransaction();
      try {
        let processed = 0;

        // Incrementally parse appended data from grown files
        for (const gf of grownFiles) {
          this.incrementalParseJsonl(gf.path, gf.oldBytePosition);
          processed++;
          this.emitProgress('parsing', `Incremental: ${path.basename(gf.path)}`, processed, totalFiles);
        }

        // Fully parse new files (these are sessions we haven't seen before)
        for (const filePath of newFiles) {
          this.fullParseNewJsonl(filePath);
          processed++;
          this.emitProgress('parsing', `New: ${path.basename(filePath)}`, processed, totalFiles);
        }

        this.ingestService.commitTransaction();
      } catch (error) {
        this.ingestService.rollbackTransaction();
        throw error;
      }

      // Update fingerprints for changed files
      this.saveAllFingerprints();
      this.emitProgress('indexing', 'Incremental warm start complete.');
      return;
    }

    // Files were modified in a non-append way or removed — determine which
    // projects are affected and only re-parse those.
    const affectedSlugs = this.getAffectedProjectSlugs(changedFiles, removedFiles);
    if (affectedSlugs.length === 0) {
      // Edge case: changed files couldn't be mapped to projects. Do full re-parse.
      await this.warmStartFullReparse(
        `Re-parsing: ${changedFiles.length} changed, ${removedFiles.length} removed files...`,
      );
      return;
    }

    this.emitProgress(
      'parsing',
      `Re-parsing ${affectedSlugs.length} affected projects (${changedFiles.length} changed, ${removedFiles.length} removed)...`,
    );

    this.ingestService.beginTransaction();
    try {
      for (let i = 0; i < affectedSlugs.length; i++) {
        const slug = affectedSlugs[i];
        this.parser.parseProjectStreaming(this.claudeDir, slug, this.ingestService);
        this.ingestService.onProjectComplete(slug);
        this.emitProgress('parsing', `Parsed ${slug}`, i + 1, affectedSlugs.length);

        if (i < affectedSlugs.length - 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      // Also handle grown/new files from other projects
      for (const gf of grownFiles) {
        this.incrementalParseJsonl(gf.path, gf.oldBytePosition);
      }
      for (const filePath of newFiles) {
        this.fullParseNewJsonl(filePath);
      }

      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    }

    this.saveAllFingerprints();
    this.emitProgress('indexing', 'Warm start complete.');
  }

  /**
   * Full re-parse of all projects — used as fallback for recovery or when
   * changes can't be handled incrementally. Uses parallel workers when available.
   */
  private async warmStartFullReparse(message: string): Promise<void> {
    this.emitProgress('parsing', message);

    const slugs = this.discoverProjectSlugs();
    const totalProjects = slugs.length;

    // Enable bulk ingest optimizations for full re-parse
    this.ingestService.beginBulkIngest();

    try {
      // Use parallel parsing for full re-parse when beneficial
      if (slugs.length >= 4 && isWorkerThreadsAvailable()) {
        try {
          await this.coldStartParallel(slugs);
          this.saveAllFingerprints();
          this.emitProgress('indexing', 'Warm start full re-parse complete.');
          return;
        } catch {
          this.emitProgress('parsing', 'Workers unavailable, falling back to sequential...');
        }
      }

      this.ingestService.beginTransaction();
      try {
        for (let i = 0; i < slugs.length; i++) {
          const slug = slugs[i];
          this.parser.parseProjectStreaming(this.claudeDir, slug, this.ingestService);
          this.ingestService.onProjectComplete(slug);
          this.emitProgress('parsing', `Parsed ${slug}`, i + 1, totalProjects);

          if (i < slugs.length - 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        this.ingestService.commitTransaction();
      } catch (error) {
        this.ingestService.rollbackTransaction();
        throw error;
      }
    } finally {
      this.ingestService.endBulkIngest();
    }

    this.saveAllFingerprints();
  }

  /**
   * Extract project slug and session ID from a JSONL file path.
   * Path format: <claudeDir>/projects/<slug>/<sessionId>.jsonl
   */
  private extractProjectInfo(filePath: string): { slug: string; sessionId: string } | null {
    const parts = filePath.split(path.sep);
    const fileName = parts[parts.length - 1];
    const slug = parts[parts.length - 2];
    const sessionId = fileName.replace('.jsonl', '');
    if (!slug || !sessionId) return null;
    return { slug, sessionId };
  }

  /**
   * Incrementally parse new lines appended to a JSONL file from a given byte position.
   */
  private incrementalParseJsonl(filePath: string, fromBytePosition: number): void {
    const info = this.extractProjectInfo(filePath);
    if (!info) return;
    const { slug, sessionId } = info;

    let messageCount = 0;
    try {
      this.fileService.readJsonlStreaming<SessionMessage>(
        filePath,
        (message, index, byteOffset) => {
          this.ingestService.onMessage(slug, sessionId, message, index, byteOffset);
          messageCount++;
        },
        { fromBytePosition },
      );
    } catch {
      // File read failed — skip
    }

    if (messageCount > 0) {
      // Update the session's byte position fingerprint
      const stats = this.fileService.getStats(filePath);
      if (stats) {
        this.ingestService.upsertFingerprint({
          path: filePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          bytePosition: stats.size,
        });
      }
    }
  }

  /**
   * Fully parse a new JSONL file that we haven't seen before.
   */
  private fullParseNewJsonl(filePath: string): void {
    const info = this.extractProjectInfo(filePath);
    if (!info) return;
    const { slug, sessionId } = info;

    let messageCount = 0;
    let lastBytePosition = 0;
    try {
      const streamResult = this.fileService.readJsonlStreaming<SessionMessage>(
        filePath,
        (message, index, byteOffset) => {
          this.ingestService.onMessage(slug, sessionId, message, index, byteOffset);
          messageCount++;
          lastBytePosition = byteOffset;
        },
      );
      lastBytePosition = streamResult.finalBytePosition;
    } catch {
      // File read failed — skip
    }

    if (messageCount > 0) {
      this.ingestService.onSessionComplete(slug, sessionId, messageCount, lastBytePosition);
    }
  }

  /**
   * Determine which project slugs are affected by the changed/removed files.
   */
  private getAffectedProjectSlugs(changedFiles: string[], removedFiles: string[]): string[] {
    const affected = new Set<string>();
    const projectsDir = path.join(this.claudeDir, 'projects');

    for (const filePath of [...changedFiles, ...removedFiles]) {
      // Extract slug from path: <claudeDir>/projects/<slug>/...
      if (filePath.startsWith(projectsDir)) {
        const relative = filePath.substring(projectsDir.length + 1);
        const slug = relative.split(path.sep)[0];
        if (slug) affected.add(slug);
      }
    }

    return [...affected];
  }

  /**
   * Check whether any project in the DB has sessions but zero messages.
   * This indicates a previous cold start failed to parse JSONL files and
   * the data needs recovery.  We also verify that the project actually has
   * JSONL files on disk — projects with no JSONL files are legitimately
   * empty and don't need re-parsing.
   */
  private hasProjectsWithMissingMessages(): boolean {
    try {
      const summaries = this.store.getProjectSummaries();
      for (const summary of summaries) {
        if (summary.sessionCount > 0 && summary.messageCount === 0) {
          // Verify there are actually JSONL files on disk for this project
          const projectDir = path.join(this.claudeDir, 'projects', summary.slug);
          try {
            const files = this.fileService.scanDirectorySync(projectDir, { pattern: '*.jsonl' });
            if (files.length > 0) {
              return true;
            }
          } catch {
            // can't read project dir — skip
          }
        }
      }
    } catch {
      // query service not ready — skip
    }
    return false;
  }

  private saveAllFingerprints(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');

    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true,
      });

      for (const projectPath of projectPaths) {
        try {
          const files = this.fileService.scanDirectorySync(projectPath, { pattern: '*.jsonl' });
          for (const filePath of files) {
            const stats = this.fileService.getStats(filePath);
            if (stats) {
              // Save file size as bytePosition so incremental parsing can
              // resume from where we left off on the next warm start.
              this.ingestService.upsertFingerprint({
                path: filePath,
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                bytePosition: stats.size,
              });
            }
          }

          // Also fingerprint the sessions-index.json
          const indexPath = path.join(projectPath, 'sessions-index.json');
          const indexStats = this.fileService.getStats(indexPath);
          if (indexStats) {
            this.ingestService.upsertFingerprint({
              path: indexPath,
              mtimeMs: indexStats.mtimeMs,
              size: indexStats.size,
            });
          }
        } catch {
          // skip bad project directory
        }
      }
    } catch {
      // projects dir doesn't exist
    }
  }

  shutdown(): void {
    this.ready = false;
    // Config/analytics caches now live on `AgentDataStore`. The store
    // outlives `shutdown()` in the current wiring (both are owned by
    // the same lifecycle), so we let its cached snapshots remain — the
    // next `initialize()` will overwrite them via `setConfig/Analytics`.

    // RFC 005 C2.7: stop the live-updates pipeline BEFORE closing the
    // SQLite connections so no in-flight `writeBatch` hits a closed
    // handle. The service's `shutdown()` contract is sync, but the
    // orchestrator's `stop()` is async (watcher unsubscribe + writer-
    // loop drain + final checkpoint flush). We fire-and-forget here —
    // Phase 2 has no subscribers, no pending events observers beyond
    // our own internal writer loop, and the orchestrator detaches
    // watchers synchronously as the first step so no further work
    // enqueues after this call returns.
    //
    // TODO(RFC 005 phase 3): promote this to an awaitable shutdown so
    // external subscribers can flush cleanly. That requires broadening
    // the `ClaudeCodeAgentDataService` interface — out of scope here.
    if (this.liveUpdates) {
      try {
        void this.liveUpdates.stop();
      } catch {
        /* best-effort teardown */
      }
    }

    try {
      this.ingestService.close();
    } catch {
      /* ignore */
    }
    try {
      this.queryService.close();
    } catch {
      /* ignore */
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy segment methods (minimal implementations for backward compat)
  // ─────────────────────────────────────────────────────────────────────────

  getSegment<T>(_key: SegmentKey): Segment<T> | null {
    // Phase 3 no longer uses the generic segment abstraction.
    // Return null — callers should migrate to dedicated methods.
    return null;
  }

  getSegmentsByType<T>(_type: SegmentType): Segment<T>[] {
    return [];
  }

  getSegmentsPaginated<T>(query: PaginatedSegmentQuery): PaginatedSegmentResult<T> {
    return { segments: [], total: 0, offset: query.offset, hasMore: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Project queries (delegate to AgentDataStore)
  // ─────────────────────────────────────────────────────────────────────────

  getProjectSlugs(): string[] {
    return this.store.getProjectSlugs();
  }

  getProject(_slug: string): Segment<Project> | null {
    // Legacy segment-based project retrieval — not supported in Phase 3.
    // Callers should use getProjectSummaries() instead.
    return null;
  }

  getProjectSessions(_slug: string): Segment<Session>[] {
    // Legacy — callers should use getSessionSummaries() instead.
    return [];
  }

  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage> {
    const result = this.store.getSessionMessages(slug, sessionId, limit, offset);

    // Wrap in Segment<SessionMessage> for backward compat with app-service.
    // The store returns the raw `{ messages, total, ... }` shape; the
    // segment wrapper lives here because it's a presentation concern
    // tied to the public `PaginatedSegmentResult<SessionMessage>`
    // contract, not to how data is fetched.
    const segments: Segment<SessionMessage>[] = result.messages.map((msg, i) => ({
      key: `message:${slug}/${sessionId}/${offset + i}`,
      type: 'message' as SegmentType,
      data: msg as SessionMessage,
      version: 1,
      updatedAt: Date.now(),
    }));

    return {
      segments,
      total: result.total,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  getConfig(): AgentConfig {
    if (this.store.hasConfig()) return this.store.getConfig();
    // Fallback: parse config if not cached yet (rare — initialize()
    // populates the cache for normal flows).
    const data = this.parser.parseSync({
      claudeDir: this.claudeDir,
      skipProjects: true,
      skipAnalytics: true,
    });
    this.store.setConfig(data.config);
    return data.config;
  }

  getAnalytics(): AgentAnalytic {
    if (this.store.hasAnalytics()) return this.store.getAnalytics();
    // Fallback: parse analytics if not cached yet.
    const data = this.parser.parseSync({
      claudeDir: this.claudeDir,
      skipProjects: true,
      skipConfig: true,
    });
    this.store.setAnalytics(data.analytics);
    return data.analytics;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summaries (delegate to AgentDataStore — SQL aggregation underneath)
  // ─────────────────────────────────────────────────────────────────────────

  getProjectSummaries(): ProjectSummaryData[] {
    return this.store.getProjectSummaries();
  }

  getSessionSummaries(projectSlug: string): SessionSummaryData[] {
    return this.store.getSessionSummaries(projectSlug);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Detail queries (delegate to AgentDataStore)
  // ─────────────────────────────────────────────────────────────────────────

  getProjectMemory(slug: string): string | null {
    return this.store.getProjectMemory(slug);
  }

  getSessionTodos(slug: string, sessionId: string): unknown[] {
    return this.store.getSessionTodos(slug, sessionId);
  }

  getSessionPlan(slug: string, sessionId: string): unknown | null {
    return this.store.getSessionPlan(slug, sessionId);
  }

  getSessionTask(slug: string, sessionId: string): unknown | null {
    return this.store.getSessionTask(slug, sessionId);
  }

  getPersistedToolResult(slug: string, sessionId: string, toolUseId: string): string | null {
    return this.store.getToolResult(slug, sessionId, toolUseId);
  }

  getSessionSubagents(
    slug: string,
    sessionId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }> {
    return this.store.getSessionSubagents(slug, sessionId);
  }

  getSubagentMessages(
    slug: string,
    sessionId: string,
    agentId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage> {
    const result = this.store.getSubagentMessages(slug, sessionId, agentId, limit, offset);

    const segments: Segment<SessionMessage>[] = result.messages.map((msg, i) => ({
      key: `subagent:${slug}/${sessionId}/${agentId}/${offset + i}`,
      type: 'subagent' as SegmentType,
      data: msg as SessionMessage,
      version: 1,
      updatedAt: Date.now(),
    }));

    return {
      segments,
      total: result.total,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search (delegate to AgentDataStore)
  // ─────────────────────────────────────────────────────────────────────────

  search(query: SearchQuery): SearchResultSet {
    return this.store.search(query);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rebuild & stats
  // ─────────────────────────────────────────────────────────────────────────

  async rebuild(): Promise<void> {
    this.ready = false;

    // Delete all data and re-parse from scratch
    this.ingestService.deleteAllData();

    this.ingestService.beginTransaction();
    try {
      this.parser.parseStreaming(this.ingestService, {
        claudeDir: this.claudeDir,
      });
      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    }

    this.saveAllFingerprints();

    // Re-parse config & analytics
    const fullData = this.parser.parseSync({
      claudeDir: this.claudeDir,
      skipProjects: true,
    });
    this.store.setConfig(fullData.config);
    this.store.setAnalytics(fullData.analytics);

    this.ready = true;
    this.emit('change', { changes: [], timestamp: Date.now() } satisfies SegmentChangeBatch);
  }

  getStoreStats(): StoreStats {
    return this.store.getStats();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private emitProgress(phase: InitProgress['phase'], message: string, current?: number, total?: number): void {
    const progress: InitProgress = { phase, message };
    if (current !== undefined) progress.current = current;
    if (total !== undefined) progress.total = total;
    this.emit('progress', progress);
  }
}
