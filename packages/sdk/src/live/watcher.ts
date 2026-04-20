/**
 * watcher.ts — filesystem watcher abstraction for RFC 005 live updates.
 *
 * This file introduces the cross-platform `Watcher` interface that
 * `LiveUpdates` (landing in C2.7) will consume, plus two concrete
 * implementations:
 *
 *  - `createParcelWatcher()` wraps `@parcel/watcher`. It's the default:
 *    single-epoll on Linux (no inotify quota explosion), correct Windows
 *    buffer sizing, macOS FSEvents, and — critically for the "what
 *    changed while we were down" recovery path in RFC 005 §Filesystem
 *    Watcher — first-class `writeSnapshot`/`getEventsSince` APIs.
 *
 *  - `createChokidarWatcher()` is a pure-JS fallback for environments
 *    where the parcel native binary fails to load (odd platforms, some
 *    CI sandboxes). Snapshot support degrades here — callers that rely
 *    on snapshots must upgrade to the parcel backend. See the per-method
 *    notes below.
 *
 * Nothing from this module is exported from the package entry yet;
 * `packages/sdk/src/live/index.ts` and the public-API wiring are
 * deliberately deferred until C2.7.
 */

import parcelWatcher from '@parcel/watcher';
import chokidar from 'chokidar';

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single filesystem event, normalised across backends.
 *
 * Matches parcel's shape one-for-one so the parcel impl can pass events
 * straight through. The chokidar impl maps its richer event vocabulary
 * onto these three cases (see `createChokidarWatcher` below).
 */
export type WatchEvent = {
  type: 'create' | 'update' | 'delete';
  path: string;
};

/**
 * "Stop watching" handle returned by `subscribe`. May be async (parcel's
 * `AsyncSubscription.unsubscribe` returns a promise); the sync-void case
 * is kept so simpler backends don't have to fabricate a promise.
 */
export type Unsubscribe = () => Promise<void> | void;

/**
 * The narrow surface `LiveUpdates` depends on. Deliberately tiny:
 *
 *  - `subscribe` is the hot path — it fires on every fs event the
 *    backend coalesces for `rootPath`. `options.ignore` is an array of
 *    glob patterns the backend skips at the source (parcel) or we
 *    filter in JS (chokidar). `options.recursive` toggles whether
 *    subdirectories are watched — parcel is always recursive, so we
 *    accept `recursive: false` but ignore it (documented in the impl);
 *    chokidar honours it via `depth: 0`.
 *
 *  - `writeSnapshot` / `getEventsSince` are the "crash recovery"
 *    escape hatch. After `LiveUpdates.stop()` we write a snapshot;
 *    on next start we ask the backend for everything that changed
 *    between the snapshot and now. Parcel does this natively;
 *    chokidar can't, and throws.
 */
export interface Watcher {
  subscribe(
    rootPath: string,
    onEvents: (events: WatchEvent[]) => void,
    options: { ignore: string[]; recursive: boolean },
  ): Promise<Unsubscribe>;

  writeSnapshot(rootPath: string, snapshotFile: string): Promise<void>;

