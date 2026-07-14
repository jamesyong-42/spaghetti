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
export type AgentSourceId = 'claude-code' | 'codex' | 'grok';

/**
 * The normalized projection an ingest writer stores for one message, produced
 * by a source's {@link MessageExtractor} (RFC 006). The verbatim source record
 * is stored separately as `messages.data` — this is the thin, queryable core
 * (list / FTS / token stats), not a lossless model.
 *
 * `msgType` is the source's message-type string. It is currently the RAW type
 * (Claude Code: `user`/`assistant`/`summary`/`ai-title`/`system`/`unknown`);
 * tightening it to RFC 006 §3's normalized enum is a deferred, value-changing
 * decision, not part of the initial extractor relocation.
 */
export interface ExtractedMessage {
  msgType: string;
  /** Flattened, truncated FTS/preview text — excludes token + raw structure. */
  text: string;
  uuid: string | null;
  timestamp: string | null;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

/**
 * Per-source extraction seam (RFC 006). Maps one raw source record into the
 * normalized {@link ExtractedMessage} the ingest writer binds to columns. This
 * is the counterpart to {@link AgentSource.classify}: it makes message-shape
 * knowledge a property of the source, so a second agent ships one small
 * `extract()` instead of the ingest engines learning its envelope.
 */
export interface MessageExtractor {
  /**
   * Extract the stored projection for one raw record. Return `null` to skip a
   * record that is not a message row (no source needs this yet — Claude Code
   * stores a row per line). The raw record's shape is source-specific; the
   * source's own extractor knows it, which is why the parameter is `unknown`.
   */
  extract(raw: unknown): ExtractedMessage | null;
}

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
  /**
   * Extract a stored message projection from one raw transcript record (RFC
   * 006). The ingest writer calls `source.messages.extract(record)` instead of
   * knowing Claude Code's message envelope, so extraction — like `classify` —
   * is a property of the source.
   */
  readonly messages: MessageExtractor;
}
