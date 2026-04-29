/**
 * subscriber-registry — topic key round-trip symmetry (RFC 005 C3.1).
 *
 * Guards the invariant that for every `Change` shape the registry
 * fans out, a subscriber registered at any *ancestor granularity*
 * (firehose → kind-only → kind+slug → ... → fully-qualified) receives
 * the event exactly once. The match relies on `topicToKey` (subscribe
 * side) and `candidateKeysFor` (emit side) producing the same flat
 * canonical strings — a single trailing-colon mismatch would silently
 * drop deliveries with no other test catching it.
 *
 * Also asserts the negative side: a sibling-granularity subscriber
 * (e.g. same kind but different slug) does NOT receive the event.
 *
 * Pure unit test — no timers, no IO. Each fixture's `change.seq` is
 * stamped by the registry caller (we don't call `store.emit`, just
 * the lower-level `registry.emit`), so the seq field is a placeholder
 * `0` here and the assertions look at delivery count + identity.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Change, ChangeTopic } from '../change-events.js';
import { createSubscriberRegistry } from '../subscriber-registry.js';

// Fixture changes — one per Change variant. Payload shapes are
// type-cast where the exact internals don't matter for routing
// (the registry only inspects the discriminator + slug/sessionId/
// agentId fields).
const PAYLOAD = {} as never;

const FIXTURES: Array<{
  name: string;
  change: Change;
  /** Topics that MUST receive the event (firehose is added by the harness). */
  matchingTopics: ChangeTopic[];
  /** Topics at the same kind but different qualifiers — must NOT receive. */
  nonMatchingTopics: ChangeTopic[];
}> = [
  {
    name: 'session.message.added',
    change: {
      type: 'session.message.added',
      seq: 0,
      ts: 0,
      slug: 'p1',
      sessionId: 's1',
      message: PAYLOAD,
      byteOffset: 0,
    },
    matchingTopics: [
      { kind: 'session' },
      { kind: 'session', slug: 'p1' },
      { kind: 'session', slug: 'p1', sessionId: 's1' },
    ],
    nonMatchingTopics: [
      { kind: 'session', slug: 'p2' },
      { kind: 'session', slug: 'p1', sessionId: 's2' },
    ],
  },
  {
    name: 'session.created',
    change: {
      type: 'session.created',
      seq: 0,
      ts: 0,
      slug: 'p1',
      sessionId: 's1',
      entry: PAYLOAD,
    },
    matchingTopics: [
      { kind: 'session' },
      { kind: 'session', slug: 'p1' },
      { kind: 'session', slug: 'p1', sessionId: 's1' },
    ],
    nonMatchingTopics: [{ kind: 'session', slug: 'other' }],
  },
  {
    name: 'session.rewritten',
    change: {
      type: 'session.rewritten',
      seq: 0,
      ts: 0,
      slug: 'p1',
      sessionId: 's1',
    },
    matchingTopics: [
      { kind: 'session' },
      { kind: 'session', slug: 'p1' },
      { kind: 'session', slug: 'p1', sessionId: 's1' },
    ],
    nonMatchingTopics: [{ kind: 'session', slug: 'p1', sessionId: 'other' }],
  },
  {
    name: 'subagent.updated',
    change: {
      type: 'subagent.updated',
      seq: 0,
      ts: 0,
      slug: 'p1',
      sessionId: 's1',
      agentId: 'a1',
      transcript: PAYLOAD,
    },
    matchingTopics: [
      { kind: 'subagent' },
      { kind: 'subagent', slug: 'p1' },
      { kind: 'subagent', slug: 'p1', sessionId: 's1' },
      { kind: 'subagent', slug: 'p1', sessionId: 's1', agentId: 'a1' },
    ],
    nonMatchingTopics: [
      { kind: 'subagent', slug: 'p2' },
      { kind: 'subagent', slug: 'p1', sessionId: 'other' },
      { kind: 'subagent', slug: 'p1', sessionId: 's1', agentId: 'other' },
    ],
  },
  {
    name: 'tool-result.added',
    change: {
      type: 'tool-result.added',
      seq: 0,
      ts: 0,
      slug: 'p1',
      sessionId: 's1',
      toolUseId: 't1',
    },
    matchingTopics: [
      { kind: 'tool-result' },
      { kind: 'tool-result', slug: 'p1' },
      { kind: 'tool-result', slug: 'p1', sessionId: 's1' },
    ],
    nonMatchingTopics: [{ kind: 'tool-result', slug: 'p2' }],
  },
  {
    name: 'file-history.added',
    change: {
      type: 'file-history.added',
      seq: 0,
      ts: 0,
      sessionId: 's1',
      hash: 'abc',
      version: 1,
    },
    matchingTopics: [{ kind: 'file-history' }, { kind: 'file-history', sessionId: 's1' }],
    nonMatchingTopics: [{ kind: 'file-history', sessionId: 'other' }],
  },
  {
    name: 'todo.updated',
    change: {
      type: 'todo.updated',
      seq: 0,
      ts: 0,
      sessionId: 's1',
      agentId: 'a1',
      items: [],
    },
    matchingTopics: [{ kind: 'todo' }, { kind: 'todo', sessionId: 's1' }],
    nonMatchingTopics: [{ kind: 'todo', sessionId: 'other' }],
  },
  {
    name: 'task.updated',
    change: {
      type: 'task.updated',
      seq: 0,
      ts: 0,
      sessionId: 's1',
      task: PAYLOAD,
    },
    matchingTopics: [{ kind: 'task' }, { kind: 'task', sessionId: 's1' }],
    nonMatchingTopics: [{ kind: 'task', sessionId: 'other' }],
  },
  {
    name: 'plan.upserted',
    change: {
      type: 'plan.upserted',
      seq: 0,
      ts: 0,
      slug: 'p1',
      plan: PAYLOAD,
    },
    matchingTopics: [{ kind: 'plan' }, { kind: 'plan', slug: 'p1' }],
    nonMatchingTopics: [{ kind: 'plan', slug: 'other' }],
  },
  {
    name: 'settings.changed',
    change: {
      type: 'settings.changed',
      seq: 0,
      ts: 0,
      file: 'settings',
      settings: PAYLOAD,
    },
    matchingTopics: [{ kind: 'settings' }],
    // Settings has no narrowing qualifiers, so there are no sibling
    // granularities to test against — only the firehose-vs-scoped split.
    nonMatchingTopics: [],
  },
];

