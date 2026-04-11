/**
 * TypeScript interfaces for top-level files in ~/.claude/
 */

export interface StatusLineConfig {
  type: string;
  command?: string;
}

export interface PermissionsConfig {
  allow: string[];
}

export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ExtraKnownMarketplace {
  source: {
    source: string;
    repo?: string;
    path?: string;
  };
}

export interface SettingsFile {
  permissions: PermissionsConfig;
  effortLevel?: string;
  enabledPlugins?: Record<string, boolean>;
  alwaysThinkingEnabled?: boolean;
  statusLine?: StatusLineConfig;
  env?: Record<string, string>;
  cleanupPeriodDays?: number;
  extraKnownMarketplaces?: Record<string, ExtraKnownMarketplace>;
  hooks?: Record<string, HookMatcher[]>;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface LongestSession {
  sessionId: string;
  duration: number;
  messageCount: number;
  timestamp: string;
}

export interface StatsCacheFile {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, ModelUsageStats>;
  totalSessions: number;
  totalMessages: number;
  longestSession: LongestSession;
  firstSessionDate: string;
  hourCounts: Record<string, number>;
  totalSpeculationTimeSavedMs: number;
}

export interface HistoryPastedContent {
  id: number;
  type: string;
  content: string;
}

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, HistoryPastedContent>;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface HistoryFile {
  entries: HistoryEntry[];
}

export interface StatusLineCommandFile {
  content: string;
  size: number;
}

/** ~/.claude/mcp-needs-auth-cache.json */
export interface McpNeedsAuthCache {
  [serverName: string]: { timestamp: number };
}

/** ~/.claude/sessions/{PID}.json — maps running PIDs to session IDs */
export interface ActiveSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
  name?: string;
}

export interface TopLevelFiles {
  settings: SettingsFile;
  statsCache: StatsCacheFile;
  history: HistoryFile;
  statusLineCommand?: StatusLineCommandFile;
}
