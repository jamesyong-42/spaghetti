/**
 * Display items — pure logic for message list abstraction
 *
 * Extracted from browse.ts. No React/JSX dependency.
 * Handles tool pair merging, thinking extraction, task notification handling,
 * filter categories, and tool input/result summaries.
 */

import type { SessionMessage } from '@vibecook/spaghetti-core';
import pc from 'picocolors';

// ─── Display Item Types ────────────────────────────────────────────────

/** A display item is a regular message, a merged tool call, or extracted thinking */
export type DisplayItem =
  | { kind: 'message'; msg: SessionMessage }
  | {
      kind: 'tool-call';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
      result: { content: string; isError: boolean } | null;
      sourceMsg: SessionMessage;
    }
  | { kind: 'thinking'; content: string; redacted: boolean; tokenEstimate: number; sourceMsg: SessionMessage };

// ─── Tool Categories ───────────────────────────────────────────────────

export type ToolCategory = 'file' | 'search' | 'shell' | 'agent' | 'nav' | 'web' | 'mcp' | 'other';

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'file',
  Write: 'file',
  Edit: 'file',
  Glob: 'file',
  Grep: 'search',
  WebSearch: 'web',
  WebFetch: 'web',
  ToolSearch: 'search',
  Bash: 'shell',
  KillShell: 'shell',
  Agent: 'agent',
  SendMessage: 'agent',
  TaskCreate: 'agent',
  TaskUpdate: 'agent',
  TaskList: 'agent',
  TaskOutput: 'agent',
  TaskStop: 'agent',
  TaskGet: 'agent',
  Task: 'agent',
  TodoWrite: 'agent',
  Skill: 'nav',
  EnterPlanMode: 'nav',
  ExitPlanMode: 'nav',
  EnterWorktree: 'nav',
  ExitWorktree: 'nav',
  NotebookEdit: 'file',
  LSP: 'file',
  AskUserQuestion: 'other',
  CronCreate: 'other',
  CronDelete: 'other',
  CronList: 'other',
  TeamCreate: 'other',
  TeamDelete: 'other',
};

export function getToolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORIES[name] || 'other';
}

export const TOOL_CATEGORY_COLORS: Record<ToolCategory, (s: string) => string> = {
  file: pc.cyan,
  search: pc.yellow,
  shell: pc.red,
  agent: pc.magenta,
  nav: pc.blue,
  web: pc.green,
  mcp: (s: string) => pc.dim(pc.cyan(s)),
  other: pc.dim,
};

// ─── Tool Summaries ────────────────────────────────────────────────────

/** Summarize tool input for single-line display */
export function toolInputSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.file_path || '');
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return `/${input.pattern || ''}/ ${input.path || input.glob || ''}`.trim();
    case 'Bash':
      return String(input.command || '').slice(0, 80);
    case 'WebSearch':
      return String(input.query || '');
    case 'WebFetch':
      return String(input.url || '');
    case 'Agent':
      return String(input.description || input.prompt || '').slice(0, 60);
    case 'Skill':
      return String(input.skill || '');
    case 'TaskCreate':
      return String(input.subject || '');
    case 'TaskUpdate':
      return `#${input.taskId || '?'} ${input.status || ''}`.trim();
    case 'SendMessage':
      return `\u2192 ${input.to || ''}`;
    case 'LSP':
      return `${input.operation || ''} ${input.filePath || ''}`.trim();
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return parts.length >= 3 ? parts[2] : name;
      }
      const keys = Object.keys(input);
      return keys.length > 0 ? `{${keys.join(', ')}}` : '';
    }
  }
}

/** Summarize tool result for display */
export function toolResultSummary(content: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  if (lines.length > 3) {
    return `${lines.length} lines`;
  }
  return content.replace(/\n/g, ' ').slice(0, 60);
}

// ─── Task Notification Helpers ─────────────────────────────────────────

/** Extract tool-use-id from a <task-notification> XML string */
function extractTaskNotificationToolId(text: string): string | null {
  const match = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
  return match ? match[1] : null;
}

/** Check if a user message is a task-notification */
function isTaskNotification(msg: SessionMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = (msg as any).message?.content;
  const text = typeof content === 'string' ? content : '';
  return text.includes('<task-notification>');
}

/** Check if an assistant message is echoing a task-notification */
function isTaskNotificationEcho(msg: SessionMessage): boolean {
  if (msg.type !== 'assistant') return false;
  const blocks = (msg as any).message?.content || [];
  const textBlocks = blocks.filter((b: any) => b.type === 'text');
  const text = textBlocks.map((b: any) => b.text || '').join('');
  return text.includes('<task-notification>');
}

// ─── Build Display Items ───────────────────────────────────────────────

