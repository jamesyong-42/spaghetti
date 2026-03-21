/**
 * Program setup — exported for testing
 */

import { Command } from 'commander';
import { initService, shutdownService } from './lib/init.js';
import { dashboardCommand } from './commands/dashboard.js';
import { projectsCommand } from './commands/projects.js';
import type { ProjectsOptions } from './commands/projects.js';
import { sessionsCommand } from './commands/sessions.js';
import type { SessionsOptions } from './commands/sessions.js';
import { messagesCommand } from './commands/messages.js';
import type { MessagesOptions } from './commands/messages.js';
import { searchCommand } from './commands/search.js';
import type { SearchOptions } from './commands/search.js';
import { statsCommand } from './commands/stats.js';
import type { StatsOptions } from './commands/stats.js';
import { memoryCommand } from './commands/memory.js';
import type { MemoryOptions } from './commands/memory.js';
import { todosCommand } from './commands/todos.js';
import type { TodosOptions } from './commands/todos.js';
import { subagentsCommand } from './commands/subagents.js';
import type { SubagentsOptions } from './commands/subagents.js';
import { planCommand } from './commands/plan.js';
import type { PlanOptions } from './commands/plan.js';
import { exportCommand } from './commands/export.js';
import type { ExportOptions } from './commands/export.js';
import { theme } from './lib/color.js';

const VERSION = '0.1.0';

