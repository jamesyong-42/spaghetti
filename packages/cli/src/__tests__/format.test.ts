import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatTokens, formatBytes, formatDuration, formatNumber } from '../lib/format.js';

describe('formatTokens', () => {
  test('formats millions', () => assert.strictEqual(formatTokens(1_200_000), '1.2M'));
  test('formats thousands', () => assert.strictEqual(formatTokens(892_000), '892.0K'));
  test('formats small numbers', () => assert.strictEqual(formatTokens(42), '42'));
  test('handles zero', () => assert.strictEqual(formatTokens(0), '0'));
});

describe('formatBytes', () => {
  test('formats MB', () => assert.strictEqual(formatBytes(3_200_000), '3.1 MB'));
  test('formats KB', () => assert.strictEqual(formatBytes(892_000), '871.1 KB'));
  test('formats bytes', () => assert.strictEqual(formatBytes(500), '500 B'));
  test('handles zero', () => assert.strictEqual(formatBytes(0), '0 B'));
});

describe('formatDuration', () => {
  test('formats hours and minutes', () => assert.strictEqual(formatDuration(8040000), '2h 14m'));
  test('formats minutes and seconds', () => assert.strictEqual(formatDuration(2700000), '45m 0s'));
  test('formats seconds', () => assert.strictEqual(formatDuration(5000), '5s'));
  test('handles zero', () => assert.strictEqual(formatDuration(0), '0s'));
});

describe('formatNumber', () => {
  test('adds commas', () => assert.strictEqual(formatNumber(186432), '186,432'));
  test('handles small numbers', () => assert.strictEqual(formatNumber(42), '42'));
  test('handles zero', () => assert.strictEqual(formatNumber(0), '0'));
});
