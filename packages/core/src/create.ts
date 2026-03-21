/**
 * Factory — createSpaghettiService()
 *
 * Wires up all internal services and returns a SpaghettiAPI instance.
 */

import { createFileService } from './io/file-service.js';
import { createSqliteService } from './io/sqlite-service.js';
import { createSpaghettiAppService } from './app-service.js';
import { createClaudeCodeParser } from './parser/claude-code-parser.js';
import { createQueryService } from './data/query-service.js';
import { createIngestService } from './data/ingest-service.js';
import { AgentDataServiceImpl } from './data/agent-data-service.js';
import type { SpaghettiAPI } from './api.js';
import type { ClaudeCodeAgentDataService, AgentDataServiceOptions } from './data/agent-data-service.js';

export interface SpaghettiServiceOptions {
  /** Override the data service implementation (for testing or custom setups) */
  dataService?: ClaudeCodeAgentDataService;
  /** Override the default DB path */
  dbPath?: string;
  /** Override the Claude data directory (defaults to ~/.claude) */
  claudeDir?: string;
}

/**
 * Create a fully wired SpaghettiAPI instance.
 *
 * Usage:
 *   import { createSpaghettiService } from '@spaghetti/core';
 *
 *   const spaghetti = createSpaghettiService();
 *   await spaghetti.initialize();
 *   const projects = spaghetti.getProjectList();
 */
export function createSpaghettiService(options?: SpaghettiServiceOptions): SpaghettiAPI {
  if (options?.dataService) {
    return createSpaghettiAppService(options.dataService);
  }

  // Default wiring: create all services from scratch
  const fileService = createFileService();
  const sqliteFactory = () => createSqliteService();
  const queryService = createQueryService(sqliteFactory);
  const ingestService = createIngestService(sqliteFactory);
  const parser = createClaudeCodeParser(fileService);

  const dataServiceOptions: AgentDataServiceOptions = {};
  if (options?.dbPath) dataServiceOptions.dbPath = options.dbPath;
  if (options?.claudeDir) dataServiceOptions.claudeDir = options.claudeDir;

  const dataService = new AgentDataServiceImpl(
    fileService,
    parser,
    queryService,
    ingestService,
    dataServiceOptions,
  );

  return createSpaghettiAppService(dataService);
}

// Re-export the service factories for manual wiring
export { createFileService } from './io/file-service.js';
export { createSqliteService } from './io/sqlite-service.js';
export { createSpaghettiAppService } from './app-service.js';
