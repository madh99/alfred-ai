#!/usr/bin/env bash
# Phase 5 H1 — TestFlight-Build, läuft AM MAC im ausgepackten Stand (aufgerufen von ios-testflight-fern.sh).
# Signatur: Xcode „automatisch“ mit App-Store-Connect-API-Schlüssel (-allowProvisioningUpdates); das Verteil-Zertifikat
# verwaltet Apple in der Cloud, lokal liegt keins. Der Schlüssel bleibt am Mac: ~/.config/alfred/asc.env nennt nur Pfad und IDs
#   ASC_KEY_PATH=/Users/…/AuthKey.p8   ASC_KEY_ID=…   ASC_ISSUER_ID=…
# Export mit destination=upload lädt direkt zu App Store Connect; danach erscheint der Build nach Apples Prüfung in TestFlight.
set -euo pipefail
export PATH="$HOME/dev/flutter/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" LANG=en_US.UTF-8
# shellcheck disable=SC1090
source "$HOME/.config/alfred/asc.env"
[ -r "$ASC_KEY_PATH" ] || { echo "API-Schlüssel nicht lesbar: $ASC_KEY_PATH"; exit 1; }
cd "$(dirname "$0")/.."
mkdir -p build
LOG="$PWD/build/testflight.log" # im eigenen Build-Ordner, nicht unter festem Namen in /tmp (Symlink-Angriff)
: > "$LOG"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "1/3 flutter build ios (Release, ohne Signatur)"
flutter build ios --release --no-codesign >> "$LOG" 2>&1 || { tail -30 "$LOG"; exit 1; }

# Archiv unsigniert: über ssh ist der Schlüsselbund gesperrt („User interaction is not allowed“), und eine lokale
# Development-Signatur braucht es nicht — die Verteil-Signatur setzt der Export per Cloud-Signatur (API-Schlüssel).
echo "2/3 Archiv (unsigniert)"
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release -destination generic/platform=iOS \
  -archivePath build/Alfred.xcarchive archive CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" >> "$LOG" 2>&1 || { grep -E "error:|Error" "$LOG" | tail -20; exit 1; }

cat > build/ExportOptions.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>T28LD8TF6X</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

echo "3/3 Export (Cloud-Signatur) + Upload zu App Store Connect"
xcodebuild -exportArchive -archivePath build/Alfred.xcarchive -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/ipa "${AUTH[@]}" >> "$LOG" 2>&1 || { grep -E "error:|Error" "$LOG" | tail -20; exit 1; }
grep -E "Upload succeeded|EXPORT SUCCEEDED|Uploaded" "$LOG" | tail -3
/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:CFBundleShortVersionString" -c "Print :ApplicationProperties:CFBundleVersion" build/Alfred.xcarchive/Info.plist | paste -sd' ' - | sed 's/^/Version /'
