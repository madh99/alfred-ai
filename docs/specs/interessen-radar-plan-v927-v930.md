# Umsetzungsplan: Stiller Modus + Interessen-Radar (v927–v930)

**Stand:** 02.07.2026 · **Status:** freigegeben, Umsetzung läuft
**Ziel:** Alfred arbeitet unverändert weiter (Reasoning, Watches, Sammeln = „Dev-Mode"), aber der
Standard-Ausgang wird **internes Wissen** statt Telegram-Nachricht. Gemeldet wird nur Wichtiges
(transparent begründet, lernend). Wissen ist auf Nachfrage abrufbar („Was gibt's Neues zu X?")
und in der UI sichtbar. Alfred erkennt Interessen aus Gesprächen und abonniert selbst Quellen.

**Ausgangsbefund (02.07.):** ~14 proaktive Sender ohne zentralen Gate; Reasoning sendet alle
~30 Min; Insights-UI (alfred_insights) zeigt 70 pending mit unbrauchbaren Aktionen
(Button = interner Skill-Name „memory", ohne benötigte Eingaben); Wichtigkeit = intransparentes
LLM-Bauchgefühl (urgent/high→senden, normal→deferred, low→verwerfen).

---

## v927 — Notification-Router + Wichtigkeits-Score v1

**Effekt:** 30-Minuten-Flut endet sofort; nichts geht verloren (alles in der Insights-UI).

1. **`packages/core/src/notification-router.ts`** (neu):
   - `route({source, urgency, title, body, category, reasons, chatId, platform, actionSkill?, actionParams?})`
   - Entscheidung: `urgency ≥ Schwelle` (config) → senden wie bisher; sonst → **still** in
     `alfred_insights` (insights-repository.upsertCandidate; category = source, body enthält
     Begründung) → erscheint in der bestehenden Insights-UI.
   - Config (`notifications:`-Block, Zod + Defaults): `minUrgency` (Default `high`),
     `perSource: Record<string,urgency>`, `devMode: boolean` (true = alles senden wie früher),
     `dailyDigestHour` (optional, Default aus).
2. **Score v1 (transparent):** Reasoning-Insight-JSON um `warum` (1 Zeile) + Kriterien-Flags
   erweitern (`zeitdruck`, `konsequenz`, `handlungsfaehigkeit` je 0–2). Score = gewichtete
   Summe (+ später v930: Themen-Relevanz, Präferenz aus InsightTracker). Score→Urgency-Band.
   Begründung wird mitgespeichert und angezeigt.
3. **Verdrahtung:** reasoning-engine `deliverOrDefer`/`sendMessage`-Stellen → Router.
   Ebenfalls durch den Router: ITSM-Tagesreflexion (alfred.ts ~23:00), Automation
   `deliverOutput`. NICHT durch den Router: Confirmations/Eskalationen (actionable Fragen),
   Reminder/Todo-Alerts (haben seit v924 Buttons), Watch-Alerts (user-definiert).
4. **On-Demand-Abruf:** „Was ist angefallen?" — Aktion im briefing-Skill (`silent_digest`):
   liest ungesendete alfred_insights seit letztem Abruf → EINE Zusammenfassung. Optionaler
   Tages-Digest (dailyDigestHour) über denselben Pfad.
5. **Tests:** Router-Entscheidung (Schwellen, devMode, perSource), Score-Mapping.

**DB:** alfred_insights hat schon category/title/body/action_skill/action_params/status/dedupe_key
— KEINE Migration nötig (Begründung geht in body; source_data trägt Router-Metadaten).

## v928 — Insights-UX-Rework (UI brauchbar machen)

1. **Sprechende Aktionen:** Insight bekommt optional `actionLabel` (z. B. „Geburtstag eintragen")
   + `inputFields: [{key,label,type:'date'|'text'|'number'}]` (in source_data, keine Migration).
   act-Endpoint (`/api/insights/:id/act`) akzeptiert `params` und merged sie in actionParams.
   KG-Gap-Adapter liefert actionLabel + inputFields (Geburtstag = date-Feld).
2. **UI InsightsPage:**
   - Action-Button zeigt actionLabel (Fallback-Mapping skill→Label), rendert inputFields inline.
   - **Gruppierung** nach category (collapsible, Zähler) + **Bulk-Verwerfen** je Gruppe.
   - **Batch-Eingabe** für KG-Gaps: Tabelle Person|Datum → ein Submit → n acts.
   - **„Mit Alfred besprechen"**: Link zu /alfred/chat mit vorbefülltem Kontext (Insight-Titel+Body).
   - **„Solche nicht mehr"**: Kategorie-Mute → insight_category_prefs (kleine neue Tabelle,
     SQLite v111/PG v115) ODER InsightTracker-Memory; fließt als Präferenz-Kriterium in den Score.
   - Begründung (warum wichtig/unwichtig) sichtbar auf der Karte.
3. **Tests:** act-mit-params, Kategorie-Mute wirkt auf Score.

## v929 — Themen-Fundament (Interessen-Radar manuell)

1. **Tabellen** (SQLite v112/PG v116): `interest_topics` (name, keywords JSON, status
   active|paused|archived, origin auto|manual, notify_threshold, created_at, last_activity_at),
   `topic_sources` (topic_id, kind rss|web_search, config JSON, added_by, enabled,
   last_checked_at), `topic_items` (topic_id, title, url, summary, source_kind, published_at,
   importance, created_at), `topic_digests` (topic_id UNIQUE, summary, items_since_update,
   updated_at). Repos in @alfred/storage.
2. **Skill `interests`:** create_topic, list_topics, add_source, remove_source, topic_briefing
   (Dossier + neueste Items; Dossier-Refresh lazy beim Abruf via LLM wenn neue Items),
   collect_now. Skill-Beschreibung: bei „was gibt's Neues zu <Thema>" IMMER topic_briefing.
3. **Collector** (Kern, stündlich, HA-Slot `topic-collect:<stunde>`): RSS via rss-parser
   (wie feed-reader), web_search-Quellen via Skill-Aufruf; Items dedupliziert (URL/Titel-Hash)
   → topic_items. Sendet NICHTS.
4. **Pipeline-Kontext:** aktive Topic-Namen als Zeile im System-Kontext (damit das LLM
   topic_briefing für Themen-Fragen nutzt).
5. **Tests:** Topic-CRUD, Collector-Dedup, briefing-Format.

## v930 — Autonomie + UI

1. **Interest-Detector:** Reasoning-Pass erkennt wiederkehrende Gesprächsthemen (aus
   Konversations-Sektion + KG) → schlägt Topic als Insight mit Aktion „Thema anlegen" vor
   (Confirmation); bei sehr starkem Signal auto-anlegen (origin=auto, still, UI zeigt es).
2. **Source-Provisioner:** bei Topic-Anlage LLM-Vorschlag (2–3 RSS-Kandidaten via web_search
   „<thema> rss feed" + 1–2 stehende Such-Queries) → topic_sources (added_by=auto).
3. **Digest-Builder** (täglich 06:30, HA-Slot): je Topic mit neuen Items Dossier
   aktualisieren (rolling summary); Items ≥ topic.notify_threshold → EINE gebündelte
   Meldung über den Router.
4. **Score-Vervollständigung:** Kriterien 4+5 (Themen-Relevanz via topic-keywords-Match,
   Präferenz via Kategorie-Mutes/acts) in den v927-Score einhängen.
5. **UI „Interessen"-Seite:** Topic-Karten (Dossier-Vorschau, Quellen, Aktivität),
   Detail (Dossier, Item-Timeline, Quellen-CRUD, notify_threshold, pause/archive),
   „Vorgeschlagene Themen" (auto-erkannt → bestätigen/ablehnen).
   **Router-Einstellungen** (Einstellungs-Sektion): Dev-Mode-Schalter, Schwellen je Sender.

---

## Konventionen je Stufe
Version-Bump + CHANGELOG + README-Badge + `pnpm build` + `node scripts/bundle.mjs` + Tests +
Commit (deutsch, keine AI-Attribution) + Push gitlab & github. Deploy macht der User.

## Wichtige Bestandsfakten (für die Umsetzung)
- Insights-UI: `/api/insights` → insights-repository → Tabelle `alfred_insights`
  (Felder: category, title, body, confidence, source_data, action_skill, action_params,
  status pending|snoozed|acted|dismissed|expired, dedupe_key). act-Callback alfred.ts:7514.
- Reasoning: parse liefert items mit urgency urgent|high|normal|low (reasoning-engine.ts:58);
  Versand deliverOrDefer ~:1353; deferred_insights = eigene Tabelle für Später-Flush.
- InsightTracker lernt Kategorie-Präferenzen aus Reaktionen (insight-tracker.ts).
- feed-reader-Skill kann subscribe/check (rss-parser); briefing-Skill aggregiert Sektionen.
- Letzte Migrationen: SQLite v110 / PG v114.
