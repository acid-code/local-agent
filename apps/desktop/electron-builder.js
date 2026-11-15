// electron-builder loads electron-builder.js from the project dir (it wins over package.json "build"). The version is derived on every build so it always increases:
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
  files: ['main.js', 'preload.js', 'updater.js', 'setup.html', 'package.json'],
  extraMetadata: { version: `0.2.${buildNumber()}`, buildCommit: commit(), buildTime: new Date().toISOString(), updateRepo: 'acid-code/local-agent' },
  win: { signAndEditExecutable: false, target: ['portable', 'nsis'] },
  portable: { artifactName: 'local-agent-portable.${ext}' },
  nsis: { artifactName: 'local-agent-setup.${ext}', oneClick: true, perMachine: false, allowToChangeInstallationDirectory: false },
};
