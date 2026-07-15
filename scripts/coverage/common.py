#!/usr/bin/env python3
"""Shared helpers for multi-agent ground-truth + coverage validation."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# scripts/coverage/ → repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
COVERAGE_DIR = Path(__file__).resolve().parent
OUT_DIR = COVERAGE_DIR / "out"

# Coverage claim statuses (machine-checked).
# - ingested: counted into the product index (or first-class query API)
# - partial: some fields/paths ingested; residual left in raw or dropped
# - ignored: present on disk; deliberately not ingested (document why)
# - out_of_scope: must-not-parse (credentials) or non-agent noise
# - unknown: scanner found it; claim has no entry → validation FAIL
STATUSES = frozenset({"ingested", "partial", "ignored", "out_of_scope", "unknown"})


def utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def expand_home(p: str | Path) -> Path:
    return Path(os.path.expanduser(str(p))).resolve()


def ensure_out_dir() -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUT_DIR


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n / 1024:.1f} KB"
    if n < 1024**3:
        return f"{n / (1024**2):.1f} MB"
    return f"{n / (1024**3):.2f} GB"


def format_num(n: int) -> str:
    return f"{n:,}"


def dir_size(path: Path) -> int:
    total = 0
    try:
        for p in path.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


def print_check(r: CheckResult) -> None:
    status = "PASS" if r.ok else "FAIL"
    line = f"  [{status}] {r.name}"
    if r.detail:
        line += f" — {r.detail}"
    print(line)


def summarize_checks(results: Iterable[CheckResult], *, title: str) -> int:
    results = list(results)
    passed = sum(1 for r in results if r.ok)
    failed = sum(1 for r in results if not r.ok)
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)
    for r in results:
        print_check(r)
    print("-" * 72)
    print(f"  {passed} passed, {failed} failed / {len(results)} checks")
    if failed:
        print("\n  Failed:")
        for r in results:
            if not r.ok:
                print(f"    - {r.name}: {r.detail or '(no detail)'}")
    return 0 if failed == 0 else 1


def load_claim(agent_dir: Path) -> dict[str, Any]:
    path = agent_dir / "claim.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing claim file: {path}")
    claim = read_json(path)
    if "agentId" not in claim or "surfaces" not in claim:
        raise ValueError(f"Invalid claim schema in {path}")
    return claim


def claim_surface_map(claim: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for s in claim["surfaces"]:
        sid = s["id"]
        if sid in out:
            raise ValueError(f"Duplicate surface id in claim: {sid}")
        status = s.get("status")
        if status not in STATUSES - {"unknown"}:
            raise ValueError(f"Surface {sid}: invalid status {status!r}")
        out[sid] = s
    return out


def ground_truth_path(agent_id: str) -> Path:
    return ensure_out_dir() / f"{agent_id}-ground-truth.json"


def default_agent_root(agent_id: str) -> Path:
    if agent_id == "claude-code":
        return expand_home("~/.claude")
    if agent_id == "codex":
        return expand_home("~/.codex")
    if agent_id == "grok":
        return expand_home("~/.grok")
    raise ValueError(f"Unknown agent id: {agent_id}")


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)
