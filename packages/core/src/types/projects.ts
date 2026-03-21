/**
 * TypeScript interfaces for all data structures found in:
 *   ~/.claude/projects/
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS INDEX
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionsIndex {
  version: number;
  originalPath?: string;
  entries: SessionIndexEntry[];
}

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION JSONL — BASE MESSAGE
// ═══════════════════════════════════════════════════════════════════════════════

export interface BaseMessageFields {
  type: SessionMessageType;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: 'external';
  slug?: string;
  permissionMode?: string;
  entrypoint?: string;
}

export type SessionMessageType =
  | 'file-history-snapshot'
  | 'progress'
  | 'saved_hook_context'
  | 'user'
  | 'assistant'
  | 'system'
  | 'summary'
  | 'queue-operation'
  | 'last-prompt';

export type SessionMessage =
  | FileHistorySnapshotMessage
  | ProgressMessage
  | SavedHookContextMessage
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | SummaryMessage
  | QueueOperationMessage
  | LastPromptMessage;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: file-history-snapshot
// ═══════════════════════════════════════════════════════════════════════════════

export interface FileHistorySnapshotMessage {
  type: 'file-history-snapshot';
  messageId: string;
  isSnapshotUpdate: boolean;
  snapshot: FileHistorySnapshot;
}

export interface FileHistorySnapshot {
  messageId: string;
  timestamp: string;
  trackedFileBackups: Record<string, FileBackupEntry>;
}

export interface FileBackupEntry {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: user
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserMessage extends BaseMessageFields {
  type: 'user';
  message: UserMessagePayload;
  thinkingMetadata?: ThinkingMetadata;
  todos?: TodoItem[];
  permissionMode?: string;
  toolUseResult?: string | ToolUseResultObject;
  sourceToolAssistantUUID?: string;
  sourceToolUseID?: string;
  agentId?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  planContent?: string;
  promptId?: string;
  imagePasteIds?: string[];
  teamName?: string;
}

export interface UserMessagePayload {
  role: 'user';
  content: string | UserContentBlock[];
}

export interface ThinkingMetadata {
  level?: string;
  disabled?: boolean;
  triggers?: string[];
  maxThinkingTokens?: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type UserContentBlock = ToolResultBlock | UserTextBlock | DocumentBlock | ImageBlock;

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
}

export interface UserTextBlock {
  type: 'text';
  text: string;
}

export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ToolUseResultObject {
  type: 'text';
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: assistant
// ═══════════════════════════════════════════════════════════════════════════════

export interface AssistantMessage extends BaseMessageFields {
  type: 'assistant';
  requestId: string;
  message: AssistantMessagePayload;
  agentId?: string;
  error?: string;
  isApiErrorMessage?: boolean;
  apiError?: string;
  teamName?: string;
}

export interface AssistantMessagePayload {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'stop_sequence' | 'max_tokens' | null;
  stop_sequence: string | null;
  usage: TokenUsage;
  context_management?: ContextManagement | null;
  container?: unknown;
}

export type AssistantContentBlock = ThinkingBlock | RedactedThinkingBlock | AssistantTextBlock | ToolUseBlock;

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface AssistantTextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

export type ToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Glob'
  | 'Grep'
  | 'Bash'
  | 'Task'
  | 'TodoWrite'
  | 'TaskCreate'
  | 'TaskUpdate'
  | 'TaskList'
  | 'TaskOutput'
  | 'TaskStop'
  | 'WebSearch'
  | 'WebFetch'
  | 'NotebookEdit'
  | 'AskUserQuestion'
  | 'EnterPlanMode'
  | 'ExitPlanMode'
  | 'Skill'
  | 'KillShell'
  | 'Agent'
  | 'ToolSearch'
  | 'EnterWorktree'
  | 'ExitWorktree'
  | 'SendMessage'
  | 'CronCreate'
  | 'CronDelete'
  | 'CronList'
  | 'LSP'
  | 'TeamCreate'
  | 'TeamDelete'
  | 'TaskGet'
  | `mcp__${string}`;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier: string | null;
  inference_geo?: string;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
}

export interface ContextManagement {
  applied_edits: unknown[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: system
// ═══════════════════════════════════════════════════════════════════════════════

export type SystemMessage =
  | StopHookSummarySystemMessage
  | TurnDurationSystemMessage
  | ApiErrorSystemMessage
  | CompactBoundarySystemMessage
  | MicrocompactBoundarySystemMessage
  | LocalCommandSystemMessage
  | BridgeStatusSystemMessage;

interface SystemMessageBase extends BaseMessageFields {
  type: 'system';
  level?: 'info' | 'error' | 'suggestion';
  isMeta?: boolean;
}

export interface StopHookSummarySystemMessage extends SystemMessageBase {
  subtype: 'stop_hook_summary';
  hookCount: number;
  hookInfos: Array<{ command: string }>;
  hookErrors: unknown[];
  preventedContinuation: boolean;
  stopReason: string;
  hasOutput: boolean;
  toolUseID: string;
}

export interface TurnDurationSystemMessage extends SystemMessageBase {
  subtype: 'turn_duration';
  durationMs: number;
}

export interface ApiErrorSystemMessage extends SystemMessageBase {
  subtype: 'api_error';
  cause: Record<string, unknown>;
  error: { cause: Record<string, unknown> };
  retryInMs: number;
  retryAttempt: number;
  maxRetries: number;
}

export interface CompactBoundarySystemMessage extends SystemMessageBase {
  subtype: 'compact_boundary';
  content: string;
  logicalParentUuid: string;
  compactMetadata: {
    trigger: string;
    preTokens: number;
  };
}

export interface MicrocompactBoundarySystemMessage extends SystemMessageBase {
  subtype: 'microcompact_boundary';
  content: string;
  microcompactMetadata: {
    trigger: string;
    preTokens: number;
    tokensSaved: number;
    compactedToolIds: string[];
  };
}

export interface LocalCommandSystemMessage extends SystemMessageBase {
  subtype: 'local_command';
  content: string;
}

export interface BridgeStatusSystemMessage extends SystemMessageBase {
  subtype: 'bridge_status';
  url?: string;
  content?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: progress
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProgressMessage extends BaseMessageFields {
  type: 'progress';
  data: ProgressData;
  toolUseID: string;
  parentToolUseID: string;
  agentId?: string;
  teamName?: string;
}

export type ProgressData =
  | HookProgressData
  | BashProgressData
  | AgentProgressData
  | McpProgressData
  | QueryUpdateData
  | SearchResultsReceivedData
  | WaitingForTaskData;

export interface HookProgressData {
  type: 'hook_progress';
  hookEvent: string;
  hookName: string;
  command: string;
}

export interface BashProgressData {
  type: 'bash_progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
}

export interface AgentProgressData {
  type: 'agent_progress';
  agentId: string;
  prompt: string;
  normalizedMessages: unknown[];
  message: {
    type: 'user' | 'assistant';
    uuid: string;
    timestamp: string;
    message: UserMessagePayload | AssistantMessagePayload;
    toolUseResult?: string;
    requestId?: string;
  };
}

export interface McpProgressData {
  type: 'mcp_progress';
  serverName: string;
  toolName: string;
  status: 'started' | 'completed';
  elapsedTimeMs?: number;
}

export interface QueryUpdateData {
  type: 'query_update';
  query: string;
}

export interface SearchResultsReceivedData {
  type: 'search_results_received';
  query: string;
  resultCount: number;
}

export interface WaitingForTaskData {
  type: 'waiting_for_task';
  taskDescription: string;
  taskType: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: saved_hook_context
// ═══════════════════════════════════════════════════════════════════════════════

export interface SavedHookContextMessage extends BaseMessageFields {
  type: 'saved_hook_context';
  content: string[];
  hookName: string;
  hookEvent: string;
  toolUseID: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: summary
// ═══════════════════════════════════════════════════════════════════════════════

export interface SummaryMessage {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: queue-operation
// ═══════════════════════════════════════════════════════════════════════════════

export interface QueueOperationMessage {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'popAll' | 'remove';
  timestamp: string;
  sessionId: string;
  content?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBAGENT MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SubagentMessage extends BaseMessageFields {
  agentId: string;
  isSidechain: true;
}

export type SubagentType = 'task' | 'prompt_suggestion' | 'compact';

// ═══════════════════════════════════════════════════════════════════════════════
// THREADING MODEL
// ═══════════════════════════════════════════════════════════════════════════════

export interface MessageThread {
  messages: SessionMessage[];
  rootUuid: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL RESULTS (on-disk)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PersistedToolResult {
  toolUseId: string;
  content: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT MEMORY (on-disk)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProjectMemory {
  projectSlug: string;
  content: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE: last-prompt
// ═══════════════════════════════════════════════════════════════════════════════

export interface LastPromptMessage extends BaseMessageFields {
  type: 'last-prompt';
  lastPrompt: string;
}
