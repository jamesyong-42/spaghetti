/**
 * TUI — Thin terminal control layer for interactive CLI views
 *
 * Provides: alternate screen buffer, raw mode keypress parsing,
 * screen rendering, resize handling, and graceful cleanup.
 * Zero dependencies beyond Node.js built-ins + picocolors.
 */

import cliTruncate from 'cli-truncate';

// ─── Types ──────────────────────────────────────────────────────────────

export type KeyEvent = 'up' | 'down' | 'enter' | 'escape' | 'q' | 'ctrl-c';

export interface TUI {
  /** Clear screen and write lines */
  render(lines: string[]): void;
  /** Register keypress handler */
  onKey(handler: (key: KeyEvent) => void): void;
  /** Current terminal height */
  rows: number;
  /** Current terminal width */
  cols: number;
  /** Register resize handler */
  onResize(handler: () => void): void;
  /** Restore terminal state — MUST be called before exit */
  cleanup(): void;
}

// ─── ANSI Escape Sequences ──────────────────────────────────────────────

const ESC = '\x1b';
const CSI = `${ESC}[`;

const ANSI = {
  enterAltScreen: `${CSI}?1049h`,
  exitAltScreen: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clearScreen: `${CSI}2J${CSI}H`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
} as const;

// ─── Keypress Parsing (exported for testing) ────────────────────────────

export function parseKeypress(buf: Buffer): KeyEvent | null {
  if (buf.length === 0) return null;

  // Ctrl+C
  if (buf[0] === 0x03) return 'ctrl-c';

  // Enter (CR)
  if (buf[0] === 0x0d) return 'enter';

  // Escape (bare ESC or ESC without valid sequence)
  if (buf[0] === 0x1b) {
    // Arrow keys: ESC [ A/B/C/D
    if (buf.length >= 3 && buf[1] === 0x5b) {
      if (buf[2] === 0x41) return 'up';
      if (buf[2] === 0x42) return 'down';
      // right (0x43) and left (0x44) not mapped — reserved for future
    }
    // Bare escape
    if (buf.length === 1) return 'escape';
    return null;
  }

  // 'q' key
  if (buf[0] === 0x71) return 'q';

  return null;
}

// ─── Factory ────────────────────────────────────────────────────────────

const MIN_ROWS = 10;
const MIN_COLS = 40;

export class TUINotAvailableError extends Error {
  constructor(reason: string) {
    super(`Interactive mode not available: ${reason}`);
    this.name = 'TUINotAvailableError';
  }
}

export function createTUI(): TUI {
  // Precondition checks
  if (!process.stdout.isTTY) {
    throw new TUINotAvailableError('stdout is not a TTY');
  }
  if (!process.stdin.isTTY) {
    throw new TUINotAvailableError('stdin is not a TTY');
  }

  const rows = process.stdout.rows ?? 24;
  const cols = process.stdout.columns ?? 80;

  if (rows < MIN_ROWS || cols < MIN_COLS) {
    throw new TUINotAvailableError(
      `terminal too small (${cols}x${rows}, need ${MIN_COLS}x${MIN_ROWS})`,
    );
  }

  let keyHandler: ((key: KeyEvent) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let cleaned = false;

  const tui: TUI = {
    rows,
    cols,

    render(lines: string[]) {
      let output = ANSI.clearScreen;
      for (let i = 0; i < lines.length && i < tui.rows; i++) {
        output += ANSI.moveTo(i + 1, 1) + cliTruncate(lines[i], tui.cols);
      }
      process.stdout.write(output);
    },

    onKey(handler: (key: KeyEvent) => void) {
      keyHandler = handler;
    },

    onResize(handler: () => void) {
      resizeHandler = handler;
    },

    cleanup() {
      if (cleaned) return;
      cleaned = true;

      // Restore stdin
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.removeListener('data', onData);
      process.stdin.pause();

      // Restore screen
      process.stdout.write(ANSI.showCursor + ANSI.exitAltScreen);

      // Remove resize listener
      process.stdout.removeListener('resize', onResizeEvent);
    },
  };

  // Setup: enter alt screen, hide cursor, enable raw mode
  process.stdout.write(ANSI.enterAltScreen + ANSI.hideCursor);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  // Input handling
  function onData(data: Buffer | string) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const key = parseKeypress(buf);
    if (key && keyHandler) {
      keyHandler(key);
    }
  }

  process.stdin.on('data', onData);

  // Resize handling
  function onResizeEvent() {
    tui.rows = process.stdout.rows ?? 24;
    tui.cols = process.stdout.columns ?? 80;
    if (resizeHandler) resizeHandler();
  }

  process.stdout.on('resize', onResizeEvent);

  return tui;
}
