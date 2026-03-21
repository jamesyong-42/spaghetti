/**
 * Service initialization — create SpaghettiAPI with optional progress spinner
 */

import { createSpaghettiService } from '@spaghetti/core';
import type { SpaghettiAPI } from '@spaghetti/core';
import { createSpinner } from 'nanospinner';
import { isTTY } from './terminal.js';

let _service: SpaghettiAPI | null = null;

export interface InitOptions {
  silent?: boolean;
  claudeDir?: string;
  dbPath?: string;
}

export async function initService(opts?: InitOptions): Promise<SpaghettiAPI> {
  const service = createSpaghettiService({
    claudeDir: opts?.claudeDir,
    dbPath: opts?.dbPath,
  });

  _service = service;

  const showSpinner = !opts?.silent && isTTY();
  const spinner = showSpinner ? createSpinner('Initializing...', { stream: process.stderr }) : null;
  spinner?.start();

  const unsub = service.onProgress((progress) => {
    if (spinner) {
      const pct = progress.total
        ? ` (${progress.current ?? 0}/${progress.total})`
        : '';
      spinner.update({ text: `${progress.message}${pct}` });
    }
  });

  try {
    await service.initialize();
  } catch (err) {
    spinner?.error({ text: 'Initialization failed' });
    unsub();
    throw err;
  }

  spinner?.success({ text: 'Ready' });
  unsub();

  return service;
}

export function shutdownService(): void {
  if (_service) {
    _service.shutdown();
    _service = null;
  }
}
