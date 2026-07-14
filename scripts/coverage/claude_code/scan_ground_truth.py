#!/usr/bin/env python3
"""
Scan real Claude Code data (~/.claude) → machine-readable ground truth.

Does **not** go through Spaghetti parsers. Counts files and JSONL line types
so coverage claims can be checked honestly against disk.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Allow `python3 scripts/coverage/claude_code/scan_ground_truth.py`
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import (  # noqa: E402
    default_agent_root,
    dir_size,
    ground_truth_path,
    utc_now_iso,
    write_json,
)

AGENT_ID = "claude-code"
UUID_JSONL = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$",
    re.I,
)


def count_jsonl_types(path: Path, type_counter: Counter, *, max_lines: int | None = None) -> dict:
    stats = {
        "lines": 0,
        "valid_json": 0,
        "empty": 0,
        "parse_errors": 0,
        "bytes": 0,
    }
    try:
        stats["bytes"] = path.stat().st_size
    except OSError:
        return stats
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if max_lines is not None and i >= max_lines:
                    break
                stats["lines"] += 1
                s = line.strip()
                if not s:
                    stats["empty"] += 1
                    continue
                try:
                    obj = json.loads(s)
                    stats["valid_json"] += 1
                    t = obj.get("type", "unknown") if isinstance(obj, dict) else "non_object"
                    type_counter[str(t)] += 1
                except json.JSONDecodeError:
                    stats["parse_errors"] += 1
    except OSError:
        stats["parse_errors"] += 1
    return stats


def inventory_toplevel(root: Path) -> dict:
    """Top-level entries under ~/.claude (presence + size)."""
    out: dict[str, dict] = {}
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        name = entry.name
        # Skip pure noise names from size bombs if needed later
        try:
            if entry.is_file():
                out[name] = {
                    "kind": "file",
                    "bytes": entry.stat().st_size,
                    "exists": True,
                }
            elif entry.is_dir():
                # Cheap sample: count immediate children + recursive size can be huge;
                # use recursive size but it's ok for audit scripts.
                out[name] = {
                    "kind": "dir",
                    "bytes": dir_size(entry),
                    "child_count": sum(1 for _ in entry.iterdir()),
                    "exists": True,
                }
        except OSError as e:
            out[name] = {"kind": "error", "error": str(e), "exists": True}
    return out


def scan(root: Path, *, sample_sessions: int | None = None) -> dict:
    projects_dir = root / "projects"
    msg_types: Counter = Counter()
    project_summaries = []
    session_file_count = 0
    session_bytes = 0
    session_lines = 0
    session_valid = 0
    subagent_files = 0
    tool_result_files = 0
    memory_files = 0
    sessions_index_files = 0
    workflow_files = 0

    if projects_dir.is_dir():
        for proj in sorted(p for p in projects_dir.iterdir() if p.is_dir()):
            sess_files = [p for p in proj.iterdir() if p.is_file() and UUID_JSONL.match(p.name)]
            if sample_sessions is not None:
                sess_files = sess_files[:sample_sessions]

            proj_msg_types: Counter = Counter()
            proj_sessions = 0
            for sf in sess_files:
                st = count_jsonl_types(sf, proj_msg_types)
                session_file_count += 1
                proj_sessions += 1
                session_bytes += st["bytes"]
                session_lines += st["lines"]
                session_valid += st["valid_json"]
            msg_types.update(proj_msg_types)

            mem = proj / "memory" / "MEMORY.md"
            if mem.is_file():
                memory_files += 1
            if (proj / "sessions-index.json").is_file():
                sessions_index_files += 1

            for child in proj.iterdir():
                if not child.is_dir():
                    continue
                sa = child / "subagents"
                if sa.is_dir():
                    for p in sa.rglob("*.jsonl"):
                        if p.is_file():
                            subagent_files += 1
                tr = child / "tool-results"
                if tr.is_dir():
                    for p in tr.rglob("*"):
                        if p.is_file():
                            tool_result_files += 1
                wf = child / "subagents" / "workflows"
                if wf.is_dir():
                    for p in wf.rglob("*"):
                        if p.is_file():
                            workflow_files += 1

            project_summaries.append(
                {
                    "slug": proj.name,
                    "session_files": proj_sessions,
                    "message_type_totals": dict(proj_msg_types),
                    "has_memory": mem.is_file(),
                }
            )

    # Secondary top-level corpora (counts only)
    secondary = {}
    for name, pattern in [
        ("todos", "todos"),
        ("plans", "plans"),
        ("tasks", "tasks"),
        ("file-history", "file-history"),
        ("teams", "teams"),
        ("sessions_pid", "sessions"),
        ("plugins", "plugins"),
    ]:
        d = root / pattern if name != "sessions_pid" else root / "sessions"
        if d.is_dir():
            files = [p for p in d.rglob("*") if p.is_file()]
            secondary[name] = {
                "exists": True,
                "file_count": len(files),
                "bytes": sum(p.stat().st_size for p in files if p.exists()),
            }
        else:
            secondary[name] = {"exists": False, "file_count": 0, "bytes": 0}

    # Bucket ids align with claim.json surface ids where possible
    buckets = {
        "session.jsonl.line": {
            "count": session_valid,
            "lines_total": session_lines,
            "files": session_file_count,
            "bytes": session_bytes,
        },
        "session.message_type": dict(msg_types),
        "project.memory": {"count": memory_files},
        "project.sessions_index": {"count": sessions_index_files},
        "subagent.jsonl": {"count": subagent_files},
        "tool_result.file": {"count": tool_result_files},
        "workflow.file": {"count": workflow_files},
        "secondary": secondary,
        # Alias for unified primary-volume reporting (valid session JSONL lines)
        "primary.records": {
            "count": session_valid,
            "unit": "session_jsonl_line",
        },
    }

    return {
        "schemaVersion": 1,
        "agentId": AGENT_ID,
        "scannedAt": utc_now_iso(),
        "root": str(root),
        "rootExists": root.is_dir(),
        "projectCount": len(project_summaries),
        "sessionCount": session_file_count,
        "toplevel": inventory_toplevel(root),
        "buckets": buckets,
        "projectsSample": project_summaries[:50],  # cap blob size
        "notes": (
            "session.message_type keys are Claude JSONL `type` discriminators. "
            "session.jsonl.line.count / primary.records = valid JSON lines "
            "(not only user/assistant). sessionCount = UUID session files; "
            "projectCount = project directories under projects/."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--root",
        type=str,
        default=None,
        help="Claude data root (default ~/.claude)",
    )
    ap.add_argument(
        "--out",
        type=str,
        default=None,
        help="Output JSON path (default scripts/coverage/out/claude-code-ground-truth.json)",
    )
    ap.add_argument(
        "--sample-sessions-per-project",
        type=int,
        default=None,
        help="Optional cap for faster dry-runs",
    )
    args = ap.parse_args()
    root = Path(args.root).expanduser().resolve() if args.root else default_agent_root(AGENT_ID)
    if not root.is_dir():
        print(f"ERROR: Claude root not found: {root}", file=sys.stderr)
        return 2

    print(f"Scanning Claude Code ground truth under {root} …")
    data = scan(root, sample_sessions=args.sample_sessions_per_project)
    out = Path(args.out) if args.out else ground_truth_path(AGENT_ID)
    write_json(out, data)

    b = data["buckets"]
    print(f"  projects:        {data['projectCount']}")
    print(f"  sessions:        {data['sessionCount']}")
    print(f"  valid jsonl:     {b['session.jsonl.line']['count']}")
    print(f"  message types:   {len(b['session.message_type'])}")
    print(f"  subagent files:  {b['subagent.jsonl']['count']}")
    print(f"  tool-results:    {b['tool_result.file']['count']}")
    print(f"  memory files:    {b['project.memory']['count']}")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
