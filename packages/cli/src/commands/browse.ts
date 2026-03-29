/**
 * Browse command — interactive hierarchical browser
 *
 * Navigates: PROJECTS → SESSIONS → MESSAGES → MESSAGE DETAIL
 * Uses tui.ts for terminal control and interactive-list.ts for list views.
 */

import type {
  SpaghettiAPI,
  ProjectListItem,
  SessionListItem,
  SessionMessage,
  MessagePage,
} from '@vibecook/spaghetti-core';
import { createTUI, TUINotAvailableError } from '../lib/tui.js';
import type { KeyEvent } from '../lib/tui.js';
import { createListView } from '../lib/interactive-list.js';
import type { ListView } from '../lib/interactive-list.js';
import { theme } from '../lib/color.js';
import { formatTokens, formatRelativeTime, formatNumber, formatDuration, totalTokens } from '../lib/format.js';
import { renderMessage } from '../lib/message-render.js';
import cliTruncate from 'cli-truncate';
import pc from 'picocolors';

// ─── Types ──────────────────────────────────────────────────────────────

type ViewLevel = 'projects' | 'sessions' | 'messages' | 'detail';

// ─── Display Items (message list abstraction) ───────────────────────────

/** A display item is a regular message, a merged tool call, or extracted thinking */
type DisplayItem =
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

/** Tool visual categories for color-coding */
type ToolCategory = 'file' | 'search' | 'shell' | 'agent' | 'nav' | 'web' | 'mcp' | 'other';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
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

function getToolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORIES[name] || 'other';
}

const TOOL_CATEGORY_COLORS: Record<ToolCategory, (s: string) => string> = {
  file: pc.cyan,
  search: pc.yellow,
  shell: pc.red,
  agent: pc.magenta,
  nav: pc.blue,
  web: pc.green,
  mcp: (s: string) => pc.dim(pc.cyan(s)),
  other: pc.dim,
};

/** Summarize tool input for display */
function toolInputSummary(name: string, input: Record<string, unknown>): string {
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
      return `→ ${input.to || ''}`;
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
function toolResultSummary(content: string): string {
  if (!content) return '';
  // Estimate line count
  const lines = content.split('\n');
  if (lines.length > 3) {
    return `${lines.length} lines`;
  }
  return content.replace(/\n/g, ' ').slice(0, 60);
}

/** Convert raw messages into display items, merging tool_use + tool_result pairs */
function buildDisplayItems(msgs: SessionMessage[]): DisplayItem[] {
  // First pass: collect all tool_results keyed by tool_use_id
  const resultMap = new Map<string, { content: string; isError: boolean }>();
  for (const msg of msgs) {
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
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
          // redacted_thinking
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
        // Empty assistant message — still show it
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
        // All blocks are tool_results matching emitted tool-call items — skip
        continue;
      }
      items.push({ kind: 'message', msg });
    } else {
      items.push({ kind: 'message', msg });
    }
  }

  return items.reverse();
}

