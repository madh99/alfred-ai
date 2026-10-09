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

**Umsetzungsstand §8 (08.10.2026, .1302, Owner-Freigabe „punkt 1 und 2"):** Recherche vorab: v1232 baute die Sitzung ohne IPC — Chat und Bestätigungen laufen per HTTP mit Gerätetoken direkt zum Server (keine zweite WebSocket-Verbindung), der Satellit wurde nur über sein Protokoll per Regex mitgelesen; ein Grund für das Verschieben stand nirgends, das IPC war schlicht nicht nötig, solange die Sitzung nichts vom Satelliten brauchte. Jetzt: `packages/cli/src/commands/satellit-ipc.ts` — der Satellit öffnet `~/.alfred/satellit.sock` (0600) bzw. `\\.\pipe\alfred-satellit-<Benutzer>`, JSON-Zeilen `status` (Name, Version, PID, verbunden, Serverversion, laufende Aktionen), `ereignis` (verbunden, getrennt, aktion, ergebnis, update), `bestaetigung`; Befehle `status`, `beenden`. Die Sitzung hängt sich an (`verbindeIpc`), Rückfall auf das Protokoll bei älterem Satelliten, Abschaltung `ALFRED_KEIN_IPC=1`. Bestätigungen: `ConfirmationQueue.beiNeu` → `GeraeteGateway.sendeAnAlle({ typ: 'bestaetigung' })` über die bestehende Satellitenverbindung → IPC → Sitzung; die 4-s-Abfrage bleibt für Erledigtes und als Rückfall. Chat und Entscheidungen weiter per HTTP (bewusst, s. o.).

**Beweis 08.10. 10:30 (PC-madh, Satellit 1302 als Dienst, Sitzung per node gestartet):** Startzeile „Satellit: Dienst läuft, angehängt über IPC", Statuszeile „⚙ Satellit 0.19.0-jarvis.1302 (PID 7352) verbunden mit Alfred 0.19.0-jarvis.1302" sofort. Chat als Owner „Öffne auf PC-madh den Ordner Downloads" um 10:30:25 → die Sitzung zeigte „🔔 Bestätigung [2] (Gerät) Auf PC-madh: oeffnen path=~/Downloads" noch bevor Alfreds Antwort „Zur Bestätigung gestellt" um 10:30:34 kam (Push, nicht Abfrage). Nach Freigabe per API: „⚙ Aktion oeffnen", „⚙ oeffnen: Fehler: Pfad nicht freigegeben: ~/Downloads …", „✓ Bestätigung erledigt" (Abfrage). Nebenbefund: das Modell übergab `~/Downloads`, der Satellit löst `~` beim Pfadrecht nicht auf (Freigaben stehen absolut) — eigener kleiner Punkt. Ink-Oberfläche (§8 Punkt 3): umgesetzt in .1303, s. u.

**.1303 (Owner-Freigabe „freigabe für die tilde und punkt 3"):** Die Sitzungslogik spricht nur noch mit der Schnittstelle `Oberflaeche` (`sitzung-oberflaeche.ts`: drucke, fluechtig, antwortDelta/NeuerAnlauf/Ende, status, prompt, aufEingabe, aufTaste). Dahinter stehen `ReadlineOberflaeche` (bisheriges Verhalten, Rückfall) und `InkOberflaeche` (`sitzung-ink.tsx`, ink 8 + react 19.3): Verlauf als `Static` (scrollt mit dem Terminal), laufende Antwort mit Kopfzeile, flüchtige Zeile, Statuszeile (Gerät, Version, Satellit mit ●/○, offene Bestätigungen, Stufe, 🔊, 🎧, Modus) und Eingabezeile. Tasten: Enter sendet, Strg+T spricht, Alt+J/Alt+N beantworten die jüngste Bestätigung, Strg+L Lage, Strg+Q Ende — die Spec-Tasten j/n/l/q kollidieren mit dem Tippen („ja, mach das", „lies …"), darum Alt/Strg. Ink nur mit echtem Terminal (Rohmodus), sonst readline; `--einfach` und `ALFRED_SITZUNG_EINFACH=1` erzwingen readline. Test mit falschem Terminal: Rahmen enthält Status/Verlauf/Antwort, Eingabe „hi"+Enter, Tasten Strg+T/Strg+L/Alt+J/Strg+Q. Beweise 08.10.: readline-Modus und automatischer Rückfall ohne Terminal mit dem 1303-Bundle gegen den laufenden Satelliten (IPC-Status, Bestätigungen) — die Ink-Darstellung selbst braucht ein echtes Terminal — Owner 08.10. ~11:00: „ink funktioniert auf mac und pc". §8 damit vollständig (Punkt 1 IPC, Punkt 2 Push, Punkt 3 Ink).

**.1304 — `alfred` im PATH ohne globales npm-Paket (Owner „freigabe für punkt 4"):** `satellit-starter.ts` legt bei `--install` (oder allein mit `--starter`) in `~/.alfred/bin` den Starter ab — `alfred-start.js` liest `aktuell.json` (bei gescheiterter Probe die vorige Version) und führt die installierte Version aus, `alfred.cmd` bzw. `alfred` rufen ihn mit dem Node des Dienstes auf — und ergänzt den PATH des Benutzers (Windows: Benutzer-Registry ohne setx-Kürzung; macOS/Linux: Zeile in .zshrc/.bashrc). Beweis PC 08.10. 11:20: Starter angelegt, PATH ergänzt, `alfred --version` über den Starter liefert die installierte Version. Die gestartete Version reicht wie bisher selbst an neuere Installationen weiter (Starter-Logik in index.ts).

**.1305 — Ink-Sitzung ausgebaut (Owner „ok 1-4", live 11:35):** (1) Eingabe wie ein Editor — Cursor ←/→, Pos1/Ende, Strg+A/E, Strg+W Wort, Strg+U Zeile, Esc leert, ↑/↓ Verlauf gesendeter Eingaben, Einfügen über den Paste-Modus des Terminals (`usePaste`), Alt+Enter bzw. Shift+Enter neue Zeile (`eingabeTaste` rein, getestet). (2) Kasten „Offene Bestätigungen" über der Eingabe: Nummern wie /offen, Quelle, Alter („vor 2 min"), jüngste fett (`SitzungStatus.offenListe`, aus sitzung.ts bei jeder Änderung). (3) Markdown-Stücke in Verlauf und laufender Antwort (`markdownZeile`: **fett**, `code` gelb, Aufzählungen als •, Überschriften unterstrichen), Zeitstempel an ⚙/🔔/✓-Zeilen, Spinner „⠋ antwortet" in der Statuszeile. (4) Statuszeile umbricht, Hinweiszeile erst ab 70 Spalten, Terminal-Größenänderung beachtet. Tests mit falschem Terminal decken Cursor („ab", ←, „x" → „axb"), ↑-Verlauf, Einfügen, Alt+Enter, Feld und Markdown ab; readline-Rückfall mit dem 1305-Bundle live geprüft. Ink-Darstellung: Owner-Test.

**.1306 — Owner-Befund (Ink auf Mac und PC geprüft):** Alt+Enter kommt nicht an — Windows Terminal nimmt es für Vollbild, Terminal.app schickt für Option+Return nur ``. Neue Zeile jetzt **Strg+N** oder **`` am Zeilenende + Enter** (beides terminalunabhängig); Alt+Enter/Shift+Enter bleiben, wo sie durchgereicht werden. Bestätigungen: **Strg+B** blendet das Feld ein, nimmt den Fokus, blendet aus (Kreislauf); im Fokus **↑/↓** wählen (▶, invers), **Enter/J** freigeben, **N/Rücktaste** ablehnen, **Esc** zurück; `aufTaste(t, nr)` trägt die gewählte Nummer, `/ja n` und Alt+J/Alt+N bleiben. Tests: Strg+N und Backslash ergeben „a
b
c", Fokus-Auswahl liefert [ja 1] und [nein 2], Aus-/Einblenden.

**.1307 (Owner-Fragen, Freigabe 1–3):** Die Sitzung behält ihre Startversion — meldet der Satellit per IPC eine neuere, steht „(neuer als die Sitzung)" in der Statuszeile plus Hinweis zum Neustart (Owner sah „1305", weil seine Sitzung aus dem Repo-dist gestartet war). Strg+G schaltet /hören ein und aus (Strg+H wäre die Rücktaste). `alfred chat` öffnet auf gekoppelten Geräten die Sitzung, sonst den alten Server-Chat.

**.1308 — Realfall PC 12:34: Satellit nach Update tot.** Der Autostart (VBS) zeigte auf `F:sourcesalfredpackagesclidistindex.js` — der Owner hatte den Dienst aus dem Repo installiert; nach dem 1307-Update kam kein Starter zurück (kein Prozess, kein Protokoll). Diagnose: `Get-CimInstance Win32_Process` ohne `satellit --dienst`, VBS-Inhalt. Sofortmaßnahme: `--install` aus der installierten 1307 (VBS → Versionsordner, Satellit 12:41 zurück). Dauerhaft .1308: Dienst-Einträge (VBS, plist, unit) zeigen auf `~/.alfred/bin/alfred-start.js`; im Dienstmodus eine Schleife — 75 → sofort aktuelle Version aus aktuell.json, Absturz → 5 s…60 s (nach 10 min stabil zurück auf 5 s), > 50 Neustarts/h → Ende; `[starter]`-Zeilen im Protokoll. `--install` startet keinen zweiten Satelliten, wenn einer läuft (Eintrag gilt ab dem nächsten Start). PC-VBS 12:45 auf den Starter umgestellt. LEKTION: Dienst nie aus dem Repo-dist installieren; Versionsordner werden aufgeräumt, nur der Starter ist stabil. Office-VM und Mac: Einträge zeigen auf das globale npm-Paket (stabil), bekommen die Absturz-Schleife erst nach einem erneuten `alfred satellit --install`.

**.1309 — Einstellungen des Satelliten (Owner „fehlt eine setup bzw config oberfläche", Freigabe „danach 4"; live 12:56):** `satellit-einstellungen.ts` = Liste (Gerät, Server, Freigaben mit Recht, gesperrte Fenster, Foto-Sperre, Aktivierungswort, Fenstertitel in den Sinnen, Sitzungs-Oberfläche) und textuelle Befehle `freigabe <pfad> lesen|schreiben|keins`, `fenster-sperre +|- <muster>`, `foto-sperre +|- <muster>`, `wort <Wort>`, `sinne-fenster an|aus`, `oberflaeche ink|einfach` (`wendeAn`, getestet). Drei Zugänge über denselben Weg (`sitzung-einstellungen.ts`: speichereKonfig + IPC-Befehl `neuladen`, der Satellit macht `Object.assign(k, ladeKonfig())` und verwirft die Bedienung-Instanz für die neue Sperrliste): Strg+E in der Ink-Sitzung (Bild: ↑/↓, Enter öffnet/umschaltet, Einträge mit Enter lesen↔schreiben, Entf/- entfernen, + hinzufügen, Textfeld fürs Wort, Esc), `/einstellungen [befehl]` in jeder Sitzung, `alfred einstellungen [befehl]` ohne Sitzung. `GeraetKonfig` typisiert jetzt `aktivierungswort`, `sinneOhneFenster`, `sitzungEinfach` (letzteres startet die Sitzung in readline). Beweis PC 12:57: Liste, `foto-sperre + Testmuster` → geraet.json und Satellitenprotokoll „Einstellungen neu geladen", `- Testmuster` → wieder leer. Server und Kopplung bleiben bei `alfred pair`/entkoppeln. Hinweis: „laufende Satellit-Prozesse: 2" ist seit .1308 normal (Starter + Kind).

**.1310 — Leiste statt Rahmen (Owner-Screenshot seines Terminals, live 13:35):** eine Zeile über der Eingabe, links knapp Gerät · Version · Satellit ●/○ · Stufe, rechts Abzeichen nur für das, was gerade zählt: „🔔 2 Bestätigungen · Strg+B" (gelb, nur bei ausgeblendetem oder leerem Feld), „⬆ Satellit 1310 · Sitzung neu starten" (grün), Spinner mit Antwortdauer (cyan), „● Aufnahme", „🎧 hört zu", „🔊 liest vor"; darunter Trennlinie und „>"-Prompt. Owner hat `alfred satellit --install` auf Mac und Office-VM gemacht → beide haben die Starter-Schleife (.1308). Weitere Ink-Ideen (nicht umgesetzt): Tab-Vervollständigung der /-Befehle, Eingabeverlauf über Sitzungen hinweg, Alt+↑/↓ zum Blättern im Verlauf bei kleinen Terminals, Fenstertitel mit Bestätigungszahl. Tilde: `satellit-pfad.ts` löst `~`/`~/…` in path, pfad, datei, cwd auf (Test).

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
5. **Zwischenablage — umgesetzt .1273.** `zwischenablage_lesen` (bestaetigen: dort liegen oft Passwörter, der Text geht an das Modell) und `zwischenablage_setzen` (auto). Windows Get-/Set-Clipboard mit Text über stdin und bis zu zehn Versuchen (RustDesk/VNC sperren die Zwischenablage kurz), macOS pbpaste/pbcopy, Linux wl-clipboard oder xclip. Beweis 16:0x: „kopier mir … in die Zwischenablage" → gesetzt; „was habe ich kopiert" → Bestätigung → Text. **Systembenachrichtigungen — umgesetzt .1275, die erste Einschätzung war falsch:** Windows hält die Toasts in der Datenbank des Benutzers (`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`, SQLite); der Satellit liest eine Kopie mit `node:sqlite` (Node ≥ 22.13). macOS über die usernoted-Datenbank mit sqlite3 und plutil (ggf. Voller Festplattenzugriff). Aktion `benachrichtigungen` (Stunden, Anzahl) mit Bestätigung. Linux ohne zentralen Speicher, Aktion fehlt dort. Beweis 18:3x: „welche Benachrichtigungen kamen heute auf meinem PC" → Bestätigung → Liste mit App, Zeit, Titel, Text.
6. **Linux-Satellit — bewiesen 07.10. 15:57.** test-ubuntu (.96, Ubuntu 24.04, Node 22, headless) gekoppelt per Tarball + `alfred pair --insecure --verzeichnisse /home/ubuntu`, Dienst als systemd-Benutzerdienst mit `loginctl enable-linger`. Chat: Zustand (Uptime seit 04.10., 4 GB von 8 GB RAM frei) und Liste von /home/ubuntu stimmen; Fensterliste meldet ehrlich „wmctrl fehlt" (kein Display). Autoupdate läuft wie bei PC und Mac.

### 17.1 Satellit entkoppeln (.1274, Owner-Frage 07.10.)

Zwei Wege. Am Gerät: `alfred satellit --entkoppeln` widerruft das Token im Gehirn (`POST /api/geraete/abmelden` mit Gerätetoken), entfernt `~/.alfred/geraet.json`, die installierten Versionen unter `~/.alfred/cli` und den Autostart-Dienst (Windows Autostart-VBS, macOS launchd, Linux systemd --user). Im Chat: „Alfred, entkopple <Gerät>" → Bestätigung → der Satellit entfernt sich selbst und beendet sich, das Gehirn widerruft das Token. Widerrufene Geräte verschwinden aus Kachel und Weltmodell, der Skill `geraet_<name>` ist weg. Die globale CLI bleibt auf dem Gerät (`npm uninstall -g @madh-io/alfred-ai`), ebenso das Browser-Profil unter `~/.alfred/browser-profil`. Neu koppeln geht jederzeit mit `alfred pair`.


## 18. Bedienen: Tastatur und Maus (§17 Punkt 4; Owner 07.10.: „ausarbeiten und umsetzen")

Grundlage ist die Recherche vom 07.10. (Memory „computer-use-recherche-2026-10"): Schnittstelle vor Oberfläche, Bedienhilfen-Baum vor Pixeln, Prüfung nach jedem Schritt, eigene Arbeitsfläche, Mensch im Kreis für Unumkehrbares.

### 18.1 Stufe A — Element-Karte (umgesetzt .1276, Windows)

- `fenster_lesen` liest das aktive Fenster (oder eines nach Titel) über Windows UI Automation als nummerierte Element-Karte: Typ, Name, Wert, Zustand, Passwortkennzeichen. Nur sichtbare, aktive Bedienelemente; höchstens 150. Dauer 0,2 bis 0,5 s.
- `element_klicken` betätigt per Nummer über die Muster Invoke, Toggle, Select, Expand, DefaultAction; letzter Rückfall Fokus plus Leertaste. Kein Mausklick nach Koordinaten.
- `tippen` schreibt per ValuePattern, sonst Fokus und SendKeys; optional Enter. `taste` sendet Kombinationen (strg+s, alt+f4, enter, f5); die Windows-Taste bleibt gesperrt.
- Sicherungen im Satelliten, modellunabhängig: Karte verfällt nach jeder Aktion und nach 45 s; Passwortfelder gesperrt; gesperrte Fenster nach Titelmuster (Standard: Banking, PayPal, Zahlung, Checkout, Kasse, Bezahlen, Anmelden bei, Sign in; `gesperrteFenster` in geraet.json); Notbremse: eigene Eingabe des Owners nach der letzten Alfred-Aktion bricht ab. Alle verändernden Aktionen sind `bestaetigen`; ein Vorhaben deckt die Folge mit einer Frage.
- Ablauf für das Modell: fenster_vordergrund → fenster_lesen → Aktion → fenster_lesen → bei Bedarf bildschirm zur Kontrolle.
- **Beweis 07.10. 20:28 (Owner ließ den PC in Ruhe):** Chat „Starte den Rechner und rechne 12 mal 7 über die Tasten" → Alfred legte selbst ein Vorhaben an (programm_starten, element_klicken, tippen, taste, bis 20:37) → Ja → Rechner gestartet, fünfmal Karte lesen und Taste betätigen (1, 2, ×, 7, =) in 45 s, Antwort „Ergebnis aus der Anzeige: 84". Unabhängig geprüft: die Anzeige des Rechners stand auf 84. Lektion .1277: Beschreibungen im Manifest sind auf 300 Zeichen begrenzt, 1276 wurde deshalb abgewiesen; der Satellit kürzt jetzt selbst. Offen: ein Satellit, dessen Manifest abgewiesen wird, muss sich beenden, damit der Starter zurückfallen kann (heute Endlosschleife, manuell gelöst).
- Grenzen: Task-Manager und andere erhöhte Programme liefern keinen Baum; Electron-Apps teils magere Bäume (Edge, Chrome, VS Code sind gut); Spiele und eigengezeichnete Oberflächen gar nicht.

### 18.2 Stufe B — Foto mit Markierungen (erster Teil umgesetzt .1279)

`bildschirm` mit `markieren=true` zeichnet Nummern und Rahmen der letzten Element-Karte ins Foto (Windows; UIA-Rechtecke und Aufnahme teilen bei 100 % Skalierung die Koordinaten, bei anderer Skalierung rechnet der Satellit um). Damit sieht das Modell, was es betätigt, und prüft das Ergebnis im Bild. **Klick nach Fotokoordinaten (.1281):** `klicken_bei` mit x, y aus dem letzten Foto (höchstens 60 s alt), umgerechnet auf den Bildschirm; der Klick wird nur ausgeführt, wenn an der Stelle das Vordergrundfenster liegt (Befund 07.10.: Klick auf verdecktes Fenster traf das Terminal davor). Optionale Foto-Sperre `fotoSperre` (Titelmuster), standardmäßig aus. Offen: Rahmen aus Bilderkennung für Fenster ohne Baum (OmniParser-Klasse). Hinweis Datenschutz: Bildschirmfotos gehen an den Modellanbieter; auf dem Schirm sichtbare Geheimnisse (z. B. eine offene .env im Editor) wandern mit. Der Owner entscheidet, wann er fotografieren lässt.

### 18.3 Schnittstellen vor Oberfläche — Office über COM (.1292–.1294, Owner 08.10.: „office-com mit lesen")

Owner 07.10.: nutzt klassisches und neues Outlook; auf dem PC ist kein Mailkonto eingerichtet, auf dem Mac und der Office-VM schon. Dritter Satellit „Office-VM" (Windows 11, Office 365 ProPlus, klassisches Outlook) gekoppelt 08.10. 00:35.

**Umgesetzt (`packages/cli/src/commands/satellit-office.ts`):** PowerShell-Skripte als `-EncodedCommand` gegen `Outlook.Application` (MAPI-Namespace) und `Excel.Application`, Ergebnis als JSON in der letzten Zeile. Aktionen nur auf Windows und nur, wenn die Registry sie trägt:

| Aktion | Autonomie | Inhalt |
|---|---|---|
| `outlook_mails` | auto | Posteingang/Entwürfe/Gesendet, neueste zuerst (max. 50), optional nur ungelesen oder Suchtext; mit `id` eine Mail vollständig (Text bis 6000 Zeichen, Anhänge mit Namen) |
| `outlook_entwurf` | bestaetigen | neu oder Antwort (`antwortAuf`), `.Save()` + `.Display()`, nie gesendet; Anhänge nur aus Freigaben |
| `outlook_senden` | bestaetigen | eigener Schritt für einen Entwurf (`.Send()`), bereits Gesendetes wird abgelehnt |
| `outlook_termine` | auto | Kalender heute + 7 Tage (oder von/bis), `IncludeRecurrences`, max. 100 |
| `outlook_termin_anlegen` | bestaetigen | Termin gespeichert, Einladungen werden nicht versendet |
| `excel_lesen` | auto | Datei aus Freigabe, unsichtbar und nur lesend, benutzter Bereich oder A1:F20, max. 200 × 30 Zellen |
| `excel_schreiben` | bestaetigen | eine Zelle (Wert oder Formel), nur in Verzeichnissen mit Schreibrecht, speichert |

**Erkennung:** Outlook nur mit COM-Klasse `HKCR\Outlook.Application` UND einem Mailkonto im Profil: REG_BINARY `{ED475418-B0D6-11D2-8C3B-00104B2A6676}` im Kontenverwalter `…\Profiles\<Profil>\9375CFF0413111d3B88A00104B2A6676` ist nicht leer (PC-madh: leer, nur Adressbuch → kein Outlook, sonst öffnet COM den Einrichtungsdialog; Office-VM: 02000000 = zwei Konten). Ein Wert „Email" existiert bei Exchange-Konten nicht (.1292 erkannte darum nichts, .1293 behoben). Excel über `HKCR\Excel.Application`. Manifest-Grenze des Gehirns 30 → 40 Aktionen (Office-VM meldet 34).

**Beweise 08.10.:** `excel_lesen` auf PC-madh 01:48 (Blatt Umsatz, 5 Zeilen, Summe 3720 korrekt wiedergegeben), `excel_schreiben` 01:49 zwei Zellen mit Bestätigung (A6 = April, B6 = 1100, Datei gespeichert, Formel in B5 unverändert). Office-VM meldet alle sieben Aktionen.

**Offen — Realfall Office-VM:** `outlook_mails` scheiterte mit COM 80080005 (CO_E_SERVER_EXEC_FAIL). Diagnose per shell-Aktion: der Satellit läuft mit Integritätsstufe hoch (`S-1-16-12288`, aus einer Administrator-PowerShell installiert), Outlook normal — COM bindet nicht an einen Prozess anderer Integrität. Abhilfe .1294: `alfred satellit --install` startet aus einer erhöhten Shell über `explorer.exe` (Benutzer-Shell, mittlere Integrität); der Satellit warnt beim Start, wenn er erhöht läuft; 80080005 nennt Ursache und Abhilfe. Owner hat den Satelliten 08.10. 02:00 normal neu gestartet („satellit läuft normal").

**Outlook-Beweise 08.10. 02:02–02:03 (Office-VM, Firmenpostfach):** `outlook_mails` Posteingang 8098 Mails, 6031 ungelesen, 5 gezeigt mit Absender/Betreff/Zeit (neueste Commvault-Alarmmail 01:23); `outlook_termine` 24 Termine 08.–15.10. korrekt mit Zeiten und Orten (Teams-Besprechungen); `outlook_entwurf` mit Bestätigung: „Alfred Test-Entwurf" an md@3033.at angelegt und geöffnet, nicht gesendet (EntryID zurückgegeben). Beim eigenen Update auf 1295 war die Office-VM 02:11–02:21 getrennt (Neustart dauerte knapp zehn Minuten, dann wieder verbunden, 1295).

**Grenzen:** nur klassisches Outlook (das neue Outlook hat kein COM); Word/PowerPoint nicht angebunden; Kontakte nicht angebunden (Graph-API deckt sie); keine Lösch-Aktion. Mail-Inhalte gehen an das Modell — Owner hat das Lesen des Firmenpostfachs am 08.10. ausdrücklich freigegeben.

### 18.5 macOS (.1283, vom Owner bewiesen 07.10. 23:31)

Beweis: Vorhaben „Rechner öffnen, 3 × 4 über die Tasten" → programm_starten Calculator, fenster_lesen, taste 3 / * / 4 / enter → Anzeige 12. Berechtigungen für `~/.alfred/bin/alfred-node` (Bedienungshilfen, Bildschirmaufnahme) sind gesetzt. Update-Kette auf dem Mac nach vier Ursachen (.1285–.1290) geschlossen: npm im PATH, node für den npm-Shebang, root-eigener npm-Cache nach sudo-Installation, node für Install-Skripte der Abhängigkeiten.

Dieselben Aktionen über System Events (Accessibility, JXA): `fenster_lesen` liest das vorderste Fenster (Rollen AXButton, AXTextField, AXCheckBox, AXPopUpButton, AXLink, AXTab, AXMenuItem …), `element_klicken` per AXPress, `tippen` per value oder keystroke, `taste` mit cmd/strg/alt/shift und Key-Codes, `klicken_bei` per `click at`. Notbremse über HIDIdleTime. Voraussetzung: Bedienungshilfen-Berechtigung für node (Satellit) unter Datenschutz & Sicherheit; ohne sie meldet der Satellit „Bedienhilfen-Berechtigung fehlt". Testvorschlag: „Öffne den Rechner und rechne 3 mal 4". Markierte Fotos bisher nur Windows.

### 18.6 Kosten: Vorhaben auf dem günstigen Tier (.1295, Owner-Freigabe 08.10. „freigabe für bedienen günstiger")

Messung 08.10. im Log: eine Runde auf `default` (gpt-6.1-sol) mit allen Werkzeugen ≈ 50–60k Prompt-Tokens ≈ 0,10 $; eine Runde auf `fast` (Haiku 5.5) ≈ 0,003 $. Seit .1231 bekommt die Vorhaben-Fortsetzung nur das Geräte-Werkzeug; seit .1295 läuft sie auf `vorhabenTier()` (`core/geraete/freigaben.ts`, Standard `fast`, über `ALFRED_GERAETE_VORHABEN_TIER` umstellbar, Logzeile `v1295 Vorhaben-Fortsetzung`). Die Planung und die Owner-Frage davor bleiben auf dem Standardmodell. Kein Modell-Gate: der Router fällt bei Störung des Tiers wie überall zurück.

**Beweis 08.10. 02:23 (MacBook, Rechner 6 × 7):** Der erste Lauf 02:21 scheiterte am gesperrten Mac („Calculator hat kein Fenster"). Nach dem Entsperren (Owner 02:22) lief das Vorhaben durch: programm_starten, fenster_lesen, taste escape/6/shift+8/7/enter, Foto. 18 Runden auf `claude-haiku-5-5` mit 2,3k–11,7k Prompt-Tokens kosteten zusammen 0,0054 $; die eine Planungsrunde davor auf default kostete allein 0,0068 $ (60k Tokens). Schönheitsfehler: nach dem Verfall der Karte meldete `taste` „Element-Karte ist 1791418999 s alt" (Epoche statt Alter); das Modell las die Karte trotzdem neu — Text in .1296 korrigiert.

**Korrektur 08.10. 02:50 (Owner-Einwand, zu Recht):** Das Vorhaben war fachlich NICHT erfolgreich — die Anzeige des Rechners stand danach auf 687, nicht 42. Ursache: das Modell schickte für „mal" die Taste `shift+8`, die auf dem deutschen Layout „(" ergibt; die Element-Karte half nicht, weil alle 24 Knöpfe nur „Taste" heißen. Diagnose per JXA (shell-Aktion, 02:51): `name` und `title` leer, `description` = Rollenname „Taste", `help` nur bei wenigen Knöpfen („Letzte eingegebene Ziffer …"), die Anzeige ist ein AXStaticText mit `value`. Zweiter Befund: beide Vorhaben blieben bis zum Ablauf (02:51/02:53) aktiv und hielten das Selbstupdate auf 1296 25 Minuten im Zustand „warten".

**.1297 (Owner-Freigabe „freigabe für 1297, diagnose am mac inklusive"):** (1) `VorhabenFreigaben.verkuerze()` — nach der Fortsetzung bleibt eine Gnadenfrist von 5 min (`VORHABEN_GNADENFRIST_MS`) für Nachfragen, dann läuft das Vorhaben aus (Logzeile `v1297 Vorhaben verkürzt`). (2) `taste`: Zeichen-Aliase auf Mac (`ZEICHEN_ALIASE`) und Windows — „mal", „plus", „gleich", „shift+8" … werden als Zeichen getippt (`keystroke`/SendKeys sind layoutunabhängig); Manifest-Text: „Zeichen wie * + / = direkt angeben, nicht shift+Ziffer". (3) Mac-Element-Karte: `description` zählt nur, wenn sie nicht dem Rollennamen gleicht, sonst `help`; für den Rechner bleibt der Weg über `taste`, weil Apple den Knöpfen keine Namen gibt (Set-of-Marks über das Foto bleibt offen). Lektion Werkzeugkette: Patch-Skripte mit split/join statt String.replace — `$'` im Ersatztext ist ein Replace-Muster und zerlegte die Datei.

**Beweis .1297 am MacBook 08.10. 03:09–03:12 (Server 1297 bestätigt 03:05):** Vorhaben „Calculator starten, 6 × 7, Anzeige lesen" → programm_starten, fenster_lesen, taste escape/6/*/7/enter (Alias tippt `*` layoutunabhängig), fenster_lesen, Foto; danach Anzeige per JXA direkt gelesen: AXStaticText „6×7" und „42". Logzeile `v1297 Vorhaben verkürzt` (bis = Freigabe + 5 min) erschien beim ersten Lauf 03:08 nach 22 s; Fortsetzung auf Tier fast (3 Runden 0,0032 $). Die Element-Karte nennt den Rücktaste-Knopf jetzt über den Hilfetext („Letzte eingegebene Ziffer oder Operation löschen …"); die übrigen Rechner-Knöpfe bleiben namenlos (Apple liefert nichts), deshalb bleibt `taste` der Weg. **.1298 (Owner „ok weitermachen", 03:28 live):** Die leere Mac-Fensterliste hatte eine einfache Ursache: das AppleScript schrieb mit `log` nach stderr, `run()` liefert bei Erfolg nur stdout; nur wenn osascript scheiterte, kam die Liste über die Fehlermeldung. Jetzt gibt das Skript die Zeilen als Ergebnis zurück (`parseFensterZeilen`, Test). Beweis 03:28: 31 Fenster auf dem MacBook mit Programm und Titel (Terminal, Outlook, Preview, TextEdit …). Schrittergebnisse in `vorgang_schritte` werden auf 2000 statt 300 Zeichen gekürzt (`ERGEBNIS_MAX_ZEICHEN`).

**.1299 — Office-VM offline seit 02:55:** Der VM-Satellit verband sich nach dem 1296-Server-Neustart (02:53), beendete sich für sein eigenes Update (02:55, Code 75) und kam nicht zurück — 1297/1298 erreichten ihn nie. Ursache im Starter: `alfred satellit` ohne `--dienst` lief selbst im Starter-Prozess, wenn keine neuere Version installiert war, und Code 75 beendete alles. Seit .1299 läuft jeder dauerhafte Satellitenlauf als Kind des Starters. Der Owner muss den VM-Satelliten einmal neu starten (am besten `alfred satellit --install` aus einer normalen PowerShell, dann hält ihn der Autostart).

### 18.7 Kostenbild 07./08.10. (Auswertung aus den LLM-Logzeilen)

| Tag | default (gpt-6.1-sol) | fast | strong | Summe |
|---|---|---|---|---|
| 07.10. | 307 Aufrufe, 9,21 $ | Sonnet 189 / 3,90 $ + Haiku 61 / 0,07 $ | Opus 24 / 3,18 $ | 16,37 $ |
| 08.10. bis 03:20 | 102 Aufrufe, 5,55 $ | Haiku 112 / 0,07 $ | – | 5,62 $ |

Treiber: jede default-Runde trägt 47–57k Prompt-Tokens (61 Werkzeugschemata ≈ 29k, Verlauf, Kontext) bei einer Cache-Quote von nur 50–61 %; am 07.10. kamen 2,4 Runden je Nachricht. Auslöser waren fast ausschließlich der Owner-Chat und die Beweisläufe (Chat-IDs `api-*-beweis`, Sitzungen), nicht die Nachtjobs. Hebel in dieser Reihenfolge: (1) Geräteaktionen aus dem normalen Chat laufen noch mit allen Werkzeugen auf default — nur Vorhaben sind seit .1295 günstig; (2) Werkzeugsatz je Nachricht enger ziehen (Skill-Filter), damit die Cache-Quote steigt und die Runde kleiner wird; (3) fast-Tier seit 07.10. abends Haiku 5.5 statt Sonnet (3,90 $ → 0,07 $ bei ähnlicher Aufrufzahl — das ist bereits eingespart). Owner-Entscheidung nötig für (1) und (2).

**Umgesetzt .1300 (Owner 08.10. „freigabe für beide", live 09:17):** `werkzeugeFuerNachricht()` in `core/skill-filter.ts` ersetzt den Default-Zweig der Pipeline. Hebel 1: nennt die Nachricht ein Gerät (Anzeigename aus der Skill-Beschreibung oder Kürzel `office_vm`/`office-vm`/`office vm`, Wortgrenzen), bekommt das Modell nur die Geräte-Skills. Hebel 2: Kategorien zuerst aus der aktuellen Nachricht; die drei vorigen Nutzer-Nachrichten zählen nur, wenn die Nachricht selbst kein Schlüsselwort trifft (bisher Vereinigung); Rückfall ohne Treffer = core, productivity, information; Geräte-Skills außerhalb von Hebel 1 nur bei Geräte-Wörtern (`GERAETE_KEYWORDS`). Unverändert: allowedSkills (Mail-Regeln, Vorhaben), Projekt-Chat-Whitelist, Sprachnachrichten. Logfeld `werkzeugwahl` in `llm_request_prep`.

| Nachricht (09:18) | werkzeugwahl | Werkzeuge | Werkzeug-Tokens | vorher |
|---|---|---|---|---|
| „Lies auf Office-VM die letzten 3 Mails …" | geraet_genannt | 1 | 3,3k | 64 / 35k |
| „Wie ist das Wetter morgen in Wien?" | nachricht | 24 | 7,5k | 64 / 35k |
| „danke" | rueckfall | 38 | 14,4k | 64 / 35k |

Alle drei Antworten fachlich richtig (Betreffzeilen aus Outlook, Wetter-Hinweis, Dank). Der Systemprompt (6,8–10k Tokens im API-Chat, 18k im Owner-Chat) ist jetzt der größere Block — nächster Hebel, falls gewünscht.

**Befund dabei (09:18): Tier default (gpt-6.1-sol) steht im billing-cooldown** — der Router überspringt den Primary und fällt auf strong (Opus 5.5) zurück: 9 Opus-Aufrufe in 90 min = 0,91 $, davon je Erst-Aufruf 0,09–0,19 $ allein für Cache-Schreiben (37k Tokens). Fallback-Reihenfolge default → strong ist die teuerste Variante; Owner 08.10.: nichts am Fallback ändern.

**Nachtrag .1301 (Owner „freigabe für punkt 1"):** Die Warnung „Tier default seit 1 h nicht erreichbar (unbekannt)" um 08:05 kam NICHT von OpenAI, sondern von Alfreds eigener Probe (`provider_puls`: fehler_text „400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 5", gestoert_seit 06:55 = synthetische Probe 06:50). Die Nachprobe alle zehn Minuten scheiterte am selben Fehler; das echte Guthaben-Ende („429 You have no credits remaining") begann erst 09:14. Fix: `PROBE_MAX_TOKENS = 16`, Klasse `anfrage` für 400/422, `fehlerGrund()` im Wächter schreibt Klasse in Worten plus Anbieter-Text (110 Zeichen). Beweis nach Deploy 10:08: Live-Beweis steht aus — Tier default ist seit 10:05 wieder gesund (Owner lud OpenAI-Guthaben, Log „billing recovered"), eine Nachprobe gestörter Tiers läuft daher nicht; die synthetische Probe am 09.10. 06:50 muss default: true liefern (vorher jeden Tag false). Unit-Tests decken Klasse „anfrage", Wortlaut und Kürzung ab.

### 18.4 Eigene Arbeitsfläche (Owner 07.10. 23:55: nicht nötig, Plan gemerkt)

Entscheidung: Satelliten arbeiten nur auf Zuruf oder auf VMs, an denen gerade niemand sitzt; eine getrennte Arbeitsfläche am PC ist deshalb nicht nötig. Der Plan bleibt dokumentiert und wird nicht umgesetzt.

Windows „Agent Workspace" (eigenes Standardkonto, isolierte Sitzung parallel zum Owner, Zugriff auf Dokumente/Downloads/Desktop/Bilder; Preview, aus; Einstellungen → System → KI-Komponenten → Agent-Tools) oder ein zweites Windows-Konto per Remote-Desktop-Loopback, in dem der Satellit läuft. Erklärt 07.10. abends; bis zur Entscheidung Notbremse und Bestätigung. Linux: AT-SPI, offen.

### 18.8 Linux/Wayland (.1339/.1340, Owner-Freigabe 09.10. 22:10 „linux tippen auch freigegeben", bewiesen 22:31)

Unter GNOME Wayland gibt es keinen Zugriff auf fremde Fenster: keine Fensterliste (`org.gnome.Shell.Introspect` → Access denied, wmctrl ist X11), keine Elemente, keine Fenstertitel. Deshalb Stufe A „light" in `satellit-bedienen-linux.ts`:

- **Ziele statt Element-Karte:** `fenster_lesen` liefert zwei feste Ziele — 1 = Fokusfenster (Text per Strg+V), 2 = Terminalfenster (Strg+Umschalt+V). Vorher mit `bildschirm` prüfen, welches Fenster vorne ist; `taste` legt die Karte bei Bedarf selbst an (.1340).
- **Tasten:** `ydotool key` mit Tastennamen (strg+s → ctrl+s, alt+f4, strg+alt+t, enter, Bild ab → pagedown); ydotool 0.1.8 (Ubuntu) kennt keine Keycode-Form.
- **Text:** nie tippen — uinput ist layoutblind. Realfall 22:16: aus `echo YDOTOOL-TEST > /tmp/yd.txt` wurde `echo ZDOTOOLßTEST : -tmp-zd.txt` (deutsches Layout). Text geht per `wl-copy` in die Zwischenablage und wird eingefügt; einzelne Zeichen (* + / =) bei `taste` ebenso.
- **Maus:** `klicken_bei` nach Fotokoordinaten; ydotool 0.1.8 bewegt nur relativ → erst −20000/−20000 (Ecke), dann (x, y), dann `click 1`.
- **Notbremse:** Leerlauf über `org.gnome.Mutter.IdleMonitor GetIdletime` (funktioniert unter Wayland, auch aus dem Dienst).
- **Umgebung:** Dienste ohne Anmeldesitzung bekommen DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY, XDG_RUNTIME_DIR ergänzt (`linuxSitzungsUmgebung`).
- **Voraussetzungen auf dem Gerät:** `ydotool`, `wl-clipboard`, `gnome-screenshot` (apt); `/dev/uinput` per udev-Regel `/etc/udev/rules.d/60-alfred-uinput.rules` (`KERNEL=="uinput", MODE="0660", GROUP="input", TAG+="uaccess"` — Nummer < 70, sonst greift uaccess nicht) → ACL `user:madh:rw-` für den angemeldeten Benutzer, ohne Neuanmeldung. Benutzer zusätzlich in Gruppe input.
- **Freigaben:** Linux-Standardordner aus `~/.config/user-dirs.dirs` (Dokumente, Schreibtisch); fehlende englische Standardeinträge werden beim Start ersetzt (Log „Freigabe repariert"); die Shell nimmt das erste vorhandene Verzeichnis mit Schreibrecht.

Beweis 09.10. 22:31 (Ubuntu-VM, Gerätesitzung): Vorhaben „Terminal öffnen, `echo ALFRED-TIPPTEST > /tmp/tipp.txt` einfügen, Strg+D" → Satellit-Log fenster_lesen → tippen (Zwischenablage + Strg+Umschalt+V + Enter) → taste strg+d, Datei `/tmp/tipp.txt` mit Inhalt um 22:31:56; die laufende Claude-Code-Sitzung im anderen Terminal blieb unberührt. Grenze: Eingaben gehen immer an das Fenster mit Fokus — für gezielte Terminalsteuerung (Claude Code) ist `tmux` mit `send-keys`/`capture-pane` über die Shell-Aktion der robuste Weg.
