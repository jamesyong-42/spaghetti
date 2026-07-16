/**
 * Minimal test — directly call parseAllProjectsStreaming with an IngestService sink
 * to verify messages are being parsed and inserted into the DB.
 *
 * ⚠️  DANGER: this manual dev script WRITES TO YOUR REAL Spaghetti cache DB at
 *     ~/.spaghetti/cache/spaghetti.db. Set SPAGHETTI_DB_PATH to a throwaway path
 *     to run it against a scratch DB instead of your real data.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createFileService } from '../packages/sdk/src/io/file-service.js';
import { createSqliteService } from '../packages/sdk/src/io/sqlite-service.js';
import { createClaudeCodeParser } from '../packages/sdk/src/parser/claude-code-parser.js';
import { createQueryService } from '../packages/sdk/src/data/query-service.js';
import { createIngestService } from '../packages/sdk/src/data/ingest-service.js';

const rootDir = path.join(os.homedir(), '.claude');
// SPAGHETTI_DB_PATH overrides the real cache DB — see the danger note above.
const dbPath =
  process.env.SPAGHETTI_DB_PATH ?? path.join(os.homedir(), '.spaghetti', 'cache', 'spaghetti.db');

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
  parser.parseStreaming(ingestService, { rootDir });
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

const target = summaries.find((s) => s.slug === '-Users-jamesyong');
if (target) {
  console.log(`\n-Users-jamesyong: sessions=${target.sessionCount}, messages=${target.messageCount}`);
}

queryService.close();
ingestService.close();
console.log('Done.');
