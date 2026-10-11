#!/usr/bin/env bash
# Build-Dienst am Mac: läuft als LaunchAgent at.alfred.build in der angemeldeten Sitzung des Owners — nur dort ist der
# Schlüsselbund offen (Developer ID + notarytool-Profil); über SSH scheitert codesign mit errSecInternalComponent.
# Angestoßen von release/macos-fern.sh (launchctl kickstart), nie per RunAtLoad. Ergebnis: Log + Exit-Code unter $ZUSTAND.
APP="$(cd "$(dirname "$0")/.." && pwd)"
ZUSTAND="$HOME/Library/Logs/alfred-build"
mkdir -p "$ZUSTAND"
rm -f "$ZUSTAND/ende"
date '+start %Y-%m-%d %H:%M:%S' > "$ZUSTAND/release.log"
ALFRED_MAC_STRENG=1 "$APP/release/macos.sh" --kein-upload >> "$ZUSTAND/release.log" 2>&1
echo $? > "$ZUSTAND/ende"
