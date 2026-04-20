/**
 * incremental-parser.test.ts — Unit tests for RFC 005 C2.4.
 *
 * Exercises the JSONL tail path (append / partial / truncate / inode
 * rotation) and the single-file re-read path against real files in a
 * tmp directory. No mocking: we spin up a real `FileService` instance
 * because the parser delegates JSONL reads to its streaming reader.
 *
 * Asserts the rich per-category `ParsedRow` shape landed in the C2.4
 * resolution pass — each variant's payload matches the writer's
 * corresponding `onX` method (and the downstream `Change` variant)
 * verbatim, so writeBatch dispatch is a pass-through.
 *
 * Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, unlinkSync, mkdirSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createIncrementalParser } from '../incremental-parser.js';
import type { FileService } from '../../io/file-service.js';
import type { IncrementalParser, ParsedRow } from '../incremental-parser.js';
import type { Checkpoint } from '../checkpoints.js';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'demo-project';
const SESSION_ID = 'session-xyz';

// Narrow helpers used throughout. TS's discriminated-union narrowing
// keeps these safe; the `as` is only a local aid for the tests.
function expectRow<C extends ParsedRow['category']>(
  rows: ParsedRow[],
  index: number,
  category: C,
): Extract<ParsedRow, { category: C }> {
  const row = rows[index];
  assert.ok(row, `expected row at index ${index}`);
  assert.equal(row.category, category);
  return row as Extract<ParsedRow, { category: C }>;
}

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
  // JSONL MESSAGE PATH
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
    assert.equal(result.rewrite, true);
    assert.equal(result.newCheckpoint.lastOffset, 0);
    assert.equal(result.newCheckpoint.size, 0);
  });

  test('first read emits each line with msgIndex + byteOffset + slug + sessionId', async () => {
    const payloads = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const lineBytes = payloads.map((p) => Buffer.byteLength(JSON.stringify(p) + '\n', 'utf8'));
    writeFileSync(jsonlPath, payloads.map((p) => JSON.stringify(p)).join('\n') + '\n');
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

    let byteOffset = 0;
    for (let i = 0; i < 3; i++) {
      const row = expectRow(result.rows, i, 'message');
      assert.equal(row.slug, SLUG);
      assert.equal(row.sessionId, SESSION_ID);
      assert.equal(row.msgIndex, i, 'msgIndex is 0-based within rewrite');
      assert.equal(row.byteOffset, byteOffset, 'byteOffset points at start of line');
      assert.deepEqual(row.message, payloads[i]);
      byteOffset += lineBytes[i];
    }
  });

  test('tail append continues msgIndex from startMsgIndex', async () => {
    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });
    assert.equal(first.rows.length, 1);
    const firstMsg = expectRow(first.rows, 0, 'message');
    assert.equal(firstMsg.msgIndex, 0);

    appendFileSync(jsonlPath, JSON.stringify({ a: 2 }) + '\n');
    appendFileSync(jsonlPath, JSON.stringify({ a: 3 }) + '\n');
    const expectedSize = statSync(jsonlPath).size;

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
      startMsgIndex: 1,
    });

    assert.equal(second.rows.length, 2);
    assert.equal(second.rewrite, false);
    const m2 = expectRow(second.rows, 0, 'message');
    const m3 = expectRow(second.rows, 1, 'message');
    assert.deepEqual(m2.message, { a: 2 });
    assert.equal(m2.msgIndex, 1);
    assert.deepEqual(m3.message, { a: 3 });
    assert.equal(m3.msgIndex, 2);
    assert.ok(m2.byteOffset > firstMsg.byteOffset);
    assert.equal(second.newCheckpoint.lastOffset, expectedSize);
  });

  test('partial last line is held back until completed', async () => {
    const firstLine = JSON.stringify({ a: 1 });
    writeFileSync(jsonlPath, `${firstLine}\n{"b":`);
    const lineEnd = Buffer.byteLength(firstLine, 'utf8') + 1;

    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(first.rows.length, 1);
    const row = expectRow(first.rows, 0, 'message');
    assert.deepEqual(row.message, { a: 1 });
    assert.equal(first.newCheckpoint.lastOffset, lineEnd);

    appendFileSync(jsonlPath, '2}\n');

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
      startMsgIndex: 1,
    });

    assert.equal(second.rows.length, 1);
    const r2 = expectRow(second.rows, 0, 'message');
    assert.deepEqual(r2.message, { b: 2 });
    assert.equal(r2.msgIndex, 1);
    assert.equal(second.rewrite, false);
    assert.equal(second.newCheckpoint.lastOffset, statSync(jsonlPath).size);
  });

  test('size decrease (truncation) forces a rewrite', async () => {
    const lines = [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 }), JSON.stringify({ a: 3 })];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');
    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });
    assert.equal(first.rows.length, 3);

    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const truncatedSize = statSync(jsonlPath).size;

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
      startMsgIndex: 3,
    });

    assert.equal(second.rewrite, true, 'shrunk file triggers rewrite');
    assert.equal(second.rows.length, 1);
    const row = expectRow(second.rows, 0, 'message');
    assert.deepEqual(row.message, { a: 1 });
    assert.equal(row.msgIndex, 0, 'rewrite restarts msgIndex at 0');
    assert.equal(second.newCheckpoint.lastOffset, truncatedSize);
  });

  test('truncated rewrite produces only rows for the new file contents (Phase 5 known-issue documented)', async () => {
    // Seed with three lines, then shrink to one. The parse contract
    // guarantees the second call's rows reflect the *current* file
    // contents only — three rows in, one row out. This is independent
    // of any SQLite state on the writer side.
    const lines = [
      JSON.stringify({ a: 1, uuid: 'one' }),
      JSON.stringify({ a: 2, uuid: 'two' }),
      JSON.stringify({ a: 3, uuid: 'three' }),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');
    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });
    assert.equal(first.rows.length, 3);

    // Shrink: keep only the first line.
    writeFileSync(jsonlPath, lines[0] + '\n');

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
      startMsgIndex: 3,
    });

    assert.equal(second.rewrite, true);
    assert.equal(second.rows.length, 1, 'parse output reflects only the current file lines');
    const row = expectRow(second.rows, 0, 'message');
    assert.equal(
      (row.message as unknown as { uuid: string }).uuid,
      'one',
      "the surviving row carries the surviving line's uuid",
    );

    // Phase 5 known-issue: the writer's `(session_id, msg_index)`
    // upsert overwrites msg_index 0 with the fresh content but
    // leaves stale rows at msg_index 1+ in SQLite — there is no
    // "delete rows beyond newLen" sweep on the live path. The cold-
    // start path reissues the whole session via worker output so it
    // doesn't hit this. Documented for future cleanup; not
    // exercised by an assertion here because the parser itself does
    // the right thing — the live writer is what would need a
    // truncation-aware DELETE.
  });

  test('inode change (delete + recreate) forces a rewrite', async () => {
    writeFileSync(jsonlPath, JSON.stringify({ a: 1 }) + '\n');
    const statBefore = statSync(jsonlPath);

    const first = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });
    assert.equal(first.newCheckpoint.inode, statBefore.ino);

    unlinkSync(jsonlPath);
    writeFileSync(jsonlPath, JSON.stringify({ b: 2 }) + '\n');
    const statAfter = statSync(jsonlPath);
    assert.notEqual(statBefore.ino, statAfter.ino);

    const second = await parser.parseFileDelta({
      path: jsonlPath,
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
      startMsgIndex: 1,
    });

    assert.equal(second.rewrite, true);
    assert.equal(second.rows.length, 1);
    const row = expectRow(second.rows, 0, 'message');
    assert.deepEqual(row.message, { b: 2 });
    assert.equal(row.msgIndex, 0);
    assert.equal(second.newCheckpoint.inode, statAfter.ino);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUBAGENT PATH — aggregate whole file into SubagentTranscript
  // ─────────────────────────────────────────────────────────────────────────

  test('subagent: full file parsed into one SubagentTranscript per call', async () => {
    // Filename-driven agentId + agentType: agent-{id}.jsonl
    const filePath = path.join(tempDir, 'agent-a123xyz.jsonl');
    writeFileSync(
      filePath,
      [JSON.stringify({ role: 'user', content: 'hi' }), JSON.stringify({ role: 'assistant', content: 'yo' })].join(
        '\n',
      ) + '\n',
    );

    const first = await parser.parseFileDelta({
      path: filePath,
      category: 'subagent',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(first.rows.length, 1);
    const row = expectRow(first.rows, 0, 'subagent');
    assert.equal(row.slug, SLUG);
    assert.equal(row.sessionId, SESSION_ID);
    assert.equal(row.transcript.agentId, 'a123xyz');
    assert.equal(row.transcript.fileName, 'agent-a123xyz.jsonl');
    assert.equal(row.transcript.agentType, 'task');
    assert.equal(row.transcript.messages.length, 2);

    // Tail: append one line, expect the full transcript (3 messages) re-emitted.
    appendFileSync(filePath, JSON.stringify({ role: 'assistant', content: 'second' }) + '\n');
    const second = await parser.parseFileDelta({
      path: filePath,
      category: 'subagent',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: first.newCheckpoint,
    });
    const row2 = expectRow(second.rows, 0, 'subagent');
    assert.equal(row2.transcript.messages.length, 3, 'tail re-reads the full file for correctness');

    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL_RESULT PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('tool_result: extracts toolUseId from filename, content from body', async () => {
    const toolUseId = 'toolu_01abcdEFGH';
    const filePath = path.join(tempDir, `${toolUseId}.txt`);
    writeFileSync(filePath, 'stdout goes here\n');

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'tool_result',
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    const row = expectRow(result.rows, 0, 'tool_result');
    assert.equal(row.slug, SLUG);
    assert.equal(row.sessionId, SESSION_ID);
    assert.equal(row.result.toolUseId, toolUseId);
    assert.equal(row.result.content, 'stdout goes here\n');

    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FILE_HISTORY PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('file_history: row carries hash + version + fileName + content', async () => {
    const hash = 'abc123def456';
    const version = 7;
    const fileName = `${hash}@v${version}`;
    const filePath = path.join(tempDir, fileName);
    writeFileSync(filePath, 'snapshot contents\n');

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'file_history',
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    const row = expectRow(result.rows, 0, 'file_history');
    assert.equal(row.sessionId, SESSION_ID);
    assert.equal(row.history.sessionId, SESSION_ID);
    assert.equal(row.history.snapshots.length, 1);
    const snap = row.history.snapshots[0];
    assert.equal(snap.hash, hash);
    assert.equal(snap.version, version);
    assert.equal(snap.fileName, fileName);
    assert.equal(snap.content, 'snapshot contents\n');
    assert.equal(snap.size, Buffer.byteLength('snapshot contents\n', 'utf8'));

    rmSync(filePath, { force: true });
  });

  test('file_history: non-matching filename is skipped (no rows)', async () => {
    const filePath = path.join(tempDir, 'random.txt');
    writeFileSync(filePath, 'whatever');

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'file_history',
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 0);
    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TODO PATH — agentId comes from filename
  // ─────────────────────────────────────────────────────────────────────────

  test('todo: row carries agentId extracted from filename', async () => {
    const agentId = 'a-abc-def';
    const filePath = path.join(tempDir, `${SESSION_ID}-agent-${agentId}.json`);
    const items = [
      { content: 'write tests', status: 'completed' as const },
      { content: 'ship it', status: 'in_progress' as const },
    ];
    writeFileSync(filePath, JSON.stringify(items));

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'todo',
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    const row = expectRow(result.rows, 0, 'todo');
    assert.equal(row.sessionId, SESSION_ID);
    assert.equal(row.todo.sessionId, SESSION_ID);
    assert.equal(row.todo.agentId, agentId);
    assert.deepEqual(row.todo.items, items);

    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TASK PATH — whole-dir read on any event
  // ─────────────────────────────────────────────────────────────────────────

  test('task: re-reads tasks/<sid>/.lock + .highwatermark on any event', async () => {
    const claudeDir = path.join(tempDir, 'claude-task');
    const sessionId = 'task-session-1';
    const taskDir = path.join(claudeDir, 'tasks', sessionId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, '.lock'), '');
    writeFileSync(path.join(taskDir, '.highwatermark'), '42');

    // Event path: a numbered item file inside the dir (we don't read
    // it, but the watcher would surface that path).
    const eventPath = path.join(taskDir, '1.json');
    writeFileSync(eventPath, '{}');

    const result = await parser.parseFileDelta({
      path: eventPath,
      category: 'task',
      sessionId,
      claudeDir,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    const row = expectRow(result.rows, 0, 'task');
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.task.taskId, sessionId);
    assert.equal(row.task.lockExists, true);
    assert.equal(row.task.hasHighwatermark, true);
    assert.equal(row.task.highwatermark, 42);

    rmSync(claudeDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PLAN PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('plan: row carries slug, title (from H1), content, size', async () => {
    const planSlug = 'my-plan';
    const filePath = path.join(tempDir, `${planSlug}.md`);
    const content = '# My Grand Plan\n\nBody text.\n';
    writeFileSync(filePath, content);

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'plan',
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    const row = expectRow(result.rows, 0, 'plan');
    assert.equal(row.slug, planSlug);
    assert.equal(row.plan.slug, planSlug);
    assert.equal(row.plan.title, 'My Grand Plan');
    assert.equal(row.plan.content, content);
    assert.equal(row.plan.size, content.length);

    rmSync(filePath, { force: true });
  });

  test('plan: title falls back to slug when no H1 present', async () => {
    const planSlug = 'no-heading';
    const filePath = path.join(tempDir, `${planSlug}.md`);
    writeFileSync(filePath, 'Just body text, no heading.\n');

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'plan',
      checkpoint: undefined,
    });

    const row = expectRow(result.rows, 0, 'plan');
    assert.equal(row.plan.title, planSlug);

    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROJECT_MEMORY PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('project_memory: row carries slug + full content', async () => {
    const filePath = path.join(tempDir, 'MEMORY.md');
    const content = '# Memory\n\nNotes from the project.\n';
    writeFileSync(filePath, content);

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'project_memory',
      slug: SLUG,
      checkpoint: undefined,
    });

    const row = expectRow(result.rows, 0, 'project_memory');
    assert.equal(row.slug, SLUG);
    assert.equal(row.content, content);

    rmSync(filePath, { force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SESSION_INDEX PATH
  // ─────────────────────────────────────────────────────────────────────────

  test('session_index: row carries originalPath + parsed SessionsIndex', async () => {
    const filePath = path.join(tempDir, 'sessions-index.json');
    const index = {
      version: 1,
      originalPath: '/tmp/projects/foo',
      entries: [],
    };
    writeFileSync(filePath, JSON.stringify(index));

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'session_index',
      slug: SLUG,
      checkpoint: undefined,
    });

    const row = expectRow(result.rows, 0, 'session_index');
    assert.equal(row.slug, SLUG);
    assert.equal(row.originalPath, '/tmp/projects/foo');
    assert.deepEqual(row.sessionsIndex, index);

    rmSync(filePath, { force: true });
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
      slug: SLUG,
      sessionId: SESSION_ID,
      checkpoint: previous,
    });

    assert.equal(result.rows.length, 0);
    assert.equal(result.rewrite, false);
    assert.deepEqual(result.newCheckpoint, previous);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE-FILE PATH (legacy parity: todo acts like the old "pass-through")
  // ─────────────────────────────────────────────────────────────────────────

  test('todo via sessionId-agent-* naming → single row with parsed items', async () => {
    const agentId = 'legacy';
    const filePath = path.join(tempDir, `${SESSION_ID}-agent-${agentId}.json`);
    writeFileSync(
      filePath,
      JSON.stringify([
        { content: 'alpha', status: 'pending' },
        { content: 'beta', status: 'completed' },
      ]),
    );
    const size = statSync(filePath).size;
    void jsonPath; // silence unused path holder for this test

    const result = await parser.parseFileDelta({
      path: filePath,
      category: 'todo',
      sessionId: SESSION_ID,
      checkpoint: undefined,
    });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rewrite, true);
    assert.equal(result.newCheckpoint.size, size);
    assert.equal(result.newCheckpoint.lastOffset, size);

    rmSync(filePath, { force: true });
  });
});
