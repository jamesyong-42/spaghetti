/**
 * Tiktoken-based token *estimate* for Codex sessions that lack `token_count`
 * events (pre-2025-09 logs, sparse interactive sessions, etc.).
 *
 * This is intentionally NOT billing-accurate:
 *  - counts only stored `text_content` (visible prose)
 *  - ignores system/tool/image/cache overhead
 *  - uses o200k_base (GPT-4o / modern OpenAI family)
 *
 * Callers MUST mark the session as estimated so the UI can show "~" and never
 * mix these with official API counts without a label.
 */

import { getEncoding } from 'js-tiktoken';

export type EstimatedMessageTokens = {
  msgIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

/** Lazy singleton — encoding load is non-trivial. */
let enc: ReturnType<typeof getEncoding> | null = null;

function encoding() {
  if (!enc) enc = getEncoding('o200k_base');
  return enc;
}

/** Count BPE tokens for a string. Empty/null → 0. */
export function countTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  try {
    return encoding().encode(text).length;
  } catch {
    // Extremely large strings or encoder failures — fall back to a coarse
    // chars/4 heuristic rather than aborting ingest.
    return Math.ceil(text.length / 4);
  }
}

/**
 * Build per-message token estimates from already-stored rows.
 * - user / developer → input
 * - assistant → output
 * - other types → ignored (0)
 */
export function estimateTokensFromMessageRows(
  rows: Array<{ msg_index: number; msg_type: string; text_content: string | null }>,
): EstimatedMessageTokens[] {
  const out: EstimatedMessageTokens[] = [];
  for (const row of rows) {
    const n = countTextTokens(row.text_content ?? '');
    if (n === 0) continue;
    const type = row.msg_type;
    if (type === 'user' || type === 'developer') {
      out.push({
        msgIndex: row.msg_index,
        inputTokens: n,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    } else if (type === 'assistant') {
      out.push({
        msgIndex: row.msg_index,
        inputTokens: 0,
        outputTokens: n,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    }
  }
  return out;
}
