const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
// Downloads (Save in the file viewer) ask where to put the file with the native save dialog.
const fs = require('fs');
const path = require('path');
const updates = require('./updater');

const SETUP = path.join(__dirname, 'setup.html');

function configPath() {
  return path.join(app.getPath('userData'), 'server.json');
}

// Everything this laptop keeps lives in userData: server.json (server URL and window colour) plus
// Chromium's own cookie jar (the sign-in session) and localStorage (a copy of the theme).
function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readUrl() {
  return validUrl(readConfig().url) || '';
}

function readBackground() {
  const value = readConfig().background;
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#090a0c';
}

// Window controls drawn by the OS over our own header (Windows/Linux); symbols follow the theme.
const TITLEBAR_HEIGHT = 40;
function overlayFor(color) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#090a0c';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
  return { color: hex, symbolColor: light ? '#1f1f1f' : '#e8e8e8', height: TITLEBAR_HEIGHT };
}

function writeConfig(patch) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}

function writeUrl(url) {
  writeConfig({ url });
}

function validUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return trimmed;
  } catch {
    return '';
  }
}

function sameServer(url) {
  const saved = readUrl();
  if (!saved) return false;
  try { return new URL(url).origin === new URL(saved).origin; } catch { return false; }
}

function showSetup(win, message) {
  const query = message ? { error: message } : undefined;
  return win.loadFile(SETUP, query ? { query } : undefined);
}

function openServer(win, url) {
  return win.loadURL(url);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'local-agent',
    backgroundColor: readBackground(),
    // No OS title bar: the app header is the title bar (drag region set by the web app via data-desktop).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: overlayFor(readBackground()) }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links to the console stay in the window. Anything else (search results, citations) opens in the default browser.
  win.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save file', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      // File previews (Open in new tab) get their own window so the console stays put.
      if (sameServer(url) && /\/api\/(files|git)\/[^?]*\/raw/.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 800, autoHideMenuBar: true, backgroundColor: readBackground(), webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
      }
      if (sameServer(url)) win.loadURL(url);
      else void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (url.startsWith('file:')) return;
    showSetup(win, `Could not open ${url} (${description}).`);
  });

  const saved = readUrl();
  if (saved) void openServer(win, saved);
  else void showSetup(win);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Server',
      submenu: [
        {
          label: 'Change server…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => { void showSetup(win); },
        },
        {
          label: 'Open in browser',
          click: () => { const current = readUrl(); if (current) void shell.openExternal(current); },
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const current = readUrl();
            if (current && win.webContents.getURL().startsWith('file:')) void openServer(win, current);
            else win.webContents.reload();
          },
        },
        {
          label: `Check for updates…  (v${app.getVersion()})`,
          click: () => { void updates.checkUpdatesInteractive(win).catch((error) => dialog.showErrorBox('Update check failed', error.message)); },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // Without an Edit menu, Ctrl+C / Ctrl+V / Ctrl+A do nothing in text boxes on Windows.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // F12, so Ctrl+Shift+I stays free for the persona info pane.
        { role: 'toggleDevTools', accelerator: 'F12' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  return win;
}

ipcMain.handle('get-url', () => readUrl());

ipcMain.handle('get-app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  packaged: app.isPackaged,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  platform: process.platform,
}));

// Settings → About & updates. check resolves with the status; progress arrives on 'update-status'.
ipcMain.handle('get-update-status', () => updates.getStatus());
ipcMain.handle('check-for-updates', async () => {
  try { return { ok: true, result: await updates.check() }; } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('install-update', () => ({ ok: updates.install() }));
ipcMain.handle('open-release-page', () => { updates.openReleasePage(); return { ok: true }; });

ipcMain.handle('open-setup', (event, message) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) void showSetup(win, message ? String(message) : undefined);
  return { ok: true };
});

// The web app reports its theme background so the window opens in the right colour next time.
ipcMain.handle('set-background', (event, value) => {
  const color = String(value || '');
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false };
  if (color !== readConfig().background) writeConfig({ background: color });
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setBackgroundColor(color);
    if (process.platform !== 'darwin' && typeof win.setTitleBarOverlay === 'function') { try { win.setTitleBarOverlay(overlayFor(color)); } catch { /* window without an overlay */ } }
  }
  return { ok: true };
});

ipcMain.handle('set-url', (event, value) => {
  const url = validUrl(value);
  if (!url) return { ok: false, error: 'The URL should start with http:// or https://.' };
  writeUrl(url);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) void openServer(win, url);
  return { ok: true, url };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.localagent.desktop');
    createWindow();
    updates.startUpdates();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
