#!/usr/bin/env python3
"""Run ground-truth scanners for one or all agents."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent

AGENTS = {
    "claude-code": BASE / "claude_code" / "scan_ground_truth.py",
    "codex": BASE / "codex" / "scan_ground_truth.py",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("agent", nargs="?", default="all", choices=["claude-code", "codex", "all"])
    ap.add_argument("--max-rollouts", type=int, default=None, help="Codex only: cap rollout files")
    ap.add_argument(
        "--sample-sessions-per-project",
        type=int,
        default=None,
        help="Claude only: cap sessions per project",
    )
    args, rest = ap.parse_known_args()
    agents = list(AGENTS) if args.agent == "all" else [args.agent]
    code = 0
    for a in agents:
        script = AGENTS[a]
        cmd = [sys.executable, str(script), *rest]
        if a == "codex" and args.max_rollouts is not None:
            cmd += ["--max-rollouts", str(args.max_rollouts)]
        if a == "claude-code" and args.sample_sessions_per_project is not None:
            cmd += ["--sample-sessions-per-project", str(args.sample_sessions_per_project)]
        print(f"\n>>> {' '.join(cmd)}")
        r = subprocess.call(cmd)
        if r != 0:
            code = r
    return code


if __name__ == "__main__":
    raise SystemExit(main())
