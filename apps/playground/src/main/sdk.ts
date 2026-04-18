/**
 * Owns the single SpaghettiService instance used by the main process.
 *
 * The service is created lazily on first use and shut down cleanly on app
 * quit. All IPC handlers import `getSdk()` rather than a live reference, so
 * we don't accidentally hold a reference before initialize() resolves.
 *
 * The DB path and ingest engine are provided by the caller (typically
 * `<userData>/cache/…` and whatever is in `<userData>/settings.json`) so
 * the desktop app owns both pieces of state inside its Electron-managed
 * app data folder rather than inheriting from the SDK's home-relative
 * default or the CLI's shared `~/.spaghetti/config.json`.
 */

import { createSpaghettiService, type IngestEngine, type SpaghettiAPI } from '@vibecook/spaghetti-sdk';

let sdkInstance: SpaghettiAPI | null = null;
let initPromise: Promise<SpaghettiAPI> | null = null;
let activeEngine: IngestEngine | null = null;

export function getSdk(): SpaghettiAPI {
  if (!sdkInstance) {
    throw new Error('SDK not initialized — call initSdk() first');
  }
  return sdkInstance;
}

export function getEngine(): IngestEngine {
  if (!activeEngine) {
    throw new Error('SDK not initialized — engine unresolved');
  }
  return activeEngine;
}

export interface InitSdkOptions {
  /** Absolute path to the SQLite index file. */
  dbPath: string;
  /** Ingest engine to run for this process. */
  engine: IngestEngine;
  /** Optional Claude source dir; defaults to the SDK's `~/.claude`. */
  claudeDir?: string;
}

export function initSdk(options: InitSdkOptions): Promise<SpaghettiAPI> {
  if (initPromise) return initPromise;

  activeEngine = options.engine;
  const service = createSpaghettiService({
    dbPath: options.dbPath,
    engine: options.engine,
    ...(options.claudeDir ? { claudeDir: options.claudeDir } : {}),
  });
  sdkInstance = service;

  initPromise = service.initialize().then(() => service);
  return initPromise;
}

export function shutdownSdk(): void {
  if (sdkInstance) {
    try {
      sdkInstance.shutdown();
    } catch (err) {
      console.error('[sdk] shutdown failed', err);
    }
    sdkInstance = null;
    initPromise = null;
    activeEngine = null;
  }
}
