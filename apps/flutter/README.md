# Alfred Desktop-App (Flutter)

Phase 4 der Geräte-Architektur — Spec `docs/specs/2026-10-07-flutter-app-phase4.md`.

- Bauen (Windows): `flutter build windows --release` mit dem SDK in `F:/tools/flutter`; ein laufendes `alfred_app.exe` vorher beenden (LNK1104).
- Verbindung: IPC des Satelliten (`~/.alfred/ipc.json`) und Gerätetoken; kein API-Token in der App.
- Startargumente für Beweisläufe: `--protokoll <datei>`, `--sende <text>`, `--sprachtest <wav>`, `--datei <pfad>`, `--kacheln an`.
