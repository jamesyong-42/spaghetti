/**
 * analytics-session-env.test.ts — session-env sessionstart-hook script listing.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createAnalyticsParser } from '../analytics-parser.js';
import type { AnalyticsParser } from '../analytics-parser.js';

describe('AnalyticsParser session-env', () => {
  let tempDir: string;
  let claudeDir: string;
  let parser: AnalyticsParser;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-senv-'));
    parser = createAnalyticsParser(createFileService());
  });
  after(() => rmSync(tempDir, { recursive: true, force: true }));

  beforeEach((t) => {
    claudeDir = path.join(tempDir, t.name.replace(/[^a-zA-Z0-9]/g, '_'));
    mkdirSync(path.join(claudeDir, 'session-env'), { recursive: true });
  });

  test('lists sessionstart-hook scripts per session, sorted', () => {
    const envDir = path.join(claudeDir, 'session-env');
    const s1 = path.join(envDir, 'sess-aaaa');
    mkdirSync(s1);
    writeFileSync(path.join(s1, 'sessionstart-hook-5.sh'), 'echo 5');
    writeFileSync(path.join(s1, 'sessionstart-hook-2.sh'), 'echo 2');
    mkdirSync(path.join(envDir, 'sess-bbbb')); // no scripts

    const entries = parser.parseAnalytics(claudeDir).sessionEnv.entries;
    const byId = Object.fromEntries(entries.map((e) => [e.sessionId, e.scripts]));
    assert.deepEqual(byId['sess-aaaa'], ['sessionstart-hook-2.sh', 'sessionstart-hook-5.sh']);
    assert.deepEqual(byId['sess-bbbb'], []);
  });

  test('a stray file under session-env/ does not break the scan', () => {
    // Regression: mapping a non-dir entry as a directory threw ENOTDIR
    // and dropped every entry.
    const envDir = path.join(claudeDir, 'session-env');
    mkdirSync(path.join(envDir, 'sess-cccc'));
    writeFileSync(path.join(envDir, '.DS_Store'), 'junk');

    const entries = parser.parseAnalytics(claudeDir).sessionEnv.entries;
    assert.deepEqual(
      entries.map((e) => e.sessionId),
      ['sess-cccc'],
    );
  });
});
