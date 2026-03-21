/**
 * Debug script — Diagnose why JSONL parsing silently fails during cold start.
 *
 * Creates a debug ProjectParseSink that logs every callback, then calls
 * parseProjectStreaming for a known broken project and reports the results.
 */

import { createFileService } from '../packages/core/src/io/file-service.js';
import { createProjectParser } from '../packages/core/src/parser/project-parser.js';
import type { ProjectParseSink } from '../packages/core/src/parser/parse-sink.js';
import type {
  SessionsIndex,
  SessionIndexEntry,
  SessionMessage,
  SubagentTranscript,
  PersistedToolResult,
  FileHistorySession,
  TodoFile,
  TaskEntry,
  PlanFile,
} from '../packages/core/src/types/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const claudeDir = path.join(os.homedir(), '.claude');
const targetSlug = '-Users-jamesyong';

console.log('=== SPAGHETTI JSONL PARSE DEBUGGER ===');
console.log(`Claude dir: ${claudeDir}`);
console.log(`Target project: ${targetSlug}`);
console.log('');

// Step 1: Check the project directory exists and list files
const projectDir = path.join(claudeDir, 'projects', targetSlug);
console.log(`Project dir: ${projectDir}`);
console.log(`Exists: ${fs.existsSync(projectDir)}`);

if (fs.existsSync(projectDir)) {
  const files = fs.readdirSync(projectDir);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  console.log(`Total files: ${files.length}`);
  console.log(`JSONL files: ${jsonlFiles.length}`);
  for (const f of jsonlFiles) {
    const stats = fs.statSync(path.join(projectDir, f));
    console.log(`  ${f} (${stats.size} bytes)`);
  }
}
console.log('');

