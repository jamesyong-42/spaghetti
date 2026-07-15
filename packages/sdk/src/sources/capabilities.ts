/**
 * Per-source product capabilities known to Spaghetti.
 *
 * Kept small and declarative so the CLI/SDK can render honest UI without
 * inventing zeros for data a source never produces (RFC 006 survey).
 */

/**
 * Whether this agent has usable token counts in the index (for UI display).
 *
 * Claude Code: per-assistant-message usage on each line.
 * Codex: turn-level `token_count` events are attributed onto assistant
 * rows at ingest (see `parseCodexTokenCount` + IngestService). Project /
 * session totals are SUM of those columns. `0` means no token_count was
 * captured for that scope (old logs / sparse events), not "unknown forever".
 */
export function sourceReportsPerMessageTokens(sourceId: string): boolean {
  switch (sourceId) {
    case 'grok':
      // Grok has no per-message usage in chat_history; sidecars attribute
      // session-level signals.contextTokensUsed onto the last assistant and
      // set tokens_estimated. UI should show the column with "~" / est.
      return true;
    case 'codex':
    case 'claude-code':
    default:
      return true;
  }
}

/** Short display name for a source id. */
export function sourceDisplayName(sourceId: string): string {
  switch (sourceId) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'grok':
      return 'Grok';
    default:
      return sourceId;
  }
}

/** Default on-disk root shown in UI (tilde form). */
export function sourceDisplayRoot(sourceId: string): string {
  switch (sourceId) {
    case 'claude-code':
      return '~/.claude';
    case 'codex':
      return '~/.codex';
    case 'grok':
      return '~/.grok';
    default:
      return `~/.${sourceId}`;
  }
}
