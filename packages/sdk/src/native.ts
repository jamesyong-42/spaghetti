/**
 * Native addon loader — optional @vibecook/spaghetti-sdk-native.
 *
 * The Rust ingest core (RFC 003) ships as a separate native addon. This
 * module loads it opportunistically: if the addon is missing, fails to
 * load, or the SPAG_NATIVE_INGEST feature flag is off, the SDK falls
 * back to the pure-TypeScript ingest path.
 *
 * The native API surface grows in later phases. For now, the only export
 * is nativeVersion() — enough to smoke-test loading on each platform.
 */

import { createRequire } from 'node:module';

export interface NativeAddon {
  /** Returns the semver of the loaded native addon. */
  nativeVersion(): string;
  // Phase 1 will add:
  //   ingest(opts: IngestOptions, onProgress?: ProgressCallback): Promise<IngestStats>;
}

let cached: NativeAddon | null | undefined;

/**
 * Load the native addon, returning null if unavailable.
 *
 * Result is memoized — a missing addon won't be retried on subsequent calls.
 */
export function loadNativeAddon(): NativeAddon | null {
  if (cached !== undefined) return cached;

  try {
    const require = createRequire(import.meta.url);
    cached = require('@vibecook/spaghetti-sdk-native') as NativeAddon;
  } catch {
    cached = null;
  }

  return cached;
}

/**
 * Whether the caller has opted into the native ingest path via env var.
 *
 * Default is false (TS path) until the native ingest is stabilized and
 * Phase 4 flips the default.
 */
export function isNativeIngestEnabled(): boolean {
  return process.env.SPAG_NATIVE_INGEST === '1';
}
