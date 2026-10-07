# Flutter-App, Phase 4 — Umsetzungs-Spec zur Freigabe

Stand 07.10.2026, Entwurf. Basis: Geräte-Architektur (docs/specs/2026-10-06-geraete-architektur.md, Abschnitte 8, 10, 11, 14, 16, 17). Noch keine Freigabe.

## 1. Ziel

Eine Flutter-Codebasis für Windows, macOS, Linux (Phase 4) und später Android, iOS (Phase 5). Die App ist eine Oberfläche über demselben Protokoll wie die Terminal-Sitzung; sie ersetzt die CLI nicht. Der Satellit (CLI-Dienst) bleibt der Ausführende am Gerät; die App bringt Fenster, Tray, globales Tastenkürzel, Systembenachrichtigungen und ein Mikrofon ohne sox.

## 2. Was es schon gibt und was die App übernimmt

| Fähigkeit | Heute (CLI) | App |
|---|---|---|
| Kopplung | `alfred pair`, Token in `~/.alfred/geraet.json` (Windows DPAPI) | liest dieselbe Datei; Windows über DPAPI-Entschlüsselung (win32 `CryptUnprotectData`). Kein zweites Pairing, eine Geräteidentität. |
| Chat mit Streaming | `POST /api/message` mit Gerätetoken, SSE mit `delta`, `attachment`, `progress` | identisch, SSE-Reader in Dart |
| Bestätigungen | `/api/confirmations/pending`, `/approve`, `/reject` | Liste und Buttons im Verlauf, Benachrichtigung des Systems bei neuer Frage |
| Talk | `/api/transcribe`, `/api/sprich`, Wiedergabe lokal | Aufnahme und Wiedergabe nativ (record/just_audio), Push-to-Talk mit globalem Tastenkürzel |
| Echtzeit-Hören | WebSocket `/api/geraete/hoeren`, Aktivierungswort | identisch, Satzende lokal wie `SatzendeErkenner` (Portierung nach Dart, gleiche Schwellen) |
| Lage, Geräte, Vorhaben, Lebenszeichen | Kacheln in der Web-GUI (`apps/web`, Bearer-Token) | eingebettetes Browserfenster (webview) mit dem Gerätetoken; keine zweite Implementierung |
| Dateien | `/api/geraete/dateien…` blockweise | Drag-and-drop ins Fenster, Teilen-Ziel |
| Update | Server-Release `GET /api/geraete/update[/datei]`, signiert | gleiche Route, Installer signiert, Abschnitt 6 |

Abweichung zur Spec vom 06.10.: Die App hängt sich nicht per IPC an den Satelliten, sondern spricht wie die Terminal-Sitzung direkt mit dem Gehirn (Gerätetoken, Sitzungs-Pfade aus `messaging/src/sitzung-pfade.ts`). Das ist der Pfad, der seit .1232 läuft und bewiesen ist; IPC brächte nur eine zweite Schicht. Der Satellit bleibt für Aktionen am Gerät zuständig, die App ruft ihn nicht selbst auf.

## 3. Eine Quelle der Wahrheit für das Protokoll

Die TypeScript-Typen in `packages/types/src/geraete.ts` und `messaging.ts` (Nachrichten, SSE-Ereignisse, Bestätigungen) werden per `ts-json-schema-generator` zu JSON-Schema und daraus mit `json_serializable` zu Dart-Klassen erzeugt. Ein Skript `scripts/protokoll-dart.mjs`, Ergebnis eingecheckt unter `apps/flutter/lib/protokoll/`. Jede Protokolländerung erzeugt die Dart-Seite neu; ein Test in CI prüft, dass das Ergebnis aktuell ist.

## 4. Aufbau der App

- `apps/flutter/` im Monorepo, Pakete: `flutter_riverpod` (Zustand), `window_manager` und `tray_manager` (Fenster, Tray), `hotkey_manager` (globales Push-to-Talk), `record` und `just_audio` (Mikrofon, Wiedergabe), `flutter_local_notifications` (Systembenachrichtigungen), `webview_flutter` bzw. `flutter_inappwebview` (Kacheln), `web_socket_channel` (Hören), `dio` (HTTPS mit eigener Zertifikatsprüfung für `insecure`).
- Oberfläche: Verlauf (Text, Sprache, Bestätigungen, proaktive Meldungen in einer Folge), Eingabezeile, Statuszeile (Gerät, Verbindung, offene Fragen, Lage-Kurzform), Kachel-Tab mit Webview.
- Konfiguration: dieselbe `~/.alfred/geraet.json`; keine zweite Datei.
- Hybrid bewusst: Kacheln bleiben Web, Sitzung ist nativ. Einzelne Kacheln können später nativ werden, wenn es einen Grund gibt.

