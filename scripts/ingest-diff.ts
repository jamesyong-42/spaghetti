#!/usr/bin/env -S tsx
/**
 * ingest-diff.ts — correctness gate for the Rust ingest port.
 *
 * Runs the TS ingest (via `@vibecook/spaghetti-sdk` → `createSpaghettiService`)
 * and the Rust ingest (via `@vibecook/spaghetti-sdk-native`) against the same
 * fixture directory, dumps every row of every table from both resulting
 * SQLite databases, and asserts the two dumps are semantically identical.
 *
 * The TS SDK writes first (and closes its connection cleanly) before the
 * Rust addon ever opens the Rust DB — they use different files and are
 * sequenced, so there is no WAL contention.
 *
 * Expected differences that the harness deliberately normalises away:
 *   - `updated_at` columns: both paths call `Date.now()` at write time and
 *     will always differ → ignored.
 *   - `source_files.mtime_ms`: set from fs.statSync and is ignored as per
 *     RFC 003. In addition, the Rust ingest (Phase 1 commit 1.7) does not
 *     write to `source_files` at all — the TS `saveAllFingerprints()`
 *     path has no Rust equivalent yet. The whole table is skipped.
 *   - JSON-valued columns — `projects.sessions_index`, `subagents.messages`,
 *     `todos.items`, `file_history.data`, and `messages.data` — are parsed
 *     as JSON before compare, because TS re-stringifies via `JSON.stringify`
 *     while Rust passes the raw JSONL line (for `messages.data`) or
 *     re-serialises via `serde_json` (for the others). The on-disk bytes
 *     therefore differ by whitespace / key order but the semantic value
 *     matches.
 *   - `search_fts` content-synced virtual table: FTS auxiliary tables
 *     (`search_fts_*`) are not diffed — they are a function of `messages`
 *     and derive from trigger output. We sanity-check the row count
 *     matches `messages` on both sides and leave it at that.
 *
 * Exit codes:
 *   0 — zero diffs.
 *   1 — at least one semantic diff, first ~10 printed.
 *   2 — harness error (fixture missing, DB open failed, etc.).
 *
 * TODO(RFC 005 C4.3): extend this harness with a "live-batch" fixture
 *   mode — generate a session JSONL with N lines, exercise both
 *   `IngestService.writeBatch` (TS path) and `live_ingest_batch` (Rust
 *   path) against the same seed, and diff the two resulting DB states.
 *   Deferred because the current harness assumes a one-shot cold-ingest
 *   flow and the SDK's dist bundle today can't be imported outside the
 *   SDK build due to a pre-existing `@parcel/watcher` dynamic-require
 *   bundling issue that crashes the harness at entry. Until that's
 *   resolved (separate bundler config fix), C4.3 parity is covered by
 *   the cargo-side tests in `crates/spaghetti-napi/src/live_ingest.rs`
 *   and the TS-side mocked-native tests in
 *   `packages/sdk/src/data/__tests__/ingest-service-write-batch.test.ts`.
 */

import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import { createSpaghettiService } from '../packages/sdk/dist/index.js';

// `@vibecook/spaghetti-sdk-native` is a workspace dep of the SDK, so it's
// already installed in node_modules — but `createRequire` lets us reach it
// from an ESM script without wrestling with module specifiers.
const require = createRequire(import.meta.url);

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    'ts-db': { type: 'string' },
    'rust-db': { type: 'string' },
  },
});

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultFixture = path.join(repoRoot, 'crates/spaghetti-napi/fixtures/small/.claude');
const fixtureClaudeDir = path.resolve(values.fixture ?? defaultFixture);
const tsDbPath = path.resolve(values['ts-db'] ?? '/tmp/ingest-diff-ts.db');
const rustDbPath = path.resolve(values['rust-db'] ?? '/tmp/ingest-diff-rust.db');

if (!existsSync(fixtureClaudeDir)) {
  console.error(`fixture not found: ${fixtureClaudeDir}`);
  console.error('regenerate with: node scripts/generate-ingest-fixture.mjs --out crates/spaghetti-napi/fixtures/small');
  process.exit(2);
}

