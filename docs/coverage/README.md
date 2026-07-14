# Agent data coverage claims

These docs are the **human** side of the coverage harness under `scripts/coverage/`.

| Agent | Claim (machine) | Human summary | Scanner |
|---|---|---|---|
| Claude Code | [`scripts/coverage/claude_code/claim.json`](../../scripts/coverage/claude_code/claim.json) | [claude-code.md](./claude-code.md) | `scan_ground_truth.py` |
| Codex CLI | [`scripts/coverage/codex/claim.json`](../../scripts/coverage/codex/claim.json) | [codex.md](./codex.md) | `scan_ground_truth.py` |

**Rule:** if it exists on a real install with non-trivial size/count, it must appear in the claim as ingested, partial, ignored, or out_of_scope. Silent omission is a validation failure.

```bash
pnpm coverage:check
pnpm coverage:report   # → docs/coverage/report.html
```

**Interactive report:** open [report.html](./report.html) in a browser (rebuild after scanning so ground-truth bars stay current).

See [`scripts/coverage/README.md`](../../scripts/coverage/README.md) for the full harness.
