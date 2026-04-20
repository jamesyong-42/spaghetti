/**
 * IngestService.writeBatch — integration tests (RFC 005 C2.6).
 *
 * These tests pin the *scaffolded* surface landed in C2.6:
 *
 *   - `writeBatch([])` must short-circuit without opening a
 *     transaction, returning a `WriteResult` with an empty
 *     `changes` array and a numeric `durationMs`.
 *   - `writeBatch([row, ...])` must throw a clear design-doc-gap
 *     error until the `ParsedRow` shape gains the metadata
 *     required by the existing per-category `onX` methods
 *     (`msgIndex` / `byteOffset` for messages, structured domain
 *     objects for the rest).
 *
 * The happy-path-per-category, seq-monotonicity, rollback, and
 * FTS-sync assertions described in the C2.6 brief land alongside
 * the follow-up commit that fixes the parser shape — at that point
 * this file expands to match the full spec.
 *
 * Style follows `agent-data-store.test.ts`: `node:test`,
 * `mkdtempSync`, direct SQL seed, real SqliteService + schema.
 */

import { test, describe, before, after } from 'node:test';
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

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SLUG = 'test-project';
const SESSION_ID = 'session-abc-123';

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════

describe('IngestService.writeBatch (RFC 005 C2.6 scaffold)', () => {
  let tempDir: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let ingest: IngestService;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-writebatch-test-'));
    dbPath = path.join(tempDir, 'writebatch.db');

    // Share one SqliteService between the test fixture seeding and the
    // IngestService under test — mirrors the production wiring.
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Seed `projects` + `sessions` rows so foreign keys / per-category
    // dispatch targets exist once the gap closes. Pre-seeding here even
    // in the scaffold phase keeps the test file stable when the follow-
    // up commit flips to real dispatch.
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
    // The shared SqliteService is already open, so `open()` will skip
    // re-opening and just prepare statements + re-run initializeSchema.
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

  test('writeBatch([<message>]) throws the design-doc-gap error (scaffold contract)', async () => {
    const row: ParsedRow = {
      category: 'message',
      slug: SLUG,
      sessionId: SESSION_ID,
      payload: {
        type: 'user',
        uuid: 'uuid-1',
        timestamp: '2026-04-20T00:00:01Z',
        message: { role: 'user', content: 'hello' },
      },
    };
    await assert.rejects(() => ingest.writeBatch([row]), /writeBatch: per-category dispatch not yet wired/);
  });

  test('a failing non-empty batch leaves the messages table untouched', async () => {
    const before = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    await assert.rejects(() =>
      ingest.writeBatch([
        {
          category: 'message',
          slug: SLUG,
          sessionId: SESSION_ID,
          payload: { type: 'user' },
        },
      ]),
    );
    const after = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    assert.strictEqual(before?.n, after?.n);
  });

  // Existing bulk-ingest path must not regress — prove it by flipping
  // the bulk-mode switches and running a raw INSERT through SqliteService.
  // This mirrors what `project-parser` does during cold start.
  test('beginBulkIngest + endBulkIngest still work alongside writeBatch', () => {
    assert.doesNotThrow(() => ingest.beginBulkIngest());
    // Inside bulk mode the FTS triggers are dropped; raw inserts still
    // succeed against the schema.
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
