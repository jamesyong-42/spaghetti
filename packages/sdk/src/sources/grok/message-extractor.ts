/**
 * Grok CLI (xAI) MessageExtractor (RFC 006 third source).
 *
 * Grok stores one JSON object per line in
 * `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/chat_history.jsonl`. Unlike
 * Codex there is NO envelope: each line IS a typed record, discriminated by
 * `type`:
 *   - `system`    → `{ content: string }`
 *   - `user`      → `{ content: [{ type:'text', text }] }`      (block array)
 *   - `assistant` → `{ content: string, tool_calls?: [...] }`   (prose string)
 *   - `reasoning` → `{ summary: [{ type:'summary_text', text }], id, encrypted_content }`
 *   - `tool_result` / `backend_tool_call` → tool I/O
 *
 * We keep the conversational turns (system/user/assistant) and the reasoning
 * SUMMARIES (small, human-readable, the transparency Claude's thinking blocks
 * give) as message rows. `tool_result` and `backend_tool_call` are tool I/O —
 * high-volume and noisy for list/FTS (one session had 385 tool_results) — so
 * they are skipped via the `extract() → null` contract, mirroring how the Codex
 * extractor skips its function_call/non-message lines. The verbatim line is
 * still preserved in `messages.data` for the rows we DO keep.
 *
 * Differences from Codex/Claude this normalizes away:
 *  - text lives in different fields per type (`content` string, `content[]`
 *    block array, or `summary[]`); one text collector handles all shapes.
 *  - chat_history lines carry NO per-message tokens (session-level only, in the
 *    sibling `signals.json`) and NO per-message timestamp (turn-level, in
 *    `events.jsonl`). So tokens are zero and timestamp is null by design —
 *    `sourceReportsPerMessageTokens('grok')` is false so the UI stays honest.
 */

import type { ExtractedMessage, MessageExtractor } from '../types.js';

/** FTS/preview text cap — matches the other extractors' convention. */
const MAX_TEXT_LENGTH = 2_000;

function truncate(text: string): string {
  return text.length <= MAX_TEXT_LENGTH ? text : text.substring(0, MAX_TEXT_LENGTH);
}

const ZERO_TOKENS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
} as const;

/**
 * Collect readable text from any Grok content shape: a bare string, or an array
 * of blocks each carrying a `text` field (`{type:'text'|'summary_text', text}`).
 */
function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const block of value) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

export const grokMessageExtractor: MessageExtractor = {
  extract(raw: unknown): ExtractedMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : '';

    let text: string;
    let uuid: string | null = null;
    switch (type) {
      case 'system':
      case 'user':
      case 'assistant':
        // system/assistant carry a `content` string, user a `content[]` array.
        text = collectText(rec.content);
        break;
      case 'reasoning':
        // Reasoning text is the plaintext `summary[]`; `encrypted_content` is opaque.
        text = collectText(rec.summary);
        uuid = typeof rec.id === 'string' ? rec.id : null;
        break;
      default:
        // tool_result / backend_tool_call / unknown — not a conversational row.
        return null;
    }

    return {
      msgType: type,
      text: truncate(text),
      uuid,
      timestamp: null, // per-message time is not in chat_history.jsonl (see events.jsonl)
      tokens: { ...ZERO_TOKENS },
    };
  },
};
