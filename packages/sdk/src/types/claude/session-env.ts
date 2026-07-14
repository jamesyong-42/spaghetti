/**
 * TypeScript interfaces for ~/.claude/session-env/
 */

export interface SessionEnvEntry {
  sessionId: string;
  /**
   * Names of the `sessionstart-hook-*.sh` scripts in this session's dir
   * (filenames only — the scripts are ephemeral generated snapshots, so
   * content is deliberately not loaded).
   */
  scripts: string[];
}

export interface SessionEnvDirectory {
  entries: SessionEnvEntry[];
}
