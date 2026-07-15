# Grok CLI (xAI) — coverage claim (human summary)

**Updated:** 2026-07-15  
**Root:** `~/.grok`  
**Machine claim:** `scripts/coverage/grok/claim.json`  
**Related:** `docs/rfcs/006-appendix-agent-survey.md`

## Honest framing

Grok is a **full multi-agent source** for Spaghetti’s thin core: projects, sessions, conversational messages, FTS, live chat_history tail, and session-level token aggregates. Tool I/O and the ACP UI stream are deliberately **not** productized yet — but they stay documented so we never confuse “chose not to” with “no data.”

## Ground truth (scanner)

- All `sessions/**/chat_history.jsonl` lines, bucketed by `type`
- Sibling files per session: `summary.json`, `events.jsonl`, `signals.json`, `updates.jsonl`
- Top-level `~/.grok/*` presence + size

```bash
python3 scripts/coverage/run_scan.py grok
python3 scripts/coverage/validate_claim.py grok
```

## Ingested (product)

| Surface | Engines | Notes |
|---|---|---|
| `chat_history` file discovery | TS + RS | Cold/warm native default |
| `system` / `user` / `assistant` / `reasoning` | TS + RS | Message rows + FTS |
| Live chat_history tail | TS watch + RS `liveIngestBatch` when `engine=rs` | |

## Partial

| Surface | Notes |
|---|---|
| `summary.json` | Session meta (cwd, title, times, branch) only |
| `events.jsonl` | Turn-scoped timestamps on message columns (not stored as rows) |
| `signals.json` | `contextTokensUsed` → last assistant + `tokens_estimated` |

## Ignored (present, not productized)

- `tool_result`, `backend_tool_call` (extract → null)
- `updates.jsonl` (UI stream, high volume)
- Derived SQLite / misc root files

## Engines

| | TS | RS |
|---|---|---|
| Grok cold/warm | yes (fallback) | **yes** (`native.ingest({ sourceId: 'grok' })`) |
| Grok live disk | yes | **yes** (writeBatch → liveIngestBatch) |
| Timestamps / session tokens | yes | yes |

## How to re-verify

```bash
pnpm test:ingest-diff:grok
python3 scripts/coverage/run_scan.py grok
python3 scripts/coverage/validate_claim.py grok
```
