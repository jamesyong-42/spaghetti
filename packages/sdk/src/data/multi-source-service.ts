/**
 * SpaghettiDataService — the agent-agnostic data service (RFC 006 multi-source).
 *
 * The app consumes ONE data service. This is it: reads delegate to the shared
 * `AgentDataStore` (which unifies every source's rows), and lifecycle
 * (`initialize`/`shutdown`/`rebuild`) fans across a set of per-source
 * `LifecycleOwner`s. It is deliberately NOT coupled to any agent — no source's
 * owner serves reads; the store does. A single-source app passes one owner; a
 * multi-source app passes several, all writing into the same store.
 *
 * Implements the same `ClaudeCodeAgentDataService` surface `app-service.ts`
 * already consumes (the name is legacy; the surface is source-neutral), plus
 * `LifecycleInternal` for `getStore`/`getLiveUpdates`.
 */

import { EventEmitter } from 'events';
import type {
  SegmentType,
  SegmentKey,
  Segment,
  PaginatedSegmentQuery,
  PaginatedSegmentResult,
  SearchQuery,
  SearchResultSet,
  StoreStats,
} from './segment-types.js';
import type { SessionSummaryData, ProjectSummaryData } from './summary-types.js';
import type { Project, Session, SessionMessage, AgentConfig, AgentAnalytic } from '../types/index.js';
import type { AgentDataStore } from './agent-data-store.js';
import type { LiveWatch } from '../live/live-watch.js';
import type { ClaudeCodeAgentDataService, LifecycleInternal, LifecycleOwner } from './lifecycle-owner.js';

export class SpaghettiDataService extends EventEmitter implements ClaudeCodeAgentDataService, LifecycleInternal {
  private ready = false;

  constructor(
    private readonly store: AgentDataStore,
    private readonly owners: LifecycleOwner[],
  ) {
    super();
    // Forward progress/change/error from every owner. `ready` is emitted once,
    // by this service's own `initialize()`, after ALL owners finish — an
    // individual owner's `ready` would fire prematurely for the whole app.
    for (const owner of this.owners) {
      owner.on('progress', (data) => this.emit('progress', data));
      owner.on('change', (data) => this.emit('change', data));
      owner.on('error', (data) => this.emit('error', data));
    }
  }

  // ── Lifecycle (fan across owners) ─────────────────────────────────────────

  async initialize(): Promise<void> {
    this.ready = false;
    const start = Date.now();
    // Sequential: owners share one SQLite handle; the first opens/creates the
    // schema, the rest reuse it. Concurrency here would race the open.
    for (const owner of this.owners) {
      await owner.initialize();
    }
    this.ready = true;
    this.emit('ready', { durationMs: Date.now() - start });
  }

  shutdown(): void {
    this.ready = false;
    // Reverse order so the primary (first-constructed) owner tears down last.
    for (const owner of [...this.owners].reverse()) {
      owner.shutdown();
    }
  }

  async shutdownAsync(): Promise<void> {
    this.ready = false;
    for (const owner of [...this.owners].reverse()) {
      if (owner.shutdownAsync) {
        await owner.shutdownAsync();
      } else {
        owner.shutdown();
      }
    }
  }

  async rebuild(): Promise<void> {
    for (const owner of this.owners) {
      await owner.rebuild();
    }
    this.emit('change', { changes: [], timestamp: Date.now() });
  }

  async rebuildIndex(): Promise<{ durationMs: number }> {
    const start = Date.now();
    for (const owner of this.owners) {
      await owner.rebuildIndex();
    }
    return { durationMs: Date.now() - start };
  }

  isReady(): boolean {
    return this.ready;
  }

  // ── Internal accessors ────────────────────────────────────────────────────

  getStore(): AgentDataStore {
    return this.store;
  }

  getLiveWatch(): LiveWatch | undefined {
    // Each source runs its own LiveWatch (started by its owner) and emits into
    // the shared store, which `api.live` observes. This returns the primary
    // (first) owner's — Claude's, which carries the `prewarm` scope surface
    // `api.live` exposes; other sources' watches run alongside via the store.
    for (const owner of this.owners) {
      const live = owner.getLiveWatch();
      if (live) return live;
    }
    return undefined;
  }

  // ── Reads (delegate to the shared, unified store) ─────────────────────────

  getSegment<T>(_key: SegmentKey): Segment<T> | null {
    return null;
  }

  getSegmentsByType<T>(_type: SegmentType): Segment<T>[] {
    return [];
  }

  getSegmentsPaginated<T>(query: PaginatedSegmentQuery): PaginatedSegmentResult<T> {
    return { segments: [], total: 0, offset: query.offset, hasMore: false };
  }

  getProjectSlugs(): string[] {
    return this.store.getProjectSlugs();
  }

  getProject(_slug: string): Segment<Project> | null {
    return null;
  }

  getProjectSessions(_slug: string): Segment<Session>[] {
    return [];
  }

  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): PaginatedSegmentResult<SessionMessage> {
    const result = this.store.getSessionMessages(slug, sessionId, limit, offset);
    const segments: Segment<SessionMessage>[] = result.messages.map((msg, i) => ({
      key: `message:${slug}/${sessionId}/${offset + i}`,
      type: 'message' as SegmentType,
      data: msg as SessionMessage,
      version: 1,
      updatedAt: Date.now(),
    }));
    return { segments, total: result.total, offset: result.offset, hasMore: result.hasMore };
  }

  getConfig(): AgentConfig {
    // Config/analytics are populated by each source's initialize() into the
    // shared store; reads just return what's there (no parser here — that keeps
    // this service source-neutral).
    return this.store.getConfig();
  }

  getAnalytics(): AgentAnalytic {
    return this.store.getAnalytics();
  }

  getSourceIds(): string[] {
    return this.store.getSourceIds();
  }

  getProjectSummaries(options?: { sourceId?: string }): ProjectSummaryData[] {
    return this.store.getProjectSummaries(options);
  }

  getSessionSummaries(projectSlug: string): SessionSummaryData[] {
    return this.store.getSessionSummaries(projectSlug);
  }

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

  getSessionWorkflows(slug: string, sessionId: string): ReturnType<AgentDataStore['getSessionWorkflows']> {
    return this.store.getSessionWorkflows(slug, sessionId);
  }

  getWorkflowSubagents(
    slug: string,
    sessionId: string,
    workflowId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }> {
    return this.store.getWorkflowSubagents(slug, sessionId, workflowId);
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
    return { segments, total: result.total, offset: result.offset, hasMore: result.hasMore };
  }

  search(query: SearchQuery): SearchResultSet {
    return this.store.search(query);
  }

  getStoreStats(): StoreStats {
    return this.store.getStats();
  }
}
