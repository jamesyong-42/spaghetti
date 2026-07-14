/**
 * TypeScript interfaces for ~/.claude/debug/
 */

export interface DebugLogFile {
  sessionId: string;
  lines: DebugLogEntry[];
}

export interface DebugLogEntry {
  timestamp: string;
  level: DebugLogLevel;
  message: string;
  category?: string;
  stackTrace?: string[];
  continuationLines?: string[];
}

export type DebugLogLevel = 'DEBUG' | 'ERROR' | 'WARN' | 'INFO';

export interface DebugLatestSymlink {
  targetSessionId: string;
  targetPath: string;
}
