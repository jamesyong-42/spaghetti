import * as os from 'node:os';
import * as path from 'node:path';
import type { FileService } from '../../../io/index.js';
import type { ClaudeCodeAgentData } from '../../../types/index.js';
import { createProjectParser } from './project-parser.js';
import { createConfigParser } from './config-parser.js';
import { createAnalyticsParser } from './analytics-parser.js';
import type { ProjectParser, ProjectParserOptions } from './project-parser.js';
import type { ConfigParser } from './config-parser.js';
import type { AnalyticsParser } from './analytics-parser.js';
import type { ProjectParseSink } from '../../../data/parse-sink.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER OPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeParserOptions {
  /** Claude Code data root (e.g. `~/.claude`). Prefer this over {@link claudeDir}. */
  rootDir?: string;
  /** @deprecated Use {@link rootDir}. */
  claudeDir?: string;
  skipProjects?: boolean;
  skipSessionMessages?: boolean;
  skipConfig?: boolean;
  skipAnalytics?: boolean;
  allDebugLogs?: boolean;
  allShellSnapshots?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE CODE PARSER INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeParser {
  parse(options?: ClaudeCodeParserOptions): Promise<ClaudeCodeAgentData>;
  parseSync(options?: ClaudeCodeParserOptions): ClaudeCodeAgentData;
  parseStreaming(sink: ProjectParseSink, options?: ClaudeCodeParserOptions): void;
  /** Parse a single project in streaming mode */
  parseProjectStreaming(rootDir: string, slug: string, sink: ProjectParseSink): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export class ClaudeCodeParserImpl implements ClaudeCodeParser {
  private projectParser: ProjectParser;
  private configParser: ConfigParser;
  private analyticsParser: AnalyticsParser;

  constructor(fileService: FileService) {
    this.projectParser = createProjectParser(fileService);
    this.configParser = createConfigParser(fileService);
    this.analyticsParser = createAnalyticsParser(fileService);
  }

  async parse(options?: ClaudeCodeParserOptions): Promise<ClaudeCodeAgentData> {
    return this.parseSync(options);
  }

  parseSync(options?: ClaudeCodeParserOptions): ClaudeCodeAgentData {
    const rootDir = options?.rootDir ?? options?.claudeDir ?? path.join(os.homedir(), '.claude');

    return {
      projects: options?.skipProjects
        ? []
        : this.projectParser.parseAllProjects(rootDir, {
            skipSessionMessages: options?.skipSessionMessages,
          }),
      config: options?.skipConfig
        ? this.configParser.empty()
        : this.configParser.parseConfig(rootDir, {
            allShellSnapshots: options?.allShellSnapshots,
          }),
      analytics: options?.skipAnalytics
        ? this.analyticsParser.empty()
        : this.analyticsParser.parseAnalytics(rootDir, {
            allDebugLogs: options?.allDebugLogs,
          }),
    };
  }

  parseStreaming(sink: ProjectParseSink, options?: ClaudeCodeParserOptions): void {
    const rootDir = options?.rootDir ?? options?.claudeDir ?? path.join(os.homedir(), '.claude');

    if (!options?.skipProjects) {
      const parserOptions: ProjectParserOptions = {
        skipSessionMessages: options?.skipSessionMessages,
      };
      this.projectParser.parseAllProjectsStreaming(rootDir, sink, parserOptions);
    }

    // Config and analytics still use sync parsers (they're small data)
    // — consumers that need them can call parseSync() separately.
  }

  parseProjectStreaming(rootDir: string, slug: string, sink: ProjectParseSink): void {
    this.projectParser.parseProjectStreaming(rootDir, slug, sink);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createClaudeCodeParser(fileService: FileService): ClaudeCodeParser {
  return new ClaudeCodeParserImpl(fileService);
}
