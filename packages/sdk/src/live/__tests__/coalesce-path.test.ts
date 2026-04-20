/**
 * coalesce-path — unit tests for the watcher-event path coalescer
 * (RFC 005 C5.2).
 *
 * `coalescePath` is a pure helper at module scope (extracted from the
 * `LiveUpdates` orchestrator so tests can hit it without spinning up
 * the full pipeline). For task-category routes it collapses every
 * file under `tasks/<sid>/` onto a single `.coalesced` synthetic
 * filename so the CoalescingQueue's path-dedup folds bursts of rapid
 * edits into one queued entry. Every other category passes the input
 * path through unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { coalescePath, TASK_COALESCE_FILENAME } from '../live-updates.js';
import type { RouteResult } from '../router.js';

const CLAUDE_DIR = '/tmp/claude';

describe('coalescePath (RFC 005 C5.2)', () => {
  test('task with sessionId → collapses to <claudeDir>/tasks/<sid>/.coalesced', () => {
    const route: RouteResult = { category: 'task', sessionId: 's1' };
    const out = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's1', '.lock'), route, CLAUDE_DIR);
    assert.equal(out, path.join(CLAUDE_DIR, 'tasks', 's1', TASK_COALESCE_FILENAME));
  });

  test('task event on .highwatermark coalesces to the same path as .lock', () => {
    const route: RouteResult = { category: 'task', sessionId: 's1' };
    const a = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's1', '.lock'), route, CLAUDE_DIR);
    const b = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's1', '.highwatermark'), route, CLAUDE_DIR);
    const c = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's1', '7.json'), route, CLAUDE_DIR);
    assert.equal(a, b, '.lock and .highwatermark coalesce together');
    assert.equal(a, c, 'numbered N.json files coalesce too');
  });

  test('two task sessions stay separate', () => {
    const r1: RouteResult = { category: 'task', sessionId: 's1' };
    const r2: RouteResult = { category: 'task', sessionId: 's2' };
    const a = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's1', '.lock'), r1, CLAUDE_DIR);
    const b = coalescePath(path.join(CLAUDE_DIR, 'tasks', 's2', '.lock'), r2, CLAUDE_DIR);
    assert.notEqual(a, b);
    assert.match(a, /tasks\/s1\/\.coalesced$/);
    assert.match(b, /tasks\/s2\/\.coalesced$/);
  });

  test('task without sessionId → identity (defensive: should not happen in practice)', () => {
    // The router's `task` category always carries a sessionId, but
    // the helper guards on it explicitly. A misclassified input
    // returns the original path unchanged.
    const route: RouteResult = { category: 'task' } as RouteResult;
    const input = path.join(CLAUDE_DIR, 'tasks', 'whatever.txt');
    assert.equal(coalescePath(input, route, CLAUDE_DIR), input);
  });

  test('non-task categories → identity', () => {
    const cases: Array<[RouteResult['category'], string]> = [
      ['session', path.join(CLAUDE_DIR, 'projects', 'slug', 'sess.jsonl')],
      ['todo', path.join(CLAUDE_DIR, 'todos', 'sess-agent-a0.json')],
      ['plan', path.join(CLAUDE_DIR, 'plans', 'abc.md')],
      ['file_history', path.join(CLAUDE_DIR, 'file-history', 'sess', 'abc@v1')],
      ['settings', path.join(CLAUDE_DIR, 'settings.json')],
      ['settings_local', path.join(CLAUDE_DIR, 'settings.local.json')],
      ['session_index', path.join(CLAUDE_DIR, 'projects', 'slug', 'sessions-index.json')],
      ['subagent', path.join(CLAUDE_DIR, 'projects', 'slug', 'sess', 'subagents', 'agent-a0.jsonl')],
      ['tool_result', path.join(CLAUDE_DIR, 'projects', 'slug', 'sess', 'tool-results', 'abc.txt')],
      ['project_memory', path.join(CLAUDE_DIR, 'projects', 'slug', 'memory', 'MEMORY.md')],
    ];
    for (const [category, input] of cases) {
      const route: RouteResult = { category } as RouteResult;
      assert.equal(coalescePath(input, route, CLAUDE_DIR), input, `category=${category} should pass through`);
    }
  });

  test('respects a non-default claudeDir', () => {
    const route: RouteResult = { category: 'task', sessionId: 's1' };
    const alt = '/var/tmp/some/other/.claude';
    const out = coalescePath(path.join(alt, 'tasks', 's1', '.lock'), route, alt);
    assert.equal(out, path.join(alt, 'tasks', 's1', TASK_COALESCE_FILENAME));
  });
});
