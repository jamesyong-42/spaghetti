/**
 * BootView — Branded loading screen shown during core initialization
 *
 * Displays the wordmark, a progress bar, status text, and elapsed time.
 * Uses manually rendered box borders (not Ink's borderStyle) to avoid
 * rendering artifacts during frequent progress updates.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTerminalSize } from './hooks.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface BootViewProps {
  version: string;
  progress: { message: string; current: number; total: number };
  elapsed: number; // seconds
  error?: string | null;
  onQuit?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const BAR_WIDTH = 36;

function padTo(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function shortenMessage(message: string): string {
  return message.replace(/(?:Parsed\s+)-[A-Za-z]+-[A-Za-z]+-.*?-([^-\s(]+)/, 'Parsed $1');
}

// ─── BootView ─────────────────────────────────────────────────────────

export function BootView({ version, progress, elapsed, error, onQuit }: BootViewProps): React.ReactElement {
  const { cols } = useTerminalSize();

  useInput((input) => {
    if (input === 'q' && error && onQuit) {
      onQuit();
    }
  });

  const innerWidth = cols - 2;
  const titleText = ` Spaghetti v${version} `;
  const titleFill = cols - 2 - titleText.length;
  const topBorder = `╭${titleText}${'─'.repeat(Math.max(titleFill, 0))}╮`;
  const bottomBorder = `╰${'─'.repeat(Math.max(cols - 2, 0))}╯`;

  // Wordmark
  const wm = [
    '  ▄▀▀ █▀█ ▄▀▄ █▀▀ █ █ █▀▀ ▀█▀ ▀█▀ █',
    '  ▀▄▄ █▀▀ █▀█ █ █ █▀█ █▀   █   █  █',
    '  ▄▄▀ █   █ █ ▀▀▀ ▀ ▀ ▀▀▀  ▀   ▀  ▀',
  ];

  const contentLines: string[] = [];
  contentLines.push(''); // blank after title

  // Wordmark
  for (const line of wm) {
    contentLines.push(padTo(line, innerWidth));
  }
  contentLines.push(''); // blank after wordmark

  if (error) {
    // Error state
    contentLines.push(padTo('  untangle your claude code history', innerWidth));
    contentLines.push('');
    contentLines.push(padTo(`  \u2717 Failed to initialize`, innerWidth));
    contentLines.push('');
    contentLines.push(padTo(`  ${error.slice(0, innerWidth - 4)}`, innerWidth));
    contentLines.push('');
    contentLines.push(padTo('  Press q to quit', innerWidth));
  } else {
    // Progress state
    contentLines.push(padTo('  untangle your claude code history', innerWidth));
    contentLines.push('');

    // Progress bar line
    const ratio = progress.total > 0 ? Math.min(progress.current / progress.total, 1) : 0;
    const filled = Math.round(BAR_WIDTH * ratio);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);
    const countStr = progress.total > 0 ? `${progress.current}/${progress.total}` : '';
    const shortMsg = shortenMessage(progress.message);
    const statusPart = countStr ? `${countStr}  ${shortMsg}` : shortMsg;
    const barLine = `  ${bar}  ${statusPart}`;
    contentLines.push(padTo(barLine, innerWidth));

    // Elapsed time right-aligned
    const elapsedStr = `${elapsed.toFixed(1)}s`;
    const elapsedLine = ' '.repeat(Math.max(innerWidth - elapsedStr.length - 2, 0)) + elapsedStr + '  ';
    contentLines.push(elapsedLine);
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{topBorder}</Text>
      {contentLines.map((line, i) => (
        <Text key={i}>
          <Text dimColor>│</Text>
          {padTo(line, innerWidth)}
          <Text dimColor>│</Text>
        </Text>
      ))}
      <Text dimColor>{bottomBorder}</Text>
    </Box>
  );
}
