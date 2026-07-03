/**
 * config-parser-settings-local.test.ts — settings.local.json promotion.
 *
 * The 2026-07 audit found settings.local.json was read in the live path
 * but never promoted into AgentConfig at cold start, so displayed
 * permissions omitted its entries. These assert the cold-start parser
 * now surfaces it (and leaves it null when absent).
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

import { createFileService } from '../../io/file-service.js';
import { createConfigParser } from '../config-parser.js';
import type { ConfigParser } from '../config-parser.js';

describe('ConfigParser settings.local.json', () => {
  let tempDir: string;
  let parser: ConfigParser;
  let claudeDir: string;

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'spaghetti-slocal-'));
    parser = createConfigParser(createFileService());
  });

  after(() => rmSync(tempDir, { recursive: true, force: true }));

  beforeEach((t) => {
    claudeDir = path.join(tempDir, t.name.replace(/[^a-zA-Z0-9]/g, '_'));
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  });

  test('settings.local.json is parsed into config.settingsLocal', () => {
    writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git*)'] }, skipAutoPermissionPrompt: true }),
    );

    const config = parser.parseConfig(claudeDir);

    assert.deepEqual(config.settings.permissions.allow, ['Read']);
    assert.ok(config.settingsLocal, 'settingsLocal should be present');
    assert.deepEqual(config.settingsLocal?.permissions.allow, ['Bash(git*)']);
    assert.equal(config.settingsLocal?.skipAutoPermissionPrompt, true);
  });

  test('settingsLocal is null when the file is absent', () => {
    const config = parser.parseConfig(claudeDir);
    assert.equal(config.settingsLocal, null);
  });

  test('empty() seeds settingsLocal: null', () => {
    assert.equal(parser.empty().settingsLocal, null);
  });

  test('new settings.json keys are typed on SettingsFile', () => {
    writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: [] },
        tui: 'fullscreen',
        autoCompactEnabled: false,
        agentPushNotifEnabled: true,
        skipWorkflowUsageWarning: true,
      }),
    );
    const s = parser.parseConfig(claudeDir).settings;
    assert.equal(s.tui, 'fullscreen');
    assert.equal(s.autoCompactEnabled, false);
    assert.equal(s.agentPushNotifEnabled, true);
    assert.equal(s.skipWorkflowUsageWarning, true);
  });
});
