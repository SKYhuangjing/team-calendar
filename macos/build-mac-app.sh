#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/macos"
APP_DIR="$BUILD_DIR/Team Calendar.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_RESOURCES_DIR="$RESOURCES_DIR/app"

command -v xcrun >/dev/null 2>&1 || { echo "需要在 macOS 上安装 Xcode Command Line Tools" >&2; exit 1; }

rm -rf "$BUILD_DIR"
mkdir -p "$MACOS_DIR" "$APP_RESOURCES_DIR"

cp "$ROOT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
python3 "$ROOT_DIR/macos/create-app-icon.py"
cp "$BUILD_DIR/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
rsync -a \
  --exclude '.git' \
  --exclude 'build' \
  --exclude 'data/scheduler.sqlite' \
  --exclude '__pycache__' \
  "$ROOT_DIR/" "$APP_RESOURCES_DIR/"

if [[ ! -f "$APP_RESOURCES_DIR/config/initial-data.json" && -f "$APP_RESOURCES_DIR/config/initial-data.json.example" ]]; then
  cp "$APP_RESOURCES_DIR/config/initial-data.json.example" "$APP_RESOURCES_DIR/config/initial-data.json"
fi

xcrun swiftc \
  -O \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -framework Cocoa \
  -framework WebKit \
  "$ROOT_DIR/macos/TeamCalendarClient.swift" \
  -o "$MACOS_DIR/TeamCalendarClient"

chmod +x "$MACOS_DIR/TeamCalendarClient"
echo "已生成：$APP_DIR"
