import { test, describe } from 'node:test';
import assert from 'node:assert';
import { UserError, noProjectMatch, noSessionMatch } from '../lib/error.js';

describe('UserError', () => {
  test('is an instance of Error', () => {
    const err = new UserError('test message');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof UserError);
  });

  test('stores message', () => {
    const err = new UserError('something went wrong');
    assert.strictEqual(err.message, 'something went wrong');
  });

  test('stores suggestion', () => {
    const err = new UserError('not found', 'try again');
    assert.strictEqual(err.suggestion, 'try again');
  });

  test('has name set to UserError', () => {
    const err = new UserError('test');
    assert.strictEqual(err.name, 'UserError');
  });

  test('suggestion is undefined when not provided', () => {
    const err = new UserError('test');
    assert.strictEqual(err.suggestion, undefined);
  });
});

describe('noProjectMatch', () => {
  test('creates UserError with suggestions', () => {
    const err = noProjectMatch('spag', [
      { folderName: 'spaghetti', sessionCount: 10 },
    ]);
    assert.ok(err instanceof UserError);
    assert.ok(err.message.includes('spag'));
    assert.ok(err.suggestion?.includes('spaghetti'));
  });

  test('creates UserError without suggestions', () => {
    const err = noProjectMatch('zzz', []);
    assert.ok(err instanceof UserError);
    assert.ok(err.message.includes('zzz'));
    assert.ok(err.suggestion?.includes('spaghetti projects'));
  });
});

describe('noSessionMatch', () => {
  test('creates UserError with project hint', () => {
    const err = noSessionMatch('abc123', 'myproject');
    assert.ok(err instanceof UserError);
    assert.ok(err.message.includes('abc123'));
    assert.ok(err.suggestion?.includes('myproject'));
  });

  test('creates UserError without project name', () => {
    const err = noSessionMatch('abc123');
    assert.ok(err instanceof UserError);
    assert.ok(err.message.includes('abc123'));
    assert.ok(err.suggestion?.includes('UUID prefix'));
  });
});
