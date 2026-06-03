#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-${GITHUB_REF_NAME:-dev}}"
SAFE_VERSION="$(printf '%s' "$VERSION" | tr '/ ' '--')"
BUILD_DIR="$ROOT_DIR/build/macos"
APP_DIR="$BUILD_DIR/team-calendar.app"
STAGE_DIR="$BUILD_DIR/dmg-stage"
DMG_PATH="$BUILD_DIR/team-calendar-$SAFE_VERSION.dmg"

command -v hdiutil >/dev/null 2>&1 || { echo "需要在 macOS 上使用 hdiutil 构建 DMG" >&2; exit 1; }

"$ROOT_DIR/macos/build-mac-app.sh"

rm -rf "$STAGE_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR"
cp -R "$APP_DIR" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

hdiutil create \
  -volname "team-calendar $VERSION" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGE_DIR"
echo "已生成：$DMG_PATH"
