/**
 * Worker Types — Shared message types between main thread and workers
 *
 * Workers parse JSONL files and send pre-extracted data to the main thread.
 * The main thread handles all SQLite writes (single-writer constraint).
 */

// ═══════════════════════════════════════════════════════════════════════════
// MAIN THREAD → WORKER MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkerParseRequest {
  type: 'parse-project';
  claudeDir: string;
  slug: string;
}

export interface WorkerShutdownRequest {
  type: 'shutdown';
}

export type MainToWorkerMessage = WorkerParseRequest | WorkerShutdownRequest;

// ═══════════════════════════════════════════════════════════════════════════
// WORKER → MAIN THREAD MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkerProjectResult {
  type: 'project-result';
  slug: string;
  originalPath: string;
  sessionsIndexJson: string;
}

export interface WorkerProjectMemoryResult {
  type: 'project-memory';
  slug: string;
  content: string;
}

export interface WorkerSessionResult {
  type: 'session-result';
  slug: string;
  sessionId: string;
  indexEntryJson: string;
}

export interface WorkerMessageBatch {
  type: 'message-batch';
  slug: string;
  sessionId: string;
  messages: string[];
  startIndex: number;
  byteOffsets: number[];
}

export interface WorkerSubagentResult {
  type: 'subagent-result';
  slug: string;
  sessionId: string;
  agentId: string;
  agentType: string;
  fileName: string;
  messagesJson: string;
  messageCount: number;
}

export interface WorkerToolResultResult {
  type: 'tool-result';
  slug: string;
  sessionId: string;
  toolUseId: string;
  content: string;
}

export interface WorkerFileHistoryResult {
  type: 'file-history';
  sessionId: string;
  dataJson: string;
}

export interface WorkerTodoResult {
  type: 'todo-result';
  sessionId: string;
  agentId: string;
  itemsJson: string;
}

export interface WorkerTaskResult {
  type: 'task-result';
  sessionId: string;
  taskJson: string;
}

export interface WorkerPlanResult {
  type: 'plan-result';
  slug: string;
  title: string;
  content: string;
  size: number;
}

export interface WorkerSessionComplete {
  type: 'session-complete';
  slug: string;
  sessionId: string;
  messageCount: number;
  lastBytePosition: number;
}

export interface WorkerProjectComplete {
  type: 'project-complete';
  slug: string;
  durationMs: number;
}

export interface WorkerError {
  type: 'worker-error';
  slug: string;
  error: string;
}

export type WorkerToMainMessage =
  | WorkerProjectResult
  | WorkerProjectMemoryResult
  | WorkerSessionResult
  | WorkerMessageBatch
  | WorkerSubagentResult
  | WorkerToolResultResult
  | WorkerFileHistoryResult
  | WorkerTodoResult
  | WorkerTaskResult
  | WorkerPlanResult
  | WorkerSessionComplete
  | WorkerProjectComplete
  | WorkerError;
