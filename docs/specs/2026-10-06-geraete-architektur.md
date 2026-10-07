# Alfred Geräte-Architektur — Satelliten, Sitzungen, Sprache

Stand: 06.10.2026, Entwurf zur Entscheidung (keine Freigabe erteilt). Gehört zur Jarvis-Architektur (`2026-10-04-jarvis-architektur.md`) und erweitert sie um einen Wirkungsraum: die Geräte des Owners.

## 1. Ziel und Nicht-Ziele

**Ziel.** Alfred ist nicht nur auf dem Server und über Web oder Messenger erreichbar, sondern hat ein eigenes Gerät in der Hand des Owners und auf dessen Schreibtisch. Drei Fähigkeiten:

1. **Sprechen, egal von wo** — Sprache hinein, Sprache heraus, aus einer Sitzung, die man einmal öffnet.
2. **Handeln auf dem Gerät** — Dateien, Programme, Shell, Bildschirm auf dem Desktop; Benachrichtigung, Standort, Kamera, Teilen auf dem Handy. Immer unter den Autonomie-Regeln von Schicht 3.
3. **Das Gerät als Sinnesorgan** — Standort, Akku, Netz, Leerlaufzeit, aktives Fenster fließen ins Weltmodell (Schicht 1) und machen Anwesenheit und Zustellung präzise.

**Nicht-Ziele.** Kein zweites Gehirn auf dem Gerät: Weltmodell, Vorgänge, Befunde, Gedächtnis und Reasoning bleiben auf dem Server. Keine neue Sprache für den Kern: Protokoll, Satellit und Sitzung sind TypeScript im Monorepo. Keine Plattform-Widgets: Apps sind installierbare, signierte Hüllen um dieselbe Oberfläche.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Gehirn** | Der Alfred-Server (`alfred start`). Einziger Ort für Zustand und Entscheidung. |
| **Gerät** | Ein Rechner oder Handy des Owners mit eigener Identität (ID, Token, Name, Plattform). Genau eine Identität je physischem Gerät. |
| **Satellit** | Der Dienst auf dem Gerät, der die Verbindung zum Gehirn hält, Fähigkeiten anbietet, Sinne liefert und Aktionen ausführt. Läuft ohne Fenster, startet mit dem System. |
| **Sitzung** | Die Oberfläche, die sich an den Satelliten hängt: Terminal (`alfred`), Desktop-Fenster oder Handy-App (beide Flutter, Entscheidung 06.10.). Chat, Talk, Bestätigungen und Meldungen in einem Verlauf. |
| **Manifest** | Was ein Gerät kann: Plattform, angebotene Aktionen mit Autonomie-Klasse, gelieferte Sinne, Version. |
| **Fähigkeit** | Eine Aktion (etwas tun) oder ein Sinn (etwas liefern). Aktionen laufen als Skills durch die Skill-Sandbox des Satelliten. |
| **Pairing** | Einmalige Kopplung eines Geräts mit dem Gehirn über einen kurzlebigen Code aus der Web-GUI; ergibt ein langlebiges, widerrufbares Gerätetoken. |

## 3. Topologie und Verbindung

- **Richtung.** Das Gerät verbindet sich nach außen zum Gehirn (`wss://<server>/api/geraete/ws`). Keine offenen Ports am Gerät, funktioniert hinter NAT und Mobilfunk. Für unterwegs: WireGuard auf der Dream Machine (empfohlen) oder eine öffentliche Adresse über den Nginx Proxy Manager, dann ausschließlich mit Gerätetoken.
- **Eine Verbindung je Gerät.** Der Satellit hält sie. Sitzungen auf demselben Rechner hängen sich über lokales IPC (Unix-Socket, auf Windows Named Pipe) an den Satelliten, statt eigene Verbindungen zu öffnen. Ohne laufenden Satelliten startet die Sitzung ihn eingebettet.
- **Lebenszeichen.** Herzschlag alle 30 s, Wiederverbindung mit exponentiellem Rückzug (1 s bis 2 min), Server markiert Geräte nach 3 verpassten Herzschlägen als getrennt. Getrennt-Zustand ist ein Befund (Quelle `geraete`), keine Owner-Meldung.
- **Nachrichten.** JSON-Rahmen mit `typ`, `id`, `zeit`, `version`; Audio als Binärrahmen mit Verweis-ID. Jede Anfrage hat eine Antwort oder einen Fehler; Wiederholungen werden über `id` erkannt (Replay-Schutz).

## 4. Sicherheit

