/**
 * AgentDataStore — unit tests (RFC 005 C1.1 + C1.2).
 *
 * Proves the new store works in isolation against a prepared SQLite
 * file, without needing the parser, ingest-service, or any ~/.claude
 * layout. Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { createSqliteService } from '../../io/sqlite-service.js';
import { createQueryService } from '../query-service.js';
import { createAgentDataStore } from '../agent-data-store.js';
import { initializeSchema } from '../schema.js';
import type { SqliteService } from '../../io/index.js';
import type { QueryService } from '../query-service.js';
import type { AgentDataStore } from '../agent-data-store.js';
import type { AgentAnalytic, AgentConfig } from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'test-project';
const SESSION_ID = 'session-abc-123';
const MSG_TEXT = 'hello world spaghetti fixture';
const MEMORY_TEXT = '# Fixture memory\nThis project lives in a unit test.';
const TOOL_USE_ID = 'toolu_test_1';
const TOOL_RESULT_TEXT = 'tool result body';

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

describe('AgentDataStore (C1.1 skeleton)', () => {
  let tempDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let queryService: QueryService;
  let store: AgentDataStore;

  before(() => {
    // Use an on-disk temp DB — `better-sqlite3` supports `:memory:` but
    // `SqliteServiceImpl.open()` calls `mkdirSync(dirname(path))` so an
    // honest file keeps the scaffolding identical to production.
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-store-test-'));
    dbPath = path.join(tempDir, 'store.db');

    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Seed the minimal rows each read path below will hit. All inserts
    // are raw SQL so the test doesn't depend on IngestService plumbing.
    sqlite.run(
      `INSERT INTO projects (slug, original_path, sessions_index, updated_at) VALUES (?, ?, ?, ?)`,
      SLUG,
      '/tmp/fake/original/path',
      JSON.stringify({ sessions: [] }),
      Date.now(),
    );

    sqlite.run(
      `INSERT INTO project_memories (project_slug, content, updated_at) VALUES (?, ?, ?)`,
      SLUG,
      MEMORY_TEXT,
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

    const message = {
      type: 'user',
      uuid: 'uuid-msg-0',
      timestamp: '2026-04-20T00:00:01Z',
      message: { role: 'user', content: MSG_TEXT },
    };

    sqlite.run(
      `INSERT INTO messages (project_slug, session_id, msg_index, msg_type, uuid, timestamp, data, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, text_content, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      SESSION_ID,
      0,
      'user',
      'uuid-msg-0',
      '2026-04-20T00:00:01Z',
      JSON.stringify(message),
      0,
      0,
      0,
      0,
      MSG_TEXT,
      0,
    );

    sqlite.run(
      `INSERT INTO subagents (project_slug, session_id, agent_id, agent_type, file_name, messages, message_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      SESSION_ID,
      'agent-0001',
      'general',
      'agent-0001.jsonl',
      JSON.stringify([message]),
      1,
      Date.now(),
    );

    sqlite.run(
      `INSERT INTO tool_results (project_slug, session_id, tool_use_id, content, updated_at) VALUES (?, ?, ?, ?, ?)`,
      SLUG,
      SESSION_ID,
      TOOL_USE_ID,
      TOOL_RESULT_TEXT,
      Date.now(),
    );

    sqlite.run(
      `INSERT INTO todos (session_id, agent_id, items, updated_at) VALUES (?, ?, ?, ?)`,
      SESSION_ID,
      'agent-0001',
      JSON.stringify([{ content: 'fixture todo', status: 'pending' }]),
      Date.now(),
    );

    // The store's query path for `getSessionMessages` counts from `messages`
    // + joins, but search goes through the FTS5 triggers — which our INSERT
    // above already fires. No extra seeding needed for search.

    queryService = createQueryService(() => sqlite);
    // QueryService.open() is a no-op when the shared SqliteService is
    // already open; it just runs `initializeSchema` again (idempotent).
    queryService.open(dbPath);

    store = createAgentDataStore(queryService);
  });

  after(() => {
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('getProjectSlugs returns the seeded slug', () => {
    const slugs = store.getProjectSlugs();
    assert.deepStrictEqual(slugs, [SLUG]);
  });

  test('getProjectSummaries returns a row for the seeded project', () => {
    const summaries = store.getProjectSummaries();
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].slug, SLUG);
    assert.strictEqual(summaries[0].sessionCount, 1);
    assert.strictEqual(summaries[0].messageCount, 1);
    assert.strictEqual(summaries[0].hasMemory, true);
  });

  test('getSessionSummaries returns the seeded session', () => {
    const sessions = store.getSessionSummaries(SLUG);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, SESSION_ID);
    assert.strictEqual(sessions[0].messageCount, 1);
    assert.strictEqual(sessions[0].firstPrompt, 'What is spaghetti?');
  });

  test('getSessionMessages returns the seeded message row', () => {
    const page = store.getSessionMessages(SLUG, SESSION_ID, 10, 0);
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.offset, 0);
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.messages.length, 1);

    const msg = page.messages[0] as Record<string, unknown>;
    assert.strictEqual(msg.type, 'user');
    assert.strictEqual(msg.uuid, 'uuid-msg-0');
  });

  test('getSessionSubagents returns the seeded agent metadata', () => {
    const agents = store.getSessionSubagents(SLUG, SESSION_ID);
    assert.strictEqual(agents.length, 1);
    assert.deepStrictEqual(agents[0], {
      agentId: 'agent-0001',
      agentType: 'general',
      messageCount: 1,
    });
  });

  test('getSubagentMessages returns the inlined message list', () => {
    const page = store.getSubagentMessages(SLUG, SESSION_ID, 'agent-0001', 10, 0);
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.messages.length, 1);
    const msg = page.messages[0] as Record<string, unknown>;
    assert.strictEqual(msg.uuid, 'uuid-msg-0');
  });

  test('getProjectMemory returns the seeded memory body', () => {
    assert.strictEqual(store.getProjectMemory(SLUG), MEMORY_TEXT);
  });

  test('getSessionTodos returns the seeded todo payload', () => {
    const todos = store.getSessionTodos(SLUG, SESSION_ID);
    assert.strictEqual(todos.length, 1);
  });

  test('getSessionPlan returns null when no plan is seeded', () => {
    assert.strictEqual(store.getSessionPlan(SLUG, SESSION_ID), null);
  });

  test('getSessionTask returns null when no task row exists', () => {
    assert.strictEqual(store.getSessionTask(SLUG, SESSION_ID), null);
  });

  test('getToolResult returns the seeded tool-result content', () => {
    assert.strictEqual(store.getToolResult(SLUG, SESSION_ID, TOOL_USE_ID), TOOL_RESULT_TEXT);
  });

  test('search finds the fixture message text via FTS', () => {
    const result = store.search({ text: 'spaghetti' });
    assert.ok(result.total > 0, `Expected at least one FTS hit, got total=${result.total}`);
    const first = result.results[0];
    assert.strictEqual(first.projectSlug, SLUG);
    assert.strictEqual(first.sessionId, SESSION_ID);
  });

  // ── C1.2: config + analytics cache ─────────────────────────────────────

  test('setConfig → getConfig roundtrip preserves the snapshot', () => {
    // The shapes are big aggregate types; casting a minimal object
    // through `unknown` keeps the test focused on store semantics
    // rather than on whether AgentConfig's sub-shapes are perfectly
    // filled in.
    const fakeConfig = { __fixture: 'config-v1' } as unknown as AgentConfig;
    store.setConfig(fakeConfig);
    assert.strictEqual(store.hasConfig(), true);
    assert.strictEqual(store.getConfig(), fakeConfig);
  });

  test('setAnalytics → getAnalytics roundtrip preserves the snapshot', () => {
    const fakeAnalytics = { __fixture: 'analytics-v1' } as unknown as AgentAnalytic;
    store.setAnalytics(fakeAnalytics);
    assert.strictEqual(store.hasAnalytics(), true);
    assert.strictEqual(store.getAnalytics(), fakeAnalytics);
  });

  test('setConfig overwrites a previous value', () => {
    const v1 = { __fixture: 'config-v1' } as unknown as AgentConfig;
    const v2 = { __fixture: 'config-v2' } as unknown as AgentConfig;
    store.setConfig(v1);
    store.setConfig(v2);
    assert.strictEqual(store.getConfig(), v2);
  });

  test('getConfig throws when no config has been set (fresh store)', () => {
    // Build a second store that never had `setConfig` called so we can
    // verify the "empty" contract without disturbing the shared fixture
    // store used by the other tests.
    const freshStore = createAgentDataStore(queryService);
    assert.strictEqual(freshStore.hasConfig(), false);
    assert.throws(() => freshStore.getConfig(), /config not set/);
    assert.strictEqual(freshStore.hasAnalytics(), false);
    assert.throws(() => freshStore.getAnalytics(), /analytics not set/);
  });
});
