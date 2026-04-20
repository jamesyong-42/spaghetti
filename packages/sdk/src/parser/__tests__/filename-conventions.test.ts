/**
 * filename-conventions — pure-helper unit tests (RFC 005).
 *
 * Both the cold-start (`project-parser.ts`) and live tail
 * (`live/incremental-parser.ts`) consume these helpers, so each
 * convention has an exhaustive set of edge cases pinned here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSubagentFilename,
  inferSubagentType,
  parseTodoFilename,
  parseFileHistoryFilename,
  parsePlanFilename,
} from '../filename-conventions.js';

// ═══════════════════════════════════════════════════════════════════════════
// SUBAGENT
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSubagentFilename', () => {
  test('matches `agent-<id>.jsonl` with leading-`a` agentId', () => {
    const r = parseSubagentFilename('agent-a0.jsonl');
    assert.deepEqual(r, { agentId: 'a0', agentType: 'task' });
  });

  test('matches multi-character agentId', () => {
    const r = parseSubagentFilename('agent-abc123.jsonl');
    assert.deepEqual(r, { agentId: 'abc123', agentType: 'task' });
  });

  test('infers `prompt_suggestion` from filename substring', () => {
    const r = parseSubagentFilename('agent-a-prompt_suggestion-1.jsonl');
    assert.equal(r?.agentType, 'prompt_suggestion');
  });

  test('infers `compact` from filename substring', () => {
    const r = parseSubagentFilename('agent-a-compact-2.jsonl');
    assert.equal(r?.agentType, 'compact');
  });

  test('returns null when agentId does not start with `a`', () => {
    assert.equal(parseSubagentFilename('agent-b1.jsonl'), null);
  });

  test('returns null without the `agent-` prefix', () => {
    assert.equal(parseSubagentFilename('a0.jsonl'), null);
  });

  test('returns null without the `.jsonl` extension', () => {
    assert.equal(parseSubagentFilename('agent-a0'), null);
  });

  test('returns null on empty string', () => {
    assert.equal(parseSubagentFilename(''), null);
  });

  test('returns null on path-like input (slashes)', () => {
    assert.equal(parseSubagentFilename('subagents/agent-a0.jsonl'), null);
  });
});

describe('inferSubagentType (standalone)', () => {
  test('defaults to `task`', () => {
    assert.equal(inferSubagentType('agent-a0.jsonl'), 'task');
  });
  test('detects compact', () => {
    assert.equal(inferSubagentType('agent-compact-x.jsonl'), 'compact');
  });
  test('detects prompt_suggestion', () => {
    assert.equal(inferSubagentType('agent-prompt_suggestion-y.jsonl'), 'prompt_suggestion');
  });
  test('compact wins over default but not over prompt_suggestion (current rule order)', () => {
    // The current rule order checks prompt_suggestion first, so a file
    // with both substrings classifies as `prompt_suggestion`.
    assert.equal(inferSubagentType('agent-prompt_suggestion-compact.jsonl'), 'prompt_suggestion');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TODO
// ═══════════════════════════════════════════════════════════════════════════

describe('parseTodoFilename', () => {
  test('matches a basic <session>-agent-<agentId>.json', () => {
    const r = parseTodoFilename('s1-agent-a0.json');
    assert.deepEqual(r, { sessionId: 's1', agentId: 'a0' });
  });

  test('matches a UUID-shaped session id', () => {
    const r = parseTodoFilename('11111111-2222-3333-4444-555555555555-agent-a9.json');
    assert.deepEqual(r, {
      sessionId: '11111111-2222-3333-4444-555555555555',
      agentId: 'a9',
    });
  });

  test('handles agentId that itself contains -agent-', () => {
    const r = parseTodoFilename('s1-agent-myagent-with-hyphens.json');
    assert.equal(r?.sessionId, 's1');
    assert.equal(r?.agentId, 'myagent-with-hyphens');
  });

  test('returns null without -agent- separator', () => {
    assert.equal(parseTodoFilename('s1-a0.json'), null);
  });

  test('returns null without .json extension', () => {
    assert.equal(parseTodoFilename('s1-agent-a0'), null);
  });

  test('returns null on empty string', () => {
    assert.equal(parseTodoFilename(''), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FILE HISTORY
// ═══════════════════════════════════════════════════════════════════════════

describe('parseFileHistoryFilename', () => {
  test('matches `<hash>@v<version>` form', () => {
    const r = parseFileHistoryFilename('abc@v1');
    assert.deepEqual(r, { hash: 'abc', version: 1, fileName: 'abc@v1' });
  });

  test('matches multi-character hex hash', () => {
    const r = parseFileHistoryFilename('deadbeef0123@v42');
    assert.deepEqual(r, { hash: 'deadbeef0123', version: 42, fileName: 'deadbeef0123@v42' });
  });

  test('matches `<hash>@v<version>.<ext>` form', () => {
    const r = parseFileHistoryFilename('abc@v3.json');
    assert.deepEqual(r, { hash: 'abc', version: 3, fileName: 'abc@v3.json' });
  });

  test('preserves the basename in `fileName`', () => {
    const r = parseFileHistoryFilename('cafebabe@v7.txt');
    assert.equal(r?.fileName, 'cafebabe@v7.txt');
  });

  test('returns null on uppercase hex (convention is lowercase)', () => {
    assert.equal(parseFileHistoryFilename('ABC@v1'), null);
  });

  test('returns null on non-hex hash', () => {
    assert.equal(parseFileHistoryFilename('zzz@v1'), null);
  });

  test('returns null without @v separator', () => {
    assert.equal(parseFileHistoryFilename('abc-v1'), null);
  });

  test('returns null without numeric version', () => {
    assert.equal(parseFileHistoryFilename('abc@vX'), null);
  });

  test('returns null on empty string', () => {
    assert.equal(parseFileHistoryFilename(''), null);
  });

  test('handles version 0', () => {
    const r = parseFileHistoryFilename('abc@v0');
    assert.deepEqual(r, { hash: 'abc', version: 0, fileName: 'abc@v0' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PLAN
// ═══════════════════════════════════════════════════════════════════════════

describe('parsePlanFilename', () => {
  test('extracts slug from `<slug>.md`', () => {
    assert.deepEqual(parsePlanFilename('hello.md'), { slug: 'hello' });
  });

  test('handles slug with hyphens', () => {
    assert.deepEqual(parsePlanFilename('my-plan-001.md'), { slug: 'my-plan-001' });
  });

  test('handles slug with dots (preserves all but the last `.md`)', () => {
    assert.deepEqual(parsePlanFilename('foo.bar.md'), { slug: 'foo.bar' });
  });

  test('returns null without .md extension', () => {
    assert.equal(parsePlanFilename('hello'), null);
  });

  test('returns null on empty string', () => {
    assert.equal(parsePlanFilename(''), null);
  });

  test('returns null on .md only (no slug)', () => {
    // The convention requires a non-empty slug.
    assert.equal(parsePlanFilename('.md'), null);
  });

  test('does not match other markdown extensions', () => {
    assert.equal(parsePlanFilename('hello.markdown'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PERCENT-ENCODING / EXOTIC INPUT
// ═══════════════════════════════════════════════════════════════════════════

describe('exotic inputs across all helpers', () => {
  test('percent-encoded characters are treated as literals (no decoding here)', () => {
    // Helpers operate on raw basenames; decoding is the caller's
    // responsibility. A `%2F` in a filename is not interpreted as a
    // path separator.
    const r = parseTodoFilename('sess%2Fid-agent-a0.json');
    assert.equal(r?.sessionId, 'sess%2Fid');
    assert.equal(r?.agentId, 'a0');
  });

  test('unicode in agentIds is allowed', () => {
    const r = parseSubagentFilename('agent-a-名前.jsonl');
    assert.equal(r?.agentId, 'a-名前');
  });

  test('whitespace inside the basename does not match', () => {
    // We never expect spaces in these conventions; the regexes are
    // strict on the boundaries.
    assert.equal(parseFileHistoryFilename('abc def@v1'), null);
  });
});
