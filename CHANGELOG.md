# Changelog

Alle relevanten Änderungen an Alfred werden in dieser Datei dokumentiert.
Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [Unreleased]

## [0.16.1] - 2026-03-15

### Fixed
- **Web Chat UI: Dashboard scrollbar** — `main` Container nutzt `overflow-y-auto` statt `overflow-hidden`. Dashboard und Settings sind jetzt scrollbar

## [0.16.0] - 2026-03-15

### Fixed
- **Web Chat SSE Streaming** — `writeHead()` in der SSE-Response überschrieb CORS/Security Headers die vorher per `setHeader()` gesetzt wurden. CORS Headers werden jetzt direkt im `writeHead()` gesetzt + `flushHeaders()` damit der Browser die SSE-Verbindung sofort öffnet

## [0.15.9] - 2026-03-15

### Fixed
- **Web Chat UI: Content-Length Bug** — `stat.size` wurde auf dem Directory gemacht statt auf der aufgelösten `index.html`. Browser brach Response nach falscher Content-Length ab → weiße Seite. stat() wird jetzt erst nach Directory→index.html Auflösung aufgerufen

## [0.15.8] - 2026-03-15

### Fixed
- **Web Chat UI: Navigation** — Sidebar nutzt native `<a>` Tags mit absoluten Pfaden (`/alfred/chat/`) statt Next.js `<Link>` (Client-Side-Navigation verursachte weiße Seiten bei Static Export)

## [0.15.7] - 2026-03-15

### Fixed
- **Web Chat UI: API-URL Default** — Leerer Default statt `http://localhost:3420` — fetch nutzt relative Pfade (same origin), funktioniert lokal und remote ohne manuelle Konfiguration

## [0.15.6] - 2026-03-15

### Fixed
- **Web Chat UI: Navigation Links** — Next.js `basePath` prefixed Links automatisch, Sidebar-Links nutzen jetzt relative Pfade (`/chat` statt `/alfred/chat`). Verhindert doppelten `/alfred/alfred/` Prefix
- **npm publish: Web-UI Dateien inkludiert** — `.npmignore` im CLI-Package erstellt, damit `.gitignore` nicht die `bundle/web-ui/` Dateien beim Publish ausschließt

## [0.15.5] - 2026-03-15

### Fixed
- **Web Chat UI: basePath entfernt** — Next.js `basePath: '/alfred'` verursachte doppelten Prefix (`/alfred/alfred/chat`). Entfernt — Alfred's HTTP-Adapter handled den `/alfred/` Prefix serverseitig. Sidebar-Links korrigiert

## [0.15.4] - 2026-03-15

### Fixed
- **Web Chat UI: Root-Page zeigt Chat direkt** — `/alfred/` rendert die Chat-Seite statt eines Client-Side-Redirects der im Static Export als 404 erschien

## [0.15.3] - 2026-03-15

### Fixed
- **Web UI Path Resolution: ESM-Kompatibilität** — `resolveWebUiPath()` nutzt `import.meta.url` statt `__dirname` (existiert nicht in ESM Bundles). Verhindert `ReferenceError: __dirname is not defined` beim Start

## [0.15.2] - 2026-03-15

### Fixed
- **Project Agent: Runner-Anbindung** — Runner wird jetzt direkt vom Skill gestartet (fire-and-forget async). Vorher: Dead Code, BackgroundTaskRunner konnte den Runner nie aufrufen
- **Project Agent: Shell-Injection** — Git-Commits nutzen `execFile` Array-Form statt Shell-String (verhindert Injection via LLM-generierter Phase-Beschreibung)
- **Project Agent: Event-Loop-Blocking** — Git-Operationen nutzen async `execFile` statt blockierendem `execSync`
- **Project Agent: Build-Output** — Zeigt stderr UND stdout (vorher: nur eines von beiden)
- **Project Agent: Build-Status** — `lastBuildPassed` wird erst nach tatsächlichem Build gesetzt (vorher: false positive vor Validierung)
- **Project Agent: Milestones** — `addMilestone()` wird bei Plan-Erstellung und nach jeder Phase aufgerufen (vorher: nie aufgerufen, DB immer leer)
- **Project Agent: Stop-Signal** — AbortController als Backup für in-memory Interjection-Inbox
- **Project Agent: Exports** — `pushInterjection`, `registerAbortController`, `removeAbortController` im Top-Level Export
- **Project Agent: Timeout** — Max-Duration wird im Runner selbst geprüft (unabhängig von BackgroundTaskRunner)

## [0.15.1] - 2026-03-15

### Added
- **Project Agent** — Autonomer Coding-Agent der Software-Projekte end-to-end erstellt und entwickelt, gesteuert via Telegram/Chat. State Machine mit Phasen: Planning → Coding → Validating → Fixing → Committing. Unbegrenzte Iterationen bis Ziel erreicht oder User stoppt. Features:
  - LLM-basierte Projekt-Planung (zerlegt Ziel in Build-Phasen)
  - Code-Agent-Ausführung (Claude Code, Codex) pro Phase
  - Automatische Build-Validierung (`npm install`, `npm run build`, `npm test`)
  - Fehler-Recovery: Build-Output wird dem Code-Agent als Fix-Kontext gegeben (max 3 Versuche)
  - User-Interjections: Anforderungen jederzeit per Chat einschleusen
  - Progress-Updates via Telegram (throttled, Milestones sofort)
  - Git-Integration: Auto-Commit nach jedem erfolgreichen Build
  - Checkpoint/Resume via PersistentAgentRunner (überlebt Prozess-Neustarts)
  - Konfigurierbar: Build-Commands, Test-Commands, Templates, Max Duration
  - Session-Tracking in DB für Status-Abfragen
  - Aktionen: `start`, `status`, `interject`, `stop`

## [0.15.0] - 2026-03-15

### Added
- **Web Chat UI** — Browser-basierte Chat-Oberfläche mit Next.js 15 und Tailwind CSS. Dark Theme, SSE-Streaming, Markdown-Rendering, Attachment-Preview. Dashboard mit aktiven Watches, Scheduled Tasks und Skill-Health-Grid. Settings-Seite für API-Verbindung. Statischer Export, integriert in Alfred (`/alfred/`) oder extern deploybar. Konfigurierbar via `api.webUi` im Setup
- **Watch Chains** — Watches können andere Watches triggern (`action_on_trigger: "trigger_watch"` + `trigger_watch_id`). Ermöglicht mehrstufige Automationen (A feuert → B evaluiert → B führt Aktion aus). Rekursiv mit Depth-Limit (max 5), jede Watch behält eigene Cooldown. Activity-Logging für Chain-Events
- **Workflow Branching** — If/Else-Logik in Workflows via `type: "condition"` Steps. Conditions referenzieren vorherige Ergebnisse (`prev.field`, `steps.0.field`). Jump-Targets: Step-Index, `"end"`, oder `null` (nächster Step). `jumpTo` auf Action-Steps für Branch-Terminierung. Cycle-Guard verhindert Endlosschleifen
- **Lern-Feedback-Loop** — Alfred merkt sich Ablehnungen und Korrekturen. Watch-Rejections werden nach Threshold (3×) zu Behavior-Feedback-Memories promoted. Korrektur-Erkennung via Muster-Scanner (deutsch/englisch). Feedback erscheint als eigene Sektion im System-Prompt. Reasoning Engine berücksichtigt Feedback-Events
- **Reasoning mit Aktionen** — Reasoning Engine kann strukturierte Aktionen vorschlagen (Skills ausführen, Reminder anlegen). Aktionen gehen durch Confirmation Queue (Human-in-the-Loop). Action-Deduplication verhindert Wiederholungen. Graceful Fallback auf Text-only bei Parse-Fehlern
- **Dashboard API** — `GET /api/dashboard` Endpoint liefert aktive Watches, Scheduled Tasks und Skill-Health-Daten als JSON

### Fixed
- **Codex CLI: Non-Interactive Modus** — Setup generiert `codex exec` statt interaktivem `codex`
- **Reasoning Engine: Weather Location** — Übergibt `action` und `location` an Weather-Skill

## [0.14.7] - 2026-03-15

### Fixed
- **Codex CLI: Non-Interactive Modus** — Setup-Wizard generiert jetzt `codex exec --dangerously-bypass-approvals-and-sandbox` statt interaktivem `codex` (braucht TTY). Code-Agent-Orchestration mit Codex funktioniert jetzt headless
- **Reasoning Engine: Weather Location** — Reasoning-Pass übergibt jetzt `action: 'current'` und `location` (aus Briefing-Config) an den Weather-Skill. Vorher: leeres Input-Objekt → `Missing required field "location"`

## [0.14.6] - 2026-03-14

### Security
- **Shell Skill: Erweiterte Blocklist** — Zusätzliche Bypass-Vektoren blockiert: alle Shell-Varianten (`zsh`, `dash`, `ksh`), Backtick-Substitution, `$()` Command-Substitution, base64-Pipes, absolute Pfade zu destruktiven Befehlen
- **SSRF: DNS-Resolution** — HTTP- und Browser-Skill lösen Hostnames vor dem Request auf und prüfen die IP gegen Private-Ranges. Verhindert DNS-Rebinding-Angriffe. IPv4-mapped IPv6 und Link-Local erkannt
- **Security Rule Engine: chatType Bypass** — Rules mit `conditions.chatType` greifen jetzt korrekt wenn der Request-Context keinen chatType hat
- **Config: Windows Pfad-Validierung** — `validateStoragePath` prüft mit `path.sep` statt nur `/`
- **Home Assistant: Jinja2 Injection** — Area-Parameter wird gegen Whitelist-Muster validiert
- **BMW Token Permissions** — Token-Datei wird mit `chmod 600` gesichert
- **Audit-Log Redaction** — Audit-Logger redaktiert Secrets wie der Haupt-Logger

### Fixed
- **Cron-Parser: Listen und Ranges** — Unterstützt `1,15`, `1-5`, `1-5/2`. Schedules wie `0 9 * * 1-5` (Mo-Fr) funktionieren korrekt
- **Cron-Parser: Deduplizierung** — Gemeinsame Utility in `@alfred/types`
- **PersistentAgentRunner: Timeout-Leak** — Timer wird nach Erfolg aufgeräumt
- **Watch-Engine: Fehlender Adapter** — Warnung statt stiller Datenverlust
- **Reminder: Cross-Platform Fallback** — Zustellung auf anderen Plattformen wenn Primär-Plattform down
- **Reminder: failCounts Cleanup** — Map wird bei `stop()` geleert
- **Google Provider: LRU-Cache** — LRU statt FIFO-Eviction für rawContentCache
- **ReasoningEngine: half_hourly Toleranz** — ±1 Minute Toleranz für Event-Loop-Delays
- **Rate-Limiter: Atomare Prüfung** — `checkAndIncrement()` verhindert Race-Conditions
- **Rate-Limiter: Dynamisches Cleanup-Window** — Nutzt tatsächliches Bucket-Window statt hardcoded 1h
- **Rule Loader: Conditions-Validierung** — Validierung bei Laden statt Runtime-Crash
- **Zod: Numerische ENV-Coercion** — `maxAgeHours` mit `z.coerce.number()`
- **DB Backup: Fehler-Logging** — Backup-Fehler als Warning statt still verschluckt
- **Skill Sandbox: Timeout-Cleanup** — Timer bei Erfolg aufgeräumt
- **Matrix Adapter: Storage-Pfad** — `~/.alfred/matrix-storage` statt CWD-relativ
- **Signal Adapter: Error-Limit** — Polling stoppt nach 50 konsekutiven Fehlern

## [0.14.5] - 2026-03-14

### Fixed
- **Reminder-Scheduler: Retry-Limit** — Maximal 5 Zustellversuche pro Reminder. Danach wird der Reminder als gefeuert markiert und nicht mehr wiederholt. Verhindert endlose Fehler-Schleifen bei unzustellbaren Erinnerungen (vorher: 6.000+ Fehler in 5 Stunden)
- **Proactive Scheduler: ChatId für Skills** — Scheduled Tasks übergeben jetzt die echte User-ChatId (`originalChatId`) an Skills. Vorher erhielten Skills die isolierte `scheduled-<id>` ChatId, was z.B. Reminder an ungültige Chats schickte
- **Calendar Watcher: Transiente Fehler als Warn** — Netzwerk-Timeouts, 502/503/504-Fehler werden als WARN statt ERROR geloggt. Reduziert Log-Noise bei normalen Netzwerk-Schwankungen
- **Watch-Engine: Alert-Fehlermeldungen** — Fehler beim Senden von Watch-Alert-Nachrichten werden jetzt geloggt (vorher: silentes `catch {}`)
- **Token-Kosten: Negative Werte verhindert** — `regularInput` kann nicht mehr negativ werden wenn `cacheReadTokens > inputTokens` (Race-Condition bei Provider-Reporting)
- **Willhaben: JSON.parse abgesichert** — `__NEXT_DATA__`-Parsing in allen drei Methoden mit try-catch geschützt. Verhindert unkontrollierte Crashes bei geändertem Page-Format
- **Condition Evaluator: Infinity-Guard** — `toNumber()` gibt `null` zurück bei `Infinity`/`-Infinity` statt den Wert als gültige Zahl zu behandeln
- **OpenAI Embeddings: Fehler-Logging** — `embed()` loggt jetzt Fehlermeldungen statt sie komplett zu verschlucken
- **Background Tasks: Timeout-Cleanup** — Timeout-Timer wird nach erfolgreicher Task-Ausführung korrekt aufgeräumt (vorher: Timer lief weiter bis Ablauf)

## [0.14.4] - 2026-03-12

### Fixed
- **Skill-Filter: Automation inkludiert alle Categories** — Watches und Schedules können jeden beliebigen Skill referenzieren (z.B. "Watch für RSS Feed" braucht `automation` + `information`). Wenn `automation` matcht, werden jetzt alle Skill-Categories dem LLM zur Verfügung gestellt
- **Skill-Filter: RSS/Feed Keywords** — `rss`, `feed`, `atom`, `news`, `nachricht`, `schlagzeil`, `headline` als Keywords für die `information`-Category hinzugefügt
- **Feed Reader: `check_all` Alias** — LLM generiert teils `check_all` statt `check` als Action. Wird jetzt als Alias akzeptiert

## [0.14.3] - 2026-03-12

### Fixed
- **Feed Reader: Links und Snippets** — Feed-Check zeigt jetzt Artikel-Links und Teaser-Text (contentSnippet/description, max 200 Zeichen) bei allen Feed-Prüfungen an. Vorher fehlten Links beim Prüfen aller Feeds und Teaser wurden komplett ignoriert

## [0.14.2] - 2026-03-12

### Fixed
- **Deploy: rss-parser als Runtime-Dependency** — `rss-parser` fehlte in den CLI-Dependencies (`packages/cli/package.json`), wodurch der Feed-Reader-Skill nach Deploy nicht funktionierte. Wird jetzt bei `npm install` automatisch mit installiert
- **Deploy: @google/genai Version** — CLI-Package auf `^1.45.0` angehoben (konsistent mit `@alfred/llm`)

## [0.14.1] - 2026-03-12

### Security
- **esbuild** 0.24.2 → 0.25.12 — Dev-Server Vulnerability behoben (GHSA-67mh-4wv8-2f99)
- **@google/genai** 1.44.0 → 1.45.0 — Neueste Version

## [0.14.0] - 2026-03-12

