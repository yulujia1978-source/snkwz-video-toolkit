#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/视频去重.app"
codesign --verify --deep --strict "$APP"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
cp "$ROOT/README.md" "$STAGE/使用说明.md"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname '视频去重 Mac' -srcfolder "$STAGE" -ov -format UDZO "$ROOT/dist/视频去重-Mac-1.0.15-arm64.dmg"
