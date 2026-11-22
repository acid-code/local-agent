// electron-builder loads electron-builder.cjs (not .js: Windows would run a .js named like the command) from the project dir (it wins over package.json "build"). The version is derived on every build so it always increases:
// 0.2.<GitHub run number + 100> on CI, 0.2.<commit count> locally. The commit and build time go into the packaged
// package.json so the in-app updater can tell whether the latest GitHub release is newer.
const { execSync } = require('child_process');

function buildNumber() {
  if (process.env.GITHUB_RUN_NUMBER) return Number(process.env.GITHUB_RUN_NUMBER) + 100;
  try { return Number(execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim()); } catch { return 1; }
}
function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return ''; }
}

module.exports = {
  appId: 'com.localagent.desktop',
  productName: 'local-agent',
  directories: { output: 'release' },
  files: ['main.js', 'preload.js', 'updater.js', 'update-state.js', 'setup.html', 'package.json'],
  extraMetadata: { version: `0.2.${buildNumber()}`, buildCommit: commit(), buildTime: new Date().toISOString(), updateRepo: 'acid-code/local-agent' },
  // Unsigned (no code-signing certificate in the repo secrets). electron-updater only verifies a signature
  // when publisherName is set, so leave it unset until a certificate exists, then set both together.
  win: { signAndEditExecutable: false, target: ['portable', 'nsis'] },
  // Writes latest.yml (version, file name, sha512) next to the installer. The release job uploads it with the
  // installer and its blockmap; electron-updater reads it from .../releases/latest/download/latest.yml.
  publish: [{ provider: 'generic', url: 'https://github.com/acid-code/local-agent/releases/latest/download' }],
  portable: { artifactName: 'local-agent-${version}-portable.${ext}' },
  // Never change appId or the package name: the NSIS uninstall GUID and install folder
  // (%LOCALAPPDATA%\Programs\local-agent-desktop) come from them, and a new one would install side by side.
  // The installer closes a running local-agent, upgrades in place, and keeps %APPDATA% (deleteAppDataOnUninstall: false).
  nsis: { artifactName: 'local-agent-${version}-setup.${ext}', oneClick: true, perMachine: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false, differentialPackage: true },
};