- **Pairing.** Owner erzeugt in der Web-GUI (Kachel Geräte) einen 8-stelligen Code oder QR, gültig 5 Minuten, einmal verwendbar. Das Gerät sendet Code, Name, Plattform, Manifest; das Gehirn antwortet mit Geräte-ID und Token (256 Bit, zufällig). Gespeichert wird nur ein Hash des Tokens; das Gerät legt das Token im Schlüsselbund des Systems ab (DPAPI, macOS Keychain, Secret Service, Android Keystore, iOS Keychain).
- **Berechtigungen je Gerät.** Der Owner legt fest, welche Fähigkeiten ein Gerät anbieten darf (Scopes). Ein Handy bekommt nie Shell. Ein Desktop bekommt Shell nur mit ausdrücklicher Freigabe. Standard für alles Verändernde: `bestaetigen`.
- **Autonomie-Klassen** (bestehend, Schicht 3): `auto` für Lesen und Benachrichtigen, `bestaetigen` für Öffnen, Schreiben, Ausführen, `nie` für Löschen außerhalb des Projektordners, Systemänderungen, Zahlungen. Die Klasse steht im Manifest je Aktion und kann vom Gehirn nur verschärft, nie gelockert werden.
- **Ausführungsgedächtnis.** Jede Geräteaktion ist ein Schritt mit Gerät, Skill, Parametern, Ergebnis und Rücknahme-Hinweis (`vorgang_schritte`, `quelle = 'geraet'`).
- **Widerruf.** Token in der Kachel widerrufbar; der Satellit erhält `abgemeldet` und löscht das Token. Verlorenes Handy: Widerruf genügt.
- **Transport.** Ausschließlich TLS. Audio und Standort verlassen das Gerät nur verschlüsselt zum Gehirn, nie zu Dritten außer den konfigurierten Sprach-Anbietern.
- **Grenzen des Satelliten.** Skills laufen in der bestehenden Skill-Sandbox mit Zeitbudget; Dateizugriff ist auf Owner-Verzeichnisse begrenzt, die der Owner in der Gerätekonfiguration nennt. Keine Geheimnisse des Servers auf dem Gerät; lokale Skills nutzen lokale Konfiguration.

## 5. Protokoll

