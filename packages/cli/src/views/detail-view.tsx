/**
 * DetailView — Scrollable content for messages, tool calls, and thinking blocks
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { DisplayItem } from './display-items.js';
import { getToolCategory, TOOL_CATEGORY_COLORS, toolInputSummary } from './display-items.js';
import { useViewNav } from './context.js';
import { renderMessage } from '../lib/message-render.js';
import { formatTokens } from '../lib/format.js';
import pc from 'picocolors';

// ─── Content Builders ──────────────────────────────────────────────────

function buildMessageContent(item: DisplayItem & { kind: 'message' }, width: number): string[] {
  const rendered = renderMessage(item.msg, { width: width - 4 });
  return rendered.split('\n');
}

function buildToolCallContent(item: DisplayItem & { kind: 'tool-call' }, width: number): string[] {
  const cat = getToolCategory(item.toolName);
  const colorFn = TOOL_CATEGORY_COLORS[cat];

  const lines: string[] = [];
  lines.push(colorFn(pc.bold(item.toolName)));
  lines.push('');

  // Input details
  lines.push(pc.white('Input:'));
  const input = item.toolInput;
  for (const [key, value] of Object.entries(input)) {
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    const valLines = valStr.split('\n');
    const maxValLen = Math.max(width - key.length - 4, 20);
    if (valLines.length <= 1) {
      const truncVal = valStr.length > maxValLen ? valStr.slice(0, maxValLen - 1) + '\u2026' : valStr;
      lines.push(`  ${pc.dim(key + ':')} ${truncVal}`);
    } else {
      const truncFirst = valLines[0].length > maxValLen ? valLines[0].slice(0, maxValLen - 1) + '\u2026' : valLines[0];
      lines.push(`  ${pc.dim(key + ':')} ${truncFirst}`);
      const maxShownLines = 20;
      for (let i = 1; i < Math.min(valLines.length, maxShownLines); i++) {
        const truncLine = valLines[i].length > (width - 2) ? valLines[i].slice(0, width - 3) + '\u2026' : valLines[i];
        lines.push(`  ${truncLine}`);
      }
      if (valLines.length > maxShownLines) {
        lines.push(pc.dim(`  ... (${valLines.length - maxShownLines} more lines)`));
      }
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

  return lines;
}

function buildThinkingContent(item: DisplayItem & { kind: 'thinking' }): string[] {
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

  return lines;
}

// ─── DetailView ────────────────────────────────────────────────────────

export interface DetailViewProps {
  item: DisplayItem;
}

export function DetailView({ item }: DetailViewProps): React.ReactElement {
  const nav = useViewNav();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const viewportHeight = Math.max(termRows - 6, 5);

  const [scrollOffset, setScrollOffset] = useState(0);

  const contentLines = useMemo(() => {
    if (item.kind === 'tool-call') {
      return buildToolCallContent(item, cols);
    }
    if (item.kind === 'thinking') {
      return buildThinkingContent(item);
    }
    return buildMessageContent(item, cols);
  }, [item, cols]);

  useInput((input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, Math.max(0, contentLines.length - viewportHeight)));
    } else if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.commandMode });

  const visibleLines = contentLines.slice(scrollOffset, scrollOffset + viewportHeight);

  // Pad to fill viewport
  while (visibleLines.length < viewportHeight) {
    visibleLines.push('');
  }

  const posIndicator = pc.dim(`[${scrollOffset + 1} / ${contentLines.length} lines]`);

  return (
    <Box flexDirection="column">
      {visibleLines.map((line, i) => (
        <Text key={i}>  {line}</Text>
      ))}
      <Text dimColor>  {posIndicator}</Text>
    </Box>
  );
}
