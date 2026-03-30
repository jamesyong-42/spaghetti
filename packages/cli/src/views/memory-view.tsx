/**
 * MemoryView — Scrollable text view showing project MEMORY.md content
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';

// ─── Simple Markdown Rendering ────────────────────────────────────────

function renderMarkdownLines(content: string): React.ReactElement[] {
  return content.split('\n').map((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      const text = trimmed.replace(/^#+\s*/, '');
      return <Text key={i} bold>  {text}</Text>;
    }
    return <Text key={i} dimColor={trimmed === ''}>  {line}</Text>;
  });
}

// ─── MemoryView ───────────────────────────────────────────────────────

export interface MemoryViewProps {
  projectSlug: string;
}

export function MemoryView({ projectSlug }: MemoryViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const content = useMemo(() => api.getProjectMemory(projectSlug), [api, projectSlug]);
  const lines = useMemo(() => (content ? renderMarkdownLines(content) : []), [content]);

  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScroll = Math.max(0, lines.length - Math.max(termRows - 6, 5));
  const viewportHeight = Math.max(termRows - 6, 5);

  useInput((_input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
    } else if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.commandMode });

  if (!content) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No MEMORY.md found for this project.</Text>
      </Box>
    );
  }

  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);

  return (
    <Box flexDirection="column">
      {visibleLines}
    </Box>
  );
}
