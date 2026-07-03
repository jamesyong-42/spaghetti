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
import type { TeamDirectory } from './teams-data.js';

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
  workflows: WorkflowRun[];
}

/**
 * One agent-orchestration workflow run (the Workflow tool), recorded at
 * `projects/{slug}/{sessionId}/workflows/{runId}.json`. Session-scoped.
 * Its subagent transcripts live under
 * `subagents/workflows/{runId}/agent-*.jsonl` and are grouped to this
 * run via `SubagentTranscript.workflowId`.
 */
export interface WorkflowRun {
  /** `wf_...` — the run id (matches the `workflows/` dir entry name). */
  workflowId: string;
  name: string;
  status: string;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number;
  /** Number of nested subagent transcripts discovered for this run. */
  subagentCount: number;
  /** The full raw `{runId}.json` run record (phases/result/progress/logs/...). */
  data: Record<string, unknown>;
  /** Parsed `journal.jsonl` entries (started/result events), if present. */
  journal: unknown[];
}

/** Subagent metadata from agent-{id}.meta.json files */
export interface SubagentMeta {
  agentType: string;
  description: string;
  worktreePath?: string;
}

export interface SubagentTranscript {
  agentId: string;
  agentType: SubagentType;
  fileName: string;
  messages: SessionMessage[];
  meta?: SubagentMeta;
  /**
   * The `wf_...` run this transcript belongs to, or `''` for a
   * top-level (non-workflow) subagent. Groups nested workflow
   * transcripts under their run.
   */
  workflowId: string;
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
  teams: TeamDirectory[];
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