| Typ | Richtung | Inhalt |
|---|---|---|
| `hallo` | Gerät → Gehirn | Geräte-ID, Token, Manifest, Satellit-Version |
| `willkommen` | Gehirn → Gerät | Server-Version, Serverzeit, aktuelle Lage, offene Bestätigungen |
| `puls` / `puls_ok` | beide | Herzschlag |
| `sinne` | Gerät → Gehirn | Standort (Zone, Koordinaten optional), Akku, Netz, Leerlaufsekunden, aktives Fenster (nur Titel, Desktop), Bewegung (Handy). Bei Änderung und spätestens alle 5 min |
| `aktion` | Gehirn → Gerät | ID, Skill, Aktion, Parameter, Autonomie, Begründung, Vorgang-ID |
| `aktion_ergebnis` | Gerät → Gehirn | ID, success, data, display, error, Dauer |
| `bestaetigung` / `bestaetigung_antwort` | beide | Frage an die aktive Sitzung oder den Messenger; Antwort Ja/Nein mit Zeit |
| `chat` | Gerät → Gehirn | Text oder Audio-Verweis, Sitzungs-ID |
| `antwort` | Gehirn → Gerät | Text (gestreamt in Abschnitten), Audio-Verweis, Warum-Kurzfassung |
| `meldung` | Gehirn → Gerät | Proaktive Meldung mit Grund (Zustellweg „geraet") |
| `lage` | Gehirn → Gerät | Aktualisierte Lage (aus .1220), für Statuszeile und Sperrbildschirm |
| `abgemeldet` | Gehirn → Gerät | Token widerrufen |

Versionierung: `version` im Rahmen; das Gehirn akzeptiert die letzten zwei Protokollversionen.

## 5a. Dateitransfer (Entscheidung 06.10.: in beide Richtungen)

- **Server → Gerät** (`datei_ablegen`): Alfred legt eine Datei aus dem Dateispeicher des Servers (Anhänge, erzeugte PDFs, Exporte) in ein freigegebenes Verzeichnis des Geräts. Autonomie `bestaetigen` (schreibt auf dem Gerät).
- **Gerät → Server** (`datei_holen`): Screenshot, Dokument oder eine in der Sitzung abgelegte Datei wandert in den Dateispeicher des Servers und steht sofort als Anhang und für Werkzeuge bereit. Autonomie `bestaetigen` (private Daten verlassen das Gerät). Quelle nur aus freigegebenen Verzeichnissen.
- **Technik.** Steuerung über die WebSocket-Verbindung, Nutzlast über HTTPS mit Gerätetoken (`PUT/GET /api/geraete/dateien/<id>`), in Blöcken mit SHA-256-Prüfsumme und Wiederaufnahme. Standardgrenze 50 MB, größer nur mit ausdrücklicher Freigabe im Scope. Jeder Transfer ist ein Schritt im Ausführungsgedächtnis (Pfad, Größe, Prüfsumme, Richtung).
- **Nicht-Ziel.** Keine Ordner-Synchronisation; Alfred kopiert gezielt einzelne Dateien im Rahmen einer Aufgabe.

## 6. Gehirn: was auf dem Server entsteht

- **Geräte-Registry** (`geraete`: id, user_id, name, plattform, manifest, token_hash, scopes, status, zuletzt_gesehen, erstellt). API: Pairing-Code erzeugen, Geräte auflisten, Scopes setzen, widerrufen.
- **Geräte-Adapter** in `@alfred/messaging`: Plattform `geraet`, Chat-ID = Geräte-ID. Damit sind Zustellung, Rückfragen und Bestätigungen für Geräte dasselbe wie für Telegram. Der Delivery-Scheduler bevorzugt die aktive Sitzung (Leerlauf < 2 min) und fällt auf Telegram zurück.
- **Skill-Proxy.** Für jedes verbundene Gerät registriert das Gehirn einen Skill `geraet_<name>` mit den Aktionen aus dem Manifest. `execute` leitet an das Gerät weiter (Zeitbudget 60 s, Shell 10 min), die Autonomie-Klasse kommt aus dem Manifest und wird vom bestehenden `klassifiziereAktion` nur verschärft. Nicht verbundene Geräte melden „Gerät getrennt seit …" als Ergebnis, kein Fehler im Modell.
- **Weltmodell-Quelle `geraete`** (`normalzustaende/geraete.ts`): je Gerät online/offline, Akku, Zone, Leerlauf. Deutung mit ⚠️ für Akku unter 15 %, getrennt über 3 h, Handy außer Haus bei Bewegung im Haus. Befunde entstehen über den Weltmodell-Beobachter wie bei BMW oder Sensorbatterien.
- **Anwesenheit.** Zone des Handys und Leerlauf des PCs werden Signale des Delivery-Schedulers (`entscheideZustellung`), neben Home Assistant. Grund in der Warum-Begründung: „Owner am PC seit 08:10".
- **Kachel Geräte** in der Web-GUI: Liste, Pairing, Scopes, zuletzt gesehen, letzte Aktionen, Widerruf.

## 7. Satellit: die CLI im Gerätemodus

- **Befehl.** `alfred satellit` (Dienst) und `alfred satellit --install` für Autostart (systemd user unit, launchd agent, Windows-Dienst oder Aufgabenplanung).
- **Lokale Skills je Plattform.** Desktop: file, shell, process, git, screenshot, clipboard, open (Datei, URL, App), notify. Der Skill-Code ist derselbe wie auf dem Server; die Sandbox läuft lokal mit Gerätekonfiguration (erlaubte Verzeichnisse, erlaubte Programme). Handy: siehe Abschnitt 10.
- **Sinne.** Leerlaufzeit und aktives Fenster über Systemabfragen, Akku und Netz über `systeminformation`, Standort auf dem Desktop aus der Netzkennung (Heimnetz = zu Hause), auf dem Handy aus dem Betriebssystem mit Zonen (Haus, Arbeit, unterwegs), Koordinaten nur auf Wunsch.
- **Zustand.** Token im Schlüsselbund, Manifest aus der Konfiguration, Protokoll der letzten 200 Aktionen lokal für die Sitzung.

## 8. Sitzung: eine Oberfläche für Chat, Talk und Bestätigung

- **Terminal (`alfred`).** Ink-Oberfläche (React im Terminal): Statuszeile (Gerät, Verbindung, offene Bestätigungen, Lage-Kurzform), Verlauf, Eingabezeile. Tasten: Enter sendet Text; F9 oder Leertaste halten spricht; j/n bestätigt; l zeigt die Lage; q schließt die Sitzung, der Satellit läuft weiter.
- **Ein Verlauf.** Text, Sprache, Bestätigungsfragen und proaktive Meldungen stehen in derselben Folge, weil es dasselbe Gespräch ist (Gesprächsfaden aus .1203 gilt auch hier).
- **Anhängen statt verbinden.** Die Sitzung spricht über IPC mit dem Satelliten; mehrere Sitzungen sind möglich, die Geräteidentität bleibt eine.
- **Desktop-Fenster (Flutter, Entscheidung 06.10.).** Dieselbe Sitzung mit Fenster, Tray, globalem Tastenkürzel für Push-to-Talk, Benachrichtigungen des Systems. Die App hängt sich per IPC an den Satelliten (CLI-Dienst) wie die Terminal-Sitzung; kein Node in der App.

## 9. Sprache

- **Aufnahme.** Push-to-Talk zuerst; Sprachaktivitätserkennung (lokal, kleines Modell) als zweite Stufe; Wake-Word als dritte Stufe, nur auf Geräten, die der Owner dafür freigibt (Raumgerät).
- **Verarbeitung.** Audio zum Gehirn, Transkription und Synthese über die konfigurierten Anbieter (heute Mistral/Voxtral, Pfad aus .1202). Antwort als Text gestreamt und als Audio, Wiedergabe lokal.
- **Latenz.** Heute 3 bis 8 s (Transkription, Antwort, Synthese nacheinander). Ziel in Stufe 2: Streaming der Antwort und Synthese je Satz, unter 2 s bis zum ersten Ton.
- **Raumgerät.** `alfred talk --wakeword` auf einem Raspberry Pi mit Mikrofon und Lautsprecher ist ein Gerät ohne Sitzung: dieselbe Identität, dasselbe Pairing, Sinne „Raum: Bewegung, Lautstärke".

## 10. Handy-Apps

- **Rahmen.** Flutter (Entscheidung 06.10.), dieselbe Codebasis wie die Desktop-App. Signiert, Store-fähig (App Store über den Apple-Account, Play oder direkte APK).
- **Kein Dienst im Hintergrund.** Betriebssysteme erlauben keine dauerhafte Verbindung. Die App verbindet sich, solange sie offen ist; sonst weckt sie Push (Apple Push, Firebase) mit einem Verweis, worauf die App die Verbindung kurz öffnet. Das Gehirn speichert Push-Token je Gerät.
- **Fähigkeiten.** Benachrichtigung, Standort mit Zonen, Mikrofon, Kamera und Foto senden, Teilen-Ziel (Text, Link, Datei an Alfred), Kalender und Kontakte lesen mit Erlaubnis, auf iOS Kurzbefehle und Siri, auf Android Schnelleinstellung. Keine Shell, keine Dateisystem-Vollzugriffe.
- **Oberfläche.** Dieselbe Sitzung wie im Terminal: Verlauf, Push-to-Talk, Bestätigungen, Lage auf dem Sperrbildschirm als Benachrichtigung.

## 11. Verteilung und Signatur

| Plattform | Paket | Signatur | Weg |
|---|---|---|---|
| Windows | MSIX oder NSIS | Trusted Signing aus Azure Key Vault im Build | direkt oder Microsoft Store |
| macOS | DMG, notarisiert | Developer ID aus dem Apple-Account | direkt oder Mac App Store |
| Linux | AppImage, Debian-Paket | GPG | direkt |
| iOS | IPA | App Store Zertifikat | TestFlight, App Store |
| Android | AAB/APK | Play-Signatur oder eigener Schlüssel | Play oder direkt |

Build in einer GitHub-Actions-Matrix (macOS-, Windows-, Ubuntu-Läufer). Die CLI bleibt wie heute ein npm-Paket; Satellit und Sitzung sind Bestandteile derselben CLI.

## 12. Phasen mit Live-Beweis

1. **Protokoll, Registry, Satellit, Sitzung im Terminal.** Reines Monorepo. Beweis: „Öffne auf meinem PC den Ordner Rechnungen" per Telegram → Bestätigung in der Terminal-Sitzung → Ausführung → Schritt im Ausführungsgedächtnis → Gerät in der Kachel.
2. **Sprache in der Sitzung.** Push-to-Talk, Wiedergabe. Beweis: Sprachfrage im Terminal, gesprochene Antwort, Dauer unter 8 s.
3. **Sinne und Weltmodell.** Leerlauf, Fenster, Akku, Zone. Beweis: Lage zeigt „PC aktiv seit 08:10", Warum nennt „Owner am PC" als Zustellgrund, Befund „Handy seit 3 h getrennt".
4. **Electron-Fenster.** Tray, Tastenkürzel, Benachrichtigungen, Notarisierung und Trusted Signing. Beweis: signierte Installer auf Windows und macOS, Auto-Update.
5. **Android-App, dann iOS.** Chat, Talk, Push, Standortzonen, Teilen-Ziel. Beweis: Meldung mit Grund als Push unterwegs, Sprachantwort von unterwegs, Zone „unterwegs" im Weltmodell.
6. **Linux-Pakete, Raumgerät, Streaming-Sprache.**

Jede Phase ist eine Folge kleiner Releases mit Audit, wie bei Jarvis.

## 12a. Umsetzungsstand Phase 1 (Stand 06.10.2026, v1230)

Freigabe des Owners am 06.10. („ok, freigabe"). Jeder Schritt als eigenes Release mit Live-Beweis, wie bei Jarvis.

| Release | Inhalt | Beweis |
|---|---|---|
| .1224 | Protokoll, Registry (`geraete`), Gateway `/api/geraete/ws`, Pairing per Code, Proxy-Skill `geraet_<name>`, Autonomie-Klassen, Einmal-Freigabe | PC-madh gepaart, `liste` über Chat liefert echte Dateien |
| .1225 | Sicherheitsbefunde: Freigabe-Nonce statt `confirmed`, realpath-Pfadprüfung, DPAPI-Token, Pairing-Drosselung | Tests |
| .1226 | Geräteaktionen umgehen die 7-Tage-Dedupe der Bestätigungs-Queue | „Downloads öffnen" per Telegram bestätigt, ausgeführt 19:42 |
| .1227 | Shell unter Windows über PowerShell | Shell-Aktion am PC |
| .1228 | Autostart-Dienst (Windows Startup-VBS, launchd, systemd --user) | Satellit nach Neustart verbunden |
| .1229 | Browser-Hand (puppeteer-core, eigenes Profil, Element-Karte, Sperren für Kauf/Zahlung/Anmeldung) | amazon.de über den Server geöffnet, 120 Elemente, 15 s |
| .1230 | Vorhaben-Freigabe: ein Ja für viele Schritte (Aktionen, Domains, Dauer), automatische Fortsetzung im Owner-Chat | Bartschneider: Chat → Vorhaben-Frage → Owner-Ja nach 9 s → Suche, Produkt, Einkaufswagen ohne Einzelbestätigung, Bericht nach 54 s |
| .1231 | Fortsetzung nur mit dem Geräte-Skill (`allowedSkills`); Kachel Geräte mit laufenden Vorhaben | Werkzeug-Tokens je Runde 28.876 → 1.028; Vorhaben orf.at 0,19 $ statt 1,11 $ |
| .1232 | Terminal-Sitzung `alfred sitzung`: Chat als Owner, Bestätigungen (/ja, /nein), Satellit mitgelesen oder gestartet; Gerätetoken nur für Sitzungs-Routen | Sitzung auf PC-madh: Ausweis, Bestätigungen, Geräteliste |
| .1233 | Sitzungs-Alias an den Master des Geräts gebunden; Wettlauf beim ersten Kontakt | „Wie heiße ich?" aus dem Owner-Gedächtnis beantwortet |
| .1234 | `delegate` reicht Anhänge der Unter-Skills durch (Owner-Beobachtung: Sprachnachricht kam nie an) | API-Probe: delegate → text_to_speech → Sprachnachricht im Strom |
| .1235 | Dateitransfer Stufe 1: `datei_holen` / `datei_ablegen`, ≤ 8 MB über WebSocket, SHA-256, nie überschreiben | Documents → Server (FileStore-Schlüssel) → Downloads, Inhalt identisch |
| .1236 | Bestätigungs-Queue stellt nach dem Ja auch Anhänge zu | — |
| .1237 | Sinne: Leerlauf, Fenster, Akku jede Minute; Weltmodell-Quelle „Geräte" mit Befunden (getrennt > 3 h, Akku < 15 %); Zustellsignal „Owner am PC" | Sinne von PC-madh im Lebenszeichen, Job `geraete-beobachten` |
| .1238 | Weltmodell-Block trägt Geräte live; Aktion `zustand` (auto) statt Shell mit Bestätigung | „Was macht mein PC gerade?" → ein Werkzeug, keine Bestätigung |
| .1239 | Systemwerte alle 5 min (Laufzeit, Start, RAM, CPU, GPU, Laufwerke; knappes Laufwerk = Befund); nach einer freigegebenen Geräteaktion arbeitet Alfred mit dem Ergebnis weiter | Tabelle mit Laufzeit 13 d, Start 23.09. 03:31, CPU, GPU, RAM, C/E/F; freigegebene Shell → formatierte Programmliste statt Rohausgabe |
| .1240 | Vorhaben überleben einen Neustart (`data/geraete-vorhaben.json`) | Test mit simuliertem Neustart; Realfall 20:52 erklärt |

### Phase 2 — Sprache in der Sitzung

| Release | Inhalt | Beweis |
|---|---|---|
| .1241 | `/talk` (Push-to-Talk, Enter stoppt) → Transkription → Nachricht → Antwort vorgelesen; `/stimme an`; Server `POST /api/sprich`; Audio je Plattform ohne native Module (Windows MCI, macOS sox/afplay, Linux arecord/mpg123) | MCI-Aufnahme 2 s = 62.702 B WAV, Wiedergabe 2,0 s |
| .1242 | STT/TTS-Callbacks wurden vor dem HTTP-Adapter verdrahtet (`/api/transcribe` seit v644 tot) — jetzt mit den übrigen API-Callbacks | `/api/sprich` → mp3, dasselbe Audio → `/api/transcribe` → „Sprachtest, was macht mein PC gerade?" |

| .1243 | Sprachantworten des Modells (text_to_speech ohne Text) werden in der Sitzung abgespielt statt als .bin abgelegt | Owner-Test /talk 22:42 erklärt; lokal „🔊 (Sprachantwort)" |
| .1244 | Stimmen-Kaskade: Owner-Standard (DB, Name → UUID) vor Konfiguration; set_default speichert UUID | /api/sprich spricht mit alfred-jav (01a1129f…); Owner: „hat funktioniert" |
| .1245/.1246 | Strg+T startet/stoppt die Aufnahme; Gerät der Sitzung im Prompt (`metadata.sitzungGeraet`) | „Von welchem Gerät schreibe ich?" → „vom Windows-PC PC-madh über alfred sitzung"; Strg+T-Test ohne Terminal |

| .1247 | Streaming-Sprache Stufe 1: Satzblöcke, nächster Block wird synthetisiert, während der vorige läuft | 3 Blöcke, erster Ton nach 1,8 s |

| .1248 | Streaming-Pfad: Pipeline streamt (Progress `delta`), Router verbucht Stream-Kosten, API nimmt `stream` und `tier`, Sitzung spricht Sätze, während das Modell schreibt; `/tier` | 6 Blöcke während des Schreibens, erstes Wort nach 5,3 s |
| .1249 | Dateitransfer Stufe 2: über 8 MB blockweise über HTTPS (4-MB-Blöcke, Offset, 409 + nächster Offset, SHA-256, Range-Download), bis 50 MB | 20 MB Documents → Server → Downloads, Prüfsumme identisch |

**Sprachmodelle und Anbieter (geprüft 06.10., Live-Listen):** Mistral: `voxtral-mini-2602` (Transkription, in Betrieb), `voxtral-mini-realtime-2602` (Echtzeit-Transkription), `voxtral-mini-tts-2603` (Sprachsynthese, in Betrieb, einzige mit geklonten Stimmen), `voxtral-small` (Audio-Chat). OpenAI: `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` (+diarize), `gpt-4o-mini-tts`, `gpt-audio`, `gpt-realtime`-Familie, `gpt-live-transcribe`. Entscheidung: Mistral bleibt für beides (geklonte Stimme, Latenz reicht). Modellstufen gelten per `/tier` auch in der Sitzung.

### Phase 2b — Echtzeit: Sprechen ohne Taste (freigegeben 07.10.)

Analyse 07.10.: Mistral `voxtral-mini-transcribe-realtime-2602` (WebSocket, PCM 16 kHz mono, `input_audio.append`/`flush`/`end`, `transcription.text.delta`/`done`, Verzögerung 240–480 ms, 0,006 $/min, 13 Sprachen) und OpenAI `gpt-live-transcribe` liefern beide **keine** Sprecherkennung — das Satzende erkennen wir selbst. Mistral bleibt. Reihenfolge: 1 Mikrofonstrom + Satzende-Erkennung lokal, 2 Relais am Server (Schlüssel bleibt dort, Kostenwächter zählt Minuten), 3 `/hören` mit konfigurierbarem Aktivierungswort (Standard „Alfred"), Gesprächsfenster 20 s, Stoppwort, Halbduplex. Taste, `/talk`, Tippen, Telegram bleiben. Lokales Aktivierungswort (wie Alexa) kommt mit der Flutter-App.

| Release | Inhalt | Beweis |
|---|---|---|
| .1250 | Mikrofon als PCM-Strom (Windows waveIn, macOS sox, Linux arecord); `SatzendeErkenner` im Kern mit Tests; `alfred sitzung --mikrofontest N` | 11,5 s Audio in 12 s, 16 kHz; Sprach-Erkennung mit synthetischem Signal getestet, am Mikro noch vom Owner zu bestätigen |

| .1251 | Hör-Relais `/api/geraete/hoeren`: Gerätetoken, PCM-Binärrahmen → Mistral Realtime (eine Verbindung je Sitzung, Flush je Äußerung), Sekunden als Service-Nutzung, Tageslimit; `alfred sitzung --hoertest <wav>` | Synthetisierter Satz durch das Relais: erstes Wort nach 1,55 s, fertig 0,25 s nach Audioende, Text exakt |

| .1252 | `/hören`: Aktivierungswort (Standard „Alfred", tolerant, Füllwort), Gesprächsfenster 20 s, Stoppwort bricht Wiedergabe ab, Halbduplex, `/hören aus`; Preis 0,006 $/min in der Preistabelle | Start/Stopp sauber; Sprechtest am Mikrofon durch den Owner ausstehend |

Phase 2b ist damit in der freigegebenen Reihenfolge umgesetzt. Klein offen: Hinweis „Relais geschlossen" nach eigenem `/hören aus`; Relais-Logzeilen prüfen. Lokales Aktivierungswort ohne Cloud kommt mit der Flutter-App. Danach Ink-Oberfläche.

**Phase 1 ist damit vollständig** (Protokoll, Registry, Satellit, Sitzung, Browser-Hand, Vorhaben, Dateitransfer, Sinne). Noch offen aus Phase 1 im Kleinen: Dateitransfer blockweise für mehr als 8 MB, Gerätename der Sitzung im Prompt. Talk in der Sitzung ist Phase 2; die Sitzung nutzt bis dahin readline statt Ink. Phase 3 (Zone des Handys) kommt mit der Android-App.

### Vorhaben-Freigabe (v1230)

Der Owner wollte nicht jeden Schritt bestätigen. Die Antwort ist kein „alles erlauben", sondern ein **Vorhaben mit Umfang**: Alfred beschreibt in einem Satz, was er vorhat, nennt die Aktionen, die er braucht (auch als Muster wie `browser_*`), die erlaubten Domains und die Dauer (5 bis 120 Minuten). Der Owner bekommt genau eine Frage. Nach dem Ja laufen die genannten Aktionen ohne Einzelbestätigung, jeder Schritt steht mit Vorhaben und Schrittnummer im Ausführungsgedächtnis. Ein Vorhaben ersetzt Bestätigungen, nie Sperren: Kauf, Zahlung, Anmeldung und Passwortfelder bleiben beim Owner, deterministisch im Satelliten geprüft. Mit der Freigabe setzt Alfred das Vorhaben von selbst fort, als Nachricht im Owner-Chat wie eine geplante Aufgabe, und berichtet am Ende.

## 13. Risiken

- **Erreichbarkeit von außen** ist Voraussetzung für alles Mobile. Entscheidung WireGuard oder Proxy mit Gerätetoken.
- **Handeln auf dem Desktop ist mächtig.** Darum Standard `bestaetigen`, Scopes je Gerät, Verzeichnis-Grenzen, vollständiges Protokoll. Shell nur mit Freigabe des Owners, nie auf dem Handy.
- **Apple-Hintergrundgrenzen.** iOS bleibt Sprech- und Sinnesorgan; keine Versprechen, die das System nicht hält.
- **Audio auf dem Desktop** hängt von Systemwerkzeugen ab; Phase 2 prüft je Plattform, welche Aufnahme-Bibliothek ohne Native-Build auskommt.
- **Kosten.** Jede Sprachrunde kostet Transkription, Modellaufruf und Synthese; der Kostenwächter deckt es, die Lage im Prompt hält Antworten kurz.

## 14. Entscheidungen des Owners (06.10.2026, noch keine Freigabe zur Umsetzung)

1. **Erreichbarkeit:** vorerst VPN (WireGuard auf der Dream Machine). Geräte brauchen ein Always-on- bzw. On-Demand-Profil; der Server bleibt intern.
2. **App-Rahmen: Flutter.** Folge: Die Apps für Windows, macOS, Linux, iOS und Android sind EINE Flutter-Codebasis. Es gibt kein Electron. Die Desktop-App bettet kein Node ein, sondern hängt sich wie die Terminal-Sitzung per IPC an den Satelliten (CLI-Dienst). Handy-Apps sprechen direkt mit dem Gehirn. Protokoll-Typen entstehen einmal in TypeScript und werden als JSON-Schema für Dart generiert, damit es eine Quelle der Wahrheit gibt.
3. **Reihenfolge:** Phase 1 und 2 (Protokoll, Satellit, Terminal-Sitzung, Sprache) zuerst auf dem Windows-PC des Owners, aber von Beginn an für macOS und Linux gebaut: Satellit und Terminal-Sitzung sind Node und laufen auf allen drei; plattformspezifisch sind nur die Sinne (Leerlauf, aktives Fenster, Akku) und die Autostart-Registrierung. Beweise auf Mac und Linux folgen in derselben Phase.
4. **Shell am Desktop: ja,** mit Verzeichnis-Grenzen, erlaubten Programmen und Standard `bestaetigen`; `nie` für Löschen außerhalb der freigegebenen Verzeichnisse und für Systemänderungen. Auf dem Handy keine Shell.
5. **CLI:** bleibt das Kernprogramm und wird zuerst gebaut. Ein npm-Paket mit den Rollen `start` (Gehirn), `satellit` (Dienst), `alfred` (Sitzung: Chat, Talk, Bestätigung), `pair`. Die Flutter-Apps sind Oberflächen über demselben Protokoll; sie ersetzen die CLI nicht, sie setzen auf ihr auf.

6. **Flutter gegen Electron, erneut geprüft (06.10.):** Weil die CLI der Satellit ist, entfällt Electrons Hauptvorteil (Node im Prozess). Flutter bleibt richtig für fünf Plattformen aus einer Codebasis. Der einzige Nachteil, die React-Kacheln sind nicht übertragbar, wird durch den **Hybrid** aufgehoben: Die Flutter-App baut die Sitzung nativ (Verlauf, Push-to-Talk, Bestätigungen, Lage, Tray, Tastenkürzel) und zeigt die Kacheln Lebenszeichen, Vorgänge, Befunde und Geräte in einem eingebetteten Browserfenster aus der bestehenden Web-GUI. Einzelne Kacheln können später nativ nachgezogen werden.

**Geänderte Phasen durch Flutter:** Phase 4 wird „Flutter-Desktop-App für Windows, macOS, Linux" (statt Electron), Phase 5 bleibt Android, dann iOS, aus derselben Codebasis.

## 15. Einordnung in Jarvis

| Schicht | Gewinn durch Geräte |
|---|---|
| 0 Lebenszeichen | Geräte sind Jobs mit Puls; getrennt = Befund |
| 1 Weltmodell | Quelle `geraete`: Zone, Leerlauf, Akku, Fenster; Anwesenheit wird messbar |
| 2 Ereignisse | Zonenwechsel, Leerlauf-Ende, Akku-Schwelle lösen Mini-Pässe aus |
| 3 Vorgänge | Geräteaktionen sind Schritte mit Autonomie und Rücknahme; Befunde für Geräte |
| 4 Messen | Kennzahlen je Zustellweg, Sprachrunden, Bestätigungsquote je Gerät |
| Interaktion | Ein Gespräch über alle Wege; Lage auf dem Sperrbildschirm; Warum auch für Geräteaktionen |


## 16. Aktualisierung der Geräte (freigegeben und umgesetzt 07.10.2026, .1258–.1265)

Der Server ist die Quelle: beim Start packt er sein installiertes Paket nach `data/releases/<Version>.tgz`, signiert die SHA-256-Prüfsumme mit einem Ed25519-Schlüssel (`data/release-key.json`) und liefert `GET /api/geraete/update` (Version, Prüfsumme, Signatur) sowie den Tarball unter `…/update/datei`, beides mit Gerätetoken. Der öffentliche Schlüssel geht mit dem Willkommen an die Geräte und wird beim ersten Kontakt gemerkt; weicht er später ab, lehnt das Gerät Updates ab.

Der Satellit vergleicht nach dem Willkommen die Serverversion mit seiner eigenen, lädt im Leerlauf, prüft Prüfsumme und Signatur, installiert nach `~/.alfred/cli/<Version>` (npm mit eigenem Präfix, ohne sudo) und beendet sich mit Code 75. Der global installierte `alfred` ist der Starter: er führt im Dienstmodus die neueste bestätigte Version als Kindprozess aus und startet bei Code 75 die neue. Eine frische Version gilt zehn Minuten als Probe; meldet sie sich beim Server, ist sie bestätigt, sonst fällt der Starter auf die vorige zurück. Dienst-Einträge (launchd, systemd, Autostart-VBS) zeigen auf den Starter und bleiben unverändert.

Beweis 07.10. 12:44: PC-Satellit 1263 erkannte Server 1265, lud 9,8 MB, prüfte, installierte in 45 s; der über den Autostart gestartete Starter führte 1265 aus, bestätigt. Erkannte Fallen: Wettlauf beim Server-Neustart (Server packt jetzt sofort und meldet nie eine fremde Version; Satellit versucht bis zu zehnmal), Symlink-Programmpfad auf dem Server, Installer-Start unter Windows jetzt über das VBS.

### 16.1 Alfred aktualisiert sich selbst (freigegeben und umgesetzt 07.10.2026, .1266)

Quelle ist ein Tarball im Eingang `data/updates/<Version>.tgz` mit Begleitdatei `.sha256` (abgelegt über SSH, die Prüfsumme kommt vom Build) oder das npm-Register (Tag oder Version; npm prüft die Integrität). Der Skill `selbstupdate` zeigt auf „gibt es ein Update" die laufende Version, den Eingang und die npm-Tags; auf „aktualisiere dich" stellt er die Frage an den Owner (Bestätigungs-Queue, Einmal-Freigabe an die Version gebunden). Nach dem Ja: Paketname, Version und Prüfsumme prüfen, nach `~/.alfred/cli/<Version>` installieren, Startprobe (`--version`), dann warten, bis kein Pass-Fenster (:57–:02, :27–:32), kein Vorhaben und keine Hör-Sitzung läuft (höchstens 60 Minuten), und sauber mit Code 75 beenden. Der globale `alfred start` ist der Starter (wie bei den Satelliten): er führt die neue Version als Kind aus; sie bestätigt sich nach zwei Minuten Lebenszeichen und meldet das dem Owner. Stürzt die Probe ab, markiert der Starter sie sofort als gescheitert und startet die vorige Version, die den Fehlschlag meldet. Nach der Bestätigung werden ältere Installationen entfernt. Die Suite läuft vor dem Packen; der Tarball enthält keine Tests, deshalb ist die Startprobe die Prüfung im Paket.

Beweis 07.10. 14:09–14:12: Chat „aktualisiere dich" → Frage beim Owner → Ja → 1267 geprüft, installiert (13 s), Startprobe, Neustart 14:10:05 (Code 75, systemd startete den Starter) → 1267 lief als Kind, Lebenszeichen bestätigt 14:12:17, Meldung beim Owner; PC-Satellit erkannte 1267 und folgte in zwei Minuten automatisch. `npm ls -g` zeigt seither nur den Starter (1266); die laufende Version steht in `/root/.alfred/cli/aktuell.json`.

Noch offen: Flutter-App über denselben Endpunkt mit signierten Installern; Handy über die Stores.


## 17. CLI-Ausbau vor jeder App (freigegeben 07.10.2026)

Der Owner hat die Reihung freigegeben; Punkt 4 (Tastatur und Maus) braucht eine eigene Entscheidung.

1. **Bildschirm sehen — umgesetzt .1268/.1269.** Aktion `bildschirm` (ganzer Bildschirm oder aktives Fenster, JPEG auf 1600 px, Fenstertitel) auf Windows, macOS, Linux. Das Modell sieht Bilder aus Werkzeugergebnissen selbst (Bildblöcke hinter den tool_result-Blöcken, höchstens drei je Runde, nie in der Historie). Beweis 14:45: „Schau auf meinen PC-Bildschirm" → Foto in 3 s → Alfred beschrieb das Terminalfenster korrekt bis in Details (Version, Exit-Codes, Hooks). Fallen: Windows Defender blockt P/Invoke plus CopyFromScreen in einem Skript und CopyFromScreen mit JPEG-Qualitätsparameter (deshalb zwei Aufrufe, ohne Parameter); der OpenAI-Kontinuitätsmodus ließ Nutzer-Items der letzten Nachricht weg (.1269). Sicherheit: Geräte-Skills prüfen den Aufrufer, nur der Owner bedient seine Geräte. macOS braucht die Berechtigung „Bildschirmaufnahme" für den Satelliten.
2. **Programme und Fenster — umgesetzt .1271.** Aktionen `fenster` (Liste mit Titel und Programm, auto), `fenster_vordergrund` (Suchtext, auto), `programm_starten` (Name, App oder Pfad plus Argumente, bestaetigen wie Shell). Windows über PowerShell und SetForegroundWindow, macOS über System Events und open, Linux über wmctrl. Beweis 15:21–15:23: „Welche Fenster sind offen? Hol Docker Desktop in den Vordergrund" → 17 Fenster gelistet, Docker vorne; „Starte mspaint" → Bestätigung → Paint lief 20 s später. Hinweis: Windows-11-Notepad ist Einzelinstanz, „starten" öffnet dort nur einen neuen Tab.
3. **Freigaben aus dem Chat — umgesetzt .1272.** Aktionen `freigaben` (Liste mit Recht, auto) und `freigabe_aendern` (pfad, recht = lesen | schreiben | keins, bestaetigen). Nur-lesen-Verzeichnisse (`nurLesen` in geraet.json) erlauben liste, öffnen, datei_holen; datei_ablegen und shell brauchen Schreibrecht; bisherige Freigaben behalten beide Rechte. Beweis 15:52: „Gib C:/Users/madh/Pictures nur zum Lesen frei" → Bestätigung → Liste zeigt Pictures als „nur lesen", Ordner wird gelistet; shell und datei_ablegen dort werden abgewiesen. Hinweis Chat-API: Pfade mit Schrägstrich, Backslashes zerlegen das JSON.
4. **Tastatur und Maus** nur im Vorhaben mit Bildschirmprobe je Schritt. Eigene Owner-Entscheidung.
5. **Zwischenablage — umgesetzt .1273.** `zwischenablage_lesen` (bestaetigen: dort liegen oft Passwörter, der Text geht an das Modell) und `zwischenablage_setzen` (auto). Windows Get-/Set-Clipboard mit Text über stdin und bis zu zehn Versuchen (RustDesk/VNC sperren die Zwischenablage kurz), macOS pbpaste/pbcopy, Linux wl-clipboard oder xclip. Beweis 16:0x: „kopier mir … in die Zwischenablage" → gesetzt; „was habe ich kopiert" → Bestätigung → Text. **Systembenachrichtigungen bleiben offen:** Windows gibt den Benachrichtigungs-Listener nur Apps mit Paket-Identität, macOS hält sie in einer geschützten Datenbank; kommt mit der Flutter-App.
6. **Linux-Satellit — bewiesen 07.10. 15:57.** test-ubuntu (.96, Ubuntu 24.04, Node 22, headless) gekoppelt per Tarball + `alfred pair --insecure --verzeichnisse /home/ubuntu`, Dienst als systemd-Benutzerdienst mit `loginctl enable-linger`. Chat: Zustand (Uptime seit 04.10., 4 GB von 8 GB RAM frei) und Liste von /home/ubuntu stimmen; Fensterliste meldet ehrlich „wmctrl fehlt" (kein Display). Autoupdate läuft wie bei PC und Mac.

### 17.1 Satellit entkoppeln (.1274, Owner-Frage 07.10.)

Zwei Wege. Am Gerät: `alfred satellit --entkoppeln` widerruft das Token im Gehirn (`POST /api/geraete/abmelden` mit Gerätetoken), entfernt `~/.alfred/geraet.json`, die installierten Versionen unter `~/.alfred/cli` und den Autostart-Dienst (Windows Autostart-VBS, macOS launchd, Linux systemd --user). Im Chat: „Alfred, entkopple <Gerät>" → Bestätigung → der Satellit entfernt sich selbst und beendet sich, das Gehirn widerruft das Token. Widerrufene Geräte verschwinden aus Kachel und Weltmodell, der Skill `geraet_<name>` ist weg. Die globale CLI bleibt auf dem Gerät (`npm uninstall -g @madh-io/alfred-ai`), ebenso das Browser-Profil unter `~/.alfred/browser-profil`. Neu koppeln geht jederzeit mit `alfred pair`.
