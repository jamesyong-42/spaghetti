/**
 * Engine command — show or switch the active ingest engine.
 *
 * Each engine (ts/rs) writes to its own SQLite file, so switching
 * doesn't force a re-ingest. Setting is persisted to
 * `~/.spaghetti/config.json` and picked up by the SDK on next startup.
 */

import {
  defaultDbPathForEngine,
  loadNativeAddon,
  readSettings,
  resolveEngine,
  settingsPath,
  writeSettings,
  type IngestEngine,
} from '@vibecook/spaghetti-sdk';
import { theme } from '../lib/color.js';

export interface EngineOptions {
  json?: boolean;
}

export async function engineCommand(target: string | undefined, opts: EngineOptions): Promise<void> {
  const current = resolveEngine();
  const settings = readSettings();
  const native = loadNativeAddon();

  // ── Show current state (no target argument) ───────────────────────────
  if (!target) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            active: current,
            persisted: settings.engine ?? null,
            source: engineSource(settings.engine),
            nativeAddonAvailable: native !== null,
            nativeVersion: native?.nativeVersion() ?? null,
            dbPaths: {
              ts: defaultDbPathForEngine('ts'),
              rs: defaultDbPathForEngine('rs'),
            },
            configPath: settingsPath(),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${theme.heading('Active ingest engine')}`);
    lines.push('');
    lines.push(`    engine:     ${theme.project(current)}${current === 'ts' ? ' (TypeScript)' : ' (Rust native)'}`);
    lines.push(`    source:     ${theme.muted(engineSource(settings.engine))}`);
    lines.push(
      `    native:     ${native ? theme.project('available') + theme.muted(` (v${native.nativeVersion()})`) : theme.muted('not installed')}`,
    );
    lines.push('');
    lines.push(`  ${theme.muted('DB files')}`);
    lines.push(`    ts:  ${defaultDbPathForEngine('ts')}`);
    lines.push(`    rs:  ${defaultDbPathForEngine('rs')}`);
    lines.push('');
    lines.push(`  ${theme.muted('Switch with: spag engine ts   or   spag engine rs')}`);
    lines.push(`  ${theme.muted('Config: ' + settingsPath())}`);
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  // ── Switch engines ────────────────────────────────────────────────────
  const lower = target.toLowerCase();
  if (lower !== 'ts' && lower !== 'rs') {
    process.stderr.write(theme.error(`\n  Unknown engine: "${target}". Use "ts" or "rs".\n\n`));
    process.exitCode = 1;
    return;
  }

  const next = lower as IngestEngine;

  if (next === 'rs' && !native) {
    process.stderr.write(
      theme.error(
        `\n  Native addon (@vibecook/spaghetti-sdk-native) not installed.\n` +
          `  The Rust engine is unavailable on this install — keeping current engine (${current}).\n\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  writeSettings({ ...settings, engine: next });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          previous: current,
          active: next,
          dbPath: defaultDbPathForEngine(next),
          configPath: settingsPath(),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  process.stdout.write(
    '\n  ' +
      theme.project(`Engine switched: ${current} → ${next}`) +
      '\n' +
      theme.muted(`  DB: ${defaultDbPathForEngine(next)}`) +
      '\n' +
      theme.muted(`  (Next spag invocation will use the ${next} engine.)`) +
      '\n\n',
  );
}

function engineSource(persisted: IngestEngine | undefined): string {
  if (process.env.SPAG_ENGINE === 'ts' || process.env.SPAG_ENGINE === 'rs') {
    return `env SPAG_ENGINE=${process.env.SPAG_ENGINE}`;
  }
  if (process.env.SPAG_NATIVE_INGEST === '0' || process.env.SPAG_NATIVE_INGEST === '1') {
    return `env SPAG_NATIVE_INGEST=${process.env.SPAG_NATIVE_INGEST} (legacy)`;
  }
  if (persisted) return `config file`;
  return `default`;
}
