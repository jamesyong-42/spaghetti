/**
 * Hook Event Types — type definitions for Claude Code hook events
 * captured by the spaghetti-hooks plugin.
 */

// ─── Hook Event Names (all 26) ───────────────────────────────────────────

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Stop'
  | 'StopFailure'
  | 'TeammateIdle'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'CwdChanged'
  | 'FileChanged'
  | 'PreCompact'
  | 'PostCompact'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'Elicitation'
  | 'ElicitationResult';

// ─── Categories ──────────────────────────────────────────────────────────

export type HookEventCategory = 'lifecycle' | 'input' | 'tool' | 'agent' | 'task' | 'config' | 'system' | 'mcp';

export const HOOK_EVENT_CATEGORIES: Record<HookEventName, HookEventCategory> = {
  SessionStart: 'lifecycle',
  SessionEnd: 'lifecycle',
  Stop: 'lifecycle',
  StopFailure: 'lifecycle',
  PreCompact: 'lifecycle',
  PostCompact: 'lifecycle',
  UserPromptSubmit: 'input',
  PreToolUse: 'tool',
  PermissionRequest: 'tool',
  PostToolUse: 'tool',
  PostToolUseFailure: 'tool',
  SubagentStart: 'agent',
  SubagentStop: 'agent',
  TeammateIdle: 'agent',
  TaskCreated: 'task',
  TaskCompleted: 'task',
  InstructionsLoaded: 'config',
  ConfigChange: 'config',
  Notification: 'system',
  CwdChanged: 'system',
  FileChanged: 'system',
  WorktreeCreate: 'system',
  WorktreeRemove: 'system',
  Elicitation: 'mcp',
  ElicitationResult: 'mcp',
};

export const HOOK_CATEGORY_LABELS: Record<HookEventCategory, string> = {
  lifecycle: 'Lifecycle',
  input: 'Input',
  tool: 'Tool',
  agent: 'Agent',
  task: 'Task',
  config: 'Config',
  system: 'System',
  mcp: 'MCP',
};

// ─── Hook Event ──────────────────────────────────────────────────────────

export interface HookEvent {
  timestamp: string;
  event: HookEventName;
  sessionId: string | null;
  cwd: string | null;
  permissionMode: string | null;
  transcriptPath: string | null;
  agentId: string | null;
  agentType: string | null;
  payload: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export function getHookEventCategory(event: HookEventName): HookEventCategory {
  return HOOK_EVENT_CATEGORIES[event];
}

/** Get a one-line summary of a hook event for display */
export function getHookEventSummary(event: HookEvent): string {
  const p = event.payload;

  switch (event.event) {
    case 'SessionStart':
      return (p.source as string) || 'startup';
    case 'SessionEnd':
      return (p.reason as string) || '';
    case 'UserPromptSubmit':
      return truncate((p.prompt as string) || '', 60);
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest': {
      const tool = (p.tool_name as string) || '';
      const input = p.tool_input as Record<string, unknown> | undefined;
      if (tool === 'Bash' && input?.command) return `${tool}  ${truncate(String(input.command), 50)}`;
      if (['Read', 'Write', 'Edit'].includes(tool) && input?.file_path)
        return `${tool}  ${truncate(String(input.file_path), 50)}`;
      if (tool === 'Agent' && input?.description) return `${tool}  ${truncate(String(input.description), 50)}`;
      return tool;
    }
    case 'Stop':
      return truncate((p.stop_ts_response as string) || '', 60);
    case 'StopFailure':
      return (p.error as string) || 'error';
    case 'SubagentStart':
    case 'SubagentStop':
      return (p.agent_type as string) || '';
    case 'TaskCreated':
      return truncate((p.task_subject as string) || '', 50);
    case 'TaskCompleted':
      return (p.task_id as string) || '';
    case 'InstructionsLoaded':
      return (p.load_reason as string) || '';
    case 'ConfigChange':
      return (p.config_source as string) || '';
    case 'Notification':
      return (p.notification_type as string) || '';
    case 'CwdChanged':
      return truncate((p.new_cwd as string) || '', 50);
    case 'FileChanged':
      return (p.filename as string) || '';
    case 'PreCompact':
    case 'PostCompact':
      return (p.trigger as string) || '';
    case 'WorktreeCreate':
    case 'WorktreeRemove':
      return '';
    case 'TeammateIdle':
      return '';
    case 'Elicitation':
    case 'ElicitationResult':
      return (p.mcp_server_name as string) || '';
    default:
      return '';
  }
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '\u2026';
}
