/**
 * QueryService — Read-only query layer for the Phase 3 dedicated-table schema
 *
 * All methods return domain types directly. No segment abstraction.
 */

import type { SqliteService } from '../io/index.js';
import type { ProjectSummaryData, SessionSummaryData, TokenUsageSummary } from './summary-types.js';
import type { SearchQuery, SearchResultSet, StoreStats } from './segment-types.js';
import { initializeSchema } from './schema.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface QueryService {
  open(dbPath: string): void;
  close(): void;
  isOpen(): boolean;

  // Projects
  getProjectSlugs(): string[];
  /** Distinct agent sources present in the index. */
  getSourceIds(): string[];
  getProjectSummaries(options?: { sourceId?: string }): ProjectSummaryData[];
  getSessionSummaries(projectSlug: string, options?: { sourceId?: string }): SessionSummaryData[];
  /**
   * Distinct `project_slug` values present in `messages` but absent
   * from `projects`. Used by warm-start recovery to detect orphaned
   * rows left behind by older code paths that emitted messages
   * without their parent `projects`/`sessions` rows.
   */
  getOrphanedMessageProjectSlugs(): string[];

  // Messages (paginated)
  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
    options?: { sourceId?: string },
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean };

  // Subagents
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

  // Workflows (agent-orchestration runs)
  getSessionWorkflows(
    slug: string,
    sessionId: string,
  ): Array<{
    workflowId: string;
    name: string;
    status: string;
    agentCount: number;
    totalTokens: number;
    totalToolCalls: number;
    durationMs: number;
    subagentCount: number;
  }>;
  getWorkflowSubagents(
    slug: string,
    sessionId: string,
    workflowId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }>;

  // Details
  getProjectMemory(slug: string, options?: { sourceId?: string }): string | null;
  getSessionTodos(slug: string, sessionId: string): unknown[];
  getSessionPlan(slug: string, sessionId: string): unknown | null;
  getSessionTask(slug: string, sessionId: string): unknown | null;
  getToolResult(slug: string, sessionId: string, toolUseId: string): string | null;

  // Search
  search(query: SearchQuery): SearchResultSet;

  // Stats
  getStats(): StoreStats;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROW TYPES (internal)
// ═══════════════════════════════════════════════════════════════════════════

interface CountRow {
  count: number;
}

interface ProjectSlugRow {
  slug: string;
}

interface ProjectSummaryRow {
  slug: string;
  source_id: string;
  original_path: string;
  session_count: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tokens_estimated: number;
  last_active_at: string;
  first_active_at: string;
  latest_git_branch: string | null;
  has_memory: number;
}

interface SessionSummaryRow {
  id: string;
  source_id: string;
  project_slug: string;
  full_path: string;
  first_prompt: string;
  summary: string;
  git_branch: string;
  project_path: string;
  is_sidechain: number;
  created_at: string;
  modified_at: string;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tokens_estimated: number;
  todo_count: number;
  plan_slug: string | null;
  has_task: number;
}

interface MessageDataRow {
  data: string;
}

interface SubagentRow {
  agent_id: string;
  agent_type: string;
  message_count: number;
}

interface WorkflowRow {
  workflow_id: string;
  name: string;
  status: string;
  agent_count: number;
  total_tokens: number;
  total_tool_calls: number;
  duration_ms: number;
  subagent_count: number;
}

interface SubagentMessagesRow {
  messages: string;
}

interface MemoryRow {
  content: string;
}

interface TodoRow {
  items: string;
}

interface PlanRow {
  content: string;
  title: string;
  slug: string;
  size: number;
}

interface TaskRow {
  session_id: string;
  has_highwatermark: number;
  highwatermark: number | null;
  lock_exists: number;
}

interface ToolResultRow {
  content: string;
}

interface SearchFtsRow {
  project_slug: string;
  session_id: string;
  msg_index: number;
  snippet: string;
  rank: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

class QueryServiceImpl implements QueryService {
  private db: SqliteService;
  private opened = false;

  constructor(sqliteServiceFactory: () => SqliteService) {
    this.db = sqliteServiceFactory();
  }

  open(dbPath: string): void {
    // If the underlying SqliteService is already open (shared connection),
    // skip opening again to avoid "Database already open" errors.
    if (!this.db.isOpen()) {
      this.db.open({ path: dbPath });
    }
    initializeSchema(this.db);
    this.opened = true;
  }

