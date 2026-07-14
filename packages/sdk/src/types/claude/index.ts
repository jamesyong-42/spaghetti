/**
 * Claude Code on-disk data shapes (~/.claude/…).
 * Product-owned; prefer importing from here in Claude parsers/live.
 * Public SDK still re-exports via types/index.ts.
 */

export * from './projects.js';
export * from './tasks.js';
export * from './todos.js';
export * from './debug.js';
export * from './session-env.js';
export * from './file-history-data.js';
export * from './plans-data.js';
export * from './shell-snapshots-data.js';
export * from './paste-cache-data.js';
export * from './plugins-data.js';
export * from './telemetry-data.js';
export * from './statsig-data.js';
export * from './ide-data.js';
export * from './cache-data.js';
export * from './toplevel-files-data.js';
export * from './teams-data.js';
export * from './backups-data.js';
