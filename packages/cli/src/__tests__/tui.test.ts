import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseKeypress } from '../lib/tui.js';

describe('parseKeypress', () => {
  test('parses up arrow', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x1b, 0x5b, 0x41])), 'up');
  });

  test('parses down arrow', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x1b, 0x5b, 0x42])), 'down');
  });

  test('parses enter', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x0d])), 'enter');
  });

  test('parses escape', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x1b])), 'escape');
  });

  test('parses q', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x71])), 'q');
  });

  test('parses ctrl+c', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x03])), 'ctrl-c');
  });

  test('returns null for unknown input', () => {
    assert.strictEqual(parseKeypress(Buffer.from([0x61])), null); // 'a'
  });
});
