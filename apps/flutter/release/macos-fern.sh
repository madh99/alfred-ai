#!/usr/bin/env bash
# macOS-Release ohne Handgriff am Mac, vom PC aus: Quellen (HEAD) per git archive hinüber, Build-Dienst at.alfred.build
# in der angemeldeten Mac-Sitzung anstoßen (signiert + notarisiert dort, siehe release/macos-dienst.sh), warten,
# DMG über den PC zum Server (der Mac hat keinen Server-Schlüssel).
#   apps/flutter/release/macos-fern.sh                komplette Kette
#   apps/flutter/release/macos-fern.sh --kein-upload  DMG nur bauen und abholen
# Voraussetzung: Owner am Mac angemeldet (Bildschirmsperre stört nicht), SSH-Zugang zum Mac und zum Server.
set -euo pipefail
MAC="${ALFRED_MAC:-madh@192.168.1.200}"
SERVER="${ALFRED_RELEASE_SERVER:-madh@192.168.1.92}"
ZIEL=/root/alfred/data/app-releases/macos
LABEL=at.alfred.build
QUELLE='~/dev/alfred-app/flutter'
ZUSTAND='~/Library/Logs/alfred-build'
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
VERSION=$(grep -E '^version:' apps/flutter/pubspec.yaml | sed -E 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
[ -n "$VERSION" ] || { echo "version in pubspec.yaml fehlt"; exit 1; }
[ -z "$(git status --porcelain -- apps/flutter/lib apps/flutter/pubspec.yaml apps/flutter/release)" ] \
  || echo "HINWEIS: ungespeicherte Änderungen unter apps/flutter — gebaut wird HEAD $(git rev-parse --short HEAD)"
echo "Alfred $VERSION — macOS-Fernbuild auf $MAC (HEAD $(git rev-parse --short HEAD))"

# 1. Quellen: LF erzwingen (autocrlf würde CRLF in die Shell-Skripte schreiben)
git -c core.autocrlf=false -c core.eol=lf archive HEAD apps/flutter \
  | ssh "$MAC" "mkdir -p ~/dev/alfred-app && tar -x -C ~/dev/alfred-app --strip-components=1"

# 2. Dienst einrichten (nur wenn neu oder geändert) und anstoßen
ssh "$MAC" "set -e; chmod +x $QUELLE/release/*.sh; P=~/Library/LaunchAgents/$LABEL.plist; D=gui/\$(id -u)
  if ! cmp -s $QUELLE/release/$LABEL.plist \$P || ! launchctl print \$D/$LABEL >/dev/null 2>&1; then
    launchctl bootout \$D/$LABEL 2>/dev/null || true; cp $QUELLE/release/$LABEL.plist \$P; launchctl bootstrap \$D \$P; fi
  mkdir -p $ZUSTAND; rm -f $ZUSTAND/ende; launchctl kickstart \$D/$LABEL"
echo "Build läuft am Mac (Log: $ZUSTAND/release.log)"

# 3. Warten (Build + Notarisierung dauern meist 5–15 min), Fortschritt aus dem Log
ssh "$MAC" "for i in \$(seq 1 270); do [ -f $ZUSTAND/ende ] && break; sleep 10
    [ \$((i % 6)) -eq 0 ] && echo \"  … \$(tail -1 $ZUSTAND/release.log | cut -c1-110)\"; done
  [ -f $ZUSTAND/ende ] || { echo 'Zeitüberschreitung (45 min)'; exit 1; }
  C=\$(cat $ZUSTAND/ende); tail -6 $ZUSTAND/release.log; [ \"\$C\" = 0 ] || { echo \"Build am Mac fehlgeschlagen (Exit \$C)\"; exit 1; }"

# 4. DMG abholen und prüfen
LOKAL="$(mktemp -d)"
scp -q "$MAC:$QUELLE/build/Alfred-$VERSION.dmg" "$MAC:$QUELLE/build/Alfred-$VERSION.dmg.sha256" "$LOKAL/"
(cd "$LOKAL" && sha256sum -c "Alfred-$VERSION.dmg.sha256")
[ "${1:-}" = "--kein-upload" ] && { echo "fertig — $LOKAL/Alfred-$VERSION.dmg"; exit 0; }

# 5. Upload wie release/windows.cjs
echo "Upload → $SERVER:$ZIEL"
scp -q "$LOKAL/Alfred-$VERSION.dmg" "$LOKAL/Alfred-$VERSION.dmg.sha256" "$SERVER:/tmp/"
B="Alfred-$VERSION.dmg"
ssh "$SERVER" "sudo mkdir -p $ZIEL && sudo mv /tmp/$B /tmp/$B.sha256 $ZIEL/ && ls -la $ZIEL/$B"
rm -rf "$LOKAL"
echo "fertig — /api/app/update?plattform=macos meldet $VERSION"
