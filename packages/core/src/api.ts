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
import type { SessionMessage } from './types/index.js';

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

  /** Get subagent list for a session */
  getSessionSubagents(projectSlug: string, sessionId: string): SubagentListItem[];

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

  /** Subscribe to init progress events */
  onProgress(cb: (progress: InitProgress) => void): () => void;

  /** Subscribe to ready event */
  onReady(cb: (info: { durationMs: number }) => void): () => void;

  /** Subscribe to data change events */
  onChange(cb: (batch: SegmentChangeBatch) => void): () => void;
}
