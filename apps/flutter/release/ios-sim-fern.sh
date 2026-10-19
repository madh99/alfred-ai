#!/usr/bin/env bash
# Phase 5 H1 — iOS-Simulator-Build am Mac, vom PC aus: Arbeitsstand (nicht nur HEAD) nach ~/dev/alfred-ios (eigener Ordner, das
# macOS-Release unter ~/dev/alfred-app bleibt unberührt), `flutter build ios --simulator`, in den laufenden Simulator installieren,
# starten und ein Bildschirmfoto holen. Ohne Signatur, ohne Upload.
#   apps/flutter/release/ios-sim-fern.sh            bauen, installieren, starten, Bildschirmfoto nach $AUSGABE (Standard ./ios-sim.png)
#   apps/flutter/release/ios-sim-fern.sh --nur-foto nur Bildschirmfoto
set -euo pipefail
MAC="${ALFRED_MAC:-madh@192.168.1.146}"
QUELLE='~/dev/alfred-ios'
AUSGABE="${AUSGABE:-ios-sim.png}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
foto() { ssh "$MAC" "xcrun simctl io booted screenshot /tmp/alfred-ios-sim.png >/dev/null 2>&1" && scp -q "$MAC:/tmp/alfred-ios-sim.png" "$AUSGABE" && echo "Bildschirmfoto: $AUSGABE"; }
[ "${1:-}" = "--nur-foto" ] && { foto; exit 0; }

# 1. Arbeitsstand ohne Build-Ordner hinüber (LF bleibt, da tar die Dateien unverändert überträgt)
tar -c --exclude=build --exclude=.dart_tool --exclude='ios/Pods' --exclude='ios/.symlinks' --exclude='*.iml' -C apps flutter \
  | ssh "$MAC" "mkdir -p $QUELLE && tar -x -C $QUELLE --strip-components=1"

# Beweislauf: START_JSON='{"koppeln":"…"}' legt eine einmalige Startdatei in den Datenordner der App (nur Debug-Builds lesen sie)
START_B64="$(printf '%s' "${START_JSON:-}" | base64 -w0 2>/dev/null || printf '%s' "${START_JSON:-}" | base64)"

# 2. Bauen, installieren, starten (Simulator muss laufen: `xcrun simctl boot <Gerät>`)
ssh "$MAC" "set -e; export PATH=\$HOME/dev/flutter/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH LANG=en_US.UTF-8; cd $QUELLE
  xcrun simctl list devices booted | grep -q Booted || { echo 'kein Simulator gestartet'; exit 1; }
  flutter build ios --simulator --debug > /tmp/alfred-ios-build.log 2>&1 || { tail -40 /tmp/alfred-ios-build.log; exit 1; }
  tail -2 /tmp/alfred-ios-build.log
  xcrun simctl terminate booted at.alfred.app >/dev/null 2>&1 || true
  xcrun simctl install booted build/ios/iphonesimulator/Runner.app
  if [ -n \"$START_B64\" ]; then D=\$(xcrun simctl get_app_container booted at.alfred.app data); mkdir -p \"\$D/Documents\"; echo $START_B64 | base64 -d > \"\$D/Documents/alfred-start.json\"; fi
  xcrun simctl launch booted at.alfred.app"
sleep "${WARTEN:-8}"
foto
