/**
 * useLiveChanges — last-Change state hook (RFC 005 C3.5).
 *
 * Returns whichever `Change` most recently matched `topic`.
 * `topic === undefined` means firehose. Good for toast or banner UIs
 * ("new session started", "settings reloaded") where the consumer only
 * cares about the event itself, not any derived snapshot.
 *
 * Why not `useSyncExternalStore` here? The other hooks use it because
 * they read external derived state (messages, lists) that can tear
 * under concurrent rendering. This hook records incoming events
 * locally in React state — there's no external snapshot to re-read on
 * every render, so a plain `useState` + `useEffect` subscription is
 * both simpler and correct. Events arrive in the order the registry
 * fans them out; React batches the resulting renders.
 *
 * **Firehose behavior**: per RFC 005 design, `onChange(listener)` does
 * NOT auto-prewarm every scope — watcher attachment stays pay-as-you-go.
 * The scoped form (`topic` provided) DOES prewarm the matching scope
 * for this hook's lifetime. Firehose consumers who want events must
 * pair this hook with an explicit `api.live.prewarm(...)` call on
 * whichever scopes they care about (or use one of the scoped hooks
 * which prewarm automatically).
 *
 * Graceful degradation: when `api.live` is undefined the effect sets
 * up no subscription and the hook stays `null` forever. No warnings,
 * no errors.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Change, ChangeTopic } from '../../live/change-events.js';
import { useSpaghettiAPI } from '../context.js';

export function useLiveChanges(topic?: ChangeTopic): Change | null {
  const api = useSpaghettiAPI();
  const [last, setLast] = useState<Change | null>(null);

  // Memoize topic identity keyed on its logical content so useEffect
  // deps are honest even when the caller inlines the object each render.
  const topicKey = topic ? JSON.stringify(topic) : '';
  const stableTopic = useMemo(() => topic, [topicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!api.live) return;
    const listener = (change: Change): void => {
      setLast(change);
    };
    // Scoped form: prewarm the matching scope for the hook's lifetime
    // so events actually flow. Firehose form skips prewarm per the
    // documented contract above.
    const prewarmDispose = stableTopic !== undefined ? api.live.prewarm(stableTopic) : undefined;
    const subDispose =
      stableTopic === undefined ? api.live.onChange(listener) : api.live.onChange(stableTopic, listener);
    return () => {
      subDispose();
      prewarmDispose?.();
    };
  }, [api, stableTopic]);

  return last;
}
