/**
 * Message renderer — render SessionMessage objects for terminal display
 */

import type { SessionMessage, SystemMessage } from '@spaghetti/core';
import { theme } from './color.js';
import { formatRelativeTime, formatTokens } from './format.js';
import { getTerminalWidth } from './terminal.js';
import cliTruncate from 'cli-truncate';

export interface RenderOptions {
  compact?: boolean;
  noTools?: boolean;
  noThinking?: boolean;
  width?: number;
}

/**
 * Render a single SessionMessage for terminal display.
 */
export function renderMessage(msg: SessionMessage, opts?: RenderOptions): string {
  const width = opts?.width ?? getTerminalWidth();

  if (opts?.compact) {
    return renderCompact(msg, width, opts);
  }

  switch (msg.type) {
    case 'user':
      return renderUserMessage(msg, width);
    case 'assistant':
      return renderAssistantMessage(msg, width, opts);
    case 'system':
      return renderSystemMessage(msg, width);
    default:
      return renderOtherMessage(msg);
  }
}

/**
 * Render messages in compact (one-line-per-message) view.
 */
function renderCompact(msg: SessionMessage, width: number, opts?: RenderOptions): string {
  switch (msg.type) {
    case 'user': {
      const content = extractUserContent(msg);
      const preview = cliTruncate(content.replace(/\n/g, ' '), Math.max(width - 30, 20));
      return `  ${theme.accent('You')}     ${preview}`;
    }
    case 'assistant': {
      const payload = msg.message;
      const blocks = payload.content || [];
      const textBlocks = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
      const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
      const text = textBlocks.map((b) => b.text).join(' ').replace(/\n/g, ' ');
      const tokens = payload.usage
        ? formatTokens(payload.usage.input_tokens + payload.usage.output_tokens)
        : '';
      const toolCount = toolBlocks.length;
      const toolInfo = toolCount > 0 && !opts?.noTools ? theme.muted(` [${toolCount} tools]`) : '';
      const tokInfo = tokens ? theme.muted(` (${tokens})`) : '';
      const preview = cliTruncate(text, Math.max(width - 50, 20));
      return `  ${theme.success('Claude')}  ${preview}${tokInfo}${toolInfo}`;
    }
    case 'system': {
      const subtype = getSystemSubtype(msg);
      const content = getSystemContent(msg);
      const preview = cliTruncate(content.replace(/\n/g, ' '), Math.max(width - 30, 20));
      return `  ${theme.muted(`[${subtype}]`)} ${preview}`;
    }
    default:
      return `  ${theme.muted(`[${msg.type}]`)}`;
  }
}

function extractUserContent(msg: SessionMessage & { type: 'user' }): string {
  const payload = msg.message;
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_result') {
          const c = block.content;
          if (typeof c === 'string') return `[tool_result] ${c.slice(0, 100)}`;
          return '[tool_result]';
        }
        return `[${block.type}]`;
      })
      .join(' ');
  }
  return '';
}

function renderUserMessage(msg: SessionMessage & { type: 'user' }, width: number): string {
  const lines: string[] = [];
  const timestamp = 'timestamp' in msg && msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
  const headerLeft = theme.accent('You:');
  const headerRight = timestamp ? theme.muted(timestamp) : '';
  const gap = Math.max(width - 6 - timestamp.length, 0);
  lines.push(`  ${headerLeft}${' '.repeat(gap)}${headerRight}`);

  const content = extractUserContent(msg);
  if (content) {
    for (const line of content.split('\n')) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderAssistantMessage(
  msg: SessionMessage & { type: 'assistant' },
  width: number,
  opts?: RenderOptions,
): string {
  const lines: string[] = [];
  const payload = msg.message;
  const timestamp = 'timestamp' in msg && msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
  const tokenInfo = payload.usage
    ? theme.muted(` (${formatTokens(payload.usage.input_tokens + payload.usage.output_tokens)} tokens)`)
    : '';

  const headerLeft = theme.success('Claude:');
  const headerRight = timestamp ? theme.muted(timestamp) : '';
  lines.push(`  ${headerLeft}${tokenInfo}${headerRight ? '  ' + headerRight : ''}`);

  const blocks = payload.content || [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        for (const line of block.text.split('\n')) {
          lines.push(`  ${line}`);
        }
        break;

      case 'tool_use':
        if (!opts?.noTools) {
          const inputSummary = summarizeToolInput(block.input);
          lines.push(`  ${theme.warning(`[Tool: ${block.name}]`)} ${theme.muted(inputSummary)}`);
        }
        break;

      case 'thinking':
        if (!opts?.noThinking) {
          const thinkLen = block.thinking?.length ?? 0;
          const tokenEstimate = Math.round(thinkLen / 4);
          lines.push(`  ${theme.muted(`(thinking... ~${formatTokens(tokenEstimate)} tokens)`)}`);
        }
        break;

      case 'redacted_thinking':
        if (!opts?.noThinking) {
          lines.push(`  ${theme.muted('(redacted thinking)')}`);
        }
        break;
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderSystemMessage(msg: SessionMessage & { type: 'system' }, _width: number): string {
  const subtype = getSystemSubtype(msg);
  const content = getSystemContent(msg);
  const preview = content.replace(/\n/g, ' ').slice(0, 80);
  return `  ${theme.muted(`[system: ${subtype}]`)} ${theme.muted(preview)}`;
}

function renderOtherMessage(msg: SessionMessage): string {
  // Skip progress, file-history-snapshot, etc. — show one-line summary
  if (msg.type === 'summary') {
    const summary = msg.summary || '';
    return `  ${theme.muted('[summary]')} ${theme.muted(summary.slice(0, 80))}`;
  }
  return '';
}

/** Extract the subtype from a SystemMessage union. */
function getSystemSubtype(msg: SystemMessage): string {
  if ('subtype' in msg) return msg.subtype;
  return 'system';
}

/** Extract displayable content from a SystemMessage union. */
function getSystemContent(msg: SystemMessage): string {
  if ('content' in msg && typeof msg.content === 'string') return msg.content;
  if ('subtype' in msg && msg.subtype === 'turn_duration' && 'durationMs' in msg) {
    return `${msg.durationMs}ms`;
  }
  if ('subtype' in msg && msg.subtype === 'api_error' && 'cause' in msg) {
    return 'API error';
  }
  return '';
}

function summarizeToolInput(input: Record<string, unknown>): string {
  // Show the most relevant field from the tool input
  if ('command' in input && typeof input.command === 'string') {
    return input.command.slice(0, 60);
  }
  if ('file_path' in input && typeof input.file_path === 'string') {
    return input.file_path;
  }
  if ('pattern' in input && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if ('content' in input && typeof input.content === 'string') {
    return input.content.slice(0, 60);
  }
  if ('query' in input && typeof input.query === 'string') {
    return input.query.slice(0, 60);
  }
  if ('skill' in input && typeof input.skill === 'string') {
    return input.skill;
  }

  // Fallback: show keys
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return `{${keys.join(', ')}}`;
}

/**
 * Render a batch of messages for display (session transcript view).
 */
export function renderMessages(messages: SessionMessage[], opts?: RenderOptions): string {
  const lines: string[] = [];

  for (const msg of messages) {
    // Skip types that produce empty output
    if (msg.type === 'file-history-snapshot' || msg.type === 'progress' || msg.type === 'saved_hook_context') {
      continue;
    }
    if (msg.type === 'queue-operation' || msg.type === 'last-prompt') {
      continue;
    }

    const rendered = renderMessage(msg, opts);
    if (rendered) {
      lines.push(rendered);
    }
  }

  return lines.join('\n');
}
