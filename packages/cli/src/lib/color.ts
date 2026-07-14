/**
 * Color theme — consistent styling across all CLI output
 */

import pc from 'picocolors';

export const theme = {
  heading: (s: string) => pc.bold(s),
  label: (s: string) => pc.dim(s),
  value: (s: string) => pc.white(s),
  accent: (s: string) => pc.cyan(s),
  success: (s: string) => pc.green(s),
  warning: (s: string) => pc.yellow(s),
  error: (s: string) => pc.red(s),
  muted: (s: string) => pc.dim(s),
  project: (s: string) => pc.bold(pc.cyan(s)),
  tokens: (s: string) => pc.yellow(s),
  time: (s: string) => pc.dim(s),
  bar: (s: string) => pc.green(s),
  barEmpty: (s: string) => pc.dim(s),
  session: (s: string) => pc.bold(pc.yellow(s)),
  message: (s: string) => pc.bold(pc.green(s)),
  detail: (s: string) => pc.bold(pc.magenta(s)),
  /** Short, color-coded agent label from a `source_id` (RFC 006 multi-source). */
  agent: (sourceId: string): string => {
    switch (sourceId) {
      case 'claude-code':
        return pc.cyan('claude');
      case 'codex':
        return pc.magenta('codex');
      case 'grok':
        return pc.yellow('grok');
      default:
        return pc.dim(sourceId);
    }
  },

  /**
   * Uppercase assistant-role label for transcript headers (TUI / messages).
   * Claude Code → "CLAUDE", Codex → "CODEX", unknown → "ASSISTANT".
   */
  assistantName: (sourceId?: string): string => {
    switch (sourceId) {
      case 'claude-code':
      case undefined:
      case '':
        return 'CLAUDE';
      case 'codex':
        return 'CODEX';
      case 'grok':
        return 'GROK';
      default:
        return sourceId.replace(/-/g, ' ').toUpperCase().slice(0, 12) || 'ASSISTANT';
    }
  },

  /** Apply a named color */
  colorize: (color: string, s: string): string => {
    const fn = (pc as unknown as Record<string, unknown>)[color];
    return typeof fn === 'function' ? (fn as (s: string) => string)(s) : s;
  },
};
