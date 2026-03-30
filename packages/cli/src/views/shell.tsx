/**
 * Shell — Root Ink component managing the view stack
 *
 * Handles breadcrumb derivation, key dispatch (q/Ctrl-C quit),
 * and rendering the active view with Header + Footer chrome.
 *
 * Phase 3: Shows BootView during initialization, then transitions
 * to ProjectsView when the service is ready.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { createRequire } from 'node:module';
import type { SpaghettiAPI } from '@vibecook/spaghetti-core';
import type { ViewEntry, ViewNav, ViewContext } from './types.js';
import { ViewNavProvider } from './context.js';
import { Header, Footer, HRule } from './chrome.js';
import { ProjectsView } from './projects-view.js';
import { SearchView } from './search-view.js';
import { HelpView } from './help-view.js';
import { StatsView } from './stats-view.js';
import { MemoryView } from './memory-view.js';
import { TodosView } from './todos-view.js';
import { PlanView } from './plan-view.js';
import { SubagentsView } from './subagents-view.js';
import { BootView } from './boot-view.js';
import { CommandInput } from './command-input.js';
import { resolveCommand } from './commands.js';
import { useAlternateScreen } from './hooks.js';

// ─── Version ──────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const VERSION = (_require('../package.json') as { version: string }).version;

// ─── API Context ───────────────────────────────────────────────────────

const ApiContext = React.createContext<SpaghettiAPI>(null!);
export const ApiProvider = ApiContext.Provider;
export function useApi(): SpaghettiAPI {
  return React.useContext(ApiContext);
}

// ─── Context Derivation ────────────────────────────────────────────────

function deriveContext(stack: ViewEntry[]): ViewContext {
  const ctx: ViewContext = {};
  for (const entry of stack) {
    // Extract context from component closures via breadcrumb analysis
    // The actual context is set by views via nav.push() with the right data
    // We store it in a side-channel on the ViewEntry
    if ((entry as any)._project) ctx.project = (entry as any)._project;
    if ((entry as any)._session) ctx.session = (entry as any)._session;
    if ((entry as any)._sessionIndex !== undefined) ctx.sessionIndex = (entry as any)._sessionIndex;
  }
  return ctx;
}

// ─── Breadcrumb Builder ────────────────────────────────────────────────

function buildBreadcrumb(stack: ViewEntry[]): string {
  return stack.map((v) => v.breadcrumb).join(' \u203A ');
}

// ─── Default Hints ─────────────────────────────────────────────────────

function defaultHints(entry: ViewEntry, isRoot: boolean): string {
  if (entry.hints) return entry.hints;
  const parts: string[] = ['\u2191\u2193 navigate'];
  if (entry.type === 'messages') parts.push('1-6 filter');
  if (entry.type === 'detail') {
    parts[0] = '\u2191\u2193 scroll';
  } else {
    parts.push('\u23CE open');
  }
  parts.push('/ command');
  if (!isRoot) parts.push('Esc back');
  parts.push('q quit');
  return parts.join('  ');
}

// ─── Shell Component ───────────────────────────────────────────────────

export interface ShellProps {
  api: SpaghettiAPI;
}

export function Shell({ api }: ShellProps): React.ReactElement {
  const { exit } = useApp();

  // Enter alternate screen buffer for a clean full-screen TUI canvas
  useAlternateScreen();

  // ── Initialization lifecycle ──────────────────────────────────────

  const [ready, setReady] = useState(() => api.isReady());
  const [progress, setProgress] = useState({ message: 'Initializing...', current: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    // If already initialized (e.g. bin.ts called initialize() before rendering Shell),
    // skip the boot screen entirely.
    if (api.isReady()) {
      setReady(true);
      return;
    }

    // Core parsing yields the event loop between projects (via setImmediate),
    // so we can update progress state on each yield. Subscribe to progress
    // events and update React state directly — the setImmediate yields give
    // Ink a chance to re-render between projects.
    const unsub = api.onProgress((p) => {
      setProgress({
        message: p.message,
        current: p.current ?? 0,
        total: p.total ?? 0,
      });
      setElapsed((Date.now() - startTimeRef.current) / 1000);
    });

    // Delay init start so Ink can paint the initial boot screen frame
    const initTimer = setTimeout(() => {
      api.initialize()
        .then(() => {
          unsub();
          setReady(true);
        })
        .catch((err) => {
          unsub();
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 100);

    return () => {
      clearTimeout(initTimer);
      unsub();
    };
  }, [api]);

  // ── View stack ────────────────────────────────────────────────────

  const initialView: ViewEntry = {
    type: 'projects',
    component: ProjectsView,
    breadcrumb: 'Projects',
  };

  const [stack, setStack] = useState<ViewEntry[]>([initialView]);

  const push = useCallback((view: ViewEntry) => {
    setStack((s) => [...s, view]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const replace = useCallback((view: ViewEntry) => {
    setStack((s) => [...s.slice(0, -1), view]);
  }, []);

  const popAndPush = useCallback((...views: ViewEntry[]) => {
    setStack((s) => [...s.slice(0, -1), ...views]);
  }, []);

  const quit = useCallback(() => {
    exit();
  }, [exit]);

  // ── Command mode ────────────────────────────────────────────────

  const [commandMode, setCommandMode] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);

  // Auto-dismiss flash messages after 2 seconds
  useEffect(() => {
    if (flash) {
      const timer = setTimeout(() => setFlash(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [flash]);

  const enterCommandMode = useCallback(() => {
    setCommandMode(true);
    setFlash(null);
  }, []);

  const exitCommandMode = useCallback(() => {
    setCommandMode(false);
  }, []);

  const handleCommandExecute = useCallback((cmdName: string, args: string) => {
    setCommandMode(false);

    // Space shorthand already resolved by CommandInput — cmdName will be 'search'
    const resolved = resolveCommand(cmdName + (args ? ` ${args}` : ''));

    if (!resolved) {
      setFlash(`Unknown command: "${cmdName}". Type /help for available commands.`);
      return;
    }

    const { command, args: resolvedArgs } = resolved;

    // Check context requirements
    const ctx = deriveContext(stack);
    if (command.needsProject && !ctx.project) {
      setFlash(`/${command.name} requires a project. Navigate to a project first.`);
      return;
    }
    if (command.needsSession && !ctx.session) {
      setFlash(`/${command.name} requires a session. Navigate to a session first.`);
      return;
    }

    // Handle commands
    switch (command.name) {
      case 'quit':
        quit();
        break;
      case 'help': {
        const entry: ViewEntry = {
          type: 'help',
          component: HelpView,
          breadcrumb: 'Help',
          hints: 'Press any key to dismiss',
        };
        push(entry);
        break;
      }
      case 'stats': {
        const entry: ViewEntry = {
          type: 'stats',
          component: StatsView,
          breadcrumb: 'Stats',
          hints: '\u2191\u2193 scroll  Esc back',
        };
        push(entry);
        break;
      }
      case 'search': {
        if (!resolvedArgs) {
          setFlash('Usage: /search <query>');
          return;
        }
        const searchQuery = resolvedArgs;
        const searchResults = api.search({ text: searchQuery });
        const entry: ViewEntry = {
          type: 'search',
          component: () => <SearchView query={searchQuery} />,
          breadcrumb: `Search: "${searchQuery}" (${searchResults.total} results)`,
          hints: '\u2191\u2193 navigate  \u23CE jump to message  Esc back  / new search',
        };
        push(entry);
        break;
      }
      case 'memory': {
        const entry: ViewEntry = {
          type: 'memory',
          component: () => <MemoryView projectSlug={ctx.project!.slug} />,
          breadcrumb: 'Memory',
          hints: '\u2191\u2193 scroll  Esc back',
        };
        push(entry);
        break;
      }
      case 'todos': {
        const sessionId = ctx.session?.sessionId ?? api.getSessionList(ctx.project!.slug)[0]?.sessionId;
        if (!sessionId) {
          setFlash('No sessions found for this project.');
          return;
        }
        const todos = api.getSessionTodos(ctx.project!.slug, sessionId);
        const entry: ViewEntry = {
          type: 'todos',
          component: () => <TodosView projectSlug={ctx.project!.slug} sessionId={sessionId} />,
          breadcrumb: `Todos (${Array.isArray(todos) ? todos.length : 0})`,
          hints: '\u2191\u2193 scroll  Esc back',
        };
        push(entry);
        break;
      }
      case 'plan': {
        const planSessionId = ctx.session?.sessionId ?? api.getSessionList(ctx.project!.slug)[0]?.sessionId;
        if (!planSessionId) {
          setFlash('No sessions found for this project.');
          return;
        }
        const entry: ViewEntry = {
          type: 'plan',
          component: () => <PlanView projectSlug={ctx.project!.slug} sessionId={planSessionId} />,
          breadcrumb: 'Plan',
          hints: '\u2191\u2193 scroll  Esc back',
        };
        push(entry);
        break;
      }
      case 'subagents': {
        const subSessionId = ctx.session?.sessionId ?? api.getSessionList(ctx.project!.slug)[0]?.sessionId;
        if (!subSessionId) {
          setFlash('No sessions found for this project.');
          return;
        }
        const subs = api.getSessionSubagents(ctx.project!.slug, subSessionId);
        const entry: ViewEntry = {
          type: 'subagents',
          component: () => <SubagentsView projectSlug={ctx.project!.slug} sessionId={subSessionId} />,
          breadcrumb: `Subagents (${subs.length})`,
          hints: '\u2191\u2193 navigate  \u23CE view transcript  Esc back',
        };
        push(entry);
        break;
      }
      case 'export':
        setFlash('Export: coming in Phase 7');
        break;
      default:
        setFlash(`Unknown command: /${command.name}`);
        break;
    }
  }, [stack, quit, api, push]);

  const top = stack[stack.length - 1];
  const context = deriveContext(stack);

  const nav: ViewNav = {
    push,
    pop,
    replace,
    popAndPush,
    quit,
    enterCommandMode,
    context,
    commandMode,
    setSubtitle,
  };

  const breadcrumb = buildBreadcrumb(stack);
  const isRoot = stack.length === 1;
  const hints = defaultHints(top, isRoot);

  // Global keys — handled at shell level so they work everywhere.
  // Suppressed when command mode is active (CommandInput handles input).
  useInput((input, key) => {
    if (input === 'q') {
      quit();
    }
    if (input === '/') {
      enterCommandMode();
    }
    if (input === '?') {
      const entry: ViewEntry = {
        type: 'help',
        component: HelpView,
        breadcrumb: 'Help',
        hints: 'Press any key to dismiss',
      };
      push(entry);
    }
  }, { isActive: !commandMode });

  // Dismiss flash on any keypress when flash is showing and not in command mode
  useInput(() => {
    if (flash) {
      setFlash(null);
    }
  }, { isActive: !commandMode && flash !== null });

  // ── Render ────────────────────────────────────────────────────────

  // Show boot screen while initializing
  if (!ready) {
    return (
      <BootView
        version={VERSION}
        progress={progress}
        elapsed={elapsed}
        error={error}
        onQuit={quit}
      />
    );
  }

  // Main TUI with view stack
  const TopView = top.component;

  // Determine what to render in the footer area
  let footerContent: React.ReactElement;
  if (commandMode) {
    footerContent = <CommandInput onExecute={handleCommandExecute} onCancel={exitCommandMode} />;
  } else if (flash) {
    footerContent = (
      <Box flexDirection="column">
        <HRule />
        <Text>  {flash}</Text>
        <HRule />
      </Box>
    );
  } else {
    footerContent = <Footer hints={hints} />;
  }

  return (
    <ApiProvider value={api}>
      <ViewNavProvider value={nav}>
        <Box flexDirection="column">
          {!isRoot && <Header breadcrumb={breadcrumb} subtitle={subtitle ?? undefined} />}
          <Box flexGrow={1} flexDirection="column">
            <TopView />
          </Box>
          {footerContent}
        </Box>
      </ViewNavProvider>
    </ApiProvider>
  );
}
