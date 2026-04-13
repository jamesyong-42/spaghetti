/**
 * TypeScript interfaces for ~/.claude/paste-cache/
 */

export interface PasteCacheFile {
  hash: string;
  content: string;
  size: number;
}

export interface PasteCacheDirectory {
  entries: PasteCacheFile[];
}
