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

## Interessen als Wissen statt Meldungen (Entwurf 10.10.2026, Schicht 1/2 — ohne Umsetzung, Owner: „als Spec ausarbeiten, keine Freigabe")

### Ausgangslage (CHANGELOG + Code, 10.10.)

- **Ursprünglicher Zweck (v929/v930, Juli 2026):** „Alfred beobachtet Themen laufend und beantwortet ‚Was gibt's Neues zu X?' aus gesammeltem Wissen". Stiller Sammler (TopicCollector, stündlich), rollendes Dossier je Thema (`topic_digests`), automatische Themen- und Quellenpflege (Interest-Detector 05:15, Source-Provisioner, Quellen-Pflege samstags), Meldung nur über Schwelle, sonst stille Ablage; Score-Kriterium 4 „Themen-Boost" im Reasoning.
- **Tatsächliche Wirkung heute:** Chat kennt nur die Themen-**Namen** (System-Prompt) und holt das Dossier nur auf ausdrückliche Frage (`topic_briefing`); Reasoning hebt Items bei Namensgleichheit an, liest aber keine Dossiers; die Dossiers liest im Kern nur das **Content-Studio** (Social, pausiert seit 01.08.). Sichtbar ist fast nur der Digest 06:30: v1197 „756 Themen-Insights in 28 Tagen, 592 unbeachtet"; Nullpunkt 10.10.: 144–219 je Woche, 40 offen an einem Tag in der Sammlung „Hinweise".
- **Folgerung:** Die Verknüpfung „Themenwissen ↔ Alltag des Owners → Ableitung" wurde nie gebaut; der Nebenausgang (Meldungen) wurde zum Hauptkanal. Bedienbare Themenkarten würden den Nebenausgang polieren — verworfen.

### Zielbild

