/**
 * Unified error handling — consistent, helpful error messages
 */

import pc from 'picocolors';

/**
 * A user-facing error with an optional suggestion for how to fix it.
 * These are displayed cleanly without stack traces.
 */
export class UserError extends Error {
  constructor(
    message: string,
    public suggestion?: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * Top-level error handler for the CLI process.
 * UserErrors get clean output; unknown errors show a hint to use --verbose.
 */
export function handleError(err: unknown): never {
  if (err instanceof UserError) {
    process.stderr.write(pc.red(`\n  Error: ${err.message}\n`));
    if (err.suggestion) {
      process.stderr.write(err.suggestion + '\n');
    }
    process.stderr.write('\n');
    process.exit(1);
  }

  // Unknown error — show message only (not stack trace unless verbose)
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(pc.red(`\n  Error: ${message}\n`));

  if (process.env.VERBOSE || process.argv.includes('--verbose')) {
    if (err instanceof Error && err.stack) {
      process.stderr.write(pc.dim(err.stack) + '\n');
    }
  } else {
    process.stderr.write(pc.dim('  Run with --verbose for details') + '\n');
  }

  process.stderr.write('\n');
  process.exit(1);
}

/**
 * Create a UserError for a project that couldn't be resolved.
 */
export function noProjectMatch(
  input: string,
  suggestions: Array<{ folderName: string; sessionCount: number }>,
): UserError {
  let sugText: string;
  if (suggestions.length > 0) {
    sugText =
      '\n  Did you mean?\n' +
      suggestions
        .map((s) => `    ${pc.bold(pc.cyan(s.folderName))} ${pc.dim(`(${s.sessionCount} sessions)`)}`)
        .join('\n');
  } else {
    sugText = pc.dim('  Run `spaghetti projects` to see all projects.');
  }
  return new UserError(`Project not found: "${input}"`, sugText);
}

/**
 * Create a UserError for a session that couldn't be resolved.
 */
export function noSessionMatch(input: string, projectName?: string): UserError {
  const hint = projectName
    ? pc.dim(`  Use \`spaghetti sessions ${projectName}\` to list sessions.`)
    : pc.dim('  Use a number (1=latest), "latest", or a UUID prefix.');
  return new UserError(`Session not found: "${input}"`, hint);
}