### Added
- **RSS/Feed Reader Skill** — Neuer Skill `feed_reader` zum Abonnieren und Überwachen von RSS/Atom-Feeds. Aktionen: `subscribe`, `unsubscribe`, `list_feeds`, `check`. Neue Einträge werden erkannt und zurückgegeben. Voll kompatibel mit Watch-Engine für automatische Feed-Alerts
- **LLM Provider Fallback** — Automatischer Wechsel auf alternative LLM-Tiers bei Provider-Ausfällen (5xx, Netzwerkfehler, Rate-Limits). Happy-Path unverändert, Fallback nur bei Fehler. Stream-Fallback nur vor erstem Chunk (kein gesplicter Output)
- **Health-Endpoint Erweiterung** — Neue Felder: `startedAt`, `watchesActive`, `schedulersActive`, `llmProviders` (Status pro Tier), `diskUsage`. Prometheus-Metriken für Watches und Scheduled Actions
- **DB-Retention/Cleanup** — Automatischer Cleanup bei Startup: Audit-Log (>90 Tage), Summaries (>180 Tage), Activity-Log (>90 Tage), Usage-Tracking (>365 Tage). Unbegrenztes DB-Wachstum verhindert
- **E-Mail Intelligence** — Neue Aktionen `summarize_inbox` (LLM-generierte Zusammenfassung ungelesener Mails) und `categorize` (Klassifizierung in urgent/action_required/fyi/newsletter). Benötigt konfiguriertes LLM, funktioniert ohne LLM weiterhin normal
- **Kalender Intelligence** — Neue Aktionen `find_free_slot` (algorithmische Lückensuche mit Working-Hours-Filter 08-18 Uhr, Wochenend-Skip) und `check_conflicts` (Konfliktprüfung mit angereichertem Display)
- **Inline Keyboards (Telegram)** — Bestätigungsanfragen nutzen jetzt Inline-Buttons `[✅ Approve] [❌ Reject]` statt Textprompts. Callback-Query-Handler für Telegram. Andere Plattformen unverändert
- **Thread/Topic Support** — `threadId` in `NormalizedMessage` und `SendMessageOptions`. Telegram: `message_thread_id` Support. Discord: Thread-Erkennung via `isThread()`
- **Inbound Webhooks** — Neue HTTP-Route `POST /api/webhook/:name` mit HMAC-SHA256 Signaturvalidierung. Webhooks können Watches sofort triggern statt auf den nächsten Poll-Zyklus zu warten. Konfiguration via YAML
- **Memory TTL** — Optionales Ablaufdatum für kurzlebige Erinnerungen (Migration v26). `saveWithTTL()` für zeitlich begrenzte Infos, `cleanupExpired()` beim Startup. Permanente Memories (Default) werden nie automatisch gelöscht
- **Proxmox Backup Server Monitoring** — Neuer Health-Check `proxmox_backup` im Monitor-Skill. Prüft PBS-API auf letztes erfolgreiches Backup und kürzliche Fehler. Separate Konfiguration mit eigener Authentifizierung
- **Setup-Wizard: PBS-Konfiguration** — Proxmox Backup Server im interaktiven Setup inkl. ENV-Variablen (`ALFRED_PBS_*`)
- **Zod-Schemas** für `marketplace`, `briefing`, `reasoning` — Config-Sektionen werden bei Validierung nicht mehr gestripped

### Fixed
- **Stream-Fallback: Kein gesplicter Output** — LLM-Stream-Fallback feuert nur vor dem ersten Chunk, nicht mid-stream
- **Memory UPSERT: TTL-Reset** — Normaler Save setzt `expires_at` auf NULL zurück, sodass alte TTL-Werte nicht fälschlich persistieren
- **Bearer-Token Timing-Safety** — HTTP-API Bearer-Token-Check nutzt jetzt `timingSafeEqual` (konsistent mit Webhook-HMAC)
- **Calendar Timezone-Konsistenz** — `checkAvailability` nutzt jetzt `parseLocalTime()` wie alle anderen Calendar-Aktionen
- **Email Attachment Path Traversal** — `path.basename()` Sanitisierung verhindert Directory Traversal bei Attachment-Dateinamen
- **Monitor Source-Attribution** — Fehlgeschlagene Health-Checks werden korrekt ihrer Quelle zugeordnet statt pauschal "proxmox"
- **ENV_MAP: verifyTls** — `ALFRED_HOMEASSISTANT_VERIFY_TLS` und `ALFRED_DOCKER_VERIFY_TLS` hinzugefügt

### Changed
- **Migration v26** — `memories` Tabelle um `expires_at` Column erweitert mit partiellem Index

## [0.13.4] - 2026-03-12

### Fixed
- **Kalender-Vorlauf: HTML-Stripping** — Kalender-Erinnerungen enthielten rohen HTML-Body aus Exchange/Microsoft-Kalendereinträgen. Description wird jetzt von HTML-Tags und Entities bereinigt bevor sie in die Benachrichtigung eingefügt wird. Wirkt für alle Calendar-Provider

## [0.13.3] - 2026-03-12

### Fixed
- **Todo-Watcher: Überfällige Todos nur 1×/Tag** — Überfällige Todo-Erinnerungen wurden stündlich wiederholt gesendet statt nur einmal. Ursache: Calendar-Cleanup löschte die Dedup-Einträge weil `event_start` das originale (vergangene) Fälligkeitsdatum enthielt. Fix: Dedup-Key enthält jetzt das aktuelle Datum und `event_start` wird auf jetzt gesetzt, sodass Cleanup den Eintrag erst nach 24h entfernt

## [0.13.2] - 2026-03-12

### Fixed
- **Skill-Filter: Konversationskontext** — Follow-up-Fragen verlieren nicht mehr den Skill-Kategorie-Kontext. Die letzten 3 User-Nachrichten aus der Konversationshistorie werden bei der Kategorie-Auswahl berücksichtigt. Behebt Problem dass z.B. nach einer BMW-Ladestatus-Frage die Anschlussfrage "km-Stand?" den BMW-Skill nicht mehr fand
- **Skill-Filter: Fahrzeug-Keywords** — `km`, `kilometer`, `kilometerstand`, `mileage`, `tachostand` als Infrastructure-Keywords hinzugefügt

## [0.13.1] - 2026-03-12

### Fixed
- **ENV-Overrides: Boolean-Koerzierung** — `"true"`/`"false"` Strings aus ENV-Variablen werden jetzt automatisch zu echten Booleans konvertiert. Behebt Problem dass `verifyTls=false` als String `"false"` statt Boolean `false` gesetzt wurde und TLS-Validierung nicht deaktiviert werden konnte
- **ENV-Overrides: verifyTls** — `ALFRED_UNIFI_VERIFY_TLS` und `ALFRED_PROXMOX_VERIFY_TLS` hinzugefügt. Ermöglicht TLS-Verifizierung für selbst-signierte Zertifikate per ENV zu deaktivieren

## [0.13.0] - 2026-03-12

### Added
- **Reasoning Engine** — Proaktives Denk-Modul das periodisch alle verfügbaren Daten (Kalender, Todos, Watches, Memories, Aktivität, Wetter, Energiepreise, Skill-Health) aggregiert und dem LLM zur cross-domain Analyse übergibt. Erkennt Zusammenhänge, Konflikte und Optimierungen und benachrichtigt den User nur bei echten, nicht-offensichtlichen Erkenntnissen
  - **3 Schedule-Modi**: `morning_noon_evening` (Standard, 3×/Tag um 7h, 12h, 18h), `hourly`, `half_hourly`
  - **Kosteneffizient**: Ein einzelner LLM-Call pro Pass (~5.500 Input-Tokens), kein Tool-Loop. ~$0.80/Monat mit Haiku bei 3×/Tag
  - **Dedup-Mechanismus**: Gleicher Insight wird innerhalb von 12h nicht wiederholt (SHA-256 Hash in `calendar_notifications`)
  - **Graceful Degradation**: Fehlende Datenquellen werden übersprungen ohne den gesamten Pass zu blockieren
  - Konfiguration via ENV: `ALFRED_REASONING_ENABLED`, `ALFRED_REASONING_SCHEDULE`, `ALFRED_REASONING_TIER`

## [0.12.5] - 2026-03-11

### Fixed
- **System-Prompt: Tool-Pflicht** — Explizite Anweisung im System-Prompt, dass das LLM keine Fakten schätzen/halluzinieren darf, die ein Tool liefern kann (Fahrzeiten, Preise, Wetter, etc.). Verhindert falsche Antworten wenn der passende Skill vorhanden ist

## [0.12.4] - 2026-03-11

### Added
- **Todo-Watcher** — Proaktive Erinnerungen für fällige Todos. Benachrichtigt 30 Minuten vor Fälligkeit und prüft stündlich auf überfällige offene Todos. Dedup über bestehende `calendar_notifications`-Tabelle, keine Migration nötig

### Fixed
- **Watch-Alerts: Nur bei Zustandswechsel** — Schwellwert-Operatoren (`lt`, `gt`, `lte`, `gte`, `eq`, `neq`, `contains`, `not_contains`) triggern jetzt nur noch beim Übergang false→true. Verhindert wiederholte Benachrichtigungen solange eine Bedingung dauerhaft erfüllt ist (z.B. Preis-Watch)
- **Watch LLM-Formatter: Sortierung** — Marketplace-Listings werden vor der LLM-Formatierung auf die angeforderte Anzahl begrenzt (aus messageTemplate extrahiert, min. 10). Verhindert falsche Sortierung bei großen Ergebnismengen

## [0.12.3] - 2026-03-11

### Fixed
- **Calculator: Code-Injection** — `new Function()`-basierte Auswertung durch sicheren Recursive-Descent-Parser ersetzt. Unterstützt Arithmetik, Klammern, `Math.*`-Funktionen und -Konstanten ohne dynamische Code-Ausführung
- **Log-Redaktion: Tiefe Pfade** — Pino-Redaktion nutzt jetzt `**`-Prefix (Deep-Matching) statt `*` (1 Ebene). Verschachtelte Keys wie `config.llm.apiKey` werden korrekt als `[REDACTED]` ausgegeben
- **Confirmation-Queue: Falsches Outcome** — Fehlgeschlagene Confirmed-Actions wurden im Audit-Trail als `approved` statt `error` geloggt
- **LLM-Router: Null-Guard** — `resolve()` crashte mit Non-Null-Assertion wenn kein Default-Tier konfiguriert war. Jetzt mit klarer Fehlermeldung und Validierung in `initialize()`
- **Abgeschnittene Tool-Calls** — Wenn das LLM `max_tokens` mit Tool-Calls zurückgab, wurden potenziell unvollständige Aufrufe ausgeführt. Tool-Calls werden jetzt bei `max_tokens` verworfen und die Continuation-Logik greift
- **Telegram: Bot-Token in Logs** — Error-Objekte mit URL (enthält Bot-Token) wurden in `console.error` ausgegeben. Jetzt wird nur `err.message` geloggt
- **Shell-Blocklist erweitert** — 12 zusätzliche gefährliche Patterns: `base64|bash`, `perl -e`, `ruby -e`, `php -r`, `tee /etc/...`, `crontab`, `mount`, `strace`, `gdb`, `sudo`, `chroot`, `eval`
- **Task-Runner: Race Conditions** — Atomisches Task-Claiming via SQLite-Transactions (`claimPending()`, `claimTask()`). Verhindert doppelte Ausführung bei parallelen Runnern
- **Task cancel() bewahrt History** — `cancel()` macht jetzt `UPDATE SET status='cancelled'` statt `DELETE`. Task-History bleibt für Audit erhalten
- **Checkpoint-Fehler: Retry + Abort** — Persistente Agenten brechen jetzt bei wiederholtem Checkpoint-Fehler den Task als `failed` ab statt ohne Checkpoint weiterzulaufen
- **Condition-Evaluator: eq/neq numerisch** — `"05" eq 5` ergab `false` weil nur String-Vergleich. Jetzt wird erst numerisch verglichen, dann String-Fallback
- **ENV-Pfad-Validierung** — `ALFRED_STORAGE_PATH` wird gegen Forbidden-Verzeichnisse (`/etc`, `/bin`, `/proc`, `/sys`, `/dev`, `/boot`) geprüft
- **SecurityRule-Schema** — YAML-Security-Rules werden jetzt über den bestehenden `RuleLoader` validiert statt blind als `SecurityRule[]` gecastet

## [0.12.2] - 2026-03-11

### Fixed
- **Kalender-Events ohne Datum** — `formatEvent()` zeigte nur die Uhrzeit (z.B. "18:33-20:30") ohne Datum. Bei Abfragen über mehrere Tage/Wochen war nicht erkennbar, an welchem Tag ein Termin stattfindet. Format jetzt: "So., 22.03.2026 18:33-20:30: ..."
- **Skill-Filter: Lade-Keywords** — `ladehistorie`, `ladesession`, `ladevorgang`, `ladezyklus`, `ladekurve` matchen jetzt korrekt auf Infrastructure-Kategorie. Verhindert dass BMW/Batterie-Anfragen den Delegate-Umweg nehmen

### Added
- **Watch-Alerts: LLM-Formatierung** — Wenn ein Watch eine `messageTemplate` hat, werden die Rohdaten vom LLM (fast tier) intelligent formatiert statt vom statischen Formatter. Das LLM filtert irrelevante Ergebnisse (z.B. Zubehör bei GPU-Suche) und respektiert die Anweisung im Template (z.B. "5 günstigsten"). Fallback auf statischen Formatter wenn kein LLM verfügbar

## [0.12.1] - 2026-03-11

### Fixed
- **Watch-Alert Formatter dynamisch** — Anzahl der angezeigten Listings im Watch-Alert ist nicht mehr auf 3 hardcoded. Der Formatter zeigt alle vom Skill zurückgegebenen Ergebnisse — die Anzahl wird über die Skill-Parameter gesteuert (z.B. `limit` im Marketplace-Skill)

## [0.12.0] - 2026-03-11

### Added
- **Fehler-Lernen / Self-Healing (Phase 6)** — Skills die wiederholt fehlschlagen werden automatisch temporär deaktiviert (5 Fehler → 30min, 10 → 2h, 20 → 24h). Neue `skill_health`-Tabelle (Migration v23), `SkillHealthTracker` prüft und re-enabled automatisch. Integriert in Pipeline, Watch-Engine und Background-Task-Runner
- **Template-Variablen (Phase 5a)** — `{{result.field}}` Auflösung in Watch-Action-Parametern und Message-Templates. Dot-Path-Traversal für verschachtelte Objekte, Arrays und `.length`
- **Workflow-Chains (Phase 5b)** — Mehrstufige Skill-Pipelines mit `{{prev.field}}`/`{{steps.N.field}}` Template-Passing. Sequentielle Ausführung mit Fehlerbehandlung (stop/skip/retry). Neue `workflow_chains`/`workflow_executions`-Tabellen (Migration v24), `WorkflowRunner`, `WorkflowSkill`
- **Persistente Agenten (Phase 7)** — Checkpoint/Resume für langlebige Background-Tasks. Conversation-History + DataStore werden alle 5 Iterationen in SQLite gespeichert. Bei Prozess-Neustart automatische Recovery ab letztem Checkpoint. Kooperativer Pause/Cancel-Mechanismus via AbortController. Neue Spalten in `background_tasks` (Migration v25)
- **Skill-Filter: Deutsche Keywords** — Ergänzt um `notiz`, `erinner`, `kalender`, `bild`, `generier`, `foto`, `script`, `skript`, `befehl`, `kommando`, `herunterlad`, `anhang`, `netzwerk` u.a. für zuverlässigere Kategorie-Erkennung. `files`-Kategorie im Fallback ergänzt

## [0.11.5] - 2026-03-10

### Fixed
- **max_tokens-Continuation bei leerem Content** — GPT-5.4 liefert bei Output-Limit manchmal `content: null` statt den abgeschnittenen Text. Continuation greift jetzt auch bei leerem Content und fordert das LLM auf, kürzer zu antworten statt stumm `(no response)` zu liefern

## [0.11.4] - 2026-03-10

### Fixed
- **Tool-Result-Truncation** — Große Skill-Ergebnisse (z.B. HA Entity-Listen mit 500+ Einträgen) werden intelligent gekürzt bevor sie ans LLM gehen. Anfang und Ende bleiben erhalten, Mitte wird mit Hinweis auf ausgelassene Zeilen ersetzt. Verhindert dass das LLM an Output-Limits scheitert
- **max_tokens-Continuation** — Wenn das LLM das Output-Limit erreicht, startet die Pipeline automatisch Fortsetzungs-Runden (max 3) statt die Antwort abzuschneiden oder stumm zu verschlucken. Lange Antworten kommen vollständig beim User an

## [0.11.3] - 2026-03-10

### Fixed
- **HA History/Logbook — fehlender `end_time` Parameter** — Home Assistant API `/api/history/period/{start}` und `/api/logbook/{start}` lieferten ohne `end_time` nur ~24h Daten statt des angeforderten Zeitraums. Behoben durch explizites `end_time=now` in beiden Aufrufen

## [0.11.2] - 2026-03-10

### Added
- **Activity Log** — Vollständiger Audit-Trail für alle autonomen Aktionen. Neue `activity_log`-Tabelle erfasst Skill-Ausführungen, Watch-Trigger, Watch-Actions, Bestätigungs-Entscheidungen, Scheduled Tasks, Background Tasks und Kalender-Benachrichtigungen mit Zeitstempel, Dauer, Outcome und Details
- **CLI: `alfred logs --activity`** — Activity-Log abfragen mit Filtern (`--type`, `--source`, `--outcome`, `--since`) und Statistik-Ansicht (`--stats`)

## [0.11.1] - 2026-03-10

### Fixed
- **Delegate-Übernutzung** — LLM ruft einfache Skill-Abfragen (z.B. "Zeig Ladevorgänge") jetzt direkt auf statt unnötig an Sub-Agenten zu delegieren. Prompt-Guidance und Delegate-Beschreibung präzisiert: Delegation nur bei iterativer Arbeit mit mehreren Durchläufen

## [0.11.0] - 2026-03-10