## 5. Meilensteine, jeder mit Live-Beweis

1. **Grundgerüst Windows.** App startet, liest `geraet.json`, zeigt Verlauf, sendet Chat mit Streaming, zeigt Bestätigungsfragen mit Buttons. Beweis: „Öffne Downloads auf meinem PC" aus der App → Frage in der App → Ja → Ordner offen.
2. **Talk und Tray.** Push-to-Talk mit globalem Tastenkürzel, Antwort gesprochen, App im Tray, Benachrichtigung bei neuer Bestätigungsfrage. Beweis: Tastenkürzel aus Brave heraus → Frage gesprochen → Antwort gehört, unter 8 s.
3. **Kacheln und Dateien.** Webview mit Lebenszeichen, Vorgänge, Befunde, Geräte; Datei per Drag-and-drop zum Gehirn und zurück. Beweis: 20-MB-Datei beide Richtungen, Prüfsumme gleich.
4. **Echtzeit-Hören.** WebSocket-Relais, Satzende lokal, Aktivierungswort. Beweis: „Alfred, wie spät ist es" ohne Taste.
5. **macOS und Linux.** Dieselbe App, Mikrofon und Benachrichtigungen nativ, Berechtigungen (Mikrofon, Bildschirmaufnahme bleibt beim Satelliten). Beweis auf dem MacBook durch den Owner.
6. **Signierte Installer und Update.** MSIX (Trusted Signing), DMG notarisiert (Developer ID), AppImage und Debian-Paket (GPG); GitHub-Actions-Matrix; Update über den Server-Endpunkt wie beim Satelliten (Abschnitt 6).

Jeder Meilenstein ist eine Folge kleiner Releases mit Audit, wie bei Jarvis. Reihenfolge Windows zuerst (Owner-PC), dann Mac, dann Linux.

## 6. Verteilung und Update

Der Server stellt neben dem CLI-Tarball je Plattform einen App-Installer bereit: `data/releases/app/<version>-<plattform>.<ext>` mit SHA-256 und Ed25519-Signatur desselben Release-Schlüssels. Route `GET /api/geraete/app-update?plattform=windows` liefert Version, Prüfsumme, Signatur, Datei. Die App prüft beim Start, lädt im Leerlauf, prüft und startet den Installer (Windows MSIX-Update ohne Admin, macOS DMG-Austausch im Programme-Ordner, Linux AppImage-Austausch). Eine Version gilt wie beim Satelliten zehn Minuten als Probe, dann bestätigt sie sich am Gehirn.

Ablage der Installer auf dem Server: durch mich, wie heute der CLI-Tarball über den Eingang, oder aus der GitHub-Actions-Matrix per Upload mit Owner-Token.

## 7. Was der Owner beisteuern muss

- **Trusted Signing** in Azure Key Vault für Windows (Konto, Zertifikatsprofil) oder alternativ ein klassisches Code-Signing-Zertifikat.
- **Apple Developer-ID** für macOS-Notarisierung (Apple-Account besteht; App-spezifisches Passwort für `notarytool`).
- GPG-Schlüssel für Linux-Pakete (kann ich erzeugen, der private Schlüssel bleibt beim Owner).
- Entscheidung, ob die App ohne Signatur auf dem eigenen PC beginnen darf (Meilenstein 1 bis 4 ohne Installer, Start aus dem Build), bevor Signatur und Verteilung kommen. Empfehlung: ja.

## 8. Risiken und Grenzen

- Flutter-Desktop-Webview ist auf Windows WebView2-basiert, auf Linux WebKitGTK; beide sind in Ordnung für die Kacheln, aber keine Zwei-Wege-Brücke nötig.
- Globale Tastenkürzel unter Wayland sind eingeschränkt; Fallback ist die Taste im Fenster.
- Systembenachrichtigungen lesen (Spec §17 Punkt 5) wird erst mit Paket-Identität möglich (MSIX); die App bekommt das als eigenes Release nach Meilenstein 6.
- Kosten: die App erzeugt keine neuen LLM-Aufrufe über die der Sitzung hinaus.

## 9. Nicht Teil von Phase 4

Android und iOS (Phase 5), Raumgerät, Tastatur und Maus am Gerät (§17 Punkt 4, eigene Owner-Entscheidung), Ablösung der CLI.
