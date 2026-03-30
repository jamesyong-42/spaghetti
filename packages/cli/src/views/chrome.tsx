/**
 * Chrome components — Header, Footer, HRule shared across all views
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from './hooks.js';

// ─── HRule ─────────────────────────────────────────────────────────────

export function HRule(): React.ReactElement {
  const { cols } = useTerminalSize();
  return <Text dimColor>{'─'.repeat(cols)}</Text>;
}

// ─── Header ────────────────────────────────────────────────────────────

export interface HeaderProps {
  breadcrumb: string;
  /** Optional second line (e.g. filter chips in messages view) */
  subtitle?: string;
}

export function Header({ breadcrumb, subtitle }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>  {breadcrumb}</Text>
      {subtitle ? <Text>  {subtitle}</Text> : null}
      <HRule />
    </Box>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────

export interface FooterProps {
  hints: string;
}

export function Footer({ hints }: FooterProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <HRule />
      <Text dimColor>  {hints}</Text>
    </Box>
  );
}