interface ViewState {
  level: ViewLevel;
  project?: ProjectListItem;
  session?: SessionListItem;
  message?: SessionMessage;
  displayItem?: DisplayItem; // currently selected display item
  projectIndex: number;
  sessionIndex: number;
  messageIndex: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const LOAD_MORE_THRESHOLD = 5;
const SEPARATOR = (cols: number) => pc.dim('─'.repeat(cols));

// ─── Filter Categories ──────────────────────────────────────────────────

interface FilterCategory {
  key: string; // '1'-'6' hotkey
  label: string; // display name
  color: (s: string) => string;
  types: string[]; // message types this category includes
}

const FILTER_CATEGORIES: FilterCategory[] = [
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

type FilterState = Record<string, boolean>; // key = category key ('1'-'6')

function createDefaultFilters(): FilterState {
  const filters: FilterState = {};
  for (const cat of FILTER_CATEGORIES) filters[cat.key] = true;
  // Progress and internal are noisy — off by default
  filters['5'] = false;
  filters['6'] = false;
  return filters;
}

function applyDisplayFilters(allItems: DisplayItem[], filters: FilterState): DisplayItem[] {
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

// ─── Main Entry Point ───────────────────────────────────────────────────

export async function browseCommand(api: SpaghettiAPI): Promise<void> {
  const tui = createTUI(); // throws TUINotAvailableError if not possible

  const state: ViewState = {
    level: 'projects',
    projectIndex: 0,
    sessionIndex: 0,
    messageIndex: 0,
  };

  let projects: ProjectListItem[] = [];
  let sessions: SessionListItem[] = [];
  let allMessages: SessionMessage[] = []; // raw messages
  let allDisplayItems: DisplayItem[] = []; // processed (tool pairs merged)
  let displayItems: DisplayItem[] = []; // filtered view
  let messagePage: MessagePage | null = null;
  let projectFirstPrompts: Map<string, string> = new Map();
  const filters: FilterState = createDefaultFilters();

  let projectList: ListView<ProjectListItem> | null = null;
  let sessionList: ListView<SessionListItem> | null = null;
  let messageList: ListView<DisplayItem> | null = null;

  let detailLines: string[] = [];
  let detailScrollOffset = 0;

  // ─── Data Fetching ──────────────────────────────────────────────────

  function loadProjects(): void {
    projects = api.getProjectList();
    projects.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    projectFirstPrompts = new Map();
    for (const p of projects) {
      const sess = api.getSessionList(p.slug);
      if (sess.length > 0) {
        projectFirstPrompts.set(p.slug, sess[0].firstPrompt || '');
      }
    }
  }

  function loadSessions(project: ProjectListItem): void {
    sessions = api.getSessionList(project.slug);
  }

  function loadMessages(project: ProjectListItem, session: SessionListItem): void {
    messagePage = api.getSessionMessages(project.slug, session.sessionId, PAGE_SIZE, 0);
    allMessages = messagePage.messages;
    allDisplayItems = buildDisplayItems(allMessages);
    displayItems = applyDisplayFilters(allDisplayItems, filters);
  }

  function loadMoreMessages(): void {
    if (!messagePage || !messagePage.hasMore || !state.project || !state.session) return;
    const nextPage = api.getSessionMessages(
      state.project.slug,
      state.session.sessionId,
      PAGE_SIZE,
      messagePage.offset + messagePage.messages.length,
    );
    messagePage = {
      messages: [...messagePage.messages, ...nextPage.messages],
      total: nextPage.total,
      offset: 0,
      hasMore: nextPage.hasMore,
    };
    allMessages = messagePage.messages;
    allDisplayItems = buildDisplayItems(allMessages);
    displayItems = applyDisplayFilters(allDisplayItems, filters);
    if (messageList) {
      messageList.updateItems(displayItems);
    }
  }

  function reapplyFilters(): void {
    displayItems = applyDisplayFilters(allDisplayItems, filters);
    if (messageList) {
      messageList.updateItems(displayItems);
    }
    state.messageIndex = Math.min(state.messageIndex, Math.max(0, displayItems.length - 1));
  }

  // ─── Renderers ──────────────────────────────────────────────────────

  function renderProjectItem(p: ProjectListItem, _idx: number, selected: boolean): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.cyan('▎') : ' ';
    const dot = pc.dim(' · ');

    // Line 1: name + branch
    const name = selected ? pc.bold(pc.white(p.folderName)) : pc.white(p.folderName);
    const branch = p.latestGitBranch ? (selected ? pc.cyan(p.latestGitBranch) : pc.dim(p.latestGitBranch)) : '';

    // Line 2: first prompt (always subdued — it's context, not primary info)
    const prompt = projectFirstPrompts.get(p.slug) || '';
    const promptLine = pc.dim(pc.italic(cliTruncate(prompt ? `"${prompt}"` : '', Math.max(cols - 6, 20))));

    // Line 3: stats with semantic coloring
    const sessions = (selected ? pc.white : pc.dim)(formatNumber(p.sessionCount));
    const msgs = (selected ? pc.white : pc.dim)(formatNumber(p.messageCount));
    const tokens = (selected ? pc.yellow : pc.dim)(formatTokens(totalTokens(p.tokenUsage)));
    const time = pc.dim(formatRelativeTime(p.lastActiveAt));
    const stats = `${sessions} ${pc.dim('sessions')}${dot}${msgs} ${pc.dim('msgs')}${dot}${tokens} ${pc.dim('tokens')}${dot}${time}`;

    return [
      `${prefix} ${name}  ${branch}`,
      `${prefix} ${promptLine}`,
      `${prefix} ${stats}`,
      '', // breathing room between cards
    ];
  }

  function renderSessionItem(s: SessionListItem, idx: number, selected: boolean): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.yellow('▎') : ' ';
    const dot = pc.dim(' · ');

    // Line 1: session number + branch
    const num = selected ? pc.bold(pc.white(`#${idx + 1}`)) : pc.white(`#${idx + 1}`);
    const branch = s.gitBranch ? (selected ? pc.yellow(s.gitBranch) : pc.dim(s.gitBranch)) : '';

    // Line 2: first prompt
    const prompt = s.firstPrompt || '';
    const promptLine = pc.dim(pc.italic(cliTruncate(prompt ? `"${prompt}"` : '', Math.max(cols - 6, 20))));

    // Line 3: stats with semantic coloring
    const msgs = (selected ? pc.white : pc.dim)(formatNumber(s.messageCount));
    const tokens = (selected ? pc.yellow : pc.dim)(formatTokens(totalTokens(s.tokenUsage)));
    const duration = (selected ? pc.white : pc.dim)(formatDuration(s.lifespanMs));
    const time = pc.dim(formatRelativeTime(s.lastUpdate));
    const stats = `${msgs} ${pc.dim('msgs')}${dot}${tokens} ${pc.dim('tokens')}${dot}${duration}${dot}${time}`;

    return [
      `${prefix} ${num}  ${branch}`,
      `${prefix} ${promptLine}`,
      `${prefix} ${stats}`,
      '', // breathing room between cards
    ];
  }

  function renderDisplayItem(item: DisplayItem, _idx: number, selected: boolean): string[] {
    if (item.kind === 'tool-call') return renderToolCallItem(item, selected);
    if (item.kind === 'thinking') return renderThinkingItem(item, selected);
    return renderMessageDisplayItem(item.msg, selected);
  }

  function renderThinkingItem(item: DisplayItem & { kind: 'thinking' }, selected: boolean): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.magenta('▎') : ' ';
    const dots = selected ? pc.magenta('···') : pc.dim('···');
    const label = selected ? pc.white('thinking') : pc.dim('thinking');

    if (item.redacted) {
      return [`${prefix} ${dots} ${label}  ${pc.dim('(redacted)')}`];
    }

    const tokensLabel = item.tokenEstimate > 0 ? pc.dim(`~${formatTokens(item.tokenEstimate)}`) : '';

    // Inline preview — single collapsed line
    const firstLine = item.content.split('\n').find((l) => l.trim().length > 0) || '';
    const usedWidth = 22 + (item.tokenEstimate > 0 ? 8 : 0);
    const previewText = cliTruncate(firstLine.trim(), Math.max(cols - usedWidth, 20));
    const preview = selected ? pc.italic(pc.dim(previewText)) : pc.dim(pc.italic(previewText));

    return [`${prefix} ${dots} ${label}  ${tokensLabel}  ${preview}`];
  }

