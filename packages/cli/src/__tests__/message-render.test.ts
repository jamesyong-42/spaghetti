import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderMarkdownText, stripMarkdownInline } from '../lib/message-render.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const hasAnsi = (s: string): boolean => stripAnsi(s).length !== s.length;

describe('renderMarkdownText', () => {
  test('returns a string array', () => {
    const lines = renderMarkdownText('hello world', 40);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length >= 1);
  });

  test('styles bold text with ANSI codes', () => {
    const lines = renderMarkdownText('**bold**', 40);
    const joined = lines.join('\n');
    assert.ok(hasAnsi(joined), 'expected ANSI escape codes');
    assert.match(stripAnsi(joined), /bold/);
    assert.doesNotMatch(stripAnsi(joined), /\*\*/);
  });

  test('styles headings', () => {
    const lines = renderMarkdownText('# Hello', 40);
    const joined = lines.join('\n');
    assert.ok(hasAnsi(joined), 'expected ANSI escape codes');
    assert.match(stripAnsi(joined), /Hello/);
  });

  test('renders code blocks', () => {
    const input = '```\nconst x = 1;\n```';
    const lines = renderMarkdownText(input, 40);
    const joined = stripAnsi(lines.join('\n'));
    assert.match(joined, /const x = 1;/);
  });

  test('does not produce trailing blank lines', () => {
    const lines = renderMarkdownText('paragraph', 40);
    assert.notEqual(lines[lines.length - 1], '');
  });

  test('handles plain text (no markdown)', () => {
    const lines = renderMarkdownText('just a sentence.', 40);
    assert.match(stripAnsi(lines.join('\n')), /just a sentence\./);
  });
});

describe('stripMarkdownInline', () => {
  test('strips bold markers', () => {
    assert.equal(stripMarkdownInline('hello **world**'), 'hello world');
  });

  test('strips italic markers', () => {
    assert.equal(stripMarkdownInline('hello *world*'), 'hello world');
    assert.equal(stripMarkdownInline('hello _world_'), 'hello world');
  });

  test('strips headings', () => {
    assert.equal(stripMarkdownInline('## Title'), 'Title');
  });

  test('strips list bullets', () => {
    assert.equal(stripMarkdownInline('- item one\n- item two'), 'item one\nitem two');
    assert.equal(stripMarkdownInline('1. first\n2. second'), 'first\nsecond');
  });

  test('strips inline code', () => {
    assert.equal(stripMarkdownInline('run `foo` now'), 'run foo now');
  });

  test('replaces fenced code blocks with a marker', () => {
    const out = stripMarkdownInline('before\n```\nx\n```\nafter');
    assert.match(out, /\[code\]/);
    assert.doesNotMatch(out, /```/);
  });

  test('strips link targets, keeps label', () => {
    assert.equal(stripMarkdownInline('see [docs](https://x.com) please'), 'see docs please');
  });

  test('strips blockquotes', () => {
    assert.equal(stripMarkdownInline('> quoted line'), 'quoted line');
  });
});
