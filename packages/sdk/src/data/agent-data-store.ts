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

import type { PaginatedSegmentResult, SearchQuery, SearchResultSet, StoreStats } from './segment-types.js';
import type { ProjectSummaryData, SessionSummaryData } from './summary-types.js';
import type { AgentAnalytic, AgentConfig, SessionMessage } from '../types/index.js';
import type { QueryService } from './query-service.js';
import type { Change, ChangeTopic, Dispose, SubscribeOptions } from '../live/change-events.js';

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

  // ── Stats ────────────────────────────────────────────────────────────────
  getStats(): StoreStats;

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

  // TODO(RFC 005 phase 2): add `open(dbPath)` / `close()` so the store
  // owns connection lifecycle; today `LifecycleOwner` drives
  // `QueryService.open/close` and the store is a pass-through consumer.
  // `getSnapshot()` / `subscribeSnapshot()` for `useSyncExternalStore`
  // land in phase 3 alongside the real subscriber registry.

  // ── Subscriber registry (RFC 005 phase 3 stub) ──────────────────────────
  /**
   * Publish a `Change` event to matching subscribers.
   *
   * TODO(RFC 005 phase 3): this is a no-op stub in C1.4. Phase 3 will
   * implement topic matching, per-subscription throttling, and a
   * monotonic in-memory `seq` counter driving `lastEmittedSeq()`. The
   * signature is wired in now so `LiveUpdates` (phase 2) can type-check
   * against the final contract while the registry is still inert.
   */
  emit(change: Change): void;
  /**
   * Register a listener for changes matching `topic` (undefined for the
   * firehose).
   *
   * TODO(RFC 005 phase 3): returns a no-op `Dispose` today. Phase 3
   * replaces this with `subscriber-registry.ts` (topic-matrix fan-out
   * + throttle support).
   */
  subscribe(topic: ChangeTopic | undefined, listener: (e: Change) => void, options?: SubscribeOptions): Dispose;
  /**
   * Last `seq` the store has assigned to an emitted `Change` this
   * process.
   *
   * TODO(RFC 005 phase 3): returns `0` today (counter lives in the
   * real registry). Kept on the interface so phase-3 wiring can bump
   * it without a signature change.
   */
  lastEmittedSeq(): number;
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

  // ── Stats ──────────────────────────────────────────────────────────────

  getStats(): StoreStats {
    return this.queryService.getStats();
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

  // ── Subscriber registry (RFC 005 phase 3 stub) ───────────────────────────

  emit(_change: Change): void {
    // TODO(RFC 005 phase 3): route through subscriber-registry.ts
    // (topic matching, throttle + `latest` coalescing, `seq` bump).
    // Intentionally a pure no-op today — an earlier draft accumulated
    // changes into a private Set; that Set was never drained, so a
    // long-lived process would leak one Change per live-commit. The
    // signature is wired so `LiveUpdates` (phase 2) can compile against
    // the final contract while the registry is still inert.
  }

  subscribe(_topic: ChangeTopic | undefined, _listener: (e: Change) => void, _options?: SubscribeOptions): Dispose {
    // TODO(RFC 005 phase 3): register the listener under its topic key,
    // apply throttle options, and return a dispose that removes it.
    // For C1.4 we return a no-op dispose so callers can wire up the
    // public `onChange` surface without any listeners actually firing.
    return () => {
      /* no-op until phase 3 */
    };
  }

  lastEmittedSeq(): number {
    // TODO(RFC 005 phase 3): return the in-memory monotonic counter
    // incremented inside `emit()` once the real registry lands.
    return 0;
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
