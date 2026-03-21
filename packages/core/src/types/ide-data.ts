/**
 * TypeScript interfaces for ~/.claude/ide/
 */

export interface IdeLockFile {
  workspaceFolders: string[];
  pid: number;
  ideName: string;
  transport: string;
  runningInWindows: boolean;
  authToken: string;
}

export interface IdeDirectory {
  lockFiles: IdeLockFile[];
}
