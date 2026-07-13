/**
 * Unit tests for parseCodexTokenCount.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexTokenCount } from '../codex/token-usage.js';

describe('parseCodexTokenCount', () => {
  test('returns null for non-token_count lines', () => {
    assert.equal(parseCodexTokenCount({ type: 'session_meta', payload: {} }), null);
    assert.equal(
      parseCodexTokenCount({
        type: 'response_item',
        payload: { type: 'message', role: 'user' },
      }),
      null,
    );
    assert.equal(parseCodexTokenCount({ type: 'event_msg', payload: { type: 'task_complete' } }), null);
  });

  test('returns null when info is null (rate-limits only)', () => {
    assert.equal(
      parseCodexTokenCount({
        type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: {} },
      }),
      null,
    );
  });

  test('maps total + last usage into Spaghetti token columns', () => {
    const parsed = parseCodexTokenCount({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 800,
            output_tokens: 50,
            reasoning_output_tokens: 20,
            total_tokens: 1070,
          },
          last_token_usage: {
            input_tokens: 200,
            cached_input_tokens: 150,
            output_tokens: 10,
            reasoning_output_tokens: 5,
            total_tokens: 215,
          },
          model_context_window: 200_000,
        },
      },
    });
    assert.ok(parsed);
    assert.equal(parsed!.last?.inputTokens, 200);
    assert.equal(parsed!.last?.cacheReadTokens, 150);
    assert.equal(parsed!.last?.outputTokens, 15); // 10 + 5 reasoning
    assert.equal(parsed!.last?.cacheCreationTokens, 0);
    assert.equal(parsed!.total?.inputTokens, 1000);
    assert.equal(parsed!.total?.outputTokens, 70);
    assert.equal(parsed!.total?.totalTokens, 1070);
  });
});