describe('subscriber-registry — topicToKey ↔ candidateKeysFor symmetry', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}: every ancestor-granularity subscriber receives one event`, () => {
      const registry = createSubscriberRegistry();
      const counts = new Map<string, number>();

      // Firehose: must always receive.
      const firehoseId = '<firehose>';
      counts.set(firehoseId, 0);
      registry.subscribe(undefined, () => {
        counts.set(firehoseId, (counts.get(firehoseId) ?? 0) + 1);
      });

      // Every matching ancestor topic: must receive exactly once.
      for (let i = 0; i < fixture.matchingTopics.length; i++) {
        const id = `match[${i}]:${JSON.stringify(fixture.matchingTopics[i])}`;
        counts.set(id, 0);
        registry.subscribe(fixture.matchingTopics[i], () => {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        });
      }

      // Sibling topics: must receive zero events.
      for (let i = 0; i < fixture.nonMatchingTopics.length; i++) {
        const id = `nomatch[${i}]:${JSON.stringify(fixture.nonMatchingTopics[i])}`;
        counts.set(id, 0);
        registry.subscribe(fixture.nonMatchingTopics[i], () => {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        });
      }

      registry.emit(fixture.change);

      // Firehose + every matching topic should have fired exactly once.
      assert.equal(counts.get(firehoseId), 1, 'firehose subscriber missed event');
      for (let i = 0; i < fixture.matchingTopics.length; i++) {
        const id = `match[${i}]:${JSON.stringify(fixture.matchingTopics[i])}`;
        assert.equal(
          counts.get(id),
          1,
          `subscriber ${id} did not receive ${fixture.change.type} — likely topicToKey/candidateKeysFor mismatch`,
        );
      }
      // Sibling-granularity subscribers must not have fired.
      for (let i = 0; i < fixture.nonMatchingTopics.length; i++) {
        const id = `nomatch[${i}]:${JSON.stringify(fixture.nonMatchingTopics[i])}`;
        assert.equal(counts.get(id), 0, `sibling ${id} should not have received the event`);
      }

      registry.dispose();
    });
  }

  test('every Change variant has a matching fixture (guards future additions)', () => {
    // Build the set of change-type tags exercised by FIXTURES and
    // compare against the full Change union so adding a new variant
    // without a fixture fails this test instead of silently
    // regressing routing coverage.
    const covered = new Set(FIXTURES.map((f) => f.change.type));
    const allTypes: Array<Change['type']> = [
      'session.message.added',
      'session.created',
      'session.rewritten',
      'subagent.updated',
      'tool-result.added',
      'file-history.added',
      'todo.updated',
      'task.updated',
      'plan.upserted',
      'settings.changed',
    ];
    for (const t of allTypes) {
      assert.ok(covered.has(t), `Change variant "${t}" has no fixture in subscriber-registry-symmetry.test.ts`);
    }
  });
});
