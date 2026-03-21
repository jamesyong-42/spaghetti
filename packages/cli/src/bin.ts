/**
 * Spaghetti CLI — Entry point
 *
 * Claude Code data explorer for your terminal.
 */

import { createProgram } from './index.js';
import { shutdownService } from './lib/init.js';
import { handleError } from './lib/error.js';

// Graceful shutdown on SIGINT
process.on('SIGINT', () => {
  shutdownService();
  process.exit(0);
});

async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleError(err);
  }
}

main();
