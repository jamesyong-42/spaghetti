/**
 * codex-ingest.test.ts — the Codex AgentSource, end to end into a real store.
 *
 * Writes a synthetic `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` tree, then
 * drives `CodexReader.readAll` into a real `IngestService` (configured with
 * `sourceId: 'codex'` + `codexMessageExtractor`) over a real SQLite schema, and
 * asserts the rows land: tagged `source_id = 'codex'`, chat turns extracted,
 * and the non-message lines (`session_meta`, `event_msg`) skipped.
 *
 * This exercises the RFC 006 seams for a second source — record production
 * (reader), extraction (extractor), and the `source_id` write path — without
 * the multi-source lifecycle orchestration (that is a later increment; here the
 * store holds codex only).
 *
 * Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { createSqliteService } from '../../io/sqlite-service.js';
import { createFileService } from '../../io/file-service.js';
import { createIngestService } from '../../data/ingest-service.js';
import { initializeSchema } from '../../data/schema.js';
import { createCodexSource, createCodexReader, codexMessageExtractor } from '../codex/index.js';
import type { SqliteService } from '../../io/index.js';

const SESSION_A = '019cf46d-0924-7523-b3f5-f6f5cc0fcd16';
const SESSION_B = '019d1808-f808-7143-99e4-f3d04a4750d2';

/** One rollout file = session_meta + the given response/event lines. */
function rolloutLines(sessionId: string, cwd: string, body: object[]): string {
  const meta = {
    timestamp: '2026-07-13T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: '2026-07-13T00:00:00.000Z',
      cwd,
      cli_version: '0.91.0',
      originator: 'codex_cli_rs',
    },
  };
  return [meta, ...body].map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function msg(role: string, text: string, kind = role === 'assistant' ? 'output_text' : 'input_text') {
  return {
    timestamp: '2026-07-13T00:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: kind, text }] },
  };
}

function tokenCountEvent() {
  // A non-message line the extractor MUST skip.
  return {
    timestamp: '2026-07-13T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } },
  };
}

interface MsgRow {
  msg_type: string;
  text_content: string;
  source_id: string;
  msg_index: number;
}

describe('Codex source — end-to-end ingest', () => {
  let tempDir: string;
  let codexRoot: string;
  let sqlite: SqliteService;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-codex-'));
    codexRoot = path.join(tempDir, '.codex');
    const dayDir = path.join(codexRoot, 'sessions', '2026', '07', '13');
    mkdirSync(dayDir, { recursive: true });

    // proj-a: developer + user + assistant, plus a token_count event (skipped).
    writeFileSync(
      path.join(dayDir, `rollout-2026-07-13T00-00-00-${SESSION_A}.jsonl`),
      rolloutLines(SESSION_A, '/tmp/proj-a', [
        msg('developer', 'system instructions here'),
        msg('user', 'how are text rendered?'),
        tokenCountEvent(),
        msg('assistant', "I'll explore the repo."),
      ]),
    );

    // proj-b: a separate project (distinct cwd → distinct slug).
    writeFileSync(
      path.join(dayDir, `rollout-2026-07-13T00-05-00-${SESSION_B}.jsonl`),
      rolloutLines(SESSION_B, '/tmp/proj-b', [msg('user', 'second project prompt'), msg('assistant', 'done')]),
    );

    const dbPath = path.join(tempDir, 'codex.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    const ingest = createIngestService(() => sqlite, { sourceId: 'codex', messages: codexMessageExtractor });
    ingest.open(dbPath);

    const fileService = createFileService();
    const source = createCodexSource({ rootDir: codexRoot });
    const reader = createCodexReader(source, fileService);
    reader.readAll(ingest);
  });

  after(() => {
    try {
      if (sqlite.isOpen()) sqlite.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('every row is stamped source_id = codex', () => {
    const ids = sqlite.all<{ source_id: string }>('SELECT DISTINCT source_id FROM messages');
    assert.deepEqual(
      ids.map((r) => r.source_id),
      ['codex'],
    );
    const proj = sqlite.all<{ source_id: string }>('SELECT DISTINCT source_id FROM projects');
    assert.deepEqual(
      proj.map((r) => r.source_id),
      ['codex'],
    );
    assert.deepEqual(
      sqlite.all<{ source_id: string }>('SELECT DISTINCT source_id FROM sessions').map((r) => r.source_id),
      ['codex'],
    );
  });

  test('two projects and two sessions were discovered from the rollout tree', () => {
    const projects = sqlite
      .all<{ slug: string; original_path: string }>('SELECT slug, original_path FROM projects ORDER BY original_path')
      .map((r) => r.original_path);
    assert.deepEqual(projects, ['/tmp/proj-a', '/tmp/proj-b']);
    const sessions = sqlite.all<{ id: string }>('SELECT id FROM sessions');
    assert.equal(sessions.length, 2);
  });

  test('chat turns are extracted; session_meta and event_msg are skipped', () => {
    const rows = sqlite.all<MsgRow>(
      'SELECT msg_type, text_content, source_id, msg_index FROM messages WHERE session_id = ? ORDER BY msg_index',
      SESSION_A,
    );
    // developer + user + assistant = 3 messages; session_meta + token_count skipped.
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.msg_type),
      ['developer', 'user', 'assistant'],
    );
    assert.deepEqual(
      rows.map((r) => r.text_content),
      ['system instructions here', 'how are text rendered?', "I'll explore the repo."],
    );
    // msg_index reflects raw line position: session_meta=0, developer=1, user=2,
    // token_count=3 (skipped), assistant=4 — so indexes are 1,2,4 (gaps are fine).
    assert.deepEqual(
      rows.map((r) => r.msg_index),
      [1, 2, 4],
    );
  });

  test('the assistant turn is searchable via FTS', () => {
    const hits = sqlite.all<{ text_content: string }>(
      "SELECT m.text_content FROM search_fts f JOIN messages m ON m.id = f.rowid WHERE search_fts MATCH 'explore'",
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].text_content, /explore the repo/);
  });

  test('codexMessageExtractor skips non-message lines directly', () => {
    assert.equal(codexMessageExtractor.extract({ type: 'session_meta', payload: { cwd: '/x' } }), null);
    assert.equal(codexMessageExtractor.extract({ type: 'event_msg', payload: { type: 'token_count' } }), null);
    assert.equal(
      codexMessageExtractor.extract({ type: 'response_item', payload: { type: 'function_call', name: 'ls' } }),
      null,
    );
    const out = codexMessageExtractor.extract({
      timestamp: '2026-07-13T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    });
    assert.ok(out);
    assert.equal(out.msgType, 'assistant');
    assert.equal(out.text, 'hi');
    assert.equal(out.timestamp, '2026-07-13T00:00:01.000Z');
    assert.deepEqual(out.tokens, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });
});
