/**
 * Electron main entrypoint.
 *
 * - Creates a single BrowserWindow with context isolation + preload.
 * - Initializes the SpaghettiService (parses ~/.claude into SQLite).
 * - Registers IPC handlers and forwards SDK lifecycle events.
 * - Cleans up on quit.
 */

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IngestEngine } from '@vibecook/spaghetti-sdk';
import { registerIpcHandlers, wireEventForwarding } from './ipc-handlers.js';
import { resolveAppEngine } from './settings.js';
import { shutdownSdk } from './sdk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the SQLite index path inside Electron's per-app `userData` folder,
 * following the platform's conventions (macOS: `~/Library/Application
 * Support/<app>`, Windows: `%APPDATA%/<app>`, Linux: `~/.config/<app>`).
 *
 * The filename includes the active ingest engine (rs|ts) so switching
 * engines does not force a re-ingest. The engine itself is read once from
 * the app's own settings file and threaded through both the DB path and
 * the SpaghettiService options; we deliberately do not call the SDK's
 * `resolveEngine()` here so the user's shell / CLI config cannot leak
 * into the desktop app.
 */
function resolvePlaygroundDbPath(engine: IngestEngine): string {
  return join(app.getPath('userData'), 'cache', `spaghetti-${engine}.db`);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Open external links in the default browser rather than a new BrowserWindow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Dev vs. production: electron-vite injects ELECTRON_RENDERER_URL when
  // running `electron-vite dev`.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

void app.whenReady().then(async () => {
  // Resolve engine once from app-scoped settings; use it for both the DB
  // filename and the explicit `engine` option on the SDK so nothing in
  // the pipeline falls back to the SDK's global resolution chain.
  const engine = resolveAppEngine();
  const dbPath = resolvePlaygroundDbPath(engine);
  registerIpcHandlers();

  // Fire-and-forget: the renderer subscribes to progress/ready events on
  // load, so there's no reason to block window creation on SDK init.
  void wireEventForwarding({ dbPath, engine }).catch((err) => {
    console.error('[main] SDK initialization failed', err);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  shutdownSdk();
});
