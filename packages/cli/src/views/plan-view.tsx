/**
 * PlanView — Scrollable text view showing session plan content
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

// ─── Extract plan text ────────────────────────────────────────────────

function extractPlanContent(plan: unknown): string | null {
  if (plan === null || plan === undefined) return null;
  if (typeof plan === 'string') return plan;
  if (typeof plan === 'object') {
    const obj = plan as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.plan === 'string') return obj.plan;
    if (typeof obj.text === 'string') return obj.text;
    // Fallback: stringify
    return JSON.stringify(plan, null, 2);
  }
  return String(plan);
}

// ─── PlanView ─────────────────────────────────────────────────────────

export interface PlanViewProps {
  projectSlug: string;
  sessionId: string;
}

export function PlanView({ projectSlug, sessionId }: PlanViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const rawPlan = useMemo(() => api.getSessionPlan(projectSlug, sessionId), [api, projectSlug, sessionId]);
  const content = useMemo(() => extractPlanContent(rawPlan), [rawPlan]);
  const lines = useMemo(() => (content ? renderMarkdownLines(content) : []), [content]);

  const [scrollOffset, setScrollOffset] = useState(0);
  const viewportHeight = Math.max(termRows - 6, 5);
  const maxScroll = Math.max(0, lines.length - viewportHeight);

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
        <Text dimColor>No plan in this session.</Text>
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
