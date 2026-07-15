/**
 * Grok sidecar enrichment — timestamps from events.jsonl, session tokens from
 * signals.json.
 *
 * chat_history.jsonl has no per-message time or tokens. Siblings carry them:
 *   - events.jsonl: turn_started / loop_started / first_token with `ts`
 *   - signals.json: session aggregates (contextTokensUsed, …)
 *
 * Join heuristic (best-effort, documented):
 *   - system → summary.created_at fallback
 *   - user → turn_started (prefer conversation_message_count as line index)
 *   - reasoning → loop_started (ordered)
 *   - assistant → first_token (ordered)
 *   - leftover users/system → created_at fallback
 *
 * Session tokens: attribute contextTokensUsed to the last assistant message
 * and set tokens_estimated=1 (session aggregate, not per-message official).
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
}

/**
 * Build absolute-line-index → ISO timestamp map from chat line types + events.
 * `lineTypes[i]` is the `type` field of non-empty chat_history line i
 * (including tool lines that will not become message rows).
 */
export function buildTimestampMap(
  lineTypes: string[],
  events: GrokEventLine[],
  fallbackCreated: string | null,
): Map<number, string> {
  const map = new Map<number, string>();

  // 1) turn_started → user at conversation_message_count (or next user line).
  for (const e of events) {
    if (e.type !== 'turn_started' || !e.ts) continue;
    if (typeof e.conversation_message_count === 'number') {
      let idx = e.conversation_message_count;
      while (idx < lineTypes.length && lineTypes[idx] !== 'user') idx++;
      if (idx < lineTypes.length && !map.has(idx)) {
        map.set(idx, e.ts);
      }
    }
  }

  // Remaining turn_started timestamps for still-unstamped users (order).
  const leftoverTurns = events.filter((e) => e.type === 'turn_started' && e.ts).map((e) => e.ts);
  let turnI = 0;
  // Skip turns already used via conversation_message_count by counting stamped users.
  const stampedUsers = [...map.keys()].filter((i) => lineTypes[i] === 'user').length;
  turnI = Math.min(stampedUsers, leftoverTurns.length);

  const loopStarts = events.filter((e) => e.type === 'loop_started' && e.ts).map((e) => e.ts);
  const firstTokens = events.filter((e) => e.type === 'first_token' && e.ts).map((e) => e.ts);
  let loopI = 0;
  let firstI = 0;

  for (let i = 0; i < lineTypes.length; i++) {
    if (map.has(i)) continue;
    const t = lineTypes[i];
    if (t === 'system') {
      if (fallbackCreated) map.set(i, fallbackCreated);
    } else if (t === 'user') {
      if (turnI < leftoverTurns.length) map.set(i, leftoverTurns[turnI++]);
      else if (fallbackCreated) map.set(i, fallbackCreated);
    } else if (t === 'reasoning') {
      if (loopI < loopStarts.length) map.set(i, loopStarts[loopI++]);
      else if (firstI < firstTokens.length) map.set(i, firstTokens[firstI++]);
    } else if (t === 'assistant') {
      if (firstI < firstTokens.length) map.set(i, firstTokens[firstI++]);
    }
  }

  return map;
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
  let lineTypes: string[] = [];
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
    // Only stamp lines that become message rows (extractor keeps these).
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

  // Last assistant absolute line index (prefer caller-provided for live path).
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
