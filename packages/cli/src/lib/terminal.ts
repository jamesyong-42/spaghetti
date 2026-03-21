/**
 * Terminal utilities — detect width, TTY, and color support
 */

export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

export function isTTY(): boolean {
  return process.stderr.isTTY === true;
}

export function isColorEnabled(): boolean {
  // NO_COLOR convention: https://no-color.org/
  if (process.env['NO_COLOR'] !== undefined) return false;

  // FORCE_COLOR forces color on
  if (process.env['FORCE_COLOR'] !== undefined) return true;

  // Check for --no-color in argv
  if (process.argv.includes('--no-color')) return false;

  // Default: color if stderr is a TTY
  return isTTY();
}
