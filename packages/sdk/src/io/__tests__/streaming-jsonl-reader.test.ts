/**
 * Streaming JSONL reader — unit tests.
 *
 * Focus: the live-tail resume contract added in the 2026-07 review fixes.
 *   - `lastTerminatedPosition` stops at the last newline-terminated line
 *     so tailers never advance past a partially-written row.
 *   - `terminatedLineCount` counts non-empty terminated lines (parsed or
 *     not) so absolute msg-index accounting stays consistent.
 *   - the `terminated` callback flag distinguishes the unterminated tail.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

import { readJsonlStreaming } from '../streaming-jsonl-reader.js';

function makeTempFile(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-jsonl-'));
  const file = path.join(dir, 'events.jsonl');
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('readJsonlStreaming — terminated-line resume contract', () => {
  test('fully terminated file: lastTerminatedPosition === finalBytePosition', () => {
    const { file, cleanup } = makeTempFile('{"a":1}\n{"a":2}\n');
    try {
      const seen: boolean[] = [];
      const res = readJsonlStreaming<{ a: number }>(file, (_e, _i, _o, _end, terminated) => {
        seen.push(terminated);
      });
      assert.deepEqual(seen, [true, true]);
      assert.equal(res.lastTerminatedPosition, res.finalBytePosition);
      assert.equal(res.terminatedLineCount, 2);
    } finally {
      cleanup();
    }
  });

  test('unterminated tail: flag false, lastTerminatedPosition stops before it', () => {
    const terminatedPart = '{"a":1}\n';
    const { file, cleanup } = makeTempFile(`${terminatedPart}{"a":2`);
    try {
      const flags: boolean[] = [];
      const res = readJsonlStreaming<unknown>(file, (_e, _i, _o, _end, terminated) => {
        flags.push(terminated);
      });
      // The partial tail `{"a":2` is invalid JSON → no callback for it.
      assert.deepEqual(flags, [true]);
      assert.equal(res.lastTerminatedPosition, Buffer.byteLength(terminatedPart));
      assert.equal(res.terminatedLineCount, 1);
      assert.ok(res.finalBytePosition > res.lastTerminatedPosition);
    } finally {
      cleanup();
    }
  });

  test('partial tail that is valid JSON still reports terminated=false', () => {
    // `{"a":2}` without newline parses fine but may still grow (e.g. into
    // `{"a":22}`) — the flag lets tailers decline to consume it.
    const head = '{"a":1}\n';
    const { file, cleanup } = makeTempFile(`${head}{"a":2}`);
    try {
      const flags: boolean[] = [];
      const res = readJsonlStreaming<unknown>(file, (_e, _i, _o, _end, terminated) => {
        flags.push(terminated);
      });
      assert.deepEqual(flags, [true, false]);
      assert.equal(res.lastTerminatedPosition, Buffer.byteLength(head));
      assert.equal(res.terminatedLineCount, 1);
    } finally {
      cleanup();
    }
  });

  test('resume from lastTerminatedPosition picks up the completed row exactly once', () => {
    const head = '{"a":1}\n';
    const { file, cleanup } = makeTempFile(`${head}{"a":2`);
    try {
      const first = readJsonlStreaming<unknown>(file, () => {});
      // Writer completes the row.
      appendFileSync(file, '2}\n');
      const rows: Array<{ a: number }> = [];
      const second = readJsonlStreaming<{ a: number }>(
        file,
        (entry, _i, _o, _end, terminated) => {
          if (terminated) rows.push(entry);
        },
        { fromBytePosition: first.lastTerminatedPosition },
      );
      assert.deepEqual(rows, [{ a: 22 }]);
      assert.equal(second.lastTerminatedPosition, second.finalBytePosition);
    } finally {
      cleanup();
    }
  });

  test('malformed terminated line advances lastTerminatedPosition (no re-read loop)', () => {
    const content = '{"a":1}\nnot json\n{"a":3}\n';
    const { file, cleanup } = makeTempFile(content);
    try {
      const parsed: number[] = [];
      const res = readJsonlStreaming<{ a: number }>(file, (e) => parsed.push(e.a));
      assert.deepEqual(parsed, [1, 3]);
      assert.equal(res.errorCount, 1);
      // Malformed-but-terminated lines are consumed: parsed or not, the
      // range is done and tailers must not get stuck re-reading it.
      assert.equal(res.lastTerminatedPosition, Buffer.byteLength(content));
      assert.equal(res.terminatedLineCount, 3);
    } finally {
      cleanup();
    }
  });

  test('empty read past EOF keeps lastTerminatedPosition at the cursor', () => {
    const content = '{"a":1}\n';
    const { file, cleanup } = makeTempFile(content);
    try {
      const pos = Buffer.byteLength(content);
      const res = readJsonlStreaming<unknown>(file, () => {}, { fromBytePosition: pos });
      assert.equal(res.lastTerminatedPosition, pos);
      assert.equal(res.finalBytePosition, pos);
      assert.equal(res.terminatedLineCount, 0);
    } finally {
      cleanup();
    }
  });
});
