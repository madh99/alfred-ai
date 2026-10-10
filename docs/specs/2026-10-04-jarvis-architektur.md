# Jarvis — Vom reaktiven Assistenten zum verlässlichen Partner (Architektur-Spec)

Branch: `feature/jarvis` (aus `feature/multi-user`). Stand: 04.10.2026. Status: Entwurf, Schicht 0 ausgearbeitet, Schichten 1–4 skizziert.

## Problem

Alfred hat **Breite** — 80+ Skills über Infrastruktur, Kalender, Mail, Smart Home, Fahrzeug, Social, ITSM/CMDB, Knowledge Graph und ein zweistufiges Reasoning. Was ihn von einem „Jarvis" trennt, ist nicht eine fehlende Fähigkeit, sondern vier strukturelle Lücken, die in den Audits August–Oktober 2026 jeweils bewiesen wurden:

| Lücke | Beweis |
|---|---|
| **Keine Selbstwahrnehmung** | 7 Wochen zu 100 % auf dem Fallback-Modell (Anthropic/OpenAI ohne Guthaben seit 18./19.08.) — unbemerkt. KG-Wartung 16 Tage tot (Timer-Bug), Insight-Sweep seit Einführung nie gelaufen, ITSM-Block seit Einführung nie registriert. Jedes Mal fiel es erst beim manuellen Log-Audit auf. |
| **Verarbeiten statt Verstehen** | „BMW-Daten 6h alt" → Modell schließt „API offline", jeden Tick, trotz Korrektur im Prompt. Erst die Deutung *an der Datenzeile* (v1151) stoppte es. Dieselbe Mechanik fehlt für alle anderen Quellen. |
| **Offene Schleifen** | 3.431 Insights, 13 „acted". 40 Watches, 1 hat je getriggert. Insights sind Beobachtungen ohne Besitzer; es gibt kein Ausführungsgedächtnis und keine Wirkungsmessung. |
| **Unverlässliches Gedächtnis** | Phantom-Personen („Mistral", „Sportverein"), 8-fach kopierte Verhaltensmuster über Login-Aliase, Attribut-Müll an Kindern — jeweils an den Schreibern behoben (v1141–v1159), aber ohne zentrales Weltmodell entstehen neue Varianten. |

Gemeinsamer Nenner aller Fixes seit August: **deterministische Leitplanken schlagen Prompt-Bitten** (Architektur-Grundsatz: Alfred muss mit jedem Modell der Fallback-Kette funktionieren). Diese Spec hebt das vom Einzelfall auf die Architektur.

## Zielbild

Jarvis in fünf Sätzen:
1. Er **weiß, wann er blind ist**, und sagt es als Erstes.
2. Er reasoned über **gedeutete Zustände**, nicht über Rohzahlen — deshalb reicht ihm meist ein kleines Modell.
3. Er reagiert auf **Ereignisse in Sekunden**, nicht im 30-Minuten-Takt.
4. Er führt **Vorgänge** mit Besitzer, nächstem Schritt und Ergebnis — und erinnert sich, was er getan hat.
5. Er **misst seine Wirkung** und wird daraus leiser oder lauter.

Explizit **nicht** Ziel: mehr Skills. Tote Features (Metric-Samples, Change-Requests, Teile der Pattern-Analyse) werden stillgelegt statt mitgeschleppt.

## Architektur — fünf Schichten

```
┌─────────────────────────────────────────────────────────────┐
│ Interaktion: Sprache · Anwesenheit · ein Faden über Plattformen │
├─────────────────────────────────────────────────────────────┤
│ Schicht 4  Messen & Lernen (Signale → Kennzahlen → Konsequenz) │
├─────────────────────────────────────────────────────────────┤
│ Schicht 3  Vorgänge statt Insights (Besitzer, Schritt, Ergebnis)│
├─────────────────────────────────────────────────────────────┤
│ Schicht 2  Ereignisgetriebene Wahrnehmung (Sekunden statt Tick) │
├─────────────────────────────────────────────────────────────┤
│ Schicht 1  Weltmodell (Stammdaten + Normalzustände je Quelle)   │
├─────────────────────────────────────────────────────────────┤
│ Schicht 0  Lebenszeichen (Jobs · Provider · Proben · Wächter)   │
└─────────────────────────────────────────────────────────────┘
```

Jede Schicht ist für sich nützlich und deploybar. Reihenfolge ist verbindlich: ohne Schicht 0 ist jede weitere Fähigkeit Glückssache.

---

## Schicht 0 — Lebenszeichen (ausgearbeitet)

### Ziel
Jeder periodische Job, jeder Provider und jede kritische Datenquelle hat einen **erwarteten Takt** und meldet **Registrierung, Lauf und Ergebnis** an eine zentrale Stelle. Abweichungen erzeugen genau **einen** Morgen-Satz an den Owner — nicht 70 Warnzeilen im Log.

### Komponenten

**1. Job-Register (`packages/core/src/lebenszeichen/job-register.ts`)**
Deterministische Registry statt verstreuter `setInterval`-Blöcke in `alfred.ts`.

```ts
interface JobDefinition {
  key: string;                  // 'kg-maintenance', 'insight-sweep', 'itsm-hygiene', …
  takt: { art: 'taeglich'; um: 'HH:MM' } | { art: 'intervall'; minuten: number } | { art: 'woechentlich'; tag: 0-6; um: 'HH:MM' };
  nachholen: boolean;           // nach Restart einmalig nachholen (nachtjob-plan.ts)
  nurMaster: boolean;           // je Master-User statt je Zeile (v1159)
  slot: boolean;                // HA-Dedup über reasoning_slots
  run: (ctx: { userId: string; logger: Logger }) => Promise<JobErgebnis>;
}
interface JobErgebnis { ok: boolean; zaehler?: Record<string, number>; fehler?: string }
```
Das Register plant alle Jobs auf dem **10-Minuten-Raster** (Lektion v1158: nie Stunden-Timer mit Minuten-Fenster), schreibt bei Registrierung und je Lauf eine Zeile in `job_runs` und loggt `registriert` / `gelaufen` / `fehlgeschlagen` einheitlich. Die bestehenden Jobs (Konsolidierung, Pattern-Analyse, KG-Wartung, Temporal, Insight-Sweep, ITSM-Hygiene, Tagesreflexion, Digest, Vorausschau, Frage-Generator, Lern-Telemetrie, Stammdaten-Sync, Pattern-Sweep) werden **ohne Verhaltensänderung** in das Register migriert — ein Job nach dem anderen, jeder mit Test gegen den Takt.