for (const p of [tsDbPath, rustDbPath]) {
  if (existsSync(p)) rmSync(p, { force: true });
  // Better-sqlite3 also creates -wal / -shm side files.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(p + suffix)) rmSync(p + suffix, { force: true });
  }
}

// ─── Run the TS ingest ──────────────────────────────────────────────────────
//
// Worker threads are on when the SDK decides the project count warrants it.
// In this small fixture we have 3 projects, below the SDK's threshold of 4,
// so the sequential path runs — which is exactly what we want for a clean
// row-by-row diff (no worker-thread JSON round-trip).
//
// We deliberately run the TS ingest in the main Node process rather than
// shelling out: the SDK exports `createSpaghettiService`, `initialize()`
// blocks until the DB is closed cleanly, and we need the DB closed before
// the Rust addon opens its own (separate) file.

async function runTsIngest(): Promise<{ durationMs: number }> {
  const start = Date.now();

  // Phase 4: the SDK defaults to the native ingest path. Force the TS
  // fallback so this "TS" side of the diff actually exercises the TS
  // code — otherwise we'd be diffing Rust-vs-Rust.
  const prior = process.env.SPAG_NATIVE_INGEST;
  process.env.SPAG_NATIVE_INGEST = '0';

  // Quieten the SDK's progress emitter — it's useful in the CLI but noisy
  // in CI logs. Consumers can opt in with VERBOSE=1.
  const verbose = process.env.VERBOSE === '1';

  const svc = createSpaghettiService({
    claudeDir: fixtureClaudeDir,
    dbPath: tsDbPath,
  });

  if (verbose) {
    // Progress events are emitted on the underlying data service, which is
    // wrapped by AppService. AppService re-emits 'progress' so we tap it.
    (svc as unknown as { on: (ev: string, cb: (p: unknown) => void) => void }).on('progress', (p) => {
      console.log('[ts]', p);
    });
  }

  await svc.initialize();
  svc.shutdown();

  // Restore the caller's env var so other code paths behave normally.
  if (prior === undefined) delete process.env.SPAG_NATIVE_INGEST;
  else process.env.SPAG_NATIVE_INGEST = prior;

  return { durationMs: Date.now() - start };
}

// ─── Run the Rust ingest ────────────────────────────────────────────────────

interface NativeAddon {
  ingest(opts: {
    claudeDir: string;
    dbPath: string;
    mode: 'cold' | 'warm';
    progressIntervalMs?: number;
    parallelism?: number;
  }): Promise<{
    durationMs: number;
    projectsProcessed: number;
    sessionsProcessed: number;
    messagesWritten: number;
    subagentsWritten: number;
    errors: Array<{ slug: string; message: string }>;
  }>;
  nativeVersion(): string;
}

async function runRustIngest(): Promise<{ durationMs: number; stats: Awaited<ReturnType<NativeAddon['ingest']>> }> {
  const native = require('@vibecook/spaghetti-sdk-native') as NativeAddon;
  const start = Date.now();
  const stats = await native.ingest({
    claudeDir: fixtureClaudeDir,
    dbPath: rustDbPath,
    mode: 'cold',
  });
  return { durationMs: Date.now() - start, stats };
}

// ─── Table inventory ────────────────────────────────────────────────────────
//
// Tables to diff, in the order we care about them. Each table declaration
// says which columns to parse-as-JSON and which to ignore entirely.
// `source_files` is deliberately absent: the Rust ingest doesn't write it
// in Phase 1, and the TS ingest writes it from `saveAllFingerprints()` —
// there would be nothing to meaningfully diff.

interface TableSpec {
  name: string;
  /** `ORDER BY` clause that gives a deterministic row ordering for diffing. */
  orderBy: string;
  /** Columns whose values are JSON strings; parse them before comparing. */
  jsonColumns?: string[];
  /** Columns to skip (e.g. updated_at, mtimeMs that both sides set to now()). */
  ignoreColumns?: string[];
}

