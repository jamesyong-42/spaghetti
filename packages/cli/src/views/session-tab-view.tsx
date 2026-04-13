/**
 * SessionTabView — Tab container showing Messages + Todos + Plan + Subagents for a session
 *
 * Wraps MessagesView (tab 0) and inline content panels for Todos, Plan, Subagents (tabs 1-3).
 * Left/Right arrows switch tabs. Esc pops back to the sessions list.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ProjectListItem, SessionListItem, SubagentListItem } from '@vibecook/spaghetti-sdk';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';
import { TabBar } from './tab-bar.js';
import { HRule } from './chrome.js';
import { MessagesView } from './messages-view.js';
import { formatNumber } from '../lib/format.js';
import type { ViewEntry } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────

const TABS = ['Messages', 'Todos', 'Plan', 'Subagents'] as const;

// ─── Todo Helpers ─────────────────────────────────────────────────────

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

// ─── Plan Helpers ─────────────────────────────────────────────────────

function extractPlanContent(plan: unknown): string | null {
  if (plan === null || plan === undefined) return null;
  if (typeof plan === 'string') return plan;
  if (typeof plan === 'object') {
    const obj = plan as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.plan === 'string') return obj.plan;
    if (typeof obj.text === 'string') return obj.text;
    return JSON.stringify(plan, null, 2);
  }
  return String(plan);
}

function renderMarkdownLines(content: string): React.ReactElement[] {
  return content.split('\n').map((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      const text = trimmed.replace(/^#+\s*/, '');
      return (
        <Text key={i} bold>
          {' '}
          {text}
        </Text>
      );
    }
    return (
      <Text key={i} dimColor={trimmed === ''}>
        {' '}
        {line}
      </Text>
    );
  });
}

// ─── TodosPanel ───────────────────────────────────────────────────────

interface TodosPanelProps {
  projectSlug: string;
  sessionId: string;
  scrollOffset: number;
  viewportHeight: number;
}

function TodosPanel({ projectSlug, sessionId, scrollOffset, viewportHeight }: TodosPanelProps): React.ReactElement {
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const rawTodos = useMemo(() => api.getSessionTodos(projectSlug, sessionId), [api, projectSlug, sessionId]);
  const todos = useMemo(() => rawTodos.map(parseTodo), [rawTodos]);

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
      {visibleTodos.map((todo, i) => {
        const maxLen = Math.max(cols - 8, 20);
        const text = todo.content.length > maxLen ? todo.content.slice(0, maxLen - 1) + '\u2026' : todo.content;

        switch (todo.status) {
          case 'completed':
            return (
              <Text key={scrollOffset + i}>
                {' '}
                <Text color="green">{'\u2713'}</Text> <Text dimColor>{text}</Text>
              </Text>
            );
          case 'in_progress':
            return (
              <Text key={scrollOffset + i}>
                {' '}
                <Text color="yellow">{'\u25D0'}</Text> <Text color="yellow">{text}</Text>
              </Text>
            );
          case 'pending':
            return (
              <Text key={scrollOffset + i}>
                {' '}
                <Text color="white">{'\u25CB'}</Text> <Text>{text}</Text>
              </Text>
            );
          default:
            return (
              <Text key={scrollOffset + i}>
                {' '}
                <Text dimColor>{'\u00B7'}</Text> <Text dimColor>{text}</Text>
              </Text>
            );
        }
      })}
    </Box>
  );
}

// ─── PlanPanel ────────────────────────────────────────────────────────

interface PlanPanelProps {
  projectSlug: string;
  sessionId: string;
  scrollOffset: number;
  viewportHeight: number;
}

function PlanPanel({ projectSlug, sessionId, scrollOffset, viewportHeight }: PlanPanelProps): React.ReactElement {
  const api = useApi();

  const rawPlan = useMemo(() => api.getSessionPlan(projectSlug, sessionId), [api, projectSlug, sessionId]);
  const content = useMemo(() => extractPlanContent(rawPlan), [rawPlan]);
  const lines = useMemo(() => (content ? renderMarkdownLines(content) : []), [content]);

  if (!content) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No plan in this session.</Text>
      </Box>
    );
  }

  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);

  return <Box flexDirection="column">{visibleLines}</Box>;
}

