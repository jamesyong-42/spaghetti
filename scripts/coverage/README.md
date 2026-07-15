# Multi-agent coverage harness

Honest inventory of **what lives on disk** vs **what Spaghetti claims to ingest**, per agent.

This is not a unit test of parsers — it is a **product honesty** tool:

1. **Scan** real agent homes (`~/.claude`, `~/.codex`, …) without going through Spaghetti.
2. **Claim** (checked-in JSON + docs) documents each surface as `ingested` | `partial` | `ignored` | `out_of_scope`.
3. **Validate** fails if ground truth shows non-empty data with **no claim** (silent gaps).

## Quick start

```bash
# From repo root
pnpm coverage:scan          # scan all agents → scripts/coverage/out/
pnpm coverage:validate      # check claims against last scan

# Or re-scan then validate
pnpm coverage:check         # scan + validate

# HTML report (self-contained; open in a browser)
pnpm coverage:report
open docs/coverage/report.html   # or scripts/coverage/out/report.html

# One agent
python3 scripts/coverage/run_scan.py codex
python3 scripts/coverage/validate_claim.py codex
```

Dry-run (faster, incomplete):

```bash
python3 scripts/coverage/run_scan.py codex --max-rollouts 10
python3 scripts/coverage/run_scan.py claude-code --sample-sessions-per-project 5
```

## Layout

```text
scripts/coverage/
  common.py                 shared helpers
  run_scan.py               entry: scan
  run_validate.py           entry: validate (± --rescan)
  validate_claim.py         claim ↔ ground-truth checks
  build_report.py           build self-contained HTML report
  out/                      local scan JSON + report.html (gitignored)
  claude_code/
    scan_ground_truth.py
    claim.json              machine claim (source of truth)
  codex/
    scan_ground_truth.py
    claim.json
  grok/
    scan_ground_truth.py
    claim.json

docs/coverage/
  README.md                 index
  claude-code.md            human summary (keep in sync with claim.json)
  codex.md
  grok.md
```

## Claim status meanings

| Status | Meaning |
|---|---|
| `ingested` | Product index / first-class API includes this data |
| `partial` | Some fields used (e.g. peek meta, token side-effect) or incomplete engine |
| `ignored` | Present on disk; **deliberately** not productized yet (must document why) |
| `out_of_scope` | Secrets, IDE noise, tmp — must-not-parse |

`unknown` is never written in claims — validation **assigns** unknown when ground truth has no covering surface.

## Adding a new agent

1. `scripts/coverage/<agent>/scan_ground_truth.py` — pure disk inventory  
2. `scripts/coverage/<agent>/claim.json` — document every observed bucket  
3. `docs/coverage/<agent>.md` — human summary  
4. Register in `run_scan.py` `AGENTS` map  
5. Run `pnpm coverage:check` on a machine with real data  

## Relation to older scripts

| Legacy | Role now |
|---|---|
| `scripts/ground-truth.py` | Claude-only narrative scanner — superseded by `claude_code/scan_ground_truth.py` |
| `scripts/validate_*.py` | **Type** validators (schema drift on real JSON) — still useful, different job |
| `scripts/validate-all.sh` | Runs type validators via `pnpm validate` |
| This harness | **Coverage honesty** (claim vs disk volume) |

Keep both: types can be complete while coverage is thin (Codex tools), or coverage claimed while types lag.

## Policy (default)

- Non-zero rollout record types must be claimed (Codex).  
- Non-empty top-level root entries must be claimed.  
- Zero-count buckets need no claim.  
- Ingested **percentage** is informational (does not fail the suite).  
