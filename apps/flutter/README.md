# Alfred Desktop-App (Flutter)

Phase 4 der Geräte-Architektur — Spec `docs/specs/2026-10-07-flutter-app-phase4.md`.

- Verbindung: IPC des Satelliten (`~/.alfred/ipc.json`, TCP 127.0.0.1 mit Geheimnis) liefert Server, Gerätetoken und Aktivierungswort; kein API-Token in der App.
- Startargumente für Beweisläufe: `--protokoll <datei>`, `--sende <text>`, `--sprachtest <wav>`, `--datei <pfad>`, `--kacheln an`, `--hoeren an`, `--hoertest <wav>`.
- Tests: `flutter test` (Satzende, Aktivierungswort, Sprachblöcke, WAV-Umwandlung).

## Bauen

- Windows: `flutter build windows --release` (SDK in `F:/tools/flutter`); ein laufendes `alfred_app.exe` vorher beenden (LNK1104). Ergebnis `build/windows/x64/runner/Release/alfred_app.exe`.
- macOS (auf dem Mac, Xcode + CocoaPods; ohne sudo: Flutter per git clone nach ~/dev/flutter, CocoaPods 1.15.2 als Benutzer-Gem mit Pins für System-Ruby 2.6 — siehe Spec Phase 4 §10, 09.10.; `export PATH=$HOME/dev/flutter/bin:$HOME/.gem/ruby/2.6.0/bin:$PATH LANG=en_US.UTF-8`): `flutter build macos --release` → `build/macos/Build/Products/Release/Alfred.app`. Bundle-ID `at.alfred.app`, kein App-Sandbox (liest `~/.alfred/ipc.json`), Beim ersten Start fragt macOS nach „Lokales Netzwerk“ (nötig für Server und Satellit), beim ersten Zuhören nach dem Mikrofon. Ohne Signatur startet die App nach Rechtsklick → Öffnen.
- Linux (Debian/Ubuntu): `sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev libayatana-appindicator3-dev libkeybinder-3.0-dev` (Tray und Tastenkürzel), dann `flutter build linux --release` → `build/linux/x64/release/bundle/alfred_app`.
