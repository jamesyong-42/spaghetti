/**
 * Color theme — consistent styling across all CLI output
 */

import pc from 'picocolors';

export const theme = {
  heading: (s: string) => pc.bold(s),
  label: (s: string) => pc.dim(s),
  value: (s: string) => pc.white(s),
  accent: (s: string) => pc.cyan(s),
  success: (s: string) => pc.green(s),
  warning: (s: string) => pc.yellow(s),
  error: (s: string) => pc.red(s),
  muted: (s: string) => pc.dim(s),
  project: (s: string) => pc.bold(pc.cyan(s)),
  tokens: (s: string) => pc.yellow(s),
  time: (s: string) => pc.dim(s),
  bar: (s: string) => pc.green(s),
  barEmpty: (s: string) => pc.dim(s),
  session: (s: string) => pc.bold(pc.yellow(s)),
  message: (s: string) => pc.bold(pc.green(s)),
  detail: (s: string) => pc.bold(pc.magenta(s)),

  /** Apply a named color */
  colorize: (color: string, s: string): string => {
    const fn = (pc as unknown as Record<string, unknown>)[color];
    return typeof fn === 'function' ? (fn as (s: string) => string)(s) : s;
  },
};
