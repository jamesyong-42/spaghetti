/**
 * idle-maintenance.test.ts — RFC 005 C5.1.
 *
 * Covers the four guarantees promised in the design doc:
 *
 *   1. Maintenance SQL fires after `idleMs` has elapsed since the
 *      last `noteActivity()` call.
 *   2. `noteActivity()` resets the idle deadline — the next tick
 *      does nothing until `idleMs` passes again.
 *   3. `stop()` cancels future ticks; no maintenance runs after.
 *   4. Missing WAL sidecar (`-wal` file absent) does not throw.
 *
 * Uses a real SQLite DB under a temp dir so `wal_checkpoint` has
 * something to act against; the `-wal` existence assertion relies on
 * `journal_mode=WAL` which `SqliteServiceImpl.open()` sets by default.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';

import { createSqliteService } from '../../io/sqlite-service.js';
import { createIdleMaintenance } from '../idle-maintenance.js';

// Tight cadence so tests don't wait seconds — the production
// defaults (60s idle / 30s check) are out of band for unit tests.
const IDLE_MS = 80;
const CHECK_MS = 25;
const TEST_TIMEOUT = 5_000;

/**
 * Minimal "counting" wrapper around a real SqliteService. Observes
 * `exec` + `run` to prove maintenance statements fire. We don't
 * subclass — wrapping is simpler and keeps the real DB semantics
 * (journal_mode, FTS) intact for the WAL assertions.
 */