**2. Provider-Puls (`provider-puls.ts`)**
Je LLM-Tier (default/strong/medium/fast/embeddings/fallback) ein Zustand: `letzterErfolg`, `letzterFehler`, `fehlerKlasse` (billing / auth / rate / netz / modell), `fallbackAktivSeit`. Gespeist aus dem Model-Router (dort entstehen heute die „Provider billing failure"-Warnungen). Zusätzlich je Skill-Quelle, die der Kontext-Kollektor nutzt (BMW, HA, Proxmox, UniFi, Mail, Kalender …), der bestehende `QuellenSchalter`-Zustand (v1142) als Puls.

**3. Synthetische Proben (`proben.ts`, täglich 06:50 vor dem Digest)**
Kleine, kostenneutrale Checks, die Ausfälle sichtbar machen, bevor sie wehtun:
- je Tier ein Minimal-Request (`"OK"`) — misst Verfügbarkeit *und* Guthaben,
- je Pflicht-Job: lief er innerhalb seines Takts? (aus `job_runs`),
- je Kernquelle: letzter erfolgreicher Abruf < 2× Takt?,
- Datenbank-Freshness: jüngste Zeile in `activity_log`, `llm_usage`, `alfred_insights`.

**4. Degradations-Wächter**
Regeln, deterministisch:
- Tier `strong`/`default` seit > 60 min nicht erreichbar → Zustand *degradiert*, Owner-Satz.
- Fehlerklasse `billing` → Zustand *Guthaben*, Owner-Satz mit Tier, Zeitpunkt des letzten Erfolgs und Hinweis, welche Fähigkeiten gerade über den Fallback laufen. Wiederholung höchstens täglich, Entwarnung einmalig.
- Pflicht-Job > 1 Takt überfällig → Owner-Satz mit Job-Name und letztem Lauf.
Kein Modell-Gate, keine Pause: Alfred **arbeitet weiter** mit dem Fallback (Architektur-Grundsatz) — er sagt es nur.

**5. Morgen-Satz und Dashboard-Kachel**
Im 07:00-Bündel genau eine Zeile, nur wenn etwas abweicht: „⚠️ Seit 18.08. ohne Anthropic-Guthaben — Reasoning läuft auf Mistral. KG-Wartung zuletzt 11.09." Web-UI: Kachel „Lebenszeichen" (Jobs mit Takt/letzter Lauf/Ergebnis, Provider-Puls, Proben), gespeist aus `job_runs` + Provider-Puls — kein neues Datenmodell in der UI, nur Anzeige.

### Persistenz
- `job_runs (id, job_key, user_id, started_at, finished_at, ok, zaehler jsonb, fehler text, node_id)` — PG + SQLite-Spiegel, 90 Tage Aufbewahrung.
- `provider_puls (tier, letzter_erfolg, letzter_fehler, fehler_klasse, fallback_seit, updated_at)` — eine Zeile je Tier.
- `reasoning_slots` bleibt die HA-Dedup-Quelle.

### Tests
- Takt-Berechnung (täglich/intervall/wöchentlich, Nachholen, Tageswechsel) als reine Funktionen (Erweiterung von `nachtjob-plan.ts`).
- Register: Registrierungs-Logzeile Pflicht; Job ohne Lauf innerhalb Takt → Probe schlägt an (Realfall 12.–28.09.).
- Degradations-Wächter: Billing-Fehler ohne Erfolg seit 60 min → genau ein Owner-Satz pro Tag; Erfolg → einmalige Entwarnung.

### Abnahme (messbar)
- Jeder periodische Job steht im Register und hat in `job_runs` einen Lauf innerhalb seines Takts.
- Ein künstlich entfernter API-Key erzeugt binnen 70 Minuten genau einen Owner-Satz und nach Rückgabe eine Entwarnung.
- Ein künstlich blockierter Job erzeugt am nächsten Morgen genau einen Satz.

---

## Schicht 1 — Weltmodell (skizziert)

**Stammdaten als Struktur, nicht als Text.** Familie, Zuhause, Fahrzeuge, Infra-Hosts, Verträge/Fristen, Vereine werden als KG-Entitäten mit Positiv-Schema (v1146 `ENTITY_SCHEMATA`, erweitert um `vertrag`, `frist`, `geraet`), Herkunft (`_prov`) und Konfidenz geführt. Der Chat-Kontext baut aus dem Graphen ein **Personal-Blatt** (bereits begonnen in `buildPersonalContext`).

**Normalzustände je Datenquelle.** Für jede Kontext-Quelle eine deterministische Deutungsschicht (`normalzustaende/<quelle>.ts`): Regeln + gelernte Baselines (Median/Streuung je Stunde/Wochentag aus `activity_log`/Messwerten). Ausgabe sind **Zustände mit Deutung** („Fahrzeug steht seit 14h — Datenalter normal", „Garage-Sensor 4 %: unter Baseline, seit 3 Tagen fallend"), die der Kollektor statt Rohzahlen liefert. Die Korrektur-Annotation (v1151) wird zum Spezialfall: User-Korrekturen sind manuelle Normalzustände mit höchster Herkunfts-Klasse.

**Widersprüche entscheidbar.** Zwei Quellen, zwei Werte → `darfUeberschreiben` (v1146) nach Herkunfts-Rang; ungelöste Widersprüche landen als *eine* Rückfrage im Wochen-Bündel des Frage-Generators, nie als Insight.

Abnahme: Ein Reasoning-Pass mit Haiku/Mistral auf gedeuteten Zuständen erzeugt für die bekannten Realfälle (MQTT, ESS-Mindest-SoC, Sensorbatterien, Gamescom-Rückfahrt) **keinen** Fehl-Insight — ohne dass das Gate eingreifen muss (Gate-Treffer → 0 als Kennzahl).

## Schicht 2 — Ereignisgetriebene Wahrnehmung (skizziert)

Ereignisse (HA-State-Change, MQTT, Mail-Eingang, Kalender-Update, Standort, Watch-Trigger) laufen über den bestehenden Event-Pfad des Reasonings (`processEvent`), aber **gefiltert durch Schicht 1**: Nur Zustandswechsel gegen den Normalzustand lösen einen Mini-Pass aus — mit dem betroffenen Ausschnitt des Weltmodells als Kontext, nicht dem Vollkontext. Der 30-Minuten-Tick bleibt als Rundgang mit reduziertem Umfang. Kennzahl: Latenz Ereignis → Reaktion, Anteil Mini-Pässe am Gesamtvolumen, Kosten je Pass.

## Schicht 3 — Vorgänge statt Insights (skizziert)

Datenmodell `vorgang (id, titel, ziel, besitzer: alfred|user, status: offen|wartet|erledigt|verworfen, naechster_schritt, frist, quelle, ergebnis, erstellt, aktualisiert)`. Insights, die eine Handlung implizieren, werden zu Vorgängen; reine Informationen bleiben Insights mit Ablaufdatum (v1158 `expireStale`). **Autonomie-Klassen** je Aktion: `auto` (reversibel, risikoarm: Reminder setzen, Watch anlegen, Dokument ablegen) → tun und berichten; `bestaetigen` (Geld, extern sichtbar, irreversibel) → ein Satz mit Buttons; `nie` (Konfig-Löschungen, Zahlungen über Schwelle). Jede Ausführung schreibt ins **Ausführungsgedächtnis** (`vorgang_schritte`), das der Kollektor als „Bereits getan" einspeist — Ende der Wiederholungsvorschläge. Die Plan-Mechanik aus `2026-04-14-autonomous-planning-design.md` wird hier eingehängt statt separat gebaut.

## Schicht 4 — Messen & Lernen (skizziert)

Jede proaktive Nachricht erhält ein Ergebnis-Signal: Reaktion (Button, Antwort), Erledigung (Vorgang geschlossen), Ignorieren (Ablauf ohne Reaktion), Korrektur (v1148-Erfassung). Wöchentliche Kennzahlen: Präzision (reagiert/gesendet), Erledigungsquote, Korrekturen je Quelle, Gate-Treffer, Kosten je erledigtem Vorgang, Modell-Verteilung. Konsequenzen sind deterministisch: Quellen unter Präzisions-Schwelle werden auf Digest-Modus gesetzt; Vorschlags-Typen mit hoher Erledigungsquote dürfen in die Autonomie-Klasse `auto` aufsteigen (mit Owner-Bestätigung der Regel, nicht jeder Aktion). Die Lern-Telemetrie (v1147) liefert den Rahmen.

## Interaktion (skizziert)

Sprache über vorhandene STT/TTS; Anwesenheit aus HA (Personen-Entitäten) und Chat-Aktivität steuert Zustellung (Ruhefenster/Deferred existieren); ein Gesprächsfaden über Telegram/Matrix/Web dank Master-Identität (v1159); Standard knapp, „Warum?" liefert die Kette Daten → Deutung → Entscheidung aus `job_runs`/`vorgang_schritte`.

## Integration mit bestehenden Systemen

- `nachtjob-plan.ts` (v1158) wird zur Takt-Bibliothek des Job-Registers.
- `QuellenSchalter` (v1142) liefert den Quellen-Puls; `TokenCostTracker`/`llm_usage` den Kosten-Teil der Kennzahlen.
- `annotiereKontextMitKorrekturen` (v1151) wird zur Normalzustands-Schicht generalisiert.
- `ConfirmationQueue` + Telegram-Buttons tragen die Autonomie-Klasse `bestaetigen`.
- `alfred_insights` bleibt für reine Informationen; `vorgang` kommt daneben, keine Migration der Historie.

## Dateien (Schicht 0)

- `packages/core/src/lebenszeichen/job-register.ts`, `provider-puls.ts`, `proben.ts`, `degradations-waechter.ts`
- `packages/storage/src/repositories/job-runs-repository.ts`, Migration `job_runs`, `provider_puls`
- `packages/core/src/alfred.ts`: Jobs schrittweise ins Register; Registrierungs-Block ersetzt die verstreuten Timer
- `apps/web/src/components/system/LebenszeichenPage.tsx` (+ API-Route in `messaging/http.ts`)
- Tests: `packages/core/src/__tests__/job-register.test.ts`, `degradations-waechter.test.ts`

## Reihenfolge

1. **Schicht 0** (2–3 Wochen): Register + Puls + Proben + Wächter, Jobs migrieren, Kachel. Jede Migration eines Jobs ist ein eigener kleiner Release mit Live-Beweis.
2. **Schicht 1**, quellenweise: BMW/MQTT → HA-Sensoren → ESS/Victron → Infra (Proxmox/UniFi/MikroTik) → Mail/Kalender. Je Quelle: Normalzustände, Test gegen Realfälle, Gate-Treffer als Abnahme.
3. **Schicht 2 + 3** parallel nach Schicht 1 (BMW/HA): Mini-Pässe und erste Vorgänge mit Autonomie-Klasse `auto`.
4. **Schicht 4**, sobald Vorgänge Ergebnisse liefern.
5. Interaktion laufend, beginnend mit „Warum?"-Trace.

## Risiken

- **Schein-Vollständigkeit**: Ein Register, in dem nur die Hälfte der Jobs steht, suggeriert Sicherheit. Gegenmittel: Lint-Test, der jeden `setInterval`/`setTimeout` in `alfred.ts` außerhalb des Registers meldet.
- **Normalzustände als neue Rauschquelle**: zu enge Baselines erzeugen Fehlalarme. Gegenmittel: Baselines sind erst *beobachtend* (loggen, nicht melden), Freischaltung je Quelle nach einer Woche Beweis.
- **Autonomie ohne Rückweg**: `auto` nur für Aktionen mit dokumentiertem Undo; jede Auto-Aktion im Ausführungsgedächtnis mit Rücknahme-Hinweis.
- **Modellabhängigkeit durch die Hintertür**: Jede neue Fähigkeit wird gegen das schwächste Modell der Kette getestet (Mistral-Small-Lauf in der Suite), nicht nur gegen das stärkste.

## Umsetzungsstand (06.10.2026, Release-Linie `0.19.0-jarvis.N`, Branch `feature/jarvis`)

Jeder Punkt wurde live auf .92 bewiesen (Logzeilen, `job_runs`, Datenbank), nicht nur gebaut. Versionsnummern verweisen auf den CHANGELOG.

### Schicht 0 — Lebenszeichen: abgeschlossen (.1161–.1168, .1190, .1191)
- Job-Register mit 10-Minuten-Raster, `job_runs`, Nachholen, Slots, Zeitbudget je Job; 43 registrierte Jobs, Lint-Basislinie für rohe Timer in `alfred.ts` = 0 (.1190: Backup-Cron, Content-Studio-Tick, Cluster-Monitor migriert).
- Provider-Puls je Tier, synthetische Proben 06:50 (Tiers, Job-Takte, Daten-Frische inkl. `messwerte`, Adapter), Degradations-Wächter mit einem Morgen-Satz und Entwarnung (Beweis 05.10. 02:24: ein Satz, 65 min nach dem ersten Puls-Fehler).
- Adapter-Puls (.1191): getrennte Messaging-Adapter werden gemeldet und alle 10 min neu verbunden (Realfall Matrix-502 am 05.10.).
- Kachel Lebenszeichen (`/alfred/lebenszeichen/`, `GET /api/lebenszeichen`).

### Schicht 1 — Weltmodell: live je Quelle (.1169–.1177, .1181, .1184, .1187, .1188)
- Normalzustände: BMW (REST+MQTT verschmolzen, Bewegung, Stream-Zustand, Kontingent), Energie/ESS, Sensorbatterien (Klassifikation am Schreiber, Monitor-Skill), Infra/MikroTik, Haus (Türen, Bewegung, Anwesenheit mit Heimzonen).
- Messwerte-Sammler (30 min) mit 7-Tage-Backfill, Baselines Median/MAD je Tagesstunde (beobachtend).
- Gate-Aussetzung durch Weltmodell: eine generische Korrektur unterdrückt keine Meldung, zu deren Objekt das Weltmodell eine Auffälligkeit hält (.1174).
- Realfälle aus dem Weltmodell behoben: BMW-Stream schloss nach 60 s (keepalive, .1184), Token-Refresh-Schleife (.1187), REST-Tageskontingent ≈ 50 Aufrufe (.1188), Fehlalarm Anwesenheit durch Zonennamen (.1181).

### Schicht 2 — Ereignisgetriebene Wahrnehmung: live (.1175–.1178, .1189, .1193)
- Home-Assistant-WebSocket (`state_changed`) mit Entprellung, Backoff und Wächter; Zustandswechsel gegen den Normalzustand lösen Mini-Pässe mit Weltmodell-Ausschnitt aus (Cooldown je Ereignisart, HA-Slots).
- Der 30-Minuten-Tick ist ein Rundgang: Vollpass nur bei fachlicher Änderung (Fingerabdruck ohne relative Zeiten, volatile Sektionen ausgenommen), spätestens alle 2 h. Bewiesen am 05.10. um 21:30: erster Tick ohne LLM („keine fachliche Änderung — Vollpass übersprungen", geändert nur Wetter, Crypto, Aktivität, Feeds). Bis dahin hatte jeder Tick eine echte oder scheinbare Änderung (Neustarts, ITSM-Flap, eigenes Gedächtnis, Wallbox, Projekt-Reihenfolge → .1185, .1189). Seit .1193 steht je geänderter Infrastruktur-Sektion die erste abweichende Zeile im Log.
- Kennzahlen: Anteil Mini-Pässe, Ø Mini-Pass-Dauer, Kosten je Vollpass (.1192).

### Schicht 3 — Vorgänge statt Insights: live (.1179–.1182, .1185, .1186)
- Tabellen `vorgaenge`/`vorgang_schritte`, Autonomie-Klassen (Freigabe Owner 05.10.: auto Reminder/Watch/Todo/Dokument/Notiz/Memory; bestätigen Geld/extern sichtbar/irreversibel inkl. E-Mail, Kalender, Smart-Home-Schaltungen, Social; nie Konfig-Löschungen, Zahlungen, destruktive Shell/DB/Infra), durchgesetzt in der Aktionsausführung.
- Handlungs-Insights werden Vorgänge des Owners (Frist 7 Tage, Dedupe über Titel-Ähnlichkeit, generische Überschriften und Preis-Hinweise ausgenommen); Ausführungsgedächtnis als Kontext-Sektion „Bereits getan".
- Kachel Vorgänge mit Entscheidung des Owners (erledigt/verworfen) als Ergebnis-Signal; Kategorie je Vorgang.

### Schicht 4 — Messen & Lernen: Teil 1 live, Teil 2 beobachtend (.1183, .1186, .1192)
- Deterministische Zähler in der Engine (Vollpässe, Rundgänge, Mini-Pässe, Insights je Zustellweg, Gate, Aktionsausgänge, Vorgänge), Tagesabschluss 23:50 als Messwerte, Lern-Telemetrie So 19:15 mit Präzision, Erledigungsquote, Kosten je Vorgang und je Vollpass, Erledigung je Kategorie mit „Kandidat Digest-Modus".
- Erkenntnis: Die Insight-Tabelle taugt nicht als Ergebnis-Signal (gesendete Reasoning-Insights ohne Statusspur); das Signal entsteht an den Vorgängen.
- Offen (Teil 2): Konsequenzen (Digest-Modus unter Präzisions-Schwelle, Aufstieg nach `auto`) erst nach Datenlage und Freigabe der Regel durch den Owner.

### Interaktion: umgesetzt (.1196–.1203)
- „Warum?": deterministische Begründung je Pass (Art, Auslöser mit erster Sektions-Abweichung oder Zustandswechsel, Gate-Aussetzung, Zustellung mit Grund); Chat-Frage „warum?" wird vor dem LLM beantwortet; Begründung dauerhaft am Vorgang (.1196, .1198, .1201).
- Anwesenheit aus Home Assistant und Chat-Aktivität steuern die Zustellung; jede Entscheidung mit Grund (.1198).
- Sprache: Transkription und Synthese laufen über Mistral (Voxtral); Sprachnachrichten erhalten zusätzlich eine gesprochene Kurzantwort (.1202, live bewiesen 05.10. 23:47).
- Standard knapp: proaktive Meldungen als Kurzfassung (Titel + ein Satz je Insight, höchstens fünf), Volltext im Vorgang (.1203).
- Gesprächsfaden: Alfreds proaktive Meldungen liegen als sein Beitrag in der Unterhaltung des Owners, damit Rückfragen darauf aufsetzen (.1203, Realfall „Outlook-Problem").
- Rücknahme-Hinweis je Auto-Aktion (.1200, Abschnitt Risiken).
- Offen: der Zustellgrund „Bewegung im Haus" und die Chat-Frage „warum?" sind gebaut, aber live noch nicht aufgetreten.

### Lernschleifen: drei von vier Bausteinen live (.1204–.1208, freigegeben 06.10.2026)
Owner-Vorgabe: Alfred soll auf alles dynamisch antworten, Wissen aufbauen und sich selbst verbessern; keine vorgegebenen Szenarien. Umsetzung als drei Schleifen in freigegebener Reihenfolge.
- Vorbedingung Kostenwächter (.1205): Tagesbudget `llm.tagesbudgetUsd` / `ALFRED_LLM_TAGESBUDGET_USD`, Bewertung im Degradations-Wächter, Kosten in der Kachel Lebenszeichen. Ohne gesetztes Budget inaktiv (Hinweis in der Kachel).
- Modell-Update Oktober (.1204): GPT-6.1 Sol, GPT-6 Sol/Luna, Claude Opus 5.5/Sonnet 5.5, Ministral 3 in Preistabelle, Kontextfenstern und Provider-Besonderheiten. Live seit 06.10.: Standard gpt-6.1-sol, strong opus-5-5, fast sonnet-5-5.
- Schleife 1 „Wissen → Antwort" (.1206): der Chat-Prompt enthält eine kompakte Weltmodell-Zusammenfassung (Auto, Haus, Energie, Infrastruktur, offene Vorgänge) mit Stand-Uhrzeit; Fakten vor Werkzeugen. Beweis 06.10. 02:35: Frage nach dem Auto in 16,7 s mit zwei Modellaufrufen und einem Werkzeug statt 83 s und sieben Runden.
- Schleife 3 „Lücke → Fähigkeit" (.1207): enthält eine Antwort eine Absage („kann ich nicht", „kein Zugriff", englische Entsprechungen) oder erkennt der Skill-Failure-Reflektor ein wiederholtes Scheitern, legt Alfred sich einen Vorgang „Lernbedarf" an (Frage, Absage-Satz, nächster Schritt, Kategorie, Frist 14 Tage, Quelle `lernbedarf`). Beweis 06.10. 02:53: Frage nach Garmin-Schritten → Vorgang offen in der Kachel.
- Schleife 2 „Reaktion → Verhalten" (Schicht 4 Teil 2): bewusst zurückgestellt, bis zwei Wochen Kennzahlen vorliegen (ab etwa 20.10.); Regeln (Digest-Modus unter Quote, Aufstieg nach `auto`) nur mit Owner-Freigabe.
- Stolperstein (.1208): Sonnet 5.5 lehnt `thinking:{type:"disabled"}` ab und verlangt `between_tools`; drei Vollpässe scheiterten in Serie. Fix deterministisch plus modellunabhängige Selbstheilung: der Provider lernt die verlangte Abschalt-Form aus der 400-Antwort, wiederholt einmal und behält sie für die Laufzeit.

### Kosten und Antwortzeit: Ursachen statt Prompt-Diät (.1209–.1211, 06.10.2026)
Owner-Frage: Soll der System-Prompt gekürzt werden? Analyse: drei frühere Kürzungen nach vermuteter Relevanz (Skill-Filter, Memory-Auswahl, Kontextfenster) schlugen jedes Mal zurück. Der statische Prompt-Text ist 6.000 Zeichen; die Masse sind Werkzeug-Schemata (29.000 Tokens bei 61 Skills gegen 16.000 für den ganzen System-Prompt), ein nach jedem Neustart laufender Generator und vier tägliche Chat-Aufgaben mit allen Werkzeugen. Entscheidung Owner: System-Prompt unangetastet, Ursachen beheben.
- Messung (.1209): `llm_request_prep` protokolliert System-, Werkzeug- und Verlaufs-Tokens je Nachricht. Entscheidung über Werkzeug-Stufen erst mit zwei Tagen Daten.
- Intervall-Jobs überleben Neustarts (.1209): das Register übernimmt den jüngsten Lauf aus `job_runs`. Der wöchentliche Self-Modify-Job lief vorher 15 Minuten nach jedem Neustart (drei Opus-Läufe in einer Nacht, ein Drittel der Tageskosten) und überspringt nun bei unverändertem Scan.
- Kontext parallel (.1210): die zehn Kontext-Lader der Chat-Pipeline laufen gleichzeitig, das Abfrage-Embedding wird 60 s zwischengespeichert (vorher bis zu 14 Netzaufrufe je Nachricht). Beweis: Vorbereitung bis zum Modellaufruf 5.674 ms → 411 ms.
- Mail-Ereignisquelle (.1211, Schicht 2): geplante Aufgaben vom Typ `mail` werden von neuer Post ausgelöst, nicht von der Uhr, genau einmal je Nachricht, mit Verweis auf die Nachricht und nur den Werkzeugen der Aufgabe. Der aWATTar-Rechnungscheck (per Chat angelegt, viermal täglich, 81 Werkzeuge) ist darauf umgestellt; der 22-Uhr-Lauf bleibt als Sicherheitsnetz, bis der Mail-Auslöser zweimal nachweislich gefeuert hat.

### Schicht 3 nachgeschärft: Befunde mit Identität (.1214–.1222, 06.10.2026)
Tages-Audit: 42 offene Vorgänge, dieselben drei Themen fünf- bis sechsmal in neuem Wortlaut; ein Vorgang behauptete einen BMW-Ausfall, den es nicht gab, und führte den Owner zu einer unnötigen Token-Erneuerung, die als Erinnerung zur „Wahrheit" wurde. Diagnose: Das Modell erzeugte Prosa, aus der Objekte abgeleitet wurden. Entscheidung Owner: keine Prompt-Kürzung, keine Schlüsselwort-Abfangstelle, sondern Objekte mit Identität.
- **Befund** (.1217): Objekt mit Schlüssel Quelle plus Gegenstand, Zustand, entstanden, zuletzt gesehen, Zähler, Vorgang. Der Weltmodell-Beobachter schreibt bei jeder Beobachtung fort: neu → Befund und Vorgang, verschwunden → beides erledigt, Wiederauftreten öffnet denselben Befund. Quellen: BMW, Energie, Sensorbatterien, MikroTik; Monitor-Alerts als infra-Befunde mit Schlüsseln ohne Messwerte (.1219); Wächter-Zustand als lebenszeichen-Befunde ohne Vorgang.
- **Lage als Delta** (.1220): Datenblock im Weltmodell-Abschnitt des Chat-Prompts: offene Befunde mit Dauer und Zähler, von selbst erledigte, Vorgänge je Kategorie, 24-h-Delta. Alle 10 Minuten und bei jedem Befund-Wechsel. Beweis 16:42: Chat „Was gibt es Neues?" antwortete aus den Objekten, ohne Falschbehauptung.
- **Prosa-Vorgänge nur noch ohne Befund** (.1222): Insight zu einem offenen Befund wird protokolliert, nicht angelegt. Rückfallebene für Themen ohne Befund: Themen-Regel mit Ankern (Hostnamen, Domains, Zitate, Kürzel) und täglicher Dubletten-Job (.1214, 23 Dubletten in 6 Gruppen zusammengelegt).
- **Hygiene des Ausführungspfads** (.1216): Fehlschlag → „wartet" mit Fehlertext, Gate-Übersprung → „verworfen", Pflichtfelder aus der Beschreibung; interne Memories (Dedup-Marker) raus aus dem Chat-Prompt; Erinnerungen tragen ihr Alter; Regel „Zustand nur aus dem Weltmodell". Fakten-Gegenprobe: Ausfall-Behauptung gegen Datenlage NORMAL → kein Vorgang (.1214).
- Lektion: Jede Deutung reiht Objekte in Zeilen; Titel müssen aus dem Segment des Gegenstands kommen (.1218, .1221). Erst der Live-Betrieb zeigte beide Fälle innerhalb einer Stunde.

### Arbeitsweise, die sich bewährt hat
- Kleine Releases mit sofortigem Live-Audit; mehrere Fehler wurden erst durch die vorangegangene Schicht sichtbar (Stream stabil → Refresh-Schleife → stiller REST-Ausfall → Tageskontingent).
- Fixes an der Quelle (Schreiber, Datenlage) statt am Modell; alles funktioniert mit jedem Modell der Fallback-Kette.

## Gespräche: ein Gespräch, viele Kanäle (Leitfaden, 09.10.2026, v1330/v1331)

Owner-Entscheidung 09.10.2026 (Freigabe 1–5): Der Gesprächsverlauf des Owners hängt am Owner, nicht am Kanal. Der Kanal (Telegram, Desktop-App, Terminal, Web) ist nur der Weg, auf dem eine Nachricht kommt und die Antwort zurückgeht. Gedächtnis, Wissen, Bestätigungen und Vorgänge liefen schon vorher über die Master-Identität; seit v1330 gilt das auch für den Verlauf.

**Begriffe**
- **Hauptgespräch**: der eine durchgehende Strang des Owners. Technisch die bisherige Telegram-Zeile (`conversations`: platform telegram, chat_id = Owner-Chat), damit nichts migriert werden musste. Ohne Telegram: `api` / `owner:haupt`.
- **Faden**: ein Nebenstrang für ein Thema. Schlüssel `owner:faden:<faden>` (faden aus `[a-z0-9-]{1,40}`). Titel = erste Frage, umbenennbar über das Feld `custom_label`. Löschen ist ein weiches Löschen.
- **Archiv**: alte Kanal-Gespräche (z. B. frühere Gerätesitzungen `sitzung:<id>`) bleiben lesbar, nichts wird gelöscht.
- **Herkunft**: Kanal und Chat-ID, aus denen eine Nachricht kam (`message.chatId`). Sie bleibt unverändert und steuert Streams, Pushes und die Antwort auf Bestätigungen und Vorhaben.

**Zuordnung (`packages/core/src/gespraeche.ts`, `gespraechsZiel`)** — nur für den Owner (masterUserId = Owner), nie für Gruppen, Projekt-Chats oder interne API-Chats (`api-chat-…`, `api-update-…`, `scheduled-…`):
- Telegram-Owner-Chat → Hauptgespräch, oder der aktive Faden dieses Chats (`/faden`, Ablage `data/gespraeche.json`).
- Gerätesitzung/Terminal `sitzung:<id>` → Hauptgespräch; `sitzung:<id>:<faden>` → Faden.
- Web `web-chat-<user>` → Hauptgespräch; `web-faden-<faden>` → Faden.
- Familie und Gäste: unverändert, Kanal-Gespräch.

**Wohin Antworten gehen**: immer in den Kanal der Frage. Andere offene Oberflächen bekommen den Push `gespraech` (Faden, Herkunft) und laden den Verlauf nach — so zeigt die App, was in Telegram lief, und umgekehrt. Spiegelung in den Owner-Chat: Standard aus, Schalter in der App (Einstellungen → Gespräche) oder `/spiegel an` (v1334); jede Nachricht trägt ihre Herkunft (`messages.herkunft`).

**Bedienung**: Apps und Terminal über die Seitenleiste bzw. `sitzung:<id>:<faden>`; Web über die Seitenleiste „Gespräche" und `?faden=`; Telegram über `/faden` (Liste), `/faden neu [Titel]`, `/faden <Nr|Kennung>`, `/faden haupt`, `/faden löschen <Kennung>`, dazu `/verlauf [n]` (letzte Nachrichten mit Herkunft) und `/spiegel an|aus` — alle ohne Modellaufruf (v1334).

**Schnittstellen**: Gerätetoken `GET /api/geraete/faeden`, `GET /api/geraete/verlauf?faden=|archiv=`, `DELETE /api/geraete/faeden/<f>`; API-Token oder Owner-Web-Sitzung `GET /api/gespraeche`, `GET /api/gespraeche/verlauf?faden=`, `DELETE /api/gespraeche/<f>` (v1331: 403 für alle anderen Web-Sitzungen; v1332: Geräte-Rückrufe nur für Geräte, deren Sitzungs-Alias am Owner-Master hängt, sonst Kanal-Gespräche des Geräts; v1333: Archiv nur eigene alte Sitzungen, Faden nur im Muster, auch im Kern geprüft — alle drei aus dem Sicherheitsreview).

**Kosten**: Das Hauptgespräch wird durch die vorhandene Zusammenfassung begrenzt (`hasSummary` bei jeder Nachricht); Nebenthemen gehören in einen Faden.

**Beweis 09.10. 17:43** (Ubuntu-VM-Sitzung, Skript `/tmp/gespraeche.cjs`): `faeden` liefert Hauptgespräch + Archiv der alten Sitzung; `verlauf` ohne Faden zeigt die Telegram-Nachrichten („Photo Booth wurde beendet", Foto-Ergebnis); `/faden` antwortet ohne Modell; eine Nachricht aus der VM landet laut Pipeline-Log (`gespraech: "5060785419"`) in der Telegram-Zeile und steht dort als Antwort „OK"; `/api/gespraeche` mit Gerätetoken 401, mit API-Token 200.

## Werkzeug-Schemata: Entscheidung (07.10.2026)

Messung über zwei Tage (06./07.10., 116 Chat-Anfragen, Phase `llm_request_prep`): System-Prompt Ø 13.400 Tokens, Werkzeug-Schemata Ø 20.200 (max 48.400), Verlauf Ø 1.400. Gleichzeitig kamen über 565 Modellaufrufe 63 % aller Eingabe-Tokens aus dem Prompt-Cache der Anbieter. Entscheidung: Die Schemata bleiben, wie sie sind. Der Cache trägt den Großteil der Kosten; eine Kürzung der Beschreibungen brächte wenig und riskiert falsche Werkzeugwahl. Wo es deterministisch geht, bleibt die Werkzeugliste klein (`allowedSkills` bei Mail-Aufgaben und Vorhaben-Fortsetzungen). Ebenfalls 07.10.: Tages-Buckets der Nutzung liefen in UTC (kein Zeitzonen-Eintrag im Owner-Profil), jetzt Server-Zeitzone; Schleife 3 legt keinen Lernbedarf mehr aus synthetischen Nachrichten an.

## Projektvorgang (Entwurf 10.10.2026, Schicht 3 — ohne Umsetzung, Owner: „ausarbeiten, weiterhin keine Freigabe")

### Ziel

Der Owner sagt: „Ich möchte auf dem PC oder der Linux-VM eine Projektidee anfangen oder weiterführen." Alfred ist Projektleiter: Er plant Etappen, lässt sie bauen (Claude Code auf einem Satelliten oder der Projekt-Agent am Server), prüft jedes Ergebnis hart, entscheidet die nächste Etappe innerhalb fester Grenzen, meldet Zwischenstände ins Gespräch und holt den Owner nur bei Weichenstellungen dazu — bis das Ziel erreicht oder das Budget verbraucht ist. Dasselbe Gerüst trägt Tests eines bestehenden Projekts auf einem Satelliten, Deploys mit Nachkontrolle und Betriebsaufgaben.

### Was es schon gibt (wird verbunden, nicht ersetzt)

- **Projekt-Skill** `project`: create, plan_feature(s), list_open_items/add/resolve, list_decisions, list_sessions, review_codebase, update_dependencies, set_health_mode — das Projektgedächtnis auf dem Server.
- **Projekt-Agent** `code-agent` (project-agent-skill): start, status, resume, stop, interject, import_feature — autonome Code-Läufe mit den CLI-Agenten auf .92 (claude-code, codex, mistral-vibe). Nur Server.
- **Deploy-Skill** `deploy`: deploy, start, stop, restart, status, logs, rollback, setup_node, setup_python — abgekoppelter Compose-Start über SSH (v931.1), Live-Fortschritt über SSE (v840). Ziel heute .96. (Korrektur zum Gespräch 10.10.: den Deploy-Skill gibt es; „Deploy: Shell" war falsch.)
- **Docker-/Sandbox-/Code-Sandbox-Skills**: Vorschau mit ephemerer Datenbank, Container-Betrieb am Server.
- **Satellit** (.1342): Aufträge an Claude Code im Druckmodus (auftrag_starten/stand/ergebnis/abbrechen), Shell (10 min, bestätigen), Dateien, Bildschirmfoto, Browser lesen/klicken, Bedienen (Win/Mac/Linux), Office-COM, Zwischenablage, Benachrichtigungen, Sinne. Geräte-Spec §19.
- **Vorhaben** (Geräte-Spec §18.6, freigaben.ts): zeitlich begrenzte Freigabe einer Aktionsliste, Fortsetzung in der anfragenden Sitzung (v1324/v1341), günstiger Tier (v1295).

### Datenmodell

`projektvorgang (id, titel, ziel, projekt_id → project, ausfuehrungsziel: server-agent | satellit:<geraetId> | sandbox, verzeichnis, status: geplant|laeuft|wartet_owner|fertig|abgebrochen|budget_erschoepft, budget_usd, verbraucht_usd, zeitbudget_min, etappen_max, vertrauen: normal|projekt, erstellt, aktualisiert)`
`etappe (id, vorgang_id, nr, titel, auftrag_text, abnahme: [Prüfung…], status: geplant|laeuft|geprueft_ok|geprueft_fehl|nachbesserung|uebersprungen, auftrag_id (Satellit) | lauf_id (Agent), ergebnis_text, kosten_usd, dauer_s, entscheidung: naechste|nachbessern|rueckfrage|stopp, begruendung)`
`vorgang_schritte` (vorhanden) protokolliert jede Aktion mit Daten → Deutung → Entscheidung, damit „Warum?" beantwortbar ist. Das Ausführungsgedächtnis (Schicht 3) bekommt die Etappen als Einträge.

### Die Schleife

1. **Planen** (Modell, einmal, teurer Tier erlaubt): aus Ziel + Projektgedächtnis einen Etappenplan mit Abnahmekriterien je Etappe; der Owner sieht Plan und Budget und bestätigt einmal (ersetzt die Einzelbestätigungen der Etappen — Vorhaben-Mechanik, Dauer bis Zeitbudget).
2. **Bauen**: Etappe als Auftrag (Satellit: `auftrag_starten` mit AUFTRAG.md = Etappentext + Abnahme; Server: `code-agent start`; Sandbox: Compose).
3. **Ende erkennen**: Satellit meldet `GeraetEreignis` (vorbereitet .1342) bzw. Agent-Status. Bis dahin Abfrage im 10-Minuten-Raster über das Job-Register (Schicht 0, kein eigener Timer).
4. **Hart prüfen (ohne Modell)**: je Abnahmekriterium ein deterministischer Prüfschritt am Ausführungsziel — Datei existiert, Befehl liefert Exit 0 (`npm test`, `pytest`, Build), Prozess startet und HTTP antwortet, Bildschirmfoto vorhanden, Browser-Seite enthält Text. Ergebnis: ok / fehl je Kriterium plus gekürzte Auszüge.
5. **Entscheiden (Modell, günstiger Tier, nur Geräte-/Projekt-Skill als Werkzeug)** aus einer **festen Liste**: `naechste` (nächste Etappe aus dem Plan), `nachbessern` (neuer Auftrag mit Prüfprotokoll, höchstens 2× je Etappe), `rueckfrage` (Owner entscheidet), `stopp`. Eingabe: Prüfprotokoll (hart) + Ergebnistext von Claude Code **als Datenblock** (zitiert, gekürzt, keine Anweisungen daraus). Freie Befehle gibt es in diesem Schritt nicht.
6. **Melden**: nach jeder Etappe ein Satz ins Gespräch des Owners (Sitzung des Starts, Owner-Chat Kopie): Etappe, Prüfergebnis, Entscheidung, Kosten bisher. Rückfragen als Bestätigung mit Optionen. Abschluss: Zusammenfassung, Dateien, offene Punkte → ins Projektgedächtnis (open items, decisions).
7. **Grenzen**: Budget (USD, Zeit, Etappenzahl), nur das Projektverzeichnis (+ Deploy-Ziel laut Plan), nichts außerhalb ohne Rückfrage; Abbruch durch den Owner jederzeit (`stopp`, Vorhaben-Abbruch).

### Rechte: Vertrauensstufe „projekt"

Nur lokal am Gerät setzbar (`alfred einstellungen vertrauen projekt <pfad> bis <Zeit>`), nie aus dem Chat: Shell/Dateien/Aufträge in diesem Verzeichnis ohne Einzelbestätigung, Installationen in Benutzerreichweite (apt mit sudo auf der VM, brew am Mac, winget --scope user am PC). Weiterhin gesperrt: Fenstersperren (Banking, Zahlung), Verzeichnisse außerhalb, Systemrechte unter Windows (erhöhter Helfer nur als eigene Owner-Entscheidung). Regel: **Vertrauensstufe „projekt" nie gleichzeitig mit Modellentscheidungen über Fremdinhalt ohne harte Prüfung davor** (Schritt 4 vor Schritt 5 ist Pflicht).

### Sicherheit (Risiko aus Geräte-Spec §19, ausformuliert)

Claude Code liest im Projekt fremde Dateien (Bibliotheken, READMEs, fremde Spezifikationen). Sein Ergebnistext kann eingeschleuste Anweisungen enthalten („lösche X", „sende Y"). Schutz: (a) harte Prüfung ohne Modell liefert die Fakten; (b) der Entscheidungsschritt wählt nur aus der festen Liste; (c) der Ergebnistext ist Datenblock, gekürzt; (d) wirksame Aktionen außerhalb des Projektordners bleiben bestätigungspflichtig; (e) Budgetgrenzen begrenzen Schaden und Kosten; (f) alles protokolliert. Die Auto-Mode-Prüfung des Entwicklungswerkzeugs lehnte am 10.10. die direkte Schleife „Geräteausgabe → Modellaufruf" zweimal ab; der Entwurf hier trennt deshalb Prüfung (deterministisch) und Entscheidung (feste Liste) — in dieser Form ist die Schleife begründbar.

### Anwendungsfälle auf dem Gerüst

Projekt anfangen/weiterführen (PC, VM); Projekt des Projekt-Skills auf einem Satelliten testen (Etappe „auschecken, installieren, Tests" mit Abnahme Exit 0); App starten und sehen (Prüfung Bildschirmfoto/HTTP/Browser); Nachbesserung aus Review-Befunden; Deploy über den Deploy-Skill auf .96 mit Nachkontrolle (status, logs, HTTP); Betriebsaufgaben (installieren, konfigurieren, Dienst neu starten) als Etappen mit Vertrauensstufe; Beobachter (Outlook, Benachrichtigungen, Datei erscheint, Build rot) als Schicht-2-Ereignisse, die einen Projektvorgang auslösen oder fortsetzen.

### Reihenfolge der Umsetzung (nicht freigegeben)

- **R1** Ende-Meldung deterministisch: Satellit sendet `GeraetEreignis`, Gehirn meldet ohne Modell („Auftrag X fertig, Dauer, Kosten, Dateien") in die Sitzung des Starts; harte Prüfschritte als Geräteaktion `pruefen` (Datei, Befehl, HTTP, Text im Bildschirm).
- **R2** Projektvorgang + Etappen im Datenmodell, Planung mit Owner-Bestätigung, Schleife mit fester Entscheidungsliste, Meldungen, Budget; Ausführungsziel Satellit zuerst (Beweis nur Ubuntu-VM), dann Server-Agent.
- **R3** Vertrauensstufe „projekt" (lokal setzbar), Leseaktion „installiert?", Installationen im Benutzerbereich.
- **R4** Beobachter am Satelliten (Outlook, Benachrichtigungen, Ordner) als Schicht-2-Ereignisse mit Job-Register-Eintrag; Deploy-Etappe mit Nachkontrolle.
- **Messen (Schicht 4)**: Etappen je Vorgang, Nachbesserungsquote, Rückfragenquote, Kosten je fertiger Etappe, Abbrüche durch Budget; Konsequenzen deterministisch (z. B. Nachbesserungsquote > 50 % → Planungsschritt auf teureren Tier).

### Stages: dev, test, prod je Projekt (Erweiterung 10.10.2026, Owner: „ja mach das, pfSense nicht vergessen", ohne Umsetzung)

**Gedanke:** Alfred hat alle Infrastruktur-Skills schon; was fehlt, ist die Klammer „Stage" im Projektvorgang, damit er Umgebungen selbst bereitstellt, befördert und zurückbaut — mit festen Toren statt freier Improvisation.

**Vorhandene Bausteine je Schritt**
- Rechner: **Proxmox** (clone_vm, create_lxc aus Vorlagen, wait_ready, create/rollback_snapshot, backup_vm, start/stop/shutdown, node_stats, list_storage).
- Netz: **UniFi** (next_free_ip, create_firewall_rule, list_networks/clients; Standort Dream Machine Pro), **pfSense** (create_rule/delete_rule, list_rules, list_vlans, list_dhcp_leases, list_gateways, status — zweite Firewall-Welt, gleiche Autonomieklasse), **Cloudflare DNS** (Einträge), **Nginx Proxy Manager** (create/update/delete_host, Zertifikate).
- Ausrollen/Betrieb: **Deploy** (deploy, rollback, logs, status, setup_node/python über SSH), **Docker**, **Monitor**, **System-Backup**, **CMDB** (Stage als Konfigurationselement), **ITSM** (Störungen), **Infra-Docs**.
- Bauen/Prüfen: Aufträge an Claude Code (PC, VM), **Mac als Satellit** für alles, was macOS braucht (Mac-/iOS-Builds, Notarisierung — wie bei der Alfred-App bewiesen), Bildschirm/Browser/HTTP-Prüfungen.

**Datenmodell**
`stage (id, vorgang_id | projekt_id, name: dev|test|prod|<frei>, rechner: proxmox-vm:<vmid> | lxc:<id> | satellit:<geraetId> | extern, ip, dns_name, proxy_host_id, firewall: [{system: unifi|pfsense, regel_id}], deploy_ziel (Host, Pfad, Compose), secrets_quelle: project_environments:<stage>, gesundheit: [Prüfung…] (HTTP 200, Container up, Log ohne Fehler), snapshot_vor_deploy: bool, status: geplant|wird_bereitgestellt|bereit|wird_ausgerollt|gesund|gestoert|abgebaut, kosten (vCPU, RAM, Platz), erstellt, aktualisiert)`.
Jede Stage ist zugleich ein CMDB-Eintrag (Quelle: Projektvorgang) und erscheint im Weltmodell (Schicht 1) unter Infrastruktur, damit Normalzustände (gesund) und Abweichungen (Schicht 2) dafür gelten.

**Bereitstellungskette einer Stage (deterministisch, jeder Schritt protokolliert, Rückbau in umgekehrter Reihenfolge)**
1. Proxmox: Klon aus Vorlage (oder LXC), Ressourcen laut Plan, Snapshot „frisch", wait_ready.
2. Netz: freie IP (UniFi/pfSense DHCP-Leases), DNS (Cloudflare oder intern), Firewall-Regel nur so weit wie nötig (Zielport, Quelle), Proxy-Host mit Zertifikat.
3. Satellit koppeln: Vorlagen-Image mit vorinstalliertem Satelliten oder Cloud-Init mit `alfred pair` (Pairing-Code aus dem Gehirn, Gerätename = Stage); ohne Satellit nur SSH über den Deploy-Skill.
4. Secrets der Stage aus den Projektumgebungen (nie aus dem Chat), Deploy, Gesundheitsprüfung, CMDB-Eintrag, Meldung.

**Beförderung mit Toren**
- dev → test → prod nur, wenn die harten Prüfungen der vorigen Stage grün sind (Tests, Gesundheit, ggf. Bildschirm-/Browser-Prüfung).
- Vor jedem Deploy auf test/prod ein Snapshot; Rollback-Pfad ist Teil des Plans (Deploy-Skill rollback oder Snapshot).
- **prod immer mit Owner-Bestätigung**, ebenso jede Firewall-, DNS- und Proxy-Änderung (Heimnetz: ein Fehler stört alle anderen Dienste). Autonomieklassen: Proxmox-Klon/Snapshot in dev `auto` innerhalb der Obergrenzen; test `bestaetigen` je Stage; prod, Firewall (UniFi und pfSense), DNS, Proxy, Löschen von VMs `bestaetigen`, prod-Löschen `nie` ohne ausdrückliche Owner-Freigabe.

**Gerätewahl je Etappe (Regel, nicht Raten):** macOS-Build/Notarisierung → Mac-Satellit; Linux-Tests, Docker-Builds → Ubuntu-VM oder Stage-VM; Windows-Installer → PC-Satellit (keine Claude-Code-Tests am PC, Owner-Regel 10.10.); Server-Code ohne Gerätebezug → Projekt-Agent auf .92; Datenbank-/Compose-Vorschau → Sandbox. Steht im Etappenplan und wird vom Owner mit dem Plan bestätigt.

**Korrektur 10.10. (Owner: „secrets usw. gibt es ja schon und stages?"):** Ja, teilweise. Vorhanden sind (a) die **Umgebungen** je Projekt und Stage: Tabelle `project_environments (project_id, stage, vars verschlüsselt)` mit dem Skill `environments` (set, get, list, reveal, scan_repo, delete, list_stages, copy_stage, delete_stage) — Secrets je Stage sind also gelöst, Punkt 5 der Lücken schrumpft auf „Secret-Scan vor Push" und „keine Secrets im Projektordner"; (b) der **Deploy-Skill** schreibt beim Ausrollen die `.env` aus `project_environments[stage]` aufs Ziel (v733, Standard prod). **Nicht vorhanden** ist die Stage als Infrastruktur-Objekt: welcher Rechner, welche IP, DNS, Proxy-Host, Firewall-Regel, Deploy-Ziel, Gesundheitsprüfung und Snapshot zu einer Stage gehören, und wer sie bereitstellt und abbaut. Der Begriff `stage` aus `project_environments` ist der Schlüssel, an den das neue Stage-Objekt anknüpft (gleicher Name, gleiche Werte: dev, test, prod oder frei) — keine zweite Benennung.
**Stage-Profil je Projekt (Owner 10.10.: „nicht jedes Projekt braucht alle Stages"):** Welche Stages ein Projekt hat, legt der Plan fest, nicht die Vorlage. Vorgeschlagene Profile: `nur-lokal` (Projektordner auf einem Satelliten, keine Stage — Skripte, Werkzeuge, Experimente), `dev` (eine Wegwerf-VM oder Sandbox), `dev+prod` (Heimdienst ohne Testbetrieb), `dev+test+prod` (Dienste mit Außenwirkung), `extern` (Ziel ist ein fremder Server über den Deploy-Skill, keine eigene Bereitstellung). Das Profil steht im Projektvorgang, Alfred schlägt es aus Ziel und Projektart vor, der Owner bestätigt es mit dem Plan; Tore gelten nur für vorhandene Stages (bei `dev+prod` führt das grüne dev-Tor direkt zur prod-Bestätigung). Stages lassen sich später ergänzen (eigener Vorgang, mit Bestätigung) oder abbauen.
**Obergrenzen und Kosten:** je Projekt höchstens N Stages (Vorschlag 3), vCPU/RAM/Platz-Budget aus node_stats/list_storage geprüft, bevor geklont wird; verwaiste Stages (ohne Deploy seit X Tagen) als Vorgang „Stage abbauen?" an den Owner; Rückbau nur mit Snapshot/Backup.

**Reihenfolge:** als **R5** nach R2 (Projektvorgang) — zuerst dev-Stage auf Proxmox mit Satellit-Kopplung und Deploy (Beweis mit einem Wegwerf-Projekt), dann Netz (Firewall/DNS/Proxy) mit Bestätigungen, dann Beförderungstore und Rückbau. Messen (Schicht 4): Zeit bis „Stage bereit", Fehlversuche je Schritt, Rollbacks, Ressourcen je Projekt.
### Quellcode: internes GitLab als Mitte (Erweiterung 10.10.2026, Owner: „und gitlab für internes", ohne Umsetzung)

**Vorhanden:** Code-Agent-Skill (run, push, orchestrate, list_agents) mit Forge-Client für **GitLab** (`ALFRED_GITLAB_BASE_URL`/`_TOKEN`, intern git.lokalkraft.at) und GitHub; die Projekt-Agent-Läufe arbeiten auf Branches und können pushen. Owner-Regel für Alfreds eigenes Repo: immer beide Remotes (gitlab + github).

**Regel im Projektvorgang:** Jedes Projekt hat ein Repository im internen GitLab (Alfred legt es an oder findet es), Stages hängen an Branches oder Tags: `dev` baut aus dem Feature-/Etappen-Branch, `test` aus `main` (nach Merge Request), `prod` aus einem Tag. Etappen laufen so: Claude Code arbeitet auf einem Etappen-Branch im Projektordner des Satelliten → Commit mit Etappentitel und Prüfprotokoll im Text → Push → Merge Request als **Tor**: harte Prüfungen grün (Tests, Build, Gesundheit der dev-Stage) → Merge nach `main` (dev → test automatisch nach Tor, prod nur mit Owner-Bestätigung) → Tag → Deploy der Stage aus dem Tag. Rollback = voriger Tag plus Snapshot.

**Was das bringt:** Jede Etappe ist nachvollziehbar (Diff, Prüfprotokoll, Entscheidung in der MR-Beschreibung), der Owner kann im GitLab lesen und eingreifen (MR kommentieren = Rückfrage an Alfred; `interject` des Code-Agents), Stages sind reproduzierbar (Tag statt Arbeitskopie), und der Mac-/PC-/VM-Satellit arbeitet nie auf dem einzigen Stand — der Satellit kann abgebaut werden, das Repo bleibt.

**Zu bauen (gehört zu R2/R5):** GitLab-Aktionen im Forge-Client für Repo anlegen, Branch, MR erstellen/lesen/zusammenführen, Tag, Pipeline-Status (falls CI); Satelliten-Auftrag bekommt `repo` + `branch` (Klonen/Auschecken vor dem Auftrag, Push danach — mit Deploy-Token je Projekt aus den Projektumgebungen, nie dem Owner-Token); MR-Kommentare als Ereignisquelle (Schicht 2). Autonomie: Branch/Push/MR anlegen `auto` im Projekt; Merge nach `main` `auto` nur bei grünem Tor und dev/test, prod-Tag und -Deploy `bestaetigen`; Repo löschen `nie`.
### Einordnung: Alfred bleibt der persönliche Assistent (10.10.2026, Owner-Frage „läuft das auseinander?")

**Antwort:** Nein — wenn die Schichtung eingehalten wird. Der Assistent ist das Gesicht und das Urteil (Gespräch, Ton, Prioritäten, Einfühlung in den Tag des Owners); Jarvis ist das Nervensystem darunter (Lebenszeichen, Weltmodell, Ereignisse, Vorgänge, Lernen); der Projektvorgang ist **eine Vorgangsart unter vielen** — neben Haushalt, Auto, Energie, Kalender, Familie, Gesundheit, Infrastruktur. Es gibt kein zweites Programm „Projektleiter", nur eine weitere Quelle und Handlungsklasse in derselben Maschine. Der große Plan ist deshalb kein Richtungswechsel, sondern die Nutzung der vorhandenen Schichten für eine neue Domäne.

**Wo es auseinanderlaufen könnte, und die Regel dagegen**
1. **Aufmerksamkeit:** Projektmeldungen überfluten das Gespräch. Regel: Projektfaden je Projekt, Ruhefenster, Sammelmeldungen; das Hauptgespräch bleibt dem Tag des Owners. Dringlichkeit entscheidet die Vorgangsklasse, nicht die Quelle.
2. **Kontext und Kosten:** Projekt-Werkzeuge blähen jeden Prompt. Regel: Werkzeug-Schemata nur im Vorgang (wie Geräte-Skill bei Vorhaben, v1231/v1295); der Alltags-Chat sieht den Projektvorgang als eine Zeile im Weltmodell („Projekt X: Etappe 3 läuft, 1,20 $").
3. **Persönlichkeit:** Alfred wird zum Entwicklungs-Bot. Regel: eine Stimme, dieselben Prompt-Grundsätze (deutsch, knapp, kein Jargon ohne Not), Projektberichte in derselben Haltung wie der Morgen-Satz. Die Fachsprache gehört in die Aufträge an Claude Code, nicht ins Gespräch.
4. **Prioritäten:** Ein roter Build ist nicht wichtiger als ein Arzttermin der Kinder. Regel: Vorgangsklassen mit Rang (Mensch vor Maschine, Frist vor Komfort), proaktive Meldungen gehen durch dasselbe Gate (Korrektur-Gate, Präzision je Quelle, Schicht 4) wie alle Insights.
5. **Rechte und Vertrauen:** Projektrechte dürfen nicht in den Alltag sickern. Regel: Vertrauensstufen sind zeitlich und örtlich (Projektordner, Stage) begrenzt und gelten nur innerhalb des Vorgangs; der Assistent im Alltag arbeitet mit den gewohnten Bestätigungen.
6. **Modellunabhängigkeit:** Die Schleife muss auch mit den Notmodellen laufen. Regel: harte Prüfung und feste Entscheidungsliste sind deterministisch; das Modell wählt, es erfindet nicht (Architekturgrundsatz vom 29.08.).

**Was der Assistent dadurch gewinnt:** Er kann Dinge erledigen, die bisher nur ein Vorschlag waren („Du könntest …" wird „Ich habe … vorbereitet, Etappe 1 ist grün, soll ich weiter?"); er kennt den Zustand aller Dienste und Geräte des Haushalts als Teil des Weltmodells; er lernt aus Projekten dieselben Ergebnis-Signale wie aus Erinnerungen und Insights (Schicht 4). Das I-Tüpfelchen ist nicht der Projektleiter, sondern dass derselbe Assistent, der morgens den einen Satz sagt, abends das Projekt vorzeigen kann — mit demselben Gedächtnis und derselben Stimme.

**Alltag zuerst (Owner 10.10.: „meine Mails, mein Leben — wird das zu viel?"):** Es ist nicht ein Kopf, der alles gleichzeitig hält. Jede Anfrage, jeder Rundgang, jeder Vorgang bekommt nur seinen Ausschnitt (Gespräch, Weltmodell-Kurzfassung, passende Werkzeuge); ein laufendes Projekt ist für das Mail-Gespräch eine Zeile im Weltmodell. Knapp werden können nur drei Dinge: die Aufmerksamkeit des Owners, die Kosten, und die Antwortqualität durch überladene Prompts (Lehre v1231/v1295). Daraus folgende Regeln, alle deterministisch:
1. **Aufmerksamkeitsbudget je Tag:** Höchstzahl proaktiver Meldungen insgesamt und je Vorgangsart; Projekte bekommen den Rest, nicht den Vorrang. Ruhefenster gelten für alles.
2. **Rangfolge der Vorgangsarten:** Mensch vor Maschine (Familie, Gesundheit, Termine, Mails mit Frist) vor Haus/Auto/Energie vor Infrastruktur vor Projekten. Bei Konkurrenz um Zustellung, Modellaufrufe oder Guthaben wird von unten gekürzt: **Projekte pausieren zuerst, der Alltag läuft weiter** (Planungsregel, kein Modell-Gate).
3. **Getrennte Durchsatzgrenzen:** gleichzeitige Modellaufrufe je Vorgangsart begrenzt, damit ein Projekt den Chat nie ausbremst; Messgröße: Antwortzeit des Chats (p95) während laufender Projekte unverändert.
4. **Nachtschicht:** Projektetappen bevorzugt, wenn der Owner abwesend oder schlafend ist (Anwesenheit aus HA und Chat-Aktivität, Interaktion-Schicht) und die Geräte frei sind; der Tag gehört dem Assistenten. Zwischenmeldungen sammeln sich bis zum Morgen-Satz.
5. **Gedächtnis-Hygiene:** Projektgedächtnis (project, Etappen, AUFTRAG.md, CLAUDE.md) und persönliches Gedächtnis (Erinnerungen, Familie, Gesundheit) bleiben getrennt; persönliche Inhalte gelangen nie in Auftragsdateien für Claude Code oder in Stage-Umgebungen. Prüfbar: Secret- und PII-Scan der Auftragsdatei vor dem Start.
6. **Alltagsproben vor jedem Release:** Die synthetischen Proben (Schicht 0, 06:50) um feste Alltagsszenarien erweitern (Mail zusammenfassen, Termin anlegen, Erinnerung, Hausfrage, Insight-Gate) und als Pflichtlauf auf der Ubuntu-VM vor Deploys — damit Projektarbeit den Alltag nie unbemerkt verschlechtert.
7. **Weltmodell füttert den Alltag:** Dienste, Geräte, Projekte stehen als Zustand im Weltmodell, damit Alltagsantworten Zusammenhänge kennen („der Server war nachts weg, deshalb kam die Mail nicht"). Das ist der Gewinn, nicht die Last.
8. **Kostenbild nebeneinander:** Tagesabschluss zeigt Kosten je Vorgangsart (Alltag, Haus, Infrastruktur, Projekte) in einer Zeile; Projekte haben ein eigenes Budget und dürfen das Alltagsbudget nicht anzapfen.
**Messbar halten (Schicht 4):** Anteil Projektmeldungen an allen proaktiven Meldungen (Zielkorridor), Reaktionsquote darauf, Korrekturen des Owners mit Bezug auf Ton oder Timing, Kosten je Vorgangsart nebeneinander — wenn Projekte den Alltag verdrängen, zeigt es die Wochenkennzahl, bevor es der Owner spürt.
### Lücken im Plan (Selbstprüfung 10.10.2026, Owner: „was fehlt dem Plan noch?", ohne Umsetzung)

1. **Bedienung eines laufenden Projektvorgangs:** eigener Gesprächsfaden je Projekt (Fäden existieren seit v1330) für alle Zwischenmeldungen, damit das Hauptgespräch nicht überläuft; Befehle `Stand`, `Pause`, `Weiter`, `Stopp`, `Ziel ändern`, `Einwurf` (wie `interject` des Code-Agents); Kachel „Projekte" in Apps und Web (Etappen, Kosten, Stage-Gesundheit, nächste Entscheidung); „Warum?" über die Schrittkette.
2. **Störfälle:** Satellit geht offline, Claude Code hängt (Höchstdauer je Auftrag, Abbruch, Wiederanlauf mit `--resume <session_id>` — die Sitzungs-ID wird schon gespeichert), Server-Neustart mitten im Vorgang (Vorgang muss aus der Datenbank fortsetzbar sein wie Vorhaben über `vorhabenDatei`), halbe Etappen (Etappe ist erst nach Prüfung „erledigt", sonst Wiederholung), Guthaben/Limits von Claude Code und der Modelle.
3. **Gleichzeitigkeit:** mehrere Projekte parallel, dasselbe Gerät für zwei Aufträge (ein Auftrag je Gerät gleichzeitig, Warteschlange), Sperre je Projektordner, Verfügbarkeit der Geräte (PC nachts aus, MacBook unterwegs — Planung nach Online-Status aus den Sinnen, sonst Etappe wartet oder wechselt das Gerät).
4. **Unabhängige Prüfung:** Abnahmekriterien schreibt Alfred bei der Planung, nicht der Bauende; zusätzlich ein getrennter Prüf-Auftrag („Prüfer") in frischer Sitzung ohne Kenntnis des Bau-Verlaufs; Code-Review über `review_codebase` als eigene Etappe vor dem Merge; selbstgeschriebene Tests allein zählen nicht als Tor.
5. **Geheimnisse und Daten:** keine Secrets im Projektordner (Claude Code liest alles); Einspeisung nur beim Deploy aus den Projektumgebungen je Stage; Secret-Scan und Lizenzprüfung vor jedem Push; keine Produktivdaten in dev/test (Sandbox-Datenbank, anonymisierte Auszüge); Backup vor Migrationen.
6. **Projektregeln für den Bauenden:** Alfred erzeugt je Projekt eine CLAUDE.md (Sprache, Konventionen, verbotene Bereiche, Abnahmeform) — im Beweis hat Claude Code eine vorhandene CLAUDE.md beachtet; Vorlagenbibliothek (Node, Python, Flutter, Compose) verkürzt Etappe 1; Lehren je Projekt landen im Projektgedächtnis (decisions).
7. **Einheitliche Rechtetabelle:** Autonomieklassen gelten heute für Geräteaktionen; der Projektvorgang braucht eine Tabelle über Geräte- UND Server-Skills (Proxmox, UniFi, pfSense, DNS, Proxy, Deploy, GitLab) je Stage-Typ, aus der Vertrauensstufe und Tore abgeleitet werden — eine Quelle statt verstreuter Regeln.
8. **Nach dem Projekt:** Übergabe an den Betrieb (Monitor, Updates, Backups, CMDB-Lebenszyklus, Verantwortlicher), sonst sammeln sich Stages ohne Pflege; Rückbau-Vorgang für Projekte, die nicht weitergeführt werden.
9. **Windows und Mac konkret:** Windows-Satellit läuft in der Benutzersitzung (Abmeldung beendet Aufträge), Defender und PowerShell-Richtlinien für Skripte, Pfade mit Leerzeichen; Mac ohne Claude Code/brew/tmux, Schlüsselbund für Signatur nur in der angemeldeten Sitzung (Erfahrung App-Release).
10. **Kosten als eine Zahl:** Claude-Code-Kosten (laut JSON, auch wenn das Max-Abo sie trägt), Alfreds Modellkosten je Etappe (LLM-Logzeilen), Ressourcen der Stages — ein Budget, ein Zähler, Meldung bei 80 %.
11. **Meldedisziplin:** Ruhefenster gelten auch für Zwischenmeldungen; Sammelmeldung statt Einzelzeilen bei schnellen Etappen; Rückfragen mit Optionen als Bestätigung, nie als Freitext.
12. **Pilot und Erfolgsmaß:** erst ein Wegwerf-Projekt mit Profil `dev` auf der Ubuntu-VM (Beweise nur dort), Erfolgsmaß je Release (R1: Meldung in < 1 min nach Ende; R2: ein Projekt mit ≥ 3 Etappen ohne manuellen Eingriff außer Planbestätigung; R5: dev-Stage in < 15 min bereit); Rückbau der Funktion möglich, ohne andere Vorgänge zu stören.
### Offene Owner-Entscheidungen

Standardbudget je Projektvorgang (Vorschlag 5 USD / 2 h / 8 Etappen); ob die Zusammenfassung des Claude-Code-Berichts durch ein Modell erlaubt ist (werkzeuglos) oder nur zitiert wird; erhöhter Helfer unter Windows (Docker Desktop, Systemdienste); Claude Code/brew/tmux auf dem Mac installieren; Berechtigungsmodus von Claude Code in Aufträgen (heute „auto", Alternative „acceptEdits" ohne Shell).
