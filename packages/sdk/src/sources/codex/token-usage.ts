/**
 * Codex `token_count` event parsing (ccusage / AgentsView style).
 *
 * Codex does not put tokens on chat lines. After each model turn it emits:
 *
 * ```json
 * {
 *   "type": "event_msg",
 *   "payload": {
 *     "type": "token_count",
 *     "info": {
 *       "total_token_usage": { input_tokens, cached_input_tokens, output_tokens,
 *                             reasoning_output_tokens, total_tokens },
 *       "last_token_usage":  { … same shape — this turn … },
 *       "model_context_window": number
 *     }
 *   }
 * }
 * ```
 *
 * `total_*` is cumulative for the session; `last_*` is the most recent turn.
 * Some lines have `info: null` (rate-limits only) — those yield null here.
 *
 * Mapping into Spaghetti's four token columns:
 *   input_tokens            → inputTokens
 *   cached_input_tokens     → cacheReadTokens
 *   output + reasoning      → outputTokens  (we have no separate reasoning col)
 *   (none)                  → cacheCreationTokens = 0
 */

export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Codex-native total (includes reasoning); useful for reconciliation. */
  totalTokens: number;
  reasoningOutputTokens: number;
}

export interface ParsedCodexTokenCount {
  /** Last turn usage — prefer this for per-assistant-message attribution. */
  last: CodexTokenUsage | null;
  /** Session cumulative — last non-null value is the session total. */
  total: CodexTokenUsage | null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mapUsage(raw: Record<string, unknown>): CodexTokenUsage {
  const input = num(raw.input_tokens);
  const cached = num(raw.cached_input_tokens);
  const output = num(raw.output_tokens);
  const reasoning = num(raw.reasoning_output_tokens);
  const total = num(raw.total_tokens);
  return {
    inputTokens: input,
    // Fold reasoning into output so formatTokens(totalTokens(...)) includes it.
    outputTokens: output + reasoning,
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
    totalTokens: total || input + output + reasoning,
    reasoningOutputTokens: reasoning,
  };
}

/**
 * Parse one raw JSONL record. Returns `null` if this is not a token_count
 * event (or has no usable `info`).
 */
export function parseCodexTokenCount(raw: unknown): ParsedCodexTokenCount | null {
  if (!raw || typeof raw !== 'object') return null;
  const line = raw as Record<string, unknown>;
  if (line.type !== 'event_msg') return null;
  const payload = line.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'token_count') return null;
  const info = payload.info;
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;

  const totalRaw = i.total_token_usage;
  const lastRaw = i.last_token_usage;
  const total = totalRaw && typeof totalRaw === 'object' ? mapUsage(totalRaw as Record<string, unknown>) : null;
  const last = lastRaw && typeof lastRaw === 'object' ? mapUsage(lastRaw as Record<string, unknown>) : null;

  if (!total && !last) return null;
  return { last, total };
}
