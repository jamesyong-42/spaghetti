/**
 * HooksMonitorView — real-time hook event stream in the TUI
 *
 * Shows captured hook events from the spaghetti-hooks plugin,
 * color-coded by category with filtering and detail drill-down.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  createHookEventWatcher,
  getHookEventCategory,
  getHookEventSummary,
  HOOK_CATEGORY_LABELS,
} from '@vibecook/spaghetti-sdk';
import type { HookEvent, HookEventCategory, HookEventWatcher } from '@vibecook/spaghetti-sdk';
import { useViewNav } from './context.js';
import { useListNavigation } from './hooks.js';
import { Header, HRule } from './chrome.js';
import type { ViewEntry } from './types.js';
import pc from 'picocolors';

// ─── Category Colors ─────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<HookEventCategory, (s: string) => string> = {
  lifecycle: pc.cyan,
  input: pc.green,
  tool: pc.yellow,
  agent: pc.magenta,
  task: pc.blue,
  config: pc.white,
  system: pc.dim,
  mcp: pc.red,
};

const ALL_CATEGORIES: HookEventCategory[] = ['lifecycle', 'input', 'tool', 'agent', 'task', 'config', 'system', 'mcp'];

// ─── Event Card ──────────────────────────────────────────────────────────

interface EventCardProps {
  event: HookEvent;
  selected: boolean;
  cols: number;
}

function EventCard({ event, selected, cols }: EventCardProps): React.ReactElement {
  const category = getHookEventCategory(event.event);
  const colorFn = CATEGORY_COLORS[category];
  const summary = getHookEventSummary(event);
  const time = event.timestamp.slice(11, 23); // HH:MM:SS.mmm

  const prefix = selected ? '\u258E' : ' ';
  const eventName = event.event.padEnd(20);

  const maxSummaryLen = Math.max(10, cols - 28 - eventName.length);
  const truncSummary = summary.length > maxSummaryLen ? summary.slice(0, maxSummaryLen - 1) + '\u2026' : summary;

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{prefix}</Text>
      <Text> </Text>
      <Text dimColor>{time}</Text>
      <Text> </Text>
      <Text>{colorFn(eventName)}</Text>
      <Text dimColor>{truncSummary}</Text>
    </Box>
  );
}

// ─── Filter Chips ────────────────────────────────────────────────────────

interface FilterChipsProps {
  enabled: Set<HookEventCategory>;
  counts: Map<HookEventCategory, number>;
}

function FilterChips({ enabled, counts }: FilterChipsProps): React.ReactElement {
  const chips = ALL_CATEGORIES.map((cat, i) => {
    const colorFn = CATEGORY_COLORS[cat];
    const count = counts.get(cat) ?? 0;
    const label = `${i + 1}:${HOOK_CATEGORY_LABELS[cat]}`;
    const active = enabled.has(cat);
    const countStr = count > 0 ? `(${count})` : '';

    if (active) {
      return <Text key={cat}>{colorFn(`${label}${countStr}`)} </Text>;
    }
    return (
      <Text key={cat} dimColor strikethrough>
        {label}{' '}
      </Text>
    );
  });

  return (
    <Box>
      <Text> </Text>
      {chips}
    </Box>
  );
}

// ─── HooksMonitorView ────────────────────────────────────────────────────

export function HooksMonitorView(): React.ReactElement {
  const nav = useViewNav();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  // State
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [enabledCategories, setEnabledCategories] = useState<Set<HookEventCategory>>(() => new Set(ALL_CATEGORIES));
  const [isRecording, setIsRecording] = useState(false);
  const watcherRef = useRef<HookEventWatcher | null>(null);

  // Watcher lifecycle
  useEffect(() => {
    const watcher = createHookEventWatcher();
    watcherRef.current = watcher;

    // Load history
    const history = watcher.getHistory(500);
    setEvents(history);

    // Subscribe to new events
    const unsub = watcher.onEvent((event) => {
      setEvents((prev) => [...prev, event]);
    });

    watcher.start();
    setIsRecording(true);

    return () => {
      unsub();
      watcher.stop();
      watcherRef.current = null;
      setIsRecording(false);
    };
  }, []);

  // Filtered events
  const filteredEvents = useMemo(
    () => events.filter((e) => enabledCategories.has(getHookEventCategory(e.event))),
    [events, enabledCategories],
  );

  // Reversed (newest first)
  const displayEvents = useMemo(() => [...filteredEvents].reverse(), [filteredEvents]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts = new Map<HookEventCategory, number>();
    for (const e of events) {
      const cat = getHookEventCategory(e.event);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [events]);

  // Navigation
  const viewportHeight = Math.max(rows - 8, 5);
  const { selectedIndex, scrollOffset, moveUp, moveDown } = useListNavigation({
    itemCount: displayEvents.length,
    itemHeight: 1,
    viewportHeight,
  });

  // Toggle category filter
  const toggleCategory = useCallback((idx: number) => {
    const cat = ALL_CATEGORIES[idx];
    if (!cat) return;
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  // Clear events (uses the same watcher instance to reset byte position)
  const clearEvents = useCallback(() => {
    watcherRef.current?.clear();
    setEvents([]);
  }, []);

  // Input handling
  useInput(
    (input, key) => {
      if (nav.searchMode) return;

      if (key.upArrow) {
        moveUp();
      } else if (key.downArrow) {
        moveDown();
      } else if (key.escape) {
        nav.pop();
      } else if (key.return && displayEvents.length > 0) {
        // Drill into detail — show raw event JSON
        const event = displayEvents[selectedIndex];
        if (event) {
          const entry: ViewEntry = {
            type: 'detail',
            component: () => <HookEventDetail event={event} />,
            breadcrumb: `${event.event}`,
            hints: '\u2191\u2193 scroll  Esc back',
          };
          nav.push(entry);
        }
      } else if (input === 'c') {
        clearEvents();
      } else if (input >= '1' && input <= '8') {
        toggleCategory(parseInt(input) - 1);
      }
    },
    { isActive: !nav.searchMode },
  );

  // Visible events
  const visible = displayEvents.slice(scrollOffset, scrollOffset + viewportHeight);

  // Status
  const statusDot = isRecording ? pc.green('\u25CF') : pc.red('\u25CF');
  const statusText = isRecording ? 'Recording' : 'Stopped';
  const countText = `${events.length} events`;
  const filteredText = filteredEvents.length !== events.length ? `  ${pc.dim(`(${filteredEvents.length} shown)`)}` : '';

  return (
    <Box flexDirection="column">
      <Header breadcrumb="Hooks Monitor" />

      {/* Status bar */}
      <Box>
        <Text>
          {' '}
          {statusDot} {statusText} {pc.dim(countText)}
          {filteredText}
        </Text>
      </Box>

      {/* Filter chips */}
      <FilterChips enabled={enabledCategories} counts={categoryCounts} />

      <HRule />

      {/* Event list */}
      {visible.length === 0 ? (
        <Box height={viewportHeight}>
          <Text dimColor> No hook events {events.length === 0 ? 'recorded yet' : 'match filters'}.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" height={viewportHeight}>
          {visible.map((event, i) => (
            <EventCard
              key={`${event.timestamp}-${i}`}
              event={event}
              selected={i + scrollOffset === selectedIndex}
              cols={cols}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ─── Hook Event Detail ───────────────────────────────────────────────────

function HookEventDetail({ event }: { event: HookEvent }): React.ReactElement {
  const nav = useViewNav();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const viewportHeight = Math.max(termRows - 6, 5);

  const [scrollOffset, setScrollOffset] = useState(0);

  const contentLines = useMemo(() => {
    const lines: string[] = [];
    const category = getHookEventCategory(event.event);
    const colorFn = CATEGORY_COLORS[category];

    lines.push(colorFn(pc.bold(event.event)));
    lines.push('');

    // Metadata
    lines.push(pc.white('Metadata:'));
    lines.push(`  ${pc.dim('timestamp:')}    ${event.timestamp}`);
    lines.push(`  ${pc.dim('category:')}     ${HOOK_CATEGORY_LABELS[category]}`);
    if (event.sessionId) lines.push(`  ${pc.dim('sessionId:')}    ${event.sessionId}`);
    if (event.cwd) lines.push(`  ${pc.dim('cwd:')}           ${event.cwd}`);
    if (event.permissionMode) lines.push(`  ${pc.dim('permissionMode:')} ${event.permissionMode}`);
    if (event.agentId) lines.push(`  ${pc.dim('agentId:')}      ${event.agentId}`);
    if (event.agentType) lines.push(`  ${pc.dim('agentType:')}    ${event.agentType}`);
    lines.push('');

    // Payload
    lines.push(pc.white('Payload:'));
    const payloadStr = JSON.stringify(event.payload, null, 2);
    for (const line of payloadStr.split('\n')) {
      lines.push(`  ${line}`);
    }

    return lines;
  }, [event]);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setScrollOffset((prev) => Math.min(prev + 1, Math.max(0, contentLines.length - viewportHeight)));
      } else if (key.escape) {
        nav.pop();
      }
    },
    { isActive: !nav.searchMode },
  );

  const visibleLines = contentLines.slice(scrollOffset, scrollOffset + viewportHeight);
  while (visibleLines.length < viewportHeight) {
    visibleLines.push('');
  }

  const posIndicator = pc.dim(`[${scrollOffset + 1} / ${contentLines.length} lines]`);

  return (
    <Box flexDirection="column">
      {visibleLines.map((line, i) => (
        <Text key={i}> {line}</Text>
      ))}
      <Text dimColor> {posIndicator}</Text>
    </Box>
  );
}
