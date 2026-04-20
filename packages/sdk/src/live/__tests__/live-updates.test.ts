/**
 * LiveUpdates — integration tests (RFC 005 C2.7 + C3.2).
 *
 * Proves the end-to-end pipeline works: a filesystem change under
 * `<claudeDir>/projects/` or `<claudeDir>/todos/` reaches SQLite via
 * watcher → queue → parser → writeBatch. Since C3.2, watchers are
 * attached lazily — every test that expects ingest must `prewarm()`
 * the relevant topic (or the end-to-end `api.live.onChange` path from
 * C3.4, which we'll migrate to once that surface ships).
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
import type { Change } from '../change-events.js';

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

    // C3.2: start() no longer attaches watchers eagerly. Prewarm both
    // scopes the suite exercises so the projects/ and todos/ watchers
    // come online before any test writes a fixture file. The disposes
    // returned here are held for the lifetime of the suite and torn
    // down implicitly via `live.stop()` in `after()`.
    live.prewarm({ kind: 'session', slug: SLUG, sessionId: SESSION_ID });
    live.prewarm({ kind: 'todo', sessionId: SESSION_ID });
    // Give parcel a tick to actually bind the watcher — attach is
    // async, triggered by the prewarm ref-count bump.
    await new Promise((r) => setTimeout(r, 100));
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

  test(
    'start() resolves without attaching watchers; prewarm on missing todos/ surfaces via onError',
    { timeout: 10000 },
    async () => {
      // Must not throw. Under C3.2, start() only loads checkpoints +
      // spawns the writer loop; no watcher is attached yet.
      await assert.doesNotReject(() => live.start());
      assert.equal(live.isRunning(), true);

      // Without prewarm, no errors have been observed yet — watchers
      // are inert.
      assert.equal(
        errors.length,
        0,
        `expected no errors pre-prewarm, got: ${errors.map((e) => e.message).join(' | ')}`,
      );

      // Prewarm the todos/ scope explicitly — this triggers the attach
      // that fails because the directory is missing.
      live.prewarm({ kind: 'todo', sessionId: 'whatever' });
      // Give the async attach a moment to fail and route through onError.
      await new Promise((r) => setTimeout(r, 150));

      const todoErr = errors.find((e) => /todos\//.test(e.message));
      assert.ok(
        todoErr,
        `expected onError to report the missing todos/ subdir. Collected: ${errors.map((e) => e.message).join(' | ')}`,
      );
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE: lazy ref-counting (RFC 005 C3.2)
// ═══════════════════════════════════════════════════════════════════════════

describe('LiveUpdates lazy ref-counting (RFC 005 C3.2)', () => {
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

  before(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-updates-lazy-'));
    tempRoot = realpathSync(tempRoot);
    claudeDir = path.join(tempRoot, '.claude');
    projectDir = path.join(claudeDir, 'projects', SLUG);
    sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    mkdirSync(projectDir, { recursive: true });

    dbPath = path.join(tempRoot, 'live.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Parent rows for nicer downstream observability.
    sqlite.run(
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at) VALUES (?, ?, ?, ?)`,
      SLUG,
      '/tmp/fake',
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

    live = createLiveUpdates({ fileService, ingestService: ingest, store }, { claudeDir });
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

  test('without prewarm: writing a JSONL line produces no SQLite rows', { timeout: 10000 }, async () => {
    // Start from a known baseline: count existing rows so concurrent
    // test pollution (should be none, but safety) can't skew the delta.
    const before = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
    const startCount = before?.n ?? 0;

    // No prewarm has been issued — the projects/ watcher is detached.
    writeFileSync(sessionPath, makeUserMessage('uuid-no-prewarm', 'should not ingest'));

    // Wait generously; if the watcher were attached we'd see a row.
    await new Promise((r) => setTimeout(r, QUIET_MS));

    const after = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
    assert.equal(
      (after?.n ?? 0) - startCount,
      0,
      `no prewarm → no watcher attached → no ingest (delta should be 0, got ${(after?.n ?? 0) - startCount})`,
    );
  });

  test('prewarm attaches the watcher; subsequent writes ingest', { timeout: 10000 }, async () => {
    const baseline =
      sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID)?.n ?? 0;

    const dispose = live.prewarm({ kind: 'session', slug: SLUG, sessionId: SESSION_ID });
    // parcel attach is async — give it a tick.
    await new Promise((r) => setTimeout(r, 150));

    writeFileSync(sessionPath, makeUserMessage('uuid-prewarmed', 'with prewarm'));

    const row = await pollUntil(() => {
      const r = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
      return r && r.n > baseline ? r : undefined;
    });
    assert.ok(row.n > baseline, 'post-prewarm ingest should advance the row count');
    // Keep the scope attached for the next test by NOT disposing yet.
    // Return the dispose so a stacking test can verify ref semantics.
    // (Disposed at the end of the suite via `live.stop()`.)
    void dispose;
  });

  test('stacking two prewarms then disposing one keeps the watcher attached', { timeout: 10000 }, async () => {
    // First prewarm: already held from the previous test (slug+sessionId).
    // Second prewarm: slug-only. Both resolve to the same `projects`
    // scope, so the ref count should be 2. Disposing one drops it to
    // 1, not 0, and the watcher stays attached.
    const dispose2 = live.prewarm({ kind: 'session', slug: SLUG });
    await new Promise((r) => setTimeout(r, 50));

    dispose2();
    await new Promise((r) => setTimeout(r, 50));

    const baseline =
      sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID)?.n ?? 0;

    appendFileSync(sessionPath, makeUserMessage('uuid-stacking', 'after partial release'));

    const row = await pollUntil(() => {
      const r = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
      return r && r.n > baseline ? r : undefined;
    });
    assert.ok(row.n > baseline, 'watcher should still be attached via the first prewarm');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE: tasks/ live updates (RFC 005 C5.2)
// ═══════════════════════════════════════════════════════════════════════════

describe('LiveUpdates tasks/ scope (RFC 005 C5.2)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let queryService: QueryService;
  let ingest: IngestService;
  let store: AgentDataStore;
  let live: LiveUpdates;

  before(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-tasks-'));
    tempRoot = realpathSync(tempRoot);
    claudeDir = path.join(tempRoot, '.claude');
    mkdirSync(path.join(claudeDir, 'tasks'), { recursive: true });

    dbPath = path.join(tempRoot, 'live.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Parent session row so the `UPDATE sessions SET has_task = 1` in
    // onTask has a target; the test itself only cares about the tasks row.
    sqlite.run(
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at) VALUES (?, ?, ?, ?)`,
      'task-slug',
      '/tmp/fake',
      JSON.stringify({ sessions: [] }),
      Date.now(),
    );
    sqlite.run(
      `INSERT INTO sessions (id, project_slug, full_path, first_prompt, summary, git_branch, project_path, is_sidechain, created_at, modified_at, file_mtime, plan_slug, has_task, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      's1',
      'task-slug',
      '/dev/null',
      'fixture',
      'fixture',
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

    live = createLiveUpdates({ fileService, ingestService: ingest, store }, { claudeDir });
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

  test('task prewarm + .lock create lands a tasks row + emits task.updated', { timeout: 10000 }, async () => {
    const captured: Change[] = [];
    const sub = store.subscribe({ kind: 'task', sessionId: 's1' }, (c) => {
      captured.push(c);
    });

    const dispose = live.prewarm({ kind: 'task', sessionId: 's1' });
    // Parcel attach is async — give it a tick.
    await new Promise((r) => setTimeout(r, 150));

    const taskDir = path.join(claudeDir, 'tasks', 's1');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, '.lock'), '');

    const row = await pollUntil(() => {
      const r = sqlite.get<{ lock_exists: number }>(`SELECT lock_exists FROM tasks WHERE session_id = ?`, 's1');
      return r ? r : undefined;
    });
    assert.equal(row.lock_exists, 1, 'tasks row should record lock_exists=1');

    // The task.updated event should have fired.
    const taskEvent = captured.find((c) => c.type === 'task.updated');
    assert.ok(taskEvent, `expected a task.updated change, got: ${captured.map((c) => c.type).join(', ')}`);

    sub();
    dispose();
  });

  test('.lock + .highwatermark within debounce window coalesce to one task.updated', { timeout: 10000 }, async () => {
    // Use a fresh session to sidestep any lingering task row from the
    // previous test.
    sqlite.run(
      `INSERT INTO sessions (id, project_slug, full_path, first_prompt, summary, git_branch, project_path, is_sidechain, created_at, modified_at, file_mtime, plan_slug, has_task, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      's2',
      'task-slug',
      '/dev/null',
      'fixture',
      'fixture',
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

    const captured: Change[] = [];
    const sub = store.subscribe({ kind: 'task', sessionId: 's2' }, (c) => {
      captured.push(c);
    });
    const dispose = live.prewarm({ kind: 'task', sessionId: 's2' });
    await new Promise((r) => setTimeout(r, 150));

    const taskDir = path.join(claudeDir, 'tasks', 's2');
    mkdirSync(taskDir, { recursive: true });
    // Two events within the 75 ms batch window + path-dedup should
    // collapse to a single enqueue → single writeBatch → single change.
    writeFileSync(path.join(taskDir, '.lock'), '');
    writeFileSync(path.join(taskDir, '.highwatermark'), '42');

    // Wait for the coalesced write to land.
    await pollUntil(() => {
      const r = sqlite.get<{ has_highwatermark: number; highwatermark: number }>(
        `SELECT has_highwatermark, highwatermark FROM tasks WHERE session_id = ?`,
        's2',
      );
      return r && r.has_highwatermark === 1 ? r : undefined;
    });

    // Give any lingering duplicate write-batch one more drain window to
    // slip through before we assert the tally.
    await new Promise((r) => setTimeout(r, 250));

    const taskChanges = captured.filter((c) => c.type === 'task.updated');
    assert.equal(
      taskChanges.length,
      1,
      `.lock + .highwatermark within the debounce window should coalesce into one task.updated, got ${taskChanges.length}: ${taskChanges.map((c) => JSON.stringify(c.type)).join(', ')}`,
    );

    sub();
    dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE: file-history/ live updates (RFC 005 C5.3)
// ═══════════════════════════════════════════════════════════════════════════

describe('LiveUpdates file-history/ scope (RFC 005 C5.3)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let queryService: QueryService;
  let ingest: IngestService;
  let store: AgentDataStore;
  let live: LiveUpdates;

  before(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-file-history-'));
    tempRoot = realpathSync(tempRoot);
    claudeDir = path.join(tempRoot, '.claude');
    mkdirSync(path.join(claudeDir, 'file-history'), { recursive: true });

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

    live = createLiveUpdates({ fileService, ingestService: ingest, store }, { claudeDir });
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

  test('file-history snapshot lands + emits file-history.added', { timeout: 10000 }, async () => {
    const captured: Change[] = [];
    const sub = store.subscribe({ kind: 'file-history', sessionId: 's1' }, (c) => {
      captured.push(c);
    });
    const dispose = live.prewarm({ kind: 'file-history', sessionId: 's1' });
    // Parcel attach is async — give it a tick.
    await new Promise((r) => setTimeout(r, 150));

    const historyDir = path.join(claudeDir, 'file-history', 's1');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(path.join(historyDir, 'abc@v1'), 'hello');

    const event = await pollUntil(() => {
      const hit = captured.find((c) => c.type === 'file-history.added');
      return hit ? hit : undefined;
    });
    assert.equal(event.type, 'file-history.added');
    if (event.type === 'file-history.added') {
      assert.equal(event.hash, 'abc');
      assert.equal(event.version, 1);
      assert.equal(event.sessionId, 's1');
    }

    sub();
    dispose();
  });
});
