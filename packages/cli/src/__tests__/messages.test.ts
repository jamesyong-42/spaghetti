import { test, describe } from 'node:test';
import assert from 'node:assert';
import { hasMoreToShow } from '../commands/messages.js';

describe('hasMoreToShow — head view (default / --offset)', () => {
  test('true when raw pages have more', () => {
    assert.strictEqual(hasMoreToShow({ isLast: false, offset: 0, trimmedMore: false, rawHasMore: true }), true);
  });

  test('true when over-fetched messages were trimmed', () => {
    assert.strictEqual(hasMoreToShow({ isLast: false, offset: 0, trimmedMore: true, rawHasMore: false }), true);
  });

  test('false when the full page fits and no more raw', () => {
    assert.strictEqual(hasMoreToShow({ isLast: false, offset: 0, trimmedMore: false, rawHasMore: false }), false);
  });
});

describe('hasMoreToShow — tail view (--last)', () => {
  test('false when the whole session fits and the newest message is shown', () => {
    // Regression: the tail filled the display limit but nothing older exists
    // (offset 0, nothing trimmed) — rawHasMore must NOT trigger "more available".
    assert.strictEqual(hasMoreToShow({ isLast: true, offset: 0, trimmedMore: false, rawHasMore: true }), false);
  });

  test('true when older messages were never fetched', () => {
    assert.strictEqual(hasMoreToShow({ isLast: true, offset: 5, trimmedMore: false, rawHasMore: false }), true);
  });

  test('true when older filtered messages were trimmed off the front', () => {
    assert.strictEqual(hasMoreToShow({ isLast: true, offset: 0, trimmedMore: true, rawHasMore: false }), true);
  });
});
