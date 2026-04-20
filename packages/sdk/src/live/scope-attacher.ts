/**
 * scope-attacher.ts — Ref-counted watcher attach/detach (RFC 005 C3.2).
 *
 * Extracted from `live-updates.ts` so the orchestrator focuses on
 * watcher / queue / writer-loop wiring. Owns the per-`WatchScopeKey`
 * ref count, the in-flight attach promise, and the lazy `subscribe()`
 * call that brings a watcher online on the 0 → 1 bump (and tears it
 * down on the 1 → 0 bump).
 *
 * Behavior identical to the inline pre-extraction version:
 *
 *   - Six known scopes: `projects`, `todos`, `tasks`, `file-history`,
 *     `plans`, `settings`. All six attach to a real watcher today.
 *
 *   - `settings` watches `claudeDir` non-recursively; every other
 *     scope is an isolated subtree that wants recursion.
 *
 *   - The 0 → 1 attach is async (parcel binds a watcher); the
 *     `acquire()` call returns synchronously and the in-flight promise
 *     is tracked on the per-scope state. If the refcount drops back to
 *     zero during a slow attach, the resolved unsubscribe handle is
 *     called immediately so we don't retain a watcher nobody wants.
 *
 *   - `detachAll()` awaits every in-flight attach so their unsubscribe
 *     handles land before the loop tears them down — needed for
 *     graceful `LiveUpdates.stop()` ordering.
 */

import * as path from 'node:path';

import type { Watcher, WatchEvent, Unsubscribe } from './watcher.js';
import type { ChangeTopic } from './change-events.js';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical string key for a watch scope (a particular `~/.claude/`
 * subtree). A ref-count map is keyed on these so "sessions in slug
 * foo" and "sessions in slug foo, sessionId bar" collapse onto the
 * same projects/-root watcher.
 */
export type WatchScopeKey =
  | 'projects' // projects/**: covers session / subagent / tool-result / project-memory / session-index
  | 'todos' // todos/** (flat)
  | 'tasks' // tasks/** (Phase 5)
  | 'file-history' // file-history/** (Phase 5)
  | 'plans' // plans/** (Phase 5)
  | 'settings'; // settings.json + settings.local.json (Phase 5)

/**
 * Scopes whose Phase 2/3/5 wiring actually attaches a real watcher.
 * Phase 5 rolled in `tasks`, `file-history`, `plans`, and `settings`;
 * all six scopes now attach real watchers on the first ref and detach
 * on the last. Exported so callers can introspect coverage in tests.
 */
export const ATTACHABLE_SCOPES: ReadonlySet<WatchScopeKey> = new Set([
  'projects',
  'todos',
  'tasks',
  'file-history',
  'plans',
  'settings',
]);

/**
 * Subpath under claudeDir for each attachable scope. `'.'` for
 * `settings`, which watches the claudeDir root itself non-recursively
 * to pick up `settings.json` / `settings.local.json` only.
 */
export const SCOPE_SUBPATH: Record<WatchScopeKey, string> = {
  projects: 'projects',
  todos: 'todos',
  tasks: 'tasks',
  'file-history': 'file-history',
  plans: 'plans',
  settings: '.',
};

/**
 * Map a `ChangeTopic` onto the watch scopes it depends on. Every topic
 * today resolves to exactly one scope, but the return type is an array
 * so a future topic that spans subtrees doesn't require a signature
 * change.
 */
export function topicToScopes(topic: ChangeTopic): WatchScopeKey[] {
  switch (topic.kind) {
    case 'session':
    case 'subagent':
    case 'tool-result':
      return ['projects'];
    case 'todo':
      return ['todos'];
    case 'task':
      return ['tasks'];
    case 'file-history':
      return ['file-history'];
    case 'plan':
      return ['plans'];
    case 'settings':
      return ['settings'];
  }
}

export interface ScopeAttacherDeps {
  claudeDir: string;
  /**
   * Returns the current `Watcher` (or `null` when no watcher has been
   * created yet — `start()` hasn't run, or `stop()` has cleared it).
   * The attacher reads this lazily on every attach so a re-start of
   * the orchestrator can swap watcher implementations cleanly.
   */
  getWatcher: () => Watcher | null;
  /**
   * Predicate read at the top of every attach to short-circuit when
   * the orchestrator is not running. Returns `true` when it's safe to
   * subscribe.
   */
  isRunning: () => boolean;
  /**
   * Forwarded to `watcher.subscribe()` — the orchestrator owns the
   * fanout / classification / queue enqueue logic.
   */
  onEvents: (events: WatchEvent[]) => void;
  /**
   * Hard-ignore globs handed to the watcher. Matches the orchestrator's
   * watcher-side ignores; passed in so the attacher doesn't have to
   * reason about which categories want which globs.
   */
  watcherIgnoreGlobs: readonly string[];
  /**
   * Error sink for watcher.subscribe() failures (e.g. "directory
   * missing"). Matches the orchestrator's `onError` discipline.
   */
  onError: (err: Error) => void;
}

