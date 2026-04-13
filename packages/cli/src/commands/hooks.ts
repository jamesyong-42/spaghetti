/**
 * Hooks command — view captured hook events from the spaghetti-hooks plugin
 */

import {
  createHookEventWatcher,
  getHookEventSummary,
  getHookEventCategory,
  HOOK_CATEGORY_LABELS,
} from '@vibecook/spaghetti-sdk';
import type { HookEvent, HookEventName } from '@vibecook/spaghetti-sdk';
import { theme } from '../lib/color.js';
import { existsSync } from 'node:fs';

export interface HooksOptions {
  follow?: boolean;
  filter?: string;
  limit?: number;
  json?: boolean;
  clear?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  lifecycle: 'cyan',
  input: 'green',
  tool: 'yellow',
  agent: 'magenta',
  task: 'blue',
  config: 'white',
  system: 'gray',
  mcp: 'red',
};

function formatEventLine(event: HookEvent): string {
  const time = event.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const category = getHookEventCategory(event.event);
  const color = CATEGORY_COLORS[category] || 'white';
  const summary = getHookEventSummary(event);

  const eventName = event.event.padEnd(20);
  const summaryStr = summary ? `  ${summary}` : '';

  return `  ${theme.muted(time)}  ${theme.colorize(color, eventName)}${theme.muted(summaryStr)}`;
}

export async function hooksCommand(opts: HooksOptions): Promise<void> {
  const watcher = createHookEventWatcher();
  const eventsPath = watcher.getEventsPath();

  // Clear
  if (opts.clear) {
    watcher.clear();
    process.stderr.write(theme.success('Hook events cleared.\n'));
    return;
  }

  // Check if events file exists
  if (!existsSync(eventsPath)) {
    process.stderr.write(
      theme.warning('\nNo hook events found.\n') +
        theme.muted(`Expected events at: ${eventsPath}\n`) +
        theme.muted('Install the plugin with: spag plugin install\n\n'),
    );
    return;
  }

  const filterName = opts.filter as HookEventName | undefined;
  const limit = opts.limit ?? 50;

  // Read history
  const allEvents = watcher.getHistory();
  let events = filterName ? allEvents.filter((e) => e.event === filterName) : allEvents;

  // Follow mode — tail the file
  if (opts.follow) {
    // Show last N events first
    const recent = events.slice(-limit);
    if (opts.json) {
      for (const e of recent) process.stdout.write(JSON.stringify(e) + '\n');
    } else {
      if (recent.length > 0) {
        process.stderr.write(`\n  ${theme.heading('Recent events')} (last ${recent.length})\n\n`);
        for (const e of recent) process.stdout.write(formatEventLine(e) + '\n');
        process.stderr.write('\n');
      }
      process.stderr.write(`  ${theme.accent('●')} ${theme.muted('Watching for new events... (Ctrl+C to stop)')}\n\n`);
    }

    watcher.onEvent((event) => {
      if (filterName && event.event !== filterName) return;
      if (opts.json) {
        process.stdout.write(JSON.stringify(event) + '\n');
      } else {
        process.stdout.write(formatEventLine(event) + '\n');
      }
    });

    watcher.start();

    // Keep alive until Ctrl+C
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        watcher.stop();
        resolve();
      });
    });
    return;
  }

  // Non-follow: show last N events
  events = events.slice(-limit);

  if (opts.json) {
    process.stdout.write(JSON.stringify(events, null, 2) + '\n');
    return;
  }

  if (events.length === 0) {
    process.stderr.write(theme.muted('\n  No hook events recorded yet.\n\n'));
    return;
  }

  // Header
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `  ${theme.heading('Hook Events')}  ${theme.muted(`(${allEvents.length} total, showing ${events.length})`)}`,
  );
  lines.push('');

  // Category legend
  const categories = [...new Set(events.map((e) => getHookEventCategory(e.event)))];
  const legend = categories
    .map((c) => theme.colorize(CATEGORY_COLORS[c] || 'white', HOOK_CATEGORY_LABELS[c]))
    .join(theme.muted(' · '));
  lines.push(`  ${legend}`);
  lines.push('');

  for (const e of events) {
    lines.push(formatEventLine(e));
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
}
