#!/usr/bin/env node
/**
 * generate-medium-fixture.mjs
 *
 * Deterministically generate a medium-sized ~/.claude fixture exercising
 * every rare SessionMessage variant the Rust ingest types support. Used by
 * the correctness gate (RFC 004 Item 1): `pnpm test:ingest-diff:medium`.
 *
 * Design goals:
 *   - 9 projects, ~30 sessions, ~500 messages, ~1MB on disk.
 *   - Every SessionMessage variant appears in at least one file.
 *   - Every system subtype appears in at least one file.
 *   - Multiple progress data subtypes, plus every user/assistant content
 *     block shape (tool_result string, tool_result block-array w/ image,
 *     image, document, redacted_thinking, thinking+tool_use same message).
 *   - An `isSidechain: true` session with a matching subagent transcript.
 *   - A project with two sessions that share the same 8-char UUID prefix.
 *
 * Forked from scripts/generate-ingest-fixture.mjs — keeps the same
 * deterministic primitives (LCG, SHA256-derived UUIDs, fixed mtime) but uses
 * seed 43 and emits under fixtures/medium/.claude/.
 *
 * Usage:
 *   node scripts/generate-medium-fixture.mjs --out <path> [--seed 43] [--scale 1]
 *
 * --scale N (default 1):
 *   Multiplies the fixture size for CI perf-gate use. Scale=1 reproduces the
 *   committed medium fixture byte-for-byte (same RNG consumption order).
 *   Scale>1 appends additional sessions AFTER the existing project 9 loop
 *   AND an extra "bulk" project after project 9, so the scale=1 stream is
 *   untouched. Target: --scale 50 → ~35k messages / ~50MB.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    seed: { type: 'string', default: '43' },
    scale: { type: 'string', default: '1' },
  },
});

if (!values.out) {
  console.error('Usage: generate-medium-fixture.mjs --out <path> [--seed 43] [--scale 1]');
  process.exit(2);
}

const OUT = path.resolve(values.out);
const SEED = Number.parseInt(values.seed, 10);
if (!Number.isFinite(SEED)) {
  console.error(`bad --seed value: ${values.seed}`);
  process.exit(2);
}
const SCALE = Number.parseInt(values.scale, 10);
if (!Number.isFinite(SCALE) || SCALE < 1) {
  console.error(`bad --scale value: ${values.scale} (must be integer >= 1)`);
  process.exit(2);
}

const FIXED_MTIME = new Date('2026-04-01T00:00:00Z');
const FIXED_TS = '2026-04-01T00:00:00.000Z';

// ─── Seeded RNG + deterministic ID generator ────────────────────────────────

function mkRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const rng = mkRng(SEED);

let counter = 0;
function nextHex(nBytes) {
  counter++;
  return createHash('sha256').update(`${SEED}:${counter}`).digest('hex').slice(0, nBytes * 2);
}

function nextUuid() {
  const h = nextHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Build a v4-shape UUID that starts with the given 8-character hex prefix.
 * Used for the "two sessions sharing the same session_id prefix" edge. The
 * remainder of the UUID is still derived from our SHA256 stream so the file
 * stays deterministic.
 */
function nextUuidWithPrefix(prefixHex8) {
  const h = nextHex(16);
  // Replace first 8 hex chars with the caller-provided prefix.
  const rest = h.slice(8);
  return `${prefixHex8}-${rest.slice(0, 4)}-${rest.slice(4, 8)}-${rest.slice(8, 12)}-${rest.slice(12, 24)}`;
}

