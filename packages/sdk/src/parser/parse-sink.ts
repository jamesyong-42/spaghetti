/**
 * ProjectParseSink — Callback interface for streaming project parsing
 *
 * Instead of building a monolithic in-memory tree, the parser calls these
 * methods as it discovers each piece of data, allowing consumers (e.g. SQLite
 * ingest) to process data incrementally during parsing.
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
} from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

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