// Step 2: Read sessions-index.json and check which entries have matching JSONL files
const indexPath = path.join(projectDir, 'sessions-index.json');
if (fs.existsSync(indexPath)) {
  const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const entries = indexData.entries || [];
  console.log(`sessions-index.json entries: ${entries.length}`);

  let existCount = 0;
  let missingCount = 0;
  for (const entry of entries) {
    const jsonlPath = path.join(projectDir, `${entry.sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      existCount++;
    } else {
      missingCount++;
    }
  }
  console.log(`  Entries with JSONL on disk: ${existCount}`);
  console.log(`  Entries without JSONL on disk: ${missingCount}`);
}
console.log('');

// Step 3: Create the FileService and ProjectParser
const fileService = createFileService();
const parser = createProjectParser(fileService);

// Step 4: Create a debug sink that counts everything
let projectCount = 0;
let sessionCount = 0;
let messageCount = 0;
let subagentCount = 0;
let toolResultCount = 0;
let fileHistoryCount = 0;
let todoCount = 0;
let taskCount = 0;
let planCount = 0;
let sessionCompleteCount = 0;
let projectCompleteCount = 0;
let memoryCount = 0;

const sessionMessages: Map<string, number> = new Map();
const errors: string[] = [];

const debugSink: ProjectParseSink = {
  onProject(slug: string, originalPath: string, sessionsIndex: SessionsIndex): void {
    projectCount++;
    console.log(`[onProject] slug=${slug}, originalPath=${originalPath}, entries=${sessionsIndex.entries.length}`);
  },

  onProjectMemory(slug: string, _content: string): void {
    memoryCount++;
    console.log(`[onProjectMemory] slug=${slug}`);
  },

  onSession(slug: string, entry: SessionIndexEntry): void {
    sessionCount++;
    const jsonlPath = path.join(claudeDir, 'projects', slug, `${entry.sessionId}.jsonl`);
    const exists = fs.existsSync(jsonlPath);
    if (!exists) {
      // Only log a few missing ones
      if (sessionCount <= 5) {
        console.log(`[onSession] sessionId=${entry.sessionId} (JSONL MISSING)`);
      }
    } else {
      const stats = fs.statSync(jsonlPath);
      console.log(`[onSession] sessionId=${entry.sessionId} (JSONL exists, ${stats.size} bytes)`);
    }
  },

  onMessage(slug: string, sessionId: string, _message: SessionMessage, index: number, byteOffset: number): void {
    messageCount++;
    const key = sessionId;
    sessionMessages.set(key, (sessionMessages.get(key) || 0) + 1);
    if (messageCount <= 3) {
      console.log(`[onMessage] sessionId=${sessionId}, index=${index}, byteOffset=${byteOffset}`);
    }
  },

  onSubagent(_slug: string, sessionId: string, _transcript: SubagentTranscript): void {
    subagentCount++;
  },

  onToolResult(_slug: string, sessionId: string, _toolResult: PersistedToolResult): void {
    toolResultCount++;
  },

  onFileHistory(sessionId: string, _history: FileHistorySession): void {
    fileHistoryCount++;
  },

  onTodo(sessionId: string, _todo: TodoFile): void {
    todoCount++;
  },

  onTask(sessionId: string, _task: TaskEntry): void {
    taskCount++;
  },

  onPlan(slug: string, _plan: PlanFile): void {
    planCount++;
  },

  onSessionComplete(slug: string, sessionId: string, msgCount: number, lastBytePos: number): void {
    sessionCompleteCount++;
    if (msgCount > 0) {
      console.log(`[onSessionComplete] sessionId=${sessionId}, messages=${msgCount}, lastBytePos=${lastBytePos}`);
    }
  },

  onProjectComplete(slug: string): void {
    projectCompleteCount++;
    console.log(`[onProjectComplete] slug=${slug}`);
  },
};

// Step 5: Run the parser
console.log('--- Running parseProjectStreaming ---');
try {
  parser.parseProjectStreaming(claudeDir, targetSlug, debugSink);
} catch (error) {
  console.error(`PARSER THREW: ${error}`);
}

// Step 6: Report results
console.log('');
console.log('=== RESULTS ===');
console.log(`Projects:          ${projectCount}`);
console.log(`Sessions:          ${sessionCount}`);
console.log(`Messages:          ${messageCount}`);
console.log(`Session completes: ${sessionCompleteCount}`);
console.log(`Project completes: ${projectCompleteCount}`);
console.log(`Subagents:         ${subagentCount}`);
console.log(`Tool results:      ${toolResultCount}`);
console.log(`File histories:    ${fileHistoryCount}`);
console.log(`Todos:             ${todoCount}`);
console.log(`Tasks:             ${taskCount}`);
console.log(`Plans:             ${planCount}`);
console.log(`Memories:          ${memoryCount}`);
console.log('');
console.log('Messages per session:');
for (const [sessionId, count] of sessionMessages) {
  console.log(`  ${sessionId}: ${count} messages`);
}

// Step 7: Also test the streaming reader directly for a known JSONL file
console.log('');
console.log('--- Direct streaming reader test ---');
import { readJsonlStreaming } from '../packages/core/src/io/streaming-jsonl-reader.js';

const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
for (const jsonlFile of jsonlFiles) {
  const filePath = path.join(projectDir, jsonlFile);
  const stats = fs.statSync(filePath);
  let directMsgCount = 0;
  let directErrors = 0;

  const result = readJsonlStreaming(filePath, (_entry, _index, _offset) => {
    directMsgCount++;
  }, {
    onError: (lineIndex, error) => {
      directErrors++;
      console.log(`  [ERROR] line ${lineIndex}: ${error}`);
    },
  });

  console.log(`File: ${jsonlFile} (${stats.size} bytes)`);
  console.log(`  totalLines=${result.totalLines}, processed=${result.processedLines}, errors=${result.errorCount}, callbacks=${directMsgCount}`);
}

// Step 8: Test ALL projects to find which have 0 messages
console.log('');
console.log('--- Testing ALL projects ---');
const projectsDir = path.join(claudeDir, 'projects');
const allProjectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

console.log(`Total project directories: ${allProjectDirs.length}`);

const zeroMessageProjects: string[] = [];

for (const slug of allProjectDirs) {
  let totalMsgs = 0;
  let totalSessions = 0;

  const countSink: ProjectParseSink = {
    onProject() {},
    onProjectMemory() {},
    onSession() { totalSessions++; },
    onMessage() { totalMsgs++; },
    onSubagent() {},
    onToolResult() {},
    onFileHistory() {},
    onTodo() {},
    onTask() {},
    onPlan() {},
    onSessionComplete() {},
    onProjectComplete() {},
  };

  try {
    parser.parseProjectStreaming(claudeDir, slug, countSink);
  } catch {
    // skip
  }

  if (totalSessions > 0 && totalMsgs === 0) {
    const projDir = path.join(projectsDir, slug);
    const hasJsonl = fs.readdirSync(projDir).some(f => f.endsWith('.jsonl'));
    zeroMessageProjects.push(`${slug} (${totalSessions} sessions, has_jsonl=${hasJsonl})`);
  }
}

console.log(`Projects with sessions but 0 messages: ${zeroMessageProjects.length}`);
for (const p of zeroMessageProjects) {
  console.log(`  ${p}`);
}
