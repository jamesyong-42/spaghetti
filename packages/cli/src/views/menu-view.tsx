/**
 * MenuView — Home screen with welcome panel and 3-item menu
 *
 * Menu items: Projects, Stats, Help
 * Each pushes the corresponding view onto the navigation stack.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';
import { useListNavigation, useTerminalSize } from './hooks.js';
import { WelcomePanel } from './welcome-panel.js';
import type { WelcomePanelStats } from './welcome-panel.js';
import { ProjectsView } from './projects-view.js';
import { StatsView } from './stats-view.js';
import { HelpView } from './help-view.js';
import { HooksMonitorView } from './hooks-monitor-view.js';
import { formatTokens, formatBytes, totalTokens } from '../lib/format.js';
import type { ViewEntry } from './types.js';

// ─── Menu Item Rendering ──────────────────────────────────────────────

interface MenuItemProps {
  name: string;
  description: string;
  rightStat: string;
  selected: boolean;
  cols: number;
}

function MenuItem({ name, description, rightStat, selected, cols }: MenuItemProps): React.ReactElement {
  const prefix = selected ? '\u258E' : ' ';
  const prefixColor = selected ? 'cyan' : undefined;

  // Calculate gap to right-align the stat
  const fixedChars = 4; // prefix + space + two trailing spaces
  const gap = Math.max(2, cols - fixedChars - name.length - rightStat.length);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={prefixColor}>{prefix}</Text>
        <Text> </Text>
        <Text bold={selected} color={selected ? 'white' : undefined}>{name}</Text>
        <Text>{' '.repeat(gap)}</Text>
        <Text dimColor>{rightStat}</Text>
      </Box>
      <Box>
        <Text color={prefixColor}>{prefix}</Text>
        <Text> </Text>
        <Text dimColor>{description}</Text>
      </Box>
      <Text> </Text>
    </Box>
  );
}

// ─── MenuView ─────────────────────────────────────────────────────────

export function MenuView(): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { cols } = useTerminalSize();

  // Load aggregate data for stats display
  const { panelStats, dataSize, queryMs, projectCount, tokenStr } = useMemo(() => {
    const t0 = performance.now();
    const projects = api.getProjectList();
    const elapsed = Math.round(performance.now() - t0);

    let sessions = 0;
    let messages = 0;
    let tokens = 0;
    for (const p of projects) {
      sessions += p.sessionCount;
      messages += p.messageCount;
      tokens += totalTokens(p.tokenUsage);
    }

    const stats: WelcomePanelStats = {
      projects: projects.length,
      sessions,
      messages,
      tokens: formatTokens(tokens),
    };

    const s = api.getStats();

    return {
      panelStats: stats,
      dataSize: formatBytes(s.dbSizeBytes),
      queryMs: elapsed,
      projectCount: projects.length,
      tokenStr: formatTokens(tokens),
    };
  }, [api]);

  // Menu items
  const menuItems = [
    { name: 'Projects', description: 'Browse all Claude Code project conversations', rightStat: `${projectCount} projects` },
    { name: 'Hooks Monitor', description: 'Real-time hook event stream from spaghetti-hooks plugin', rightStat: 'live' },
    { name: 'Stats', description: 'Usage statistics, token counts, top projects', rightStat: `${tokenStr} tokens` },
    { name: 'Help', description: 'Navigation, commands, and keyboard shortcuts', rightStat: '? keybindings' },
  ];

  const { selectedIndex, moveUp, moveDown } = useListNavigation({
    itemCount: 4,
    itemHeight: 3,
  });

  useInput((input, key) => {
    if (key.upArrow) {
      moveUp();
    } else if (key.downArrow) {
      moveDown();
    } else if (key.return) {
      if (selectedIndex === 0) {
        const entry: ViewEntry = {
          type: 'projects',
          component: ProjectsView,
          breadcrumb: 'Projects',
        };
        nav.push(entry);
      } else if (selectedIndex === 1) {
        const entry: ViewEntry = {
          type: 'hooks-monitor',
          component: HooksMonitorView,
          breadcrumb: 'Hooks Monitor',
          hints: '\u2191\u2193 navigate  \u23CE detail  1-8 filter  c clear  Esc back',
        };
        nav.push(entry);
      } else if (selectedIndex === 2) {
        const entry: ViewEntry = {
          type: 'stats',
          component: StatsView,
          breadcrumb: 'Stats',
        };
        nav.push(entry);
      } else if (selectedIndex === 3) {
        const entry: ViewEntry = {
          type: 'help',
          component: HelpView,
          breadcrumb: 'Help',
        };
        nav.push(entry);
      }
    }
  }, { isActive: !nav.searchMode });

  return (
    <Box flexDirection="column">
      <WelcomePanel
        stats={panelStats}
        dataPath="~/.claude"
        dataSize={dataSize}
        initMs={queryMs}
      />
      {menuItems.map((item, i) => (
        <MenuItem
          key={item.name}
          name={item.name}
          description={item.description}
          rightStat={item.rightStat}
          selected={i === selectedIndex}
          cols={cols}
        />
      ))}
    </Box>
  );
}
