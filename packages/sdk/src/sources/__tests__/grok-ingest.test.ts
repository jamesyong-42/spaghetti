/**
 * grok-ingest.test.ts — the Grok AgentSource, end to end into a real store.
 *
 * Writes a synthetic `~/.grok/sessions/<url-encoded-cwd>/<uuid>/` tree (each
 * session dir carrying `chat_history.jsonl` + `summary.json`), then drives
 * `GrokReader.readAll` into a real `IngestService` (configured with
 * `sourceId: 'grok'` + `grokMessageExtractor`) over a real SQLite schema, and
 * asserts the rows land: tagged `source_id = 'grok'`, conversational turns
 * (system/user/assistant/reasoning) extracted, and tool I/O (`tool_result`,
 * `backend_tool_call`) skipped.
 *
 * Exercises the RFC 006 seams for the third source — record production (reader),
 * extraction (extractor), and the `source_id` write path — without the
 * multi-source lifecycle orchestration.
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
import { createGrokSource, createGrokReader, grokMessageExtractor } from '../grok/index.js';
import type { SqliteService } from '../../io/index.js';

const SESSION_A = '019f5d61-da35-7b60-a1b5-02055fd8fcdd';
const SESSION_B = '019f54c0-0dd3-7482-a3ee-e73ca610e8a3';

/** Write one Grok session dir: sessions/<enc(cwd)>/<uuid>/{chat_history,summary}. */
function writeSession(grokRoot: string, cwd: string, sessionId: string, title: string, chatLines: object[]): void {
  const sessionDir = path.join(grokRoot, 'sessions', encodeURIComponent(cwd), sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), chatLines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(
    path.join(sessionDir, 'summary.json'),
    JSON.stringify({
      info: { id: sessionId, cwd },
      created_at: '2026-07-13T21:28:41.941460Z',
      updated_at: '2026-07-13T23:07:59.611347Z',
      generated_title: title,
      session_summary: title,
      head_branch: 'main',
      git_root_dir: cwd + '/',
    }),
  );
}

interface MsgRow {
  msg_type: string;
  text_content: string;
  source_id: string;
  msg_index: number;
}

describe('Grok source — end-to-end ingest', () => {
  let tempDir: string;
  let grokRoot: string;
  let sqlite: SqliteService;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-grok-'));
    grokRoot = path.join(tempDir, '.grok');

    // proj-a: system + user + assistant + reasoning kept; tool_result skipped.
    writeSession(grokRoot, '/tmp/proj-a', SESSION_A, 'Codebase Onboarding', [
      { type: 'system', content: 'You are Grok, a coding assistant.' },
      { type: 'user', content: [{ type: 'text', text: 'how are text rendered?' }] },
      {
        type: 'assistant',
        content: "I'll explore the repo.",
        tool_calls: [{ id: 'call-1', name: 'list_dir', arguments: '{}' }],
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'The user wants onboarding.' }],
        encrypted_content: 'xxx',
        status: 'completed',
      },
      { type: 'tool_result', tool_call_id: 'call-1', content: 'a/\nb/\nc.ts' },
    ]);

    // proj-b: user + assistant kept; backend_tool_call skipped.
    writeSession(grokRoot, '/tmp/proj-b', SESSION_B, 'Token Research', [
      { type: 'user', content: [{ type: 'text', text: 'second project prompt' }] },
      { type: 'backend_tool_call', kind: { tool_type: 'web_search', action: { type: 'search', query: 'tokens' } } },
      { type: 'assistant', content: 'here is the answer' },
    ]);

    const dbPath = path.join(tempDir, 'grok.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    const ingest = createIngestService(() => sqlite, { sourceId: 'grok', messages: grokMessageExtractor });
    ingest.open(dbPath);

    const fileService = createFileService();
    const source = createGrokSource({ rootDir: grokRoot });
    const reader = createGrokReader(source, fileService);
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

  test('every row is stamped source_id = grok', () => {
    for (const table of ['messages', 'projects', 'sessions']) {
      const ids = sqlite.all<{ source_id: string }>(`SELECT DISTINCT source_id FROM ${table}`);
      assert.deepEqual(
        ids.map((r) => r.source_id),
        ['grok'],
        `${table} should be all grok`,
      );
    }
  });

  test('two projects and two sessions were discovered from the session tree', () => {
    const projects = sqlite
      .all<{ original_path: string }>('SELECT original_path FROM projects ORDER BY original_path')
      .map((r) => r.original_path);
    assert.deepEqual(projects, ['/tmp/proj-a', '/tmp/proj-b']);
    assert.equal(sqlite.all<{ id: string }>('SELECT id FROM sessions').length, 2);
  });

  test('conversational turns extracted; tool_result / backend_tool_call are not rows', () => {
    const rows = sqlite.all<MsgRow>(
      'SELECT msg_type, text_content, source_id, msg_index FROM messages WHERE session_id = ? ORDER BY msg_index',
      SESSION_A,
    );
    // system + user + assistant + reasoning = 4; tool_result skipped.
    assert.deepEqual(
      rows.map((r) => r.msg_type),
      ['system', 'user', 'assistant', 'reasoning'],
    );
    assert.deepEqual(
      rows.map((r) => r.text_content),
      [
        'You are Grok, a coding assistant.',
        'how are text rendered?',
        "I'll explore the repo.",
        'The user wants onboarding.',
      ],
    );
    // msg_index preserves file position: tool_result at index 4 is skipped.
    assert.deepEqual(
      rows.map((r) => r.msg_index),
      [0, 1, 2, 3],
    );

    const bRows = sqlite.all<MsgRow>(
      'SELECT msg_type, msg_index FROM messages WHERE session_id = ? ORDER BY msg_index',
      SESSION_B,
    );
    // user(0) + assistant(2); backend_tool_call(1) skipped.
    assert.deepEqual(
      bRows.map((r) => r.msg_type),
      ['user', 'assistant'],
    );
    assert.deepEqual(
      bRows.map((r) => r.msg_index),
      [0, 2],
    );
  });

  test('the assistant turn is searchable via FTS', () => {
    const hits = sqlite.all<{ text_content: string }>(
      "SELECT m.text_content FROM search_fts f JOIN messages m ON m.id = f.rowid WHERE search_fts MATCH 'explore'",
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].text_content, /explore the repo/);
  });

  test('the session title comes from summary.json generated_title', () => {
    const row = sqlite.get<{ first_prompt: string }>('SELECT first_prompt FROM sessions WHERE id = ?', SESSION_A);
    assert.equal(row?.first_prompt, 'Codebase Onboarding');
  });

  test('grokMessageExtractor: turns kept, tool I/O skipped, no per-message tokens/time', () => {
    assert.equal(grokMessageExtractor.extract({ type: 'tool_result', tool_call_id: 'c', content: 'x' }), null);
    assert.equal(grokMessageExtractor.extract({ type: 'backend_tool_call', kind: {} }), null);

    const user = grokMessageExtractor.extract({ type: 'user', content: [{ type: 'text', text: 'hi' }] });
    assert.equal(user?.msgType, 'user');
    assert.equal(user?.text, 'hi');

    const reasoning = grokMessageExtractor.extract({
      type: 'reasoning',
      id: 'rs_9',
      summary: [{ type: 'summary_text', text: 'thinking' }],
      encrypted_content: 'zzz',
    });
    assert.equal(reasoning?.msgType, 'reasoning');
    assert.equal(reasoning?.text, 'thinking');
    assert.equal(reasoning?.uuid, 'rs_9');
    assert.equal(reasoning?.timestamp, null);
    assert.deepEqual(reasoning?.tokens, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
