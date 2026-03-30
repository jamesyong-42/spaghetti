/**
 * MessagesView — Display items with filter chips, 256-color blocks, tool calls
 *
 * The most complex view. Handles:
 * - User/Claude message blocks with 256-color backgrounds
 * - Tool call single-line items with category colors
 * - Thinking items with inline preview
 * - System/metadata items
 * - Filter toggles (1-6)
 * - Backward pagination (loads older messages on scroll)
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ProjectListItem, SessionListItem, SessionMessage } from '@vibecook/spaghetti-core';
import { useViewNav } from './context.js';
import { HRule } from './chrome.js';
import { useApi } from './shell.js';
import { useListNavigation } from './hooks.js';
import { formatTokens, formatRelativeTime, formatDuration } from '../lib/format.js';
import {
  buildDisplayItems,
  applyDisplayFilters,
  createDefaultFilters,
  FILTER_CATEGORIES,
  getToolCategory,
  TOOL_CATEGORY_COLORS,
  toolInputSummary,
  toolResultSummary,
} from './display-items.js';
import type { DisplayItem, FilterState } from './display-items.js';
import type { ViewEntry } from './types.js';
import { DetailView } from './detail-view.js';
import pc from 'picocolors';

// ─── Constants ─────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const LOAD_MORE_THRESHOLD = 5;

// ─── 256-Color Helpers ─────────────────────────────────────────────────

const RESET = '\x1b[0m';
const fg256 = (n: number) => `\x1b[38;5;${n}m`;
const bg256 = (n: number) => `\x1b[48;5;${n}m`;
const BOLD = '\x1b[1m';

const COLORS = {
  userBg: 233,
  userBgSelected: 236,
  userLabel: 79,
  userLabelDim: 36,
  userText: 36,
  userTextSelected: 79,
  claudeBg: 233,
  claudeBgSelected: 235,
  claudeLabel: 216,
  claudeLabelDim: 173,
  claudeText: 173,
  claudeTextSelected: 216,
  timestamp: 248,
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function bgLine256(text: string, width: number, bgColor: number): string {
  const visLen = stripAnsi(text).length;
  const pad = Math.max(0, width - visLen);
  return `${bg256(bgColor)}${text}${' '.repeat(pad)}${RESET}`;
}

// ─── Filter Chips ──────────────────────────────────────────────────────

function buildFilterChips(filters: FilterState): string {
  return FILTER_CATEGORIES.map((cat) => {
    const on = filters[cat.key];
    if (on) {
      return `${pc.white(cat.key)}${pc.dim(':')}${cat.color(cat.label)}`;
    } else {
      return `${pc.dim(cat.key)}${pc.dim(':')}${pc.strikethrough(pc.dim(cat.label))}`;
    }
  }).join(pc.dim('  '));
}

// ─── Item Renderers ────────────────────────────────────────────────────

interface ItemRendererProps {
  item: DisplayItem;
  selected: boolean;
  cols: number;
}

function UserItem({ msg, selected, cols }: { msg: SessionMessage; selected: boolean; cols: number }): React.ReactElement {
  const bgColor = selected ? COLORS.userBgSelected : COLORS.userBg;
  const labelColor = selected ? COLORS.userLabel : COLORS.userLabelDim;
  const textColor = selected ? COLORS.userTextSelected : COLORS.userText;

  let preview = '';
  const content = (msg as any).message.content;
  if (typeof content === 'string') preview = content;
  else if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === 'text');
    if (textBlock && 'text' in textBlock) preview = textBlock.text;
  }
  // Collapse newlines to spaces for wrapping
  preview = preview.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

  const timestamp = 'timestamp' in msg && (msg as any).timestamp ? formatRelativeTime((msg as any).timestamp) : '';

  const timeVis = timestamp;
  const labelVis = 'USER \u2590';
  const rightVis = `${timeVis}  ${labelVis} `;
  const leftPad = Math.max(1, cols - rightVis.length);
  const headerContent = `${' '.repeat(leftPad)}${fg256(COLORS.timestamp)}${timestamp}  ${selected ? BOLD : ''}${fg256(labelColor)}${labelVis} `;

  // Split preview into up to 3 lines
  const lineWidth = Math.max(cols - 4, 10);
  const bodyLines: string[] = [];
  let remaining = preview;
  for (let i = 0; i < 3; i++) {
    if (!remaining) break;
    if (remaining.length <= lineWidth || i === 2) {
      bodyLines.push(remaining.length > lineWidth ? remaining.slice(0, lineWidth - 1) + '\u2026' : remaining);
      break;
    }
    bodyLines.push(remaining.slice(0, lineWidth));
    remaining = remaining.slice(lineWidth);
  }
  // Pad to exactly 3 body lines for consistent height
  while (bodyLines.length < 3) bodyLines.push('');

  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text>{bgLine256(headerContent, cols, bgColor)}</Text>
      {bodyLines.map((line, i) => {
        // Right-align body text to match the right-aligned header
        const textVisLen = line.length + 1; // line + trailing space
        const leftPad = Math.max(1, cols - textVisLen);
        const content = `${' '.repeat(leftPad)}${fg256(textColor)}${line} `;
        return <Text key={i}>{bgLine256(content, cols, bgColor)}</Text>;
      })}
      <Text> </Text>
    </Box>
  );
}

function AssistantItem({ msg, selected, cols }: { msg: SessionMessage; selected: boolean; cols: number }): React.ReactElement {
  const bgColor = selected ? COLORS.claudeBgSelected : COLORS.claudeBg;
  const labelColor = selected ? COLORS.claudeLabel : COLORS.claudeLabelDim;
  const textColor = selected ? COLORS.claudeTextSelected : COLORS.claudeText;

  const blocks = (msg as any).message.content || [];
  const textBlocks = blocks.filter((b: any) => b.type === 'text');
  let preview = textBlocks.map((b: any) => b.text).join(' ');
  preview = preview.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

  const timestamp = 'timestamp' in msg && (msg as any).timestamp ? formatRelativeTime((msg as any).timestamp) : '';

  const headerContent = ` ${selected ? BOLD : ''}${fg256(labelColor)}\u258C CLAUDE  ${fg256(COLORS.timestamp)}${timestamp} `;

  // Split preview into up to 2 lines
  const lineWidth = Math.max(cols - 4, 10);
  const bodyLines: string[] = [];
  let remaining = preview;
  for (let i = 0; i < 2; i++) {
    if (!remaining) break;
    if (remaining.length <= lineWidth || i === 1) {
      bodyLines.push(remaining.length > lineWidth ? remaining.slice(0, lineWidth - 1) + '\u2026' : remaining);
      break;
    }
    bodyLines.push(remaining.slice(0, lineWidth));
    remaining = remaining.slice(lineWidth);
  }
  // Pad to exactly 2 body lines for consistent height
  while (bodyLines.length < 2) bodyLines.push('');

  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text>{bgLine256(headerContent, cols, bgColor)}</Text>
      {bodyLines.map((line, i) => (
        <Text key={i}>{bgLine256(` ${fg256(textColor)}${line} `, cols, bgColor)}</Text>
      ))}
      <Text> </Text>
    </Box>
  );
}

function ToolCallItem({ item, selected, cols }: { item: DisplayItem & { kind: 'tool-call' }; selected: boolean; cols: number }): React.ReactElement {
  const cat = getToolCategory(item.toolName);
  const colorFn = TOOL_CATEGORY_COLORS[cat];
  const prefix = selected ? colorFn('\u258E') : ' ';

  const catLabel = pc.dim(cat);
  const badge = selected ? pc.bold(colorFn(item.toolName)) : colorFn(item.toolName);
  const input = toolInputSummary(item.toolName, item.toolInput);

  let status: string;
  let resultHint: string;
  if (item.result) {
    if (item.result.isError) {
      status = pc.red('\u2717');
      const errText = item.result.content.replace(/\n/g, ' ').slice(0, 40);
      resultHint = pc.red(pc.dim(errText));
    } else {
      status = pc.green('\u2713');
      const summary = toolResultSummary(item.result.content);
      resultHint = pc.dim(summary);
    }
  } else {
    status = pc.dim('\u00B7');
    resultHint = '';
  }

  const fixedWidth = cat.length + item.toolName.length + 10;
  const maxInputLen = Math.max(cols - fixedWidth - 20, 10);
  const inputText = input
    ? selected
      ? pc.white(input.length > maxInputLen ? input.slice(0, maxInputLen - 1) + '\u2026' : input)
      : pc.dim(input.length > maxInputLen ? input.slice(0, maxInputLen - 1) + '\u2026' : input)
    : '';

  return <Text>{`${prefix} ${catLabel} ${badge}  ${inputText}  ${status} ${resultHint}`}</Text>;
}

function ThinkingItem({ item, selected, cols }: { item: DisplayItem & { kind: 'thinking' }; selected: boolean; cols: number }): React.ReactElement {
  const prefix = selected ? pc.magenta('\u258E') : ' ';
  const dots = selected ? pc.magenta('\u00B7\u00B7\u00B7') : pc.dim('\u00B7\u00B7\u00B7');
  const label = selected ? pc.white('thinking') : pc.dim('thinking');

  if (item.redacted) {
    return <Text>{`${prefix} ${dots} ${label}  ${pc.dim('(redacted)')}`}</Text>;
  }

  const tokensLabel = item.tokenEstimate > 0 ? pc.dim(`~${formatTokens(item.tokenEstimate)}`) : '';
  const firstLine = item.content.split('\n').find((l) => l.trim().length > 0) || '';
  const usedWidth = 22 + (item.tokenEstimate > 0 ? 8 : 0);
  const maxPreview = Math.max(cols - usedWidth, 20);
  const previewText = firstLine.trim().length > maxPreview ? firstLine.trim().slice(0, maxPreview - 1) + '\u2026' : firstLine.trim();
  const preview = selected ? pc.italic(pc.dim(previewText)) : pc.dim(pc.italic(previewText));

  return <Text>{`${prefix} ${dots} ${label}  ${tokensLabel}  ${preview}`}</Text>;
}

function SystemItem({ msg, selected, cols }: { msg: SessionMessage; selected: boolean; cols: number }): React.ReactElement {
  const prefix = selected ? pc.dim('\u258E') : ' ';
  let symbol: string;
  let text: string;

  switch (msg.type) {
    case 'system': {
      const subtype = 'subtype' in msg ? (msg as any).subtype : '';
      if (subtype === 'turn_duration') {
        symbol = selected ? pc.white('\u23F1') : pc.dim('\u23F1');
        text = formatDuration((msg as any).durationMs || 0);
      } else if (subtype === 'api_error') {
        symbol = selected ? pc.red('\u26A0') : pc.dim('\u26A0');
        text = `api error (retry ${(msg as any).retryAttempt}/${(msg as any).maxRetries})`;
      } else if (subtype === 'compact_boundary') {
        symbol = selected ? pc.white('\u25C7') : pc.dim('\u25C7');
        const content = (msg as any).content || '';
        const maxLen = Math.max(cols - 16, 20);
        const contentText = content.replace(/\n/g, ' ');
        text = `compacted ${contentText.length > maxLen ? contentText.slice(0, maxLen - 1) + '\u2026' : contentText}`;
      } else if (subtype === 'stop_hook_summary') {
        symbol = selected ? pc.white('\u25A0') : pc.dim('\u25A0');
        text = `stop hook (${(msg as any).hookCount || 0} hooks)`;
      } else {
        symbol = selected ? pc.white('\u25C6') : pc.dim('\u25C6');
        const content =
          'content' in msg && typeof (msg as any).content === 'string'
            ? (msg as any).content.replace(/\n/g, ' ')
            : subtype || 'system';
        const maxLen = Math.max(cols - 8, 20);
        text = content.length > maxLen ? content.slice(0, maxLen - 1) + '\u2026' : content;
      }
      break;
    }
    case 'summary': {
      symbol = selected ? pc.white('\u00A7') : pc.dim('\u00A7');
      const summary = ((msg as any).summary || '').replace(/\n/g, ' ');
      const maxLen = Math.max(cols - 8, 20);
      text = pc.italic(summary.length > maxLen ? summary.slice(0, maxLen - 1) + '\u2026' : summary);
      break;
    }
    case 'progress': {
      symbol = selected ? pc.white('\u27F3') : pc.dim('\u27F3');
      const data = (msg as any).data;
      if (data?.type === 'bash_progress') {
        const maxLen = Math.max(cols - 14, 20);
        const output = (data.output || '').replace(/\n/g, ' ');
        text = `bash ${output.length > maxLen ? output.slice(0, maxLen - 1) + '\u2026' : output}`;
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
      symbol = selected ? pc.white('\u00B7') : pc.dim('\u00B7');
      if (msg.type === 'saved_hook_context') {
        text = `${msg.type} ${(msg as any).hookName || ''}`;
      } else if (msg.type === 'queue-operation') {
        text = `queue ${(msg as any).operation || ''}`;
      } else if (msg.type === 'last-prompt') {
        text = `last-prompt`;
      } else if (msg.type === ('custom-title' as any)) {
        text = `title: ${(msg as any).customTitle || ''}`;
      } else if (msg.type === ('agent-name' as any)) {
        text = `agent: ${(msg as any).agentName || ''}`;
      } else {
        text = msg.type;
      }
      break;
    }
  }

  const styledText = selected ? pc.white(text) : pc.dim(text);
  return <Text>{`${prefix} ${symbol} ${styledText}`}</Text>;
}

function DisplayItemRenderer({ item, selected, cols }: ItemRendererProps): React.ReactElement {
  if (item.kind === 'tool-call') {
    return <ToolCallItem item={item} selected={selected} cols={cols} />;
  }
  if (item.kind === 'thinking') {
    return <ThinkingItem item={item} selected={selected} cols={cols} />;
  }

  const msg = item.msg;
  if (msg.type === 'user') {
    return <UserItem msg={msg} selected={selected} cols={cols} />;
  }
  if (msg.type === 'assistant') {
    return <AssistantItem msg={msg} selected={selected} cols={cols} />;
  }
  return <SystemItem msg={msg} selected={selected} cols={cols} />;
}

// ─── Item Height Helper ────────────────────────────────────────────────

function getItemHeight(item: DisplayItem): number {
  if (item.kind === 'tool-call') return 1;
  if (item.kind === 'thinking') return 1;
  if (item.kind === 'message') {
    if (item.msg.type === 'user') return 6;      // margin + header + 3 body + margin
    if (item.msg.type === 'assistant') return 5;  // margin + header + 2 body + margin
    return 1; // system/other single line
  }
  return 1;
}

// ─── MessagesView ──────────────────────────────────────────────────────

export interface MessagesViewProps {
  project: ProjectListItem;
  session: SessionListItem;
  sessionIndex: number;
  /** Optional initial display-item index to scroll to (e.g. from search navigation) */
  initialIndex?: number;
}

