/**
 * LiveUpdates — integration tests (RFC 005 C2.7).
 *
 * Proves the end-to-end pipeline works: a filesystem change under
 * `<claudeDir>/projects/` or `<claudeDir>/todos/` reaches SQLite via
 * watcher → queue → parser → writeBatch. `store.emit()` is still a
 * no-op stub in Phase 2, so we don't assert on subscribers — just on
 * the DB rows that land.
 *
 * Style matches `data/__tests__/ingest-service-write-batch.test.ts` and
 * `live/__tests__/watcher.test.ts`: `node:test` + `assert/strict`,
 * `mkdtempSync` per suite, real SQLite + real filesystem, no mocks.
 *
 * `createParcelWatcher()` is the default — `--test-force-exit` in the
 * SDK's test script handles any lingering native handles.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createSqliteService } from '../../io/sqlite-service.js';
import { createQueryService } from '../../data/query-service.js';
import { createIngestService } from '../../data/ingest-service.js';
import { createAgentDataStore } from '../../data/agent-data-store.js';
import { initializeSchema } from '../../data/schema.js';
import { createLiveUpdates, type LiveUpdates } from '../live-updates.js';
import type { SqliteService } from '../../io/index.js';
import type { IngestService } from '../../data/ingest-service.js';
import type { QueryService } from '../../data/query-service.js';
import type { AgentDataStore } from '../../data/agent-data-store.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'test-slug';
const SESSION_ID = 'session-xyz';

// Polling budget for eventually-consistent assertions. Watcher +
// queue's 30 ms debounce + 75 ms batch window + SQLite commit usually
// lands within a few hundred ms; 2 s gives headroom for CI noise.
const POLL_INTERVAL_MS = 50;
const POLL_MAX_ITER = 40; // 40 * 50ms = 2s
const QUIET_MS = 500;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poll until `check()` returns a value, or the budget runs out.
 * Mirrors the pattern used in the watcher test (longer `timeoutMs`
 * window, shorter per-iteration sleep).
 */
async function pollUntil<T>(check: () => T | undefined): Promise<T> {
  for (let i = 0; i < POLL_MAX_ITER; i++) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const final = check();
  if (final !== undefined) return final;
  throw new Error(`pollUntil timed out after ${POLL_MAX_ITER * POLL_INTERVAL_MS}ms`);
}

/** JSONL user message — minimal shape the writer accepts. */
function makeUserMessage(uuid: string, text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      message: { role: 'user', content: text },
    }) + '\n'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE: end-to-end with a populated claudeDir
// ═══════════════════════════════════════════════════════════════════════════