/** Helper to initialize the service with standard error handling */
async function withService<T>(fn: (api: Awaited<ReturnType<typeof initService>>) => Promise<T>): Promise<T> {
  let api;
  try {
    api = await initService();
  } catch (_err) {
    process.stderr.write(
      theme.error('\nFailed to initialize. Is Claude Code installed?\n') +
      theme.muted('Expected data at ~/.claude\n\n'),
    );
    process.exit(1);
  }

  try {
    return await fn(api);
  } finally {
    shutdownService();
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('spaghetti')
    .version(VERSION, '-v, --version')
    .description('Claude Code data explorer');

  // Default action: dashboard
  program.action(async () => {
    await withService((api) => dashboardCommand(api, VERSION));
  });

  // Projects command
  const projectsCmd = new Command('projects')
    .alias('p')
    .description('List all projects')
    .option('-s, --sort <key>', 'Sort by: active, sessions, messages, tokens, name', 'active')
    .option('-l, --limit <n>', 'Limit results', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (cmdOpts: ProjectsOptions) => {
      await withService((api) =>
        projectsCommand(api, {
          sort: cmdOpts.sort,
          limit: cmdOpts.limit,
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(projectsCmd);

  // Sessions command
  const sessionsCmd = new Command('sessions')
    .alias('s')
    .description('List sessions for a project')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .option('-s, --sort <field>', 'Sort by: recent, tokens, messages, duration', 'recent')
    .option('-l, --limit <n>', 'Limit results (default: 20)', parseInt)
    .option('-a, --all', 'Show all sessions (no limit)')
    .option('--since <time>', 'Filter by time (today, yesterday, "3 days ago", ISO date)')
    .option('--json', 'Output as JSON')
    .action(async (projectArg: string | undefined, cmdOpts: SessionsOptions) => {
      await withService((api) =>
        sessionsCommand(api, projectArg, {
          sort: cmdOpts.sort,
          limit: cmdOpts.limit,
          all: cmdOpts.all,
          since: cmdOpts.since,
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(sessionsCmd);

  // Messages command
  const messagesCmd = new Command('messages')
    .alias('m')
    .description('Read messages from a session')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .argument('[session]', 'Session index (1=latest), "latest", or partial UUID')
    .option('-n, --limit <n>', 'Limit messages (default: 50)', parseInt)
    .option('--offset <n>', 'Start from message N', parseInt)
    .option('--last <n>', 'Show last N messages', parseInt)
    .option('--compact', 'One-line-per-message view')
    .option('--no-tools', 'Hide tool use details')
    .option('--no-thinking', 'Hide thinking blocks')
    .option('--raw', 'Show raw JSON per message')
    .option('--json', 'Full JSON output')
    .action(async (projectArg: string | undefined, sessionArg: string | undefined, cmdOpts: MessagesOptions) => {
      await withService((api) =>
        messagesCommand(api, projectArg, sessionArg, {
          limit: cmdOpts.limit,
          offset: cmdOpts.offset,
          last: cmdOpts.last,
          compact: cmdOpts.compact,
          noTools: cmdOpts.noTools,
          noThinking: cmdOpts.noThinking,
          raw: cmdOpts.raw,
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(messagesCmd);

  // Search command
  const searchCmd = new Command('search')
    .description('Full-text search across all data')
    .argument('<query>', 'Search text')
    .option('-p, --project <name>', 'Scope to a specific project (fuzzy resolved)')
    .option('-l, --limit <n>', 'Limit results (default: 20)', parseInt)
    .option('--offset <n>', 'Pagination offset', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (query: string, cmdOpts: SearchOptions) => {
      await withService((api) =>
        searchCommand(api, query, {
          project: cmdOpts.project,
          limit: cmdOpts.limit,
          offset: cmdOpts.offset,
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(searchCmd);

  // Stats command
  const statsCmd = new Command('stats')
    .alias('st')
    .description('Usage statistics')
    .option('--json', 'Output as JSON')
    .action(async (cmdOpts: StatsOptions) => {
      await withService((api) =>
        statsCommand(api, {
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(statsCmd);

  // Memory command
  const memoryCmd = new Command('memory')
    .alias('mem')
    .description('View project MEMORY.md')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .option('--json', 'Output as JSON')
    .action(async (projectArg: string | undefined, cmdOpts: MemoryOptions) => {
      await withService((api) =>
        memoryCommand(api, projectArg, {
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(memoryCmd);

  // Todos command
  const todosCmd = new Command('todos')
    .alias('t')
    .description('View session todos')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .argument('[session]', 'Session index (1=latest), "latest", or partial UUID')
    .option('--json', 'Output as JSON')
    .action(async (projectArg: string | undefined, sessionArg: string | undefined, cmdOpts: TodosOptions) => {
      await withService((api) =>
        todosCommand(api, projectArg, sessionArg, {
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(todosCmd);

  // Subagents command
  const subagentsCmd = new Command('subagents')
    .alias('sub')
    .description('View session subagents')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .argument('[session]', 'Session index (1=latest), "latest", or partial UUID')
    .argument('[agent]', 'Agent index to view messages')
    .option('--json', 'Output as JSON')
    .action(async (projectArg: string | undefined, sessionArg: string | undefined, agentArg: string | undefined, cmdOpts: SubagentsOptions) => {
      await withService((api) =>
        subagentsCommand(api, projectArg, sessionArg, agentArg, {
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(subagentsCmd);

  // Plan command
  const planCmd = new Command('plan')
    .alias('pl')
    .description('View session plan')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .argument('[session]', 'Session index (1=latest), "latest", or partial UUID')
    .option('--json', 'Output as JSON')
    .action(async (projectArg: string | undefined, sessionArg: string | undefined, cmdOpts: PlanOptions) => {
      await withService((api) =>
        planCommand(api, projectArg, sessionArg, {
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(planCmd);

  // Export command
  const exportCmd = new Command('export')
    .alias('x')
    .description('Export project data')
    .argument('[project]', 'Project name, index, or "." for cwd')
    .option('-s, --session <id>', 'Export specific session only')
    .option('-f, --format <fmt>', 'Output format: json, markdown', 'json')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--include-tools', 'Include full tool result content')
    .option('--json', 'Output as JSON (same as --format json)')
    .action(async (projectArg: string | undefined, cmdOpts: ExportOptions) => {
      await withService((api) =>
        exportCommand(api, projectArg, {
          session: cmdOpts.session,
          format: cmdOpts.format,
          output: cmdOpts.output,
          includeTools: cmdOpts.includeTools,
          json: cmdOpts.json,
        }),
      );
    });

  program.addCommand(exportCmd);

  return program;
}