function pickInt(lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pickOne(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ─── IO helpers ────────────────────────────────────────────────────────────

function write(filePath, body) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
  utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
}

// ─── Content corpora ───────────────────────────────────────────────────────

const USER_CORPUS = [
  'Explain this function.',
  'Why does the test fail?',
  'Refactor the parser for clarity.',
  'Add error handling around the IO call.',
  'Summarise the diff.',
  'What changed in the last commit?',
  'Convert callbacks to async/await.',
  'Port this from TS to Rust.',
];

const ASSISTANT_TEXT_CORPUS = [
  'Looking at the code, the hot loop allocates on every iteration. Hoisting the allocation and reusing the buffer is the easiest win. I will draft a change that keeps the public API unchanged while moving the allocation to construction time. The change itself is small: move the Vec::with_capacity call out of the loop body and into the function prelude, then reuse the buffer with .clear() at the top of each iteration. Ownership stays on the caller side so no lifetime gymnastics are needed.',
  'The failing test is asserting equality on an unordered map. That will flake depending on hash seed. Switching to a sorted vec of entries or using an assert helper that ignores order fixes the flake without hiding a real bug. I ran the test suite 100 times locally with varying seeds after the fix — zero failures. Before the fix it failed roughly 1 in 20 runs, which matches the flake report on CI. The root cause is that Rust HashMap randomises bucket order by default, and the test was iterating .values() directly.',
  'I added three unit tests around the edge cases we discussed. Two cover empty input, one covers the off-by-one at the right boundary. All three pass locally against the fresh build. I also added a small property test using proptest that generates random inputs of varying lengths — it ran 10k cases without a single failure. The three hand-written tests make the intent explicit; the proptest sweep is insurance against shapes we did not think of.',
  'Propagating the error rather than logging-and-continuing is the right call here — the caller already has a Result<_, _> signature and can handle it. I left a comment explaining why the previous silent-drop was wrong. The change touches four call sites. Three of them were obvious (just add ?), one needed a bit more thought because it was inside a spawn_blocking closure — I switched that to return the error through a oneshot channel rather than unwrapping it.',
  'The benchmark moved from 420ms to 11ms after the refactor. Most of the win is cutting a redundant clone in the inner loop; the rest is replacing the linear lookup with a pre-built HashMap. I measured with criterion using ten warm-up iterations and thirty sample iterations per case. The standard deviation on the new path is under 0.3ms, so the improvement is real and not benchmark noise. I also checked that the result semantics match on 5k random inputs.',
  'Done — committed in three logical steps so the diff is easy to review: (1) extract the helper, (2) use it in the two existing call sites, (3) add the new feature that needed it. Each commit has its own passing test run, so if we ever need to bisect we can. The final diff is about 200 lines, most of which is the test file. The production code delta is only ~30 lines of actual logic.',
  'Reviewed the pull request. The approach is sound but I have three suggestions on the implementation. First, the error type could implement From<io::Error> so callers do not have to map_err at every boundary. Second, the buffer in parse_line could use BufRead::read_until rather than a custom byte loop — same performance, fewer lines. Third, the doc comment on the public function should mention the behaviour when the input contains an embedded null byte, because the current code silently truncates there.',
  'Extracted the shared parsing logic into its own module. The module has no external dependencies beyond serde and thiserror, which keeps compile times snappy. I wrote a module-level doc comment that walks through the state machine, and each public function has a one-paragraph doc plus a runnable doctest example. Internal helpers are #[doc(hidden)] but still covered by unit tests in the same file.',
];

const TOOL_NAMES = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];

const SUMMARY_CORPUS = [
  'Investigated failing test, fixed type mismatch in reducer.',
  'Added streaming support to the JSONL reader.',
  'Refactored session parser for readability.',
];

// ─── Building blocks ──────────────────────────────────────────────────────

function baseFields(sessionId, extra = {}) {
  return {
    uuid: nextUuid(),
    parentUuid: null,
    timestamp: FIXED_TS,
    sessionId,
    cwd: '/home/u/proj',
    version: '1.0.0',
    gitBranch: 'main',
    isSidechain: false,
    userType: 'external',
    ...extra,
  };
}

function userMessage(sessionId, content, extra = {}) {
  return {
    type: 'user',
    ...baseFields(sessionId, extra),
    message: { role: 'user', content },
  };
}

function assistantMessage(sessionId, blocks, extra = {}) {
  return {
    type: 'assistant',
    ...baseFields(sessionId, extra),
    requestId: `req_${nextHex(6)}`,
    message: {
      model: 'claude-test',
      id: `msg_${nextHex(8)}`,
      type: 'message',
      role: 'assistant',
      content: blocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: pickInt(40, 4000),
        output_tokens: pickInt(20, 1000),
        cache_creation_input_tokens: pickInt(0, 200),
        cache_read_input_tokens: pickInt(0, 500),
      },
    },
  };
}

