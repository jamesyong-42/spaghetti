#!/usr/bin/env python3
"""Validate coverage claims (optionally re-scan first)."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "agent",
        nargs="?",
        default="all",
        choices=["claude-code", "codex", "grok", "all"],
    )
    ap.add_argument(
        "--rescan",
        action="store_true",
        help="Run ground-truth scan before validating",
    )
    args = ap.parse_args()
    if args.rescan:
        r = subprocess.call([sys.executable, str(BASE / "run_scan.py"), args.agent])
        if r != 0:
            return r
    return subprocess.call([sys.executable, str(BASE / "validate_claim.py"), args.agent])


if __name__ == "__main__":
    raise SystemExit(main())
