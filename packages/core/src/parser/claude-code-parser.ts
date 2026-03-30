import * as os from 'node:os';
import * as path from 'node:path';
import type { FileService } from '../io/index.js';
import type { ClaudeCodeAgentData } from '../types/index.js';
import { createProjectParser } from './project-parser.js';
import { createConfigParser } from './config-parser.js';
import { createAnalyticsParser } from './analytics-parser.js';
import type { ProjectParser, ProjectParserOptions } from './project-parser.js';
import type { ConfigParser } from './config-parser.js';
import type { AnalyticsParser } from './analytics-parser.js';
import type { ProjectParseSink } from './parse-sink.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER OPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClaudeCodeParserOptions {
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
  parseProjectStreaming(claudeDir: string, slug: string, sink: ProjectParseSink): void;
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
    const claudeDir = options?.claudeDir ?? path.join(os.homedir(), '.claude');

    return {
      projects: options?.skipProjects
        ? []
        : this.projectParser.parseAllProjects(claudeDir, {
            skipSessionMessages: options?.skipSessionMessages,
          }),
      config: options?.skipConfig
        ? this.configParser.empty()
        : this.configParser.parseConfig(claudeDir, {
            allShellSnapshots: options?.allShellSnapshots,
          }),
      analytics: options?.skipAnalytics
        ? this.analyticsParser.empty()
        : this.analyticsParser.parseAnalytics(claudeDir, {
            allDebugLogs: options?.allDebugLogs,
          }),
    };
  }

  parseStreaming(sink: ProjectParseSink, options?: ClaudeCodeParserOptions): void {
    const claudeDir = options?.claudeDir ?? path.join(os.homedir(), '.claude');

    if (!options?.skipProjects) {
      const parserOptions: ProjectParserOptions = {
        skipSessionMessages: options?.skipSessionMessages,
      };
      this.projectParser.parseAllProjectsStreaming(claudeDir, sink, parserOptions);
    }

    // Config and analytics still use sync parsers (they're small data)
    // — consumers that need them can call parseSync() separately.
  }

  parseProjectStreaming(claudeDir: string, slug: string, sink: ProjectParseSink): void {
    this.projectParser.parseProjectStreaming(claudeDir, slug, sink);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createClaudeCodeParser(fileService: FileService): ClaudeCodeParser {
  return new ClaudeCodeParserImpl(fileService);
}
