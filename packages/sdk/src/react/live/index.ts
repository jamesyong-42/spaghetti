/**
 * React live hooks — barrel (RFC 005 C3.5).
 *
 * Four `useSyncExternalStore`-backed hooks (three + one useState
 * variant) that let React consumers subscribe to live `Change`
 * events with automatic watcher attachment/detachment tied to
 * component lifecycle.
 *
 * All hooks:
 *  - Acquire the api via `useSpaghettiAPI()` (context-provided).
 *  - Prewarm the relevant topic on mount; dispose on unmount.
 *  - Subscribe via `api.live?.onChange(topic, …)` and degrade
 *    gracefully when `api.live` is undefined (live-mode opt-out —
 *    initial snapshot still works, no re-renders, no errors).
 *
 * TODO (deferred, not blocking): React-testing-library + happy-dom
 * are not currently in the SDK devDependencies — adding them
 * requires touching root devDeps + the `test` script, which is
 * out of scope for the 7-file budget on this commit. The hooks
 * themselves are type-checked + tree-shakable. Follow-up commit
 * will install the testing stack and land
 * `packages/sdk/src/react/__tests__/live-hooks.test.tsx`
 * (mount → emit change → assert re-render → unmount → assert
 * detach) per `docs/LIVE-UPDATES-COMMIT-PLAN.md` C3.5.
 */

export { useLiveSessionMessages, type UseLiveSessionMessagesResult } from './use-live-session-messages.js';
export { useLiveSessionList } from './use-live-session-list.js';
export { useLiveSettings } from './use-live-settings.js';
export { useLiveChanges } from './use-live-changes.js';
