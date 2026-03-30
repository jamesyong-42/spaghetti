/**
 * TodosView — Scrollable list of session todos with status indicators
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';

// ─── Status helpers ───────────────────────────────────────────────────

interface TodoItem {
  content: string;
  status: string;
}

function parseTodo(item: unknown): TodoItem {
  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    return {
      content: typeof obj.content === 'string' ? obj.content : String(obj.content ?? ''),
      status: typeof obj.status === 'string' ? obj.status : 'unknown',
    };
  }
  return { content: String(item), status: 'unknown' };
}

function TodoLine({ todo, cols }: { todo: TodoItem; cols: number }): React.ReactElement {
  const maxLen = Math.max(cols - 8, 20);
  const text = todo.content.length > maxLen ? todo.content.slice(0, maxLen - 1) + '\u2026' : todo.content;

  switch (todo.status) {
    case 'completed':
      return <Text>  <Text color="green">{'\u2713'}</Text> <Text dimColor>{text}</Text></Text>;
    case 'in_progress':
      return <Text>  <Text color="yellow">{'\u25D0'}</Text> <Text color="yellow">{text}</Text></Text>;
    case 'pending':
      return <Text>  <Text color="white">{'\u25CB'}</Text> <Text>{text}</Text></Text>;
    default:
      return <Text>  <Text dimColor>{'\u00B7'}</Text> <Text dimColor>{text}</Text></Text>;
  }
}

// ─── TodosView ────────────────────────────────────────────────────────

export interface TodosViewProps {
  projectSlug: string;
  sessionId: string;
}

export function TodosView({ projectSlug, sessionId }: TodosViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  const rawTodos = useMemo(() => api.getSessionTodos(projectSlug, sessionId), [api, projectSlug, sessionId]);
  const todos = useMemo(() => rawTodos.map(parseTodo), [rawTodos]);

  const [scrollOffset, setScrollOffset] = useState(0);
  const viewportHeight = Math.max(termRows - 6, 5);
  const maxScroll = Math.max(0, todos.length - viewportHeight);

  useInput((_input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
    } else if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.commandMode });

  if (todos.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No todos in this session.</Text>
      </Box>
    );
  }

  const visibleTodos = todos.slice(scrollOffset, scrollOffset + viewportHeight);

  return (
    <Box flexDirection="column">
      {visibleTodos.map((todo, i) => (
        <TodoLine key={scrollOffset + i} todo={todo} cols={cols} />
      ))}
    </Box>
  );
}
