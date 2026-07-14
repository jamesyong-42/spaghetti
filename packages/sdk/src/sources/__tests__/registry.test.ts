/**
 * Lifecycle owner registry — Phase E.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createSqliteService } from '../../io/sqlite-service.js';
import { createConsoleErrorSink } from '../../io/error-sink.js';
import { createDurableStore } from '../../store/durable-store.js';
import {
  createClaudeCodeSource,
  createCodexSource,
  createGrokSource,
  createLifecycleOwnerForSource,
  isLifecycleOwnerRegistered,
  registeredLifecycleOwnerIds,
} from '../index.js';

describe('lifecycle owner registry', () => {
  test('registers claude-code, codex, and grok', () => {
    const ids = registeredLifecycleOwnerIds().sort();
    assert.deepEqual(ids, ['claude-code', 'codex', 'grok']);
    assert.equal(isLifecycleOwnerRegistered('claude-code'), true);
    assert.equal(isLifecycleOwnerRegistered('codex'), true);
    assert.equal(isLifecycleOwnerRegistered('grok'), true);
    assert.equal(isLifecycleOwnerRegistered('unknown-agent'), false);
  });

  test('createLifecycleOwnerForSource builds an owner per known source', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'spag-registry-'));
    const dbPath = path.join(tempDir, 't.db');
    try {
      const fileService = createFileService();
      const sqlite = createSqliteService();
      const store = createDurableStore({ sqlite, engine: 'ts', native: null });
      const errorSink = createConsoleErrorSink('[test]');

      for (const source of [
        createClaudeCodeSource({ rootDir: path.join(tempDir, '.claude') }),
        createCodexSource({ rootDir: path.join(tempDir, '.codex') }),
        createGrokSource({ rootDir: path.join(tempDir, '.grok') }),
      ]) {
        const owner = createLifecycleOwnerForSource({
          source,
          fileService,
          store,
          dbPath,
          errorSink,
          live: false,
          engine: 'ts',
          native: null,
        });
        assert.ok(owner, `expected owner for ${source.id}`);
        assert.equal(owner!.sourceId, source.id);
      }

      const unknown = createLifecycleOwnerForSource({
        source: {
          id: 'unknown-agent' as 'codex',
          rootDir: tempDir,
          stateDir: tempDir,
          paths: createClaudeCodeSource().paths,
          classify: () => ({ category: 'ignored' }),
          messages: { extract: () => null },
        },
        fileService,
        store,
        dbPath,
        errorSink,
        live: false,
        engine: 'ts',
        native: null,
      });
      assert.equal(unknown, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