  function renderToolCallItem(item: DisplayItem & { kind: 'tool-call' }, selected: boolean): string[] {
    const cols = tui.cols;
    const cat = getToolCategory(item.toolName);
    const colorFn = TOOL_CATEGORY_COLORS[cat];
    const prefix = selected ? colorFn('▎') : ' ';

    // Category label + tool name + input + status — all on one line (pipeline feel)
    const catLabel = pc.dim(cat);
    const badge = selected ? pc.bold(colorFn(item.toolName)) : colorFn(item.toolName);
    const input = toolInputSummary(item.toolName, item.toolInput);

    // Status indicator: ✓ success, ✗ error
    let status: string;
    let resultHint = '';
    if (item.result) {
      if (item.result.isError) {
        status = pc.red('✗');
        const errText = item.result.content.replace(/\n/g, ' ').slice(0, 40);
        resultHint = pc.red(pc.dim(errText));
      } else {
        status = pc.green('✓');
        const summary = toolResultSummary(item.result.content);
        resultHint = pc.dim(summary);
      }
    } else {
      status = pc.dim('·');
      resultHint = '';
    }

    // Calculate available width for input text
    const fixedWidth = cat.length + item.toolName.length + 10; // spaces + status
    const inputText = input
      ? (selected
          ? pc.white(cliTruncate(input, Math.max(cols - fixedWidth - 20, 10)))
          : pc.dim(cliTruncate(input, Math.max(cols - fixedWidth - 20, 10))))
      : '';

    return [
      `${prefix} ${catLabel} ${badge}  ${inputText}  ${status} ${resultHint}`,
    ];
  }

  // ─── Per-Type Message Renderers ─────────────────────────────────────

