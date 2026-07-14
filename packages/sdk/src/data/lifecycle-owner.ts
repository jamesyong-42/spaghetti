/**
 * Lifecycle contracts + compat re-exports (generic / shared layer).
 *
 * Product implementations live under `sources/`:
 * - Claude Code → `sources/claude-code/lifecycle-owner.ts`
 * - Codex → `sources/codex/lifecycle-owner.ts`
 *
 * This module keeps the shared interfaces (`LifecycleOwner`,
 * `ClaudeCodeAgentDataService`, options) and re-exports the Claude owner
 * class so existing imports from `./lifecycle-owner.js` / `agent-data-service`
 * keep working without churn.
 */

import type { EventEmitter } from 'events';
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
import type { IngestEngine } from '../settings.js';

// Re-export types used by app-service / agent-data-service shim
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

// Product impl — re-exported for backward-compat import paths
export { ClaudeCodeLifecycleOwner } from '../sources/claude-code/lifecycle-owner.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeAgentDataService extends EventEmitter {
  initialize(): Promise<void>;
  shutdown(): void;
  /**
   * Awaitable teardown (RFC 005 C3.4). Stops the live pipeline,
   * drains in-flight writes, disposes the subscriber registry, and
   * closes SQLite. Optional on the interface so external impls that
   * predate C3.4 still type-check; the default `LifecycleOwner`
   * always provides it.
   */
  shutdownAsync?(): Promise<void>;
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
    options?: { sourceId?: string },
  ): PaginatedSegmentResult<SessionMessage>;
  getConfig(): AgentConfig;
  getAnalytics(): AgentAnalytic;

  getSourceIds(): string[];
  getProjectSummaries(options?: { sourceId?: string }): ProjectSummaryData[];
  getSessionSummaries(projectSlug: string, options?: { sourceId?: string }): SessionSummaryData[];

  getProjectMemory(slug: string, options?: { sourceId?: string }): string | null;
  getSessionTodos(slug: string, sessionId: string): unknown[];
  getSessionPlan(slug: string, sessionId: string): unknown | null;
  getSessionTask(slug: string, sessionId: string): unknown | null;
  getPersistedToolResult(slug: string, sessionId: string, toolUseId: string): string | null;
  getSessionSubagents(
    slug: string,
    sessionId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }>;
  getSessionWorkflows(slug: string, sessionId: string): ReturnType<AgentDataStore['getSessionWorkflows']>;
  getWorkflowSubagents(
    slug: string,
    sessionId: string,
    workflowId: string,
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

/**
 * Internal accessors the app-service consumes via structural typing.
 *
 * NOT exported from the SDK barrel — `getStore()` returns the
 * `AgentDataStore` (an internal type with the subscriber registry on
 * it) and `getLiveUpdates()` returns the orchestrator (also internal).
 * Exposing either on the public `ClaudeCodeAgentDataService`
 * interface would leak implementation types into consumer code
 * (audit finding); keeping them on a separate interface that only
 * `LifecycleOwner` implements means `app-service.ts` reaches them
 * via duck-typing without the public surface advertising them.
 */
export interface LifecycleInternal {
  getStore(): AgentDataStore;
  /** This source's live pipeline (RFC 006), or undefined when not live. */
  getLiveWatch(): LiveWatch | undefined;
}

/**
 * The per-source ingest-lifecycle contract (RFC 006 multi-source).
 *
 * A `LifecycleOwner` owns ONE agent source's ingest into the shared store:
 * engine selection (rs/ts), cold-start, warm-start, and (optionally) the live
 * pipeline. It deliberately does NOT own reads — `getProjectSummaries`,
 * `search`, etc. query the shared store, which already unifies every source's
 * rows, so reads are a shared facade, not a per-source concern.
 *
 * Implementations: `ClaudeCodeLifecycleOwner` (`sources/claude-code/`),
 * `CodexLifecycleOwner` (`sources/codex/`). A coordinator fans
 * `initialize`/`shutdown`/`rebuild` across all owners.
 */
export interface LifecycleOwner extends LifecycleInternal {
  /** The `AgentSource.id` this owner ingests for (stamped on its rows). */
  readonly sourceId: string;
  initialize(): Promise<void>;
  shutdown(): void;
  shutdownAsync?(): Promise<void>;
  rebuild(): Promise<void>;
  /** Full cold rebuild of this source's rows. */
  rebuildIndex(): Promise<{ durationMs: number }>;
  /** Owners emit `progress`/`change`/`error`; the coordinator forwards them. */
  on(event: string, listener: (...args: unknown[]) => void): this;
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
