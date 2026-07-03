# Umsetzungsplan: Social-Media-Betrieb (v933–v938)

Stand: 03.07.2026 · Freigegeben durch User („ok, passt so") nach Konzept-Review.

## Ziel

Alfred betreibt bestehende Social-Media-Kanäle oder baut neue auf — pro Projekt
(z. B. fussball-cc) oder standalone. Er baut Wissen auf (was wollen die
Zuschauer, welche Nischen funktionieren), erstellt Content (Text, Bild, Video),
plant im konfigurierbaren Horizont voraus und published je Kanal-Modus:
Vorschlag → Freigabe → autonom. Jede Plattform funktioniert ab Tag 1 in einem
von zwei Publish-Modi: `api` (Alfred veröffentlicht selbst) oder `prepare`
(Alfred bereitet fertig auf — Text, Medien, Hashtags, Zeitpunkt — der User
postet mit 2 Taps und bestätigt).

## Plattform-Zuschnitt (User-Entscheidung)

- **Kern:** Meta (Instagram + Facebook + Threads, Graph API; bis App-Review
  durch ist im prepare-Modus), YouTube inkl. Shorts (Data API v3, OAuth2),
  TikTok (prepare-Modus, API-Audit restriktiv), Telegram-Kanal (trivial,
  Bot-API), eigene Plattform (generic-REST-Provider, z. B. fussball.cc-API —
  die sich Alfred per Code-Agent selbst baut).
- **Dazu:** X/Twitter Free-Tier (500 Posts/Monat), WhatsApp-Channels (prepare),
  Mastodon/Bluesky/RSS (trivial), LinkedIn (nur bei B2B-Bedarf).

## Video (User-Entscheidung)

Stufe 1 (ffmpeg-Slideshow/Shorts + TTS + Untertitel, lokal, kostenlos)
**+** Hybrid (Alfred liefert Script/Thumbnail/Metadaten, User dreht)
**+** externer Video-Provider (Runway/Kling/Veo) als vorbereitetes Interface,
per Config aktivierbar **+** User kann eigene Videos liefern (Telegram-Upload →
Asset-Bridge → ans Content-Item).

## Leitplanken autonomer Modus (User-Entscheidung: Vorschlagswerte ok)

1. Erstpost-Sperre: erste **5** Posts je Kanal brauchen Freigabe; erst nach 5
   Freigaben ohne Korrektur wird `autonomous` wirksam.
2. Mengen-Limit: max **3** Posts/Tag je Kanal (konfigurierbar).
3. Themen-/Wort-Blacklist je Kanal → Treffer geht in Freigabe-Queue statt live.
4. Stopp-Schalter: „Social-Stopp" (Chat) + Not-Aus (UI) pausiert alle Kanäle.
5. Kosten-Budget für Medien-Generierung pro Projekt/Monat.
6. Jede Post-ID wird gespeichert → löschen/depublizieren auf Zuruf.
7. Transparenz: jeder autonome Post läuft still über den Notification-Router
   (lückenlos in der Insights-UI sichtbar).

---

## v933 — Fundament

1. **Tabellen** (SQLite v113 / PG v117):
   - `social_channels`: id, user_id, project_id NULL, platform, name, handle,
     mode ('suggest'|'approve'|'autonomous', Default suggest), publish_mode
     ('api'|'prepare'), planning_horizon_days (Default 14), posting_slots JSON,
     persona TEXT, blacklist JSON, max_posts_per_day (Default 3),
     approved_streak INT (Erstpost-Sperre-Zähler), status
     ('active'|'paused'|'archived'), config JSON (provider-spezifisch:
     chat_id, base_url, env_stage …), created_at, updated_at.
   - `content_items`: id, channel_id, user_id, status ('idea'|'draft'|
     'scheduled'|'approved'|'publishing'|'published'|'failed'|'rejected'),
     title, body, media JSON ([{type,source,pathOrUrl}]), hashtags JSON,
     scheduled_at, published_at, external_id, external_url, error,
     performance JSON, source ('manual'|'studio'|'detector'), created_at,
     updated_at.
   - `channel_metrics`: id, channel_id, item_id NULL, date, kind, value REAL,
     meta JSON, created_at. Unique (channel_id, item_id, date, kind).
2. **SocialRepository** (@alfred/storage): Channel-CRUD, Item-CRUD mit
   erlaubten Status-Übergängen (Pipeline), Items-per-Status/Kanal,
   Tages-Zählung published je Kanal (für Limit), Metrics insert/list.
3. **Provider-Architektur** (packages/skills/src/built-in/social/, Muster
   marketplace/): `SocialProvider` abstract — platform, capabilities()
   {text,image,video,maxLength}, publish(item, channel, secrets) →
   {externalId, url}, validateAuth(channel, secrets), optional
   fetchMetrics(...). Provider v933: **rest** (generic: config.base_url +
   config.publish_path + Template-Body; Bearer aus Secrets) und
   **telegram_channel** (Bot-API sendMessage/sendPhoto an config.chat_id;
   Token aus Secrets ODER globalem telegram.token).
4. **social-Skill:** create_channel, list_channels, update_channel,
   set_status, add_content (draft), list_content, schedule_content,
   approve_content, reject_content, publish_now (api-Modus → Provider;
   prepare-Modus → fertige Aufbereitung als Antwort + Item auf approved),
   mark_published (User bestätigt manuellen Post, external_url optional),
   delete_remote (löscht via Provider wenn unterstützt).
5. **Secrets:** Kanal referenziert project_environments über
   config.env_stage (Default 'social'); alfred.ts injiziert
   resolveSecrets(projectId, stage) (envCryptoRef-Muster alfred.ts:2919).
   Ohne Projekt: Secrets in config.secret_env_keys gegen das Owner-„Projekt"
   oder direkte config-Werte (nur für unkritische wie chat_id).
6. **Tests:** Repo (Stub-Adapter + sqlite skipIf), Pipeline-Übergänge,
   Provider mit gemocktem fetch, Skill-Aktionen.

## v934 — Publishing-Flow + Leitplanken

1. **PublishingEngine** (core, Timer 5-Min-Raster, HA-Slot je Stunde):
   fällige approved-Items (scheduled_at erreicht) publishen; approve-Modus:
   scheduled-Items zur Freigabe ausspielen (ConfirmationQueue mit
   Telegram-Buttons `content:<id>:approve|reject|snooze` — Quick-Action-Muster
   v924) UND als Insight (category 'social-approval', actionLabel
   „Freigeben"); autonomous: Leitplanken-Checks in CODE (Erstpost-Sperre,
   Tages-Limit, Blacklist-Scan) → bestanden = publish + stiller
   Router-Eintrag, sonst → Freigabe-Queue.
2. **Kalender-API:** GET /api/social/calendar?from&to (Items je Slot),
   Standard-CRUD-Routen für Channels/Items.
3. **Stopp-Schalter:** social-Skill action pause_all/resume_all; Chat-Phrase
   in Skill-Beschreibung verankert.
4. Retry-Politik: publish-Fehler → status failed + Insight; 1 Auto-Retry nach
   15 min.

## v935 — Content-Studio

1. **Ideen-Generator** (core, täglich im Planungsfenster; nutzt
   Interessen-Radar-Dossiers des Projekts, channel_metrics-Bestperformer,
   web_search-Trends, KG): erzeugt idea-Items mit Begründung (warum-Feld wie
   Score v1) bis der Planungshorizont je Kanal gefüllt ist.
2. **Draft-Erstellung:** Text in Kanal-Persona (LLM), Bild via image_generate
   (Budget-Zähler), Hashtags, bester Slot.
3. **YouTube-Planungsflow:** Vorschlag = Video-Konzept mit Termin + komplettem
   Script (Hook, Kapitel), Titel/Beschreibung/Tags, Thumbnail-Entwurf.
   User-Video-Übergabe: Datei per Telegram (Asset-Bridge) oder UI →
   attach_media ans Item.
4. Automatische Themen-Anlage: je Kanal ein Interessen-Topic (origin=auto)
   mit Nischen-Keywords, damit der Collector Futter sammelt.

## v936 — Plattform-Provider + Lern-Loop

1. **YouTube-Provider:** OAuth2 (Refresh-Token in ENV-Stage), resumable
   Upload, Thumbnail setzen, Analytics (Views/Watchtime/Subs je Video).
2. **Meta-Provider:** IG-Container-Flow + FB-Pages + Threads über eine
   Graph-App; solange App-Review offen → prepare-Modus derselben Items.
3. **X-Provider** (Free-Tier, 500/Monat, Zähler).
4. **Analytics-Collector** (täglich, HA-Slot): Metriken je Kanal/Item →
   channel_metrics; **Lern-Loop:** Bestperformer-Analyse fließt als
   Gewichtung in den Ideen-Generator; wöchentlicher Nischen-Report als
   stiller Router-Eintrag.

## v937 — UI + Autonomie scharf

1. **Social-Seite** (Sidebar): Kanal-Karten (Plattform, Modus, Limits,
   Auth-Status), Content-Kalender (Wochenansicht, Drag zum Umplanen),
   Freigabe-Queue (Vorschau wie im Ziel-Look, Freigeben/Ablehnen/Bearbeiten),
   Performance-Charts, Not-Aus.
2. Autonomer Modus end-to-end mit Erstpost-Sperre-Logik + Router-Transparenz.

## v938 — Video-Pipeline

1. **Stufe 1:** ffmpeg-Renderer (Bilder + TTS-Voiceover + Untertitel →
   Shorts/Reels MP4, 9:16 und 16:9 Templates), läuft auf dem Node.
2. **User-Videos:** Upload-Flow fertigstellen (Transcode-Check via ffprobe).
3. **Externer Provider:** VideoGenProvider-Interface (Runway/Kling/Veo),
   per Config aktivierbar, Kosten-Budget-Zähler je Projekt.

---

## Konventionen je Stufe

Version-Bump + CHANGELOG + README-Badge + `pnpm build` + `pnpm test` +
`node scripts/bundle.mjs` + Commit (deutsch, keine AI-Attribution) + Push
gitlab & github. Deploy macht der User.

## Wichtige Bestandsfakten (für die Umsetzung)

- Provider-Muster: packages/skills/src/built-in/marketplace/ (abstract class
  + Implementierungen + index); calendar/ ebenso.
- ENV-Verschlüsselung: EnvironmentRepository.get(projectId, stage) →
  varsEncrypted/iv/authTag; Entschlüsselung via envCryptoRef
  (alfred.ts:2919-Muster). security.envEncryptionKey MUSS base64-32 sein.
- Telegram-Buttons: options.replyMarkup.inlineKeyboard; callback_query kommt
  als Message-Text zurück (telegram.ts:147); QuickActionHandler
  (core/quick-actions.ts) matcht `<prefix>:<id>:<aktion>` VOR dem LLM.
- Insights mit Aktion: sourceData.actionLabel + inputFields (v928),
  upsertCandidate unter ownerMasterUserId; act-Endpoint nimmt {params}.
- Interessen-Radar: InterestsRepository (topics/sources/items/digests),
  TopicCollector stündlich, topic_briefing liefert Dossier.
- image_generate (gpt-image-1/gemini), tts, browser (Playwright), http,
  web_search, feed-reader vorhanden. youtube-Skill NUR lesend.
- Asset-Bridge: Telegram-Uploads landen als Dateien (code-agent/asset-bridge).
- HA-Slots: reasoning_slots INSERT ON CONFLICT (claimDailySlot-Helper in
  alfred.ts, v930).
- Scheduler-Muster: setInterval + Zeitfenster-Check + Tages-Slot (v930
  interestsDailyTimer).
- Letzte Migrationen: SQLite v112 / PG v116 (v929) → v933 nutzt v113/v117.