  function renderUserItem(msg: SessionMessage, selected: boolean): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.cyan('▎') : ' ';

    // Pill badge style — ALL CAPS, colored background feel via inverse/bold
    const badge = selected
      ? pc.bold(pc.inverse(pc.cyan(' USER ')))
      : pc.inverse(pc.cyan(' USER '));
    const timestamp =
      'timestamp' in msg && (msg as any).timestamp ? pc.dim(formatRelativeTime((msg as any).timestamp)) : '';

    // Extract text content
    let preview = '';
    const content = (msg as any).message.content;
    if (typeof content === 'string') preview = content;
    else if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b.type === 'text');
      if (textBlock && 'text' in textBlock) preview = textBlock.text;
    }
    preview = preview.replace(/\n/g, ' ');
    const previewText = cliTruncate(preview, Math.max(cols - 10, 20));
    const previewLine = selected ? pc.white(previewText) : pc.dim(previewText);

    return [
      `${prefix} ${badge}  ${timestamp}`,
      `${prefix}     ${previewLine}`,
    ];
  }

  function renderAssistantItem(msg: SessionMessage, selected: boolean): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.yellow('▎') : ' ';

    // Pill badge — Claude Code brand color (amber/orange → pc.yellow)
    const badge = selected
      ? pc.bold(pc.inverse(pc.yellow(' CLAUDE ')))
      : pc.inverse(pc.yellow(' CLAUDE '));
    const timestamp =
      'timestamp' in msg && (msg as any).timestamp ? pc.dim(formatRelativeTime((msg as any).timestamp)) : '';

    const blocks = (msg as any).message.content || [];
    const textBlocks = blocks.filter((b: any) => b.type === 'text');
    let preview = textBlocks.map((b: any) => b.text).join(' ');
    preview = preview.replace(/\n/g, ' ');
    const previewText = cliTruncate(preview, Math.max(cols - 10, 20));
    const previewLine = selected ? pc.white(previewText) : pc.dim(previewText);

    return [
      `${prefix} ${badge}  ${timestamp}`,
      `${prefix}     ${previewLine}`,
    ];
  }

  function renderMessageDisplayItem(msg: SessionMessage, selected: boolean): string[] {
    // Dispatch to type-specific renderers
    if (msg.type === 'user') return renderUserItem(msg, selected);
    if (msg.type === 'assistant') return renderAssistantItem(msg, selected);

    const cols = tui.cols;
    const prefix = selected ? pc.dim('▎') : ' ';

    // All metadata types render as single-line with a unicode symbol prefix
    let symbol: string;
    let text: string;

    switch (msg.type) {
      case 'system': {
        const subtype = 'subtype' in msg ? (msg as any).subtype : '';
        if (subtype === 'turn_duration') {
          symbol = selected ? pc.white('⏱') : pc.dim('⏱');
          text = formatDuration((msg as any).durationMs || 0);
        } else if (subtype === 'api_error') {
          symbol = selected ? pc.red('⚠') : pc.dim('⚠');
          text = `api error (retry ${(msg as any).retryAttempt}/${(msg as any).maxRetries})`;
        } else if (subtype === 'compact_boundary') {
          symbol = selected ? pc.white('◇') : pc.dim('◇');
          const content = (msg as any).content || '';
          text = `compacted ${content ? cliTruncate(content.replace(/\n/g, ' '), Math.max(cols - 16, 20)) : ''}`;
        } else if (subtype === 'stop_hook_summary') {
          symbol = selected ? pc.white('■') : pc.dim('■');
          text = `stop hook (${(msg as any).hookCount || 0} hooks)`;
        } else {
          symbol = selected ? pc.white('◆') : pc.dim('◆');
          const content = 'content' in msg && typeof (msg as any).content === 'string'
            ? (msg as any).content.replace(/\n/g, ' ')
            : subtype || 'system';
          text = cliTruncate(content, Math.max(cols - 8, 20));
        }
        break;
      }
      case 'summary': {
        symbol = selected ? pc.white('§') : pc.dim('§');
        const summary = ((msg as any).summary || '').replace(/\n/g, ' ');
        text = pc.italic(cliTruncate(summary, Math.max(cols - 8, 20)));
        break;
      }
      case 'progress': {
        symbol = selected ? pc.white('⟳') : pc.dim('⟳');
        const data = (msg as any).data;
        if (data?.type === 'bash_progress') {
          text = `bash ${cliTruncate((data.output || '').replace(/\n/g, ' '), Math.max(cols - 14, 20))}`;
        } else if (data?.type === 'agent_progress') {
          text = `agent ${data.agentId || ''}`;
        } else if (data?.type === 'hook_progress') {
          text = `hook ${data.hookName || ''}`;
        } else if (data?.type === 'mcp_progress') {
          text = `mcp ${data.serverName || ''}/${data.toolName || ''}`;
        } else {
          text = data?.type || 'progress';
        }
        break;
      }
      default: {
        // Internal types: file-history-snapshot, saved_hook_context, queue-operation, last-prompt, custom-title, agent-name
        symbol = selected ? pc.white('·') : pc.dim('·');
        if (msg.type === 'saved_hook_context') {
          text = `${msg.type} ${(msg as any).hookName || ''}`;
        } else if (msg.type === 'queue-operation') {
          text = `queue ${(msg as any).operation || ''}`;
        } else if (msg.type === 'last-prompt') {
          text = `last-prompt`;
        } else if (msg.type === 'custom-title' as any) {
          text = `title: ${(msg as any).customTitle || ''}`;
        } else if (msg.type === 'agent-name' as any) {
          text = `agent: ${(msg as any).agentName || ''}`;
        } else {
          text = msg.type;
        }
        break;
      }
    }

    const styledText = selected ? pc.white(text) : pc.dim(text);
    return [`${prefix} ${symbol} ${styledText}`];
  }

  // ─── Header / Footer Builders ───────────────────────────────────────

  function buildHeader(): string[] {
    const cols = tui.cols;
    let breadcrumb = '';

    switch (state.level) {
      case 'projects':
        breadcrumb = theme.project(`Projects`) + pc.dim(` (${projects.length})`);
        break;
      case 'sessions':
        breadcrumb =
          pc.dim(state.project!.folderName) +
          pc.dim(' › ') +
          theme.session(`Sessions`) +
          pc.dim(` (${sessions.length})`);
        break;
      case 'messages': {
        const total = allDisplayItems.length;
        const shown = displayItems.length;
        const countLabel = total === shown ? pc.dim(` (${total})`) : pc.dim(` (${shown}/${total})`);
        breadcrumb =
          pc.dim(state.project!.folderName) +
          pc.dim(' › ') +
          pc.dim(`#${state.sessionIndex + 1}`) +
          pc.dim(' › ') +
          theme.message(`Messages`) +
          countLabel;
        break;
      }
      case 'detail': {
        const di = state.displayItem;
        if (di && di.kind === 'tool-call') {
          const cat = getToolCategory(di.toolName);
          const colorFn = TOOL_CATEGORY_COLORS[cat];
          breadcrumb =
            pc.dim(state.project!.folderName) +
            pc.dim(' › ') +
            pc.dim(`#${state.sessionIndex + 1}`) +
            pc.dim(' › ') +
            colorFn(pc.bold(di.toolName)) +
            pc.dim(` ${toolInputSummary(di.toolName, di.toolInput).slice(0, 40)}`);
        } else if (di && di.kind === 'thinking') {
          const label = di.redacted ? 'Redacted Thinking' : 'Thinking';
          const tokLabel =
            !di.redacted && di.tokenEstimate > 0 ? pc.dim(` ~${formatTokens(di.tokenEstimate)} tokens`) : '';
          breadcrumb =
            pc.dim(state.project!.folderName) +
            pc.dim(' › ') +
            pc.dim(`#${state.sessionIndex + 1}`) +
            pc.dim(' › ') +
            pc.bold(pc.magenta(label)) +
            tokLabel;
        } else {
          const role = state.message?.type || '';
          const ts =
            state.message && 'timestamp' in state.message && (state.message as any).timestamp
              ? formatRelativeTime((state.message as any).timestamp)
              : '';
          breadcrumb =
            pc.dim(state.project!.folderName) +
            pc.dim(' › ') +
            pc.dim(`#${state.sessionIndex + 1}`) +
            pc.dim(' › ') +
            theme.detail(`Message ${state.messageIndex + 1}`) +
            pc.dim(` ${role} · ${ts}`);
        }
        break;
      }
    }

    const lines = [`  ${breadcrumb}`];

    // Filter chips — only on messages view
    if (state.level === 'messages') {
      const chips = FILTER_CATEGORIES.map((cat) => {
        const on = filters[cat.key];
        if (on) {
          return `${pc.white(cat.key)}${pc.dim(':')}${cat.color(cat.label)}`;
        } else {
          return `${pc.dim(cat.key)}${pc.dim(':')}${pc.strikethrough(pc.dim(cat.label))}`;
        }
      }).join(pc.dim('  '));
      lines.push(`  ${chips}`);
    }

    lines.push(`  ${SEPARATOR(cols - 4)}`);
    return lines;
  }

  function buildFooter(): string[] {
    const cols = tui.cols;
    // Style: keys are white, descriptions are dim
    const key = (k: string) => pc.white(k);
    const desc = (d: string) => pc.dim(d);
    const sep = pc.dim('  ');
    let hints = '';

    switch (state.level) {
      case 'projects':
        hints = `${key('↑↓')} ${desc('navigate')}${sep}${key('Enter')} ${desc('open')}${sep}${key('q')} ${desc('quit')}`;
        break;
      case 'sessions':
        hints = `${key('↑↓')} ${desc('navigate')}${sep}${key('Enter')} ${desc('open')}${sep}${key('Esc')} ${desc('back')}${sep}${key('q')} ${desc('quit')}`;
        break;
      case 'messages':
        hints = `${key('↑↓')} ${desc('navigate')}${sep}${key('1-6')} ${desc('filter')}${sep}${key('Enter')} ${desc('open')}${sep}${key('Esc')} ${desc('back')}${sep}${key('q')} ${desc('quit')}`;
        break;
      case 'detail': {
        const pos = pc.dim(`[${detailScrollOffset + 1} / ${detailLines.length} lines]`);
        hints = `${key('↑↓')} ${desc('scroll')}${sep}${key('Esc')} ${desc('back')}${sep}${key('q')} ${desc('quit')}${sep}${pos}`;
        break;
      }
    }

    return [`  ${SEPARATOR(cols - 4)}`, `  ${hints}`];
  }

  // ─── View Setup ─────────────────────────────────────────────────────

  function setupProjectsView(): void {
    loadProjects();
    if (projects.length === 0) {
      tui.cleanup();
      throw new TUINotAvailableError('no projects found');
    }
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    projectList = createListView({
      items: projects,
      renderItem: renderProjectItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (projectList.getSelectedIndex() < state.projectIndex && state.projectIndex < projects.length) {
      projectList.moveDown();
    }
  }

  function setupSessionsView(): void {
    loadSessions(state.project!);
    if (sessions.length === 0) {
      // Show empty state — render a centered message
      state.level = 'sessions';
      const header = buildHeader();
      const footer = buildFooter();
      const viewportHeight = tui.rows - header.length - footer.length;
      const emptyMsg = pc.dim('No sessions found');
      const padTop = Math.floor(viewportHeight / 2);
      const lines = [...header];
      for (let i = 0; i < padTop; i++) lines.push('');
      lines.push(`  ${emptyMsg}`);
      while (lines.length < header.length + viewportHeight) lines.push('');
      lines.push(...footer);
      tui.render(lines);
      sessionList = null;
      return;
    }
    state.level = 'sessions';
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    sessionList = createListView({
      items: sessions,
      renderItem: renderSessionItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (sessionList.getSelectedIndex() < state.sessionIndex && state.sessionIndex < sessions.length) {
      sessionList.moveDown();
    }
  }

  function setupMessagesView(): void {
    loadMessages(state.project!, state.session!);
    if (displayItems.length === 0) {
      state.level = 'messages';
      const header = buildHeader();
      const footer = buildFooter();
      const viewportHeight = tui.rows - header.length - footer.length;
      const emptyMsg = pc.dim('No messages');
      const padTop = Math.floor(viewportHeight / 2);
      const lines = [...header];
      for (let i = 0; i < padTop; i++) lines.push('');
      lines.push(`  ${emptyMsg}`);
      while (lines.length < header.length + viewportHeight) lines.push('');
      lines.push(...footer);
      tui.render(lines);
      messageList = null;
      return;
    }
    state.level = 'messages';
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    messageList = createListView({
      items: displayItems,
      renderItem: renderDisplayItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (messageList.getSelectedIndex() < state.messageIndex && state.messageIndex < displayItems.length) {
      messageList.moveDown();
    }
  }

  function setupDetailView(): void {
    state.level = 'detail';
    detailScrollOffset = 0;
    const rendered = renderMessage(state.message!, { width: tui.cols - 4 });
    detailLines = rendered.split('\n');
  }

  function setupToolDetailView(item: DisplayItem & { kind: 'tool-call' }): void {
    state.level = 'detail';
    detailScrollOffset = 0;
    const cat = getToolCategory(item.toolName);
    const colorFn = TOOL_CATEGORY_COLORS[cat];
    const width = tui.cols - 4;

    const lines: string[] = [];
    lines.push(colorFn(pc.bold(item.toolName)));
    lines.push('');

    // Input details
    lines.push(pc.white('Input:'));
    const input = item.toolInput;
    for (const [key, value] of Object.entries(input)) {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      const valLines = valStr.split('\n');
      if (valLines.length <= 1) {
        lines.push(`  ${pc.dim(key + ':')} ${cliTruncate(valStr, Math.max(width - key.length - 4, 20))}`);
      } else {
        lines.push(`  ${pc.dim(key + ':')} ${cliTruncate(valLines[0], Math.max(width - key.length - 4, 20))}`);
        for (let i = 1; i < Math.min(valLines.length, 20); i++) {
          lines.push(`  ${cliTruncate(valLines[i], width - 2)}`);
        }
        if (valLines.length > 20) lines.push(pc.dim(`  ... (${valLines.length - 20} more lines)`));
      }
    }

    lines.push('');

    // Result
    if (item.result) {
      if (item.result.isError) {
        lines.push(pc.red(pc.bold('Error:')));
      } else {
        lines.push(pc.white('Result:'));
      }
      const resultLines = item.result.content.split('\n');
      for (const rl of resultLines) {
        lines.push(`  ${rl}`);
      }
    } else {
      lines.push(pc.dim('(no result captured)'));
    }

    detailLines = lines;
  }

  function setupThinkingDetailView(item: DisplayItem & { kind: 'thinking' }): void {
    state.level = 'detail';
    detailScrollOffset = 0;

    const lines: string[] = [];
    if (item.redacted) {
      lines.push(pc.magenta(pc.bold('Redacted Thinking')));
      lines.push('');
      lines.push(pc.dim('The model chose to redact this thinking block.'));
      lines.push(pc.dim('This is typically done for safety or privacy reasons.'));
    } else {
      const tokLabel = item.tokenEstimate > 0 ? pc.dim(` (~${formatTokens(item.tokenEstimate)} tokens)`) : '';
      lines.push(pc.magenta(pc.bold('Thinking')) + tokLabel);
      lines.push('');
      for (const line of item.content.split('\n')) {
        lines.push(pc.italic(line));
      }
    }

    detailLines = lines;
  }

  // ─── Render ──────────────────────────────────────────────────────────

  // Recreates the list view with fresh header/footer on each render.
  // This is simple and correct. At our data scale (< 50 visible items
  // due to pagination), the O(n) index restoration is negligible.
  function fullRender(): void {
    if (state.level === 'detail') {
      const dh = buildHeader();
      const df = buildFooter();
      const viewportHeight = tui.rows - dh.length - df.length;
      const visible = detailLines.slice(detailScrollOffset, detailScrollOffset + viewportHeight);
      while (visible.length < viewportHeight) visible.push('');
      tui.render([...dh, ...visible.map((l) => `  ${l}`), ...df]);
      return;
    }

    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    let activeList: ListView<any> | null = null;
    switch (state.level) {
      case 'projects':
        if (projectList) {
          projectList = createListView({
            items: projects,
            renderItem: renderProjectItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.projectIndex && i < projects.length - 1; i++) {
            projectList.moveDown();
          }
          activeList = projectList;
        }
        break;
      case 'sessions':
        if (sessionList) {
          sessionList = createListView({
            items: sessions,
            renderItem: renderSessionItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.sessionIndex && i < sessions.length - 1; i++) {
            sessionList.moveDown();
          }
          activeList = sessionList;
        }
        break;
      case 'messages':
        if (messageList) {
          messageList = createListView({
            items: displayItems,
            renderItem: renderDisplayItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.messageIndex && i < displayItems.length - 1; i++) {
            messageList.moveDown();
          }
          activeList = messageList;
        }
        break;
    }

    if (activeList) {
      tui.render(activeList.getLines());
    }
  }

  // ─── Key Handler ────────────────────────────────────────────────────

  function handleKey(key: KeyEvent): void {
    if (key === 'q' || key === 'ctrl-c') {
      tui.cleanup();
      return;
    }

    switch (state.level) {
      case 'projects':
        handleProjectsKey(key);
        break;
      case 'sessions':
        handleSessionsKey(key);
        break;
      case 'messages':
        handleMessagesKey(key);
        break;
      case 'detail':
        handleDetailKey(key);
        break;
    }
  }

  function handleProjectsKey(key: KeyEvent): void {
    if (!projectList || projects.length === 0) {
      if (key === 'escape') tui.cleanup();
      return;
    }

    switch (key) {
      case 'up':
        projectList.moveUp();
        state.projectIndex = projectList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        projectList.moveDown();
        state.projectIndex = projectList.getSelectedIndex();
        fullRender();
        break;
      case 'enter':
        state.project = projectList.getSelected();
        state.projectIndex = projectList.getSelectedIndex();
        state.sessionIndex = 0;
        setupSessionsView();
        fullRender();
        break;
      case 'escape':
        tui.cleanup();
        break;
    }
  }

  function handleSessionsKey(key: KeyEvent): void {
    if (!sessionList) {
      if (key === 'escape') {
        state.level = 'projects';
        setupProjectsView();
        fullRender();
      }
      return;
    }

    switch (key) {
      case 'up':
        sessionList.moveUp();
        state.sessionIndex = sessionList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        sessionList.moveDown();
        state.sessionIndex = sessionList.getSelectedIndex();
        fullRender();
        break;
      case 'enter':
        if (sessions.length === 0) break;
        state.session = sessionList.getSelected();
        state.sessionIndex = sessionList.getSelectedIndex();
        state.messageIndex = 0;
        setupMessagesView();
        fullRender();
        break;
      case 'escape':
        state.level = 'projects';
        setupProjectsView();
        fullRender();
        break;
    }
  }

  function handleMessagesKey(key: KeyEvent): void {
    // Filter toggles work even when list is empty
    if (key >= '1' && key <= '6') {
      filters[key] = !filters[key];
      reapplyFilters();
      if (displayItems.length > 0 && !messageList) {
        setupMessagesView();
      } else if (displayItems.length === 0) {
        setupMessagesView();
      }
      fullRender();
      return;
    }

    if (!messageList) {
      if (key === 'escape') {
        state.level = 'sessions';
        setupSessionsView();
        fullRender();
      }
      return;
    }

    switch (key) {
      case 'up':
        messageList.moveUp();
        state.messageIndex = messageList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        messageList.moveDown();
        state.messageIndex = messageList.getSelectedIndex();
        if (messagePage?.hasMore && state.messageIndex >= displayItems.length - LOAD_MORE_THRESHOLD) {
          loadMoreMessages();
        }
        fullRender();
        break;
      case 'enter': {
        if (displayItems.length === 0) break;
        const selected = messageList.getSelected();
        if (!selected) break;
        state.messageIndex = messageList.getSelectedIndex();
        state.displayItem = selected;
        if (selected.kind === 'tool-call') {
          state.message = selected.sourceMsg;
          setupToolDetailView(selected);
        } else if (selected.kind === 'thinking') {
          state.message = selected.sourceMsg;
          setupThinkingDetailView(selected);
        } else {
          state.message = selected.msg;
          setupDetailView();
        }
        fullRender();
        break;
      }
      case 'escape':
        state.level = 'sessions';
        setupSessionsView();
        fullRender();
        break;
    }
  }

  function handleDetailKey(key: KeyEvent): void {
    const viewportHeight = tui.rows - 4; // header + footer

    switch (key) {
      case 'up':
        if (detailScrollOffset > 0) {
          detailScrollOffset--;
          fullRender();
        }
        break;
      case 'down':
        if (detailScrollOffset < detailLines.length - viewportHeight) {
          detailScrollOffset++;
          fullRender();
        }
        break;
      case 'escape':
        state.level = 'messages';
        setupMessagesView();
        fullRender();
        break;
    }
  }

  // ─── Run ────────────────────────────────────────────────────────────

  try {
    state.level = 'projects';
    setupProjectsView();
    fullRender();

    tui.onKey(handleKey);
    tui.onResize(() => fullRender());

    // Keep the process alive until cleanup is called
    await new Promise<void>((resolve) => {
      const origCleanup = tui.cleanup.bind(tui);
      tui.cleanup = () => {
        origCleanup();
        resolve();
      };
    });
  } catch (err) {
    tui.cleanup();
    throw err;
  }
}
