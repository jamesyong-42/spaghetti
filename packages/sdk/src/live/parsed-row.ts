/**
 * ParsedRow — generic write-batch row contract (Plane 2 → IngestService).
 *
 * Shared by Claude's incremental parser and the thinner Codex/Grok live
 * watchers. Category variants mirror what `IngestService.writeBatch` accepts;
 * product-specific *parsing* of those rows lives under each source.
 */

import type {
  SessionMessage,
  SessionsIndex,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
} from '../types/index.js';

/**
 * Category tags for a live write batch. Claude populates the full set;
 * Codex/Grok typically only emit `message` (and invent session parents
 * via onProject/onSession outside this union).
 */
export type ParsedRowCategory =
  | 'message'
  | 'subagent'
  | 'tool_result'
  | 'file_history'
  | 'todo'
  | 'task'
  | 'plan'
  | 'project_memory'
  | 'session_index';

/**
 * Discriminated union of rows destined for `IngestService.writeBatch`.
 * Each variant maps 1:1 onto an `onX` sink method.
 */
export type ParsedRow =
  | {
      category: 'message';
      slug: string;
      sessionId: string;
      message: SessionMessage;
      msgIndex: number;
      byteOffset: number;
    }
  | {
      category: 'subagent';
      slug: string;
      sessionId: string;
      transcript: SubagentTranscript;
    }
  | {
      category: 'tool_result';
      slug: string;
      sessionId: string;
      result: PersistedToolResult;
    }
  | {
      category: 'file_history';
      sessionId: string;
      history: FileHistorySession;
    }
  | {
      category: 'todo';
      sessionId: string;
      todo: TodoFile;
    }
  | {
      category: 'task';
      sessionId: string;
      task: TaskEntry;
    }
  | {
      category: 'plan';
      slug: string;
      plan: PlanFile;
    }
  | {
      category: 'project_memory';
      slug: string;
      content: string;
    }
  | {
      category: 'session_index';
      slug: string;
      originalPath: string;
      sessionsIndex: SessionsIndex;
    };
