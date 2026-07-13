/**
 * multi-source.test.ts — createSpaghettiService ingests two sources into one store.
 *
 * Wires the real Claude `small` fixture plus a synthetic Codex rollout tree via
 * `additionalSources`, initializes once, and asserts the unified index spans
 * both agents: `getSourceIds()` reports both, `getProjectList()` includes each
 * source's projects, and source filtering works. Also checks a warm re-init on
 * the same DB doesn't duplicate.
 *
 * This is the RFC 006 multi-source lifecycle end to end: one shared store, one
 * `LifecycleOwner` per source, reads served by the agent-agnostic coordinator.
 *
 * Run with `pnpm --filter @vibecook/spaghetti-sdk test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { createSpaghettiService } from '../index.js';
import { createCodexSource } from '../sources/index.js';
import type { SpaghettiAPI } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLAUDE_DIR = path.resolve(here, '../../../../crates/spaghetti-napi/fixtures/small/.claude');
const CODEX_SESSION = '019cf46d-0924-7523-b3f5-f6f5cc0fcd16';
const CODEX_CWD = '/tmp/codex-proj';
const CODEX_SLUG = '-tmp-codex-proj';

function writeCodexFixture(codexRoot: string): void {
  const dayDir = path.join(codexRoot, 'sessions', '2026', '07', '13');
  mkdirSync(dayDir, { recursive: true });
  const lines = [
    {
      timestamp: '2026-07-13T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: CODEX_SESSION, cwd: CODEX_CWD, cli_version: '0.91.0', originator: 'codex_cli_rs' },
    },
    {
      timestamp: '2026-07-13T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex hello' }] },
    },
    {
      timestamp: '2026-07-13T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex reply' }] },
    },
  ];
  writeFileSync(
    path.join(dayDir, `rollout-2026-07-13T00-00-00-${CODEX_SESSION}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

describe('multi-source ingest (claude + codex)', () => {
  let spaghetti: SpaghettiAPI;
  let tempDir: string;
  let dbPath: string;
  let codexRoot: string;

  before(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-multi-'));
    dbPath = path.join(tempDir, 'spaghetti.db');
    codexRoot = path.join(tempDir, '.codex');
    writeCodexFixture(codexRoot);

    spaghetti = createSpaghettiService({
      claudeDir: FIXTURE_CLAUDE_DIR,
      additionalSources: [createCodexSource({ rootDir: codexRoot })],
      dbPath,
    });
    await spaghetti.initialize();
  });

  after(() => {
    spaghetti.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('getSourceIds() reports both sources', () => {
    assert.deepEqual(spaghetti.getSourceIds(), ['claude-code', 'codex']);
  });

  test('getProjectList spans both sources', () => {
    const projects = spaghetti.getProjectList();
    const sourceIds = new Set(projects.map((p) => p.sourceId));
    assert.ok(sourceIds.has('claude-code'), 'has claude projects');
    assert.ok(sourceIds.has('codex'), 'has codex projects');

    const codexProject = projects.find((p) => p.sourceId === 'codex');
    assert.ok(codexProject, 'codex project present');
    assert.equal(codexProject.slug, CODEX_SLUG);
  });

  test('the codex session and its messages are queryable', () => {
    // Scoped list — no client-side sourceId filter required once the API
    // threads the agent dimension through.
    const codexSessions = spaghetti.getSessionList(CODEX_SLUG, { sourceId: 'codex' });
    assert.equal(codexSessions.length, 1);
    assert.equal(codexSessions[0].sessionId, CODEX_SESSION);
    assert.equal(codexSessions[0].sourceId, 'codex');

    const { messages } = spaghetti.getSessionMessages(CODEX_SLUG, CODEX_SESSION, 50, 0, {
      sourceId: 'codex',
    });
    const texts = messages.map((m) => JSON.stringify(m));
    assert.ok(
      texts.some((t) => t.includes('codex hello')),
      'user turn present',
    );
    assert.ok(
      texts.some((t) => t.includes('codex reply')),
      'assistant turn present',
    );
  });

  test('getSessionList scopes by sourceId when a slug is shared', () => {
    // Even if only codex owns this slug in the fixture, the API contract is:
    // with sourceId, never return rows from another agent.
    const scoped = spaghetti.getSessionList(CODEX_SLUG, { sourceId: 'codex' });
    assert.ok(scoped.every((s) => s.sourceId === 'codex'));
    const empty = spaghetti.getSessionList(CODEX_SLUG, { sourceId: 'claude-code' });
    assert.equal(empty.length, 0, 'claude scope on a codex-only slug returns nothing');
  });

  test('getProjectMemory is null for non-claude sources', () => {
    assert.equal(spaghetti.getProjectMemory(CODEX_SLUG, { sourceId: 'codex' }), null);
  });

  test('getProjectList filters to the codex source only', () => {
    const codexOnly = spaghetti.getProjectList({ sourceId: 'codex' });
    assert.equal(codexOnly.length, 1);
    assert.equal(codexOnly[0].slug, CODEX_SLUG);
  });

  test('rebuildIndex() preserves BOTH sources (file-delete does not orphan codex)', async () => {
    await spaghetti.rebuildIndex();
    // The whole-DB rebuild fans across owners; every source must come back.
    assert.deepEqual(spaghetti.getSourceIds(), ['claude-code', 'codex']);
    const codexOnly = spaghetti.getProjectList({ sourceId: 'codex' });
    assert.equal(codexOnly.length, 1);
    assert.equal(codexOnly[0].slug, CODEX_SLUG);
    // Claude side still present too.
    assert.ok(spaghetti.getProjectList({ sourceId: 'claude-code' }).length > 0, 'claude projects survive the rebuild');
  });

  test('warm re-init on the same DB does not duplicate', async () => {
    const again = createSpaghettiService({
      claudeDir: FIXTURE_CLAUDE_DIR,
      additionalSources: [createCodexSource({ rootDir: codexRoot })],
      dbPath,
    });
    await again.initialize();
    try {
      assert.equal(again.getProjectList({ sourceId: 'codex' }).length, 1);
    } finally {
      again.shutdown();
    }
  });
});