### Added
- **Watch-Actions** — Watches können jetzt Skills ausführen wenn Bedingungen eintreten. `action_skill_name` + `action_skill_params` definieren die Aktion, `action_on_trigger` steuert ob nur Alert, nur Aktion oder beides. Beispiel: Strompreis < 15ct → Wallbox via Home Assistant einschalten
- **Composite Watch-Conditions** — AND/OR-Logik über mehrere Bedingungen pro Watch. `conditions` Array als Alternative zur Einzel-Condition. Beispiel: Strompreis < 15ct UND BMW SoC < 80%
- **Kalender-Vorlauf** — Automatische Erinnerung vor Kalender-Events. Konfigurierbar via `calendar.vorlauf.enabled` und `minutesBefore` (default 15). Ganztägige Events werden übersprungen, Dedup verhindert Doppel-Benachrichtigungen
- **Human-in-the-Loop Bestätigungen** — Watches mit `requires_confirmation: true` führen Aktionen nicht direkt aus, sondern fragen den User per Chat ("ja"/"nein"). 30 Min Timeout, Alert wird trotzdem gesendet

### Improved
- **Watch-Alert bei Action-Fehler** — Bei `alert_and_action` wird der Alert auch bei fehlgeschlagener Aktion gesendet, inkl. Fehlermeldung
- **Prompt-Guidance** — LLM-Anleitung für "Wenn X dann Y"-Muster mit Watch-Actions ergänzt

## [0.10.82] - 2026-03-10

### Fixed
- **BMW Authorize: Auto-Resume + vereinfachter Flow** — Wenn das LLM `authorize` mehrfach ohne `device_code` aufruft, wird jetzt automatisch der gespeicherte pending Device-Code gepollt statt einen neuen zu generieren. Step-1-Antwort sagt jetzt "rufe authorize erneut auf (ohne Parameter)" statt den device_code zu nennen — verhindert dass das LLM den komplexen 2-Schritt als Delegation an das starke Modell weiterleitet

## [0.10.80] - 2026-03-09

### Fixed
- **Watch-Alerts: Kontext auch bei custom messageTemplate** — Das LLM setzte bei Watch-Erstellung eigene `messageTemplate`-Texte (z.B. "DDR4 ECC RAM unter 250 € gefunden"), wodurch die Kontext-Anreicherung aus v0.10.79 nicht griff. Jetzt werden günstigste Inserate auch bei custom Templates angehängt

## [0.10.79] - 2026-03-09

### Improved
- **Watch-Alerts mit Kontext** — Alerts zeigen jetzt nicht nur den nackten Wert (z.B. "minPrice: 2700"), sondern auch die günstigsten 3 Inserate mit Titel, Preis, Ort und Link. Erkennt automatisch Marketplace-Datenstrukturen (listings, cheapest). Funktioniert generisch für alle Skills mit strukturierten Arrays

## [0.10.78] - 2026-03-09

### Changed
- **Routing: Alias-Auflösung entfernt** — `resolveAddressAlias()` und die nie konfigurierbaren Config-Felder `routing.homeAddress`/`workAddress` entfernt. Das LLM löst Aliase wie "zuhause", "Büro", "bei mir" jetzt selbst über Memory/Kontext auf und sendet immer konkrete Adressen. Verhindert den Fehler "konnte mit Alias home keine Route berechnen". Briefing-Skill unverändert (eigener `resolveAddresses()` mit Memory + Config-Fallback)

## [0.10.77] - 2026-03-09

### Fixed
- **Marketplace Detail — Scam-Analyse fehlte** — Das `display`-Feld der Detail-Aktion enthielt nur Titel, Preis und Beschreibung. Jetzt werden alle für die Seriosität-Bewertung relevanten Felder ans LLM übergeben: Verkäufer-Name, Account-Alter, Foto-Anzahl, Zustand, Veröffentlichungsdatum, alle Attribute. Skill-Description instruiert das LLM, bei jeder Detail-Abfrage automatisch eine Risikobewertung abzugeben

## [0.10.76] - 2026-03-09

### Fixed
- **Marketplace Detail-Aktion lieferte leere Daten** — Willhaben-Detailseiten nutzen eine andere JSON-Struktur als Suchergebnisse (`advertDetails` statt `advertDetail`, Titel in `description`, Beschreibung in Attribut `DESCRIPTION`, Verkäufer in `sellerProfileUserData`, Adresse in `advertAddressDetails`, Zustand in `attributeInformation`). `getDetail()` komplett auf die tatsächliche Seitenstruktur angepasst. HTML-Tags werden aus der Beschreibung entfernt

## [0.10.75] - 2026-03-09

### Fixed
- **Watch + Marketplace Bug** — WatchEngine rief den Marketplace-Skill mit leeren `skill_params` auf (`input: {}`), weil das LLM die Parameter nicht korrekt in `skill_params` verschachtelt hat. Fix: WatchSkill validiert jetzt bei `create` die `skill_params` gegen die `required`-Felder des Ziel-Skills und gibt eine klare Fehlermeldung mit den erwarteten Feldern zurück
- **Watch Skill Description** — Marketplace-Beispiel und deutlicher Hinweis ergänzt, dass `skill_params` ALLE Parameter des Ziel-Skills enthalten muss (action, query, platform etc.)

## [0.10.74] - 2026-03-09

### Added
- **MarketplaceSkill v2 — Strukturierte Rückgabe** — `search` und `compare` liefern jetzt strukturiertes JSON in `data` (für WatchEngine + LLM) und Markdown in `display` (für User-Anzeige). ~60% weniger Tokens im LLM-Kontext
- **Watch-Integration** — Marketplace-Suchen sind jetzt Watch-kompatibel: `condition_field: "count"` für neue Inserate, `"minPrice"` für Preisdrops
- **Detail-Aktion** — Neue `detail`-Aktion zeigt Einzelinserat mit Beschreibung, Fotos, Verkäufer-Info und Attributen (Willhaben)
- **Erweiterte Filter** — Neue Suchparameter: `sort` (price_asc/price_desc/date_desc), `condition` (new/used), `postcode` (PLZ-Filter) für Willhaben und eBay

## [0.10.73] - 2026-03-09

### Fixed
- **Kalender +1h Bug endgültig behoben** — Microsoft Graph API ignoriert den `Prefer: outlook.timezone="UTC"` Header bei POST/PATCH Responses und liefert Zeiten in der Event-Timezone zurück. `parseGraphDateTime()` prüft jetzt `dt.timeZone` und konvertiert Non-UTC-Zeiten korrekt via Intl.DateTimeFormat Offset-Berechnung. Damit stimmt das Feedback nach Erstellen/Aktualisieren endlich mit der tatsächlichen Kalenderzeit überein

## [0.10.72] - 2026-03-09

### Added
- **SQLite-persistentes Kosten-Tracking** — LLM-Nutzungsdaten werden jetzt in der `llm_usage`-Tabelle persistiert (Migration v17) und überleben Neustarts. Tägliche Aggregation pro Modell mit Upsert (calls, tokens, costs)
- **`/api/metrics` Prometheus-Endpoint** — Separater Endpoint im Prometheus-Textformat mit Metriken: `alfred_uptime_seconds`, `alfred_requests_total`, `alfred_llm_cost_usd_total`, `alfred_llm_calls_total{model=...}`, `alfred_llm_today_cost_usd` (aus SQLite)
- **UsageRepository** — Neues Repository für LLM-Nutzungsdaten mit `record()`, `getDaily()`, `getRange()` und `getTotal()` Methoden
- **Health Endpoint erweitert** — `todayUsage` Feld zeigt persistierte Tageskosten aus SQLite

## [0.10.71] - 2026-03-09

### Fixed
- **Kalender Zeitzonen-Bug** — Erstellen/Aktualisieren von Terminen zeigte in der Antwort die falsche Uhrzeit (+1h Offset). Ursache: Microsoft Graph API lieferte Zeiten in Kalender-Zeitzone zurück, `parseGraphDateTime()` interpretierte sie aber als UTC. Fix: `Prefer: outlook.timezone="UTC"` Header global für alle Graph-Requests gesetzt (nicht nur für listEvents)
- **Kalender formatEvent() Timezone** — Event-Formatierung nutzte den statischen Konstruktor-Timezone (immer `undefined`) statt den pro-Request aktualisierten Provider-Timezone. Jetzt wird `calendarProvider.timezone` bevorzugt
- **Kalender Input-Parsing** — LLMs senden manchmal ISO-Zeiten mit `Z`-Suffix (UTC), obwohl Lokalzeit gemeint ist. Neuer `parseLocalTime()` Helfer entfernt das `Z` und die Input-Schema-Beschreibung weist explizit darauf hin, keine Timezone-Suffixe zu senden

## [0.10.70] - 2026-03-09

### Added
- **Token Cost Tracking** — Vollständiges LLM-Kosten-Tracking mit Preistabelle für OpenAI (GPT-5.4, GPT-4.1, o3/o4), Anthropic (Opus 4.6, Sonnet 4.6, Haiku 4.5), Google (Gemini 3.x, 2.5, 2.0) und Mistral. Jeder LLM-Call loggt jetzt `model`, `costUsd`, Cache-Read/Write-Tokens
- **Cost Tracking pro Request** — "Message processed" Log enthält jetzt `model`, `costUsd` und kumulative Token-Summen. `PipelineMetrics` erweitert um `totalInputTokens`, `totalOutputTokens`, `totalCostUsd`
- **Health Endpoint mit Kosten** — `/api/health` liefert jetzt `costs` (Gesamt-Token-Verbrauch + Kosten aufgeschlüsselt nach Modell) und `metrics` (Pipeline-Statistiken)
- **Model-Feld in LLM-Response** — Alle Provider (OpenAI, Anthropic, Google, Ollama) setzen jetzt `model` in der Response, sodass Kosten korrekt zugeordnet werden können

## [0.10.69] - 2026-03-09

### Fixed
- **Startup-Crash in v0.10.68** — `better-sqlite3.backup()` gibt ein Promise zurück und wurde im synchronen Constructor ohne await aufgerufen → Unhandled Rejection beim Start. Backup nutzt jetzt `fs.copyFileSync()` nach WAL-Checkpoint
- **Übermäßige Bestätigungsanfragen** — System-Prompt überarbeitet: Kalender-Einträge, Reminder, Todos, E-Mail-Suche, Routenberechnung und andere read/write-Tool-Aktionen erfordern keine explizite Bestätigung mehr, wenn der User die Aktion klar anfordert
- **Tool-Message DB-Bloat** — Jede Tool-Loop-Iteration speicherte 2 separate Messages (leerer Content) in der DB → bei 5 Tool-Calls pro Anfrage 10 Messages statt 1 Antwort. Jetzt werden alle Tool-Interaktionen konsolidiert als ein einzelnes Paar gespeichert
- **Kontextverlust bei Zusammenfassung** — `HISTORY_WITH_SUMMARY` von 6 auf 10 erhöht, damit nach Summary genug Messages für Tool-Paare + echte Konversation bleiben

### Added
- **Routing Adress-Aliase** — `routing` Skill löst "home"/"zuhause"/"work"/"büro" automatisch auf konfigurierte Adressen auf (`routing.homeAddress`/`routing.workAddress` in config.yaml)
- **Memory-Nutzung im System-Prompt** — LLM wird explizit angewiesen, gespeicherte Fakten (Adresse, Präferenzen) proaktiv zu nutzen statt nachzufragen

## [0.10.68] - 2026-03-09

### Added
- **HTTP API Authentication** — Optionaler Bearer-Token-Auth via `api.token` in config.yaml. Ohne Token bleibt die API offen (Rückwärtskompatibilität für localhost-only Setups), mit Token erfordert jeder Request `Authorization: Bearer <token>`
- **HTTP API Security Headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, konfigurierbare CORS-Origin (`api.corsOrigin`), Request Size Limit (1 MB)
- **Health Check erweitert** — `/api/health` liefert jetzt DB-Status, Uptime, Adapter-Status und Timestamp; gibt HTTP 503 bei degradiertem Status zurück
- **Pipeline Metrics** — In-Memory-Counters für requestsTotal/Success/Failed/avgDurationMs/lastRequestAt, abrufbar via `pipeline.getMetrics()`
- **Secret Redaction im Logger** — Pino Redaction für apiKey, token, password, secret, accessToken, refreshToken, clientSecret, Authorization — Secrets erscheinen als `[REDACTED]` in Logs
- **Auto-Backup bei Startup** — SQLite-DB wird automatisch vor dem Start gesichert (1x pro Tag, nur wenn > 100 KB). Backups landen in `data/backups/`, manuelles Backup-Script unter `scripts/backup.sh` mit 7-Tage-Retention
- **Graceful Shutdown Timeout** — 15s Timeout für `alfred.stop()`, Adapter-Disconnect mit je 5s Timeout, WAL Checkpoint vor DB-Close
- **Docker Support** — Dockerfile + docker-compose.yml mit Health Check, Volume-Mount und Production-Defaults
- **Tests** — 4 neue Test-Suites: ConversationSummarizer (6 Tests), SummaryRepository (4 Tests), ProactiveScheduler (4 Tests), WatchEngine (5 Tests)

### Fixed
- **Watch Engine Context-Bug** — `buildSkillContext` wurde ohne User-ID aufgerufen und crashte bei jedem Watch-Check. Jetzt wird `platformUserId` korrekt übergeben
- **Memory Leak** — `extractionTimestamps` Map in ActiveLearningService wuchs unbegrenzt — leere Arrays für inaktive User werden jetzt gelöscht

### Changed
- **Shell Skill Blocklist** — 4 neue Patterns: `bash -c`/`sh -c`, `dd of=/dev/`, `chmod 777 /`, `chown /`

## [0.10.67] - 2026-03-08

### Added
- **Running Summary — Arbeitsgedächtnis für lange Konversationen** — Ab 6 Nachrichten wird automatisch eine strukturierte Zusammenfassung des Gesprächsverlaufs erstellt und alle 3 Nachrichten aktualisiert (Ziel/Thema/Fakten/Entscheidungen/Offen). Die Summary ersetzt alte History-Messages im Prompt: statt 30 werden nur noch 6 aktuelle Messages geladen, ergänzt durch ~200 Tokens Summary. Spart ~3.500 Tokens pro Request ab Turn 7. Fire-and-forget-Update nach jedem relevanten Turn, kein Blocking der Pipeline. Neue DB-Tabelle `conversation_summaries` mit CASCADE-Delete

## [0.10.66] - 2026-03-08

### Changed
- **Tool Result Trimming — Token-Reduktion für Konversationshistorie** — Alte, große Tool-Ergebnisse (≥ 300 Zeichen) in der History werden beim LLM-Send auf eine kurze Zusammenfassung gekürzt (`[Ergebnis: <tool_name> — <erste Zeile>]`). Die letzten 3 Tool-Paare bleiben immer voll erhalten, kleine Ergebnisse (BMW-Status, Wetter, Licht) werden nie gekürzt. Spart ~2.500–3.500 Tokens pro Request bei typischer Nutzung. Volle Daten bleiben in der DB erhalten

## [0.10.65] - 2026-03-08

### Fixed
- **Briefing Display — 7 Bereinigungen für LLM-freien Output** —
  - Kalender: ID-Regex erkennt jetzt Bindestriche in Microsoft-Graph-IDs (`AAO-1WxcAAA=`)
  - Todos: Markdown-Tabellen mit UUIDs → einfache Liste (`☐ [high] Titel`)
  - Microsoft To Do: `[taskId=...]` und `[listId=...]` entfernt
  - HA Lichter: Zigbee-Hardware-IDs (`0xa4c1...`) und Netzwerk-LEDs (UniFi AP/Switch) ausgeblendet
  - HA Akkus: Nur noch `device_class: battery` statt name-basierter Regex — filtert Victron-System-Sensoren (Ströme, Spannungen, History-Zähler) korrekt raus
  - HA Leistung: Sensoren mit nicht-numerischen States (Forecast-Timestamps) werden übersprungen
  - Monitor: Battery-Check nur für echte Batterie-%-Sensoren (`device_class: battery`, `unit: %`, Wert ≥ 0) — eliminiert ~50 falsche Victron-Alerts

## [0.10.64] - 2026-03-08

### Fixed
- **Skill-Filter — Bestätigungen verloren Skill-Kontext** — "ok"/"ja" nach einem Scheduled-Task-Plan führte dazu, dass das LLM den `scheduled_task`-Skill nicht mehr hatte (Fallback enthielt `automation` nicht). LLM wich auf `reminder` aus oder gab auf. Fix: `automation` in die Fallback-Common-Categories aufgenommen
- **Skill-Filter — BMW/Auto-Keywords fehlten** — "Wie ist der Ladestand meines Autos?" erreichte den BMW-Skill nicht, weil `auto`, `ladestand`, `fahrzeug`, `bmw`, `reichweite`, `soc` etc. in der Infrastructure-Regex fehlten. LLM halluzinierte stattdessen Daten aus der History. Fix: Keywords ergänzt
- **ProactiveScheduler — skillName vor promptTemplate priorisiert** — Tasks mit beiden Feldern (z.B. alter Morgenbriefing-Task) liefen weiterhin durch die LLM-Pipeline statt den kostenlosen direkten Skill-Pfad zu nutzen. Fix: `skillName`-Check wird vor `promptTemplate` geprüft

