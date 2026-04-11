#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitDir = resolve(rootDir, '.git');
const hooksPath = '.githooks';

if (!existsSync(gitDir)) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', '--local', 'core.hooksPath', hooksPath], {
    cwd: rootDir,
    stdio: 'ignore',
  });
} catch (error) {
  process.stderr.write(
    `[spaghetti] failed to configure git hooks path to ${hooksPath}: ${String(error)}\n`,
  );
  process.exitCode = 0;
}
