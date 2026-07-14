/**
 * TypeScript interfaces for data structures found in:
 *   ~/.claude/backups/
 */

// Backup files are timestamped copies of .claude.json global state
export interface ClaudeGlobalStateBackup {
  fileName: string;
  timestamp: number;
  state: ClaudeGlobalState;
}

export interface ClaudeGlobalState {
  numStartups?: number;
  installMethod?: string;
  autoUpdates?: boolean;
  hasSeenTasksHint?: boolean;
  tipsHistory?: Record<string, number>;
  [key: string]: unknown;
}