## [0.10.63] - 2026-03-08

### Fixed
- **Briefing Display — interne IDs und technische Details entfernt** — E-Mail- und Kalender-Module gaben im Briefing rohe interne IDs (lange Base64-Strings) und ISO-Datumsformate aus. Neuer `cleanDisplay()`-Bereiniger im Briefing-Skill: entfernt interne IDs, ersetzt `[UNREAD]`→📩 und `[ATT]`→📎, entfernt ISO-Dates und redundante Headers. Original-Skills bleiben für interaktive Nutzung unverändert

## [0.10.62] - 2026-03-08

### Changed
- **HA Briefing Summary — kompakter Smart-Home-Überblick** — Energy-Sensoren (kumulativ, kWh) werden nicht mehr im Briefing angezeigt (dafür gibt es `energy_stats`). Battery/SoC-Sensoren auf max. 5 begrenzt, sortiert nach niedrigstem Stand. Power-Sensoren auf max. 5 begrenzt, sortiert nach höchstem Absolutwert. Kompaktes Einzeiler-Format: `🔋 Akkus: Victron: 85% | Handy: 42%` und `⚡ Leistung: PV: 3.2 kW | Verbrauch: 1.1 kW` statt einer Zeile pro Sensor

## [0.10.61] - 2026-03-08

### Changed
- **Briefing LLM-frei als Scheduled Task** — Geplante Briefings werden jetzt direkt als Skill ausgeführt ohne LLM-Overhead ($0.00 statt ~$0.016 pro Ausführung). Der ProactiveScheduler wendet den ResponseFormatter auch auf den direkten Skill-Execution-Pfad an (korrekter `parseMode` für Telegram). System-Prompt enthält Guidance für `skill_name: "briefing"` statt `prompt_template`
- **Briefing Display-Verbesserung** — Verbesserter Briefing-Output: Emoji-Header, `**label**` statt `### label`, regelbasierte Actionable Highlights am Ende (BMW-Akku niedrig, Infrastruktur-Warnungen, günstige Strompreise, Kalender-Termine). Kein LLM nötig für ansprechende Darstellung
- **Token-Reduktion für interaktive Nachrichten** — Skill-Filter Fallback reduziert: bei generischen Nachrichten werden nur noch `productivity`, `information`, `media` statt aller 45+ Tools mitgeschickt (~3.000–4.000 Tokens gespart). Default History-Limit von 100 auf 30 Nachrichten reduziert. Geschätzte Einsparung: ~50% weniger Input-Tokens pro Nachricht

## [0.10.60] - 2026-03-08

### Fixed
- **Briefing Wetter-Location — Memory-Adresse hat jetzt Vorrang** — Das LLM (Haiku) übergab bei Scheduled Tasks `location: "Vienna"` an den Briefing-Skill, was die korrekte Heim-Adresse aus den Memories überschrieb. Location-Priorität geändert: aufgelöste Heim-Adresse → Config → LLM-Input → Fallback „Vienna"

## [0.10.59] - 2026-03-08

### Fixed
- **Scheduled Tasks — HTML-Tags als Rohtext auf Telegram** — Der ProactiveScheduler hat den `parseMode` vom ResponseFormatter ignoriert und Nachrichten ohne `parse_mode` an Telegram gesendet. Dadurch wurden `<b>`, `<i>` etc. als sichtbarer Text angezeigt statt als Formatierung gerendert. Fix: `parseMode` wird jetzt vom Formatter bis zum `adapter.sendMessage()` durchgereicht

## [0.10.58] - 2026-03-08

### Fixed
- **Briefing Wetter-Location — Scheduled Task User-Auflösung** — Geplante Aufgaben (Briefing) zeigten „Wien" statt „Altlengbach" als Wetter-Standort. Ursache: Der ProactiveScheduler übergab die interne User-UUID als `userId` an die Pipeline, die diese als Platform-User-ID interpretierte. Dadurch wurden keine verknüpften User-IDs aufgelöst und Erinnerungen (Heim-Adresse) nicht gefunden → Fallback auf „Vienna". Fix: User wird vor der synthetischen Nachricht via `findById()` aufgelöst und die tatsächliche Platform-User-ID verwendet

## [0.10.57] - 2026-03-08

### Fixed
- **Response-Formatter — Verschachtelte HTML-Tags** — LLMs (Haiku) erzeugen verschachtelte Bold-Tags wie `<b>📅 <b>Kalender</b></b>` die auf Telegram kaputt rendern. Neuer Ansatz: Markdown→HTML Konvertierung, dann `flattenNestedTag()` entfernt redundante verschachtelte Tags gleichen Typs. Kein fragiler HTML→MD→HTML Roundtrip mehr. Auch `<strong>`→`<b>`, `<em>`→`<i>` Normalisierung und Stripping nicht-unterstützter HTML-Tags

## [0.10.56] - 2026-03-08

### Added
- **Home Assistant — Energieverbrauch-Statistiken** — Neue Action `energy_stats` im HA-Skill: Auto-Discovery aller Energie-Sensoren (`state_class: total_increasing`, `device_class: energy`), Verbrauchsberechnung über History-API (Differenz erster/letzter Wert), Einheiten-Normalisierung (Wh/MWh → kWh), freundliche Zeiträume (`today`/`heute`, `yesterday`/`gestern`, `this_week`, `last_week`, `this_month`, `last_month`). Fallback auf aktuelle Zählerstände wenn History-Retention überschritten
- **Skill-Filter — Energy-Keywords für Infrastructure** — Begriffe wie `solar`, `photovoltaik`, `stromverbrauch`, `energieverbrauch`, `einspeisung`, `wallbox` aktivieren jetzt die Infrastructure-Kategorie, damit der HA-Skill bei Energiefragen sichtbar wird

## [0.10.55] - 2026-03-08

### Fixed
- **Response-Formatter — Markdown/HTML-Mix Rendering** — LLMs (insbesondere Haiku) mischen Markdown (`##`, `**`) mit HTML-Tags (`<b>`, `<code>`). Der Formatter normalisiert jetzt zuerst HTML-Tags zurück zu Markdown und konvertiert dann einheitlich ins Zielformat. Zusätzlich: `## Headers` → `<b>` für Telegram/Matrix, `---` Trennlinien entfernt, überschüssige Leerzeilen kollabiert
- **Scheduled Tasks — Markdown-Format-Hinweis** — Synthetische Messages an das LLM enthalten jetzt einen Format-Hinweis der reines Markdown verlangt (kein HTML-Mix)

## [0.10.54] - 2026-03-08

### Fixed
- **Skill-Filter — Word-Boundary-Bug bei „in X Minuten"** — Die Regex `in\s+\d+\s*min` scheiterte am `\b` (Word-Boundary) weil „min" mitten im Wort „Minuten" steht. Alternation auf vollständige Wortformen geändert (`minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min`)

## [0.10.53] - 2026-03-08

### Fixed
- **Skill-Filter — „in X Minuten" aktiviert jetzt Automation-Kategorie** — Zeitangaben wie „in 2 Minuten" matchten keines der Automation-Keywords, dadurch wurde `scheduled_task` rausgefiltert und das LLM konnte nur `reminder` anbieten. Neues Pattern `in\s+\d+\s*(min|stund|...)` ergänzt
- **Prompt — scheduled_task vs. reminder Abgrenzung** — Klare Anweisung im System-Prompt: „Task ausführen zu Zeitpunkt X" → `scheduled_task` mit `prompt_template`, nicht `reminder`. Reminder sind nur für einfache Texterinnerungen

## [0.10.52] - 2026-03-08

### Changed
- **Token-Kostenoptimierung für Scheduled Tasks** — Synthetische Messages vom ProactiveScheduler setzen `skipHistory: true` (spart ~2.000-5.000 Tokens History-Loading) und `tier: 'fast'` (nutzt Fast-Tier statt Default für reine Formatierungsaufgaben). Briefing-Kosten sinken von ~$0,33 auf ~$0,02-0,05 pro Aufruf
- **Anthropic Prompt Caching** — System-Prompt und Tool-Definitionen werden mit `cache_control: { type: 'ephemeral' }` markiert. Im agentic Tool-Loop (mehrere LLM-Calls pro Pipeline-Run) sind diese bei jeder Iteration identisch → 90% Rabatt auf gecachte Tokens. Cache-Metriken (`cacheCreationTokens`, `cacheReadTokens`) werden in `LLMUsage` getrackt
- **OpenAI Prefix-Optimierung** — Statische Prompt-Sektionen (Core Principles, Tools, User Profile) werden vor dynamische (Datum/Uhrzeit, Kalender, Memories) gestellt. Maximiert den stabilen Prefix für OpenAIs automatisches Caching (50% Rabatt)

## [0.10.51] - 2026-03-08

### Fixed
- **Kalender — Zeitzonen-Fix korrigiert** — Der v0.10.48 Fix hatte einen Logikfehler (Offset wurde subtrahiert statt korrekt behandelt). Neuer Ansatz: `Prefer: outlook.timezone="UTC"` Header an Microsoft Graph senden, so liefert die API garantiert UTC-Zeiten. `dateTime` wird mit `Z`-Suffix geparst und korrekt in lokale Zeit konvertiert

## [0.10.50] - 2026-03-08

### Fixed
- **Briefing — Kalender zeigte Events der nächsten 7 Tage** — `list_events` wurde ohne Start/End aufgerufen, der Default war „ab jetzt + 7 Tage". Dadurch erschienen zukünftige Termine (z.B. vom 13. März) fälschlich im heutigen Briefing. Briefing schränkt jetzt explizit auf den heutigen Tag ein

## [0.10.49] - 2026-03-08

### Added
- **Strompreis — Briefing-Übersicht** — Neue Action `briefing` im Energy-Skill: zeigt aktuellen Preis, Tagesdurchschnitt, Min/Max, die 3 günstigsten und 3 teuersten verbleibenden Stunden. Morgenbriefing nutzt jetzt diese kompakte Übersicht statt nur die aktuelle Stunde

## [0.10.48] - 2026-03-08

### Fixed
- **Kalender — Zeitzonen-Verschiebung bei Microsoft Graph** — Microsoft Graph API liefert `dateTime` ohne Offset (z.B. `"18:00:00"`), `new Date()` interpretierte das als UTC statt Lokalzeit. Termine wurden dadurch um 1 Stunde verschoben angezeigt (18:00 → 17:00 in CET). Neues `parseGraphDateTime()` berücksichtigt die Provider-Timezone korrekt

## [0.10.47] - 2026-03-08

### Fixed
- **Briefing — Wetter-Location PLZ-Parsing** — `extractCity()` nahm den letzten Komma-Teil der Adresse, bei „Alleestraße 6, 3033 Altlengbach, Niederösterreich" also das Bundesland statt den Ort. Jetzt wird gezielt der Teil mit Postleitzahl gesucht und der Ortsname daraus extrahiert (3033 → „Altlengbach")

## [0.10.46] - 2026-03-08

### Fixed
- **Briefing — Wetter-Location** — Briefing nutzte die vollständige Heimadresse (z.B. „Alleestraße 6, 3033 Altlengbach") als Wetter-Ort. Open-Meteo Geocoding kann keine Straßenadressen auflösen. Jetzt wird automatisch der Ortsname extrahiert (PLZ + Stadtname → „Altlengbach")
- **Briefing — Microsoft To Do** — `list_tasks` wurde ohne `listId` aufgerufen und schlug fehl. Microsoft To Do Skill nutzt jetzt automatisch die Standard-Liste (Aufgaben/Tasks) wenn keine Liste angegeben ist

## [0.10.45] - 2026-03-08

### Fixed
- **Briefing — Scheduled Task fehlgeschlagen** — Scheduled Tasks rufen den Skill mit leerem Input `{}` auf (ohne `action`). Briefing-Skill nutzt jetzt `run` als Default-Action wenn keine angegeben ist

## [0.10.44] - 2026-03-08

### Added
- **BMW — Verbrauchsstatistik** — Neue Action `consumption` berechnet kWh/100km aus Lade-Sessions (km-Stand-Differenz × SoC-Differenz × Batteriekapazität). Perioden: `last` (letzte Fahrt), `week`, `month` (default), `year`, `all`. Zeigt Durchschnitt, Min, Max, Median und Einzelfahrten-Tabelle

## [0.10.43] - 2026-03-08

### Added
- **BMW — Lade-Sessions erweitert** — Tabelle zeigt jetzt Start-/Endzeit (Datum + Uhrzeit), Kilometerstand und Ladeort pro Session

## [0.10.41] - 2026-03-08

### Fixed
- **BMW — Lade-Sessions Datum 21.1.1970** — `startTime`/`endTime` der BMW CarData API sind Unix-Timestamps in Sekunden, nicht Millisekunden. `new Date(seconds)` ergab Januar 1970 statt dem korrekten Datum

## [0.10.40] - 2026-03-08

### Fixed
- **BMW — Token-Cache verhindert Re-Autorisierung** — `loadTokens()` cached Token-Daten im Speicher. Nach einem fehlgeschlagenen Refresh wurde der Cache zwar auf `null` gesetzt, aber ein nachfolgender `pollToken`-Aufruf las die Datei (noch ohne `codeVerifier`) und cachedte sie erneut. Wenn danach `authorize` Schritt 1 den `codeVerifier` in die Datei schrieb, las Schritt 2 weiterhin den veralteten Cache → `Kein code_verifier gefunden`. Fix: Cache-Invalidierung nach `savePartialTokens`

## [0.10.39] - 2026-03-08

### Added
- **Home Assistant — `briefing_summary` Action** — Neue kompakte HA-Übersicht speziell für das Morgenbriefing. Smart Defaults: offene Kontaktmelder, eingeschaltete Lichter, Batterie-/SoC-Sensoren, Energieverbrauch, Klima, Anwesenheit. Konfigurierbar über `briefing.homeAssistant.entities[]` / `domains[]` in YAML-Config oder via User-Memories (`briefing_ha_entities`). Statt 500+ Entities werden nur relevante Daten geliefert

### Fixed
- **Briefing — Review-Fixes** — Energy-Modul nutzt `current` statt `today` (kompakter für Briefing), Wetter-Location fällt auf Heimadresse aus Memories zurück bevor "Vienna" als Default greift, `modules`-Anzeige zeigt korrekten Status für Memory-basierte Adressen

## [0.10.37] - 2026-03-08

### Added
- **Briefing-Skill — Morgenbriefing mit paralleler Datensammlung** — Sammelt Daten aus allen verfügbaren Skills (Kalender, Wetter, Todos, E-Mail, Strompreise, BMW, Smart Home, Infrastruktur) parallel in einem einzigen Skill-Call. Das LLM synthetisiert das Ergebnis in einem Durchgang statt 8-10 sequenzielle Tool-Calls. Reduziert Latenz (~5s statt ~30s) und Token-Verbrauch (~80k statt ~500k). Module werden automatisch anhand der vorhandenen Skill-Registrierungen erkannt
- **Briefing — automatischer Pendler-Check Mo–Fr** — Wenn `ALFRED_BRIEFING_HOME_ADDRESS` und `ALFRED_BRIEFING_OFFICE_ADDRESS` konfiguriert sind, berechnet das Briefing an Werktagen automatisch die Route Heim→Büro (mit Live-Traffic) und prüft den BMW-Akkustand. Warnt bei unter 30%. Wird übersprungen wenn ein auswärtiger Termin im Kalender steht (physischer Ort, keine virtuellen Meetings)

## [0.10.36] - 2026-03-07

### Fixed
- **Todo — gekürzte IDs in Display-Ausgabe** — `list` zeigte nur die ersten 8 Zeichen der UUID in der Tabelle. GPT-5.4 las die Display-Ausgabe statt der `data`-Property und verwendete die gekürzte ID für Folgeaktionen (complete, delete) → `not found`. Volle UUID wird jetzt angezeigt

## [0.10.35] - 2026-03-07

### Fixed
- **Skill-Filter — deutsche Flexionsformen für Zeitintervalle** — `täglich`, `stündlich`, `wöchentlich`, `monatlich` matchten nur die Grundform, nicht flektierte Varianten wie „Tägliche", „stündlicher", „wöchentliches". Dadurch wurde die `automation`-Kategorie bei Nachrichten wie „Tägliche Strompreise aWATTar kann gelöscht werden" nicht erkannt und `scheduled_task` aus dem Tool-Set gefiltert

