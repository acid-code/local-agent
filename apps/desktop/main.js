const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const SETUP = path.join(__dirname, 'setup.html');

function configPath() {
  return path.join(app.getPath('userData'), 'server.json');
}

function readUrl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return validUrl(parsed && parsed.url) || '';
  } catch {
    return '';
  }
}

function writeUrl(url) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ url }, null, 2));
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
    backgroundColor: '#090a0c',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      win.loadURL(url);
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
  ]);
  Menu.setApplicationMenu(menu);
  return win;
}

ipcMain.handle('get-url', () => readUrl());

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
