/**
 * LiveUpdates — end-to-end subscriber delivery (RFC 005 C3.3).
 *
 * Seals the "subscribers actually fire" contract. Prior commits wired
 * every seam: the writer loop calls `store.emit`, the store routes
 * through the subscriber registry, `prewarm` ref-counts the watcher
 * on. This test exercises the full chain — real parcel-watcher, real
 * SQLite, real IncrementalParser — and asserts a `Change` variant
 * lands on a listener within a bounded window.
 *
 * Transitional note: C3.3 constructs the pipeline via the component
 * factories so we can subscribe through `store.subscribe` directly.
 * C3.4 re-points this test at `createSpaghettiService({ live: true })`
 * + `api.live.onChange` — at which point any private-accessor
 * scaffolding can go away. The test structure (real fs → real ingest
 * → listener fires) is the invariant; only the subscribe call site
 * moves.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';

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

const SLUG = 'e2e-slug';
const SESSION_ID = 'e2e-session';
const DELIVERY_TIMEOUT_MS = 2000;

/**
 * Resolve when `store.subscribe` fires OR `timeoutMs` elapses,
 * whichever first. Returns the first matching Change (or throws on
 * timeout). Subscription is disposed automatically after resolution.
 */
function awaitFirstChange(
  store: AgentDataStore,
  topic: Parameters<AgentDataStore['subscribe']>[0],
  timeoutMs: number,
): Promise<Change> {
  return new Promise<Change>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dispose = store.subscribe(topic, (e) => {
      if (timer !== null) clearTimeout(timer);
      dispose();
      resolve(e);
    });
    timer = setTimeout(() => {
      dispose();
      reject(new Error(`awaitFirstChange timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

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

describe('LiveUpdates end-to-end subscriber delivery (RFC 005 C3.3)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let sessionPath: string;
  let dbPath: string;
  let sqlite: SqliteService;
  let queryService: QueryService;
  let ingest: IngestService;
  let store: AgentDataStore;
  let live: LiveUpdates;
  const capturedErrors: Error[] = [];

  before(async () => {
    tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'spaghetti-live-events-')));
    claudeDir = path.join(tempRoot, '.claude');
    const projectDir = path.join(claudeDir, 'projects', SLUG);
    sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    mkdirSync(projectDir, { recursive: true });

    dbPath = path.join(tempRoot, 'live.db');
    sqlite = createSqliteService();
    sqlite.open({ path: dbPath });
    initializeSchema(sqlite);

    // Parent rows so the message upsert has a sensible parent session.
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

    live = createLiveUpdates(
      { fileService, ingestService: ingest, store },
      {
        claudeDir,
        // Route errors into a list instead of the default console.warn
        // so the test output isn't polluted by benign attach-timing
        // noise on CI.
        onError: (err) => {
          capturedErrors.push(err);
        },
      },
    );
    live.attachStore(store);
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

  test(
    'file change → watcher → parse → writeBatch → store.emit → subscriber sees session.message.added',
    { timeout: 10000 },
    async () => {
      // Subscribe BEFORE prewarm — the registry keeps the listener
      // alive even when no watcher is attached; the delivery path
      // engages once prewarm attaches the projects/ watcher.
      const topic = { kind: 'session' as const, slug: SLUG, sessionId: SESSION_ID };
      const changePromise = awaitFirstChange(store, topic, DELIVERY_TIMEOUT_MS);

      // Prewarm brings the watcher online. A tiny await so parcel has
      // a chance to bind before we write — belt-and-braces; the
      // pipeline is robust against "write before attach" (the
      // incremental parser will catch the file on the next update
      // event) but this keeps the test deterministic.
      const unprewarm = live.prewarm(topic);
      await new Promise((r) => setTimeout(r, 100));

      writeFileSync(sessionPath, makeUserMessage('uuid-e2e-1', 'hello from C3.3 integration'));

      const change = await changePromise;

      // 1. Payload shape.
      assert.equal(change.type, 'session.message.added');
      if (change.type !== 'session.message.added') return; // narrow
      assert.equal(change.slug, SLUG);
      assert.equal(change.sessionId, SESSION_ID);
      // seq is stamped by the store — must be ≥ 1 for the first emit.
      assert.ok(change.seq >= 1, `seq should be >= 1, got ${change.seq}`);
      assert.equal(typeof change.ts, 'number');

      // 2. SQLite row exists (proves the write went through before
      //    the event fired).
      const row = sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`, SESSION_ID);
      assert.ok(row && row.n >= 1, 'SQLite row should exist alongside the event');

      unprewarm();
    },
  );
});
