/**
 * Claude Code path → live category classifier.
 *
 * Product-owned: `~/.claude` layout rules live here so the live plane only
 * calls `source.classify(path)`. Shared result types stay in `live/router.ts`
 * (`Category`, `RouteResult`).
 *
 * Pure — no I/O. Safe in hot watcher callbacks.
 *
 * See `docs/LIVE-UPDATES-DESIGN.md` §2.8.
 */

import path from 'node:path';

import type { Category, RouteResult } from '../../live/router.js';

export type { Category, RouteResult } from '../../live/router.js';

// ═══════════════════════════════════════════════════════════════════════════
// HARD IGNORE LISTS (Claude Code watch topology)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Directory segments that, if present anywhere in the relative path,
 * force `{ category: 'ignored' }`. Dominate Claude Code event traffic
 * and carry nothing the live-update path cares about.
 */
export const HARD_IGNORE_SEGMENTS = ['debug', 'telemetry', 'paste-cache', 'session-env'] as const;

/**
 * Filename suffixes that force `{ category: 'ignored' }`. `.tmp` is how
 * Claude Code (and our own atomic-rename writers) stage writes; `.DS_Store`
 * is macOS Finder noise.
 */
export const HARD_IGNORE_SUFFIXES = ['.tmp', '.DS_Store'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY RULES (order matters — most specific first)
// ═══════════════════════════════════════════════════════════════════════════

interface Rule {
  readonly re: RegExp;
  readonly build: (m: RegExpMatchArray) => RouteResult;
}

const CATEGORY_RULES: readonly Rule[] = [
  // projects/<slug>/<sessionId>/subagents/workflows/<wf>/agent-*.jsonl
  {
    re: /^projects\/([^/]+)\/([^/]+)\/subagents\/workflows\/([^/]+)\/agent-[^/]+\.jsonl$/,
    build: (m) => ({
      category: 'subagent',
      slug: decode(m[1]!),
      sessionId: decode(m[2]!),
      workflowId: decode(m[3]!),
    }),
  },
  // projects/<slug>/<sessionId>/subagents/agent-*.jsonl (flat, top-level)
  {
    re: /^projects\/([^/]+)\/([^/]+)\/subagents\/agent-[^/]+\.jsonl$/,
    build: (m) => ({ category: 'subagent', slug: decode(m[1]!), sessionId: decode(m[2]!) }),
  },
  // projects/<slug>/<sessionId>/tool-results/*.txt
  {
    re: /^projects\/([^/]+)\/([^/]+)\/tool-results\/[^/]+\.txt$/,
    build: (m) => ({ category: 'tool_result', slug: decode(m[1]!), sessionId: decode(m[2]!) }),
  },
  // projects/<slug>/memory/MEMORY.md
  {
    re: /^projects\/([^/]+)\/memory\/MEMORY\.md$/,
    build: (m) => ({ category: 'project_memory', slug: decode(m[1]!) }),
  },
  // projects/<slug>/sessions-index.json
  {
    re: /^projects\/([^/]+)\/sessions-index\.json$/,
    build: (m) => ({ category: 'session_index', slug: decode(m[1]!) }),
  },
  // projects/<slug>/<sessionId>.jsonl
  {
    re: /^projects\/([^/]+)\/([^/]+)\.jsonl$/,
    build: (m) => ({ category: 'session', slug: decode(m[1]!), sessionId: decode(m[2]!) }),
  },
  // file-history/<sessionId>/<anything>
  {
    re: /^file-history\/([^/]+)\/[^/].*$/,
    build: (m) => ({ category: 'file_history', sessionId: decode(m[1]!) }),
  },
  // todos/<sessionId>-agent-*.json
  {
    re: /^todos\/(.+?)-agent-[^/]+\.json$/,
    build: (m) => ({ category: 'todo', sessionId: decode(m[1]!) }),
  },
  // tasks/<sessionId>/<anything>
  {
    re: /^tasks\/([^/]+)\/[^/]+$/,
    build: (m) => ({ category: 'task', sessionId: decode(m[1]!) }),
  },
  // plans/*.md
  {
    re: /^plans\/[^/]+\.md$/,
    build: () => ({ category: 'plan' }),
  },
  // settings.json (exactly at agent root)
  {
    re: /^settings\.json$/,
    build: () => ({ category: 'settings' }),
  },
  // settings.local.json (exactly at agent root)
  {
    re: /^settings\.local\.json$/,
    build: () => ({ category: 'settings_local' }),
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// CLASSIFY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify an absolute path under the Claude Code data root (`rootDir`).
 *
 * Pure — no fs access. Returns `{ category: 'ignored' }` outside the root,
 * under a hard-ignore segment/suffix, or when no category rule matches.
 *
 * @param absPath Absolute path from a filesystem watcher
 * @param rootDir Claude Code data root (e.g. `~/.claude`)
 */
export function classifyClaudePath(absPath: string, rootDir: string): RouteResult {
  const relPosix = toRelPosix(absPath, rootDir);
  if (relPosix === null) return { category: 'ignored' };

  if (isHardIgnored(relPosix)) return { category: 'ignored' };

  for (const rule of CATEGORY_RULES) {
    const m = rule.re.exec(relPosix);
    if (m) return rule.build(m);
  }

  return { category: 'ignored' };
}

/**
 * @deprecated Prefer {@link classifyClaudePath}.
 */
export function classify(absPath: string, rootDir: string): RouteResult {
  return classifyClaudePath(absPath, rootDir);
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function toRelPosix(absPath: string, rootDir: string): string | null {
  const absNorm = absPath.replace(/\\/g, '/');
  const rootNorm = rootDir.replace(/\\/g, '/');

  const rel = path.posix.relative(rootNorm, absNorm);
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

function isHardIgnored(relPosix: string): boolean {
  for (const suffix of HARD_IGNORE_SUFFIXES) {
    if (relPosix.endsWith(suffix)) return true;
  }
  const segments = relPosix.split('/');
  for (const seg of segments) {
    for (const bad of HARD_IGNORE_SEGMENTS) {
      if (seg === bad) return true;
    }
  }
  return false;
}

function decode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
