/**
 * IngestService.writeBatch — integration tests (RFC 005 C2.6).
 *
 * Covers the per-category dispatch landed alongside the rich ParsedRow
 * shape (C2.4 resolution pass). Each category test seeds a fixture
 * `ParsedRow`, calls `writeBatch`, then asserts:
 *
 *   1. The correct `Change` variant(s) come back in `WriteResult.changes`.
 *   2. Every returned Change carries a numeric `ts` and `seq: 0` (the
 *      store stamps the real monotonic seq on `emit()` — see C3.1).
 *   3. The target SQLite row exists with the expected content (and
 *      the FTS index agrees for messages).
 *
 * The empty-batch short-circuit, rollback-on-throw, and bulk-ingest
 * interop invariants are preserved from the C2.6 scaffold test.
 *
 * Style follows `agent-data-store.test.ts`: `node:test`, `mkdtempSync`,
 * real SqliteService + schema, no mocking.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { createSqliteService } from '../../io/sqlite-service.js';
import { createIngestService } from '../ingest-service.js';
import { initializeSchema } from '../schema.js';
import type { SqliteService } from '../../io/index.js';
import type { IngestService } from '../ingest-service.js';
import type { ParsedRow } from '../../live/incremental-parser.js';
import type {
  SessionMessage,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
  SessionsIndex,
} from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'test-project';
const SESSION_ID = 'session-abc-123';

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

describe('IngestService.writeBatch (RFC 005 C2.6)', () => {
  let tempDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let ingest: IngestService;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-writebatch-test-'));
    dbPath = path.join(tempDir, 'writebatch.db');

    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Seed the project + session rows so downstream INSERTs have a
    // plausible foreign-key landscape (the schema doesn't enforce FKs
    // so this is purely realism — several tests assert that specific
    // rows land, which needs the matching parents for the SELECTs to
    // make sense).
    sqlite.run(
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at) VALUES (?, ?, ?, ?)`,
      SLUG,
      '/tmp/fake/original/path',
      JSON.stringify({ sessions: [] }),
      Date.now(),
    );

    sqlite.run(
      `INSERT INTO sessions (id, project_slug, full_path, first_prompt, summary, git_branch, project_path, is_sidechain, created_at, modified_at, file_mtime, plan_slug, has_task, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      SESSION_ID,
      SLUG,
      `/tmp/fake/original/path/${SESSION_ID}.jsonl`,
      'What is spaghetti?',
      'Fixture session',
      'main',
      '/tmp/fake/original/path',
      0,
      '2026-04-20T00:00:00Z',
      '2026-04-20T00:05:00Z',
      Date.now(),
      null,
      0,
      Date.now(),
    );

    ingest = createIngestService(() => sqlite);
    ingest.open(dbPath);
  });

  after(() => {
    try {
      ingest.close();
    } catch {
      /* ignore */
    }
    try {
      if (sqlite.isOpen()) sqlite.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Clean slate per test for tables that tests poke at. Projects +
  // sessions stay so FK-ish semantics remain intact.
  beforeEach(() => {
    for (const table of [
      'messages',
      'subagents',
      'tool_results',
      'todos',
      'tasks',
      'plans',
      'file_history',
      'project_memories',
    ]) {
      sqlite.run(`DELETE FROM ${table}`);
    }
    sqlite.run(`INSERT INTO search_fts(search_fts) VALUES('rebuild')`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EMPTY BATCH + NO-OP INVARIANTS
  // ─────────────────────────────────────────────────────────────────────────

  test('writeBatch([]) short-circuits with an empty WriteResult', async () => {
    const result = await ingest.writeBatch([]);
    assert.deepStrictEqual(result.changes, []);
    assert.strictEqual(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0, `durationMs must be non-negative, got ${result.durationMs}`);
  });

  test('writeBatch([]) does not touch the messages table', async () => {
    const before = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    await ingest.writeBatch([]);
    const after = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    assert.strictEqual(before?.n, after?.n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PER-CATEGORY HAPPY PATHS
  // ─────────────────────────────────────────────────────────────────────────

  test('message row → INSERT into messages + FTS hit + session.message.added event', async () => {
    const message: SessionMessage = {
      type: 'user',
      uuid: 'uuid-hello-world',
      parentUuid: null,
      timestamp: '2026-04-20T00:00:01Z',
      sessionId: SESSION_ID,
      cwd: '/tmp',
      version: 'test',
      gitBranch: 'main',
      isSidechain: false,
      userType: 'external',
      message: { role: 'user', content: 'hello spaghetti world' },
    } as unknown as SessionMessage;

    const row: ParsedRow = {
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      message,
      msgIndex: 0,
      byteOffset: 0,
    };

    const result = await ingest.writeBatch([row]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'session.message.added');
    if (change.type !== 'session.message.added') return; // narrow
    assert.equal(change.slug, SLUG);
    assert.equal(change.sessionId, SESSION_ID);
    assert.equal(change.byteOffset, 0);
    // As of C3.1, `writeBatch` returns Changes with `seq: 0` —
    // `AgentDataStore.emit()` stamps the real monotonic value.
    assert.equal(change.seq, 0);
    assert.equal(typeof change.ts, 'number');

    // SQLite row exists
    const dbRow = sqlite.get<{ msg_index: number; text_content: string; byte_offset: number }>(
      `SELECT msg_index, text_content, byte_offset FROM messages WHERE session_id = ? AND msg_index = ?`,
      SESSION_ID,
      0,
    );
    assert.ok(dbRow, 'message row should exist');
    assert.equal(dbRow.msg_index, 0);
    assert.equal(dbRow.byte_offset, 0);

    // FTS hit
    const ftsRow = sqlite.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ?`,
      'spaghetti',
    );
    assert.ok((ftsRow?.n ?? 0) >= 1, 'FTS index should be synced');
  });

  test('subagent row → INSERT into subagents + subagent.updated event', async () => {
    const transcript: SubagentTranscript = {
      agentId: 'a-xyz',
      agentType: 'task',
      fileName: 'agent-a-xyz.jsonl',
      messages: [{ type: 'user', message: { role: 'user', content: 'go' } } as unknown as SessionMessage],
    };

    const result = await ingest.writeBatch([{ category: 'subagent', slug: SLUG, sessionId: SESSION_ID, transcript }]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'subagent.updated');
    if (change.type !== 'subagent.updated') return;
    assert.equal(change.agentId, 'a-xyz');
    assert.equal(change.transcript.messages.length, 1);

    const dbRow = sqlite.get<{ agent_id: string; message_count: number }>(
      `SELECT agent_id, message_count FROM subagents WHERE session_id = ?`,
      SESSION_ID,
    );
    assert.ok(dbRow);
    assert.equal(dbRow.agent_id, 'a-xyz');
    assert.equal(dbRow.message_count, 1);
  });

  test('tool_result row → INSERT into tool_results + tool-result.added event', async () => {
    const tResult: PersistedToolResult = { toolUseId: 'toolu_01X', content: 'some output' };

    const result = await ingest.writeBatch([
      { category: 'tool_result', slug: SLUG, sessionId: SESSION_ID, result: tResult },
    ]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'tool-result.added');
    if (change.type !== 'tool-result.added') return;
    assert.equal(change.toolUseId, 'toolu_01X');

    const dbRow = sqlite.get<{ tool_use_id: string; content: string }>(
      `SELECT tool_use_id, content FROM tool_results WHERE session_id = ?`,
      SESSION_ID,
    );
    assert.ok(dbRow);
    assert.equal(dbRow.tool_use_id, 'toolu_01X');
    assert.equal(dbRow.content, 'some output');
  });

  test('file_history row → INSERT into file_history + file-history.added event', async () => {
    const history: FileHistorySession = {
      sessionId: SESSION_ID,
      snapshots: [{ hash: 'abc123', version: 4, fileName: 'abc123@v4', content: 'snap', size: 4 }],
    };

    const result = await ingest.writeBatch([{ category: 'file_history', sessionId: SESSION_ID, history }]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'file-history.added');
    if (change.type !== 'file-history.added') return;
    assert.equal(change.hash, 'abc123');
    assert.equal(change.version, 4);

    const dbRow = sqlite.get<{ data: string }>(`SELECT data FROM file_history WHERE session_id = ?`, SESSION_ID);
    assert.ok(dbRow);
    const parsed = JSON.parse(dbRow.data) as FileHistorySession;
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.snapshots[0].hash, 'abc123');
  });

  test('todo row → INSERT into todos + todo.updated event', async () => {
    const todo: TodoFile = {
      sessionId: SESSION_ID,
      agentId: 'a-todo',
      items: [
        { content: 't1', status: 'pending' },
        { content: 't2', status: 'completed' },
      ],
    };

    const result = await ingest.writeBatch([{ category: 'todo', sessionId: SESSION_ID, todo }]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'todo.updated');
    if (change.type !== 'todo.updated') return;
    assert.equal(change.agentId, 'a-todo');
    assert.equal(change.items.length, 2);

    const dbRow = sqlite.get<{ agent_id: string; items: string }>(
      `SELECT agent_id, items FROM todos WHERE session_id = ?`,
      SESSION_ID,
    );
    assert.ok(dbRow);
    assert.equal(dbRow.agent_id, 'a-todo');
    const parsedItems = JSON.parse(dbRow.items);
    assert.equal(parsedItems.length, 2);
  });

  test('task row → INSERT into tasks + task.updated event', async () => {
    const task: TaskEntry = {
      taskId: SESSION_ID,
      hasHighwatermark: true,
      highwatermark: 7,
      lockExists: true,
    };

    const result = await ingest.writeBatch([{ category: 'task', sessionId: SESSION_ID, task }]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'task.updated');
    if (change.type !== 'task.updated') return;
    assert.equal(change.task.highwatermark, 7);

    const dbRow = sqlite.get<{ highwatermark: number; lock_exists: number }>(
      `SELECT highwatermark, lock_exists FROM tasks WHERE session_id = ?`,
      SESSION_ID,
    );
    assert.ok(dbRow);
    assert.equal(dbRow.highwatermark, 7);
    assert.equal(dbRow.lock_exists, 1);
  });

  test('plan row → INSERT into plans + plan.upserted event', async () => {
    const plan: PlanFile = {
      slug: 'my-plan',
      title: 'My Plan',
      content: '# My Plan\n\nBody.',
      size: 20,
    };

    const result = await ingest.writeBatch([{ category: 'plan', slug: 'my-plan', plan }]);

    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.type, 'plan.upserted');
    if (change.type !== 'plan.upserted') return;
    assert.equal(change.plan.slug, 'my-plan');
    assert.equal(change.plan.title, 'My Plan');

    const dbRow = sqlite.get<{ title: string; content: string; size: number }>(
      `SELECT title, content, size FROM plans WHERE slug = ?`,
      'my-plan',
    );
    assert.ok(dbRow);
    assert.equal(dbRow.title, 'My Plan');
    assert.equal(dbRow.size, 20);
  });

  test('project_memory row → INSERT into project_memories, NO Change emitted', async () => {
    const result = await ingest.writeBatch([{ category: 'project_memory', slug: SLUG, content: 'memory body' }]);

    assert.equal(result.changes.length, 0, 'project_memory emits no Change (RFC 005 §2.9)');

    const dbRow = sqlite.get<{ content: string }>(`SELECT content FROM project_memories WHERE project_slug = ?`, SLUG);
    assert.ok(dbRow);
    assert.equal(dbRow.content, 'memory body');
  });

  test('session_index row → UPSERT projects row, NO Change emitted', async () => {
    const sessionsIndex: SessionsIndex = {
      version: 1,
      originalPath: '/tmp/new/original',
      entries: [],
    };

    const result = await ingest.writeBatch([
      {
        category: 'session_index',
        slug: SLUG,
        originalPath: '/tmp/new/original',
        sessionsIndex,
      },
    ]);

    assert.equal(result.changes.length, 0, 'session_index emits no Change (RFC 005 §2.9)');

    const dbRow = sqlite.get<{ original_path: string }>(`SELECT original_path FROM projects WHERE slug = ?`, SLUG);
    assert.ok(dbRow);
    assert.equal(dbRow.original_path, '/tmp/new/original');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MULTI-ROW BATCH
  // ─────────────────────────────────────────────────────────────────────────

  test('multi-row batch returns one Change per row with placeholder seq=0', async () => {
    const m1: SessionMessage = {
      type: 'user',
      message: { role: 'user', content: 'first' },
    } as unknown as SessionMessage;
    const m2: SessionMessage = {
      type: 'user',
      message: { role: 'user', content: 'second' },
    } as unknown as SessionMessage;

    const result = await ingest.writeBatch([
      { category: 'message', slug: SLUG, sessionId: SESSION_ID, message: m1, msgIndex: 0, byteOffset: 0 },
      { category: 'message', slug: SLUG, sessionId: SESSION_ID, message: m2, msgIndex: 1, byteOffset: 100 },
    ]);

    assert.equal(result.changes.length, 2);
    // Each Change carries seq: 0 — the store's emit() assigns the real
    // monotonic value when the writer loop fans them out. (Monotonicity
    // is proven in `agent-data-store.test.ts` under the C3.1 tests.)
    assert.equal(result.changes[0].seq, 0);
    assert.equal(result.changes[1].seq, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ROLLBACK ON MID-BATCH THROW
  // ─────────────────────────────────────────────────────────────────────────

  test('mid-batch throw rolls back the transaction; SQLite state unchanged', async () => {
    const beforeCount = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)?.n ?? 0;

    // Second row has undefined `message` — onMessage tries to read
    // extractMsgType on it and `msg.type` on undefined throws.
    const valid: SessionMessage = {
      type: 'user',
      message: { role: 'user', content: 'ok' },
    } as unknown as SessionMessage;

    await assert.rejects(() =>
      ingest.writeBatch([
        {
          category: 'message',
          slug: SLUG,
          sessionId: SESSION_ID,
          message: valid,
          msgIndex: 0,
          byteOffset: 0,
        },
        {
          category: 'message',
          slug: SLUG,
          sessionId: SESSION_ID,
          message: undefined as unknown as SessionMessage,
          msgIndex: 1,
          byteOffset: 100,
        },
      ]),
    );

    const afterCount = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)?.n ?? 0;
    assert.equal(afterCount, beforeCount, 'mid-batch throw must roll back the whole batch');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BULK INGEST INTEROP (unchanged from C2.6 scaffold)
  // ─────────────────────────────────────────────────────────────────────────

  test('beginBulkIngest + endBulkIngest still work alongside writeBatch', () => {
    assert.doesNotThrow(() => ingest.beginBulkIngest());
    sqlite.run(
      `INSERT INTO messages (project_slug, session_id, msg_index, msg_type, uuid, timestamp, data, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, text_content, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      SESSION_ID,
      999,
      'user',
      'uuid-bulk',
      '2026-04-20T00:10:00Z',
      JSON.stringify({ type: 'user' }),
      0,
      0,
      0,
      0,
      'bulk fixture',
      0,
    );
    assert.doesNotThrow(() => ingest.endBulkIngest());
  });
});
