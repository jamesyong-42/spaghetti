/**
 * router.ts — Path-to-Category classifier for LiveUpdates (RFC 005).
 *
 * Fifth component of Phase 2 (C2.5). Pure function: given an absolute
 * path coming from a filesystem watcher event and the `claudeDir` root
 * (e.g. `~/.claude`), decide which live-update category it belongs to
 * and extract the identifiers (`slug`, `sessionId`) downstream wiring
 * needs for routing / subscription matching.
 *
 * Design doc: `docs/LIVE-UPDATES-DESIGN.md` §2.8. Keep in sync if the
 * directory layout documented in that section changes.
 *
 * Invariants:
 *   - No I/O. No dynamic RegExp from user input. All patterns static.
 *   - Paths are normalized to POSIX forward-slash form internally so a
 *     Windows watcher delivering `projects\foo\bar.jsonl` still matches.
 *   - Hard-ignore takes precedence over every other rule. The patterns
 *     listed in `HARD_IGNORE_SEGMENTS` / `HARD_IGNORE_SUFFIXES` dominate
 *     event traffic and aren't on the live-update path (see RFC 005
 *     "Watch topology"), so we drop them as early as possible.
 *   - Most-specific match wins: subagent before session, session_index
 *     before session, etc. Ordering of `CATEGORY_RULES` is load-bearing.
 *   - Paths outside `claudeDir` → `{ category: 'ignored' }` as a defense
 *     in depth in case a watcher is ever wired up against a surprising
 *     root; never a throw.
 */

import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every bucket a filesystem event can land in. The twelve non-ignored
 * categories map 1:1 to the directory layout documented in
 * `docs/LIVE-UPDATES-DESIGN.md` §2.8; `ignored` is the catch-all for
 * anything outside those shapes or inside a hard-ignored segment.
 */
export type Category =
  | 'session'
  | 'session_index'
  | 'subagent'
  | 'tool_result'
  | 'project_memory'
  | 'file_history'
  | 'todo'
  | 'task'
  | 'plan'
  | 'settings'
  | 'settings_local'
  | 'ignored';

/**
 * Result of `classify()`. `slug` / `sessionId` are populated only for
 * the categories where the directory layout encodes them; see the
 * per-rule comments below for which fields are present per category.
 */
export interface RouteResult {
  category: Category;
  slug?: string;
  sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// HARD IGNORE LISTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Directory segments that, if present anywhere in the relative path,
 * force a `{ category: 'ignored' }` result. Sourced verbatim from
 * RFC 005 "Watch topology" — these directories dominate Claude Code's
 * event traffic and carry nothing the live-update path cares about.
 */
export const HARD_IGNORE_SEGMENTS = ['debug', 'telemetry', 'paste-cache', 'session-env'] as const;

/**
 * Filename suffixes that force `{ category: 'ignored' }`. `.tmp` is
 * how Claude Code (and our own atomic-rename writers) stage writes;
 * `.DS_Store` is the macOS Finder turd. Both are high-volume noise.
 */
export const HARD_IGNORE_SUFFIXES = ['.tmp', '.DS_Store'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY RULES (order matters — most specific first)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single classification rule: a POSIX-relative-path regex and a
 * builder that turns match groups into a `RouteResult`. Rules are
 * tried in array order; the first match wins. Order is load-bearing:
 *
 *   1. Subagent / tool-result / project-memory are nested under a
 *      session directory, so they must be tested **before** the
 *      top-level session rule — otherwise `projects/foo/bar/...`
 *      would match `session` with sessionId=`bar` and never reach
 *      the specific handler.
 *   2. `sessions-index.json` is a sibling of session files; its
 *      literal name disambiguates but we still put it ahead of the
 *      generic session pattern for clarity.
 *   3. Literal `settings.json` / `settings.local.json` are anchored
 *      to claudeDir root so they can't collide with anything under
 *      a project slug.
 */
interface Rule {
  readonly re: RegExp;
  readonly build: (m: RegExpMatchArray) => RouteResult;
}

const CATEGORY_RULES: readonly Rule[] = [
  // projects/<slug>/<sessionId>/subagents/agent-*.jsonl
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
  // todos/<sessionId>-agent-*.json — sessionId is everything before the first "-agent-".
  {
    re: /^todos\/(.+?)-agent-[^/]+\.json$/,
    build: (m) => ({ category: 'todo', sessionId: decode(m[1]!) }),
  },
  // tasks/<sessionId>/<anything> (.lock, .highwatermark, or N.json)
  {
    re: /^tasks\/([^/]+)\/[^/]+$/,
    build: (m) => ({ category: 'task', sessionId: decode(m[1]!) }),
  },
  // plans/*.md
  {
    re: /^plans\/[^/]+\.md$/,
    build: () => ({ category: 'plan' }),
  },
  // settings.json (exactly at claudeDir root)
  {
    re: /^settings\.json$/,
    build: () => ({ category: 'settings' }),
  },
  // settings.local.json (exactly at claudeDir root)
  {
    re: /^settings\.local\.json$/,
    build: () => ({ category: 'settings_local' }),
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// CLASSIFY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify a filesystem path under `claudeDir`.
 *
 * Pure function — no fs access, no side effects. Safe to call from hot
 * watcher callbacks. Returns `{ category: 'ignored' }` for anything
 * outside `claudeDir`, anything under a hard-ignore segment, anything
 * ending in a hard-ignore suffix, or anything not matching one of the
 * twelve category shapes.
 */
export function classify(absPath: string, claudeDir: string): RouteResult {
  const relPosix = toRelPosix(absPath, claudeDir);
  if (relPosix === null) return { category: 'ignored' };

  if (isHardIgnored(relPosix)) return { category: 'ignored' };

  for (const rule of CATEGORY_RULES) {
    const m = rule.re.exec(relPosix);
    if (m) return rule.build(m);
  }

  return { category: 'ignored' };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize an absolute path to a forward-slash relative path rooted
 * at `claudeDir`. Returns `null` if the path sits outside `claudeDir`
 * (i.e. the relative form starts with `..` or — on Windows — is
 * absolute because the drive letters differ).
 *
 * We accept both POSIX and Windows separators in the input because
 * watcher events can arrive with either depending on platform and
 * library. `path.relative` handles the mixed-separator case on
 * Windows; on POSIX we pre-normalize backslashes to forward slashes
 * so a caller passing a Windows path string for testing still works.
 */
function toRelPosix(absPath: string, claudeDir: string): string | null {
  // Normalize separators so `path.relative` on POSIX still understands
  // a Windows-style input and vice-versa. This is the only place we
  // bridge the separator gap; downstream rules are POSIX-only.
  const absNorm = absPath.replace(/\\/g, '/');
  const rootNorm = claudeDir.replace(/\\/g, '/');

  const rel = path.posix.relative(rootNorm, absNorm);
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/**
 * True if the relative path is under any `HARD_IGNORE_SEGMENTS`
 * directory or ends with any `HARD_IGNORE_SUFFIXES`. Uses explicit
 * segment split rather than a regex so a file literally named
 * `debugging-notes.md` isn't misclassified as ignored.
 */
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

/**
 * Defensive URL decode: Claude Code doesn't escape slug/sessionId
 * components today, but if a future version ever does we don't want
 * subscribers to see the percent-encoded form. Cheap skip-if-clean.
 */
function decode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
