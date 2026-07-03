/**
 * SpaghettiAPI — Public interface for consuming Claude Code agent data
 */

import type {
  SearchQuery,
  SearchResultSet,
  StoreStats,
  InitProgress,
  SegmentChangeBatch,
} from './data/segment-types.js';
import type { TokenUsageSummary } from './data/summary-types.js';
import type { SessionMessage, TeamDirectory } from './types/index.js';
import type { SpaghettiLive } from './live/spaghetti-live.js';

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ProjectListItem {
  slug: string;
  folderName: string;
  absolutePath: string;
  sessionCount: number;
  messageCount: number;
  tokenUsage: TokenUsageSummary;
  lastActiveAt: string;
  firstActiveAt: string;
  latestGitBranch: string;
  hasMemory: boolean;
}

export interface SessionListItem {
  sessionId: string;
  startTime: string;
  lastUpdate: string;
  lifespanMs: number;
  tokenUsage: TokenUsageSummary;
  messageCount: number;
  fullPath: string;
  summary: string;
  firstPrompt: string;
  gitBranch: string;
  todoCount: number;
  planSlug: string | null;
  hasTask: boolean;
  isSidechain: boolean;
}

export interface MessagePage {
  messages: SessionMessage[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export interface SubagentListItem {
  agentId: string;
  agentType: string;
  messageCount: number;
}

export interface WorkflowListItem {
  workflowId: string;
  name: string;
  status: string;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number;
  subagentCount: number;
}

export interface SubagentMessagePage {
  messages: SessionMessage[];
  total: number;
  offset: number;
  hasMore: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// SPAGHETTI API INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface SpaghettiAPI {
  /** Initialize the data service (parse + index) */
  initialize(): Promise<void>;

  /** Shut down watchers and close the database */
  shutdown(): void;

  /**
   * Force a full cold rebuild of the index. Closes the DB, deletes its
   * files, and re-ingests from scratch via the native Rust path (with
   * TS fallback). Useful when the index looks out of sync with
   * `~/.claude` or after a schema bump.
   */
  rebuildIndex(): Promise<{ durationMs: number }>;

  /** Whether the service is ready to accept queries */
  isReady(): boolean;

  /** Get all projects sorted by last active date */
  getProjectList(): ProjectListItem[];

  /** Get all sessions for a project sorted by last update */
  getSessionList(projectSlug: string): SessionListItem[];

  /** Get paginated messages for a session */
  getSessionMessages(projectSlug: string, sessionId: string, limit?: number, offset?: number): MessagePage;

  /** Get project MEMORY.md content */
  getProjectMemory(projectSlug: string): string | null;

  /** Get todos for a session */
  getSessionTodos(projectSlug: string, sessionId: string): unknown[];

  /** Get plan for a session */
  getSessionPlan(projectSlug: string, sessionId: string): unknown | null;

  /** Get task for a session */
  getSessionTask(projectSlug: string, sessionId: string): unknown | null;

  /** Get a persisted tool result */
  getToolResult(projectSlug: string, sessionId: string, toolUseId: string): string | null;

  /** Get top-level subagent list for a session (excludes workflow-nested) */
  getSessionSubagents(projectSlug: string, sessionId: string): SubagentListItem[];

  /** Get agent-orchestration workflow runs for a session */
  getSessionWorkflows(projectSlug: string, sessionId: string): WorkflowListItem[];

  /** Get the subagents that ran under a specific workflow */
  getWorkflowSubagents(projectSlug: string, sessionId: string, workflowId: string): SubagentListItem[];

  /** Get paginated subagent messages */
  getSubagentMessages(
    projectSlug: string,
    sessionId: string,
    agentId: string,
    limit?: number,
    offset?: number,
  ): SubagentMessagePage;

  /** Full-text search across all segments */
  search(query: SearchQuery): SearchResultSet;

  /** Get store statistics */
  getStats(): StoreStats;

  /**
   * Agent teams parsed from `~/.claude/teams/` (experimental agent-teams
   * feature). Empty array when the feature is unused. `config` is null
   * for orphaned team dirs that only have inboxes on disk.
   */
  getTeams(): TeamDirectory[];

  /** Subscribe to init progress events */
  onProgress(cb: (progress: InitProgress) => void): () => void;

  /** Subscribe to ready event */
  onReady(cb: (info: { durationMs: number }) => void): () => void;

  /** Subscribe to data change events */
  onChange(cb: (batch: SegmentChangeBatch) => void): () => void;

  /**
   * Live-updates surface (RFC 005). Present only when the service
   * was constructed with `{ live: true }`. See
   * `docs/rfcs/005-live-updates.md` §Public API for the full
   * subscribe + events + prewarm contract.
   */
  readonly live?: SpaghettiLive;

  /**
   * Awaitable teardown. Stops the live pipeline, drains in-flight
   * writes, disposes subscribers, and closes SQLite. Prefer this to
   * `shutdown()` when the caller can `await` — `shutdown()` is
   * fire-and-forget.
   *
   * Declared as a plain method because the SDK's tsconfig targets
   * ES2022 and `Symbol.asyncDispose` (ES2024) isn't available in the
   * type lib. Once the target bumps, this becomes
   * `[Symbol.asyncDispose](): Promise<void>` and consumers can use
   * `await using`.
   */
  dispose(): Promise<void>;
}
