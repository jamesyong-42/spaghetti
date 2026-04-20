/**
 * useLiveSettings — settings hook (RFC 005 C3.5).
 *
 * Phase 3 doesn't attach a watcher to `~/.claude/settings.json` — that
 * lands in Phase 5. The settings topic is still recognized by
 * `LiveUpdates.prewarm`, so calling it here is harmless (ref-count
 * bookkeeping only) and ready to activate once the Phase 5 watcher
 * ships: the hook will automatically start receiving
 * `settings.changed` Changes without any consumer-side code change.
 *
 * Public SDK note: `SpaghettiAPI` does not expose a formal `getConfig`
 * method today — the concrete `SpaghettiAppService` inherits it via
 * the underlying data service surface but the interface omits it.
 * Rather than widen `SpaghettiAPI` in this commit (out of scope), the
 * hook performs a structural-typed read on the api and returns `null`
 * if the method is absent. Once the surface is widened the hook
 * automatically starts returning the real `SettingsFile`.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { SettingsFile } from '../../types/index.js';
import { useSpaghettiAPI } from '../context.js';

type SettingsSnapshot = {
  seq: number;
  settings: SettingsFile | null;
};

interface ConfigLike {
  getConfig?: () => { settings?: SettingsFile } | undefined;
}

function readSettings(api: unknown): SettingsFile | null {
  const candidate = api as ConfigLike;
  const getConfig = candidate.getConfig;
  if (typeof getConfig !== 'function') return null;
  try {
    const cfg = getConfig.call(candidate);
    return cfg?.settings ?? null;
  } catch {
    // Before the data store is populated `getConfig()` throws — return
    // null so the hook renders a benign initial state.
    return null;
  }
}

export function useLiveSettings(): SettingsFile | null {
  const api = useSpaghettiAPI();

  const cacheRef = useRef<SettingsSnapshot | null>(null);
  const localSeqRef = useRef(0);

  useEffect(() => {
    const dispose = api.live?.prewarm({ kind: 'settings' });
    return () => {
      dispose?.();
    };
  }, [api]);

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const dispose = api.live?.onChange({ kind: 'settings' }, () => {
        localSeqRef.current += 1;
        cacheRef.current = null;
        onStoreChange();
      });
      return dispose ?? (() => {});
    },
    [api],
  );

  const getSnapshot = useCallback((): SettingsSnapshot => {
    const cached = cacheRef.current;
    if (cached && cached.seq === localSeqRef.current) {
      return cached;
    }
    const next: SettingsSnapshot = { seq: localSeqRef.current, settings: readSettings(api) };
    cacheRef.current = next;
    return next;
  }, [api]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.settings;
}
