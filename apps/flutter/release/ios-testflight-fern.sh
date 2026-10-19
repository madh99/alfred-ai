#!/usr/bin/env bash
# Phase 5 H1 — TestFlight-Build vom PC aus: committeter Stand (git archive, wie macos-fern.sh) nach ~/dev/alfred-ios-release/<Version>
# am Mac, dort ios-testflight-mac.sh (bauen, signieren, hochladen). Version/Build aus pubspec.yaml; jeder Upload braucht eine neue
# Build-Nummer (+N). Voraussetzung am Mac: ~/.config/alfred/asc.env (siehe ios-testflight-mac.sh).
set -euo pipefail
MAC="${ALFRED_MAC:-madh@192.168.1.146}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
VERSION="$(sed -n 's/^version: *//p' apps/flutter/pubspec.yaml | tr -d '\r')"
[ -z "$(git status --porcelain apps/flutter)" ] || echo "Hinweis: nicht committete Änderungen unter apps/flutter werden NICHT mitgebaut"
ZIEL="dev/alfred-ios-release/${VERSION//+/-}"
echo "Alfred $VERSION — TestFlight (Quelle $(git rev-parse --short HEAD))"
git -c core.autocrlf=false archive HEAD apps/flutter | ssh "$MAC" "mkdir -p ~/$ZIEL && tar -x -C ~/$ZIEL --strip-components=2"
ssh "$MAC" "bash ~/$ZIEL/release/ios-testflight-mac.sh"
