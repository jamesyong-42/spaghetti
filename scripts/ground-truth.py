#!/usr/bin/env python3
"""
Ground Truth Measurement of ~/.claude

Exhaustive audit of ALL data in ~/.claude/projects/ to establish
absolute correctness baselines for validating spaghetti CLI output.
"""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$"
)

OUTPUT_JSON = Path(__file__).parent / "ground-truth-output.json"


def decode_folder_name(slug: str) -> str:
    """Decode a project slug into a human-readable folder name.

    The slug is the absolute path with / replaced by - and leading -.
    e.g. '-Users-jamesyong-Projects-project100-p008-spaghetti'
    -> last segment is 'spaghetti'
    """
    # Remove leading dash
    cleaned = slug.lstrip("-")
    # Split on - but be aware that folder names can contain dashes
    # The slug encodes path separators as -, so we try to extract
    # the last meaningful path segment
    parts = cleaned.split("-")
    if not parts:
        return slug
    # The slug is like Users-jamesyong-Projects-project100-p008-spaghetti
    # We want the last segment(s) that form the folder name
    # Strategy: return everything after the last recognized path component
    return parts[-1] if parts else slug


def analyze_session_file(filepath: Path) -> dict:
    """Analyze a single .jsonl session file."""
    result = {
        "file_path": str(filepath),
        "file_size_bytes": 0,
        "total_lines": 0,
        "valid_json_lines": 0,
        "empty_lines": 0,
        "parse_errors": 0,
        "message_types": defaultdict(int),
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_tokens": 0,
        "cache_read_tokens": 0,
    }

    try:
        result["file_size_bytes"] = filepath.stat().st_size
    except OSError:
        return result

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                result["total_lines"] += 1
                stripped = line.strip()
                if not stripped:
                    result["empty_lines"] += 1
                    continue
                try:
                    obj = json.loads(stripped)
                    result["valid_json_lines"] += 1
                    msg_type = obj.get("type", "unknown")
                    result["message_types"][msg_type] += 1

                    # Extract token counts from assistant messages
                    if msg_type == "assistant":
                        message = obj.get("message", {})
                        usage = message.get("usage", {})
                        if usage:
                            result["input_tokens"] += usage.get("input_tokens", 0)
                            result["output_tokens"] += usage.get("output_tokens", 0)
                            result["cache_creation_tokens"] += usage.get(
                                "cache_creation_input_tokens", 0
                            )
                            result["cache_read_tokens"] += usage.get(
                                "cache_read_input_tokens", 0
                            )
                except json.JSONDecodeError:
                    result["parse_errors"] += 1
    except (OSError, UnicodeDecodeError) as e:
        print(f"  WARNING: Could not read {filepath}: {e}", file=sys.stderr)

    # Convert defaultdict to regular dict for JSON serialization
    result["message_types"] = dict(result["message_types"])
    return result


