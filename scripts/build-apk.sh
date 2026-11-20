#!/usr/bin/env bash
# Build a consistently signed release APK using a persistent keystore on this host.
# Once installed on your phone, every future APK built with this script updates in-place
# without uninstalling or losing your server URL / login session.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYDIR="${ANDROID_KEYSTORE_DIR:-$HOME/.local/share/local-agent}"
KEYSTORE="$KEYDIR/android-release.keystore"
PASS="${ANDROID_KEYSTORE_PASSWORD:-localagent-release}"
ALIAS="${ANDROID_KEY_ALIAS:-localagent}"
OUT="$REPO_ROOT/apps/mobile/local-agent.apk"

mkdir -p "$KEYDIR"
if [[ ! -f "$KEYSTORE" ]]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$KEYDIR:/keys" ghcr.io/cirruslabs/android-sdk:35 \
    keytool -genkeypair -keystore /keys/android-release.keystore \
    -storepass "$PASS" -alias "$ALIAS" -keypass "$PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=local-agent, O=LocalAgent, C=IL"
  chmod 600 "$KEYSTORE"
fi

docker run --rm \
  -v "$REPO_ROOT/apps/mobile/android:/project" \
  -v "$KEYDIR:/keys:ro" \
  -v local-agent-gradle-cache:/root/.gradle \
  -e ANDROID_KEYSTORE_PATH=/keys/android-release.keystore \
  -e ANDROID_KEYSTORE_PASSWORD="$PASS" \
  -e ANDROID_KEY_ALIAS="$ALIAS" \
  -e ANDROID_KEY_PASSWORD="$PASS" \
  -w /project \
  ghcr.io/cirruslabs/android-sdk:35 \
  bash -c "chmod +x ./gradlew && ./gradlew assembleRelease --no-daemon"

BUILT="$(find "$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/release" -name '*-release*.apk' -print -quit)"
cp -f "$BUILT" "$OUT"
echo "Signed APK ready: $OUT"
