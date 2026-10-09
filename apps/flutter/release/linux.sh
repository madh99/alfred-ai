#!/usr/bin/env bash
# Phase 4 M6 — Linux-Release der Alfred-App als Debian-Paket. Läuft auf einer Ubuntu-Maschine mit Flutter
# (z. B. Ubuntu-VM 192.168.1.178): bauen, nach /opt/alfred packen, Desktop-Eintrag + Symbol + Autostart,
# dpkg-deb, Prüfsumme, Upload nach data/app-releases/linux/ auf dem Alfred-Server.
#   release/linux.sh            komplette Kette
#   release/linux.sh --kein-upload
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${ALFRED_RELEASE_SERVER:-madh@192.168.1.92}"
ZIEL=/root/alfred/data/app-releases/linux
VERSION=$(grep -E '^version:' "$APP/pubspec.yaml" | sed -E 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
[ -n "$VERSION" ] || { echo "version in pubspec.yaml fehlt"; exit 1; }
echo "Alfred $VERSION — Linux-Release (.deb)"

cd "$APP"
flutter build linux --release
BUNDLE="$APP/build/linux/x64/release/bundle"
[ -x "$BUNDLE/alfred_app" ] || { echo "Bundle fehlt"; exit 1; }

PKG="$APP/build/deb/alfred_${VERSION}_amd64"
rm -rf "$PKG"; mkdir -p "$PKG/DEBIAN" "$PKG/opt/alfred" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/256x256/apps" "$PKG/etc/xdg/autostart" "$PKG/usr/bin"
cp -R "$BUNDLE/." "$PKG/opt/alfred/"
cp "$APP/assets/alfred.png" "$PKG/usr/share/icons/hicolor/256x256/apps/alfred.png"
cat > "$PKG/usr/share/applications/alfred.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Alfred
Comment=Alfred Desktop-App (Gerätesitzung)
Exec=/opt/alfred/alfred_app
Icon=alfred
Terminal=false
Categories=Utility;
StartupWMClass=alfred_app
EOF
# Autostart für alle Benutzer (der Satellit läuft als Benutzerdienst; die App findet ihn über ~/.alfred/ipc.json)
sed 's/^Comment=.*/Comment=Alfred beim Anmelden starten/' "$PKG/usr/share/applications/alfred.desktop" > "$PKG/etc/xdg/autostart/alfred.desktop"
ln -sf /opt/alfred/alfred_app "$PKG/usr/bin/alfred-app"
GROESSE_KB=$(du -sk "$PKG/opt" | cut -f1)
cat > "$PKG/DEBIAN/control" <<EOF
Package: alfred
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: $GROESSE_KB
Depends: libgtk-3-0, libayatana-appindicator3-1, libkeybinder-3.0-0, libnotify4, libasound2t64 | libasound2, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good
Maintainer: Alfred <alfred@lokalkraft.at>
Description: Alfred Desktop-App
 Chat, Bestätigungen, Sprache und Kacheln für das Alfred-Gehirn, verbunden über den Satelliten dieses Geräts.
EOF
cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
exit 0
EOF
chmod 755 "$PKG/DEBIAN/postinst"
find "$PKG" -type d -exec chmod 755 {} +
DEB="$APP/build/deb/alfred_${VERSION}_amd64.deb"
dpkg-deb --build --root-owner-group "$PKG" "$DEB"
sha256sum "$DEB" | sed "s#$APP/build/deb/##" > "$DEB.sha256"
echo "$(basename "$DEB")  $(du -h "$DEB" | cut -f1)  sha256 $(cut -c1-16 "$DEB.sha256")…"
[ "${1:-}" = "--kein-upload" ] && exit 0
echo "Upload → $SERVER:$ZIEL"
scp -q "$DEB" "$DEB.sha256" "$SERVER:/tmp/"
B=$(basename "$DEB")
ssh "$SERVER" "sudo mkdir -p $ZIEL && sudo mv /tmp/$B /tmp/$B.sha256 $ZIEL/ && ls -la $ZIEL/$B"
echo "fertig — /api/app/update?plattform=linux meldet $VERSION"
