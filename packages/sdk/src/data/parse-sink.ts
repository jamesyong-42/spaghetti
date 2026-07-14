/**
 * ProjectParseSink — callback interface for streaming project/session ingest.
 *
 * Shared write contract (not agent-specific): Claude's project parser, Codex's
 * reader, and IngestService all speak this surface so product parsers stay
 * under `sources/` while the writer lives in `data/`.
 */

import type {
  SessionsIndex,
  SessionIndexEntry,
  SessionMessage,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
  WorkflowRun,
} from '../types/index.js';

export interface ProjectParseSink {
  /** Called when a project directory is discovered with its sessions index. */
  onProject(slug: string, originalPath: string, sessionsIndex: SessionsIndex): void;

  /** Called when a project's MEMORY.md file is found. */
  onProjectMemory(slug: string, content: string): void;

  /** Called for each session index entry within a project. */
  onSession(slug: string, entry: SessionIndexEntry): void;

  /** Called for each message line parsed from a session JSONL file. */
  onMessage(slug: string, sessionId: string, message: SessionMessage, index: number, byteOffset: number): void;

  /** Called for each subagent transcript found in a session directory. */
  onSubagent(slug: string, sessionId: string, transcript: SubagentTranscript): void;

  /** Called for each workflow run found in a session's `workflows/` dir. */
  onWorkflow(slug: string, sessionId: string, workflow: WorkflowRun): void;

  /** Called for each persisted tool result found in a session directory. */
  onToolResult(slug: string, sessionId: string, toolResult: PersistedToolResult): void;

  /** Called when file history snapshots are found for a session. */
  onFileHistory(sessionId: string, history: FileHistorySession): void;

  /** Called for each todo file associated with a session. */
  onTodo(sessionId: string, todo: TodoFile): void;

  /** Called when a task entry is found for a session. */
  onTask(sessionId: string, task: TaskEntry): void;

  /** Called for each plan file discovered in the plans directory. */
  onPlan(slug: string, plan: PlanFile): void;

  /** Called after all messages for a session have been streamed. */
  onSessionComplete(slug: string, sessionId: string, messageCount: number, lastBytePosition: number): void;

  /** Called after all sessions for a project have been processed. */
  onProjectComplete(slug: string): void;
}