function summaryMessage() {
  return { type: 'summary', summary: pickOne(SUMMARY_CORPUS), leafUuid: nextUuid() };
}

function toolResultStringBlock(toolUseId) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: 'stdout: ok\nstderr:\n(exit 0)',
  };
}

function toolResultBlockArray(toolUseId, withImage = false) {
  const content = [
    { type: 'text', text: 'Here is the tool output.' },
    { type: 'text', text: 'Second fragment.' },
  ];
  if (withImage) {
    content.splice(1, 0, {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        // 1x1 transparent PNG
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      },
    });
  }
  return { type: 'tool_result', tool_use_id: toolUseId, content };
}

function imageBlock() {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    },
  };
}

function documentBlock() {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: 'JVBERi0xLjQKJcfsj6IKCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCg==',
    },
  };
}

function thinkingBlock() {
  return { type: 'thinking', thinking: 'Considering the refactor shape...' };
}

function redactedThinkingBlock() {
  return { type: 'redacted_thinking', data: 'REDACTED-THOUGHTS-12345' };
}

function toolUseBlock(name = null) {
  const id = `toolu_${nextHex(8)}`;
  return {
    id,
    block: {
      type: 'tool_use',
      id,
      name: name ?? pickOne(TOOL_NAMES),
      input: { path: '/src/index.ts' },
    },
  };
}

// ─── Rare SessionMessage variants ─────────────────────────────────────────

function agentNameMessage(sessionId) {
  return {
    type: 'agent-name',
    agentName: 'main-agent',
    sessionId,
  };
}

function customTitleMessage(sessionId) {
  return {
    type: 'custom-title',
    customTitle: 'Investigation: parser port',
    sessionId,
  };
}

function permissionModeMessage(sessionId) {
  return {
    type: 'permission-mode',
    permissionMode: 'acceptEdits',
    sessionId,
  };
}

function prLinkMessage(sessionId) {
  return {
    type: 'pr-link',
    sessionId,
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    prRepository: 'example/repo',
    timestamp: FIXED_TS,
  };
}

function queueOperationMessage(sessionId, operation = 'enqueue') {
  return {
    type: 'queue-operation',
    operation,
    timestamp: FIXED_TS,
    sessionId,
    content: 'queued prompt text',
  };
}

function lastPromptMessage(sessionId) {
  return {
    type: 'last-prompt',
    ...baseFields(sessionId),
    lastPrompt: 'What is the current status?',
  };
}

function attachmentMessage(sessionId) {
  return {
    type: 'attachment',
    ...baseFields(sessionId),
    attachment: {
      type: 'bash-output',
      hookName: 'post-bash',
      toolUseID: `toolu_${nextHex(6)}`,
      hookEvent: 'PostToolUse',
      content: 'captured output line',
      stdout: 'hello\nworld\n',
      stderr: '',
      exitCode: 0,
      command: 'echo hello',
      durationMs: 12.5,
    },
  };
}

function fileHistorySnapshotMessage() {
  const msgId = `msg_${nextHex(8)}`;
  return {
    type: 'file-history-snapshot',
    messageId: msgId,
    isSnapshotUpdate: false,
    snapshot: {
      messageId: msgId,
      timestamp: FIXED_TS,
      trackedFileBackups: {
        '/src/a.ts': {
          backupFileName: 'a.ts.bak',
          version: 1,
          backupTime: FIXED_TS,
        },
      },
    },
  };
}

function savedHookContextMessage(sessionId) {
  return {
    type: 'saved_hook_context',
    ...baseFields(sessionId),
    content: ['line one', 'line two'],
    hookName: 'pre-tool',
    hookEvent: 'PreToolUse',
    toolUseID: `toolu_${nextHex(6)}`,
  };
}

// ─── System subtypes ──────────────────────────────────────────────────────

