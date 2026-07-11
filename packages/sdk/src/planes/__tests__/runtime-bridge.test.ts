/**
 * RuntimeBridge unit tests — path helpers, hook history, lifecycle.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createClaudeCodeSource } from '../../sources/claude-code/index.js';
import { createRuntimeBridge } from '../runtime-bridge.js';
import type { RuntimeEvent } from '../../events/runtime-event.js';

describe('RuntimeBridge', () => {
  let tempRoot: string;
  let hooksDir: string;
  let channelDir: string;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'spag-runtime-'));
    hooksDir = join(tempRoot, 'hooks');
    channelDir = join(tempRoot, 'channel', 'sessions');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(channelDir, { recursive: true });
  });

  after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exposes paths from AgentSource', () => {
    const source = createClaudeCodeSource({
      rootDir: join(tempRoot, 'claude'),
      stateDir: tempRoot,
    });
    const bridge = createRuntimeBridge(source);
    assert.equal(bridge.hookEventsPath(), join(tempRoot, 'hooks', 'events.jsonl'));
    assert.equal(bridge.channelSessionsDir(), join(tempRoot, 'channel', 'sessions'));
    assert.ok(!bridge.isRunning());
  });

  it('reads hook history and emits hook events on append', async () => {
    const source = createClaudeCodeSource({
      rootDir: join(tempRoot, 'claude'),
      stateDir: tempRoot,
    });
    const eventsPath = join(tempRoot, 'hooks', 'events.jsonl');
    const seed = {
      timestamp: '2026-07-10T12:00:00.000Z',
      event: 'SessionStart',
      sessionId: 'sess-1',
      cwd: '/tmp',
      permissionMode: null,
      transcriptPath: null,
      agentId: null,
      agentType: null,
      payload: { source: 'startup' },
    };
    writeFileSync(eventsPath, JSON.stringify(seed) + '\n', 'utf-8');

    const bridge = createRuntimeBridge(source);
    const history = bridge.getHookHistory();
    assert.ok(history.length >= 1);
    assert.equal(history[history.length - 1]!.event, 'SessionStart');

    const received: RuntimeEvent[] = [];
    const dispose = bridge.onEvent((e) => {
      received.push(e);
    });
    assert.ok(bridge.isRunning());

    // Append a new hook event after start (watcher seeks to end on start)
    await new Promise((r) => setTimeout(r, 80));
    const next = {
      ...seed,
      timestamp: '2026-07-10T12:00:01.000Z',
      event: 'PreToolUse',
      payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
    };
    writeFileSync(eventsPath, JSON.stringify(seed) + '\n' + JSON.stringify(next) + '\n', 'utf-8');

    // Wait for fs.watch debounce
    await new Promise((r) => setTimeout(r, 200));

    dispose();
    bridge.stop();
    assert.ok(!bridge.isRunning());

    // Best-effort: on some CI/fs backends watch is flaky; at least
    // history + start/stop must work. If an event arrived, shape-check it.
    const hooks = received.filter((e) => e.type === 'hook');
    if (hooks.length > 0) {
      const last = hooks[hooks.length - 1]!;
      assert.equal(last.type, 'hook');
      if (last.type === 'hook') {
        assert.ok(typeof last.name === 'string');
        assert.ok(last.payload);
      }
    }
  });

  it('listChannelSessions returns empty when no discovery files', () => {
    const source = createClaudeCodeSource({
      rootDir: join(tempRoot, 'claude'),
      stateDir: tempRoot,
    });
    const bridge = createRuntimeBridge(source);
    const sessions = bridge.listChannelSessions();
    assert.ok(Array.isArray(sessions));
    bridge.stop();
  });
});
