#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${VIDEO_DEDUPE_ORIGINAL:-/Users/luke/Desktop/Playground}"
OUT="$ROOT/dist"
APP="$OUT/视频去重.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin"
cp -R "$ROOT/Resources/" "$APP/Contents/Resources/"
NODE="${NODE_BIN:-$(command -v node)}"
FFMPEG="${FFMPEG_BIN:-$SOURCE/node_modules/ffmpeg-static/ffmpeg}"
FFPROBE="${FFPROBE_BIN:-$SOURCE/node_modules/@ffprobe-installer/darwin-arm64/ffprobe}"
# Thin the universal Node runtime to match this Apple Silicon build.
lipo "$NODE" -thin arm64 -output "$APP/Contents/Resources/bin/node" 2>/dev/null || cp "$NODE" "$APP/Contents/Resources/bin/node"
cp "$FFMPEG" "$APP/Contents/Resources/bin/ffmpeg"
cp "$FFPROBE" "$APP/Contents/Resources/bin/ffprobe"
chmod +x "$APP/Contents/Resources/bin/"*
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
swift "$ROOT/scripts/make-icon.swift" "$OUT/icon.png"
for SIZE in 16 32 128 256 512; do
 sips -z "$SIZE" "$SIZE" "$OUT/icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
 DOUBLE=$((SIZE * 2))
 sips -z "$DOUBLE" "$DOUBLE" "$OUT/icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
swiftc -O -parse-as-library -target arm64-apple-macosx13.5 -framework Cocoa -framework WebKit "$ROOT/Sources/App.swift" -o "$APP/Contents/MacOS/VideoDedupe"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleExecutable</key><string>VideoDedupe</string>
<key>CFBundleIdentifier</key><string>com.snkwz.video-dedupe</string>
<key>CFBundleName</key><string>视频去重</string>
<key>CFBundleDisplayName</key><string>视频去重</string>
<key>CFBundleVersion</key><string>16</string>
<key>CFBundleShortVersionString</key><string>1.0.15</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>视频去重 Mac 桌面版</string>
</dict></plist>
PLIST
for BIN in node ffmpeg ffprobe; do codesign --force --sign - "$APP/Contents/Resources/bin/$BIN"; done
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "$APP"