  close(): void {
    if (this.opened) {
      this.db.close();
      this.opened = false;
    }
  }

  isOpen(): boolean {
    return this.opened;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Projects
  // ─────────────────────────────────────────────────────────────────────────

  getProjectSlugs(): string[] {
    const rows = this.db.all<ProjectSlugRow>('SELECT slug FROM projects ORDER BY slug');
    return rows.map((r) => r.slug);
  }

  getOrphanedMessageProjectSlugs(): string[] {
    const rows = this.db.all<{ project_slug: string }>(
      `SELECT DISTINCT m.project_slug
         FROM messages m
         LEFT JOIN projects p ON m.project_slug = p.slug
        WHERE p.slug IS NULL`,
    );
    return rows.map((r) => r.project_slug);
  }

  /** Distinct agent sources present in the index. */
  getSourceIds(): string[] {
    const rows = this.db.all<{ source_id: string }>('SELECT DISTINCT source_id FROM sessions ORDER BY source_id');
    return rows.map((r) => r.source_id);
  }

  getProjectSummaries(options?: { sourceId?: string }): ProjectSummaryData[] {
    const where = options?.sourceId ? 'WHERE p.source_id = ?' : '';
    const params = options?.sourceId ? [options.sourceId] : [];
    const rows = this.db.all<ProjectSummaryRow>(
      `
      SELECT p.slug, p.source_id, p.original_path,
        (SELECT COUNT(*) FROM sessions WHERE project_slug = p.slug AND source_id = p.source_id) as session_count,
        COALESCE((SELECT SUM(mc.cnt) FROM (SELECT COUNT(*) as cnt FROM messages WHERE project_slug = p.slug AND source_id = p.source_id GROUP BY session_id) mc), 0) as message_count,
        COALESCE((SELECT SUM(input_tokens) FROM messages WHERE project_slug = p.slug AND source_id = p.source_id), 0) as input_tokens,
        COALESCE((SELECT SUM(output_tokens) FROM messages WHERE project_slug = p.slug AND source_id = p.source_id), 0) as output_tokens,
        COALESCE((SELECT SUM(cache_creation_tokens) FROM messages WHERE project_slug = p.slug AND source_id = p.source_id), 0) as cache_creation_tokens,
        COALESCE((SELECT SUM(cache_read_tokens) FROM messages WHERE project_slug = p.slug AND source_id = p.source_id), 0) as cache_read_tokens,
        COALESCE((SELECT MAX(tokens_estimated) FROM sessions WHERE project_slug = p.slug AND source_id = p.source_id), 0) as tokens_estimated,
        COALESCE((SELECT MAX(modified_at) FROM sessions WHERE project_slug = p.slug AND source_id = p.source_id), '1970-01-01') as last_active_at,
        COALESCE((SELECT MIN(created_at) FROM sessions WHERE project_slug = p.slug AND source_id = p.source_id), '1970-01-01') as first_active_at,
        (SELECT git_branch FROM sessions WHERE project_slug = p.slug AND source_id = p.source_id ORDER BY modified_at DESC LIMIT 1) as latest_git_branch,
        CASE
          WHEN p.source_id = 'claude-code'
          THEN EXISTS(SELECT 1 FROM project_memories WHERE project_slug = p.slug)
          ELSE 0
        END as has_memory
      FROM projects p
      ${where}
    `,
      ...params,
    );

    return rows.map((row) => this.toProjectSummary(row));
  }

  getSessionSummaries(projectSlug: string, options?: { sourceId?: string }): SessionSummaryData[] {
    const sourceClause = options?.sourceId ? ' AND s.source_id = ?' : '';
    const params: unknown[] = options?.sourceId ? [projectSlug, options.sourceId] : [projectSlug];
    const rows = this.db.all<SessionSummaryRow>(
      `
      SELECT
        s.id,
        s.source_id,
        s.project_slug,
        s.full_path,
        COALESCE(s.first_prompt, '') as first_prompt,
        COALESCE(s.summary, '') as summary,
        COALESCE(s.git_branch, '') as git_branch,
        COALESCE(s.project_path, '') as project_path,
        COALESCE(s.is_sidechain, 0) as is_sidechain,
        COALESCE(s.created_at, '1970-01-01') as created_at,
        COALESCE(s.modified_at, '1970-01-01') as modified_at,
        COALESCE((SELECT COUNT(*) FROM messages WHERE session_id = s.id AND project_slug = s.project_slug AND source_id = s.source_id), 0) as message_count,
        COALESCE((SELECT SUM(input_tokens) FROM messages WHERE session_id = s.id AND project_slug = s.project_slug AND source_id = s.source_id), 0) as input_tokens,
        COALESCE((SELECT SUM(output_tokens) FROM messages WHERE session_id = s.id AND project_slug = s.project_slug AND source_id = s.source_id), 0) as output_tokens,
        COALESCE((SELECT SUM(cache_creation_tokens) FROM messages WHERE session_id = s.id AND project_slug = s.project_slug AND source_id = s.source_id), 0) as cache_creation_tokens,
        COALESCE((SELECT SUM(cache_read_tokens) FROM messages WHERE session_id = s.id AND project_slug = s.project_slug AND source_id = s.source_id), 0) as cache_read_tokens,
        COALESCE(s.tokens_estimated, 0) as tokens_estimated,
        COALESCE((SELECT COUNT(*) FROM todos WHERE session_id = s.id), 0) as todo_count,
        s.plan_slug,
        COALESCE(s.has_task, 0) as has_task
      FROM sessions s
      WHERE s.project_slug = ?${sourceClause}
    `,
      ...params,
    );

    return rows.map((row) => this.toSessionSummary(row));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────────────────────

  getSessionMessages(
    slug: string,
    sessionId: string,
    limit: number,
    offset: number,
    options?: { sourceId?: string },
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean } {
    const sourceClause = options?.sourceId ? ' AND source_id = ?' : '';
    const baseParams: unknown[] = options?.sourceId ? [slug, sessionId, options.sourceId] : [slug, sessionId];

    const countRow = this.db.get<CountRow>(
      `SELECT COUNT(*) as count FROM messages WHERE project_slug = ? AND session_id = ?${sourceClause}`,
      ...baseParams,
    );
    const total = countRow?.count ?? 0;

    const rows = this.db.all<MessageDataRow>(
      `SELECT data FROM messages WHERE project_slug = ? AND session_id = ?${sourceClause} ORDER BY msg_index LIMIT ? OFFSET ?`,
      ...baseParams,
      limit,
      offset,
    );

    const messages = rows
      .map((r) => {
        try {
          return JSON.parse(r.data);
        } catch {
          return null;
        }
      })
      .filter((m) => m !== null);

    return {
      messages,
      total,
      offset,
      hasMore: offset + rows.length < total,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Subagents
  // ─────────────────────────────────────────────────────────────────────────

  getSessionSubagents(
    slug: string,
    sessionId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }> {
    // Top-level subagents only (workflow_id ''); workflow-nested ones are
    // surfaced under their run via getWorkflowSubagents.
    const rows = this.db.all<SubagentRow>(
      "SELECT agent_id, agent_type, message_count FROM subagents WHERE project_slug = ? AND session_id = ? AND workflow_id = '' ORDER BY agent_id",
      slug,
      sessionId,
    );
    return rows.map((r) => ({
      agentId: r.agent_id,
      agentType: r.agent_type,
      messageCount: r.message_count,
    }));
  }

  getSessionWorkflows(
    slug: string,
    sessionId: string,
  ): Array<{
    workflowId: string;
    name: string;
    status: string;
    agentCount: number;
    totalTokens: number;
    totalToolCalls: number;
    durationMs: number;
    subagentCount: number;
  }> {
    const rows = this.db.all<WorkflowRow>(
      'SELECT workflow_id, name, status, agent_count, total_tokens, total_tool_calls, duration_ms, subagent_count FROM workflows WHERE project_slug = ? AND session_id = ? ORDER BY workflow_id',
      slug,
      sessionId,
    );
    return rows.map((r) => ({
      workflowId: r.workflow_id,
      name: r.name,
      status: r.status,
      agentCount: r.agent_count,
      totalTokens: r.total_tokens,
      totalToolCalls: r.total_tool_calls,
      durationMs: r.duration_ms,
      subagentCount: r.subagent_count,
    }));
  }

  getWorkflowSubagents(
    slug: string,
    sessionId: string,
    workflowId: string,
  ): Array<{ agentId: string; agentType: string; messageCount: number }> {
    const rows = this.db.all<SubagentRow>(
      'SELECT agent_id, agent_type, message_count FROM subagents WHERE project_slug = ? AND session_id = ? AND workflow_id = ? ORDER BY agent_id',
      slug,
      sessionId,
      workflowId,
    );
    return rows.map((r) => ({
      agentId: r.agent_id,
      agentType: r.agent_type,
      messageCount: r.message_count,
    }));
  }

  getSubagentMessages(
    slug: string,
    sessionId: string,
    agentId: string,
    limit: number,
    offset: number,
  ): { messages: unknown[]; total: number; offset: number; hasMore: boolean } {
    const row = this.db.get<SubagentMessagesRow>(
      'SELECT messages FROM subagents WHERE project_slug = ? AND session_id = ? AND agent_id = ?',
      slug,
      sessionId,
      agentId,
    );

    if (!row) {
      return { messages: [], total: 0, offset, hasMore: false };
    }

    let allMessages: unknown[];
    try {
      allMessages = JSON.parse(row.messages) as unknown[];
    } catch {
      allMessages = [];
    }

    const total = allMessages.length;
    const paged = allMessages.slice(offset, offset + limit);

    return {
      messages: paged,
      total,
      offset,
      hasMore: offset + paged.length < total,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Details
  // ─────────────────────────────────────────────────────────────────────────

  getProjectMemory(slug: string, options?: { sourceId?: string }): string | null {
    // project_memories is Claude-only today (no source_id column). Never
    // surface Claude's MEMORY.md under a non-Claude project that happens to
    // share the same slug.
    if (options?.sourceId && options.sourceId !== 'claude-code') {
      return null;
    }
    const row = this.db.get<MemoryRow>('SELECT content FROM project_memories WHERE project_slug = ?', slug);
    return row?.content ?? null;
  }

  getSessionTodos(slug: string, sessionId: string): unknown[] {
    // slug unused in todos table — match by session_id
    void slug;
    const rows = this.db.all<TodoRow>('SELECT items FROM todos WHERE session_id = ?', sessionId);
    const result: unknown[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.items);
        result.push(parsed);
      } catch {
        // skip bad todo JSON
      }
    }
    return result;
  }

  getSessionPlan(slug: string, sessionId: string): unknown | null {
    // Look up the session's plan_slug, then fetch the plan
    void slug;
    const sessionRow = this.db.get<{ plan_slug: string | null }>(
      'SELECT plan_slug FROM sessions WHERE id = ?',
      sessionId,
    );
    if (!sessionRow?.plan_slug) return null;

    const planRow = this.db.get<PlanRow>(
      'SELECT slug, title, content, size FROM plans WHERE slug = ?',
      sessionRow.plan_slug,
    );
    if (!planRow) return null;
    return { slug: planRow.slug, title: planRow.title, content: planRow.content, size: planRow.size };
  }

  getSessionTask(slug: string, sessionId: string): unknown | null {
    void slug;
    const row = this.db.get<TaskRow>(
      'SELECT session_id, has_highwatermark, highwatermark, lock_exists FROM tasks WHERE session_id = ?',
      sessionId,
    );
    if (!row) return null;
    return {
      taskId: row.session_id,
      hasHighwatermark: !!row.has_highwatermark,
      highwatermark: row.highwatermark,
      lockExists: !!row.lock_exists,
    };
  }

  getToolResult(slug: string, sessionId: string, toolUseId: string): string | null {
    const row = this.db.get<ToolResultRow>(
      'SELECT content FROM tool_results WHERE project_slug = ? AND session_id = ? AND tool_use_id = ?',
      slug,
      sessionId,
      toolUseId,
    );
    return row?.content ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────

  search(query: SearchQuery): SearchResultSet {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    // Build the FTS5 MATCH expression
    const matchExpr = escapeFts5(query.text);

    // Build WHERE clauses for additional filters (applied as JOIN conditions)
    const whereParts: string[] = [];
    const whereParams: unknown[] = [];

    if (query.projectSlug) {
      whereParts.push('m.project_slug = ?');
      whereParams.push(query.projectSlug);
    }
    if (query.sessionId) {
      whereParts.push('m.session_id = ?');
      whereParams.push(query.sessionId);
    }
    if (query.type) {
      whereParts.push('m.msg_type = ?');
      whereParams.push(query.type);
    }

    const whereClause = whereParts.length > 0 ? `AND ${whereParts.join(' AND ')}` : '';

    // Count query
    const countRow = this.db.get<CountRow>(
      `SELECT COUNT(*) as count
       FROM search_fts
       JOIN messages m ON m.id = search_fts.rowid
       WHERE search_fts MATCH ? ${whereClause}`,
      matchExpr,
      ...whereParams,
    );
    const total = countRow?.count ?? 0;

    // Result query
    const rows = this.db.all<SearchFtsRow>(
      `SELECT m.project_slug, m.session_id, m.msg_index,
              snippet(search_fts, 0, '<b>', '</b>', '...', 64) as snippet,
              rank
       FROM search_fts
       JOIN messages m ON m.id = search_fts.rowid
       WHERE search_fts MATCH ? ${whereClause}
       ORDER BY rank
       LIMIT ? OFFSET ?`,
      matchExpr,
      ...whereParams,
      limit,
      offset,
    );

    return {
      results: rows.map((row) => ({
        key: `message:${row.project_slug}/${row.session_id}/${row.msg_index}`,
        type: 'message' as const,
        snippet: row.snippet,
        rank: row.rank,
        projectSlug: row.project_slug || undefined,
        sessionId: row.session_id || undefined,
      })),
      total,
      hasMore: offset + rows.length < total,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────

  getStats(): StoreStats {
    const tables = ['projects', 'sessions', 'messages', 'subagents', 'tool_results', 'todos', 'tasks', 'plans'];
    const segmentsByType: Record<string, number> = {};
    let totalSegments = 0;

    for (const table of tables) {
      const row = this.db.get<CountRow>(`SELECT COUNT(*) as count FROM ${table}`);
      const count = row?.count ?? 0;
      segmentsByType[table] = count;
      totalSegments += count;
    }

    const fpRow = this.db.get<CountRow>('SELECT COUNT(*) as count FROM source_files');
    const totalFingerprints = fpRow?.count ?? 0;

    const ftsRow = this.db.get<CountRow>('SELECT COUNT(*) as count FROM search_fts');
    const searchIndexed = ftsRow?.count ?? 0;

    const dbSizeBytes = this.db.getFileSize();

    return {
      totalSegments,
      segmentsByType,
      totalFingerprints,
      dbSizeBytes,
      searchIndexed,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private toProjectSummary(row: ProjectSummaryRow): ProjectSummaryData {
    const originalPath = row.original_path ?? '';
    const parts = originalPath.split(/[\\/]/);
    const folderName = parts[parts.length - 1] || row.slug;

    const tokenUsage: TokenUsageSummary = {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    };

    return {
      slug: row.slug,
      sourceId: row.source_id,
      folderName,
      absolutePath: originalPath,
      sessionCount: row.session_count,
      messageCount: row.message_count,
      tokenUsage,
      tokensEstimated: !!row.tokens_estimated,
      lastActiveAt: row.last_active_at,
      firstActiveAt: row.first_active_at,
      latestGitBranch: row.latest_git_branch ?? '',
      hasMemory: !!row.has_memory,
    };
  }

  private toSessionSummary(row: SessionSummaryRow): SessionSummaryData {
    const createdAt = row.created_at || '1970-01-01';
    const modifiedAt = row.modified_at || '1970-01-01';

    let lifespanMs = 0;
    try {
      const start = new Date(createdAt).getTime();
      const end = new Date(modifiedAt).getTime();
      if (!isNaN(start) && !isNaN(end)) {
        lifespanMs = Math.max(0, end - start);
      }
    } catch {
      // ignore date parsing errors
    }

    const tokenUsage: TokenUsageSummary = {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    };

    return {
      sessionId: row.id,
      sourceId: row.source_id,
      projectSlug: row.project_slug,
      startTime: createdAt,
      lastUpdate: modifiedAt,
      lifespanMs,
      tokenUsage,
      tokensEstimated: !!row.tokens_estimated,
      messageCount: row.message_count,
      fullPath: row.full_path ?? '',
      summary: row.summary ?? '',
      firstPrompt: row.first_prompt ?? '',
      gitBranch: row.git_branch ?? '',
      todoCount: row.todo_count,
      planSlug: row.plan_slug ?? null,
      hasTask: !!row.has_task,
      isSidechain: !!row.is_sidechain,
    };
  }
}

function escapeFts5(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createQueryService(sqliteServiceFactory: () => SqliteService): QueryService {
  return new QueryServiceImpl(sqliteServiceFactory);
}
