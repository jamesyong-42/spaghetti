/**
 * Auto-updater — background update check and install
 *
 * On CLI startup:
 * 1. Check ~/.spaghetti/update-check.json for last check time
 * 2. If update was applied, show notification
 * 3. If last check > 1 hour ago, spawn detached background process
 * 4. Background process checks npm registry and installs if newer
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import pc from 'picocolors';

const UPDATE_DIR = join(homedir(), '.spaghetti');
const UPDATE_FILE = join(UPDATE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface UpdateCheckData {
  lastCheck: number;
  latestVersion: string | null;
  currentVersionAtCheck: string;
  updateApplied: boolean;
  appliedVersion: string | null;
}

function getVersion(): string {
  try {
    const _require = createRequire(import.meta.url);
    const pkg = _require('../package.json') as { version: string };
    return pkg.version || '0.0.0';
  } catch {
    // Fallback: try one more level up
    try {
      const _require = createRequire(import.meta.url);
      const pkg = _require('../../package.json') as { version: string };
      return pkg.version || '0.0.0';
    } catch {}
  }
  return '0.0.0';
}

function readUpdateData(): UpdateCheckData | null {
  try {
    if (existsSync(UPDATE_FILE)) {
      return JSON.parse(readFileSync(UPDATE_FILE, 'utf-8')) as UpdateCheckData;
    }
  } catch {}
  return null;
}

function writeUpdateData(data: UpdateCheckData): void {
  try {
    if (!existsSync(UPDATE_DIR)) {
      mkdirSync(UPDATE_DIR, { recursive: true });
    }
    writeFileSync(UPDATE_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

export function checkForUpdates(): void {
  // Respect opt-out
  if (process.env['SPAGHETTI_NO_UPDATE'] || process.argv.includes('--no-update-check')) {
    return;
  }

  try {
    const data = readUpdateData();
    const currentVersion = getVersion();

    // Show notification if update was applied since last run
    if (data?.updateApplied && data.appliedVersion && data.appliedVersion !== currentVersion) {
      // Version changed but appliedVersion doesn't match — stale flag
      writeUpdateData({ ...data, updateApplied: false });
    } else if (data?.updateApplied && data.appliedVersion) {
      process.stderr.write(pc.dim(`  Updated to v${data.appliedVersion}\n`));
      writeUpdateData({ ...data, updateApplied: false });
    }

    // Check interval
    if (data?.lastCheck && Date.now() - data.lastCheck < CHECK_INTERVAL_MS) {
      return;
    }

    // Spawn detached background updater
    spawnBackgroundUpdater(currentVersion);
  } catch {
    // Never let update checking crash the CLI
  }
}

function spawnBackgroundUpdater(currentVersion: string): void {
  const script = `
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const UPDATE_FILE = ${JSON.stringify(UPDATE_FILE)};
    const UPDATE_DIR = ${JSON.stringify(UPDATE_DIR)};
    const CURRENT = ${JSON.stringify(currentVersion)};

    function isNewer(a, b) {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i]||0) > (pb[i]||0)) return true;
        if ((pa[i]||0) < (pb[i]||0)) return false;
      }
      return false;
    }

    try {
      const latest = execSync('npm view @spaghetti/cli version', {
        timeout: 10000, encoding: 'utf-8'
      }).trim();

      const data = {
        lastCheck: Date.now(),
        latestVersion: latest,
        currentVersionAtCheck: CURRENT,
        updateApplied: false,
        appliedVersion: null,
      };

      if (latest && latest !== CURRENT && isNewer(latest, CURRENT)) {
        try {
          execSync('npm install -g @spaghetti/cli@latest', {
            timeout: 60000, stdio: 'ignore'
          });
          data.updateApplied = true;
          data.appliedVersion = latest;
        } catch {}
      }

      if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
      fs.writeFileSync(UPDATE_FILE, JSON.stringify(data, null, 2));
    } catch {}
  `;

  try {
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // Silently fail if we can't spawn
  }
}
