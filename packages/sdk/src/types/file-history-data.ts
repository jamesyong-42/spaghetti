/**
 * TypeScript interfaces for ~/.claude/file-history/
 */

export interface FileHistorySession {
  sessionId: string;
  snapshots: FileHistorySnapshotFile[];
}

export interface FileHistorySnapshotFile {
  hash: string;
  version: number;
  fileName: string;
  content: string;
  size: number;
}

export interface FileHistoryDirectory {
  sessions: FileHistorySession[];
}
