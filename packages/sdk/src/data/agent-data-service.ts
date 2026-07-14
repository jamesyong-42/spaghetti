/**
 * agent-data-service.ts — Backward-compat re-export shim.
 *
 * Claude Code lifecycle implementation lives in
 * `sources/claude-code/lifecycle-owner.ts`. Shared contracts
 * (`LifecycleOwner`, `ClaudeCodeAgentDataService`, options) live in
 * `./lifecycle-owner.ts`. This module keeps every consumer —
 * `create.ts`, `index.ts`, `app-service.ts`, and downstream packages —
 * importing `AgentDataServiceImpl` / `ClaudeCodeAgentDataService` /
 * `AgentDataServiceOptions` from `./data/agent-data-service.js` without
 * churn.
 */

export {
  // Impl: the class formerly known as `AgentDataServiceImpl`, now
  // `ClaudeCodeLifecycleOwner` under sources/claude-code/.
  // Aliased back on the way out so existing `new AgentDataServiceImpl(...)`
  // call-sites keep compiling.
  ClaudeCodeLifecycleOwner as AgentDataServiceImpl,
  ClaudeCodeLifecycleOwner,
  // The per-source ingest-lifecycle interface + options.
  type LifecycleOwner,
  type ClaudeCodeAgentDataService,
  type AgentDataServiceOptions,
  // Segment / search / summary re-exports that previously lived on
  // this file and are consumed across the codebase.
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
  type SearchIndexEntry,
  type SearchIndexer,
  createSearchIndexer,
  type SegmentStore,
  createSegmentStore,
  type TokenUsageSummary,
  type SessionSummaryData,
  type ProjectSummaryData,
} from './lifecycle-owner.js';
