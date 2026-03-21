/**
 * AppService — Frontend-ready API wrapping the data service
 *
 * Adapted from ClaudeCodeAppService. Implements SpaghettiAPI.
 */

import { EventEmitter } from 'events';
import type {
  SpaghettiAPI,
  ProjectListItem,
  SessionListItem,
  MessagePage,
  SubagentListItem,
  SubagentMessagePage,
} from './api.js';
import type { ClaudeCodeAgentDataService } from './data/agent-data-service.js';
import type { SearchQuery, SearchResultSet, StoreStats, InitProgress, SegmentChangeBatch } from './data/segment-types.js';
import type { SessionSummaryData, ProjectSummaryData } from './data/summary-types.js';

class SpaghettiAppService extends EventEmitter implements SpaghettiAPI {
  private dataService: ClaudeCodeAgentDataService;

  constructor(dataService: ClaudeCodeAgentDataService) {
    super();
    this.dataService = dataService;

    this.dataService.on('progress', (data) => this.emit('progress', data));
    this.dataService.on('ready', (data) => this.emit('ready', data));
    this.dataService.on('change', (data) => this.emit('change', data));
    this.dataService.on('error', (data) => this.emit('error', data));
  }

  async initialize(): Promise<void> {
    await this.dataService.initialize();
  }

  shutdown(): void {
    this.dataService.shutdown();
  }

  isReady(): boolean {
    return this.dataService.isReady();
  }

  getProjectList(): ProjectListItem[] {
    const summaries = this.dataService.getProjectSummaries();
    summaries.sort((a, b) => (a.lastActiveAt > b.lastActiveAt ? -1 : 1));
    return summaries.map(toProjectListItem);
  }

  getSessionList(projectSlug: string): SessionListItem[] {
    const summaries = this.dataService.getSessionSummaries(projectSlug);
    summaries.sort((a, b) => (a.lastUpdate > b.lastUpdate ? -1 : 1));
    return summaries.map(toSessionListItem);
  }

  getSessionMessages(projectSlug: string, sessionId: string, limit = 30, offset = 0): MessagePage {
    const result = this.dataService.getSessionMessages(projectSlug, sessionId, limit, offset);
    return {
      messages: result.segments.map((s) => s.data),
      total: result.total,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  getProjectMemory(projectSlug: string): string | null {
    return this.dataService.getProjectMemory(projectSlug);
  }

  getSessionTodos(projectSlug: string, sessionId: string): unknown[] {
    return this.dataService.getSessionTodos(projectSlug, sessionId);
  }

  getSessionPlan(projectSlug: string, sessionId: string): unknown | null {
    return this.dataService.getSessionPlan(projectSlug, sessionId);
  }

  getSessionTask(projectSlug: string, sessionId: string): unknown | null {
    return this.dataService.getSessionTask(projectSlug, sessionId);
  }

  getToolResult(projectSlug: string, sessionId: string, toolUseId: string): string | null {
    return this.dataService.getPersistedToolResult(projectSlug, sessionId, toolUseId);
  }

  getSessionSubagents(projectSlug: string, sessionId: string): SubagentListItem[] {
    return this.dataService.getSessionSubagents(projectSlug, sessionId);
  }

  getSubagentMessages(projectSlug: string, sessionId: string, agentId: string, limit = 30, offset = 0): SubagentMessagePage {
    const result = this.dataService.getSubagentMessages(projectSlug, sessionId, agentId, limit, offset);
    return {
      messages: result.segments.map((s) => s.data),
      total: result.total,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  search(query: SearchQuery): SearchResultSet {
    return this.dataService.search(query);
  }

  getStats(): StoreStats {
    return this.dataService.getStoreStats();
  }

  onProgress(cb: (progress: InitProgress) => void): () => void {
    this.on('progress', cb);
    return () => this.removeListener('progress', cb);
  }

  onReady(cb: (info: { durationMs: number }) => void): () => void {
    this.on('ready', cb);
    return () => this.removeListener('ready', cb);
  }

  onChange(cb: (batch: SegmentChangeBatch) => void): () => void {
    this.on('change', cb);
    return () => this.removeListener('change', cb);
  }
}

function toProjectListItem(data: ProjectSummaryData): ProjectListItem {
  return {
    slug: data.slug,
    folderName: data.folderName,
    absolutePath: data.absolutePath,
    sessionCount: data.sessionCount,
    messageCount: data.messageCount,
    tokenUsage: data.tokenUsage,
    lastActiveAt: data.lastActiveAt,
    firstActiveAt: data.firstActiveAt,
    latestGitBranch: data.latestGitBranch,
    hasMemory: data.hasMemory,
  };
}

function toSessionListItem(data: SessionSummaryData): SessionListItem {
  return {
    sessionId: data.sessionId,
    startTime: data.startTime,
    lastUpdate: data.lastUpdate,
    lifespanMs: data.lifespanMs,
    tokenUsage: data.tokenUsage,
    messageCount: data.messageCount,
    fullPath: data.fullPath,
    summary: data.summary,
    firstPrompt: data.firstPrompt,
    gitBranch: data.gitBranch,
    todoCount: data.todoCount,
    planSlug: data.planSlug,
    hasTask: data.hasTask,
    isSidechain: data.isSidechain,
  };
}

export function createSpaghettiAppService(dataService: ClaudeCodeAgentDataService): SpaghettiAPI {
  return new SpaghettiAppService(dataService);
}
