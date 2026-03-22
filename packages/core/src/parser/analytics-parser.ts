import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileService } from '../io/index.js';
import type {
  AgentAnalytic,
  StatsCacheFile,
  HistoryFile,
  HistoryEntry,
  TelemetryDirectory,
  TelemetryFile,
  TelemetryEvent,
  DebugLogFile,
  DebugLogEntry,
  DebugLogLevel,
  DebugLatestSymlink,
  PasteCacheDirectory,
  PasteCacheFile,
  SessionEnvDirectory,
  SessionEnvEntry,
} from '../types/index.js';

export interface AnalyticsParserOptions {
  allDebugLogs?: boolean;
}

export interface AnalyticsParser {
  parseAnalytics(claudeDir: string, options?: AnalyticsParserOptions): AgentAnalytic;
  empty(): AgentAnalytic;
}

export class AnalyticsParserImpl implements AnalyticsParser {
  constructor(private fileService: FileService) {}

  parseAnalytics(claudeDir: string, options?: AnalyticsParserOptions): AgentAnalytic {
    return {
      statsCache: this.parseStatsCache(claudeDir),
      history: this.parseHistory(claudeDir),
      telemetry: this.parseTelemetry(claudeDir),
      debugLogs: this.parseDebugLogs(claudeDir, options?.allDebugLogs ?? false),
      debugLatest: this.parseDebugLatest(claudeDir),
      pasteCache: this.parsePasteCache(claudeDir),
      sessionEnv: this.parseSessionEnv(claudeDir),
    };
  }

  empty(): AgentAnalytic {
    return {
      statsCache: {
        version: 2,
        lastComputedDate: '',
        dailyActivity: [],
        dailyModelTokens: [],
        modelUsage: {},
        totalSessions: 0,
        totalMessages: 0,
        longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
        firstSessionDate: '',
        hourCounts: {},
        totalSpeculationTimeSavedMs: 0,
      },
      history: { entries: [] },
      telemetry: { files: [] },
      debugLogs: [],
      debugLatest: null,
      pasteCache: { entries: [] },
      sessionEnv: { entries: [] },
    };
  }

  private parseStatsCache(claudeDir: string): StatsCacheFile {
    try {
      const filePath = path.join(claudeDir, 'stats-cache.json');
      return this.fileService.readJsonSync<StatsCacheFile>(filePath) ?? this.empty().statsCache;
    } catch {
      return this.empty().statsCache;
    }
  }

  private parseHistory(claudeDir: string): HistoryFile {
    try {
      const filePath = path.join(claudeDir, 'history.jsonl');
      const result = this.fileService.readJsonlSync<HistoryEntry>(filePath);
      return { entries: result.entries };
    } catch {
      return { entries: [] };
    }
  }

  private parseTelemetry(claudeDir: string): TelemetryDirectory {
    try {
      const telemetryDir = path.join(claudeDir, 'telemetry');
      const filePaths = this.fileService.scanDirectorySync(telemetryDir, {
        pattern: '1p_failed_events.*.json',
      });

      const telemetryFiles: TelemetryFile[] = [];
      for (const filePath of filePaths) {
        try {
          const parsed = this.parseTelemetryFile(filePath);
          if (parsed) telemetryFiles.push(parsed);
        } catch {
          // skip bad telemetry file
        }
      }

      return { files: telemetryFiles };
    } catch {
      return { files: [] };
    }
  }

  private parseTelemetryFile(filePath: string): TelemetryFile | null {
    const fileName = path.basename(filePath);
    const match = fileName.match(/^1p_failed_events\.([0-9a-f-]+)\.([0-9a-f-]+)\.json$/);
    if (!match) return null;

    const result = this.fileService.readJsonlSync<TelemetryEvent>(filePath);
    const stats = this.fileService.getStats(filePath);

    return {
      sessionUuid: match[1],
      eventUuid: match[2],
      events: result.entries,
      size: stats?.size ?? 0,
    };
  }

