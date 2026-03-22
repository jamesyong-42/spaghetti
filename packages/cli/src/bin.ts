/**
 * Spaghetti CLI — Entry point
 *
 * Claude Code data explorer for your terminal.
 */

import { createProgram } from './index.js';
import { shutdownService } from './lib/init.js';
import { handleError } from './lib/error.js';
import { checkForUpdates } from './lib/updater.js';

// Graceful shutdown on SIGINT
process.on('SIGINT', () => {
  shutdownService();
  process.exit(0);
});

async function main(): Promise<void> {
  checkForUpdates();
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleError(err);
  }
}

main();
