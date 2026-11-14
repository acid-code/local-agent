const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
// Downloads (Save in the file viewer) ask where to put the file with the native save dialog.
const fs = require('fs');
const path = require('path');

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
    autoHideMenuBar: false,
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
        { role: 'toggleDevTools' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  return win;
}

ipcMain.handle('get-url', () => readUrl());

// The web app reports its theme background so the window opens in the right colour next time.
ipcMain.handle('set-background', (event, value) => {
  const color = String(value || '');
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false };
  if (color !== readConfig().background) writeConfig({ background: color });
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setBackgroundColor(color);
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
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
