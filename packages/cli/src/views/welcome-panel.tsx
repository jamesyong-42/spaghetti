/**
 * WelcomePanel — Two-column branded header shown on the home screen
 *
 * Left column: wordmark, tagline, data path + perf
 * Right column: stats summary, divider, command hints
 *
 * Uses manually rendered box borders (not Ink's borderStyle) to avoid
 * rendering artifacts on terminal resize. Ink's border diff algorithm
 * produces cascading box glitches when the width changes dynamically.
 *
 * Responsive: hides right column below 70 cols, hides entirely below 50 cols.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { createRequire } from 'node:module';
import { Wordmark } from './wordmark.js';
import { useTerminalSize } from './hooks.js';

// ─── Version ──────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const VERSION = (_require('../package.json') as { version: string }).version;

// ─── Types ────────────────────────────────────────────────────────────

export interface WelcomePanelStats {
  projects: number;
  sessions: number;
  messages: number;
  tokens: string; // pre-formatted like "66.3M"
}

export interface WelcomePanelProps {
  stats: WelcomePanelStats;
  dataPath: string;  // e.g., "~/.claude"
  dataSize: string;  // e.g., "512 MB"
  initMs: number;    // e.g., 28
}

// ─── Helpers ──────────────────────────────────────────────────────────

const STATS_COL_WIDTH = 24;
const DIVIDER_COL = '│';

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

/** Pad or truncate a string to exact width */
function padTo(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

/** Right-align a value within a label row */
function statsLine(label: string, value: string, width: number): string {
  const gap = width - label.length - value.length;
  return label + (gap > 0 ? ' '.repeat(gap) : ' ') + value;
}

// ─── WelcomePanel ─────────────────────────────────────────────────────

export function WelcomePanel({ stats, dataPath, dataSize, initMs }: WelcomePanelProps): React.ReactElement | null {
  const { cols } = useTerminalSize();

  if (cols < 50) return null;

  // Full terminal width minus the two border characters (│ │)
  const innerWidth = cols - 2;
  const showRight = cols >= 70;
  const rightWidth = STATS_COL_WIDTH;
  const leftWidth = showRight ? innerWidth - rightWidth - 3 : innerWidth; // 3 = " │ "

  // Build the title bar: ╭ Spaghetti v0.2.2 ────...─╮
  const titleText = ` Spaghetti v${VERSION} `;
  const titlePad = innerWidth - titleText.length - 2; // -2 for ╭╮
  const topBorder = `╭${titleText}${'─'.repeat(Math.max(titlePad, 0))}╮`;
  const bottomBorder = `╰${'─'.repeat(innerWidth)}╯`;
  const emptyLine = `│${' '.repeat(innerWidth)}│`;

  // Build content lines — each is exactly innerWidth chars inside │...│
  const contentLines: string[] = [];

  // Wordmark lines (hardcoded widths are stable)
  const wm = [
    '  ▄▀▀ █▀█ ▄▀▄ █▀▀ █ █ █▀▀ ▀█▀ ▀█▀ █',
    '  ▀▄▄ █▀▀ █▀█ █ █ █▀█ █▀   █   █  █',
    '  ▄▄▀ █   █ █ ▀▀▀ ▀ ▀ ▀▀▀  ▀   ▀  ▀',
  ];
  const tagline = '  untangle your claude code history';
  const perfLine = `  ${dataPath} · ${dataSize}${initMs > 0 ? ` · ${initMs}ms` : ''}`;

  // Right column lines (if shown)
  const rightLines = showRight
    ? [
        statsLine('Projects', formatNum(stats.projects), rightWidth),
        statsLine('Sessions', formatNum(stats.sessions), rightWidth),
        statsLine('Messages', formatNum(stats.messages), rightWidth),
        statsLine('Tokens', stats.tokens, rightWidth),
        '',
        '─'.repeat(rightWidth),
        '/search  /stats  /help',
      ]
    : [];

  // Left column content (9 lines: blank, wm x3, blank, tagline, blank, perf, blank)
  const leftLines = [
    '',
    ...wm,
    '',
    tagline,
    '',
    perfLine,
    '',
  ];

  // Combine left + right into full-width content lines.
  // Each line must be exactly innerWidth chars so the right │ aligns.
  const maxLines = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxLines; i++) {
    const left = (leftLines[i] ?? '');
    if (showRight) {
      const right = (rightLines[i] ?? '');
      const paddedLeft = padTo(left, leftWidth);
      const paddedRight = padTo(right, rightWidth);
      // left + " │ " + right = leftWidth + 3 + rightWidth
      // Pad the whole line to innerWidth to catch any rounding
      contentLines.push(padTo(`${paddedLeft} ${DIVIDER_COL} ${paddedRight}`, innerWidth));
    } else {
      contentLines.push(padTo(left, innerWidth));
    }
  }

  // Render as plain Text lines — no Ink borderStyle
  return (
    <Box flexDirection="column">
      <Text dimColor>{topBorder}</Text>
      {contentLines.map((line, i) => (
        <Text key={i}>
          <Text dimColor>│</Text>
          {line}
          <Text dimColor>│</Text>
        </Text>
      ))}
      <Text dimColor>{bottomBorder}</Text>
    </Box>
  );
}
