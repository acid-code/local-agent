// node --test apps/desktop/test  (no Electron needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { reduce, initialStatus, canCheck, friendlyError, FEED_URL } = require('../update-state');
const config = require('../electron-builder.cjs');
const pkg = require('../package.json');

// electron-builder's NSIS GUID: UUID v5 of appId in its namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3.
function nsisGuid(appId) {
  const ns = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const h = crypto.createHash('sha1').update(ns).update(appId).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

test('installer keeps the identity of the installed app so it upgrades in place', () => {
  assert.equal(config.appId, 'com.localagent.desktop');
  // The uninstall key on Asaf's laptop (local-agent 0.2.187) is this GUID.
  assert.equal(nsisGuid(config.appId), 'b98c26f9-ab8f-597c-9238-bc16369cb8fb');
  assert.equal(pkg.name, 'local-agent-desktop');
  assert.equal(config.productName, 'local-agent');
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.oneClick, true);
  assert.notEqual(config.nsis.deleteAppDataOnUninstall, true);
});

test('build writes latest.yml for the same feed the app reads, with versioned file names', () => {
  assert.deepEqual(config.publish, [{ provider: 'generic', url: FEED_URL }]);
  assert.match(config.nsis.artifactName, /\$\{version\}-setup\.\$\{ext\}$/);
  assert.match(config.portable.artifactName, /\$\{version\}-portable\.\$\{ext\}$/);
  assert.ok(config.files.includes('update-state.js'));
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater must be a runtime dependency');
});

test('version always increases on CI', () => {
  const old = process.env.GITHUB_RUN_NUMBER;
  process.env.GITHUB_RUN_NUMBER = '88';
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const fresh = require('../electron-builder.cjs');
  if (old === undefined) delete process.env.GITHUB_RUN_NUMBER; else process.env.GITHUB_RUN_NUMBER = old;
  assert.equal(fresh.extraMetadata.version, '0.2.188');
  const [a, b, c] = fresh.extraMetadata.version.split('.').map(Number);
  assert.ok(a === 0 && b === 2 && c > 187, 'must be newer than the installed 0.2.187');
});

test('status: check → up to date', () => {
  let s = initialStatus('0.2.190', { packaged: true, portable: false });
  assert.equal(s.state, 'idle');
  s = reduce(s, 'checking-for-update');
  assert.equal(s.state, 'checking');
  assert.equal(canCheck(s), false);
  s = reduce(s, 'update-not-available', { version: '0.2.190' });
  assert.equal(s.state, 'up-to-date');
  assert.equal(canCheck(s), true);
});

test('status: installer build downloads with progress, then is ready to install', () => {
  let s = initialStatus('0.2.190', { packaged: true, portable: false });
  s = reduce(s, 'update-available', { version: '0.2.191' });
  assert.deepEqual([s.state, s.version, s.percent], ['downloading', '0.2.191', 0]);
  s = reduce(s, 'download-progress', { percent: 42.6 });
  assert.equal(s.percent, 43);
  s = reduce(s, 'update-downloaded', { version: '0.2.191' });
  assert.equal(s.state, 'downloaded');
  // A later background check or error must not hide the ready update.
  assert.equal(reduce(s, 'checking-for-update').state, 'downloaded');
  assert.equal(reduce(s, 'error', { message: 'net::ERR_INTERNET_DISCONNECTED' }).state, 'downloaded');
});

test('status: portable only reports the new version', () => {
  let s = initialStatus('0.2.190', { packaged: true, portable: true });
  s = reduce(s, 'update-available', { version: '0.2.191' });
  assert.equal(s.state, 'portable-available');
  assert.equal(s.percent, undefined);
});

test('status: development builds and readable errors', () => {
  assert.equal(initialStatus('0.2.1', { packaged: false }).state, 'development');
  assert.match(friendlyError('HttpError: 404 Not Found "method: GET url: https://github.com/x/releases/latest/download/latest.yml"'), /latest\.yml/);
  assert.match(friendlyError('net::ERR_NAME_NOT_RESOLVED'), /reach GitHub/);
});
