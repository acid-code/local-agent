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
    const req = net.request({ url, headers: { 'User-Agent': 'local-agent-desktop', Accept: 'application/vnd.github+json' } });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.end();
  });
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', headers: { 'User-Agent': 'local-agent-desktop' } });
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(file);
      const hash = crypto.createHash('sha256');
      res.on('data', (chunk) => { hash.update(chunk); out.write(chunk); });
      res.on('end', () => out.end(() => resolve(hash.digest('hex'))));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Newer means: a different commit than this build, published after this build was made. */
function isNewer(release) {
  const sha = String(release.tag_name || '').replace(/^main-/, '');
  if (!sha || (meta.buildCommit && meta.buildCommit.startsWith(sha))) return false;
  return !meta.buildTime || Date.parse(release.published_at) > Date.parse(meta.buildTime) + 60_000;
}

async function check(win) {
  if (!app.isPackaged) return;
  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!isNewer(release) || offered === release.tag_name) return;
  if (PORTABLE) {
    offered = release.tag_name;
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, message: 'New version available', detail: `${release.name || release.tag_name} is out. You are on ${app.getVersion()}. Download the new portable exe to update.` });
    if (response === 0) void shell.openExternal(release.html_url);
    return;
  }
  const asset = (release.assets || []).find((item) => /-setup\.exe$/i.test(item.name));
  if (!asset) return;
  const file = path.join(os.tmpdir(), asset.name);
  const sha256 = await download(asset.browser_download_url, file);
  const expected = String(asset.digest || '').replace(/^sha256:/, '');
  if (expected && expected !== sha256) { fs.rmSync(file, { force: true }); throw new Error('Downloaded update failed its checksum.'); }
  offered = release.tag_name;
  const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart to install', 'Later'], defaultId: 0, cancelId: 1, message: 'Update available, restart to install', detail: `${release.name || release.tag_name} is ready. You are on ${app.getVersion()}.` });
  if (response !== 0) return;
  // Delay 2s via cmd.exe so Electron fully exits and releases file locks before NSIS /S runs.
  // Use app.exit(0) instead of app.quit() so a minimize-to-tray handler cannot keep the process alive.
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', `ping -n 3 127.0.0.1 >nul & start "" "${file}" /S --force-run`], {
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
  setInterval(run, 6 * 3_600_000);
}

module.exports = { startUpdates, isNewer };
