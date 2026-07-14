/**
 * Claude Code live-disk façade — builds {@link ClaudeCodeLiveUpdates}
 * from AgentSource + DurableStore.
 *
 * Formerly `planes/live-disk-ingest.ts` under the misleadingly generic
 * name `LiveDiskIngest`. Codex/Grok do not use this; they own
 * `CodexLiveWatch` / `GrokLiveWatch`.
 */

import type { ErrorSink } from '../../../io/error-sink.js';
import type { FileService } from '../../../io/file-service.js';
import type { AgentSource } from '../../types.js';
import type { DurableStore } from '../../../store/durable-store.js';
import {
  createClaudeCodeLiveUpdates,
  type ClaudeCodeLiveUpdates,
  type ClaudeCodeLiveUpdatesOptions,
} from './live-updates.js';

/** Claude Code Plane 2 live orchestrator. */
export type ClaudeCodeLiveDiskIngest = ClaudeCodeLiveUpdates;

export interface ClaudeCodeLiveDiskIngestOptions {
  source: AgentSource;
  store: DurableStore;
  fileService: FileService;
  /** Absolute DB path — must match StaticIngest / LifecycleOwner. */
  dbPath: string;
  errorSink?: ErrorSink;
  /** Pass-through knobs for the Claude live pipeline. */
  liveOptions?: Omit<ClaudeCodeLiveUpdatesOptions, 'rootDir' | 'errorSink'>;
}

/**
 * Start the Claude live disk pipeline for `source.rootDir` writing into `store`.
 */
export function createClaudeCodeLiveDiskIngest(options: ClaudeCodeLiveDiskIngestOptions): ClaudeCodeLiveDiskIngest {
  return createClaudeCodeLiveUpdates(
    {
      fileService: options.fileService,
      ingestService: options.store.ingest,
      store: options.store.data,
      sqlite: options.store.sqlite,
      dbPath: options.dbPath,
    },
    {
      rootDir: options.source.rootDir,
      classify: options.source.classify,
      errorSink: options.errorSink,
      ...options.liveOptions,
    },
  );
}
