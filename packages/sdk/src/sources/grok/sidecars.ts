/**
 * Grok sidecar enrichment — timestamps from events.jsonl, session tokens from
 * signals.json.
 *
 * ## Timestamp join (turn-scoped — verified against real ~/.grok sessions)
 *
 * `chat_history.jsonl` has no per-message time. `events.jsonl` does, with a
 * reliable structure:
 *
 * 1. **`turn_started.conversation_message_count`** is the absolute
 *    chat_history line index of that turn's primary user message (exact match
 *    on every observed turn).
 * 2. Turn ranges are `[count_i, count_{i+1})` (last turn → EOF).
 * 3. Within a turn's time window `[turn_started.ts, turn_ended.ts]`:
 *    - `loop_started[]` and `first_token[]` are 1:1 with **assistant** cycles
 *      (not with reasoning — a loop may emit multiple reasoning records before
 *      one assistant).
 *    - Walk chat lines in order:
 *      - `user` → `turn_started.ts`
 *      - `reasoning` → current `loop_started[loop_i].ts` (stay on same loop)
 *      - `assistant` → `first_token[loop_i].ts`, then `loop_i++`
 * 4. Pre-turn lines (`0 .. first_count`) — system + bootstrap context users —
 *    get `fallbackCreated` (summary.created_at).
 *
 * Without events.jsonl, only the fallback is applied to system/user lines.
 *
 * ## Session tokens
 *
 * `signals.contextTokensUsed` is a session aggregate. Attribute it to the last
 * assistant message and set `tokens_estimated=1` so the UI never treats it as
 * per-message API usage.
 */

import * as path from 'node:path';

import type { FileService } from '../../io/file-service.js';
import type { SessionTokenApi } from '../types.js';

const EVENTS_FILE = 'events.jsonl';
const SIGNALS_FILE = 'signals.json';

export interface GrokSignals {
  contextTokensUsed: number;
  contextWindowTokens: number;
}

/** Minimal event shape we care about for timestamp attribution. */
export interface GrokEventLine {
  type: string;
  ts: string;
  conversation_message_count?: number;
  turn_number?: number;
  loop_index?: number;
}

/**
 * Build absolute-line-index → ISO timestamp map from chat line types + events.
 * `lineTypes[i]` is the `type` of non-empty chat_history line i (including
 * tool lines that do not become message rows).
 */
export function buildTimestampMap(
  lineTypes: string[],
  events: GrokEventLine[],
  fallbackCreated: string | null,
): Map<number, string> {
  const map = new Map<number, string>();
  const n = lineTypes.length;
  if (n === 0) return map;

  const turns = events
    .filter((e) => e.type === 'turn_started' && e.ts)
    .slice()
    .sort((a, b) => {
      const ta = a.turn_number ?? -1;
      const tb = b.turn_number ?? -1;
      if (ta >= 0 && tb >= 0 && ta !== tb) return ta - tb;
      return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    });

  const turnEnds = events.filter((e) => e.type === 'turn_ended' && e.ts).map((e) => e.ts);

  // ── Pre-turn bootstrap (system + context users before first turn) ────────
  const firstTurnStart = turns.length > 0 ? (turns[0].conversation_message_count ?? 0) : n;
  const preEnd = clampIndex(firstTurnStart, 0, n);
  if (fallbackCreated) {
    for (let i = 0; i < preEnd; i++) {
      const t = lineTypes[i];
      if (t === 'system' || t === 'user') {
        map.set(i, fallbackCreated);
      }
    }
  }

  if (turns.length === 0) {
    // No turn markers — apply fallback to remaining system/user only.
    if (fallbackCreated) {
      for (let i = preEnd; i < n; i++) {
        if (lineTypes[i] === 'system' || lineTypes[i] === 'user') {
          map.set(i, fallbackCreated);
        }
      }
    }
    return map;
  }

  // ── Per-turn scoped join ─────────────────────────────────────────────────
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const start = clampIndex(turn.conversation_message_count ?? 0, 0, n);
    const end = ti + 1 < turns.length ? clampIndex(turns[ti + 1].conversation_message_count ?? n, start, n) : n;

    const windowStart = turn.ts;
    // Prefer matching turn_ended by order; else next turn_started; else open-ended.
    const windowEnd = ti < turnEnds.length ? turnEnds[ti] : ti + 1 < turns.length ? turns[ti + 1].ts : '\uffff';

    const loops = events.filter((e) => e.type === 'loop_started' && e.ts && e.ts >= windowStart && e.ts <= windowEnd);
    const firstTokens = events.filter(
      (e) => e.type === 'first_token' && e.ts && e.ts >= windowStart && e.ts <= windowEnd,
    );

    let loopI = 0;
    for (let i = start; i < end; i++) {
      const t = lineTypes[i];
      if (t === 'user' || t === 'system') {
        // Primary user is at `start`; extra users in the same turn share turn_started.
        map.set(i, turn.ts);
      } else if (t === 'reasoning') {
        // Multiple reasonings may precede one assistant within the same loop.
        if (loopI < loops.length) {
          map.set(i, loops[loopI].ts);
        } else if (loops.length > 0) {
          map.set(i, loops[loops.length - 1].ts);
        } else {
          map.set(i, turn.ts);
        }
      } else if (t === 'assistant') {
        if (loopI < firstTokens.length) {
          map.set(i, firstTokens[loopI].ts);
        } else if (loopI < loops.length) {
          map.set(i, loops[loopI].ts);
        } else {
          map.set(i, turn.ts);
        }
        // Advance the agent loop after the assistant (1:1 with loop/first_token).
        loopI++;
      }
      // tool_result / backend_tool_call: not stored as message rows; skip.
    }
  }

  return map;
}

