/**
 * incremental-parser.test.ts — Unit tests for RFC 005 C2.4.
 *
 * Exercises the JSONL tail path (append / partial / truncate / inode
 * rotation) and the single-file re-read path against real files in a
 * tmp directory. No mocking: we spin up a real `FileService` instance
 * because the parser delegates JSONL reads to its streaming reader.
 *
 * Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createIncrementalParser } from '../incremental-parser.js';
import type { FileService } from '../../io/file-service.js';
import type { IncrementalParser } from '../incremental-parser.js';
import type { Checkpoint } from '../checkpoints.js';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'demo-project';
const SESSION_ID = 'session-xyz';

describe('IncrementalParser (C2.4)', () => {
  let tempDir: string;
  let fileService: FileService;
  let parser: IncrementalParser;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-incparse-'));
    fileService = createFileService();
    parser = createIncrementalParser({ fileService });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Each test gets a fresh path to avoid state leaking across cases.
  let jsonlPath: string;
  let jsonPath: string;
  beforeEach((t) => {
    const safe = t.name.replace(/[^a-zA-Z0-9]/g, '_');
    jsonlPath = path.join(tempDir, `${safe}.jsonl`);
    jsonPath = path.join(tempDir, `${safe}.json`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // JSONL PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('empty fixture → no rows, no error', async () => {
    writeFileSync(jsonlPath, '');
    const result = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 0);
    // Cold start is still "rewrite" semantically — we just have
    // nothing to emit. The checkpoint should pin the empty state.
    assert.equal(result.rewrite, true);
    assert.equal(result.newCheckpoint.lastOffset, 0);
    assert.equal(result.newCheckpoint.size, 0);
  });

  test('first read (no prior checkpoint) emits every line and rewrites', async () => {
    const lines = [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }), JSON.stringify({ a: 3 })];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');
    const fileSize = statSync(jsonlPath).size;

    const result = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 3);
    assert.equal(result.rewrite, true);
    assert.equal(result.newCheckpoint.lastOffset, fileSize);
    assert.equal(result.newCheckpoint.size, fileSize);
    assert.deepEqual(result.rows[0].payload, { a: 1 });
    assert.equal(result.rows[0].category, 'message');
    assert.equal(result.rows[0].slug, SLUG);
    assert.equal(result.rows[0].sessionId, SESSION_ID);
  });

  test('tail append 2 lines → emits only the new ones, rewrite: false', async () => {
    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });
    assert.equal(first.rows.length, 1);

    appendFileSync(jsonlPath, JSON.stringify({ a: 2 }) + '\n');
    appendFileSync(jsonlPath, JSON.stringify({ a: 3 }) + '\n');
    const expectedSize = statSync(jsonlPath).size;

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
    });

    assert.equal(second.rows.length, 2);
    assert.equal(second.rewrite, false);
    assert.deepEqual(second.rows[0].payload, { a: 2 });
    assert.deepEqual(second.rows[1].payload, { a: 3 });
    assert.equal(second.newCheckpoint.lastOffset, expectedSize);
    assert.equal(second.newCheckpoint.inode, first.newCheckpoint.inode);
  });

  test('partial last line is held back until completed', async () => {
    // `{"a":1}\n{"b":` — first line complete, second is torn.
    const firstLine = JSON.stringify({ a: 1 });
    writeFileSync(jsonlPath, `${firstLine}\n{"b":`);
    const lineEnd = Buffer.byteLength(firstLine, 'utf8') + 1; // +1 for `\n`

    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(first.rows.length, 1, 'only the complete line emits');
    assert.deepEqual(first.rows[0].payload, { a: 1 });
    assert.equal(first.newCheckpoint.lastOffset, lineEnd, 'lastOffset sits just after the last complete `\\n`');

    // Now complete the torn line. Next parse should emit it fresh.
    appendFileSync(jsonlPath, '2}\n');

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
    });

    assert.equal(second.rows.length, 1);
    assert.deepEqual(second.rows[0].payload, { b: 2 });
    assert.equal(second.rewrite, false);
    assert.equal(second.newCheckpoint.lastOffset, statSync(jsonlPath).size);
  });

  test('size decrease (truncation) forces a rewrite', async () => {
    const lines = [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }), JSON.stringify({ a: 3 })];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');
    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      checkpoint: undefined,
    });
    assert.equal(first.rows.length, 3);

    // Truncate to just the first line.
    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const truncatedSize = statSync(jsonlPath).size;

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      checkpoint: first.newCheckpoint,
    });

    assert.equal(second.rewrite, true, 'shrunk file triggers rewrite');
    assert.equal(second.rows.length, 1);
    assert.deepEqual(second.rows[0].payload, { a: 1 });
    assert.equal(second.newCheckpoint.lastOffset, truncatedSize);
  });

  test('inode change (delete + recreate) forces a rewrite', async () => {
    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const statBefore = statSync(jsonlPath);

    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      checkpoint: undefined,
    });
    assert.equal(first.newCheckpoint.inode, statBefore.ino);

    // Replace the file with a fresh inode.
    unlinkSync(jsonlPath);
    writeFileSync(jsonlPath, JSON.stringify({ b: 2 }) + '\n');
    const statAfter = statSync(jsonlPath);
    assert.notEqual(statBefore.ino, statAfter.ino, 'precondition: recreated file must have a different inode');

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      checkpoint: first.newCheckpoint,
    });

    assert.equal(second.rewrite, true);
    assert.equal(second.rows.length, 1);
    assert.deepEqual(second.rows[0].payload, { b: 2 });
    assert.equal(second.newCheckpoint.inode, statAfter.ino);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE-FILE PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('single-file JSON (todo) → one row, payload matches parsed JSON', async () => {
    // Shape modeled on todos/<sid>-agent-*.json — the exact schema
    // doesn't matter here; the parser is a pass-through.
    const todoFile = {
      version: 1,
      items: [
        { id: 't1', content: 'write tests', status: 'completed' },
        { id: 't2', content: 'ship it', status: 'in_progress' },
      ],
    };
    writeFileSync(jsonPath, JSON.stringify(todoFile));
    const size = statSync(jsonPath).size;

    const result = await parser.parseFileDelta({
      path: jsonPath,
      category: 'todo',
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rewrite, true);
    assert.equal(result.rows[0].category, 'todo');
    assert.deepEqual(result.rows[0].payload, todoFile);
    assert.equal(result.newCheckpoint.size, size);
    assert.equal(result.newCheckpoint.lastOffset, size);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MISSING FILE
  // ─────────────────────────────────────────────────────────────────────────

  test('missing file → empty rows, rewrite: false, no throw', async () => {
    const missing = path.join(tempDir, 'does-not-exist.jsonl');
    const previous: Checkpoint = {
      path: missing,
      inode: 42,
      size: 100,
      lastOffset: 100,
      lastMtimeMs: 1,
    };

    const result = await parser.parseFileDelta({
      path: missing,
      category: 'message',
      checkpoint: previous,
    });

    assert.equal(result.rows.length, 0);
    assert.equal(result.rewrite, false);
    assert.deepEqual(result.newCheckpoint, previous, 'preserves prior checkpoint on transient miss');
  });
});
