# App updates

**Versions** always increase: `0.2.<n>` where n is the GitHub run number + 100 on CI (commit count locally).
Android: `versionCode = n`, `versionName = 0.2.n` (apps/mobile/android/app/build.gradle). Windows: electron-builder.js.

**Android** release builds are signed with one fixed key from the repo secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, so a new APK installs over the old one.
The release notes say `release-signed`; `debug-signed` means the secrets are missing. An APK installed before the fixed
key (any build before 0.2.x) must be uninstalled once. Keep a backup of the keystore: losing it means users must
uninstall again.

**Windows**: the app checks the latest GitHub release on start and every 6 hours.
- Setup build: downloads the new `*-setup.exe`, checks its SHA-256 against GitHub's digest, then asks
  "Update available, restart to install"; restart installs silently and reopens the app.
- Portable build: shows "New version available" with a link to the release.

electron-updater with `latest.yml` and the blockmap is not used: publishing those files needs a change to
`.github/workflows/windows.yml`, which the CI token cannot make. The built-in updater (apps/desktop/updater.js) does the
same job from the release assets that are already published.