Interessen sind **Wissen**. Alfred nutzt es von selbst im Gespräch und meldet sich nur, wenn eine neue Information **mit etwas aus dem Leben des Owners verbunden** ist — mit einer Ableitung („betrifft deine Speichererweiterung, Frist …"), nicht mit einer Linkliste.

### Bausteine

1. **Themen melden standardmäßig nichts.** `notify_threshold = mute` (seit v1143: Dossier wird gepflegt, aber nie aktiv gemeldet). Sammler, Dossier, Quellenpflege, Interest-Detector laufen unverändert. Ein Schalter „täglich melden" je Thema bleibt für Themen, die der Owner bewusst täglich will.
2. **Verknüpfung (Schicht 2, ereignisgetrieben):** neue `topic_items` des Tages werden gegen einen **Anker-Katalog** aus dem Weltmodell (Schicht 1) geprüft: Haus/Energie (PV, Speicher, Wallbox, Tarif, Netzbetreiber), Auto, Kalender (nächste 30 Tage), offene Vorgänge und Projekte, Mail-Absender/Organisationen der letzten 30 Tage, CMDB/Infrastruktur, Familie/Interessen der Personen. Vorauswahl **deterministisch** (Begriffe, Entitäten, Synonyme je Anker, Mindestüberlappung); nur Treffer gehen in einen Mini-Pass (günstiger Tier, Ausschnitt: Beitrag mit Feed-Summary + betroffener Weltmodell-Ausschnitt), der aus einer **festen Liste** antwortet: `ableitung` (ein Satz Bezug + ein Satz Bedeutung + optional nächster Schritt), `nur_wissen` (kein Hinweis), `vorgang` (Handlung mit Frist → Vorgang). Kein Treffer → keine Meldung, kein Modellaufruf.
3. **Wissen im Gespräch:** passt eine Owner-Frage zu einem Thema (Name, Keywords, Anker), kommt ein kurzer Dossier-Auszug (höchstens ~600 Zeichen, Stand-Datum) in den Kontext — nicht nur der Name. Fakten-Treue wie v986 (Feed-Summaries, keine Schlagzeilen-Raterei).
4. **Wochenüberblick je Thema** (Lesestoff, kein Entscheidungsbedarf): ein Eintrag im Sonntags-Überblick bzw. in der Kachel, nicht in der Sammlung „Hinweise".
5. **Sammlung „Hinweise" (v1343)** zeigt Themen nur noch als abgeleitete Hinweise; Themen-Digests und Quellen-Pflege-Berichte erscheinen dort nicht mehr (Quellen-Pflege → Interessen-Ansicht bzw. Kachel).
6. **Messen (Schicht 4):** Hinweise aus Verknüpfung je Thema/Anker, Owner-Entscheidungen (erledigt/verworfen) als Präzision je Anker; Anker unter Präzision X werden nach Beobachtungszeit enger gefasst (deterministisch).

### Content-Studio / Social bleiben unberührt (Owner-Vorgabe 10.10.)

Das Content-Studio liest `topic_items` (listItems), `topic_digests` (getDigest), `interest_topics` (getTopicById, findTopicByName) und legt eigene Nischen-Themen an (createTopic). Daraus folgen harte Regeln für die Umsetzung:
- **Nur `notify_threshold` ändern**, nie `status` (active/paused/archived): der Sammler sammelt nur aktive Themen, ein pausiertes Thema würde dem Studio die Items entziehen.
- Sammler, Dossier-Fortschreibung (Digest-Builder ruft `buildSummary` auch bei `mute`), Quellenpflege und Item-Schema bleiben unverändert; keine Löschung, kein Kürzen der Item-Historie, keine Änderung an `listItems`/`getDigest`/`createTopic`.
- Vom Studio angelegte Nischen-Themen (Social-Kanäle) behalten ihre Einstellungen; der Wechsel auf `mute` betrifft nur Owner-/Auto-Themen und wird je Thema protokolliert (umkehrbar).
- Die Verknüpfung (Baustein 2) **liest** nur; sie schreibt keine Items und keine Dossiers.
- Prüfung vor jedem Release dieses Abschnitts: Studio-Probe auf der Sandbox/VM (Dossier-Sektion je Thema vorhanden, Items der letzten 7 Tage abrufbar) — auch solange die Kanäle pausiert sind.

### Risiken und Gegenmittel

- **Owner verpasst Neuigkeiten ohne Bezug:** Wochenüberblick, „Was gibt's Neues zu X?" jederzeit, Schalter „täglich melden" je Thema.
- **Falsche Verknüpfungen erzeugen Lärm:** deterministische Vorauswahl mit Mindestüberlappung, feste Antwortliste, Owner-Entscheidungen als Signal, Anker enger fassen statt Modell-Gate.
- **Dünnes Weltmodell → wenige Treffer:** leise und unschädlich; Trefferquote je Anker zeigt Lücken im Weltmodell (Schicht 1 gezielt füllen).
- **Kosten:** Modellaufruf nur bei Vorauswahl-Treffer, günstiger Tier, Tagesobergrenze je Thema.
- **Modellunabhängigkeit (Grundsatz 29.08.):** Vorauswahl, Rangfolge, Zustellweg und Drosselung deterministisch; das Modell formuliert nur die Ableitung.
- **Content-Studio:** siehe eigener Abschnitt; jede Änderung, die Status, Items oder Dossiers berührt, ist ausgeschlossen.

### Reihenfolge (nicht freigegeben)

- **I1** Alle Owner-/Auto-Themen auf `mute` (umkehrbar, protokolliert), Themen-Digests und Quellen-Pflege aus der Sammlung „Hinweise" heraus — sofort Ruhe, kein Wissensverlust, Studio unberührt.
- **I2** Dossier-Auszug im Gespräch (Baustein 3).
- **I3** Anker-Katalog aus dem Weltmodell + deterministische Vorauswahl, zuerst **beobachtend** (nur Logzeilen „wäre Hinweis geworden", zwei Wochen).
- **I4** Mini-Pass mit fester Antwortliste, Hinweise in die Sammlung, Vorgänge bei Handlung mit Frist; Wochenüberblick.
- **I5** Messen und Anker nachschärfen (Schicht 4).

### Neubewertung (12.10.2026, Owner: „ist I1 wirklich relevant? … ich habe es so verstanden, dass Alfred bei Neuigkeiten, die mit mir oder Dingen, die ich verwende, zu tun haben, diese meldet — bitte recherchieren und neu bewerten")

**Befund (CHANGELOG, Code, Live 12.10.):**
- Der Plan v927–v930 meinte: still sammeln, auf Frage antworten, über Themen-Schwelle melden, Themen-Boost für Reasoning-Hinweise. Die Verknüpfung „Neuigkeit ↔ Dinge des Owners" — das Verständnis des Owners — gab es nur auf einem **Nebenweg**: abonnierte RSS-Feeds (18, Skill `feed_reader`) liest das Modell in jedem Reasoning-Durchlauf roh und soll „nach Relevanz filtern"; Ergebnis meist Leerlauf-Sätze („Keine passenden RSS-Treffer …"), selten schwache Treffer. **Zwei Wege sammeln parallel, ohne voneinander zu wissen.**
- **I1 ist praktisch wirkungslos:** alle Themen-Digests wurden in der Woche still abgelegt (0 zugestellt), in der App seit v1344 ausgeblendet. Stummschalten änderte nichts.
- 64 aktive Themen, davon ~34 Umformulierungen derselben Interessen (Interest-Detector prüfte nur den exakten Namen), 6 071 Beiträge/Woche, ~2 300 Web-Suchen/Tag (DuckDuckGo, 74 Fehler/Tag), 27–38 Dossier-Aufrufe/Tag.

**Neue Reihenfolge (Owner 12.10. „ok wie empfohlen — dabei auch konsolidieren, wenn es sonst nichts beeinträchtigt"):**
- **I1 entfällt** (ersetzt durch Bereinigung).
- **B1 Bereinigen** — Ähnlichkeitsprüfung vor dem Anlegen/Vorschlagen durch den Detector (nicht für Owner-Anlagen, v952); Bestand zusammengeführt (archivieren, Feeds kopieren, umkehrbar). → v1366.
- **B2 Wege zusammenführen** — die abonnierten Feeds laufen zusätzlich über den Themen-Sammler (Thema „Abonnierte Feeds", stumm); ein gemeinsamer Abgleich prüft Themen-Beiträge und Feeds. Der Feed-Abschnitt im Reasoning bleibt, bis der Vergleich nach zwei Wochen zeigt, dass der Abgleich mindestens gleich gut ist; dann fallen Feed-Abschnitt und `check_all` im Reasoning weg (spart einen Kontextblock je Durchlauf, beendet die Leerlauf-Sätze). Benutzerdefinierte Feed-Watches bleiben.
- **I3 Verknüpfung beobachtend** — Anker: Hersteller/Modelle der Home-Assistant-Geräte (Victron, go-e, Shelly, Sonos, Ubiquiti, Aqara, Philips Hue, Proxmox …), Organisationen, Fahrzeug, konkrete Orte und Kürzel aus dem Wissensgraph. Titel-Treffer stark, nur Zusammenfassung schwach, je Anker höchstens 3 am Tag, ohne Modell. Offline kalibriert (6 071 Beiträge): 5 % mit Anker, Funde wie „Home Assistant 2026.10", „Shelly Plug über stündliche Strompreise steuern", „Ultraschnellladepark Altlengbach", „BMW-Modelle, die bidirektional laden"; Lärm vor allem Bitcoin in Zusammenfassungen. → v1367, Auswertung ~26.10.
- Danach unverändert I2 (Dossier-Auszug im Gespräch), I4 (Mini-Pass mit fester Antwortliste, Meldung als Hinweis — K1-Reaktionen messen die Präzision je Anker), I5.

**Entschieden (Owner 12.10.: „das sollte doch so sein, funktioniert richtig"):** die sieben Themen aus der eigenen Arbeit bleiben aktiv. — Ursprüngliche Frage: sieben Themen sehen nach Alfreds eigener Arbeit statt nach Nachrichten-Interesse aus (Web-Application Development & Feature-Parity, Mobile App Development & Cross-Platform Parity, Open-Items & Projekt-Backlog-Management, Finanzielle Rückforderungen & Zahlungsdispute, Abrechnungssysteme & Energiedatenverarbeitung, IT-Infrastruktur & Deployment-Management, Prisma ORM & Database Migrations) — pausieren oder behalten? Noch nicht geprüft: Themen-Boost bei breiten Themen, Themennamen im Chat-Prompt (geschätzt, nicht gemessen).

**Umsetzungsstand:** v1365 Leerlauf-Sätze verworfen, Inhalt dahinter behalten; v1366 Ähnlichkeitsprüfung + Bestand 64 → 30 aktiv (34 archiviert, 39 Feeds kopiert, Undo unter `data/interessen-bereinigung/`, Studio-Themen unverändert); v1367 Verknüpfung beobachtend + Feeds über den Sammler (Logzeilen „v1367 Verknüpfung: Beitrag wäre Hinweis geworden (beobachtend)", „v1367 Verknüpfung gelaufen").; v1377 I2 Dossier-Auszug im Gespräch (Owner-Freigabe 12.10.; Zuordnung über Stichwörter/Namenswörter, ≤ 600 Zeichen, dynamischer Prompt-Teil, Logzeile „v1377 Dossier-Auszug im Gespräch").
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

### R2 — Prüfung gegen den Stand 12.10. (Owner: „R2 spec prüfen", ohne Freigabe)

**Kernbefund: Die Schleife gibt es schon — im Projekt-Agenten am Server.** Der Entwurf vom 10.10. führt den Projekt-Agenten (`project-agent-runner.ts`, 2 335 Zeilen) nur als „Ausführungsziel Server". Tatsächlich enthält er bereits fast alles, was R2 neu bauen wollte:

| R2-Entwurf | vorhanden im Projekt-Agenten |
|---|---|
| Planen mit Etappen | `createProjectPlan` (Phasen), Plan-Review vor dem Start, Phasen persistiert (`plansRepo`: markRunning/markFailed, Zeiten) |
| Bauen je Etappe | `executeAgent` je Phase (claude-code/codex/mistral-vibe auf .92), Zeitlimit je Phase |
| Hart prüfen | `validateBuild` mit `buildCommands`/`testCommands` (Exit-Code), `extractBuildError` |
| Entscheiden aus fester Liste | **deterministisch**: Build grün → nächste Phase; rot → Fix-Auftrag mit Build-Fehler, höchstens `maxFixAttempts` (3); danach `awaiting_user` (= Rückfrage). Zusätzlich `assessPlanProgress`: Modell darf den Plan ändern (proceed/skip/insert/modify, Schema, Rückfall „proceed") |
| Melden | `sendProgress` je Phase ins Gespräch, Ausgabe-Puffer (SSE) |
| Grenzen | Wochenbudget je Projekt (`budgetStatusResolver`), `maxDurationHours` (8), Stopp, `interject` |
| Gedächtnis | Commit je Phase, Lessons-Loop (v825), Projekt-Skill (open items, decisions) |

Einen zweiten Projektvorgang daneben zu bauen hieße, dieselbe Schleife doppelt zu pflegen (Grundsatz „vorhandene Bausteine prüfen statt Abkürzung", Owner 12.10.). **Neuer Zuschnitt R2: der Projekt-Agent bekommt das Ausführungsziel „Satellit".** Statt `executeAgent` lokal: `auftrag_starten` auf dem Gerät und Warten auf die Ende-Meldung (R1, v1382); statt `validateBuild` lokal: `pruefen_befehl` (v1383) mit denselben Build-/Test-Befehlen; Dateiliste aus dem Ende-Ereignis statt `git diff` am Server. Dafür eine schmale Schnittstelle „Arbeitsplatz" im Runner (agentAusfuehren, befehlePruefen, geaenderteDateien, commit) mit den Umsetzungen `server` (heutiges Verhalten, unverändert) und `satellit:<geraetId>`.

**Was vom Entwurf bleibt, was entfällt**
- Bleibt: Ziel, Beweis nur auf der Ubuntu-VM, Wegwerf-Projekt als Pilot, Erfolgsmaß, Meldung nach jeder Etappe, Budget/Zeit/Etappenzahl.
- Entfällt: eigene Tabellen `projektvorgang`/`etappe` (es gibt Sitzungen und Phasen des Projekt-Agenten), der Entscheidungsschritt per Modell aus der festen Liste (die Entscheidung ist heute schon deterministisch und braucht die Ausgabe von Claude Code nicht — damit entfällt das Hauptrisiko des Entwurfs), das 10-Minuten-Abfragen (R1 meldet das Ende sofort; als Rückfall reicht `auftrag_stand` nach Ablauf des Phasen-Zeitlimits).
- Sichtbarkeit: Jede Projekt-Sitzung wird zusätzlich ein **Vorgang** (Quelle `projekt`, Besitzer Alfred, Ergebnis am Ende) — damit erscheint sie in Lage, App-Ansicht „Vorgänge" und im Ausführungsgedächtnis, ohne neue Ansicht.

**Lücken, die R2 wirklich schließen muss**
1. **Freigabe für die Dauer eines Projekts.** Vorhaben sind auf 120 min begrenzt (`VORHABEN_MAX_MIN`), ein Projekt läuft Stunden. Neu: **Projektfreigabe** — mit der Planbestätigung freigegeben werden genau zwei Geräteaktionen (`auftrag_starten`, `pruefen_befehl`) auf einem Gerät, nur im bestätigten Projektverzeichnis, bis Budget, Zeitlimit oder Ende der Sitzung. Alles andere (Shell, Dateien außerhalb, Netz, Deploy) bleibt einzeln zu bestätigen. Das ist bewusst enger als die Vertrauensstufe „projekt" (R3, nur lokal am Gerät setzbar).
2. **Prüfbefehle festlegen.** Am Server kommen `buildCommands`/`testCommands` aus der Projektkonfiguration; für ein neues Projekt auf dem Satelliten schlägt der Plan sie vor, der Owner sieht sie in der Planbestätigung. Ohne Prüfbefehl keine automatische nächste Etappe (dann je Etappe Rückfrage).
3. **Umplanen per Modell absichern.** `assessPlanProgress` liest heute schon 400 Zeichen Agent-Ausgabe und Build-Ausgabe und darf Phasen **einfügen oder ändern**. Auf einem Satelliten würde eine eingeschleuste Anweisung so zu einem neuen Claude-Code-Auftrag. Regel: beim Ziel Satellit sind nur `proceed` und `skip` automatisch; `insert`/`modify` gehen als Rückfrage an den Owner (deterministisches Tor, modellunabhängig). Für den Server unverändert lassen, aber als Befund vermerken.
4. **Kosten.** Claude Code meldet Kosten je Auftrag (R1-Ereignis); sie werden auf das Projektbudget gebucht (heute zählt der Runner nur Server-Läufe).
5. **Neustarts.** Läuft eine Sitzung, während das Gehirn neu startet (Selbstupdate!), muss sie fortsetzbar sein: Phase und Auftrags-ID stehen in `plansRepo`/Auftrags-Zuordnung (v1383), `resume` setzt mit dem nachgereichten Ende fort. Selbstupdate wartet bereits auf laufende Vorhaben; das muss auch für Projekt-Sitzungen gelten.
6. **Commits.** Am Satelliten committet Claude Code selbst (Auftragstext: „am Ende committen mit Etappentitel"); der Runner prüft per `pruefen_befehl` „git status sauber". Push/GitLab erst mit dem GitLab-Abschnitt (später).

**Risiken**
- Die Ausgabe von Claude Code erreicht ein Modell nur noch im Umplanen (Punkt 3, mit Tor); Meldungen bleiben modellfrei (R1).
- Der Runner ist groß und produktiv genutzt: Die Arbeitsplatz-Schnittstelle muss das Server-Verhalten unverändert lassen (bestehende Tests `project-agent-runner.test.ts`, Push-Guard), Umbau in kleinen Schritten.
- Claude Code auf dem Satelliten läuft im Modus „auto" (Standard) — keine Freigabe für `--dangerously`.

**Vorgeschlagene Reihenfolge (je ein Release mit Beweis auf der Ubuntu-VM)**
- **R2a** Arbeitsplatz-Schnittstelle im Runner, Umsetzung `server` = heutiger Code (reiner Umbau, Tests grün, kein Verhaltenswechsel).
- **R2b** Umsetzung `satellit`: Auftrag + Warten auf Ende + Prüfbefehle + Kosten; Projektfreigabe (Lücke 1); Tor für Umplanen (Lücke 3). Beweis: Wegwerf-Projekt mit 3 Etappen auf der VM ohne Eingriff außer Planbestätigung.
- **R2c** Vorgang je Sitzung, Fortsetzen nach Neustart, Selbstupdate wartet.

**Owner-Entscheidungen**
1. Neuer Zuschnitt (Projekt-Agent erweitern statt eigener Projektvorgang) — ja/nein?
2. Projektfreigabe wie in Lücke 1 (zwei Aktionen, ein Verzeichnis, bis Budget/Zeit) — oder je Etappe bestätigen?
3. Umplanen beim Satelliten: `insert`/`modify` als Rückfrage — oder ganz aus?
4. Standardgrenzen für ein Satelliten-Projekt: Vorschlag 5 USD, 4 h, höchstens 8 Etappen, 3 Fix-Versuche je Etappe.
5. Gilt Punkt 3 (Tor beim Umplanen) auch für den Server-Agenten?

**Entscheidungen und Umsetzung (Owner 12.10. „ok wie empfohlen freigegeben", Rückfrage „funktioniert der Projekt-Agent am Server weiter wie bisher?" → ja):** 1 ja, 2 Projektfreigabe, 3 Rückfrage, 4 Standardgrenzen 5 USD/4 h/8 Etappen/3 Fix-Versuche, 5 Server unverändert.
**Änderung Owner 12.10. abends (v1394):** Budget und Zeitgrenze NUR, wenn der Owner sie nennt (Entscheidung 4 ersetzt); mit Budget Restbudget je Auftrag als --max-budget-usd. Aufträge mit --setting-sources project,local (claude-flow-Hooks der VM bremsten). Satellit prüft jede Minute auf beendete, ungemeldete Aufträge.
**Abweichung bei der Umsetzung (v1387):** Statt einer Arbeitsplatz-Schnittstelle im Runner (R2a) ein eigener schlanker Ablauf `core/projekt/satellit-projekt.ts` — der Runner arbeitet an ~80 Stellen direkt am Server-Dateisystem (Git-Init, Branches, Sandbox, Lock, Review, Push, Self-Heal); Zweige dort hätten den Server-Weg gefährdet. Wiederverwendet: `createProjectPlan`, `assessPlanProgress`, `applyMutation`, Bestätigungs-Queue, Vorgänge, R1-Bausteine. `project-agent-runner.ts`, Planer und Prüfer sind unverändert (leerer Diff). Selbstupdate wird nicht blockiert (bis 4 h Sperre wäre schlecht); stattdessen Fortsetzen nach Neustart aus `data/projekte-satellit/` (R2c). Einstieg: `project_agent start` mit `geraet`; Rückfragen als Bestätigung mit Einmal-Kennung (`satellit_antwort`), „weiter ohne Planänderung" mit `satellit_weiter`.

### Reihenfolge der Umsetzung (nicht freigegeben)

- **R1** (umgesetzt: Ende-Meldung v1382, Prüfschritte `pruefen`/`pruefen_befehl` und Zuordnung über Neustarts v1383 — Owner-Freigabe 12.10.; „Text im Bildschirm" über die Element-Karte, Bildschirmfoto-OCR nicht) Ende-Meldung deterministisch: Satellit sendet `GeraetEreignis`, Gehirn meldet ohne Modell („Auftrag X fertig, Dauer, Kosten, Dateien") in die Sitzung des Starts; harte Prüfschritte als Geräteaktion `pruefen` (Datei, Befehl, HTTP, Text im Bildschirm).
- **R2** Projektvorgang + Etappen im Datenmodell, Planung mit Owner-Bestätigung, Schleife mit fester Entscheidungsliste, Meldungen, Budget; Ausführungsziel Satellit zuerst (Beweis nur Ubuntu-VM), dann Server-Agent.
- **R3** Vertrauensstufe „projekt" (lokal setzbar), Leseaktion „installiert?", Installationen im Benutzerbereich.
- **R4** Beobachter am Satelliten (Outlook, Benachrichtigungen, Ordner) als Schicht-2-Ereignisse mit Job-Register-Eintrag; Deploy-Etappe mit Nachkontrolle.
- **Messen (Schicht 4)**: Etappen je Vorgang, Nachbesserungsquote, Rückfragenquote, Kosten je fertiger Etappe, Abbrüche durch Budget; Konsequenzen deterministisch (z. B. Nachbesserungsquote > 50 % → Planungsschritt auf teureren Tier).

### Stages: dev, test, prod je Projekt (Erweiterung 10.10.2026, Owner: „ja mach das, pfSense nicht vergessen", ohne Umsetzung)

**Gedanke:** Alfred hat alle Infrastruktur-Skills schon; was fehlt, ist die Klammer „Stage" im Projektvorgang, damit er Umgebungen selbst bereitstellt, befördert und zurückbaut — mit festen Toren statt freier Improvisation.

**Vorhandene Bausteine je Schritt**
- Rechner: **Proxmox** (clone_vm, create_lxc aus Vorlagen, wait_ready, create/rollback_snapshot, backup_vm, start/stop/shutdown, node_stats, list_storage).
- Netz: **UniFi** (next_free_ip, create_firewall_rule, list_networks/clients; Standort Dream Machine Pro) — **Korrektur 12.10.:** create_firewall_rule/list_firewall_rules nutzen das alte Regelmodell (`rest/firewallrule`, auf Network 11.0.81 leer); die UDM arbeitet zonenbasiert (`v2/firewall-policies`, 263 Policies). Firewall-Änderungen über Alfred brauchen erst neue Aktionen auf dem Policy-Modell — **umgesetzt v1386** (list/create/set_enabled/delete_firewall_policy über Integration-API v1, Reihenfolge mit before_policy, Einmal-Freigabe nach Owner-Bestätigung), **pfSense** (create_rule/delete_rule, list_rules, list_vlans, list_dhcp_leases, list_gateways, status — zweite Firewall-Welt, gleiche Autonomieklasse), **Cloudflare DNS** (Einträge), **Nginx Proxy Manager** (create/update/delete_host, Zertifikate).
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

**Projektgespräche (Owner 10.10.: „Projekte könnten in eigenen Unterhaltungen laufen, der Haupt-Alltagschat weiß Bescheid"):** Jeder Projektvorgang bekommt einen eigenen Gesprächsfaden (`owner:faden:<projekt>`, Fäden seit v1330 in Telegram, Apps, Web und Terminal gleich). Dort laufen Planung, Etappenmeldungen, Rückfragen und Berichte. Das Hauptgespräch kennt den Stand über das Weltmodell (eine Zeile je Projekt) und bleibt der Ort für den Tag: Fragen dort („wie steht das Projekt?") werden aus dem Projektgedächtnis beantwortet, Aufträge dort („bau in Projekt X noch …") werden als Etappe in den Projektfaden gelegt — kurze Rückmeldung im Hauptgespräch („übernommen, läuft im Faden X"), Verlauf und Ergebnis im Projektfaden. Umgekehrt steigt aus dem Projektfaden nur das ins Hauptgespräch, was Rang hat (Rückfrage mit Frist, Budgetgrenze, prod-Freigabe), alles andere wartet auf den Morgen-Satz oder die Kachel. Technisch: `/faden` kennt das Projekt (Faden wird beim Anlegen des Vorgangs erzeugt und mit dem Vorgang verknüpft), die Fortsetzung nach Freigabe (v1341) und die Ende-Meldung zielen auf den Projektfaden statt auf die Startsitzung, und die Apps zeigen Projektfäden in der Seitenleiste mit Statuspunkt.
**Alltag zuerst (Owner 10.10.: „meine Mails, mein Leben — wird das zu viel?"):** Es ist nicht ein Kopf, der alles gleichzeitig hält. Jede Anfrage, jeder Rundgang, jeder Vorgang bekommt nur seinen Ausschnitt (Gespräch, Weltmodell-Kurzfassung, passende Werkzeuge); ein laufendes Projekt ist für das Mail-Gespräch eine Zeile im Weltmodell. Knapp werden können nur drei Dinge: die Aufmerksamkeit des Owners, die Kosten, und die Antwortqualität durch überladene Prompts (Lehre v1231/v1295). Daraus folgende Regeln, alle deterministisch:
1. **Aufmerksamkeitsbudget je Tag:** Höchstzahl proaktiver Meldungen insgesamt und je Vorgangsart; Projekte bekommen den Rest, nicht den Vorrang. Ruhefenster gelten für alles.
2. **Rangfolge der Vorgangsarten:** Mensch vor Maschine (Familie, Gesundheit, Termine, Mails mit Frist) vor Haus/Auto/Energie vor Infrastruktur vor Projekten. Bei Konkurrenz um Zustellung, Modellaufrufe oder Guthaben wird von unten gekürzt: **Projekte pausieren zuerst, der Alltag läuft weiter** (Planungsregel, kein Modell-Gate).
3. **Getrennte Durchsatzgrenzen:** gleichzeitige Modellaufrufe je Vorgangsart begrenzt, damit ein Projekt den Chat nie ausbremst; Messgröße: Antwortzeit des Chats (p95) während laufender Projekte unverändert.
4. **Nachtschicht:** Projektetappen bevorzugt, wenn der Owner abwesend oder schlafend ist (Anwesenheit aus HA und Chat-Aktivität, Interaktion-Schicht) und die Geräte frei sind; der Tag gehört dem Assistenten. Zwischenmeldungen sammeln sich bis zum Morgen-Satz.
5. **Gedächtnis-Hygiene:** Projektgedächtnis (project, Etappen, AUFTRAG.md, CLAUDE.md) und persönliches Gedächtnis (Erinnerungen, Familie, Gesundheit) bleiben getrennt; persönliche Inhalte gelangen nie in Auftragsdateien für Claude Code oder in Stage-Umgebungen. Prüfbar: Secret- und PII-Scan der Auftragsdatei vor dem Start.
6. **Alltagsproben vor jedem Release:** Die synthetischen Proben (Schicht 0, 06:50) um feste Alltagsszenarien erweitern (Mail zusammenfassen, Termin anlegen, Erinnerung, Hausfrage, Insight-Gate) und als Pflichtlauf auf der Ubuntu-VM vor Deploys — damit Projektarbeit den Alltag nie unbemerkt verschlechtert.
7. **Weltmodell füttert den Alltag:** Dienste, Geräte, Projekte stehen als Zustand im Weltmodell, damit Alltagsantworten Zusammenhänge kennen („der Server war nachts weg, deshalb kam die Mail nicht"). Das ist der Gewinn, nicht die Last.
8. **Kostenbild nebeneinander:** Tagesabschluss zeigt Kosten je Vorgangsart (Alltag, Haus, Infrastruktur, Projekte) in einer Zeile; Projekte haben ein eigenes Budget und dürfen das Alltagsbudget nicht anzapfen.
**Nullpunkt (Ist-Aufnahme 10.10.2026 02:30, nur lesen; Owner: September wenig genutzt, davor Entwicklung — kein Normalzustand):**

| Größe | Wert | Lesart |
|---|---|---|
| Owner-Nachrichten je Woche | Sept. 1–11 (Telegram); Woche ab 05.10.: 189 Telegram + 280 api (Beweisläufe) | Alltag kaum gemessen, Entwicklungswoche dominiert |
| LLM-Kosten je Tag | 1.–5.10. 1,0–2,4 $ (nur Fallback mistral, Guthaben aus); 6.–9.10. 14,9 / 16,4 / 9,6 / 6,4 $ | gpt-6.1-sol trägt 28 $ von 55 $ in 10 Tagen; Haiku (638 Aufrufe) 0,70 $ |
| Antwortzeit Pipeline | p50 10,7 s, p95 69 s (n=481, 10 Tage) | Messlatte: darf durch Projekte nicht steigen; schon jetzt zu langsam |
| Insights je Woche | 150–220, davon „interests" 144–219, fast alle expired; acted 4/Woche im Sept. | lauteste Quelle ohne Reaktion → zuerst senken |
| Vorgänge (Woche ab 05.10.) | 156 (123 Owner, 33 Alfred); erledigt 61, verworfen 61, offen 30 | Reasoning-Vorgänge ≈ 50 % verworfen |
| Bestätigungen gesamt | 3 484 expired, 696 approved, 40 rejected; expired je Skill: itsm 64, project_agent 10, email 8 (35 Tage) | reasoning stellt Fragen, die niemand beantwortet |
| Fehler 7 Tage | email 39, geraet_macbook 19, geraet_ubuntu_vm 13, geraet_office_vm 12 | E-Mail-Skill zuerst prüfen |
| Job-Register 7 Tage | 25 Jobs, ≈700 Läufe je 10-min-Job, Fehler nur bmw-rest-poll 3, mail-ereignisse 1 | Schicht 0 hält |
| Erinnerungen | 22–28 je Woche (Sept.), 9 (Entwicklungswoche) | echter Alltagsnutzen, klein |

Folgerung: Das Aufmerksamkeitsbudget (Regel 1) muss zuerst den Bestand senken (Interessen-Insights, unbeantwortete Reasoning-Bestätigungen), bevor Projektmeldungen dazukommen; E-Mail-Fehler und Antwortzeit sind Alltagsschulden vor jedem Projektvorgang. Details und Skripte: Gedächtnis `ist-aufnahme-2026-10-10`.
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

## Projekte sichtbar und fortsetzbar (Entwurf 12.10.2026, R2-Folge — ohne Umsetzung, Owner: „man sieht in der App oder im Web außer beim Bauen nichts vom Projekt … dort ersichtlich machen und dann bei Weiterarbeiten auswählen, um ihm zu sagen, was man weiter will — das Drumherum sollte er selbst wissen", keine Freigabe)

### Ist-Stand (belegt 12.10.)

- Ein Geräte-Projekt ist heute ein **Lauf** (`sat-…`, Datei `data/projekte-satellit/<id>.json`): Plan, Etappen, Kosten, Gerät, Pfad, Prüfbefehle. In App und Web erscheint er nur als Vorgang (`quelle 'projekt'`): offen, solange er läuft, danach 7 Tage unter „abgeschlossen" (`uebersicht(owner, 7)`), dann nicht mehr.
- Weiterarbeiten startet einen **neuen, unverbundenen Lauf**: Der Owner muss Gerät, Pfad, Bestand („bestehende App, Beschreibung in docs/README.md") und Testbefehl erneut nennen; der Planer sieht nur diesen Text, nicht den Code und nicht die früheren Etappen. Realfall 12.10. 22:27: `sat-a08a7d26` (Merkliste) neben `sat-42080afb` (Grundgerüst) im selben Ordner `/home/madh/claudecode/game` — für Alfred zwei fremde Läufe.
- Vorhandene Bausteine, die das Ziel schon beschreiben: Lücke 1 dieses Abschnitts („Kachel Projekte in Apps und Web"), „Projektgespräche" (eigener Faden je Projekt, Hauptgespräch: „bau in Projekt X noch …"), Weltmodell-Zeile je Projekt (Lage-Zeile seit v1392), Vorgänge-Ansicht der App (1.9/1.13), Git je Projektordner (v1396/v1397).

### Zielbild

**Projekt = dauerhafte Akte, Lauf = Episode darin.** Die Akte kennt das Drumherum; der Owner sagt nur noch, *was* er will.

### Bausteine

1. **Projektakte** (Server, `data/projekte-satellit/akten.json` oder Tabelle `projekt_akten` — Entscheidung bei der Umsetzung nach dem Muster der Vorgänge): `prj-<kurz>`, Name (Alfred schlägt ihn aus dem Ziel vor, z. B. „Supermarkt-Angebote"; Owner kann umbenennen), Gerät (ID + Name), Pfad, Beschreibung (Ziel des ersten Laufs + README-Pfad, falls vorhanden), Prüfbefehle, Git ja/nein, Läufe (`sat-…` mit Ziel, Status, Etappen, Kosten, Zeitraum), Kosten gesamt, letzte Aktivität, Status `aktiv` / `ruht` / `archiviert`. **Zuordnung deterministisch:** gleicher Gerät-+Pfad-Schlüssel = dieselbe Akte. **Migration:** vorhandene `sat-*.json` nach (Gerät, Pfad) gruppiert → Akten; Probe-Ordner (`r1-probe`, `r2-probe`, …) als `archiviert` vorschlagen, nicht selbst entscheiden.
2. **Anzeige in App und Web** (Bereich „Projekte", in der App neben „Vorgänge"): Liste mit Name, Gerät, Status (läuft · wartet auf dich · ruht), letzte Etappe, Kosten gesamt, letzte Aktivität. Detail: Läufe mit ihren Etappen (✅/❌, Kosten, Dauer), Commits aus dem Repository (neueste zuerst), Prüfbefehle, Pfad. Knöpfe: **Weiterarbeiten**, **Frage stellen**, **Stand** (bei laufendem Projekt mit Live-Schritten wie heute `status`), **Archivieren**. API: `GET /api/projekte`, `GET /api/projekte/:id`, `POST /api/projekte/:id/weiter {text}`, `POST /api/projekte/:id/frage {text}` — Verdrahtung wie Vorgänge (`setXxxCallbacks` am apiAdapter, Aktion durch den Skill).
3. **Weiterarbeiten mit Kontext:** `project_agent` neue Aktion `weiter` (Akte + Wunschtext). Alfred setzt Gerät, Pfad, Prüfbefehle und Git aus der Akte und baut dem Planer einen **Bestandsblock** (als Daten, nicht als Anweisung): Beschreibung, README-Auszug (≤ 4 KB), Dateiliste der obersten zwei Ebenen, Titel der bisherigen Etappen, letzte Commits. Planregel im Prompt: „bestehendes Projekt erweitern, nichts neu anlegen, was es gibt". Danach unverändert: eine Planfrage, eine Freigabe, Etappen mit Abnahme. Im Gespräch ohne App: „Am Supermarkt-Projekt weiter: …" — der Akten-Name wird deterministisch erkannt (Namensliste der Akten in der Werkzeugwahl wie `PROJEKT_AUF_GERAET`, v1389), bei mehreren Treffern Rückfrage mit Optionen.
4. **Projekt lesen** (Satellit, neue Aktion `projekt_lesen`, Autonomie `auto`, nur lesend): README, `package.json`/`pyproject.toml`, Dateibaum (Tiefe 2, ohne `node_modules`/`.git`), `git log -n 10` — nur in freigegebenen Verzeichnissen, nur Textdateien, Größen gedeckelt. Grundlage für 3 und für die Detailansicht (Commits). Inhalt geht an den Planer nur als Daten (Fremdinhalt, Prompt-Injection-Regel wie Nachforschen).
5. **Frage zum Projekt** (Vorschlag 12.10., vom Owner für gut befunden): Claude Code im **Nur-Lese-Modus** (`--permission-mode plan` und/oder `--disallowedTools` für Schreiben/Shell — bei der Umsetzung an Claude Code 2.1.296 auf der VM belegen, nicht annehmen), Autonomie `auto`, weil technisch nichts geändert werden kann; Antwort direkt in die fragende Sitzung bzw. im Projektdetail; Kosten in der Akte. Ohne diesen Nachweis bleibt die Aktion `bestaetigen`.
6. **Projektfaden** (aus „Projektgespräche"): optional als letzter Schritt — Etappenmeldungen im Faden der Akte statt im Hauptgespräch; Hauptgespräch behält Lage-Zeile und Rückfragen mit Rang.

### Reihenfolge (nicht freigegeben)

**P1** Akte + Migration + Zuordnung je Lauf + `GET`-API (Beweis: `sat-42080afb` und `sat-a08a7d26` in einer Akte „Supermarkt-Angebote") → **P2** `projekt_lesen` + Weiterarbeiten mit Bestandsblock im Gespräch (Beweis: „Am Supermarkt-Projekt weiter: …" ohne Pfad/Gerät/Testbefehl → Plan erweitert statt neu, Abnahme `npm test`) → **P3** App/Web-Bereich „Projekte" mit Weiterarbeiten/Stand/Archivieren (App-Release) → **P4** Frage zum Projekt (Nur-Lese-Nachweis zuerst) → **P5** Projektfaden.

### Abnahme (messbar)

Ein zweiter Lauf im selben Ordner landet ohne Zutun in derselben Akte; „weiter" braucht nur den Wunschtext (keine erneute Angabe von Gerät, Pfad, Testbefehl); der Plan des zweiten Laufs enthält keine Etappe „Grundgerüst/Projekt anlegen" für ein bestehendes Projekt; abgeschlossene Projekte bleiben nach 7 Tagen sichtbar; eine Frage ändert nachweislich keine Datei (`git status` leer danach).

### Risiken

Fremdinhalt aus dem Projekt im Planer-Prompt (nur als Daten, gekürzt); falsche Akte bei verschobenen Ordnern (Schlüssel Gerät+Pfad, Umzug als eigene Aktion); App-Ansicht ohne Server-Stand bei älteren Servern (Feature-Abfrage wie bei Befunden).

### Offene Owner-Entscheidungen

1. Akte in Datei (wie Läufe heute) oder Datenbank-Tabelle (wie Vorgänge, für Web/App-Abfragen und Verlauf) — Empfehlung Tabelle.
2. Projektname: Alfred schlägt vor und fragt mit der Planfrage mit, oder erst beim ersten „weiter".
3. Frage zum Projekt: ohne Bestätigung nur mit belegtem Nur-Lese-Modus (Empfehlung) — oder immer mit Bestätigung.
4. Probe-Ordner `r1-probe`, `r2-probe`, `hallo-alfred` auf der VM: löschen oder als archivierte Akten behalten.

### Owner-Entscheidungen und Umsetzungsstand (12./13.10.2026)

Owner 12.10.: „wie empfohlen freigegeben, Projektnamen soll auch genannt werden können“; Probe-Ordner gelöscht. Nach P1 (v1398, eigene Tabelle projekt_akten) fiel auf, dass das Projekt-System `projects` (Web „Projects“, Projekt-Chat, offene Punkte) schon existiert. Owner: „ja wie vorgeschlagen machen“ → **integriert**: v1399/v1400 Geräte-Projekte = `projects` mit `geraet_id`, Lauf = `project_sessions` (Typ geraet), Server-Funktionen im Projektordner gesperrt (Web-API 409, Skill `project`, list()/findByCwd() ohne Geräte-Projekte). Web-Detailansicht (v1399, vom Owner geprüft), App-Ansicht „Projekte“ (v1401/v1402, App 1.15.0), Herkunft App-Sitzung und Freigeben/Ablehnen direkt in der Projektansicht (v1403, App 1.15.1), **P4 Frage zum Projekt** (v1404, App 1.15.2): Claude Code im Plan-Modus mit gesperrten Schreib-/Shell-Werkzeugen, ohne Bestätigung, 0,50 USD je Frage; Nachweis VM 13.10. 00:02 (Ändern/Anlegen/Löschen verlangt → unverändert) und 00:11 am Owner-Projekt (Antwort nach 37 s, 0,32 USD, Commit/Status/Dateizeiten unverändert). P5 Projektfaden: Projekt-Chat je Projekt besteht im Web; Etappenmeldungen gehen weiter an Herkunft + Telegram.

## R3 neu zugeschnitten: Umgebung und Installationen (Prüfung 13.10.2026, ohne Umsetzung — Owner: „ok“ zu „R3 prüfen und als Spec ausarbeiten“)

### Ist-Stand (belegt 13.10.)

- **Bauen läuft über Claude Code**, nicht über Alfreds eigene Geräteaktionen: Projektfreigabe (`auftrag_starten`, `pruefen_befehl`, ein Verzeichnis) seit R2. In den Owner-Läufen am Angebots-Radar (5 Läufe, 12.–13.10.) gab es außer Plan und Planänderung keine Einzelbestätigung. Der ursprüngliche Grund für die Vertrauensstufe „projekt“ (Shell/Dateien im Projektordner ohne Einzelbestätigung) ist damit weitgehend entfallen.
- **Umgebung unbekannt beim Planen:** Planer und Claude Code erfahren erst in der Etappe, was installiert ist. Ubuntu-VM: Node 22 und Docker (Snap), npm, Python 3, Git, Yarn; kein pnpm, Java, Go, Rust, Flutter; 80 GB frei.
- **Systeminstallationen haben keinen geregelten Weg.** Auf der VM geht `sudo` ohne Passwort; Claude Code im Modus „auto“ könnte damit systemweit installieren. In den bisherigen Protokollen (`~/.alfred/auftraege/*/log.txt`) kommt kein `sudo`/`apt` vor, ausgeschlossen ist es aber nicht. Mac (brew ohne sudo) und PC (winget) sind ähnlich offen.

### Neuer Zuschnitt

- **R3a Umgebung lesen** (auto, nur lesend): `projekt_lesen` liefert zusätzlich `umgebung` — Betriebssystem, Versionen von node/npm/pnpm/yarn/python/pip/docker/git/java/go/cargo/flutter (je `--version`, Zeitlimit, fehlend = „fehlt“), freier Platz. Verwendet im Bestandsblock des Planers, als Zeile in der Planfrage („Umgebung: Node 22, Python 3.12, Docker; fehlt: pnpm“) und im Etappen-Auftrag („vorhanden: …; fehlt: … — nicht systemweit installieren, sondern melden“).
- **R3b Systemänderungen aus Claude Code heraus sperren:** Projekt-Aufträge zusätzlich mit gesperrtem `sudo` (Regel-Syntax für `--disallowedTools` bei der Umsetzung an Claude Code 2.1.296 auf der VM belegen, wie beim Nur-Lese-Modus). Projekt-lokale Abhängigkeiten (`npm install` im Projekt, Python-venv) bleiben erlaubt.
- **R3c Installieren als eigene, bestätigte Geräteaktion** `installieren {paket, quelle}`: Quellen fest (siehe Entscheidung 2), Paketname per Muster geprüft (kein freier Befehl, keine Optionen), je Installation eine Bestätigung mit Gerät, Paket und Quelle. Auslöser: scheitert eine Etappe erkennbar an einem fehlenden Werkzeug (Prüfprotokoll „command not found“/„not installed“, deterministisch erkannt), fragt Alfred „X auf <Gerät> installieren?“ statt eines Fix-Versuchs; nach der Installation läuft die Etappe erneut.
- **R3d Vertrauensstufe „projekt“ (lokal setzbar) zurückstellen:** kein Bedarf belegt. Messen statt bauen: Einzelbestätigungen je Projektlauf (Schicht 4); wird sie wiederholt gebraucht, neu vorlegen.

### Reihenfolge (nicht freigegeben)

R3a (klein, nur lesend) → R3b (Sperre, Nachweis auf der VM: Auftrag verlangt `sudo apt install`, wird verweigert, Etappe meldet fehlendes Werkzeug) → R3c (Installieren mit Bestätigung, Beweis: fehlendes pnpm auf der VM).

### Abnahme (messbar)

Planfrage nennt die Umgebung; ein Plan verlangt kein Werkzeug, das „fehlt“, ohne Installationsschritt; kein `sudo` in Projekt-Protokollen nach R3b; jede systemweite Installation hat eine Bestätigung im Verlauf.

### Offene Owner-Entscheidungen

1. R3b: `sudo` für Claude-Code-Projektaufträge sperren — Empfehlung ja.
2. R3c: erlaubte Quellen — Vorschlag apt (VM), brew (Mac), winget --scope user (PC); npm global und pip --user nur auf Wunsch.
3. R3d: Vertrauensstufe „projekt“ zurückstellen und messen — Empfehlung ja.

**Owner-Entscheidungen 13.10.:** 1. **nicht sperren, aber optional sperrbar** — Standard offen; Sperre zuschaltbar je Gerät (lokale Einstellung) und je Projekt (Option beim Start/in der Akte). 2. **Quellen vollumfänglich** — apt, brew, winget (Benutzer und System), npm global, pip; jede Installation weiter einzeln bestätigt. 3. **Schalter bauen** (Vertrauensstufe „projekt“, nur lokal am Gerät setzbar). Umsetzung freigegeben „wie empfohlen“: R3a → R3b → R3c → R3d, je ein Release mit Beweis auf der VM.

**Umsetzungsstand (13.10.):** R3a v1408 (Umgebung in Planfrage/Planer/Etappe). R3b v1409 (sudo-Sperre je Gerät lokal und je Projekt-Tag; Nachweis VM 01:06: ohne Regel root-Datei, mit `Bash(sudo:*)` abgelehnt; Geräte-Einstellung live 01:16). R3c v1410 (Aktion `installieren` apt/brew/winget/winget-system/npm/pip, Projektfrage bei FEHLT/command not found; Nachweis `tree` per apt nach Bestätigung). R3d v1411–v1413 (Vertrauensstufe nur lokal; nach drei automatischen Sicherheitsprüfungen eng: nur Erlaubnisliste-Befehle ohne Shell-Sonderzeichen, Prüfungen, Excel — nicht `auftrag_starten`, nicht `datei_ablegen`; Nachweis 01:27: git status im Ordner ohne Bestätigung, ls außerhalb → Bestätigung).

## Projekte im Gespräch, nachvollziehbar und live (Entwurf 13.10.2026 — ohne Umsetzung, Owner: „in der App über Projekte zu sprechen ist mühsam … man sieht nach einer Session nicht, was wirklich gemacht wurde … besser erkennen, wenn eine Session läuft, vielleicht durch Streamen der Aktivitäten" — keine Freigabe)

### Ist-Stand (belegt 13.10.)

- **Gespräch zerrissen:** Weiterarbeiten und Fragen stellt man in der App-Projektansicht; Meldungen und Antworten landen im Hauptgespräch (v1406 dort gespeichert) bzw. in der fragenden Sitzung. Rückfragen dazu führt man im Hauptgespräch, ohne dass es weiß, um welches Projekt es geht. Das Web hat einen Projekt-Chat je Projekt (`project:<id>`, v658), die App nicht.
- **Ergebnis kaum sichtbar:** Je Etappe gespeichert sind nur ✅/❌, Kosten und die letzten 400 Zeichen der Ausgabe von Claude Code (`erledigt[].text`); die geänderten Dateien kennt das Ende-Ereignis (R1) zwar, sie werden aber nicht je Etappe abgelegt; Commits gibt es nur über „Stand laden".
- **Laufende Session unsichtbar:** Das Fortschrittsprotokoll (stream-json, `fortschrittAus`, v1392) liest Alfred nur auf Nachfrage („Stand"). Die App kennt die Anzeige „Alfred arbeitet gerade auf einem anderen Gerät" (`fremde_arbeit.dart`, Ereignis `arbeit` start/status/ende, v1354) — für Projekte wird sie nicht genutzt.

### Bausteine

1. **Projektfaden als Ort des Gesprächs** (P5 aus „Projekte sichtbar und fortsetzbar"): jedes Geräte-Projekt hat einen Faden (Schlüssel = Projekt-Chat `project:<id>`, im Web schon vorhanden), in der App unter „Gespräche" mit Projektsymbol und Zustandspunkt und in der Projektansicht eingebettet. Dorthin gehen: Planfrage (mit Freigeben/Ablehnen), Etappenmeldungen, Antworten auf Fragen zum Projekt, Endmeldung. Gespräche im Faden haben den Projekt-Kontext (wie der Web-Projekt-Chat: Gerät, Pfad, Läufe, Anweisungen v1399). Das Hauptgespräch bekommt nur eine Zeile mit Rang („Angebots-Radar: fertig, 3/3 — Details im Projekt") und die Rückfragen, die eine Entscheidung brauchen.
2. **Etappenbericht** je Etappe (deterministisch, ohne Modell): Zusammenfassung von Claude Code (vollständiger Ergebnistext, nicht 400 Zeichen), geänderte Dateien (aus dem Ende-Ereignis), Commit (Kennung + Titel, `git show --stat` über eine Leseaktion), Abnahme (Prüfbefehle mit Ergebnis, bei Rot das Protokoll), Kosten und Dauer. Gespeichert im Laufstand bzw. in der Projekt-Sitzung; in App und Web je Etappe aufklappbar, plus „Was hat sich geändert?" (Diff-Statistik, auf Wunsch der Diff einer Datei, nur lesend).
3. **Live-Aktivität:** Während ein Auftrag läuft, schickt der Satellit neue Fortschrittsschritte als Ereignis `fortschritt` (gebündelt, höchstens alle 5 s, nur Kurzform: „✏️ schreibt src/merkliste.js", „▶ npm test", „💬 …" gekürzt). Das Gehirn reicht sie an die Owner-Geräte weiter (wie `arbeit`, ohne Speicherung im Gespräch) und hält den letzten Stand für Web/App-Abfragen. Anzeige:
   - App-Statusleiste/Seitenleiste wie „Alfred arbeitet gerade": „🔨 Angebots-Radar · Etappe 2/3 · ✏️ schreibt src/merkliste.js" — antippen öffnet das Projekt;
   - Projektansicht: laufende Etappe mit Live-Liste der letzten Schritte (wie ein Terminal-Ticker), Dauer, bisherige Kosten;
   - Web: dieselbe Liste im Projekt-Detail (Abfrage alle paar Sekunden oder SSE).
   Fremdinhalt (Befehle, Texte von Claude Code) bleibt gekürzt und als Daten gekennzeichnet; Geheimnisse in Befehlen werden nicht übertragen (Muster wie bei Logs).

### Reihenfolge (nicht freigegeben)

**G1** Etappenbericht (Daten vollständig speichern, Anzeige in App/Web) → **G2** Live-Aktivität (Ereignis `fortschritt`, App-Statusleiste + Projektansicht, Web) → **G3** Projektfaden (Meldungen/Antworten im Faden, Faden in der App, Hauptgespräch nur mit Rang).

### Abnahme (messbar)

Nach einem Lauf zeigt jede Etappe Zusammenfassung, Dateien, Commit und Abnahme ohne „Stand laden"; während eines Laufs erscheint ein neuer Schritt von Claude Code in der App nach höchstens 10 s; eine Frage zum Projekt und ihre Antwort stehen im selben Faden; Rückfragen im Faden kennen das Projekt ohne Nennung.

### Umsetzungsstand (13.10.)

Freigabe Owner 13.10. „ok wie vorgeschlagen“: G1 → G2 → G3, Hauptgespräch nur Ende und Entscheidungen, Live-Anzeige nur App/Web.

- **G1** v1417 (App 1.16.0): Etappenbericht mit Zusammenfassung, Dateien, Commit, Abnahme, Dauer; Diff-Ansicht.
- **G2** v1418 (App 1.16.1): Live-Aktivität über `fortschritt` (5 s), App-Statusleiste + Projektansicht, Web mit Abfrage alle 5 s.
- **G3** v1419 (App 1.17.0) + v1420: Projektfaden `owner:faden:projekt-<id8>` „🔨 <Name>“; Etappen, Fragen und Antworten im Faden, Hauptgespräch nur Ende-Zeile; Knopf „Gespräch zum Projekt“ in App und Web. v1420: Titel wird auch gesetzt, wenn eine Frage den Faden eröffnet.
- **Beweis G3 13.10. 00:52/00:56 UTC**: zwei Fragen an Angebots-Radar über die Web-Route → Faden angelegt, Titel „🔨 Angebots-Radar Österreich“ (nach v1420), beide Antworten im Faden (0,12 $ / 0,11 $), Zustellung nur `faden:` (Log „v1342 Auftrag beendet“, herkunft owner:faden:projekt-b77431a2). App 1.17.0 für Windows, Linux und macOS im Update-Eingang.
- Offen: Abnahme „Rückfragen im Faden kennen das Projekt ohne Nennung“ durch den Owner in der App; Live-Aktivität beim nächsten echten Lauf beobachten.
- **v1432 (13.10. abends, Owner „ja mit der Verbesserung freigegeben“): Frage im Projektfaden = eine Antwort.**
  - Realfall 18:08/18:14: Alfred schrieb eine eigene Antwort, und eine Minute später kam die Rohantwort von Claude Code.
  - Jetzt: Der Faden-Kontext enthält eigene Daten (Etappenberichte, Dateien, Commits, letzte Antworten von Claude Code), mit der Anweisung, zuerst dort nachzusehen.
  - `projekt_frage` wartet bis 2 min und gibt die Antwort als Werkzeug-Ergebnis zurück. Die Quellenzeile setzt Alfred deterministisch darunter.
  - Steht die Antwort aus, erscheint ein fester Satz. Die Nachlieferung läuft über die gespeicherte Herkunft (übersteht Neustart, gilt auch für die Route der Projektansicht).
  - Folgefragen laufen per `--resume` in derselben Sitzung (nur lesend). Neu nach einem Lauf oder nach 24 h; ist die Sitzung nicht fortsetzbar, wird einmal frisch gefragt.
  - Die leeren assistant/user-Zeilen sind kein Fehler: Es ist das gewollte Werkzeugpaar (tool_calls gefüllt), und die Anzeige filtert es.
  - **Beweis 13.10. 19:04–19:06 UTC (Projektfaden Angebots-Radar, App-Pfad):**
    - (1) Händler-Frage aus eigenen Daten in 4 s, mit genannter Grundlage.
    - (2) Spar-Fehlerbehandlung: eine Antwort nach 50 s, „v1432 Antwort auf Projektfrage abgeholt“, keine Ende-Meldung, Quelle 0,39 $.
    - (3) Folgefrage `folgefrage:true`, Befehl `--resume … --permission-mode plan --disallowedTools …`, 0,51 $, Projekt unverändert.
  - Nicht live gesehen: Pfad über 2 min mit Nachlieferung (nur per Code und Test belegt).
  - Beobachtung: Eine Folgefrage kostet mehr (mitgeschleppter Kontext); die 0,50-$-Grenze wird leicht überschritten.

### Risiken

Datenmenge (Fortschritt nur gebündelt, nicht gespeichert); Fremdinhalt in Anzeige und Projektfaden-Kontext (gekürzt, als Daten); zwei Orte für Projektmeldungen während der Umstellung (Hauptgespräch bekommt weiterhin die Zeile mit Rang).

### Offene Owner-Entscheidungen

1. Reihenfolge G1 → G2 → G3 — oder Projektfaden zuerst?
2. Was bleibt im Hauptgespräch: nur Ende und Entscheidungen (Empfehlung) — oder auch Etappenstarts?
3. Live-Aktivität auch in Telegram (eine sich aktualisierende Nachricht) — oder nur App/Web (Empfehlung)?

**Owner-Entscheidungen 13.10. („ok wie vorgeschlagen"):** Reihenfolge G1 → G2 → G3; im Hauptgespräch nur Ende und Entscheidungen; Live-Aktivität nur App/Web. Umsetzung freigegeben.

## R4 Beobachter am Satelliten und Deploy-Etappe (Entwurf 13.10.2026 — ohne Umsetzung, Owner: „ok wie vorgeschlagen … parallel die R4-Spec, ohne Umsetzung")

Ziel: Alfred bemerkt selbst, was auf den Geräten des Owners passiert (neue Datei, wichtige Mail in Outlook, Benachrichtigung, Build rot), und macht daraus nach festen Regeln einen Hinweis, einen Vorgang oder den nächsten Schritt eines Projekts. Dazu kommt die Deploy-Etappe mit Nachkontrolle für Geräte-Projekte. Grundsätze wie überall: Regeln deterministisch (jede Fähigkeit funktioniert mit dem schwächsten Modell), das Modell deutet höchstens im Mini-Pass, nichts Neues am Job-Register vorbei.

### Ist-Stand (belegt 13.10., Bestandsaufnahme im Code)

- **Am Satelliten gibt es keinen Beobachter.** Kein `fs.watch`, keine Abonnements für Outlook oder Benachrichtigungen. Vorhanden sind nur Abfragen auf Zuruf:
  - `outlook_mails` und `outlook_termine` (Windows, COM über PowerShell, `satellit-office.ts`),
  - `benachrichtigungen` (Windows `wpndatabase.db`, macOS usernoted, **Linux nicht verfügbar**, mit Bestätigung, `satellit-benachrichtigungen.ts`).
- **Sinne** (`satellit-sinne.ts`) sind Messwerte, die einmal pro Minute ankommen (Leerlauf, Fenster, Akku, System), keine Ereignisse. Der Server speichert sie nur und deutet sie alle 10 min im Job `geraete-beobachten` (Befunde: getrennt, Akku, Platte). Die Wechsel-Auslöser aus der Geräte-Spec (Zone, Leerlauf-Ende, Akku-Schwelle → Mini-Pass) sind nicht gebaut.
- **Protokoll:** `GeraetEreignis` kennt nur `art: 'auftrag'`. `gateway.ts` (beiEreignis) und `alfred.ts` (Filter `art === 'auftrag'`) verwerfen alles andere. Ein neues Ereignis braucht an beiden Stellen einen Fall.
- **Schicht 2 am Server ist da und wird wiederverwendet:**
  - `WeltmodellBeobachter` (Zustandswechsel → Mini-Pass mit Abkühlzeit → Hinweis) und Befund → Vorgang (`befund:<quelle>:<gegenstand>`, Stumm-Regel des Owners).
  - Mail-Regeln (v1211, `mail-ereignisse.ts`): Konto/Absender/Betreff → geplante Aufgabe mit fester Werkzeugliste über `fuehreAusDurchEreignis`. Läuft am Server per IMAP, nicht am Satelliten.
  - Home Assistant in Echtzeit mit Wächter-Job.
- **Job-Register:** Takte gibt es nur als täglich, wöchentlich oder Intervall. Ereignisquellen erscheinen dort nur als Abfrage-Job oder als Wächter (`ha-ereignisse-watchdog`).
- **Deploy-Skill** (`deploy.ts`): deploy/status/logs/restart/rollback über SSH. **Projektläufe haben keine Deploy-Etappe**; die Abnahme besteht nur aus Prüfbefehlen auf dem Gerät.

### Bausteine

- **B1 Ereignis „beobachtung" im Protokoll.** Neue `GeraetEreignis`-Art `beobachtung` mit:
  - `quelle`: ordner | outlook | benachrichtigung | build,
  - `regel` (Kennung der auslösenden Regel), `schluessel` (eindeutig, für Dedup), `zeit`,
  - `kopf` (nur Kopfdaten: Dateiname/Größe, Absender/Betreff, App/Titel).

  Inhalte schickt der Satellit nie mit. Braucht eine Regel den Inhalt, holt der Server ihn ausdrücklich mit der vorhandenen Lese-Aktion. Am Satelliten wird gebündelt (5 s) und gedrosselt (höchstens 30 Ereignisse pro Minute und Gerät, darüber ein Sammel-Ereignis „N weitere"). Server: je ein Fall in `gateway.ts` und `alfred.ts`, Dedup über `schluessel`.
- **B2 Beobachter-Regeln am Server** (nach dem Muster der Mail-Regeln). Felder:
  - Gerät, Quelle, Filter (Ordner + Muster | Absender/Betreff | App | Projekt),
  - Wirkung:
    - `hinweis`: über `pruefeHinweis` → `deliverOrDefer`,
    - `vorgang`: Befund → Vorgang mit Owner-Entscheidung,
    - `aufgabe`: geplante Aufgabe mit fester Werkzeugliste, wie Mail v1211,
    - `projekt`: Wunsch an ein Geräte-Projekt, **immer mit Bestätigung**.

  Anlegen im Gespräch („sag mir, wenn in Downloads eine Rechnung landet"), in der App und im Web. Der Server schickt jedem Satelliten seine Beobachtungsliste (neue Nachricht `beobachten`, bei Verbindung und bei Änderung).
- **B3 Ordner-Beobachter** (alle Plattformen): `fs.watch` rekursiv, nur in freigegebenen Verzeichnissen. Temporäre Dateien werden ignoriert (`~$*`, `.part`, `.crdownload`, `.tmp`); eine Datei gilt erst als „neu", wenn ihre Größe 3 s stabil bleibt. Ereignisse: neu, geändert, gelöscht, mit Name, Größe und relativem Pfad.
- **B4 Outlook-Beobachter** (Windows): Abfrage alle 2 min über die vorhandene COM-Lesefunktion, nur Mails nach der letzten EntryID, nur Kopfdaten. Gedacht für Konten, die der Server nicht selbst liest (z. B. Exchange). Dedup mit `mail-ereignisse` über die Message-ID. Ist Outlook geschlossen oder liegt ein Fehler der Integritätsstufe vor (80080005), wird der Beobachter als „gestört" gemeldet statt still zu schweigen.
- **B5 Benachrichtigungs-Beobachter** (Windows/macOS): Abfrage jede Minute über die vorhandene Lesefunktion, nur neue Einträge. **Nur Apps, die in einer Regel stehen, verlassen das Gerät**; alles andere verwirft der Satellit. Linux bleibt ohne (D-Bus-Mitschnitt wäre ein eigener späterer Schritt).
- **B6 Build-Beobachter:** Ein Projekt kann einen Prüfbefehl als „Wache" bekommen (z. B. `npm test` alle 30 min oder nach einer Änderung im Projektordner aus B3). Rot → Ereignis `build` → Wirkung laut Regel, typisch Vorgang mit dem Angebot „Fix-Lauf starten" (bestätigen).
- **B7 Lebenszeichen:**
  - Jeder Beobachter meldet seinen Stand mit den Sinnen: läuft, gestört mit Grund, letzte Beobachtung.
  - Der Job `beobachter-waechter` (10 min, Job-Register) macht daraus Befunde („Outlook-Beobachter auf PC-madh seit 25 min gestört").
  - Kachel und Lage zeigen die Beobachter.
  - Lokales Veto am Gerät: `alfred einstellungen beobachter aus`, wie beim Vertrauen; das Gerät hat das letzte Wort.
- **B8 Deploy-Etappe mit Nachkontrolle** (Geräte-Projekte). Ein Projekt bekommt optional ein **Deploy-Ziel**: Host über den Deploy-Skill, Compose-Pfad und Gesundheitsprüfung (HTTP-URL mit erwartetem Status, Log-Muster). Der Planer darf eine letzte Etappe „Deploy" einplanen:
  - Deploy **immer mit Bestätigung**;
  - danach automatische Nachkontrolle (Status, HTTP-Probe, Logs ohne Fehlermuster, 3 Proben in 2 min);
  - bei Rot: Bericht und Frage „Rollback?", ebenfalls mit Bestätigung.

  Das Ergebnis kommt in den Etappenbericht (v1425) und in den Projektfaden.
- **B9 (optional) Sinne-Wechsel als Ereignis:** Leerlauf-Ende („Owner wieder am PC"), Akku unter Schwelle und Gerät verbunden/getrennt werden zu Zustandswechseln für den `WeltmodellBeobachter`. Damit lassen sich zurückgehaltene Hinweise zustellen, wenn der Owner zurückkommt.

### Reihenfolge (nicht freigegeben)

1. **R4a:** B1, B2, B3 und B7. Ordner auf allen Plattformen, Regeln und Lebenszeichen; das ist der kleinste Weg zum ersten echten Ereignis.
2. **R4b:** B5 und B4. Benachrichtigungen und Outlook unter Windows und macOS.
3. **R4c:** B8 und B6. Deploy-Etappe mit Nachkontrolle, Build-Wache.
4. **R4d (optional):** B9.

Jeder Schritt ist eine eigene Version mit Live-Beweis auf der Ubuntu-VM bzw. dem Windows-PC.

### Abnahme (messbar)

- Neue Datei in einem beobachteten Ordner → Hinweis oder Vorgang in < 1 min.
- Mail von einem Regel-Absender in Outlook → Vorgang in < 3 min, ohne Doppelung, wenn der Server dasselbe Konto liest.
- Ein Beobachter fällt aus → Befund in ≤ 20 min.
- Kein Ereignis ohne Regel verlässt das Gerät (Probe mit einer fremden App-Benachrichtigung).
- Deploy-Etappe: Nachkontrolle rot → Rollback-Frage, kein automatischer Rollback.
- Alle Regeln greifen mit dem Notmodell gleich, nur die Deutung im Mini-Pass hängt am Modell.

### Risiken

- **Fremdinhalte und Datenschutz:** Benachrichtigungen und Mails anderer Personen. Gegenmittel: nur Kopfdaten, Filter am Satelliten, Inhalt nur auf ausdrückliche Anfrage.
- **Flut:** Bündelung, Drossel, Sammel-Ereignis, Abschalten je Regel.
- **COM-Fehler und geschlossenes Outlook:** wird als „gestört" gemeldet, nie still.
- **Linux ohne Benachrichtigungen.**
- **Doppelte Quellen** (IMAP am Server und Outlook): Dedup über die Message-ID.
- **Deploy auf falsches Ziel:** Das Ziel liegt fest am Projekt, jeder Deploy wird bestätigt, und prod-Tore bleiben bei R5.

### Offene Owner-Entscheidungen

1. **Reihenfolge:** R4a (Ordner) zuerst wie empfohlen, oder Outlook/Benachrichtigungen zuerst?
2. **Wo die Regeln entstehen:** am Server (Gespräch, App, Web) mit lokalem Veto am Gerät (Empfehlung), oder nur lokal am Gerät?
3. **Outlook nur für Konten, die der Server nicht selbst liest?** (Empfehlung ja, sonst doppelt.)
4. **Was ein Ereignis ohne Rückfrage auslösen darf:** Hinweis, Vorgang und Aufgabe mit fester Werkzeugliste automatisch; Projekt-Wunsch, Fix-Lauf, Deploy und Rollback nur mit Bestätigung (Empfehlung).
5. **Deploy-Ziel:** pro Projekt fest hinterlegt und jeder Deploy bestätigt (Empfehlung), oder in dev automatisch nach grüner Abnahme?
6. **B9 (Sinne-Wechsel)** jetzt mitplanen oder später?

### Owner-Entscheidungen (13.10.2026)

1. **Komplett:** R4a, R4b und R4c, also Ordner, Benachrichtigungen, Outlook, Build-Wache und Deploy-Etappe; jeder Schritt eine eigene Version mit Live-Beweis.
2. **Regeln am Server** (Gespräch, App, Web) **mit sichtbaren Schaltern** je Regel und je Gerät/Beobachter; lokales Veto am Gerät.
3. **Outlook nur für Konten, die der Server nicht selbst liest.** Dedup über die Message-ID.
4. **Wie empfohlen:** Hinweis, Vorgang und Aufgabe automatisch; Projekt-Wunsch, Fix-Lauf, Deploy und Rollback nur mit Bestätigung.
5. **Deploy-Ziel fest je Projekt, jeder Deploy bestätigt.** Die Alternative „in dev automatisch nach grüner Abnahme“ ist je Projekt optional einstellbar (Standard aus).
6. **B9 später.** Bestand: Die Zustellentscheidung kennt die Anwesenheit am Gerät schon (v1198/v1237 `amGeraet`). Aufgeschobene Hinweise werden aber nur nachgeliefert, wenn im Durchlauf (≈ 30 min) eine Chat-Nachricht des Owners in den letzten 30 min liegt. Es fehlt nur das Ereignis „Leerlauf-Ende“ als sofortiger Auslöser.

### Umsetzungsstand

- **v1429 + App 1.20.0 (13.10.): R4a.**
  - B1 Protokoll als eigene Nachrichtentypen `beobachten` (Gehirn → Gerät) und `beobachtung` (Gerät → Gehirn), statt einer neuen `ereignis`-Art (der Auftrags-Pfad bleibt unberührt).
  - B2 Regeln in `beobachter_regeln` (PG v141 / SQLite v137), Skill `beobachter`, App-Ansicht und Web-Seite „Beobachter“ mit Schalter je Regel.
  - B3 Ordner-Beobachter: `cli/satellit-beobachter.ts`.
  - B7 Wächter-Job `beobachter-waechter` und lokales Veto `alfred einstellungen beobachter aus`.
  - Wirkungen Hinweis/Vorgang/Aufgabe (synthetische geplante Aufgabe mit fester Werkzeugliste, wie Mail-Regeln)/Projekt (Bestätigung); Drossel 20/h je Regel.
  - **Beweis 13.10. 14:36 UTC (Ubuntu-VM):** Regel über die Web-Route angelegt → Satellit „läuft“; `probe-rechnung.pdf` → Hinweis nach ≈ 10 s in Telegram/Hauptgespräch, `.txt` nicht gemeldet; im Gespräch „Schalte den Beobachter Probe PDF aus“ → aus, danach angelegte PDF nicht gemeldet. Regel und Dateien danach gelöscht.
- **v1430 + App 1.21.0 (13.10.): R4b.**
  - Benachrichtigungen (Windows/macOS): nur Apps der Regel, nur App + Titel.
  - Outlook-Posteingang (Windows): Absender/Betreff, Kopfdaten + EntryID; Konten im Stand. Liest der Server alle Konten selbst → „ohne Wirkung“.
  - **Beweis 13.10. 14:48 UTC (PC-madh):** Test-Toast → Hinweis über Telegram ins Hauptgespräch.
  - Outlook live nicht geprüft (PC ohne Mailkonto, Office-VM offline).
  - Microsoft-Konto „default“ hat keine Adresse in der Konfig und wird beim Doppel-Lesen-Abgleich nicht erkannt.
- **v1431 + App 1.22.0 (13.10.): R4c Teil B6 Build-Wache.**
  - Nur die Prüfbefehle des Projekts, 15–1440 min; meldet Wechsel rot/grün; pausiert während eines Laufs.
  - **Beweis 13.10. 14:59 UTC (Ubuntu-VM, Wegwerf-Projekt):** grün ohne Meldung, rot → „Prüfbefehle rot (test -f ok.txt)“.
  - Dazu lesbarer App-Name bei Benachrichtigungen.
- **Offen: R4c Teil B8 Deploy-Etappe — Owner-Entscheidung nötig.**
  - Der Deploy-Skill holt Code auf dem Ziel per `git clone/pull` aus einer Repo-URL.
  - Geräte-Projekte haben nur ein lokales Git ohne Remote.
  - Wege: (a) Ziel = das Gerät selbst (Start/Neustart im Projektordner, Nachkontrolle per HTTP auf dem Gerät und Log-Muster) — sofort baubar; (b) entferntes Ziel über ein Remote (GitLab-Repo je Projekt, Deploy-Token aus den Projektumgebungen, Push vom Gerät) — das ist der Git-Teil von R5.
- B9 später.

### Erweiterung nach Owner-Klärung (13.10.2026 abends, „ok“ — Spec festgehalten, Umsetzung nicht freigegeben)

**Grundsätze (Owner):**

1. **Deploy ist optional.** Ohne Deploy bleibt alles wie bisher: Projekt auf dem Gerät, Läufe, Abnahme, Neustart über den Geräte-Skill. Nichts davon hängt an GitLab oder am Deploy.
2. **Alfreds eigene Mail bleibt unverändert.** Mail-Skill, Mail-Regeln (v1211, geplante Aufgaben `mail`), Hinweise und Vorgänge aus Mails laufen weiter wie heute. Sie werden weder umgebaut noch in die Beobachter übernommen (der frühere Vorschlag „Mail (Server)“ als Beobachter-Quelle ist zurückgezogen).
3. **Geräte-Mail bleibt getrennt.** Der Outlook-Beobachter gilt nur für Konten, die Alfred nicht selbst konfiguriert hat. Die Welten werden nicht vermischt: keine gemeinsame Liste und keine Mail, die doppelt kommt.
4. **Jede Beobachtungsart je Gerät einzeln schaltbar.** Ordner, Benachrichtigungen, Outlook und Build-Wache bekommen je Gerät einen eigenen Schalter in App und Web. Ist eine Art aus, läuft dort keine Regel dieser Art. Dazu kommen weiter der Schalter je Regel und das lokale Veto am Gerät, das das letzte Wort hat.
5. **„einmalig“ und „bis“** für alle Beobachter. „Sag mir Bescheid, sobald …“ schaltet die Regel nach dem ersten Treffer ab und meldet „erledigt“; „die nächsten 3 Tage“ setzt ein Ablaufdatum, danach ist sie automatisch aus.

**Bausteine:**

- **B10 Schalter je Gerät und Art:** am Gerätedatensatz (Server) und in App/Web; die Nutzlast `beobachten` enthält nur Regeln eingeschalteter Arten. Der Stand zeigt „Art am Gerät aus“.
- **B11 einmalig/bis:** Felder an `beobachter_regeln`; der Dienst schaltet nach dem ersten Treffer bzw. beim Ablauf ab (Wächter-Job), mit Meldung. Im Gespräch: „sobald …“ → einmalig, Zeitangabe → bis.
- **B12 Eigene Konten zuverlässig kennen:** Beim Start fragt Alfred die Adresse jedes Microsoft-Kontos einmal ab (Graph `/me`). Heute fehlt „default“, weil die Konfiguration keine Adresse enthält. Dazu kommen IMAP-Benutzer und Dienste mit Adresse. Die Liste ist in der Beobachter-Ansicht sichtbar.
- **B13 Git-Teil (vorgezogen aus R5):**
  - (a) Ein Projekt, das schon auf GitLab liegt, auf ein Gerät holen (`git clone`, Remote bleibt) und dort wie jedes Geräte-Projekt weiterentwickeln.
  - Nach jeder abgenommenen Etappe wird zu GitLab gepusht, mit einem Token je Projekt aus den Projektumgebungen (nie das Owner-Token).
- **B14 Deploy auf einen anderen Rechner (b):**
  - Das Gerät pusht; der vorhandene Deploy-Skill holt den Stand auf das Ziel.
  - Danach Nachkontrolle: Status, HTTP-Probe, Logs ohne Fehlermuster (der Deploy-Skill prüft heute nur `curl localhost` und meldet auch bei Fehlschlag Erfolg).
  - Jeder Deploy und jeder Rollback wird bestätigt. „In dev automatisch nach grüner Abnahme“ ist ein Schalter je Projekt (Standard aus).
  - Rollback heute nur `git revert HEAD` ohne docker-compose-Zweig; dafür braucht es den Stand vor dem Deploy und einen Compose-Zweig.

**Reihenfolge — FREIGEGEBEN (Owner 13.10. abends „ok freigegeben“):** 1) B10 + B11 + B12 (nur Beobachter, klein) → 2) B13 Git-Teil → 3) B14 Deploy mit Nachkontrolle.

**Umsetzungsstand:**

- **v1433 + App 1.23.0 (13.10.): B10–B12.**
  - B10: Tabelle `beobachter_geraete`; Schalter in App, Web und Gespräch (`geraet_art`).
  - B11: `einmalig` und `bis` (tage/stunden/ISO); der Wächter schaltet ab.
  - B12: Adresse je Mail-Provider über Graph `/me`; Liste „Alfred liest selbst“.
  - **Beweis 13.10. 19:28–19:30 UTC (Ubuntu-VM):** Konto „default“ → markus@dohnal.co.
    - Die einmalige Regel schlug bei der ersten Datei an und meldete „v1433 Beobachter beendet“; die zweite Datei blieb ohne Treffer.
    - Ordner auf der VM aus: Stand „Art am Gerät aus“, `test.nie` ohne Treffer. Wieder an: `jetzt.nie` → Beobachtung.
    - Probe-Regeln gelöscht.
  - Nicht live gesehen: Ablauf nach „bis“ (nur Test; Probe hätte 2 h gebraucht).
- **v1434–v1436 (13.10.): B13 Git-Teil.**
  - `project_agent projekt_holen` (Repo-Adresse oder Server-Projekt → Gerät, Remote bleibt, Akte mit repoUrl).
  - Push nach jeder abgenommenen Etappe (Zeile in der Etappenmeldung; Tag `push-aus`).
  - Token aus der Projektumgebung (`GIT_TOKEN`/`GITLAB_TOKEN`/`GITHUB_TOKEN`), nie das Owner-Token.
  - Zwei Sicherheitsprüfungen eingearbeitet:
    - v1435: Push nur zur erwarteten Adresse; Token nur für deren Host; keine Weiterleitungen, Hooks oder Credential-Helper.
    - v1436: Push mit Token aus einem frischen temporären Repo, ohne globale und System-Konfiguration; Hooks auf `/dev/null` bzw. `NUL`.
  - Die Aktions-Logzeile des Satelliten schwärzt Geheimnisse.
  - **Beweis 13.10. (Ubuntu-VM, öffentliches Repo octocat/Hello-World):**
    - Geholt per Chat („v1434 Projekt geholt“, master 7fd1a60, Remote ohne Zugangsdaten).
    - Etappe abgenommen → Push versucht, sauber abgelehnt ohne Token.
    - Umgebogenes origin → „ist nicht das Repo des Projekts — nicht gepusht“.
    - Probe archiviert, Ordner gelöscht.
  - Erfolgreicher Push nur per Test gegen ein echtes lokales Repo belegt.
  - **Offen (Owner):** `GIT_TOKEN` (GitLab-Projekt-Token, Rolle Developer, Bereich write_repository) in der Projektumgebung eines Projekts hinterlegen — dann ist der erfolgreiche Push live prüfbar.
- **v1437 (13.10.): B14 Deploy mit Nachkontrolle.**
  - `projekt_deploy_ziel`, `projekt_deploy`, `projekt_rollback`; Speicher `projects.deploy_ziel`.
  - Deploy und Rollback nur mit Owner-Bestätigung (Einmal-Kennung).
  - Nachkontrolle: Status, HTTP, Log-Muster seit dem Deploy; bei Rot ein Rollback-Angebot auf den Commit vor dem Deploy.
  - Deploy-Skill: Projekt-Token über stdin, Commits vor/nach dem Deploy, `logs seit_minuten`, Rollback auf Commit mit Compose-Zweig und ehrlichem Ergebnis.
  - `auto_dev` nur für die Stufe dev, nach grüner Abnahme aller Etappen.
  - Fix: Der API-Deploy merkte `verified=ok` auch bei Fehlschlag.
  - **Beweis 13.10.:** Migration angelegt. „Deploye Angebots-Radar“ → `projekt_deploy` ohne Ziel abgelehnt, Alfred fragt nach dem Ziel; ohne Deploy alles wie bisher.
  - **Nicht live:** echter Deploy, Nachkontrolle und Rollback auf einem Zielrechner. Die Bestätigung ist das Tor des Owners und wurde nicht stellvertretend erteilt.
  - Nur Gespräch, keine App-/Web-Maske für das Deploy-Ziel.
  - **v1438 (Sicherheitsprüfung):** Ein Deploy-Ziel wird erst nach der Bestätigung des Owners gespeichert und als bestätigt markiert. Deploys, auch automatische, gibt es nur für bestätigte Ziele. Die Einmal-Kennungen stammen aus randomBytes(16).
  - **Offen (Owner):** erstes Projekt mit Remote + Deploy-Ziel (z. B. dev auf .96) deployen und bestätigen → Live-Beweis Nachkontrolle/Rollback.

## Nachforschen vor dem Melden (Entwurf 11.10.2026, Schicht 2/3 — ohne Umsetzung, Owner: „als Spec ausarbeiten, keine Freigabe"; überarbeitet 11.10.: Rezepte dynamisch, Owner: „so überarbeiten, keine Freigabe")

### Anlass (Realfall 10./11.10.)

Am 10.10. 09:30 meldete Alfred von sich aus: „Home Assistant meldet zwei neu nicht verfügbare Entitäten (LichtWaschkammerl …): **prüfen, ob** das zugehörige Gerät/die Integration offline ist". Die Untersuchung ging an den Owner. Am 11.10. 13:26 fragte der Owner im Chat, welche Lichter länger als sonst an waren und was dahinterstecken könnte. Alfred untersuchte dieselbe Sache selbst und nur lesend und lieferte: Einschaltdauer 14,8 statt 9,8 h/Tag (+51 %) mit den langen Phasen, Melder `0x00158d0004867bb2` seit 04.10. ohne Bewegung, Einschaltautomation zuletzt am 23.09., die Ausschaltautomation lief nur bei Zigbee-Neuverbindungen, Batterie 100 % als nicht frischer Wert; Abgrenzung (kein Zigbee-Gesamtausfall, Eingang/Garage melden; Gang OG und Küche ebenfalls verdächtig); offen „Batterie, Funk oder Defekt nicht unterscheidbar"; konkrete Aufgabe „Waschkammerl betreten, in Zigbee2MQTT auf frischen Zeitstempel prüfen".

Owner (11.10.): Das zweite ist das erwartete Verhalten — **weiter Fehler melden, aber vorher selbst nachsehen, ableiten und, was Alfred nicht selbst kann, als Aufgabe an den Owner geben**.

### Ist-Stand (Code, DB, Log 11.10.)

- **Zwei Wege zur Meldung:** (a) Befunde mit Identität (.1217, `ereignisse/befunde.ts`): Quellen `bmw`, `energie`, `sensorbatterien`, `infra` (MikroTik, Monitor-Alerts), `geraete`, `lebenszeichen`, je 1–7 neue pro Tag; (b) Handlungs-Insights des Reasonings → Prosa-Vorgänge nur ohne Befund (.1222). Die Waschkammerl-Meldung kam über (b) — **HA-Anomalien sind heute keine Befunde**.
- **Volumen:** 18–44 neue Vorgänge pro Tag (05.–11.10.); offen nach Quelle: reasoning-insight 27, reasoning 15, lernbedarf 7, befund 3.
- **Kosten einer freien Untersuchung** (die Chat-Antwort vom 11.10. 13:26–13:31, Log): 25 Modellaufrufe, 3,43 USD, 308 s Modellzeit (Stufe default). Freie Untersuchung bei jeder Meldung wäre bei diesem Volumen nicht tragbar — und verstieße gegen den Grundsatz, dass Fähigkeiten mit dem schwächsten Modell der Kette funktionieren müssen.
- **Vorhanden und wiederverwendbar:** Vorgänge mit Besitzer `alfred|user`, `naechster_schritt`, Schritte (`vorgang_schritte`, Arten `vorgeschlagen … notiz`); Autonomie-Klassen in der Ausführung (`vorgaenge/autonomie.ts`, `klassifiziereAktion`); Fakten-Gegenprobe gegen die Datenlage (.1214); Weltmodell-Beobachter und Watches (Nachprüfung); Runbooks mit `symptom/cause/steps/verification` und der Chat-Runbook-Reflektor (`reflection/chat-session-runbook-reflector.ts`); HA-Skill mit Leseaktionen `state`, `history`, `logbook`, `areas`, Automationen lesen; Todos und App-Ansicht Aufgaben (v1353); Vorgangs-Dialog mit Entscheidung (App 1.9.0); Sammlung „Hinweise" (v1343).

### Zielverhalten

Neuer Befund oder Handlungs-Hinweis → **Nachforschen** (nur lesen) → **Ableiten** (Hypothese, Belege, Sicherheit, offen) → **Aufteilen** (was Alfred selbst tut, was der Owner tun muss, was eine Bestätigung braucht) → **Melden** in einem festen Format → **Nachprüfen** und selbst schließen. Melden bleibt — das Nachforschen kommt davor, ersetzt es nicht.

Meldeformat (kurz; Details im Vorgang, „Warum?" und App-Dialog):

> **Waschkammerl: Licht bleibt an, Bewegungsmelder stumm.** Geprüft: Licht zuletzt 14,8 statt 9,8 h/Tag an; Melder seit 04.10. ohne Bewegung; Automation zuletzt 23.09. Wahrscheinlich: Melder meldet nicht mehr (Batterie, Funk oder Defekt — noch nicht unterscheidbar). **Deine Aufgabe:** Waschkammerl betreten und in Zigbee2MQTT auf eine frische Meldung achten. **Ich:** prüfe ab jetzt stündlich, ob der Melder wieder meldet, und schließe den Befund dann selbst.

### Bausteine

**1. Auslöser (wann nachgeforscht wird).** Neuer Befund; Befund, der nach „erledigt" wieder auftritt; Handlungs-Insight, aus dem ein Vorgang würde (Weg b). Nicht: reine Informations-Insights, Interessen/Digest, Lebenszeichen-Befunde ohne Vorgang, geplante oder interne Läufe. Gibt es für die Art des Befunds noch kein **Prüfrezept** (Baustein 2), erstellt Alfred es beim ersten Auftreten selbst (Baustein 7) und wendet es sofort an — schon die erste Meldung ist untersucht. Einmal je Befund — erneut nur bei Zustandswechsel.

**2. Prüfrezepte statt freier Untersuchung.** Datenmodell `pruefrezept (id, muster {quelle, gegenstand_regex}, schritte [{werkzeug, aktion, params_vorlage, zweck}], deutungsfragen[], eigene_schritte[], aufgaben_vorlagen[], nachpruefung {werkzeug, aktion, bedingung, takt}, herkunft dynamisch|chat|owner, status bewaehrung|bewaehrt|ueberarbeitet|stillgelegt, version, vorgaenger, laeufe, bestaetigt, widerlegt, unsicher)`. Rezepte entstehen **dynamisch** (Baustein 7); das unten stehende Beispiel ist zugleich die Messlatte, die ein selbst erstelltes Rezept für den Waschkammerl-Fall erreichen muss. Die Schritte führt der Code **ohne Modell** aus; Platzhalter (Entität, Bereich, Host) kommen aus dem Befund. Ergebnis ist ein **Belegblock**: gekürzte Rohdaten mit Zeitstempeln und Quelle je Zeile. Beispielrezept „HA: Licht ungewöhnlich lange an / Entität nicht verfügbar":
1. `history` der Entität, 10 Tage → Einschaltdauer je Tag, Vergleich mit dem Normalzustand (Schicht 1);
2. `areas` → Bewegungsmelder desselben Bereichs, deren `history` → letzte Bewegung;
3. Automationen, die Entität oder Melder nennen → `last_triggered`;
4. Batterie, Linkqualität, `last_seen` der Melder (Zeitstempel der Messung, nicht nur Wert);
5. Gegenprobe Gesamtausfall: andere Melder derselben Integration mit Bewegung im selben Zeitraum.

**3. Deutung mit festem Schema.** Ein werkzeugloser Modellaufruf (Stufe fast oder medium) bekommt Belegblock und Deutungsfragen und antwortet nur im Schema `{hypothese, sicherheit hoch|mittel|niedrig, belege[{text, beleg_zeile}], nicht_unterscheidbar[], alfred_schritte[], owner_aufgaben[{titel, ort, handgriff, erledigt_wenn}], bestaetigungen[]}`. Deterministische Gegenprobe danach: Jeder Beleg muss auf eine Zeile des Belegblocks verweisen und deren Zahl/Zeitstempel enthalten; `alfred_schritte` nur aus `eigene_schritte` des Rezepts; fehlt etwas → Sicherheit „niedrig", Beleg gestrichen. So trägt die Logik das Rezept, nicht das Modell; Abnahme mit Haiku und Mistral.

**4. Ergebnis im Vorgang.** Neue Schrittart `nachgeforscht` mit Belegblock-Verweis, Hypothese und Sicherheit; der Befund erhält die Hypothese als `detail`. Besitzer des Vorgangs: `user`, wenn Owner-Aufgaben offen sind, sonst `alfred`. **Owner-Aufgaben werden Todos** (Liste „Alfred-Aufgaben", Fälligkeit aus der Dringlichkeit, Verweis auf Vorgang) und erscheinen damit in Telegram, Web und der App-Ansicht Aufgaben. Schalt- oder Konfigurationsschritte gehen als Bestätigung (Klasse `bestaetigen`), nie still.

**5. Meldung.** Formular wie oben; Zustellung über die bestehenden Wege (Sammlung Hinweise, Telegram) mit Ruhefenstern. Die Nachforschung selbst läuft auch im Ruhefenster, gemeldet wird danach. Eine Meldung „prüfen, ob …" ohne eigene Belege gibt es für Quellen mit Rezept nicht mehr.

**6. Nachprüfen und Schließen.** Die `nachpruefung` des Rezepts (z. B. „Melder meldet Bewegung mit Zeitstempel nach Aufgabenbeginn") läuft über Weltmodell-Beobachter bzw. Watch. Erfüllt → Befund, Vorgang und Todo erledigt, kurze Meldung „erledigt, bestätigt durch …". Hakt der Owner die Aufgabe ab, wird sofort nachgeprüft; bleibt der Befund, sagt Alfred das mit dem neuen Stand. Nach Ablauf der Frist einmal erinnern, mit aktualisierten Belegen.

**7. Rezepte dynamisch erstellen, bewähren, verbessern.** Owner 11.10.: Alfred soll Rezepte beim Auftreten eines Fehlers selbst erstellen, nicht auf eine Übernahme warten. Die Sicherheit kommt aus der Lese-Positivliste in der Ausführung (Abschnitt Sicherheit), nicht aus einer Freigabe des Rezepts — ein selbst erstelltes Rezept kann nichts schalten.
1. **Planen beim ersten Auftreten:** Neuer Befund bzw. Handlungs-Hinweis ohne passendes Rezept (Muster aus Quelle und Gegenstand) → ein Planungsaufruf mit Stufe strong. Er bekommt den Befund, den Weltmodell-Ausschnitt und **nur den Katalog der erlaubten Lese-Werkzeuge** (Werkzeug, Aktion, Parameter, Beispielausgabe) und antwortet im Rezept-Schema (Schritte, Deutungsfragen, eigene Schritte, Aufgaben-Vorlagen, Nachprüfung).
2. **Prüfen vor dem Lauf (deterministisch):** jeder Schritt in der Positivliste, Parameter-Platzhalter auflösbar, ≤ 12 Schritte, Nachprüfung ist eine Leseaktion mit prüfbarer Bedingung. Ungültig → einmal mit Fehlerliste neu planen, dann Rückfall auf das heutige Verhalten plus Vorgang „Prüfrezept fehlt" (Lernschleife 3).
3. **Sofort anwenden:** Das Rezept läuft gleich für diesen Befund — Sammeln, Deutung, Gegenprobe und Meldung wie in den Bausteinen 2–5.
4. **Verallgemeinern und speichern:** konkrete Bezeichner werden Platzhalter (Entität → „Licht des Bereichs", Melder → „Bewegungsmelder des Bereichs", Host → „betroffener Host"), das Muster wird so weit wie belegt gefasst (Quelle + Art des Gegenstands, nicht der einzelne Gegenstand). Nächster ähnlicher Befund: kein Planungsaufruf, die Deutung läuft mit fast/medium — damit tragen die schwächeren Modelle der Kette den Alltag.
5. **Bewährung statt Freigabe:** Status `bewaehrung` ab dem ersten Lauf, aktiv. Ergebnis-Signale je Lauf: **bestätigt** (Nachprüfung erfüllt nach Owner-Aufgabe oder Selbstheilung passend zur Hypothese, Owner hakt Aufgabe ab und Befund verschwindet), **widerlegt** (Owner korrigiert die Hypothese, Befund verschwindet aus anderem Grund, Aufgabe ohne Wirkung), **unsicher** (Deutung nur „niedrig"). Nach ≥ 3 bestätigten Läufen ohne Widerlegung → `bewaehrt`.
6. **Selbst verbessern:** zwei Widerlegungen oder drei „unsicher" in Folge → Überarbeitung: Planungsaufruf mit dem alten Rezept, den Belegblöcken und den Signalen; neue Version (`vorgaenger` verweist), alte `ueberarbeitet`. Nach drei erfolglosen Versionen `stillgelegt` und Vorgang „Prüfrezept für … taugt nicht" an den Owner (Lernschleife 3).
7. **Weitere Quellen für Rezepte:** Untersuchungen im Chat (wie Waschkammerl 11.10.) liefert der Runbook-Reflektor als Rezept mit Herkunft `chat`; bei gleichem Muster gewinnt das Rezept mit der besseren Bestätigungsquote, gleichstand → `chat` (der Owner hat mitgedacht). Owner-Rezepte (`owner`) gehen immer vor.
8. **Owner behält den Überblick, ohne freizugeben:** Liste der Rezepte in App und Web (Muster, Status, Läufe, bestätigt/widerlegt, letzte Version, Diff zur Vorgängerin); jederzeit abschaltbar oder als Owner-Rezept festschreibbar. Neue Rezepte erscheinen einmal als Hinweis in der Sammlung („Neues Prüfrezept: …"), nicht als Bestätigung.

### Budget und Grenzen

Erwartet je Rezeptlauf: 0 Modellaufrufe für das Sammeln, 1 für die Deutung (Kosten zu messen; Ziel deutlich unter 0,05 USD statt 3,43 USD frei). Beim ersten Auftreten einer Art zusätzlich 1 Planungsaufruf (strong, ggf. ein zweiter nach Prüffehler), bei Überarbeitung ebenso; eigenes Teilbudget für Planungen (Vorschlag 5 je Tag), danach Rückfall auf das heutige Verhalten mit Vorgang „Prüfrezept fehlt". Tagesbudget (Vorschlag 20 Läufe oder 1 USD, danach Verhalten wie heute mit Hinweis im Lagebild), Zeitlimit 60 s je Lauf, Werkzeugaufrufe je Lauf ≤ 12, Belegblock ≤ 6 000 Zeichen. Kennzahlen in Schicht 4: Läufe, Kosten, Sicherheit je Rezept, Anteil Owner-Aufgaben erledigt, Anteil selbst geschlossener Befunde, Korrekturen des Owners an Hypothesen.

### Sicherheit

Nur lesende Aktionen: Positivliste je Werkzeug **und** Aktion (z. B. HA `state/history/logbook/areas`, Automation lesen; nie `call_service`, `trigger_automation`, `create/update/delete_automation`), durchgesetzt in der Ausführung, nicht im Prompt. Belege können Fremdtext enthalten (Mail, Logbuch, Gerätenamen) → Deutung ohne Werkzeuge, Ausgabe nur im Schema, Owner-Aufgaben sind Text und lösen nichts aus. Rezepte mit Schreibschritten sind ungültig — die Prüfung vor dem Lauf (Baustein 7.2) und die Positivliste in der Ausführung greifen beide, auch für dynamisch erstellte Rezepte. Der Planungsaufruf sieht nur den Lese-Katalog; Befund- und Belegtexte sind für ihn Daten, keine Anweisungen (Fremdtext aus Logbuch, Mail, Gerätenamen).

### Verhältnis zu anderen Entwürfen

- **Projektvorgang:** dieselbe Schleife — planen (Rezept bzw. Plan), prüfen (Gegenprobe, Nachprüfung), feste Entscheidungsliste (Owner-Aufgaben, Bestätigungen), melden. Gemeinsamer Unterbau: Vorgangsschritte, Budget je Lauf, Meldeformat. Nachforschen ist der kleinere, risikoärmere erste Anwender (keine Schreibrechte).
- **Interessen als Wissen:** unberührt; Interessen lösen kein Nachforschen aus.
- **HA-Entitäten (offene Owner-Entscheidung, 72 nicht verfügbar):** Voraussetzung N0 — erst HA-Anomalien als Befunde, sonst bleibt der Waschkammerl-Fall auf dem Prosa-Weg. Dauerhaft tote Entitäten brauchen einen Normalzustand „bekannt tot", sonst erzeugen sie Dauerbefunde.

### Reihenfolge (nicht freigegeben)

- **N0** HA-Anomalien als Befunde, deterministisch gegen den Normalzustand: Licht/Schalter ungewöhnlich lange an, Entität neu nicht verfügbar, Melder seit X ohne Meldung.
- **N1** Rezept-Gerüst, Lese-Katalog und Positivliste, Prüfung vor dem Lauf; ein von Hand geschriebenes Referenzrezept (HA Licht/Melder) als Messlatte; Belegblock als Vorgangsschritt — beobachtend, Meldungen unverändert, Kennzahlen.
- **N2** Deutung mit Schema und Gegenprobe, Meldeformat, Owner-Aufgaben als Todos.
- **N3** Dynamische Erstellung beim ersten Auftreten (Planen, Prüfen, Anwenden, Verallgemeinern) — erst beobachtend neben dem Referenzrezept (gleiche Befunde, Ergebnisse vergleichen), dann aktiv.
- **N4** Nachprüfen und selbst schließen; Bewährung und Selbstverbesserung (Signale, Versionen, Stilllegen); Rezeptliste in App und Web.
- **N5** Rezepte aus Chat-Untersuchungen (Runbook-Reflektor); alle Befund-Quellen.
- **N6** (nur mit Owner-Entscheidung) freie Untersuchung als Rückfall mit eigenem Budget.

### Abnahme (messbar)

Waschkammerl nachgestellt (Verlauf 04.–11.10.): Meldung enthält Dauervergleich, stummen Melder, letzte Automationsauslösung, „nicht unterscheidbar" und die Aufgabe „betreten, Zigbee2MQTT prüfen" — mit Haiku und mit Mistral gleich; im Log 0 Schreibaktionen während des Laufs; Kosten je Lauf gemessen und unter Ziel; nach Melder-Reparatur (oder simuliertem Zustandswechsel auf der Test-VM) schließt Alfred Befund, Vorgang und Todo selbst. Dynamisch: Für den Waschkammerl-Fall erstellt Alfred ohne vorhandenes Rezept beim ersten Auftreten ein Rezept, das die Messlatte erreicht (gleiche Belege wie das Referenzrezept); ein ähnlicher Befund in einem anderen Raum nutzt es ohne Planungsaufruf; ein absichtlich schlechtes Rezept wird nach den Signalen überarbeitet bzw. stillgelegt (Test-VM, simulierte Zustände). Über zwei Wochen: Meldungen „prüfen, ob …" ohne Belege = 0 für alle Quellen mit Befunden; Planungsaufrufe pro Tag fallen nach der Anlaufphase gegen 0.

### Offene Owner-Entscheidungen

Tagesbudget für Läufe und für Planungen; Reihenfolge der Quellen (Vorschlag: Haus/HA, dann Infra); Schwelle für „bewährt" (Vorschlag 3 bestätigte Läufe); eigene Todo-Liste „Alfred-Aufgaben" oder Standardliste; freie Untersuchung als Rückfall (N6) ja/nein; ob Alfred risikoarme Selbsthilfe vorschlagen darf (z. B. Integration neu laden — das ist eine Schaltung und bliebe Klasse `bestaetigen`).

### Prüfung gegen den Stand 12.10.2026 (Owner: „Nachforschen-Spec prüfen")

**Seit dem Entwurf gebaut, das die Spec verändert:**

| Baustein | Wirkung auf Nachforschen |
|---|---|
| v1357 `history_summary` (Einschaltdauer, Phasen, Auffälligkeiten, Ursachen aus dem Logbuch — im Code berechnet) | ersetzt Rezeptschritt 1 und 4; begrenzte Ausgabe statt Rohverlauf; **nie ungefiltertes Logbuch** (34 MB/Tag, Lektion 12.10.) |
| v1358 `relations` (Licht → Schalter → Melder → Automation, inkl. `last_triggered`) | ersetzt Rezeptschritte 2 und 3 |
| v1359 Haus-Check A1–A3, B1–B3 als Befunde `haus-check` | deckt „Melder meldet nichts mehr" (B2) und tote Geräte (B1) wöchentlich ab — der stumme Waschkammerl-Melder wäre heute ein Befund; Owner-Entscheidung: Haus-Check erzeugt keine Vorgänge |
| v1362 E1/E2: Regeln (stumm/immer fragen), Haltefristen (Sicherheit sofort, Ausfall 2 h, Batterie 24 h, Abweichung 24 h) beobachtend | Live 12.10.: 8 von 8 Befund-Vorgängen „wären entfallen" (von selbst erledigt) — Nachforschen bei **jedem neuen** Befund wäre Verschwendung |
| E3 (Vorgang mit Lage, Belegen, Frage, Optionen, Vorschlag) — Spec „Entscheiden statt Abhaken" | Ausgabe der Deutung (Hypothese, Belege, nicht unterscheidbar, Owner-Aufgaben) ist genau das Futter für E3 — **ein** Schema statt zwei |
| v1368 Korrektur-Sperre nur bei genanntem Gegenstand; Sicherheit nie unterdrückbar | gleiche Regel für „nicht nachforschen": Befunde mit wirksamer Korrektur oder Regel `stumm` werden nicht untersucht |
| v1369 „Nicht zugestellt"-Zeile | Läufe, die nichts melden, zählen dort mit |

**Live-Befund (Woche 05.–12.10.):** Befunde ohne Haus-Check 32 neu, davon 29 von selbst erledigt. Vorgänge: Befund 85, Reasoning-Prosa 141 (reasoning 76, reasoning-insight 65), Lernbedarf 18. Offen u. a. **„Fenster von Lena prüfen" zweimal** (Prosa, Dublette) — die deterministische Haus-Deutung (`normalzustaende/haus.ts`: Öffnungen bei Abwesenheit, Rauch/CO/Wasser, Alarm) existiert, wird aber **nicht** an den Weltmodell-Beobachter gegeben; Befunde entstehen nur aus bmw, energie, sensorbatterien, mikrotik, infra, geraete, lebenszeichen, haus-check. Darum laufen Haus-Auffälligkeiten über den Prosa-Weg (ohne Identität, mit Dubletten und „prüfen, ob …").

**Änderungen an der Spec (Vorschlag):**
1. **N0 neu gefasst:** (a) Haus-Deutung als Befund-Quelle `haus` an den Weltmodell-Beobachter (Fenster/Tür offen bei Abwesenheit, Rauch/CO/Wasser, Alarm) — damit gelten Identität, E1-Regeln, Haltefristen, Lage, Korrektur-Gegenstand; der Prosa-Weg wird für diese Fälle schon heute zum Befund zugeordnet (.1222). (b) „Licht ungewöhnlich lange an" als Befund aus `history_summary` (ein Lauf täglich über die Lichter mit Bewegungsbezug aus `relations`). (c) „Entität neu nicht verfügbar" bleibt der bestehende infra-Befund (Monitor), keine zweite Quelle.
2. **Auslöser:** nachgeforscht wird, wenn ein Befund **seine Haltefrist überschreitet** (= er würde Vorgang), Sicherheit sofort — nicht bei jedem neuen Befund. Befunde mit Regel `stumm` oder passender Korrektur nicht. Prosa-Vorgänge (Weg b) erst in N5.
3. **Referenzrezept HA** = drei Aufrufe: `relations` (Bereich, Melder, Automationen), `history_summary` (Licht und Melder, 10 Tage), `state` der Melder (Batterie, `last_seen`). Lese-Positivliste HA: `state`, `history_summary`, `relations`, `review`, `areas`, `history` und `logbook` nur mit Entität und Zeitraum.
4. **Ein Ausgabeschema** für Nachforschen und E3: `{lage, hypothese, sicherheit, belege[], nicht_unterscheidbar[], frage, optionen[], vorschlag, owner_aufgaben[], alfred_schritte[]}` — am Vorgang gespeichert; E3 rendert es.
5. **Reihenfolge neu:** N0 (Befunde Haus) → N1+N2 zusammen, **beobachtend** (Lauf bei Haltefrist, Ergebnis als Vorgangsschritt `nachgeforscht`, Meldung unverändert, Kosten gemessen) → nach Auswertung E2 (~26.10.) Meldeformat und Owner-Aufgaben aktiv (zusammen mit E3) → N3 dynamische Rezepte → N4 Nachprüfen/Schließen → N5 Prosa-Weg und Chat-Rezepte.

**Offene Owner-Entscheidungen (mit Empfehlung):**
- Auslöser bei Haltefrist statt bei jedem neuen Befund — *Empfehlung ja*.
- N0 (a) Haus-Deutung als Befunde — *ja*; (b) Licht-Dauer täglich — *ja, beobachtend*.
- Owner-Aufgaben als eigene Todo-Liste „Alfred-Aufgaben" — *ja* (trennt sie von deinen eigenen Aufgaben, App-Ansicht Aufgaben zeigt beide).
- Budget: 10 Läufe oder 0,50 USD am Tag, 3 Planungen — *ja* (Live-Volumen nach Haltefrist: wenige Läufe pro Woche).
- „bewährt" nach 3 bestätigten Läufen — *ja*.
- Freie Untersuchung als Rückfall (N6) — *nein*.
- Selbsthilfe vorschlagen (z. B. Integration neu laden, Klasse `bestaetigen`) — *später, nach N4*.

**Owner-Entscheidungen 12.10. („ok wie empfohlen freigegeben"):** alle Empfehlungen oben angenommen.

**Umsetzungsstand:**
- **v1371 (12.10.):** N0 — Haus-Deutung als Befund-Quelle `haus` (bei Änderung und alle 10 min, ohne doppelten Mini-Pass); täglich 05:40 Licht-Dauer als Befunde `licht` (beobachtend, ohne Vorgang).
- **v1372 (12.10.):** N1/N2 beobachtend — Lese-Katalog (HA: state, relations, history_summary ≤ 10 d, history ≤ 7 d und logbook ≤ 3 d nur mit Entität, areas), vier Referenzrezepte (Licht lange an, offen/Bewegung bei Abwesenheit, Rauch/CO/Wasser/Alarm, Sensorbatterie), Prüfung vor dem Lauf und Positivliste bei jedem Aufruf, Belegblock ≤ 6 000 Zeichen, Deutung (fast, ohne Werkzeuge) mit Gegenprobe, gemeinsames Schema mit E3; Job `nachforschen` alle 10 min, je Befund einmal nach der Haltefrist, Budget 10 Läufe / 0,50 USD am Tag; Ergebnis als Vorgangsschritt `nachgeforscht` und im Zustand; Logzeile „v1372 Nachforschen (beobachtend)". Meldungen unverändert bis zur Auswertung ~26.10.
- **v1373–v1380 (12.10.):** Licht-Dauer auch für Schalter (v1373); Infra-Rezepte UniFi/Proxmox, „kein Rezept" wird neu versucht (v1376); erste echte Untersuchung 12.10. 15:09 (AC Mesh: Lage, Hypothese „niedrig", 3 Belege, 2 gestrichen, eine Owner-Aufgabe; 4,7 s, 0,0006 USD) nach Fix „Deutung am Token-Limit abgeschnitten" (v1378) und UniFi-Rezept mit Site-Statistik statt nicht verfügbarer Listen (v1379); PV-Rezept mit Wetter und PV-Sensoren, Befund-Titel mit Gegenstand und Messwert, Vorgangsziel = betroffene Zeile (v1380).
- **v1381 (12.10.):** UniFi-Warnungen/-Ereignisse aus dem System-Log (v2) — `list_alerts`/`list_events` und Monitor-Alarmprüfung funktionieren wieder; UniFi-Rezept liest Warnungen und Geräte-Ereignisse.

## Home-Assistant-Prüfung nach Best Practice (Entwurf 12.10.2026, Schicht 1–3 — ohne Umsetzung, Owner: „alfred sollte auch die homeassistant umgebung nach best practice untersuchen … und diese vorschlagen")

### Anlass

Realfall 11.10.: Bei der Frage „welche Lichter waren länger an" entdeckte Alfred nebenbei einen seit Tagen stummen Melder (Waschkammerl), einen zweiten im Gang OG (Automation zuletzt 07.09.) und einen Lichtschalter mit über 20 Verbindungsaussetzern pro Tag — alles nur, weil zufällig danach gefragt wurde. Der Owner will, dass Alfred die Umgebung als Ganzes prüft: Sind die Automationen sinnvoll, wie ließen sie sich verbessern, wo fehlen welche — und das als Vorschläge.

### Ist-Stand (Code und Live, 12.10.)

- **v1357 `history_summary`:** Verlauf, Schaltungen, Aussetzer, „unverändert seit", Ursachen aus dem Logbuch — im Code gerechnet.
- **v1358 `relations`:** Zuordnung Melder → Automation → Schalter aus den Konfigurationen (Entitäts- und Geräte-Trigger), Raum und Gerät je Entität, höchstens alle 30 min neu gelesen, Vergleich mit dem letzten Stand (auch über Neustarts) → Änderungsprotokoll (Sensortausch, Stilllegung, Umbau, neue fehlende Verweise). Live 12.10. 00:16: 107 Automationen, 4 ohne lesbare Konfiguration, 5 mit Verweisen auf fehlende Entitäten/Geräte, 15 deaktiviert, 34 aktiv aber seit über 30 Tagen nicht ausgelöst; 643 von 2 402 Entitäten haben einen Raum.
- Schreibende Aktionen gibt es bereits (`create_automation`, `update_automation`, `delete_automation`) — heute ohne eigenen Vorschlagsweg.
- Weltmodell „Haus" (Schicht 1) deutet Anwesenheit, Öffnungen, Rauch/Wasser; Sensorbatterien als Zeitreihe (v1171); Befunde/Vorgänge (Schicht 3) existieren.

### Grundsatz

Die Umgebung ändert sich (Sensortausch, Stilllegung, umgebaute Automation). Darum **kein gemerktes Bild der Anlage**, sondern bei jeder Prüfung frisch aus Home Assistant gelesen; gemerkt wird nur, **was sich seit dem letzten Stand geändert hat** und **wie der Owner auf einen Vorschlag reagiert hat**. Gesammelt wird ohne Modell nach festen Regeln; das Modell deutet und formuliert nur.

### Prüfkatalog (deterministisch, jede Regel mit Begründung in der Ausgabe)

**A — Automationen**
1. Verweis auf fehlende Entität oder fehlendes Gerät (Sensortausch ohne Nachziehen der Automation).
2. Aktiv, aber seit über 30 Tagen nie ausgelöst — getrennt nach „Auslöser stumm/defekt" (Verlauf des Auslösers) und „Anlass selten" (z. B. Rauchmelder, Saisonales).
3. Lange deaktiviert (> 30 Tage) — aufräumen oder bewusst behalten?
4. Ein/Aus-Paare: Einschalt-Automation aktiv, zugehörige Ausschalt-Automation deaktiviert oder fehlend → Licht bleibt an.
5. Konkurrenz: mehrere aktive Automationen schalten dasselbe Ziel mit widersprüchlicher Wirkung im selben Zeitfenster.
6. Geräte-Trigger/-Aktionen (Registry-IDs) statt Entitäten — Best Practice: Entitätsbezug, der übersteht Gerätetausch und ist lesbar.
7. Bewegungslicht mit Nachlauf im Modus `single` statt `restart` (Nachlauf wird nicht verlängert).
8. Auslöser ist ein Melder mit Auffälligkeit aus `history_summary` (stumm, Wert eingefroren, instabil).

**B — Entitäten und Geräte**
1. Dauerhaft nicht verfügbar (> 7 Tage), gruppiert nach Gerät/Integration.
2. Messwert eingefroren (Batterie 100 % seit Tagen, „letzte Meldung" alt).
3. Verbindung instabil (≥ 5 kurze Aussetzer/Tag).
4. Ohne Raum, obwohl Teil einer Automation (erschwert Zuordnung und Sprachsteuerung).
5. Doppelte Geräte für dieselbe Funktion (z. B. zwei Trockner-Shellys, eines dauerhaft an).

**C — System**
1. Neustarts und nicht sauber beendeter Recorder (Logbuch „stopped/started", Fehlerprotokoll).
2. Ausstehende Updates (`update.*`), gruppiert.
3. Fehler im Home-Assistant-Protokoll, nach Integration gezählt (nur Zählung + Beispiel, nie ganze Logs).

### Vorschläge für neue oder geänderte Automationen

Abgeleitet aus Mustern in Verlauf, Logbuch und Zuordnung — jede mit Beleg und fertigem Entwurf (Konfiguration als JSON wie `create_automation` sie braucht):
- **Licht ohne Ausschaltung:** Schalter wird oft ohne Kontext (Taster) eingeschaltet, bleibt lange an, im selben Raum gibt es einen Melder → Ausschalt-Automation mit Nachlauf.
- **Raum mit Melder ohne Licht-Automation** (oder umgekehrt).
- **Wiederkehrende Handschaltung** zur gleichen Zeit an ≥ 5 Tagen (±15 min) → Zeitplan.
- **Umstellung Geräte- auf Entitäts-Trigger** für bestehende Automationen (A6), **Modus `restart`** (A7), **Nachziehen nach Sensortausch** (A1, mit dem neuen Sensor aus dem Änderungsprotokoll).
- **Wächter**, wo ein Ausfall teuer wäre und noch keiner existiert (Melder stumm, Gerät offline) — anknüpfend an vorhandene „Wächter:"-Automationen.

Jeder Vorschlag ist Autonomie-Klasse **`bestaetigen`**: Alfred legt nichts an und ändert nichts ohne Zustimmung. Vor jeder Änderung wird die alte Konfiguration gesichert (Rückbau mit einem Schritt). Abgelehnte Vorschläge werden mit ihrem Schlüssel gemerkt und nicht erneut gebracht, solange sich die Grundlage nicht ändert.

### Ablauf

1. **Sammeln (ohne Modell):** Zuordnung + Verlauf + Logbuch + Fehlerzählung → Liste von Befunden mit stabilem Schlüssel (Regel + Objekt).
2. **Abgleich mit dem letzten Lauf:** neu / unverändert / erledigt (Befunde-Mechanik aus Schicht 3).
3. **Ein Modellaufruf** (Tier medium) bekommt nur die neuen und geänderten Befunde und formuliert: Priorität, Erklärung in einem Satz, Vorschlag mit Entwurf.
4. **Ausgabe:** ein Bericht „Haus-Check" (Kachel/Ansicht in der App) plus Vorgänge nur für die wichtigsten Punkte; Änderungsvorschläge als Bestätigungen.
5. **Rhythmus:** wöchentlich als Job im Register; zusätzlich gezielt, wenn das Änderungsprotokoll (v1358) etwas Neues meldet (z. B. Automation verweist plötzlich auf fehlende Entität).

### Budget und Grenzen

Sammeln kostet nur Home-Assistant-Abrufe (Messung 12.10.: Zuordnung 5,8 s, Verlaufsauswertung 0,3–1,4 s). Modell: ein Aufruf je Lauf, Zielgröße unter 0,10 USD. Keine ungefilterten Logbuch-Abrufe (1 Tag = 34 MB). Keine ssh-Zugriffe auf den Home-Assistant-Host für die Prüfung — alles über die API.

### Reihenfolge (nicht freigegeben)

- **H1** Prüfkatalog A1–A3, B1–B3 als reine Funktionen auf v1357/v1358 + Aktion `review` im Skill (nur lesend, Bericht).
- **H2** Befunde mit Schlüssel und Abgleich gegen den letzten Lauf; Wochen-Job im Register, zuerst **beobachtend** (nur Bericht an den Owner, keine Vorgänge).
- **H3** Restliche Regeln (A4–A8, B4–B5, C1–C3).
- **H4** Vorschläge mit Entwurf und Klasse `bestaetigen`, Sicherung vor Änderung, Merken abgelehnter Vorschläge.
- **H5** Musterbasierte Vorschläge (Handschaltungen, fehlende Ausschaltung) nach zwei Wochen Beobachtung.

### Owner-Entscheidungen (12.10.2026, „ok wie empfohlen freigegeben")

1. Umfang: H1 + H2, zwei Wochen beobachtend (nur Befunde, keine Vorgänge, keine Änderungen an Home Assistant); danach Entscheidung über H3–H5.
2. Rhythmus: wöchentlich So 09:00, zusätzlich nach erkannten Änderungen der Zuordnung.
3. Kanal: App + ein Satz auf Telegram. **Präzisiert nach Owner-Rückfrage („ist ein Gesprächsfaden die richtige Herangehensweise?")**: kein Faden, sondern **Befunde** (Schicht 3, Quelle `haus-check`) — Liste mit Zustand (neu/offen/erledigt, Wiederöffnen), in der Lage jedes Gesprächs, später per Einstellung mit Vorgang (H4). Native App-Ansicht „Befunde" für alle Quellen, der Haus-Check gruppiert nach Regel.
4. Umbau bestehender Automationen: ja (neue vorschlagen + bestehende umbauen), immer mit Bestätigung und Sicherung; Löschen nur auf ausdrücklichen Auftrag (gilt ab H4).
5. Grenzen: deaktiviert > 30 Tage, nicht ausgelöst > 30 Tage, nicht verfügbar > 7 Tage; Rauch/Wasser/Alarm bei „nicht ausgelöst" ausgenommen.
6. Ausgenommen: EMS/Batterie/Pool, Netzwerk-LEDs, Diagnose.
7. Lücken aus v1358 mitbeheben (Licht über Türkontakt, doppeltes Laden).

### Umsetzungsstand

- **v1359 (12.10.):** `skills/built-in/ha-pruefung.ts` (Regeln A1–A3, B1–B3, Ausnahmen inkl. Wiedergabe-Sitzungen und Batteriestände — die meldet „sensorbatterien"), Skill-Aktion `review`, `hausCheck()` mit Vollständigkeit (Abgleich nur nach vollständigem Lauf, sonst gälten Punkte fälschlich als erledigt), Deaktiviert-seit selbst beobachtet (HA hält ~10 Tage Verlauf), B1 aus dem Verlauf (HA-Neustart setzt last_changed zurück). Jobs `haus-check` (So 09:00, Slot) und `ha-zuordnung` (stündlich; Erstlauf einmalig über Slot ohne Datum, nach Änderungen je 6-h-Block). Lage bündelt den Haus-Check zu einer Zeile (sonst belegen 20–60 Punkte die 6 Plätze). Route `/api/geraete/befunde` (+ SITZUNG_PFADE). App 1.12.0: Ansicht „Befunde", Kachel-Zeile, Befehlspalette.
- **Live-Probe 12.10. 00:52:** 51 Punkte, vollständig, 17 s (107 Automationen, 412 Entitäten mit Verlauf). Kalibriert: Emby-Sitzungen ausgenommen (Rauschen); „UniFi Network: 151 Regel-Schalter nicht verfügbar" bleibt als ein echter Befund.

### Offene Owner-Entscheidungen

Nach der Beobachtungsphase (ab ~26.10.): H3–H5 freigeben? Bis dahin offen: welche Bereiche zusätzlich ausgenommen werden; ob Befunde des Haus-Checks Vorgänge erzeugen sollen.

<!-- ursprünglicher Stand der offenen Fragen (12.10. vor der Entscheidung): -->
Rhythmus (wöchentlich?) und Kanal (Bericht in der App, Telegram, nur Vorgänge?); ob Alfred bestehende Automationen umbauen darf (immer mit Bestätigung) oder nur neue vorschlägt; Grenze „lange deaktiviert" und „lange nicht ausgelöst" (Vorschlag 30 Tage); welche Räume/Bereiche ausgenommen sind (z. B. EMS/Batterie — eigene Spec); ob der Haus-Check auch die Netzwerkgeräte-LEDs und Diagnose-Entitäten ausblendet (Vorschlag: ja).

## Entscheiden statt Abhaken (Entwurf 12.10.2026, Schicht 3/4 — ohne Umsetzung, Owner: „bitte wirklich gründlich und richtig analysieren", Reihenfolge nach Einschätzung freigegeben: erst Fix „Ausführen" (v1361), dann diese Spec)

### Anlass

Owner 12.10. zur Vorgangsmeldung „Hausbatterie: SoC 47 %": „Bei Erledigt muss man doch sagen wie — und ob etwas entschieden wurde oder in Zukunft bei so etwas entschieden werden soll. Aktuell ist es mager: Erledigt mit optionalem Text, Verwerfen oder Chatten, ohne dass es den Befund beeinflusst oder Alfred überhaupt weiß, was und warum man sich über den Vorgang unterhalten hat. Was ist ein Vorgang überhaupt, warum mischst du das mit den Befunden?"

### Begriffe (verbindlich)

| Objekt | Bedeutung | Entsteht | Endet |
|---|---|---|---|
| **Befund** | Beobachtung „etwas ist auffällig" mit Identität (Quelle + Gegenstand) | Weltmodell, Haus-Check, Wächter — aus Messung | von selbst, wenn nicht mehr auffällig |
| **Vorgang** | Anliegen „es ist etwas zu tun oder zu entscheiden" mit Besitzer, Frage, nächstem Schritt, Frist, Ergebnis, Verlauf | aus Befund (nur bei Handlungsbedarf), Hinweis mit Handlung, Aktion, Lernbedarf, Projekt | durch Entscheidung oder Erledigung — mit Ergebnis |
| **Hinweis** | Mitteilung an den Owner, Ablaufdatum | Reasoning, Interessen, Vorausschau | Ablauf oder Reaktion |
| **Aufgabe** | konkrete Tätigkeit des Owners | Owner, Vorgang (Nachforschen: Owner-Aufgaben) | abgehakt |
| **Bestätigung** | Freigabe einer konkreten Aktion | Autonomie-Klasse `bestaetigen` | Ja/Nein |
| **Regel** (neu) | Entscheidung für die Zukunft: wie mit einer Art Befund/Vorgang umgegangen wird | Abschluss eines Vorgangs, Owner im Chat | widerrufen oder abgelaufen |

Ein Befund ist kein Vorgang; ein Vorgang kann aus einem Befund entstehen und verweist dann auf ihn.

### Ist-Stand (belegt 12.10., Woche ab 05.10.)

- **Jede Befund-Auffälligkeit wird sofort ein Vorgang** (`alfred.ts` setBefundeSync): 77 Befund-Vorgänge, 74 davon „von selbst erledigt: im Weltmodell nicht mehr auffällig" — Messwerte, die um eine Schwelle pendeln. Nächster Schritt jeweils nur „Owner entscheidet", ohne Frage.
- **Vorgangstext = Rohdatenauszug**: Ziel der Hausbatterie-Meldung ist die ganze Weltmodell-Zeile (inkl. PV und Raumtemperatur ohne Bezug).
- **Entscheidung ohne Inhalt**: App-Dialog erledigt | verworfen | Notiz (`entscheideOwner` setzt nur Status + Schritt `bestaetigt|abgelehnt`); in der Woche 20× „vom Owner erledigt", 1 Schritt „abgelehnt"; die Notiz wird nirgends gelesen.
- **Keine Wirkung**: Befund bleibt offen; tritt er wieder auf, entsteht ein neuer Vorgang (Wiederöffnen setzt `vorgang_id` zurück). Korrekturen im Chat (v1148) bremsen nur Hinweise — bei Weltmodell-Befunden setzt das Weltmodell sie bewusst außer Kraft (v1174). Schicht 4 zählt nur Erledigungsquoten je Kategorie.
- **Gespräch ohne Bezug**: „Nachfragen" schickt „Wie steht es um „<Titel>"?" — ohne Kennung, ohne Inhalt. Im Chat kennt Alfred Vorgänge nur als Zählung in der Lage; das Ausführungsgedächtnis („Bereits getan") sieht nur der Reasoning-Rundgang. **Kein Werkzeug** liest oder schreibt einen Vorgang; was besprochen wird, landet nie im Vorgang.
- **Baseline ohne Jahreszeit und Mindestabstand**: Vergleich gegen alle Proben ±1 h (Hausbatterie n = 106, rund zweieinhalb Wochen, sonniger Spätsommer), Schwelle |z| ≥ 3 über MAD — bei kleiner Streuung schlagen kleine Abweichungen an (Raumtemperatur 21,7 statt 22,5 °C „deutlich unter").
- „Ausführen" an Hinweisen: Fehler behoben in v1361 (Reasoning-Hinweise ohne Aktion).

### Ziel

Der Owner beantwortet eine **Frage** statt einen Status zu setzen; seine Antwort wird **Ergebnis** des Vorgangs und, wenn er will, **Regel** für die Zukunft. Regeln wirken deterministisch dort, wo Befunde, Vorgänge und Hinweise entstehen. Gespräche über einen Vorgang gehören zum Vorgang. Alfred legt nur Vorgänge an, bei denen wirklich gehandelt oder entschieden werden muss.

### Bausteine

**A — Vom Befund zum Vorgang nur bei Handlungsbedarf.** Ein Befund wird Vorgang, wenn (a) eine Regel es verlangt, (b) er länger als seine Haltefrist besteht (je Befundart, Vorschlag: Baseline-Abweichung 24 h, Ausfall/offline 2 h, Sicherheit sofort), (c) das Nachforschen (Spec „Nachforschen", N1–N3) eine Owner-Aufgabe oder Entscheidung ergibt, oder (d) der Owner ihn aus der Ansicht „Befunde" ausdrücklich zum Vorgang macht. Sonst bleibt er Befund (App-Ansicht „Befunde", v1359) und erledigt sich dort.

**B — Ein Vorgang stellt eine Frage.** Felder neu: `frage` (ein Satz, was zu entscheiden ist), `lage` (ein Satz, worum es geht), `belege` (gekürzt, mit Zeit und Quelle — aus Nachforschen bzw. Befund-Detail statt Rohzeile), `optionen[]` (2–4 Möglichkeiten, je `art` + Text + optional Aktion mit Vorschau und Autonomie-Klasse), `vorschlag` (welche Option Alfred empfiehlt und warum). Entstehen deterministisch aus Vorlagen je Befundart, sonst ein Modellaufruf (Tier medium) mit festem Schema; ohne gültige Optionen gilt die Standardauswahl (unten).

**C — Abschluss mit Ergebnis.** Der Dialog fragt zwei Dinge:
1. **Was war es?** `behoben` (Ursache, Maßnahme — je eine Zeile), `entschieden` (was), `kein Problem` (warum), `anders` (Freitext). Pflicht ist die Art; die Zeilen sind vorbefüllt aus Optionen/Gespräch und änderbar.
2. **Und künftig?** `wie heute` (keine Regel) · `so lassen, nicht mehr melden für …` (7/30/90 Tage) · `Normalwert/Schwelle anpassen` (Vorschlag mit Wert) · `immer so behandeln` (Option als Standard, ggf. Ausführung nach Autonomie-Klasse) · `jedes Mal fragen`.
Ergebnis schreibt Vorgangsfelder `ergebnis_art`, `ursache`, `massnahme`, `entscheidung` und einen Schritt `abgeschlossen` mit allem; „Erledigt"/„Verwerfen" als nackte Knöpfe entfallen (Kurzweg bleibt: Option mit einem Klick, Ergebnis = Option).

**D — Regeln, die wirken.** Tabelle `regeln (id, user_id, geltung {quelle, gegenstand | art}, wirkung {art: stumm|schwelle|normalwert|standard_option|immer_fragen, wert?, bis?}, begruendung, herkunft owner|chat, vorgang_id, erstellt, widerrufen_am)`. Wirkungsorte, alle deterministisch:
- Befund→Vorgang (Baustein A): `stumm` → kein Vorgang bis Ablauf; `immer_fragen` → sofort Vorgang.
- Normalzustände/Baseline: `schwelle`/`normalwert` überschreibt je Gegenstand (z. B. Hausbatterie: Abweichung erst ab 30 Punkten, Oktober–März).
- Hinweis-Gate (v1360): Hinweise zum geregelten Gegenstand werden wie Wiederholungen behandelt.
- Lage/Chat: aktive Regeln zum Thema stehen als eine Zeile im Kontext („Regel seit 12.10.: Hausbatterie unter Normal im Herbst — nicht melden").
- `standard_option`: beim nächsten Auftreten wird die gewählte Option vorgeschlagen bzw. — nur Klasse `auto` — ausgeführt und berichtet.
Regeln sind in der App einsehbar und widerrufbar (Ansicht „Befunde" → Abschnitt „Regeln"), jede Anwendung schreibt eine Logzeile und zählt (Schicht 4: Regel-Treffer, widerrufene Regeln).

**E — Gespräch gehört zum Vorgang.** „Nachfragen" öffnet einen **Vorgangsfaden** (`owner:faden:v-<id8>`, Fäden seit v1330 kanalunabhängig) mit Systemkopf: Lage, Frage, Optionen, Belege, Verlauf. Alfred bekommt die Werkzeuge `vorgang lesen`, `notiz ergänzen`, `abschluss vorschlagen` (Ergebnis + Regel als Vorschlag), `option ausführen` (über Autonomie-Klasse/Bestätigung). Abschließen und Regel anlegen nur mit Owner-Bestätigung (Knopf im Faden). Am Ende steht im Vorgang ein Schritt `besprochen` mit Kurzfassung und Verweis auf den Faden. Im Hauptgespräch erkennt Alfred Bezüge auf offene Vorgänge (Titel/Anker) und bietet „im Vorgang weiter?" an.

**F — Hinweise zeigen ihre Aktion als Status statt als Knopf.** Ergänzend zu v1361: Zu einem Reasoning-Hinweis zeigt die App, was aus der zugehörigen Aktion wurde („Erinnerung morgen 09:00 gesetzt — automatisch", „wartet auf deine Bestätigung", „blockiert") — Zuordnung über die Vorgangs-ID der Aktion (v1179) und Anker (v1360), sonst nichts.

### Beispieldurchlauf Hausbatterie (Messlatte)

Befund `energie/hausbatterie:baseline` entsteht 11.10. 16:14 → Haltefrist 24 h → besteht noch am 12.10. 16:14 → Vorgang:
> **Lage:** Hausbatterie seit gestern 16 Uhr unter ihrem üblichen Stand (47 % statt ~92 % um diese Uhrzeit), Vollladung zuletzt 07.10. **Belege:** PV-Ertrag 0,38 kWh am 11.10.; Verbrauch 12,5 kWh; Vergleichswerte 25.09.–11.10. **Frage:** Ist das so in Ordnung? **Optionen:** (1) normal für die Jahreszeit — Vergleich anpassen; (2) Vollladung jetzt anstoßen (Automation „Batterie-Pflege", Klasse bestätigen); (3) beobachten bis 15.10. **Vorschlag:** (1) — wenig PV seit Monatsbeginn.
Owner wählt (1), „Und künftig?" → „Normalwert/Schwelle anpassen: Abweichung erst ab 30 Punkten, Oktober–März". Ergebnis: Vorgang `entschieden`, Regel `schwelle` für `energie/hausbatterie`; der Befund schließt sich mit der neuen Schwelle; nächster Herbsttag ohne Meldung, im Chat weiß Alfred „Regel seit 12.10.".

### Reihenfolge (nicht freigegeben)

- **E1** Datenmodell (Vorgangsfelder, Tabelle `regeln`, Schritt-Arten `abgeschlossen`, `besprochen`) + Abschluss-Dialog in der App mit „Was war es?/Und künftig?" (Standardoptionen ohne Modell); Regeln `stumm` und `immer_fragen` an Befund→Vorgang wirksam; Ansicht „Regeln".
- **E2** Haltefristen je Befundart (Baustein A) — zuerst beobachtend: Logzeile „wäre Vorgang geworden", zwei Wochen.
- **E3** Frage/Lage/Optionen aus Vorlagen je Befundart (Hausbatterie, Sensorbatterie, Offline, Haus-Check-Regeln), Modell nur ohne Vorlage.
- **E4** Vorgangsfaden + Werkzeuge (Baustein E).
- **E5** Regeln `schwelle`/`normalwert` in den Normalzuständen, Baseline mit Mindestabstand je Größe und kürzerem Fenster.
- **E6** Hinweis-Status der Aktion (Baustein F); Schicht-4-Kennzahlen (Regel-Treffer, Abschlüsse je Ergebnisart).

### Abnahme (messbar)

Befund-Vorgänge je Woche von 77 auf ≤ 15 ohne verlorenen echten Handlungsbedarf (Gegenprobe gegen die Liste der von selbst erledigten); jeder vom Owner abgeschlossene Vorgang hat eine Ergebnisart; ≥ 1 Regel wirkt nachweislich (Logzeile) ohne Widerruf in 14 Tagen; ein im Faden besprochener Vorgang trägt den Schritt `besprochen`; Hausbatterie-Durchlauf wie oben live.

### Risiken

Zu frühes Stummschalten verdeckt echte Probleme → Regeln mit Ablauf, Sicherheits-Befunde (Rauch, Wasser, Einbruch) nie stummschaltbar, Regel-Liste sichtbar. Optionen vom Modell können falsch sein → Vorlagen zuerst, Modell-Optionen nur mit Vorschau. Zusätzlicher Aufwand beim Abschließen → Kurzweg „Option mit einem Klick", „Und künftig?" vorbelegt mit „wie heute".

### Verhältnis zu anderen Entwürfen

„Nachforschen vor dem Melden" liefert Belege, Hypothese und Owner-Aufgaben (Baustein B speist sich daraus); „Home-Assistant-Prüfung" (H4) braucht genau diesen Abschluss mit Regel für Vorschläge an Automationen; Befunde-Ansicht (App 1.12.0) wird Ort für Befunde ohne Vorgang und für Regeln.

### Owner-Entscheidungen (12.10.2026, „ok wie empfohlen freigegeben aber alfreds vorgeschlagene regeln sollte man auch übernehmen können")

Umsetzung E1 + E2 (E2 zwei Wochen beobachtend); Haltefristen Sicherheit sofort, Ausfall 2 h, Batterie 24 h, Abweichung 24 h, Haus-Check kein Vorgang; „nicht mehr melden" 7/30/90 Tage, Standard 30, danach einmal nachfragen; Alfred schlägt Regeln vor (ab drittem „kein Problem") — **übernehmbar mit einem Klick**, nie selbst angelegt; nie stummschaltbar: Rauch, CO, Wasser/Leck, Alarm, Einbruch/Sabotage, Alfreds eigener Zustand; Vorgangsfäden nur über den Vorgang (E4).

### Umsetzungsstand

- **v1361 (12.10.):** Reasoning-Hinweise ohne „Ausführen" (Baustein F, Vorstufe).
- **v1362 + App 1.13.0 (12.10. 03:03):** E1 — Ergebnis am Vorgang (Migration PG v136/SQLite v132: ergebnis_art, ursache, massnahme, entscheidung; Schritt `abgeschlossen`), Tabelle `regeln` (stumm/immer_fragen, Herkunft owner/alfred, Status aktiv/vorgeschlagen/widerrufen/abgelehnt), Regel „stumm" wirkt beim Befund-Abgleich (Logzeile „v1362 Regel: Befund ohne Vorgang"), Prüfung vor dem Abschluss (Sicherheitsbefund nicht stummschaltbar → 400 ohne Abschluss), Regelvorschlag ab drittem „kein Problem", Übernehmen mit Frist ab Übernahme, Lage-Zeile „Regeln des Owners"; App-Dialog „Was war es?"/„Und künftig?" mit vorausgewähltem Vorschlag, Regeln in „Befunde". E2 — Haltefristen nur protokolliert („v1362 E2 Haltefrist (beobachtend)", „v1362 E2 Vorgang wäre entfallen"); Auswertung ~26.10. Live geprüft: Routen mit Gerätetoken der VM (Regeln leer, 2 Befund-Vorgänge mit Bezug, ungültige Art 400).

### Offene Owner-Entscheidungen

Nach E2-Beobachtung (~26.10.): Haltefristen scharf schalten? Danach E3–E6.

<!-- ursprünglicher Stand der offenen Fragen (12.10. vor der Entscheidung): -->
Haltefristen je Befundart (Vorschlag oben); Standarddauer für „nicht mehr melden" (Vorschlag 30 Tage); ob Alfred Regeln selbst vorschlagen darf, wenn derselbe Befund dreimal „kein Problem" war; welche Befundarten nie stummschaltbar sind (Vorschlag: Rauch, CO, Wasser, Alarm, Einbruch); ob Vorgangsfäden in der Seitenleiste erscheinen oder nur aus dem Vorgang erreichbar sind.

## Auf Hinweise reagieren (Entwurf 12.10.2026, Schicht 3/4 — ohne Umsetzung, Owner: „vorher analysieren, was mit Hinweisen eigentlich geplant war und ob das Vorgehen das ändert oder beeinträchtigt — keine Freigabe")

### Wofür Hinweise gedacht sind (CHANGELOG + Specs)

| Stand | Festlegung | Quelle |
|---|---|---|
| Insight-Präferenzen (Juni/Juli) | Alfred lernt aus Reaktionen im Chat („danke/ok" positiv, „stopp/nervig" negativ, keine Reaktion = ignoriert) je Kategorie; Präferenz als Kontext im Reasoning-Prompt | `insight-tracker.ts` |
| Tracker-Umbau | **Informative Hinweise erwarten keine Reaktion** und werden nicht als „ignoriert" gezählt — „das System bestrafte Alfred für nützliche Insights, die keine Antwort brauchten" | CHANGELOG „Insight-Tracker: Fundamentaler Redesign" |
| v928 (02.07.) | Insights-Seite (Web): Aktion mit Eingabefeldern, Erledigen je Gruppe, „Mit Alfred besprechen", **„Solche nicht mehr" = Kategorie-Mute** (`insight_category_prefs`, zentral in `upsertCandidate`) | CHANGELOG v928 |
| v1148 (29.08.) | „Das ist normal / nicht mehr melden" im Chat wird **Korrektur** (ohne Verfall) und **hart** im Zustell-Gate durchgesetzt, objektweit, dauerhaft | CHANGELOG v1148 |
| Jarvis Schicht 3 (04.10.) | Handlungs-Insights werden Vorgänge; **reine Informationen bleiben Hinweise mit Ablaufdatum** | Spec oben |
| Jarvis Schicht 4 (04.10.) | Jede proaktive Nachricht bekommt ein Ergebnis-Signal (Reaktion, Erledigung, Ignorieren, Korrektur); Präzision je Quelle → Digest-Modus unter Schwelle (Schleife 2, **zurückgestellt bis Datenlage ~20.10. und Owner-Freigabe**) | Spec oben |
| .1186 | „Die Insight-Tabelle taugt nicht als Ergebnis-Signal — das Signal entsteht an den Vorgängen" | Umsetzungsstand Schicht 4 |
| v1343 (10.10.) | Sammlung „Hinweise": Erledigt/Später/Verwerfen/Ausführen, **jede Entscheidung nur als Signal protokolliert, gedrosselt wird nichts**; „verworfen" sperrt den Schlüssel dauerhaft | CHANGELOG v1343 |
| Interessen (Entwurf 10.10.) | Erledigt/Verworfen als Präzision je Anker (I5) | Spec „Interessen als Wissen" |
| Entscheiden (12.10.) | Hinweis = Mitteilung mit Ablaufdatum, endet durch Ablauf oder Reaktion; Regeln wirken auch im Hinweis-Gate (Baustein D) | Spec „Entscheiden statt Abhaken" |

**Kern:** Ein Hinweis ist Information, kein Auftrag. Er darf unbeantwortet ablaufen, ohne dass das als schlecht gilt. Reaktionen sind ein **Lernsignal** (Schicht 4); „nicht mehr melden" gibt es bereits zweimal (Kategorie-Mute v928, Korrektur v1148).

### Ist-Stand (belegt 12.10.)

- **Knöpfe in der App:** Nachfragen (Chat mit Titel + Text), Erledigt (`acted`), Später (24 h), Verwerfen (`dismissed`), Ausführen nur bei echter Aktion (Reasoning seit v1361 ohne).
- **Wirkung:** Erledigt/Verwerfen setzen nur den Status und schreiben die Logzeile „v1343 Hinweis entschieden". Verwerfen sperrt den Schlüssel dauerhaft — bei Reasoning-Hinweisen ist der Schlüssel aber „Tag + Titel", also praktisch ohne Wirkung. Die Wiederholungssperre (v1360) vergleicht mit den **zugestellten** Hinweisen der letzten 48 h, unabhängig vom Status.
- **Nicht verbunden:** Die App-Knöpfe speisen weder den Insight-Tracker (lernt nur aus Chat-Wörtern) noch die Korrekturen (v1148) noch die Regeln (v1362). Kategorie-Mute gibt es nur im Web — und für Reasoning wäre es zu grob: alle Reasoning-Hinweise haben die eine Kategorie `reasoning`.
- **Zahlen seit 10.10.:** reasoning 69 erledigt / 1 verworfen / 39 offen; interests 95 offen; vorausschau 1, kg-gap 2, lern-telemetrie 1. **68 der 69 „Erledigt" kamen am 11.10. zwischen 00:00 und 01:00 in einem Zug** — „Erledigt" wird als „gelesen / weg damit" benutzt. Als Präzisionssignal (Schicht 4, I5) ist es damit wertlos.
- Kein Grund beim Verwerfen; keine Kategorie gemutet; Korrekturen: 32 (alle aus dem Chat).

### Würde „Verwerfen mit Grund + Regel" den Zweck ändern oder beeinträchtigen?

| Gefahr | Bewertung | Folge für die Spec |
|---|---|---|
| Hinweise werden zu Mini-Vorgängen, die eine Entscheidung verlangen | widerspräche Schicht 3 und dem Tracker-Umbau | Reaktion bleibt **freiwillig**, Ablauf ohne Reaktion bleibt neutral, Grund ist optional, kein Pflichtdialog |
| Dritter Stumm-Mechanismus neben Kategorie-Mute und Korrektur | Doppelung, Owner sieht nicht, was wirkt | **Keine neue Mechanik:** „nicht mehr melden" schreibt in die Tabelle `regeln` (v1362), die laut Baustein D ohnehin im Hinweis-Gate wirken soll; Korrekturen und Kategorie-Mute bleiben unverändert und werden in der Regel-Ansicht nur **angezeigt** |
| Zu grobes Stummschalten verschluckt Wichtiges | real (Kategorie `reasoning` = alles) | Geltung je **Anker** (v1360 `ankerAus`: Hostnamen, Entitäten, Zitate, Kürzel), mit Ablauf; nie stummschaltbar wie bei Befunden (Sicherheit, Alfreds eigener Zustand) |
| Ein einzelnes „Verwerfen" bremst ein Thema | wäre Lernen aus Rauschen | Ein Verwerfen sperrt nur diesen Hinweis; **Regel nur auf Owner-Wunsch** oder als **Vorschlag ab dem dritten** Verwerfen mit gleichem Anker und Grund — übernehmbar mit einem Klick (wie E1) |
| „Falsch" als Grund vermischt Meinung und Fakt | ein falscher Hinweis ist ein Fehler, keine Vorliebe | „falsch" zählt als Fehlerfall je Quelle (Kennzahl) und läuft — mit Satz des Owners — durch dieselbe deterministische Korrektur-Erfassung wie v1148 (keine zweite Erfassung) |
| Interessen/Content-Studio betroffen | Interessen-Hinweise sind 95 der 139 seit 10.10. | Für Quelle `interests` nur der Vorschlag „Thema nicht mehr melden" = `notify_threshold: mute` (wie I1), nie `status`; ohne Freigabe I1–I5 wird nur gezählt |
| Schleife 2 (Digest-Modus) wird vorweggenommen | nein — sie braucht genau dieses saubere Signal | Spec liefert nur das Signal; Konsequenzen je Quelle bleiben Schleife 2 mit eigener Freigabe |
| Modellabhängigkeit | Grundsatz 29.08. | Grund, Anker, Regel, Gate: alles deterministisch; kein Modellaufruf |

**Ergebnis der Prüfung:** Der Zweck bleibt — es wird eingelöst, was Schicht 4, v1343 („Signal") und Baustein D („Regeln im Hinweis-Gate") schon vorsehen. Verändert würde nur „Erledigt": heute Abhaken ohne Bedeutung, künftig getrennt in „gelesen" (neutral) und „nützlich" (Signal).

### Bausteine

**K-A — Knöpfe mit Bedeutung.**
- **Nützlich** (ersetzt „Erledigt"; positives Signal für Quelle/Anker).
- **Gelesen** / „Alle gelesen" (neutral; räumt auf, zählt weder positiv noch negativ — für den Abend-Durchgang wie am 11.10.).
- **Nicht nützlich ▾** mit optionalem Grund: `schon bekannt` · `falsch` · `interessiert mich nicht` · `zu oft`. Ohne Auswahl = Verwerfen wie heute.
- **Später** und **Nachfragen** bleiben; Nachfragen markiert den Hinweis als `besprochen` (schwach positiv).
- Telegram: dieselben Antworten als Knöpfe unter der Meldung (QuickActionHandler, ohne Modell).

Speicherung: Status wie heute + Feld `reaktion` (`nuetzlich|gelesen|bekannt|falsch|kein_interesse|zu_oft|besprochen`) und `anker[]` beim Ablegen (aus v1360).

**K-B — „Und künftig?" nur auf Wunsch.** Bei `kein_interesse`/`zu_oft` bietet die App eine Zeile an: „Zu **<Anker>** nicht mehr melden — 7/30/90 Tage" (Standard 30, wie E1). Ergebnis ist eine Regel `stumm` mit Geltung `{quelle: 'hinweis', anker}` in `regeln`; das Hinweis-Gate behandelt passende Punkte wie Wiederholungen (Logzeile „Regel: Hinweis nicht zugestellt"). Bei `schon bekannt` keine Regel, aber das Thema gilt 7 Tage als bekannt (Wiederholungssperre statt 48 h). Nie stummschaltbar: dieselbe Liste wie bei Befunden.

**K-C — Vorschläge statt Eigenmächtigkeit.** Ab dem dritten `kein_interesse`/`zu_oft` mit überlappendem Anker in 30 Tagen schlägt Alfred die Regel vor (Status `vorgeschlagen`, übernehmbar mit einem Klick, Ansicht „Befunde → Regeln"). Für `interests` lautet der Vorschlag „Thema X nicht mehr täglich melden" (`notify_threshold`), sonst nichts am Thema.

**K-D — Eine Regel-Ansicht für alles, was stumm macht.** Abschnitt „Regeln" zeigt zusätzlich, nur lesend: Korrekturen aus dem Chat (v1148) und gemutete Kategorien (v928), je mit Herkunft und „widerrufen" (dieselben Endpunkte wie heute). Der Owner sieht an einer Stelle, warum etwas nicht mehr kommt.

**K-E — Messen (Schicht 4).** Präzision je Quelle und Anker = nützlich / (nützlich + nicht nützlich); „gelesen" und Ablauf zählen nicht. Kennzahlen `hinweisNuetzlich`, `hinweisNichtNuetzlich` je Grund, `hinweisRegelTreffer`. Grundlage für Schleife 2 und I5 — Konsequenzen dort, mit eigener Freigabe.

### Reihenfolge (nicht freigegeben)

- **K1** Knöpfe + Feld `reaktion` + Anker beim Ablegen + Kennzahlen (K-A, K-E), App und Telegram — reine Erfassung, nichts wird gedrosselt.
- **K2** „Und künftig?" + Regel im Hinweis-Gate + Vorschläge (K-B, K-C), Logzeilen; „schon bekannt" = 7 Tage.
- **K3** Regel-Ansicht inkl. Korrekturen und Kategorie-Mute (K-D).


### Abnahme (messbar)

Jede Owner-Reaktion trägt eine Art; „gelesen" verfälscht die Präzision nicht mehr (Gegenprobe: ein Abend-Durchgang wie am 11.10. ergibt 0 Präzisions-Ereignisse); eine aus einem Hinweis übernommene Regel unterdrückt nachweislich (Logzeile) einen späteren Hinweis zum selben Anker, ohne fremde Hinweise zu treffen (Test mit echten Hinweisen der Woche); kein Hinweis verlangt eine Reaktion.

### Offene Owner-Entscheidungen

„Erledigt" in „Nützlich" + „Gelesen" teilen (Vorschlag ja); Gründe-Liste wie oben; „schon bekannt" sperrt 7 Tage; Telegram-Knöpfe ja/nein; Reihenfolge K1 → K2 → K3 sofort oder K1 erst nach Auswertung E2 (~26.10.).

### Owner-Entscheidungen (12.10.2026, „ok wie empfohlen freigegeben")

„Erledigt" geteilt in „Nützlich" + „Gelesen"; Gründe-Liste wie oben; Telegram-Knöpfe ja. „Schon bekannt": Sperrdauer offen (Owner unsicher) → zwei Wochen beobachten (Logzeile „wäre als bekannt gesperrt", Tag seit Markierung, Inhalt gleich/geändert), dann entscheiden. Reihenfolge: K1 sofort, K2/K3 nach Auswertung ~26.10. (zusammen mit E2, Haus-Check und Schleife 2).

### Umsetzungsstand

- **v1364 + App 1.14.0 (12.10. 10:30):** K1 — Spalten `reaktion`, `reaktion_am` (PG v137 / SQLite v133); Reaktionen nuetzlich, gelesen, nicht_nuetzlich, bekannt, falsch, kein_interesse, zu_oft, besprochen über `/api/geraete/hinweise/<id>` (App bis 1.13: erledigt = gelesen, verwerfen = nicht nützlich); Logzeile „v1364 Hinweis-Reaktion" mit Ankern; Kennzahlen `hinweisNuetzlich`, `hinweisNichtNuetzlich`, `hinweisBekanntBeobachtet`; Telegram 👍/👎 je Hinweis passend zur Zeilennummer (auch aufgeschoben), Grund nach 👎, nur Owner-Chat; Beobachtung „bekannt" (`insights/hinweis-reaktion.ts`). Anker werden aus Titel + Text berechnet statt gespeichert (deterministisch, gleiche Funktion wie v1360). Live geprüft: Route 200, Reaktion in der DB, Logzeile, ungültige Aktion 400; Telegram-Knöpfe erst bei der nächsten Zustellung sichtbar.

## Vom Signal zur Handlung — Abgleich mit dem Bestand und Diagnose (Entwurf 13.10.2026, Schicht 2–4 — ohne Umsetzung, Owner: „mit allem was besteht abgleichen … sollte man nicht auch Diagnose einfügen, also Auffälligkeit → Diagnose → Befund → …?" — keine Freigabe)

### Anlass

Owner-Frage 13.10. nach einem Projekttag:
- Befunde entstehen aus gesammelten Daten und Ereignissen, daraus entstehen Vorgänge, auf die der Owner oder (je Autonomie) Alfred reagiert, und Hinweise ebenso.
- Vorgänge sind aber nie so beschrieben, dass man darauf reagieren könnte, und Alfred reagiert nicht.
- Hinweise kommen mehrfach, auch zu bereits behandelten Themen.

Dieser Abschnitt prüft das gegen alle bestehenden Bausteine und ergänzt „Entscheiden statt Abhaken" (E3–E6), „Nachforschen" und „Auf Hinweise reagieren" (K2/K3). Er ersetzt keinen davon.

### Belege (DB und Code, 13.10.)

**Vorgänge seit 29.09. (≈ 300):**
- 103 „von selbst erledigt" (Befund wieder unauffällig),
- 29 „automatisch ausgeführt", davon ausschließlich Erinnerung oder Todo angelegt,
- 20 vom Owner abgehakt, 25 behoben, 4 entschieden, 81 verworfen.
- **Keine einzige Gegenmaßnahme** zu einem Befund.

**Offene Vorgänge:**
- Nächster Schritt fest „Owner entscheidet" bzw. „Bestätigung des Owners".
- Ziel ist der rohe Befundtext („0x00158d000320aede temperature: 20,5 °C ↳ ⚠️").
- Dubletten: „Fenster von Lena" 2×, „Proxmox-Replikation" 2×.

**Code:**
- Befund → Vorgang (`alfred.ts` setBefundeSync) setzt `naechsterSchritt 'Owner entscheidet'` und `autonomie 'bestaetigen'`. Eine Aktion gibt es nicht; ein Vorgang hat kein Aktionsfeld, nur seine Schritte.
- Autonomie-Klassen wirken nur auf Aktionen, die das Modell im Reasoning vorschlägt.
- Die Regel `immer_fragen` wird gespeichert, aber nie ausgewertet; E2-Haltefristen laufen nur beobachtend.

**Hinweise 11.–13.10.:**
- Domains noahhabel 6×, Proxmox-Replikation 4× am 13.10., Fenster Lena und MikroTik mehrfach. Jedes Mal mit neuem Schlüssel `hinweis:<Tag>:<Titel>`, weil jeder Durchlauf den Titel neu formuliert.
- Zusätzlich wird Erzählung des Modells als Hinweis abgelegt („Ausgelassen habe ich …", „Die beiden Vorab-Auffälligkeiten habe ich …").

### Die Kette (verbindlich ergänzt)

| Stufe | Bedeutung | Heute |
|---|---|---|
| **Messung / Ereignis** | Rohdaten aus Quellen (HA, Monitor, Energie, Geräte, Mail …) | vorhanden |
| **Auffälligkeit** | deterministische Abweichung vom Normalzustand (Schwellen, Baseline z ≥ 3) | vorhanden (`normalzustaende/*`) |
| **Befund** | Akte der Auffälligkeit: Identität (Quelle + Gegenstand), seit wann, wie oft | vorhanden (`befunde`) |
| **Diagnose** (neu als Begriff) | Was steckt dahinter? Hypothese, Belege, Sicherheit, was nicht unterscheidbar ist, Optionen, Vorschlag | als **Nachforschen** gebaut, aber nur beobachtend; Ergebnis nur als Schritt bzw. in skill_state |
| **Vorgang** | Anliegen mit Frage, Lage, Optionen (je Aktion + Autonomie-Klasse), Vorschlag, Frist, Besitzer | Feld-Gerüst vorhanden (E1); Inhalt fehlt (E3) |
| **Reaktion** | Owner wählt eine Option, oder Alfred führt sie aus (Klasse `auto` bzw. Regel `standard_option`) | fehlt |
| **Nachprüfen / Abschluss** | Befund wieder unauffällig → Vorgang schließt mit Ergebnis | vorhanden („von selbst erledigt"), Ergebnis-Dialog nur in der App |
| **Regel** | Entscheidung für die Zukunft (stumm, Schwelle, Standard-Option, immer fragen) | `stumm` wirkt, Rest fehlt |

**Zur Reihenfolge „Auffälligkeit → Diagnose → Befund":** Inhaltlich ist es genau das. Der Befund ist allerdings die *Akte* der Auffälligkeit; die Diagnose braucht diese Identität:
- um ihr Ergebnis abzulegen,
- um nicht doppelt zu untersuchen,
- um Budget und Haltefrist zu führen.

Deshalb hängt die Diagnose **am** Befund. Entscheidend ist: **Vor der Diagnose entsteht kein Vorgang und kein Hinweis.** Ausnahme sind Sicherheitsbefunde, die melden sofort.

**Hinweise gibt es in zwei Arten** (die Festlegung „Hinweis = Information, kein Auftrag" bleibt):
- **Objekt-Hinweis:** betrifft einen Befund oder Vorgang (Proxmox, Domains, Fenster). Er trägt dessen Identität und entsteht nur bei einem **Zustandswechsel**: neu, schlimmer, Frist naht, Owner-Aktion nötig, erledigt.
- **Freie Information:** Interessen, Vorausschau, Strompreis, Lern-Telemetrie, Social, Insight-Adapter. Bleibt **unverändert**.

### Abgleich mit dem Bestand — was jeder Baustein heute tut und was sich ändern würde

| # | Bestand | Zweck heute | Wirkung des Vorschlags | Beeinträchtigung? |
|---|---|---|---|---|
| 1 | Normalzustände / Weltmodell (`normalzustaende/*`, Baseline MAD) | Auffälligkeit deterministisch erkennen | unverändert; Schwellen künftig per Regel (E5) | nein |
| 2 | Befunde (`befunde`, Wiederöffnen setzt `vorgang_id` zurück) | Akte mit Identität | erhält Verweis auf die Diagnose | nein |
| 3 | Befund → Vorgang (setBefundeSync, sofort) | jede Auffälligkeit wird Vorgang | Vorgang erst nach Haltefrist **und** Diagnose (A + E2-Auswertung ~26.10.); Sicherheit sofort | **ja, gewollt:** weniger Vorgänge; Gegenprobe gegen die 103 „von selbst erledigt" (Abnahme E) |
| 4 | Nachforschen N0–N2 (`nachforschen/*`, beobachtend, Rezepte, Schema mit lage/hypothese/frage/optionen/vorschlag/owner_aufgaben/alfred_schritte, 0,50 USD/Tag) | Diagnose vorbereiten | wird **die Diagnose-Stufe**: Ergebnis füllt Lage, Frage, Optionen und Vorschlag des Vorgangs; Meldung im Nachforschen-Format | Budget steigt mit Zahl der Befunde → Grenze bleibt, ohne Rezept Vorlage statt Modell |
| 5 | Mini-Pass bei neuem Befund (`zustandswechsel.ts`, „keine Vermutungen über Ursachen") | schnelle Meldung | wird Objekt-Hinweis mit Befund-Schlüssel; bei Befunden mit Haltefrist ersetzt die Diagnose-Meldung den Sofort-Hinweis | Meldung kommt später (Haltefrist); **Sicherheit unverändert sofort** |
| 6 | Reasoning-Hinweise (`legeHinweiseAb`, Schlüssel Tag + Titel; stille Ablage mit erster Aktion des Durchlaufs; Scan-Punkte) | Information aus dem Rundgang | passt ein Punkt (Anker v1360) zu offenem Befund/Vorgang → **kein neuer Hinweis**, sondern Schritt am Vorgang; neuer Hinweis nur bei Zustandswechsel; Erzählung über Alfreds eigenen Durchlauf wird deterministisch verworfen | weniger, nicht schlechtere Hinweise; Präzisions-Kennzahl (Schicht 4) ändert ihre Basis — als Bruch markieren |
| 7 | Insight-Vorgänge (`legeInsightVorgaengeAn`, übersprungen bei passendem **Befund**) | Handlungs-Insights werden Vorgänge | zusätzlich Abgleich mit offenen **Vorgängen** über Anker → Schritt statt Dublette | nein |
| 8 | Interessen (Digest je Thema und Tag), Vorausschau, Lern-Telemetrie, Social / Content-Studio, Insight-Adapter (infra-forecast, open-loop, kg-gap …) | freie Information bzw. eigene Aktionen (kg-gap, social-approval) | **unverändert** | nein — Content-Studio und Interessen bleiben unberührt |
| 9 | Zustell-Gate `pruefeHinweis` (Korrektur v1148, Wiederholung 48 h v1360, Faktencheck), Reaktionen K1, Beobachtung „bekannt" | Qualität vor Zustellung | Identitätsprüfung (Befund/Vorgang) läuft **vor** dem Textvergleich; K1 bleibt Lernsignal | nein |
| 10 | Regeln v1362 (`stumm` wirkt; `immer_fragen` gespeichert, nicht ausgewertet) | Entscheidung für die Zukunft | `immer_fragen`, `schwelle`, `standard_option` wirken (D) | nein |
| 11 | ITSM (dieselben Monitor-Alarme → Incident; Muster → Problem; **Auto-RCA** mit Hypothese und Fix; Tagesreflexion/Hygiene direkt an Telegram) | Störungs- und Problem-Management Infrastruktur | **Überschneidung:** für Infra ist die Auto-RCA bereits eine Diagnose. Vorschlag: Befund verweist auf den Incident, der Vorgang zeigt Incident/Problem und RCA als Diagnose, ITSM-Telegram-Meldungen gelten als Objekt-Hinweise desselben Gegenstands | heute dreifach (Befund-Vorgang, Incident, ITSM-Meldung); **Owner-Entscheidung nötig**, welches System bei Infra führt |
| 12 | Geplante Aufgaben (v1368, eigene Zustellentscheidung), ITSM-Direktmeldungen | eigene Kanäle | unverändert; nur in der Lage „Nicht zugestellt" mitgezählt | nein |
| 13 | Ausführen an Hinweisen (Web/App `act` für Nicht-Reasoning-Kategorien; Chat-Skill `insights act` **ohne** v1361-Prüfung) | Aktion aus Hinweis | Ausführen wandert an die **Option des Vorgangs**; Lücke im Chat-Skill schließen | Befund nebenbei: Chat-`act` umgeht v1361 |
| 14 | Lage, Ausführungsgedächtnis („Bereits getan"), Vorgangsliste | Kontext für Alfred | profitieren von Lage/Optionen im Vorgang | nein |
| 15 | Web-Vorgänge (nur erledigt/verworfen) | Abschluss | Abschluss-Dialog wie App (E1) | nein |

**Ergebnis der Prüfung:** Der Zweck der Hinweise bleibt erhalten (Information, kein Auftrag; freie Information unverändert). Geändert wird nur, dass Hinweise *über einen bekannten Gegenstand* an dessen Identität hängen. Der einzige echte Zielkonflikt ist ITSM bei Infrastruktur.

### Bausteine

- **V1 Objekt-Identität für Hinweise.**
  - Vor dem Ablegen oder Zustellen eines Reasoning-Punkts deterministisch prüfen: Passen Anker oder Gegenstand zu einem offenen Befund oder Vorgang? Dann wird ein Schritt `gemeldet` am Vorgang geschrieben.
  - Ein Hinweis entsteht nur bei Zustandswechsel: neu, schlimmer, Frist < 24 h, Owner-Aktion nötig, erledigt. Schlüssel `objekt:<befund|vorgang>:<id>:<wechsel>`.
  - Punkte, die Alfreds eigenen Durchlauf beschreiben, werden verworfen (feste Muster, Logzeile).
- **V2 Diagnose scharf.** Das Nachforschen-Ergebnis füllt am Vorgang `lage`, `frage`, `belege`, `optionen[]` und `vorschlag` (Felder aus B). Gemeldet wird im Nachforschen-Format. Ohne Rezept gelten Vorlagen je Befundart (E3), das Modell nur mit festem Schema. Für Infra mit offenem Incident wird die Auto-RCA übernommen statt neu untersucht (nach Entscheidung zu #11).
- **V3 Vorgang erst nach Diagnose** (A, Haltefristen aus E2).
- **V4 Reagieren.** Jede Option trägt eine Aktion mit Vorschau und Autonomie-Klasse; „Ausführen" sitzt an der Option (App, Web, Telegram-Knopf). Die Regel `standard_option` lässt Alfred beim nächsten Auftreten selbst handeln, nur bei Klasse `auto`, sonst als Vorschlag. Danach prüft Alfred selbst nach, ob der Befund verschwindet.
- **V5 Gespräch und Web.** Vorgangsfaden (E4), Abschluss-Dialog im Web, Chat-`insights act` mit v1361-Prüfung.
- **V6 ITSM-Brücke.** Befund ↔ Incident verknüpfen; eine Meldung je Gegenstand.

### Reihenfolge (nicht freigegeben)

1. **V1** sofort möglich: rein deterministisch und unabhängig von E2. Am schnellsten spürbar (Domains 6× → 1× + Fristerinnerung).
2. **V2 + V3** nach der E2-Auswertung (~26.10.).
3. **V4**.
4. **V5 / V6**.

Jeder Schritt bekommt eine eigene Version und einen Live-Beweis.

### Abnahme (messbar)

- Je Gegenstand höchstens ein Hinweis pro Zustandswechsel (Gegenprobe mit den Hinweisen vom 11.–13.10.).
- Kein Erzähl-Hinweis mehr.
- Keine zwei offenen Vorgänge mit überlappendem Anker.
- ≥ 80 % der Befund-Vorgänge haben Frage und mindestens zwei Optionen.
- Mindestens eine Option wird nachweislich von Alfred per Regel ausgeführt und nachgeprüft (Logzeile + Schritt).
- Freie Informationen (Interessen, Vorausschau, Strompreis) unverändert in Zahl und Zustellung.

### Risiken

- **Verspätete Meldung durch Haltefrist:** Sicherheit bleibt sofort, Ausfall 2 h (Owner-Entscheidung 12.10.).
- **Falsche Anker-Zuordnung verschluckt einen neuen Punkt:** Zuordnung nur bei eindeutigem Anker, sonst Hinweis wie heute; Logzeile „einem Vorgang zugeordnet" zur Kontrolle.
- **Diagnosekosten:** Budget je Tag bleibt, Vorlagen zuerst.
- **Kennzahlen-Bruch in Schicht 4:** Stichtag markieren.

### Offene Owner-Entscheidungen

1. Infrastruktur: Führt ITSM (Incident/Problem mit RCA), und der Vorgang verweist nur darauf (Empfehlung)? Oder ersetzt der Vorgang die ITSM-Meldungen an den Owner?
2. Liste der Zustandswechsel für Objekt-Hinweise wie oben?
3. Darf der Sofort-Hinweis bei neuen Befunden mit Haltefrist durch die spätere Diagnose-Meldung ersetzt werden (Empfehlung ja, Sicherheit ausgenommen)?
4. Reihenfolge: V1 sofort, Rest nach ~26.10. (Empfehlung)?

### Owner-Entscheidungen (13.10.2026, „einverstanden wie empfohlen“ — Umsetzung noch nicht freigegeben)

1. Infrastruktur: ITSM führt (Incident/Problem mit RCA), der Vorgang verweist darauf.
2. Zustandswechsel für Objekt-Hinweise wie vorgeschlagen (neu, schlimmer, Frist < 24 h, Owner-Aktion nötig, erledigt).
3. Der Sofort-Hinweis bei Befunden mit Haltefrist wird durch die Diagnose-Meldung ersetzt; Sicherheit bleibt sofort.
4. Reihenfolge: V1 zuerst, V2–V6 nach der E2-Auswertung (~26.10.).

### Umsetzungsstand

- **v1428 (13.10.):** V1 — Objekt-Hinweise (`insights/objekt-hinweis.ts`, Zuordnung über Titelwörter + Anker, kalibriert an 179 echten Punkten 06.–13.10., 108 zugeordnet), Zustellung nur bei neu/geändert/Frist < 24 h, Schritt `gemeldet` am Vorgang; Insight-Vorgänge ohne Dublette eines offenen Vorgangs; Erzähltext-Filter erweitert; Lage-Zähler „Nicht zugestellt“ dauerhaft (`data/zustellprotokoll.json`); Chat-`insights act` mit v1361-Sperre. Logzeilen „v1428 Objekt-Hinweis …“, Kennzahlen `hinweisObjektBekannt`, `hinweisObjektGemeldet`, `vorgaengeZuVorgang`.

## Lernende Helfer neben dem Sprachmodell (Entwurf 12.10.2026, Schicht 4 — ohne Umsetzung, Owner: „ok wie vorgeschlagen, Reihenfolge bestimmst du")

### Anlass

Owner 12.10. (Gedanken zu Machine Learning): Ein kleines ML-System unterstützt das Sprachmodell, ohne es zu trainieren — es übernimmt eng begrenzte Entscheidungen (Art der Anfrage → Ablauf/Werkzeug, relevante Erinnerungen, Schwierigkeit → Code/kleines/großes Modell, Akzeptanz von Vorschlägen, wiederkehrende Muster) und lernt aus Anfrage → gewählter Ablauf → erfolgreich oder korrigiert. Beispiel: häufige Fragen erkennt ein Klassifikator, normaler Code beantwortet sie ohne Modellaufruf.

### Bewertung gegen Alfred (12.10.)

Die Idee entspricht dem Jarvis-Grundsatz „deterministisch zuerst, Modell nur wo nötig". Die Grenze ist die **Datenmenge eines Einzelnutzers**, nicht das Verfahren.

| Aufgabe | Daten bei Alfred | Entscheidung |
|---|---|---|
| Vorschläge nach Akzeptanz reihen | Dutzende Reaktionen/Woche (K1, Vorgangs-Ergebnisse, Regeln) | **Zählen statt ML** — Quoten je Quelle/Anker, schon Schicht 4 / Schleife 2 |
| Relevante Erinnerungen auswählen | keine Beschriftung „gebraucht" | **nicht** — drei frühere Kürzungen nach vermuteter Relevanz schlugen zurück (06.10.); 63 % der Eingabe kommen aus dem Prompt-Cache |
| Werkzeug/Ablauf wählen | ~760 Anfragen/Woche mit genutzten Skills und Ausgang | **Kandidat für ML** (L2) — Ziel Tempo; „Schemata bleiben" (07.10.) gilt: vorsortieren, nie weglassen |
| Schwierigkeit → Modellstufe | Kosten/Dauer gemessen, Erfolgssignal fehlt | erst das Signal (L0); Vergleich 11.10.: Opus allein besser als „stark plant, günstig führt aus" |
| Häufige Fragen ohne Modell | Wiederholungen im Verlauf | **zuerst ohne ML** — feste Schnellantworten aus dem Weltmodell (L1) |
| Muster → Abläufe vorschlagen | Pattern-Analyse, Runbooks vorhanden | Verbesserung des Bestehenden, eigener Punkt später |

**Ist (05.–12.10.):** ~760 Anfragen (Telegram 397, App/API 366), Antwortzeit p50 9,6 s / p95 42 s (535 Gesprächsanfragen), Modellkosten 65 USD bei 6 589 Aufrufen.

### Grundsätze

Messen vor Lernen; jedes gelernte Teil läuft zuerst **beobachtend** neben der heutigen Entscheidung und darf erst entscheiden, wenn es nachweislich besser ist; erklärbare Verfahren (Zählung, Naive Bayes, logistische Regression) direkt in Alfreds Code, kein eigener Python-Dienst, CPU; modellunabhängig (Grundsatz 29.08.); Daten bleiben in Alfreds Datenbank.

### Bausteine

**L0 — Anfrage-Protokoll (Lernsignal).** Je Gesprächsanfrage eine Zeile: Zeit, Kanal, grobe Absicht (deterministisch aus den Kategorien des Skill-Filters), Textauszug (≤ 200 Zeichen) bzw. Wortmerkmale, genutzte Skills und Aktionen mit Ausgang, Modellstufe und Modell, Dauer, Kosten, Werkzeugrunden, und das **Folgesignal**: innerhalb von 5 Minuten Korrektur („falsch", „nein, …", v1148-Erfassung), gleiche Frage erneut, Abbruch (Stopp-Knopf), Reaktion 👍/👎 bei Hinweisen. Kennzahlen in Schicht 4: häufigste Absichten, Wiederholungsfragen, Anteil korrigiert je Absicht und Stufe. Zwei Wochen, dann Auswertung zusammen mit E2/K1/Verknüpfung (~26.10.).

**L1 — Schnellantworten.** Aus L0 die 5–10 häufigsten, eindeutig aus dem Weltmodell beantwortbaren Fragen (z. B. Ladezustand Auto, Hausbatterie, offene Vorgänge, „was gibt's Neues") als feste Muster mit Antwort aus der Weltmodell-Sektion — wie „warum?" (v1196) ohne Modellaufruf. Erst eine Woche parallel: Schnellantwort berechnen, Modellantwort trotzdem senden, beide vergleichen (Zahlen gleich?); dann scharf. Unsichere Fälle gehen immer ans Modell.

**L2 — Lernende Werkzeugwahl.** Ein Klassifikator (Naive Bayes / logistische Regression über Wortmerkmale) sagt aus L0-Daten die benötigten Skills voraus. Beobachtend: Vorhersage gegen tatsächlich genutzte Skills (Trefferquote, Vollständigkeit). Nur bei Vollständigkeit ≥ 98 % darf er die Werkzeugliste **vorsortieren** (passende zuerst) — weggelassen wird nichts. Nutzen: weniger Werkzeugrunden, kürzere Antwortzeit.

**L3 — Stufenwahl.** Erst wenn L0 ein belastbares Erfolgssignal je Stufe zeigt: Regel oder Klassifikator „reicht fast/medium?" — beobachtend, Kosten- und Korrekturvergleich.

**L4 — Vorschläge reihen:** bleibt Zählung (Schleife 2), kein ML.

### Reihenfolge (nicht freigegeben)

L0 (zwei Wochen messen) → Auswertung → L1 (parallel, dann scharf) → L2 beobachtend → L3 nur mit Signal.

### Abnahme (messbar)

L0: jede Gesprächsanfrage eine Zeile mit Folgesignal; Auswertung nennt die häufigsten Absichten und Wiederholungsfragen. L1: Schnellantworten stimmen in der Parallelwoche zu 100 % mit den Zahlen der Modellantwort überein; danach p50 dieser Fragen < 1 s und 0 Modellaufrufe. L2: Vollständigkeit ≥ 98 % über zwei Wochen, bevor er vorsortiert; Werkzeugrunden je Anfrage sinken messbar.

### Risiken

Falsche Schnellantwort ohne Modell → nur eindeutige Muster, Parallelwoche, unsichere Fälle ans Modell. Zu wenig Daten für L2 → bleibt beobachtend, kein Schaden. Datenschutz: Textauszüge der eigenen Anfragen in Alfreds Datenbank (wie Verlauf heute), Aufbewahrung begrenzt (Vorschlag 90 Tage).

### Offene Owner-Entscheidungen

Textauszüge speichern (Vorschlag ja, ≤ 200 Zeichen, 90 Tage) oder nur Wortmerkmale; Freigabe L0 jetzt (Vorschlag ja, reine Messung); welche Fragen L1 zuerst (nach L0-Auswertung).

**Owner-Entscheidungen 12.10. („wie empfohlen"):** L0 jetzt, Textauszüge ≤ 200 Zeichen, 90 Tage.

**Umsetzungsstand:** v1374 (12.10.) L0 — Tabelle `anfrage_protokoll`, Haken am Ende jeder Gesprächsanfrage und bei Abbruch, Folgesignal korrigiert/wiederholt (5 min, deterministisch), Aufräumen täglich 03:50; Logzeile „v1374 Anfrage-Folgesignal".
