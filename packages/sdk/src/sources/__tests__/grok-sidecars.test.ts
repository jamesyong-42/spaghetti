/**
 * Grok sidecar join — timestamps from events.jsonl, tokens from signals.json.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTimestampMap, parseGrokEvents, parseGrokSignals, collectChatLineTypes } from '../grok/sidecars.js';

describe('Grok sidecars', () => {
  test('buildTimestampMap joins turn/loop/first_token to chat lines', () => {
    const types = ['system', 'user', 'reasoning', 'assistant', 'tool_result', 'assistant'];
    const events = parseGrokEvents(`
{"ts":"2026-04-01T10:00:10.000Z","type":"turn_started","conversation_message_count":1}
{"ts":"2026-04-01T10:00:11.000Z","type":"loop_started"}
{"ts":"2026-04-01T10:00:12.000Z","type":"first_token"}
{"ts":"2026-04-01T10:00:20.000Z","type":"loop_started"}
{"ts":"2026-04-01T10:00:21.000Z","type":"first_token"}
`);
    const map = buildTimestampMap(types, events, '2026-04-01T09:00:00.000Z');
    assert.equal(map.get(0), '2026-04-01T09:00:00.000Z'); // system fallback
    assert.equal(map.get(1), '2026-04-01T10:00:10.000Z'); // user via count
    assert.equal(map.get(2), '2026-04-01T10:00:11.000Z'); // reasoning ← loop
    assert.equal(map.get(3), '2026-04-01T10:00:12.000Z'); // assistant ← first_token
    assert.equal(map.has(4), false); // tool_result not stamped
    assert.equal(map.get(5), '2026-04-01T10:00:21.000Z'); // 2nd assistant
  });

  test('parseGrokSignals reads contextTokensUsed', () => {
    const s = parseGrokSignals(JSON.stringify({ contextTokensUsed: 4200, contextWindowTokens: 500000 }));
    assert.ok(s);
    assert.equal(s!.contextTokensUsed, 4200);
  });

  test('collectChatLineTypes skips blank lines', () => {
    const types = collectChatLineTypes(
      ['{"type":"user","content":"a"}', '', '{"type":"assistant","content":"b"}', '\n'].join('\n'),
    );
    assert.deepEqual(types, ['user', 'assistant']);
  });
});
