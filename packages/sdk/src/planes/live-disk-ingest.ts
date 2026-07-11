/**
 * LiveDiskIngest — Plane 2 façade (filesystem watch + incremental write).
 *
 * Wraps {@link createLiveUpdates}. Present only when the service is
 * constructed with `{ live: true }`. Public subscribers use `api.live`.
 *
 * See `docs/THREE-PLANE-INGEST-ARCHITECTURE.md` and RFC 005.
 */

import type { ErrorSink } from '../io/error-sink.js';
import type { FileService } from '../io/file-service.js';
import { createLiveUpdates, type LiveUpdates, type LiveUpdatesOptions } from '../live/live-updates.js';
import type { AgentSource } from '../sources/types.js';
import type { DurableStore } from '../store/durable-store.js';

/** Plane 2 orchestrator — same surface as LiveUpdates for now. */
export type LiveDiskIngest = LiveUpdates;

export interface LiveDiskIngestOptions {
  source: AgentSource;
  store: DurableStore;
  fileService: FileService;
  /** Absolute DB path — must match StaticIngest / LifecycleOwner. */
  dbPath: string;
  errorSink?: ErrorSink;
  /** Pass-through knobs for the underlying LiveUpdates pipeline. */
  liveOptions?: Omit<LiveUpdatesOptions, 'claudeDir' | 'errorSink'>;
}

/**
 * Start the live disk pipeline for `source.rootDir` writing into `store`.
 */
export function createLiveDiskIngest(options: LiveDiskIngestOptions): LiveDiskIngest {
  return createLiveUpdates(
    {
      fileService: options.fileService,
      ingestService: options.store.ingest,
      store: options.store.data,
      sqlite: options.store.sqlite,
      dbPath: options.dbPath,
    },
    {
      claudeDir: options.source.rootDir,
      errorSink: options.errorSink,
      ...options.liveOptions,
    },
  );
}
