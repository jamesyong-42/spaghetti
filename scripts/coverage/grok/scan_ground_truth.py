#!/usr/bin/env python3
"""
Scan real Grok CLI (xAI) data (~/.grok) → machine-readable ground truth.

Does **not** go through Spaghetti. Inventories top-level artifacts and
counts chat_history.jsonl record types plus sibling sidecars so coverage
claims must document every observed bucket.
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
    ground_truth_path,
    utc_now_iso,
    write_json,
)

AGENT_ID = "grok"
CHAT_HISTORY = "chat_history.jsonl"
SIBLINGS = ("summary.json", "events.jsonl", "signals.json", "updates.jsonl")


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


def scan_chat_history(path: Path, counter: Counter) -> dict:
    stats = {
        "path": str(path),
        "bytes": 0,
        "lines": 0,
        "valid_json": 0,
        "empty": 0,
        "parse_errors": 0,
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
                        t = obj.get("type", "unknown")
                        counter[str(t)] += 1
                    else:
                        counter["non_object"] += 1
                except json.JSONDecodeError:
                    stats["parse_errors"] += 1
    except OSError:
        stats["parse_errors"] += 1
    return stats


def scan(root: Path, *, max_sessions: int | None = None) -> dict:
    sessions_dir = root / "sessions"
    record_types: Counter = Counter()
    chat_files: list[Path] = []
    if sessions_dir.is_dir():
        chat_files = sorted(sessions_dir.rglob(CHAT_HISTORY))
        if max_sessions is not None:
            chat_files = chat_files[:max_sessions]

    sibling_counts: Counter = Counter()
    project_dirs: set[str] = set()
    total_bytes = 0
    total_lines = 0
    total_valid = 0
    per_file = []

    for cf in chat_files:
        st = scan_chat_history(cf, record_types)
        per_file.append(
            {
                "path": st["path"],
                "bytes": st["bytes"],
                "lines": st["lines"],
                "valid_json": st["valid_json"],
                "parse_errors": st["parse_errors"],
            }
        )
        total_bytes += st["bytes"]
        total_lines += st["lines"]
        total_valid += st["valid_json"]
        # sessions/<encoded-cwd>/<uuid>/chat_history.jsonl
        session_dir = cf.parent
        project_dirs.add(str(session_dir.parent))
        for name in SIBLINGS:
            p = session_dir / name
            if p.is_file():
                sibling_counts[name] += 1

    conversational = sum(
        record_types.get(t, 0) for t in ("system", "user", "assistant", "reasoning")
    )
    tool_ish = sum(
        v
        for k, v in record_types.items()
        if k in ("tool_result", "backend_tool_call") or "tool" in k
    )

    return {
        "schemaVersion": 1,
        "agentId": AGENT_ID,
        "scannedAt": utc_now_iso(),
        "root": str(root),
        "rootExists": root.is_dir(),
        "projectCount": len(project_dirs),
        "sessionCount": len(chat_files),
        "toplevel": inventory_toplevel(root),
        "buckets": {
            "chat_history.file": {
                "count": len(chat_files),
                "bytes": total_bytes,
                "lines": total_lines,
                "valid_json": total_valid,
            },
            "chat_history.record_type": dict(record_types),
            "chat_history.conversational": {"count": conversational},
            "chat_history.tool_ish": {"count": tool_ish},
            "sibling.summary.json": {"count": sibling_counts.get("summary.json", 0)},
            "sibling.events.jsonl": {"count": sibling_counts.get("events.jsonl", 0)},
            "sibling.signals.json": {"count": sibling_counts.get("signals.json", 0)},
            "sibling.updates.jsonl": {"count": sibling_counts.get("updates.jsonl", 0)},
            "primary.records": {
                "count": total_valid,
                "unit": "chat_history_jsonl_line",
            },
        },
        "sessionsSample": per_file[:30],
        "notes": (
            "chat_history.record_type keys are the `type` field on each JSONL line. "
            "Spaghetti Grok v1 stores system/user/assistant/reasoning as messages; "
            "tool_result/backend_tool_call are skipped. "
            "events.jsonl → timestamps; signals.json → session token aggregate; "
            "updates.jsonl is UI stream (ignored). "
            "projectCount = unique encoded-cwd session parents; sessionCount = chat_history files."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=str, default=None, help="Grok data root (default ~/.grok)")
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--max-sessions", type=int, default=None, help="Cap chat_history files for dry-runs")
    args = ap.parse_args()
    root = Path(args.root).expanduser().resolve() if args.root else default_agent_root(AGENT_ID)

    # Empty install: still write ground truth so validate can run offline.
    if not root.is_dir():
        print(f"WARN: Grok root not found: {root} — writing empty ground truth", file=sys.stderr)
        data = {
            "schemaVersion": 1,
            "agentId": AGENT_ID,
            "scannedAt": utc_now_iso(),
            "root": str(root),
            "rootExists": False,
            "projectCount": 0,
            "sessionCount": 0,
            "toplevel": {},
            "buckets": {
                "chat_history.file": {"count": 0, "bytes": 0, "lines": 0, "valid_json": 0},
                "chat_history.record_type": {},
                "chat_history.conversational": {"count": 0},
                "chat_history.tool_ish": {"count": 0},
                "sibling.summary.json": {"count": 0},
                "sibling.events.jsonl": {"count": 0},
                "sibling.signals.json": {"count": 0},
                "sibling.updates.jsonl": {"count": 0},
                "primary.records": {"count": 0, "unit": "chat_history_jsonl_line"},
            },
            "sessionsSample": [],
            "notes": "empty root",
        }
    else:
        print(f"Scanning Grok ground truth under {root} …")
        data = scan(root, max_sessions=args.max_sessions)

    out = Path(args.out) if args.out else ground_truth_path(AGENT_ID)
    write_json(out, data)

    b = data["buckets"]
    print(f"  projects:        {data.get('projectCount', 0)}")
    print(f"  sessions:        {data.get('sessionCount', 0)}")
    print(f"  chat_history:    {b['chat_history.file']['count']}")
    print(f"  valid jsonl:     {b['chat_history.file']['valid_json']}")
    print(f"  record kinds:    {len(b['chat_history.record_type'])}")
    print(f"  conversational:  {b['chat_history.conversational']['count']}")
    print(f"  tool-ish:        {b['chat_history.tool_ish']['count']}")
    print(f"  events siblings: {b['sibling.events.jsonl']['count']}")
    print(f"  signals siblings:{b['sibling.signals.json']['count']}")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
