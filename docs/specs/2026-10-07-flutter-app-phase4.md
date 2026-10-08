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


## 10. Umsetzungsstand

**08.10.2026 — Start (Owner „danach weiter mit phase 4"), Meilenstein 1 am PC bewiesen (14:00).**
- Werkzeuge: Flutter 3.47.6 stable nach `F:	oolslutter` (ohne Admin), Visual Studio Build Tools 2022 mit C++ waren da; `flutter doctor` grün für Windows-Desktop. App unter `apps/flutter` (`alfred_app`, nur Windows-Plattform angelegt).
- Anbindung: wie die Terminal-Sitzung — HTTP mit Gerätetoken zum Gehirn (Chat mit SSE-Streaming, offene Bestätigungen, Entscheidung) und IPC zum Satelliten. Weil Flutter die Named Pipe von Node nicht öffnen kann, lauscht der Satellit seit CLI .1312 zusätzlich auf 127.0.0.1 (Port und Geheimnis in `~/.alfred/ipc.json`, 0600, `hallo` mit Geheimnis zuerst) und liefert per Befehl `konfig` Server, Gerät und Token — die App liest die DPAPI-geschützte `geraet.json` nicht selbst. Ohne laufenden Satelliten zeigt die App das und versucht es alle 3 s neu.
- Dateien: `lib/modell.dart` (Eintrag, Bestätigung, Status, Konfig), `lib/ipc.dart` (TCP-IPC, JSON-Zeilen, Wiederverbindung), `lib/server.dart` (HttpClient, `insecure` = Zertifikat akzeptieren, SSE-Parser), `lib/main.dart` (Verlauf als Liste mit Du/Alfred-Blasen, Satelliten- und Bestätigungszeilen mit Zeit, Kasten „Offene Bestätigungen" mit Ja/Nein, Eingabe mit Senden, Statuszeile; Startargumente `--protokoll <datei>` und `--sende "<text>"` für Beweisläufe). Keine Zusatzpakete außer dem Gerüst; Riverpod, Tray, Hotkey, Audio folgen mit den Meilensteinen 2 ff.
- **Beweis Meilenstein 1 (13:55–13:56):** App gestartet mit `--sende "Öffne auf PC-madh den Ordner Downloads im Explorer."` → Protokoll: Anhängen über IPC, Nachricht gesendet 13:55:37, Bestätigung „(Gerät) Auf PC-madh: oeffnen path=~/Downloads" per IPC-Push 13:55:41 in der App, Antwort „zur Bestätigung gestellt"; Freigabe (per API, in der App ist es der Ja-Button auf demselben Weg) 13:56:18 → Schrittprotokoll `oeffnen ausgefuehrt — Geöffnet auf PC-madh: C:UsersmadhDownloads`; die App zeigte anschließend die Satelliten-Ereignisse (Aktion, Ergebnis) mit. Das Spec-Kriterium „Frage in der App → Ja → Ordner offen" ist erfüllt; der Ja-Button selbst steht noch für den Owner-Test (gleiche Route wie der API-Aufruf).
- Offen in Meilenstein 1: Markdown in Antworten, Fenstertitel mit Bestätigungszahl, Verlauf beim Start aus dem Gehirn laden. Danach Meilenstein 2 (Talk und Tray).

**08.10.2026 14:16 — Meilenstein 2 gebaut, Sprachkette bewiesen; Tastenkürzel und Tray für den Owner-Test.**
- Pakete: window_manager 0.5.2 (Fenster, Titel, Schließen = verbergen), tray_manager 0.7.0 über `legacy.dart` (Symbol `assets/alfred.ico`, erzeugt per Skript; Menü Öffnen / Sprechen / Beenden; Linksklick öffnet), hotkey_manager 0.2.3 (Strg+Alt+Leertaste systemweit, schaltet die Aufnahme um), record 7.1.1 (WAV 16 kHz mono), audioplayers 6.8.1 (Wiedergabe der Sprachsynthese), local_notifier 0.1.6 (WinToast) — flutter_local_notifications scheiterte am Build: braucht `atlbase.h` (ATL-Komponente der VS-Build-Tools, nicht installiert); path_provider.
- Ablauf Sprache: Aufnahme → `POST /api/transcribe` → Chat mit Streaming → `POST /api/sprich` (ganzer Antworttext) → Wiedergabe; Vorlesen-Schalter in der Leiste liest auch getippte Antworten vor. Benachrichtigung nur, wenn das Fenster verborgen ist; Klick öffnet es. Fenstertitel „Alfred — PC-madh · 2 Bestätigungen". Markdown (fett, Code, Aufzählung, Überschrift) in Antworten.
- **Beweis Sprachkette 14:16 (`--sprachtest`, WAV per Windows-Sprachsynthese „Alfred, wie spät ist es gerade?"):** Transkription wortgleich, Antwort „Es ist gerade 14:16 Uhr", erster Ton nach 8,6 s, Wiedergabe ohne Fehler (erster Lauf 12,3 s mit Wiedergabefehler durch falschen Timeout-Typ, behoben). Spec-Ziel „unter 8 s" knapp verfehlt: die App spricht den ganzen Text in einem Stück; blockweise Synthese wie in der Terminal-Sitzung (v1247) ist der nächste Schritt.
- **Offen für den Owner:** Tastenkürzel aus einem anderen Programm, Tray-Menü, Benachrichtigung bei verborgenem Fenster — das kann ich nicht fernsteuern. Dann Meilenstein 3 (Kacheln und Dateien).
- Werkzeug-Lektion: ein laufendes `alfred_app.exe` sperrt die Exe (LNK1104) — vor dem Build eigene Testinstanzen beenden.

**08.10.2026 14:40 — Meilenstein 2 abgeschlossen (Owner-Test: Tastenkürzel, Aufnahme und Sprache gehen; Tray und Benachrichtigung vom Owner noch nicht gemeldet).** Zwei Nachbesserungen aus dem Owner-Test: (1) Dart kodiert `HttpClientRequest.write` als Latin-1 — Antworten mit „–" oder „„" brachen die Sprachsynthese mit „Contains invalid characters"; jetzt `utf8.encode` mit `charset=utf-8` für Chat und Sprache. (2) Sprachausgabe satzweise (`Vorleser` in audio.dart, `schneideSaetze` ab 60 Zeichen, Synthese je Block, Wiedergabe der Reihe nach, Markdown entfernt) statt des ganzen Textes in einem Stück: erster Ton nach 6,8 s (vorher 8,6 / 9,0 / 22,3 s) — unter dem Spec-Ziel von 8 s. Gilt für Spracheingabe und Vorlesen-Schalter.

**08.10.2026 14:46 — Meilenstein 3, Teil Dateien bewiesen; Teil Kacheln braucht eine Entscheidung.**
- Dateien: `lib/transfer.dart` lädt wie der Satellit (v1249) blockweise mit SHA-256 über `/api/geraete/dateien` (Start → PUT-Blöcke mit Offset, 409 + `empfangen` = weitermachen, `fertig` → Schlüssel); Drag-and-drop ins Fenster (`desktop_drop`), danach sagt die App Alfred im Chat Bescheid (Name, Größe, Prüfsumme, Schlüssel). Beweis 14:45–14:46 mit 20 MB Zufallsdaten: Upload in 0,7 s, Schlüssel `…/2026-10-08T12-45-10-193Z_beweis-20mb.bin`, Alfred bestätigte den Empfang; zurück per Chat „lege die Datei … in ~/Downloads ab" → `datei_ablegen` nach Freigabe → `C:\Users\madh\Downloads\beweis-20mb.bin (20971520 B)`; SHA-256 beider Dateien `e0aeae9a…f3d367` gleich. Beweislauf: `alfred_app.exe --datei <pfad>`.
- Kacheln: `flutter_inappwebview` (Windows über WebView2) braucht zum Bauen `nuget` im PATH und die Web-Oberfläche verlangt das API-Token des Owners, das die App bewusst nicht hat (nur Gerätetoken, Routen in `sitzung-pfade.ts`). Zwei Wege: (a) Webview wie im Spec — nuget installieren, API-Token in die App geben (mehr Angriffsfläche); (b) die vier Kacheln nativ in Flutter aus den JSON-Routen zeichnen und `/api/vorgaenge` sowie `/api/befunde` lesend fürs Gerätetoken freigeben (Lebenszeichen und Geräte sind es schon). Empfehlung (b): kein nuget, kein API-Token in der App, und die Spec-Entscheidung „Hybrid: Kacheln bleiben Web" wird für diese vier Kacheln zu „nativ" — Owner-Entscheidung.

**08.10.2026 15:02 — Meilenstein 3 abgeschlossen: Kacheln nativ (Owner „nativ, freigabe").**
- `lib/kacheln.dart`: vier Karten Lage, Befunde, Vorgänge, Geräte+Modelle aus `/api/lebenszeichen` und `/api/vorgaenge?limit=30`, alle 30 s neu, zweispaltig ab 900 px, Ziehen zum Aktualisieren. Kein Webview, kein API-Token: v1313 gibt dem Gerätetoken die Vorgangsliste lesend frei (Entscheidungen bleiben beim API-Token).
- Umschalter in der Titelleiste; Startargument `--kacheln an` für Beweisläufe. Beweis 15:01 (Protokoll): „Kacheln geladen: 4 Befunde, 29 Vorgänge, 3 Geräte“, Bildschirm zeigt Vorgänge (29), Geräte (3/3 online) mit den fünf Modell-Tiers.
- Offen aus M1: Verlauf beim Start (keine Gerätetoken-Route). Nächster Schritt: M4 Echtzeit-Hören.

**08.10.2026 15:25 — Meilenstein 4 Echtzeit-Hören umgesetzt und über das Relais bewiesen.**
- `lib/hoeren.dart`: `SatzendeErkenner` (Portierung von `satzende.ts`, gleiche Schwellen: 20-ms-Rahmen, 3 laute Rahmen Start, 700 ms Ruhe Ende, 400 ms Minimum, 20 s Maximum, Grundpegel ×3 ab 350), `pruefeAktivierung` (Portierung von `aktivierung.ts` samt Levenshtein-Toleranz, Füllwörtern und Stoppwörtern), `HoerClient` (dart:io-WebSocket zu `/api/geraete/hoeren` mit Gerätetoken; Binär = PCM, JSON start/ende/schluss; zurück bereit/delta/fertig/fehler/limit), `wavZuPcm16k` für Beweisläufe.
- `lib/audio.dart`: Mikrofonstrom über `record.startStream` (PCM 16 kHz mono) und Flag `spielt` für den Halbduplex (während Alfred antwortet oder spricht wird nicht gehört).
- `lib/main.dart`: Kopfhörer-Knopf „Zuhören", Gesprächsfenster 20 s nach einer Antwort, „Alfred, stopp" bricht die Wiedergabe ab, nur das Wort → „Ja?", Startargumente `--hoeren an` und `--hoertest <wav>`; Strg+Alt+Leertaste verweist während des Zuhörens auf das Aktivierungswort.
- Beweis 15:22 (Protokoll der App + Server-Log „v1251 Hören"): WAV 3,4 s in 80-ms-Blöcken → Satzende lokal nach 3,3 s → Relais „Äußerung transkribiert" (31 Zeichen, 2 Anbieter-Sekunden) → „Wie spät ist es gerade?" im Gesprächsfenster angenommen → Antwort „Es ist gerade 15:22 Uhr." → vorgelesen. Erster Ton erst nach 13,9 s: die Sprachsynthese am Server war langsam, nicht die App (M2 hatte 6,8 s).
- Offen: Mikrofon-Beweis mit Aktivierungswort durch den Owner (Kopfhörer-Knopf, „Alfred, wie spät ist es" ohne Taste); das Wort kommt vorerst fest als „Alfred", bis der Satellit es in der IPC-Konfig mitschickt (geplant v1314).