const TABLE_SPECS: TableSpec[] = [
  { name: 'schema_meta', orderBy: 'key' },
  {
    name: 'projects',
    orderBy: 'slug',
    jsonColumns: ['sessions_index'],
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'project_memories',
    orderBy: 'project_slug',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'sessions',
    orderBy: 'id',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'messages',
    // `id` is AUTOINCREMENT; same insertion order on both sides gives the
    // same ids, but we key on (session_id, msg_index) which is UNIQUE so
    // the diff is robust even if ids drift.
    orderBy: 'session_id, msg_index',
    jsonColumns: ['data'],
    ignoreColumns: ['id'],
  },
  {
    name: 'subagents',
    orderBy: 'project_slug, session_id, agent_id',
    jsonColumns: ['messages'],
    ignoreColumns: ['id', 'updated_at'],
  },
  {
    name: 'tool_results',
    orderBy: 'project_slug, session_id, tool_use_id',
    ignoreColumns: ['id', 'updated_at'],
  },
  {
    name: 'todos',
    orderBy: 'session_id, agent_id',
    jsonColumns: ['items'],
    ignoreColumns: ['id', 'updated_at'],
  },
  {
    name: 'tasks',
    orderBy: 'session_id',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'plans',
    orderBy: 'slug',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'config',
    orderBy: 'key',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'analytics',
    orderBy: 'key',
    ignoreColumns: ['updated_at'],
  },
  {
    name: 'file_history',
    orderBy: 'session_id',
    jsonColumns: ['data'],
    ignoreColumns: ['updated_at'],
  },
];

// ─── Dump + diff ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function dumpTable(db: Database.Database, spec: TableSpec): Row[] {
  const rows = db.prepare(`SELECT * FROM ${spec.name} ORDER BY ${spec.orderBy}`).all() as Row[];
  return rows.map((row) => normaliseRow(row, spec));
}

function normaliseRow(row: Row, spec: TableSpec): Row {
  const out: Row = {};
  const ignore = new Set(spec.ignoreColumns ?? []);
  const jsonCols = new Set(spec.jsonColumns ?? []);
  for (const [k, v] of Object.entries(row)) {
    if (ignore.has(k)) continue;
    if (jsonCols.has(k) && typeof v === 'string' && v.length > 0) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface Diff {
  table: string;
  rowIndex: number;
  kind: 'row-count' | 'field' | 'ts-only-row' | 'rust-only-row';
  field?: string;
  tsValue?: unknown;
  rustValue?: unknown;
}

function canonical(v: unknown): string {
  // Stable JSON with sorted keys — used both for row-key comparison and
  // for rendering a readable diff. Order-independent so { a:1, b:2 } and
  // { b:2, a:1 } hash identically.
  return JSON.stringify(v, sortedReplacer(v), 2);
}

function sortedReplacer(root: unknown): (key: string, value: unknown) => unknown {
  return function (_key: string, value: unknown) {
    if (value === root) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(entries);
    }
    return value;
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bArr[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao).sort();
  const keysB = Object.keys(bo).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!deepEqual(ao[keysA[i]], bo[keysA[i]])) return false;
  }
  return true;
}