/** Convert raw messages into display items, merging tool_use + tool_result pairs */
export function buildDisplayItems(msgs: SessionMessage[]): DisplayItem[] {
  // First pass: collect all tool_results keyed by tool_use_id
  const resultMap = new Map<string, { content: string; isError: boolean }>();
  const taskNotificationToolIds = new Set<string>();

  for (const msg of msgs) {
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;

      // Standard tool_result blocks
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((b: any) => b.text || '').join(' ')
                  : '';
            resultMap.set(block.tool_use_id, {
              content: resultContent,
              isError: block.is_error === true,
            });
          }
        }
      }

      // Task-notification messages (Agent tool results as plain text XML)
      if (typeof content === 'string' && content.includes('<task-notification>')) {
        const toolId = extractTaskNotificationToolId(content);
        if (toolId) {
          taskNotificationToolIds.add(toolId);
          const outputMatch = content.match(/<output-file>([^<]*)<\/output-file>/);
          const resultText = outputMatch ? `agent result \u2192 ${outputMatch[1]}` : 'agent completed';
          resultMap.set(toolId, { content: resultText, isError: false });
        }
      }
    }
  }

  // Collect all tool_use IDs that we'll emit as tool-call items
  const emittedToolUseIds = new Set<string>();
  for (const msg of msgs) {
    if (msg.type === 'assistant') {
      const blocks = (msg as any).message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_use') emittedToolUseIds.add(b.id);
      }
    }
  }

  // Second pass: build display items
  const items: DisplayItem[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    if (msg.type === 'assistant') {
      // Skip assistant messages that are just echoing task-notifications
      if (isTaskNotificationEcho(msg)) continue;

      const blocks = (msg as any).message?.content || [];
      const textBlocks = blocks.filter((b: any) => b.type === 'text');
      const thinkingBlocks = blocks.filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking');
      const toolBlocks = blocks.filter((b: any) => b.type === 'tool_use');

      // Emit thinking blocks as separate items (before text/tools)
      for (const tb of thinkingBlocks) {
        if (tb.type === 'thinking') {
          const thinkLen = tb.thinking?.length ?? 0;
          items.push({
            kind: 'thinking',
            content: tb.thinking || '',
            redacted: false,
            tokenEstimate: Math.round(thinkLen / 4),
            sourceMsg: msg,
          });
        } else {
          items.push({
            kind: 'thinking',
            content: '',
            redacted: true,
            tokenEstimate: 0,
            sourceMsg: msg,
          });
        }
      }

      // If there's text, emit the message (text-only preview)
      if (textBlocks.length > 0) {
        items.push({ kind: 'message', msg });
      } else if (thinkingBlocks.length === 0 && toolBlocks.length === 0) {
        // Empty assistant message - still show it
        items.push({ kind: 'message', msg });
      }

      // Emit each tool_use as a separate display item
      for (const tb of toolBlocks) {
        const result = resultMap.get(tb.id) || null;
        items.push({
          kind: 'tool-call',
          toolName: tb.name,
          toolInput: tb.input,
          toolUseId: tb.id,
          result,
          sourceMsg: msg,
        });
      }
    } else if (msg.type === 'user') {
      // Check if this user message is purely tool results that are already merged
      const content = (msg as any).message?.content;
      if (
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b: any) => b.type === 'tool_result' && emittedToolUseIds.has(b.tool_use_id))
      ) {
        continue;
      }
      // Skip task-notification messages (merged into Agent tool-call items)
      if (isTaskNotification(msg)) {
        continue;
      }
      items.push({ kind: 'message', msg });
    } else {
      items.push({ kind: 'message', msg });
    }
  }

  return items.reverse();
}

// ─── Filter Categories ─────────────────────────────────────────────────

export interface FilterCategory {
  key: string;
  label: string;
  color: (s: string) => string;
  types: string[];
}

export const FILTER_CATEGORIES: FilterCategory[] = [
  { key: '1', label: 'user', color: pc.cyan, types: ['user'] },
  { key: '2', label: 'claude', color: pc.green, types: ['assistant'] },
  { key: '3', label: 'thinking', color: pc.magenta, types: ['__thinking__'] },
  { key: '4', label: 'tools', color: pc.yellow, types: ['__tool-call__'] },
  { key: '5', label: 'system', color: pc.red, types: ['system', 'progress', 'summary'] },
  {
    key: '6',
    label: 'internal',
    color: pc.dim,
    types: ['file-history-snapshot', 'saved_hook_context', 'queue-operation', 'last-prompt'],
  },
];

export type FilterState = Record<string, boolean>;

export function createDefaultFilters(): FilterState {
  const filters: FilterState = {};
  for (const cat of FILTER_CATEGORIES) filters[cat.key] = true;
  return filters;
}

export function applyDisplayFilters(allItems: DisplayItem[], filters: FilterState): DisplayItem[] {
  const enabledTypes = new Set<string>();
  for (const cat of FILTER_CATEGORIES) {
    if (filters[cat.key]) {
      for (const t of cat.types) enabledTypes.add(t);
    }
  }
  return allItems.filter((item) => {
    if (item.kind === 'tool-call') return enabledTypes.has('__tool-call__');
    if (item.kind === 'thinking') return enabledTypes.has('__thinking__');
    return enabledTypes.has(item.msg.type);
  });
}
