/**
 * coalescing-queue.test.ts — unit tests for `createCoalescingQueue`.
 *
 * Uses real timers with short windows (10–100 ms). Fake timers would
 * only complicate the interleaving with `await` points; real timers
 * keep the tests fast AND deterministic on CI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCoalescingQueue, type QueuedEvent } from '../coalescing-queue.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('coalescing-queue', () => {
  test('enqueue then drain returns all events', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });
    q.enqueue({ path: 'b', reason: 'append' });
    q.enqueue({ path: 'c', reason: 'rewrite' });

    const drained = await q.drain(100, 20);

    assert.equal(drained.length, 3);
    assert.deepEqual(
      drained.map((e) => e.path),
      ['a', 'b', 'c'],
    );
    assert.equal(q.size(), 0);
    q.stop();
  });

  test('dedup: same path enqueued twice collapses to one entry', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });
    q.enqueue({ path: 'a', reason: 'append' });

    assert.equal(q.size(), 1);

    const drained = await q.drain(10, 20);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.path, 'a');
    assert.equal(drained[0]?.reason, 'append');
    q.stop();
  });

  test('reason escalates: append + rewrite -> reason=rewrite with later enqueuedAt', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });
    // Make sure `Date.now()` moves measurably between the two enqueues.
    await sleep(5);
    const beforeSecondEnqueue = Date.now();
    q.enqueue({ path: 'a', reason: 'rewrite' });

    const drained = await q.drain(10, 15);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.reason, 'rewrite');
    assert.ok(
      (drained[0]?.enqueuedAt ?? 0) >= beforeSecondEnqueue,
      `expected enqueuedAt (${drained[0]?.enqueuedAt}) >= ${beforeSecondEnqueue}`,
    );
    q.stop();
  });

  test('reason does NOT de-escalate: rewrite + append keeps rewrite', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'rewrite' });
    q.enqueue({ path: 'a', reason: 'append' });

    const drained = await q.drain(10, 15);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.reason, 'rewrite');
    q.stop();
  });

  test('delete beats rewrite beats append (priority collapse)', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });
    q.enqueue({ path: 'a', reason: 'rewrite' });
    q.enqueue({ path: 'a', reason: 'delete' });
    // Subsequent lower-priority noise must not push the reason back.
    q.enqueue({ path: 'a', reason: 'append' });
    q.enqueue({ path: 'a', reason: 'rewrite' });

    const drained = await q.drain(10, 15);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.reason, 'delete');
    q.stop();
  });

  test('maxRows: drain(2, ...) with 3 enqueued returns 2 and leaves 1', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });
    q.enqueue({ path: 'b', reason: 'append' });
    q.enqueue({ path: 'c', reason: 'append' });

    const drained = await q.drain(2, 1000);
    assert.equal(drained.length, 2);
    assert.deepEqual(
      drained.map((e) => e.path),
      ['a', 'b'],
    );
    assert.equal(q.size(), 1);

    // The remaining entry is still the original `c`.
    const rest = await q.drain(10, 10);
    assert.equal(rest.length, 1);
    assert.equal(rest[0]?.path, 'c');
    q.stop();
  });

  test('window timing: drain(100, 50) with 1 enqueue resolves in ~50 ms', async () => {
    const q = createCoalescingQueue();
    q.enqueue({ path: 'a', reason: 'append' });

    const started = Date.now();
    const drained = await q.drain(100, 50);
    const elapsed = Date.now() - started;

    assert.equal(drained.length, 1);
    // Allow generous slack on either side — we just need to confirm
    // the window actually gated the return rather than it firing
    // immediately or hanging indefinitely.
    assert.ok(elapsed >= 40, `elapsed ${elapsed}ms should be ≥ ~40ms`);
    assert.ok(elapsed < 500, `elapsed ${elapsed}ms should be well under 500ms`);
    q.stop();
  });

  test('stop() wakes a pending drain early with whatever is queued', async () => {
    const q = createCoalescingQueue();

    // Nothing queued: drain would block indefinitely on the signal.
    const started = Date.now();
    const pending = q.drain(100, 10_000);

    // Fire stop() after a short delay.
    setTimeout(() => q.stop(), 20);

    const drained: QueuedEvent[] = await pending;
    const elapsed = Date.now() - started;

    assert.deepEqual(drained, []);
    assert.ok(elapsed < 500, `stop should wake drain quickly, elapsed=${elapsed}ms`);
    assert.equal(q.running(), false);

    // Subsequent drain returns [] immediately too.
    const again = await q.drain(10, 10_000);
    assert.deepEqual(again, []);

    // Enqueue after stop is a no-op.
    q.enqueue({ path: 'x', reason: 'append' });
    assert.equal(q.size(), 0);
  });

  test('saturated(): oldest older than threshold flips true; empty/fresh stays false', async () => {
    const q = createCoalescingQueue({ saturationThresholdMs: 5 });
    assert.equal(q.saturated(), false);

    q.enqueue({ path: 'a', reason: 'append' });
    // Immediately after enqueue, threshold has not been crossed yet.
    assert.equal(q.saturated(), false);

    await sleep(15);
    assert.equal(q.saturated(), true);

    // Drain the stale entry, queue is empty again → not saturated.
    await q.drain(10, 1);
    assert.equal(q.size(), 0);
    assert.equal(q.saturated(), false);

    // Fresh enqueue resets the clock — not saturated immediately.
    q.enqueue({ path: 'b', reason: 'append' });
    assert.equal(q.saturated(), false);
    q.stop();
  });

  test('running() toggles off after stop()', async () => {
    const q = createCoalescingQueue();
    assert.equal(q.running(), true);
    q.stop();
    assert.equal(q.running(), false);
    // stop() is idempotent.
    q.stop();
    assert.equal(q.running(), false);
  });
});
