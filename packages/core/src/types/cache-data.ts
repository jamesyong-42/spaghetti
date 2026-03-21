/**
 * TypeScript interfaces for ~/.claude/cache/
 */

export interface ChangelogFile {
  content: string;
  size: number;
}

export interface CacheDirectory {
  changelog?: ChangelogFile;
}
