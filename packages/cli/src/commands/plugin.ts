/**
 * Plugin command — install/uninstall/status of spaghetti's Claude Code plugins.
 *
 * Uses Claude Code's official plugin system: marketplace registration from a
 * GitHub repo. The repo root has .claude-plugin/marketplace.json that lists
 * every plugin shipped by this marketplace. Currently:
 *   - spaghetti-hooks    (hook-event capture)
 *   - spaghetti-channel  (WebSocket chat bridge MCP server)
 */

import { execSync } from 'node:child_process';
import { theme } from '../lib/color.js';
import {
  MARKETPLACE_NAME,
  PLUGINS,
  REPO,
  getPluginState,
  pluginId,
  type PluginMeta,
  type PluginState,
} from '../lib/plugins.js';

export async function pluginCommand(action: string, target?: string): Promise<void> {
  const selection = resolveSelection(target);

  switch (action) {
    case 'install':
      return installPlugins(selection);
    case 'uninstall':
      return uninstallPlugins(selection);
    case 'status':
      return showStatus(selection);
    default:
      process.stderr.write(
        theme.error(`Unknown plugin action: "${action}"\n`) +
          theme.muted('Available: install, uninstall, status\n'),
      );
      process.exit(1);
  }
}

function resolveSelection(target: string | undefined): PluginMeta[] {
  if (!target) return [...PLUGINS];
  const match = PLUGINS.find(
    (p) => p.name === target || p.name === `spaghetti-${target}`,
  );
  if (!match) {
    process.stderr.write(
      theme.error(`Unknown plugin: "${target}"\n`) +
        theme.muted(`Known: ${PLUGINS.map((p) => p.name).join(', ')}\n`),
    );
    process.exit(1);
  }
  return [match];
}

// ─── install ─────────────────────────────────────────────────────────────

function installPlugins(plugins: PluginMeta[]): void {
  // Skip plugins that are already fully installed & enabled.
  const pending: PluginMeta[] = [];
  process.stderr.write('\n');
  for (const p of plugins) {
    const state = getPluginState(p.name);
    if (state.installed && state.enabled && state.pathExists) {
      process.stderr.write(
        `  ${theme.success('✓')} ${theme.accent(p.name)} ${theme.muted('already installed & enabled')}\n`,
      );
      continue;
    }
    pending.push(p);
  }

  if (pending.length === 0) {
    process.stderr.write('\n' + theme.success('  All spaghetti plugins are installed.') + '\n\n');
    return;
  }

  process.stderr.write('\n');
  process.stderr.write(`  ${theme.heading('Installing spaghetti plugins...')}\n\n`);

  // Step 1: Register the marketplace (idempotent — safe to re-add).
  try {
    process.stderr.write(`  ${theme.muted('Adding marketplace...')}\n`);
    execSync(`claude plugin marketplace add ${REPO}`, { stdio: 'inherit' });
  } catch {
    printManualInstall(pending);
    return;
  }

  // Step 2: Install each pending plugin.
  for (const p of pending) {
    process.stderr.write(`  ${theme.muted(`Installing ${p.name}...`)}\n`);
    try {
      execSync(`claude plugin install ${pluginId(p.name)}`, { stdio: 'inherit' });
    } catch {
      printManualInstall(pending);
      return;
    }
  }

  process.stderr.write('\n');
  process.stderr.write(
    theme.success('  Plugins installed. Restart Claude Code to activate.') + '\n\n',
  );
}

// ─── uninstall ───────────────────────────────────────────────────────────

function uninstallPlugins(plugins: PluginMeta[]): void {
  process.stderr.write('\n');
  let touched = false;
  for (const p of plugins) {
    const state = getPluginState(p.name);
    if (!state.installed) {
      process.stderr.write(`  ${theme.muted('•')} ${p.name} ${theme.muted('not installed')}\n`);
      continue;
    }
    touched = true;
    try {
      execSync(`claude plugin uninstall ${state.id}`, { stdio: 'inherit' });
    } catch {
      process.stderr.write(
        '\n' +
          theme.warning('  Could not uninstall automatically. Run manually:\n') +
          `  ${theme.accent(`claude plugin uninstall ${state.id}`)}\n\n`,
      );
      return;
    }
  }

  if (touched) {
    process.stderr.write(
      '\n' + theme.success('  Uninstall complete. Restart Claude Code to take effect.') + '\n\n',
    );
  } else {
    process.stderr.write('\n');
  }
}

// ─── status ──────────────────────────────────────────────────────────────

function showStatus(plugins: PluginMeta[]): void {
  process.stderr.write('\n');
  process.stderr.write(
    `  ${theme.heading('Spaghetti Plugins')}  ${theme.muted(`(${MARKETPLACE_NAME} marketplace)`)}\n\n`,
  );

  for (const p of plugins) {
    const state = getPluginState(p.name);
    const label = statusLabel(state);
    const version = state.version ? `v${state.version}` : '—';
    process.stderr.write(
      `  ${theme.accent(p.name.padEnd(18))}  ${label}  ${theme.muted(version)}\n`,
    );
    process.stderr.write(`  ${' '.repeat(18)}  ${theme.muted(p.description)}\n`);
    if (state.installPath) {
      process.stderr.write(`  ${' '.repeat(18)}  ${theme.muted(state.installPath)}\n`);
    }
    process.stderr.write('\n');
  }
}

function statusLabel(state: PluginState): string {
  if (!state.installed) return theme.error('not installed');
  if (!state.pathExists) return theme.warning('registered (path missing)');
  if (!state.enabled) return theme.warning('installed (disabled)');
  return theme.success('installed & enabled');
}

// ─── shared ──────────────────────────────────────────────────────────────

function printManualInstall(plugins: PluginMeta[]): void {
  process.stderr.write('\n');
  process.stderr.write(theme.warning('  Could not install automatically.\n'));
  process.stderr.write(theme.muted('  Install manually by running:\n\n'));
  process.stderr.write(`  ${theme.accent(`claude plugin marketplace add ${REPO}`)}\n`);
  for (const p of plugins) {
    process.stderr.write(`  ${theme.accent(`claude plugin install ${pluginId(p.name)}`)}\n`);
  }
  process.stderr.write('\n');
}
