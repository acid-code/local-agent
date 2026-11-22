// In-app updates with electron-updater. The installer build (NSIS) checks
// https://github.com/acid-code/local-agent/releases/latest/download/latest.yml on start and every 30 minutes,
// downloads a newer setup.exe in the background (SHA-512 from latest.yml is checked), then offers
// "Restart to install". Installing closes the app, upgrades in place (same appId, data in %APPDATA% is kept)
// and starts it again. The portable exe cannot replace itself: it only reports the new version and links to it.
const { app, BrowserWindow, dialog, shell } = require('electron');
const { RELEASES_URL, FEED_URL, initialStatus, reduce, canCheck } = require('./update-state');

const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
let status = initialStatus(app.getVersion(), { packaged: app.isPackaged, portable: PORTABLE });
let updater = null;
let prompted = '';

function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update-status', status);
  }
}

function apply(event, payload) {
  status = reduce(status, event, payload);
  broadcast();
}

function getUpdater() {
  if (updater || !app.isPackaged) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
  autoUpdater.autoDownload = !PORTABLE;
  autoUpdater.autoInstallOnAppQuit = !PORTABLE;
  // Old installers are not in the latest release, so a differential download would only 404 first.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = { info: (m) => console.log('[update]', m), warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug: () => {} };
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded']) {
    autoUpdater.on(event, (payload) => apply(event, payload || {}));
  }
  autoUpdater.on('error', (error) => apply('error', { message: error && error.message }));
  autoUpdater.on('update-downloaded', (info) => { void offerRestart(info && info.version); });
  updater = autoUpdater;
  return updater;
}

async function offerRestart(version) {
  if (!version || prompted === version) return;
  prompted = version;
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart to install', 'Later'], defaultId: 0, cancelId: 1, message: 'Update ready', detail: `local-agent ${version} is downloaded. You are on ${app.getVersion()}. It also installs the next time you quit.` });
  if (response === 0) install();
}

/** Checks now. Resolves with the status once the check (not the download) finishes; never throws. */
async function check() {
  const u = getUpdater();
  if (!u) { broadcast(); return status; }
  if (!canCheck(status)) return status;
  try { await u.checkForUpdates(); } catch (error) { apply('error', { message: error && error.message }); }
  return status;
}

function install() {
  if (status.state !== 'downloaded' || !updater) return false;
  // isSilent=true, isForceRunAfter=true: the NSIS installer closes this app, upgrades in place and reopens it.
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

function openReleasePage() { void shell.openExternal(RELEASES_URL); }

function startUpdates() {
  if (!app.isPackaged) return;
  setTimeout(() => { void check(); }, 10_000);
  setInterval(() => { void check(); }, 30 * 60_000);
}

/** Menu item: check, then say what happened in a dialog. */
async function checkUpdatesInteractive(win) {
  const result = await check();
  const opts = { type: 'info', buttons: ['OK'] };
  if (result.state === 'development') return dialog.showMessageBox(win, { ...opts, message: 'Updates are checked in packaged builds', detail: 'Run the installer to receive updates.' });
  if (result.state === 'up-to-date') return dialog.showMessageBox(win, { ...opts, message: 'You are up to date', detail: `local-agent ${app.getVersion()} is the newest version.` });
  if (result.state === 'downloading') return dialog.showMessageBox(win, { ...opts, message: 'Downloading update', detail: `local-agent ${result.version} is downloading (${result.percent || 0}%). You will be asked to restart when it is ready.` });
  if (result.state === 'downloaded') return offerRestart(result.version) ;
  if (result.state === 'portable-available') {
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, message: 'New version available', detail: `local-agent ${result.version} is out. You are on ${app.getVersion()}. The portable exe cannot update itself: download the new one, or use the installer to get automatic updates.` });
    if (response === 0) openReleasePage();
    return undefined;
  }
  if (result.state === 'error') return dialog.showMessageBox(win, { type: 'warning', buttons: ['OK'], message: 'Update check failed', detail: result.error || 'Unknown error.' });
  return undefined;
}

function getStatus() { return status; }

module.exports = { startUpdates, check, checkUpdatesInteractive, install, openReleasePage, getStatus };
