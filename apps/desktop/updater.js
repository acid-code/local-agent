// In-app updates from GitHub Releases (public repo, no token). On start, and every 6 hours, it reads the latest release.
// Installed (NSIS) build: downloads local-agent-<sha>-setup.exe, checks its SHA-256 against GitHub's digest, then offers
// "Update available, restart to install"; restart runs the installer silently and reopens the app.
// Portable build: shows "New version available" with a link to the release page.
const { app, dialog, net, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const meta = (() => { try { return require('./package.json'); } catch { return {}; } })();
const REPO = meta.updateRepo || 'acid-code/local-agent';
const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
let offered = '';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Update request timed out')), 20_000);
    const req = net.request({ url, headers: { 'User-Agent': 'local-agent-desktop', Accept: 'application/vnd.github+json' } });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('GitHub returned invalid release JSON')); }
      });
    });
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Update download timed out')), 120_000);
    const req = net.request({ url, redirect: 'follow', headers: { 'User-Agent': 'local-agent-desktop' } });
    req.on('response', (res) => {
      if (res.statusCode !== 200) { clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(file);
      const hash = crypto.createHash('sha256');
      res.on('data', (chunk) => { hash.update(chunk); out.write(chunk); });
      res.on('end', () => out.end(() => { clearTimeout(timer); resolve(hash.digest('hex')); }));
      res.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

/** Newer means: a different commit than this build, published after this build was made. */
function isNewer(release) {
  const tag = String(release.tag_name || '');
  const sha = tag.replace(/^main-/, '');
  if (sha !== tag && meta.buildCommit && sha.length >= 7 && meta.buildCommit.toLowerCase().startsWith(sha.toLowerCase())) return false;
  if (!sha) return false;
  if (!meta.buildTime) return false;
  const published = Date.parse(release.published_at || '');
  const built = Date.parse(meta.buildTime || '');
  return Number.isFinite(published) && Number.isFinite(built) && published > built + 60_000;
}

async function check(win, options = {}) {
  if (!app.isPackaged) {
    if (!options.silent) dialog.showMessageBox(win, { type: 'info', message: 'Updates are checked in packaged builds', detail: 'Run the desktop installer or portable release to receive updates.' });
    return { status: 'development' };
  }
  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!isNewer(release)) {
    if (!options.silent) dialog.showMessageBox(win, { type: 'info', message: 'You are up to date', detail: `local-agent ${app.getVersion()} is the latest build available.` });
    return { status: 'up-to-date', release };
  }
  if (options.silent && offered === release.tag_name) return { status: 'update-offered', release };
  if (PORTABLE) {
    offered = release.tag_name;
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, message: 'New version available', detail: `${release.name || release.tag_name} is out. You are on ${app.getVersion()}. Download the new portable exe to update.` });
    if (response === 0) void shell.openExternal(release.html_url);
    return { status: 'portable', release };
  }
  const asset = (release.assets || []).find((item) => /(?:^|-)setup\.exe$/i.test(item.name) || /-setup\.exe$/i.test(item.name));
  if (!asset) {
    if (!options.silent) dialog.showMessageBox(win, { type: 'warning', message: 'Installer asset is not ready', detail: 'The latest release has not finished publishing the Windows installer. It will retry automatically.' });
    return { status: 'asset-pending', release };
  }
  const file = path.join(os.tmpdir(), `local-agent-${crypto.randomBytes(6).toString('hex')}-${asset.name}`);
  const sha256 = await download(asset.browser_download_url, file);
  const stat = fs.statSync(file);
  if (stat.size < 100_000) { fs.rmSync(file, { force: true }); throw new Error('Downloaded installer is unexpectedly small.'); }
  const expected = String(asset.digest || '').replace(/^sha256:/, '');
  if (expected && expected !== sha256) { fs.rmSync(file, { force: true }); throw new Error('Downloaded update failed its checksum.'); }
  offered = release.tag_name;
  const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart to install', 'Later'], defaultId: 0, cancelId: 1, message: 'Update available, restart to install', detail: `${release.name || release.tag_name} is ready. You are on ${app.getVersion()}.` });
  if (response !== 0) return;
  // Delay 2s via PowerShell so Electron fully exits and releases file locks before NSIS /S runs.
  // Use app.exit(0) instead of app.quit() so a minimize-to-tray handler cannot keep the process alive.
  if (process.platform === 'win32') {
    const psFile = file.replace(/'/g, "''");
    spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      `Start-Sleep -Seconds 2; Start-Process -FilePath '${psFile}' -ArgumentList '/S'`,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } else {
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  }
  app.exit(0);
}

function startUpdates(win) {
  const run = () => check(win).catch((error) => console.warn('update check failed:', error.message));
  setTimeout(run, 10_000);
  setInterval(run, 30 * 60_000);
}

function checkUpdates(win) {
  return check(win, { silent: false });
}

module.exports = { startUpdates, checkUpdates, isNewer };
