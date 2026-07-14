/**
 * Claude Code on-disk parsers (product-specific).
 *
 * Shared write contract: {@link ProjectParseSink} in `data/parse-sink.ts`.
 */

export {
  type ClaudeCodeParserOptions,
  type ClaudeCodeParser,
  ClaudeCodeParserImpl,
  createClaudeCodeParser,
} from './claude-code-parser.js';

export {
  type ProjectParserOptions,
  type ProjectParser,
  ProjectParserImpl,
  createProjectParser,
} from './project-parser.js';

export { type ConfigParserOptions, type ConfigParser, ConfigParserImpl, createConfigParser } from './config-parser.js';

export {
  type AnalyticsParserOptions,
  type AnalyticsParser,
  AnalyticsParserImpl,
  createAnalyticsParser,
} from './analytics-parser.js';

export {
  type ParsedSubagentFilename,
  type ParsedTodoFilename,
  type ParsedFileHistoryFilename,
  type ParsedPlanFilename,
  parseSubagentFilename,
  inferSubagentType,
  parseTodoFilename,
  parseFileHistoryFilename,
  parsePlanFilename,
} from './filename-conventions.js';