function diffTable(tsRows: Row[], rustRows: Row[], spec: TableSpec): Diff[] {
  const diffs: Diff[] = [];

  if (tsRows.length !== rustRows.length) {
    diffs.push({
      table: spec.name,
      rowIndex: -1,
      kind: 'row-count',
      tsValue: tsRows.length,
      rustValue: rustRows.length,
    });
  }

  const limit = Math.min(tsRows.length, rustRows.length);
  for (let i = 0; i < limit; i++) {
    const t = tsRows[i];
    const r = rustRows[i];
    const allKeys = new Set<string>([...Object.keys(t), ...Object.keys(r)]);
    for (const key of allKeys) {
      if (!deepEqual(t[key], r[key])) {
        diffs.push({
          table: spec.name,
          rowIndex: i,
          kind: 'field',
          field: key,
          tsValue: t[key],
          rustValue: r[key],
        });
      }
    }
  }

  for (let i = limit; i < tsRows.length; i++) {
    diffs.push({ table: spec.name, rowIndex: i, kind: 'ts-only-row', tsValue: tsRows[i] });
  }
  for (let i = limit; i < rustRows.length; i++) {
    diffs.push({ table: spec.name, rowIndex: i, kind: 'rust-only-row', rustValue: rustRows[i] });
  }

  return diffs;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`fixture: ${fixtureClaudeDir}`);
  console.log(`ts-db:   ${tsDbPath}`);
  console.log(`rust-db: ${rustDbPath}`);
  console.log('');

  // Run TS first — it holds the DB handle open via better-sqlite3 inside the
  // SDK. Calling shutdown() releases it. Only then do we touch Rust.
  console.log('running TS ingest...');
  const ts = await runTsIngest();
  console.log(`  TS ingest: ${ts.durationMs}ms`);

  console.log('running Rust ingest...');
  const rust = await runRustIngest();
  console.log(`  Rust ingest: ${rust.durationMs}ms`);
  console.log(
    `  stats: projects=${rust.stats.projectsProcessed} sessions=${rust.stats.sessionsProcessed} messages=${rust.stats.messagesWritten} subagents=${rust.stats.subagentsWritten}`,
  );
  if (rust.stats.errors.length > 0) {
    console.log(`  WARN: Rust ingest recorded ${rust.stats.errors.length} parse errors:`);
    for (const e of rust.stats.errors.slice(0, 5)) {
      console.log(`    [${e.slug}] ${e.message}`);
    }
  }

  console.log('');
  console.log('opening both DBs read-only for compare...');
  const tsDb = new Database(tsDbPath, { readonly: true });
  const rustDb = new Database(rustDbPath, { readonly: true });

  const allDiffs: Diff[] = [];

  try {
    for (const spec of TABLE_SPECS) {
      // Sanity: both DBs must have the table (schema is owned identically by both).
      const tsExists = tsDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(spec.name);
      const rustExists = rustDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(spec.name);
      if (!tsExists || !rustExists) {
        allDiffs.push({
          table: spec.name,
          rowIndex: -1,
          kind: 'row-count',
          tsValue: tsExists ? 'present' : 'missing',
          rustValue: rustExists ? 'present' : 'missing',
        });
        continue;
      }

      const tsRows = dumpTable(tsDb, spec);
      const rustRows = dumpTable(rustDb, spec);
      const tableDiffs = diffTable(tsRows, rustRows, spec);
      if (tableDiffs.length === 0) {
        console.log(`  ✓ ${spec.name}: ${tsRows.length} rows, clean`);
      } else {
        console.log(`  ✗ ${spec.name}: ${tableDiffs.length} diff(s)`);
        allDiffs.push(...tableDiffs);
      }
    }

    // FTS sanity: row count equal on both sides.
    const tsFts = (tsDb.prepare('SELECT COUNT(*) AS c FROM search_fts').get() as { c: number }).c;
    const rustFts = (rustDb.prepare('SELECT COUNT(*) AS c FROM search_fts').get() as { c: number }).c;
    if (tsFts !== rustFts) {
      allDiffs.push({
        table: 'search_fts (row count)',
        rowIndex: -1,
        kind: 'row-count',
        tsValue: tsFts,
        rustValue: rustFts,
      });
    } else {
      console.log(`  ✓ search_fts: ${tsFts} rows (count match)`);
    }
  } finally {
    tsDb.close();
    rustDb.close();
  }

  console.log('');

  if (allDiffs.length === 0) {
    console.log('RESULT: zero diffs ✓');
    process.exit(0);
  }

  console.log(`RESULT: ${allDiffs.length} diff(s) — first 10:`);
  for (const d of allDiffs.slice(0, 10)) {
    const prefix = `  [${d.table}#${d.rowIndex}] ${d.kind}`;
    if (d.kind === 'row-count') {
      console.log(`${prefix}: ts=${d.tsValue} rust=${d.rustValue}`);
    } else if (d.kind === 'field') {
      console.log(`${prefix} field=${d.field}`);
      console.log(`    ts:   ${canonical(d.tsValue)}`);
      console.log(`    rust: ${canonical(d.rustValue)}`);
    } else if (d.kind === 'ts-only-row') {
      console.log(`${prefix}: ${canonical(d.tsValue)}`);
    } else {
      console.log(`${prefix}: ${canonical(d.rustValue)}`);
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
