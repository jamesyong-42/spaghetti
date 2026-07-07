/**
 * Chrome components — Header, Footer, HRule shared across all views
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { IngestEngine } from '@vibecook/spaghetti-sdk';
import { useTerminalSize } from './hooks.js';

// ─── EngineBadge ───────────────────────────────────────────────────────

/**
 * Compact indicator of the ingest engine actually in use this session.
 * `rs` (Rust native) renders green, `ts` (TypeScript fallback) cyan —
 * fed the *effective* engine (`resolveActiveEngine().engine`), so it
 * reads `TS` when an `rs` preference silently fell back to TypeScript
 * because the native addon isn't installed.
 */
export function EngineBadge({ engine }: { engine: IngestEngine }): React.ReactElement {
  const isRust = engine === 'rs';
  const color = isRust ? 'green' : 'cyan';
  return (
    <Text>
      <Text dimColor>engine </Text>
      <Text color={color} bold>
        {'●'} {isRust ? 'RS' : 'TS'}
      </Text>
      <Text> </Text>
    </Text>
  );
}

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
      <Text> {breadcrumb}</Text>
      {subtitle ? <Text> {subtitle}</Text> : null}
      <HRule />
    </Box>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────

export interface FooterProps {
  hints: string;
  /** Effective ingest engine — shown as a right-aligned badge. Omit to hide. */
  engine?: IngestEngine;
}

export function Footer({ hints, engine }: FooterProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <HRule />
      <Box>
        <Box flexGrow={1}>
          <Text dimColor> {hints}</Text>
        </Box>
        {engine ? <EngineBadge engine={engine} /> : null}
      </Box>
    </Box>
  );
}
