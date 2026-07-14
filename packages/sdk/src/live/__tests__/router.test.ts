/**
 * Compatibility: live/router re-exports Claude classify for legacy imports.
 * Full coverage lives in sources/claude-code/__tests__/classify.test.ts.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, type Category, type RouteResult } from '../router.js';

describe('live/router re-exports Claude classify (compat)', () => {
  test('classify still works via live/router path', () => {
    const r = classify('/home/u/.claude/settings.json', '/home/u/.claude');
    assert.equal(r.category, 'settings');
  });

  test('types are exportable', () => {
    const cat: Category = 'session';
    const res: RouteResult = { category: cat, sessionId: 'x' };
    assert.equal(res.category, 'session');
  });
});
