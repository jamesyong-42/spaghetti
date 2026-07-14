/**
 * agent-data-service.ts — Backward-compat re-export shim.
 *
 * Claude Code lifecycle implementation lives in
 * `sources/claude-code/lifecycle-owner.ts`. Shared contracts
 * (`LifecycleOwner`, `AgentDataService`, options) live in
 * `./lifecycle-owner.ts`.
 */

export {
  // Impl: the class formerly known as `AgentDataServiceImpl`, now
  // `ClaudeCodeLifecycleOwner` under sources/claude-code/.
  ClaudeCodeLifecycleOwner as AgentDataServiceImpl,
  ClaudeCodeLifecycleOwner,
  type LifecycleOwner,
  type AgentDataService,
  /** @deprecated Use AgentDataService */
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
