import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3', 'chokidar'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
