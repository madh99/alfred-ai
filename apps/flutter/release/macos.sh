#!/usr/bin/env bash
# Phase 4 M6 — macOS-Release der Alfred-App als DMG. Läuft auf dem Mac (Xcode, CocoaPods, Flutter im PATH):
# bauen, signieren (Developer ID, wenn ALFRED_MAC_IDENTITY gesetzt), DMG, notarisieren (wenn ALFRED_NOTARY_PROFILE
# gesetzt, ein mit `xcrun notarytool store-credentials` angelegtes Profil), stapeln, Prüfsumme, Upload.
#   release/macos.sh            komplette Kette
#   release/macos.sh --kein-upload
# Ohne Identität entsteht ein ad-hoc signiertes DMG (startet nur auf Macs, die der Signatur vertrauen).
set -euo pipefail
export PATH="$HOME/dev/flutter/bin:$HOME/.gem/ruby/2.6.0/bin:$PATH" LANG=en_US.UTF-8
APP="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${ALFRED_RELEASE_SERVER:-madh@192.168.1.92}"
ZIEL=/root/alfred/data/app-releases/macos
VERSION=$(grep -E '^version:' "$APP/pubspec.yaml" | sed -E 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
[ -n "$VERSION" ] || { echo "version in pubspec.yaml fehlt"; exit 1; }
IDENT="${ALFRED_MAC_IDENTITY:-}"
echo "Alfred $VERSION — macOS-Release (DMG)${IDENT:+, signiert als $IDENT}"

cd "$APP"
flutter build macos --release
BUNDLE="$APP/build/macos/Build/Products/Release/Alfred.app"
[ -d "$BUNDLE" ] || { echo "Alfred.app fehlt"; exit 1; }

if [ -n "$IDENT" ]; then
  codesign --force --deep --options runtime --timestamp --entitlements "$APP/macos/Runner/Release.entitlements" --sign "$IDENT" "$BUNDLE"
  codesign --verify --deep --strict "$BUNDLE" && echo "codesign ok"
fi

STAGE="$APP/build/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$BUNDLE" "$STAGE/Alfred.app"
ln -s /Applications "$STAGE/Applications"
DMG="$APP/build/Alfred-$VERSION.dmg"; rm -f "$DMG"
hdiutil create -volname "Alfred $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
if [ -n "$IDENT" ]; then
  codesign --force --timestamp --sign "$IDENT" "$DMG"
  if [ -n "${ALFRED_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$ALFRED_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG" && echo "notarisiert und gestapelt"
  fi
fi
(cd "$(dirname "$DMG")" && shasum -a 256 "$(basename "$DMG")" > "$DMG.sha256")
echo "$(basename "$DMG")  $(du -h "$DMG" | cut -f1)  sha256 $(cut -c1-16 "$DMG.sha256")…"
[ "${1:-}" = "--kein-upload" ] && exit 0
echo "Upload → $SERVER:$ZIEL"
scp -q "$DMG" "$DMG.sha256" "$SERVER:/tmp/"
B=$(basename "$DMG")
ssh "$SERVER" "sudo mkdir -p $ZIEL && sudo mv /tmp/$B /tmp/$B.sha256 $ZIEL/ && ls -la $ZIEL/$B"
echo "fertig — /api/app/update?plattform=macos meldet $VERSION"
