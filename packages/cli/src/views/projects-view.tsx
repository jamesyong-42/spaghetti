/**
 * ProjectsView — Scrollable list of projects, the TUI home screen
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ProjectListItem } from '@vibecook/spaghetti-core';
import { useViewNav } from './context.js';
import { useApi } from './shell.js';
import { useListNavigation, useTerminalSize } from './hooks.js';
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
  const maxWidth = cols - 2; // leave 2 chars margin

  // Truncate helper
  const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '\u2026' : s;

  // Prefix: ▎ (selected) or space
  const prefix = selected ? '\u258E' : ' ';
  const prefixColor = selected ? 'cyan' : undefined;

  // Line 1: name + branch
  const branchStr = p.latestGitBranch || '';
  const nameMaxLen = maxWidth - 4 - branchStr.length; // "▎ name  branch"
  const displayName = trunc(p.folderName, Math.max(nameMaxLen, 10));

  // Line 2: first prompt (collapse newlines, then truncate)
  const promptFlat = firstPrompt ? firstPrompt.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const promptText = promptFlat ? `"${promptFlat}"` : '';
  const truncatedPrompt = trunc(promptText, maxWidth - 4);

  // Line 3: stats
  const stats = `${formatNumber(p.sessionCount)} sessions \u00B7 ${formatNumber(p.messageCount)} msgs \u00B7 ${formatTokens(totalTokens(p.tokenUsage))} tokens \u00B7 ${formatRelativeTime(p.lastActiveAt)}`;
  const truncatedStats = trunc(stats, maxWidth - 4);

  return (
    <Box flexDirection="column" width={cols}>
      <Box width={cols}>
        <Text>
          <Text color={prefixColor}>{prefix}</Text>
          <Text> </Text>
          <Text bold={selected} color="white">{displayName}</Text>
          <Text>  </Text>
          <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>{branchStr}</Text>
        </Text>
      </Box>
      <Box width={cols}>
        <Text>
          <Text color={prefixColor}>{prefix}</Text>
          <Text> </Text>
          <Text dimColor italic>{truncatedPrompt}</Text>
        </Text>
      </Box>
      <Box width={cols}>
        <Text>
          <Text color={prefixColor}>{prefix}</Text>
          <Text> </Text>
          {selected
            ? <Text>{truncatedStats}</Text>
            : <Text dimColor>{truncatedStats}</Text>
          }
        </Text>
      </Box>
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
  const { cols, rows } = useTerminalSize();
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

  // Viewport = terminal rows - footer chrome (3 lines: hrule + hints + hrule)
  // - welcome panel height (if visible)
  // Shell hides the header on home screen, so no header lines to subtract.
  const chromeLines = 3; // footer
  const viewportHeight = Math.max(5, rows - chromeLines - panelHeight);

  const { selectedIndex, scrollOffset, moveUp, moveDown } = useListNavigation({
    itemCount: projects.length,
    itemHeight: 4,
    viewportHeight,
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

  // Visible slice — use the same viewportHeight as useListNavigation
  const visibleItems = Math.max(1, Math.floor(viewportHeight / 4));
  const visibleProjects = projects.slice(scrollOffset, scrollOffset + visibleItems);

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
