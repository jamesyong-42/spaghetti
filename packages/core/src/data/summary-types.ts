/**
 * Summary Types — Aggregated token usage and summary data
 */

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface SessionSummaryData {
  sessionId: string;
  projectSlug: string;
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

export interface ProjectSummaryData {
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
