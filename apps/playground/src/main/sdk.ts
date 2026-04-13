/**
 * Owns the single SpaghettiService instance used by the main process.
 *
 * The service is created lazily on first use and shut down cleanly on app
 * quit. All IPC handlers import `getSdk()` rather than a live reference, so
 * we don't accidentally hold a reference before initialize() resolves.
 */

import { createSpaghettiService, type SpaghettiAPI } from '@vibecook/spaghetti-sdk';

let sdkInstance: SpaghettiAPI | null = null;
let initPromise: Promise<SpaghettiAPI> | null = null;

export function getSdk(): SpaghettiAPI {
  if (!sdkInstance) {
    throw new Error('SDK not initialized — call initSdk() first');
  }
  return sdkInstance;
}

export function initSdk(): Promise<SpaghettiAPI> {
  if (initPromise) return initPromise;

  const service = createSpaghettiService();
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
  }
}
