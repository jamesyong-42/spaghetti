#!/usr/bin/env -S tsx
/**
 * bench-ingest.ts — wall-clock benchmark for the Rust and TS ingest paths.
 *
 * Runs each path multiple times against a given fixture (default: the
 * committed small fixture), reports min / median / max / mean, and prints
 * a side-by-side comparison.
 *
 * Usage:
 *   pnpm bench:ingest                           # small fixture, both paths, 3 runs
 *   pnpm bench:ingest --fixture ~/.claude       # your real claude dir
 *   pnpm bench:ingest --runs 10 --parallelism 4 # specific parallelism
 *   pnpm bench:ingest --only rust               # skip the TS path
 *   pnpm bench:ingest --warmup 0                # skip warmup (default is 1)
 *
 * Exit codes:
 *   0 — bench completed.
 *   1 — a run failed.
 *   2 — bad args / fixture missing.
 */

import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { createSpaghettiService } from '../packages/sdk/dist/index.js';

const require = createRequire(import.meta.url);

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    runs: { type: 'string' },
    warmup: { type: 'string' },
    parallelism: { type: 'string' },
    only: { type: 'string' }, // 'rust' | 'ts'
  },
});

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultFixture = path.join(repoRoot, 'crates/spaghetti-napi/fixtures/small/.claude');
const fixtureClaudeDir = path.resolve(expandTilde(values.fixture ?? defaultFixture));

const runs = parseIntOrDie(values.runs ?? '3', 'runs');
const warmup = parseIntOrDie(values.warmup ?? '1', 'warmup');
const parallelism = values.parallelism ? parseIntOrDie(values.parallelism, 'parallelism') : undefined;
const only = values.only as 'rust' | 'ts' | undefined;

if (only && only !== 'rust' && only !== 'ts') {
  console.error(`--only must be 'rust' or 'ts', got: ${only}`);
  process.exit(2);
}

if (!existsSync(fixtureClaudeDir)) {
  console.error(`fixture not found: ${fixtureClaudeDir}`);
  process.exit(2);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '', p.slice(2));
  return p;
}

function parseIntOrDie(s: string, name: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative integer, got: ${s}`);
    process.exit(2);
  }
  return n;
}

function cleanDb(p: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(p + suffix)) rmSync(p + suffix, { force: true });
  }
}

function summarize(label: string, msSamples: number[]): Summary {
  const sorted = [...msSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = msSamples.reduce((a, b) => a + b, 0) / msSamples.length;
  return { label, samples: msSamples, min, median, mean, max };
}

interface Summary {
  label: string;
  samples: number[];
  min: number;
  median: number;
  mean: number;
  max: number;
}

function formatMs(n: number): string {
  if (n < 10) return `${n.toFixed(2)}ms`;
  if (n < 1_000) return `${n.toFixed(1)}ms`;
  return `${(n / 1_000).toFixed(2)}s`;
}

function printSummary(s: Summary): void {
  console.log(`  ${s.label.padEnd(6)}  min ${formatMs(s.min).padStart(8)}   med ${formatMs(s.median).padStart(8)}   mean ${formatMs(s.mean).padStart(8)}   max ${formatMs(s.max).padStart(8)}`);
  const samples = s.samples.map(formatMs).join('  ');
  console.log(`          samples: ${samples}`);
}

// ─── Runners ────────────────────────────────────────────────────────────────

interface NativeAddon {
  ingest(opts: {
    claudeDir: string;
    dbPath: string;
    mode: 'cold' | 'warm';
    parallelism?: number;
  }): Promise<{ durationMs: number }>;
  nativeVersion(): string;
}

async function runRustOnce(dbPath: string): Promise<number> {
  cleanDb(dbPath);
  const native = require('@vibecook/spaghetti-sdk-native') as NativeAddon;
  const t0 = performance.now();
  await native.ingest({
    claudeDir: fixtureClaudeDir,
    dbPath,
    mode: 'cold',
    parallelism,
  });
  return performance.now() - t0;
}

async function runTsOnce(dbPath: string): Promise<number> {
  cleanDb(dbPath);
  const svc = createSpaghettiService({ claudeDir: fixtureClaudeDir, dbPath });
  const t0 = performance.now();
  await svc.initialize();
  svc.shutdown();
  return performance.now() - t0;
}

async function runBench(
  label: string,
  fn: (dbPath: string) => Promise<number>,
): Promise<Summary> {
  const dbPath = path.join(tmpdir(), `bench-ingest-${label.toLowerCase()}.db`);
  for (let i = 0; i < warmup; i++) {
    await fn(dbPath);
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    samples.push(await fn(dbPath));
  }
  cleanDb(dbPath);
  return summarize(label, samples);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const native = require('@vibecook/spaghetti-sdk-native') as NativeAddon;

  console.log(`fixture:       ${fixtureClaudeDir}`);
  console.log(`runs:          ${runs} (+ ${warmup} warmup)`);
  if (parallelism !== undefined) console.log(`parallelism:   ${parallelism}`);
  console.log(`native:        ${native.nativeVersion()}`);
  console.log('');

  const results: Summary[] = [];

  if (only !== 'ts') {
    process.stdout.write('Rust ingest... ');
    results.push(await runBench('rust', runRustOnce));
    console.log('done');
  }

  if (only !== 'rust') {
    process.stdout.write('TS ingest...   ');
    results.push(await runBench('ts', runTsOnce));
    console.log('done');
  }

  console.log('');
  for (const r of results) printSummary(r);

  // Speedup summary when both ran.
  const rust = results.find((r) => r.label === 'rust');
  const ts = results.find((r) => r.label === 'ts');
  if (rust && ts) {
    console.log('');
    const speedup = ts.median / rust.median;
    console.log(`speedup (median): ${speedup.toFixed(2)}×   (TS ${formatMs(ts.median)} → Rust ${formatMs(rust.median)})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
