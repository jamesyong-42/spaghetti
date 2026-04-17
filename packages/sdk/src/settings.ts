/**
 * Spaghetti SDK settings — persisted user preferences.
 *
 * Backs `~/.spaghetti/config.json`. The only setting today is which
 * ingest engine (native Rust vs pure TypeScript) to use; more may land
 * over time. Keep the file small, hand-editable, and forward-compatible
 * (unknown keys are preserved on write).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type IngestEngine = 'ts' | 'rs';

export interface SpaghettiSettings {
  /** Which ingest engine to use for startup. Defaults to `rs` (native). */
  engine?: IngestEngine;
  /** Unknown keys from future versions are preserved. */
  [key: string]: unknown;
}

export function settingsPath(): string {
  return path.join(os.homedir(), '.spaghetti', 'config.json');
}

export function readSettings(): SpaghettiSettings {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SpaghettiSettings;
  } catch {
    return {};
  }
}

export function writeSettings(settings: SpaghettiSettings): void {
  const p = settingsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Resolve the active ingest engine, consulting (in order):
 * 1. `SPAG_ENGINE=ts|rs` env var
 * 2. Legacy `SPAG_NATIVE_INGEST=0|1` env var (0 → ts, 1 → rs)
 * 3. Persisted `engine` setting in `~/.spaghetti/config.json`
 * 4. Default: `rs`
 */
export function resolveEngine(): IngestEngine {
  const envEngine = process.env.SPAG_ENGINE;
  if (envEngine === 'ts' || envEngine === 'rs') return envEngine;

  const legacy = process.env.SPAG_NATIVE_INGEST;
  if (legacy === '0') return 'ts';
  if (legacy === '1') return 'rs';

  const stored = readSettings().engine;
  if (stored === 'ts' || stored === 'rs') return stored;

  return 'rs';
}

/**
 * Default DB path for a given engine.
 *
 * Separate files per engine means switching engines doesn't require
 * re-ingesting — each side keeps its own cache and results are
 * comparable side-by-side. Useful while TS remains the iteration +
 * ground-truth path and Rust is still stabilising.
 */
export function defaultDbPathForEngine(engine: IngestEngine): string {
  return path.join(os.homedir(), '.spaghetti', 'cache', `spaghetti-${engine}.db`);
}
