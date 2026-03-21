/**
 * Simple table renderer — Unicode box drawing, ANSI-safe width handling
 */

import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import { theme } from './color.js';
import { getTerminalWidth } from './terminal.js';

export interface Column {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'right';
  format?: (value: unknown) => string;
}

function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  const sw = stringWidth(str);
  if (sw >= width) return cliTruncate(str, width);
  const diff = width - sw;
  if (align === 'right') return ' '.repeat(diff) + str;
  return str + ' '.repeat(diff);
}

export function renderTable(
  data: Record<string, unknown>[],
  columns: Column[],
  opts?: { width?: number },
): string {
  const termWidth = opts?.width ?? getTerminalWidth();

  // Calculate column widths
  const colWidths = columns.map((col) => {
    if (col.width) return col.width;

    // Auto-size: max of header and all values
    let max = stringWidth(col.label);
    for (const row of data) {
      const val = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '');
      const w = stringWidth(val);
      if (w > max) max = w;
    }
    return max;
  });

  // If total width exceeds terminal, shrink the widest auto-sized column
  const gap = 2; // space between columns
  const totalGap = gap * (columns.length - 1);
  let totalWidth = colWidths.reduce((a, b) => a + b, 0) + totalGap;

  if (totalWidth > termWidth) {
    // Find the widest column without a fixed width and shrink it
    let widestIdx = -1;
    let widestVal = 0;
    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].width && colWidths[i] > widestVal) {
        widestVal = colWidths[i];
        widestIdx = i;
      }
    }
    if (widestIdx >= 0) {
      const overflow = totalWidth - termWidth;
      colWidths[widestIdx] = Math.max(colWidths[widestIdx] - overflow, 8);
    }
  }

  totalWidth = colWidths.reduce((a, b) => a + b, 0) + totalGap;

  const lines: string[] = [];

  // Header
  const headerCells = columns.map((col, i) =>
    pad(theme.label(col.label), colWidths[i], col.align),
  );
  lines.push(headerCells.join('  '));

  // Separator
  const sep = colWidths.map((w) => '\u2500'.repeat(w)).join('  ');
  lines.push(theme.muted(sep));

  // Rows
  for (const row of data) {
    const cells = columns.map((col, i) => {
      const raw = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '');
      return pad(raw, colWidths[i], col.align);
    });
    lines.push(cells.join('  '));
  }

  return lines.join('\n');
}