  getEventsSince(rootPath: string, snapshotFile: string): Promise<WatchEvent[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARCEL IMPL (default)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper over `@parcel/watcher`.
 *
 * Parcel's callback signature is `(err, events)`; on error we log to
 * stderr and drop the batch rather than propagate, mirroring how the
 * existing `file-service.ts` chokidar setup treats errors — live updates
 * should degrade, not crash the host process. `LiveUpdates` sits above
 * this and tracks saturation/error surfaces of its own.
 *
 * Parcel's own `Event.type` values (`'create' | 'update' | 'delete'`)
 * are identical to ours, so the mapping is a no-op clone.
 *
 * `recursive: false` is silently ignored — parcel is always recursive.
 * Callers that need non-recursive semantics (e.g. watching `~/.claude/`
 * without descending into `projects/`) must filter events via `ignore`
 * globs. This is acceptable because the non-recursive scopes in RFC 005
 * §Filesystem Watcher are all leaf-ish (`todos/`, `plans/`, top-level
 * `~/.claude/`) and wouldn't benefit from recursion anyway.
 */
export function createParcelWatcher(): Watcher {
  return {
    async subscribe(rootPath, onEvents, options) {
      const subscription = await parcelWatcher.subscribe(
        rootPath,
        (err, events) => {
          if (err) {
            // Surface to stderr. `LiveUpdates.onError` hook lives one
            // layer up — we don't have a reference to it here, and
            // pushing an error through `onEvents` would conflate
            // success/failure signalling.

            console.error('[spaghetti-sdk] parcel watcher error:', err);
            return;
          }
          if (events.length === 0) return;
          // Parcel's Event shape is `{ type, path }` — a structural
          // match for `WatchEvent`. Map-to-new-object to avoid leaking
          // any future extra fields parcel might add.
          onEvents(events.map((e) => ({ type: e.type, path: e.path })));
        },
        { ignore: options.ignore },
      );
      // `recursive: false` is accepted for interface compatibility but
      // not honoured — see the doc-comment on `createParcelWatcher`.
      void options.recursive;
      return () => subscription.unsubscribe();
    },

    async writeSnapshot(rootPath, snapshotFile) {
      await parcelWatcher.writeSnapshot(rootPath, snapshotFile);
    },

    async getEventsSince(rootPath, snapshotFile) {
      const events = await parcelWatcher.getEventsSince(rootPath, snapshotFile);
      return events.map((e) => ({ type: e.type, path: e.path }));
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CHOKIDAR IMPL (fallback)
// ═══════════════════════════════════════════════════════════════════════════

const SNAPSHOT_UNSUPPORTED_MESSAGE = 'Chokidar backend does not support snapshots — upgrade to @parcel/watcher';

/**
 * Pure-JS fallback for platforms where `@parcel/watcher` fails to load.
 *
 * Event mapping:
 *
 *   chokidar `add`      → `create`   (new file observed)
 *   chokidar `change`   → `update`   (existing file content changed)
 *   chokidar `unlink`   → `delete`   (file removed)
 *   chokidar `addDir`   → (ignored — directory creates are noise; the
 *                         consumer only cares about file contents)
 *   chokidar `unlinkDir`→ (ignored — same rationale; individual file
 *                         unlinks inside fire separately)
 *
 * `ignoreInitial: true` matches parcel's semantics — we don't fire
 * synthetic events for files that already exist when the watcher
 * attaches; the warm-start path reconciles those on process startup.
 *
 * `writeSnapshot` / `getEventsSince` throw unconditionally. Consumers
 * relying on the snapshot-based recovery path must use the parcel
 * backend — documented in the throw message so runtime errors point at
 * the fix.
 */
export function createChokidarWatcher(): Watcher {
  return {
    async subscribe(rootPath, onEvents, options) {
      const watcher = chokidar.watch(rootPath, {
        ignored: options.ignore.length > 0 ? options.ignore : undefined,
        ignoreInitial: true,
        persistent: true,
        // `depth: 0` keeps chokidar from descending when the caller
        // explicitly asked for a non-recursive watch. Without this,
        // chokidar follows every subdirectory by default.
        depth: options.recursive ? undefined : 0,
      });

      const emit = (type: WatchEvent['type'], path: string): void => {
        onEvents([{ type, path }]);
      };

      watcher.on('add', (p) => emit('create', p));
      watcher.on('change', (p) => emit('update', p));
      watcher.on('unlink', (p) => emit('delete', p));
      // addDir / unlinkDir: intentionally unhandled — see doc-comment.

      // chokidar's `ready` event fires once the initial scan completes.
      // We wait for it so callers observing the returned `Unsubscribe`
      // don't race against pending bootstrapping work.
      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => {
          watcher.off('error', onError);
          resolve();
        };
        const onError = (err: unknown): void => {
          watcher.off('ready', onReady);
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        watcher.once('ready', onReady);
        watcher.once('error', onError);
      });

      return () => watcher.close();
    },

    async writeSnapshot(_rootPath, _snapshotFile) {
      throw new Error(SNAPSHOT_UNSUPPORTED_MESSAGE);
    },

    async getEventsSince(_rootPath, _snapshotFile) {
      throw new Error(SNAPSHOT_UNSUPPORTED_MESSAGE);
    },
  };
}
