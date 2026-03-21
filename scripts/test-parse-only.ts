/**
 * Minimal test — directly call parseAllProjectsStreaming with an IngestService sink
 * to verify messages are being parsed and inserted into the DB.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createFileService } from '../packages/core/src/io/file-service.js';
import { createSqliteService } from '../packages/core/src/io/sqlite-service.js';
import { createClaudeCodeParser } from '../packages/core/src/parser/claude-code-parser.js';
import { createQueryService } from '../packages/core/src/data/query-service.js';
import { createIngestService } from '../packages/core/src/data/ingest-service.js';

const claudeDir = path.join(os.homedir(), '.claude');
const dbPath = path.join(os.homedir(), '.spaghetti', 'cache', 'spaghetti.db');

console.log('Creating services directly from source...');

const fileService = createFileService();
const sharedSqlite = createSqliteService();
const sqliteFactory = () => sharedSqlite;
const queryService = createQueryService(sqliteFactory);
const ingestService = createIngestService(sqliteFactory);
const parser = createClaudeCodeParser(fileService);

// Open DB
queryService.open(dbPath);
ingestService.open(dbPath);

// Cold start: parse all projects
console.log('Parsing all projects...');
ingestService.beginTransaction();
try {
  parser.parseStreaming(ingestService, { claudeDir });
  ingestService.commitTransaction();
} catch (error) {
  ingestService.rollbackTransaction();
  throw error;
}

// Check results
console.log('Checking results...');
const summaries = queryService.getProjectSummaries();
console.log(`Total projects: ${summaries.length}`);

let zeroMsgCount = 0;
for (const s of summaries) {
  if (s.sessionCount > 0 && s.messageCount === 0) {
    zeroMsgCount++;
    console.log(`  ZERO msgs: ${s.slug} (sessions=${s.sessionCount})`);
  }
}
console.log(`Projects with sessions but 0 messages: ${zeroMsgCount}`);

const target = summaries.find(s => s.slug === '-Users-jamesyong');
if (target) {
  console.log(`\n-Users-jamesyong: sessions=${target.sessionCount}, messages=${target.messageCount}`);
}

queryService.close();
ingestService.close();
console.log('Done.');
