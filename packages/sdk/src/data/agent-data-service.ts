/**
 * agent-data-service.ts — Backward-compat re-export shim.
 *
 * The implementation class lives in `./lifecycle-owner.ts` under its
 * new name `LifecycleOwner` as of RFC 005 Phase 1 (commit C1.4). This
 * module exists so every consumer — `create.ts`, `index.ts`,
 * `app-service.ts`, and all downstream packages — can keep importing
 * `AgentDataServiceImpl` / `ClaudeCodeAgentDataService` /
 * `AgentDataServiceOptions` from `./data/agent-data-service.js` without
 * any churn. When the rename is fully absorbed by the ecosystem, this
 * shim can be deleted and imports pointed directly at
 * `./lifecycle-owner.js`.
 */

export {
  // Impl: the class formerly known as `AgentDataServiceImpl`, now
  // implemented as `LifecycleOwner`. Aliased back on the way out so
  // existing `new AgentDataServiceImpl(...)` call-sites keep compiling.
  LifecycleOwner as AgentDataServiceImpl,
  // Interface + options used by `create.ts` and `app-service.ts`.
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
