/**
 * TypeScript interfaces for ~/.claude/session-env/
 */

export interface SessionEnvEntry {
  sessionId: string;
}

export interface SessionEnvDirectory {
  entries: SessionEnvEntry[];
}