function systemStopHookSummary(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    level: 'info',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    hookInfos: [{ command: 'run-lint' }, { command: 'run-tests' }],
    hookErrors: [],
    preventedContinuation: false,
    stopReason: 'user_stop',
    hasOutput: true,
    toolUseID: `toolu_${nextHex(6)}`,
  };
}

function systemTurnDuration(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    subtype: 'turn_duration',
    durationMs: 1234.5,
    messageCount: 4,
  };
}

function systemApiError(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    level: 'error',
    subtype: 'api_error',
    cause: { kind: 'overloaded_error' },
    error: { cause: { kind: 'overloaded_error' } },
    retryInMs: 500,
    retryAttempt: 1,
    maxRetries: 5,
  };
}

function systemCompactBoundary(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    subtype: 'compact_boundary',
    content: 'Summary of prior context.',
    logicalParentUuid: nextUuid(),
    compactMetadata: { trigger: 'manual', preTokens: 12000 },
  };
}

function systemMicrocompactBoundary(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    subtype: 'microcompact_boundary',
    content: 'Microcompact boundary marker.',
    microcompactMetadata: {
      trigger: 'auto',
      preTokens: 4000,
      tokensSaved: 1800,
      compactedToolIds: [`toolu_${nextHex(4)}`, `toolu_${nextHex(4)}`],
    },
  };
}

function systemLocalCommand(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    subtype: 'local_command',
    content: '/status',
  };
}

function systemBridgeStatus(sessionId) {
  return {
    type: 'system',
    ...baseFields(sessionId),
    subtype: 'bridge_status',
    url: 'https://bridge.local',
    content: 'ok',
  };
}

// ─── Progress subtypes ────────────────────────────────────────────────────

function progressBash(sessionId) {
  return {
    type: 'progress',
    ...baseFields(sessionId),
    toolUseID: `toolu_${nextHex(6)}`,
    parentToolUseID: '',
    data: {
      type: 'bash_progress',
      output: 'line 1\nline 2',
      fullOutput: 'line 1\nline 2\nline 3',
      elapsedTimeSeconds: 0.42,
      totalLines: 3,
    },
  };
}

