/**
 * filename-conventions.ts — Pure helpers for parsing the filename
 * conventions used across `~/.claude/`.
 *
 * The cold-start (`project-parser.ts`) and live (`live/incremental-parser.ts`)
 * paths each used to carry their own copies of these regexes. The
 * "deliberate duplication" rationale stopped applying once both paths
 * stabilised in RFC 005 — divergence here is a correctness bug, not a
 * design feature. Centralising means both sides agree on what counts
 * as a subagent / todo / file-history / plan filename.
 *
 * All helpers operate on `path.basename(filePath)` (no slashes); each
 * returns `null` when the basename doesn't match. Callers decide
 * whether a non-match means "skip this file" or "fall back to a less
 * strict identity" (e.g. cold-start's subagent extractor falls back to
 * stripping `.jsonl` when the convention doesn't match).
 *
 * Conventions:
 *
 *   - subagent:     `agent-{agentId}.jsonl` where agentId starts with `a`
 *   - todo:         `{sessionId}-agent-{agentId}.json`
 *   - file-history: `{hash}@v{version}` or `{hash}@v{version}.{ext}` (hash is lowercase hex)
 *   - plan:         `{slug}.md`
 */

// ═══════════════════════════════════════════════════════════════════════════
// REGEXES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subagent transcripts live under `projects/<slug>/<sessionId>/subagents/`
 * and are named `agent-<agentId>.jsonl`. Cold-start used to allow the
 * live form `agent-(a.+)\.jsonl` only; the leading `a` matches the
 * convention Claude Code uses for stamped agent IDs. Anything that
 * doesn't match returns `null` here; cold-start callers fall back to
 * a less-strict identity (strip `.jsonl`) when they want a transcript
 * to land regardless.
 */
const SUBAGENT_FILENAME = /^agent-(a.+)\.jsonl$/;

/**
 * Todos live under `todos/` (flat) and are named
 * `<sessionId>-agent-<agentId>.json`. The lazy-quantified
 * `(.+?)-agent-(.+)` correctly handles agentIds that themselves
 * contain `-agent-` since the second capture is greedy.
 */
const TODO_FILENAME = /^(.+?)-agent-(.+)\.json$/;

/**
 * File-history snapshots live under `file-history/<sessionId>/` and
 * are named `<hash>@v<version>` (hash lowercase hex). The optional
 * `(?:\..*)?` tail accepts (and discards) extension suffixes that
 * older Claude Code builds occasionally appended (e.g. `@v3.json`).
 *
 * Cold-start's regex was the strict `^([0-9a-f]+)@v(\d+)$` form
 * (rejecting any tail); the live regex was the looser form. We adopt
 * the looser form here so a cold-start re-ingest of the same fixture
 * picks up files the live tail saw — mismatched coverage between the
 * two paths was the original audit finding.
 */
const FILE_HISTORY_FILENAME = /^([0-9a-f]+)@v(\d+)(?:\..*)?$/;

/**
 * Plans live under `plans/` (flat) as markdown. The slug is the
 * basename minus the `.md` extension.
 */
const PLAN_FILENAME = /^(.+)\.md$/;

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedSubagentFilename {
  agentId: string;
  /**
   * Optional `agentType` derived from substring presence in the
   * filename. Mirrors the cold-start `inferAgentType` rule:
   * `prompt_suggestion` → `'prompt_suggestion'`,
   * `compact` → `'compact'`, otherwise `'task'`. Callers pin this on
   * the `SubagentTranscript.agentType` field.
   */
  agentType: 'task' | 'compact' | 'prompt_suggestion';
}

/**
 * Parse a subagent transcript filename. Returns `null` when the
 * basename doesn't match the `agent-<id>.jsonl` convention; callers
 * that want a fallback identity can compute one themselves
 * (`fileName.replace(/\.jsonl$/, '')`).
 */
export function parseSubagentFilename(basename: string): ParsedSubagentFilename | null {
  const match = basename.match(SUBAGENT_FILENAME);
  if (!match) return null;
  return {
    agentId: match[1],
    agentType: inferSubagentType(basename),
  };
}

/**
 * Infer the `SubagentTranscript.agentType` from substring hints in
 * the filename. Exposed separately because the live parser today calls
 * it without first matching the strict `agent-<id>.jsonl` form.
 */
export function inferSubagentType(basename: string): 'task' | 'compact' | 'prompt_suggestion' {
  if (basename.includes('prompt_suggestion')) return 'prompt_suggestion';
  if (basename.includes('compact')) return 'compact';
  return 'task';
}

export interface ParsedTodoFilename {
  sessionId: string;
  agentId: string;
}

/**
 * Parse a todo filename. Returns `null` when the basename doesn't
 * match the `<sessionId>-agent-<agentId>.json` convention.
 */
export function parseTodoFilename(basename: string): ParsedTodoFilename | null {
  const match = basename.match(TODO_FILENAME);
  if (!match) return null;
  return {
    sessionId: match[1],
    agentId: match[2],
  };
}

export interface ParsedFileHistoryFilename {
  hash: string;
  version: number;
  /** The full basename, preserved so callers can write it into snapshot records. */
  fileName: string;
}

/**
 * Parse a file-history snapshot filename (`<hash>@v<version>` with an
 * optional extension tail). Returns `null` when the basename doesn't
 * match.
 */
export function parseFileHistoryFilename(basename: string): ParsedFileHistoryFilename | null {
  const match = basename.match(FILE_HISTORY_FILENAME);
  if (!match) return null;
  const version = parseInt(match[2], 10);
  if (Number.isNaN(version)) return null;
  return {
    hash: match[1],
    version,
    fileName: basename,
  };
}

export interface ParsedPlanFilename {
  slug: string;
}

/**
 * Parse a plan filename (`<slug>.md`). Returns `null` when the
 * basename doesn't end in `.md`.
 */
export function parsePlanFilename(basename: string): ParsedPlanFilename | null {
  const match = basename.match(PLAN_FILENAME);
  if (!match) return null;
  return { slug: match[1] };
}
