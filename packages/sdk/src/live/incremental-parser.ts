/**
 * @deprecated Claude incremental parser lives under `sources/claude-code/live/`.
 * Shared write-batch types: `live/parsed-row.ts`.
 */
export type { ParsedRow, ParsedRowCategory } from './parsed-row.js';
export {
  createIncrementalParser,
  type IncrementalParser,
  type IncrementalParseResult,
  type ParseFileDeltaParams,
} from '../sources/claude-code/live/incremental-parser.js';