function progressAgent(sessionId) {
  const agentId = `agent_${nextHex(4)}`;
  return {
    type: 'progress',
    ...baseFields(sessionId),
    toolUseID: `toolu_${nextHex(6)}`,
    parentToolUseID: `toolu_${nextHex(6)}`,
    agentId,
    data: {
      type: 'agent_progress',
      agentId,
      prompt: 'Find all TODOs.',
      normalizedMessages: [],
      message: {
        type: 'assistant',
        uuid: nextUuid(),
        timestamp: FIXED_TS,
        message: {
          model: 'claude-test',
          id: `msg_${nextHex(6)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Found three TODOs.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    },
  };
}

function progressMcp(sessionId) {
  return {
    type: 'progress',
    ...baseFields(sessionId),
    toolUseID: `toolu_${nextHex(6)}`,
    parentToolUseID: '',
    data: {
      type: 'mcp_progress',
      serverName: 'context7',
      toolName: 'resolve-library-id',
      status: 'completed',
      elapsedTimeMs: 312.5,
    },
  };
}

// ─── Session index entry ──────────────────────────────────────────────────

function buildSessionEntry(
  sessionId,
  fullPath,
  firstPrompt,
  messageCount,
  projectOriginalPath,
  isSidechain = false,
) {
  return {
    sessionId,
    fullPath,
    fileMtime: FIXED_MTIME.getTime(),
    firstPrompt,
    summary: '',
    messageCount,
    created: FIXED_TS,
    modified: FIXED_TS,
    gitBranch: 'main',
    projectPath: projectOriginalPath,
    isSidechain,
  };
}

// ─── Content mix for realistic sessions ───────────────────────────────────

function buildRealisticSessionLines(sessionId, messageCount) {
  const lines = [];
  const toolUseIds = [];
  lines.push(userMessage(sessionId, pickOne(USER_CORPUS)));

  for (let i = 1; i < messageCount; i++) {
    const dice = rng();
    if (dice < 0.5) {
      const blocks = [{ type: 'text', text: pickOne(ASSISTANT_TEXT_CORPUS) }];
      if (rng() < 0.5) {
        const tu = toolUseBlock();
        toolUseIds.push(tu.id);
        blocks.push(tu.block);
      }
      if (rng() < 0.15) blocks.unshift(thinkingBlock());
      lines.push(assistantMessage(sessionId, blocks));
    } else if (dice < 0.85) {
      if (toolUseIds.length > 0 && rng() < 0.5) {
        const tuid = toolUseIds[toolUseIds.length - 1];
        lines.push(userMessage(sessionId, [toolResultStringBlock(tuid)]));
      } else {
        lines.push(userMessage(sessionId, pickOne(USER_CORPUS)));
      }
    } else {
      lines.push(summaryMessage());
    }
  }

  return { lines, toolUseIds };
}

// ─── Project generators ───────────────────────────────────────────────────

const CLAUDE_DIR = path.join(OUT, '.claude');

/** Build a project dir & write its sessions-index + session files. */
function writeProject(projectIdx, buildSessions) {
  const slug = `-Users-test-medium${projectIdx + 1}`;
  const originalPath = `/Users/test/medium${projectIdx + 1}`;
  const projectDir = path.join(CLAUDE_DIR, 'projects', slug);

  const built = buildSessions(projectDir, slug, originalPath);
  const entries = built.entries;

  // sessions-index.json
  const indexPath = path.join(projectDir, 'sessions-index.json');
  write(indexPath, JSON.stringify({ version: 1, originalPath, entries }, null, 2));

  return {
    slug,
    originalPath,
    sessionIds: built.sessionIds,
  };
}

function writeSession(projectDir, sessionId, lines) {
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  write(jsonlPath, body);
  return jsonlPath;
}

/**
 * Utility: pull a "first prompt" value from the first user line, matching
 * what the TS / Rust parsers would write if sessions-index.json's
 * firstPrompt were empty. We always pre-fill the index entry with this so
 * both ingest paths store identical session.first_prompt values.
 */
function pickFirstPrompt(lines) {
  const first = lines[0];
  if (first && first.type === 'user') {
    if (typeof first.message.content === 'string') {
      return first.message.content.slice(0, 200);
    }
    if (Array.isArray(first.message.content)) {
      for (const b of first.message.content) {
        if (b.type === 'text' && typeof b.text === 'string') {
          return b.text.slice(0, 200);
        }
      }
    }
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Project 1 — user content variety (tool_result string, tool_result blocks
//             with image+text, image, document blocks)
// ═══════════════════════════════════════════════════════════════════════════

const project1 = writeProject(0, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  // Session 1a: realistic mix with tool_result string form
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 12);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Session 1b: user w/ tool_result block-array containing image+text sub-blocks
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const tu = toolUseBlock('Read');
    const lines = [
      userMessage(sessionId, 'Read /src/config.ts please.'),
      assistantMessage(sessionId, [
        { type: 'text', text: 'Calling Read tool.' },
        tu.block,
      ]),
      // Edge: tool_result with inner blocks mixing text + image
      userMessage(sessionId, [toolResultBlockArray(tu.id, true)]),
      assistantMessage(sessionId, [{ type: 'text', text: 'Here is the summary.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Session 1c: user w/ image block and document block content
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, [
        { type: 'text', text: 'What is in this screenshot?' },
        imageBlock(),
      ]),
      assistantMessage(sessionId, [{ type: 'text', text: 'A small transparent pixel.' }]),
      userMessage(sessionId, [
        { type: 'text', text: 'Summarise this PDF.' },
        documentBlock(),
      ]),
      assistantMessage(sessionId, [{ type: 'text', text: 'Empty document.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Project memory — covers memory parse path.
  write(
    path.join(projectDir, 'memory', 'MEMORY.md'),
    `# Memory for medium project 1\n\n- node 24\n- vite build\n`,
  );

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 2 — assistant content variety (redacted_thinking,
//             thinking+tool_use in same message)
// ═══════════════════════════════════════════════════════════════════════════

const project2 = writeProject(1, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  // Session 2a: assistant with redacted_thinking block
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, 'Plan the refactor.'),
      assistantMessage(sessionId, [
        redactedThinkingBlock(),
        { type: 'text', text: 'Here is the plan.' },
      ]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Session 2b: assistant with thinking followed by tool_use in same message
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const tu = toolUseBlock('Grep');
    const lines = [
      userMessage(sessionId, 'Find the failing assertion.'),
      assistantMessage(sessionId, [
        thinkingBlock(),
        { type: 'text', text: 'Searching for the assertion.' },
        tu.block,
      ]),
      userMessage(sessionId, [toolResultStringBlock(tu.id)]),
      assistantMessage(sessionId, [{ type: 'text', text: 'Found it — three hits.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Session 2c: realistic mix + tool-results/.txt files (exercises the
  // tool-results on-disk parse path, matching small fixture's project 2).
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines, toolUseIds } = buildRealisticSessionLines(sessionId, 14);
    const jsonl = writeSession(projectDir, sessionId, lines);
    for (const tuid of toolUseIds.slice(0, 3)) {
      write(
        path.join(projectDir, sessionId, 'tool-results', `${tuid}.txt`),
        `Result for ${tuid}:\nsome content\n`,
      );
    }
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 3 — every system subtype (all 7)
// ═══════════════════════════════════════════════════════════════════════════

const project3 = writeProject(2, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  // Session 3a: every system subtype in one session
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, 'Exercise every system subtype.'),
      systemStopHookSummary(sessionId),
      systemTurnDuration(sessionId),
      systemApiError(sessionId),
      systemCompactBoundary(sessionId),
      systemMicrocompactBoundary(sessionId),
      systemLocalCommand(sessionId),
      systemBridgeStatus(sessionId),
      assistantMessage(sessionId, [{ type: 'text', text: 'All system subtypes emitted.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Session 3b: plain realistic session for baseline
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 10);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 4 — progress variants (bash, agent, mcp)
// ═══════════════════════════════════════════════════════════════════════════

const project4 = writeProject(3, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, 'Run the benchmark and watch progress.'),
      progressBash(sessionId),
      progressAgent(sessionId),
      progressMcp(sessionId),
      assistantMessage(sessionId, [{ type: 'text', text: 'Progress snapshots captured.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Another realistic session so the project has multiple entries.
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 12);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 5 — attachment + saved_hook_context + last-prompt variants
// ═══════════════════════════════════════════════════════════════════════════

const project5 = writeProject(4, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, 'Exercise attachment + saved_hook_context + last-prompt.'),
      attachmentMessage(sessionId),
      savedHookContextMessage(sessionId),
      lastPromptMessage(sessionId),
      assistantMessage(sessionId, [{ type: 'text', text: 'Done.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Plain realistic session
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 10);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 6 — queue-operation, permission-mode, custom-title, pr-link,
//             agent-name, file-history-snapshot (non-base variants cluster)
// ═══════════════════════════════════════════════════════════════════════════

const project6 = writeProject(5, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const lines = [
      userMessage(sessionId, 'Exercise non-base variants.'),
      queueOperationMessage(sessionId, 'enqueue'),
      queueOperationMessage(sessionId, 'dequeue'),
      permissionModeMessage(sessionId),
      customTitleMessage(sessionId),
      prLinkMessage(sessionId),
      agentNameMessage(sessionId),
      fileHistorySnapshotMessage(),
      assistantMessage(sessionId, [{ type: 'text', text: 'All non-base variants emitted.' }]),
    ];
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // Plain realistic session
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 10);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 7 — sidechain session with matching subagent transcript
// ═══════════════════════════════════════════════════════════════════════════

const project7 = writeProject(6, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  // Sidechain session (isSidechain: true in index entry) — the writer stores
  // this as 1 in sessions.is_sidechain. The on-disk JSONL messages still use
  // their own isSidechain field (false by default); only the session-row
  // flag is derived from the index entry.
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 6);
    const jsonl = writeSession(projectDir, sessionId, lines);

    // Matching subagent transcript at <session>/subagents/agent-a*.jsonl.
    // The regex `^agent-(a.+)\.jsonl$` requires the id to start with 'a'.
    const subagentLines = [
      userMessage(sessionId, 'Sub-task: find all TODO comments.', { isSidechain: true }),
      assistantMessage(
        sessionId,
        [{ type: 'text', text: 'I found three TODO comments in src/.' }],
        { isSidechain: true },
      ),
    ];
    const transcriptPath = path.join(projectDir, sessionId, 'subagents', 'agent-alpha7.jsonl');
    write(transcriptPath, subagentLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath, true),
    );
  }

  // Plain session for contrast
  {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 8);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 8 — two sessions sharing the same session_id prefix
// ═══════════════════════════════════════════════════════════════════════════

const project8 = writeProject(7, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];

  // Fixed shared prefix — 8 hex chars (matches the UUID regex first group).
  const SHARED_PREFIX = '5ace5ace';

  for (let k = 0; k < 2; k++) {
    const sessionId = nextUuidWithPrefix(SHARED_PREFIX);
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, 8 + k);
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  return { entries, sessionIds };
});

// ═══════════════════════════════════════════════════════════════════════════
// Project 9 — bulk realistic sessions to pad to the ~500-message target
// ═══════════════════════════════════════════════════════════════════════════

const project9 = writeProject(8, (projectDir, _slug, originalPath) => {
  const entries = [];
  const sessionIds = [];
  // Bulk realistic sessions to pad the fixture toward the RFC target
  // (~500 messages, ~1MB on disk). The actual count keeps the rest of the
  // generator output stable: if you tune these numbers, regenerate both
  // the fixture tree and the README summary table together.
  for (let k = 0; k < 14; k++) {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, pickInt(32, 52));
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }

  // ── --scale N extension (scale=1 is a no-op; byte-identical to committed) ──
  // Appended AFTER the fixed 14-session loop so the RNG stream for scale=1
  // stays exactly as it was. For scale>1, add (scale-1) * 28 extra realistic
  // sessions to this project. The multiplier of 28 targets ~50MB at
  // scale=50 (the CI bench value). Scale=1 still produces zero extra work.
  const extraSessions = (SCALE - 1) * 28;
  for (let k = 0; k < extraSessions; k++) {
    const sessionId = nextUuid();
    sessionIds.push(sessionId);
    const { lines } = buildRealisticSessionLines(sessionId, pickInt(32, 52));
    const jsonl = writeSession(projectDir, sessionId, lines);
    entries.push(
      buildSessionEntry(sessionId, jsonl, pickFirstPrompt(lines), lines.length, originalPath),
    );
  }
  return { entries, sessionIds };
});

const projectResults = [
  project1,
  project2,
  project3,
  project4,
  project5,
  project6,
  project7,
  project8,
  project9,
];

// ─── Claude-level artifacts (todos / tasks / file-history) ────────────────

// Todos — tie to project 1 session 0 so there's a todo row in the index.
{
  const todoSession = project1.sessionIds[0];
  write(
    path.join(CLAUDE_DIR, 'todos', `${todoSession}-agent-agent_main.json`),
    JSON.stringify(
      [
        { content: 'Write the parser', status: 'completed' },
        { content: 'Port the writer', status: 'in_progress', activeForm: 'Porting' },
        { content: 'Add the medium diff harness', status: 'pending' },
      ],
      null,
      2,
    ),
  );
}

// Tasks — project 2 session 0.
{
  const taskSession = project2.sessionIds[0];
  write(path.join(CLAUDE_DIR, 'tasks', taskSession, '.lock'), '');
  write(path.join(CLAUDE_DIR, 'tasks', taskSession, '.highwatermark'), '99\n');
}

// File history — project 3 session 0. Single snapshot avoids readdir-order
// diffs (same rationale as the small fixture README explains).
{
  const historySession = project3.sessionIds[0];
  write(
    path.join(CLAUDE_DIR, 'file-history', historySession, 'abc123@v1'),
    'first snapshot contents\n',
  );
}

console.log(`Wrote deterministic fixture to: ${CLAUDE_DIR}`);
console.log(`Projects: ${projectResults.length}`);
console.log(`Total sessions: ${projectResults.reduce((n, p) => n + p.sessionIds.length, 0)}`);
