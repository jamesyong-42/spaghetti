#!/usr/bin/env python3
"""
Build a self-contained HTML coverage report from claim.json + ground-truth scans.

Writes:
  scripts/coverage/out/report.html   (gitignored, full local data)
  docs/coverage/report.html          (checked-in friendly; same UI, embeds data)

Paths under the user's home are redacted for safer sharing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import COVERAGE_DIR, OUT_DIR, REPO_ROOT, ensure_out_dir, read_json  # noqa: E402

AGENTS = [
    ("claude-code", COVERAGE_DIR / "claude_code" / "claim.json"),
    ("codex", COVERAGE_DIR / "codex" / "claim.json"),
]

HOME = str(Path.home())


def redact(obj):
    """Recursively redact absolute home paths from strings."""
    if isinstance(obj, dict):
        return {k: redact(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    if isinstance(obj, str):
        s = obj
        if s.startswith(HOME):
            s = "~" + s[len(HOME) :]
        # also collapse long absolute paths if home differs
        s = re.sub(r"/Users/[^/]+", "~", s)
        s = re.sub(r"/home/[^/]+", "~", s)
        return s
    return obj


def load_agent_payload(agent_id: str, claim_path: Path) -> dict:
    claim = read_json(claim_path)
    gt_path = OUT_DIR / f"{agent_id}-ground-truth.json"
    ground = read_json(gt_path) if gt_path.exists() else None
    return {
        "agentId": agent_id,
        "claim": redact(claim),
        "groundTruth": redact(ground) if ground else None,
        "groundTruthPath": str(gt_path.relative_to(REPO_ROOT)) if gt_path.exists() else None,
    }


def build_html(payload: dict) -> str:
    data_json = json.dumps(payload, indent=None, ensure_ascii=False)
    # Prevent </script> breakouts in JSON strings
    data_json = data_json.replace("<", "\\u003c").replace(">", "\\u003e")
    generated = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return HTML_TEMPLATE.replace("/*__GENERATED__*/", generated).replace(
        "/*__DATA__*/", data_json
    )


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Spaghetti · Agent coverage</title>
<style>
  :root {
    --bg: #0b0f14;
    --bg2: #121821;
    --bg3: #1a222e;
    --border: #2a3544;
    --text: #e7eef7;
    --muted: #8b9bb0;
    --accent: #2dd4bf;
    --accent2: #38bdf8;
    --ingested: #34d399;
    --partial: #fbbf24;
    --ignored: #94a3b8;
    --oos: #64748b;
    --unknown: #f87171;
    --danger: #fb7185;
    --radius: 12px;
    --font: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font); }
  body {
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse 80% 50% at 10% -10%, rgba(45,212,191,0.12), transparent),
      radial-gradient(ellipse 60% 40% at 100% 0%, rgba(56,189,248,0.10), transparent);
  }
  a { color: var(--accent2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 80px; }
  header.hero {
    display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;
    justify-content: space-between; margin-bottom: 28px;
  }
  .brand { display: flex; flex-direction: column; gap: 6px; }
  .brand h1 {
    margin: 0; font-size: 1.65rem; letter-spacing: -0.02em; font-weight: 650;
  }
  .brand h1 span { color: var(--accent); }
  .brand p { margin: 0; color: var(--muted); font-size: 0.95rem; max-width: 52ch; line-height: 1.45; }
  .meta { color: var(--muted); font-size: 0.8rem; font-family: var(--mono); }
  .tabs {
    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px;
  }
  .tab {
    border: 1px solid var(--border); background: var(--bg2); color: var(--text);
    padding: 8px 14px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.9rem;
  }
  .tab:hover { border-color: var(--accent); }
  .tab.active {
    background: linear-gradient(135deg, rgba(45,212,191,0.18), rgba(56,189,248,0.12));
    border-color: var(--accent); color: #fff;
  }
  .panel { display: none; }
  .panel.active { display: block; animation: fade .25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  .grid { display: grid; gap: 14px; grid-template-columns: repeat(12, 1fr); margin-bottom: 18px; }
  .card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; grid-column: span 12;
  }
  /* 6 equal hero cards on a 12-col grid */
  .card.sm { grid-column: span 2; }
  .card.md { grid-column: span 6; }
  @media (max-width: 960px) {
    .card.sm { grid-column: span 4; }
    .card.md { grid-column: span 6; }
  }
  @media (max-width: 560px) {
    .card.sm, .card.md { grid-column: span 12; }
  }
  .card h2 { margin: 0 0 6px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
  .card .big { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .card .sub { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }

  .bar {
    height: 12px; border-radius: 999px; background: var(--bg3); overflow: hidden;
    display: flex; margin: 10px 0 6px;
  }
  .bar > i { display: block; height: 100%; }
  .bar .ingested { background: var(--ingested); }
  .bar .partial { background: var(--partial); }
  .bar .ignored { background: var(--ignored); }
  .bar .oos { background: var(--oos); }
  .bar .unknown { background: var(--unknown); }
  .legend { display: flex; flex-wrap: wrap; gap: 10px 16px; font-size: 0.8rem; color: var(--muted); }
  .legend span::before {
    content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 6px; vertical-align: middle;
  }
  .legend .ingested::before { background: var(--ingested); }
  .legend .partial::before { background: var(--partial); }
  .legend .ignored::before { background: var(--ignored); }
  .legend .oos::before { background: var(--oos); }
  .legend .unknown::before { background: var(--unknown); }

  .desc {
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 16px; color: var(--muted); line-height: 1.5; font-size: 0.92rem;
  }
  .engines { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .pill {
    font-size: 0.75rem; font-family: var(--mono); padding: 3px 8px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg3); color: var(--muted);
  }
  .pill.on { border-color: rgba(45,212,191,0.4); color: var(--accent); }
  .pill.off { opacity: 0.55; }

  .toolbar {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 8px 0 12px;
  }
  .toolbar input, .toolbar select {
    background: var(--bg3); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 0.88rem;
  }
  .toolbar input { min-width: 220px; flex: 1; }
  table {
    width: 100%; border-collapse: collapse; font-size: 0.88rem;
  }
  th, td {
    text-align: left; padding: 10px 10px; border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em;
    font-weight: 600; position: sticky; top: 0; background: var(--bg2); z-index: 1;
  }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .status {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 0.75rem; font-weight: 600;
    padding: 2px 8px; border-radius: 999px; border: 1px solid transparent;
  }
  .status.ingested { color: #065f46; background: rgba(52,211,153,0.2); border-color: rgba(52,211,153,0.35); color: #6ee7b7; }
  .status.partial { color: #fde68a; background: rgba(251,191,36,0.15); border-color: rgba(251,191,36,0.35); }
  .status.ignored { color: #cbd5e1; background: rgba(148,163,184,0.12); border-color: rgba(148,163,184,0.3); }
  .status.out_of_scope { color: #94a3b8; background: rgba(100,116,139,0.15); border-color: rgba(100,116,139,0.3); }
  .status.unknown { color: #fecaca; background: rgba(248,113,113,0.15); border-color: rgba(248,113,113,0.35); }
  .id { font-family: var(--mono); font-size: 0.8rem; word-break: break-all; }
  .notes { color: var(--muted); font-size: 0.82rem; line-height: 1.4; max-width: 42ch; }
  .count { font-variant-numeric: tabular-nums; font-family: var(--mono); white-space: nowrap; }
  .count.muted { color: var(--muted); }
  .bar-mini {
    display: inline-block; width: 72px; height: 6px; border-radius: 4px; background: var(--bg3);
    vertical-align: middle; margin-right: 8px; overflow: hidden;
  }
  .bar-mini > i { display: block; height: 100%; background: var(--accent2); }

  .section-title {
    margin: 22px 0 10px; font-size: 1.05rem; font-weight: 650; letter-spacing: -0.01em;
  }
  .warn {
    border: 1px solid rgba(251,191,36,0.35); background: rgba(251,191,36,0.08);
    color: #fde68a; border-radius: var(--radius); padding: 12px 14px; margin-bottom: 14px; font-size: 0.9rem;
  }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  footer {
    margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border);
    color: var(--muted); font-size: 0.8rem; line-height: 1.5;
  }
  .table-wrap {
    overflow: auto; max-height: 560px; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--bg2);
  }
</style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div class="brand">
        <h1><span>Spaghetti</span> · agent coverage</h1>
        <p>What exists on disk vs what we claim to ingest — per agent, from ground-truth scans and checked-in claims.</p>
      </div>
      <div class="meta">Generated /*__GENERATED__*/</div>
    </header>

    <div class="tabs" id="tabs"></div>
    <div id="panels"></div>

    <footer>
      Machine claims: <code>scripts/coverage/*/claim.json</code> ·
      Scans: <code>scripts/coverage/out/*-ground-truth.json</code> ·
      Rebuild: <code>pnpm coverage:report</code> ·
      Validate: <code>pnpm coverage:check</code>
    </footer>
  </div>

<script>
const DATA = /*__DATA__*/;

const STATUS_ORDER = { ingested: 0, partial: 1, ignored: 2, out_of_scope: 3, unknown: 4 };

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString();
}
function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n/1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n/1048576).toFixed(1) + " MB";
  return (n/1073741824).toFixed(2) + " GB";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function surfaceCoversRecordType(surface, rt) {
  const m = surface.match || {};
  if (m.recordType === rt) return true;
  if (m.recordTypePrefix && rt.startsWith(m.recordTypePrefix)) return true;
  return false;
}

function statusForRecordType(claim, rt) {
  const hits = (claim.surfaces || []).filter(s => surfaceCoversRecordType(s, rt));
  if (!hits.length) return "unknown";
  // prefer most "product-facing" status
  hits.sort((a,b) => (STATUS_ORDER[a.status]??9) - (STATUS_ORDER[b.status]??9));
  return hits[0].status;
}

/**
 * Primary-volume stats — same shape for every agent so the hero is comparable.
 *
 * Primary unit:
 *   Claude → valid session JSONL lines (session.jsonl.line / primary.records)
 *   Codex  → all rollout JSONL lines (rollout.record_type sum)
 *
 * Ingested % = share of those primary records claimed as status=ingested.
 */
function computeStats(agent) {
  const claim = agent.claim;
  const gt = agent.groundTruth;
  const surfaces = claim.surfaces || [];
  const byStatus = { ingested: 0, partial: 0, ignored: 0, out_of_scope: 0, unknown: 0 };
  for (const s of surfaces) byStatus[s.status] = (byStatus[s.status] || 0) + 1;

  let volume = {
    total: 0, ingested: 0, partial: 0, ignored: 0, unknown: 0,
    pct: null, unitLabel: "primary records", rows: null, hasData: false,
  };

  // Codex-style: breakdown by record type
  if (gt && gt.buckets && gt.buckets["rollout.record_type"]) {
    const rt = gt.buckets["rollout.record_type"];
    const rows = [];
    for (const [k, v] of Object.entries(rt)) {
      const c = Number(v) || 0;
      volume.total += c;
      const st = statusForRecordType(claim, k);
      if (st === "ingested") volume.ingested += c;
      else if (st === "partial") volume.partial += c;
      else if (st === "ignored" || st === "out_of_scope") volume.ignored += c;
      else volume.unknown += c;
      rows.push({ type: k, count: c, status: st });
    }
    rows.sort((a,b) => b.count - a.count);
    volume.rows = rows;
    volume.unitLabel = "rollout lines";
    volume.hasData = true;
  } else if (gt && gt.buckets && gt.buckets["session.jsonl.line"]) {
    // Claude-style: every valid session JSONL line is claimed ingested
    const sl = gt.buckets["session.jsonl.line"];
    const total = Number(sl.count) || 0;
    volume.total = total;
    volume.ingested = total; // claim: session.jsonl.line → ingested
    volume.partial = 0;
    volume.ignored = 0;
    volume.unknown = 0;
    volume.unitLabel = "session JSONL lines";
    volume.hasData = total > 0 || !!gt;
    // Optional: message-type rows for the histogram table (all ingested)
    const mt = gt.buckets["session.message_type"];
    if (mt && typeof mt === "object") {
      volume.rows = Object.entries(mt)
        .map(([type, count]) => ({ type, count: Number(count) || 0, status: "ingested" }))
        .sort((a,b) => b.count - a.count);
    }
  }

  volume.pct = volume.total ? (100 * volume.ingested / volume.total) : (volume.hasData ? 0 : null);

  const projects = gt ? (gt.projectCount != null ? Number(gt.projectCount) : null) : null;
  let sessions = gt ? (gt.sessionCount != null ? Number(gt.sessionCount) : null) : null;
  if (sessions == null && gt?.buckets?.["session.jsonl.line"]?.files != null) {
    sessions = Number(gt.buckets["session.jsonl.line"].files);
  }
  if (sessions == null && gt?.buckets?.["rollout.file"]?.count != null) {
    sessions = Number(gt.buckets["rollout.file"].count);
  }

  return { byStatus, volume, projects, sessions, surfaces };
}

function statusBadge(st) {
  return `<span class="status ${esc(st)}">${esc(st)}</span>`;
}

function enginePills(engines) {
  if (!engines) return "";
  const ts = engines.ts ? "on" : "off";
  const rs = engines.rs ? "on" : "off";
  return `<span class="pill ${ts}">TS ${engines.ts ? "✓" : "—"}</span>
          <span class="pill ${rs}">RS ${engines.rs ? "✓" : "—"}</span>`;
}

function renderAgent(agent) {
  const stats = computeStats(agent);
  const claim = agent.claim;
  const gt = agent.groundTruth;
  const v = stats.volume;

  // Same six hero cards for every agent (comparable at a glance).
  const pctStr = v.pct == null ? "—" : v.pct.toFixed(1) + "%";
  const pctColor = v.pct == null ? "var(--muted)" : "var(--ingested)";
  const unknownColor = v.unknown ? "var(--danger)" : "var(--muted)";
  const noGt = !gt;

  const heroCards = noGt ? `
      <div class="card md"><h2>Ground truth</h2>
        <div class="big" style="font-size:1.2rem;color:var(--partial)">Not scanned yet</div>
        <div class="sub">Run <code>pnpm coverage:scan</code> then <code>pnpm coverage:report</code></div>
      </div>
      <div class="card sm"><h2>Projects</h2><div class="big">—</div><div class="sub">needs scan</div></div>
      <div class="card sm"><h2>Sessions</h2><div class="big">—</div><div class="sub">needs scan</div></div>
    ` : `
      <div class="card sm"><h2>Ingested %</h2>
        <div class="big" style="color:${pctColor}">${pctStr}</div>
        <div class="sub">${fmt(v.ingested)} / ${fmt(v.total)} ${esc(v.unitLabel)}</div>
      </div>
      <div class="card sm"><h2>Partial</h2>
        <div class="big" style="color:var(--partial)">${fmt(v.partial)}</div>
        <div class="sub">of primary stream</div>
      </div>
      <div class="card sm"><h2>Ignored</h2>
        <div class="big">${fmt(v.ignored)}</div>
        <div class="sub">of primary stream</div>
      </div>
      <div class="card sm"><h2>Unknown</h2>
        <div class="big" style="color:${unknownColor}">${fmt(v.unknown)}</div>
        <div class="sub">${v.unknown ? "fix claim.json!" : "none — good"}</div>
      </div>
      <div class="card sm"><h2>Projects</h2>
        <div class="big">${fmt(stats.projects)}</div>
        <div class="sub">${esc(gt?.root || claim.rootDefault || "")}</div>
      </div>
      <div class="card sm"><h2>Sessions</h2>
        <div class="big">${fmt(stats.sessions)}</div>
        <div class="sub">${fmt(v.total)} primary records</div>
      </div>`;

  // status stack bar for primary volume
  const barSegs = v.total ? ["ingested","partial","ignored","unknown"].map(st => {
    const n = v[st] || 0;
    const w = (100 * n / v.total).toFixed(2);
    return n ? `<i class="${st === "unknown" ? "unknown" : st}" style="width:${w}%"></i>` : "";
  }).join("") : "";

  // Record-type / message-type breakdown table (shared)
  let recordTable = "";
  if (v.rows && v.rows.length) {
    const maxC = v.rows[0]?.count || 1;
    const title = gt?.buckets?.["rollout.record_type"]
      ? "Primary stream record types (ground truth × claim)"
      : "Session message types (ground truth × claim)";
    recordTable = `
      <h3 class="section-title">${title}</h3>
      <div class="toolbar">
        <input type="search" data-filter="records" placeholder="Filter types…" />
        <select data-filter-status="records">
          <option value="">All statuses</option>
          <option>ingested</option><option>partial</option><option>ignored</option><option>unknown</option>
        </select>
      </div>
      <div class="table-wrap">
        <table data-table="records">
          <thead><tr>
            <th>Type</th><th>Count</th><th>Share</th><th>Claim status</th>
          </tr></thead>
          <tbody>
            ${v.rows.map(r => {
              const pct = 100 * r.count / (v.total || 1);
              const w = 100 * r.count / maxC;
              return `<tr data-status="${esc(r.status)}" data-text="${esc(r.type)}">
                <td class="id">${esc(r.type)}</td>
                <td class="count">${fmt(r.count)}</td>
                <td class="count muted"><span class="bar-mini"><i style="width:${w}%"></i></span>${pct.toFixed(1)}%</td>
                <td>${statusBadge(r.status)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // Keep Claude secondary message histogram only if rows already cover message types
  // (volume.rows is message types for Claude — no separate table needed)
  let msgTypesTable = "";

  // secondary buckets Claude
  let secondaryHtml = "";
  const secondary = gt?.buckets?.secondary;
  if (secondary && typeof secondary === "object") {
    const rows = Object.entries(secondary).map(([k,v]) => ({
      k, files: v?.file_count||0, bytes: v?.bytes||0, exists: !!v?.exists
    })).filter(r => r.exists).sort((a,b)=>b.files-a.files);
    if (rows.length) {
      secondaryHtml = `
        <h3 class="section-title">Secondary trees</h3>
        <div class="table-wrap" style="max-height:280px">
          <table>
            <thead><tr><th>Tree</th><th>Files</th><th>Size</th></tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td class="id">${esc(r.k)}</td>
                <td class="count">${fmt(r.files)}</td>
                <td class="count muted">${fmtBytes(r.bytes)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    }
  }

  // surfaces table
  const surfaces = [...stats.surfaces].sort((a,b) => {
    const d = (STATUS_ORDER[a.status]??9) - (STATUS_ORDER[b.status]??9);
    return d || a.id.localeCompare(b.id);
  });

  const surfacesTable = `
    <h3 class="section-title">Claim surfaces</h3>
    <div class="toolbar">
      <input type="search" data-filter="surfaces" placeholder="Filter surface id / notes…" />
      <select data-filter-status="surfaces">
        <option value="">All statuses</option>
        <option>ingested</option><option>partial</option><option>ignored</option><option>out_of_scope</option>
      </select>
    </div>
    <div class="table-wrap">
      <table data-table="surfaces">
        <thead><tr>
          <th>Status</th><th>Surface id</th><th>Engines</th><th>Product</th><th>Notes</th>
        </tr></thead>
        <tbody>
          ${surfaces.map(s => `
            <tr data-status="${esc(s.status)}" data-text="${esc(s.id + " " + (s.notes||""))}">
              <td>${statusBadge(s.status)}</td>
              <td class="id">${esc(s.id)}</td>
              <td>${enginePills(s.engines)}</td>
              <td class="notes">${esc((s.product||[]).join(", ") || "—")}</td>
              <td class="notes">${esc(s.notes || "")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  const stackBar = v.hasData && v.total ? `
    <div class="card">
      <h2>Primary stream by claim status (${esc(v.unitLabel)})</h2>
      <div class="bar">${barSegs}</div>
      <div class="legend">
        <span class="ingested">ingested ${fmt(v.ingested)}</span>
        <span class="partial">partial ${fmt(v.partial)}</span>
        <span class="ignored">ignored ${fmt(v.ignored)}</span>
        <span class="unknown">unknown ${fmt(v.unknown)}</span>
      </div>
      <div class="sub" style="margin-top:8px">
        Ingested % compares how much of the <em>transcript stream</em> Spaghetti stores as product rows —
        Claude: session JSONL lines · Codex: all rollout JSONL lines.
      </div>
    </div>` : `
    <div class="card">
      <h2>Claim surfaces by status</h2>
      <div class="bar">${["ingested","partial","ignored","out_of_scope"].map(st => {
        const n = stats.byStatus[st] || 0;
        const w = (100 * n / (stats.surfaces.length || 1)).toFixed(2);
        return n ? `<i class="${st === "out_of_scope" ? "oos" : st}" style="width:${w}%"></i>` : "";
      }).join("")}</div>
      <div class="legend">
        <span class="ingested">ingested ${stats.byStatus.ingested||0}</span>
        <span class="partial">partial ${stats.byStatus.partial||0}</span>
        <span class="ignored">ignored ${stats.byStatus.ignored||0}</span>
        <span class="oos">out_of_scope ${stats.byStatus.out_of_scope||0}</span>
      </div>
    </div>`;

  const warn = !gt ? `<div class="warn">No ground-truth scan found for this agent. Showing claim only. Run <code>pnpm coverage:scan</code>.</div>` : "";
  const scanned = gt ? `<div class="meta" style="margin-bottom:10px">Scanned ${esc(gt.scannedAt || "")} · root ${esc(gt.root || "")}</div>` : "";

  return `
    ${warn}
    ${scanned}
    <div class="desc">
      ${esc(claim.description || "")}
      <div class="engines" style="margin-top:10px">
        <span class="pill on">claim ${esc(claim.updated || "")}</span>
        ${Object.entries(claim.engines||{}).map(([k,v]) =>
          `<span class="pill" title="${esc(v)}">${esc(k)}: ${esc(String(v).slice(0,48))}${String(v).length>48?"…":""}</span>`
        ).join("")}
      </div>
    </div>
    <div class="grid">${heroCards}</div>
    ${stackBar}
    ${recordTable}
    ${msgTypesTable}
    ${secondaryHtml}
    ${surfacesTable}
  `;
}

function wireFilters(root) {
  root.querySelectorAll("[data-filter]").forEach(input => {
    const key = input.getAttribute("data-filter");
    const statusSel = root.querySelector(`[data-filter-status="${key}"]`);
    const table = root.querySelector(`[data-table="${key}"]`);
    if (!table) return;
    const apply = () => {
      const q = (input.value || "").toLowerCase();
      const st = statusSel ? statusSel.value : "";
      table.querySelectorAll("tbody tr").forEach(tr => {
        const text = (tr.getAttribute("data-text") || "").toLowerCase();
        const rowSt = tr.getAttribute("data-status") || "";
        const okQ = !q || text.includes(q);
        const okS = !st || rowSt === st || (st === "ignored" && rowSt === "out_of_scope" && key === "records" ? false : rowSt === st);
        // simpler:
        const okStatus = !st || rowSt === st;
        tr.style.display = (okQ && okStatus) ? "" : "none";
      });
    };
    input.addEventListener("input", apply);
    if (statusSel) statusSel.addEventListener("change", apply);
  });
}

function main() {
  const tabs = document.getElementById("tabs");
  const panels = document.getElementById("panels");
  const agents = DATA.agents || [];

  if (!agents.length) {
    panels.innerHTML = `<div class="empty">No agent data embedded. Run <code>pnpm coverage:report</code>.</div>`;
    return;
  }

  agents.forEach((agent, i) => {
    const id = agent.agentId;
    const tab = document.createElement("button");
    tab.className = "tab" + (i === 0 ? " active" : "");
    tab.type = "button";
    tab.textContent = id;
    tab.dataset.agent = id;
    tabs.appendChild(tab);

    const panel = document.createElement("section");
    panel.className = "panel" + (i === 0 ? " active" : "");
    panel.dataset.agent = id;
    panel.innerHTML = renderAgent(agent);
    panels.appendChild(panel);
    wireFilters(panel);
  });

  tabs.addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    const id = t.dataset.agent;
    tabs.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
    panels.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.dataset.agent === id));
  });
}

main();
</script>
</body>
</html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=str,
        default=None,
        help="Primary output path (default scripts/coverage/out/report.html)",
    )
    ap.add_argument(
        "--also-docs",
        action="store_true",
        default=True,
        help="Also write docs/coverage/report.html (default on)",
    )
    ap.add_argument("--no-docs", action="store_true", help="Skip docs/coverage/report.html")
    args = ap.parse_args()

    ensure_out_dir()
    agents = []
    for agent_id, claim_path in AGENTS:
        if not claim_path.exists():
            print(f"skip {agent_id}: missing {claim_path}", file=sys.stderr)
            continue
        agents.append(load_agent_payload(agent_id, claim_path))
        gt = agents[-1]["groundTruth"] is not None
        print(f"  {agent_id}: claim ok, ground-truth={'yes' if gt else 'MISSING'}")

    payload = {
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "agents": agents,
    }
    html = build_html(payload)

    out = Path(args.out) if args.out else OUT_DIR / "report.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"Wrote {out}")

    if args.also_docs and not args.no_docs:
        docs_out = REPO_ROOT / "docs" / "coverage" / "report.html"
        docs_out.write_text(html, encoding="utf-8")
        print(f"Wrote {docs_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
