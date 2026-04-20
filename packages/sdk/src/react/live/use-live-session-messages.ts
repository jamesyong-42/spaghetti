/**
 * useLiveSessionMessages — chat-view hook for one session (RFC 005 C3.5).
 *
 * Built on `useSyncExternalStore` so React's concurrent-mode tearing
 * guards apply. The hook:
 *
 *  1. Prewarms the session scope on mount so the underlying
 *     `~/.claude/projects/<slug>/` watcher attaches and starts feeding
 *     Change events. Dispose runs on unmount and drops the ref.
 *  2. Subscribes to the same topic through `api.live.onChange`. The
 *     subscribe function is stable across renders (keyed on inputs)
 *     and no-ops when `api.live` is undefined (live mode opt-out).
 *  3. Reads `api.getSessionMessages(slug, sessionId, 500, 0)` for the
 *     snapshot, capped at 500 messages for Phase 3 — pagination is a
 *     separate hook concern.
 *
 * Snapshot stability: `useSyncExternalStore` re-reads `getSnapshot` on
 * every render; returning a fresh array each time would trigger an
 * infinite re-render loop. A ref holds the last observed "store seq"
 * alongside the cached messages array; `getSnapshot` returns the
 * cached array unless the subscribe callback has bumped the seq
 * (signalling a Change landed) or the slug/sessionId changed.
 *
 * Graceful degradation: when `api.live` is undefined the hook still
 * renders the initial snapshot (SQLite is populated by cold/warm
 * start); the subscribe path is a no-op so no re-renders will fire.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SessionMessage } from '../../types/index.js';
import { useSpaghettiAPI } from '../context.js';

const MAX_MESSAGES = 500;

interface MessagesSnapshot {
  seq: number;
  messages: SessionMessage[];
}

export interface UseLiveSessionMessagesResult {
  messages: SessionMessage[];
  isLoading: boolean;
}

export function useLiveSessionMessages(slug: string, sessionId: string): UseLiveSessionMessagesResult {
  const api = useSpaghettiAPI();

  // Ref holds the last-returned snapshot + a local seq counter bumped
  // by the subscribe callback. Using a local counter (rather than
  // `store.lastEmittedSeq()`) keeps the hook decoupled from store
  // internals and only triggers re-computes when an event actually
  // matches the topic this hook subscribes to.
  const cacheRef = useRef<MessagesSnapshot | null>(null);
  const localSeqRef = useRef(0);
  const keyRef = useRef<string>('');

  // Invalidate cache if slug/sessionId changed so the next getSnapshot
  // reads fresh data. Using refs directly here because this runs
  // inline with render — useEffect would be one paint too late.
  const key = `${slug}\u0000${sessionId}`;
  if (keyRef.current !== key) {
    keyRef.current = key;
    cacheRef.current = null;
  }

  // Prewarm the session scope on mount; effect cleanup drops the ref
  // so unmount auto-detaches the underlying watcher once refcount
  // hits zero.
  useEffect(() => {
    const dispose = api.live?.prewarm({ kind: 'session', slug, sessionId });
    return () => {
      dispose?.();
    };
  }, [api, slug, sessionId]);

  // Subscribe passed to useSyncExternalStore. Must be stable (same
  // identity across renders for a given set of inputs) — React calls
  // it to register its own onStoreChange callback.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const dispose = api.live?.onChange({ kind: 'session', slug, sessionId }, () => {
        localSeqRef.current += 1;
        cacheRef.current = null;
        onStoreChange();
      });
      return dispose ?? (() => {});
    },
    [api, slug, sessionId],
  );

  const getSnapshot = useCallback((): MessagesSnapshot => {
    const cached = cacheRef.current;
    if (cached && cached.seq === localSeqRef.current) {
      return cached;
    }
    const page = api.getSessionMessages(slug, sessionId, MAX_MESSAGES, 0);
    const next: MessagesSnapshot = { seq: localSeqRef.current, messages: page.messages };
    cacheRef.current = next;
    return next;
  }, [api, slug, sessionId]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => ({ messages: snapshot.messages, isLoading: false }), [snapshot]);
}
