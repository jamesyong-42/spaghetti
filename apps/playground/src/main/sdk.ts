/**
 * Owns the single SpaghettiService instance used by the main process.
 *
 * The service is created lazily on first use and shut down cleanly on app
 * quit. All IPC handlers import `getSdk()` rather than a live reference, so
 * we don't accidentally hold a reference before initialize() resolves.
 *
 * The DB path is provided by the caller (typically `<userData>/cache/…`)
 * so the desktop app keeps its index inside the Electron-managed app data
 * folder rather than the SDK's home-relative default.
 */

import { createSpaghettiService, resolveEngine, type IngestEngine, type SpaghettiAPI } from '@vibecook/spaghetti-sdk';

let sdkInstance: SpaghettiAPI | null = null;
let initPromise: Promise<SpaghettiAPI> | null = null;
let resolvedEngine: IngestEngine | null = null;

export function getSdk(): SpaghettiAPI {
  if (!sdkInstance) {
    throw new Error('SDK not initialized — call initSdk() first');
  }
  return sdkInstance;
}

export function getEngine(): IngestEngine {
  return resolvedEngine ?? resolveEngine();
}

export interface InitSdkOptions {
  /** Absolute path to the SQLite index file. */
  dbPath: string;
  /** Optional Claude source dir; defaults to the SDK's `~/.claude`. */
  claudeDir?: string;
}

export function initSdk(options: InitSdkOptions): Promise<SpaghettiAPI> {
  if (initPromise) return initPromise;

  resolvedEngine = resolveEngine();
  const service = createSpaghettiService({
    dbPath: options.dbPath,
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
    resolvedEngine = null;
  }
}
