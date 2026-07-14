/**
 * RuntimeEvent — Plane 3 event union.
 *
 * Disk-derived live updates use {@link Change} from `live/change-events.ts`
 * (Plane 2). Runtime events observe process-adjacent activity (hooks,
 * channel sessions) and may reference session/project ids without always
 * mutating the SQLite index.
 *
 * See `docs/THREE-PLANE-INGEST-ARCHITECTURE.md` §6 and §9.
 */

import type { HookEvent } from '../types/spaghetti/hook-events.js';
import type { SessionInfo } from '../types/spaghetti/channel-messages.js';

/** Runtime event stream — hooks + channel session liveness today. */
export type RuntimeEvent =
  | {
      type: 'hook';
      /** Hook event name, e.g. `PreToolUse`. */
      name: string;
      /** Full captured hook payload. */
      payload: HookEvent;
      ts: number;
      sessionId?: string;
    }
  | {
      type: 'channel.sessions';
      /** Currently live channel sessions after a discovery refresh. */
      sessions: SessionInfo[];
      ts: number;
    }
  | {
      type: 'session.active';
      sessionId: string;
      pid?: number;
      ts: number;
    };

export function isHookRuntimeEvent(e: RuntimeEvent): e is Extract<RuntimeEvent, { type: 'hook' }> {
  return e.type === 'hook';
}

export function isChannelSessionsRuntimeEvent(
  e: RuntimeEvent,
): e is Extract<RuntimeEvent, { type: 'channel.sessions' }> {
  return e.type === 'channel.sessions';
}

export function isSessionActiveRuntimeEvent(e: RuntimeEvent): e is Extract<RuntimeEvent, { type: 'session.active' }> {
  return e.type === 'session.active';
}