describe('LiveUpdates end-to-end (RFC 005 C2.7)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let projectDir: string;
  let sessionPath: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let queryService: QueryService;
  let ingest: IngestService;
  let store: AgentDataStore;
  let live: LiveUpdates;
  const capturedErrors: Error[] = [];

  before(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-updates-test-'));
    // Parcel emits realpath-canonicalised paths on macOS; classify
    // compares against the root we pass in, so use the realpath form
    // everywhere to keep the two sides in sync.
    tempRoot = realpathSync(tempRoot);
    claudeDir = path.join(tempRoot, '.claude');
    projectDir = path.join(claudeDir, 'projects', SLUG);
    sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`);

    // Pre-create both subdirs so the happy-path suite doesn't fight
    // the watcher on "directory that doesn't exist yet". The
    // graceful-startup suite below uses its own claudeDir with only
    // projects/ present.
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(path.join(claudeDir, 'todos'), { recursive: true });

    dbPath = path.join(tempRoot, 'live.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Seed projects + sessions rows so the messages/todos inserts have
    // plausible parents — the schema doesn't enforce FKs, but
    // session-scoped reads below are easier to reason about with
    // matching parent rows.
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
      sessionPath,
      'fixture',
      'fixture session',
      'main',
      '/tmp/fake',
      0,
      '2026-04-20T00:00:00Z',
      '2026-04-20T00:05:00Z',
      Date.now(),
      null,
      0,
      Date.now(),
    );

    const fileService = createFileService();
    queryService = createQueryService(() => sqlite);
    queryService.open(dbPath);
    ingest = createIngestService(() => sqlite);
    ingest.open(dbPath);
    store = createAgentDataStore(queryService);

    live = createLiveUpdates(
      { fileService, ingestService: ingest, store },
      {
        claudeDir,
        onError: (err) => {
          capturedErrors.push(err);
        },
      },
    );
    await live.start();
  });

  after(async () => {
    try {
      await live.stop();
    } catch {
      /* ignore */
    }
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
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('live write lands in SQLite', { timeout: 10000 }, async () => {
    writeFileSync(sessionPath, makeUserMessage('uuid-1', 'first live message'));

    const row = await pollUntil(() => {
      const r = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
      return r && r.n >= 1 ? r : undefined;
    });
    assert.equal(row.n, 1, `expected 1 message row for ${SESSION_ID}, got ${row.n}`);
  });

  test('append after initial write is captured', { timeout: 10000 }, async () => {
    appendFileSync(sessionPath, makeUserMessage('uuid-2', 'second live message'));

    const row = await pollUntil(() => {
      const r = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
      return r && r.n >= 2 ? r : undefined;
    });
    assert.equal(row.n, 2);
  });

  test('rewrite is captured', { timeout: 10000 }, async () => {
    // Truncate + replace with a single new line. The writer upserts on
    // (session_id, msg_index) so the fresh row at msg_index=0 overwrites
    // whatever was there — the row count may drop to 1 (ideal) or stay
    // at the previous count if stale rows linger; Phase 2 just asserts
    // ingest fires, Phase 5 tightens the truncation repair.
    writeFileSync(sessionPath, makeUserMessage('uuid-rewrite', 'rewritten content'));

    // Wait for *something* to change — the rewrite bumps the row at
    // msg_index=0 to the new uuid.
    const row = await pollUntil(() => {
      const r = sqlite.get<{ uuid: string }>(
        `SELECT uuid FROM messages WHERE session_id = ? AND msg_index = 0`,
        SESSION_ID,
      );
      return r && r.uuid === 'uuid-rewrite' ? r : undefined;
    });
    assert.equal(row.uuid, 'uuid-rewrite');
  });

  test('todo file lands in SQLite', { timeout: 10000 }, async () => {
    const todoPath = path.join(claudeDir, 'todos', `${SESSION_ID}-agent-a0.json`);
    writeFileSync(todoPath, JSON.stringify([{ content: 'test todo', status: 'pending' }]));

    const row = await pollUntil(() => {
      const r = sqlite.get<{ items: string; agent_id: string }>(
        `SELECT items, agent_id FROM todos WHERE session_id = ? AND agent_id = ?`,
        SESSION_ID,
        'a0',
      );
      return r ? r : undefined;
    });
    assert.equal(row.agent_id, 'a0');
    const items = JSON.parse(row.items) as Array<{ content: string; status: string }>;
    assert.equal(items.length, 1);
    assert.equal(items[0].content, 'test todo');
  });

  test('stop() halts further writes', { timeout: 10000 }, async () => {
    // Sanity: read the current row count, then stop, then append, then
    // check the count hasn't moved.
    const before =
      sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID)?.n ?? 0;

    await live.stop();

    appendFileSync(sessionPath, makeUserMessage('uuid-after-stop', 'should be silent'));

    // Wait a generous window; if the pipeline were still live we'd see
    // the row by now.
    await new Promise((r) => setTimeout(r, QUIET_MS));

    const after =
      sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID)?.n ?? 0;
    assert.equal(after, before, `stop() should halt ingest: messages rose from ${before} → ${after} after stop()`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE: graceful startup when only projects/ exists
// ═══════════════════════════════════════════════════════════════════════════

describe('LiveUpdates graceful startup (RFC 005 C2.7)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let ingest: IngestService;
  let queryService: QueryService;
  let store: AgentDataStore;
  let live: LiveUpdates;
  const errors: Error[] = [];

  before(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-updates-graceful-'));
    tempRoot = realpathSync(tempRoot);
    claudeDir = path.join(tempRoot, '.claude');

    // Only create projects/; todos/ is intentionally missing so the
    // watcher attach for it must fail gracefully.
    mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });

    dbPath = path.join(tempRoot, 'live.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    const fileService = createFileService();
    queryService = createQueryService(() => sqlite);
    queryService.open(dbPath);
    ingest = createIngestService(() => sqlite);
    ingest.open(dbPath);
    store = createAgentDataStore(queryService);

    live = createLiveUpdates(
      { fileService, ingestService: ingest, store },
      {
        claudeDir,
        onError: (err) => {
          errors.push(err);
        },
      },
    );
  });

  after(async () => {
    try {
      await live.stop();
    } catch {
      /* ignore */
    }
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
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('start() resolves even when todos/ is missing; onError sees the failure', { timeout: 10000 }, async () => {
    // Must not throw. parcel-watcher refuses to attach on a missing
    // directory; the orchestrator should surface via onError and
    // keep going.
    await assert.doesNotReject(() => live.start());
    assert.equal(live.isRunning(), true);

    // At least one error should describe the missing todos/ attach.
    const todoErr = errors.find((e) => /todos\//.test(e.message));
    assert.ok(
      todoErr,
      `expected onError to report the missing todos/ subdir. Collected: ${errors.map((e) => e.message).join(' | ')}`,
    );
  });
});
