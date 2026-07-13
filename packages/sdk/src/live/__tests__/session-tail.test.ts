/**
 * session-tail.test.ts — watchSessionTranscript (scoped single-session tail).
 *
 * Real files in a tmp directory, no mocking (same approach as
 * incremental-parser.test.ts). Tests drive the tail exclusively through
 * poll() — the low-latency path a hook-signal consumer uses — with the
 * fallback interval parked at 60s so it never interferes.
 *
 * Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

import { watchSessionTranscript } from '../session-tail.js';
import type { SessionTranscriptEvent, SessionTranscriptTail } from '../session-tail.js';

const SESSION_ID = '3fef0014-58b0-4938-905e-ad50b553cb76';

let tails: SessionTranscriptTail[] = [];
afterEach(() => {
  for (const tail of tails) tail.stop();
  tails = [];
});

function makeDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'session-tail-'));
}

function startTail(transcriptPath: string): { tail: SessionTranscriptTail; events: SessionTranscriptEvent[] } {
  const events: SessionTranscriptEvent[] = [];
  const tail = watchSessionTranscript(transcriptPath, { pollIntervalMs: 60_000 });
  tail.onMessage((e) => events.push(e));
  tails.push(tail);
  return { tail, events };
}

const line = (record: object) => `${JSON.stringify(record)}\n`;

describe('watchSessionTranscript', () => {
  test('streams appended messages with monotonic msgIndex and byte offsets', async () => {
    const dir = makeDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, line({ role: 'user', content: 'hi' }));

    const { tail, events } = startTail(file);
    await tail.poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].msgIndex, 0);
    assert.equal(events[0].byteOffset, 0);
    assert.equal(events[0].rewrite, true); // cold start counts as a rewrite in checkpoint terms

    appendFileSync(file, line({ role: 'assistant', content: 'yo' }));
    await tail.poll();
    assert.equal(events.length, 2);
    assert.equal(events[1].msgIndex, 1);
    assert.ok(events[1].byteOffset > 0);
    assert.equal(events[1].rewrite, false);
  });

  test('holds partial lines until the newline arrives', async () => {
    const dir = makeDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, line({ role: 'user', content: 'one' }));

    const { tail, events } = startTail(file);
    await tail.poll();
    assert.equal(events.length, 1);

    const half = JSON.stringify({ role: 'assistant', content: 'two' });
    appendFileSync(file, half.slice(0, 12));
    await tail.poll();
    assert.equal(events.length, 1); // incomplete tail line not emitted

    appendFileSync(file, `${half.slice(12)}\n`);
    await tail.poll();
    assert.equal(events.length, 2);
  });

  test('detects rewrites and restarts message indexes', async () => {
    const dir = makeDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, line({ role: 'user', content: 'aaaa' }) + line({ role: 'assistant', content: 'bbbb' }));

    const { tail, events } = startTail(file);
    await tail.poll();
    assert.equal(events.length, 2);

    writeFileSync(file, line({ role: 'user', content: 'x' })); // smaller: truncation/replace
    await tail.poll();
    assert.equal(events.length, 3);
    assert.equal(events[2].rewrite, true);
    assert.equal(events[2].msgIndex, 0);
  });

  test('waits quietly for a transcript that does not exist yet', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'later', `${SESSION_ID}.jsonl`);

    const { tail, events } = startTail(file);
    await tail.poll();
    assert.equal(events.length, 0);

    mkdirSync(path.join(dir, 'later'), { recursive: true });
    writeFileSync(file, line({ role: 'user', content: 'finally' }));
    await tail.poll();
    assert.equal(events.length, 1);
  });

  test('stop() ends delivery', async () => {
    const dir = makeDir();
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, line({ role: 'user', content: 'hi' }));

    const { tail, events } = startTail(file);
    await tail.poll();
    tail.stop();
    appendFileSync(file, line({ role: 'assistant', content: 'late' }));
    await tail.poll();
    assert.equal(events.length, 1);
  });
});