## [0.10.34] - 2026-03-07

### Added
- **Marketplace-Skill (willhaben.at + eBay)** — Dedizierter Skill für strukturierte Marktplatz-Suche. willhaben: parst `__NEXT_DATA__` aus HTML, liefert ALLE Inserate als Tabelle statt 5 zusammengefasste via Browser-Skill. eBay: Browse API mit OAuth Client Credentials. Actions: `search` (alle Inserate auflisten), `compare` (Preisstatistik + günstigste 5). Token-Verbrauch sinkt von ~59k auf ~2k Input-Tokens

## [0.10.33] - 2026-03-07

### Fixed
- **Microsoft To Do — fehlende IDs in Display-Ausgabe** — `list_tasks` und `list_lists` zeigten nur Titel/Status, aber keine `taskId`/`listId`. Der LLM konnte daher keine Folgeaktionen (complete, delete, update) ausführen, weil ihm die nötigen IDs fehlten. IDs werden jetzt in der Display-Ausgabe mitgeliefert

## [0.10.32] - 2026-03-07

### Fixed
- **Home Assistant Config API — POST statt PUT** — HA Config API für Automationen/Skripte/Szenen erwartet `POST`, nicht `PUT`. HTTP 405 Method Not Allowed behoben

## [0.10.31] - 2026-03-07

### Added
- **Home Assistant — Config API für Automationen, Skripte & Szenen** — 6 neue Actions: `create_automation`, `delete_automation`, `create_script`, `delete_script`, `create_scene`, `delete_scene`. Nutzt die HA Config REST API (`PUT/DELETE /api/config/{type}/config/{id}`), um Automationen, Skripte und Szenen direkt über Alfred zu erstellen, aktualisieren und zu löschen

## [0.10.30] - 2026-03-07

### Fixed
- **Code Sandbox — INPUT_DATA Schema-Beschreibung korrigiert** — Schema sagte `DATA env var or stdin`, aber die Implementierung injiziert `INPUT_DATA` als Variable. LLMs (GPT-5.4) lasen die Beschreibung und schrieben `os.environ['DATA']` oder `json.loads(DATA)` → sofortiger Crash. Beschreibung jetzt korrekt: `INPUT_DATA` direkt als Variable, bereits geparst wenn JSON

## [0.10.29] - 2026-03-07

### Fixed
- **Code Sandbox — Umgebung vollständig vererbt** — Sandbox-Prozesse erhielten eine minimale Umgebung (nur PATH, HOME, LANG), wodurch weder Python-Packages (openpyxl) noch Node-Libraries (exceljs) gefunden wurden, obwohl sie systemweit installiert waren. Jetzt wird `process.env` vollständig vererbt — identisch mit Shell-Ausführung
- **NODE_PATH — Symlink-Auflösung für globale npm-Installs** — `process.argv[1]` zeigt bei globalem npm-Install auf `.../bin/alfred` (Symlink). `realpathSync` löst den Symlink zum echten Bundle-Pfad auf und findet `../node_modules/` mit exceljs/pdfkit. Funktioniert sowohl für globale npm-Installs als auch für `/tmp/`-Bundle-Deploys
- **Data-Store — strukturierte Daten statt Display-Text** — Data-Store speicherte `result.content` (Display-Text), was bei Injection in code_sandbox zu String statt Array/Object führte. Jetzt wird `JSON.stringify(result.data)` gespeichert, sodass INPUT_DATA korrekt als Objekt/Array verfügbar ist

## [0.10.28] - 2026-03-07

### Fixed
- **Delegate Datenverlust — Data-Store mit Referenz-IDs** — Sub-Agent musste bisher alle extrahierten Daten (z.B. 85 Email-Einträge, 6.4k Tokens) als Output kopieren, was zu Datenverlust und 13k verschwendeten Output-Tokens führte. Neuer Mechanismus: große Tool-Ergebnisse (>500 Zeichen) werden automatisch als `result_N` gespeichert. LLM referenziert nur die ID, Delegate injiziert die echten Daten bei Execution. Output-Tokens sinken von ~13k auf ~200
- **NODE_PATH bulletproof im Bundle-Kontext** — `require.resolve` scheitert im esbuild-Bundle (silent catch), wodurch NODE_PATH leer blieb und exceljs/pdfkit nicht gefunden wurden. Neue Fallbacks: `node_modules` relativ zu `process.argv[1]` (Bundle-Pfad) und `process.cwd()`. Bestehende NODE_PATH-Einträge werden korrekt per Delimiter aufgesplittet
- **Code-Size-Guard gegen Hardcoding** — Harter Fehler bei `action:"run"` mit >4000 Zeichen Code. Verhindert, dass der LLM extrahierte Daten in Code hardcoded (LLM-Recency-Bias). Fehlermeldung leitet zu `run_with_data` mit Data-Referenz um. Maximal 1 verlorene Iteration statt unkontrolliertem Datenverlust
- **Delegate System-Prompt verkürzt** — Langer Workflow-Block (der bei 57k Input-Tokens von Opus 4.5 ignoriert wurde) durch kurzen Prompt ersetzt. Enforcement ist jetzt strukturell statt per Guidance

## [0.10.27] - 2026-03-07

### Fixed
- **Delegate Datenverlust bei Data-to-File Workflows** — Sub-Agent hardcodete extrahierte Daten in Sandbox-Code und verlor dabei Einträge (LLM-Recency-Bias). Neuer Workflow: `extract` → `run_with_data` → `INPUT_DATA` direkt als Objekt/Array verfügbar. System-Prompt mit expliziter Data-to-File Guidance verhindert Hardcoding
- **Code Sandbox — exceljs/pdfkit nicht verfügbar** — `NODE_PATH` enthielt nur `pdf-parse`. Jetzt werden auch `exceljs` und `pdfkit` aufgelöst, die bereits als Dependencies installiert sind. Spart 2-4 verschwendete Iterationen pro Delegate-Run
- **Code Sandbox — run_with_data JSON-Injection** — JSON-Daten werden jetzt direkt als Objekt/Array injiziert statt als String-Literal. `INPUT_DATA` ist sofort als Array/Object nutzbar ohne `JSON.parse()`
- **Code Sandbox Test — riskLevel Mismatch behoben** — Test erwartete `'destructive'` statt `'write'`

## [0.10.26] - 2026-03-07

### Fixed
- **Email Extract — KQL-Datumsfilter statt $filter** — Graph API `$search` und `$filter` können bei Messages nicht kombiniert werden. Neuer Ansatz nutzt KQL `received:MM/DD/YYYY..MM/DD/YYYY` Syntax direkt in `$search`, wodurch Datum + Keywords in einem Query funktionieren. Basiert auf offizieller Microsoft Graph API Dokumentation

## [0.10.25] - 2026-03-07

### Fixed
- **Email Extract — $search/$filter Kombination behoben** — Microsoft Graph API erlaubt nicht `$search` und `$filter` gleichzeitig (400-Fehler). Neuer Ansatz: bei Datum+Keywords wird `$filter` für die Datumseingrenzung verwendet und Keywords werden client-seitig auf Subject/From/Preview gefiltert. Alle drei Kombinationen funktionieren: nur Keywords, nur Datum, beides

## [0.10.24] - 2026-03-07

### Fixed
- **Email Extract — Datumsfilter und Timeout behoben** — `extract` nutzt jetzt `$filter` mit `receivedDateTime` für korrekte Datumseingrenzung (statt ungültigem `$search`-Datumsformat). Body-Lesen erfolgt nun in parallelen 5er-Batches statt sequentiell, mit 5 Minuten Skill-Timeout. Neue Parameter `dateFrom`/`dateTo` im YYYY-MM-DD Format

## [0.10.23] - 2026-03-07

### Added
- **Email Extract-Action für Massen-Datenextraktion** — Neue `email.extract` Action durchsucht das Postfach mit Pagination (kein 50-Ergebnis-Limit mehr), liest Email-Bodies serverseitig und extrahiert Geldbeträge per Regex (€/$/EUR/USD-Muster). Gibt kompakte strukturierte Daten zurück (~50 Tokens pro Email statt ~1500), wodurch der LLM 500+ Emails verarbeiten kann ohne das Context Window zu sprengen

### Fixed
- **Email-Suche Pagination** — `email.search` folgt nun `@odata.nextLink` für Ergebnisse über 50 Treffer. Vorher wurden maximal 50 Ergebnisse zurückgegeben, unabhängig von der Anfrage
- **Delegate Sub-Agent Iterations** — Default von 5 auf 15, Maximum von 15 auf 25 erhöht. 5 Iterationen reichten nicht für mehrstufige Aufgaben (Suchen + Lesen + Verarbeiten + Datei generieren)

## [0.10.22] - 2026-03-06

### Fixed
- **Delegate Sub-Agent maxTokens erhöht** — Der Sub-Agent hatte ein Output-Limit von 2048 Tokens, was bei Code-Generierung (z.B. Excel mit exceljs) zum Abschneiden des JSON führte. Das `code`-Feld fehlte dadurch im tool_use-Input und `code_sandbox` schlug mit "Missing required field code" fehl. Limit auf 8192 erhöht — genug für Code-Generierung, ohne das Context Window zu überlasten

## [0.10.21] - 2026-03-06

### Fixed
- **Background-Task vs. Delegate Guidance** — LLM verwendete fälschlicherweise `background_task` für komplexe Multi-Step-Aufgaben (z.B. "durchsuche Emails und erstelle Excel"), obwohl `background_task` nur einen einzelnen Skill-Call ausführt. Neuer System-Prompt-Block und verbesserte Skill-Beschreibung erklären den Unterschied: `background_task` für einzelne asynchrone Skill-Calls, `delegate` für Multi-Step-Workflows

## [0.10.20] - 2026-03-06

### Fixed
- **Concurrency-Limiter für parallele Tool-Calls** — Wenn der LLM viele Aufrufe zum selben Skill gleichzeitig feuert (z.B. 8× `email.read`), wurden bisher alle parallel ausgeführt, was bei rate-limitierten APIs (Microsoft Graph, etc.) zu 429-Fehlern führte. Neuer Per-Skill-Concurrency-Limiter in der Message-Pipeline begrenzt gleichzeitige Aufrufe pro Skill auf 3, während verschiedene Skills weiterhin parallel laufen

## [0.10.19] - 2026-03-06

### Fixed
- **Code-Sandbox Security-Level korrigiert** — `code_sandbox` hatte `riskLevel: 'destructive'`, was von der Default-Security-Regel blockiert wurde. Da die Sandbox in einem isolierten Temp-Verzeichnis mit Timeout läuft, ist `write` das korrekte Risk-Level. Behebt "dieses Tool ist nicht verfügbar" bei Excel/PDF/HTML-Generierung

## [0.10.18] - 2026-03-06

### Fixed
- **Document-Skill — Abgeschnittene IDs behoben** — `document.list` zeigte Document-IDs nur als 8-Zeichen-Prefix (`accd31f0...`), was dazu führte dass `document.summarize` mit diesen IDs fehlschlug ("Document not found"). Volle UUID wird jetzt in der Display-Ausgabe angezeigt
- **Delegate-Retry-Schutz** — Neue System-Prompt-Regel verhindert dass der LLM bei gescheiterter Sub-Agent-Delegation denselben Task blind nochmal delegiert. Stattdessen soll er die Fehlerursache analysieren und selbst weitermachen

### Improved
- **Code-Agent Delegation präzisiert** — `code_agent` wird nur noch für Repository-Coding-Tasks empfohlen, nicht mehr für Daten-Tasks die Alfreds eigene Skills benötigen (Dokumente, Emails, Kalender etc.)
- **Data-to-File Workflow** — Neuer System-Prompt-Block erklärt dem LLM den korrekten Ablauf: erst Daten mit eigenen Tools sammeln, dann `code_sandbox` für Datei-Erstellung. Verhindert dass der LLM versucht, beides in einer isolierten Sandbox zu machen

## [0.10.17] - 2026-03-06

### Fixed
- **Skill-Filter — Deutsche Zeitplan-Keywords fehlten** — Nachrichten wie "checke den Proxmox-Status jeden Morgen um 5 Uhr" aktivierten die Automation-Kategorie nicht, wodurch `scheduled_task` nicht im Tool-Set war. Neue Keywords: `täglich`, `stündlich`, `wöchentlich`, `monatlich`, `jeden Tag/Morgen/Abend` + Wochentage, `um X Uhr`, `alle X Minuten/Stunden`, sowie englische Varianten (`daily`, `hourly`, `weekly`, `every X min`)

## [0.10.16] - 2026-03-06

### Improved
- **LLM Context Window Mapping aktualisiert** — Korrekte Token-Limits für aktuelle Modelle: GPT-5.4 (1.05M Input, 128k Output), GPT-5/5.2 (400k Input, 128k Output), Gemini 3.x/3.1 (1M Input, 64k Output), Mistral Large 3 (256k Context/Output), Mistral Medium 3.1/Small 3.2 (128k Context/Output), Magistral Medium/Small 1.2 (128k Context, 131k Output), Codestral (256k Context/Output). Veraltete Output-Limits (4k–8k) durch die tatsächlichen Herstellerangaben ersetzt

## [0.10.15] - 2026-03-06

### Improved
- **Watch/Scheduled-Task — LLM-Guidance verbessert** — Watch-Skill-Description enthält jetzt konkrete `conditionField`-Pfade pro Skill (energy→bruttoCt, bmw→telematic.\*.value, todo→length, email→unreadCount, monitor→length). System-Prompt enthält einen schlanken Guidance-Block der dem LLM erklärt wann `watch` vs. `scheduled_task` sinnvoll ist. Skill-Filter erkennt jetzt auch Keywords wie "benachrichtige", "überwache", "alert", "Bescheid" für die Automation-Kategorie

## [0.10.14] - 2026-03-06

### Security
- **Malware-Paket entfernt: `@whiskeysockets/baileys@6.17.16`** — Typosquat auf die legitime Version `6.7.16`. Das Paket fing WhatsApp-Sessions, Nachrichten und Kontakte ab und verlinkte ein Attacker-Device. Version auf `6.7.21` gepinnt (kein Caret-Range mehr)
- **CVE-2025-7783 behoben (`form-data@2.3.3`, CVSS 9.4)** — Vorhersagbare Multipart-Boundaries durch `Math.random()`. Transitive Dependency via `matrix-bot-sdk` → `request`. Per pnpm-Override auf `^4.0.5` erzwungen, `matrix-bot-sdk` auf `0.8.0` aktualisiert

## [0.10.13] - 2026-03-06

### Added
- **Watch-System (Condition-based Alerts)** — Neuer `watch` Skill für zustandsbasierte Benachrichtigungen. Alfred pollt Skills in konfigurierbaren Intervallen und benachrichtigt bei erfüllter Bedingung — ohne LLM-Aufruf. 11 Operatoren: `lt`, `gt`, `lte`, `gte`, `eq`, `neq`, `contains`, `not_contains`, `changed`, `increased`, `decreased`. Baseline-Erkennung verhindert False Positives beim ersten Check, Cooldown-Timer verhindert Spam. Beispiele: "Sag Bescheid wenn der Strompreis unter 20ct fällt", "Alert wenn BMW Batterie unter 20%", "Benachrichtige mich wenn sich die Einkaufsliste ändert"

## [0.10.12] - 2026-03-06

### Fixed
- **Image Generation — `response_format` Fehler** — OpenAI `gpt-image-1` unterstützt den Parameter `response_format: 'b64_json'` nicht (HTTP 400). Entfernt — das Modell liefert Base64-Daten standardmäßig

### Added
- **Excel-Support in Code-Sandbox** — `exceljs` als Dependency hinzugefügt, `.xlsx`/`.xls` MIME-Types registriert. Alfred kann jetzt Excel-Dateien im Sandbox erstellen und als Dokument senden

## [0.10.11] - 2026-03-06

### Fixed
- **Energy-Config — Laden schlug fehl** — ENV-Variablen für Netzkosten (`ALFRED_ENERGY_GRID_USAGE_CT` etc.) sind Strings, das Zod-Schema erwartete aber `number`. Fix: `z.coerce.number()` konvertiert automatisch

## [0.10.10] - 2026-03-06

