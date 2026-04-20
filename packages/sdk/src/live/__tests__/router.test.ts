/**
 * Router — unit tests (RFC 005 C2.5).
 *
 * Exhaustive coverage of `classify()`:
 *   - Happy case per category (12 branches).
 *   - slug / sessionId extraction correctness.
 *   - Hard-ignore by segment and by suffix.
 *   - Outside-claudeDir rejection.
 *   - Specificity ordering: subagent path wins over session path,
 *     sessions-index.json wins over session.
 *   - Cross-platform: Windows-style backslash paths classify the same
 *     as POSIX paths.
 *   - Structural near-misses: right shape, wrong depth → ignored.
 *
 * Pure function → no async, no timers, no temp dirs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { classify, HARD_IGNORE_SEGMENTS, HARD_IGNORE_SUFFIXES } from '../router.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

const CLAUDE = '/home/user/.claude';

/** POSIX-join helper for readable test inputs. */
const p = (...parts: string[]) => path.posix.join(CLAUDE, ...parts);

// ═══════════════════════════════════════════════════════════════════════════
// HAPPY-CASE: one per category
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — category happy paths', () => {
  test('session: projects/<slug>/<sessionId>.jsonl', () => {
    const r = classify(p('projects/my-proj/abc-123.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'session', slug: 'my-proj', sessionId: 'abc-123' });
  });

  test('session_index: projects/<slug>/sessions-index.json', () => {
    const r = classify(p('projects/my-proj/sessions-index.json'), CLAUDE);
    assert.deepEqual(r, { category: 'session_index', slug: 'my-proj' });
  });

  test('subagent: projects/<slug>/<sessionId>/subagents/agent-*.jsonl', () => {
    const r = classify(p('projects/my-proj/sid-1/subagents/agent-42.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'subagent', slug: 'my-proj', sessionId: 'sid-1' });
  });

  test('tool_result: projects/<slug>/<sessionId>/tool-results/*.txt', () => {
    const r = classify(p('projects/my-proj/sid-1/tool-results/toolu_abc.txt'), CLAUDE);
    assert.deepEqual(r, { category: 'tool_result', slug: 'my-proj', sessionId: 'sid-1' });
  });

  test('project_memory: projects/<slug>/memory/MEMORY.md', () => {
    const r = classify(p('projects/my-proj/memory/MEMORY.md'), CLAUDE);
    assert.deepEqual(r, { category: 'project_memory', slug: 'my-proj' });
  });

  test('file_history: file-history/<sessionId>/<anything>', () => {
    const r = classify(p('file-history/sid-1/abc123@v1'), CLAUDE);
    assert.deepEqual(r, { category: 'file_history', sessionId: 'sid-1' });
  });

  test('todo: todos/<sessionId>-agent-<id>.json', () => {
    const r = classify(p('todos/sid-1-agent-main.json'), CLAUDE);
    assert.deepEqual(r, { category: 'todo', sessionId: 'sid-1' });
  });

  test('task (.lock): tasks/<sessionId>/.lock', () => {
    const r = classify(p('tasks/sid-1/.lock'), CLAUDE);
    assert.deepEqual(r, { category: 'task', sessionId: 'sid-1' });
  });

  test('task (.highwatermark): tasks/<sessionId>/.highwatermark', () => {
    const r = classify(p('tasks/sid-1/.highwatermark'), CLAUDE);
    assert.deepEqual(r, { category: 'task', sessionId: 'sid-1' });
  });

  test('task (N.json): tasks/<sessionId>/7.json', () => {
    const r = classify(p('tasks/sid-1/7.json'), CLAUDE);
    assert.deepEqual(r, { category: 'task', sessionId: 'sid-1' });
  });

  test('plan: plans/*.md', () => {
    const r = classify(p('plans/roadmap.md'), CLAUDE);
    assert.deepEqual(r, { category: 'plan' });
  });

  test('settings: settings.json at claudeDir root', () => {
    const r = classify(p('settings.json'), CLAUDE);
    assert.deepEqual(r, { category: 'settings' });
  });

  test('settings_local: settings.local.json at claudeDir root', () => {
    const r = classify(p('settings.local.json'), CLAUDE);
    assert.deepEqual(r, { category: 'settings_local' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// slug / sessionId extraction
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — identifier extraction', () => {
  test('slug with dashes and digits is preserved verbatim', () => {
    const r = classify(p('projects/p008-spaghetti-2/session-abc.jsonl'), CLAUDE);
    assert.equal(r.slug, 'p008-spaghetti-2');
    assert.equal(r.sessionId, 'session-abc');
  });

  test('uuid-like sessionId is preserved verbatim', () => {
    const uuid = '4a81a14f-9ffc-9412-0da4-42dac6563f30';
    const r = classify(p(`projects/foo/${uuid}.jsonl`), CLAUDE);
    assert.equal(r.category, 'session');
    assert.equal(r.sessionId, uuid);
  });

  test('todo sessionId: everything before the first "-agent-" wins', () => {
    // sessionId contains dashes; splitter finds the first -agent- token.
    const r = classify(p('todos/abc-def-agent-worker.json'), CLAUDE);
    assert.equal(r.category, 'todo');
    assert.equal(r.sessionId, 'abc-def');
  });

  test('subagent agent-* filename variant', () => {
    const r = classify(p('projects/foo/sid/subagents/agent-sub-42.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'subagent', slug: 'foo', sessionId: 'sid' });
  });

  test('percent-encoded slug is decoded', () => {
    // Synthetic case — Claude Code doesn't encode today but the router
    // defensively decodes so future behavior doesn't surprise callers.
    const r = classify(p('projects/my%20proj/abc.jsonl'), CLAUDE);
    assert.equal(r.category, 'session');
    assert.equal(r.slug, 'my proj');
    assert.equal(r.sessionId, 'abc');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HARD IGNORES
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — hard-ignore segments', () => {
  for (const seg of HARD_IGNORE_SEGMENTS) {
    test(`${seg}/ anywhere in path → ignored`, () => {
      const r = classify(p('projects/foo', seg, 'anything.jsonl'), CLAUDE);
      assert.deepEqual(r, { category: 'ignored' });
    });

    test(`top-level ${seg}/ → ignored`, () => {
      const r = classify(p(seg, 'whatever.txt'), CLAUDE);
      assert.deepEqual(r, { category: 'ignored' });
    });
  }

  test('segment that merely contains an ignore substring is NOT ignored', () => {
    // "debugging-notes.md" shouldn't match the `debug` segment — the
    // rule is whole-segment equality, not substring.
    const r = classify(p('plans/debugging-notes.md'), CLAUDE);
    assert.deepEqual(r, { category: 'plan' });
  });
});

describe('classify — hard-ignore suffixes', () => {
  for (const suffix of HARD_IGNORE_SUFFIXES) {
    test(`${suffix} suffix → ignored even inside a recognized category dir`, () => {
      const r = classify(p(`projects/foo/abc${suffix}`), CLAUDE);
      assert.deepEqual(r, { category: 'ignored' });
    });
  }

  test('.DS_Store at claudeDir root → ignored', () => {
    const r = classify(p('.DS_Store'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('atomic-rename .tmp under todos/ → ignored', () => {
    const r = classify(p('todos/sid-agent-x.json.tmp'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OUTSIDE claudeDir
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — defense in depth', () => {
  test('absolute path outside claudeDir → ignored', () => {
    const r = classify('/tmp/unrelated/file.jsonl', CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('sibling of claudeDir → ignored', () => {
    const r = classify('/home/user/.claude-backup/settings.json', CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('claudeDir itself (rel=="") → ignored', () => {
    const r = classify(CLAUDE, CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SPECIFICITY ORDERING
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — most specific rule wins', () => {
  test('subagent path wins over session path with same prefix', () => {
    // `projects/foo/bar.jsonl` is a session; `projects/foo/bar/subagents/agent-x.jsonl`
    // starts with the same two segments but is a subagent. The router
    // must not short-circuit on the session rule.
    const r = classify(p('projects/foo/bar/subagents/agent-x.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'subagent', slug: 'foo', sessionId: 'bar' });
  });

  test('sessions-index.json wins over generic session match', () => {
    // Without ordering, `sessions-index.json` would match the
    // `projects/<slug>/<sessionId>.jsonl` rule as a sessionId of
    // `sessions-index` with a `.json` ext — but since the session
    // rule requires `.jsonl`, this is primarily a guard that the
    // index-specific rule is reached before any accidental fallback.
    const r = classify(p('projects/foo/sessions-index.json'), CLAUDE);
    assert.deepEqual(r, { category: 'session_index', slug: 'foo' });
  });

  test('project_memory wins over anything under projects/<slug>/memory/', () => {
    const r = classify(p('projects/foo/memory/MEMORY.md'), CLAUDE);
    assert.deepEqual(r, { category: 'project_memory', slug: 'foo' });
  });

  test('tool_result wins over any other projects/<slug>/<sid>/* pattern', () => {
    const r = classify(p('projects/foo/sid/tool-results/toolu_xyz.txt'), CLAUDE);
    assert.deepEqual(r, { category: 'tool_result', slug: 'foo', sessionId: 'sid' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-PLATFORM
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — Windows-style paths', () => {
  test('Windows session path with backslashes classifies as session', () => {
    const r = classify('C:\\Users\\x\\.claude\\projects\\foo\\abc.jsonl', 'C:\\Users\\x\\.claude');
    assert.deepEqual(r, { category: 'session', slug: 'foo', sessionId: 'abc' });
  });

  test('Windows subagent path with mixed separators', () => {
    const r = classify('C:\\Users\\x\\.claude\\projects\\foo\\sid\\subagents\\agent-1.jsonl', 'C:\\Users\\x\\.claude');
    assert.deepEqual(r, { category: 'subagent', slug: 'foo', sessionId: 'sid' });
  });

  test('Windows settings.json at root', () => {
    const r = classify('C:\\Users\\x\\.claude\\settings.json', 'C:\\Users\\x\\.claude');
    assert.deepEqual(r, { category: 'settings' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL NEAR-MISSES
// ═══════════════════════════════════════════════════════════════════════════

describe('classify — structural near-misses → ignored', () => {
  test('projects/xxx.jsonl at wrong depth (missing slug) → ignored', () => {
    const r = classify(p('projects/xxx.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('projects/<slug>/something.txt (not .jsonl, not index) → ignored', () => {
    const r = classify(p('projects/foo/readme.txt'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('todos/not-an-agent.json → ignored (missing -agent-)', () => {
    const r = classify(p('todos/not-an-agent.json'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('tasks at root (no sessionId dir) → ignored', () => {
    const r = classify(p('tasks/stray.json'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('plans at nested depth → ignored', () => {
    const r = classify(p('plans/nested/file.md'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('settings.json NOT at root → ignored', () => {
    const r = classify(p('projects/foo/settings.json'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('agent-*.jsonl outside a subagents/ dir → ignored', () => {
    const r = classify(p('projects/foo/sid/agent-loose.jsonl'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('tool-results non-.txt → ignored', () => {
    const r = classify(p('projects/foo/sid/tool-results/weird.bin'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });

  test('file-history root with no sessionId dir → ignored', () => {
    const r = classify(p('file-history/stray.txt'), CLAUDE);
    assert.deepEqual(r, { category: 'ignored' });
  });
});
