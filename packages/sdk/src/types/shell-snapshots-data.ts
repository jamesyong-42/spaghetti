/**
 * TypeScript interfaces for ~/.claude/shell-snapshots/
 */

export interface ShellSnapshotFile {
  shell: string;
  timestamp: number;
  hash: string;
  fileName: string;
  content: string;
  size: number;
}

export interface ShellSnapshotsDirectory {
  snapshots: ShellSnapshotFile[];
}
