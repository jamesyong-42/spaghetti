/**
 * Auto-updater — truffle-style background update check + manual update command
 *
 * Background (on CLI startup):
 * 1. Check ~/.spaghetti/update-check.json for last check time
 * 2. If update was applied, show notification
 * 3. If last check > 24h ago, spawn detached background process
 * 4. Background process checks GitHub releases and installs via npm if newer
 *
 * Manual (`spaghetti update`):
 * 1. Check GitHub releases for latest version
 * 2. Show current vs latest with progress
 * 3. Install via npm with visible output
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import pc from 'picocolors';

const SPAGHETTI_DIR = join(homedir(), '.spaghetti');
const UPDATE_FILE = join(SPAGHETTI_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours (like truffle)
const GITHUB_REPO = 'jamesyong-42/spaghetti';
const NPM_PACKAGE = '@vibecook/spaghetti';

interface UpdateCheckData {
  lastCheck: number;
  latestVersion: string | null;
  currentVersionAtCheck: string;
  updateAvailable: boolean;
  updateApplied: boolean;
  appliedVersion: string | null;
}

export function getVersion(): string {
  try {
    const _require = createRequire(import.meta.url);
    const pkg = _require('../package.json') as { version: string };
    return pkg.version || '0.0.0';
  } catch {
    try {
      const _require = createRequire(import.meta.url);
      const pkg = _require('../../package.json') as { version: string };
      return pkg.version || '0.0.0';
    } catch {}
  }
  return '0.0.0';
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
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
    if (!existsSync(SPAGHETTI_DIR)) {
      mkdirSync(SPAGHETTI_DIR, { recursive: true });
    }
    writeFileSync(UPDATE_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND CHECK (called on every CLI startup)
// ═══════════════════════════════════════════════════════════════════════════

export function checkForUpdates(): void {
  // Respect opt-out
  if (process.env['SPAGHETTI_NO_UPDATE'] || process.argv.includes('--no-update-check')) {
    return;
  }

  try {
    const data = readUpdateData();
    const currentVersion = getVersion();

    // Show notification if update was applied
    if (data?.updateApplied && data.appliedVersion) {
      if (data.appliedVersion === currentVersion) {
        // Successfully updated — show once
        process.stderr.write(
          `  ${pc.green('✔')} Updated to ${pc.bold(`v${data.appliedVersion}`)}\n`,
        );
      }
      writeUpdateData({ ...data, updateApplied: false });
    }

    // Show "update available" nudge (like truffle's startup notification)
    if (data?.updateAvailable && data.latestVersion && isNewer(data.latestVersion, currentVersion)) {
      process.stderr.write(
        pc.dim(`  Update available: ${currentVersion} → ${pc.bold(pc.cyan(data.latestVersion))}`) +
        pc.dim(`  Run ${pc.cyan('spaghetti update')} to upgrade\n`),
      );
    }

    // Check interval (24h like truffle)
    if (data?.lastCheck && Date.now() - data.lastCheck < CHECK_INTERVAL_MS) {
      return;
    }

    // Spawn detached background checker
    spawnBackgroundChecker(currentVersion);
  } catch {
    // Never let update checking crash the CLI
  }
}

function spawnBackgroundChecker(currentVersion: string): void {
  // Background script: check npm for latest version, record result
  // Does NOT install — just checks and records. User runs `spaghetti update` to install.
  const script = `
    const { execSync } = require('child_process');
    const fs = require('fs');

    const UPDATE_FILE = ${JSON.stringify(UPDATE_FILE)};
    const SPAGHETTI_DIR = ${JSON.stringify(SPAGHETTI_DIR)};
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
      const latest = execSync('npm view ${NPM_PACKAGE} version', {
        timeout: 15000, encoding: 'utf-8'
      }).trim();

      const data = {
        lastCheck: Date.now(),
        latestVersion: latest,
        currentVersionAtCheck: CURRENT,
        updateAvailable: latest && isNewer(latest, CURRENT),
        updateApplied: false,
        appliedVersion: null,
      };

      if (!fs.existsSync(SPAGHETTI_DIR)) fs.mkdirSync(SPAGHETTI_DIR, { recursive: true });
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
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL UPDATE COMMAND (`spaghetti update`)
// ═══════════════════════════════════════════════════════════════════════════

export async function updateCommand(): Promise<void> {
  const currentVersion = getVersion();

  console.log('');
  console.log(`  ${pc.bold('Spaghetti Update')}`);
  console.log('');
  console.log(`  Current version: ${pc.dim(`v${currentVersion}`)}`);
  console.log(`  Checking for updates...`);

  // Check npm registry for latest version
  let latestVersion: string;
  try {
    latestVersion = execSync(`npm view ${NPM_PACKAGE} version`, {
      timeout: 15000,
      encoding: 'utf-8',
    }).trim();
  } catch {
    console.log(`  ${pc.red('✖')} Failed to check for updates. Check your internet connection.`);
    process.exit(1);
  }

  console.log(`  Latest version:  ${pc.bold(`v${latestVersion}`)}`);
  console.log('');

  if (!isNewer(latestVersion, currentVersion)) {
    console.log(`  ${pc.green('✔')} Already up to date!`);
    console.log('');

    // Update cache
    writeUpdateData({
      lastCheck: Date.now(),
      latestVersion,
      currentVersionAtCheck: currentVersion,
      updateAvailable: false,
      updateApplied: false,
      appliedVersion: null,
    });
    return;
  }

  // Show what's changing
  console.log(`  Updating ${pc.dim(`v${currentVersion}`)} → ${pc.bold(pc.green(`v${latestVersion}`))}`);
  console.log('');

  // Install with visible output (like truffle's progress bar)
  try {
    console.log(pc.dim('  Installing...'));
    console.log('');
    execSync(`npm install -g ${NPM_PACKAGE}@latest`, {
      timeout: 120000,
      stdio: 'inherit',
    });
    console.log('');
    console.log(`  ${pc.green('✔')} Updated to ${pc.bold(`v${latestVersion}`)}`);
    console.log(pc.dim('  Restart your terminal to use the new version.'));
    console.log('');

    // Update cache
    writeUpdateData({
      lastCheck: Date.now(),
      latestVersion,
      currentVersionAtCheck: currentVersion,
      updateAvailable: false,
      updateApplied: true,
      appliedVersion: latestVersion,
    });
  } catch {
    console.log('');
    console.log(`  ${pc.red('✖')} Update failed.`);
    console.log('');
    console.log(`  Try manually: ${pc.cyan(`npm install -g ${NPM_PACKAGE}@latest`)}`);
    console.log('');
    process.exit(1);
  }
}
