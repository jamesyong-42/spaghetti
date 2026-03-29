/**
 * FileService - Unified file system operations
 *
 * Consolidates all file watching, reading, and writing operations.
 * Uses chokidar for directory watching and native fs.watch for single files.
 */

import { EventEmitter } from 'events';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  watch as fsWatch,
  type FSWatcher as NodeFSWatcher,
  type Stats,
} from 'fs';
import { readFile, writeFile, appendFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  readJsonlStreaming as readJsonlStreamingImpl,
  type StreamingJsonlResult,
  type StreamingJsonlOptions,
} from './streaming-jsonl-reader.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type FileEvent = 'add' | 'change' | 'unlink';

export interface FileChange {
  watcherId: string;
  event: FileEvent;
  path: string;
  stats?: FileStats;
}

export interface FileStats {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface DirectoryWatchOptions {
  patterns: string[];
  ignoreInitial?: boolean;
  awaitWriteFinish?:
    | {
        stabilityThreshold?: number;
        pollInterval?: number;
      }
    | boolean;
  depth?: number;
}

export interface FileWatchOptions {
  persistent?: boolean;
}

export interface ScanOptions {
  pattern?: string;
  recursive?: boolean;
  includeDirectories?: boolean;
  maxDepth?: number;
}

export interface ReadOptions {
  encoding?: BufferEncoding;
}

export interface ReadBytesOptions {
  start: number;
  length: number;
}

export interface JsonlReadResult<T> {
  entries: T[];
  errors: Array<{ line: number; error: string }>;
  totalLines: number;
}

export interface IncrementalReadResult<T> {
  entries: T[];
  newPosition: number;
  errors: Array<{ line: number; error: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface FileService extends EventEmitter {
  watchDirectory(id: string, options: DirectoryWatchOptions): void;
  watchFile(id: string, path: string, options?: FileWatchOptions): void;
  unwatch(id: string): void;
  unwatchAll(): void;
  getActiveWatchers(): string[];

  readFile(path: string, options?: ReadOptions): Promise<string>;
  readFileSync(path: string, options?: ReadOptions): string;
  readJson<T>(path: string): Promise<T | null>;
  readJsonSync<T>(path: string): T | null;
  readJsonl<T>(path: string): Promise<JsonlReadResult<T>>;
  readJsonlSync<T>(path: string): JsonlReadResult<T>;

  readFirstLine(path: string, maxBytes?: number): string | null;
  readBytes(path: string, options: ReadBytesOptions): Buffer;
  readLastBytes(path: string, bytes: number): Buffer;
  readJsonlIncremental<T>(path: string, fromPosition: number): IncrementalReadResult<T>;
  readJsonlStreaming<T>(
    path: string,
    callback: (entry: T, lineIndex: number, byteOffset: number) => void,
    options?: { fromBytePosition?: number; onError?: (lineIndex: number, error: string) => void },
  ): StreamingJsonlResult;

  writeFile(path: string, content: string | Buffer): Promise<void>;
  writeFileSync(path: string, content: string | Buffer): void;
  writeJson<T>(path: string, data: T): Promise<void>;
  writeJsonSync<T>(path: string, data: T): void;
  appendFile(path: string, content: string): Promise<void>;
  appendFileSync(path: string, content: string): void;
  appendJsonl<T>(path: string, entry: T): Promise<void>;

  ensureDir(path: string): Promise<void>;
  ensureDirSync(path: string): void;
  scanDirectory(path: string, options?: ScanOptions): Promise<string[]>;
  scanDirectorySync(path: string, options?: ScanOptions): string[];

  exists(path: string): boolean;
  getStats(path: string): FileStats | null;
  getFileSize(path: string): number | null;

  deleteFile(path: string): Promise<void>;
  cleanupOldFiles(
    directory: string,
    options: {
      pattern?: string;
      maxFiles?: number;
      maxAgeDays?: number;
    },
  ): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

export class FileServiceImpl extends EventEmitter implements FileService {
  private directoryWatchers: Map<string, FSWatcher> = new Map();
  private fileWatchers: Map<string, NodeFSWatcher> = new Map();

  watchDirectory(id: string, options: DirectoryWatchOptions): void {
    if (this.directoryWatchers.has(id) || this.fileWatchers.has(id)) {
      this.unwatch(id);
    }

    const watcher = chokidar.watch(options.patterns, {
      persistent: true,
      ignoreInitial: options.ignoreInitial ?? true,
      awaitWriteFinish:
        options.awaitWriteFinish === true
          ? { stabilityThreshold: 300, pollInterval: 100 }
          : options.awaitWriteFinish === false
            ? false
            : (options.awaitWriteFinish ?? { stabilityThreshold: 300, pollInterval: 100 }),
      depth: options.depth,
    });

    watcher.on('add', (path, stats) => this.emitChange(id, 'add', path, stats));
    watcher.on('change', (path, stats) => this.emitChange(id, 'change', path, stats));
    watcher.on('unlink', (path) => this.emitChange(id, 'unlink', path));
    watcher.on('error', (error) => this.emit('error', { watcherId: id, error }));
    watcher.on('ready', () => this.emit('ready', { watcherId: id }));

    this.directoryWatchers.set(id, watcher);
  }

  watchFile(id: string, path: string, options?: FileWatchOptions): void {
    if (this.directoryWatchers.has(id) || this.fileWatchers.has(id)) {
      this.unwatch(id);
    }

    try {
      const watcher = fsWatch(path, { persistent: options?.persistent ?? true }, (eventType) => {
        if (eventType === 'change') {
          const stats = this.getStats(path);
          this.emitChange(id, 'change', path, stats ?? undefined);
        }
      });

      watcher.on('error', (error) => this.emit('error', { watcherId: id, path, error }));
      this.fileWatchers.set(id, watcher);
    } catch (error) {
      this.emit('error', { watcherId: id, path, error });
    }
  }

  unwatch(id: string): void {
    const dirWatcher = this.directoryWatchers.get(id);
    if (dirWatcher) {
      dirWatcher.close();
      this.directoryWatchers.delete(id);
    }

    const fileWatcher = this.fileWatchers.get(id);
    if (fileWatcher) {
      fileWatcher.close();
      this.fileWatchers.delete(id);
    }
  }

  unwatchAll(): void {
    for (const [id] of this.directoryWatchers) {
      this.unwatch(id);
    }
    for (const [id] of this.fileWatchers) {
      this.unwatch(id);
    }
  }

  getActiveWatchers(): string[] {
    return [...this.directoryWatchers.keys(), ...this.fileWatchers.keys()];
  }

  private emitChange(watcherId: string, event: FileEvent, path: string, stats?: Stats | FileStats): void {
    let fileStats: FileStats | undefined;

    if (stats) {
      const isDir =
        typeof (stats as Stats).isDirectory === 'function'
          ? (stats as Stats).isDirectory()
          : (stats as FileStats).isDirectory;

      fileStats = {
        size: stats.size,
        mtimeMs: 'mtimeMs' in stats ? stats.mtimeMs : ((stats as Stats).mtime?.getTime() ?? 0),
        isDirectory: isDir,
      };
    }

    const change: FileChange = { watcherId, event, path, stats: fileStats };
    this.emit('change', change);
  }

  async readFile(path: string, options?: ReadOptions): Promise<string> {
    return readFile(path, options?.encoding ?? 'utf-8');
  }

  readFileSync(path: string, options?: ReadOptions): string {
    return readFileSync(path, options?.encoding ?? 'utf-8');
  }

  async readJson<T>(path: string): Promise<T | null> {
    try {
      if (!this.exists(path)) return null;
      const content = await this.readFile(path);
      return JSON.parse(content) as T;
    } catch (error) {
      this.emit('error', { path, error });
      return null;
    }
  }

  readJsonSync<T>(path: string): T | null {
    try {
      if (!this.exists(path)) return null;
      const content = this.readFileSync(path);
      return JSON.parse(content) as T;
    } catch (error) {
      this.emit('error', { path, error });
      return null;
    }
  }

  async readJsonl<T>(path: string): Promise<JsonlReadResult<T>> {
    return this.readJsonlSync<T>(path);
  }

  readJsonlSync<T>(path: string): JsonlReadResult<T> {
    const result: JsonlReadResult<T> = { entries: [], errors: [], totalLines: 0 };

    if (!this.exists(path)) return result;

    try {
      const content = this.readFileSync(path);
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        result.totalLines++;
        try {
          result.entries.push(JSON.parse(line) as T);
        } catch (error) {
          result.errors.push({
            line: i + 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.emit('error', { path, error });
    }

    return result;
  }

  readFirstLine(path: string, maxBytes: number = 8192): string | null {
    if (!this.exists(path)) return null;

    try {
      const fd = openSync(path, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
      closeSync(fd);

      const content = buffer.subarray(0, bytesRead).toString('utf-8');
      const newlineIndex = content.indexOf('\n');
      return newlineIndex !== -1 ? content.substring(0, newlineIndex).replace(/\r$/, '') : content;
    } catch (error) {
      this.emit('error', { path, error });
      return null;
    }
  }

  readBytes(path: string, options: ReadBytesOptions): Buffer {
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(options.length);
    readSync(fd, buffer, 0, options.length, options.start);
    closeSync(fd);
    return buffer;
  }

  readLastBytes(path: string, bytes: number): Buffer {
    const stats = this.getStats(path);
    if (!stats) return Buffer.alloc(0);

    const start = Math.max(0, stats.size - bytes);
    const length = Math.min(bytes, stats.size);
    return this.readBytes(path, { start, length });
  }

  readJsonlIncremental<T>(path: string, fromPosition: number): IncrementalReadResult<T> {
    const result: IncrementalReadResult<T> = { entries: [], newPosition: fromPosition, errors: [] };

    const stats = this.getStats(path);
    if (!stats || stats.size <= fromPosition) return result;

    try {
      const bytesToRead = stats.size - fromPosition;
      const buffer = this.readBytes(path, { start: fromPosition, length: bytesToRead });
      const content = buffer.toString('utf-8');
      const lines = content.split('\n');

      let processedBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        processedBytes += Buffer.byteLength(line, 'utf-8') + 1;

        const trimmed = line.trim();
        if (!trimmed) continue;

        if (i === lines.length - 1 && !content.endsWith('\n')) {
          processedBytes -= Buffer.byteLength(line, 'utf-8') + 1;
          break;
        }

        try {
          result.entries.push(JSON.parse(trimmed) as T);
        } catch (error) {
          result.errors.push({
            line: i,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      result.newPosition = fromPosition + processedBytes;
    } catch (error) {
      this.emit('error', { path, error });
    }

    return result;
  }

  readJsonlStreaming<T>(
    path: string,
    callback: (entry: T, lineIndex: number, byteOffset: number) => void,
    options?: { fromBytePosition?: number; onError?: (lineIndex: number, error: string) => void },
  ): StreamingJsonlResult {
    return readJsonlStreamingImpl<T>(path, callback, options as StreamingJsonlOptions | undefined);
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.ensureDir(dirname(path));
    await writeFile(path, content);
  }

  writeFileSync(path: string, content: string | Buffer): void {
    this.ensureDirSync(dirname(path));
    writeFileSync(path, content);
  }

  async writeJson<T>(path: string, data: T): Promise<void> {
    await this.writeFile(path, JSON.stringify(data, null, 2));
  }

  writeJsonSync<T>(path: string, data: T): void {
    this.writeFileSync(path, JSON.stringify(data, null, 2));
  }

  async appendFile(path: string, content: string): Promise<void> {
    await this.ensureDir(dirname(path));
    await appendFile(path, content);
  }

  appendFileSync(path: string, content: string): void {
    this.ensureDirSync(dirname(path));
    appendFileSync(path, content);
  }

  async appendJsonl<T>(path: string, entry: T): Promise<void> {
    await this.appendFile(path, JSON.stringify(entry) + '\n');
  }

  async ensureDir(path: string): Promise<void> {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  ensureDirSync(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  async scanDirectory(path: string, options?: ScanOptions): Promise<string[]> {
    return this.scanDirectorySync(path, options);
  }

  scanDirectorySync(path: string, options?: ScanOptions, currentDepth: number = 0): string[] {
    if (!this.exists(path)) return [];

    if (options?.maxDepth !== undefined && currentDepth > options.maxDepth) {
      return [];
    }

    const entries = readdirSync(path, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const fullPath = join(path, entry.name);

      if (entry.isDirectory()) {
        if (options?.includeDirectories) {
          if (!options.pattern || this.matchPattern(entry.name, options.pattern)) {
            results.push(fullPath);
          }
        }
        if (options?.recursive) {
          results.push(...this.scanDirectorySync(fullPath, options, currentDepth + 1));
        }
      } else {
        if (!options?.pattern || this.matchPattern(entry.name, options.pattern)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }

  private matchPattern(filename: string, pattern: string): boolean {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (braceMatch) {
      const alternatives = braceMatch[1].split(',');
      return alternatives.some((alt) => {
        const expandedPattern = pattern.replace(braceMatch[0], alt);
        return this.matchPattern(filename, expandedPattern);
      });
    }

    let regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '___STAR___')
      .replace(/\\\?/g, '___QUESTION___')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/___STAR___/g, '\\*')
      .replace(/___QUESTION___/g, '\\?');

    regex = `^${regex}$`;

    try {
      return new RegExp(regex).test(filename);
    } catch {
      return filename === pattern;
    }
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  getStats(path: string): FileStats | null {
    try {
      const stats = statSync(path);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: stats.isDirectory(),
      };
    } catch {
      return null;
    }
  }

  getFileSize(path: string): number | null {
    const stats = this.getStats(path);
    return stats?.size ?? null;
  }

  async deleteFile(path: string): Promise<void> {
    if (this.exists(path)) {
      await unlink(path);
    }
  }

  async cleanupOldFiles(
    directory: string,
    options: {
      pattern?: string;
      maxFiles?: number;
      maxAgeDays?: number;
    },
  ): Promise<number> {
    const files = await this.scanDirectory(directory, { pattern: options.pattern });
    if (files.length === 0) return 0;

    const fileInfos = files
      .map((f) => ({ path: f, stats: this.getStats(f) }))
      .filter((f) => f.stats !== null)
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));

    let deleted = 0;
    const now = Date.now();
    const maxAgeMs = options.maxAgeDays ? options.maxAgeDays * 24 * 60 * 60 * 1000 : null;

    for (let i = 0; i < fileInfos.length; i++) {
      const file = fileInfos[i];
      let shouldDelete = false;

      if (options.maxFiles !== undefined && i >= options.maxFiles) {
        shouldDelete = true;
      }

      if (maxAgeMs && file.stats && now - file.stats.mtimeMs > maxAgeMs) {
        shouldDelete = true;
      }

      if (shouldDelete) {
        await this.deleteFile(file.path);
        deleted++;
      }
    }

    return deleted;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON FACTORY
// ═══════════════════════════════════════════════════════════════════════════

let instance: FileServiceImpl | null = null;

export function getFileService(): FileService {
  if (!instance) {
    instance = new FileServiceImpl();
  }
  return instance;
}

export function createFileService(): FileService {
  return new FileServiceImpl();
}
