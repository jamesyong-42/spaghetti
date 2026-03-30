/**
 * SubagentsView — Scrollable list of subagents for a session with drill-down
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { SubagentListItem } from '@vibecook/spaghetti-core';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';
import { useListNavigation } from './hooks.js';
import { formatNumber } from '../lib/format.js';
import type { ViewEntry } from './types.js';

// ─── SubagentCard ─────────────────────────────────────────────────────

interface SubagentCardProps {
  agent: SubagentListItem;
  selected: boolean;
  cols: number;
}

function SubagentCard({ agent, selected, cols: _cols }: SubagentCardProps): React.ReactElement {
  const prefix = selected ? '\x1b[35m\u258E\x1b[0m' : ' '; // magenta ▎ or space
  const typeName = selected
    ? `\x1b[1m\x1b[37m${agent.agentType}\x1b[0m`
    : `\x1b[35m${agent.agentType}\x1b[0m`;
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

// ─── SubagentsView ────────────────────────────────────────────────────

export interface SubagentsViewProps {
  projectSlug: string;
  sessionId: string;
}

export function SubagentsView({ projectSlug, sessionId }: SubagentsViewProps): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  const subagents = useMemo(
    () => api.getSessionSubagents(projectSlug, sessionId),
    [api, projectSlug, sessionId],
  );

  const { selectedIndex, scrollOffset, moveUp, moveDown } = useListNavigation({
    itemCount: subagents.length,
    itemHeight: 3,
  });

  useInput((_input, key) => {
    if (key.upArrow) {
      moveUp();
    } else if (key.downArrow) {
      moveDown();
    } else if (key.return) {
      if (subagents.length === 0) return;
      const agent = subagents[selectedIndex];
      if (!agent) return;

      // Push a placeholder detail view for the subagent transcript
      const entry: ViewEntry = {
        type: 'detail',
        component: () => (
          <SubagentTranscriptPlaceholder agentId={agent.agentId} agentType={agent.agentType} />
        ),
        breadcrumb: `${agent.agentType} ${agent.agentId.slice(0, 8)}`,
        hints: 'Esc back',
      };
      nav.push(entry);
    } else if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.commandMode });

  if (subagents.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No subagents in this session.</Text>
      </Box>
    );
  }

  const viewportItems = Math.max(1, Math.floor((termRows - 6) / 3));
  const visibleAgents = subagents.slice(scrollOffset, scrollOffset + viewportItems);

  return (
    <Box flexDirection="column">
      {visibleAgents.map((agent, i) => {
        const actualIndex = scrollOffset + i;
        return (
          <SubagentCard
            key={agent.agentId}
            agent={agent}
            selected={actualIndex === selectedIndex}
            cols={cols}
          />
        );
      })}
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

  useInput((_input, key) => {
    if (key.escape) {
      nav.pop();
    }
  }, { isActive: !nav.commandMode });

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text>Subagent: <Text bold>{agentType}</Text> <Text dimColor>{agentId}</Text></Text>
      <Text> </Text>
      <Text dimColor>Subagent transcript view coming soon.</Text>
    </Box>
  );
}
