// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS — all leaf types from each data module
// ═══════════════════════════════════════════════════════════════════════════════

export * from './projects.js';
export * from './tasks.js';
export * from './todos.js';
export * from './debug.js';
export * from './session-env.js';
export * from './file-history-data.js';
export * from './plans-data.js';
export * from './shell-snapshots-data.js';
export * from './paste-cache-data.js';
export * from './plugins-data.js';
export * from './telemetry-data.js';
export * from './statsig-data.js';
export * from './ide-data.js';
export * from './cache-data.js';
export * from './toplevel-files-data.js';
export * from './teams-data.js';
export * from './backups-data.js';
export * from './hook-events.js';
export * from './channel-messages.js';

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTS — types used by aggregation interfaces below
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  SessionsIndex,
  SessionIndexEntry,
  SessionMessage,
  SubagentType,
  PersistedToolResult,
  ProjectMemory,
} from './projects.js';
import type { FileHistorySession } from './file-history-data.js';
import type { TodoFile } from './todos.js';
import type { TaskEntry } from './tasks.js';
import type { PlanFile } from './plans-data.js';

import type { SettingsFile, StatusLineCommandFile, StatsCacheFile, HistoryFile } from './toplevel-files-data.js';
import type { PluginsDirectory } from './plugins-data.js';
import type { StatsigDirectory } from './statsig-data.js';
import type { IdeDirectory } from './ide-data.js';
import type { ShellSnapshotsDirectory } from './shell-snapshots-data.js';
import type { CacheDirectory } from './cache-data.js';
import type { TelemetryDirectory } from './telemetry-data.js';
import type { DebugLogFile, DebugLatestSymlink } from './debug.js';
import type { PasteCacheDirectory } from './paste-cache-data.js';
import type { SessionEnvDirectory } from './session-env.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE CODE AGENT — top-level aggregation
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeAgentData {
  projects: Project[];
  config: AgentConfig;
  analytics: AgentAnalytic;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT
// ═══════════════════════════════════════════════════════════════════════════════

export interface Project {
  slug: string;
  originalPath: string;
  sessionsIndex: SessionsIndex;
  sessions: Session[];
  memory: ProjectMemory | null;
}

export interface Session {
  sessionId: string;
  indexEntry: SessionIndexEntry;
  messages: SessionMessage[];
  subagents: SubagentTranscript[];
  toolResults: PersistedToolResult[];
  fileHistory: FileHistorySession | null;
  todos: TodoFile[];
  task: TaskEntry | null;
  plan: PlanFile | null;
}

/** Subagent metadata from agent-{id}.meta.json files */
export interface SubagentMeta {
  agentType: string;
  description: string;
}

export interface SubagentTranscript {
  agentId: string;
  agentType: SubagentType;
  fileName: string;
  messages: SessionMessage[];
  meta?: SubagentMeta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentConfig {
  settings: SettingsFile;
  plugins: PluginsDirectory;
  statsig: StatsigDirectory;
  ide: IdeDirectory;
  shellSnapshots: ShellSnapshotsDirectory;
  cache: CacheDirectory;
  statusLineCommand: StatusLineCommandFile | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT ANALYTIC
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentAnalytic {
  statsCache: StatsCacheFile;
  history: HistoryFile;
  telemetry: TelemetryDirectory;
  debugLogs: DebugLogFile[];
  debugLatest: DebugLatestSymlink | null;
  pasteCache: PasteCacheDirectory;
  sessionEnv: SessionEnvDirectory;
}
