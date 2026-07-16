/**
 * WorkerPool — crash-recovery unit tests.
 *
 * Regression coverage for the 2026-07 review fixes:
 *   - a crashed worker's replacement gets FRESH handlers (the old
 *     implementation cloned the dead worker's listeners, whose closures
 *     kept assigning work to the dead worker → permanent hang);
 *   - an in-flight slug lost to a crash is retried once, then counted;
 *   - the pool rejects instead of hanging when every worker dies.
 *
 * Uses a stub worker script (plain .mjs, no build step) that speaks the
 * MainToWorkerMessage / WorkerToMainMessage protocol.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createWorkerPool } from '../worker-pool.js';
import type { WorkerToMainMessage } from '../worker-types.js';

/**
 * Stub worker: completes every slug except ones starting with "crash",
 * which kill the thread via process.exit(1). "crash-once-*" slugs crash
 * only the first worker that sees them (signalled via an env-independent
 * marker file) so the retry path can be observed succeeding.
 */
const STUB_WORKER = `
import { parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';

parentPort.on('message', (msg) => {
  if (msg.type === 'shutdown') process.exit(0);
  if (msg.type !== 'parse-project') return;
  const slug = msg.slug;
  if (slug.startsWith('crash-once')) {
    const marker = msg.rootDir + '/' + slug + '.marker';
    if (!existsSync(marker)) {
      writeFileSync(marker, '1');
      process.exit(1);
    }
  } else if (slug.startsWith('crash')) {
    process.exit(1);
  }
  parentPort.postMessage({ type: 'project-complete', slug, durationMs: 0 });
});
`;

function makeStub(): { dir: string; script: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-pool-'));
  const script = path.join(dir, 'stub-worker.mjs');
  writeFileSync(script, STUB_WORKER);
  return { dir, script, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function completedSlugs(messages: WorkerToMainMessage[]): string[] {
  return messages.filter((m) => m.type === 'project-complete').map((m) => (m as { slug: string }).slug);
}

describe('WorkerPool crash recovery', () => {
  test('happy path: all slugs complete', async () => {
    const { dir, script, cleanup } = makeStub();
    const pool = createWorkerPool({ maxWorkers: 2, workerScript: script });
    try {
      const messages: WorkerToMainMessage[] = [];
      await pool.parseProjects(dir, ['a', 'b', 'c', 'd', 'e'], (msg) => void messages.push(msg));
      assert.deepEqual(completedSlugs(messages).sort(), ['a', 'b', 'c', 'd', 'e']);
    } finally {
      pool.shutdown();
      cleanup();
    }
  });

  test('replacement worker drains the remaining queue after a crash (no hang)', async () => {
    const { dir, script, cleanup } = makeStub();
    // Single worker: the crash-once slug kills it mid-run; the replacement
    // must retry that slug and then keep draining the rest of the queue —
    // under the old cloned-listener bug this test hung forever.
    const pool = createWorkerPool({ maxWorkers: 1, workerScript: script });
    try {
      const messages: WorkerToMainMessage[] = [];
      await pool.parseProjects(dir, ['a', 'crash-once-x', 'b', 'c'], (msg) => void messages.push(msg));
      assert.deepEqual(completedSlugs(messages).sort(), ['a', 'b', 'c', 'crash-once-x']);
    } finally {
      pool.shutdown();
      cleanup();
    }
  });

  test('poison slug is retried once, then counted lost; run still finishes', async () => {
    const { dir, script, cleanup } = makeStub();
    const pool = createWorkerPool({ maxWorkers: 1, workerScript: script });
    try {
      const messages: WorkerToMainMessage[] = [];
      await pool.parseProjects(dir, ['a', 'crash-always', 'b'], (msg) => void messages.push(msg));
      // The poison slug never completes, but everything else must.
      assert.deepEqual(completedSlugs(messages).sort(), ['a', 'b']);
    } finally {
      pool.shutdown();
      cleanup();
    }
  });

  test('rejects (not hangs) when the worker script is unloadable', async () => {
    const { dir, cleanup } = makeStub();
    const pool = createWorkerPool({ maxWorkers: 2, workerScript: path.join(dir, 'missing.mjs') });
    try {
      // A missing script surfaces as worker 'error' events on every spawned
      // worker → all workers dead with work unfinished → loud rejection.
      await assert.rejects(pool.parseProjects(dir, ['a', 'b'], () => {}));
    } finally {
      pool.shutdown();
      cleanup();
    }
  });
});
