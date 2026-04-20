/**
 * AgentDataStore — Read layer + cache owner for the Phase 3 schema.
 *
 * This file is the first landing point for the RFC 005 refactor that
 * splits `AgentDataServiceImpl` into a lifecycle owner (future
 * `LifecycleOwner`) and a store that concentrates every read path plus
 * the in-memory config/analytics caches.
 *
 * For this commit (C1.1) the store only exposes the current read
 * methods, delegating each one to an injected `QueryService`. Later
 * commits move the `cachedConfig`/`cachedAnalytics` fields in (C1.2),
 * route `AgentDataServiceImpl`'s reads through the store (C1.3), and
 * attach the subscriber/registry stubs (C1.4).
 *
 * See `docs/rfcs/005-live-updates.md` and
 * `docs/LIVE-UPDATES-DESIGN.md` §2.2 for the full intended shape.
 */

import type { PaginatedSegmentResult, SearchQuery, SearchResultSet } from './segment-types.js';
import type { ProjectSummaryData, SessionSummaryData } from './summary-types.js';
import type { AgentAnalytic, AgentConfig, SessionMessage } from '../types/index.js';
import type { QueryService } from './query-service.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read-only view over the SDK's SQLite cache. Every method here mirrors
 * the corresponding read method currently on `AgentDataServiceImpl` —
 * same name, same signature, same return shape — so later commits can
 * swap the service's implementation over to `this.store.getX(...)` with
 * no observable behavior change.
 */
export interface AgentDataStore {
  // ── Projects ─────────────────────────────────────────────────────────────
  getProjectSlugs(): string[];
  getProjectSummaries(): ProjectSummaryData[];
  getSessionSummaries(projectSlug: string): SessionSummaryData[];

  // ── Messages ─────────────────────────────────────────────────────────────
  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean };

  // ── Subagents ────────────────────────────────────────────────────────────
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
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean };

  // ── Details ──────────────────────────────────────────────────────────────
  getProjectMemory(slug: string): string | null;
  getSessionTodos(slug: string, sessionId: string): unknown[];
  getSessionPlan(slug: string, sessionId: string): unknown | null;
  getSessionTask(slug: string, sessionId: string): unknown | null;
  getToolResult(slug: string, sessionId: string, toolUseId: string): string | null;

  // ── Search ───────────────────────────────────────────────────────────────
  search(query: SearchQuery): SearchResultSet;

  // ── In-memory caches (config + analytics) ────────────────────────────────
  /**
   * Return the last-set `AgentConfig`. Throws if the lifecycle owner
   * hasn't populated the cache yet (i.e. before `initialize()` has
   * finished). Callers that want a lazy-populating fallback should
   * keep using `AgentDataServiceImpl.getConfig()` — that surface still
   * handles re-parsing when the cache is empty.
   */
  getConfig(): AgentConfig;
  /** Same contract as `getConfig()`, for the analytics half. */
  getAnalytics(): AgentAnalytic;
  /** Replace the cached config snapshot. */
  setConfig(config: AgentConfig): void;
  /** Replace the cached analytics snapshot. */
  setAnalytics(analytics: AgentAnalytic): void;
  /** True once both caches have been populated at least once. */
  hasConfig(): boolean;
  hasAnalytics(): boolean;
}

/**
 * Marker type re-exported so lifecycle-layer code can wrap the store's
 * paginated message shape in the existing `Segment<SessionMessage>[]`
 * adapter without importing `query-service.ts` directly. Today this is
 * just an alias for `PaginatedSegmentResult<SessionMessage>`; it exists
 * so later commits have a stable name to reach for.
 */
export type StorePaginatedMessages = PaginatedSegmentResult<SessionMessage>;

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thin delegating implementation. The long-term plan (RFC 005) has the
 * store composing `QueryService` privately and exposing the richer
 * subscriber/registry surface, but C1.1 keeps it a strict pass-through
 * so the refactor can land in small, verifiable steps.
 */
export class AgentDataStoreImpl implements AgentDataStore {
  private readonly queryService: QueryService;

  // In-memory caches moved here from `AgentDataServiceImpl` in C1.2.
  // The lifecycle owner still owns when these are populated (after cold
  // or warm start runs `parser.parseSync({ skipProjects: true, ... })`)
  // but the storage + accessor surface belongs to the store.
  private cachedConfig: AgentConfig | null = null;
  private cachedAnalytics: AgentAnalytic | null = null;

  constructor(queryService: QueryService) {
    this.queryService = queryService;
  }

  // ── Projects ───────────────────────────────────────────────────────────

  getProjectSlugs(): string[] {
    return this.queryService.getProjectSlugs();
  }

  getProjectSummaries(): ProjectSummaryData[] {
    return this.queryService.getProjectSummaries();
  }

  getSessionSummaries(projectSlug: string): SessionSummaryData[] {
    return this.queryService.getSessionSummaries(projectSlug);
  }

  // ── Messages ───────────────────────────────────────────────────────────

  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean } {
    return this.queryService.getSessionMessages(slug, sessionId, limit, offset);
  }

  // ── Subagents ──────────────────────────────────────────────────────────

  getSessionSubagents(
    slug: string,
    sessionId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }> {
    return this.queryService.getSessionSubagents(slug, sessionId);
  }

  getSubagentMessages(
    slug: string,
    sessionId: string,
    agentId: string,
    limit: number,
    offset: number,
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean } {
    return this.queryService.getSubagentMessages(slug, sessionId, agentId, limit, offset);
  }

  // ── Details ────────────────────────────────────────────────────────────

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

  getToolResult(slug: string, sessionId: string, toolUseId: string): string | null {
    return this.queryService.getToolResult(slug, sessionId, toolUseId);
  }

  // ── Search ─────────────────────────────────────────────────────────────

  search(query: SearchQuery): SearchResultSet {
    return this.queryService.search(query);
  }

  // ── In-memory caches ───────────────────────────────────────────────────

  getConfig(): AgentConfig {
    if (!this.cachedConfig) {
      throw new Error('AgentDataStore: config not set. The lifecycle owner must call setConfig() during initialize().');
    }
    return this.cachedConfig;
  }

  getAnalytics(): AgentAnalytic {
    if (!this.cachedAnalytics) {
      throw new Error(
        'AgentDataStore: analytics not set. The lifecycle owner must call setAnalytics() during initialize().',
      );
    }
    return this.cachedAnalytics;
  }

  setConfig(config: AgentConfig): void {
    this.cachedConfig = config;
  }

  setAnalytics(analytics: AgentAnalytic): void {
    this.cachedAnalytics = analytics;
  }

  hasConfig(): boolean {
    return this.cachedConfig !== null;
  }

  hasAnalytics(): boolean {
    return this.cachedAnalytics !== null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Construct a store backed by the given `QueryService`. The
 * `QueryService` must already be opened against the target SQLite
 * database — the store does not manage the connection lifecycle.
 */
export function createAgentDataStore(queryService: QueryService): AgentDataStore {
  return new AgentDataStoreImpl(queryService);
}
