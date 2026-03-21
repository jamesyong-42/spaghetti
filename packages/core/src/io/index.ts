/**
 * I/O Module — Core I/O primitives
 */

export {
  type FileEvent,
  type FileChange,
  type FileStats,
  type DirectoryWatchOptions,
  type FileWatchOptions,
  type ScanOptions,
  type ReadOptions,
  type ReadBytesOptions,
  type JsonlReadResult,
  type IncrementalReadResult,
  type FileService,
  FileServiceImpl,
  getFileService,
  createFileService,
} from './file-service.js';

export {
  type JsonlLineCallback,
  type StreamingJsonlOptions,
  type StreamingJsonlResult,
  readJsonlStreaming,
} from './streaming-jsonl-reader.js';

export {
  type SqliteConfig,
  type RunResult,
  type PreparedStatement,
  type TableInfo,
  type SqliteService,
  SqliteServiceImpl,
  createSqliteService,
} from './sqlite-service.js';

