#!/usr/bin/env python3
"""
Scan real OpenAI Codex CLI data (~/.codex) → machine-readable ground truth.

Does **not** go through Spaghetti. Inventories top-level artifacts and
counts rollout JSONL record kinds (type / payload.type) so coverage claims
must document every observed bucket.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import (  # noqa: E402
    default_agent_root,
    dir_size,
    ground_truth_path,
    utc_now_iso,
    write_json,
)

AGENT_ID = "codex"
ROLLOUT = "rollout-*.jsonl"


def rollout_record_key(obj: dict) -> str:
    """Canonical bucket key for one RolloutLine."""
    t = obj.get("type", "unknown")
    if t == "response_item":
        p = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        return f"response_item/{p.get('type', 'unknown')}"
    if t == "event_msg":
        p = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        return f"event_msg/{p.get('type', 'unknown')}"
    return str(t)


def scan_rollout_file(path: Path, counter: Counter) -> dict:
    stats = {
        "path": str(path),
        "bytes": 0,
        "lines": 0,
        "valid_json": 0,
        "empty": 0,
        "parse_errors": 0,
        "project_cwd": None,  # from first session_meta payload.cwd
        "session_id": None,
    }
    try:
        stats["bytes"] = path.stat().st_size
    except OSError:
        return stats
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                stats["lines"] += 1
                s = line.strip()
                if not s:
                    stats["empty"] += 1
                    continue
                try:
                    obj = json.loads(s)
                    stats["valid_json"] += 1
                    if isinstance(obj, dict):
                        counter[rollout_record_key(obj)] += 1
                        if obj.get("type") == "session_meta" and not stats["project_cwd"]:
                            p = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
                            if isinstance(p.get("cwd"), str) and p["cwd"]:
                                stats["project_cwd"] = p["cwd"]
                            if isinstance(p.get("id"), str) and p["id"]:
                                stats["session_id"] = p["id"]
                    else:
                        counter["non_object"] += 1
                except json.JSONDecodeError:
                    stats["parse_errors"] += 1
    except OSError:
        stats["parse_errors"] += 1
    return stats


def inventory_toplevel(root: Path) -> dict:
    out: dict[str, dict] = {}
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        name = entry.name
        try:
            if entry.is_file():
                out[name] = {
                    "kind": "file",
                    "bytes": entry.stat().st_size,
                    "exists": True,
                }
            elif entry.is_dir():
                files = [p for p in entry.rglob("*") if p.is_file()]
                out[name] = {
                    "kind": "dir",
                    "bytes": sum(p.stat().st_size for p in files),
                    "file_count": len(files),
                    "exists": True,
                }
        except OSError as e:
            out[name] = {"kind": "error", "error": str(e), "exists": True}
    return out


def scan(root: Path, *, max_rollouts: int | None = None) -> dict:
    sessions_dir = root / "sessions"
    record_types: Counter = Counter()
    rollout_files: list[Path] = []
    if sessions_dir.is_dir():
        rollout_files = sorted(sessions_dir.rglob("rollout-*.jsonl"))
        if max_rollouts is not None:
            rollout_files = rollout_files[:max_rollouts]

    per_file = []
    total_bytes = 0
    total_lines = 0
    total_valid = 0
    project_cwds: set[str] = set()
    for rf in rollout_files:
        st = scan_rollout_file(rf, record_types)
        per_file.append(
            {
                "path": st["path"],
                "bytes": st["bytes"],
                "lines": st["lines"],
                "valid_json": st["valid_json"],
                "parse_errors": st["parse_errors"],
                "project_cwd": st.get("project_cwd"),
            }
        )
        total_bytes += st["bytes"]
        total_lines += st["lines"]
        total_valid += st["valid_json"]
        if st.get("project_cwd"):
            project_cwds.add(st["project_cwd"])

    # Spaghetti-relevant vs raw: chat messages are only response_item/message
    chat = record_types.get("response_item/message", 0)
    tools = sum(v for k, v in record_types.items() if "function_call" in k or "custom_tool" in k)
    reasoning = sum(v for k, v in record_types.items() if "reasoning" in k)
    token_events = record_types.get("event_msg/token_count", 0)

    # Unified inventory fields (same keys as Claude scan) for the HTML hero.
    session_count = len(rollout_files)  # one rollout file = one session
    project_count = len(project_cwds)

    return {
        "schemaVersion": 1,
        "agentId": AGENT_ID,
        "scannedAt": utc_now_iso(),
        "root": str(root),
        "rootExists": root.is_dir(),
        "projectCount": project_count,
        "sessionCount": session_count,
        "toplevel": inventory_toplevel(root),
        "buckets": {
            "rollout.file": {
                "count": len(rollout_files),
                "bytes": total_bytes,
                "lines": total_lines,
                "valid_json": total_valid,
            },
            "rollout.record_type": dict(record_types),
            "rollout.chat_messages": {"count": chat},
            "rollout.tool_ish": {"count": tools},
            "rollout.reasoning": {"count": reasoning},
            "rollout.token_count_events": {"count": token_events},
            # Alias for unified primary-volume reporting (valid JSONL lines)
            "primary.records": {
                "count": total_valid,
                "unit": "rollout_jsonl_line",
            },
        },
        "rolloutsSample": per_file[:30],
        "notes": (
            "rollout.record_type keys: response_item/<payload.type>, "
            "event_msg/<payload.type>, or top-level type. "
            "Spaghetti Codex v1 stores only response_item/message as messages; "
            "token_count is used for attribution without storing the event row. "
            "projectCount = unique session_meta.cwd values; sessionCount = rollout files."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=str, default=None, help="Codex data root (default ~/.codex)")
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--max-rollouts", type=int, default=None, help="Cap files for dry-runs")
    args = ap.parse_args()
    root = Path(args.root).expanduser().resolve() if args.root else default_agent_root(AGENT_ID)
    if not root.is_dir():
        print(f"ERROR: Codex root not found: {root}", file=sys.stderr)
        return 2

    print(f"Scanning Codex ground truth under {root} …")
    data = scan(root, max_rollouts=args.max_rollouts)
    out = Path(args.out) if args.out else ground_truth_path(AGENT_ID)
    write_json(out, data)

    b = data["buckets"]
    print(f"  projects:        {data.get('projectCount', 0)}")
    print(f"  sessions:        {data.get('sessionCount', 0)}")
    print(f"  rollout files:   {b['rollout.file']['count']}")
    print(f"  valid jsonl:     {b['rollout.file']['valid_json']}")
    print(f"  record kinds:    {len(b['rollout.record_type'])}")
    print(f"  chat messages:   {b['rollout.chat_messages']['count']}")
    print(f"  tool-ish:        {b['rollout.tool_ish']['count']}")
    print(f"  reasoning:       {b['rollout.reasoning']['count']}")
    print(f"  token_count:     {b['rollout.token_count_events']['count']}")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