// ─── SubagentsPanel ───────────────────────────────────────────────────

interface SubagentsPanelProps {
  projectSlug: string;
  sessionId: string;
  scrollOffset: number;
  selectedIndex: number;
  viewportHeight: number;
}

function SubagentsPanelCard({ agent, selected }: { agent: SubagentListItem; selected: boolean }): React.ReactElement {
  const prefix = selected ? '\x1b[35m\u258E\x1b[0m' : ' '; // magenta or space
  const typeName = selected ? `\x1b[1m\x1b[37m${agent.agentType}\x1b[0m` : `\x1b[35m${agent.agentType}\x1b[0m`;
  const agentId = `\x1b[2m${agent.agentId}\x1b[0m`;
  const msgCount = `\x1b[2m${formatNumber(agent.messageCount)} messages\x1b[0m`;

  return (
    <Box flexDirection="column">
      <Text>{`${prefix} ${typeName}  ${agentId}`}</Text>
      <Text>{`    ${msgCount}`}</Text>
      <Text> </Text>
    </Box>
  );
}

function SubagentsPanel({
  projectSlug,
  sessionId,
  scrollOffset,
  selectedIndex,
  viewportHeight,
}: SubagentsPanelProps): React.ReactElement {
  const api = useApi();

  const subagents = useMemo(() => api.getSessionSubagents(projectSlug, sessionId), [api, projectSlug, sessionId]);

  if (subagents.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No subagents in this session.</Text>
      </Box>
    );
  }

  const viewportItems = Math.max(1, Math.floor(viewportHeight / 3));
  const visibleAgents = subagents.slice(scrollOffset, scrollOffset + viewportItems);

  return (
    <Box flexDirection="column">
      {visibleAgents.map((agent, i) => {
        const actualIndex = scrollOffset + i;
        return <SubagentsPanelCard key={agent.agentId} agent={agent} selected={actualIndex === selectedIndex} />;
      })}
    </Box>
  );
}

// ─── SessionTabView ───────────────────────────────────────────────────

export interface SessionTabViewProps {
  project: ProjectListItem;
  session: SessionListItem;
  sessionIndex: number;
}