function wrapSqlite(dbPath: string): {
  service: ReturnType<typeof createSqliteService>;
  counts: { exec: string[]; run: string[] };
  close: () => void;
} {
  const service = createSqliteService();
  service.open({ path: dbPath });
  // Seed a minimal FTS5 table so `merge` has a target. This mirrors
  // the schema's `messages_fts` virtual table shape — we don't
  // import `initializeSchema` here to keep the test narrow.
  service.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content)`);

  const counts = { exec: [] as string[], run: [] as string[] };

  // Patch exec + run to record invocations. Prepared-statement paths
  // aren't used by idle-maintenance.ts, so we only instrument these.
  const originalExec = service.exec.bind(service);
  const originalRun = service.run.bind(service);
  service.exec = (sql: string) => {
    counts.exec.push(sql);
    originalExec(sql);
  };
  service.run = (sql: string, ...params: unknown[]) => {
    counts.run.push(sql);
    return originalRun(sql, ...params);
  };

  return {
    service,
    counts,
    close: () => {
      if (service.isOpen()) service.close();
    },
  };
}

describe('IdleMaintenance (RFC 005 C5.1)', () => {
  test('fires wal_checkpoint + fts merge + optimize after idle window', { timeout: TEST_TIMEOUT }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'idle-maint-fires-'));
    const dbPath = path.join(tmp, 'db.sqlite');
    const { service, counts, close } = wrapSqlite(dbPath);
    try {
      // Provoke WAL usage by writing something so the -wal sidecar
      // materialises. Without it, `wal_checkpoint` is a no-op but
      // still runs; we want to assert the *call* happens, not the
      // size, so we force a threshold of 0.
      service.exec('CREATE TABLE t (x INTEGER)');
      service.exec('INSERT INTO t VALUES (1)');

      const im = createIdleMaintenance(
        { sqlite: service, dbPath },
        {
          idleMs: IDLE_MS,
          checkIntervalMs: CHECK_MS,
          walCheckpointThresholdBytes: 0, // force checkpoint to fire regardless
          ftsMergeChunk: 10,
        },
      );
      im.start();

      // Wait idleMs + a couple of check cadences to let the tick land.
      await new Promise((r) => setTimeout(r, IDLE_MS + CHECK_MS * 3));

      im.stop();

      // Assert the three maintenance statements fired at least once.
      const checkpointFired = counts.exec.some((s) => /wal_checkpoint/.test(s));
      const mergeFired = counts.run.some((s) => /INSERT INTO messages_fts/.test(s));
      const optimizeFired = counts.exec.some((s) => /PRAGMA optimize/.test(s));

      assert.equal(checkpointFired, true, 'wal_checkpoint should have fired');
      assert.equal(mergeFired, true, 'fts merge should have fired');
      assert.equal(optimizeFired, true, 'PRAGMA optimize should have fired');
    } finally {
      close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('noteActivity() resets the idle timer', { timeout: TEST_TIMEOUT }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'idle-maint-reset-'));
    const dbPath = path.join(tmp, 'db.sqlite');
    const { service, counts, close } = wrapSqlite(dbPath);
    try {
      service.exec('CREATE TABLE t (x INTEGER)');

      const im = createIdleMaintenance(
        { sqlite: service, dbPath },
        {
          idleMs: IDLE_MS,
          checkIntervalMs: CHECK_MS,
          walCheckpointThresholdBytes: 0,
          ftsMergeChunk: 10,
        },
      );
      im.start();

      // Busy-loop: call noteActivity() ~every 20ms for a span longer
      // than idleMs. No maintenance should fire during that span.
      const end = Date.now() + IDLE_MS * 2;
      while (Date.now() < end) {
        im.noteActivity();
        await new Promise((r) => setTimeout(r, 20));
      }

      const midMerges = counts.run.filter((s) => /INSERT INTO messages_fts/.test(s)).length;
      assert.equal(
        midMerges,
        0,
        `noteActivity() should hold off maintenance: merge ran ${midMerges}x during busy span`,
      );

      // Now stop touching activity; a tick should fire within idleMs + check cadence.
      await new Promise((r) => setTimeout(r, IDLE_MS + CHECK_MS * 3));

      const lateMerges = counts.run.filter((s) => /INSERT INTO messages_fts/.test(s)).length;
      assert.ok(lateMerges >= 1, `merge should fire once activity stops: ran ${lateMerges}x`);

      im.stop();
    } finally {
      close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stop() cancels future ticks', { timeout: TEST_TIMEOUT }, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'idle-maint-stop-'));
    const dbPath = path.join(tmp, 'db.sqlite');
    const { service, counts, close } = wrapSqlite(dbPath);
    try {
      service.exec('CREATE TABLE t (x INTEGER)');

      const im = createIdleMaintenance(
        { sqlite: service, dbPath },
        {
          idleMs: IDLE_MS,
          checkIntervalMs: CHECK_MS,
          walCheckpointThresholdBytes: 0,
          ftsMergeChunk: 10,
        },
      );
      im.start();
      im.stop();

      // Wait more than enough for a tick to have fired if stop hadn't.
      await new Promise((r) => setTimeout(r, IDLE_MS + CHECK_MS * 4));

      const merges = counts.run.filter((s) => /INSERT INTO messages_fts/.test(s)).length;
      assert.equal(merges, 0, `stop() should halt maintenance: saw ${merges} merge call(s)`);

      // noteActivity() after stop is a no-op (no throw).
      assert.doesNotThrow(() => im.noteActivity());
    } finally {
      close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing -wal sidecar does not throw', { timeout: TEST_TIMEOUT }, async () => {
    // Point the maintenance at a DB path whose WAL sidecar will not
    // exist. We don't even open the DB at that path; the FTS merge +
    // optimize against the real service still runs successfully, but
    // the checkpoint gate's stat of a missing -wal file must be
    // handled gracefully.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'idle-maint-nowal-'));
    const realDbPath = path.join(tmp, 'real.sqlite');
    const missingDbPath = path.join(tmp, 'missing.sqlite');

    const { service, counts, close } = wrapSqlite(realDbPath);
    try {
      // Sanity: the missing -wal path really is absent.
      assert.equal(existsSync(`${missingDbPath}-wal`), false);

      const errors: Error[] = [];
      const im = createIdleMaintenance(
        { sqlite: service, dbPath: missingDbPath },
        {
          idleMs: IDLE_MS,
          checkIntervalMs: CHECK_MS,
          walCheckpointThresholdBytes: 100, // threshold > 0 so checkpoint skips when size=0
          ftsMergeChunk: 10,
          onError: (e) => errors.push(e),
        },
      );
      im.start();

      await new Promise((r) => setTimeout(r, IDLE_MS + CHECK_MS * 3));

      im.stop();

      assert.equal(
        errors.length,
        0,
        `idle maintenance should swallow missing WAL: ${errors.map((e) => e.message).join(' | ')}`,
      );

      // FTS merge + optimize should still fire (they don't depend on WAL).
      const mergeFired = counts.run.some((s) => /INSERT INTO messages_fts/.test(s));
      assert.equal(mergeFired, true, 'merge should fire even when -wal is absent');

      // Checkpoint should NOT fire (gated by threshold + missing sidecar = 0 size).
      const checkpointFired = counts.exec.some((s) => /wal_checkpoint/.test(s));
      assert.equal(checkpointFired, false, 'checkpoint should skip when WAL sidecar absent');
    } finally {
      close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
