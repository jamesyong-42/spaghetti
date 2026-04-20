/**
 * useLiveSessionList — session / project list hook (RFC 005 C3.5).
 *
 * Two modes:
 *
 *  - `slug` provided → prewarms + subscribes to `{ kind: 'session',
 *    slug }`, snapshot = `api.getSessionList(slug)`. Good for a
 *    project-detail sidebar.
 *  - `slug` omitted → prewarms + subscribes to the session firehose
 *    (`{ kind: 'session' }`), snapshot = `api.getProjectList()`. The
 *    public SDK does not expose a cross-project session accessor,
 *    so the firehose variant returns the project list (per RFC 005
 *    §8; the design calls this "session/project list"). Any session
 *    Change bumps the list because project summaries roll up session
 *    counts / last-active timestamps.
 *
 * Snapshot stability follows the same pattern as
 * `useLiveSessionMessages`: ref-held cache keyed on a local counter
 * bumped by the subscribe callback.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ProjectListItem, SessionListItem } from '../../api.js';
import type { ChangeTopic } from '../../live/change-events.js';
import { useSpaghettiAPI } from '../context.js';

type ListSnapshot = {
  /** Input key the snapshot was computed against. */
  key: string;
  seq: number;
  items: SessionListItem[] | ProjectListItem[];
};

// Overloads so `slug: string` narrows to `SessionListItem[]` and the
// bare call narrows to `ProjectListItem[]`. Consumers pick the shape
// they need at the call site.
export function useLiveSessionList(slug: string): SessionListItem[];
export function useLiveSessionList(): ProjectListItem[];
export function useLiveSessionList(slug?: string): SessionListItem[] | ProjectListItem[] {
  const api = useSpaghettiAPI();

  const cacheRef = useRef<ListSnapshot | null>(null);
  const localSeqRef = useRef(0);

  const key = slug ?? '';

  // Memoize the topic so useEffect / useCallback deps stay honest —
  // this replaces the previous `eslint-disable-next-line
  // react-hooks/exhaustive-deps` escape hatches.
  const topic = useMemo<ChangeTopic>(
    () => (slug !== undefined ? { kind: 'session', slug } : { kind: 'session' }),
    [slug],
  );

  useEffect(() => {
    const dispose = api.live?.prewarm(topic);
    return () => {
      dispose?.();
    };
  }, [api, topic]);

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const dispose = api.live?.onChange(topic, () => {
        localSeqRef.current += 1;
        onStoreChange();
      });
      return dispose ?? (() => {});
    },
    [api, topic],
  );

  const getSnapshot = useCallback((): ListSnapshot => {
    const cached = cacheRef.current;
    if (cached && cached.key === key && cached.seq === localSeqRef.current) {
      return cached;
    }
    const items: SessionListItem[] | ProjectListItem[] =
      slug !== undefined ? api.getSessionList(slug) : api.getProjectList();
    const next: ListSnapshot = { key, seq: localSeqRef.current, items };
    cacheRef.current = next;
    return next;
  }, [api, key, slug]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.items;
}
