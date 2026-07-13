/**
 * AgentSource — adapter boundary for a local agent product (Plane 0).
 *
 * Claude Code is the only source today. Future agents plug in by
 * implementing this interface; ingest planes read roots from here
 * instead of hardcoding `~/.claude` / `~/.spaghetti`.
 *
 * See `docs/THREE-PLANE-INGEST-ARCHITECTURE.md` and
 * `docs/PR-PLAN-THREE-PLANE-SHAPE.md`.
 */

import type { RouteResult } from '../live/router.js';

/** Stable id for a supported agent product. Extend as sources land. */
export type AgentSourceId = 'claude-code';

/**
 * Paths derived from the source roots. Callers should prefer these
 * over assembling `path.join(homedir(), …)` ad hoc.
 */
export interface AgentSourcePaths {
  /** `<rootDir>/projects` */
  projectsDir: string;
  /** `<rootDir>/todos` */
  todosDir: string;
  /** `<rootDir>/plans` */
  plansDir: string;
  /** `<rootDir>/tasks` */
  tasksDir: string;
  /** `<rootDir>/file-history` */
  fileHistoryDir: string;
  /** `<rootDir>/sessions` — Claude Code active-session PID registry */
  sessionsDir: string;
  /** `<rootDir>/settings.json` */
  settingsFile: string;
  /** Hook events JSONL (Spaghetti state), e.g. `~/.spaghetti/hooks/events.jsonl` */
  hookEventsFile: string;
  /** Channel session discovery dir, e.g. `~/.spaghetti/channel/sessions` */
  channelSessionsDir: string;
  /** Channel message history dir, e.g. `~/.spaghetti/channel/messages` */
  channelMessagesDir: string;
}

/**
 * Describes where an agent product stores data on disk and where
 * Spaghetti keeps auxiliary runtime state for that machine.
 */
export interface AgentSource {
  readonly id: AgentSourceId;
  /** Agent product data root, e.g. `~/.claude`. */
  readonly rootDir: string;
  /** Spaghetti-owned state root, e.g. `~/.spaghetti`. */
  readonly stateDir: string;
  /** Derived absolute paths for common subtrees. */
  readonly paths: AgentSourcePaths;
  /**
   * Classify an absolute path under this source's root into a normalized
   * `Category` (session / subagent / tool_result / …). This is the seam that
   * makes file-layout knowledge a property of the source: the live plane calls
   * `source.classify(path)` rather than assuming Claude Code's directory shape,
   * so a second AgentSource declares its own path→category mapping without the
   * ingest engines changing. Pure — no I/O; safe in hot watcher callbacks.
   */
  classify(absPath: string): RouteResult;
}
