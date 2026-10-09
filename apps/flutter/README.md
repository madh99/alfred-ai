# Alfred Desktop-App (Flutter)

Phase 4 der Geräte-Architektur — Spec `docs/specs/2026-10-07-flutter-app-phase4.md`.

- Verbindung: IPC des Satelliten (`~/.alfred/ipc.json`, TCP 127.0.0.1 mit Geheimnis) liefert Server, Gerätetoken und Aktivierungswort; kein API-Token in der App.
- Startargumente für Beweisläufe: `--protokoll <datei>`, `--sende <text>`, `--sprachtest <wav>`, `--datei <pfad>`, `--kacheln an`, `--hoeren an`, `--hoertest <wav>`.
- Tests: `flutter test` (Satzende, Aktivierungswort, Sprachblöcke, WAV-Umwandlung).

## Bauen

- Windows: `flutter build windows --release` (SDK in `F:/tools/flutter`); ein laufendes `Alfred.exe` vorher beenden (LNK1104). Ergebnis `build/windows/x64/runner/Release/Alfred.exe` (Binärname seit 09.10. „Alfred“ — neuer Pfad, damit Windows nicht das alte Flutter-Symbol aus dem Cache zeigt).
- macOS (auf dem Mac, Xcode + CocoaPods; ohne sudo: Flutter per git clone nach ~/dev/flutter, CocoaPods 1.15.2 als Benutzer-Gem mit Pins für System-Ruby 2.6 — siehe Spec Phase 4 §10, 09.10.; `export PATH=$HOME/dev/flutter/bin:$HOME/.gem/ruby/2.6.0/bin:$PATH LANG=en_US.UTF-8`): `flutter build macos --release` → `build/macos/Build/Products/Release/Alfred.app`. Bundle-ID `at.alfred.app`, kein App-Sandbox (liest `~/.alfred/ipc.json`), Beim ersten Start fragt macOS nach „Lokales Netzwerk“ (nötig für Server und Satellit), beim ersten Zuhören nach dem Mikrofon. Ohne Signatur startet die App nach Rechtsklick → Öffnen.
- Linux (Debian/Ubuntu): `sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev libayatana-appindicator3-dev libkeybinder-3.0-dev libnotify-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libasound2-dev` (Tray, Tastenkürzel, Benachrichtigungen, Ton; bewiesen 09.10. auf Ubuntu 24.04), dann `flutter build linux --release` → `build/linux/x64/release/bundle/alfred_app`.

## Release (M6)

- Version steht in `pubspec.yaml` (`version: x.y.z+n`); der Server verteilt je Plattform die höchste Version aus `data/app-releases/<plattform>/`, die App prüft beim Start und alle sechs Stunden (`/api/app/update`).
- Windows: `node release/windows.cjs` — baut, signiert EXE/DLLs und das Setup über Azure Key Vault (AzureSignTool, Zugang in `.env.release`, Werkzeug in `tools/`, beides gitignored), packt mit Inno Setup (`release/alfred.iss`, Installation je Benutzer nach `%LOCALAPPDATA%\Programs\Alfred`, Autostart-Option) und lädt `Alfred-<v>-setup.exe` auf den Server. Still installieren: `Alfred-<v>-setup.exe /SILENT /CLOSEAPPLICATIONS /NORESTART`.
- Linux: `release/linux.sh` auf einer Ubuntu-Maschine mit Flutter — `.deb` mit `/opt/alfred`, Desktop-Eintrag, Symbol, Autostart für alle Benutzer; Upload nach `data/app-releases/linux/`.
- macOS: `release/macos.sh` auf dem Mac — DMG; mit `ALFRED_MAC_IDENTITY="Developer ID Application: …"` signiert (Hardened Runtime), mit `ALFRED_NOTARY_PROFILE=<notarytool-Profil>` notarisiert und gestapelt.
- Beweislauf Update: `Alfred.exe --protokoll <datei> --update sofort` lädt und installiert ein verfügbares Update ohne Klick.
