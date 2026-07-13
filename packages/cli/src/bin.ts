/**
 * Spaghetti CLI — Entry point
 *
 * Claude Code data explorer for your terminal.
 *
 * Bare command (`spag`) on a TTY launches the Ink TUI.
 * Bare command piped (`spag | cat`) outputs summary JSON.
 * Any subcommand (`spag p`, `spag s .`, etc.) falls through to commander.
 */

import { createProgram } from './index.js';
import { initService, shutdownService, registerService, disposeService, detectAdditionalSources } from './lib/init.js';
import { handleError } from './lib/error.js';
import { checkForUpdates } from './lib/updater.js';

// Graceful shutdown on SIGINT — prefer awaitable dispose so live pipeline
// drains and checkpoints flush (TUI + one-shots both register via init).
process.on('SIGINT', () => {
  void disposeService().finally(() => {
    process.exit(0);
  });
});

async function main(): Promise<void> {
  checkForUpdates();

  const args = process.argv.slice(2);

  // Detect whether this is a bare command (no subcommand).
  // A "subcommand" is a non-flag first argument (e.g. `p`, `sessions`).
  // Flags like --version and --help start with '-' and fall through to commander.
  const hasSubcommand = args.length > 0 && !args[0].startsWith('-');
  const hasJsonFlag = args.includes('--json');
  const isBareCommand = !hasSubcommand;

  if (isBareCommand && !hasJsonFlag && args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // TTY: launch the Ink TUI
      const { render } = await import('ink');
      const React = await import('react');
      const { Shell } = await import('./views/shell.js');
      const { createSpaghettiService } = await import('@vibecook/spaghetti-sdk');

      // Enter the alternate screen BEFORE Ink's first render. If we
      // let Shell's `useAlternateScreen` hook do it via useEffect, the
      // first-paint output lands on the main screen and the alt-screen
      // switch-over wipes it — producing a blank canvas until the next
      // state update (often after warm-start completes, i.e. never on
      // a fast machine). Restore on exit via the handler below.
      process.stdout.write('\x1b[?1049h');
      const leaveAlt = (): void => {
        try {
          process.stdout.write('\x1b[?1049l');
        } catch {
          // stdout may already be closed on abrupt exit
        }
      };
      process.on('exit', leaveAlt);

      // Plane 2 on for the long-lived TUI so session lists / search stay warm
      // while Claude Code writes. One-shot commands (initService) stay pull-only.
      const service = createSpaghettiService({ live: true, additionalSources: detectAdditionalSources() });
      registerService(service);
      // Don't initialize here — let Shell handle it with BootView
      const { waitUntilExit } = render(React.createElement(Shell, { api: service }), { exitOnCtrlC: true });

      await waitUntilExit();
      await disposeService();
      leaveAlt();
      return;
    } else {
      // Piped: output summary JSON
      const { summaryJSON } = await import('./commands/dashboard.js');
      const api = await initService({ silent: true });
      await summaryJSON(api);
      shutdownService();
      return;
    }
  }

  // `spag --json` (bare command with --json flag) → summary JSON
  if (isBareCommand && hasJsonFlag) {
    const { summaryJSON } = await import('./commands/dashboard.js');
    const api = await initService({ silent: true });
    await summaryJSON(api);
    shutdownService();
    return;
  }

  // Has subcommand or other flags (--version, --help): fall through to commander
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleError(err);
  }
}

main();