def analyze_project(project_dir: Path) -> dict:
    """Analyze a single project directory."""
    slug = project_dir.name
    folder_name = decode_folder_name(slug)

    result = {
        "slug": slug,
        "folder_name": folder_name,
        "session_count": 0,
        "session_index_count": None,
        "session_index_exists": False,
        "total_messages": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_creation_tokens": 0,
        "total_cache_read_tokens": 0,
        "has_memory": False,
        "newest_file_mtime": None,
        "oldest_file_mtime": None,
        "newest_file_mtime_iso": None,
        "oldest_file_mtime_iso": None,
        "sessions": [],
        "message_type_totals": defaultdict(int),
        "total_session_file_size_bytes": 0,
        "subagent_file_count": 0,
        "tool_result_file_count": 0,
        "total_disk_usage_bytes": 0,
    }

    # Check for memory/MEMORY.md
    memory_path = project_dir / "memory" / "MEMORY.md"
    result["has_memory"] = memory_path.exists()

    # Check for sessions-index.json
    sessions_index_path = project_dir / "sessions-index.json"
    if sessions_index_path.exists():
        result["session_index_exists"] = True
        try:
            with open(sessions_index_path, "r") as f:
                index_data = json.load(f)
                entries = index_data.get("entries", [])
                result["session_index_count"] = len(entries)
        except (json.JSONDecodeError, OSError) as e:
            print(
                f"  WARNING: Could not parse {sessions_index_path}: {e}",
                file=sys.stderr,
            )
            result["session_index_count"] = -1  # Error marker

    # Find all UUID .jsonl session files (directly in project dir)
    session_files = []
    try:
        for entry in project_dir.iterdir():
            if entry.is_file() and UUID_PATTERN.match(entry.name):
                session_files.append(entry)
    except OSError as e:
        print(f"  WARNING: Could not list {project_dir}: {e}", file=sys.stderr)

    result["session_count"] = len(session_files)

    # Track mtimes
    newest_mtime = None
    oldest_mtime = None

    # Analyze each session file
    for sf in session_files:
        session_analysis = analyze_session_file(sf)
        result["sessions"].append(
            {
                "session_id": sf.stem,
                "file_size_bytes": session_analysis["file_size_bytes"],
                "total_lines": session_analysis["total_lines"],
                "valid_json_lines": session_analysis["valid_json_lines"],
                "empty_lines": session_analysis["empty_lines"],
                "parse_errors": session_analysis["parse_errors"],
                "message_types": session_analysis["message_types"],
                "input_tokens": session_analysis["input_tokens"],
                "output_tokens": session_analysis["output_tokens"],
                "cache_creation_tokens": session_analysis["cache_creation_tokens"],
                "cache_read_tokens": session_analysis["cache_read_tokens"],
            }
        )

        result["total_messages"] += session_analysis["valid_json_lines"]
        result["total_input_tokens"] += session_analysis["input_tokens"]
        result["total_output_tokens"] += session_analysis["output_tokens"]
        result["total_cache_creation_tokens"] += session_analysis[
            "cache_creation_tokens"
        ]
        result["total_cache_read_tokens"] += session_analysis["cache_read_tokens"]
        result["total_session_file_size_bytes"] += session_analysis["file_size_bytes"]

        for msg_type, count in session_analysis["message_types"].items():
            result["message_type_totals"][msg_type] += count

        # Track file mtimes
        try:
            mtime = sf.stat().st_mtime
            if newest_mtime is None or mtime > newest_mtime:
                newest_mtime = mtime
            if oldest_mtime is None or mtime < oldest_mtime:
                oldest_mtime = mtime
        except OSError:
            pass

    if newest_mtime is not None:
        result["newest_file_mtime"] = newest_mtime
        result["newest_file_mtime_iso"] = datetime.fromtimestamp(
            newest_mtime, tz=timezone.utc
        ).isoformat()
    if oldest_mtime is not None:
        result["oldest_file_mtime"] = oldest_mtime
        result["oldest_file_mtime_iso"] = datetime.fromtimestamp(
            oldest_mtime, tz=timezone.utc
        ).isoformat()

    # Count subagent files and tool-result files
    # These live inside UUID-named directories (same name as session, without .jsonl)
    for entry in project_dir.iterdir():
        if entry.is_dir():
            subagents_dir = entry / "subagents"
            if subagents_dir.exists() and subagents_dir.is_dir():
                try:
                    for sa_file in subagents_dir.iterdir():
                        if sa_file.is_file():
                            result["subagent_file_count"] += 1
                except OSError:
                    pass

            tool_results_dir = entry / "tool-results"
            if tool_results_dir.exists() and tool_results_dir.is_dir():
                try:
                    for tr_file in tool_results_dir.iterdir():
                        if tr_file.is_file():
                            result["tool_result_file_count"] += 1
                except OSError:
                    pass

    # Calculate total disk usage for the project directory
    result["total_disk_usage_bytes"] = get_dir_size(project_dir)

    # Convert defaultdict for serialization
    result["message_type_totals"] = dict(result["message_type_totals"])

    return result


def get_dir_size(path: Path) -> int:
    """Calculate total disk usage of a directory recursively."""
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def format_bytes(b: int) -> str:
    """Format bytes into human-readable string."""
    if b < 1024:
        return f"{b} B"
    elif b < 1024 * 1024:
        return f"{b / 1024:.1f} KB"
    elif b < 1024 * 1024 * 1024:
        return f"{b / (1024 * 1024):.1f} MB"
    else:
        return f"{b / (1024 * 1024 * 1024):.2f} GB"


def format_number(n: int) -> str:
    """Format a number with comma separators."""
    return f"{n:,}"