### Added
- **Strompreis-Skill (`energy_price`)** — Echtzeit-Strompreise basierend auf aWATTar HOURLY Tarif (EPEX Spot AT). Fünf Aktionen: `current` (aktueller Preis mit vollständiger Aufschlüsselung), `today`/`tomorrow` (Stundenpreise), `cheapest` (günstigste Stunden), `average` (Durchschnittspreis). Transparente Darstellung aller Preiskomponenten: Marktpreis, aWATTar-Aufschlag (1,5 ct/kWh), 3% Ausgleichsenergie (entfällt automatisch ab 01.04.2026), Netznutzungs- & Netzverlustentgelt, Elektrizitätsabgabe, Ökostrom-Förderbeitrag, USt. Fixe Monatskosten (Grundgebühr, Leistungspauschale, Messentgelt, Förderpauschalen) werden separat ausgewiesen
- **Setup-Wizard: Energy-Sektion** — `alfred setup` fragt jetzt die Netzkosten aus der eigenen Stromrechnung ab: Netzbetreiber-Name, Netznutzungsentgelt (ct/kWh), Netzverlustentgelt (ct/kWh), Leistungspauschale (€/Monat), Messentgelt (€/Monat). Keine geschätzten Defaults mehr — nur verifizierte Werte vom User

## [0.10.8] - 2026-03-06

### Added
- **Public Transit Skill (`transit_search`)** — Öffentlicher Nahverkehr für ganz Österreich via hafas-client (ÖBB-Profil). Drei Aktionen: `search_stop` (Haltestellensuche), `journeys` (Verbindungssuche mit Abfahrts-/Ankunftszeit), `departures` (Abfahrtstafel einer Haltestelle mit Echtzeit-Verspätungen). Deckt ÖBB, Wiener Linien, Postbus, Regionalbusse, S-Bahn, U-Bahn und Straßenbahn ab. Keine API-Keys oder Konfiguration nötig — wird automatisch registriert

## [0.10.7] - 2026-03-05

### Fixed
- **code_sandbox — Dateien wurden nicht automatisch gesendet** — LLM nutzte fälschlicherweise `file send` auf Sandbox-generierte Dateien, die im isolierten Temp-Verzeichnis lagen und vom Host nicht erreichbar waren. Fix: Skill-Description und System-Prompt weisen jetzt explizit darauf hin, dass die Sandbox Dateien automatisch als Attachments liefert
- **file send — Leere Dateien an Telegram** — Wenn eine Datei nicht existierte oder leer war, wurde ein leerer Buffer an die Telegram-API geschickt (`file must be non-empty`). Fix: Validierung auf `size === 0` vor dem Senden

## [0.10.6] - 2026-03-05

### Added
- **Image Generation Skill** — Bilder auf Anfrage generieren via `image_generate` Tool. Unterstützt OpenAI (`gpt-image-1`, `gpt-image-1-mini`) und Google (`gemini-2.0-flash-exp`). Wird automatisch aktiviert wenn ein OpenAI- oder Google-Key in der LLM-Config vorhanden ist — keine zusätzliche Konfiguration nötig. Optionale Parameter: Modell, Größe (1024x1024, 1536x1024, 1024x1536), Qualität (low/medium/high)

## [0.10.5] - 2026-03-05

### Fixed
- **Document Upload — LLM ignorierte indexierte Dokumente** — Beim Upload ohne Begleittext erzwang ein Fallback-Prompt "Do NOT use any tools", der den Auto-Ingest-Hinweis überschrieb. Das LLM fragte nur "Was soll ich damit tun?" statt den Empfang zu bestätigen. Fix: Pipeline erkennt indexierte Dokumente und gibt stattdessen eine passende Anweisung, die das LLM auf `document → search` hinweist

## [0.10.4] - 2026-03-05

### Fixed
- **Auto-Ingest — LLM nutzte shell statt document search** — Der Hinweis im User-Content war zu subtil. Neuer expliziter Text weist das LLM an, den `document`-Skill mit `search`-Action zu verwenden und nicht shell/file für PDFs
- **Inbox — Duplikat-Dateien auf der Platte** — Bei Dedup wurde die Datei trotzdem in die Inbox gespeichert. Jetzt wird die Duplikat-Datei sofort nach Erkennung gelöscht. Verhindert Anhäufung identischer Dateien

## [0.10.3] - 2026-03-05

### Added
- **Auto-Ingest bei Datei-Upload** — PDFs, DOCX, TXT, CSV, Markdown und andere Textformate werden beim Empfang über Telegram/Matrix/etc. automatisch in die Dokument-DB ingestet und für Semantic Search indiziert. Das LLM erhält sofort die Info "Document indexed: X chunks" bzw. "already indexed" (Dedup). Kein manueller `document → ingest` Aufruf mehr nötig

## [0.10.2] - 2026-03-05

### Added
- **Document Deduplication** — Beim Ingest wird ein SHA-256 Hash über den Dateiinhalt berechnet. Identische Dokumente (gleicher User, gleicher Inhalt) werden erkannt und nicht erneut verarbeitet. Antwort: "already ingested, ready for search". Fehlgeschlagene Versuche (chunk_count = 0) werden automatisch bereinigt und neu ingestet

### Fixed
- **Migration 14 — Aufräumen kaputter Dokumente** — Entfernt alle Dokumente mit chunk_count = 0 (Leichen vom FK-Bug) inklusive verwaister Embeddings aus der DB

## [0.10.1] - 2026-03-05

### Fixed
- **Google Gemini — INVALID_ARGUMENT bei functionCall-Turns** — Memory-Budget-Trimming konnte `functionResponse`-Nachrichten entfernen und verwaiste `functionCall`-Parts in der History hinterlassen. Gemini verlangt aber auf jeden `functionCall` ein unmittelbares `functionResponse`. Fix: `sanitizeContents()` entfernt jetzt auch verwaiste `functionCall`-Parts ohne zugehörige Response

## [0.10.0] - 2026-03-05

### Fixed
- **Document Ingest — FOREIGN KEY constraint failed** — `DocumentProcessor` setzte die `source_id` als `embedding_id` in `document_chunks` statt der tatsächlichen UUID aus der `embeddings`-Tabelle. Kein Dokument konnte je erfolgreich gechunkt und eingebettet werden. Fix: `embedAndStore()` gibt jetzt die Embedding-ID zurück, die direkt in `document_chunks` verwendet wird
- **Code Sandbox — Node-Module nicht gefunden** — Subprocess hatte kein `NODE_PATH` gesetzt, daher konnten installierte Module wie `pdf-parse` nicht importiert werden. Fix: `NODE_PATH` wird aus dem Parent-Prozess abgeleitet und an den Subprocess weitergegeben

## [0.9.99] - 2026-03-05

### Fixed
- **Email — Attachment-Download fehlgeschlagen** — Das LLM übergab den Dateinamen als `attachmentId` statt der internen Graph API ID → 404-Fehler. Fix: Fallback-Suche per Dateiname wenn die ID kein Match ergibt. Bei keinem Treffer werden verfügbare Attachments aufgelistet
- **Skill-Sandbox — Fehlermeldungen nicht geloggt** — Bei `success: false` wurde der `error`-Text nicht ins Log geschrieben. Erschwerte Debugging erheblich. Jetzt wird der Error-Text mitgeloggt

### Added
- **Email — PDF/DOCX-Inhalt aus Anhängen lesen** — Die `attachment`-Action extrahiert jetzt automatisch den Textinhalt aus PDF (`pdf-parse`), DOCX (`mammoth`) und Text-Dateien und gibt ihn ans LLM zurück. Alfred kann damit Rechnungen, Verträge etc. direkt aus E-Mail-Anhängen lesen
- **Email — Anhänge auf Festplatte speichern** — Neuer `save`-Parameter: `attachment` + `save: "/pfad/"` speichert den Anhang auf die Festplatte ohne den Inhalt zu extrahieren. Ohne `save` wird der Inhalt gelesen und angezeigt
- **Email — Bessere Attachment-Anzeige** — Die `read`-Action zeigt Anhänge jetzt mit expliziter `attachmentId` an, damit das LLM die korrekte ID verwenden kann

## [0.9.98] - 2026-03-05

### Added
- **Email — Forward-Action** — Neuer `forward` Action leitet E-Mails via Graph API weiter (`POST /me/messages/{id}/forward`). Parameter: `messageId` (Pflicht), `to` (Pflicht), `body` (optionaler Begleittext)
- **Email — Reply-Draft** — Die `draft` Action unterstützt jetzt auch Antwort-Entwürfe: `draft` + `messageId` + `body` erstellt einen Reply-Draft via `POST /me/messages/{id}/createReply`, ohne `to`/`subject` zu benötigen

## [0.9.97] - 2026-03-05

### Fixed
- **Email — Mehrfachversand bei Reply/Send** — Graph API antwortet bei `/me/messages/{id}/reply` und `/me/sendMail` mit HTTP 202 (leerer Body). `graphRequest()` versuchte den leeren Body als JSON zu parsen → `Unexpected end of JSON input`. Der Skill meldete Fehler obwohl die Email bereits gesendet war, das LLM versuchte es erneut → Mehrfachversand. Fix: Leere Responses (202, 204, leerer Body) werden korrekt als Erfolg behandelt

### Added
- **Email — Draft-Action** — Neuer `draft` Action im Email-Skill erstellt Entwürfe via Graph API (`POST /me/messages`) ohne sie zu senden. Erscheint im Entwürfe-Ordner in Outlook/OWA. Wenn der User eine Email "vorbereiten" will, verwendet das LLM nun `draft` statt `send`

## [0.9.96] - 2026-03-05

### Added
- **Microsoft To Do Integration** — Neuer `microsoft_todo` Skill für Microsoft To Do via Graph API. 8 Actions: Listen anzeigen/erstellen, Aufgaben anzeigen/hinzufügen/erledigen/wiedereröffnen/aktualisieren/löschen. Listenauflösung per Display-Name (z.B. "füge Milch zur Einkaufsliste hinzu"). Eigener `graphRequest`-Helper mit automatischem Token-Refresh. OAuth-Scopes (`Tasks.ReadWrite`) in `alfred auth microsoft` integriert — kein separates Setup nötig

## [0.9.95] - 2026-03-05

### Added
- **MonitorSkill — Deterministisches Infrastruktur-Monitoring** — Neuer `monitor` Skill führt Health-Checks für Proxmox, UniFi und Home Assistant ohne LLM-Calls durch. Prüft Node-Status, VM-Disk/RAM-Auslastung, UniFi-Subsystem-Health und Device-Connectivity, HA unavailable Entities und niedrige Batteriestände. Checks laufen parallel via `Promise.allSettled`, bei keinen Alerts wird die Notification unterdrückt (`display: ''`). Wird automatisch registriert wenn mindestens eine Infra-Konfiguration vorhanden ist. Nutzbar als Scheduled Task (`skill_name: 'monitor'`) — spart ~4M Tokens/Tag gegenüber LLM-basiertem Monitoring

## [0.9.94] - 2026-03-05

### Fixed
- **Gemini — Tool-Call Message-Ordering** — Gemini 3/3.1 Pro verlangt strikt abwechselnde Rollen (user ↔ model) und lehnt Requests mit aufeinanderfolgenden same-role Turns ab. Umfassender Fix im GoogleProvider: `sanitizeContents()` entfernt orphaned `functionResponse`-Parts (entstehen wenn Auto-Pruning die zugehörigen `functionCall`-Turns abschneidet), merged consecutive same-role Turns, und filtert leere Einträge. Zusätzlich Role-Korrekturen in der Pipeline (`collapseRepeatedToolErrors`, `trimToContextWindow`, `abortToolLoop`). Andere Provider (Anthropic, OpenAI, Ollama) sind nicht betroffen

## [0.9.91] - 2026-03-05

### Fixed
- **CLI — Fehlende `@google/genai` Dependency** — Der native Google/Gemini Provider benötigt `@google/genai` als Runtime-Dependency. Das Paket war nur im internen `@alfred/llm` Workspace deklariert, fehlte aber im publizierten CLI-Paket `@madh-io/alfred-ai`. Dadurch schlug `npm install -g` mit `ERR_MODULE_NOT_FOUND: Cannot find package '@google/genai'` fehl

## [0.9.90] - 2026-03-05

### Fixed
- **OpenAI Provider — GPT-5/o-Series Kompatibilität** — `max_tokens` durch `max_completion_tokens` ersetzt für Modelle die das erfordern (gpt-5*, o1*, o3*, o4*). Temperature-Parameter wird bei Reasoning-Modellen (o1, o3, o4, gpt-5, gpt-5.1) automatisch weggelassen, da diese ihn nicht unterstützen. gpt-5.2 und ältere Modelle (gpt-4o etc.) sind nicht betroffen. Subklassen (OpenRouter, Mistral, OpenWebUI) ebenfalls nicht betroffen

## [0.9.89] - 2026-03-05

### Changed
- **Google/Gemini Provider — Native SDK** — GoogleProvider komplett auf native `@google/genai` SDK umgestellt statt OpenAI-kompatiblem Endpoint. Behebt 400-Fehler bei Tool-Calling mit Gemini 3/3.1 Pro, die durch fehlende `thought_signature` im OpenAI-Kompatibilitätsmodus verursacht wurden. Raw-Content-Cache bewahrt Thought-Signatures über Tool-Call-Roundtrips hinweg. Fallback auf Sentinel-Wert bei Cache-Miss. Bestehende Provider (Anthropic, OpenAI, Ollama, etc.) sind nicht betroffen

## [0.9.88] - 2026-03-05

### Fixed
- **Scheduled Tasks — Whitelist-basierte Silence-Detection** — Silence-Erkennung von Blacklist (spezifische "alles OK"-Phrasen) auf Whitelist (nur senden bei Alert-Keywords) umgestellt. Statt kreative LLM-Antworten wie "silenzio." oder "(no response)" einzeln abzufangen, werden bei Monitoring-Prompts mit "antworte NICHTS" nur Antworten mit echten Alarm-Indikatoren (offline, error, down, fehler, nicht erreichbar, etc.) durchgelassen. Model-unabhängig — funktioniert mit Gemini, Claude und GPT

## [0.9.87] - 2026-03-05

### Fixed
- **Scheduled Tasks — Review-Fixes** — Conversation-Injection nur noch für `prompt_template`-basierte Monitoring-Tasks, nicht für Skill-basierte Tasks (UDM Health Check, Strompreise), die sonst die User-Conversation genauso aufblähen würden. Alerts als `assistant`-Message mit `[Automated Scheduled Alert]`-Prefix statt `system`-Role, da `buildMessages()` system-Messages filtert und der Alert sonst für das LLM unsichtbar wäre

## [0.9.86] - 2026-03-05

### Fixed
- **Scheduled Tasks — Auto-Pruning** — Isolierte Scheduled-Task Conversations werden nach jedem Run auf maximal 20 Nachrichten getrimmt, um unbegrenztes DB-Wachstum zu verhindern
- **Scheduled Tasks — Silence-Detection** — "Alles OK"-Antworten (z.B. "Alles in Ordnung", "Keine Probleme") werden jetzt per Regex erkannt und unterdrückt, nicht nur leere Responses
- **Scheduled Tasks — System-Message-Injection** — Monitoring-Alerts werden als `system`-Message mit `[Scheduled Alert: ...]`-Prefix in die User-Conversation injiziert statt als `assistant`-Message, damit das LLM sie als automatisierte Benachrichtigungen erkennt und nicht als eigene Aussagen weiterführt

## [0.9.85] - 2026-03-05

### Fixed
- **Scheduled Tasks — Conversation-Isolation** — Scheduled Tasks mit `prompt_template` (z.B. UniFi/Proxmox-Monitoring) liefen bisher in der gleichen Conversation wie der User. Das führte zu einer Konversation mit tausenden Nachrichten, wodurch das LLM irrelevanten Kontext halluzinierte (z.B. Wandervorschläge während eines Infrastruktur-Checks). Jeder Scheduled Task bekommt nun eine eigene isolierte Conversation (`scheduled-{actionId}`). Monitoring-Meldungen die tatsächlich an den User gesendet werden, werden zusätzlich in die User-Conversation injiziert, damit der User darauf antworten kann (z.B. "starte die VM neu")
- **Scheduled Tasks — Stille Antworten** — Monitoring-Prompts die "antworte NICHTS wenn alles OK ist" sagen, erzeugten trotzdem Nachrichten an den User. Leere/kurze LLM-Antworten (< 3 Zeichen) werden jetzt unterdrückt und nur geloggt

## [0.9.84] - 2026-03-05

### Fixed
- **Scheduled Tasks — `prompt_template` ohne `skill_name`** — Scheduled Tasks mit `prompt_template` (LLM-Prompt statt direktem Skill-Aufruf) scheiterten, weil `skill_name` immer als Pflichtfeld validiert wurde. Tasks mit `prompt_template` werden durch die volle Message Pipeline geroutet und brauchen keinen expliziten `skill_name`. Ermöglicht proaktive Automations-Tasks wie Gesundheitschecks, Monitoring und bedingte Benachrichtigungen

## [0.9.83] - 2026-03-05

### Fixed
- **CLI Start — Error-Logging** — Startup-Fehler wurden als `error: {}` geloggt, da pino non-Error-Objekte nicht serialisieren kann. Fehler werden jetzt korrekt als `Error`-Instanz mit Stack-Trace geloggt