export function SessionTabView({ project, session, sessionIndex }: SessionTabViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const [activeTab, setActiveTab] = useState(0);

  // Scroll state for tabs 1-3 (Todos, Plan, Subagents)
  const [todosScroll, setTodosScroll] = useState(0);
  const [planScroll, setPlanScroll] = useState(0);
  const [subagentsScroll, setSubagentsScroll] = useState(0);
  const [subagentsSelected, setSubagentsSelected] = useState(0);

  // Compute max scroll values for tabs 1-3
  const viewportHeight = Math.max(termRows - 8, 5);

  const rawTodos = useMemo(
    () => api.getSessionTodos(project.slug, session.sessionId),
    [api, project.slug, session.sessionId],
  );
  const todosCount = rawTodos.length;
  const todosMaxScroll = Math.max(0, todosCount - viewportHeight);

  const rawPlan = useMemo(
    () => api.getSessionPlan(project.slug, session.sessionId),
    [api, project.slug, session.sessionId],
  );
  const planContent = useMemo(() => extractPlanContent(rawPlan), [rawPlan]);
  const planLineCount = useMemo(() => (planContent ? planContent.split('\n').length : 0), [planContent]);
  const planMaxScroll = Math.max(0, planLineCount - viewportHeight);

  const subagents = useMemo(
    () => api.getSessionSubagents(project.slug, session.sessionId),
    [api, project.slug, session.sessionId],
  );
  const subagentsCount = subagents.length;
  const subagentsViewportItems = Math.max(1, Math.floor(viewportHeight / 3));
  const subagentsMaxScroll = Math.max(0, subagentsCount - subagentsViewportItems);

  // Tab switching — always active (works on all tabs including Messages)
  useInput(
    (_input, key) => {
      if (key.leftArrow) {
        setActiveTab((prev) => Math.max(0, prev - 1));
      } else if (key.rightArrow) {
        setActiveTab((prev) => Math.min(TABS.length - 1, prev + 1));
      }
    },
    { isActive: !nav.searchMode },
  );

  // Key handling for non-Messages tabs (Todos, Plan, Subagents)
  // When Messages tab is active, MessagesView handles its own keys.
  useInput(
    (_input, key) => {
      if (activeTab === 1) {
        // Todos tab — scroll only
        if (key.upArrow) {
          setTodosScroll((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setTodosScroll((prev) => Math.min(todosMaxScroll, prev + 1));
        } else if (key.escape) {
          nav.pop();
        }
      } else if (activeTab === 2) {
        // Plan tab — scroll only
        if (key.upArrow) {
          setPlanScroll((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setPlanScroll((prev) => Math.min(planMaxScroll, prev + 1));
        } else if (key.escape) {
          nav.pop();
        }
      } else if (activeTab === 3) {
        // Subagents tab — list navigation + Enter for detail
        if (key.upArrow) {
          setSubagentsSelected((prev) => {
            const next = Math.max(0, prev - 1);
            // Adjust scroll if selection goes above viewport
            if (next < subagentsScroll) {
              setSubagentsScroll(next);
            }
            return next;
          });
        } else if (key.downArrow) {
          setSubagentsSelected((prev) => {
            const next = Math.min(subagentsCount - 1, prev + 1);
            // Adjust scroll if selection goes below viewport
            if (next >= subagentsScroll + subagentsViewportItems) {
              setSubagentsScroll(Math.min(subagentsMaxScroll, subagentsScroll + 1));
            }
            return next;
          });
        } else if (key.return) {
          if (subagentsCount === 0) return;
          const agent = subagents[subagentsSelected];
          if (!agent) return;

          const entry: ViewEntry = {
            type: 'detail',
            component: () => <SubagentTranscriptPlaceholder agentId={agent.agentId} agentType={agent.agentType} />,
            breadcrumb: `${agent.agentType} ${agent.agentId.slice(0, 8)}`,
            hints: 'Esc back',
          };
          nav.push(entry);
        } else if (key.escape) {
          nav.pop();
        }
      }
    },
    { isActive: activeTab !== 0 && !nav.searchMode },
  );

  // Build breadcrumb for the tab bar
  const tabBreadcrumb = `${project.folderName} \u203A #${sessionIndex + 1}`;

  return (
    <Box flexDirection="column">
      <TabBar tabs={[...TABS]} activeIndex={activeTab} onTabChange={setActiveTab} breadcrumb={tabBreadcrumb} />
      {activeTab === 0 && <MessagesView project={project} session={session} sessionIndex={sessionIndex} />}
      {activeTab !== 0 && <HRule />}
      {activeTab === 1 && (
        <TodosPanel
          projectSlug={project.slug}
          sessionId={session.sessionId}
          scrollOffset={todosScroll}
          viewportHeight={viewportHeight}
        />
      )}
      {activeTab === 2 && (
        <PlanPanel
          projectSlug={project.slug}
          sessionId={session.sessionId}
          scrollOffset={planScroll}
          viewportHeight={viewportHeight}
        />
      )}
      {activeTab === 3 && (
        <SubagentsPanel
          projectSlug={project.slug}
          sessionId={session.sessionId}
          scrollOffset={subagentsScroll}
          selectedIndex={subagentsSelected}
          viewportHeight={viewportHeight}
        />
      )}
    </Box>
  );
}

// ─── Placeholder for subagent transcript ──────────────────────────────

function SubagentTranscriptPlaceholder({
  agentId,
  agentType,
}: {
  agentId: string;
  agentType: string;
}): React.ReactElement {
  const nav = useViewNav();

  useInput(
    (_input, key) => {
      if (key.escape) {
        nav.pop();
      }
    },
    { isActive: !nav.searchMode },
  );

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text>
        Subagent: <Text bold>{agentType}</Text> <Text dimColor>{agentId}</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>Subagent transcript view coming soon.</Text>
    </Box>
  );
}
