/**
 * SqliteService - Wrapper around better-sqlite3
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SqliteConfig {
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement<T = unknown> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  iterate(...params: unknown[]): IterableIterator<T>;
}

export interface TableInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface SqliteService {
  open(config: SqliteConfig): void;
  close(): void;
  isOpen(): boolean;
  getDb(): Database.Database;

  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): RunResult;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  iterate<T>(sql: string, ...params: unknown[]): IterableIterator<T>;

  prepare<T = unknown>(sql: string): PreparedStatement<T>;

  transaction<T>(fn: () => T): T;

  tableExists(tableName: string): boolean;
  getTables(): string[];
  getTableInfo(tableName: string): TableInfo[];
  vacuum(): void;
  getFileSize(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

export class SqliteServiceImpl implements SqliteService {
  private db: Database.Database | null = null;
  private config: SqliteConfig | null = null;

  open(config: SqliteConfig): void {
    if (this.db) {
      throw new Error('Database already open. Close it first.');
    }

    const dir = dirname(config.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const dbOptions: {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
    } = {};

    if (config.readonly !== undefined) dbOptions.readonly = config.readonly;
    if (config.fileMustExist !== undefined) dbOptions.fileMustExist = config.fileMustExist;
    if (config.timeout !== undefined) dbOptions.timeout = config.timeout;
    if (config.verbose !== undefined) dbOptions.verbose = config.verbose;

    this.db = new Database(config.path, dbOptions);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.config = config;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.config = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }
    return this.db;
  }

  exec(sql: string): void {
    this.getDb().exec(sql);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const result = this.getDb().prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.getDb().prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.getDb().prepare(sql).all(...params) as T[];
  }

  iterate<T>(sql: string, ...params: unknown[]): IterableIterator<T> {
    return this.getDb().prepare(sql).iterate(...params) as IterableIterator<T>;
  }

  prepare<T = unknown>(sql: string): PreparedStatement<T> {
    const stmt = this.getDb().prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const result = stmt.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params: unknown[]) => stmt.get(...params) as T | undefined,
      all: (...params: unknown[]) => stmt.all(...params) as T[],
      iterate: (...params: unknown[]) => stmt.iterate(...params) as IterableIterator<T>,
    };
  }

  transaction<T>(fn: () => T): T {
    const db = this.getDb();
    const transaction = db.transaction(fn);
    return transaction();
  }

  tableExists(tableName: string): boolean {
    const result = this.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?`,
      tableName
    );
    return (result?.count ?? 0) > 0;
  }

  getTables(): string[] {
    const rows = this.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    return rows.map((r) => r.name);
  }

  getTableInfo(tableName: string): TableInfo[] {
    return this.all<TableInfo>(`PRAGMA table_info(${tableName})`);
  }

  vacuum(): void {
    this.getDb().exec('VACUUM');
  }

  getFileSize(): number {
    if (!this.config) return 0;
    try {
      const { statSync } = require('fs');
      const stats = statSync(this.config.path);
      return stats.size;
    } catch {
      return 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createSqliteService(): SqliteService {
  return new SqliteServiceImpl();
}
