/**
 * ClaudeCodeAgentDataService — Interface + full AgentDataServiceImpl
 *
 * The implementation uses QueryService for reads and IngestService for writes,
 * backed by the Phase 3 dedicated-table schema.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'events';
import type {
  SegmentType, SegmentKey, Segment, SegmentChangeBatch, InitProgress,
  PaginatedSegmentQuery, PaginatedSegmentResult,
  SearchQuery, SearchResultSet, StoreStats,
} from './segment-types.js';
import type { SessionSummaryData, ProjectSummaryData } from './summary-types.js';
import type {
  Project, Session, SessionMessage, AgentConfig, AgentAnalytic,
  SessionsIndex, SessionIndexEntry, SubagentTranscript,
  PersistedToolResult, FileHistorySession, TodoFile, TaskEntry, PlanFile,
} from '../types/index.js';
import type { QueryService } from './query-service.js';
import type { IngestService } from './ingest-service.js';
import type { ClaudeCodeParser, ClaudeCodeParserOptions } from '../parser/claude-code-parser.js';
import type { FileService } from '../io/index.js';
import {
  createWorkerPool,
  isWorkerThreadsAvailable,
  type WorkerToMainMessage,
} from '../workers/index.js';

// Re-export types used by app-service
export {
  type SegmentType, type SegmentKey, type Segment,
  type SegmentChangeBatch, type InitProgress,
  type PaginatedSegmentQuery, type PaginatedSegmentResult,
  type SearchQuery, type SearchResultSet, type StoreStats,
  segmentKey, parseSegmentKey,
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
  isReady(): boolean;

  getSegment<T>(key: SegmentKey): Segment<T> | null;
  getSegmentsByType<T>(type: SegmentType): Segment<T>[];
  getSegmentsPaginated<T>(query: PaginatedSegmentQuery): PaginatedSegmentResult<T>;

  getProjectSlugs(): string[];
  getProject(slug: string): Segment<Project> | null;
  getProjectSessions(slug: string): Segment<Session>[];
  getSessionMessages(slug: string, sessionId: string, limit: number, offset: number): PaginatedSegmentResult<SessionMessage>;
  getConfig(): AgentConfig;
  getAnalytics(): AgentAnalytic;

  getProjectSummaries(): ProjectSummaryData[];
  getSessionSummaries(projectSlug: string): SessionSummaryData[];

  getProjectMemory(slug: string): string | null;
  getSessionTodos(slug: string, sessionId: string): unknown[];
  getSessionPlan(slug: string, sessionId: string): unknown | null;
  getSessionTask(slug: string, sessionId: string): unknown | null;
  getPersistedToolResult(slug: string, sessionId: string, toolUseId: string): string | null;
  getSessionSubagents(slug: string, sessionId: string): Array<{ agentId: string; agentType: string; messageCount: number }>;
  getSubagentMessages(slug: string, sessionId: string, agentId: string, limit: number, offset: number): PaginatedSegmentResult<SessionMessage>;

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
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT DB PATH
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultDbPath(): string {
  return path.join(os.homedir(), '.spaghetti', 'cache', 'spaghetti.db');
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

export class AgentDataServiceImpl extends EventEmitter implements ClaudeCodeAgentDataService {
  private fileService: FileService;
  private parser: ClaudeCodeParser;
  private queryService: QueryService;
  private ingestService: IngestService;
  private options: AgentDataServiceOptions;

  private ready = false;
  private dbPath: string;
  private claudeDir: string;

  // Cached config/analytics (parsed once, small data)
  private cachedConfig: AgentConfig | null = null;
  private cachedAnalytics: AgentAnalytic | null = null;

  constructor(
    fileService: FileService,
    parser: ClaudeCodeParser,
    queryService: QueryService,
    ingestService: IngestService,
    options?: AgentDataServiceOptions,
  ) {
    super();
    this.fileService = fileService;
    this.parser = parser;
    this.queryService = queryService;
    this.ingestService = ingestService;
    this.options = options ?? {};
    this.dbPath = this.options.dbPath ?? getDefaultDbPath();
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

      // Open both services (they share the same DB path)
      this.emitProgress('parsing', 'Opening database...');
      this.queryService.open(this.dbPath);
      this.ingestService.open(this.dbPath);

      // Check if this is a cold start or warm start
      const fingerprints = this.ingestService.getAllFingerprints();
      const isColdStart = fingerprints.length === 0;

      if (isColdStart) {
        await this.performColdStart();
      } else {
        await this.performWarmStart(fingerprints);
      }

      // Parse config and analytics (small data, always sync)
      this.emitProgress('parsing', 'Parsing config and analytics...');
      const fullData = this.parser.parseSync({
        claudeDir: this.claudeDir,
        skipProjects: true,
        skipSessionMessages: true,
      });
      this.cachedConfig = fullData.config;
      this.cachedAnalytics = fullData.analytics;

      this.ready = true;
      const durationMs = Date.now() - startTime;
      this.emit('ready', { durationMs });
    } catch (error) {
      this.emit('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async performColdStart(): Promise<void> {
    // Discover project slugs to decide on parallel vs sequential
    const slugs = this.discoverProjectSlugs();

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

    // Save fingerprints for all session JSONL files we can find
    this.emitProgress('storing', 'Saving file fingerprints...');
    this.saveAllFingerprints();

    this.emitProgress('indexing', 'Cold start complete.');
  }

  private async coldStartSequential(): Promise<void> {
    // Discover slugs to report progress count
    const slugs = this.discoverProjectSlugs();
    const totalProjects = slugs.length;
    let completedProjects = 0;

    this.emitProgress('parsing', `Parsing ${totalProjects} projects...`, 0, totalProjects);

    // Wrap the ingest service with a progress-emitting proxy
    const self = this;
    const progressSink: typeof this.ingestService = Object.create(this.ingestService);
    progressSink.onProjectComplete = function(slug: string) {
      self.ingestService.onProjectComplete(slug);
      completedProjects++;
      self.emitProgress('parsing', `Parsed ${slug}`, completedProjects, totalProjects);
    };

    // Use streaming parser to ingest all data directly into SQLite
    this.ingestService.beginTransaction();
    try {
      this.parser.parseStreaming(progressSink, {
        claudeDir: this.claudeDir,
      });
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

    const pool = createWorkerPool({ maxWorkers: 4 });

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

  private async performWarmStart(existingFingerprints: Array<{ path: string; mtimeMs: number; size: number; bytePosition?: number }>): Promise<void> {
    this.emitProgress('reconciling', 'Warm start: checking for changes...');

    // Check which files have changed since last parse
    // Skip recovery:// fingerprints — those track imported legacy data
    const changedFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const fp of existingFingerprints) {
      if (fp.path.startsWith('recovery://')) continue;
      const stats = this.fileService.getStats(fp.path);
      if (!stats) {
        removedFiles.push(fp.path);
      } else if (stats.mtimeMs !== fp.mtimeMs || stats.size !== fp.size) {
        changedFiles.push(fp.path);
      }
    }

    // Recovery check: detect projects that have sessions in the DB but 0
    // messages.  This happens when a previous cold start silently failed
    // to parse JSONL files (e.g. stale sessions-index.json).  If we find
    // any, force a full re-parse to recover the lost data.
    let needsRecovery = false;
    if (changedFiles.length === 0 && removedFiles.length === 0) {
      needsRecovery = this.hasProjectsWithMissingMessages();
      if (!needsRecovery) {
        this.emitProgress('reconciling', 'No changes detected, using cached data.');
        return;
      }
      this.emitProgress('reconciling', 'Detected projects with 0 messages — triggering recovery re-parse...');
    }

    // Re-parse only from disk files. Use a MERGE strategy: re-ingest from
    // disk (which uses UPSERT) without deleting first. This preserves
    // recovered legacy data that has no corresponding disk files.
    this.emitProgress('parsing', needsRecovery
      ? 'Recovery re-parse: fixing projects with missing messages...'
      : `Re-parsing: ${changedFiles.length} changed, ${removedFiles.length} removed files...`);

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

    // Update fingerprints
    this.saveAllFingerprints();
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
      const summaries = this.queryService.getProjectSummaries();
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
              this.ingestService.upsertFingerprint({
                path: filePath,
                mtimeMs: stats.mtimeMs,
                size: stats.size,
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
    this.cachedConfig = null;
    this.cachedAnalytics = null;
    try { this.ingestService.close(); } catch { /* ignore */ }
    try { this.queryService.close(); } catch { /* ignore */ }
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
  // Project queries (delegate to QueryService)
  // ─────────────────────────────────────────────────────────────────────────

  getProjectSlugs(): string[] {
    return this.queryService.getProjectSlugs();
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
    const result = this.queryService.getSessionMessages(slug, sessionId, limit, offset);

    // Wrap in Segment<SessionMessage> for backward compat with app-service
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
    if (this.cachedConfig) return this.cachedConfig;
    // Fallback: parse config if not cached
    const data = this.parser.parseSync({
      claudeDir: this.claudeDir,
      skipProjects: true,
      skipAnalytics: true,
    });
    this.cachedConfig = data.config;
    return data.config;
  }

  getAnalytics(): AgentAnalytic {
    if (this.cachedAnalytics) return this.cachedAnalytics;
    // Fallback: parse analytics if not cached
    const data = this.parser.parseSync({
      claudeDir: this.claudeDir,
      skipProjects: true,
      skipConfig: true,
    });
    this.cachedAnalytics = data.analytics;
    return data.analytics;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summaries (delegate to QueryService — SQL aggregation)
  // ─────────────────────────────────────────────────────────────────────────

  getProjectSummaries(): ProjectSummaryData[] {
    return this.queryService.getProjectSummaries();
  }

  getSessionSummaries(projectSlug: string): SessionSummaryData[] {
    return this.queryService.getSessionSummaries(projectSlug);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Detail queries
  // ─────────────────────────────────────────────────────────────────────────

  getProjectMemory(slug: string): string | null {
    return this.queryService.getProjectMemory(slug);
  }

  getSessionTodos(slug: string, sessionId: string): unknown[] {
    return this.queryService.getSessionTodos(slug, sessionId);
  }

  getSessionPlan(slug: string, sessionId: string): unknown | null {
    return this.queryService.getSessionPlan(slug, sessionId);
  }

  getSessionTask(slug: string, sessionId: string): unknown | null {
    return this.queryService.getSessionTask(slug, sessionId);
  }

  getPersistedToolResult(slug: string, sessionId: string, toolUseId: string): string | null {
    return this.queryService.getToolResult(slug, sessionId, toolUseId);
  }

  getSessionSubagents(slug: string, sessionId: string): Array<{ agentId: string; agentType: string; messageCount: number }> {
    return this.queryService.getSessionSubagents(slug, sessionId);
  }

  getSubagentMessages(
    slug: string,
    sessionId: string,
    agentId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage> {
    const result = this.queryService.getSubagentMessages(slug, sessionId, agentId, limit, offset);

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
  // Search
  // ─────────────────────────────────────────────────────────────────────────

  search(query: SearchQuery): SearchResultSet {
    return this.queryService.search(query);
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
    this.cachedConfig = fullData.config;
    this.cachedAnalytics = fullData.analytics;

    this.ready = true;
    this.emit('change', { changes: [], timestamp: Date.now() } satisfies SegmentChangeBatch);
  }

  getStoreStats(): StoreStats {
    return this.queryService.getStats();
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
