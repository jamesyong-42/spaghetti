/**
 * App-scoped settings for the playground.
 *
 * Persisted at `<userData>/settings.json`, following Electron's per-app
 * data-dir convention. The CLI and other SDK consumers share a global
 * `~/.spaghetti/config.json`; the playground deliberately does not read
 * from that file so a user's shell-level engine preference never leaks
 * into the desktop app (and vice versa).
 *
 * The file is small, hand-editable, and forward-compatible: unknown keys
 * from future versions are preserved on read and re-serialised on write.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { IngestEngine } from '@vibecook/spaghetti-sdk';

export interface PlaygroundSettings {
  /** Ingest engine the playground should use. Defaults to `rs` (native). */
  engine?: IngestEngine;
  /** Unknown keys from future versions are preserved. */
  [key: string]: unknown;
}

const DEFAULT_ENGINE: IngestEngine = 'rs';

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function readSettings(): PlaygroundSettings {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as PlaygroundSettings;
  } catch {
    // Malformed on-disk file — treat as empty rather than crash the app.
    return {};
  }
}

export function writeSettings(settings: PlaygroundSettings): void {
  const p = settingsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Engine the playground should run. Reads `<userData>/settings.json` and
 * falls back to the default (`rs`). Deliberately does not consult
 * `SPAG_ENGINE` or `~/.spaghetti/config.json` — those belong to the CLI's
 * user-level preference surface, not the desktop app's.
 */
export function resolveAppEngine(): IngestEngine {
  const stored = readSettings().engine;
  if (stored === 'ts' || stored === 'rs') return stored;
  return DEFAULT_ENGINE;
}
