/**
 * Unit tests for Claude Code AgentSource + path helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';

import { createClaudeCodeSource, defaultClaudeDir, defaultSpaghettiStateDir } from '../claude-code/index.js';
import { createRuntimeBridge } from '../../planes/runtime-bridge.js';
import { toLifecycleOptions } from '../../planes/static-ingest.js';

describe('createClaudeCodeSource', () => {
  it('defaults root and state to home subdirs', () => {
    const source = createClaudeCodeSource();
    assert.equal(source.id, 'claude-code');
    assert.equal(source.rootDir, defaultClaudeDir());
    assert.equal(source.stateDir, defaultSpaghettiStateDir());
    assert.equal(source.rootDir, path.join(os.homedir(), '.claude'));
    assert.equal(source.stateDir, path.join(os.homedir(), '.spaghetti'));
  });

  it('honors rootDir and stateDir overrides', () => {
    const source = createClaudeCodeSource({
      rootDir: '/tmp/fake-claude',
      stateDir: '/tmp/fake-spaghetti',
    });
    // Derived paths come from path.join, so expectations must too —
    // hardcoded '/'-joined strings fail on Windows.
    assert.equal(source.rootDir, '/tmp/fake-claude');
    assert.equal(source.stateDir, '/tmp/fake-spaghetti');
    assert.equal(source.paths.projectsDir, path.join('/tmp/fake-claude', 'projects'));
    assert.equal(source.paths.hookEventsFile, path.join('/tmp/fake-spaghetti', 'hooks', 'events.jsonl'));
    assert.equal(source.paths.channelSessionsDir, path.join('/tmp/fake-spaghetti', 'channel', 'sessions'));
    assert.equal(source.paths.channelMessagesDir, path.join('/tmp/fake-spaghetti', 'channel', 'messages'));
    assert.equal(source.paths.sessionsDir, path.join('/tmp/fake-claude', 'sessions'));
    assert.equal(source.paths.settingsFile, path.join('/tmp/fake-claude', 'settings.json'));
  });

  it('maps to lifecycle options via StaticIngest helper', () => {
    const source = createClaudeCodeSource({ rootDir: '/data/claude' });
    const opts = toLifecycleOptions({
      source,
      engine: 'ts',
      dbPath: '/tmp/idx.db',
    });
    assert.equal(opts.rootDir, '/data/claude');
    assert.equal(opts.engine, 'ts');
    assert.equal(opts.dbPath, '/tmp/idx.db');
  });

  it('RuntimeBridge exposes source paths and starts stopped', () => {
    const source = createClaudeCodeSource({
      rootDir: '/c',
      stateDir: '/s',
    });
    const bridge = createRuntimeBridge(source);
    assert.equal(bridge.hookEventsPath(), path.join('/s', 'hooks', 'events.jsonl'));
    assert.equal(bridge.channelSessionsDir(), path.join('/s', 'channel', 'sessions'));
    assert.equal(bridge.channelMessagesDir(), path.join('/s', 'channel', 'messages'));
    assert.equal(bridge.source, source);
    assert.equal(bridge.isRunning(), false);
  });
});