export interface ScopeAttacher {
  /**
   * Bump the ref count for one scope. On 0 → 1 we kick off an attach.
   * Synchronous — the attach promise is tracked internally so
   * subsequent `release` / `detachAll` calls can serialise against it.
   */
  acquire(scope: WatchScopeKey): void;
  /**
   * Drop one ref from a scope. On 1 → 0 we detach (or, if an attach is
   * still in flight, let the in-flight attach see refCount=0 and tear
   * itself down).
   */
  release(scope: WatchScopeKey): void;
  /**
   * Awaits any in-flight attach + detaches every scope. Called from
   * `LiveUpdates.stop()` so unsubscribe handles land cleanly before
   * the parcel/chokidar handle is dropped.
   */
  detachAll(): Promise<void>;
  /**
   * Bring online any scopes whose ref count was bumped before
   * `start()` resolved (exotic, but legal — prewarm calls before
   * start are accepted). Called once from `LiveUpdates.start()` after
   * the watcher is constructed.
   */
  attachPending(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Per-scope ref-count state. */
interface ScopeState {
  /**
   * Number of live `acquire` refs holding this scope.
   * Attach fires on 0 → 1, detach fires on 1 → 0.
   */
  refCount: number;
  /**
   * Live `Unsubscribe` handle for the current watcher attach — unset
   * while the attach is in-flight (pending promise) or the scope is
   * not attachable. Carries the responsibility of tearing down the
   * parcel/chokidar subscription when the ref count drops back to 0.
   */
  unsubscribe: Unsubscribe | null;
  /**
   * In-flight attach promise. Serialised against disposes so a
   * refcount bounce (0 → 1 → 0) during a slow attach cleanly tears
   * down once the attach lands.
   */
  pending: Promise<void> | null;
  /**
   * `true` for scopes whose wiring actually attaches a watcher. Today
   * every scope in `ATTACHABLE_SCOPES` is true; the bit is preserved
   * so a future Phase that defers some category back to a
   * polling/lazy mode can flip it without changing the call sites.
   */
  attachable: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createScopeAttacher(deps: ScopeAttacherDeps): ScopeAttacher {
  const scopes = new Map<WatchScopeKey, ScopeState>();

  function getOrCreateScope(scope: WatchScopeKey): ScopeState {
    let state = scopes.get(scope);
    if (!state) {
      state = {
        refCount: 0,
        unsubscribe: null,
        pending: null,
        attachable: ATTACHABLE_SCOPES.has(scope),
      };
      scopes.set(scope, state);
    }
    return state;
  }

  async function attachScope(scope: WatchScopeKey, state: ScopeState): Promise<void> {
    const watcher = deps.getWatcher();
    if (!watcher || !state.attachable) return;
    const subPath = SCOPE_SUBPATH[scope];
    const fullPath = path.join(deps.claudeDir, subPath);
    // Settings watches claudeDir itself non-recursively — recursive
    // would pull the entire tree in and defeat the point of the rest
    // of the lazy-attach system. All other scopes are isolated
    // subtrees that want recursion.
    const recursive = scope !== 'settings';
    try {
      const unsub = await watcher.subscribe(fullPath, deps.onEvents, {
        ignore: [...deps.watcherIgnoreGlobs],
        recursive,
      });
      // If the refcount dropped back to zero during the attach
      // (acquire + release raced faster than parcel could bind), tear
      // down immediately instead of retaining a watcher nobody wants.
      if (state.refCount === 0) {
        try {
          await unsub();
        } catch {
          /* best-effort */
        }
        return;
      }
      state.unsubscribe = unsub;
    } catch (err) {
      deps.onError(
        err instanceof Error
          ? new Error(`[LiveUpdates] failed to attach watcher on ${scope}/ (${fullPath}): ${err.message}`)
          : new Error(`[LiveUpdates] failed to attach watcher on ${scope}/ (${fullPath}): ${String(err)}`),
      );
    }
  }

  async function detachScope(state: ScopeState): Promise<void> {
    const unsub = state.unsubscribe;
    state.unsubscribe = null;
    if (unsub) {
      try {
        await unsub();
      } catch {
        /* best-effort — watcher may already be torn down */
      }
    }
  }

  function kickAttach(scope: WatchScopeKey, state: ScopeState): void {
    const pending = attachScope(scope, state).finally(() => {
      if (state.pending === pending) state.pending = null;
    });
    state.pending = pending;
  }

  return {
    acquire(scope: WatchScopeKey): void {
      const state = getOrCreateScope(scope);
      state.refCount += 1;
      if (state.refCount !== 1) return;
      if (!state.attachable) return;
      if (!deps.isRunning() || !deps.getWatcher()) return; // start()/attachPending() will attach.
      kickAttach(scope, state);
    },

    release(scope: WatchScopeKey): void {
      const state = scopes.get(scope);
      if (!state || state.refCount <= 0) return;
      state.refCount -= 1;
      if (state.refCount !== 0) return;
      if (!state.attachable) return;
      // If a pending attach is still in flight, let it see refCount=0
      // and tear itself down. Otherwise detach right now.
      if (state.pending) return;
      void detachScope(state);
    },

    async detachAll(): Promise<void> {
      // Let any in-flight attaches resolve (so their unsub handles
      // land on state.unsubscribe), then detach every scope.
      const pendings = Array.from(scopes.values())
        .map((s) => s.pending)
        .filter((p): p is Promise<void> => p !== null);
      if (pendings.length > 0) {
        try {
          await Promise.all(pendings);
        } catch {
          /* errors already routed via onError during attach */
        }
      }
      for (const state of scopes.values()) {
        await detachScope(state);
      }
      // Leave the ref-count entries in place — callers can re-acquire
      // after a re-start. We just dropped the unsubscribe handles.
    },

    attachPending(): void {
      for (const [scope, state] of scopes) {
        if (state.attachable && state.refCount > 0 && !state.unsubscribe && !state.pending) {
          kickAttach(scope, state);
        }
      }
    },
  };
}
