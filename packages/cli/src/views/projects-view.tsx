/**
 * ProjectsView — Scrollable list of projects, the TUI home screen
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ProjectListItem } from '@vibecook/spaghetti-core';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';
import { useListNavigation } from './hooks.js';
import { formatTokens, formatBytes, formatRelativeTime, formatNumber, totalTokens } from '../lib/format.js';
import { SessionsView } from './sessions-view.js';
import { WelcomePanel } from './welcome-panel.js';
import type { WelcomePanelStats } from './welcome-panel.js';
import type { ViewEntry } from './types.js';

// ─── ProjectCard ───────────────────────────────────────────────────────

interface ProjectCardProps {
  project: ProjectListItem;
  firstPrompt: string;
  selected: boolean;
  cols: number;
}

function ProjectCard({ project, firstPrompt, selected, cols }: ProjectCardProps): React.ReactElement {
  const p = project;
  const dot = ' \u00B7 ';

  // Line 1: name + branch
  const prefix = selected ? '\x1b[36m\u258E\x1b[0m' : ' '; // cyan ▎ or space
  const name = selected ? `\x1b[1m\x1b[37m${p.folderName}\x1b[0m` : `\x1b[37m${p.folderName}\x1b[0m`;
  const branch = p.latestGitBranch
    ? selected
      ? `\x1b[36m${p.latestGitBranch}\x1b[0m`
      : `\x1b[2m${p.latestGitBranch}\x1b[0m`
    : '';

  // Line 2: first prompt
  const promptText = firstPrompt ? `"${firstPrompt}"` : '';
  const maxPromptLen = Math.max(cols - 6, 20);
  const truncatedPrompt = promptText.length > maxPromptLen ? promptText.slice(0, maxPromptLen - 1) + '\u2026' : promptText;

  // Line 3: stats
  const sessionCount = selected ? `\x1b[37m${formatNumber(p.sessionCount)}\x1b[0m` : `\x1b[2m${formatNumber(p.sessionCount)}\x1b[0m`;
  const msgCount = selected ? `\x1b[37m${formatNumber(p.messageCount)}\x1b[0m` : `\x1b[2m${formatNumber(p.messageCount)}\x1b[0m`;
  const tokenCount = selected ? `\x1b[33m${formatTokens(totalTokens(p.tokenUsage))}\x1b[0m` : `\x1b[2m${formatTokens(totalTokens(p.tokenUsage))}\x1b[0m`;
  const timeStr = `\x1b[2m${formatRelativeTime(p.lastActiveAt)}\x1b[0m`;

  return (
    <Box flexDirection="column">
      <Text>{prefix} {name}  {branch}</Text>
      <Text>{prefix} <Text dimColor italic>{truncatedPrompt}</Text></Text>
      <Text>{`${prefix} ${sessionCount}\x1b[2m sessions${dot}${msgCount}\x1b[2m msgs${dot}${tokenCount}\x1b[2m tokens${dot}${timeStr}`}</Text>
      <Text> </Text>
    </Box>
  );
}

// ─── ProjectsView ──────────────────────────────────────────────────────

// ─── Welcome Panel Height ─────────────────────────────────────────────
// The welcome panel takes ~12 lines when visible (border + title + content + padding).
// When the right column is hidden (<70 cols) it's ~10 lines.
// When hidden entirely (<50 cols) it's 0 lines.
const WELCOME_PANEL_HEIGHT_FULL = 12;
const WELCOME_PANEL_HEIGHT_NARROW = 10;

export function ProjectsView(): React.ReactElement {
  const nav = useViewNav();
  const api = useApi();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const isHome = nav.context.project === undefined;

  // Load data — also measure query time for the welcome panel
  const { projects, queryMs } = useMemo(() => {
    const t0 = performance.now();
    const list = api.getProjectList();
    const elapsed = Math.round(performance.now() - t0);
    list.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return { projects: list, queryMs: elapsed };
  }, [api]);

  const firstPrompts = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      const sess = api.getSessionList(p.slug);
      if (sess.length > 0) {
        map.set(p.slug, sess[0].firstPrompt || '');
      }
    }
    return map;
  }, [api, projects]);

  // Compute aggregate stats for the welcome panel
  const panelStats = useMemo((): WelcomePanelStats => {
    let sessions = 0;
    let messages = 0;
    let tokens = 0;
    for (const p of projects) {
      sessions += p.sessionCount;
      messages += p.messageCount;
      tokens += totalTokens(p.tokenUsage);
    }
    return {
      projects: projects.length,
      sessions,
      messages,
      tokens: formatTokens(tokens),
    };
  }, [projects]);

  // Get data size from store stats
  const dataSize = useMemo(() => {
    const stats = api.getStats();
    return formatBytes(stats.dbSizeBytes);
  }, [api]);

  // Calculate welcome panel height for viewport adjustment
  const showPanel = isHome && cols >= 50;
  const panelHeight = !showPanel ? 0 : cols >= 70 ? WELCOME_PANEL_HEIGHT_FULL : WELCOME_PANEL_HEIGHT_NARROW;

  const { selectedIndex, scrollOffset, moveUp, moveDown } = useListNavigation({
    itemCount: projects.length,
    itemHeight: 4,
  });

  // Key handling
  useInput((input, key) => {
    if (key.upArrow) {
      moveUp();
    } else if (key.downArrow) {
      moveDown();
    } else if (key.return) {
      if (projects.length === 0) return;
      const project = projects[selectedIndex];
      const entry: ViewEntry = {
        type: 'sessions',
        component: () => <SessionsView project={project} />,
        breadcrumb: project.folderName,
      };
      (entry as any)._project = project;
      nav.push(entry);
    } else if (key.escape) {
      nav.quit();
    }
  }, { isActive: !nav.commandMode });

  if (projects.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>No projects found.</Text>
      </Box>
    );
  }

  // Calculate visible range — subtract panel height when panel is showing
  const termRows = stdout?.rows ?? 24;
  const viewportItems = Math.max(1, Math.floor((termRows - 6 - panelHeight) / 4));
  const visibleProjects = projects.slice(scrollOffset, scrollOffset + viewportItems);

  return (
    <Box flexDirection="column">
      {showPanel && (
        <WelcomePanel
          stats={panelStats}
          dataPath="~/.claude"
          dataSize={dataSize}
          initMs={queryMs}
        />
      )}
      {visibleProjects.map((p, i) => {
        const actualIndex = scrollOffset + i;
        return (
          <ProjectCard
            key={p.slug}
            project={p}
            firstPrompt={firstPrompts.get(p.slug) || ''}
            selected={actualIndex === selectedIndex}
            cols={cols}
          />
        );
      })}
    </Box>
  );
}
