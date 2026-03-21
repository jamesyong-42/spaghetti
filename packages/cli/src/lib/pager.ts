/**
 * Pager — pipe long output to system pager ($PAGER or less -R)
 */

import { spawn } from 'node:child_process';
import { isTTY } from './terminal.js';

/**
 * Output content, using the system pager if the content is longer than the terminal height.
 * Falls back to console.log for non-TTY or short content.
 */
export function outputWithPager(content: string): void {
  const isTerminal = isTTY() && process.stdout.isTTY === true;

  if (!isTerminal) {
    process.stdout.write(content + '\n');
    return;
  }

  const termHeight = process.stdout.rows ?? 24;
  const lineCount = content.split('\n').length;

  if (lineCount <= termHeight) {
    process.stdout.write(content + '\n');
    return;
  }

  // Pipe to pager
  const pagerCmd = process.env['PAGER'] || 'less -R';
  const parts = pagerCmd.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  const pager = spawn(cmd, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  pager.stdin.on('error', (err: NodeJS.ErrnoException) => {
    // EPIPE means user quit pager early — that's fine
    if (err.code !== 'EPIPE') {
      // Silently ignore other pipe errors
    }
  });

  pager.stdin.write(content);
  pager.stdin.end();

  // Wait for pager to close
  pager.on('close', () => {
    // Done
  });
}
