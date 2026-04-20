/**
 * useLiveChanges — last-Change state hook (RFC 005 C3.5).
 *
 * Lightweight counterpart to the other live hooks: returns whichever
 * `Change` most recently matched `topic`. `topic === undefined` means
 * firehose — every emitted Change bumps the state. Good for toast or
 * banner UIs ("new session started", "settings reloaded") where the
 * consumer only cares about the event itself, not any derived snapshot.
 *
 * Why not `useSyncExternalStore` here? The other hooks use it because
 * they read external derived state (messages, lists) that can tear
 * under concurrent rendering. This hook records incoming events
 * locally in React state — there's no external snapshot to re-read on
 * every render, so a plain `useState` + `useEffect` subscription is
 * both simpler and correct. Events arrive in the order the registry
 * fans them out; React batches the resulting renders.
 *
 * Graceful degradation: when `api.live` is undefined the effect sets
 * up no subscription and the hook stays `null` forever. No warnings,
 * no errors.
 */

import { useEffect, useState } from 'react';
import type { Change, ChangeTopic } from '../../live/change-events.js';
import { useSpaghettiAPI } from '../context.js';

// Topic is an object; stringify to a stable key so useEffect deps
// don't re-trigger on every render when the caller inlines `{kind:
// 'session'}`. The key is deterministic for a given topic and cheap
// enough — these objects have a handful of string fields.
function topicKey(topic: ChangeTopic | undefined): string {
  if (!topic) return '';
  return JSON.stringify(topic);
}

export function useLiveChanges(topic?: ChangeTopic): Change | null {
  const api = useSpaghettiAPI();
  const [last, setLast] = useState<Change | null>(null);

  const key = topicKey(topic);

  useEffect(() => {
    if (!api.live) return;
    const listener = (change: Change): void => {
      setLast(change);
    };
    // The overload split — firehose form takes only the listener.
    const dispose = topic === undefined ? api.live.onChange(listener) : api.live.onChange(topic, listener);
    return () => {
      dispose();
    };
    // topic object identity changes each render but topicKey is the
    // stable value; disable the rule that wants the object itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  return last;
}