export function MessagesView({ project, session, sessionIndex, initialIndex }: MessagesViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  const [filters, setFilters] = useState<FilterState>(createDefaultFilters);
  const [allMessages, setAllMessages] = useState<SessionMessage[]>([]);
  const [loadedOffsetLow, setLoadedOffsetLow] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Initial load
  useEffect(() => {
    const probe = api.getSessionMessages(project.slug, session.sessionId, 1, 0);
    const total = probe.total;
    setTotalCount(total);

    const startOffset = Math.max(0, total - PAGE_SIZE);
    const page = api.getSessionMessages(project.slug, session.sessionId, PAGE_SIZE, startOffset);
    setAllMessages(page.messages);
    setLoadedOffsetLow(startOffset);
  }, [api, project.slug, session.sessionId]);

  const allDisplayItems = useMemo(() => buildDisplayItems(allMessages), [allMessages]);
  const displayItems = useMemo(() => applyDisplayFilters(allDisplayItems, filters), [allDisplayItems, filters]);

  const { selectedIndex, scrollOffset, moveUp, moveDown, jumpTo } = useListNavigation({
    itemCount: displayItems.length,
    itemHeight: 2, // approximate: mix of 1-line and 4-line items
  });

  // Jump to initialIndex once display items are loaded
  const initialJumpDone = useRef(false);
  useEffect(() => {
    if (initialIndex != null && !initialJumpDone.current && displayItems.length > 0) {
      initialJumpDone.current = true;
      const target = Math.min(initialIndex, displayItems.length - 1);
      jumpTo(target);
    }
  }, [initialIndex, displayItems.length, jumpTo]);

  // Load more messages when scrolling near bottom
  const loadMoreMessages = useCallback(() => {
    if (loadedOffsetLow <= 0) return;
    const nextOffset = Math.max(0, loadedOffsetLow - PAGE_SIZE);
    const fetchSize = loadedOffsetLow - nextOffset;
    if (fetchSize <= 0) return;

    const olderPage = api.getSessionMessages(project.slug, session.sessionId, fetchSize, nextOffset);
    setLoadedOffsetLow(nextOffset);
    setAllMessages((prev) => [...olderPage.messages, ...prev]);
  }, [api, project.slug, session.sessionId, loadedOffsetLow]);

  // Build filter chips + count label for display within this view
  const total = allDisplayItems.length;
  const shown = displayItems.length;
  const countLabel = total === shown ? `(${total})` : `(${shown}/${total})`;
  const filterChipsLine = `${buildFilterChips(filters)}  ${countLabel}`;

  // Key handling
  useInput((input, key) => {
    // Filter toggles
    if (input >= '1' && input <= '6') {
      setFilters((prev) => ({ ...prev, [input]: !prev[input] }));
      return;
    }

    if (key.upArrow) {
      moveUp();
    } else if (key.downArrow) {
      moveDown();
      // Load more when near bottom
      if (loadedOffsetLow > 0 && selectedIndex >= displayItems.length - LOAD_MORE_THRESHOLD) {
        loadMoreMessages();
      }
    } else if (key.return) {
      if (displayItems.length === 0) return;
      const selected = displayItems[selectedIndex];
      if (!selected) return;

      let detailBreadcrumb: string;
      let detailItem = selected;

      if (selected.kind === 'tool-call') {
        detailBreadcrumb = `${selected.toolName} ${toolInputSummary(selected.toolName, selected.toolInput).slice(0, 40)}`;
      } else if (selected.kind === 'thinking') {
        const label = selected.redacted ? 'Redacted Thinking' : 'Thinking';
        const tokLabel = !selected.redacted && selected.tokenEstimate > 0 ? ` ~${formatTokens(selected.tokenEstimate)} tokens` : '';
        detailBreadcrumb = `${label}${tokLabel}`;
      } else {
        const role = selected.msg.type || '';
        const ts = 'timestamp' in selected.msg && (selected.msg as any).timestamp
          ? formatRelativeTime((selected.msg as any).timestamp)
          : '';
        detailBreadcrumb = `Message ${selectedIndex + 1} (${role} \u00B7 ${ts})`;
      }

      const entry: ViewEntry = {
        type: 'detail',
        component: () => <DetailView item={detailItem} />,
        breadcrumb: detailBreadcrumb,
        hints: '\u2191\u2193 scroll  Esc back  q quit',
      };
      nav.push(entry);
    } else if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.searchMode });

  // Calculate visible range
  // We need variable-height items, so do line-based viewport math
  const viewportLines = Math.max(termRows - 8, 5); // header + filter chips + hrule + footer

  // Collect visible items within viewport line budget
  const visibleItems: Array<{ item: DisplayItem; index: number }> = [];
  let usedLines = 0;
  for (let i = scrollOffset; i < displayItems.length; i++) {
    const h = getItemHeight(displayItems[i]);
    if (usedLines + h > viewportLines && usedLines > 0) break;
    visibleItems.push({ item: displayItems[i], index: i });
    usedLines += h;
  }

  // Pad remaining viewport lines so the footer stays fixed at the bottom
  const padLines = Math.max(0, viewportLines - usedLines);

  return (
    <Box flexDirection="column">
      <Text>  {filterChipsLine}</Text>
      <HRule />
      {displayItems.length === 0 ? (
        <Box flexDirection="column" height={viewportLines}>
          <Box paddingLeft={2} marginTop={1}>
            <Text dimColor>No messages match current filters.</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" height={viewportLines}>
          {visibleItems.map(({ item, index }) => (
            <DisplayItemRenderer
              key={`${index}-${item.kind}`}
              item={item}
              selected={index === selectedIndex}
              cols={cols}
            />
          ))}
          {padLines > 0 && (
            <Box height={padLines} />
          )}
        </Box>
      )}
    </Box>
  );
}
