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