## [0.9.82] - 2026-03-05

### Fixed
- **Config Loader — `ALFRED_GOOGLE_API_KEY` nicht gemappt** — Das Setup-Wizard schrieb `ALFRED_GOOGLE_API_KEY` in die `.env`, aber der Config Loader hatte kein Mapping dafür in der `ENV_MAP`. Google/Gemini als Haupt-LLM-Provider konnte daher nicht starten, weil der API Key nie in der Config ankam

## [0.9.81] - 2026-03-05

### Fixed
- **Kalender Skill — Timezone-Bug bei Microsoft Graph** — Events wurden mit `timeZone: 'UTC'` an die Graph API gesendet, obwohl die Zeiten in der lokalen Timezone des Users gemeint waren. Ein Termin um 10:30 Uhr (Europe/Vienna) landete als 09:30 Uhr im Kalender. Der Microsoft Provider nutzt jetzt die User-Timezone aus dem SkillContext und formatiert Dates korrekt für die Graph API (`dateTime` ohne UTC-Offset + `timeZone: 'Europe/Vienna'`)

## [0.9.80] - 2026-03-05

### Fixed
- **Kalender Skill — Event-IDs in der Ausgabe** — `list_events` und andere Kalender-Aktionen zeigen jetzt die Event-ID im Display-Text (`[id:...]`). Ohne die ID konnte das LLM Termine nicht löschen oder aktualisieren, da `delete_event` und `update_event` eine `event_id` erfordern

## [0.9.79] - 2026-03-05

### Fixed
- **Config Loader — ENV-Override bei YAML-Accounts** — Wenn die YAML-Config `email.accounts[]` definiert, wurden ENV-Variablen wie `ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN` ignoriert, da sie auf `email.microsoft.*` gemappt werden. ENV-Werte werden jetzt in bestehende Microsoft-Accounts gemergt und überschreiben veraltete YAML-Werte (z.B. abgelaufene Refresh Tokens)
- **Microsoft Email Provider — Bessere Fehlermeldung** — Token-Refresh-Fehler enthalten jetzt den vollständigen HTTP-Body statt nur den Status-Code. Fehlende `refreshToken`-Config wird frühzeitig erkannt
- **`alfred auth microsoft` — `.env` Trailing Newline** — Ohne abschließende Newline wurden angehängte Keys an die letzte Zeile geklebt

## [0.9.78] - 2026-03-04

### Fixed
- **`alfred auth microsoft` — Provider-Flags setzen** — Der Auth-Command schreibt jetzt auch `ALFRED_EMAIL_PROVIDER=microsoft`, `ALFRED_CALENDAR_PROVIDER=microsoft` und `ALFRED_CONTACTS_PROVIDER=microsoft` in die `.env`. Ohne diese schlug die Zod-Config-Validierung fehl und Alfred konnte nicht mehr starten. Auskommentierte Zeilen (`# KEY=value`) werden ebenfalls erkannt und überschrieben

## [0.9.77] - 2026-03-04

### Fixed
- **Routing Skill — `departureTime` darf nicht "jetzt" sein** — Google Routes API lehnt `departureTime` ab wenn er nicht strikt in der Zukunft liegt (`"Timestamp must be set to a future time."`). `computeDepartureTime` sendet jetzt keinen expliziten Timestamp mehr (Google nutzt automatisch die aktuelle Zeit). Zusätzlich werden `departureTime`/`arrivalTime` nur an die API übergeben wenn sie mindestens 1 Minute in der Zukunft liegen

## [0.9.76] - 2026-03-04

### Fixed
- **Routing Skill — Timestamp-Normalisierung** — Timestamps ohne Zeitzonen-Offset (z.B. `2026-03-05T08:00:00` vom LLM) werden jetzt mit dem lokalen UTC-Offset ergänzt statt als UTC interpretiert. Verhindert dass Google Routes API den Zeitpunkt als in der Vergangenheit ablehnt

## [0.9.75] - 2026-03-04

### Fixed
- **BMW CarData Skill — Robuster Auth-Flow** — `pollToken` speichert Tokens + VIN sofort nach dem Token-Tausch, bevor Container-Setup versucht wird. Container-Fehler bricht den Auth-Flow nicht mehr ab, Tokens gehen nicht mehr verloren. Container-Fehler wird separat gemeldet
- **BMW Descriptor-Keys erweitert** — Komplette Liste aus dem BMW Telematics Data Catalogue (29 Keys statt 15): Preconditioning, Charging-Methode/Phasen/Limits, Trip-Daten, Plug-Events, Vehicle-Identification u.a.

## [0.9.74] - 2026-03-04

### Fixed
- **BMW CarData Skill — API-Spec-Abgleich** — Kompletter Abgleich mit der offiziellen Swagger-Spec (`swagger-customer-api-v1.json`). Container-Erstellung: `technicalDescriptors` als String-Array statt Objekt-Array, `vins`-Feld entfernt (existiert nicht in der API). Vehicle-Mappings: Response ist ein einzelnes Objekt, kein Array. Charging-History: `data`-Feld statt `chargingSessions`, korrekte Feldnamen (`startTime` ms-Timestamp, `totalChargingDurationSec`, `energyConsumedFromPowerGridKwh`, `displayedStartSoc`/`displayedSoc`). BasicData: `modelName` priorisiert

## [0.9.73] - 2026-03-04

### Fixed
- **BMW CarData Skill — `.find is not a function`** — Die BMW API gibt bei Vehicles und Containers ein Objekt (z.B. `{ vehicles: [...] }`) statt ein nacktes Array zurück. `fetchVin` und `ensureContainer` parsen die Response jetzt defensiv und extrahieren das Array aus bekannten Wrapper-Keys

## [0.9.72] - 2026-03-04

### Fixed
- **Context-Window-Tabelle komplett aktualisiert** — Fehlende Models ergänzt: GPT-4.1/4.1-mini/4.1-nano, o3, o4-mini, Gemini 2.5 Pro/Flash, Claude 3/3.5 Varianten, Llama 4, Gemma 3, Qwen 3, Phi 4, DeepSeek v3/chat, Command R+. Default-Fallback auf 128k erhöht

## [0.9.71] - 2026-03-04

### Fixed
- **Context-Window für Claude 4.5 Models** — `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101` und `claude-haiku-4-5-20251001` fehlten in der Context-Window-Lookup-Tabelle → Fallback auf 8k statt 200k → System-Prompt sprengte das Budget → keine Conversation History → Alfred konnte sich zwischen Nachrichten nicht erinnern. Generischer `claude-*` Prefix-Fallback und Default von 8k auf 128k erhöht

## [0.9.70] - 2026-03-04

### Added
- **`alfred auth microsoft`** — Neuer CLI-Command für automatischen Microsoft 365 OAuth-Flow. Startet lokalen HTTP-Server, öffnet Browser, fängt Callback ab, tauscht Auth-Code gegen Tokens und schreibt Refresh Token direkt in `.env` (Email, Calendar, Contacts). Credentials werden aus bestehender Config/ENV gelesen oder interaktiv abgefragt
- **Setup-Wizard Hinweis** — Bei Microsoft Email- und Contacts-Konfiguration wird jetzt ein Tipp angezeigt, dass `alfred auth microsoft` den Refresh Token automatisch holen kann

## [0.9.69] - 2026-03-04

### Changed
- **BMW CarData Skill — API-Rewrite** — Kompletter Rewrite auf die echte BMW CarData Customer API (`api-cardata.bmwgroup.com`). OAuth Device Flow mit PKCE (S256), Container-basierter Datenzugriff über Telematik-Descriptor-Keys, `basicData`-Endpoint für Modelldaten. `location`-Action entfernt (GPS nur über MQTT-Stream verfügbar). Charging-Details erweitert: Ladeleistung, AC-Spannung/-Strom, Ziel-SoC, Stecker-/Klappen-/Schloss-Status, Batterie-Gesundheit (SoH). `charging_sessions` nutzt jetzt `/chargingHistory` mit `from`/`to`-Zeitraum

## [0.9.68] - 2026-03-04

### Added
- **BMW CarData Skill** — Fahrzeugdaten vom BMW i4 via BMW CarData Customer API: Ladestand (SoC), elektrische Reichweite, km-Stand, Türen/Fenster, GPS-Position, Ladestatus, Lade-Sessions (letzte 30 Tage). OAuth Device Authorization Flow mit persistenten Tokens (`~/.alfred/bmw-tokens.json`), automatischer Token-Refresh, Response-Cache (5 Min TTL, respektiert BMW 50 Calls/Tag Limit)
- **Google Routing Skill** — Routenberechnung mit Live-Traffic via Google Routes API: Distanz, Fahrzeit mit/ohne Verkehr, Verkehrsverzögerung, Abfahrtszeit-Empfehlung mit 15% Puffer. Unterstützt Adressen und GPS-Koordinaten, Fortbewegungsarten DRIVE/BICYCLE/WALK/TRANSIT
- **Setup-Wizard** — BMW CarData und Google Routing Abschnitte mit Schritt-für-Schritt-Anleitungen zur API-Key-Erstellung

## [0.9.67] - 2026-03-04

### Added
- **Dynamische Model-Discovery** — Setup-Wizard ruft verfügbare Models direkt von der Provider-API ab (Anthropic, OpenAI, Google, Mistral, OpenRouter, Ollama, OpenWebUI). Kein manuelles Nachziehen bei neuen Model-Releases mehr nötig
- **Model-Cache** — Abgerufene Model-Listen werden lokal gecacht (`~/.alfred/model-cache.json`, TTL 24h). Bei `alfred start` wird der Cache im Hintergrund aktualisiert
- **Tier-Model-Auswahl** — Multi-Model-Tier-Konfiguration zeigt jetzt ebenfalls eine nummerierte Model-Liste statt nur ein freies Textfeld

### Fixed
- **API Overload Retry** — Anthropic- und OpenAI-Provider nutzen jetzt 5 Retries mit Exponential Backoff (statt SDK-Default 2). Reduziert 529-Overloaded-Fehler bei stark ausgelasteten Models (z.B. Haiku)

## [0.9.66] - 2026-03-04

### Added
- **LLM Tier-Logging** — ModelRouter loggt beim Start welche Tiers initialisiert wurden (Provider + Model pro Tier) und bei jedem API-Call: angeforderter Tier, tatsächlich verwendeter Tier, Model, Input-/Output-Tokens. Macht sichtbar ob `strong` (Opus) / `fast` (Haiku) korrekt geroutet werden

## [0.9.65] - 2026-03-04

### Fixed
- **API-Key-Propagation** — `ALFRED_ANTHROPIC_API_KEY` wird jetzt an alle LLM-Tiers (`strong`, `fast`, `embeddings`, `local`) propagiert wenn kein eigener Key gesetzt ist. Vorher hat Zod den Top-Level-Key bei gemischtem Format (flat + Tier-Sub-Objekte) gestrippt → `strong`/`fast` Tiers bekamen keinen API-Key und fielen stillschweigend auf `default` (Sonnet) zurück
- **Token-Usage Logging** — Token-Verbrauch wird jetzt kumulativ über alle Tool-Loop-Iterationen geloggt (`totalTokens`). Vorher zeigte das Log nur den letzten API-Call — bei 5 Iterationen war die tatsächliche Nutzung ~5x höher als angezeigt

### Added
- **Conversation History Limit** — Neuer Config-Wert `conversation.maxHistoryMessages` (Default: 100, Range: 10–500). Reduziert die geladene History von 200 auf 100 Messages, was die Input-Token-Anzahl pro API-Call deutlich senkt. Die bestehende `trimToContextWindow`-Logik erzeugt automatisch Zusammenfassungen für ältere Messages

### Changed
- `MultiModelConfigSchema` verwendet jetzt `.passthrough()` um Top-Level-Keys (z.B. `apiKey` vom Env-Override) nicht zu strippen
- LLM-Config-Normalisierung (flat → multi-model) findet jetzt vor der Zod-Validierung statt wenn Tier-Sub-Objekte vorhanden sind

## [0.9.64] - 2026-03-04

### Added
- **Skill-Kategorien** — Neuer `SkillCategory`-Typ mit 9 Kategorien (core, productivity, information, media, automation, files, infrastructure, identity, mcp). Alle Skills haben jetzt eine `category` in ihrer Metadata
- **Kontextbasierte Tool-Filterung** — Message-Pipeline filtert Skills per Keyword-Matching nach Relevanz. Nur passende Tool-Schemas werden an das LLM gesendet, was Tokens spart. Fallback: bei keinem Keyword-Match bleiben alle Skills aktiv

### Refactored
- **ContextFactory** — User-Lookup, Master-Resolution und Timezone-Auflösung in zentrale `buildSkillContext()`-Funktion extrahiert. Ersetzt duplizierten Code in MessagePipeline, BackgroundTaskRunner und ProactiveScheduler
- **User-ID-Hilfsfunktionen** — `effectiveUserId()` und `allUserIds()` als gemeinsame Funktionen in `@alfred/skills` extrahiert. Entfernt identische private Methoden aus 7 Skills (memory, note, todo, reminder, background-task, scheduled-task, document). ProfileSkill vereinfacht

## [0.9.63] - 2026-03-04

### Fixed
- **Scheduled/Background Tasks** — User-Context (masterUserId, linkedPlatformUserIds) wird jetzt korrekt aufgelöst. ProactiveScheduler und BackgroundTaskRunner reichern den SkillContext vor Skill-Ausführung über das UserRepository an — `cross_platform.send_message` funktioniert nun auch bei zeitgesteuerten Tasks
- **Phantom-User-Bug** — Background/Scheduled Tasks speichern `masterUserId` (interne UUID) als `userId`. `findOrCreate` mit dieser UUID erzeugte fälschlich neue „Phantom-User" mit der UUID als `platformUserId` → Telegram `chat not found`. Fix: Interne ID wird jetzt per `findById` erkannt und direkt genutzt

## [0.9.62] - 2026-03-04

### Fixed
- Erster Versuch des User-Context-Fix (unvollständig, siehe 0.9.63)

## [0.9.61] - 2026-03-03

### Fixed
- **Prompt-too-long Retry** — Wenn die API den Prompt als zu lang ablehnt, wird automatisch mit halbiertem Budget neu getrimmt und erneut gesendet (bis zu 3 Retries). Macht die char-basierte Token-Schätzung irrelevant — Alfred korrigiert sich selbst
- **Trim-Algorithmus** — `continue` → `break` beim Gruppen-Walk: überspringt keine großen kürzlichen Message-Gruppen mehr zugunsten kleinerer alter Gruppen. Neueste Nachrichten haben Vorrang
- Token-Schätzung und Budget-Ratio auf Originalwerte zurückgesetzt (chars/3.5, 85%) — Retry-Mechanismus macht konservative Schätzung überflüssig

## [0.9.60] - 2026-03-03

### Fixed
- Token-Schätzung chars/3.5 → chars/2.5, Budget-Ratio 85% → 75% (nicht ausreichend, siehe 0.9.61)

## [0.9.59] - 2026-03-03

### Fixed
- Token-Schätzung chars/3.5 → chars/2.8, Budget-Ratio 85% → 80% (nicht ausreichend, siehe 0.9.61)

## [0.9.58] - 2026-03-03

### Added
- **Contacts Skill** — Kontaktverwaltung mit Provider-Pattern (wie Calendar). Drei Provider: CardDAV (tsdav + vCard-Parsing), Google People API v1 (OAuth + fetch), Microsoft Graph /me/contacts (OAuth + fetch). 6 Aktionen: `search`, `get`, `list`, `create`, `update`, `delete`. Normalisiertes Contact-Interface mit Emails, Telefonnummern, Adressen, Organisation, Geburtstag
- **Todo Skill** — Aufgabenlisten mit SQLite-Storage (Migration v13). Mehrere benannte Listen, Prioritäten (low/normal/high/urgent), Fälligkeitsdaten. 7 Aktionen: `add`, `list`, `complete`, `uncomplete`, `delete`, `lists`, `clear`. Cross-Platform User-IDs wie NoteSkill
- **Docker Skill** — Docker-Container-Management über die Engine API v1.45. Node.js native `http.request` mit Unix-Socket oder TCP. 16 Aktionen: `containers`, `container`, `logs`, `start`, `stop`, `restart`, `images`, `pull_image`, `remove_image`, `networks`, `volumes`, `system_info`, `prune`, `compose_ps`, `compose_up`, `compose_down`. Kein Extra-Dependency
- **Setup Wizard** — Neue Sektionen für Contacts (Provider-Auswahl + Credentials) und Docker (Socket/Host)
- **Configure Skill** — Hot-Reload-Support für `contacts`, `docker` und `homeassistant`

