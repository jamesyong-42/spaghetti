import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({ rollupTypes: true }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        'better-sqlite3',
        'chokidar',
        'events',
        'fs',
        'fs/promises',
        'path',
        'os',
        'crypto',
        'ws',
        'node:os',
        'node:path',
        'node:fs',
        'node:crypto',
        'node:worker_threads',
      ],
    },
  },
});