  private parseDebugLogs(claudeDir: string, all: boolean): DebugLogFile[] {
    try {
      const debugDir = path.join(claudeDir, 'debug');

      if (!all) {
        const latest = this.parseDebugLatest(claudeDir);
        if (!latest) return [];
        try {
          const filePath = path.join(debugDir, `${latest.targetSessionId}.txt`);
          const content = this.fileService.readFileSync(filePath);
          const lines = this.parseDebugLogContent(content);
          return [{ sessionId: latest.targetSessionId, lines }];
        } catch {
          return [];
        }
      }

      const filePaths = this.fileService.scanDirectorySync(debugDir, { pattern: '*.txt' });

      const debugLogs: DebugLogFile[] = [];
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const sessionId = fileName.replace(/\.txt$/, '');
          const content = this.fileService.readFileSync(filePath);
          const lines = this.parseDebugLogContent(content);
          debugLogs.push({ sessionId, lines });
        } catch {
          // skip bad debug log
        }
      }

      return debugLogs;
    } catch {
      return [];
    }
  }

  private parseDebugLogContent(content: string): DebugLogEntry[] {
    const rawLines = content.split(/\r?\n/);
    const entries: DebugLogEntry[] = [];

    const logPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+\[(\w+)\]\s+(.*)/;
    const categoryPattern = /^\[([^\]]+)\]\s+(.*)/;
    const stackPattern = /^\s+at\s+/;

    for (const line of rawLines) {
      if (!line) continue;

      const logMatch = line.match(logPattern);
      if (logMatch) {
        const entry: DebugLogEntry = {
          timestamp: logMatch[1],
          level: logMatch[2] as DebugLogLevel,
          message: logMatch[3],
        };

        const catMatch = entry.message.match(categoryPattern);
        if (catMatch) {
          entry.category = catMatch[1];
          entry.message = catMatch[2];
        }

        entries.push(entry);
      } else if (entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        if (stackPattern.test(line)) {
          if (!lastEntry.stackTrace) lastEntry.stackTrace = [];
          lastEntry.stackTrace.push(line);
        } else {
          if (!lastEntry.continuationLines) lastEntry.continuationLines = [];
          lastEntry.continuationLines.push(line);
        }
      }
    }

    return entries;
  }

  private parseDebugLatest(claudeDir: string): DebugLatestSymlink | null {
    try {
      const latestPath = path.join(claudeDir, 'debug', 'latest');
      const targetPath = fs.readlinkSync(latestPath);
      const targetFileName = path.basename(targetPath);
      const targetSessionId = targetFileName.replace(/\.txt$/, '');
      return { targetSessionId, targetPath };
    } catch {
      return null;
    }
  }

  private parsePasteCache(claudeDir: string): PasteCacheDirectory {
    try {
      const cacheDir = path.join(claudeDir, 'paste-cache');
      const filePaths = this.fileService.scanDirectorySync(cacheDir, { pattern: '*.txt' });

      const entries: PasteCacheFile[] = [];
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const hash = fileName.replace(/\.txt$/, '');
          const content = this.fileService.readFileSync(filePath);
          const stats = this.fileService.getStats(filePath);
          entries.push({ hash, content, size: stats?.size ?? 0 });
        } catch {
          // skip bad paste cache file
        }
      }

      return { entries };
    } catch {
      return { entries: [] };
    }
  }

  private parseSessionEnv(claudeDir: string): SessionEnvDirectory {
    try {
      const envDir = path.join(claudeDir, 'session-env');
      const dirPaths = this.fileService.scanDirectorySync(envDir, { includeDirectories: true });

      const entries: SessionEnvEntry[] = dirPaths.map((dirPath) => ({
        sessionId: path.basename(dirPath),
      }));
      return { entries };
    } catch {
      return { entries: [] };
    }
  }
}

export function createAnalyticsParser(fileService: FileService): AnalyticsParser {
  return new AnalyticsParserImpl(fileService);
}
