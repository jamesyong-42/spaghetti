import { test, describe } from 'node:test';
import assert from 'node:assert';
import { resolveLimit, resolveOffset, resolveOptionalCount } from '../lib/limit.js';

describe('resolveLimit', () => {
  test('returns a positive finite value', () => {
    assert.strictEqual(resolveLimit(10, 20), 10);
  });

  test('falls back on undefined', () => {
    assert.strictEqual(resolveLimit(undefined, 20), 20);
  });

  test('falls back on NaN (commander parseInt of garbage)', () => {
    assert.strictEqual(resolveLimit(NaN, 20), 20);
  });

  test('falls back on zero', () => {
    assert.strictEqual(resolveLimit(0, 20), 20);
  });

  test('falls back on negative', () => {
    assert.strictEqual(resolveLimit(-5, 20), 20);
  });

  test('falls back on Infinity', () => {
    assert.strictEqual(resolveLimit(Infinity, 20), 20);
  });
});

describe('resolveOffset', () => {
  test('returns a non-negative finite value', () => {
    assert.strictEqual(resolveOffset(5), 5);
  });

  test('allows zero', () => {
    assert.strictEqual(resolveOffset(0), 0);
  });

  test('falls back to 0 on undefined', () => {
    assert.strictEqual(resolveOffset(undefined), 0);
  });

  test('falls back on NaN', () => {
    assert.strictEqual(resolveOffset(NaN), 0);
  });

  test('falls back on negative', () => {
    assert.strictEqual(resolveOffset(-1), 0);
  });

  test('honours a custom fallback', () => {
    assert.strictEqual(resolveOffset(NaN, 3), 3);
  });
});

describe('resolveOptionalCount', () => {
  test('returns a positive finite value', () => {
    assert.strictEqual(resolveOptionalCount(7), 7);
  });

  test('returns undefined when absent', () => {
    assert.strictEqual(resolveOptionalCount(undefined), undefined);
  });

  test('returns undefined for NaN (--last garbage)', () => {
    assert.strictEqual(resolveOptionalCount(NaN), undefined);
  });

  test('returns undefined for zero and negatives', () => {
    assert.strictEqual(resolveOptionalCount(0), undefined);
    assert.strictEqual(resolveOptionalCount(-3), undefined);
  });
});
