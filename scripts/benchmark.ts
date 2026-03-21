/**
 * Benchmark script for @spaghetti/core
 *
 * Measures cold start, warm start, and query performance against real ~/.claude data.
 * Validates against Architecture C targets.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts
 *
 * Prerequisites:
 *   Worker threads require parse-worker.js to be compiled. This script does it
 *   automatically via esbuild if the file is missing.
 */

import { performance } from 'node:perf_hooks';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createSpaghettiService } from '../packages/core/src/create.js';
import type { SpaghettiAPI } from '../packages/core/src/api.js';
import type { InitProgress } from '../packages/core/src/data/segment-types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Ensure parse-worker.js exists (needed for worker threads in dev mode)
// ═══════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORKER_TS = join(ROOT, 'packages/core/src/workers/parse-worker.ts');
const WORKER_JS = join(ROOT, 'packages/core/src/workers/parse-worker.js');

if (!existsSync(WORKER_JS)) {
  console.log('Building parse-worker.js for worker threads...');
  execSync(
    `npx esbuild "${WORKER_TS}" --bundle --platform=node --format=esm --outfile="${WORKER_JS}" --external:better-sqlite3`,
    { cwd: ROOT, stdio: 'inherit' },
  );
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const DB_PATH = join(homedir(), '.spaghetti', 'cache', 'spaghetti.db');
const DB_WAL_PATH = DB_PATH + '-wal';
const DB_SHM_PATH = DB_PATH + '-shm';
const QUERY_ITERATIONS = 10;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function deleteDbFiles(): void {
  for (const f of [DB_PATH, DB_WAL_PATH, DB_SHM_PATH]) {
    if (existsSync(f)) {
      unlinkSync(f);
    }
  }
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getDbSizeBytes(): number {
  try {
    return statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getHeapMB(): string {
  return `${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1)} MB`;
}

async function benchFn<T>(fn: () => T | Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

async function benchAvg<T>(fn: () => T | Promise<T>, iterations: number): Promise<{ durationMs: number; result: T }> {
  let totalMs = 0;
  let lastResult: T;
  for (let i = 0; i < iterations; i++) {
    const { result, durationMs } = await benchFn(fn);
    totalMs += durationMs;
    lastResult = result;
  }
  return { durationMs: totalMs / iterations, result: lastResult! };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmarks
// ═══════════════════════════════════════════════════════════════════════════

interface BenchmarkResults {
  coldStartMs: number;
  warmStartMs: number;
  projectCount: number;
  sessionCount: number;
  messageCount: number;
  dbSizeBytes: number;
  peakHeapMB: string;
  queries: Record<string, number>;
}

async function runBenchmarks(): Promise<BenchmarkResults> {
  const results: BenchmarkResults = {
    coldStartMs: 0,
    warmStartMs: 0,
    projectCount: 0,
    sessionCount: 0,
    messageCount: 0,
    dbSizeBytes: 0,
    peakHeapMB: '',
    queries: {},
  };

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           @spaghetti/core Performance Benchmark             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Cold Start
  // ─────────────────────────────────────────────────────────────────────────

  console.log('── 1. Cold Start ──────────────────────────────────────────────');
  console.log('  Deleting existing DB...');
  deleteDbFiles();

  const coldService = createSpaghettiService();
  const progressUnsub = coldService.onProgress((progress: InitProgress) => {
    console.log(`  [${progress.phase}] ${progress.message}`);
  });

  const coldStart = performance.now();
  await coldService.initialize();
  const coldEnd = performance.now();
  results.coldStartMs = coldEnd - coldStart;

  progressUnsub();

  // Verify data
  const projects = coldService.getProjectList();
  const stats = coldService.getStats();
  results.projectCount = projects.length;
  results.dbSizeBytes = getDbSizeBytes();
  results.peakHeapMB = getHeapMB();

  // Count total sessions and messages from stats (table names: 'sessions', 'messages')
  results.sessionCount = stats.segmentsByType['sessions'] ?? 0;
  results.messageCount = stats.segmentsByType['messages'] ?? 0;

  console.log(`  Cold start: ${formatMs(results.coldStartMs)}`);
  console.log(`  Projects: ${results.projectCount}`);
  console.log(`  Sessions: ${results.sessionCount}`);
  console.log(`  Messages: ${results.messageCount}`);
  console.log(`  Total segments: ${stats.totalSegments}`);
  console.log(`  Segments by type:`, JSON.stringify(stats.segmentsByType));
  console.log(`  DB size: ${formatBytes(results.dbSizeBytes)}`);
  console.log(`  Heap: ${results.peakHeapMB}`);
  console.log('');

  coldService.shutdown();

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Warm Start
  // ─────────────────────────────────────────────────────────────────────────

  console.log('── 2. Warm Start ─────────────────────────────────────────────');

  const warmService = createSpaghettiService();
  const warmProgressUnsub = warmService.onProgress((progress: InitProgress) => {
    console.log(`  [${progress.phase}] ${progress.message}`);
  });

  const warmStart = performance.now();
  await warmService.initialize();
  const warmEnd = performance.now();
  results.warmStartMs = warmEnd - warmStart;

  warmProgressUnsub();

  // Verify data is still accessible
  const warmProjects = warmService.getProjectList();
  console.log(`  Warm start: ${formatMs(results.warmStartMs)}`);
  console.log(`  Projects (verify): ${warmProjects.length}`);
  console.log('');

  warmService.shutdown();

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Query Benchmarks
  // ─────────────────────────────────────────────────────────────────────────

  console.log('── 3. Query Benchmarks ───────────────────────────────────────');
  console.log(`  (averaging over ${QUERY_ITERATIONS} iterations each)`);
  console.log('');

  const queryService = createSpaghettiService();
  await queryService.initialize();

  const allProjects = queryService.getProjectList();

  // getProjectList()
  {
    const { durationMs } = await benchAvg(() => queryService.getProjectList(), QUERY_ITERATIONS);
    results.queries['getProjectList()'] = durationMs;
    console.log(`  getProjectList()          ${formatMs(durationMs).padStart(10)}`);
  }

  // getSessionList() — pick the first project with sessions
  let testProjectSlug = '';
  let testSessionId = '';
  if (allProjects.length > 0) {
    // Pick the project with the most sessions for a meaningful benchmark
    const sortedBySessionCount = [...allProjects].sort((a, b) => b.sessionCount - a.sessionCount);
    testProjectSlug = sortedBySessionCount[0].slug;

    const sessions = queryService.getSessionList(testProjectSlug);

    {
      const { durationMs } = await benchAvg(
        () => queryService.getSessionList(testProjectSlug),
        QUERY_ITERATIONS,
      );
      results.queries[`getSessionList('${testProjectSlug.slice(0, 20)}...')`] = durationMs;
      console.log(`  getSessionList()          ${formatMs(durationMs).padStart(10)}  (${sessions.length} sessions)`);
    }

    // getSessionMessages() — find a session that actually has messages
    if (sessions.length > 0) {
      // Try to find a session with a non-zero messageCount
      const sortedSessions = [...sessions].sort((a, b) => b.messageCount - a.messageCount);
      testSessionId = sortedSessions[0].sessionId;

      // Verify this session has stored messages by doing a trial query
      const trial = queryService.getSessionMessages(testProjectSlug, testSessionId, 1, 0);
      if (trial.total === 0 && sessions.length > 1) {
        // Try finding any session with stored messages across all projects
        let found = false;
        for (const proj of allProjects) {
          const projSessions = queryService.getSessionList(proj.slug);
          for (const sess of projSessions) {
            const check = queryService.getSessionMessages(proj.slug, sess.sessionId, 1, 0);
            if (check.total > 0) {
              testProjectSlug = proj.slug;
              testSessionId = sess.sessionId;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      const { durationMs } = await benchAvg(
        () => queryService.getSessionMessages(testProjectSlug, testSessionId, 50, 0),
        QUERY_ITERATIONS,
      );
      results.queries['getSessionMessages()'] = durationMs;
      const msgPage = queryService.getSessionMessages(testProjectSlug, testSessionId, 50, 0);
      console.log(`  getSessionMessages()      ${formatMs(durationMs).padStart(10)}  (${msgPage.total} total msgs in session)`);
    }
  }

  // search()
  {
    const { durationMs, result } = await benchAvg(
      () => queryService.search({ text: 'function' }),
      QUERY_ITERATIONS,
    );
    results.queries["search('function')"] = durationMs;
    console.log(`  search('function')        ${formatMs(durationMs).padStart(10)}  (${result.total} results)`);
  }

  // search() with project filter
  if (testProjectSlug) {
    const { durationMs, result } = await benchAvg(
      () => queryService.search({ text: 'error', projectSlug: testProjectSlug }),
      QUERY_ITERATIONS,
    );
    results.queries["search('error', filtered)"] = durationMs;
    console.log(`  search('error', filtered) ${formatMs(durationMs).padStart(10)}  (${result.total} results)`);
  }

  // getStats()
  {
    const { durationMs } = await benchAvg(() => queryService.getStats(), QUERY_ITERATIONS);
    results.queries['getStats()'] = durationMs;
    console.log(`  getStats()                ${formatMs(durationMs).padStart(10)}`);
  }

  console.log('');

  queryService.shutdown();

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

function printSummary(r: BenchmarkResults): void {
  console.log('── 4. Summary ────────────────────────────────────────────────');
  console.log('');

  const rows: Array<[string, string, string]> = [
    ['Cold start', formatMs(r.coldStartMs), '1500-3000ms'],
    ['Warm start', formatMs(r.warmStartMs), '50-200ms'],
  ];

  for (const [name, ms] of Object.entries(r.queries)) {
    rows.push([name, formatMs(ms), '<10ms']);
  }

  // Table
  const col1 = 30;
  const col2 = 12;
  const col3 = 12;

  const topBorder    = `\u2554${''.padEnd(col1, '\u2550')}\u2564${''.padEnd(col2, '\u2550')}\u2564${''.padEnd(col3, '\u2550')}\u2557`;
  const headerSep    = `\u2560${''.padEnd(col1, '\u2550')}\u256A${''.padEnd(col2, '\u2550')}\u256A${''.padEnd(col3, '\u2550')}\u2563`;
  const bottomBorder = `\u255A${''.padEnd(col1, '\u2550')}\u2567${''.padEnd(col2, '\u2550')}\u2567${''.padEnd(col3, '\u2550')}\u255D`;

  console.log(topBorder);
  console.log(`\u2551${' Metric'.padEnd(col1)}\u2502${'  Actual'.padEnd(col2)}\u2502${'  Target'.padEnd(col3)}\u2551`);
  console.log(headerSep);

  for (const [metric, actual, target] of rows) {
    console.log(`\u2551 ${metric.padEnd(col1 - 1)}\u2502 ${actual.padEnd(col2 - 1)}\u2502 ${target.padEnd(col3 - 1)}\u2551`);
  }

  console.log(bottomBorder);

  console.log('');
  console.log('  Data indexed:');
  console.log(`    Projects:  ${r.projectCount}`);
  console.log(`    Sessions:  ${r.sessionCount}`);
  console.log(`    Messages:  ${r.messageCount}`);
  console.log(`    DB size:   ${formatBytes(r.dbSizeBytes)}`);
  console.log(`    Peak heap: ${r.peakHeapMB}`);
  console.log('');

  // Pass/fail verdict
  const coldOk = r.coldStartMs <= 3000;
  const warmOk = r.warmStartMs <= 200;
  const queriesOk = Object.values(r.queries).every((ms) => ms < 10);

  console.log('  Verdict:');
  console.log(`    Cold start: ${coldOk ? 'PASS' : 'FAIL'} (${formatMs(r.coldStartMs)} vs target 1500-3000ms)`);
  console.log(`    Warm start: ${warmOk ? 'PASS' : 'FAIL'} (${formatMs(r.warmStartMs)} vs target 50-200ms)`);
  console.log(`    Queries:    ${queriesOk ? 'PASS' : 'FAIL'} (all under 10ms: ${queriesOk ? 'yes' : 'no'})`);
  console.log('');

  if (coldOk && warmOk && queriesOk) {
    console.log('  ALL TARGETS MET');
  } else {
    console.log('  SOME TARGETS MISSED — review results above');
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  try {
    const results = await runBenchmarks();
    printSummary(results);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

main();
