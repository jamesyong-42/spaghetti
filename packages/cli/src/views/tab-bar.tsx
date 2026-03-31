/**
 * TabBar — Pill-style tab badges with rounded borders
 *
 * Active tab: background-filled (ANSI 256-color bg)
 * Inactive tabs: dim rounded borders (╭ ╮)
 *
 * Optionally prepends a breadcrumb path before the tabs,
 * separated by ► to distinguish navigation from tab switching.
 */

import React from 'react';
import { Box, Text } from 'ink';

// ─── Props ────────────────────────────────────────────────────────────

export interface TabBarProps {
  tabs: string[];
  activeIndex: number;
  onTabChange: (index: number) => void;
  /** Optional breadcrumb path to show before tabs (e.g., "truffle › #1") */
  breadcrumb?: string;
}

// ─── ANSI helpers ─────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const bg256 = (n: number) => `\x1b[48;5;${n}m`;
const fg256 = (n: number) => `\x1b[38;5;${n}m`;

// Active tab: white text on dark gray background
const ACTIVE_BG = 238; // #444444
const ACTIVE_FG = 255; // white

// Inactive tab: dim rounded borders
const INACTIVE_FG = 245; // gray

function activeTab(label: string): string {
  return `${bg256(ACTIVE_BG)}${fg256(ACTIVE_FG)}${BOLD} ${label} ${RESET}`;
}

function inactiveTab(label: string): string {
  return `${DIM}╭ ${RESET}${fg256(INACTIVE_FG)}${label}${RESET}${DIM} ╮${RESET}`;
}

// ─── TabBar Component ─────────────────────────────────────────────────

export function TabBar({ tabs, activeIndex, breadcrumb }: TabBarProps): React.ReactElement {
  const parts: string[] = [];

  if (breadcrumb) {
    parts.push(`  ${breadcrumb} \u25B8 `);
  } else {
    parts.push('  ');
  }

  for (let i = 0; i < tabs.length; i++) {
    if (i > 0) parts.push('  ');
    parts.push(i === activeIndex ? activeTab(tabs[i]) : inactiveTab(tabs[i]));
  }

  return (
    <Box>
      <Text>{parts.join('')}</Text>
    </Box>
  );
}