function clampIndex(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

/** Parse events.jsonl into ordered event lines (invalid lines skipped). */
export function parseGrokEvents(text: string): GrokEventLine[] {
  const out: GrokEventLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof o.type === 'string' ? o.type : '';
      const ts = typeof o.ts === 'string' ? o.ts : '';
      if (!type || !ts) continue;
      const ev: GrokEventLine = { type, ts };
      if (typeof o.conversation_message_count === 'number') {
        ev.conversation_message_count = o.conversation_message_count;
      }
      if (typeof o.turn_number === 'number') {
        ev.turn_number = o.turn_number;
      }
      if (typeof o.loop_index === 'number') {
        ev.loop_index = o.loop_index;
      }
      out.push(ev);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Parse signals.json for session-level token aggregates. */
export function parseGrokSignals(text: string): GrokSignals | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const contextTokensUsed =
      typeof o.contextTokensUsed === 'number'
        ? o.contextTokensUsed
        : typeof o.context_tokens_used === 'number'
          ? o.context_tokens_used
          : 0;
    const contextWindowTokens =
      typeof o.contextWindowTokens === 'number'
        ? o.contextWindowTokens
        : typeof o.context_window_tokens === 'number'
          ? o.context_window_tokens
          : 0;
    if (contextTokensUsed <= 0 && contextWindowTokens <= 0) return null;
    return { contextTokensUsed, contextWindowTokens };
  } catch {
    return null;
  }
}

/** Collect `type` for each non-empty chat_history line (absolute index order). */
export function collectChatLineTypes(chatText: string): string[] {
  const types: string[] = [];
  for (const line of chatText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { type?: unknown };
      types.push(typeof o.type === 'string' ? o.type : 'unknown');
    } catch {
      types.push('unknown');
    }
  }
  return types;
}

/**
 * Load sibling sidecars for a chat_history path and apply timestamps + tokens
 * via the shared SessionTokenApi (TS writer).
 */
export function applyGrokSidecars(
  fileService: FileService,
  chatHistoryFile: string,
  sessionId: string,
  api: SessionTokenApi,
  opts?: { fallbackCreated?: string | null; lastAssistantIndex?: number | null },
): void {
  const sessionDir = path.dirname(chatHistoryFile);
  let lineTypes: string[];
  try {
    lineTypes = collectChatLineTypes(fileService.readFileSync(chatHistoryFile));
  } catch {
    return;
  }

  let events: GrokEventLine[] = [];
  try {
    events = parseGrokEvents(fileService.readFileSync(path.join(sessionDir, EVENTS_FILE)));
  } catch {
    /* no events */
  }

  const fallback = opts?.fallbackCreated ?? null;
  const tsMap = buildTimestampMap(lineTypes, events, fallback);
  for (const [msgIndex, ts] of tsMap) {
    const t = lineTypes[msgIndex];
    if (t === 'system' || t === 'user' || t === 'assistant' || t === 'reasoning') {
      api.updateMessageTimestamp?.(sessionId, msgIndex, ts);
    }
  }

  let signals: GrokSignals | null = null;
  try {
    signals = parseGrokSignals(fileService.readFileSync(path.join(sessionDir, SIGNALS_FILE)));
  } catch {
    /* no signals */
  }
  if (!signals || signals.contextTokensUsed <= 0) return;

  let lastAssistant = opts?.lastAssistantIndex ?? null;
  if (lastAssistant == null) {
    for (let i = lineTypes.length - 1; i >= 0; i--) {
      if (lineTypes[i] === 'assistant') {
        lastAssistant = i;
        break;
      }
    }
  }
  if (lastAssistant == null) return;

  api.updateMessageTokens(sessionId, lastAssistant, {
    inputTokens: signals.contextTokensUsed,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  api.setSessionTokensEstimated(sessionId, true);
}
