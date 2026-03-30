/**
 * Command registry — pure data, no React
 *
 * Defines all slash commands with names, aliases, argument specs,
 * descriptions, and context requirements. Provides prefix-match
 * filtering and unique-match resolution.
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface CommandDef {
  name: string;
  aliases: string[];
  args?: string;
  description: string;
  needsProject: boolean;
  needsSession: boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────

export const COMMANDS: CommandDef[] = [
  { name: 'search', aliases: ['s', 'find', 'grep'], args: '<query>', description: 'Search all messages', needsProject: false, needsSession: false },
  { name: 'stats', aliases: ['st'], description: 'Usage statistics', needsProject: false, needsSession: false },
  { name: 'memory', aliases: ['mem'], description: 'Project MEMORY.md', needsProject: true, needsSession: false },
  { name: 'todos', aliases: ['t'], description: 'Session todo list', needsProject: true, needsSession: false },
  { name: 'plan', aliases: ['pl'], description: 'Session plan', needsProject: true, needsSession: false },
  { name: 'subagents', aliases: ['sub'], description: 'Subagent transcripts', needsProject: true, needsSession: false },
  { name: 'export', aliases: ['x'], description: 'Export current view', needsProject: false, needsSession: false },
  { name: 'help', aliases: ['?', 'h'], description: 'Help and keybindings', needsProject: false, needsSession: false },
  { name: 'quit', aliases: ['q'], description: 'Quit spaghetti', needsProject: false, needsSession: false },
];

// ─── Matching ─────────────────────────────────────────────────────────

/**
 * Return all commands whose name or any alias starts with `input`.
 * If input is empty, returns all commands.
 */
export function matchCommands(input: string): CommandDef[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return COMMANDS;

  return COMMANDS.filter((cmd) => {
    if (cmd.name.startsWith(trimmed)) return true;
    return cmd.aliases.some((a) => a.startsWith(trimmed));
  });
}

/**
 * Resolve a typed input to a unique command + arguments.
 *
 * The input is expected WITHOUT the leading `/`.
 * Returns null if no unique match is found.
 */
export function resolveCommand(input: string): { command: CommandDef; args: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Split into command part and arguments
  const spaceIdx = trimmed.indexOf(' ');
  const cmdPart = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const argsPart = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Exact match on name
  const exactName = COMMANDS.find((c) => c.name === cmdPart);
  if (exactName) return { command: exactName, args: argsPart };

  // Exact match on alias
  const exactAlias = COMMANDS.find((c) => c.aliases.includes(cmdPart));
  if (exactAlias) return { command: exactAlias, args: argsPart };

  // Prefix match — only if unique
  const prefixMatches = COMMANDS.filter((c) => {
    if (c.name.startsWith(cmdPart)) return true;
    return c.aliases.some((a) => a.startsWith(cmdPart));
  });

  if (prefixMatches.length === 1) {
    return { command: prefixMatches[0], args: argsPart };
  }

  return null;
}
