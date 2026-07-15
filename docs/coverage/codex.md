# Codex CLI — coverage claim (human summary)

**Updated:** 2026-07-13  
**Root:** `~/.codex`  
**Machine claim:** `scripts/coverage/codex/claim.json`  
**Related:** `docs/rfcs/006-appendix-agent-survey.md`

## Honest framing

Codex **is not a shallow agent** on disk. Real rollouts are dominated by **tool calls + reasoning**, not chat. Spaghetti **v1 intentionally under-indexes** that stream so multi-agent list/search/tokens work first.

This claim exists so we never confuse “we chose not to” with “Codex has no data.”

## Ground truth (scanner)

- All `sessions/**/rollout-*.jsonl` lines, bucketed as:
  - `response_item/<payload.type>`
  - `event_msg/<payload.type>`
  - other top-level `type`s
- Top-level `~/.codex/*` presence + size (config, history, sqlite DBs, memories, …)

## Ingested (product)

| Surface | Engine | Notes |
|---|---|---|
| Rollout files | TS only | `CodexReader` |
| `response_item/message` | TS | Chat turns → `messages` + FTS |
| Project/session from `session_meta` | TS | cwd → slug; partial (peek only) |

## Partial

| Surface | Notes |
|---|---|
| `event_msg/token_count` | Attribute tokens onto assistant; not stored as rows; else tiktoken `~` |

## Ignored (present, not productized)

**High volume (typical installs):**

- `response_item/function_call` + `_output`  
- `response_item/custom_tool_call` + `_output`  
- `response_item/reasoning`  
- Most other `event_msg/*` (UI projection; prefer `response_item` as SoT)  
- `turn_context`, `compacted`, `world_state`, web_search_call, …

**Side artifacts:**

- `config.toml`, `history.jsonl`, `memories*`, `shell_snapshots`, skills/plugins/rules  
- Derived SQLite: `state_*.sqlite`, `logs_*.sqlite`, `goals_*.sqlite` (not transcript SoT)

## Out of scope

`auth.json`, tmp/IDE noise, installation ids.

## Engines

| | TS | RS |
|---|---|---|
| Codex cold/warm | yes (fallback) | **yes** (`native.ingest({ sourceId: 'codex' })`) |
| Codex live disk | yes | not yet (TS live watch; Grok live does use RS writeBatch) |
| Tiktoken estimate when no `token_count` | yes | not yet (official attribution only) |

## How to re-verify

```bash
python3 scripts/coverage/run_scan.py codex
python3 scripts/coverage/validate_claim.py codex
# Expect: info line showing low % of records status=ingested (honest thin core)
```
