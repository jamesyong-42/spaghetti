/**
 * Plugin command — install/uninstall/status of the spaghetti-hooks Claude Code plugin
 *
 * Uses Claude Code's official plugin system: marketplace registration from a GitHub repo.
 * The repo root has .claude-plugin/marketplace.json that lists the plugin.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { theme } from '../lib/color.js';

const MARKETPLACE_NAME = 'spaghetti';
const PLUGIN_NAME = 'spaghetti-hooks';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const REPO = 'jamesyong-42/spaghetti';

const CLAUDE_DIR = join(homedir(), '.claude');
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
const INSTALLED_PLUGINS_PATH = join(PLUGINS_DIR, 'installed_plugins.json');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export async function pluginCommand(action: string): Promise<void> {
  switch (action) {
    case 'install':
      return installPlugin();
    case 'uninstall':
      return uninstallPlugin();
    case 'status':
      return pluginStatus();
    default:
      process.stderr.write(
        theme.error(`Unknown plugin action: "${action}"\n`) + theme.muted('Available: install, uninstall, status\n'),
      );
      process.exit(1);
  }
}

function installPlugin(): void {
  // Check if already installed
  const installed = readJson(INSTALLED_PLUGINS_PATH) as { plugins?: Record<string, unknown[]> };
  if (installed.plugins?.[PLUGIN_ID]?.length) {
    const settings = readJson(SETTINGS_PATH) as { enabledPlugins?: Record<string, boolean> };
    const enabled = settings.enabledPlugins?.[PLUGIN_ID] === true;
    if (enabled) {
      process.stderr.write(theme.success('\nPlugin is already installed and enabled.\n\n'));
      return;
    }
  }

  // Try to install via claude CLI
  process.stderr.write('\n');
  process.stderr.write(`  ${theme.heading('Installing spaghetti-hooks plugin...')}\n\n`);

  try {
    execSync(`claude plugins add ${PLUGIN_NAME} --marketplace github.com/${REPO}`, {
      stdio: 'inherit',
    });
    process.stderr.write('\n');
    process.stderr.write(theme.success('  Plugin installed! Restart Claude Code to activate.\n\n'));
  } catch {
    // claude CLI not available or failed — show manual instructions
    process.stderr.write('\n');
    process.stderr.write(theme.warning('  Could not run `claude plugins add` automatically.\n'));
    process.stderr.write(theme.muted('  Install manually by running:\n\n'));
    process.stderr.write(`  ${theme.accent(`claude plugins add ${PLUGIN_NAME} --marketplace github.com/${REPO}`)}\n\n`);
  }
}

function uninstallPlugin(): void {
  try {
    execSync(`claude plugins remove ${PLUGIN_NAME}@${MARKETPLACE_NAME}`, {
      stdio: 'inherit',
    });
    process.stderr.write(theme.success('\nPlugin uninstalled. Restart Claude Code to take effect.\n\n'));
  } catch {
    process.stderr.write('\n');
    process.stderr.write(theme.warning('  Could not run `claude plugins remove` automatically.\n'));
    process.stderr.write(theme.muted('  Uninstall manually by running:\n\n'));
    process.stderr.write(`  ${theme.accent(`claude plugins remove ${PLUGIN_ID}`)}\n\n`);
  }
}

function pluginStatus(): void {
  process.stderr.write('\n');
  process.stderr.write(`  ${theme.heading('Spaghetti Hooks Plugin')}\n\n`);

  // Check installed_plugins.json
  const installed = readJson(INSTALLED_PLUGINS_PATH) as { plugins?: Record<string, unknown[]> };
  const entry = installed.plugins?.[PLUGIN_ID];

  if (!entry || entry.length === 0) {
    process.stderr.write(`  ${theme.muted('Status:')}   ${theme.error('Not installed')}\n`);
    process.stderr.write(`  ${theme.muted('Install:')}  spag plugin install\n`);
    process.stderr.write('\n');
    return;
  }

  const installInfo = entry[0] as { installPath?: string; version?: string };
  const installPath = installInfo?.installPath || '(unknown)';
  const pathExists = installPath !== '(unknown)' && existsSync(installPath);

  // Check settings.json
  const settings = readJson(SETTINGS_PATH) as { enabledPlugins?: Record<string, boolean> };
  const enabled = settings.enabledPlugins?.[PLUGIN_ID] === true;

  if (pathExists && enabled) {
    process.stderr.write(`  ${theme.muted('Status:')}   ${theme.success('Installed & enabled')}\n`);
  } else if (pathExists && !enabled) {
    process.stderr.write(`  ${theme.muted('Status:')}   ${theme.warning('Installed but disabled')}\n`);
  } else {
    process.stderr.write(`  ${theme.muted('Status:')}   ${theme.warning('Registered but path missing')}\n`);
  }

  process.stderr.write(`  ${theme.muted('Plugin:')}   ${PLUGIN_ID}\n`);
  process.stderr.write(`  ${theme.muted('Path:')}     ${installPath}\n`);
  process.stderr.write(`  ${theme.muted('Version:')}  ${installInfo?.version || 'unknown'}\n`);
  process.stderr.write(`  ${theme.muted('Enabled:')}  ${enabled ? 'yes' : 'no'}\n`);
  process.stderr.write('\n');
}