### Fixed
- **Token-Budget-Berechnung** — Tool-Definitionen (Skill-Schemas) werden jetzt bei der Context-Window-Trimming-Berechnung berücksichtigt. Verhindert `prompt is too long`-Fehler bei vielen registrierten Skills

### Changed
- `ContactsConfig`, `DockerConfig` zu AlfredConfig hinzugefügt (types, schema, loader)
- 13 neue ENV-Variablen für Contacts und Docker
- Skills-Export erweitert: `ContactsSkill`, `TodoSkill`, `DockerSkill`
- 30+ Skills total

## [0.9.57] - 2026-03-03

### Added
- **Home Assistant: 9 neue Actions** — `areas` (Räume/Zonen via Jinja2-Template), `template` (freie Jinja2-Abfragen), `presence` (Personen-Status), `notify` (Benachrichtigungen senden), `activate_scene` (Szenen aktivieren), `trigger_automation` (Automationen auslösen/an/aus), `run_script` (Skripte ausführen), `calendar_events` (Kalender-Events abfragen), `error_log` (HA-Fehlerlog anzeigen)
- Neuer `apiText()` Helper für Plain-Text-API-Endpoints (Template-Rendering, Error-Log)
- Home Assistant Skill Version 2.0.0 — 19 Actions total, rückwärtskompatibel

## [0.9.56] - 2026-03-03

### Added
- **Multi-Account Email** — Mehrere benannte Email-Accounts konfigurierbar (z.B. "alfred", "user"). Jeder Account kann einen eigenen Provider haben (IMAP/SMTP oder Microsoft 365, mischbar). Account-Auswahl im Skill über `account`-Feld (nur sichtbar bei >1 Account)
- **Setup Wizard: Multi-Account Email** — Nach dem ersten Account: "Add another email account?" Loop mit Account-Name-Prompt und Provider-Auswahl pro Account
- Message-ID-Encoding: `accountName::rawId` bei Multi-Account, kein Prefix bei Single-Account

### Changed
- **EmailConfig** umstrukturiert: `accounts`-Array mit `EmailAccountConfig`-Einträgen (jeweils mit `name`-Feld). Alte Flat-Configs werden automatisch zu `{ accounts: [{ name: 'default', ... }] }` normalisiert — keine Breaking Changes für bestehende Konfigurationen
- Email Skill Version 3.0.0 — dynamische Metadata, Provider-Map statt einzelnem Provider

## [0.9.55] - 2026-03-03

### Added
- **Home Assistant Skill** — Smart-Home-Steuerung über die HA REST API. 10 Aktionen: `states`, `state`, `turn_on`, `turn_off`, `toggle`, `call_service`, `services`, `history`, `logbook`, `config`. Authentifizierung über Long-Lived Access Token (Bearer Auth)
- **Setup Wizard: Home Assistant** — Neue Sektion im Infrastructure-Block. URL, Long-Lived Access Token, TLS-Verify. ENV- und YAML-Output
- ENV-Variablen: `ALFRED_HOMEASSISTANT_URL`, `ALFRED_HOMEASSISTANT_TOKEN`
- Hot-Reload: Home Assistant Skill kann per `configure set homeassistant` zur Laufzeit aktiviert werden

## [0.9.54] - 2026-03-03

### Added
- **Email: Microsoft Graph Provider** — Neuer Email-Provider für Microsoft 365 via Graph API mit OAuth. IMAP/SMTP-Basic-Auth wird bei Office 365 zunehmend blockiert; der neue Provider nutzt den gleichen OAuth-Flow wie der Calendar-Skill
- **Email: Provider Pattern** — Umstellung von monolithischem `email.ts` auf Provider-Pattern (analog Calendar): abstrakte `EmailProvider`-Basisklasse, `StandardEmailProvider` (IMAP/SMTP), `MicrosoftGraphEmailProvider` (Graph API), Factory-Funktion
- **Email: Neue Aktionen** — `folders` (Ordner auflisten), `folder` (Nachrichten aus bestimmtem Ordner), `reply` (auf Nachricht antworten), `attachment` (Anhang herunterladen)
- **Email: Credential-Sharing** — Wenn `email.provider: microsoft` gesetzt ist aber keine eigenen Credentials vorhanden, werden automatisch die Microsoft-Credentials vom Calendar übernommen
- **Setup Wizard: Email-Provider-Auswahl** — IMAP/SMTP oder Microsoft 365 (Graph API) wählbar. Bei Microsoft 365 wird erkannt ob Calendar bereits konfiguriert ist und Credentials geteilt werden können
- ENV-Variablen für Microsoft Email: `ALFRED_EMAIL_PROVIDER`, `ALFRED_MICROSOFT_EMAIL_CLIENT_ID`, `ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET`, `ALFRED_MICROSOFT_EMAIL_TENANT_ID`, `ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN`

### Changed
- **EmailConfig** ist jetzt backward-kompatibel erweitert: `provider`-Feld (optional, Default `imap-smtp`), `imap`/`smtp`/`auth` sind optional bei `microsoft`-Provider. Bestehende Configs funktionieren ohne Änderung

## [0.9.53] - 2026-03-03

### Fixed
- **Telegram HTML-Parsing**: Sonderzeichen wie `<3s` im LLM-Output wurden als HTML-Tag interpretiert und ließen `sendMessage` fehlschlagen (400 Bad Request). Stray `<` werden jetzt escaped, bekannte Telegram-Tags (`<b>`, `<i>`, `<pre>`, `<a>` etc.) bleiben erhalten
- **Fallback auf Plaintext**: Wenn HTML-formatierte Nachrichten beim Senden fehlschlagen, wird automatisch nochmal als Plaintext gesendet statt den generischen Fehler-Text anzuzeigen

## [0.9.52] - 2026-03-03

### Added
- **Hot-Reload für Services** — Nach `configure set proxmox/unifi` wird der Service sofort aktiviert, ohne Alfred neu zu starten. `.env` wird geschrieben, Config neu geladen, alter Skill deregistriert und neuer Skill registriert — die MessagePipeline sieht den Skill sofort
- `SkillRegistry.unregister()` — Ermöglicht Entfernung registrierter Skills zur Laufzeit
- `reloadDotenv()` — Exportierte Funktion zum erneuten Laden der `.env` mit Override bestehender Werte
- `Alfred.reloadService()` — Orchestriert den Hot-Reload-Zyklus: dotenv → Config → unregister → register

### Fixed
- **Code Agent Progress**: `onProgress`-Callback wird jetzt an alle Skills weitergereicht, nicht nur an `delegate`. Behebt fehlende Fortschrittsmeldungen in Telegram/Discord während `code_agent`-Ausführung

### Changed
- **ConfigureSkill**: Nach erfolgreichem `set` mit allen Pflichtfeldern wird der Service automatisch per Callback aktiviert. Meldung: „wurde aktiviert. Du kannst es jetzt sofort nutzen." statt Restart-Hinweis
- `Alfred.config` ist jetzt mutable (war `readonly`), damit `reloadService()` die Config-Referenz aktualisieren kann
- `Alfred.skillRegistry` wird als Instanz-Feld gespeichert (war lokale Variable in `initialize()`)

## [0.9.50] - 2026-03-03

### Added
- **Setup-Wizard: Proxmox + UniFi** — Neue Sektion "Infrastructure Management" im Setup. Proxmox: URL, API-Token-ID, Secret, TLS-Verify. UniFi: URL, API-Key oder Username/Password, TLS-Verify. ENV- und YAML-Output
- **ConfigureSkill** — Immer registriert, ermöglicht Konfiguration von Services (Proxmox, UniFi) per Chat. Aktionen: `list_services`, `show`, `set`. Schreibt ENV-Variablen in `.env` und weist auf nötigen Restart hin

## [0.9.49] - 2026-03-02

### Added
- **Proxmox VE Skill**: Vollständige Proxmox-API-Anbindung — Cluster-Status, Nodes, VMs/CTs auflisten, starten, stoppen, herunterfahren, Snapshots, Backups, Migration, Storage, Tasks. API-Token-Auth, Self-Signed-TLS-Support, automatischer VM-Lookup nach ID über alle Nodes
- **UniFi Network Skill**: Vollständige UniFi-API-Anbindung — Geräte, Clients, WLANs, Netzwerke, Alerts, Events, DPI-Statistiken, Voucher-Erstellung. Duale Auth: API-Key (UniFi OS) oder Username/Password (Cookie-Session mit Auto-Relogin). Auto-Detection UniFi OS vs. Classic Controller
- Config-Typen, Zod-Schemas und ENV-Overrides für `proxmox` und `unifi` (`ALFRED_PROXMOX_*`, `ALFRED_UNIFI_*`)

### Changed
- **Code Agent Delegation**: System-Prompt enthält jetzt explizite Anweisung, Coding-Tasks an `code_agent` (Claude Code, Codex etc.) zu delegieren statt selbst zu beantworten — `action: "run"` für einfache, `action: "orchestrate"` für komplexe Aufgaben

## [0.9.48] - 2026-03-02

### Fixed
- **Agent-Erkennung im Setup-Wizard**: `which`/`where` findet CLI-Tools nicht wenn `~/.local/bin` nicht im PATH ist (z.B. nvm-Setups auf macOS). Fallback prüft jetzt `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, npm-global-Pfade
- Erkannte Agents verwenden den aufgelösten absoluten Pfad als `command`, sodass sie auch ohne PATH-Eintrag funktionieren

## [0.9.47] - 2026-03-02

### Changed
- **Forge: Auto-Detect Remote + Projekt-Erstellung** — Owner/Repo wird zur Laufzeit aus `git remote -v` gelesen, nicht mehr in der Config gespeichert
- `owner`, `repo` (GitHub) und `projectId` (GitLab) aus ForgeConfig, Zod-Schemas, ENV-Map und Setup-Wizard entfernt — nur Token + baseUrl bleiben global
- `createPullRequest()` und `getPipelineStatus()` nehmen jetzt `RepoIdentifier` als Parameter statt Konstruktor-Config

### Added
- `parseRemoteUrl()` — erkennt SSH/HTTPS Remote-URLs (GitHub, GitLab, Self-hosted, mit/ohne `.git`)
- `gitGetRemoteUrl()`, `gitInitRepo()`, `gitAddRemote()` in git-ops
- `ForgeClient.createProject()` — erstellt Repositories auf GitHub (`POST /user/repos`) und GitLab (`POST /api/v4/projects`)
- `orchestrateWithGit()` initialisiert bei Bedarf ein Git-Repo, erkennt Remote automatisch, erstellt Projekt auf Forge falls kein Remote existiert

### Removed
- ENV-Variablen: `ALFRED_GITHUB_OWNER`, `ALFRED_GITHUB_REPO`, `ALFRED_GITLAB_PROJECT_ID`
- Setup-Wizard: Owner/Repo/ProjectId-Fragen entfernt (nur noch Provider + Token)

## [0.9.46] - 2026-03-02

### Added
- **Code Agent Auto-Detection im Setup-Wizard**: Erkennt automatisch installierte CLI-Tools (Claude Code, Codex, Aider, Gemini CLI) via `which`/`where` und bietet sie zur Auswahl an
- Bestehende custom Agents aus der Config werden erkannt und beibehalten
- Agents und Forge-Integration werden in einem gemeinsamen `codeAgents`-Block zusammengeführt

## [0.9.45] - 2026-03-02

### Added
- **Forge-Integration im Setup-Wizard**: GitHub/GitLab Provider-Auswahl, Token und Owner/Repo bzw. ProjectId interaktiv konfigurierbar
- ENV-Variablen und YAML-Config werden automatisch geschrieben

## [0.9.44] - 2026-03-02

### Added
- **Git + Forge Integration** für code_agent orchestrate: automatisches Branching, Commit, Push und PR/MR-Erstellung (GitHub REST v3, GitLab REST v4)
- `orchestrateWithGit()` als Wrapper um die bestehende Orchestrierung
- Git CLI Wrapper via `execFile` (branch, stage, commit, push) — kein Shell-Injection-Risiko
- Abstraktes ForgeClient-Pattern mit GitHub- und GitLab-Implementierung via native `fetch`
- ForgeConfig in Types, Zod-Schemas und ENV-Overrides (`ALFRED_FORGE_*`, `ALFRED_GITHUB_*`, `ALFRED_GITLAB_*`)

### Changed
- `CodeAgentSkill` unterstützt `git`, `prTitle` und `baseBranch` als Input-Parameter
- `CodeAgentsConfig` um optionale `forge`-Konfiguration erweitert

## [0.9.43] - 2026-02-28

### Added
- **code_agent orchestrate**: LLM-gesteuertes Multi-Agent Task-Splitting mit paralleler Ausführung und Validation-Loop
- Automatische Aufgabenzerlegung via LLM (Planning → Execution → Validation)
- Semaphore-basierte Concurrency-Kontrolle für parallele Agent-Ausführung

## [0.9.42] - 2026-02-27

### Added
- **code_agent Skill**: Generischer CLI Coding-Agent Orchestrator (Claude Code, Codex, Gemini CLI, Aider etc.)
- Agent-Executor mit `execFile`, Timeout-Handling, Modified-Files-Tracking
- Aktionen: `list_agents`, `run`, `orchestrate`

## [0.9.41] - 2026-02-26

### Changed
- Kontext-Fenster Budgetierung: Memory Token-Budget + Tool-Loop Re-Trimming
- LLM-Guidance bei großen Dateien zu kompaktem datengetriebenen Code
- `file.write` verweist LLM bei fehlender Content-Angabe auf code_sandbox

## [0.9.40] - 2026-02-24

### Fixed
- code_sandbox sammelt HTML, TXT, MD, XML, PDF Dateien ein

## [0.9.39] - 2026-02-23

### Fixed
- ProactiveScheduler nutzt volle MessagePipeline für promptTemplate

## [0.9.38] - 2026-02-22

### Fixed
- API-Adapter finale Antwort als sendMessage statt editMessage

## [0.9.37] - 2026-02-21

### Added
- **HTTP API Server** + CLI Client Mode
- Mistral AI Provider + Modellauswahl im Setup-Wizard

### Fixed
- Matrix Media-Download nutzt authentifizierten Endpoint
- Cross-Platform Reminder-Zustellung, Matrix Voice Retry

## [0.9.13] - 2026-02-14

### Fixed
- Synthetic Label Detection für File-Uploads + Memory Retrieval
- Skip Memory Loading für Media ohne Captions
- Repeated Tool-Error Detection und Loop-Abbruch
- Prompt: Ask when intent is unclear, stop retrying failed tools

## [0.9.7] - 2026-02-10

### Fixed
- Summarize trimmed messages statt Drop
- System Prompt: Ask before acting, Reconnect on Follow-ups

## [0.9.5] - 2026-02-08

### Changed
- Timeout-basiertes Tool-Loop statt hartem Iterations-Limit

### Fixed
- No-Response nach Tool-Iterationen, Max-Iterations Orphan, Block-Level Sanitizer

## [0.9.0] - 2026-02-04

### Added
- **Active Learning & Smart Memory**: automatische Wissensextraktion aus Konversationen
- Embedding-basiertes Memory Retrieval

## [0.8.2] - 2026-01-30

### Added
- Setup-Wizard mit OpenWebUI-Support und Base-URL für alle Provider

## [0.8.1] - 2026-01-29

### Added
- **Multi-Model Routing**: default/strong/fast/embeddings/local
- OpenWebUI Provider
- Chat CLI (`alfred chat`)

## [0.8.0] - 2026-01-25

### Added
- **7 Superpowers**: Parallele Agents, Background Tasks, Proaktivität, MCP, Cross-Platform Identity, Code Sandbox, Document Intelligence

## [0.7.0] - 2026-01-18

### Added
- RAG (Document Intelligence), Kalender-Integration, User-Profile
- Markdown/HTML Response-Formatierung

## [0.6.0] - 2026-01-15

### Added
- Multi-modal Support (Bilder, Dateien, Voice)
- File Attachments für alle Adapter

## [0.4.0] - 2026-01-10

### Added
- Telegram Live-Status Updates
- Dynamische Tool-Descriptions

## [0.3.0] - 2026-01-06

### Added
- Web-Suche (Brave, SearXNG, Tavily, DuckDuckGo)
- Email (IMAP/SMTP)
- Context-Window-Management

## [0.2.0] - 2026-01-03

### Added
- Shell Skill, Memory Skill, Sub-Agents (DelegateSkill)
- Persistente Reminders

## [0.1.0] - 2025-12-28

### Added
- Initial Release: Telegram Bot mit Anthropic/OpenAI LLM
- Sicherheitssystem mit YAML-Regeln
- Multi-Plattform Messaging (Discord, Matrix, WhatsApp, Signal)
- Multi-Provider LLM (OpenAI, OpenRouter, Ollama)
- CLI-Tool & Plugin-System
- Installer + interaktiver Setup-Wizard