def main():
    print("=" * 100)
    print("GROUND TRUTH MEASUREMENT OF ~/.claude")
    print(f"Run at: {datetime.now(tz=timezone.utc).isoformat()}")
    print("=" * 100)
    print()

    if not PROJECTS_DIR.exists():
        print(f"ERROR: {PROJECTS_DIR} does not exist")
        sys.exit(1)

    # Enumerate all project directories
    project_dirs = []
    for entry in PROJECTS_DIR.iterdir():
        if entry.is_dir():
            project_dirs.append(entry)

    project_dirs.sort(key=lambda p: p.name)

    print(f"Found {len(project_dirs)} project directories in {PROJECTS_DIR}")
    print()

    # Analyze each project
    all_projects = []
    for i, pd in enumerate(project_dirs):
        print(
            f"  Analyzing [{i + 1}/{len(project_dirs)}] {pd.name}...",
            end="",
            flush=True,
        )
        project_data = analyze_project(pd)
        all_projects.append(project_data)
        print(
            f" {project_data['session_count']} sessions, {format_number(project_data['total_messages'])} msgs"
        )

    print()

    # Sort by newest_file_mtime (most recent first), projects with no sessions last
    def sort_key(p):
        if p["newest_file_mtime"] is None:
            return 0
        return p["newest_file_mtime"]

    all_projects.sort(key=sort_key, reverse=True)

    # Print formatted table
    print("=" * 100)
    print("PER-PROJECT SUMMARY (sorted by most recent activity)")
    print("=" * 100)

    # Header
    header_fmt = "{:<55} {:>6} {:>8} {:>12} {:>12} {:>10}"
    print(
        header_fmt.format(
            "PROJECT SLUG", "SESS", "MSGS", "IN_TOKENS", "OUT_TOKENS", "DISK"
        )
    )
    print("-" * 100)

    for p in all_projects:
        slug_display = p["slug"]
        if len(slug_display) > 54:
            slug_display = "..." + slug_display[-51:]

        newest_str = ""
        if p["newest_file_mtime_iso"]:
            newest_str = p["newest_file_mtime_iso"][:10]

        print(
            header_fmt.format(
                slug_display,
                p["session_count"],
                format_number(p["total_messages"]),
                format_number(p["total_input_tokens"]),
                format_number(p["total_output_tokens"]),
                format_bytes(p["total_disk_usage_bytes"]),
            )
        )

        # Second line with more detail
        detail_parts = []
        if p["newest_file_mtime_iso"]:
            detail_parts.append(f"last={p['newest_file_mtime_iso'][:10]}")
        if p["oldest_file_mtime_iso"]:
            detail_parts.append(f"first={p['oldest_file_mtime_iso'][:10]}")
        if p["has_memory"]:
            detail_parts.append("MEMORY")
        if p["session_index_exists"]:
            detail_parts.append(f"index={p['session_index_count']}")
        if p["subagent_file_count"] > 0:
            detail_parts.append(f"subagents={p['subagent_file_count']}")
        if p["tool_result_file_count"] > 0:
            detail_parts.append(f"tool-results={p['tool_result_file_count']}")
        if p["total_cache_creation_tokens"] > 0:
            detail_parts.append(
                f"cache_create={format_number(p['total_cache_creation_tokens'])}"
            )
        if p["total_cache_read_tokens"] > 0:
            detail_parts.append(
                f"cache_read={format_number(p['total_cache_read_tokens'])}"
            )

        if detail_parts:
            print(f"  {'  |  '.join(detail_parts)}")

        # Print message type breakdown if there are messages
        if p["message_type_totals"]:
            type_str = "  types: " + ", ".join(
                f"{k}={v}" for k, v in sorted(p["message_type_totals"].items())
            )
            print(type_str)

        print()

    # Global totals
    print("=" * 100)
    print("GLOBAL TOTALS")
    print("=" * 100)

    total_projects = len(all_projects)
    total_projects_with_sessions = sum(
        1 for p in all_projects if p["session_count"] > 0
    )
    total_sessions = sum(p["session_count"] for p in all_projects)
    total_messages = sum(p["total_messages"] for p in all_projects)
    total_input_tokens = sum(p["total_input_tokens"] for p in all_projects)
    total_output_tokens = sum(p["total_output_tokens"] for p in all_projects)
    total_cache_creation = sum(p["total_cache_creation_tokens"] for p in all_projects)
    total_cache_read = sum(p["total_cache_read_tokens"] for p in all_projects)
    total_disk = sum(p["total_disk_usage_bytes"] for p in all_projects)
    total_session_file_size = sum(
        p["total_session_file_size_bytes"] for p in all_projects
    )
    total_subagent_files = sum(p["subagent_file_count"] for p in all_projects)
    total_tool_result_files = sum(p["tool_result_file_count"] for p in all_projects)
    projects_with_memory = sum(1 for p in all_projects if p["has_memory"])
    projects_with_index = sum(1 for p in all_projects if p["session_index_exists"])

    # Aggregate message types across all projects
    global_message_types = defaultdict(int)
    for p in all_projects:
        for msg_type, count in p["message_type_totals"].items():
            global_message_types[msg_type] += count

    print(f"  Total project directories:        {total_projects}")
    print(f"  Projects with sessions:           {total_projects_with_sessions}")
    print(f"  Projects with memory/MEMORY.md:   {projects_with_memory}")
    print(f"  Projects with sessions-index.json:{projects_with_index}")
    print()
    print(f"  Total session .jsonl files:       {format_number(total_sessions)}")
    print(
        f"  Total session file size:          {format_bytes(total_session_file_size)}"
    )
    print(f"  Total messages (valid JSON lines):{format_number(total_messages)}")
    print()
    print(f"  Total input_tokens:               {format_number(total_input_tokens)}")
    print(f"  Total output_tokens:              {format_number(total_output_tokens)}")
    print(
        f"  Total cache_creation_input_tokens:{format_number(total_cache_creation)}"
    )
    print(f"  Total cache_read_input_tokens:    {format_number(total_cache_read)}")
    print(
        f"  Total all tokens:                 {format_number(total_input_tokens + total_output_tokens + total_cache_creation + total_cache_read)}"
    )
    print()
    print(f"  Total subagent files:             {format_number(total_subagent_files)}")
    print(
        f"  Total tool-result files:          {format_number(total_tool_result_files)}"
    )
    print(f"  Total disk usage (all projects):  {format_bytes(total_disk)}")
    print()

    # Message type breakdown
    print("  Message types across all sessions:")
    for msg_type, count in sorted(
        global_message_types.items(), key=lambda x: -x[1]
    ):
        print(f"    {msg_type:<30} {format_number(count):>10}")

    print()

    # Session count distribution
    session_counts = [p["session_count"] for p in all_projects if p["session_count"] > 0]
    if session_counts:
        print("  Session count distribution:")
        print(f"    Min sessions per project:       {min(session_counts)}")
        print(f"    Max sessions per project:       {max(session_counts)}")
        print(
            f"    Avg sessions per project:       {sum(session_counts) / len(session_counts):.1f}"
        )
        print(
            f"    Median sessions per project:    {sorted(session_counts)[len(session_counts) // 2]}"
        )

    print()

    # Top 5 projects by session count
    by_sessions = sorted(all_projects, key=lambda p: p["session_count"], reverse=True)
    print("  Top 10 projects by session count:")
    for p in by_sessions[:10]:
        print(f"    {p['session_count']:>5} sessions  {p['slug']}")

    print()

    # Top 5 projects by total messages
    by_messages = sorted(all_projects, key=lambda p: p["total_messages"], reverse=True)
    print("  Top 10 projects by total messages:")
    for p in by_messages[:10]:
        print(f"    {format_number(p['total_messages']):>10} msgs  {p['slug']}")

    print()

    # Top 5 projects by total tokens (input + output)
    by_tokens = sorted(
        all_projects,
        key=lambda p: p["total_input_tokens"] + p["total_output_tokens"],
        reverse=True,
    )
    print("  Top 10 projects by total tokens (input + output):")
    for p in by_tokens[:10]:
        total = p["total_input_tokens"] + p["total_output_tokens"]
        print(f"    {format_number(total):>15} tokens  {p['slug']}")

    print()

    # Top 5 projects by disk usage
    by_disk = sorted(
        all_projects, key=lambda p: p["total_disk_usage_bytes"], reverse=True
    )
    print("  Top 10 projects by disk usage:")
    for p in by_disk[:10]:
        print(
            f"    {format_bytes(p['total_disk_usage_bytes']):>10}  {p['slug']}"
        )

    print()
    print("=" * 100)

    # Save JSON output
    output_data = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "claude_dir": str(CLAUDE_DIR),
        "projects_dir": str(PROJECTS_DIR),
        "global_totals": {
            "total_projects": total_projects,
            "total_projects_with_sessions": total_projects_with_sessions,
            "projects_with_memory": projects_with_memory,
            "projects_with_sessions_index": projects_with_index,
            "total_sessions": total_sessions,
            "total_session_file_size_bytes": total_session_file_size,
            "total_messages": total_messages,
            "total_input_tokens": total_input_tokens,
            "total_output_tokens": total_output_tokens,
            "total_cache_creation_tokens": total_cache_creation,
            "total_cache_read_tokens": total_cache_read,
            "total_all_tokens": total_input_tokens
            + total_output_tokens
            + total_cache_creation
            + total_cache_read,
            "total_subagent_files": total_subagent_files,
            "total_tool_result_files": total_tool_result_files,
            "total_disk_usage_bytes": total_disk,
            "global_message_types": dict(global_message_types),
        },
        "projects": all_projects,
    }

    try:
        with open(OUTPUT_JSON, "w") as f:
            json.dump(output_data, f, indent=2, default=str)
        print(f"\nJSON output saved to: {OUTPUT_JSON}")
    except OSError as e:
        print(f"\nERROR: Could not write JSON output: {e}", file=sys.stderr)

    print(f"Total projects analyzed: {total_projects}")
    print(f"Total sessions found: {total_sessions}")
    print(f"Total messages parsed: {format_number(total_messages)}")


if __name__ == "__main__":
    main()
