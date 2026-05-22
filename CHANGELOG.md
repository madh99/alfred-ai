# Changelog

Alle relevanten Änderungen an Alfred werden in dieser Datei dokumentiert.
Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [Unreleased]

## [0.19.0-multi-ha.698] - 2026-05-22

### Added — Sandbox-Preview Internal Proxy (Phase 3/5)

Internal HTTP- + WebSocket-Proxy für `/preview/<sandboxId>/*` direkt im Alfred-HTTP-Server. Keine externe NPM/Nginx-Komponente nötig, Auth über existing Session-Token, Same-Origin → keine Cookie-/CORS-Sorgen.

**Wie es funktioniert:**

1. WebUI mountet iframe mit `src="/preview/<sandboxId>/?_alfred_auth=<token>"`
2. Alfred-Proxy liest Query-Token, validiert (Token → User → Sandbox-Ownership → Status='running' → hostPort)
3. Setzt path-scoped Cookie `__alfred_preview_token=<token>; Path=/preview/<sid>/; HttpOnly; SameSite=Strict; Secure` und redirected auf URL ohne Query
4. Subsequent Requests carry Cookie automatisch (auch Sub-Resources des Dev-Servers + WebSocket-Upgrade)
5. Jeder Request: gleicher Auth-Check, dann HTTP-Proxy via `http.request()` zu `localhost:hostPort` mit Path-Rewriting
6. WebSocket-Upgrade (HMR): hijackt den Socket, baut TCP-Connect zu Upstream, pipet beide Sockets bidirectional

**Sicherheit:**
- Auth-Subrequest pro Request: Token + Ownership + Status → 401/403/404/409 mit klarer HTML-Error-Page
- Alfred-Cookies + Authorization-Header werden zum Dev-Server NICHT weitergegeben (kein Cross-Origin-Leak)
- X-Forwarded-Proto/Host/Prefix korrekt gesetzt
- Cookie ist `HttpOnly` + `SameSite=Strict` + `Secure` (bei HTTPS)
- Activity-Touch pro Request (resets idle-timer für v700-Cleanup)

**Was funktioniert:**
- HTTP-GET/POST/PUT/DELETE/PATCH/HEAD → transparent durchgereicht
- WebSocket-Upgrade für HMR (Vite/Next/Astro)
- Sub-Resources des Dev-Servers (relative URLs funktionieren wegen `Path=/preview/<sid>/`)
- Hop-by-hop-Headers korrekt entfernt (Connection, Upgrade, Transfer-Encoding)

**Was NICHT funktioniert (out-of-scope):**
- Andere WebSocket-Routes als Sandbox-Preview (Server-Upgrade-Handler verwirft alles andere mit 404)
- Streaming-Responses mit Server-Sent-Events durch den Proxy — werden trotzdem geforwarded, aber nicht aktiv getestet

**Geänderte Dateien:**
- `packages/messaging/src/adapters/http.ts`:
  - Neues Callback-Feld `sandboxProxyResolve` + Setter `setSandboxProxyResolver`
  - Path-Match `/preview/<sandboxId>/...` (mindestens 8 Zeichen sandboxId) im handleRequest
  - `server.on('upgrade')` für WebSocket-Upgrade-Hijack
  - `handleSandboxProxyHttp` (Cookie-flow + http-proxy)
  - `handleSandboxProxyUpgrade` (TCP-tunnel mit HTTP-handshake-rebuild)
- `packages/core/src/alfred.ts`: Proxy-Resolver registriert nach Sandbox-Skill-Wiring

### Backward-Compatibility — weiterhin garantiert
- ProjectAgentRunner: unverändert
- `/preview/*`-Path war vorher nicht belegt → keine Kollision
- Wenn Sandbox-Feature disabled: Proxy-Resolver wird nicht gesetzt → jeder /preview/-Request landet auf der 503-Page
- Existierende WebSocket-Endpunkte? Es gibt keine — der Upgrade-Handler wirft alle anderen Pfade mit 404 zurück

### Test-Möglichkeit nach Deploy
1. Sandbox via API/Skill erstellen (v697-Pfad)
2. Status checken: `sandbox list` → host_port + status='running'
3. WebUI hat noch keinen iframe-Embed (v699), aber manuell testbar:
   `curl -L 'https://alfred.local/preview/<SANDBOX_ID>/?_alfred_auth=<TOKEN>'`
4. HTML des Dev-Servers sollte zurückkommen
5. WS-Test via `wscat` oder Browser-DevTools sobald iframe da ist

## [0.19.0-multi-ha.697] - 2026-05-22

### Added — Sandbox Lifecycle: Worktree + Container + Dev-Server (Phase 2/5)

Auf v696-Foundation aufbauend: vollständiger Sandbox-Lebenszyklus inkl. Worktree-Verwaltung, Docker-Container-Orchestrierung, Project-Type-Detection und Dev-Server-Health-Check. Weiterhin **kein User-facing Verhalten in der WebUI** — Lifecycle nur via neuem `sandbox`-Skill oder direkter SandboxManager-API ansprechbar.

**Neue Files:**
- `packages/core/src/sandbox/worktree.ts` — `createWorktree`, `destroyWorktree`, `listWorktrees`, `validateGitRepo` mit atomarem Rollback und Branch-Konflikt-Handling (Suffix-Fallback)
- `packages/core/src/sandbox/project-detect.ts` — `detectProjectType` mit Heuristiken für Next/Astro/Remix/CRA/Vite + generic Node, inkl. Package-Manager-Detection (pnpm/npm/yarn) via Lockfile
- `packages/core/src/sandbox/port-allocator.ts` — `findFreePort` mit DB-Check + OS-TCP-Bind-Test, Range 9100-9199 default
- `packages/core/src/sandbox/docker.ts` — `runSandboxContainer`, `stopContainer`, `startContainer`, `removeContainer`, `getContainerStats`, `waitForDevServer` (HTTP-Probe mit 5 min Timeout), `ensureImage` (auto-build on first use), `streamContainerLogs` (AsyncIterable)
- `packages/cli/sandbox-images/Dockerfile.node-22` — Base-Image (Alpine + Node 22 + pnpm + git + dumb-init), non-root user, no-new-privileges, cap-drop ALL
- `packages/skills/src/built-in/sandbox.ts` — `SandboxSkill` (Actions: status, list, pause, resume, discard, destroy, cleanup_idle) für CLI/Memory-Skill-Trigger und v700-Cleanup-Worker
- `scripts/bundle.mjs` — kopiert nun auch `sandbox-images/` ins Bundle

**Erweitert:**
- `SandboxManager.createForSession()` — voller Flow: Quota-Check → Worktree → DB-Insert → (optional) Image-Build → Port-Allocation → Container-Run → Health-Wait → DB-Update. Bei jedem Fehler vollständiger Rollback (Container weg, Worktree weg, Branch weg, Status='failed').
- `SandboxManager.pause()` / `resume()` / `discard()` / `destroy()` implementiert
- `SandboxManager.merge()` bleibt für v700 (PR-API + Pre-Merge-Secret-Scan)
- `alfred.ts`: registriert `SandboxSkill` mit allen Callbacks (incl. Project-Cwd-Resolver via `ProjectRepository.getByIdAnyOwner`)

**Container-Konfiguration:**
- Resource-Limits: 2 GB RAM, 2 CPU-Cores, no-swap
- Security: `--security-opt=no-new-privileges`, `--cap-drop ALL`, non-root UID/GID 1000
- Volumes: worktree → `/workspace`, optional shared pnpm-store → `/pnpm-store`
- Network: standard bridge, Outbound erlaubt (npm install), Inbound nur via Port-Forward
- Default-Command: `pnpm install && exec <devCommand>` (devCommand aus project-detect)

**Lifecycle-Übersicht:**
| Action | Worktree | Container | Branch | Status |
|---|---|---|---|---|
| create | erstellt | gestartet (preview/interactive) | erstellt | creating → running |
| pause | bleibt | stop | bleibt | paused |
| resume | bleibt | start | bleibt | paused → running |
| discard | weg | weg | weg | discarded |
| destroy | weg | weg | weg | cleaned |
| merge (v700) | weg | weg | gepusht/gemerged | merging → cleaned |

### Backward-Compatibility — weiterhin garantiert
- ProjectAgentRunner v697-Code-Pfad unverändert (Sandbox-Mode-Switch kommt erst in v699 mit UI)
- Wenn `config.sandbox.enabled` false oder Docker fehlt: SandboxManager bleibt undefined, `SandboxSkill` wird nicht registriert
- Existierende Sessions: `mode='classic'` durch v696-Migration

### Manueller Test ab v697 möglich
Nach Aktivierung via `ALFRED_SANDBOX_ENABLED=true` + `ALFRED_SANDBOX_WORKTREE_BASE_PATH=...`:
1. Image-Build automatisch beim ersten Sandbox-Create (~1-3 min initial)
2. Sandbox-Status via Skill: `sandbox status` → zeigt available + dockerAvailable + worktreeBaseWritable
3. Aktive Sandboxes auflisten: `sandbox list`
4. Pause/Resume/Discard via `sandbox pause sandbox_id=…`

`createForSession` selbst ist API-only — UI-Trigger kommt in v699.

## [0.19.0-multi-ha.696] - 2026-05-22

### Added — Project-Agent Sandbox + Live-Preview: Foundation (Phase 1/5)

Vorbereitende Infrastruktur für ephemere Worktree+Container-Sessions mit Live-Preview. **In dieser Version: kein User-facing Verhalten.** Alle existierenden Sessions laufen 1:1 wie heute weiter. Die Sandbox-Funktion ist opt-in über `config.sandbox.enabled = true` UND setzt verfügbares Docker + beschreibbaren Worktree-Pfad voraus. Ohne beides: SandboxManager bleibt `undefined`, classic-Pfad ist Default.

**Was kommt nach v696:**
- v697: Worktree-Lifecycle + Container-Spawn + Project-Type-Detection
- v698: Internal-Proxy `/preview/{id}/*` (HTTP + WebSocket-HMR)
- v699: WebUI (autonom-Tabs + interactive-chat-Mode)
- v700: Hardening (Cleanup, HA-Migration via NFS-aware path, Pre-Merge-Secret-Scan)

**Geänderte Dateien:**
- `@alfred/types`: `SandboxConfig`, `SandboxSessionMode`, `SandboxMergeStrategy`
- `@alfred/config`: `SandboxConfigSchema` (Zod) + ENV-Overrides für 13 Felder (`ALFRED_SANDBOX_*`)
- `@alfred/storage`:
  - Migration v87 (SQLite) + v90 (PG): Tabelle `project_agent_sandboxes`, neue Spalte `project_agent_sessions.mode` (default `'classic'`), neue Spalten `projects.sandbox_default_mode` + `projects.merge_strategy`
  - Neuer `SandboxRepository` mit vollem CRUD (create, getById, listByProject, listActiveByUser, updateStatus, setContainerInfo, touchActivity, markDestroyed, …)
- `@alfred/core`:
  - Neue Klasse `SandboxManager` (Skelett — Lifecycle-Methoden werfen `not-implemented`, werden in v697+ gefüllt)
  - `runHealthCheck()` prüft Docker-Daemon + Worktree-Base-Pfad und entscheidet ob das Feature überhaupt nutzbar ist
  - `isAvailable()` + `getStatus()` als Diagnose-Hooks für künftige UI/API-Endpunkte
  - `checkUserQuota()` prüft `maxParallelPerUser` + `diskQuotaPerUserMb` (für Phase 2 nutzbar)
  - Wiring in `alfred.ts`: lazy-Init nur wenn `config.sandbox.enabled` true UND Health-Check ✓. Bei Fehler: warn-Log, classic-Pfad bleibt aktiv.

### Backward-Compatibility — explizit garantiert

- Alle existierenden Sessions: `mode = 'classic'` durch Migration-Default
- Existierende Projects: `sandbox_default_mode = NULL` und `merge_strategy = NULL` → Global-Default greift (= classic, da default-enabled = false)
- ProjectAgentRunner: keine Code-Änderung in v696. Wird in v697 um eine vorab-Verzweigung erweitert.
- Wenn `config.sandbox` komplett fehlt: SandboxManager wird nie initialisiert
- Wenn Docker fehlt: SandboxManager wird initialisiert, aber `isAvailable() = false` → Runner sieht es nicht
- Beim Upgrade ohne Aktivierung: NULL Code-Path-Änderung gegenüber v695

### Default-Werte
| Feld | Default |
|---|---|
| `enabled` | false |
| `defaultMode` | 'classic' |
| `defaultMergeStrategy` | 'pr' |
| `maxParallelPerUser` | 3 |
| `diskQuotaPerUserMb` | 5120 (5 GB) |
| `diskQuotaPerSandboxMb` | 2048 (2 GB) |
| `hostPortRangeStart` / `End` | 9100 / 9199 |
| `idleTimeoutMin` | 30 |
| `cleanupAfterHours` | 24 |
| `worktreeBasePath` | `/var/alfred/worktrees` (HA-Cluster: NFS-Mount empfohlen) |
| `containerImage` | `alfred-sandbox:node-22` (gebaut beim ersten Use in v697) |
| `pnpmStorePath` | null |

## [0.19.0-multi-ha.695] - 2026-05-22

### Fixed — kg-gap-adapter: ehrliche Existenz-Checks statt naive Attribut-Lücken

v694 hat die Insight-Engine zum Laufen gebracht — aber der KG-Gap-Adapter spammt mit Karten wie „Beziehung zu Tochter Hannah unklar" (Name enthält die Beziehung!), „Beziehung zu Alexandra unklar" (Memory weiß sie ist die Frau), „Adresse für Alleestraße 6 fehlt" (Name IST die Adresse), „Adresse für St. Pölten fehlt" (das ist eine Stadt). Root-Cause: Adapter prüfte ausschließlich `entity.attributes` und ignorierte (a) den Namen selbst, (b) `kg_relations`-Edges (Familien-Inferenz schreibt dorthin), (c) `memories`-Inhalte.

**A — Name-basierte Heuristiken** in `kg-gap-adapter.ts`:
- `RELATION_PREFIX_RE` (de): Sohn/Tochter/Mutter/Vater/Mama/Papa/Schwester/Bruder/Oma/Opa/Tante/Onkel/Cousin/Mann/Frau/Partner/Freund/Kollege/Chef/Nachbar/Schwager/Schwägerin/Schwiegermutter/Schwiegervater/Schwiegersohn/Schwiegertochter — Match überspringt Beziehungs-Gap
- `STREET_WITH_NUMBER_RE`: Straßen-Suffix + Hausnummer → Name IST die Adresse → Skip
- `STREET_IN_NAME_RE`: Straßen-Suffix ohne Nummer → noch immer Adress-Information → Skip
- `PLACE_NAME_RE`: Stadt/Ort-Pattern (Großbuchstaben, kein Suffix, keine Nummer, ≤30 Zeichen) → Skip Adresse-Gap

**B — KG-Relations-Check:** neue Adapter-Dependency `KgGapDataFacade.listRelationsForEntity(uids, entityId)`. Bei Person-Beziehungs-Gap wird abgefragt ob bereits eine Edge mit Type `sibling | parent_of | child_of | spouse | spouse_of | friend | colleague | relates_to_owner | family_of | partner_of | married_to | parent | child` existiert. Bei Birthday-Gap: `birthday | born_on | has_birthday`. Wenn ja → Skip.

**C — Memory-Text-Check:** Facade-Methode `listMemoryValues(uids)` lädt einmal pro Sweep ALLE memory.value-Strings, in-memory wird zeilenweise gegen `name LIKE` + Keyword-Regex (Relation/Birthday/Adresse/Org-Info) gematcht. Wenn Treffer → Skip. Keine N+1-Queries.

**D — Bulk-Dismiss-Endpoint + WebUI-Button:** Damit die alten Noise-Karten nicht einzeln weggeklickt werden müssen:
- `InsightsRepository.dismissCategory(userId, category)` setzt alle pending/snoozed einer Kategorie auf dismissed
- `POST /api/insights/dismiss-category` mit Body `{ category }`
- WebUI `/insights`: zusätzlicher Button „✕ Alle erledigen (N)" erscheint nur wenn ein Kategorie-Filter + Status=pending + N>0

**E — Backward-Compatibility:** Wenn `KgGapDataFacade` nicht verfügbar (Storage-Init-Fehler), fällt der Adapter auf reines `entity.attributes`-Verhalten zurück (v638-Level, kein Crash).

### Beobachtbar in den Karten
- **„Beziehung zu Tochter Hannah unklar"** → weg (Name-Regex)
- **„Beziehung zu Sohn Noah unklar"** → weg (Name-Regex)
- **„Beziehung zu Sabine unklar"** → weg wenn Memory „Sabine ist meine Schwester" enthält
- **„Beziehung zu Alexandra unklar"** → weg wenn Memory Ehe-Hinweis enthält
- **„Adresse für Alleestraße 6 fehlt"** → weg (Adress-Pattern im Namen)
- **„Adresse für Viktor Kaplan Straße 12 fehlt"** → weg
- **„Adresse für St. Pölten fehlt"** → weg (Stadt-Erkennung)
- **„Adresse für Mittelschule Laabental fehlt"** → bleibt (kein Pattern-Match, sinnvoller Gap)

### Beeinträchtigt nichts
- v694 Legacy-UID-Brücke unverändert
- Wenn keine Memories existieren: Adapter funktioniert weiter, fängt nur weniger Spam ab
- Question-Generator nutzt eigenen Pfad (unverändert)

## [0.19.0-multi-ha.694] - 2026-05-22

### Fixed — Insight-Engine produziert 0 Insights: Legacy-UID-Brücke + Canonical-Merge

Live-Befund: Tabelle `alfred_insights` ist leer, alle 6 Adapter (kg-gap, open-loop, cross-source-mention, calendar-mismatch, goal-drift, infra-forecast) liefern 0 — obwohl 2460 KG-Entities, 17 Conversations und reichlich BMW-Telemetrie vorhanden sind. Root-Cause: Sweep läuft mit `ownerMasterUserId` (admin in alfred_users), aber alle Quelldaten leben unter einer Legacy-UID aus der Zeit vor der Multi-User-Migration. Diese Legacy-UID steht nicht in `alfred_users` und nicht in `user_platform_links` → linkedUserIds enthielt sie nicht → Adapter sahen nichts.

**A — Legacy-Data-UID-Discovery (alfred.ts):** Beim Startup wird einmal gescannt, ob in `kg_entities` / `conversations` user-ids mit >50 Zeilen existieren, die NICHT in `alfred_users` stehen und NICHT die owner-uid sind. Diese werden als `legacyDataUids` gecacht. Discovery ist read-only und Idempotent.

**B — Owner-Gate (Risk-Mitigation):** Neue Helper-Methode `withLegacyForOwner(uid, linked)` erweitert linkedUserIds nur dann um Legacy-UIDs, wenn `uid === ownerMasterUserId`. Verhindert dass Gast-User (z.B. `alex`) Owner-Daten in ihren Insights sehen.

**C — Brücke an allen Sweep-Callsites:** Drei Sweep-Aufrufe in `alfred.ts` ziehen die Legacy-Brücke jetzt mit:
- Daily 09:00 lokal-Timer
- `insightsSkill.setSweepCallback` (manuelle Trigger via Memory-Skill)
- `/api/insights/sweep` Endpoint (WebUI „🔄 Sweep jetzt"-Button)

Zusätzlich gleiche Brücke im wöchentlichen Goal-Extractor (So 21:00) + täglichen KG-Question-Generator (18:00).

**D — KG-Facade Canonical-Merge (Risk A — Infinite-Re-Surface verhindert):** Die Facade-Signatur wechselt von `listEntities(userId: string)` auf `listEntities(userIds: string[])`. Beim Merge werden Entities mit gleichem `(entity_type + normalized_name)` über alle UIDs zusammengeführt:
- attributes-merge: erstes nicht-leeres Value gewinnt pro Attribut
- mention_count = max
- stable id = lexikalisch kleinste id der Duplikate → deterministisches dedupeKey über Sweeps hinweg

Effekt: Wenn der User Birthday via Memory-Skill auf der NEUEN Master-UID ergänzt, aber die OLD-Legacy-UID-Entity ohne Birthday bleibt, sieht der Adapter dank Merge die gefüllte Variante → kein Spam mehr.

**E — Cross-Source-Mention KEYWORD_PATTERNS erweitert (5 → 15):** Zusätzliche Patterns für Lieferungen (DPD/Hermes/Post), Kulturevents, Fahrzeug-Service (TÜV/Pickerl/§57a), Feiern, Trainings, Abholungen, Schule/Kita, Behörden, Beauty/Wellness, Job-Interviews. Alle harten Time-Anchors (am/um/nächst…/Wochentag) reduzieren False-Positives drastisch.

### Berücksichtigte Risiken
- **Risk A (Infinite-Re-Surface):** durch Canonical-Merge in KG-Facade abgefangen
- **Risk B (Multi-User-Kontamination):** durch Owner-Gate (`withLegacyForOwner`) abgefangen
- **Risk C (Question-Generator + Insights-Callback):** alle 3 Sweep-Callsites + Question-Generator + Goal-Extractor migriert; Facade-Signaturänderung an beiden Call-Sites synchron
- **Risk D (WebUI):** geprüft — `/insights`-Seite existiert bereits vollständig (Sweep/Snooze/Dismiss/Act/Filter); keine UI-Arbeit nötig
- `cmdb_metric_samples` und `alfred_goals` bleiben leer — separate PRs (infra-forecast und Goals brauchen eigene Data-Sourcen, außerhalb v694-Scope)

### Beobachtbar im Server-Log
- `"v694 Legacy data UIDs discovered"` — beim Startup, mit count + uid-Liste
- `"Insight sweep complete"` mit `inserted: >0` und nicht mehr alle Adapter auf 0

### Beeinträchtigt nichts
- Briefing-Queue (`deferred_insights`, 458 Zeilen) ist unabhängig — Reasoning-Briefings auf Telegram laufen unverändert
- Wenn keine Legacy-UID gefunden wird (frische Installation): Verhalten identisch zu v693
- Gast-User-Insights bleiben strikt auf eigene Daten beschränkt

## [0.19.0-multi-ha.693] - 2026-05-22

### Changed — Reasoning-Engine: gibt nicht mehr beim ersten Fail auf

Drei Erweiterungen damit das LLM proaktive Aktionen kreativer löst statt früh „Aktion nicht möglich" zu antworten:

**A — LLM-Self-Heal:** Wenn `executeDirectly()` failed (z.B. weil eine Skill-Action nicht existiert, Permissions fehlen, oder ein anderer Skill-Fehler kommt), wird ein **zweiter LLM-Pass** gestartet mit:
- Original-Action (description, skillName, skillParams)
- Konkrete Fehlermeldung
- Liste aller Skills + ihrer echten Actions (max 12 pro Skill)
- Instruktion: Schlage eine korrigierte Action vor ODER antworte mit `GIVE_UP`

Bei valider JSON-Antwort wird die alternative Action ausgeführt. Bei Erfolg sieht der User „⚡ Proaktiv ausgeführt: …" mit der gehealten Description. Bei wiederholtem Fail kommt jetzt eine ehrliche Nachricht („… auch eine Alternative gesucht — keiner der Wege funktioniert mit den aktuellen Skills") inklusive Error-Details.

**B — Prompt-Improvement:** Reasoning-Detail-Prompt um `ACTION-DESIGN-REGELN`-Block erweitert: „GIB NIEMALS AUF wenn ein Tool nicht direkt passt. Probiere 2-3 Wege (watch, scheduled_task, workflow) bevor du eine Aktion verwirfst. NIEMALS Action-Namen erfinden — verwende nur die in den Skill-Descriptions gelisteten."

**C — Pattern-Cookbook im Prompt:** Konkrete Beispiele für typische Use-Cases:
- „Täglich X-Anzahl beobachten" → `watch.create` mit `list_X` + `count`/`length` als condition_field
- „Wert regelmäßig irgendwo hinschreiben" → `scheduled_task.create` mit Prompt
- „Schritt-Folge automatisieren" → `workflow.create`
- Plus expliziter UniFi-Hinweis: `list_alerts` (NICHT `get_alerts`)

### Beobachtbar im Server-Log
- `"Reasoning: trying LLM self-heal"` — wenn ein erster Versuch failed
- `"Reasoning: LLM proposed alternative — retrying"` — wenn der zweite Pass eine Korrektur lieferte
- `"Reasoning: proactive action failed (after self-heal)"` — wenn auch der zweite Pass nicht helfen konnte

### Beeinträchtigt nichts
- Confirmation-Queue / direkter Skill-Call / WebUI-Modal: unverändert
- Self-Heal-LLM-Pass kostet nur 1 zusätzlichen LLM-Call PRO FAILED proaktiver Action (selten)
- v692 Fuzzy-Match bleibt als erste Verteidigung — v693 ist die zweite (LLM-basierte) Schicht

## [0.19.0-multi-ha.692] - 2026-05-22

### Fixed — Reasoning-Engine: Halluzinierte Skill-Action-Namen führten zu „Aktion nicht möglich"

**Root-Cause:** Das Reasoning-LLM hat in seinen proaktiven Aktionen Skill-Action-Namen halluziniert (z. B. `unifi.get_alerts` statt korrekt `unifi.list_alerts`). Die Reasoning-Engine validierte nur das **eigene** Skill-Schema (z. B. `watch.action=create` war OK), nicht aber **nested** `skill_params.action` für Target-Skills. Beim echten Skill-Run schlug es dann fehl mit `Skill "unifi" has no action "get_alerts"` — User bekam eine „Aktion nicht möglich"-Meldung statt der gewünschten Watch.

**Fix (Variante B+C kombiniert):**
- **B — Pre-Validation:** Neue Methode `validateAndHealAction()` prüft VOR dem Execute beide Action-Schichten (Top-Level + nested `skill_params.action` für `watch` und `scheduled_task`).
- **C — Self-Heal mit Fuzzy-Match:** Bei Mismatch wird `findClosestAction()` aufgerufen:
  1. Token-Match: Snake-case-tokens vergleichen (`get_alerts` → Token `alerts` matched `list_alerts`)
  2. Levenshtein-Fallback: max 3-4 Edits oder 40% der String-Länge
  - Bei Match → Action automatisch korrigiert, Memory `correction_skill_action_<skill>_<wrong>` gespeichert mit category=`correction`
  - Bei kein Match → klare Reject-Nachricht mit Valid-Actions-Liste
- **Correction-Memory:** Wird via `upsertSystemMemory` geschrieben (umgeht Guards), erscheint im Prompt-Block beim nächsten Reasoning-Run → LLM lernt die richtige Action.

### Wirkung
- **Direkt:** „Aktion nicht möglich"-Meldungen sollten praktisch verschwinden — entweder Auto-Korrektur oder klare Reject-Begründung
- **Lernend:** Beim nächsten gleichen Skill kennt das LLM die richtige Action (Correction-Block im Prompt)
- **Andere Pfade:** Confirmation-Queue / direkter Skill-Call / WebUI-Modal unverändert

## [0.19.0-multi-ha.691] - 2026-05-22

### Fixed — Deploy-Skill: Memory-Save lief silent ins Leere bei Chat/Telegram-Triggern

**Root-Cause:** Der Deploy-Skill schreibt seine Erfolgs-Memory in einem stillen try-catch ohne jegliches Logging. Wenn der Save scheiterte (z.B. `ownerUserId` undefined, oder UPSERT-Guard greift weil ein alter `source='manual'`-Eintrag den Key blockiert), wusste niemand davon.

Konkret heute beobachtet: Drei Deploys, nur EINER hat die Memory aktualisiert (der WebUI-Modal-Deploy via v679-Backup-Pfad in `alfred.ts`). Project-Chat-Deploy und Telegram-Action-Card-Deploy → Skill-Aufruf success=true, aber DB-Row unverändert.

**Fix in `deploy.ts:425`:**
- `upsertSystemMemory()` (v689) statt `saveWithMetadata()` → umgeht manual-/correction-Guards, sodass System-Auto-Writes greifen auch wenn der Key schonmal manuell belegt war. Fallback auf `saveWithMetadata` falls die Repo-Version die neue Methode nicht hat.
- Bei `!memoryRepo || !ownerUserId` → `console.warn` mit Diagnose (statt silent skip)
- Bei Erfolg → `console.info "memory written via upsertSystemMemory key=…"` damit man im Log nachvollziehen kann
- Bei Fehler → `console.warn` mit `err.message` (kein silent catch mehr)

**Wirkung:**
- WebUI-Modal-Deploys: unverändert (Pfad B in alfred.ts schreibt eh)
- Chat-/Telegram-/Confirmation-Deploys: Memory wird jetzt zuverlässig geschrieben (Pfad A repariert)
- Bei zukünftigen Memory-Problemen sehen wir im Log sofort den Grund statt rätselraten

## [0.19.0-multi-ha.690] - 2026-05-22

### Added — Project-Chat: Expand-Mode mit Side-Panel + Live-View

Neuer 🔲 **Vergrößern**-Button im Project-Chat öffnet den Chat als Full-Screen-Overlay mit zweispaltigem Layout:

- **Links (60%):** Chat mit allen Features (Messages, Toolbar 📌 📎, @-Mention, Drag&Drop)
- **Rechts (40%):**
  - 🟢 **Running**-Liste oben: alle aktuell laufenden Project-Agent-Sessions (Polling alle 5s)
  - Klick auf eine Session → unten die **Live-View** mit Header (Phase/Iter/Files/Dauer), Live-Output-Stream, Interject-Input, Stop-Button (oder Resume bei done/failed)
- **Esc** oder ✕ schließt den Expand-Mode

**Architektur:**
- Neue Komponente `SessionLivePane` (extrahiert aus ProjectAgentsPage in einen wiederverwendbaren Block, kompakt-mode für Side-Panel)
- ProjectAgentsPage bleibt unverändert in Funktion (keine Regression)
- ProjectChat erweitert um `expandedFull`-State + Overlay-Layout + Polling für running sessions
- `renderChatBody({ fillHeight })`-Helper, beide Modi (Default + Expand) nutzen dasselbe JSX

## [0.19.0-multi-ha.689] - 2026-05-22

### Fixed — Letzte Deploys: alter manueller Memory-Eintrag blockierte Auto-Updates

**Root-Cause:** `saveWithMetadata` hat zwei Guards (sinnvoll für User-Schutz):
- `auto` darf `manual` NICHT überschreiben
- `auto` darf `correction`-Typen NICHT überschreiben

Der `deploy_alpbyte-games_192_168_1_96`-Eintrag wurde am 20.05. vom User im Chat manuell angelegt mit `source='manual'`. Mein v679/v686-Memory-Write läuft durch (Log `Deploy memory written`), aber UPDATE-SET wird vom Guard übersprungen → DB-Row bleibt mit altem freitext + `category='general'`. `lastDeploys`-Parser filtert `category!='deployment'` raus → Modal leer.

**Fix:**
- **A — One-shot SQL** (bereits ausgeführt): existierender Alpbyte-Eintrag umgestellt auf `source='auto'`, `category='deployment'`, strukturiertes Format. Sofort lesbar im Modal.
- **B — v689 Code-Fix:** Neue Methode `memoryRepo.upsertSystemMemory()` ohne Guards für system-managed Keys. `triggerDeploy` und `project-workspace-Auto-Save` nutzen sie jetzt. Künftige Deploys auf andere Projekte mit alten manuellen Memory-Einträgen funktionieren ohne weiteren Eingriff.

**Konsequenz:**
- WebUI Modal „Letzte Deploys" zeigt jetzt deinen aktuellen Alpbyte-Deploy
- Nächster Deploy überschreibt automatisch (kein manual-Guard mehr für system-Keys)

## [0.19.0-multi-ha.688] - 2026-05-22

### Added — Projekte-Seite: Info-Banner „Aktuell laufend"

Auf der `/projects/`-Übersicht zwischen Suchleiste und Projekt-Liste erscheint jetzt ein Banner mit allen laufenden Project-Agent-Sessions (alle currentPhase außer `done`/`failed`/`aborted`):

- Pulsing 🟢 Indicator + Counter „Aktuell laufend (N)"
- Pro Session: Phase-Badge (planning/coding/validating/…), Goal-Snippet, Projekt-Ordner (basename(cwd)), Iter-Counter, Files-Counter, Zeit seit letztem Progress
- Polling alle 5s (refresh ohne Reload nötig)
- ↻-Refresh-Button
- Klick auf eine Karte → `/project-agents?task=<taskId>` mit dem Detail-Pane automatisch geöffnet

### Geändert
- `ProjectAgentsPage`: Liest jetzt `?task=<id>` aus der URL und wählt das passende Session-Detail automatisch aus (matched auch auf Prefix). Wird vom Banner-Klick und potenziellen anderen Deep-Links genutzt.

## [0.19.0-multi-ha.687] - 2026-05-22

### Added — Project-Chat: Context-Refs (Toolbar + @-Mention + Drag&Drop)

Im Project-Chat können jetzt **Open-Items, Notes, Documents, Files und URLs** direkt mit der Nachricht referenziert werden — ohne den Inhalt manuell kopieren zu müssen.

**A — Toolbar:**
- 📌 **Open-Item-Button:** Dropdown mit allen aktiven Open-Items des Projekts. Klick fügt eine Ref hinzu, sichtbar als Chip.
- 📎 **Anhang-Button:** Modal mit 4 Tabs — Documents (RAG, mit Suche) / Files (FileStore) / URL (http/https + Label) / Upload (max 25 MB).
- Chip-Anzeige mit ✕ zum Entfernen pro Ref.
- **Drag&Drop:** Dateien direkt ins Chat-Fenster fallen lassen → Auto-Upload + Ref hinzugefügt.

**B — @-Mention-Autocomplete:**
- User tippt `@` → Popover über dem Input mit Search-Filtered Open-Items + Notes.
- Klick fügt Token in Text ein + Ref im State.
- `Escape` schließt das Popover.

**Backend:**
- `/api/message`-Body um `contextRefs: Array<{ kind, refId, label? }>` erweitert. Übergeben via `message.metadata.contextRefs`.
- Pipeline-Phase `context_refs_resolved`: Refs werden zu Markdown-Blöcken expandiert und an die User-Message angehängt:
  ```
  ## Mitgegebener Kontext (2 Refs)
  ### 📌 Open-Item: Modal-Hintergrund fixen
  - Status: open · Priority: high
  - [Description]
  ### 📎 Datei: screenshot.png
  - file-key: …
  ```
- Open-Items: `projectRepo.getOpenItemById()` lädt Titel + Beschreibung
- Notes: best-effort über `noteRepo.getById()` falls verfügbar
- Documents / Files / URLs: als Reference-Hinweis (Backend lädt nicht den File-Inhalt, der LLM kann via Tools nachfragen)
- TypeScript: `NormalizedMessage.metadata.contextRefs` Type ergänzt

## [0.19.0-multi-ha.686] - 2026-05-22

### Fixed
- **Arbeitszeit-Statistik (v668 Bug-Korrektur):** Completion-Callback las `SELECT started_at FROM project_agent_sessions` — das Feld heißt aber `created_at`. Die Query throw'd silent, `startedAt = undefined`, DB-Default `now()` → Project-Agent-Sessions zeigten 8-19s statt der echten 1-2h. Jetzt `created_at` korrekt. **Wirkt ab v686 NUR auf neue Sessions** — die alten 19 Einträge bleiben so wie sie in der DB stehen (Reparatur-SQL auf Anfrage).

### Added — Project-Agent Completion-Notifications
- **Telegram-DM:** Bei jedem Project-Agent-Completion (Erfolg oder Failure) wird eine DM an `config.security.ownerUserId` gesendet — egal welcher Trigger-Channel (WebUI / Telegram / Matrix). Format `🎉 Project-Agent fertig — Projekt-Name • N Phasen, X Files. Task-ID …` oder `❌ Project-Agent fehlgeschlagen — …`. Best-effort: schluckt Fehler ohne den Completion-Flow zu blockieren.
- **Project-Chat-Persistierung:** Completion-Summary wird als `assistant`-Message in die Project-Chat-Conversation eingefügt. Beim nächsten Öffnen des Project-Chats sieht der User in der History den Run-Abschluss mit Phasen-Count, Files und Task-ID.

### Bewusst NICHT umgesetzt: Insight-Badge
Insights sind Lessons-Learned/Pattern-Erkennung, nicht Activity-Notifications. Den Pending-Counter mit Completion-Events zu mischen würde die Semantik des `pending`-Badge entwerten. Falls eine eigene WebUI-Notification gewünscht ist, kommt das als dedizierte Bell-View in einer separaten Version (z. B. v687).

## [0.19.0-multi-ha.685] - 2026-05-22

### Fixed — System-weiter Root-Cause: WebUI-Owner fiel auf Role „guest" zurück

**Echtes Root-Cause (v682-684 waren Workarounds):** Alfred hat zwei parallele User-Tabellen, die nicht miteinander reden:
- `users` (Kerngebrauch, mit `master_user_id`-Verlinkung) — WebUI-User ist hier korrekt am Owner gelinkt
- `alfred_users` (Multi-User-Rollen-Feature, später dazu gekommen) — WebUI-User hat **keinen Eintrag**

Die Pipeline las Role nur aus `alfred_users` und fiel sonst auf `'guest'` zurück — auch wenn `users.master_user_id` korrekt auf den `ownerUserId` zeigte. Konsequenz: Owner im WebUI hatte nur die 9 guest-Skills.

**Fix:** Wenn `alfred_users`-Lookup leer UND `masterUserId === ownerMasterUserId` → fallback auf Role `'admin'` (statt `'guest'`). Damit ist die Owner-Erkennung konsistent über alle Pfade (Telegram-Owner war OK weil dort ein expliziter `alfred_users`-admin-Eintrag existiert; jetzt funktioniert WebUI-Owner äquivalent).

**Konsequenz:** Die v682-684 Project-Chat-Workarounds (`!isProjectChat`-Bypass etc.) sind jetzt nicht mehr nötig — bleiben aber als zusätzliche Sicherheitsschicht im Code (kein Schaden, kostet keine Performance).

**Wirkung über Project-Chat hinaus:**
- WebUI normaler Chat (`/chat`) hat jetzt Owner-Rechte
- WebUI Project-Chat hat jetzt Owner-Rechte
- Telegram-Owner: unverändert (admin via alfred_users)
- Andere User (linked an anderen Master, nicht-Owner): bleiben guest wie vorher

## [0.19.0-multi-ha.684] - 2026-05-22

### Fixed — Project-Chat: 0 Skills durchs role-based Filter (FORTSETZUNG zu v683)

**Live-Diagnose:** Server-Log zeigte `phase: skill_filter, count: 0` nach v683-Deploy — meine 18er Whitelist matched zwar `project_agent`/`code_agent`/`shell`, aber der NACHFOLGENDE role-based Filter (`6b`) hat alles wieder weggekürzt.

**Root-Cause:** Der WebUI-User fällt im `alfredUser`-Lookup auf `undefined` zurück (kein expliziter `alfred_users`-Eintrag, nur Master-Link). Pipeline default: `role = 'guest'`. Guest-Whitelist in `user-management.ts` enthält nur 9 Skills (`calculator, weather, web_search, routing, transit, energy_price, youtube, user_management, help`) — `project_agent` ist NICHT dabei. Schnittmenge mit meiner v683-Whitelist = ∅ → 0 Skills → „kein Tool zur Verfügung".

**Fix:** Bei Project-Chat (`metadata.projectId` gesetzt) den role-based Filter (`6b`) komplett überspringen. Der Project-Chat ist durch WebUI-Token-Auth schon abgesichert — der Caller ist der Owner, und die v683-Whitelist aus Schritt 6 ist bereits kurz und kuratiert.

**Konsistenz:** Telegram/Matrix/Discord/WhatsApp/Signal/normaler Web-Chat → role-based Filter läuft weiter wie vorher. NUR Project-Chat ist betroffen.

## [0.19.0-multi-ha.683] - 2026-05-22

### Changed — Project-Chat: Kuratierte Skill-Whitelist statt aller 76

**Hintergrund:** v682 hatte Project-Chat-Messages ALLE 76 Skills durchgereicht. Das spart zwar das "kein Tool"-Problem, kostet aber ~12k extra Input-Tokens pro Message (~$0.18/Msg bei Claude Opus). Außerdem erhöhte es das Hallucination-Risiko (BMW/Spotify im Code-Kontext).

**Neu in v683:** Project-Chat bekommt eine **kuratierte 18-Skill-Whitelist** der für Project-Arbeit relevanten Tools:
- Code: `project_agent`, `code_agent`, `shell`, `deploy`, `file`, `git`
- Wissen: `memory`, `note`, `todo`, `reminder`, `document`, `knowledge`
- Project: `project`, `brainstorming`, `watch`
- Infra (oft Deploy-Kontext): `homeassistant`, `monitor`, `cmdb`

**Nicht im Project-Chat:** BMW, Spotify, Sonos, Crypto, Travel, Recipe, Shopping, EnergyPrice, Transit, YouTube, FeedReader — die kommen im Project-Arbeitskontext praktisch nie vor.

### Wichtig: Blast-Radius isoliert
- `metadata.projectId` wird AUSSCHLIESSLICH vom HTTP-Adapter (`/api/message`) gesetzt, und auch nur wenn der Request-Body explizit `projectId` enthält (= NUR die `ProjectChat.tsx`-Komponente macht das).
- **Telegram, Matrix, Discord, WhatsApp, Signal, normaler Web-Chat: alle UNVERÄNDERT** — sie nutzen weiterhin den keyword-basierten `selectCategories`-Filter wie zuvor.
- Voice-Messages (`hasAudioAttachment`): unverändert (alle Skills).

## [0.19.0-multi-ha.682] - 2026-05-22

### Fixed — Project-Chat: Alfred behauptete „kein Tool zur Verfügung"

**Diagnose:** Bei Project-Chat-Messages filterte der Pipeline-`selectCategories(text)` die Tools nach Kategorie-Keywords im User-Text. Ein UI-Bug-Report („das Modal hat keinen Hintergrund...") matched keine Kategorie wie `code` oder `agent` → `project_agent`/`code_agent`/`shell`/`deploy` wurden weggefiltert → LLM bekam nur generische Tools → antwortete „kein Code-/Project-Agent-Tool zur Verfügung".

**Fix:**
- Skill-Filter wird bei Project-Chat (`metadata.projectId` gesetzt) **komplett übersprungen** — der LLM bekommt ALLE Tools. Analoges Verhalten wie bei Voice-Messages (`hasAudioAttachment`).
- System-Prompt für Project-Chats explizit erweitert: „**ALLE Tools** sind verfügbar: project_agent, code_agent, shell, deploy, file, git, brainstorming. Behaupte NIEMALS ‚kein Tool zur Verfügung'." Plus expliziter Hinweis dass UI-/Code-Bugs ebenfalls über `project_agent`/`code_agent` gefixt werden.

## [0.19.0-multi-ha.681] - 2026-05-22

### Fixed — Log-Viewer zeigte nur die aktuelle Stunde

**Diagnose:** Heutige Log-Datei `alfred.2026-05-22.1.log` hat 5485 Zeilen, WebUI fragte hardcoded `lines: 500` an. Backend macht `parsed.slice(-500)` = nur letzte 500 Zeilen ≈ 1 Stunde sichtbar. Datei-Rotation funktionierte korrekt (täglich pro Date+Index), nur das Viewer-Limit war zu klein.

**Fix:**
- WebUI default `lines: 5000` (vorher 500). Page-Size-Dropdown 500/2k/5k/20k/100k.
- Backend cap 5000 → **100.000 Zeilen** pro Request.
- Neue Query-Params: `?since=<unixMs>` (Time-Cutoff) und `?offset=<n>` (Pagination — skip die N neuesten Zeilen, dann hole `lines` davor).
- **Time-Range-Dropdown** im UI: Ganze Datei / Heute / Letzte 24h / Letzte 7 Tage.
- **Pagination-Bar** (sichtbar wenn total > pageSize): „← Ältere 5000" / „Neuere 5000 →" / „Zum Aktuellen" + aktive Datei + Größe.
- Status-Zeile rechts oben zeigt jetzt `X–Y von N` statt nur `N Eintr.`

### Konsequenz
- Zum Tag-Überblick: Dropdown auf "Heute" + Page-Size "20.000". Du siehst dann die ganze Tagessicht in einem Rutsch.
- Zum Älteren scrollen: Pagination-Bar „← Ältere 5000".

## [0.19.0-multi-ha.680] - 2026-05-22

### Fixed — Project-Chat hängt ohne UI-Feedback (Root-Cause + UX)

**Root-Cause:** `NormalizedMessage.id` für API-Adapter war `api-${messageCounter}`. Der Counter ist instance-state, startet bei jedem Alfred-Restart bei 1. Der HA-Dedup-Store (`processed_messages`) speichert verarbeitete Message-Keys 24h lang. Heißt: jede erste WebUI-Message nach einem Restart bekommt `id=api-1`, ihre Key ist `api:api-1` — schon claimed → `markProcessed` returnt false → Pipeline returnt `{ text: '' }` ohne weiteren Log-Output → leere ALFRED-Bubble.

**Live-Befund:** Im Pipeline-Log sieht man `Processing message` + `phase: confirmation_check` und danach NICHTS mehr — exakt das Symptom dieses Pfads.

**Fix:** `id: \`api-${crypto.randomUUID()}\`` statt counter. Global eindeutig, restart-stabil.

### UX-Verbesserungen ProjectChat
- Beim Send sofortiges Status `⏳ Sende an Alfred…` (vorher: leere assistant-Bubble bis Backend-Status kommt — bei HA-Dedup-Fail kam GAR NICHT).
- Animierte 3-Punkt-Pulse-Bubble (statt statisches `…`) während leerer assistant-Bubble streamed.
- Status-Banner mit Indicator-Dot zusätzlich zu animate-pulse.
- Wenn der Stream OHNE Antwort schließt: explizite Fehlermeldung statt leerer Bubble (`Backend hat keine Antwort gesendet…`) + Bubble wird entfernt.

## [0.19.0-multi-ha.679] - 2026-05-22

### Fixed
- **„Letzte Deploys" leer nach erfolgreichem Deploy:** Der Deploy-Skill hat die Memory-Schreibung in einem stillen `try-catch` (`/* best-effort */`), das alle Fehler schluckt. War der Memory-Save aus irgendeinem Grund nicht erfolgreich (z. B. ownerUserId-Mismatch), gab's keine Spur. v679 verlegt die Memory-Schreibung in `triggerDeploy` (alfred.ts) — wir haben dort die User-ID garantiert + emittieren `Deploy memory written` als info-Log bei Erfolg und `Deploy memory write failed` mit Stack bei Fehler. Bei Success category=`deployment`, bei Failure `deploy` (UI-Failure-Indicator). Selber Key wie der Skill-interne Save, eventuelle Duplicate werden vom UNIQUE-Constraint auf `memories(user_id, key)` zu einem UPSERT.

## [0.19.0-multi-ha.678] - 2026-05-22

### Fixed
- **Sidebar Chat-Klick auf Project-Chat sprang fälschlicherweise zum Web-Chat:** Klick auf `project:<uuid>` in der Sidebar lud zwar die Conversation-Messages, aber `useChat.chatId` ist fest `web-chat-<userId>` — neue Nachrichten gingen also an den falschen Chat. Neu: Project-Chats werden direkt zur `/projects/?id=<projectId>&chat=open` navigiert. Die ProjectChat-Komponente erkennt den `chat=open`-Param und expandiert automatisch + scrollt zum Element. Query-Param wird nach Auto-Open entfernt damit Reload nicht endlos scrollt.
- **Sidebar-Label für Project-Chats:** Statt rohem `project:3a407ced-a819-…` zeigt die Sidebar jetzt 📁 + den echten Projekt-Namen (via in-memory Lookup gegen die bereits geladenen aktiven Projekte).

## [0.19.0-multi-ha.677] - 2026-05-22

### Fixed — Deploy: vier zusammenhängende Bugs

**1) Slug-Priorität korrigiert:** `triggerDeploy` priorisierte den Projekt-`slug` über `basename(cwd)`. Bei alten Projekten ist `slug` der sanitized LLM-Goal-Text (z. B. `starte-einen-neuen-projekt-agent-lauf-fur-alpbyte-games-unte`) → validate-konform aber semantisch nutzlos. Neue Reihenfolge: `input.project` → `basename(cwd)` → `slug` (nur wenn ≤30 chars und nicht mit `starte/erstelle/bearbeite` startet) → `sanitized(name)`. Bei Projekt mit `cwd=/home/madh/projects/alpbyte-games` ergibt das jetzt `alpbyte-games` ✅.

**2) „Letzte Deploys" zeigte 0 trotz Deploys:** `lastDeploys` suchte nach Memory-Key `deploy_${project.name}_…`, der Deploy-Skill schreibt aber `deploy_${slug}_${host_sanitized}` — niemals Match. Jetzt nutzt `lastDeploys` dieselbe Slug-Ableitung wie `triggerDeploy`.

**3) Memory bei Failure:** Bisher schrieb der Deploy-Skill nur bei Erfolg Memory (category=`deployment`). Bei Fehler wusste „Letzte Deploys" nichts. Neu: `triggerDeploy` schreibt bei Fehler eine Memory mit category=`deploy` am SELBEN Key — beim nächsten erfolgreichen Run wird sie automatisch von der `deployment`-Memory überschrieben. UI zeigt jetzt ❌ + Fehler-Snippet bei failed-Einträgen.

**4) Telegram-Benachrichtigung bei Deploy-Fehler:** Bei Off-WebUI-Triggern (Skill via Chat) hatte der User keine Rückmeldung. Neu: bei `!result.success` wird eine DM an den `ownerUserId` gesendet mit Projekt-Name, Host, Slug und der ersten Fehler-Zeile. Erfolg wird NICHT per DM gemeldet (würde spammen).

## [0.19.0-multi-ha.676] - 2026-05-22

### Fixed
- **Deploy-Trigger schlug fehl mit „project erforderlich":** `triggerDeploy` schickte `project.name` an den Deploy-Skill, der aber `validateName` (nur a-z, 0-9, ., -) erwartet. Bei alten Projekten ist `project.name` der lange LLM-Goal-Text ("Starte einen NEUEN Projekt-Agent-Lauf für…") → Validation fail → 400. Neu: Slug-Ableitung mit Priorität `input.project` → `project.slug` (falls validate-konform) → `basename(project.cwd)` → sanitized `project.name`. NFKD-Normalisierung räumt Umlaute weg, Whitespace/Sonderzeichen werden zu `-` ersetzt, max 60 Zeichen.

## [0.19.0-multi-ha.675] - 2026-05-22

### Fixed
- **Automation-Templates 404 (Route-Order-Bug):** Im HTTP-Adapter stand die generic Route `/api/projects/:id` (Zeile 903) VOR der spezifischen `/api/projects/automation-templates` (Zeile 939). Dadurch matched die generic Route zuerst, `:id = "automation-templates"` wurde an `handleProjectsGet` weitergereicht, das natürlich kein Projekt mit dieser ID fand → 404. Fix: spezifische Route nach `/api/projects` (GET/POST) eingefügt, vor der `[^/]+`-Match-Zeile. Klassischer Routing-Reihenfolge-Fehler.
- **listAutomationTemplates-Callback (vorsorglich):** Statt `mod.listAutomationTemplates()` zu rufen (was esbuild's Module-Namespace-Getter durchläuft) greife ich direkt auf `mod.AUTOMATION_TEMPLATES` zu und mache `Object.values()` selbst — umgeht jede Bundler-Optimization.

### Diagnostik
- Temporärer info-Log `listAutomationTemplates served` mit count + sample-kind. Beim nächsten Empty-Modal sieht man im Server-Log sofort ob's am Backend oder Frontend liegt.

## [0.19.0-multi-ha.674] - 2026-05-22

### Added — Attachment Downloads, Image-Previews & Drag-and-Drop

**Download-Endpoint:**
- `GET /api/files/download?key=<key>` streamt ein FileStore-File mit User-Scope-Check (FileStore prüft Key-Prefix gegen User-ID).
- Sichere `Content-Disposition` (RFC 5987 UTF-8 + ASCII-Fallback gegen Header-Injection).
- `X-Content-Type-Options: nosniff` + `Cache-Control: private, no-cache`.
- Token-Auth via Bearer ODER `?token=…` Query-Param (für `<a href>`-Downloads ohne JS-Header).
- Best-effort MIME-Detection aus File-Extension (PNG/JPG/GIF/PDF/MD/JSON/MP4/MP3/DOCX/XLSX …).

**WebUI:**
- `file`/`upload`-Attachments haben jetzt einen klickbaren Download-Link.
- Bilder (`image/*` oder Extension PNG/JPG/GIF/WebP/SVG) werden als 40×40 Thumbnail inline angezeigt.
- Upload-Tab: Drag-and-Drop-Area mit visuellem Hover-State, File-Picker als Fallback.
- `<a download>`-Attribut sorgt dafür dass der Browser den Filename behält statt URL-encoded Key zu speichern.

## [0.19.0-multi-ha.673] - 2026-05-22

### Added — Generisches Attachment-System für Todos + Notes

Todos und Notes können jetzt Anhänge aus 4 Quellen referenzieren:

- **📄 Documents** — RAG-indizierte Dokumente aus der `documents`-Tabelle (Such-Picker mit Filename-Filter)
- **📁 Frühere Uploads** — Files die bereits im FileStore (lokal / NFS / S3) gespeichert sind
- **🔗 URLs** — externe Links (http/https)
- **⬆ Direct-Upload** — Datei direkt im Detail-View per File-Picker hochladen (Base64-Body, max 25 MB), landet im FileStore und steht künftig auch als „Frühere Uploads" zur Verfügung

**Migration v86 (SQLite) + v89 (PG):** generische `attachments`-Tabelle mit `entity_type`/`entity_id`-Pattern — ist später ohne Schema-Change auch für Open-Items, Reminders etc. nutzbar.

**Backend:**
- Neues `AttachmentRepository` (add / listForEntity / delete / deleteForEntity).
- Neue HTTP-Endpoints:
  - `GET /api/documents` (User-Documents für Picker)
  - `GET /api/files` (FileStore-List)
  - `POST /api/uploads` (Base64-Upload, 25 MB Limit)
  - `GET|POST /api/{todos|notes}/:id/attachments`
  - `DELETE /api/attachments/:id`
- `alfred.ts` wired `setAttachmentsCallbacks` mit Anti-Tampering (Entity muss User gehören) und URL-Validierung (nur http/https).

**WebUI:**
- Neue Komponente `AttachmentSection` (wiederverwendbar). In TodosPage Detail + NotesPage Detail integriert.
- 4-Tab-Modal mit Auswahl pro Quelle, Drag-and-Drop für Upload nicht enthalten (File-Picker reicht).

**Limitations (Phase 1):**
- Kein dedizierter Download-Endpoint für `file`/`upload`-Attachments — die UI verlinkt nicht direkt zum Binary. Folgt als v674 falls gewünscht.
- Keine Volltextsuche in Attachments — nur Filename-Filter im Picker.

## [0.19.0-multi-ha.672] - 2026-05-22

### Added — Notes ↔ Todos M:N-Verknüpfung

Eine User-Notiz (aus dem `/notes`-Bereich) kann jetzt mit beliebig vielen Todos verknüpft werden — und ein Todo kann beliebig viele Notizen als Kontext referenzieren. Anders als die Arbeits-Notizen aus v670 (Verlaufseinträge AM Todo) sind das eigenständige Wissens-Notizen die als Referenz dienen.

**Migration v85 (SQLite) + v88 (PG):** Join-Tabelle `todo_note_links` mit Composite-PK, FK-Cascade auf beide Richtungen.

**Backend:**
- `TodoRepository.linkNote / unlinkNote / listLinkedNoteIds / listLinkedTodoIds`.
- Resolver in `alfred.ts` löst IDs zu vollen Note-Objekten auf.

**API:**
- `POST /api/todos/:todoId/note-links/:noteId` — verknüpfen
- `DELETE /api/todos/:todoId/note-links/:noteId` — lösen
- `GET /api/todos/:todoId/linked-notes` — verknüpfte Notes
- `GET /api/notes/:noteId/linked-todos` — verknüpfte Todos

**WebUI:**
- TodosPage Detail: neue Section „🔖 Verknüpfte Notizen" mit Picker-Modal (Volltext-Suche über alle eigenen Notes).
- NotesPage Detail: Section „🔖 Verknüpfte Todos" listet alle Todos die diese Note referenzieren (Status sichtbar).

## [0.19.0-multi-ha.671] - 2026-05-22

### Added — Todo ↔ Project-Open-Item Spiegel-Link

Beim Anlegen eines Todos kann nun optional ein Projekt gewählt werden. Alfred legt dann parallel ein **Open-Item im Projekt** an und verlinkt beide Einträge bidirektional. Status- und Inhalts-Änderungen synchronisieren sich automatisch.

**Migration v84 (SQLite) + v87 (PG):**
- `todos.linked_project_id`, `todos.linked_open_item_id`
- `project_open_items.linked_todo_id`
- Partial Indizes für schnellen Reverse-Lookup

**Sync-Regeln (entschieden mit User):**
- **Delete:** beim Löschen eines Todos wird nur die Verlinkung am Open-Item entfernt — das Open-Item bleibt erhalten.
- **Cancel:** wird ein Open-Item als `cancelled` markiert, bleibt das Todo offen (nur `done` propagiert).
- **Edit:** Titel + Beschreibung werden Todo → Open-Item synchronisiert. Idempotenz-Check verhindert Loops (Update wird nur ausgeführt wenn Werte tatsächlich differieren).
- **Status:** `completed`/`done` propagiert in beide Richtungen.

**Backend:**
- `TodoRepository`: `setLink`, `findByLinkedOpenItem`, `add()` um `linkedProjectId`/`linkedOpenItemId` erweitert.
- `ProjectRepository`: `updateOpenItemFields`, `setOpenItemTodoLink`, `findOpenItemByLinkedTodo`, `getOpenItemByIdRaw`.
- `alfred.ts` Sync-Layer in `todosCallbacks.add/update/complete/delete` + `projectsCallbacks.updateOpenItem`.

**WebUI:**
- TodosPage Add-Form: optionaler Projekt-Dropdown (lädt aktive Projekte).
- TodosPage Detail: 🔗-Badge in Listenzeile, Link zum Projekt im Detail, Info-Banner zur Sync-Mechanik.
- ProjectsPage Open-Item: 🔗-Symbol bei verlinkten Items + Eintrag „Verknüpftes Todo: …" im Expanded-Detail.

## [0.19.0-multi-ha.670] - 2026-05-22

### Added — Todos: Bearbeiten + Arbeitsnotizen
- **Edit-Mode pro Todo:** Klick auf Todo öffnet einen ausklappbaren Detail-Bereich. „✏ Bearbeiten" gibt einen Edit-Modus mit allen Feldern (Titel, Beschreibung, Priorität, Fälligkeit, Liste).
- **Beschreibung beim Anlegen:** Im Add-Form zusätzlicher Toggle „▸ Mit Beschreibung anlegen" für direkten Multiline-Eingang.
- **Arbeitsnotizen / Fortschritts-Verlauf:** Neue Tabelle `todo_notes` (Migration v83 SQLite + v86 PG). Pro Todo lassen sich beliebig viele zeitgestempelte Notizen anlegen — z. B. Zwischenstände, Blocker, Entscheidungen, Recherche-Links. Sichtbar im expandierten Detail, sortiert nach „neueste zuerst". Cmd/Ctrl+Enter speichert direkt aus dem Eingabe-Feld. Jede Notiz ist einzeln löschbar.
- **Sichtbarer Notizen-Counter:** Pro Todo zeigt das Listing 📝 N falls Notizen vorhanden.

### Added — Backend
- `TodoRepository.update(todoId, userId, patch)` — Update aller Felder mit User-Scope-Check.
- `TodoRepository.addNote / listNotes / deleteNote`.
- HTTP-Endpoints `GET/POST /api/todos/:id/notes`, `DELETE /api/todos/notes/:noteId`.
- PATCH `/api/todos/:id` reicht jetzt alle Felder durch (vorher nur `completed`).

## [0.19.0-multi-ha.669] - 2026-05-22

### Fixed
- **Audit-Loading-Indicator (Projects-View):** Beim Klick auf 🔍 Audit gab es keine UI-Rückmeldung — der LLM-Call läuft 10–30s, der User dachte es passiert nichts. Neu: Button-Label wechselt auf "⏳ Audit läuft…", pulsing Banner unterhalb erklärt was gerade passiert.
- **Automation-Modal (leerer Body):** Wenn die Template-Liste zum Modal-Open-Zeitpunkt noch nicht geladen war (Race-Condition) oder das Backend 0 Templates zurückgab, sah der User nur den Header "22 Templates verfügbar" und keine Auswahl. Hardcoded "22" entfernt. Modal lädt jetzt selbst nach (`fetchAutomationTemplates`), zeigt Loading-Spinner, Empty-State mit Retry-Button und Fehler-Diagnose-Hint.
- Collapsed-Sidebar-Label und Empty-State-Hint zeigen die echte Template-Anzahl statt der hardcoded "22".

## [0.19.0-multi-ha.668] - 2026-05-22

### Fixed
- **ITSM Filter:** `'draft'`-Change-Requests und `'logged'`-Probleme wurden vom Aktiv-Filter unsichtbar gemacht. Die Default-Status frisch angelegter Tickets sind jetzt im Active-Set enthalten + jeweils eigene Status-Chips (Draft / Logged) in der Stats-Bar.
- **Arbeitszeit-Statistik:** Sessions zeigten nur 8–19s statt der echten Agent-Laufzeit. Ursache: `finishSession()` legte den DB-Row erst am Ende an, `started_at` und `ended_at` waren ~gleich. Fix: `FinishSessionParams.startedAt` durchgereicht (Code-Agent: `Date.now() - durationMs`; Project-Agent: aus `project_agent_sessions.started_at` per Lookup; Delegate: ebenfalls aus `info.durationMs`).
- **Dashboard Number-Formatting:** Hohe Call-Zahlen wurden RAW geprintet (z. B. `123456 Calls`). Neu: `formatCount()` mit K/M-Kompaktformat ab 10k + Tausender-Trenner im Tooltip + `truncate` auf Cost-Werten.

### Added
- **Sidebar:** Projekte- und Chats-Sections jetzt collapsible (Caret-Toggle + Counter + LocalStorage-Persistenz `alfred-sidebar-chats-open` / `alfred-sidebar-projects-open`).
- **Roadmap aus Open-Items:** Pro Open-Item im Projekte-Detail neuer 🗺️-Button → Inline-Form für Milestone-Name, Reihenfolge und geschätzte Stunden. Bestehender `updateOpenItemRoadmap`-Endpoint wird genutzt. Button-Color zeigt sofort ob ein Item Teil der Roadmap ist. „Aus Roadmap entfernen"-Aktion entfernt das Milestone-Feld.
- **Work-Stats: Abgebrochene Sessions:** Vierte Kennzahl "Abgebrochen" im Total-Grid. Pro Session-Type wird `failedCount` aus `summary_json.status === 'failed' \|\| 'cancelled'` extrahiert und als `✓/✗`-Counter ausgewiesen.

### Changed
- `ProjectRepository.getWorkStats()` Return-Type um `failedCount` erweitert (auf Total- und ByType-Ebene).
- `ProjectManager.AttachSessionParams` + `FinishSessionParams` um optionalen `startedAt`-Parameter ergänzt.

## [0.19.0-multi-ha.667] - 2026-05-22

### Fixed — Pipeline-Hang im Project-Chat + Multi-User-Identity-Leak

**Bug:** Sendet ein WebUI-User eine Nachricht im Project-Chat, bleibt die Pipeline 5+min ohne Antwort hängen. Ursache: drei zusammenspielende Probleme.

**Fix A — Pipeline-Phasen-Tracing** (`message-pipeline.ts`):
- Neuer Helper `tracePhase(name, extra)` loggt nach jeder Phase `{ phase, ms, totalMs }` auf info-level.
- Phasen: `confirmation_check`, `ha_dedup`, `skill_context`, `alfred_user`, `project_owner_resolve`, `conversation`, `memories_load`, `rules_load`, `profile_load`, `skill_filter`, `system_prompt_built`, `project_chat_context`, `itsm_inject`, `runbook_inject`, `llm_request_prep`.
- Bei jedem zukünftigen Hang sofort sichtbar in welcher Phase blockiert wurde.
- ITSM-Skill-Lookup mit 3s-Timeout gewrapped — verhinderte vorher, dass ein hängender ITSM-Repo die Pipeline blockiert.

**Fix B — `autoLinkApiUser` abgesichert gegen Multi-User-Identity-Leak** (`alfred.ts`):
- Bisheriges Verhalten: api/cli-User wurden BLIND an den ersten beliebigen Non-bot User gelinkt (`findFirstByPlatformNotIn(['api','cli'])`).
- In Multi-User-Setups (matrix + telegram + …) übernahm ein neuer WebUI-Login die Identität eines FREMDEN Users — inkl. dessen Memories, KG und Profil.
- Neue Logik: Auto-Link nur wenn EXAKT 1 Master-User existiert (Single-User-Setup), sonst ist explizites `/link` erforderlich.
- Opt-In für Legacy-Setups: `users.apiAutoLink: true` in der yaml-Config.
- Neue Method `UserRepository.countMasterUsersNotIn(excluded)`.

**Fix C — Project-Chat-Owner-Resolution** (`message-pipeline.ts` + `project-repository.ts`):
- Wenn das WebUI eine Projekt-Chat-Message schickt (`metadata.projectId` gesetzt), ist der WebUI-User (api-platform) nicht zwangsweise der Projekt-Owner.
- Vorher: Pipeline lädt Memories/KG/Project-Kontext für den (falschen) auto-gelinkten masterUserId → Project-Block leer, Memories irrelevant.
- Neu: `ProjectRepository.getByIdAnyOwner(id)` — Lookup ohne Owner-Filter (intern, nicht über API exposed).
- Pipeline überschreibt nach `buildSkillContext` den `masterUserId` temporär auf `project.userId` wenn `metadata.projectId` gesetzt und Owner-Mismatch.
- Konsequenz: Memory/KG/Project-Context-Loading läuft mit der korrekten Identität des Projekt-Owners. Das war auch die wahrscheinlichste Ursache des konkreten Hängers: für den ungewollt aufgelinkten Fremd-User wurden große Memory-Sets traversiert.

### Changed
- `message-pipeline.ts`: System-Prompt-Building gefolgt von einer Reihe atomarer "Inject"-Blöcke (Project-Chat, ITSM, Runbook) — jeder mit eigenem Phase-Marker.

## [0.19.0-multi-ha.666] - 2026-05-21

### Added — Project-Mobility: Move local↔shared (v665b)

**ProjectMoveService** (`cluster/project-move.ts`):
- `computeTargetPath(project, target)` — leitet Pfad aus storageType+shareId+slug
- `preflight(project, target, opts)` — 6 Checks:
  1. **no_active_session** (locked_by_node_id IS NULL OR stale)
  2. **git_clean** (`git status --porcelain` leer)
  3. **source_exists** (cwd auf dieser Node erreichbar)
  4. **target_free** (Target-Pfad noch nicht vorhanden)
  5. **share_usable** (bei Ziel=shared)
  6. **disk_space** (du-Quelle * 1.2 < df-avail-Ziel, best-effort)
- `execute(project, target, opts, userId, onProgress?)`:
  1. tryLock(180min TTL)
  2. rsync `-a --info=progress2 --exclude…` + Live-Progress an onProgress
  3. Verify: `git status` im Ziel (wenn .git existiert)
  4. DB-Update transaktional (cwd/storage_type/share_id/node_id)
  5. Source-Cleanup wenn !keepSource
  6. Lock release (auch im Fehler-Pfad)
- Rollback-Safety: vor DB-Update bleibt Source unverändert

**API-Endpoints**:
- `GET /api/cluster/shares` — alle konfigurierten Shares + Status (available/writable/reason)
- `POST /api/projects/:id/move/preflight` Body `{ storageType, shareId?, nodeId? }`
  → Liste aller 6 Checks mit pass/fail/detail + sourceCwd + targetCwd
- `POST /api/projects/:id/move` Body `{ storageType, shareId?, nodeId?, excludes?, keepSource? }`
  → rsync execution + DB-Update + cleanup

**WebUI** (`ProjectStorageView` + `MoveModal`):
- 📦 Storage Section in ProjectsPage Detail (collapsible):
  - Aktueller storageType / shareId / nodeId / cwd-Pfad
  - 🔒 Lock-Anzeige falls aktive Session (Holder-Node + TTL)
  - „📤 Move…" Button öffnet Modal
- Move-Modal:
  - Aktuelles-Storage-Banner
  - Ziel-Toggle: 🖥 local (diese Node) / 🗄 shared (Cluster-Share)
  - Share-Picker (deaktiviert für offline/readonly/not-writable)
  - „Source behalten" Toggle
  - **Pre-Flight-Anzeige live** (✓/✗ pro Check, sourceCwd → targetCwd)
  - „Move starten" Button (disabled wenn !preflight.ok || moving)
  - Result-Banner mit Duration + Pfaden

### Architektur
- Default-Excludes: `node_modules`, `dist`, `build`, `.next`, `__pycache__`, `.cache`, `target`, `coverage`
- Konfigurierbar via `projects.rsyncExcludes` in config
- rsync mit `-a --info=progress2` (preserves perms/symlinks/times, streamt Progress)
- Sicher gegen race: kombinierter Pre-Flight + tryLock vor rsync
- Wenn rsync fehlschlägt: Source bleibt, DB unverändert; Target-Verzeichnis bleibt
  als Half-Copy (Operator-Cleanup empfohlen)

### Notes
- Build grün (12/12)
- NFS + SMB direkt unterstützt sobald die Mounts auf den Nodes existieren —
  ShareManager prüft existsSync + W_OK
- Share-Wechsel (z.B. `shared@main` → `shared@archive`) direkt unterstützt
  (kein zwischen-local-step nötig)
- `gh`-CLI für PR-Automations läuft auf der Lock-Holder-Node (genau wie git)
- Owner-Cross-Node-Move (local-zu-anderer-local-Node): aktuell nicht implementiert —
  bräuchte ssh-rsync; für jetzt: erst auf shared moven, dann anderer Node holt sich's

## [0.19.0-multi-ha.665] - 2026-05-21

### Added — Cluster-Shares Foundation für Projekte (v665a)

**Schema (Migration v82/v85)**:
- `projects.storage_type TEXT NOT NULL DEFAULT 'local'` ('local' | 'shared')
- `projects.share_id TEXT` (FK auf konfigurierten Share aus infra.shares)
- `projects.node_id TEXT` (bei storage_type='local': welche Cluster-Node hostet das Projekt)
- `projects.locked_by_node_id TEXT` (Active-Session-Lock)
- `projects.locked_until TEXT` (TTL für Stale-Lock-Cleanup)
- Indizes: `(share_id, storage_type)` und `(locked_by_node_id, locked_until)`
- **Bestehende Projekte bleiben unverändert** — Default 'local', node_id kann erst beim ersten Adapter-Owner-Run gesetzt werden

**Config-Schema (`infra.shares[]`)**:
```yaml
infra:
  shares:
    - id: 'main'
      name: 'Cluster-Hauptshare'
      mountPath: '/mnt/cluster-projects'   # IDENTISCH auf allen Nodes
      type: 'nfs'                          # nfs|smb|virtiofs|cephfs|local-shared
      readOnly: false
      preflightCheck: true
projects:
  localBase: '/home/alfred/projects'
  defaultStorage: 'local'                  # Default für neue Projekte
  defaultShareId: 'main'                   # nur bei defaultStorage='shared'
  rsyncExcludes: ['node_modules', 'dist', 'build', '.next', '__pycache__']
```

**ShareManager** (`cluster/share-manager.ts`):
- Startup-Check: existsSync + accessSync(W_OK) pro share.mountPath
- `getShare(id)`, `isUsable(id)`, `listStatuses()`, `recheckAll()`
- Logs Warnings bei nicht-vorhandenen Mounts — bricht NICHT ab (Single-Node-Setups laufen weiter)

**ProjectRepository Lock-API**:
- `tryLock(projectId, nodeId, ttlMinutes=180)` — atomares acquire (UPDATE … WHERE
  locked_by IS NULL OR locked_by = ? OR locked_until < now())
- `refreshLock(projectId, nodeId, ttlMinutes)` — Heartbeat
- `releaseLock(projectId, nodeId)` — idempotent, nur eigener Lock
- `sweepStaleLocks()` — Cleanup für Crashed-Holder

**Project-Agent Lock-Integration**:
- `setProjectLockHooks(acquire, release)` — neue Hooks im Runner
- Vor `_runInner` → Lock acquire. Bei Misserfolg → 🔒-Message + Abort vor Session-Aufbau.
- Im finally → Lock release
- **Routing-Reject** bei `storage_type='local'` + falsche `node_id`:
  Klare Fehlermeldung „Projekt liegt lokal auf node X — diese Node ist Y. Bitte per
  project.move auf einen shared Mount verschieben."

**Hintergrund-Cleanup**:
- alle 5min: `projectRepo.sweepStaleLocks()` befreit Locks älterer als TTL
  (z.B. nach Node-Crash ohne sauberen Release)

### Notes
- Build grün (12/12)
- v665a ist **funktional vollständig** für Cluster-Lokal-Routing — Projekte sind
  jetzt cluster-aware, mehrere Nodes können sicher koexistieren
- **v665b folgt** mit Move-Operation (local↔shared, NFS+SMB), WebUI Storage-Section
  + Move-Modal, project_move Skill-Action mit v657 Multi-Action-Confirmation
- Bestehende lokale Projekte funktionieren unverändert. Erst wenn ein Projekt
  gemoved wird, kommt der shared-Codepfad zum Einsatz.

## [0.19.0-multi-ha.664] - 2026-05-21

### Added — Project Automations mit 22 Templates (v663b)

**Schema (Migration v81/v84)**:
- Neue Tabelle `project_automations` (id/project_id/user_id/name/template_kind/
  schedule/prompt_override/output_destination/enabled/last_run_at/last_run_status/
  last_run_output/next_run_at/created_at)
- Indizes auf `(project_id, enabled)` und `(next_run_at, enabled)` für Cron-Sweep

**22 Template-Kinds** (`automation-templates.ts`):

**Core (mit Daten-Collectors):**
- 📅 daily_standup — täglich 08:00, git_log_recent
- 📈 weekly_progress — Mo 09:00, git_log_recent
- 🚀 release_prep — manuell, CHANGELOG-Vorschlag + Tag
- 🔍 code_review — manuell, git_diff_summary + git_log_recent
- 📦 dependency_check — 1. Monat 09:00, npm_outdated + pip_outdated + npm_audit
- 🎯 open_items_triage — Mo 09:00, prompt-basiert
- 📝 documentation_drift — monatlich, tree_overview

**Erweiterungen (prompt-basiert mit Projekt-Kontext):**
- 🧪 test_coverage_drift, 📊 activity_digest, 🔄 auto_rebase
- 💡 brainstorming_pulse, 🔀 pr_pflege (mit `gh pr list` collector)
- 🛡 security_sentinel (mit npm_audit), ⚡ performance_baseline
- 👋 onboarding_doc, 💰 cost_tracking
- 👥 stakeholder_briefing, ⚖ license_audit
- 🔮 pre_mortem, 📜 adr_decisions
- 🎬 demo_day_prep, 🐛 recurring_bug_detector
- ✨ custom (frei definierbar)

**AutomationEngine** (`automation/automation-engine.ts`):
- Tick alle 60s → fällige `next_run_at <= now()` ausführen
- Pro Run:
  1. Projekt-Kontext laden (sessions/openItems/decisions)
  2. Collectors ausführen (git log / npm outdated / npm audit / tree / pr list / coverage)
  3. LLM-Call mit Template-Prompt + Kontext + Collector-Output (tier=fast, 1500 tokens)
  4. Output an Destination liefern:
     - `telegram` → Owner-Chat (default)
     - `project_chat` → ConversationRepo.addMessage in Projekt-Conversation (v658)
     - `email` / `web_notification` → fallback auf adapter (TODO)
  5. `recordRun(status, output, nextRunAt)` persistieren
- **Minimaler Cron-Parser** (5 Felder: min hour dom mon dow, mit *, Listen, Ranges, Steps)

**API-Endpoints**:
- `GET /api/projects/automation-templates` — 22 Templates auflisten
- `GET /api/projects/:id/automations` — pro Projekt
- `POST /api/projects/:id/automations` — Add (mit nextRunAt-Compute)
- `PATCH /api/projects/automations/:id` — Update (Schedule → next_run_at recompute)
- `DELETE /api/projects/automations/:id`
- `POST /api/projects/automations/:id/run` — Sofort-Ausführen

**WebUI** (`ProjectAutomationsView`):
- 🤖 Automations Section in ProjectsPage Detail (collapsible)
- Add-Modal mit Template-Picker (2-Spalten-Grid, 22 Cards mit Icon+Label+Description+Default-Schedule)
- Pro Card: Klick öffnet Form mit
  - Name (bearbeitbar)
  - Schedule (Cron oder „manual")
  - Output-Ziel Dropdown (Telegram/Projekt-Chat/Email/Web)
  - Prompt (bearbeitbar — default vorgeladen)
- Liste der konfigurierten Automations:
  - Icon + Name + Status (✓ Last Run) + Next-Run-Hinweis
  - ▶ Run-Now / ⏸ Pause-Toggle / ✕ Delete
  - Expandable „Last Output" details

### Notes
- Build grün (12/12)
- AutomationEngine startet automatisch im Background
- Schedules sind opt-in via `enabled` Flag
- Collectors die fehlen (npm/pip/gh nicht installiert) failen silent — Output ist dann nur Kontext-basiert
- Custom-Template erlaubt freien Prompt mit Projekt-Kontext (cwd/sessions/openItems/decisions/conventions wird automatisch zum LLM gegeben)
- `email` und `web_notification` Output-Destinations sind Routing-Hooks aber noch ohne separate Adapter — fallen aktuell auf Telegram zurück

## [0.19.0-multi-ha.663] - 2026-05-21

### Added — Project Conventions + Roadmap (v663a)

**Schema (Migration v80/v83)**:
- `projects.conventions TEXT` (JSON: readme/changelog/commits/branching/versioning)
- `project_open_items.roadmap_milestone TEXT`
- `project_open_items.roadmap_order INTEGER`
- `project_open_items.estimated_hours REAL`
- Index `idx_open_items_roadmap`

**Project Conventions (alle opt-in, default = off)**:
- `readme.autoUpdate` + `template` (default/minimal/custom)
- `changelog.autoUpdate` + `format` (keepachangelog/free)
- `commits.convention` (conventional/free) + `scopePolicy` (required/optional/forbidden)
- `branching.strategy` (main-only/feature-branches/gitflow) + `prTarget`
- `versioning.scheme` (semver/date/custom) + `autoTag`

**Project-Agent-Integration der Conventions**:
- `setProjectConventionsResolver(cwd → conventions)` Hook — alfred.ts liefert
  über `projectRepo.list().find(p => p.cwd === cwd)`
- `branching.strategy='feature-branches'` → `branchPerSession=true` automatisch
- `commits.convention='conventional'` → Heuristisches Präfix:
  fix:/feat:/refactor:/test:/docs:/style:/perf:/chore: aus Phase-Text abgeleitet
- `readme.autoUpdate=true` → Phase-Prompt-Hint „README.md pflegen (Template: …)"
- `changelog.autoUpdate=true` → Phase-Prompt-Hint „CHANGELOG.md Eintrag unter
  [Unreleased] anlegen (Format: …)"
- `versioning.autoTag=true` + scheme='semver' → bei erfolgreichem Push:
  letztes Semver-Tag finden, Patch+1, taggen + pushen
- `commits.scopePolicy='required'` → Prompt-Hint „mit Scope: feat(scope): …"

**Project Roadmap**:
- Open-Items mit `roadmap_milestone` gesetzt sind Roadmap-Items
- `listRoadmap(projectId)` gruppiert nach Milestone, intern sortiert nach roadmap_order
- `listMilestoneItems(projectId, milestone)` für Implement-Aktion
- `updateOpenItemRoadmap(itemId, {milestone, order, estimatedHours})`
- `implementMilestone(projectId, milestone)` Action:
  - aggregiert alle open + in_progress items des Milestones
  - sortiert nach roadmap_order
  - Goal-Komposition: nummerierte Item-Liste mit Beschreibungen + estimated hours
  - Startet `project_agent.start` mit `link_open_item_ids` (für Auto-Resolve v641)

**API-Endpoints**:
- `GET /api/projects/:id/roadmap` — Items grouped by milestone
- `PATCH /api/projects/open-items/:id/roadmap` — milestone/order/estimatedHours setzen
- `POST /api/projects/:id/implement-milestone` Body `{milestone}` — startet Project-Agent
- `PATCH /api/projects/:id` jetzt mit `conventions` Patch-Field

**WebUI** (`ProjectConventionsView` + `ProjectRoadmapView` in ProjectsPage):
- ⚙️ Conventions Section: kollabierbar mit Badge „N aktiv", Form für alle 5 Bereiche
- 🗺️ Roadmap Section: kollabierbar, Milestones gruppiert mit Header (count/hours/done)
- Pro Milestone: ⚡ Implementieren Button (disabled wenn keine offenen Items)
- Item-Zeilen mit Status-Badge, Priority-Icon, EstimatedHours, Reihenfolge-Index

### Notes
- Build grün (12/12)
- Alles opt-in — bestehende Projekte ohne aktivierte Conventions verhalten sich unverändert
- README/CHANGELOG-Auto-Update läuft via Phase-Prompt-Hint an den LLM (nicht
  hardcoded-Edit) — flexibler und respektiert das tatsächliche Repo-Layout
- v663b folgt mit **22 Automation-Templates** (Standup, Release-Pflege,
  Wöchentlich, Code-Review, Dependency, Test-Coverage, Activity-Digest,
  Open-Items-Triage, Doc-Drift, Auto-Rebase, Brainstorming-Pulse, PR-Pflege,
  Security-Sentinel, Performance-Baseline, Onboarding-Doc, Cost-Tracking,
  Stakeholder-Briefing, License-Audit, Pre-Mortem, ADR, Demo-Day-Prep,
  Recurring-Bug-Detector)

## [0.19.0-multi-ha.662] - 2026-05-21

### Added — Telegram Reactions als Feedback-Signal

**Adapter-Layer**:
- Neuer `ReactionEvent`-Type im `@alfred/messaging` mit platform, chatId,
  messageId, added/removed emojis, heuristisches `sentiment` und timestamp
- `MessagingAdapter`-Events um `reaction` erweitert (gehört zum EventEmitter
  generic — Adapter ohne Reaction-Support emittieren es einfach nie)

**Telegram-Adapter**:
- `bot.on('message_reaction')` Listener
- `bot.start({ allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction', 'message_reaction_count'] })` — explizit nötig damit
  Telegram das Update überhaupt zustellt
- Sentiment-Mapping:
  - 👍 ❤️ ❤ 🔥 🎉 🥰 🤩 👏 😍 💯 ✅ 👌 🙏 💪 → **positive**
  - 👎 💩 😡 😢 🤬 🤮 😱 🙄 😤 ❌ → **negative**
  - entfernte Positiv-Reaktion → negative (Korrektur-Signal)
  - alles andere → neutral (kein Memory)

**alfred.ts** (Reaction-Handler):
- Bei `sentiment !== 'neutral'`:
  - Conversation per `chatId` finden
  - Letzte assistant-Message holen (pragmatisch — kein Telegram-msg-id → DB
    Mapping; deckt 99% der Fälle ab da User typisch auf die jüngste Antwort
    reagiert)
  - Memory speichern:
    - **positiv**: `category='feedback'`, `type='pattern'` →
      „User reagierte positiv (👍) auf Alfred-Antwort: '…'. Vorgehen merken,
      ähnliche Situation analog handhaben."
    - **negativ**: `category='feedback'`, `type='correction'` →
      „User reagierte negativ (👎) auf Alfred-Antwort: '…'. Vorgehen ÜBERDENKEN,
      ähnliche Situation anders angehen."
  - confidence 0.85, source 'auto'
- Type `'correction'` wird vom Reasoning-Context-Collector IMMER geladen
  (siehe `fetchMemoriesContextAware` Z.1062) — Memory wirkt sofort beim
  nächsten Reasoning-Cycle
- Type `'pattern'` wird auch immer geladen (max 5)

### Architektur
- Memory-basiert statt eigene Reactions-Tabelle — nutzt existierende
  `fetchMemoriesContextAware`-Pipeline (v653-fix). Reactions = first-class
  Feedback-Signal genau wie Confirmations (v657).
- Snippet auf 200 Chars getrimmt, whitespace-normalisiert
- Key-Format `reaction_<sentiment>_<chatId>_<messageId>` → deterministisch,
  überschreibt sich bei mehrfacher gleicher Reaktion (idempotent)
- Andere Adapter (Discord/WhatsApp/Matrix) emittieren `reaction` aktuell nicht
  — einfache Erweiterung wenn benötigt (Discord MessageReactionAdd Event etc.)

### Notes
- Build grün (12/12)
- Telegram Bot API ≥7.0 erforderlich (release Feb 2024)
- `allowed_updates` muss `message_reaction` enthalten — sonst zustellt Telegram
  die Reactions nicht (häufige Fehlerquelle)
- Für Group-Chats: nur Reactions sichtbarer User-Identitäten zählen — Telegram
  liefert die User-ID nur wenn der Bot Admin ist oder es ein Private-Chat ist

## [0.19.0-multi-ha.661] - 2026-05-21

### Added — Todos + Notes WebUI

**Backend (API)**:
- 5 neue Todo-Endpoints: GET/POST `/api/todos`, PATCH/DELETE `/api/todos/:id`, POST `/api/todos/:id/complete`
- 4 neue Note-Endpoints: GET/POST `/api/notes`, PATCH/DELETE `/api/notes/:id`
- Callbacks nutzen die bereits vorhandenen `TodoRepository` + `NoteRepository`
- Owner-scoped (ownerMasterUserId)

**Frontend**:
- Neue Page `/todos`: 
  - Add-Form mit Titel/Priority/Due-Date/List
  - Filter nach Liste + „Erledigte zeigen"-Toggle
  - Sortierung: Open zuerst, dann nach Priority (urgent/high/normal/low), dann Due-Date
  - Überfällig-Markierung (⏰ rot)
  - One-Click-Complete/Reopen via Checkbox
- Neue Page `/notes`:
  - Split-View: Liste links, Detail/Editor rechts
  - Volltext-Search
  - Markdown-freundlicher Mono-Editor
  - New/Edit/Delete-Aktionen
- Sidebar-Einträge: ✅ Todos + 🗒️ Notes

### Notes
- Build grün (12/12)
- Repos existierten schon, nur WebUI fehlte — keine Migration nötig
- TodoRepository hat (noch) keine generic update — Update geht aktuell nur
  über `completed`-Toggle. Edit-Form für Title/Description/Priority kann später
  ergänzt werden wenn benötigt

## [0.19.0-multi-ha.660] - 2026-05-21

### Improved — Deploy-Modal Runtime Auto-Detect aus Projekt-cwd

**Backend**:
- `lastDeploys`-Callback erweitert: prüft `project.cwd` per `existsSync()` und
  liefert `detectedRuntime` + `detectionReason`
- Detect-Reihenfolge (erst-Match):
  1. `docker-compose.yml` / `compose.yaml` → `docker`
  2. `Dockerfile` → `docker`
  3. `package.json` → `node`
  4. `pyproject.toml` / `requirements.txt` / `setup.py` → `python`
  5. `index.html` → `static`
- Response-Format geändert: `{ deploys: […], detectedRuntime: 'node', detectionReason: 'package.json gefunden' }`

**Frontend**:
- Runtime-Badge neben Label im Form:
  - 🔍 grün wenn aktueller Runtime-Select == detected
  - ⚠ amber wenn Override (User hat manuell anders gewählt)
- Dropdown-Optionen mit `(detected)`-Suffix bei der erkannten Runtime
- Auto-Default-Logik:
  - Wenn letzter Deploy vorhanden → Runtime aus dem letzten Deploy
  - Sonst wenn detected → detected wird Default
  - Bei `docker`-Detect → docker-compose als pm vorbelegt
- `runtimeOverridden`-Flag verhindert dass detected nachträglich überschreibt
- Hover-Tooltip zeigt `detectionReason` (z.B. „Dockerfile gefunden")

### Notes
- Build grün (12/12)
- Backwards-compat: Response ist jetzt Objekt `{deploys, detectedRuntime}` statt
  Array — Client-Code wurde mit-angepasst, kein anderer Konsument existiert
- Detect läuft im Backend (Node fs) — funktioniert auf der Cluster-Node die
  Zugriff auf das Project-cwd hat. Bei verteiltem Mount würde der falsche Node
  ggf. nichts finden — Edge-Case, später lösbar via Node-Targeting

## [0.19.0-multi-ha.659] - 2026-05-21

### Added — Deploy-Trigger pro Projekt in ProjectsPage

**Backend**:
- Neue Projects-Callbacks:
  - `lastDeploys(id)` — parsed alle `deploy_<project>_*`-Memories (Format aus
    deploy.ts:425: `Deployed X → HOST (user=…, runtime=…, pm=…, port=…, am=…)`)
    → liefert sortierte Liste mit host, user, runtime, processManager, composeVariant, port, verified, date
  - `triggerDeploy(id, params)` — führt deploy-Skill via SkillSandbox aus mit
    Form-Params (action='deploy', project, host, user, process_manager, runtime,
    app_port, branch, repo_url). Repo-URL aus Projekt vorbelegt falls nicht
    explizit gesetzt.
- Neue HTTP-Endpoints:
  - `GET /api/projects/:id/last-deploys`
  - `POST /api/projects/:id/deploy`

**Frontend (`ProjectDeployModal.tsx`)**:
- 🚀 Deploy-Button im ProjectsPage Detail Header (rechts neben „Archivieren")
- Modal mit Form:
  - Host * (Pflichtfeld) + User
  - Process-Manager (🐳 docker-compose / ⚙️ pm2 / 🛠 systemd)
  - Runtime (Node / Python / Docker / Static)
  - App-Port + Branch + Repo-URL (default: project.repoUrl)
- Letzte Deploys werden als klickbare Cards angezeigt:
  - Format: `<host> · <user> · <pm> · <runtime> · :<port>` mit ✓ verified + Datum
  - Klick füllt das Form-Felder automatisch aus (One-Click-Reuse)
- Auto-Prefill: aktuellster Deploy wird beim Öffnen automatisch ins Form geladen
- Result-Panel zeigt success/error + display-String vom Deploy-Skill
- Modal-Close via ✕, Klick außerhalb oder „Schließen"

### Notes
- Build grün (12/12)
- Funktioniert auch mit Memories aus Chat-getriggerten Deploys (Telegram, Web-Chat)
  — sie sind dieselben `deploy_*`-Memories
- LLM-Bias zu pm2 ist umgangen: User wählt explizit per Dropdown
- Bei fehlerhaftem Memory-Format wird das Item übersprungen (try/parse silent)

## [0.19.0-multi-ha.658] - 2026-05-21

### Added — Projekt-Chat + Work-Stats + Session-Duration

**Projekt-Chat (eigene Konversation pro Projekt mit Auto-Kontext-Injection)**:
- Migration v79/v82: `conversations.project_id TEXT` + Index
- `Conversation`-Type um `projectId?` erweitert
- `ConversationRepo.findOrCreateForProject(userId, projectId)` — chatId-Konvention `project:<id>`
- `/api/message` akzeptiert optionalen `projectId` Body-Param → routet zur Projekt-Conversation
- `NormalizedMessage.metadata.projectId` durch die Pipeline
- `message-pipeline`: bei `projectId` lädt Projekt-Kontext (cwd, repo, status, beschreibung,
  offene Items, letzte Sessions, letzte Decisions) und injiziert als
  `## Aktiver Projekt-Kontext: <Name>` Block in den System-Prompt
- LLM-Hint: "baue X ein" → project_agent / "deploy auf …" → deploy / "lass uns über X
  brainstormen" → brainstorming / "füge … zur Liste" → add_open_item
- Neue API: `GET /api/projects/:id/chat-history?limit=100`
- WebUI: neue Komponente `ProjectChat.tsx` collapsible Chat-Pane in Project-Detail
  - History-Load bei Aufklappen
  - Stream-Antwort mit Status-Indicator
  - Stop-Button während streaming
  - Welcome-Hints mit Beispiel-Inputs

**Work-Stats (Arbeitszeit pro Projekt nach Type + Agent)**:
- Neue Repository-Methode `ProjectRepository.getWorkStats(projectId)`:
  - `total`: Anzahl Sessions, Gesamt-Sekunden, laufende Sessions
  - `byType`: project_agent / code_agent / brainstorming / delegate — count, totalSeconds, completedCount
  - `byAgent`: claude-code / codex / etc. — count, totalSeconds (LEFT JOIN auf project_agent_sessions)
  - Laufende Sessions zählen now() als endedAt für Live-Anzeige
- Neue API: `GET /api/projects/:id/work-stats`
- WebUI: neue Komponente `ProjectWorkStatsView.tsx` collapsible Section
  - Top: Gesamtzeit + Sessions-Count + Laufende
  - Tabelle "Nach Typ" mit Icon-Labels + Done-Counter
  - Tabelle "Nach Agent" (claude-code, codex, ...)
  - Duration-Formatter: s/m/h/d

**Session-Duration in ProjectAgentsPage**:
- Helper `sessionDuration()` berechnet: bei terminal-Phasen (done/failed) updatedAt-createdAt,
  sonst now()-createdAt mit `running: true`
- Liste-Row: zusätzliches Feld `⏱ 12m 34s` (live-grün wenn läuft, blau wenn fertig)
- Tooltip mit "Gestartet: … Beendet: …" Datum/Uhrzeit
- Detail-Sektion: 3-Spalten-Grid mit Gestartet / Beendet (oder Aktualisiert) / Dauer

**Brainstorming-Integration**:
- LLM-System-Prompt im Projekt-Chat-Kontext schließt brainstorming als Tool ein
- Bei Erkenntnissen schlägt der LLM vor sie als Open-Items zu übernehmen
- Nutzt die existierende v657 Multi-Action Confirmation-Pipeline:
  `enqueue({skillName:'project', skillParams:{action:'add_open_item',...}, extraActions:[{kind:'dismiss'...},{kind:'defer'...}]})`

### Schema (v79/v82)
```sql
ALTER TABLE conversations ADD COLUMN project_id TEXT;
CREATE INDEX idx_conversations_project ON conversations(project_id);
```

### Architektur
- Telegram + WebUI **bleiben funktional unverändert**:
  - Telegram-Chat (global) und Projekt-Chat sind getrennte Conversations
  - Wissen wird automatisch via Memory + KG + Project-Repo geteilt
  - Project-Agent-Starts funktionieren weiterhin via Telegram, im Projekt-Chat ist
    nur der cwd/repo schon vorbelegt
- LLM entscheidet pro Input welcher Skill: project_agent, code_agent, deploy, reminder,
  open_item, brainstorming, oder Direktantwort

### Notes
- Build grün (12/12)
- Backwards-compat: bestehende Conversations ohne project_id laufen wie bisher
- chatHistory-API lädt max 200 Messages (`?limit=N` einstellbar)
- Project-Chat Frontend lädt History on-demand (beim ersten Aufklappen)

## [0.19.0-multi-ha.657] - 2026-05-21

### Added — Multi-Action Confirmations + Reply-Kontext

**Multi-Action Confirmations (`ConfirmationQueue`)**:
- Migration v78/v81: `pending_confirmations.extra_actions TEXT` (JSON-Array)
- Neuer Type `ConfirmationExtraAction` mit 4 Kinds:
  - `skill` — führt skillName/skillParams aus, löst als 'approved'
  - `dismiss` — markiert als 'rejected', Eskalation bleibt deduped
  - `cancel-item` — schließt verlinktes Open-Item (`status='cancelled'`)
  - `defer` — löscht Eskalations-Marker + setzt Snooze-Memory bis +N Stunden
- `enqueue()` neuer Param `extraActions?` → Telegram Inline-Keyboard wird dynamisch
  (Standard ✅/❌ Row + extra Rows max 3 Buttons/Row)
- `checkForConfirmation()` extended Callback-Pattern: `confirm:<id>:<custom-key>`
- `handleWebDecision()` akzeptiert custom-keys (Side-Panel kann extra-Actions auslösen)
- ProjectRepo + MemoryRepo via `setProjectRepo()`/`setMemoryRepo()` für cancel/defer-Handler

**Open-Items-Reflector**:
- Nutzt jetzt `confirmationQueue.enqueue()` statt nackten Adapter-Send
- 4 Action-Buttons in Telegram + WebUI Side-Panel:
  - ✅ **Ja** → `project_agent.start` mit Item-Titel als Goal, cwd vom Projekt
  - ❌ **Nein** → keine Aktion, Dedup-Marker bleibt (keine Re-Eskalation)
  - 🗑 **Open-Item ablehnen** → `cancel-item`-Handler setzt Item auf `cancelled`
  - ⏰ **24h zurückstellen** → `defer`-Handler, Snooze-Memory bis +24h
- Snooze-Check beim hourly Sweep: skipped Items mit aktivem Snooze
- Fallback auf plain-text wenn confirmationQueue nicht verkabelt (legacy)

**HTTP-API + WebUI Side-Panel**:
- `POST /api/confirmations/:id/:key` akzeptiert beliebige extraAction-keys (cancel_item, snooze_24h, etc.)
- `PendingConfirmationItem` mit `extraActions[]` Property
- Side-Panel rendert die extra-Buttons als zweite Button-Row, blue-Theme

**Telegram Reply-Kontext**:
- `NormalizedMessage.replyToText` + `replyToFrom` neu im Schema
- Telegram-Adapter füllt aus `msg.reply_to_message.{text, caption, from}` direkt
  (keine DB-Lookup nötig — Telegram Update enthält das komplette Objekt)
- `message-pipeline.buildReplyContextPrefix()`: prependet
  `[User antwortet auf Nachricht von <Name>: "<Text auf 300 Chars>"]` an User-Prompt
- Wirkt sowohl im Text-only-Pfad als auch beim multi-modal-Block-Pfad

**WebUI Reply-Funktion**:
- `↩ Reply`-Knopf in der Hover-Action-Bar jeder Chat-Nachricht (`ChatMessage`)
- Reply-Banner über dem Input mit `From: ...` + getrimmtem Text + ✕ Button
- `useChat.sendMessage()` + `client.streamMessage()` nehmen `replyTo` Param
- `/api/message` POST-Body um `replyToText` / `replyToFrom` / `replyToMessageId` erweitert
- HTTP-Adapter füllt das in `NormalizedMessage` durch — selber Pipeline-Pfad wie Telegram

### Schema (v78/v81)
```sql
ALTER TABLE pending_confirmations ADD COLUMN extra_actions TEXT;
```

### Notes
- Build grün (12/12)
- Multi-Action ist abwärtskompatibel — bestehende Confirmations ohne extra_actions
  rendern wie bisher (nur Standard ✅/❌)
- Reply-Kontext ist additiv — Nachrichten ohne replyToText laufen unverändert
- Andere Adapter (Discord/WhatsApp/Matrix) füllen `replyToText` aktuell nicht;
  einfache Erweiterung wenn benötigt (siehe Telegram-Adapter als Vorlage)
- Side-Panel zeigt extra-Actions nur wenn der Server sie liefert (kein Schema-Change im UI nötig)

## [0.19.0-multi-ha.656] - 2026-05-21

### Added — Dashboard Stunden-Granularität + Timezone-aware Bucketing

**Befund (Timezone-Bug):**
`usage-repository.ts:32` und `service-usage-repository.ts:43` nutzten
`new Date().toISOString().slice(0,10)` → **UTC-Datum**. In Europe/Vienna
(CEST=UTC+2) wurden die ersten 2h des lokalen Tages noch unter dem UTC-Datum
des Vortags gebucht → User-Report „um 00:00 lokal kein neuer Tag".
Profile-Timezone existierte schon (`getProfile().timezone`, wird in alfred.ts
für Reasoning genutzt), aber Usage-Repos hatten keinen Bezug dazu.

**Fix Timezone:**
- `UsageRepository.setTimezone(tz)` und `ServiceUsageRepository.setTimezone(tz)`
- Bucketing via `Intl.DateTimeFormat('en-CA', { timeZone })` → YYYY-MM-DD lokal
- `alfred.ts` reicht `userTimezone` an beide Repos durch (nach Profile-Resolve)
- Dashboard-Callback: `today` wird jetzt lokal aufgelöst, alle `startDate`-
  Berechnungen für week/month/year sind lokal-relativ
- `cleanup()` Cutoff in Lokalzeit

**Neu (Hourly Buckets):**
- Migration SQLite v77 / PG v80: neue Tabelle `llm_usage_hourly`
  - `hour_bucket TEXT` (Format `YYYY-MM-DDTHH`, Lokalzeit), UNIQUE(hour_bucket, model)
  - Index `idx_llm_usage_hourly_bucket`
- `UsageRepository.record()` schreibt **parallel** in `llm_usage` (Tag) und
  `llm_usage_hourly` (Stunde). Backward-compat: try/catch falls Migration noch
  nicht durch.
- `UsageRepository.getHourly(date)` liefert exakt 24 Buckets (leere Stunden = 0)
- `UsageRepository.cleanupHourly(62)` — Retention für aktueller + Vormonat
- Dashboard-Endpoint nimmt neue Query-Params:
  - `granularity=hour` → Stundenmodus
  - `date=YYYY-MM-DD` → wählbarer Tag (sonst heute)
- Response enthält `bucketGranularity: 'hour'` und `hourlyDate`

**Frontend (Dashboard):**
- Neuer „⏱ Stündlich"-Toggle neben dem Range-Selector
- Bei aktivem Toggle: HTML5 Date-Picker mit `min=heute-62d`, `max=heute`
- 24 Balken statt 1, Bucket-Label „HH" (z.B. „14h")
- KPI-Karten zeigen Datum statt Range-Label im Hourly-Modus
- Range + Hourly mutually exclusive (Range-Click resettet Hourly)

**Schema (Hourly-Tabelle):**
```sql
CREATE TABLE llm_usage_hourly (
  id, hour_bucket TEXT, model TEXT,
  calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
  UNIQUE(hour_bucket, model)
);
```

### Notes
- Build grün (12/12)
- Historische Daten (vor v656) haben keine Stunden-Auflösung → bei Datum < v656-Deploy
  zeigt Hourly-Modus 0-Buckets bzw. lückenhaft. Frontend zeigt das transparent.
- TZ-Fix wirkt sich auch auf die **bestehende** Tages-Aggregation (`llm_usage`) aus —
  ab v656 fallen Buckets nach Lokal-Datum statt UTC. Alte UTC-Buckets bleiben
  unverändert in der DB (keine destruktive Migration). Drift maximal ein paar
  Stunden bei Tagesgrenzen.
- HA-Cluster: beide Nodes schreiben in dieselbe Tabelle → `ON CONFLICT(hour_bucket, model)
  DO UPDATE` löst Race-Conditions.

## [0.19.0-multi-ha.655] - 2026-05-21

### Fixed — Dashboard: Tokens-KPI folgt dem Range-Selector

`DashboardPage.tsx`:
- Karte „Tokens heute" hing fest auf `today.totalInputTokens` / `today.totalOutputTokens`,
  während daneben der Range-Selector (today/week/month/year/all) bereits für die
  Kosten-Karte und das Bucket-Diagramm gilt
- Karte umgestellt auf `rangeInputTokens` / `rangeOutputTokens` aus
  `buckets.reduce((s,d) => s + d.totalInputTokens, 0)` analog zu `rangeTotal`/`rangeCalls`
- Title-Label folgt jetzt `RANGE_LABELS[range]` („Tokens Heute", „Tokens Woche", etc.)
- Tooltip auf den Token-Werten zeigt die volle Zahl mit DE-Locale-Tausendertrennung
  (z.B. `1.234.567 Input-Tokens`)
- Backend-Daten unverändert — `DailyUsageSummary` enthielt `totalInputTokens`/
  `totalOutputTokens` schon, die wurden nur nicht aggregiert für die KPI-Karte

### Notes
- Build grün (12/12)
- Sidebar-Mini-Anzeige bleibt unverändert auf „heute" — User-Request bezog sich
  explizit auf das Dashboard

## [0.19.0-multi-ha.654] - 2026-05-21

### Fixed — WebUI: Projekte erledigte Items + ITSM Aktiv-Filter

**Projekte-WebUI (`ProjectsPage.tsx`)**:
- Frontend filterte hart `status === 'open'` → erledigte (`done`/`cancelled`) und
  in-progress Items waren komplett unsichtbar, obwohl die API alle 4 Statuses
  zurückliefert (`projRepo.listOpenItems(uid, { projectId, limit: 200 })` ohne
  Status-Filter). Backend war OK, Frontend zeigte Daten nicht.
- Neue collapsed „Erledigt"-Section unter der offenen-Liste:
  - Zeigt `resolvedAt` formatiert (DE-Locale), counter mit „zuletzt vor X" Hinweis
  - Auto-Resolved-Items mit 🤖 Tooltip (voller `autoResolvedBy`-String, Confidence%)
  - Cancelled-Items mit ✖ statt ☑
  - max 50 sichtbar, dann „+N weitere" Hinweis
- `in_progress`-Items in der offenen-Liste mit 🔄 statt Priority-Icon — sieht man
  dass Project-Agent gerade dran arbeitet
- Expandable Item-Details (Klick auf Titel klappt Block aus):
  - `description` (whitespace-preserved)
  - `dueAt` mit Überfällig-Markierung (🔴 wenn in Vergangenheit)
  - `linkedIncidentId` → Link `/itsm?incident=...`
  - `linkedChangeId` → Link `/itsm?change=...`
  - `sessionId` → Link `/project-agents?task=...`
  - Voller `autoResolvedBy`-String (statt 40-Char-Trunkierung)
- Frontend-Type `ProjectOpenItem` (`alfred-client.ts:1410`): fehlende Felder
  `linkedIncidentId` + `linkedChangeId` ergänzt — waren im Backend-Type vorhanden
  aber im Frontend-Type nicht spiegelbildlich

**ITSM Changes + Problems wurden nicht angezeigt (`ItsmPage.tsx`)**:
Root-Cause: Frontend defaultete `chgStatusFilter = 'active'` und `incStatusFilter
= 'active'` als UI-Pseudo-Status (= Multi-Status-Filter „pending+approved+in_progress"
bzw. „open+acknowledged+investigating+mitigating"). Diese Pseudo-Werte wurden ungefilter
an die API geschickt: `loadChanges` Z.417 `filters.status = chgStatusFilter` →
`GET /api/itsm/changes?status=active` → `WHERE status = 'active'` (existiert nicht im
DB-Status-Enum) → **0 Treffer**.

Die korrekte Filter-Logik existierte im Frontend (`applyChgFilter` Z.858 mit
`CHANGE_ACTIVE_STATES`-Set), wurde aber nie aktiv weil API schon leer zurückgab.

- **Fix** in `loadIncidents`/`loadChanges`/`loadProblems`: `'active'` wird **nicht**
  als API-Filter weitergegeben — alles laden, dann via `applyXxxFilter` client-side
  filtern. Korrekte Stati (draft/pending/approved/etc.) bleiben unverändert weiter
  als API-Filter aktiv.

### Notes
- Build grün (12/12)
- Backend-Code unverändert — alle Fixes im Frontend
- Bei Problems war zusätzlich toter Code aufgefallen: zwei doppelte States
  (`probStatusFilter` ungenutzt + `prbStatusFilter2` der echte) — Fix bleibt
  defensive auch für `probStatusFilter`, Aufräumen separat
- userId-Mismatch oder API-Bug war NICHT die Ursache — verifiziert durch Code-Trace
  (Endpoints `/api/itsm/changes`, `/api/itsm/problems` + Callbacks korrekt verdrahtet)

## [0.19.0-multi-ha.653] - 2026-05-21

### Fixed — Reasoning halluziniert keine Entity-IDs mehr

**Root-Cause-Befund:**
Im Reasoning-Pfad zur Confirmation-Queue gab es drei verkettete Fehler die zusammen
zur Symptomatik „Incident 4b304796 nicht gefunden — passiert immer wieder" führten:

1. `reasoning-context-collector.ts` rief vier ITSM-Listen-Skills mit `{} as any` als
   Context auf (`list_incidents`, `list_changes`, `list_problems`, `check_sla_compliance`).
   ITSM-Skill resolved `userId = context.masterUserId || context.userId` → `undefined`.
   SQL-Param `[undefined]` → SQLite TypeError (gecatcht → success:false) bzw. Postgres
   NULL-Compare (immer false). **Resultat: leere Listen, keine echten IDs im Reasoning-Context.**

2. System-Prompt zeigte konkrete Beispiel-Hex-IDs (`"0815bc66"`, `"a3f2c8e1"`) als
   Action-Template. Ohne reale IDs im Context: **LLM imitiert das Muster und erfindet
   plausibel aussehende 8-Hex-Strings** (Mustermimikry).

3. Validator vor `enqueue` prüfte nur den Action-Namen gegen das Skill-Enum, **NICHT**
   ob referenzierte `incident_id` / `change_id` / `problem_id` real existieren.
   → Confirmation 24h pending, beim „ja" findet die Skill nichts → 404.

**Fixes (Bundle):**

- **P0a** (`reasoning-context-collector.ts:670-783`): 4× `{} as any` durch
  `buildSkillContext(userRepo, {userId: defaultChatId, platform: defaultPlatform, ...})`
  ersetzt. Context wird einmal pro Reasoning-Tick gebaut und für alle ITSM-Listen
  wiederverwendet. → echte Incident/Change/Problem-IDs im LLM-Kontext.

- **P0b** (`reasoning-engine.ts:1629`): Action-Validator erweitert. Bei
  `skillName === 'itsm'` und gesetzter `incident_id`/`change_id`/`problem_id` wird
  vor `confirmationQueue.enqueue()` ein `get_incident`/`get_change`/`get_problem`-Lookup
  ausgeführt. Bei `success:false`: Action **gedroppt, NICHT enqueued**, WARN-Log mit
  `halluzinatedRef`. Bei Lookup-Exception (Network/DB-Fehler): Check übersprungen
  (treated as valid — fail-open damit transiente Fehler keine validen Aktionen blocken).

- **P1** (`reasoning-engine.ts:880-888`): Konkrete Beispiel-Hex-IDs (`0815bc66`,
  `a3f2c8e1`) durch Platzhalter `<id-aus-liste>` ersetzt. WICHTIG-Hinweis verschärft:
  „nicht aus dem Beispiel-Platzhalter ableiten — wenn KEINE passende ID in der Liste
  steht: KEIN update_incident enqueuen, stattdessen create_incident". Entzieht dem
  LLM die Schablone für Halluzination.

### Notes
- Build grün (12/12)
- P0a + P0b sind die strukturellen Fixes — selbst wenn Beobachtung 1 jemals
  regressiert, fängt der Validator (P0b) halluzinierte IDs ab
- P1 ist Defense-in-depth — reduziert Wahrscheinlichkeit dass der LLM überhaupt
  versucht zu halluzinieren
- Owner-Chat-Resolve-Pfad ist KORREKT (Monitor-Auto-Incident und Confirmation-Execution
  nutzen dieselbe `ownerMasterUserId`) — die ursprüngliche userId-Mismatch-Hypothese
  war eine **ungeprüfte Vermutung** und wurde durch Code-Trace widerlegt

## [0.19.0-multi-ha.652] - 2026-05-21

### Added — Project-Agent Smart (Bundle 5 von 5)

**#9 Auto-Resume opt-in**:
- `ProjectAgentConfig.autoResume` flag (`auto_resume=true` per Skill)
- Bei terminal-Failure: sendet "⏳ Auto-Resume in 30s …" Hinweis, dann
  ruft `autoResumeCallback(failedTaskId, "Auto-Resume Versuch n/2")` auf
- `setTimeout(30_000)` damit User noch Stop drücken kann (Live-WebUI v651)
- Hardlimit: max 2 Auto-Resumes pro Session-Kette gegen Infinite-Loops
- `auto_resume_count` Spalte auf project_agent_sessions (Migration 76/79),
  per `incrementAutoResumeCount()` atomic erhöht

**#16 Pattern-Memorierung**:
- Neue Tabelle `project_agent_lessons` (cwd, pattern, advice, occurrences)
- `ProjectAgentLessonsRepository.upsert()` mit Counter und Unique(cwd, pattern)
- Bei Failure: `extractBuildError().summary` wird als Pattern persistiert,
  Failure-Insight als advice
- Bei Run-Start: Lessons für die cwd geladen (min 2 occurrences), in jedem
  Phase-Prompt via `assemblePrompt(…, lessonsHint)` eingespeist:
  `"LESSONS aus früheren Runs in dieser cwd: [3× erlebt] X → Vermeide Y"`

**#19 Failure-Insight**:
- LLM-Call (tier='fast', 600 tokens, temp 0.3) generiert kompakten
  Lessons-Learned-Text — max 5 Zeilen, deutsch, konkret
- Wird sowohl bei Done als auch Failed aufgerufen (Erfolg = "was war effektiv",
  Misserfolg = "Root-Cause + nächster Schritt")
- Persistiert in `project_agent_sessions.failure_insight` (Migration 76/79)
- Im WebUI: Amber-Karte "💡 Lessons" in der Detail-Ansicht
- Auch in Chat-Reply nach Session-Ende: "💡 Insight: …"

### Storage
- SQLite Migration v76 + Postgres Migration v79:
  - `project_agent_sessions.failure_insight TEXT`
  - `project_agent_sessions.auto_resume_count INTEGER DEFAULT 0`
  - Neue Tabelle `project_agent_lessons` (id, cwd, pattern, advice, occurrences, last_seen_at, created_at)
  - Indizes: `idx_pa_lessons_cwd(cwd, last_seen_at DESC)`, `uq_pa_lessons_cwd_pattern(cwd, pattern)`

### Architecture
- Lessons werden **einmal pro Run** geladen (am Start), nicht pro Phase — spart DB-Calls
- Pattern-Mining ist konservativ: nur `extractBuildError.recognized` summaries werden persistiert (keine generischen Stack-Traces als Pattern)
- Auto-Resume nutzt die existierende `project_agent.resume`-Action (v648), keine Sonderpfade
- Failure-Insight braucht den LLM-Provider — die `LLMProvider.complete()`-API ist abstrakt und providers- agnostic

### Notes
- Build grün (12/12)
- Komplette Bundle-Reihe v648-v652 abgeschlossen
- Alle drei Features (Auto-Resume, Lessons, Insight) sind opt-in oder rein additiv — bestehende Workflows unverändert

## [0.19.0-multi-ha.651] - 2026-05-21

### Added — Project-Agent Live UX (Bundle 4 von 5)

**#10 SSE Output-Stream**:
- Neuer In-Memory-Ring-Buffer pro Session in `project-agent-skill.ts`
  - `outputBuffers: Map<taskId, { lines, subscribers, endedAt? }>`
  - 500 Zeilen max pro Session, 5min Retention nach `markOutputEnded()`
- 3 Quellen pumpen in den Buffer:
  - `agent-executor` stdout/stderr (per-Zeile, `taskId` Option neu)
  - `project-agent-runner.sendProgress` (System-Events: Phase-Start, Build-Ergebnis) via `AsyncLocalStorage`-Context — kein Refactoring der 46 sendProgress-Call-Sites nötig
- Neue HTTP-Endpoints:
  - `GET /api/project-agents/:taskId/output` — Server-Sent-Events
    - Beim Connect: `event: history` mit gepufferten Zeilen
    - Danach `event: line` pro neuer Zeile
    - Heartbeat-Comment alle 25s gegen Proxy-Timeouts
    - `X-Accel-Buffering: no` damit Nginx nicht puffert
  - EventSource Token-Fallback über `?token=…` Query-Param
- Cleanup: bei `req.close`/`req.error` unsubscribe(), `markOutputEnded()` im Runner-finally

**#11 Live-Interjection im WebUI**:
- Neuer Endpoint `POST /api/project-agents/:taskId/interject` — bestehende v605-Pipeline
- WebUI ProjectAgentsPage für laufende Sessions:
  - Schwarze Output-Box (h-48 scroll-auto-bottom) Farbcodiert stdout=grau, stderr=rot, system=blau
  - Text-Input + Senden-Button, Enter sendet
  - SSE-EventSource bei selected-Wechsel sauber geschlossen + neu geöffnet
- Auto-Scroll, max 800 Zeilen im Frontend-Buffer

### Architecture
- `AsyncLocalStorage` für sessionId-Propagation durch sendProgress — sauberer als 46 Call-Sites umschreiben oder Map-by-chatId (race-anfällig bei parallelen Sessions im selben Chat)
- Ring-Buffer:
  - Geboren bei erstem `appendOutputLine()` oder erstem Subscriber
  - `endedAt` nach Session-Ende → 5min Retention dann freigegeben
  - Spät-Connector bekommt letzte 500 Zeilen für 5min

### Notes
- Build grün (12/12)
- 1 EventSource pro WebUI-Klient — Subscriber-Liste pro Session
- Live-Interjection nutzt drainInterjections() im Phase-Loop (selber Pfad wie Telegram)
- Auth: API-Token + User-Session-Token via Query-Param

## [0.19.0-multi-ha.650] - 2026-05-21

### Added — Project-Agent Safety (Bundle 3 von 5)

**#8 Secret-Scan vor Commit**:
- Neue `scanDiffForSecrets(cwd, runAsUser)` Helper im project-agent-runner
- Pattern-Liste: AWS Access Keys (AKIA…), GitHub Tokens (ghp_/gho_/ghs_), GitLab Tokens (glpat-), OpenAI/Anthropic Keys (sk-…/sk-ant-), Stripe Secret Keys (sk_live_), Slack Tokens (xox[abp]-), Private RSA-Keys, JWT-Tokens
- Scan läuft auf `git diff HEAD --unified=0` vor jedem Commit
- Bei Funden: Commit ABGEBROCHEN, Phase → 'failed', runFailed=true, Liste der Funde in Progress-Message + Log
- Konservativ: standalone "AWS Secret Key" Pattern (40 char Base64) wird explizit übersprungen weil zu false-positive-anfällig

**#6 Branch-per-Session** (opt-in):
- `ProjectAgentConfig.branchPerSession?` flag
- Skill-Action akzeptiert `branchPerSession=true` oder `branch_per_session=true`
- Wenn gesetzt: nach Plan-Persistierung wird `feature/agent-<sessionId-prefix>` per `git checkout -b` erstellt
- Alle Phase-Commits laufen auf diesen Branch, Push erzeugt Merge-Request via existing `extractPushUrl` (v643)

**#5 Plan-Review-Step** (opt-in):
- `ProjectAgentConfig.confirmPlan?` flag (`confirm_plan=true` per Skill)
- Vor Phase 1: Plan-Display + Wartet auf Interjection
- "ok"/"approve"/"go" → starte Phase 1
- Beliebiges anderes Feedback → notiert + Run abgebrochen mit Hinweis "starte neu mit angepasstem Goal"
- 30min Timeout, danach Abbruch

**#23 Stop-Signal-Cleanup**:
- `executeAgent(opts.signal?: AbortSignal)` neuer Parameter
- Bei aborted: Process-Tree-Kill via `process.kill(-pid, 'SIGTERM')` (detached spawn macht pid auch zur process-group-id)
- Nach 3s SIGKILL als Sicherheits-Backup
- kill-Reason in stderr annotiert: `[agent-executor] killed: caller aborted (Stop-Signal)`
- Runner: bei `__STOP__`-Interjection wird `abortController.abort()` aufgerufen — laufende Sub-Process-Trees werden sofort sauber beendet

### Notes
- Build grün (12/12)
- Secret-Scan ist **konservativ** — Patterns matchen nur eindeutige Token-Formate, kein generischer Hex-/Base64-Scan
- Branch-per-Session ist opt-in damit existierende Workflows die direkt auf default branch arbeiten unverändert bleiben
- Plan-Review-Step ist opt-in für die Fälle wo der User explizit Kontrolle will (typisch große Refactorings)
- Stop-Cleanup beeinflusst nicht den Happy-Path — wirkt nur wenn signal.abort() gefeuert wird

## [0.19.0-multi-ha.649] - 2026-05-21

### Added — Project-Agent Quick-Wins (Bundle 2 von 5)

**#3 WebUI Resume-Button** im /project-agents Tab:
- `client.resumeProjectAgent(failedTaskId, notes?)` Client-Methode
- `POST /api/project-agents/:taskId/resume` Backend-Endpoint
- `setProjectAgentCallbacks` um `resume` + `plan` erweitert
- ProjectAgentsPage: Resume-Button erscheint für failed/done/awaiting_user Sessions, fragt nach optionalen Notes via prompt(), zeigt neue Task-ID
- Plan-Endpoint `GET /api/project-agents/:taskId/plan` liefert den persisted Plan aus v648

**#4 Pre-Flight erweitert** (`extendedPreflight` in project-agent-skill.ts):
- Agent-Binary-Check (`<command> --version` exit-status)
- Git-Identity-Probe (`git config user.name` gesetzt?)
- Disk-Space-Warnung (statfs <0.5GB)
- Build-Tools (npm/cargo) je nach erkanntem Projekt-Typ
- Warnungen werden im start-Result als `preflightWarnings` mitgegeben und im Display angezeigt — kein blockender Stop

**#21 Auto-Test-Discovery** (`autoDetectBuildCommands`):
- Liest `package.json` und mappt Scripts (install / build / typecheck / lint / test)
- Detect pnpm/yarn/npm via lockfile
- Fallback `Cargo.toml` → `cargo build` + `cargo test`
- Fallback `pyproject.toml` → `pip install -e .` + pytest wenn erkannt
- Fallback `go.mod` → `go build ./... + go test ./...`
- Override-Priorität: explizite Input-Params > Template > Auto-Detect > Default
- Display zeigt "🔎 Auto-Detect: N Build- + M Test-Commands erkannt"

**#9 Goal-Templates** — folgen in v651 als Teil der WebUI-Welcome-Erweiterung (Quick-Start-Cards), da hier Skill-Side nichts zu tun ist

**#10 Open-Item-direkter-Start** — kommt in v651, ist ein UI-Refactor in ProjectsPage

### Notes
- Build grün (12/12)
- Pre-Flight ist non-blocking — Warnungen werden gezeigt aber Run startet trotzdem
- Auto-Detect erkennt jetzt: package.json / Cargo.toml / pyproject.toml / go.mod — weitere Projekttypen einfach in `autoDetectBuildCommands` ergänzen
- v650 (Safety) folgt direkt

## [0.19.0-multi-ha.648] - 2026-05-21

### Added — Resume-Foundation (Bundle 1 von 5)

Persisted-Plan + Phase-Timing + echte Resume-Action. Voraussetzung für die folgenden v649-v652 Bundles.

**Schema** (SQLite v75 / Postgres v78):
- Neue Tabelle `project_agent_plans(id, session_id, phase_idx UNIQUE pro session, description, status, started_at, ended_at)` mit Index auf `(session_id, phase_idx)`
- `project_agent_sessions.resumed_from_task_id` für Traceability

**Repository** `ProjectAgentPlansRepository`:
- `bulkInsert(sessionId, phases)` — speichert alle Plan-Phasen mit Status='planned'
- `markRunning/markDone/markFailed(sessionId, phaseIdx)` — Status + Timestamps fortschreiben
- `listBySession(sessionId)` — komplette Plan-History mit Status/Times

**Runner-Hooks** (`packages/core/src/project-agent-runner.ts`):
- Nach Plan-Generation: `bulkInsert` aller geplanten Phasen
- Phase-Loop-Start: `markRunning(phaseIdx + 1)`
- Phase erfolgreich (nach Milestone-Add): `markDone(phaseIdx + 1)`
- Phase exitCode≠0: `markFailed(phaseIdx + 1)` (parallel zum existing v636-runFailed-Pattern)

**Resume-Action** `project_agent resume failed_task_id=<id> notes?=<text>`:
- Erlaubt für Sessions im Status failed/awaiting_user/done
- Liest persisted Plan via `plansRepo.listBySession`, baut Status-Übersicht (✓ done / ✗ failed / ◐ running / ○ planned)
- Konstruiert Continuation-Goal mit:
  - Original-Ziel (gekürzt)
  - Status zum Abbruch (Phase-Index, Files, Build, Last-Commit)
  - Plan-Tabelle mit Erfolgs-Markern
  - Erreichte Milestones (letzte 10)
  - Optional User-Notes
  - Explizite "ERSTE PHASE: scanne Repo-Stand + matched gegen Original-Ziel" Anweisung
- Startet via `startProject` mit `_resumedFromTaskId` Marker
- Neue Session bekommt `resumed_from_task_id=<old>` für Traceability

### Workflow für 471cd234
```
Alfred, resume 471cd234-2499-4e9f-86d5-0f2f3a01117e
```
oder mit User-Note:
```
Alfred, resume 471cd234 — fokus nur auf französische Übersetzungen, restliches i18n war ok
```

Der neue Project-Agent bekommt den vollen Plan-Status + Last-Commit als Kontext und untersucht den Repo-Stand als allererste Phase.

### Notes
- Build grün (12/12)
- Bestehende Sessions ohne persisted plan (alle Sessions vor v648) funktionieren weiterhin — Resume-Action zeigt dann nur Milestones statt Plan-Tabelle
- v649-v652 bauen auf diesem Foundation auf

## [0.19.0-multi-ha.647] - 2026-05-21

### Fixed — Sidebar-Deep-Links: Klick auf Projekte/Chats öffnet jetzt das gewählte Item

**Symptom (v646)**: User-Report: Klick auf ein Projekt in der Sidebar öffnete die Projekt-Übersicht ohne Auswahl, gleiches Verhalten bei Chats — der Klick navigierte zur Page-Liste, aber das gewählte Item wurde nicht auto-selektiert.

**Ursache**:
- Sidebar-Projekte: `<a href="/alfred/projects/">` ohne ID-Parameter
- Sidebar-Chats: `localStorage.setItem('alfred-chat-active-conversation-id', id)` + Navigation zu `/chat/` — aber `useChat`-Hook hat den localStorage-Key nicht gelesen
- Beides resultierte in: navigate-to-page-aber-zeige-Standardansicht

**Fix v647**:

1. **Sidebar** (`apps/web/src/components/layout/Sidebar.tsx`):
   - `openProject(id)` → `/alfred/projects/?id=<projectId>` Deep-Link
   - `openConversation(c)` differenziert nach Platform:
     - `api`/web-Chats → `localStorage.setItem('alfred-chat-active-conversation-id')` + Navigation zu `/chat/`
     - Matrix/Telegram/Discord/etc. → `/alfred/history/?id=<conversationId>` (read-only View, weil ChatPage Messages nur als Platform=api versendet)
   - Tooltip auf Chat-Items zeigt jetzt "Im Chat fortsetzen" vs "In History öffnen (read-only)"

2. **ProjectsPage** (`apps/web/src/components/projects/ProjectsPage.tsx`):
   - useEffect liest `?id=` aus URL beim Mount, setzt `selectedId` → triggert existierende `loadDetail()`-Logik, Detail-Panel öffnet automatisch

3. **HistoryPage** (`apps/web/src/components/history/HistoryPage.tsx`):
   - useEffect liest `?id=` aus URL beim Mount (gated auf `client` damit Repository-Helper bereit ist), ruft `loadConversation(id)` → Detail-Panel öffnet mit Messages-Lazy-Load

4. **useChat** (`apps/web/src/hooks/useChat.ts`):
   - Liest `alfred-chat-active-conversation-id` aus localStorage beim Initialisieren
   - Wenn gesetzt: `fetchConversationMessages(id, 500)` und befüllt den Reducer-State mit User-/Assistant-Messages
   - localStorage-Key wird nach dem Laden wieder gelöscht — sonst würde Reload doppelt laden
   - `loadedConvOnceRef` als Re-Mount-Guard

### Notes
- Build grün (12/12), nur Web-Bundle verändert
- Keine Schema-Änderungen, keine API-Änderungen
- Bestehendes "Im Chat fortsetzen"-Button in History-Detail-View (v644) nutzt denselben localStorage-Mechanismus, profitiert automatisch
- v647 ergänzt **kein** Projekt-Agent-Resume (separate Funktion, kann später folgen) — heute zeigt v605 M6 schon Hint mit `getHistoryByCwd` beim Start im selben Verzeichnis

## [0.19.0-multi-ha.646] - 2026-05-21

### Improved — Sidebar-Umbau (Variante B) + Chat-Welcome-View

Sidebar wechselt von einer flachen 18-Item-Liste zu einem strukturierten Layout im Stil moderner Chat-UIs (Claude-Code / ChatGPT). Funktional verliert nichts — alle Routes bleiben erreichbar, nur visuell aufgeräumt.

**Neue Sidebar-Struktur** (`apps/web/src/components/layout/Sidebar.tsx`):

1. **Quick-Actions oben** (immer sichtbar):
   - 💬 **Neuer Chat** — clears localStorage und navigiert zu /chat
   - 🔍 **Suche & History** — geht zu /history (mit Ctrl+K Volltext-Search innerhalb)
   - 💡 **Insights** — Counter-Badge zeigt pending-Anzahl aus `/api/insights/stats`
   - 🎯 **Goals** — Counter-Badge mit aktiven Goals

2. **Projekte-Sektion** (sichtbar wenn ≥1 aktives Projekt):
   - Top-8 active Projects als klickbare Items mit 📁-Icon
   - "Alle ›"-Link in der Section-Header zu /projects

3. **Chats-Sektion** (sichtbar wenn ≥1 nicht-scheduled Conversation):
   - Top-10 Conversations (sortiert pinned_first), mit Platform-Icon + Pin-Marker
   - Klick speichert `alfred-chat-active-conversation-id` und navigiert zu /chat
   - Custom-Label statt chatId wenn vorhanden (v644)
   - "Alle ›"-Link zur vollen History

4. **🛠️ Tools** (collapsible, State persistiert in localStorage):
   - Default zu, expanded zeigt: Dashboard, Knowledge, Memories, Runbooks, Project-Agents, Background-Tasks, CMDB, ITSM, Services, Docs, Logs, Cluster
   - 12 Routes — alles was nicht primary aber wichtig ist

5. **Account-Box unten** (collapsible):
   - Default zu: zeigt Username + Role
   - Expanded: Einstellungen / Verbrauch (Token + $Kosten heute aus /api/dashboard) / GitHub / Abmelden

**Chat-Welcome-View** (`apps/web/src/components/chat/ChatWelcome.tsx`):

- Wird statt der alten "Alfred"-Headline angezeigt sobald `messages.length === 0`
- **Hero**: "Woran sollen wir arbeiten?" + Slash-Befehl-Tipp
- **3-4 dynamische Connector-Cards** mit Live-Daten:
  - 💡 Pending Insights (mit Counter)
  - ✅ Pending Confirmations (Counter aus side-panel-API)
  - ⏰ Anstehende Reminders (nächster mit Time-Stamp)
  - 🎯 Überfällige Goal-Checks
  - 🤖 Active Project-Agents (mit aktueller Phase)
  - Wenn nichts pending → Fallback-Cards: Knowledge-Graph / Runbooks / Projekte
- Cards mit hover-Border, klick navigiert zur entsprechenden Page
- Graceful degradation bei fehlenden Daten

**Layout**:
- Sidebar-Breite 16/56 → uniform 64 (256px) — Labels immer sichtbar (kein collapsed mode mehr nötig — die Sidebar ist jetzt strukturiert genug)
- Account-Box sticky bottom mit explicit border-t für visuelle Trennung

### Notes
- Build grün (12/12), Routen unverändert in Größe (Chat 165B+158kB shared)
- Existing-Pages (ItsmPage, ProjectsPage, etc.) komplett unangetastet
- Keine API-Änderungen — nur 5 existing Endpoints werden in der Sidebar parallel gefetched
- Layout-Anpassungen für Mobile-Drawer können in v647 folgen falls gewünscht

## [0.19.0-multi-ha.645] - 2026-05-21

### Improved — ITSM-UI: Closed default aus, Bulk-Actions überall, Stats-Bar

**A. Closed Incidents default ausblenden**:
- Neue Pseudo-Filter-Option `active` als default für Incidents, Changes, Problems
- Incidents-Active = open/acknowledged/investigating/mitigating
- Changes-Active = pending/approved/in_progress
- Problems-Active = open/analyzing/root_cause_identified/fix_in_progress
- Dropdowns bekommen "⚡ Alle aktiv (default)" als erste Option, "" weiterhin verfügbar für "Alle Status"

**B. Bulk-Actions** — Backend + UI:
- Generische HTTP-Endpoints: `POST /api/itsm/{incidents,changes,problems,services}/bulk` mit `{ids, action, params}`
- `ItsmCallbacks` erweitert um `bulkIncidents/bulkChanges/bulkProblems/bulkServices`, jeweils mit Action-Switch im Repository-Layer
- Frontend Client: `itsmBulkIncidents/Changes/Problems/Services(ids, action, params?)`

**Incidents** (Bulk-Toolbar bei Selection):
- ✓ **Acknowledge** (status → acknowledged)
- ⚠ **Severity-Change** (Modal mit Severity-Dropdown)
- ✕ **Close** (Modal mit Resolution-Pflichtfeld)
- Plus bestehende v632-Aktionen (Neues Problem / Bestehendes Problem)

**Changes** (Multi-Select neu, Bulk-Toolbar):
- ✓ Bulk-Approve
- ✕ Bulk-Reject

**Problems** (Multi-Select neu, Bulk-Toolbar):
- Status-Change (Modal mit Status-Dropdown analyzing/root_cause_identified/fix_in_progress/resolved/closed)
- ⚠ Mark Known-Error (Prompt für Beschreibung)

**Services** (Multi-Select neu, Bulk-Toolbar):
- 🩺 Bulk-Health-Check

**C. Stats-Bar pro Tab** mit Filter-Click:
- Neue `StatChip`-Komponente: ein Chip pro Status mit Counter, Klick filtert direkt, aktive Auswahl getönt
- **Incidents**: Aktiv · Open · Ack · Inv · Resolved · Closed (rechts: 🔴 Crit · 🟠 High)
- **Changes**: Aktiv · Pending · Approved · In Progress · Completed · (Failed wenn >0)
- **Services**: ✅ Healthy · 🟡 Degraded · 🔴 Down · ❓ Unknown
- **Problems**: Aktiv · Open · Analyzing · Root Cause · Resolved · Closed
- Closed-Counter ist grau dargestellt um visuell zurückzunehmen

**D. Schmal-Padding/Severity-Border**: Border-Tönung der Selection-Rows zeigt Multi-Select-Status sofort sichtbar (Blue-Tint statt nur Checkbox).

### Notes
- Build grün (12/12), ITSM-Route 12.2 → 15.1 kB
- Backend-Logic generisch im `bulkIncidents/Changes/Problems/Services`-Callback in alfred.ts — neue Aktionen einfach via Switch ergänzbar
- Bestehende Detail-Actions (Single-Item-Buttons im rechten Panel) bleiben unverändert
- User-Sicherheit: `close`/`reject`/`mark_known_error` brauchen jeweils Confirm-Dialog oder Modal-Input

## [0.19.0-multi-ha.644] - 2026-05-21

### Added — Chat + History vervollständigt (drei Bereiche)

User-Befund: nicht alles aus dem A/B/C-Plan war umgesetzt. Drei Bereiche nachgezogen.

**Schema** — SQLite v74 / Postgres v77:
- `conversations.pinned_at`, `custom_label`, `deleted_at`, `branched_from_conversation_id`, `branched_at_message_id`
- Index für `(user_id, pinned_at DESC, updated_at DESC)` zum effizienten Listing

**Bereich 1 — Chat: Multi-Modal + Voice**
- **File-Upload** in `InputBar.tsx`:
  - 📎-Button + verstecktes `<input type="file" multiple>`
  - **Drag&Drop** über die ganze InputBar (visuelles Ring-Highlight)
  - **Paste-Handler** für Bilder direkt aus Zwischenablage
  - Pending-Attachments-Preview mit Thumbnail (Bilder) / 📄-Icon (Files), Name, Size, Remove-Button
  - Max 8 Files, je max 10MB
- **Voice-Input** mit MediaRecorder API:
  - 🎤-Button startet Aufnahme (rot pulsiert während Recording)
  - Stop sendet WebM-Blob an neuen `POST /api/transcribe`-Endpoint
  - Server nutzt bestehende `SpeechTranscriber.transcribe(buffer, mime)` (Mistral Voxtral / Groq Whisper)
  - Transkribierter Text landet in der Textarea zum Editieren vor dem Senden
- `useChat.sendMessage(text, attachments?)` — Bilder werden als Markdown `![]()` inlined, andere Files als `[📄 name](dataUrl)` Link

**Bereich 2 — History: Lifecycle**
- **Sort**: Pinned-zuerst (default) / Letzte-Aktivität / Neueste / Längste
- **Date-Range-Filter**: Heute / 7d / 30d / 90d / Jahr / Alle Zeit
- **Pagination**: PAGE_SIZE=100, "↓ Mehr laden"-Button unten in Sidebar
- **Pin/Unpin** pro Conversation (📌/📍-Button hover) → `pinned_at`
- **Rename** (Inline-Edit, Enter speichert, Escape verwirft) → `custom_label`
- **Delete** (Soft-Delete mit Confirm) → setzt `deleted_at`, default ausgefiltert
- **"💬 Im Chat fortsetzen"** Button im Sidebar-Item-Hover und im Detail-Header — speichert `alfred-chat-active-conversation-id` in localStorage und navigiert zu /chat
- **Bulk-Mode**: ☑-Toggle, Multi-Checkbox-Auswahl, "📥 Export"-Button generiert pro Conversation eine `.md`-Datei (Browser-Multi-Download)
- Branched-Conversations bekommen ⎇-Badge

**Bereich 3 — Tieferes**
- **Branch** (`POST /api/conversations/:id/branch` body `{at_message_id}`):
  - `ConversationRepository.branchAtMessage` kopiert alle Messages bis zum Cutoff in neue Conversation mit neuem `chat_id=web-fork-<uuid>`
  - Neue Conversation hat `branched_from_conversation_id` + `branched_at_message_id`
  - UI: Hover-Action `⎇ Branch` pro Message → Confirm → neue Conv erstellt und sofort geöffnet
- **Skill-Replay** (`POST /api/conversations/:id/replay` body `{message_id}`):
  - Parsed `tool_calls` JSON aus der Message
  - Pro Tool-Call: holt Skill aus Registry, führt mit denselben Params erneut aus (mit Owner-User-Context)
  - UI: Hover-Action `▶ Replay` (nur sichtbar wenn Message tool_calls hat) → Confirm-Dialog (mutating-Warning) → Result als Alert
- **Bulk-Export**: über Bulk-Mode → `POST /api/conversations/export` body `{conversation_ids[]}` → Server liefert Array `{filename, content}` → Browser triggert sequentielle Downloads (kein zip-Dep im Frontend nötig)

**HTTP-API** — neue Endpoints:
- `PATCH /api/conversations/:id` — `{customLabel?, pinned?}`
- `DELETE /api/conversations/:id?hard=1` — soft (default) oder hard delete
- `POST /api/conversations/:id/branch` — body `{at_message_id}`
- `POST /api/conversations/export` — body `{conversation_ids[]}`
- `POST /api/conversations/:id/replay` — body `{message_id}`
- `POST /api/transcribe` — Audio-Blob im Body (max 25MB)
- `GET /api/conversations` erweitert um Query-Params: `offset`, `sort`, `since`, `until`, `include_deleted`

**Frontend-Files erweitert/neu**:
- `apps/web/src/components/chat/InputBar.tsx` — File/Voice/Drag&Drop/Paste
- `apps/web/src/hooks/useChat.ts` — sendMessage akzeptiert attachments
- `apps/web/src/components/history/ConversationsSidebar.tsx` — komplettes Rewrite mit Hover-Actions, Bulk-Mode, Pagination, Sort/Date
- `apps/web/src/components/history/HistoryPage.tsx` — Lifecycle-Handler + Branch/Replay-Aufrufe + Bulk-Export-Logik
- `apps/web/src/components/history/ConversationDetail.tsx` — Per-Message-Hover-Actions + "Im Chat fortsetzen"-Button

### Notes
- Build grün (12/12), Migrationen laufen automatisch beim ersten Start
- Voice-Input nutzt MediaRecorder API → braucht HTTPS-Origin oder localhost
- Replay ist mit Confirmation-Dialog gegated — bei mutierenden Skills (z.B. itsm.close_incident) entscheidet User explizit
- Branch dupliziert Messages (kein Foreign-Key); die forked Conversation lebt unabhängig

## [0.19.0-multi-ha.643] - 2026-05-21

### Added — Project-Repo-URL + Commit-Tracking + PR-Detection (v643, vollumfänglich A+B+C+D)

Vorher: pro Project-Agent-Session wurde nur der **letzte** Commit-SHA gespeichert (bei 24-Phasen-Läufen waren 23 Commits "weg"), die Repo-URL war unsichtbar, MR/PR-Links aus git push wurden weggeworfen.

**Schema** — SQLite Migration v73 / Postgres v76:
- Neue Tabelle `project_agent_commits(id, session_id, project_id, sha, message, phase_idx, phase_description, files_changed, branch, committed_at, pushed_at, push_url)`
- 2 Indizes: (session_id, committed_at) + (project_id, committed_at DESC)
- `project_agent_sessions.last_push_url` TEXT — der MR/PR-Link der letzten Push-Operation
- `projects.default_branch` TEXT — auto-detected via `git rev-parse --abbrev-ref HEAD`

**A. Per-Phase Commit-Tracking** (`packages/storage/src/repositories/project-agent-commits-repository.ts`):
- `record()` schreibt pro Commit einen Eintrag
- `markSessionPushed(sessionId, pushUrl?)` markiert alle Session-Commits als pushed
- `listBySession(sid)` / `listByProject(pid, limit)` für UI-Abfragen
- `ProjectAgentRunner.setCommitsRepository(repo, resolver)` neuer Injection-Point — wenn gesetzt wird nach jedem `git commit` der Eintrag mit Phase-Index, Branch und Files-Count persistiert

**B. Repo-URL + Branch Auto-Detection** (`packages/core/src/alfred.ts`):
- Nach jedem Project-Agent-Lauf: wenn das Project noch keine `repo_url` oder `default_branch` hat, wird beides per `git -C <cwd>` aus dem Workspace ausgelesen und ins Project geschrieben
- Strip von embed-Credentials aus der URL (`https://oauth2:token@…` → `https://…`)

**C. PR/MR-Auto-Detection** (`packages/core/src/project-agent-runner.ts`):
- Neue `gitExecBoth()` Helper (gibt stdout UND stderr zurück)
- `extractPushUrl(stderr)` Regex-Heuristik die GitLab/GitHub/Gitea-MR-Create-URLs aus den `remote:`-Lines parsed ("To create a merge request for X, visit:", "Create a pull request for X by visiting:")
- `pushToRemote()` returnt jetzt die extrahierte URL (oder undefined)
- Nach Push: `session.last_push_url` updated + alle Session-Commits per `markSessionPushed(url)` als pushed markiert
- Progress-Message zeigt MR/PR-Link direkt: "📤 Gepusht: … \n🔀 MR/PR: <url>"

**D. WebUI Project-Detail erweitert** (`apps/web/src/components/projects/ProjectsPage.tsx`):
- **Header** zeigt Repo-URL als klickbarer Link mit Provider-Icon (🐙 GitHub / 🦊 GitLab / 🍵 Gitea / 🪣 Bitbucket / 🔗 sonst) + Short-URL + ⎇ Branch-Badge
- **Sessions-Liste** umgebaut zu einer eigenen `SessionRow`-Komponente die expandable ist
- Klick auf Session → lädt Commits per `/api/projects/:id/sessions/:sourceId/commits` → zeigt pro Commit: Phase-Index, SHA (klickbar auf `commitUrlFor(repoUrl, sha)`), Message, Files-Count, ↑-Icon wenn pushed
- Wenn die Session eine `lastPushUrl` hat: am Ende ein 🔀 "MR/PR öffnen ↗" Button

**HTTP-API**:
- `GET /api/projects/:id/commits?limit=` — alle Commits des Projects DESC
- `GET /api/projects/:id/sessions/:sid/commits` — alle Commits einer Session ASC

### Effekt
- Bei jedem Project-Agent-Lauf wachsen jetzt: `project_agent_commits` (eine Zeile pro Phase), `project_agent_sessions.last_push_url` (eine URL pro Lauf), `projects.repo_url`+`default_branch` (einmalig beim Erstkontakt)
- Im WebUI: Project-Detail zeigt sofort den Repo-Link, klick darauf öffnet GitLab/GitHub-Repo-Page; jede Session ist expandable und zeigt alle ihre Commits mit klickbaren SHAs
- Nach erfolgreichem Push: MR/PR-Link prominent in der Session-Detail-View

### Notes
- Build grün (12/12)
- Backwards-compatible: alte Sessions ohne Commits zeigen einfach eine leere Liste im Expander
- `extractPushUrl` ist defensiv — bei unbekanntem Forge-Output bleibt's einfach undefined und der Rest funktioniert weiter

## [0.19.0-multi-ha.642] - 2026-05-21

### Improved — Open-Items-Audit deutlich vertieft (war zu oberflächlich)

User-Report v641: bei 83+ offenen Items lieferte das Audit nur 2 Duplikat-Gruppen — nichtssagend. Realdaten-Check zeigte: 114 Items, fast alle ≤2d alt → Stale-30d-Heuristik greift gar nicht, Title-Jaccard ≥0.7 ist auch zu strikt.

**Backend** (`packages/skills/src/built-in/project.ts`):
- **Stats-Block**: total, byPriority (high/normal/low), byAge (4 Buckets <1d / 1-7d / 7-30d / ≥30d), withDescription, autoMarked
- **LLM-Pass** (default an, `with_llm=false` zum Skippen):
  - Sammelt git log (`git log --oneline -n 40`) + `git ls-files` aus Project-cwd
  - Schickt alle Items + Projekt-Info + Repo-Snapshot an default-LLM
  - Erwartet JSON-Array mit `{item_id, verdict, confidence, reason}`, Verdict in `likely-done | outdated | redundant | still-open`
  - Konservativ ("im Zweifel weglassen"), nur Items mit klarer Einordnung
- **Strukturierte Response** in `data` (statt nur Markdown): UI kann pro Sektion eigene Bulk-Aktionen anbieten
- `setLlmCallback()` Injection — wird in alfred.ts mit `llmProvider.complete` verbunden

**Frontend** — neues `AuditModal.tsx` (Component):
- **Stats-Header** mit 4 Karten (Total, Priorität-Aufteilung, Alter-Buckets, Qualität)
- **Sticky Bulk-Toolbar** erscheint bei ≥1 Auswahl: "✓ Als erledigt markieren" + "▶ Mit Project-Agent abarbeiten"
- **Section-Komponente** pro Verdict-Klasse mit eigenem "+ Alle auswählen"-Button:
  - 🤖 LLM: wahrscheinlich erledigt (mit Confidence + Begründung)
  - 🗑️ LLM: veraltet
  - 🔁 LLM: redundant
  - 🤖 Matcher: vermutlich erledigt (aus v641 OpenItemMatcher)
  - 🕸️ ≥30d offen
  - 👯 Title-Duplikate
- **Per-Item Checkbox** zur granularen Auswahl
- Empty-State: "✓ Keine Auffälligkeiten gefunden mit N aktiven Items"

**HTTP-API**:
- Neu: `POST /api/projects/:id/bulk-close-items` Body `{item_ids[]}` returns `{closed, failed}`
- `ProjectsCallbacks.bulkCloseItems` (optional) routet auf `projRepo.updateOpenItemStatus`

**Wiring** (`packages/core/src/alfred.ts`):
- `projectSkill.setLlmCallback(...)` direkt nach Skill-Creation
- `bulkCloseItems` als neue Projects-Callback registriert

### Effekt
- Statt "nur 2 Duplikat-Gruppen" liefert das Audit jetzt eine echte Übersicht: Stats-Breakdown + LLM-Bewertung gegen Repo-State
- LLM matched Items wie "Docker-Setup erstellen" gegen tatsächlich vorhandenes `docker-compose.yml`+`Dockerfile` → markiert als likely-done
- Bulk-Actions direkt im Modal — kein Modal-Schließen mehr zwischen Audit und Aufräum-Aktion

### Notes
- Build grün (12/12)
- LLM-Pass kostet pro Audit-Run ~1-3k Tokens (default tier) bei deinen ~100 Items
- Bei Project ohne cwd oder ohne git: LLM-Pass wird übersprungen, Audit zeigt nur Heuristiken
- `auditOpenItems({with_llm: false})` skippt den LLM-Call falls jemand das via Skill direkt steuern will

## [0.19.0-multi-ha.641] - 2026-05-21

### Added — Open-Items: Auto-Resolve nach Project-Agent + Bulk-Work + Audit

User-Befund: Project-Agent läuft, danach bleiben 84 offene Punkte einfach offen — Alfred prüft nicht ob Punkte erledigt wurden. Es gibt auch keinen Workflow "arbeite Punkte X-Z mit Project-Agent ab" und keinen Cleanup für stale/duplicate Items.

**Schema** (SQLite v72 / Postgres v75):
- `project_open_items.auto_resolved_by` (TEXT) — Attribution wenn Alfred ein Item automatisch als erledigt erkannt hat
- `project_open_items.auto_resolved_confidence` (REAL) — 0-1 Confidence des LLM-Matchers

**OpenItemMatcher** (`packages/core/src/projects/open-item-matcher.ts`):
- Fire-and-forget Pass nach jedem **erfolgreichen** Project-Agent-Run (Skip wenn 0 Files geändert)
- Holt alle 'open'/'in_progress' Items des Projekts, schickt sie mit Goal+Milestones+ChangedFiles an default-LLM
- LLM antwortet als JSON-Array: pro Item `{item_id, resolved: bool, confidence: 0-1, reason}`
- Confidence ≥ 0.6 + resolved=true → **status='done'** + `auto_resolved_by=project_agent_session:<id>` + `auto_resolved_confidence=…`
- Confidence < 0.6 aber Indizien → bleibt 'open' aber `auto_resolved_*` markiert für UI-Hinweis
- System-Prompt ist konservativ formuliert ("im Zweifel resolved=false")

**Skill-Aktionen** (`packages/skills/src/built-in/project.ts`):
- `work_on_open_items project_id item_ids? max_items=10`
  - Sammelt N offene Items (high-prio first, dann oldest-first), capped auf max_items
  - Konstruiert einen Goal-Text aus allen Item-Titeln + Descriptions ("Arbeite die folgenden offenen Punkte ab. Pro Punkt: prüfe ob er noch zutrifft, implementiere…")
  - Startet Project-Agent mit Project-cwd via dem neuen `setProjectAgentStarter`-Callback
  - Nach dem Lauf macht der OpenItemMatcher automatisch sein Ding — Kreis schließt sich
- `audit_open_items project_id?`
  - Findet **stale** (≥30d offen ohne Updates)
  - Findet **Duplikate** (Title-Token-Jaccard ≥ 0.7)
  - Findet **possibly-done** (auto_resolved_by gesetzt aber status noch open — Matcher hatte Unsicherheit)
  - Liefert strukturierten Markdown-Report ohne destruktive Aktionen — User entscheidet

**HTTP-API** (`packages/messaging/src/adapters/http.ts`):
- `POST /api/projects/:id/work-on-items` — Body `{ item_ids[], max_items }`, returns `{ ok, taskId }`
- `POST /api/projects/:id/audit-items` — returns `{ data, display }`
- `ProjectsCallbacks` um `workOnOpenItems` + `auditOpenItems` erweitert
- Beide route über die Skill-API (single source of truth, kein Code-Duplikat)

**Frontend** (`apps/web/src/components/projects/ProjectsPage.tsx`):
- **Multi-Select-Checkbox** pro Open-Item-Zeile (Auswahl wird blau hinterlegt)
- **Bulk-Toolbar** erscheint bei ≥1 Selection: Counter + "Auswahl löschen" + "▶ Mit Project-Agent abarbeiten"
- **🤖-Marker** mit Tooltip an Items die `auto_resolved_by` gesetzt haben aber noch open sind (zeigt Confidence in %)
- **🔍 Audit-Button** im OpenItems-Header öffnet Modal mit dem Report
- Confirmation-Dialog vor Bulk-Start

**Wiring** (`packages/core/src/alfred.ts`):
- `OpenItemMatcher` Import + Call im `projectRunner.setCompletionCallback`-Block, gated auf `success=true` und `llmProvider+projectRepo+totalFilesChanged>0`
- `projectSkill.setProjectAgentStarter(...)` neuer Callback der `projectAgentSkill.execute({action:'start',goal,cwd})` aufruft → Bulk-Workflow geht durch die normale Pipeline

### Workflow
1. **Auto-Close nach Lauf**: User startet Project-Agent → 24 Phasen, 77 Files → bei Success vergleicht der Matcher die 12 offenen Items mit dem Erreichten → 5 mit Confidence ≥0.6 werden auto-done mit 🤖-Marker; 2 weitere bekommen den Marker bei Confidence 0.45-0.59 für späteren manuellen Review.
2. **Bulk-Work über UI**: User wählt 5 Items per Checkbox → klickt "▶ Mit Project-Agent abarbeiten" → Confirmation → Project-Agent startet mit konstruiertem Multi-Item-Goal.
3. **Audit**: User klickt "🔍 Audit" → sieht 8 stale Items (>30d), 3 Duplikat-Gruppen, 2 möglicherweise-erledigte → kann gezielt aufräumen.

### Notes
- Build grün (12/12)
- Matcher läuft NUR bei `success && totalFilesChanged > 0` — keine LLM-Kosten für fehlgeschlagene Läufe
- Audit ist read-only — Cleanup-Aktionen bleiben dem User vorbehalten
- v638 InfraForecast-Adapter funktioniert parallel weiter — Insights und Open-Item-Matching sind getrennte Systeme mit unterschiedlichem Scope

## [0.19.0-multi-ha.640] - 2026-05-21

### Added — KG Question-Generator + Self-Audit (v640 — Teil 3 von 3 für Personal-Optimization, Abschluss)

Alfred fragt proaktiv nach KG-Lücken die er nicht selbst füllen kann. Anti-Nagging mit Ignore-Learning.

**Schema** — SQLite Migration v71 / Postgres v74:
- `kg_questions` Tabelle mit UNIQUE(user_id, target_kind, target_id, attribute) — pro KG-Entity + Attribut nur eine offene Frage
- Felder: `question_text`, `asked_at`, `asked_via_platform/chat_id`, `status` (asked/answered/ignored/cancelled), `answered_at` + `answer_text` + `parsed_value`, `ignore_count`

**Repository** (`packages/storage/src/repositories/kg-questions-repository.ts`):
- `upsertAsk()` — UNIQUE-Constraint per (user, target, attribute). Existiert eine Frage <7d alt → skip. >7d → `ignore_count++` und neue `asked_at`. Bei 3 Ignores → status='ignored', wird nie wieder gefragt.
- `markAnswered()` — speichert Antwort + optional parsed_value
- `cancel()` — manueller User-Block
- `ignoreRateForAttribute()` — wie oft wurde die Attribut-Klasse (z.B. 'birthday') schon ignoriert? Treibt das Back-Off.

**Generator** (`packages/core/src/insights/question-generator.ts`):
- Scannt KG für Lücken: Personen ohne Birthday/Relation bei ≥3 Mentions, Orgs ohne URL+Branche bei ≥5 Mentions, Locations ohne Adresse bei ≥3 Mentions
- Score = `mentions × Attribut-Gewicht × backoff(attribute)`
- `backoff` = `1 - min(0.7, ignore_rate_per_attribute)` → wenn Birthday-Fragen oft ignoriert wurden, sinkt der Score für NEUE Birthday-Fragen automatisch
- Sortiert nach Score, nimmt Top-N, queued max 3 Confirmations pro Run
- Pro Frage wird eine Confirmation gestellt mit gebundener `memory.add` Action (User-Antwort landet in der nächsten Nachricht und wird via Confirmation-Approval persistiert)

**Scheduling**: täglich 18:00 lokal, max 3 Fragen/Tag. Platform: telegram > matrix > discord (erste aktive).

### Workflow
1. Alfred sieht im KG: "Bernhard" hat 8 Mentions, kein Birthday-Attribut, keine Frage in den letzten 7d.
2. Generator scored: 8 × 2 × 1.0 = 16 (höchster Kandidat).
3. Sendet Confirmation an Owner-Chat: "🤔 Wann hat Bernhard Geburtstag?"
4. Approve → User schreibt Datum als nächste Nachricht → memory.add speichert es.
5. Reject oder ignoriere 3× → wird nicht mehr gefragt.
6. Wenn 5 von 10 Birthday-Fragen ignoriert wurden → ignore_rate=0.5 → backoff=0.5 → neue Birthday-Fragen scoren halb so hoch → andere Attribut-Klassen kommen zum Zug.

### Notes
- Build grün (12/12)
- Personal-Optimization-Trio v638/v639/v640 komplett: Insight-Engine + Goal-Tracker + KG-Question-Generator
- Frequenz und max-pro-Tag könnten später konfigurierbar gemacht werden (heute hardcoded auf 18:00 / 3 Fragen)
- KG-Self-Audit-Funktion sitzt in v638 KgGapAdapter (statisch im Insights-Tab sichtbar). v640 ergänzt **aktiv nachfragen** statt nur in der Web-UI auflisten.

## [0.19.0-multi-ha.639] - 2026-05-21

### Added — Goal-Tracker (v639 — Teil 2 von 3 für Personal-Optimization)

Persistente Ziel-Verfolgung mit Drift-Detection im Insight-Engine.

**Schema** — SQLite Migration v70 / Postgres v73:
- `alfred_goals` — id, title, description, category (fitness/finance/relationships/work/health/learning/home/other), cadence (daily/weekly/monthly/one-time), target_metric, status (active/paused/achieved/abandoned), check_frequency_days, last_checked_at + last_status, source (user/extracted-chat), source_conversation_id + source_message_id
- `alfred_goal_checkpoints` — pro Check ein Eintrag mit status (on-track/drifting/achieved/no-data/paused), evidence (JSON), notes

**Repository** (`packages/storage/src/repositories/goals-repository.ts`):
- `create/getById/list/update`
- `findGoalsDueForCheck()` — alle aktiven Goals deren `lastCheckedAt + checkFrequencyDays` in der Vergangenheit liegt
- `recordCheckpoint()` — schreibt Checkpoint UND aktualisiert `last_checked_at`/`last_status` auf dem Goal
- `listCheckpoints()` — History pro Goal

**Skill `goal`** (`packages/skills/src/built-in/goals.ts`):
- `add/list/get/check/pause/resume/complete/abandon/history`
- ID-Prefix-Resolution (8-char Prefix → volle UUID)

**GoalDriftAdapter** (`packages/core/src/insights/adapters/goal-drift-adapter.ts`):
- Registriert sich beim InsightEngine
- Erzeugt Insight pro überfälligem Goal mit Confidence skalierend nach Überfälligkeit (0.85 wenn letzter Status "drifting", sonst 0.55 + 0.02/Tag Überfälligkeit)
- Bindet `goal.check` als Action — Klick im WebUI Insight-Card oder Skill-Call markiert Goal als geprüft

**LLM-Goal-Extractor** (`packages/core/src/insights/goal-extractor.ts`):
- Wöchentlich (Sonntag 21:00 lokal) scannt es die letzten 7 Tage Chat-Messages
- Pro Conversation: gruppiert User-Messages, schickt sie mit Goal-Extraction-Prompt an default-LLM-Tier (1500 Tokens)
- Erwartetes Output: JSON-Array mit `title/description/category/cadence/target_metric/confidence/source_excerpt`
- Dedup gegen existierende Goals via Title-Normalization
- Erkannte Ziele werden NICHT direkt persistiert — **Confirmation queued** mit Skill-Action `goal.add`, User bestätigt explizit über Side-Panel oder Telegram-Inline-Button

**HTTP-API**:
- `GET /api/goals` (filter: status, category)
- `POST /api/goals` (title required + optional fields)
- `GET /api/goals/:id` (returns goal + checkpoint-history)
- `PATCH /api/goals/:id` (status/title/description/cadence updates)
- `POST /api/goals/:id/check` (body: { status, notes? })

**WebUI** (`apps/web/src/components/goals/GoalsPage.tsx`):
- Neue Route `/alfred/goals` mit Karten-Layout (Title, Category, Cadence, Target-Metric, Last-Check + Status-Badge)
- Card-Click expandiert: Description, Status-Aktionen (Pausieren/Reaktivieren/Erreicht/Aufgeben), Checkpoint-History
- "+ Check"-Button pro aktivem Goal öffnet Quick-Check-Modal (Status + optional Notiz)
- "+ Neues Ziel"-Modal mit Category/Cadence-Dropdown + Check-Frequency
- Sidebar-Eintrag `🎯 Goals` nach Insights

### Workflow
1. **Manuell**: User → "+ Neues Ziel" oder im Chat `goal add title="…" cadence=weekly`
2. **Auto-Extract**: User schreibt im Chat "ich möchte ab Juni 2x/Woche Sport" → Sonntag-Sweep extrahiert → Confirmation kommt → User approves → Goal persistiert
3. **Drift-Detection**: Goal wird N Tage nicht gecheckt → Insight erscheint im Insights-Tab mit "🎯 Ziel-Check fällig" + Action-Button
4. **Check**: User klickt "Act" oder "+ Check" → Checkpoint geloggt → Goal-Drift-Insight wird re-evaluated

### Notes
- Build grün (12/12)
- LLM-Extraction läuft mit default-Tier — bei kleinem Mistral-Setup ggf. Modell anpassen
- Confirmation-Quelle ist 'reasoning' → läuft durch die normale Telegram/Matrix-Approval-Pipeline
- v640 (Question-Generator + KG-Self-Audit) folgt als letzter Teil

## [0.19.0-multi-ha.638] - 2026-05-21

### Added — Insight-Engine Foundation (v638 — Teil 1 von 3 für Personal-Optimization)

Cross-Domain-Reflector der aus mehreren Datenquellen Anstöße/Optimierungs-Vorschläge generiert. Erster Teil eines dreiteiligen Ausbaus (v639 Goal-Tracker, v640 Question-Generator folgen).

**Schema** — SQLite Migration v69 / Postgres v72:
- `alfred_insights` Tabelle mit `category`, `title`, `body`, `confidence`, `source_data` (JSON), `action_skill` + `action_params`, `status` (pending/acted/dismissed/snoozed/expired), `snoozed_until`, `dedupe_key` (unique pro user)
- 3 Indizes: user+status+created, user+dedupe (unique partial), user+category+status

**Repository** (`packages/storage/src/repositories/insights-repository.ts`):
- `upsertCandidate(userId, candidate)` — Dedupe-aware Insert; refreshed pending/snoozed Einträge, überspringt acted/dismissed/expired (User hat schon entschieden)
- `list/getById/dismiss/snooze/markActed`
- `expireSnoozes` (Snoozes deren `snoozed_until` past) + `expireStale` (pending > 21d)
- `stats` (Counts pro Status)

**Engine** (`packages/core/src/insights/insight-engine.ts`):
- `InsightEngine` mit Domain-Adapter-Pattern: jeder Adapter implementiert `generate(ctx)` und liefert Candidates
- `sweep()` läuft alle Adapter parallel mit Isolation (Promise.allSettled), upsertet alle Candidates, returnt Aggregate
- Plug-and-play: weitere Adapter registrieren über `engine.register()`

**Fünf Initial-Adapter** (`packages/core/src/insights/adapters/`):
1. **InfraForecastAdapter** — verkettet Capacity-Forecast (v633) × Pattern-Detection (v633) × Service-Health (v634). Confidence steigt mit Anzahl Co-Signale (0.55/0.75/0.95 bei 1/2/3 Signalen). Bindet `itsm.create_change_request` als Action.
2. **OpenLoopAdapter** — findet Conversations >7d still mit Frage des Users zuletzt (Heuristik: endet auf "?" oder typische Frage-Keywords). Confidence skaliert mit Tagen-Stille.
3. **CrossSourceMentionAdapter** — Regex-Heuristik für Termin-Erwähnungen (Klempner kommt, Treffe…am, Termin am…, Arzt, Flug) in Chat-Messages der letzten 14d, ohne passenden Calendar-Eintrag in 30d. Bindet `calendar.create_event` als Action.
4. **KgGapAdapter** — KG-Self-Audit: Personen ohne Birthday/Relation bei ≥5 Mentions, Orgs ohne URL+Branche bei ≥5 Mentions, Locations ohne Adresse bei ≥3 Mentions. Bindet `memory.add` Aktion vor mit Vorschlags-Template.
5. **CalendarMismatchAdapter** — Termin in nächsten 24h mit Location × BMW-Range <50km → "vorher laden". Bindet `goecharger.set_charging_window` als Action.

**Skill** (`packages/skills/src/built-in/insights.ts`): `insights list/dismiss/snooze/act/sweep/stats`, akzeptiert truncated ID-Prefixes.

**HTTP-API** (`packages/messaging/src/adapters/http.ts`):
- `GET /api/insights` — list (filter: category, status, limit)
- `GET /api/insights/stats` — Counts
- `POST /api/insights/sweep` — manueller Trigger
- `POST /api/insights/:id/dismiss`
- `POST /api/insights/:id/snooze` — Body `{ hours }`
- `POST /api/insights/:id/act` — führt gebundene Skill-Action aus, markiert acted bei Erfolg

**Wiring** (`packages/core/src/alfred.ts`):
- Insight-Engine wird im CMDB/ITSM-Block instanziiert (gleicher Lebensbereich)
- Adapter werden bedingt registriert: KG-Gap nur wenn DB da, Calendar-Mismatch nur wenn Calendar-Skill registriert, BMW-Facade nur wenn BMW-Skill registriert
- **Daily Sweep**: setTimeout bis nächste 09:00 lokal, danach 24h-Intervall, `unref()`-ed
- Adapter-Result wird mit linked-user-ids gescoped (v637-Pattern)

**Frontend** (`apps/web/src/components/insights/InsightsPage.tsx`):
- Neue Route `/alfred/insights`
- Stats-Bar (pending/snoozed/acted/dismissed/expired)
- Filter (Kategorie + Status)
- Insight-Karten mit Farb-Coding nach Confidence (🟢🟡🔴), Expand/Collapse für langen Body
- Pro-Insight-Buttons: Aktion ausführen (falls gebunden), Snooze 24h/7d, Erledigt
- Sweep-Now-Button
- Sidebar-Eintrag `💡 Insights` zwischen Dashboard und Knowledge

### Effekt heute (nach Deploy + erster Sweep)
- `infra-forecast`: bei dir liefen die `PGSql-P01 RAM`/`git-server RAM`-Patterns aus v631 — der Adapter dürfte 1-2 hochconfidente Insights generieren wenn die Capacity-Samples genug Datenpunkte haben
- `open-loop`: scannt all deine Telegram/Matrix-Chats nach unbeantworteten Fragen >7d
- `kg-gap`: liest deine KG-Personen, schlägt Birthday/Relation-Lücken vor
- `cross-source-mention`: Regex-Match auf letzten 14d Chats — kann an deinem Volume false-positive haben, dafür Snooze/Dismiss
- `calendar-mismatch`: nur aktiv wenn Calendar UND BMW konfiguriert

### Notes
- Build grün (12/12)
- Designed für graceful degradation — fehlt eine Quelle (z.B. BMW), wird der Adapter still übersprungen, andere laufen weiter
- Nächste Schritte (v639+v640) sind unabhängig nutzbar: v639 fügt GoalDriftAdapter hinzu, v640 KG-Question-Generator

## [0.19.0-multi-ha.637] - 2026-05-21

### Fixed — History-Viewer + Confirmations-Panel: Matrix/Discord/WhatsApp Chats waren versteckt

**Symptom**: WebUI History-Tab zeigt nur Telegram-Chatverlauf, Matrix-Conversations bleiben unsichtbar. Gleicher Bug im Confirmations-Side-Panel.

**Ursache** (Multi-User-Linking-Asymmetrie):
- `conversations.user_id` speichert die **platform-spezifische** Alfred-User-UUID (z.B. Matrix-User `12d88202-…`)
- `users.master_user_id` linkt diese auf den Owner-Master (z.B. Telegram-User `f165df7a-…`)
- v627/v629 filterten in der DB-Query strikt mit `WHERE user_id = ownerMasterUserId` — Telegram-Conversations matchen (weil dort `user_id == master`), Matrix-Conversations nicht (weil `user_id` die platform-Variante ist).

**Fix v637** — Linked-User-IDs als Filter-Set:

1. `ConversationRepository.listConversations()` akzeptiert jetzt zusätzlich `userIds: string[]` (single `userId` bleibt für rückwärtskompatible Aufrufe)
2. `ConversationRepository.searchMessages()` `userId` ist jetzt `string | string[]` — gleiche Logik für FTS-Search (Postgres + SQLite)
3. `ConfirmationRepository.findAllPendingForUser()` `userId` akzeptiert ebenfalls `string | string[]`
4. `ConfirmationQueue.listPendingForUser()` Signatur entsprechend erweitert
5. `alfred.ts` Wiring — neuer Helper `resolveLinkedUserIds()` ruft `userRepo.getLinkedUsers(ownerMasterUid)` (`SELECT … WHERE master_user_id = ? OR id = ?`) und reicht alle IDs in die Callbacks weiter. Identisches Pattern für History-Callbacks und Confirmations-Side-Panel.

### Effekt
- Im History-Tab erscheinen jetzt deine Matrix-Räume (`!ZPGQNbIwbLWeULnGBZ:…`, `!aRXNPPnPhMEnMgeUkr:…`, `!NBdczIlAsusdPxkfWh:…`) neben Telegram-Chats
- Volltext-Suche (Ctrl+K) durchsucht jetzt **alle** linked Plattformen
- Pending-Confirmations im Side-Panel zeigt auch Matrix-/Discord-Bestätigungen
- Funktioniert für jeden zukünftigen Adapter, der Conversations mit platform-spezifischer User-ID schreibt (Discord, WhatsApp, Signal etc.)

### Notes
- Build grün (12/12)
- Kein DB-Cleanup nötig — der Fix ändert nur die Filter-Logik, nicht die Daten
- `getLinkedUsers()` existiert seit dem Multi-User-Branch und liefert sauber alle verknüpften IDs für einen gegebenen Master

## [0.19.0-multi-ha.636] - 2026-05-21

### Fixed — Project-Agent-State: v630 reichte nicht. lastBuildActuallyPassed ist sticky.

**Symptom**: Session `82a17860-…` lief 24/28 Phasen, schrieb 77 Dateien, Phase 24 wurde wegen Inactivity gekillt (exitCode=124) — die `❌ Project Agent fehlgeschlagen`-Message wurde geschickt, aber in der DB landete `current_phase='done'` mit `last_build_passed=0`. UI zeigt grünes "done" + Sanduhr.

**Bug** (Fehler in meinem v630-Fix, nicht im v620-Original):
- Phase-Loop bei exitCode≠0 (line 335): `state.projectPhase = 'failed'` + `break` ✓
- POST-Loop v630 (line 477): `overallSuccess = anyPhaseProducedFiles && lastBuildActuallyPassed`
- **`lastBuildActuallyPassed` ist sticky** — wird in line 360 auf `true` gesetzt sobald **irgendeine** Phase grün baut, **nie zurückgesetzt**
- Bei Phase 24-Fail nach 23 grünen Phasen: `anyPhaseProducedFiles=true` (77 Files), `lastBuildActuallyPassed=true` (sticky-true) → `overallSuccess=true` → state wieder auf `'done'` zurück

**Fix v636** — expliziter `runFailed` Flag der vor jedem harten break-Pfad gesetzt wird:
```typescript
let runFailed = false; // initial

// Coding-Phase exitCode ≠ 0:
runFailed = true; state.projectPhase = 'failed'; break;

// Fail-Fast (3 consecutive empty phases):
runFailed = true; break;

// Post-Loop:
const overallSuccess = !runFailed && anyPhaseProducedFiles && lastBuildActuallyPassed;
state.projectPhase = overallSuccess ? 'done' : 'failed';
```

`runFailed` ist eindeutig "hartes Failure", unabhängig von der sticky-Natur von `lastBuildActuallyPassed`. v630-Fix bleibt korrekt für den Catch-Block (Exception) und Pre-Flight-Failure — die berühren `lastBuildActuallyPassed` gar nicht.

### DB-Bereinigung
- `UPDATE project_agent_sessions SET current_phase='failed' WHERE task_id='82a17860-…'` — direkt auf .91 ausgeführt
- Andere Bestandssessions waren in v630-DB-Sweep schon korrigiert

### Lehre
- "Konzept richtig + Bedingung falsch" ist gleich gefährlich wie "Bedingung richtig + Stelle falsch". v630 dachte ich hätte alle drei Sites geändert; die Bedingung an einer dieser Sites war aber nicht ausreichend für alle Failure-Pfade.
- Mein Fehler — Entschuldigung für die wiederholte Schlamperei in dieser Region.

### Notes
- Build grün (12/12, nur core touched)
- Patch ist klein und isoliert — kein Risiko für andere Code-Pfade

## [0.19.0-multi-ha.635] - 2026-05-21

### Fixed — Agent-Executor Inactivity-Detection: File-mtime-Heartbeat ergänzt

**Symptom** (User-Report 02:28 nach v634): Project-Agent lief 24 Phasen erfolgreich (77 Dateien geändert) und wurde dann in Phase 24/28 ("Datenmodell prüfen und ergänzen: Migrationen für Galerie/Trailer") nach 600s stdout/stderr-Stille gekillt — obwohl der Build danach grün gelaufen wäre (293/293 Tests passed in der Final-Output). Phase wurde mit Normal-Default 10min (v625) statt Long-Phase 20min behandelt, weil das Regex auf "Datenmodell/Migration"-Keywords nicht matched.

**Ursache** (`agent-executor.ts`): Inactivity-Detection ist heute rein stdout/stderr-driven. claude-code kann in einzelnen langen Tool-Calls (Multi-Datei-Read, deep thinking) >10min stdout-stumm sein — entweder weil das Tool das wirklich braucht oder weil Node's child-process-Pipes den Output puffern wenn der Subprocess nicht aktiv flushed. Auch wenn der Agent in der Zwischenzeit **77 Dateien schreibt** wird das nicht als Aktivität erkannt.

**Fix** (drei Komponenten, in absteigender Wichtigkeit):

1. **File-mtime-Heartbeat** (`packages/skills/src/built-in/code-agent/agent-executor.ts`)
   - Neuer `setInterval(30s)` vergleicht aktuellen mtime-Snapshot vom cwd gegen letzten Snapshot
   - Findet sich ≥1 geänderte Datei → `resetInactivity('fs-heartbeat')` wird gefeuert
   - Verhindert das exakte Symptom: Agent schreibt Dateien, stdout-Buffer staut sich, mit Heartbeat bleibt der Timer am Leben
   - `unref()`-ed, wird in `close`/`error` Handler aufgeräumt
   - `resetSource` wird in der Kill-Annotation mit ausgegeben (`last-activity=fs-heartbeat|stdout|stderr`) für Diagnose

2. **Long-Phase-Pattern erweitert** (`packages/core/src/project-agent-runner.ts`)
   - Zusätzlich erkannt: `Datenmodell`, `data model`, `datamodel`, `Migration(en|s)`, `Schema`, `Refactor(ing)`, `Umbau`, `Typsystem`, `type system`
   - Diese Phasen schreiben typisch viele Dateien (Migration + Type + Repo + Service-Layer + Tests) und passten vorher nicht ins Regex → bekamen Normal-Default
   - Jetzt: Long-Phase-Default (20min Inactivity)

3. **Default sanft angehoben** `DEFAULT_TIMEOUT_MS` von 600.000ms (10min) → 720.000ms (12min)
   - Kleiner Bump als Belt-and-Suspenders. Wichtiger ist (1) — der Heartbeat sollte 99% der Fälle erfassen
   - Ceiling `MAX_TIMEOUT_MS` bleibt 30min, Long-Phase bleibt 20min explizit

### Effekt
- Phase 24 des Beispiels: schreibt vermutlich `prisma/schema.prisma` + Migration-File(s) + Typedefs binnen 30s → Heartbeat-Reset → Timer läuft weiter
- Phasen mit `Migration`/`Datenmodell`/`Schema`/`Refactor` im Phase-Text: ab v635 mit 20min Default
- Diagnose-Ausgabe: bei `exitCode=124` sehen wir jetzt `last-activity=fs-heartbeat` vs `last-activity=stdout` — wenn fs-heartbeat zuletzt zog und der Agent trotzdem killed wurde, war die Phase wirklich >12min ohne **jegliche** File-Aktivität

### Notes
- Build grün (12/12, nur skills + core touched)
- Wenn v635 noch nicht reicht: nächster Schritt wäre Process-CPU-Heartbeat (`ps`-basiert auf Linux) als drittes Aktivitäts-Signal
- Performance: mtime-Scan über cwd alle 30s — Skip-Dirs (.git, node_modules, .next, dist, .cache) hält den Scan klein, Last vernachlässigbar auch bei ~1k Files

## [0.19.0-multi-ha.634] - 2026-05-21

### Added — ITSM Operational Excellence (T4 vom T1-T4-Quartett, Abschluss)

Vier strukturelle Ergänzungen die ITSM von "Tickets verwalten" zu "Operations-Insight" anheben.

**Migrationen** — SQLite v68, Postgres v71:
- Neue Tabelle `cmdb_service_cascades(id, user_id, source_service_id, target_service_id, observed_count, first_observed_at, last_observed_at, avg_delay_minutes)` + Index auf `(user_id, source_service_id)`

**T4.1 — Service-Health-Score** (`itsm-repository.ts:serviceHealthScore`, Skill `service_health_score`)
- 0-100-Score je Service, niedriger = mehr Operations-Druck
- Aggregiert über `windowDays` (default 30):
  - bis 30 Punkte Abzug: Incident-Last × Severity-Gewicht (critical=5, high=3, medium=1, low=0.5)
  - bis 30 Punkte Abzug: Recurrence-Burden (Summe `recurrence_count`)
  - bis 20 Punkte Abzug: Component-Health (down × 5, degraded × 2)
  - bis 20 Punkte Abzug: aktueller Health-Status (down → 0, degraded → 10, unknown → 14, healthy → 20)
- Markdown-Tabelle mit 🔴/🟡/🟢-Flags, sortiert nach schlechtestem zuerst

**T4.2 — Cascade-Detection** (`itsm-repository.ts:observeCascade` + `listCascades`, Skill `list_cascades`)
- Bei jedem neuen Auto-Incident wird gegen recently-resolved Incidents anderer Services (30min-Fenster) gematcht
- Pro beobachteten (sourceService → targetService)-Pair wird `observed_count++` und der Average-Delay aktualisiert (`avg_delay_minutes`)
- Über Zeit lernt das System Service-Failure-Cascades aus echten Beobachtungen — unabhängig von der konfigurierten CMDB-Topologie
- Skill listet Cascades sortiert nach Häufigkeit mit Service-Namen + ⌀ Verzögerung

**T4.3 — Post-Incident-Review-Skill** (`itsm-repository.ts:findClosedIncidentsWithoutPir`, Skill `pir_pending`)
- Identifiziert in den letzten 72h geschlossene Incidents ohne `lessons_learned` und ohne `postmortem`
- Skill listet sie auf — User kann pro Incident `update_incident lessons_learned=…` oder direkt Runbook generieren
- Daily-Reflection erwähnt offene PIRs

**T4.4 — SLA-Breach-Prediction** (`itsm-repository.ts:slaBreachRisk`, Skill `sla_breach_risk`)
- Für jeden aktiven Incident: ist auf einem der affected Services ein `sla.targets.mttrMinutes` gesetzt?
- Vergleich mit historischem MTTR-Median (aus `mttrReport`) → Projektion ob Bruch droht
- Skill listet Risiken nach Restzeit sortiert mit 🔴 (verletzt) / ⚠️ (<30min) / 🟡 (eng)

**Daily-Reflection erweitert** (`alfred.ts:dailyReflection`):
- Bestehender 23:00-Job zeigt zusätzlich: Service-Scores <70 (Top 3), SLA-Risiken (Top 3), offene Post-Incident-Reviews (Top 3)
- Skip-Bedingung erweitert: nur wenn ALLE Sektionen leer sind, wird die Reflection ausgelassen

### Notes
- Build grün (12/12)
- Cascade-Tabelle füllt sich erst über Zeit — sinnvolle Daten ab ca. 2-4 Wochen Laufzeit
- T1-T4-Quartett komplett: v631 Pattern-Detection, v632 WebUI, v633 Smart, v634 Operational Excellence
- Roadmap-Bonus (nicht in v634): Auto-Capacity-Change-Vorschlag (wenn Forecast <30d), Service-Topology-Visualisierung aus Cascades

## [0.19.0-multi-ha.633] - 2026-05-21

### Added — Smart ITSM Erweiterungen (T3 vom T1-T4-Quartett)

Sieben Verbesserungen, die den Lifecycle deutlich aufräumen und Alfred dazu bringen, mehr Eigenarbeit zu leisten.

**Migrationen** — SQLite v67, Postgres v70:
- `cmdb_incidents`: `recurrence_count INTEGER DEFAULT 0`, `last_recurrence_at TEXT`
- `cmdb_change_requests`: `pr_url TEXT`
- Neue Tabelle `cmdb_metric_samples (id, user_id, asset_id, metric_name, value, unit, sampled_at, source)` + Indizes

**T3.1 — Auto-RCA bei Problem-Erstellung** (`alfred.ts:runProblemRca`)
- Bei `auto-promoted` und Sweep-Problems mit ≥2 verlinkten Incidents wird fire-and-forget ein LLM-Call abgesetzt (default tier, 800 Tokens, deutsch).
- Prompt enthält Problem-Titel + Incident-Titel/Symptoms.
- Antwort wird in 3 Abschnitten erwartet (Root-Cause-Hypothese, Untersuchungs-Schritte, Vorgeschlagener Fix).
- Persistenz: `analysisNotes` via `appendAnalysisNotes`, `proposedFix` per regex-Extraktion aus der "Vorgeschlagener Fix"-Sektion.
- Skipped wenn LLM nicht konfiguriert oder `rootCauseDescription` schon gesetzt.

**T3.2 — Known-Error-Auto-Apply** (`alfred.ts:findKnownErrorMatch`)
- Beim Erstellen eines neuen Auto-Incidents wird gegen alle `is_known_error=true` Problems gematcht (≥2 shared keywords).
- Bei Treffer wird der bekannte Workaround mit Problem-ID-Link **vor** den Alert-Text in die `symptoms` geschrieben — User sieht direkt "🔁 Bekannte Lösung aus Problem `<id>`: …".

**T3.3 — MTTR-Tracking** (`itsm-repository.ts:mttrReport`, Skill-Action `mttr_report`)
- Aggregiert Resolve-Zeiten (`resolved_at - opened_at`) je Asset + Gesamt
- Mean / Median / p95 in Minuten + `recurrenceTotal`
- Skill-Display als Markdown-Tabelle, Daten via `mttr_report window_days=30` aufrufbar

**T3.4 — Capacity-Forecast** (`metric-samples-repository.ts`, Skill-Action `capacity_forecast`)
- Neue Repository `MetricSamplesRepository` mit `record()`, `listRecent()`, `forecast()`
- Monitor-Hook in `alfred.ts` parsed jetzt numerische Werte aus Alerts (`xx.x%`, MB/GB/ms) + Metric-Name (RAM/CPU/disk/memory/GPU/swap/load/temperature) und schreibt pro Asset einen Sample
- `forecast()`: lineare Regression über `windowDays` (default 30), liefert `slopePerDay`, `latestValue`, `daysUntilThreshold` (default 95%)
- Sortiert nach Dringlichkeit (kürzeste Zeit-bis-Threshold zuerst)
- Use case: "PGSql-P01 RAM stieg von 90→95% in 14d → in ~30d wird OOM erwartet"

**T3.5 — Re-Open statt Duplicate bei Recurrence** (`itsm-repository.ts:findRecentResolvedDuplicate` + `reopenIncident`)
- Vor jedem Auto-Incident-Create check: existiert ein resolved/closed Incident mit denselben Keywords + Source in den letzten 24h?
- Wenn ja → re-open + bump `recurrence_count` + append `[Re-Open #N]`-Notiz zu `symptoms`
- Ergebnis: ein Incident pro echtem Vorfall statt N Duplikate pro Flap-Cycle
- Bei `recurrence_count ≥ 3` wird der Incident als "neu" markiert sodass Pattern-Detection ihn sieht und Auto-Promotion zünden kann

**T3.6 — Change-PR-Link** (Schema)
- `cmdb_change_requests.pr_url` Spalte
- `CmdbChangeRequest.prUrl` Type-Erweiterung
- `updateChangeRequest({ prUrl })` akzeptiert das Feld
- Auto-Population aus Code-Agent folgt später; manuell oder via `update_change` heute schon nutzbar

**T3.7 — Daily ITSM-Reflection** (`alfred.ts:dailyReflection`)
- Täglich um 23:00 lokal: Sammelt 7d-Statistik (Incidents, Closed, Top-Recurrers ≥2×, MTTR-Summary, Capacity-Forecasts ≤30d zu Threshold)
- Sendet Insight-Message an Owner-Chat (Telegram/Discord/Matrix je nach Config)
- Skipped wenn nichts zu berichten ist (keine Incidents + keine Recurrer + keine Forecasts)
- Initial-Delay bis zum nächsten 23:00, danach 24h-Intervall (unref()ed)

### Notes
- Build grün (12/12)
- Beim ersten Deploy auf Bestandsdaten: SQLite/Postgres-Migrationen laufen automatisch beim Start, `cmdb_metric_samples` ist leer — Forecast baut sich über die nächsten 14-30d auf
- Manuell triggerbar: `Alfred, mttr report` und `Alfred, capacity forecast` (Chat) bzw. die Skill-Actions
- v634 (T4 Operational Excellence: Service-Score, Cascade-Detection, Post-Incident-Review, SLA-Breach-Prediction) folgt

## [0.19.0-multi-ha.632] - 2026-05-21

### Added — ITSM WebUI Bulk-Merge + Pattern-Preview (T2 vom T1-T4-Quartett)

Macht Pattern-Detection und Backfill sichtbar/bedienbar in der WebUI.

**Backend** (3 neue Endpoints + Callbacks):
- `POST /api/itsm/problems/:id/bulk-link` — mehrere `incident_ids` in einem Call an bestehendes Problem hängen
- `POST /api/itsm/problems/promote` — `title` + `incident_ids[]` → neues Problem mit allen verlinkt
- `POST /api/itsm/incidents/backfill-assets` — Skill-Action `backfill_assets` als HTTP-Wrapper
- `ItsmCallbacks` um `bulkLinkToProblem`, `promoteIncidentsToProblem`, `backfillAssets` erweitert
- `alfred.ts` wired alle drei mit `resolveUser`-User-Scoping

**Frontend** (`apps/web/src/components/itsm/ItsmPage.tsx`):
- **Multi-Select-Spalte** in Incidents-Tabelle: Checkboxen pro Zeile + Select-All-Header, ausgewählte Zeilen blau hinterlegt
- **Bulk-Toolbar** erscheint sobald ≥1 ausgewählt: Counter, "Auswahl löschen", "+ Neues Problem", "→ Bestehendes Problem"
- **Merge-Modal** mit zwei Modi: Neues Problem (Titel + Priority) oder bestehendes Problem (Dropdown aus `problems`-Liste)
- **🔧 Asset-Backfill-Button** im Toolbar — One-Shot-Action mit Result-Alert (`X aktualisiert, Y bereits gesetzt, Z kein Match`)
- **🔁 Patterns-Tab** (neu) — listet alle erkannten Cluster (default ≥2 Incidents in 14d) als Karten mit:
  - Vorkommen-Counter, Keyword-Cluster, Zeitraum, Asset/Service-Counts
  - "Linked Incidents"-Details-Expander
  - "+ Als Problem promoten"-Button pro Cluster (mit Confirm-Dialog), wenn nicht schon gelinkt
  - Live-Filter: Fenster-Tage + Min. Incidents

**Client** (`apps/web/src/lib/alfred-client.ts`):
- `itsmBulkLinkToProblem(problemId, incidentIds[])`
- `itsmPromoteIncidents(title, incidentIds[], priority?)`
- `itsmBackfillAssets()`

### Notes
- ITSM-Route: 9.9 kB → 12.2 kB
- Praktischer Workflow: **Patterns-Tab öffnen → Cluster sehen → "Promoten" oder manuell Incidents im Tab "Incidents" filtern → Multi-Select → Bulk-Merge**
- Backend grün (12/12), Frontend grün
- v633 (T3 Smart Features) und v634 (T4 Operational Excellence) folgen

## [0.19.0-multi-ha.631] - 2026-05-21

### Added — ITSM Pattern-Detection greift härter (T1 vom T1-T4-Quartett)

User-Befund: 100 Incidents in der DB, 2 Problems, 0 Verknüpfungen. Klare Doppelgänger (`PGSql-P01 RAM 95.x%` 15×, `git-server RAM 95.x%` 16×, `homeassistant Health check` 6×, `unifi Subsystem wlan` 8×) blieben unentdeckt. Vier Verbesserungen, die das Symptom strukturell beheben.

**T1.1 — Title-Normalization vor Keyword-Cluster** (`packages/storage/src/repositories/problem-repository.ts`):
- Neue Helper `normalizeTitle(title)` strippt `<num>%` (Prozent-Varianten), `<ip>` (IPv4), `<ts>` (ISO-Zeit), `<hex>` (Hex-IDs ≥6 chars), `<num>` (Zahlen ≥3 Stellen).
- `detectPatterns()` clustert auf normalisiertem Titel → `95.0%`/`95.1%`/`95.2%` haben jetzt identisches Keyword-Set
- GENERIC-Blacklist um `subsystem`, `usage`, `value` erweitert

**T1.2 — Asset-ID-Backfill für Altdaten** (`packages/skills/src/built-in/itsm.ts`):
- Neue Skill-Action `backfill_assets`: scannt alle Incidents mit leerem `affected_asset_ids`, matched Asset-Names/Hostnames (≥3 chars, Word-Boundary, Regex-escaped) gegen Title + Symptoms, schreibt Treffer zurück
- Pattern-Detection clustert damit auch über historische Incidents (Vorher 77/100 nicht clusterbar)
- Companion-Action `bulk_link_to_problem` (problem_id + incident_ids[]) für WebUI-Bulk-Merge (v632)
- Neue `detectedBy='pattern_detection'` Variante in `CmdbProblem.detectedBy` Union-Type

**T1.3 — Zwei-Stufen-Promotion statt nur Confirmation** (`packages/core/src/alfred.ts`):
- `≥5 Incidents innerhalb 7d` ODER `≥8 absolut` → **automatisch** Problem erstellen + alle Incidents verlinken, kurze Info-Message an Owner-Chat ohne Confirmation-Round-Trip
- `3-4 Incidents in 14d` → weiterhin 24h-Confirmation wie bisher
- Reasoning: eindeutige High-Count-Cluster sind unstrittig, manueller Approval-Schritt nur Reibung

**T1.4 — Periodische Pattern-Sweep** (`packages/core/src/alfred.ts`):
- `setInterval(30min)` zusätzlich zum post-monitor-Trigger
- Fängt Cluster auch wenn keine neuen Monitor-Alerts kommen (nur tägliche Alerts → `minIncidents=3 in 14d` braucht Geduld)
- Sweep promoviert NUR automatisch (≥5/7d), Confirmations bleiben dem live-Monitor-Pfad vorbehalten
- `unref()`-ed für sauberen Shutdown

### Notes
- Build grün (12/12). Neue Skill-Actions sind sofort über LLM/Chat verfügbar (`Alfred, ITSM Backfill ausführen`)
- Für f05b0123-Bestandsdaten: nach Deploy einmalig `backfill_assets` ausführen, dann `detect_problem_patterns` → die 15+16+8 Cluster werden direkt sichtbar
- v632 (T2 WebUI Bulk-Merge + Pattern-Preview-Tab) folgt unmittelbar; v633 (T3 Smart features) und v634 (T4 Operational Excellence) danach

## [0.19.0-multi-ha.630] - 2026-05-21

### Fixed — Project-Agent-Session-State: 'done' bei tatsächlichem Failure

v620 hatte den `'failed'`-State in `ProjectAgentMeta` ergänzt und die Coding-Phase-ExitCode≠0-Behandlung darauf umgestellt — **drei weitere End-Pfade** in `project-agent-runner.ts` setzten aber weiterhin unconditional `'done'`, sodass fehlgeschlagene Sessions in der UI als grünes "done" mit Sanduhr-Icon (`lastBuildPassed=false`) erschienen. Genau dieses Symptom hatte der User schon mehrfach (`d116503c`, `4252cf83`, jetzt `f05b0123`); die Quick-Fix-SQL-Updates haben das Symptom behoben, nicht die Ursache.

**Konkret** (`packages/core/src/project-agent-runner.ts`):
- Zeile 164 (Pre-Flight-Check fehlgeschlagen, cwd nicht erreichbar): `'done'` → `'failed'`
- Zeile 469 (Post-Loop, alle Phasen durchlaufen): unconditional `'done'` → `overallSuccess ? 'done' : 'failed'`. Dazu wurde die Reihenfolge umgedreht: `overallSuccess = anyPhaseProducedFiles && lastBuildActuallyPassed` wird jetzt **vor** der Phase-Zuweisung berechnet. Die nachgelagerte Logik (Git-Push nur bei Success, End-Message, Completion-Callback) ist unverändert — die hat `overallSuccess` schon vorher korrekt benutzt; lediglich der persistierte Phasen-State lief auseinander.
- Zeile 514 (Catch-Block bei Exception): `'done'` → `'failed'` (Exception ist per Definition Failure)

### Effekt
- Sessions, die alle Phasen durchlaufen aber **nie** erfolgreich gebaut haben → DB `current_phase='failed'` (rot, 🔴-Icon)
- Pre-Flight-Failures (z.B. cwd nicht erreichbar als runAsUser) → `'failed'`
- Exceptions (`removeAbortController`, completion-callback-throws, etc.) → `'failed'`
- Erfolgreich gebaute Sessions: weiterhin `'done'` (grün, ✅-Icon)

### Notes
- Bestehende Sessions mit fälschlich `'done'`-State werden per einmaligem SQL-Update korrigiert: `UPDATE project_agent_sessions SET current_phase='failed' WHERE current_phase='done' AND last_build_passed=false`
- Build grün (12/12)
- v620 (Type-Erweiterung) und v630 (alle End-Pfade) zusammen schließen das Thema endgültig

## [0.19.0-multi-ha.629] - 2026-05-21

### Added — Structural Integration (C vom A/B/C-Trio)

Letzter Teil der WebUI-Ausbaustufe. Verbindet den Chat strukturell mit Alfreds Reasoning-/Action-Layer und Knowledge-Graph: offene Bestätigungen werden direkt im Chat freigegeben/abgelehnt, Entity-Namen werden klickbar, anstehende Reminder sichtbar.

**Backend** (`packages/storage/src/repositories/confirmation-repository.ts`):
- `findAllPendingForUser(userId, limit)` — Join auf `conversations.user_id` als Ownership-Filter, sodass ein User in der WebUI keine pending Confirmations eines anderen Users sehen oder beeinflussen kann.

**ConfirmationQueue** (`packages/core/src/confirmation-queue.ts`):
- `handleWebDecision({ id, decision, userId })` — Web-UI-Ersatz für inline-Button-Press. Baut den `SkillContext` (inkl. korrektem `conversationId` via ConversationRepository), ruft dann `checkForConfirmation()` mit synthetischem `confirm:<id>:<decision>`-String — so läuft die Auto-Sibling-Topic-Dedup, das Adapter-Feedback, der ActivityLogger und FeedbackService **identisch** zur Telegram-Inline-Button-Flow.
- `listPendingForUser(userId, limit)` — Wrapper über das neue Repo-Method
- `setConversationRepository(repo)` — Optional-Dependency-Injection für korrekten `conversationId`-Lookup

**HTTP-Adapter** (`packages/messaging/src/adapters/http.ts`):
- `setConfirmationCallbacks({ list, decide })` + `setRemindersCallback(list)`
- 4 neue Endpoints:
  - `GET /api/confirmations/pending` — Liste der offenen Bestätigungen für den User
  - `POST /api/confirmations/:id/approve` — Aktion freigeben (returns 200/409/404)
  - `POST /api/confirmations/:id/reject` — Aktion ablehnen (returns 200/409/404)
  - `GET /api/reminders` — alle anstehenden Reminders

**Wiring** (`packages/core/src/alfred.ts`): scope-bar auf `ownerMasterUserId`; Web-Approval läuft serverseitig durch dieselbe ConfirmationQueue wie ein Telegram-Button — gleicher Code-Path, kein Drift.

**Frontend**:
- `apps/web/src/components/chat/ChatSidePanel.tsx` (neu, 165 LoC)
  - **Sektion 1 "Offene Bestätigungen"**: Karten mit Skill-Name, Beschreibung, Ablaufzeit ("läuft in 28m ab") und Buttons "✓ Freigeben"/"✕ Ablehnen". Optimistic refresh nach Klick. Auto-Refresh alle 30s während Panel offen.
  - **Sektion 2 "Anstehende Reminders"**: nächste 15, sortiert nach `triggerAt`, mit Relativ-Zeit und absoluter Zeitangabe.
  - **Sektion 3 "Schnellzugriff"**: 2×2-Grid für History/Knowledge/Memories/Runbooks.
  - Panel-State (offen/zu) per `localStorage` (`alfred-chat-side-panel`) persistiert.
- `ChatPage.tsx`: 2-Spalten-Layout mit toggle-bar Side-Panel (📋-Button im Header)
- **C2 Entity-Klick**: `ChatMessage.tsx` parsed Wiki-Style `[[Entity Name]]` (außerhalb von Code-Fences) und rendert als violetter Pill-Link auf `/alfred/knowledge/?entity=<name>`
- `KnowledgeGraphPage.tsx`: liest `?entity=`-Query-Param und initialisiert `searchQuery` damit — Deep-Link landet direkt auf gefilterter Sicht

### Notes
- `pnpm build` grün (12/12). Knowledge-Route wuchs minimal (5.05→5.10 kB) durch initialState-Hook
- A/B/C ist damit komplett: v627 = History-Viewer, v628 = Chat-UX-Enhancements, v629 = Structural Integration
- Web-Approve nutzt **dieselbe** `ConfirmationQueue.checkForConfirmation()`-Methode wie der Telegram-Inline-Button-Flow → keine duplizierte Business-Logic, kein Drift bei künftigen Auto-Sibling-Dedup-Änderungen

## [0.19.0-multi-ha.628] - 2026-05-21

### Added — Chat-Interface-Enhancements (B vom A/B/C-Trio)

Zweiter Teil der WebUI-Ausbaustufe. Bestehender rudimentärer Chat bekommt produktive Bedien-Features.

**InputBar** (`apps/web/src/components/chat/InputBar.tsx`):
- **Auto-Resize-Textarea** — wächst bis 12 Zeilen, dann interner Scroll
- **Stop-Button während Streaming** — ersetzt Senden-Button mit rotem Stop-Glyph, verbindet auf `useChat.cancel()`
- **Slash-Command-Palette** (B3) — Komponente `SlashCommandPalette.tsx`: `/`-Tastendruck öffnet, gefilterte Liste mit ↑/↓-Navigation, Tab-Vervollständigung, Enter-Übernahme. 9 Befehle: `/help /clear /skills /usage /history /dashboard /knowledge /memories /runbooks` — Routen springen direkt, andere werden als Nachricht gesendet.
- **Token-Preview** — Live-Zähler unter dem Input: Zeichen + geschätzte Tokens (3.5 chars/token, German-tuned)
- **Draft-Persistence** — ungesendeter Text wird in `localStorage` als `alfred-chat-draft` gehalten und nach Reload wiederhergestellt
- **Streaming-Indicator** — pulsierender blauer Dot rechts unten ("Alfred antwortet …")
- Mobile-Padding: `p-3 md:p-4` statt fixed `p-4`

**useChat** (`apps/web/src/hooks/useChat.ts`):
- `clearMessages()` — lokales State + persistierten Cache leeren
- `retryLast()` — letzte Assistant-Nachricht verwerfen, letzte User-Nachricht neu streamen
- `editLastUser(newText)` — letzte User/Assistant-Pair durch neue User-Nachricht ersetzen, neu streamen
- **Message-Persistence** — `state.messages` werden in `localStorage` (Key `alfred-chat-messages`, max 200) persistiert und beim Mount wiederhergestellt; reload verliert Conversation nicht mehr

**ChatMessage** (`apps/web/src/components/chat/ChatMessage.tsx`):
- **Hover-Actions** (B4) — Copy/Edit/Retry-Buttons erscheinen on-hover oberhalb der Bubble
- **Copy** auf jeder Nachricht (mit ✓-Bestätigung)
- **Edit** nur auf letzter User-Nachricht (Inline-Textarea, Abbrechen/Senden ↻)
- **Retry** nur auf letzter Assistant-Nachricht
- Edits sind disabled während `streaming`, kein Doppel-Submit möglich

**ChatPage** (`apps/web/src/components/chat/ChatPage.tsx`):
- Header (sichtbar ab erster Nachricht): User-ID, Nachrichten-Count, "Leeren"-Button
- `lastUserId`/`lastAssistantId` per `useMemo` an `ChatMessage` durchgereicht
- Confirm-Dialog vor "Leeren" mit Hinweis dass Server-Historie unverändert bleibt

### Notes
- `pnpm build` grün (12/12); Chat-Route hat sich nicht vergrößert (165 B Route + 154 kB First-Load gleich wie vorher)
- v627 (A - History-Viewer) und v628 (B - Chat-UX) sind unabhängig deploybar
- v629 (C - Structural Integration) folgt: Confirmations im Chat, Entity-Klick öffnet KG, Insight-Side-Panel

## [0.19.0-multi-ha.627] - 2026-05-21

### Added — Chat-History-Viewer in der WebUI (A vom Trio A/B/C)

Erster Teil der mit dem User geplanten Chat-UI-Ausbaustufe ("vollumfänglich machen"). Read-Mode-Viewer für alle persistierten Conversations: Sidebar mit Plattform-Filter, Detail-Panel mit Lazy-Loading älterer Nachrichten, Volltextsuche über alle Chats via Ctrl+K, Markdown-Export pro Conversation.

**Backend** (`packages/storage/src/repositories/conversation-repository.ts`):
- `listConversations({ userId?, platform?, limit?, offset? })` — listet Conversations mit Message-Count + letztem-Preview ohne N+1, scope-bar auf User
- `getMessagesPaged(conversationId, { beforeIso?, limit? })` — paginiert für Lazy-Loading älterer Nachrichten
- Bestehendes `searchMessages(userId, query, opts)` (FTS5/tsvector + 30d-Decay) wird wiederverwendet

**HTTP-Adapter** (`packages/messaging/src/adapters/http.ts`):
- `setConversationCallbacks(...)` + 4 neue Endpoints:
  - `GET /api/conversations?platform=&limit=` — Sidebar-Liste
  - `GET /api/conversations/:id/messages?before=&limit=` — Paginierter Detail-Load
  - `GET /api/conversations/:id/summary` — `conversation_summaries`-Eintrag wenn vorhanden
  - `GET /api/conversations/search?q=&limit=` — Volltext-Treffer mit Score

**Wiring** (`packages/core/src/alfred.ts`): Callbacks scopen auf `ownerMasterUserId`, ConversationRepository + SummaryRepository werden aus dem bestehenden DB-Adapter erzeugt.

**Frontend** (`apps/web/src/components/history/`):
- `HistoryPage.tsx` — Layout-Container, State-Mgmt, Ctrl+K-Hotkey, Markdown-Export
- `ConversationsSidebar.tsx` — gefilterte Liste mit Plattform-Icon, Relativ-Zeit, Preview
- `ConversationDetail.tsx` — chronologische Anzeige, "Ältere laden"-Button am Top
- `ToolCallsBlock.tsx` — JSON-Parser für `tool_calls`, expandierbar mit Pretty-Print
- `SummaryBanner.tsx` — gelb hervorgehoben am Top wenn Summary existiert
- `SearchOverlay.tsx` — Modal mit 250ms-Debounce, Treffer-Hervorhebung, Klick springt in Conversation
- Sidebar-Eintrag "📜 History" zwischen Chat und Dashboard

### Notes
- `pnpm build` grün (12/12); Web-Bundle: history-Route 4.36 kB
- Read-Only-Viewer: Mutation-Endpoints folgen in v629 (C - Structural Integration)
- v628 (B) bringt Chat-Interface-Enhancements; v629 (C) integriert Confirmations/Entity-Klicks/Side-Panel

## [0.19.0-multi-ha.626] - 2026-05-21

### Fixed — `MAX_TIMEOUT_MS` Ceiling clampte v624 Long-Phase auf 15min statt 20min

User-beobachtet während laufender Phase 2 (alpbyte-games Validation): Halfway-Warning erschien bei 450s (=7.5min) mit "wird in ~8min gekillt" — Summe 15min, nicht die in v624 versprochenen 20min.

**Root cause** in `agent-executor.ts:178`:
```typescript
const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);
```

`MAX_TIMEOUT_MS = 900_000` (15min) clampte den vom Runner übergebenen Wert (20min für Long-Phases) intern auf 15min. v624's "20min Long-Phase" war damit eine **Lüge meinerseits** — der Wert kam nie an.

**Fix**: `MAX_TIMEOUT_MS` von `900_000` (15min) auf `1_800_000` (30min) angehoben. Damit wirkt das 20min-Long-Phase-Setting tatsächlich, plus 10min Buffer für noch extremere Cases (große monorepos, langsame networks).

**Effekt nach v626**:
- Normal-Phase: 10min Inactivity (Halfway bei 5min) — unverändert
- Long-Phase: **wirklich 20min** Inactivity (Halfway bei 10min) — vorher fälschlich 15min
- Absolute Cap bleibt 60min

### Notes
- Build grün (12 packages)
- One-line core change; entschuldige die wiederholte Schlamperei in dieser Code-Region
- Laufende Phase die schon im 15min-Timer war wird mit v625 noch gekillt; nach Deploy + Restart gilt v626

## [0.19.0-multi-ha.625] - 2026-05-21

### Changed — Default-Inactivity-Timeout von 5 auf 10 min

Pragmatische Folge-Anpassung zu v624: nach Diskussion der typischen LLM-Reasoning-Pausen (1-3min legitim, gelegentlich >2min bei komplexen Multi-File-Refactorings) war der v619 Default von 5min zu eng. False-positive Kills nicht nur bei expliziten Build-Phasen sondern auch bei normalen, intensiven Coding-Phasen mit langen Reasoning-Schritten.

**Geändert**:
- `packages/skills/src/built-in/code-agent/agent-executor.ts`: `DEFAULT_TIMEOUT_MS` von `300_000` (5min) auf `600_000` (10min)
- `packages/core/src/project-agent-runner.ts`: Normal-Phase-Timeout im Phase-Detection-Code-Block ebenfalls von 5min auf 10min angehoben (Long-Phase bleibt 20min)

**Effekt**:
- Normal-Phase: Halfway-Warning bei 5min Stille → Kill bei 10min
- Long-Phase (build/test/lint/install): Halfway-Warning bei 10min → Kill bei 20min (unverändert v624)
- Absolute Cap bleibt 60min (unverändert)

Echte Hänger werden weiterhin erkannt; nur die Toleranz für legitime stille Phasen ist 2× erhöht. Halfway-Warning macht den Unterschied "wirklich tot" vs "still aber lebt" für den User sichtbar.

### Notes
- Build grün (12 packages)
- One-line core change, minimaler Patch
- Echte Hang-Erkennung verzögert sich um 5min — akzeptabel weil ABSOLUTE_CAP_MS=60min Schutz bleibt

## [0.19.0-multi-ha.624] - 2026-05-21

### Fixed — B+D: Halfway-Warning + Phase-Type-aware Inactivity-Timeout

Zwei aufeinander folgende Phase-2-Kills im alpbyte-games Security/Production-Run (Sessions d116503c, 4252cf83): claude-code wurde bei Validierungs-Phasen ("npm install, lint, typecheck, test, build") nach exakt 5min (v619 `DEFAULT_TIMEOUT_MS`) gekillt, obwohl er produktiv arbeitete — nur eben ohne stdout während die npm-Subprocesses liefen.

**Root cause**: `DEFAULT_TIMEOUT_MS=300_000` (5min) ist die Inactivity-Schwelle für ALLE Phasen. Inspect/Edit-Phasen sind <2min, aber Validierungs-Phasen mit `npm install + lint + typecheck + test + build` brauchen realistisch 5-10min Sub-Process-Zeit ohne eigenen Output des Agents. Bei genau 5min Stille → SIGTERM mit false-positive "inactivity timeout".

#### D — Phase-Type-aware Inactivity-Timeout (`project-agent-runner.ts`)

Vor jedem `executeAgent()`-Call wird der Phase-Text gegen ein Pattern geprüft:

```typescript
const longPhasePattern = /\bnpm\s+(install|run\s+build|run\s+lint|run\s+typecheck|test|run\s+test|ci)\b|\bvalidier|\bvalidation\b|\bvalidate\b|\bbuild-?fehler\b|\breproduzieren\b/i;
```

Wenn match → `timeoutMs: 20 * 60_000` (20min Inactivity), sonst Default 5min. Plus: alle **Fix-Läufe** im Build-Validate-Loop bekommen ebenfalls 20min, weil `npm run build` zum Reparieren typisch ist.

Effekt: Normal-Phasen failen weiterhin schnell wenn der Agent hängt (5min); legitime Validation/Build-Phasen können 20min still sein ohne false-positive Kill.

#### B — Mid-Progress-Warning bei 50% (`agent-executor.ts`)

Pro inactivity-window wird zusätzlich zum kill-Timer ein `halfwayTimer` gesetzt der bei `timeoutMs/2` einmalig den `onProgress`-Callback feuert mit Text:

> ⏳ Stille seit Ns — wird in ~Mmin gekillt sofern keine Aktivität

Beim nächsten stdout/stderr-Chunk wird der Timer mit `resetInactivity()` zusammen mit dem inactivity-Timer zurückgesetzt → keine Spam-Warnings bei zwischenzeitlicher Aktivität. Pro Stille-Phase max eine Warnung.

Effekt für User in Telegram:
- Normal-Phase (5min): Warning bei 2.5min Stille → Kill bei 5min
- Long-Phase (20min): Warning bei 10min Stille → Kill bei 20min
- → User sieht in Echtzeit "Agent ist noch da nur leise" vs "Agent ist wirklich tot"

#### Was unverändert bleibt

- `ABSOLUTE_CAP_MS = 60min` als oberster Hammer
- Sliding-Inactivity-Timer-Mechanik aus v619 D0
- exitCode-Checks aus v618 B1
- Diagnose-Reihenfolge aus v619 D1

### Notes
- Build grün (12 packages)
- Reine Defensive-Verbesserung; bei normalem Agent-Verhalten unverändert
- Long-Phase-Detection ist regex-basiert auf Phase-Text — bei false-positive (kein Build aber Wort "validate" in der Beschreibung) → 20min statt 5min ist nur längere Wartezeit auf echten Hänger, kein Schaden

## [0.19.0-multi-ha.623] - 2026-05-20

### Added — Background-Tasks WebUI (analog Project-Agents)

Persistente Inspektor-Seite für `background_tasks`-Tabelle. Gegenstück zum v609 Project-Agents-UI für die andere Sorte langlaufender/async Skill-Tasks (shell, deploy, code_agent-persistent). Macht Recovery-Stories (Midnight-Crash, Cluster-Failover) und gefährliche failed-tasks sichtbar.

#### Backend

`packages/storage/src/repositories/background-task-repository.ts`:
- Neue `listAll({ status?, limit? = 200 })` — generische Liste, optional Status-Filter, neueste zuerst

#### HTTP-API

`packages/messaging/src/adapters/http.ts`:
- `setBackgroundTaskCallbacks({ list, get, cancel })` — neue Callback-Setter
- 3 neue Endpoints:
  - `GET /api/background-tasks?status=<status>` — Liste mit optional Status-Filter
  - `GET /api/background-tasks/:id` — Detail einer einzelnen Task
  - `POST /api/background-tasks/:id/cancel` — Cancel-Aktion (nur in pending/running möglich)
- Wired in `alfred.ts` neben Project-Agent-API (3635+)

#### Frontend

`apps/web/src/components/background-tasks/BackgroundTasksPage.tsx` (neu):
- Tabelle aller Tasks mit Status-Badge, Description-Snippet, Skill-Name, Dauer, Resume-Count
- ⚓-Icon wenn `agent_state` vorhanden (recoverable)
- ↻N-Icon wenn `resumeCount > 0`
- Filter-Dropdown: alle/pending/running/checkpointed/resuming/completed/failed/cancelled
- Volltext-Suche über description/skill/id/error
- Auto-Refresh alle 10s solange mindestens eine live-Task sichtbar (pending/running/resuming/checkpointed)
- Detail-Panel rechts mit: voller Description, Skill-Input (raw JSON), Error/Result-Blocks, Created/Started/Checkpoint/Completed-Timestamps
- Cancel-Button für `pending`/`running`-Tasks

`apps/web/src/lib/alfred-client.ts`:
- `BackgroundTaskItem` interface + `BackgroundTaskStatus` type
- 3 Methoden: `fetchBackgroundTasks`, `fetchBackgroundTask`, `cancelBackgroundTask`

`apps/web/src/components/layout/Sidebar.tsx`:
- Neuer Eintrag "Background Tasks" mit ⚙️ Icon zwischen "Project Agents" und "Projects"

`apps/web/src/app/background-tasks/page.tsx` (neu):
- Route /background-tasks → BackgroundTasksPage

### Notes
- Build grün (12 packages), Route `/background-tasks` 2.75 kB
- Auf .92 aktuell 2 background_tasks-Einträge sichtbar (beide failed shell-tasks vom v611-Crash + v619-Test) → Recovery-Story jetzt visuell nachvollziehbar
- Keine DB-Migration, keine API-Breaking-Changes

## [0.19.0-multi-ha.622] - 2026-05-20

### Added — Dashboard Usage-Tracking: Time-Range-Picker + Stacked Bars + Model-Toggle

User-Wunsch: granularere Sicht auf die LLM-Kosten — auswählbare Zeiträume (heute/Woche/Monat/Jahr/All-Time), Balkendiagramm gestapelt nach Model, Models toggelbar.

#### Backend (X1) — Range-aware Dashboard API

`packages/storage/src/repositories/usage-repository.ts`:
- Neue `getRangeByMonth(startDate, endDate)`: aggregiert `llm_usage` über `SUBSTR(date, 1, 7)` zu Monats-Buckets statt täglich. Für Year/All-Time-Views (sonst 365 statt 12 Balken).
- Neue `getEarliestDate()`: liefert frühestes Datum für All-Time-Range.

`packages/core/src/alfred.ts:dashboardCallback`:
- Signatur erweitert: `(opts?: { range?: string })`
- Range-Mapping:
  - `today` → 1 Tag, daily-buckets
  - `week` → 7 Tage, daily-buckets (Default für Backwards-Compat)
  - `month` → 30 Tage, daily-buckets
  - `year` → 365 Tage, **monthly-buckets** (12 statt 365 Balken)
  - `all` → ab `getEarliestDate()`, **monthly-buckets**
- Response erweitert um: `range`, `startDate`, `endDate`, `bucketGranularity`, `usage.buckets`
- `userUsage` und `userSkillUsage` laufen jetzt **mit der gewählten Range** mit (vorher 7d hardcoded)
- Legacy `usage.week` bleibt befüllt wenn `range='week'` für nicht-aktualisierte Clients

#### HTTP-Adapter — Query-Param-Routing

`packages/messaging/src/adapters/http.ts`:
- `dashboardCallback` Typ akzeptiert `opts?: { range?: string }`
- `handleDashboard` extrahiert `?range=` aus URL, validiert gegen Whitelist (today/week/month/year/all), reicht durch

#### WebUI (X1+X2) — Time-Range-Picker + Stacked Bar Chart

`apps/web/src/components/dashboard/DashboardPage.tsx`:
- Neue `DashboardRange` State (Default `week`)
- 5-Button Tab-Picker oberhalb der Stat-Cards (Heute/Woche/Monat/Jahr/All-Time)
- `useDashboard` hook akzeptiert `range`, ruft `client.fetchDashboard(range)`
- Stat-Card "Letzte 7 Tage" wird dynamisch zu "Heute" / "Woche" / "Monat" / "Jahr" / "All-Time"
- **Bar-Chart komplett neu**: ehemals einfarbig-blau-Cost-pro-Tag → **gestapelte Segmente nach Model**
  - Pro Bucket (Tag oder Monat): jeder Model-Anteil als farbiges Segment
  - 12 stabile Farben aus Palette (claude/gpt/mistral/... bekommen jeweils ihre Farbe)
  - Größtes Segment unten (sortiert nach Kosten desc → stabilere Optik)
  - Höhe normalized über alle sichtbaren Buckets (maxCost dynamisch)
- **Multi-Select-Legend mit Click-to-Toggle**:
  - Pro Model ein Button mit Farb-Square + Name
  - Klick: Model wird `hiddenModels`-Set hinzugefügt → in allen Bars verschwinden seine Segmente
  - Skala (`maxCost`) wird auf sichtbare Models re-normalisiert
  - State lokal in Component (nicht persisted) — Reload setzt zurück
- Bucket-Labels passen sich Granularität an: Tag → `MM-DD`, Monat → `YY-MM`
- Per-User-Tabellen (Admin) zeigen `(${range})` im Titel statt `(letzte 7 Tage)`

#### Was unverändert bleibt

- Service-Usage-Tabelle (STT/TTS/OCR) bleibt flach — diese Kosten skalieren nicht mit LLM und brauchen den Stack-Stress nicht
- "Cost by Model" Tabelle bleibt All-Time
- DB-Schema unverändert — keine Migration

### Notes
- Build grün (12 packages)
- Backwards-kompatibel: alte Clients ohne `?range=` bekommen weiterhin Week-Daten via `usage.week`
- All-Time auf großen DBs (>2 Jahre) liefert 24+ Monats-Buckets — Bar-Chart skaliert horizontal über `flex-1`

## [0.19.0-multi-ha.621] - 2026-05-20

### Fixed — R2: Runbook-Similarity-Dedup im ChatSessionRunbookReflector

User-Beschwerde: 3× aWATTar-Runbooks und 2× Spond-Runbooks am selben Tag — alle nahezu identisch, nur mit leicht anderen LLM-generierten Titeln. Ursache:

Der `ChatSessionRunbookReflector` deduplt **pro Conversation+Marker**. Aber `scheduled_actions` wie `aWATTar Rechnung Check 07:00/12:00/17:00/22:00` erzeugen pro Cron-Lauf eine **neue Conversation**. Jede dieser Conversations wird unabhängig analysiert → LLM extrahiert essentially-gleiches Runbook 4× mit leicht anderen Worten.

**Fix in `chat-session-runbook-reflector.ts`**:

1. Neue `normalizeTitle(title)` Helper-Funktion am Datei-Anfang:
   - lowercase, Sonderzeichen → Whitespace
   - Deutsche + englische Stopwords entfernt (der/die/das, soll/kann/wird, etc)
   - Tokens ≥3 Zeichen behalten, in Set für O(1) Schnittmenge
2. In `processCandidate()` nach LLM-Extraktion + bestehender per-Conversation-Dedup: zusätzlicher Similarity-Check gegen ALLE bestehenden Runbooks (limit 200, alle Status — Duplizieren eines verified-Runbooks wäre besonders unsinnig):
   - **≥3 gemeinsame Tags** → Duplikat
   - **Title-Token-Overlap ≥ 60%** (`shared / min(setA.size, setB.size)`) → Duplikat
3. Bei Treffer: skip + `markProcessed()` damit die Conversation nicht in 5min nochmal versucht wird

Beispiel: für die aWATTar-Konversation würde der neue Code finden:
- Existing: `aWATTar-Rechnungen in Microsoft-Mail prüfen und Duplikate vermeiden` → Tokens {awattar, rechnungen, microsoft, mail, prüfen, duplikate, vermeiden}
- Candidate: `aWATTar-Rechnung in Microsoft-Mail suchen und Duplikate blockieren` → Tokens {awattar, rechnung, microsoft, mail, suchen, duplikate, blockieren}
- Shared: {awattar, microsoft, mail, duplikate} = 4 von 7 = 57% Overlap — könnte je nach Stopword-Filter doch matchen
- PLUS Tag-Overlap "awattar, microsoft, email, finanzen" = 4 gemeinsam → klares Duplikat

Außerdem: bestehende 4 Duplikate (3× aWATTar, 2× Spond minus original) müssen manuell in der WebUI gelöscht werden — der Reflector lässt sie ab v621 nur nicht mehr nachwachsen.

### Notes
- Build grün (12 packages)
- Best-effort — bei Repo-Fehlern wird die Dedup-Check übersprungen, Standard-Save geht weiter
- Marker wird auch beim Skip gesetzt (24h TTL), damit dieselbe Conversation nicht alle 5min erneut versucht
- Keine DB-Migration, kein API-Change

## [0.19.0-multi-ha.620] - 2026-05-20

### Fixed — A1: 'failed' als terminal Phase-State zulassen (UI zeigt jetzt korrekt rot)

In v618 (B1 exitCode-Check) musste der Runner einen Phase-State setzen wenn der Coding-Agent crashed. Der TypeScript-Type `ProjectAgentMeta.projectPhase` enthielt aber kein `'failed'`, nur `'done'`. Workaround in v618: `state.projectPhase = 'done'` setzen — semantisch falsch.

Folge in der WebUI: `ProjectAgentsPage.tsx:128`:
```
buildIcon = lastBuildPassed ? '✅' : (currentPhase === 'failed' ? '🔴' : '⏳')
```
Mit `phase='done'` und `lastBuildPassed=false` greift weder ✅ noch 🔴 → fallback ⏳ Sanduhr. Plus `PHASE_BADGES.done` ist grün. → optisch wirkt eine gecrashte Session wie "fertig mit unklarem Build-Status".

**Fix**:
1. `packages/types/src/storage.ts:78` — `ProjectAgentMeta.projectPhase` um `'failed'` erweitert
2. `packages/core/src/project-agent-runner.ts:295` — v618-Workaround entfernt, `state.projectPhase = 'failed'` korrekt gesetzt

Effekt: gecrashte Sessions zeigen jetzt:
- Phase-Badge: rot (`bg-red-500/20`)
- Build-Icon: 🔴
- Detail-Panel "phase: failed"

### Notes
- Build grün (12 packages)
- DB-Schema unverändert (`current_phase` ist TEXT, akzeptiert beliebige Strings)
- Bestehende Sessions in `phase='done'` bleiben so — nur neue Crashes ab v620 werden `'failed'`. Eine spezifische Session kann manuell per SQL-UPDATE auf `'failed'` gesetzt werden (so wurde z.B. `ea1fb69a-6548-4cf1-812b-66b064d66de7` korrigiert).

## [0.19.0-multi-ha.619] - 2026-05-20

### Fixed — D0+D1+D2: Sliding-Inactivity-Timeout + ehrliche Diagnose

Root cause des Phase-2-Kills im alpbyte-games-Security-Review (codex Phase 2 wurde nach exakt 5 Minuten Hard-Timeout abgebrochen obwohl die ganze Zeit produktiv arbeitend):

**Bug 1 (architektonisch)** — v608 F4 hatte nur halb implementiert was die Anforderung war ("Alfred checkt ob Agent aktiv und verlängert Timeout"). Die SkillSandbox arbeitet mit Inactivity-Tracker (`INACTIVITY_THRESHOLD_MS=120s`) korrekt. Aber `agent-executor.ts:204` hatte einen ZWEITEN, **harten Timer**:
```
const timer = setTimeout(() => kill, timeoutMs);  // absolut, ignoriert Aktivität
```
Egal wie aktiv der Subprocess war — nach `timeoutMs` (5min default) wurde SIGTERM gesendet. Codex Phase 2 mit Multi-Datei-Refactoring → 5min normal → gekillt mitten in der Arbeit.

**Bug 2 (Diagnose-Schlamperei in v618)** — Pattern-Match `/401|Unauthorized|auth\.json|...../i` lief gegen GANZEN stderr (oft 100k+ Zeichen mit Code-Diffs). Bei einem Security-Review enthält der Code-Output zwangsläufig Wörter wie "auth", "Unauthorized" (in betroffenen Routen, Kommentaren, OpenAPI-Beschreibungen). False-Positive: "Auth-Fehler" angezeigt obwohl es ein Timeout war.

#### D0 — Sliding-Inactivity-Timer in agent-executor.ts (kritisch)

`packages/skills/src/built-in/code-agent/agent-executor.ts`:

```diff
- const timer = setTimeout(() => { kill }, timeoutMs);
+ let inactivityTimer;
+ const resetInactivity = () => {
+   if (inactivityTimer) clearTimeout(inactivityTimer);
+   inactivityTimer = setTimeout(() => { kill; killReason='inactivity' }, timeoutMs);
+ };
+ resetInactivity();
+
+ // Plus absolute Sicherung 60min (Safety-Cap)
+ const absoluteTimer = setTimeout(() => { kill; killReason='absolute' }, ABSOLUTE_CAP_MS);
+
+ child.stdout.on('data', chunk => { ...; resetInactivity(); });
+ child.stderr.on('data', chunk => { ...; resetInactivity(); });
```

Neue Semantik:
- `timeoutMs` (default 5min, max 15min) ist jetzt **Inactivity-Schwelle**: kill erst wenn `timeoutMs` lang KEIN Output mehr kommt
- `ABSOLUTE_CAP_MS = 60min` als oberste Sicherung — verhindert Endlos-Schleifen
- stderr wird beim Kill annotiert mit Grund (`inactivity timeout` oder `absolute cap reached`)

Effekt: codex/claude-code/vibe können beliebig lange Phasen ausführen solange sie kontinuierlich Output produzieren. Auth-Hänger + Frozen-Tools + Forever-Loops werden weiterhin nach `timeoutMs`-Stille bzw. spätestens 60min gekillt.

#### D1 — Diagnose-Reihenfolge umgedreht (project-agent-runner.ts)

Vorher: stderr-Pattern-Match war erst, exitCode-Check zuletzt → false-positive Auth-Diagnose schlug zu bei jedem Timeout der zufällig "auth" im stderr hatte.

Jetzt: exitCode-spezifische Hints (exitCode 124 → Timeout-Variante anhand der agent-executor-Annotation) **ZUERST**, stderr-Pattern als Fallback.

Unterschieden:
- `[agent-executor] killed: ... (inactivity timeout)` → "Inactivity-Timeout. Logs prüfen (hung Request, frozen Tool, Auth-Wait)"
- `[agent-executor] killed: ... (absolute cap reached)` → "Absolute Grenze. Phase zu groß, in kleinere Schritte zerlegen"
- Legacy: einfach "Timeout. Sollte mit v619 nicht mehr vorkommen"

#### D2 — stderr-Pattern nur auf letzte 2000 Zeichen

`const stderrTail = stderr.slice(-2000);` — alle Pattern-Tests gegen `stderrTail` statt `stderr`. Verhindert dass beliebige Code-Inhalte (Diffs, Kommentare, OpenAPI-Texte) die Diagnose triggern.

### Notes
- Build grün (12 packages)
- Reine Defensive-Verbesserung: bei korrekt funktionierenden Agents (kein Timeout) komplett unsichtbar
- claude-code, codex und vibe profitieren ALLE vom sliding-timer; vorher war claude-code nur "zufällig schneller fertig", nicht strukturell besser geschützt

## [0.19.0-multi-ha.618] - 2026-05-20

### Fixed — B1: Project-Agent ignorierte exitCode des Coding-Agents → Fake-Success

**Root cause (im Detail in v617-Bericht)**: codex wurde als madh-User ohne Auth aufgerufen, brach mit exitCode 2 (401 Unauthorized vom OpenAI-API) ab. Der Project-Agent-Runner las nur `codeResult.modifiedFiles.length` (=0) und ignorierte `codeResult.exitCode`. Build-Validation lief auf unverändertem Code (= grünes Build), `git commit --allow-empty` produzierte leere Commits, alles wurde als "Phase erfolgreich" reportet. 12 leere Commits landeten auf origin/master. Der User sah "12 Phasen, 0 Dateien geändert" und dachte alles funktioniert.

**Fix in `packages/core/src/project-agent-runner.ts`**:

1. **Coding-Phase**: nach `executeAgent()` wird `codeResult.exitCode` geprüft. Bei `!== 0`:
   - Phase wird als Failure gemeldet mit stderr-Tail (letzte 400 Zeichen)
   - Diagnose-Hint basierend auf stderr-Pattern:
     - `401|Unauthorized|Missing bearer|not authenticated` → "Auth-Fehler. Login als Runtime-User durchführen oder API-Key in agent-Config setzen"
     - `command not found|ENOENT` → "Binary fehlt. Installation prüfen oder absoluten Pfad in Config"
     - exitCode 124 → "Timeout. Komplexität reduzieren oder timeout in Config erhöhen"
   - Phase-State auf `done` gesetzt (terminal), Run wird via `break` aus der Phase-Loop verlassen
   - Post-Loop detect honestly success=false via `anyPhaseProducedFiles && lastBuildActuallyPassed` (beide false)
   - → Telegram bekommt `❌ Project Agent fehlgeschlagen` statt `🎉 fertig`

2. **Fix-Phase im Build-Validate-Loop**: bei `fixResult.exitCode !== 0` wird gewarnt, Fix-Counter läuft weiter, nach `maxFixAttempts` bricht der Loop sauber ab statt still durchzurutschen.

**Was NICHT geändert wurde**:
- `--allow-empty` bleibt — sinnvoll für legitime "nichts zu schreiben"-Phasen
- ExitCode-Logik ist defensive; bei erfolgreichem Coding-Agent (exit 0) verhält sich der Runner exakt wie vorher

### Notes
- Build grün (12 packages), Bundle erstellt
- Reine defensive Code-Verbesserung; bei korrekter Agent-Config (Login da, Binary erreichbar) unveränderte UX
- Erkennt zukünftige Auth-Probleme (Token-Ablauf, neue Agent-Hinzufügung ohne Login) sofort statt durch leere Commits zu maskieren

## [0.19.0-multi-ha.617] - 2026-05-20

### Fixed — M1+M2 lehnten den KORREKTEN cwd ab wenn ein anderes Projekt mit gleichem basename existiert

**Selbst-entdeckt vor Deploy.** v615 M1 prüfte beim project_agent.start ob ein Projekt mit gleichem basename aber anderem cwd existiert → reject. Aber: wenn der user den KORREKTEN cwd übergibt, existiert auch ein Projekt mit EXAKT diesem cwd (auto-bind passt). Der M1-Code würde trotzdem über alle Projekte iterieren und das andere alpbyte-games (mit basename-Match aber falschem cwd) als Konflikt zurückgeben.

Real-Welt-Beispiel das v616 für diesen User produziert hätte:
- DB: Projekt 3a407ced (cwd=/home/madh/projects/alpbyte-games) ✓ richtiger Workspace
- DB: Projekt ef6f549a (cwd=/home/ubuntu/alpbyte-games) ✗ falscher Workspace
- User: `project_agent.start cwd=/home/madh/projects/alpbyte-games`
- v616 M1: exact match auf 3a407ced → "not a conflict" — aber find() läuft weiter und findet ef6f549a als basename-Konflikt → BLOCK
- Folge: User wird blockiert obwohl er den richtigen cwd übergeben hat = **Regression gegenüber v613**

**Fix**: vor M1+M2-Checks wird einmal `projectRepo.list()` geholt und nach `p.cwd === cwd` durchsucht. Wenn exact match existiert → M1 und M2 werden BEIDE übersprungen (auto-bind nimmt das Projekt sowieso, kein Konflikt-Check sinnvoll).

### Notes
- Build grün
- Reine Logik-Korrektur in `project-agent-skill.ts:startProject()`
- v617 enthält alle v611-v616 Patches plus diese Korrektur
- Verhindert dass v616-Deploy für diesen User in Konstellation `3a407ced + ef6f549a` einen blockierenden Fehler produziert

## [0.19.0-multi-ha.616] - 2026-05-20

### Fixed — UX-Polish: Projekt-Namen + Open-Items-Rate-Limit (NA1+L8)

Zwei Patches die zusammen mit v615 deployt werden sollten, damit die UX nach v615 stimmig ist.

#### NA1 — Semantische Projekt-Namen + Cleanup der Bestandsdaten

**Vorher**: `project-manager.ts findOrCreate()` setzte `name = params.goal.slice(0, 80)`. Das produzierte unleserliche Stümpfe wie "Starte einen NEUEN Projekt-Agent-Lauf für 'Alpbyte Games' unter /root/alpbyte-ga…" und machte die WebUI-Projekt-Liste schwer scanbar. Zwei verschiedene alpbyte-games-Projekte waren so im UI optisch fast identisch.

**Neu**: 
1. `deriveProjectName(cwd, goal, sourceId)` — exportierte Helper-Funktion:
   - Wenn cwd existiert → `basename(cwd)` (z.B. "alpbyte-games", "uboot-cc")
   - Sonst → goal-text mit LLM-Boilerplate-Patterns gestrippt ("Starte einen ...", "Bearbeite das ...", "Erstelle ein ...", "Im Projekt ...", "Bitte ...") + erstem Satz, max 60 Zeichen
   - Fallback → "Session <kurz-id>"
2. `ProjectManager.rebuildLongProjectNames(userId)` — One-shot Cleanup für Bestandsprojekte. Erkennungs-Heuristik: Name beginnt mit Boilerplate-Prefix ODER ist länger als 50 Zeichen + enthält cwd-basename nicht. Idempotent über Memory-Marker `project_names_rebuilt_v616`.
3. Wired in `alfred.ts:585` fire-and-forget beim Startup. Läuft genau einmal pro Installation.

Effekt nach Deploy: bestehende Projekte werden umbenannt, die WebUI-Liste wird kompakt + lesbar. Auto-Generated Slugs bleiben durch `uniqueSlug()` eindeutig auch bei Duplikat-Namen (alpbyte-games + alpbyte-games-2 etc).

#### L8 — Rate-Limit für OpenItemsReflector (max 3 Eskalationen pro Sweep)

**Vorher**: v615 deployen hätte beim ersten hourlySweep alle 11 wartenden high-prio open items auf einmal eskaliert → 11 Telegram-Nachrichten innerhalb Sekunden.

**Neu**: `MAX_ESCALATIONS_PER_SWEEP = 3` Konstante in `open-items-reflector.ts`. Items werden vor der Loop nach `createdAt ASC` sortiert (älteste zuerst), Zähler `sentThisSweep` wird pro erfolgreich gesendeter Eskalation inkrementiert. Sobald 3 erreicht → break mit Info-Log "rate-limit reached, deferring rest to next sweep".

Effekt: 11 wartende Items → 3 Eskalationen pro Stunde → über ~4 Stunden komplett durchgegangen. Älteste-zuerst sorgt für sinnvolle Prio.

### Risiken / Tradeoffs

- **NA1-Cleanup**: bei dem ersten Startup nach v616 werden bestehende Projekt-Namen aktualisiert. Memory-Marker verhindert mehrfache Ausführung. Falls etwas schiefgeht: Cleanup-Action ist additiv (nur UPDATE name, kein DELETE), reversibel über DB.
- **L8 Rate-Limit**: bei wachsendem high-prio-Backlog könnten 3/h nicht ausreichen. Wenn das passiert, leicht in der Konstante hochsetzen (z.B. 5).

### Notes
- Build grün (12 packages)
- Keine DB-Migration nötig
- Memory-Marker `project_names_rebuilt_v616` (type=feedback) wird beim ersten Startup geschrieben — sicheres Indiz dass Cleanup gelaufen ist

## [0.19.0-multi-ha.615] - 2026-05-20

### Fixed — alpbyte-games-cwd-Verwechslung: Project-Agent wählte Deploy-Target als Workspace

Root cause des 2026-05-20 alpbyte-games-Vorfalls: Zwei Project-Agent-Sessions wurden mit `cwd=/home/ubuntu/alpbyte-games` gestartet anstatt mit dem korrekten Dev-Workspace `/home/madh/projects/alpbyte-games`. Ergebnis: 70+18 Dateien Arbeit (OpenAPI + API-Keys + Tests, committed bis a5f9bd2) landeten in einem lokal neu angelegten parallelen Verzeichnis `/home/ubuntu/alpbyte-games` auf der Alfred-Node, der echte Dev-Workspace wurde nicht angefasst, Push schlug fehl wegen state-Konflikt.

Die LLM-Fehl-Inferenz kam aus dem Memory `deploy_alpbyte-games_192_168_1_96` (Value: "Alpbyte Games läuft auf 192.168.1.96 als ubuntu via docker-compose") — der LLM interpretierte den Deploy-Target-Pfad als Workspace, weil **kein Gegen-Memory** existierte das den Dev-Workspace explizit nennt, und der Project-Agent-Skill keine Name-basierten Konflikt-Checks machte.

#### M1 — Project-Name-Konflikt-Check in `project_agent.start`

`packages/skills/src/built-in/code-agent/project-agent-skill.ts` lädt jetzt vor Start die `projects`-Tabelle und prüft per Last-Segment-Match (z.B. `alpbyte-games`) ob ein aktives Projekt mit ANDEREM cwd existiert. Falls ja: explizite Fehlermeldung mit Vorschlag des bestehenden cwd, statt blind einen neuen Workspace anzulegen.

Beispiel-Output bei Konflikt: *"Es gibt bereits ein Projekt 'alpbyte-games' mit cwd /home/madh/projects/alpbyte-games. Du hast cwd /home/ubuntu/alpbyte-games angegeben — meintest du den bestehenden Pfad? Falls ja: action=start nochmal mit cwd=/home/madh/projects/alpbyte-games."*

Wired via `projectAgentSkill.setProjectLookup(this.projectRepo, ownerUserId)` in `alfred.ts:841`.

#### M2 — Workspace-Sanity-Check für `/home/<X>/` wenn X ≠ runAsUser

`project-agent-skill.ts:startProject()` lehnt cwd ab das auf `/home/<X>/` zeigt wo `<X>` nicht der `runAsUser` (typischerweise `madh`) ist. Klassisches Beispiel: `/home/ubuntu/...` ist der Deploy-Target auf einem Remote-Host, nicht der lokale Workspace.

Output: *"cwd '/home/ubuntu/alpbyte-games' verweist auf Home von User 'ubuntu', aber Agent läuft als 'madh'. Wahrscheinlich gemeint: /home/madh/projects/alpbyte-games."*

#### M3 (L6) — Auto-Memory bei Project-Agent-Completion (DAS fehlende Lern-Pendant zu v609 V2)

**Das ist der eigentliche strukturelle Fix.** v609 V2 schrieb bereits Auto-Memory `deploy_<project>_<host>` nach jedem erfolgreichen Deploy. Es gab aber **keine Entsprechung** für Project-Agent-Sessions — das Lernen "User sagt X, ich arbeitete in cwd Y" fand nicht statt.

v615 schreibt jetzt nach JEDEM Project-Agent-Lauf (success ODER failure):

```
project_workspace_<projektname> = "Dev-Workspace für Projekt '<projektname>': /home/madh/projects/<projektname> 
                                   (lokal auf Alfred-Node), last_run=YYYY-MM-DD HH:MM, phases=N, 
                                   files_changed=N, build_passed=yes/no, last_commit=<sha8>, 
                                   HINWEIS: Das ist der LOKALE Workspace zum Entwickeln, 
                                   NICHT der Deploy-Target-Pfad"
```

Category `workspace`, source `auto`, type `fact`. Wird vom Reasoning-Context-Collector via semantic-memory-search aufgenommen (Priority 1, 1200 token budget).

Damit beim nächsten "weiter am alpbyte-games" das LLM zwei Memories sieht:
- `deploy_alpbyte-games_192_168_1_96` → wo es deployed wird
- `project_workspace_alpbyte-games` → wo es entwickelt wird

#### M4 — Skill-Description erweitert

Die Skill-Description nennt jetzt explizit:
- "cwd = LOKALER Entwicklungs-Pfad auf der Alfred-Node, NICHT Deploy-Target-Pfad auf einem Remote-Host"
- "Wenn die Deploy-Memory sagt 'läuft auf 192.168.1.96 als ubuntu' ist das der Deploy-Target, NICHT der Workspace"
- "Für Continue-Sessions: gleichen cwd wie der letzte erfolgreiche Lauf benutzen (siehe project_workspace_<projektname> Memory)"

Das LLM bekommt die Disambiguierung jetzt direkt im Tool-Schema.

#### M5 — Bewusst deferred

Push-Token-Inject für `sudo -u madh git push` in non-interactive-Kontext. v601 hat einen Mechanismus, der greift hier nicht in dem `/home/ubuntu/...` Workspace. Der Push-Bug ist real, aber sekundär — wenn M1+M2 verhindern dass der Agent überhaupt im falschen cwd landet, kommt es zu dem Push-Fehler nicht mehr.

### Notes
- Build grün (12 packages), Bundle erstellt
- M3 schließt die letzte offene Lern-Loop-Lücke ("User-Aufträge → Workspace-Memory")
- Memory `project_workspace_*` wird auch bei `success=false` geschrieben — wichtig für Retry-Cases
- Existing memories bleiben unverändert; das neue Schema kommt zu deploy_* hinzu, ersetzt nichts

## [0.19.0-multi-ha.614] - 2026-05-20

### Added — Lern-Loop schließen (L1, L2, L3, L5; L4 bewusst deferred)

Adressiert die User-Beschwerde "Alfred lernt aus Aktionen nicht — Open Items liegen 5h+ unbeachtet, Runbooks haben usage_count=0, auto_extracted workflows=0". Audit der DB hat gezeigt: Capture funktioniert (Activity-Log, Memories, Runbooks, Skill-Host-Failures, Host-Capabilities, KG, Project-Auto-Binding), aber die Wiederverwendung schließt nicht.

#### L1 + L5 — OpenItemsReflector (`packages/core/src/reflection/open-items-reflector.ts`)

Neue Klasse mit zwei Methoden, gewired in `reflection-engine.ts:tick()`:
- `hourlySweep()`: Für jedes `project_open_items` mit `status='open' AND priority='high' AND age > 4h` wird einmalig eine Telegram-Nachricht "🔴 High-Priority Open Item — Nh offen ... Soll ich mich darum kümmern?" gesendet. Dedup via Memory-Marker `open_item_escalated:<itemId>` (analog zum bestehenden `insight_delivered:*`-Pattern).
- `dailyDigest()` um 09:00 LOCAL: Zusammenfassung aller offenen Items gruppiert nach Projekt mit Prioritäten-Icons. Dedup via Tages-Memory-Marker `open_items_digest_sent:<YYYY-MM-DD>`.

Voraussetzung: `projectRepo` und `ownerUserId` müssen in `ReflectorDeps` gesetzt sein — beide werden jetzt von `alfred.ts:4245` ans `ReflectionEngine` übergeben. Wenn Projects-Feature deaktiviert ist, läuft der Reflector schlicht nicht (kein Error).

Eskalations-Window: 4h ≤ age ≤ 7d. Älter als eine Woche wird nicht mehr eskaliert (User hat es ja gesehen und liegen gelassen — nicht weiter nerven).

#### L2 — Runbook-Auto-Promotion (`reasoning-context-collector.ts`)

Im PHASE-2c-Block, wo `runbookRepo.findMatching()` Runbooks für den aktuellen Kontext findet: jedes gefundene Runbook ruft `incrementUsage()` auf. Bei `status='draft' AND usage_count+1 >= 3` wird automatisch auf `status='verified'` promoted. Das Match-Statement zählt jetzt also als reale Nutzung, weil das Reasoning-LLM die Runbook-Liste im Prompt sieht.

Vorher: alle 8 Runbooks `usage_count=0` permanent. Jetzt: jedes Surface inkrementiert, 3× gesehen ⇒ verifiziert. Die "verified"-Liste wird mit der Zeit zu einer kuratierten Wissensbasis ohne manuellen Eingriff.

#### L3 — WorkflowExtractor auch für code_agent (`alfred.ts:701-738`)

Der WorkflowExtractor war seit v602 P2 nur für `delegate`-Skill-Sessions verdrahtet. Code-Agent-Sessions wurden komplett ausgespart, obwohl diese typischerweise länger und strukturierter sind als Delegate-Runs. Erklärt warum `workflow_chains WHERE auto_extracted=1` ⇒ 0 Treffer in Produktion.

Fix: Mirror der Delegate-Logik im `code_agent`-Completion-Callback. Aufruft `proposeWorkflowFromSession()` bei `info.success && info.toolCalls > 0`. Die Pre-Filter des Extractors (≥2 distinkte Skills ODER ≥4 Calls) verhindern weiterhin triviale Reuse-Vorschläge.

Caveat: `emitCompletion` reicht nur `toolCalls` als Zähler durch, keine vollen Inputs pro Call. Vorerst wird ein synthetischer "code_agent: task=… cwd=…" Pseudo-Call gebaut. Echte Per-Call-Inputs erfordern eine separate Erweiterung von `SessionCompletionInfo` — als Future-Work markiert.

#### L4 — Bewusst verschoben

Insight→Action Mapping wurde geplant aber nicht implementiert. Begründung:

Der Mechanismus ist KOMPLETT vorhanden: `reasoning-engine.ts:35 ACTION_MARKER`, `:1068-1101` Parser, `:402 processActions()`. Die Reasoning-Engine kann ACTIONS-Blöcke konsumieren und Confirmation-Queue-Einträge enqueuen.

Was fehlt: das Reasoning-LLM emittiert in der Praxis fast nie ACTIONS-Blöcke (Production-Logs: `actions:0` konsistent). Das ist kein Code-Bug, sondern Prompt-Engineering — und Prompt-Engineering braucht **iteratives Testen über mehrere Reasoning-Pässe** mit verschiedenen Triggern, nicht einen Einmal-Patch. Wird in einer eigenen v615 (oder als laufender Tuning-Aufwand) angegangen.

#### Wiring-Änderungen

- `ReflectorDeps`: zwei neue optionale Felder `projectRepo`, `runbookRepo`, plus `ownerUserId` für owner-scoped Reflektoren
- `alfred.ts:4245` (ReflectionEngine-Init): übergibt diese drei jetzt explizit
- `ReflectionEngine.tick()`: ruft `openItemsReflector.hourlySweep()` einmal pro Stunde, plus `dailyDigest()` wenn `getHours() === 9`

### Notes
- Build grün (12 packages), Bundle erstellt
- Open-Items-Reflector ist owner-scoped: in einer Multi-User-Konfiguration meldet sich Alfred nur an den `security.ownerUserId`, nicht an alle Plattform-Nutzer
- Memory-Marker-Pattern (statt eigener Tabelle) wurde gewählt um Migrations-Aufwand zu sparen
- L2-Promotion-Schwelle (3) ist hardcoded — wenn sich rausstellt dass das zu wenig/zu viel ist, leicht in Config heben
- Workflow-Extraction-Quality bleibt vom Pre-Filter des Extractors abhängig; bessere Per-Call-Input-Erfassung wäre nächster Schritt

## [0.19.0-multi-ha.613] - 2026-05-20

### Fixed — findActiveByCwd ignorierte 'failed' als terminal

**Root Cause**: `ProjectAgentSessionRepository.findActiveByCwd()` filterte mit `current_phase != 'done'`, schloss aber `'failed'` NICHT aus. Eine project-agent-Session die crashte und manuell auf 'failed' gesetzt wurde, blockierte trotzdem weiterhin neue Starts für denselben cwd — der Block-Check im Skill rief `findActiveByCwd` auf, bekam die failed-Session zurück und lehnte mit "läuft bereits" ab.

Inkonsistent zu zwei Geschwister-Funktionen im selben Repository:
- `listRunning()`: filtert `NOT IN ('done', 'failed')` ✓
- `getHistoryByCwd()`: filtert `IN ('done', 'failed')` als terminal ✓
- `findActiveByCwd()`: filterte nur `!= 'done'` ✗ (Bug)

**Fix**: `findActiveByCwd` benutzt jetzt `NOT IN ('done', 'failed')` — konsistent mit dem Rest.

### Notes
- Build grün
- Aufgetaucht beim Versuch nach dem v611-Midnight-Crash einen neuen Project-Agent für alpbyte-games zu starten, nachdem die orphan-Session manuell auf 'failed' gesetzt wurde

## [0.19.0-multi-ha.612] - 2026-05-20

### Fixed — Log-Viewer WebUI sieht pino-roll v4 Files nicht (Hotfix v611)

Nach dem v611-Upgrade auf pino-roll@4 sahen die WebUI-Logs keine aktuellen Einträge mehr.

**Root Cause**: `packages/core/src/alfred.ts:3802-3822` `listLogFiles()` matchte File-Namen nur gegen das alte v2-Schema `<base>.<date>.<num>` (z.B. `alfred.log.2026-05-19.1`). pino-roll v4 schreibt aber `<stem>.<date>.<num>.<ext>` (z.B. `alfred.2026-05-20.1.log` mit Extension am Ende). Der Pattern `entry.startsWith("alfred.log.")` matcht `"alfred.2026..."` nicht → WebUI fand die neuen Dateien gar nicht.

**Fix**: `listLogFiles()` matcht jetzt BEIDE Naming-Schemen:
- Old (v2): `<base>` oder `<base>.<anything>` 
- New (v4): `<stem>.<anything><ext>`

Kompatibel mit gemischten Verzeichnissen die noch v2- und schon v4-Dateien enthalten.

### Notes
- Build grün, Bundle erstellt
- Reine Logik-Korrektur, keine Schema-/Migrations-Änderungen
- Audit-Log-Viewer profitiert automatisch (gleiche Funktion)

## [0.19.0-multi-ha.611] - 2026-05-20

### Fixed — Midnight-Crash auf beiden Cluster-Nodes (pino-roll v2 → v4) + Agent-Auswahl im Project-Agent

Behebt einen reproduzierbaren Cluster-weiten Crash und macht das vom Project-Agent verwendete Coding-Tool endlich vom User/LLM auswählbar.

#### Root Cause: pino-roll Version-Mismatch (Cluster-Crash bei 2026-05-20T00:00 UTC)

Am 2026-05-20 um 00:00:00 UTC sind beide Alfred-Cluster-Nodes (.92 + .93) gleichzeitig ausgefallen. Die Telegram-Notification, die WebUI und der laufende Project-Agent (139874aa, alpbyte-games HTTPS/Cookie-Banner-Erweiterung, Phase 12/15) brachen ab.

Die direkte Source-Diff-Analyse zwischen den beiden installierten pino-roll-Versionen ergab:

- `packages/cli/package.json` deklarierte `"pino-roll": "^2.0.1"` → installiert wurde **v2.2.0**
- `packages/logger/package.json` deklarierte `"pino-roll": "^4.0.0"` → erwartete v4-API
- Die CLI als Entry-Point gewinnt im Bundle → v2.2.0 wurde tatsächlich geladen
- v2.2.0 ruft im `roll()`-Callback `createSymlink()` **async ohne await/catch** auf und hat **kein try/catch** um `destination.reopen()`
- v4.0.0 ersetzt das durch sync `createSymlinkSync` + umschließendes try/catch + `isClosing`-Race-Guard + Error-Emit über `destination.emit('error', ...)`

Bei der täglichen Rotation um Mitternacht UTC warf v2.2.0 eine Exception, die ungefangen den Worker-Thread crashte → Main-Thread bekam uncaughtException → graceful shutdown auf beiden Nodes. Diagnostik scheiterte zusätzlich daran, dass der CLI-Handler `logger.fatal({ error: err }, ...)` benutzte; pino's `stdSerializers.err` greift nur beim Schlüssel `err`, daher serialisierte der Error als `{}` ohne Stack-Trace.

**Fix:**
- `packages/cli/package.json` von `"pino-roll": "^2.0.1"` auf `"^4.0.0"` gehoben — konsistent zur logger-Package-Erwartung
- `packages/logger/src/logger.ts` registriert explizit `serializers: { err, error: stdSerializers.err }` damit künftige uncaughtExceptions/unhandledRejections mit Stack-Trace geloggt werden
- `packages/cli/src/commands/start.ts` + `apps/alfred/src/graceful-shutdown.ts`: `logger.fatal({ error }, ...)` → `logger.fatal({ err }, ...)` (oder `{ err: reason }`), nutzt pino's std-err-Serializer
- pnpm-lock.yaml verifiziert: ausschließlich pino-roll@4.0.0, keine v2-Referenzen mehr

#### Agent-Auswahl im Project-Agent (v611-light, H1)

Beobachtung: Es waren `claude-code`, `codex` und `mistral-vibe` in der `default.yml` konfiguriert. Der Project-Agent verwendete aber immer claude-code, weil:
- `project-agent-skill.ts:160` wählte bei fehlendem `agent`-Parameter `[...this.agents.keys()][0]` (erster in der Map)
- Das Input-Schema hatte kein `enum` der erlaubten Agent-Namen — das LLM wusste nicht welche überhaupt verfügbar sind
- Die `description` erwähnte nur `claude-code` und `codex` als Beispiel, `mistral-vibe` war komplett unsichtbar

**Fix in `packages/skills/src/built-in/code-agent/project-agent-skill.ts`:**
- `metadata` wird jetzt im Konstruktor gebaut (nicht mehr als statischer Property-Initializer)
- `inputSchema.properties.agent.enum` wird aus `this.agents.keys()` befüllt
- `description` listet alle verfügbaren Agents auf und benennt den Default explizit
- Die übergeordnete Skill-`description` enthält ebenfalls die Liste

Damit kann das LLM (oder du explizit per Telegram "starte project_agent für X mit agent=codex") jeden konfigurierten Agent wählen. Schema-Validation lehnt Typos früh ab statt sie deep im Runner als "Unknown agent" zu produzieren.

#### Bewusst NICHT in v611

- Auto-Selection per Phase durch das Planning-LLM (was als "H3" diskutiert wurde). Begründung: die Agents sind General-Purpose-Coding-Tools, es gibt keine objektive Faktenbasis ("vibe ist gut für CSS, codex für Algorithmen" wäre erfunden). Ehrliche Auto-Selection bräuchte gemessene Erfolgsraten über viele Runs — Cold-Start-Problem. Wird wieder aufgegriffen wenn ausreichend Datenbasis existiert.
- systemd unit mit `Restart=on-failure` als zusätzliches Sicherheitsnetz. Mit dem v4-Fix sollte das nicht mehr nötig sein, aber wenn der Crash erneut auftritt wäre das die nächste Eskalationsstufe.

### Notes
- Build grün (12 packages), Bundle erstellt
- Skills-Tests 188 passed
- pnpm-lock.yaml: pino-roll@4.0.0 zwei Referenzen, pino-roll@2 null Referenzen
- Project-Agent-Session 139874aa bleibt nach Restart als "running" mit current_phase=coding stehen — recoverInterrupted ignoriert sie (kein agentState/persistent-task), muss bei Bedarf manuell neu gestartet werden

## [0.19.0-multi-ha.610] - 2026-05-19

### Fixed + Added — Recovery-UX + Activity-Log + Auto-Deploy-Vorschlag

Schließt drei Beobachtungen aus dem alpbyte-games-Workflow nach v609-Deploy: (1) der Recovery-Mechanismus produziert ein alarmistisches "Hintergrund-Task abgebrochen" auch bei kurzen Single-Shot-Tasks die noch keinen Checkpoint hatten; (2) das activity_log.details Feld war seit jeher NULL, womit v608 F8 (Deploy-History Context) faktisch wirkungslos war; (3) nach erfolgreicher Project-Agent-Session wurde nur ein Runbook-Vorschlag enqueued, kein Deploy-Vorschlag.

#### G1+G2 — Recovery-Telegram-Spam reduzieren (`persistent-agent-runner.ts`)
- `recoverInterrupted()`: Tasks die <60s vor dem Neustart liefen werden jetzt **still** als failed markiert (kein Telegram). Diese sind meist Single-Shot-Skills (shell, deploy) die schlicht nie ihren ersten Checkpoint erreichten — eine "wir haben deine Arbeit verloren"-Meldung ist hier Noise.
- Für längere Tasks: Formulierung umgeschrieben von "❌ Hintergrund-Task abgebrochen (Prozess-Neustart ohne Checkpoint)" zu "⚠️ Hintergrund-Task <desc> wurde durch Neustart unterbrochen. Falls noch nötig, bitte erneut anstossen." — informativ statt alarmistisch.

#### G5 — Auto-Deploy-Vorschlag nach Project-Agent (`alfred.ts` setCompletionCallback)
- Wenn ein Project-Agent erfolgreich endet (`success=true`) UND eine Memory `deploy_<project>_*` für denselben Projektnamen existiert (geschrieben von v609 V2): enqueue eines zweiten Confirmation-Eintrags `"Project Agent fertig — auch nach <host>:<port> (user <user>, pm <pm>) deployen wie letztes Mal?"` mit `skillName: deploy` und vorgefüllten Parametern.
- Parsing aus dem strukturierten Memory-Value (`Deployed X → HOST (user=..., port=..., pm=...)`). Hose-Belt-Suspenders: Memory-Filter auf `category=deployment` zusätzlich zum Key-Prefix.
- Timeout 60 min, dedup-source-id `auto-deploy-from-project-<sessionId8>` verhindert Doppel-Enqueue beim selben Run.
- Der Runbook-Vorschlag bleibt unverändert; nur die Frühausstiegslogik wurde umgebaut sodass G5 unabhängig vom Milestone-Count laufen kann (Runbook bleibt ≥3-Milestones-gated, Deploy braucht nur grünen Build).

#### G7 — `activity_log.details` befüllen (`message-pipeline.ts`)
- Bug aus v608: An den drei Aufrufstellen von `logSkillExec()` (success/error/denied) wurden weder Skill-Input noch Host/Project an die Activity-Log-Tabelle weitergereicht. Konsequenz: das `details`-Feld war seit jeher NULL, womit:
  - v608 F8 "Letzte Deploys" Reasoning-Context-Source NIE Treffer produzierte (sie sucht `details.host`/`details.project`)
  - SkillFailureReflector (v607 D3) Workaround-Patterns nur über `errorMessage` matchen konnte
- Fix: neue Helper-Funktion `redactInputSecrets()` strippt Keys aus der `SECRET_KEY_NAMES`-Liste (password, secret, token, apiKey, accessToken, refreshToken, clientSecret, private_key u.a.) und reicht den Rest als `details` durch.
- Konsequenz: Ab v610 hat F8 endlich echte Daten zum Anzeigen.

### Notes
- Build grün (12 packages), Bundle erstellt
- Vorbestehende `watch-engine.test.ts`/`reasoning-engine.test.ts` Failures unverändert (nicht von v610 verursacht)
- G5 setzt voraus dass v609 V2 schon mal einen Deploy für das Projekt geschrieben hat — beim ersten Deploy gibt's noch keinen Auto-Vorschlag (per Design)

## [0.19.0-multi-ha.609] - 2026-05-19

### Added — Project-Agent-Sessions UI + Auto-Memory on Deploy

Schließt die zwei in v608 explizit ausgesparten Themen ab: (1) eine UI um nachzusehen was der Project-Agent historisch gebaut hat, und (2) ein zweiter Lern-Pfad zusätzlich zu F8 (activity-log-basiert) bei dem jeder erfolgreiche Deploy als Fact-Memory persistiert wird.

#### Project-Agent-Sessions UI (V1)
- Neue Sidebar-Section: `🤖 Project Agents` (zwischen Runbooks und Projects)
- Neue Page: `/project-agents` mit Tabelle aller Sessions (`ProjectAgentSessionRepository.listAll`)
- Filter: Phase-Dropdown (planning/coding/building/fixing/done/failed) + Volltext-Suche über goal/cwd/taskId
- Detail-Panel zeigt: Task ID, Ziel, Phase-Badge, Build-Status, Iteration, Files-Changed, cwd, Agent, Last-Commit-SHA, Milestones (letzte N), Created/Updated
- Auto-Refresh alle 10s solange mindestens eine non-terminale Session sichtbar ist
- Button "Session stoppen" für laufende Sessions (sendet `__STOP__` Interjection an Runner)
- 3 neue HTTP-Endpoints (`GET /api/project-agents`, `GET /api/project-agents/:id`, `POST /api/project-agents/:id/stop`)
- 3 neue Client-Methoden in `alfred-client.ts` (`fetchProjectAgents`, `fetchProjectAgent`, `stopProjectAgent`)
- Callback-Wiring in `alfred.ts` parallel zur bestehenden Runbook/Projects-API

#### Auto-Memory on Deploy Success (V2)
- `deploy.ts doDeploy()` schreibt nach erfolgreichem Deploy einen Memory-Eintrag (`source='auto', type='fact', category='deployment', confidence=0.95`)
- Key-Schema: `deploy_<project>_<host-sanitized>` → idempotent (überschreibt vorherigen Eintrag für dasselbe project+host)
- Value enthält: project, host, user, runtime, process_manager, ggf. compose-Variant, port, verified-Flag, Datum (YYYY-MM-DD)
- Wired via `DeploySkill.setMemoryRepo(memoryRepo, ownerMasterUserId)` in `alfred.ts` Skill-Registration
- Wirkt komplementär zu v608 F8: F8 zieht aus activity_log (transient), v609 schreibt persistente semantische Memories die der KG-Linker erfasst und das Memory-Section (Priority 1, 1200 token budget) im Reasoning-Context auftauchen können

### Notes
- Build grün (12 packages), neue `/project-agents` Route 2.4 kB
- Memory-Save ist best-effort: Deploys schlagen NIE wegen Memory-Fehler fehl
- composeVariant wird in der Auto-Memory mit aufgenommen (zusätzliche Sichtbarkeit neben v608 host_capabilities Tabelle)

## [0.19.0-multi-ha.608] - 2026-05-19

### Fixed + Added — Code-Agent-Crash-Fixes + Persistente Lehre (F1-F8 Voll-Variante)

Adressiert zwei verzahnte Probleme aus dem 19:51-Vorfall: (a) der `code_agent` Skill scheiterte zweimal hintereinander mit unterschiedlichen Bugs (orchestrate-API-Error, run-idle-Timeout), wodurch eine User-Bestätigung "(no response)" produzierte; (b) Alfred zog keine Lehren aus erfolgreichen Deploys, weil mehrere "Lern-Pipelines" gebrochen oder unverdrahtet waren.

#### F1 — `temperature` aus `code_agent orchestrate` LLM-Calls entfernt
- `packages/skills/src/built-in/code-agent/orchestrator.ts:170`, `:264` — Planning + Validation LLM-complete-Calls hatten hartcodiertes `temperature: 0.2`
- Anthropic API (Opus 4.7) wirft 400-Fehler `\`temperature\` is deprecated for this model` → Orchestrate komplett unbenutzbar
- Beide Stellen aufgeräumt; `tier: 'strong'` reicht

#### F2 — Anthropic-Provider `supportsTemperature()` Filter
- `packages/llm/src/providers/anthropic.ts` — neue Helper-Methode prüft Model-Name
- Bei `opus-4-7*` wird `temperature` nicht mehr im Request mitgeschickt (analog zu OpenAI's `safeTemperature()` für o-series-Reasoning-Modelle)
- Verhindert Wiederholung des Bugs in allen anderen LLM-Pfaden die `temperature` durchreichen

#### F3 — SkillFailureReflector `eventType`-Bug behoben (RUNBOOK-LEHRE WAR TOT!)
- `packages/core/src/reflection/skill-failure-reflector.ts:76` — query suchte nach `eventType: 'skill_call'`
- ActivityLogger schreibt aber `eventType: 'skill_exec'` (activity-logger.ts:25) → **Reflector fand seit v607 NIE etwas**
- Bedeutet: die in v607 aufgebaute "Lerne aus Skill-Workarounds → erzeuge Runbook"-Pipeline war seit Release tot
- Fix: einzeiliger String-Tausch. Test entsprechend angepasst. 6/6 Tests grün

#### F4 — Code-Agent Subprocess `activity-ping` an SkillSandbox-Watchdog
- `packages/skills/src/built-in/code-agent/agent-executor.ts` — neuer `onActivity` Callback in `executeAgent()` Options
- Wird bei jedem stdout/stderr-Chunk gefeuert → ruft `tracker.ping('processing')`
- `packages/skills/src/skill-sandbox.ts` — injectet jetzt den Tracker in den `SkillContext` (`context.tracker`)
- `code-agent-skill.ts runAgent()` + Orchestrator: ziehen Tracker aus Context und reichen `onActivity` durch
- Verhindert das Phänomen, dass claude-code subprocess mit korrektem Output gekillt wird, weil der Sandbox-Watchdog 600s lang keinen ping bekam und auf "idle" geschlossen hat

#### F5 — `code_agent` Preflight-Check (`which <binary>`)
- Vor `spawn()` wird via `spawnSync('which', [command])` geprüft ob die Agent-Binary existiert
- Bei `sudo -u <user> <real-command>` wird die `real-command` Binary geprüft, nicht `sudo`
- Bei Fehlen: sofortige klare Fehlermeldung `"Agent binary 'claude' nicht im PATH"` statt 10min Idle-Hang
- Best-effort: wenn `which` selbst nicht verfügbar, blockt der Preflight nicht

#### F6 — Persistente `host_capabilities`-Tabelle (composeVariant überlebt Restarts)
- Neue Migration v66 (SQLite) + v69 (PG): Tabelle `host_capabilities(host, user_name, key, value, probed_at)` mit PK (host, user, key)
- Neue `HostCapabilitiesRepository` mit `get(host,user,key)` + `set(host,user,key,value)`
- `deploy.ts detectComposeVariant()`: konsultiert vor Probe den persistenten Store, persistiert das Probe-Ergebnis
- Verbindung via `setHostCapabilitiesRepo()` in `alfred.ts` nach Skill-Registration
- Effekt: Wenn Alfred auf Host X einmal `docker compose v2` festgestellt hat, weiß er das auch nach Node-Restart und Cluster-Failover

#### F7 — Project-Agent: bessere Vorgeschichte beim Retry
- Neue `ProjectAgentSessionRepository.getHistoryByCwd()` liefert bis zu 5 abgeschlossene/gescheiterte Sessions mit Phase, `lastBuildPassed`, `lastCommitSha`, jüngsten Milestones
- `project-agent-skill.ts startProject()`: ersetzt den knappen `previousAttemptHint` durch eine strukturierte Übersicht (Build-Status, Commit-SHA, letzte Milestones pro Vorgänger-Session)
- Hilft sowohl dem Reasoning-LLM ("die letzte Session ist auf einem grünen Build stehengeblieben") als auch dem Planning-LLM in `createProjectPlan()`

#### F8 — Deploy-History als Reasoning-Context-Source
- `reasoning-context-collector.ts`: neue Section "Letzte Deploys" (Priority 2)
- Query: `activity_log` letzte 14 Tage, `action='deploy', outcome='success'`, gruppiert per (host, project), neueste pro Paar
- `ActivityQuery` erweitert um `action`-Filter (`types/activity.ts` + repository-query)
- Bis zu 5 Einträge mit Host, Projekt, Alter, runtime/process_manager — damit der LLM beim Wunsch "deploy alpbyte-games erneut" weiß "letztes Mal nach 192.168.1.96 als ubuntu mit docker-compose"
- Vorher: Diese Information lag zwar im activity_log, wurde aber NIE in einen Prompt gezogen

### Notes
- Build grün (12 packages), Bundle erstellt
- `skill-failure-reflector.test.ts` 6/6 grün — bestätigt dass F3 nicht regrediert
- Vorbestehende `watch-engine.test.ts`/`reasoning-engine.test.ts` Failures sind unverändert (nicht durch v608 verursacht)
- Migration v66 (SQLite) / v69 (PG) wird beim ersten Start einmalig ausgeführt
- Code-Agent UI für Project-Agent-Sessions noch nicht enthalten — geplant als v609

## [0.19.0-multi-ha.607] - 2026-05-19

### Added — Deploy-Skill Variant-Detection + Skill-Failure-Lehre (D1-D7 Voll-Variante)

Adressiert die in der 18:39-Analyse identifizierten 7 Wurzel-Probleme nach dem alpbyte-games Deploy-Fail. Behebt den konkreten docker-compose-Bug UND etabliert den fehlenden "Lehre"-Mechanismus für Skill-Failures.

#### D1 — Docker-Compose-Variant-Detection (`deploy.ts`)
- Neue Methode `detectComposeVariant(host, user)`: probiert via SSH `command -v docker-compose` (v1 binary) → fallback `docker compose version` (v2 plugin)
- Ergebnis pro `user@host` gecached für die Session
- `composeCmd()` baut den dynamischen Command-Prefix
- Bei beidem fehlend: klare Fehlermeldung mit Install-Hint statt "command not found"

#### D2 — Detection in allen Deploy-Pfaden
- `deploy` (start), `status`, `logs`, `start/stop/restart` — alle nutzen jetzt `composeCmd()`
- Eliminiert das Phänomen "Deploy-Skill zickt auf v2-only Hosts"

#### D3 — Skill-Failure-Reflector (`packages/core/src/reflection/skill-failure-reflector.ts`)
- Neues Modul scannt activity_log nach Pattern: "Skill X scheitert ≥2× konsekutiv mit gleichem error_class → shell/code_agent/deploy-Workaround → success"
- Klassifiziert Error in COMMAND_NOT_FOUND, EACCES, ENOENT, ETIMEDOUT, NETWORK, AUTH_FAIL, NOT_FOUND, OTHER
- Extrahiert Scope (host/cwd) aus failed-skill-input
- Liefert pro Pattern: workaroundSteps, finalSuccess, participatingActivityIds
- 6 Vitests grün (alpbyte-Repro, single-fail-skip, no-workaround-skip, failed-workaround-skip, cwd-scope-extraction)

#### D3 Wiring (`alfred.ts`)
- 15-Minuten Sweep-Interval ruft `failureReflector.detect(ownerUid)` 
- Pro Pattern: Confirmation-Queue-Eintrag "Runbook aus Skill-Failure-Workaround erstellen: ..." mit den Workaround-Schritten als runbook-steps
- DedupSourceId verhindert Spam wenn dasselbe Pattern wiederholt erkannt wird

#### D4 — Parallele Workflow-Vorschläge (`alfred.ts`)
- Wenn Pattern ≥2 shell-Steps UND scope=host enthält: zusätzliche Confirmation "Workflow X aus Workaround speichern?"
- WorkflowSteps werden als WorkflowActionStep (shell-skill calls) gebildet
- `auto_extracted=true` Flag für Tracking

#### D5 — Goal-Sanitization (`project-agent-skill.ts`)
- Neue exportierte Funktion `stripGoalPrefix(goal)`: entfernt LLM-Boilerplate-Prefixe wie "Starte einen NEUEN Projekt-Agent-Lauf für", "Bitte starte", "Erstelle ein neues Projekt für"
- Layered-stripping (iter bis stable)
- Quote-Stripping um Projekt-Namen
- 9 Vitests grün
- Beseitigt das v605-Goal-Pollution-Phänomen (sah als Project-Name "Starte einen NEUEN..." in DB)

#### D6 — LLM-generated Runbook-Title (`alfred.ts` Trigger-B)
- Statt `goal.slice(0, 100)`: fast-Tier-LLM-Call "Fasse das Projekt-Ziel in einem prägnanten Titel zusammen (max 60 Zeichen)"
- Fallback auf raw-slice bei LLM-Fehler
- Resultat: lesbare Titel statt zerschnittene goal-Texte

#### D7 — Host-spezifische Skill-Pattern-Memory
- Migration v65 SQLite / v68 PG: neue Tabelle `skill_host_failures` (skill_name, host, error_class, count, first_seen, last_seen, error_message)
- `SkillHealthRepository.recordHostFailure()`, `getHostFailures()`, `listRecentHostFailures()` neu
- `SkillHealthTracker.recordHostFailure()` API
- `MessagePipeline`: bei jedem skill-failure mit `host` oder `target_host` im input → automatisch `recordHostFailure` mit klassifiziertem error_class
- `PromptBuilder` rendert Section "## Known skill-failure patterns" wenn `recentHostFailures` provided → LLM sieht "deploy @ 192.168.1.96 → COMMAND_NOT_FOUND (2× seen)" und routet around
- `MessagePipeline.setSkillHealthRepo()` neu für direct repo access

### Wie D1-D7 zusammenwirken (Defense-in-Depth gegen den nächsten "Wand-Hit")
1. **Vorbeugung**: D1+D2 verhindern den konkreten docker-compose-Wand-Hit
2. **Verhinderung Wiederholung**: D7 warnt LLM beim nächsten Aufruf wenn (skill, host) bereits gescheitert
3. **Lehre festhalten**: D3 erkennt successful workarounds und schlägt Runbook vor
4. **Lehre wiederverwendbar**: D4 promotet zu Workflow wenn parametrisierbar
5. **Saubere Doku**: D5 + D6 sorgen für lesbare Project-Namen und Runbook-Titel statt LLM-Boilerplate

### Tests
- 9 Vitests `stripGoalPrefix`
- 6 Vitests `SkillFailureReflector` (alpbyte-Repro inkl.)
- Bestehende Tests stabil

### Backward-Compatibility
- alle Setter optional → setups ohne `setSkillHealthRepo` zeigen keine Section
- Migration v65/v68 nur additiv (neue Tabelle, keine Schema-Änderung an existing tables)
- Deploy-Skill funktioniert auf Hosts MIT Legacy docker-compose v1 unverändert (Detection erkennt v1 first)

## [0.19.0-multi-ha.606] - 2026-05-19

### Added — Memory-Hygiene: Correction-Klassifikation + Deduplication (K1-K6 Voll-Variante)

Adressiert die in der Analyse vom 19.05. (Batterie-Memory falsch als correction) identifizierten 6 Wurzel-Probleme. Vorher landete jede Nachricht mit "in Zukunft" oder "nur wenn" pauschal als correction-memory mit 90% Konfidenz — auch Fragen, Doku und Runbooks.

#### K1 — Pattern-Match enger (`correction-signal-scanner.ts`)
- Sentence-Start-Anker `(?:^|[\n.!?]\s*)` für Pattern wie "in zukunft", "ab jetzt", "nur wenn", "schwellenwert ändern"
- Verhindert Match in deskriptiven Texten ("Wir hatten überlegt das in zukunft anders zu lösen")
- Direkte Korrekturen ("nein das ist falsch", "ich meinte") bleiben unverändert (kein Anker, immer Trigger)
- 16 Vitests grün (echte Korrekturen + False-Positive-Beispiele aus Live-DB)

#### K2 — LLM-Validierung nach Pattern-Match (`feedback-service.ts`)
- Nach `scanCorrectionSignal: high` läuft `classifyMessage()` mit fast-Tier-LLM
- Strict-JSON-Output: `intent: 'correction' | 'preference' | 'rule' | 'skip'`
- Bei `intent === 'skip'` → memory wird NICHT gespeichert
- LLM-Call ~50 Tokens, sub-Cent. Bei LLM-Fehler: konservativer Fallback auf `correction`

#### K3 — Type-Routing (`feedback-service.ts`)
- LLM-Klassifikation routet zum richtigen Memory-Type:
  - `correction` → type='correction', confidence 0.9 (echte Falsch-Aktion-Korrektur)
  - `preference` → type='preference', confidence 0.85 (Verhaltensregel für Zukunft)
  - `rule` → type='general', confidence 0.85 (Runbook/prozedurale Anweisung)
  - `skip` → kein Save
- Vorher: alles als `correction` 0.9 hardcoded

#### K4 — Embedding-basierte Deduplication (`feedback-service.ts`, `memory-repository.ts`)
- Vor Save: `tryDeduplicate()` holt bestehende memories desselben Types
- Berechnet Cosine-Similarity zwischen neuer und bestehenden values via `llm.embed()`
- Bei similarity > 0.85: `memoryRepo.touch()` aktualisiert nur `updated_at`, keine neue Row
- `MemoryRepository.touch(userId, key)` neue Methode
- Verhindert dass derselbe Inhalt (z.B. das Batterie-Runbook) bei wiederholter Eingabe N-mal als Row in DB landet

#### K5 — Migration alter Einträge (`feedback-service.migrateCorrectionMemories()`)
- One-shot Maintenance bei Alfred-Start (30s delay)
- Liest alle memories mit key-prefix `feedback:correction:` (sowohl type='correction' als auch type='feedback')
- Reklassifiziert jeden via `classifyMessage()` → updated type oder löscht bei `intent='skip'`
- Marker-Memory `_internal_correction_migration_done` verhindert Wiederholung
- Stats werden gelogged: reclassified, deleted, unchanged, skipped

#### K6 — WebUI Type-Editor (`MemoriesPage.tsx`, alfred-client, HttpAdapter)
- Memory-Type-Badge wird zum `<select>` Dropdown auf der Memories-Page
- Direkte Type-Änderung per Klick: 'correction', 'preference', 'fact', 'entity', 'general', 'pattern'
- Neue API-Route: `PATCH /api/memories/:id` mit `{ type }` body
- `MemoryRepository.updateType(memoryId, type)` neue Methode
- `HttpAdapter.setMemoryCallbacks()` erweitert um `updateType`
- `AlfredClient.updateMemoryType()` neue Client-Methode
- Validierung: type muss in erlaubter Liste sein (nicht beliebig)

### Wie K1-K6 zusammenwirken (Defense-in-Depth)
1. K1 filtert offensichtlich-nicht-Korrekturen schon im Regex aus (kein LLM-Call) — günstig
2. K2 wenn doch durchgekommen: LLM macht das Final-Cut → `skip` falls keine Korrektur
3. K3 falls Korrektur-artig: routet zum richtigen Type, nicht pauschal correction
4. K4 falls neuer Eintrag identisch zu existierendem: refresh statt duplicate
5. K5 räumt alte Falsch-Klassifikationen einmal sauber auf (einmal beim ersten Start)
6. K6 lässt den User manuell nachjustieren falls die ML-Pipeline daneben liegt

### Tests
- 16 neue Vitests für `correction-signal-scanner` (5 echte Korrekturen, 5 False-Positives aus Live-DB, 3 Anker-Tests, 1 Min-Length, 2 mixed)
- Bestehende Tests stabil

### Backward-Compatibility
- API additiv (alle Setter optional, neue Routes parallel zu alten)
- Bestehende memories unverändert bis K5 sie reklassifiziert
- Ohne `embeddingService`-Wiring: dedup übersprungen (Verhalten wie v605)
- Ohne `llm`-Wiring: classifyMessage fällt auf `correction` zurück (Verhalten wie v605)

## [0.19.0-multi-ha.605] - 2026-05-19

### Added — Project-Agent Anti-Hallucination (Reaktion auf "interject auf tote Session" 17:21)

Adressiert die in der 17:21-Analyse identifizierten 7 Punkte (M1-M7). Behebt das Phänomen "Alfred sagt 'ich habe dem laufenden Project-Agenten nachgereicht' obwohl die Session längst beendet ist". Vollständige Maximal-Variante.

#### M1 — `interject` lehnt tote Sessions ab (`project-agent-skill.ts`)
- Vorher: `interject` rief `pushInterjection` auch wenn `session.currentPhase === 'done'` / `'failed'` → success=true, Nachricht landet in orphan-inbox
- Jetzt: Strikte Phase-Prüfung → `success=false` mit klarer Meldung: "Session bereits beendet (phase: X). Interject geht nur an LAUFENDE Sessions. Starte eine NEUE Session mit action='start'."

#### M2 — Skill-Description präzisiert
- Action-Beschreibungen ergänzt: "start: when the user asks for a NEW project or wants to retry"
- "interject: ONLY use to send updates to a CURRENTLY RUNNING session. DO NOT use after a session has finished — start a new one"
- Macht LLM-Entscheidung beim Tool-Call klarer

#### M3 — Reasoning-Prompt-Regel im PromptBuilder (`prompt-builder.ts`)
- Wenn `project_agent`-Skill im Skill-Set: explizite Section "## project_agent — start vs interject"
- Klare Regeln: "Same goal, different attempt = new session. Do not assume a previous task_id is still alive. When in doubt → start."

#### M4 — `status` zeigt TERMINIERT-Hint
- Bei `currentPhase === 'done'` / `'failed'`: Display zeigt explizit "⚠️ Diese Session ist ABGESCHLOSSEN. Interject hat hier keine Wirkung."
- `data.terminated: true` als strukturiertes Feld für Programm-Logik

#### M5 — Inbox-Cleanup beim Session-Ende (`project-agent-runner.ts`)
- Im `finally`-Block: `drainInterjections(sessionId)` aufgerufen
- Verhindert Akkumulation von orphan-messages wenn User nach Session-Ende noch interjectet
- Loggt Anzahl der gedraintten orphans als Warnung (Hinweis auf User-Verwirrung)

#### M6 — Start mit Vorgänger-Hint (`project-agent-skill.ts`)
- Bei `startProject`: prüft `sessionRepo.getCompletedByCwd(cwd)` — wenn Vorgänger existiert: Hint im Display "ℹ️ Vorheriger Versuch in diesem Verzeichnis existiert. Diese neue Session läuft frisch — keine Daten werden weitergeführt."
- Nicht-blockierend, nur informativ. Macht User-Erwartung klar.

#### M7 — Currently-Running-Section im System-Prompt (M3-Ergänzung)
- `SystemPromptContext` neues optionales Feld `runningProjectAgentSessions: Array<{ taskId, goal, currentPhase, cwd, lastProgressAt }>`
- `PromptBuilder` rendert Section "### Currently running project-agent sessions (interject targets):"
- Bei leerer Liste: "### No project-agent sessions are currently running. Any task_id in chat history is from a TERMINATED session."
- `ProjectAgentSessionRepository.listRunning()` neu (filter auf `current_phase NOT IN ('done', 'failed')`)
- `MessagePipeline.setProjectAgentSessionRepo()` neu — wird in `alfred.ts` verkabelt nachdem `projectAgents.enabled`
- Pipeline lädt running sessions pro message-build und übergibt an PromptBuilder
- Eliminiert die "task_id aus chat-history zieht den LLM in dead session" Falle

### Wie die 7 Maßnahmen zusammenwirken
1. **LLM versucht trotz Prompt-Regel ein interject auf tote session** → M1 rejected mit success=false (last resort)
2. **LLM ruft status auf einer toten Session auf** → M4 zeigt TERMINIERT-Hint, LLM wechselt zu start
3. **LLM sieht task_id in chat-history** → M7 Section sagt explizit "diese ist TERMINIERT, einzige laufenden sind: ..."
4. **LLM hat Zweifel ob start oder interject** → M3 Prompt-Regel sagt "Bei Zweifel → start"
5. **User schreibt Nachricht nach Session-Ende** → M5 drained inbox, keine orphan-msg-Akkumulation
6. **User startet erneut für selben cwd** → M6 informiert "fresh session, kein Carry-Over"
7. **Skill-Description leitet den LLM grundlegend** → M2 verstärkt M3

### Backward-Compatibility
- Bestehende running sessions: kein Effekt. M5 drained nur am Ende, nicht bei laufender Session.
- API-Surface: nur neue Methoden + Optional-Fields hinzugefügt, keine Breaking Changes.
- Pipeline ohne `setProjectAgentSessionRepo` Wiring: `runningProjectAgentSessions=undefined` → PromptBuilder zeigt die "No sessions running" Default-Section.

## [0.19.0-multi-ha.604] - 2026-05-19

### Added — Project-Agent Robustheit (Reaktion auf alpbyte-games Total-Failure)

Adressiert die 10 in der Analyse vom 19.05. (alpbyte-games) identifizierten Probleme. Behebt das Phänomen "13 Phasen laufen ergebnislos mit immer derselben Permission-Fehlermeldung, am Ende sagt Alfred trotzdem 🎉 fertig".

#### L1 — Pre-Flight cwd-Reachability-Check (`project-agent-runner.ts`)
- Vor Phase 1: `sudo -n -u <runAsUser> test -d <cwd> && test -w <cwd>`
- Bei Fehler: sofortiger Abbruch mit klarer Diagnose
- Verhindert 52 ergebnislose subprocess-Calls bei nicht traversierbarem cwd (Klassiker: cwd unter `/root/` während Agent als `madh` läuft, /root ist drwx------)

#### L2 — Fail-Fast nach 3 konsekutiven Total-Failure-Phasen
- Neuer Counter `consecutiveCompletePhaseFailures` — bricht ab wenn 3 Phasen in Folge weder gebaut noch Dateien produziert haben
- Reset bei jedem Fortschritt (build pass oder Files geändert)
- 13×4-Phase-Versuche werden zu max. 3×4 → 75% weniger LLM-Spam, schnellere User-Antwort

#### L3 — Honest success-Flag im Completion-Callback
- Vorher: hardcoded `success=true` nach Loop-Ende, egal ob irgendwas funktionierte
- Jetzt: `overallSuccess = anyPhaseProducedFiles && lastBuildActuallyPassed`
- Beseitigt die "🎉 fertig"-Lüge bei 0/13 erfolgreichen Phasen

#### L4 — Smart cwd-Default (`project-agent-skill.ts`)
- Wenn Agent als non-root User läuft (`sudo -u X`) UND cwd unter `/root/` → automatisch nach `/home/X/projects/<slug>` umleiten
- Warnung im Display: "cwd wurde umgeleitet weil ..."
- Verhindert Wiederholung der gleichen Konfig-Falle

#### L5 — Intelligenter Error-Extractor (`error-extractor.ts`)
- Ersetzt `combinedOutput.slice(-500)` (chopte oft den echten Fehler ab)
- Sucht nach Error-Markern (EACCES, ENOENT, ENOSPC, ETIMEDOUT, TS-Compile, etc.) und captured 3 Zeilen vor + 5 nach
- Pattern-Recognizer übersetzt npm/build/python errors in user-freundliche Diagnose
  - Spezialfall: EACCES + Pfad unter `/root/` → "Permission denied: ... Code-Agent läuft als non-root User. Lösung: Pfad auf /home/<user>/... wechseln"
  - npm registry unreachable, disk full, missing module, TS compile error, generic exit-code
- 10 Vitests grün

#### L6 — Ehrliche End-Message
- Nur 🎉 bei `overallSuccess=true`
- Sonst ❌ mit Diagnose: "X/N Phasen versucht, Y Dateien geändert. Abgebrochen nach 3 ergebnislosen Phasen in Folge. **Diagnose:** ... **Letzter Build-Output:** ..."
- Git-Push wird nur bei success ausgeführt

#### L7 — Phase-Prefix-Cleanup (`project-planner.ts`)
- Planner-Output wird normalisiert: `"Phase 1: ..."` Strings werden zu `"..."` getrimmt (Regex `/^\s*Phase\s+\d+\s*[:\-—]\s*/i`)
- Eliminiert das hässliche `"Phase 1/13: Phase 1: Projektverzeichnis anlegen"` Doppel-Prefix

#### L8 — FileStore-Asset-Bridge (`asset-bridge.ts`)
- Beim Project-Agent-Start: Goal-Text wird nach File-Store-Keys gescannt (Pattern: `<userId>/<timestamp>_<filename>.<ext>`)
- Gefundene Dateien werden in `<cwd>/uploads/<cleanname>` kopiert
- Goal-Text wird automatisch mit konkreten Pfaden umgeschrieben — der Code-Agent sieht `uploads/logo.MP4` statt opaque store-key
- Filename-Cleanup: Timestamp-Prefix entfernt, Kollisions-Counter
- chown auf uploads/ damit runAsUser lesen darf
- 9 Vitests grün

#### L9 — ProjectManager kein Auto-Project bei Total-Failure
- `finishSession()` und `finishOrphanSession()` skippen jetzt wenn `success=false` UND `totalFilesChanged=0`
- Verhindert dass tote Sessions als `status='active'` Projects landen
- Verhindert dass Health-Monitor alle 6h fehlgeschlagene Projekte probt
- Verhindert dass Reasoning-Context den Misc-Bucket mit Müll füllt

#### L10 — alpbyte-games Cleanup (operativ)
- Project `3baa458b-f351-40ca-9b2c-6055e4d3da84` auf status='archived' gesetzt
- Leeres `/root/alpbyte-games` Verzeichnis entfernt

### Tests
- 19 neue Vitests (10 error-extractor + 9 asset-bridge)
- Bestehende Tests: alle stabil

### Backward-Compatibility
- Alle Änderungen additiv. Bestehende project_agent_sessions unverändert.
- Smart-cwd nur aktiv wenn agent-config `sudo -u X` Pattern hat — root-Agents nicht betroffen.

## [0.19.0-multi-ha.603] - 2026-05-19

### Added — Logger-Fixes, AuditLogger-Verkabelung, systemd-Service-Unit

Adressiert die in der Analyse vom 19.05. identifizierten Logging- und Start-Probleme. Keine Code-Änderungen an Projects/Workflows in dieser Version — die laufen noch im Test seit v602.

#### L4 — `frequency` + `dateFormat` an pino-roll durchreichen (`logger.ts`)
- Vorher: `frequency` war im `LogFileConfig` Interface deklariert, aber **nicht** an pino-roll weitergegeben → Daily-Rotation lief nie, obwohl als Default dokumentiert
- Jetzt: `frequency` (default `'daily'`) und `dateFormat` (default `'yyyy-MM-dd'`) werden korrekt in die pino-roll-Optionen injiziert
- ENV-Overrides: `ALFRED_LOG_FILE_FREQUENCY` (`daily` / `hourly` / `null`), `ALFRED_LOG_FILE_DATE_FORMAT`
- Konfigurierbar pro Config-Datei via `logger.file.frequency`

#### L7 — Stabile `tail -F`-Datei via Symlink (pino-roll v2 → v4)
- pino-roll Upgrade `^2.0.1` → `^4.0.0` (`mkdir: true`, `symlink: true` Optionen)
- pino-roll v4 erzeugt automatisch einen Symlink mit dem Basename (`alfred.log`) zur aktuellen rotierten Datei (`alfred.log.2026-05-19`)
- `tail -F /root/alfred/data/logs/alfred.log` folgt damit der aktiven Datei auch über Tages-Rotation hinweg
- Gleiche Behandlung für `audit.log` (AuditLogger)
- Eliminiert das beobachtete Phänomen "es gibt kein alfred.log, nur .1 .2 .3 .4 .5"

#### L5 — AuditLogger initialisieren + verkabeln
- Vorher: `AuditLogger`-Klasse existierte in `@alfred/logger` aber wurde **nie instanziiert** → keine `audit.log`-Datei vorhanden trotz `auditLogPath` in config
- Jetzt: `alfred.ts` (Schritt 2 Init) erstellt `AuditLogger` mit dem aus `config.logger.auditLogPath` geladenen Pfad und übergibt ihn als zweite Senke an `SecurityManager`
- `SecurityManager` schreibt jede Audit-Entry sowohl in die `audit_log`-Tabelle (DB-backed, für UI-Query) als auch in die rotierende Datei (file-backed, für tail+Archivierung)
- Fehler im File-Sink werden geswallowed — DB-Audit bleibt im Vordergrund-Pfad
- Neue Interface `AuditFileSink` im `@alfred/security` für lose Kopplung

#### L2 — systemd-Service-Unit (`packaging/systemd/alfred.service`)
- Neue Service-Definition mit `Type=simple`, `Restart=on-failure`, sauberen `StandardOutput=journal`/`StandardError=journal` Streams
- Setzt `NODE_ENV=production` (eliminiert pino-pretty in stdout-Pfaden)
- Setzt `ALFRED_LOG_FILE_ENABLED=true` und `ALFRED_LOG_FILE_PATH` deterministisch
- `StartLimitBurst=5` über 5 Minuten — verhindert Crash-Loop-Schleifen
- Ausführliche Install-Doku in `packaging/systemd/README.md` inkl. Migration von `nohup`-Setup
- **Löst das Doppel-Start-Problem dauerhaft**: systemd setzt stdin/stdout/stderr **vor** dem exec auf journald-Sockets — kein TTY-Übergangszustand, kein EIO

#### Backward-Compatibility
- Bestehende Setups (nohup) laufen weiter unverändert — systemd-Unit ist additiv, kein Zwang zum Umstieg
- Existing rotated log-files (`alfred.log.1`, `alfred.log.2026-04-17.1`, etc.) bleiben liegen — pino-roll v4 startet seine eigene Rotation parallel
- Empfehlung: nach Umstieg alte Files manuell archivieren

### Wichtig für Deployment
- **Manuelle Migration**: nach Update auf v603 läuft die existierende `nohup`-Variante weiter, aber empfohlen ist Umstieg auf systemd (siehe `packaging/systemd/README.md`)
- Bei Migration: alten `nohup`-Prozess stoppen, dann `sudo systemctl enable alfred --now`

## [0.19.0-multi-ha.602] - 2026-05-19

### Added — Auto-Workflow-Creation + Cluster-Fixes + ITSM-Verlinkung

Adressiert 5 Themen aus der Analyse vom 19.05.: HealthMonitor-Cluster-Spam, fehlende Lern-Funktion (Workflow aus Sessions), Trigger-Lücke für Delegate-Sessions, ITSM-Doppel-Tracking im Misc-Bucket, WebUI-Trennung von Projekten und Beratungs-Sessions.

#### P1 — HealthMonitor cluster-aware
- `HealthMonitor` nimmt jetzt einen `ClusterClaim`-Resolver (lazy, weil `AdapterClaimManager` später in `initialize()` konstruiert wird)
- Vor jedem Cycle: `tryClaim('project-health-monitor')` — nur der eine Node läuft die Probes
- Andere Nodes loggen "cycle skipped — claim held by another node" und tun nichts
- Beseitigt das Phänomen "alle 6h Confirmation-Spam wegen alternierender Node-Sichten"
- Plattform wird in `alfred.ts` Init-Phase 2 via `adapterClaimManager.registerPlatform('project-health-monitor')` registriert
- Single-Node SQLite-Deployments: Resolver gibt `undefined` → unverändertes Single-Node-Verhalten

#### P2 — Auto-Workflow-Creation (Variante B, Session-basiert)
- Neu: `packages/core/src/projects/workflow-extractor.ts`
  - LLM-Analyse (Strong-Tier default) erkennt wiederverwendbare Skill-Sequenzen aus Delegate-Sessions
  - Schwellwert: `>=2 successful tool-calls AND >=2 unique skills` als Early-Skip
  - Output: strict JSON mit `suggested_name` (kebab-case), `suggested_description`, `steps` (WorkflowActionStep-konform)
  - Validation: erfundene Skills werden abgelehnt (anti-hallucination), kebab-case strikt erzwungen
- Wiring in `alfred.ts` DelegateSkill-Completion-Callback: nach `finishOrphanSession()` ruft `proposeWorkflowFromSession()` an, wenn substantiell + erfolgreich
- Confirmation-Queue-Eintrag mit `skillName='workflow', action='create', autoExtracted=true`
- **Zwei separate Confirmations** bei Project-Agent-Erfolg (Runbook bestehend + Workflow neu) — bewusst nach User-Entscheidung
- Migration v64/v67: `workflow_chains` bekommt `source_session_id`, `related_runbook_id`, `auto_extracted`, `auto_run`, `description`
- `WorkflowRepository`: neue `findByName()`, `setAutoRun()`, `setRelatedRunbook()`
- 11 neue Vitests für Extractor

#### P2 — Workflow Run-Confirmation + `auto_run` Flag
- `WorkflowSkill.runWorkflow`: bei `auto_run=false` und ohne `confirmed=true` → enqueued Confirmation-Eintrag mit `confirmed=true` als Approval-Payload, return mit Steps-Preview
- Neue Skill-Action `set_auto_run` (workflow_id + enabled boolean) — toggle pro Workflow
- Wichtig: Skill-Level admin-Confirmations bleiben unabhängig aktiv. Ein Workflow mit `auto_run=true` enthält trotzdem geschützte SSH/Deploy-Skills, die ihre eigenen Sicherheits-Prompts behalten

#### P3 — Runbook-Workflow-Kopplung
- Cross-Link via `related_runbook_id` Feld in `workflow_chains`
- Beide Artefakte entstehen aus derselben Session, behalten aber separate Confirmations und Lifecycles

#### P4 — Anti-Duplicate ITSM-Verlinkung
- Migration v64/v67: `project_open_items` bekommt `linked_incident_id`, `linked_change_id`
- `SessionSummarizer` Prompt-Erweiterung: erkennt 8-char hex-IDs im Titel, extrahiert als `linked_incident_id` statt im Titel zu duplizieren
- Parser-Fallback: wenn LLM die Regel missachtet, regex-basierter Fallback-Extraktor
- **Cross-Domain-Cascade**:
  - **Forward**: ProjectSkill `resolve_open_item` → wenn `linkedIncidentId` gesetzt → ItsmSkill `update_incident` / `close_incident`
  - **Reverse**: ItsmSkill `close_incident` / `update_incident` mit status=resolved/closed → ProjectRepo `findOpenItemsByLinkedIncident()` → alle linked open-items auf `done`
- `ProjectSkill.setIncidentCascade()` und `ItsmSkill.setProjectItemCascade()` neue Setter
- Wiring in `alfred.ts` über Lazy-Lookup `skillRegistry.get('itsm')` (ItsmSkill wird im CMDB-Block ~600 Zeilen später konstruiert)

#### P5 — WebUI Misc-Tab
- `/alfred/projects` Page bekommt 2 Tabs: "Projekte" (alles ohne Misc) und "Beratungs-Sessions" (nur Misc-Bucket)
- Misc-Erkennung: `slug='misc'` oder Tag `system` enthalten
- Counter im Tab-Label: zeigt wieviele Projekte/Sessions pro Tab
- Backend unverändert — Misc bleibt im `projects`-Schema, nur Frontend trennt visuell

### Tests
- 5 neue Cluster-Claim Tests in `health-monitor.test.ts` (insgesamt 15)
- 11 neue Vitests für WorkflowExtractor (Parse, Anti-Halluzination, Skip-Cases)
- 46/46 project-tests stabil

### Backward-Compatibility
- Bestehende Workflows: alle Spalten unverändert, neue Spalten NULL/0 für alte Records
- Bestehende Runbooks: unverändert, `related_workflow_id` bleibt NULL
- v591-v600 Project/Runbook/Health-Mechanismen: alle Trigger weiter aktiv
- HealthMonitor-API: nur Constructor erweitert (optionaler Parameter ans Ende), keine Breaking Changes

## [0.19.0-multi-ha.601] - 2026-05-18

### Added — Projects WebUI + Health-Detail im Chat

Frontend-Page für die in v597-v600 etablierte Projects-Foundation. Plus den fehlenden Health-Detail im `project get` Skill-Output.

#### Health-Detail in `project get` (`packages/skills/src/built-in/project.ts`)
- Neue Section "Letzte Health-Checks" im Display
- Pro Probe (git/build/deps/http): Icon (✓/⚠/✗/·), Status, relative Zeit, gekürzte Details
- Datenquelle: `getCurrentHealthSummary()` aus dem Repo
- Returns `health` jetzt zusätzlich im `result.data`

#### Projects API (`packages/messaging/src/adapters/http.ts`)
Neue Endpoints mit Bearer-Auth:
- `GET /api/projects?status=...` — Liste
- `GET /api/projects/:id` — Detail mit sessions + openItems + decisions + health-summary
- `POST /api/projects` — Anlegen (name + optionale description/cwd/repoUrl/tags)
- `PATCH /api/projects/:id` — Update (name/status/healthMode/description/cwd/repoUrl/tags)
- `DELETE /api/projects/:id` — Archive (setzt status=archived, kein Hard-Delete)
- `POST /api/projects/:id/open-items` — Open-Item hinzufügen
- `PATCH /api/projects/open-items/:itemId` — Status ändern (open/in_progress/done/cancelled)
- `GET /api/projects/:id/health-log?limit=100` — Health-Log-History

Wiring in `alfred.ts` via `setProjectsCallbacks()` Pattern (analog Runbook-API).

#### WebUI Page `/alfred/projects` (`apps/web/src/components/projects/ProjectsPage.tsx`)
- Sidebar-Eintrag 🗂️ zwischen Runbooks und CMDB
- Master/Detail-Layout:
  - Liste: Status + Health-Mode-Badge, Name, cwd, Last-Activity
  - Filter: status (active/paused/maintenance/completed/archived/all) + Suchfeld
- Detail-View:
  - Inline-Edit für Name (Bleistift-Icon)
  - Status-Switcher (4 Buttons) + Health-Mode-Switcher (3 Buttons)
  - Health-Checks-Section: 4 Probes mit Icon + relative Zeit + Details
  - Open-Items mit Quick-Resolve-Checkbox + Inline-Add (Title + Priority-Dropdown)
  - Sessions-Liste mit Type-Badge + Status-Color + whatWasDone-Snippet
  - Decisions-Liste mit Choice + Rationale-Italic
  - Archive-Button (rot)
- Create-Modal mit name/description/cwd/repoUrl

#### Type-Exports (`apps/web/src/lib/alfred-client.ts`)
- `Project`, `ProjectStatus`, `ProjectHealthMode`, `ProjectSession`, `ProjectOpenItem`, `ProjectDecision`, `ProjectHealthEntry`, `ProjectDetail`, `HealthProbe`, `HealthStatus`

### Tests
- 29/29 project-tests stabil

## [0.19.0-multi-ha.600] - 2026-05-18

### Added — Projects T3: Health-Monitoring per Projekt

Alfred prüft jetzt periodisch den Gesundheitszustand seiner aktiven Projekte. Schließt die Projects-Foundation ab — Alfred kann nicht nur Sessions tracken (T1+T4) und Projekte im Reasoning referenzieren (T2), sondern auch eigenständig erkennen wenn ein Projekt-Build kaputt geht, Dependencies veralten oder eine Deploy-URL ausfällt.

#### Schema (Migration v63 SQLite / v66 PG)
- **project_health_log**: id, project_id, probe, status (ok/warning/error/skipped), details, duration_ms, checked_at
- Indizes auf (project_id, checked_at) + (project_id, probe, checked_at)

#### Probes (`packages/core/src/projects/probes/`)
- **git-probe**: existiert .git? Branch + Last-Commit lesbar? Commit-Age. `ok` bei <30d, `warning` bei >30d, `error` bei fehlender Repo, `skipped` ohne cwd
- **build-probe**: Auto-Detection (pnpm/npm/yarn/cargo/python), Non-Destructive Check (`tsc --noEmit`, `cargo check`, `compileall`). 90s Default-Timeout, `warning` bei Timeout (inconclusive)
- **deps-probe**: `npm outdated --json --depth=0` für direkte Dependencies (Transitive Churn ist Noise). 30s Timeout
- **http-probe**: HEAD-Request auf `repoUrl` (nur http/https, skips ssh/file/git+ssh). `ok` 2xx, `warning` 3xx-4xx, `error` 5xx/timeout

#### HealthMonitor (`packages/core/src/projects/health-monitor.ts`)
- Background-Task mit konfigurierbarem Intervall (default 6h, min 15min)
- Iteriert active + maintenance Projekte des Owners
- Respektiert `project.healthMode`: `off` skip, `minimal` nur git, `full` alle 4 Probes
- Persistiert jedes Ergebnis in `project_health_log`
- Detection von **Status-Degradation**: ok→warning, ok→error, warning→error → triggert StatusChangeListener
- Concurrency-Schutz: überlappende Cycles werden geskipped

#### Status-Change-Confirmation (`alfred.ts`)
Bei Degradation wird automatisch ein Confirmation-Queue-Eintrag erzeugt mit probe-spezifischer Beschreibung:
- `build`: "Build von Projekt X ist kaputt — Code-Agent zur Reparatur starten?"
- `deps`: "Dependencies von X sind veraltet. Updates prüfen?"
- `http`: "Deploy-URL von X antwortet nicht mehr. Prüfen?"
- skillName = 'project', skillParams = `{ action: 'get', project_id }` → User kann direkt nachschauen
- Timeout 24h, Source `reasoning`

#### Config (`config.projects`)
- `healthCheckEnabled` (default true)
- `healthCheckIntervalHours` (default 6)
- `healthProbeTimeoutMs` (default je-Probe 15-90s)

#### Per-Chat-Steuerung (bereits in v597)
- `Alfred, schalt Health-Mode für Projekt X auf minimal` → ProjectSkill `set_health_mode`
- `Alfred, schalt Health komplett für Y aus` → `set_health_mode off`

### Tests
- 9 neue Vitests für `isDegradation` (Status-Übergangslogik)
- 5 neue Vitests für `gitProbe` (lokale tmp-Repo Setup, deterministisch)
- 29/29 project-tests gesamt grün

### Roadmap-Abschluss
T1 (v597) + T4 (v598) + T2 (v599) + T3 (v600) sind alle released. Die Projects-Foundation ist damit komplett: Alfred sieht alles was in project-agent/code-agent/delegate-Sessions passiert, hält Open-Items+Decisions+History, referenziert Projekte im Reasoning und wartet sie via Health-Probes.

## [0.19.0-multi-ha.599] - 2026-05-18

### Added — Projects T2: Reasoning-Engine sieht aktive Projekte

Alfred kann nun seine Project-Container im Reasoning-Loop nutzen. Mit v597+v598 hatte Alfred zwar bereits persistente Projekt-Daten, aber die Reasoning-Engine kannte sie nicht — Insights konnten weder auf Projekte verweisen noch Stale-Projekte aufgreifen. v599 schließt die Lücke.

#### Neue Section "Aktive Projekte" (`reasoning-context-collector.ts`)
Wird im Reasoning-Context-Collector als Priority-2 Section angezeigt, **nur** wenn aktive Projekte existieren (sonst skip = Token-Ersparnis):
- Top 5 aktive Projekte mit Name + Aktivitätsdatum + Open-Items-Counter
- **Stale-Block** (>30 Tage inaktiv) → Kandidaten für Archivierung-Frage
- **Überfällige Open-Items** (priority + Projekt-Bezug, max 5)
- Inline-Hinweis für LLM zur Nutzung

#### Prompt-Regel-Erweiterung (`reasoning-engine.ts`)
Neuer Block "AKTIVE PROJEKTE NUTZEN" mit Verhaltensregeln:
- Bei thematischem Match: Projekt explizit referenzieren ("gehört zu Landingpage-Projekt, 3 offene Punkte")
- Stale-Projekte (>30d): Max 1 Confirmation-Vorschlag pro Insight-Lauf — nicht mehrere gleichzeitig anbieten
- Überfällige Open-Items nur bei passender Tageszeit oder Themenkontext erwähnen
- Open-Items immer mit Projekt-Bezug behandeln, nicht als generische Todos

#### Wiring
- `ProjectRepository` neuer optionaler Constructor-Param in `ReasoningContextCollector` + `ReasoningEngine`
- `alfred.ts` reicht `this.projectRepo` an `ReasoningEngine` durch
- Engine erzeugt Collector intern mit `projectRepo` → kein extra Wiring nötig

### Roadmap
- T3 (v600): Health-Monitoring per Project (Git/Build/Deploy Probes, per-Project konfigurierbar)

## [0.19.0-multi-ha.598] - 2026-05-18

### Added — Projects T4: Delegate + Code-Agent Lifecycle-Coverage

Mit v597 hat Alfred persistente Projekt-Container bekommen, aber bisher nur Project-Agent-Sessions automatisch hineingespeist. v598 erweitert die Lifecycle-Coverage auf Delegate-Calls und Code-Agent-Runs/Orchestrations.

#### Threshold-Gate (`session-thresholds.ts`)
Eine Session zählt als "substantiell" und wird persistiert wenn **mindestens eine** der folgenden Bedingungen erfüllt ist:
- `toolCalls >= 5` (default, konfigurierbar via `config.projects.orphanDelegateThresholdToolCalls`)
- `filesChanged >= 1` (jede beobachtete File-Modifikation)
- `durationMs >= 3 * 60_000` (default, konfigurierbar via `config.projects.orphanDelegateThresholdMinutes`)

Triviale Lookups (1-2 Tool-Calls, keine Files, <3min) werden ignoriert — keine Pollution der Projektliste.

#### DelegateSkill (`delegate.ts`)
- `setSessionCompletionCallback(cb)` — neuer Setter, wird von alfred.ts beim Initialisieren des Project-Managers gesetzt
- Tracking pro execute(): `toolCalls`, `filesChanged` (Heuristik via FILE_WRITE_TOOLS-Set), `durationMs`, `iterations`, `toolNames` Set, `finalResponse`
- Callback emit auf success-Pfad und error-Pfad (NICHT auf pause — paused sessions sollen nicht als orphan summarized werden)
- Type-Export: `DelegateSessionInfo`

#### CodeAgentSkill (`code-agent-skill.ts`)
- `setSessionCompletionCallback(cb)` — gleicher Pattern
- `run`-Action: emit mit `modifiedFiles.length` aus dem `executeAgent`-Result (mtime-Diff)
- `orchestrate`-Action: emit mit `allModifiedFiles.length` + `totalDurationMs` + `summary` als finalOutput
- Callback emit auf success und error in beiden Actions
- Type-Export: `CodeAgentSessionInfo`

#### ProjectManager (`project-manager.ts`)
- Neue Methode `ensureMiscBucket(userId)`: Find-or-create ein einzelnes "Misc"-Projekt für orphan-Sessions ohne cwd-Bezug
- Neue Methode `finishOrphanSession(...)`: hängt orphan-Sessions an Misc-Bucket statt pro Goal ein neues Projekt zu erzeugen
- Standard `finishSession(...)` wird weiterhin für cwd-basierte Auto-Bindung verwendet (Code-Agent mit cwd, Project-Agent)

#### Wiring (`alfred.ts`)
- DelegateSkill-Ref + CodeAgentSkill-Ref werden in Klassen-Properties gehalten
- Im Projects-Block werden beide Callbacks gesetzt — Threshold-Check, dann ProjectManager-Routing:
  - Delegate (kein cwd) → `finishOrphanSession` → Misc-Bucket
  - CodeAgent.run mit cwd → `finishSession` → cwd-basiertes Projekt
  - CodeAgent.run ohne cwd → `finishOrphanSession` → Misc-Bucket
  - CodeAgent.orchestrate mit cwd → `finishSession` → cwd-basiertes Projekt

### Tests
- 6 neue Vitests in `session-thresholds.test.ts`: trivial-skip, tool-calls-threshold, file-change-trigger, duration-trigger, custom-thresholds, any-criterion

### Roadmap
- T2 (v599): Reasoning-Engine Active-Projects Context-Integration
- T3 (v600): Health-Monitoring per Project mit Git/Build/Deploy Probes

## [0.19.0-multi-ha.597] - 2026-05-18

### Added — Projects (T1 Foundation)

Langlebige Projekt-Container über project-agent / code-agent / delegate / chat Sessions. Alfred hatte bisher keinen Zustand jenseits der einzelnen Session — abgeschlossene Projekte waren nach Session-Ende unsichtbar für Reasoning und Chat. Diese Schicht schließt die Lücke.

#### Schema (Migration v62 SQLite / v65 PostgreSQL)
- **projects**: id, user_id, name, slug (unique pro user), description, cwd, repo_url, status (active/paused/completed/maintenance/archived), health_mode (full/minimal/off), tags, created_at, last_active_at, next_check_at
- **project_sessions**: bindet einzelne Session-Quellen (project_agent / code_agent / delegate / chat) an ein Project, hält `summary_json` mit LLM-extrahierten Erkenntnissen
- **project_open_items**: TODOs / Follow-ups aus Sessions, mit priority + status + due_at
- **project_decisions**: Architektur- und Stack-Entscheidungen + Rationale

#### LLM Session-Summarizer (`packages/core/src/projects/session-summarizer.ts`)
- Strict-JSON-Output: `what_was_done`, `key_decisions`, `files_touched`, `open_items`, `status`, `next_check_in_days`
- Default-Tier `strong`, konfigurierbar via `config.projects.summarizerLlmTier`
- Robust gegen LLM-Halluzination: ungültige Felder werden gedroppt, leere Titel skipped, Arrays auf Safe-Limits geclamped (max 5 decisions, max 8 open items, max 20 files)
- Fallback bei Parse-Fehler: deterministische Minimal-Summary aus Milestones

#### ProjectManager (`packages/core/src/projects/project-manager.ts`)
- `attachSession()`: Auto-Find oder -Create per cwd-Match (konfigurierbar via `autoBindByCwd`)
- `finishSession()`: ruft Summarizer, persistiert Open-Items + Decisions, setzt `next_check_at` basierend auf LLM-Vorschlag
- Wird vom Project-Agent-Completion-Callback aufgerufen (success UND failure-Pfad)

#### Project Skill (`packages/skills/src/built-in/project.ts`)
Actions: `list`, `get`, `create`, `rename`, `set_status`, `set_health_mode`, `list_open_items`, `add_open_item`, `resolve_open_item`, `list_sessions`, `list_decisions`, `archive`
- Per-Project Health-Mode konfigurierbar per Chat ("Alfred, schalt Projekt X auf minimal")
- Slug-basierte Auflösung (`get my-project-name`) + 8-char hex prefix match
- Verifizierte Owner-only Zugriffe via masterUserId

#### Config (`config.projects`)
- `enabled` (default true)
- `summarizerLlmTier`: 'default' | 'strong' (default 'strong')
- `autoBindByCwd` (default true)
- `orphanDelegateThresholdToolCalls` (für T4 vorbereitet)
- `orphanDelegateThresholdMinutes` (für T4 vorbereitet)

### Tests
- 9 neue Vitests in `session-summarizer.test.ts`: Parsing well-formed JSON, Markdown-Fences-Stripping, Unparseable-Output Null-Return, next_check_in_days Clamping, invalid-priority Default, empty-title Filter, Array-Capping, Status-Inferenz aus input.success, LLM-Throw → null

### Roadmap
- T4 (v598): Delegate + Subagent Lifecycle-Coverage
- T2 (v599): Reasoning-Engine Active-Projects Context-Integration
- T3 (v600): Health-Monitoring per Project (Git/Build/Deploy Probes)

## [0.19.0-multi-ha.596] - 2026-05-18

### Added — Mistral Medium 3.5 Support inkl. Prompt-Caching

Mistral hat im April 2026 Mistral Medium 3.5 veröffentlicht (frontier-class multimodal, 256k context, $1.5/$7.5 per 1M tokens). Mistral hat zusätzlich Prompt-Caching im API (`prompt_cache_key` parameter) — opt-in, cached tokens = 10% des Input-Preises.

#### P1 — Pricing-Eintrag (token-costs.ts)
- Neue Zeile **vor** generic `mistral-medium`: `'mistral-medium-3-5'` mit `{ input: 1.50, output: 7.50, cacheRead: 0.15 }`
- Prefix-Match findet 3.5 zuerst — Aliase `mistral-medium-3-5` und `mistral-medium-3-5-26-04` werden korrekt zugeordnet
- Verhindert Silent-Pricing-Drift wenn `mistral-medium-latest` auf 3.5 zeigt (kosten wären sonst 4× unterschätzt)

#### P2 — Context-Window (provider.ts)
- Neue Zeile `'mistral-medium-3-5': { maxInputTokens: 256_000, maxOutputTokens: 131_072 }`
- 256k Input (doppelt von 3.0/3.1)
- Output konservativ auf 131k (Mistral-Docs spezifizieren nicht explizit, lieber Standard)

#### P3 — Setup-Wizard (setup.ts)
- Neue Option `mistral-medium-3-5-26-04` (datiertes Snapshot — deterministisch, kein Auto-Upgrade-Risiko)
- Beschreibung von `mistral-medium-latest` aktualisiert mit Hinweis "auto-upgrades on release (pricing may shift)"

#### P4 — Prompt-Caching aktiviert (mistral.ts + openai.ts)
- Neuer `protected extraRequestParams(request)` Hook in OpenAIProvider — subclasses können Body-Felder einfügen
- MistralProvider überschreibt: setzt `prompt_cache_key` aus stabiler SHA-256 Hash über (system + tools) — NUR für `mistral-medium-3-5*` Modelle
- Konservativer Scope: andere Mistral-Modelle (small, large, magistral, ministral, codestral, embed) bleiben unverändert da Mistral-Docs Caching-Support für die nicht explizit dokumentieren
- Cache-Key 32 hex chars (128 bits), identische system+tools → identischer Key → Cache-Hit → 90% Ersparnis auf Input-Tokens

### Tests
- 19 neue Vitests in `mistral.test.ts`:
  - Pricing-Match: 3.5-spezifisch + 3.0/3.1 generic unverändert + mistral-medium-3 (v3.0) korrekt
  - Context-Window: 256k für 3.5, 131k für andere
  - Cache-Scoping: nur 3.5-Modelle, andere ausgeschlossen
  - Key-Stabilität: gleicher input → gleicher key, system-Änderung → neuer key, tools-Änderung → neuer key
  - extraRequestParams-Hook: emits `prompt_cache_key` nur wenn berechtigt

## [0.19.0-multi-ha.595] - 2026-05-18

### Added — Hallucinated-Action Schutz + Watch-Auto-Repair

Bug-Befund: alle 6 enabled Watches hatten LLM-halluzinierte Action-Namen (`list_entities`, `get_state`, `get_entity_state`, `check_job_runtime` — keine davon existiert in den jeweiligen Skill-Enums). Watches wurden trotzdem erstellt, da Watch-Skill nur `required` Felder pruefte, nicht den Action-Wert gegen das Enum. Ergebnis: alle Watches feuerten nie, nur stille WARN-Logs.

#### Schicht 1 — Action-Enum-Validator (zentral)
`@alfred/skills` neuer Helper `validateSkillAction(registry, skillName, params)`:
- Prueft `params.action` gegen `inputSchema.properties.action.enum` des Ziel-Skills
- Liefert `ok: false` mit `error: "Skill X hat keine action Y. Valid: [...]"` 
- Pass-through wenn Skill kein Action-Enum hat (free-form Skills) oder Registry undefined ist

Wird genutzt in 4 Create-Pfaden:
- `WatchSkill.createWatch` — verhindert Bestandsfehler-Wiederholung
- `ScheduledTaskSkill.createAction` — `skill_input.action` validiert
- `BackgroundTaskSkill.scheduleTask` — `skill_input.action` validiert
- `WorkflowSkill.createWorkflow` — pro action-step

Skills brauchen jetzt optional `skillRegistry` im Constructor (in `alfred.ts` durchgereicht).

#### Schicht 2 — DB-Cleanup
6 broken Watches via `DELETE FROM watches WHERE id IN (...)` entfernt. User legt bei Bedarf neu an — LLM kann jetzt keine kaputten mehr erzeugen (Schicht 1 fängt's ab).

#### Schicht 3 — Watch-Auto-Repair
Migration v61 (SQLite) + v64 (PG): neue Spalten `watches.consecutive_failures` + `watches.last_repair_at` (sowie für `scheduled_actions`).

WatchEngine-Erweiterungen:
- Bei jedem fehlgeschlagenen Poll: `consecutive_failures++`
- Bei erfolgreichem Poll: `consecutive_failures = 0`
- Bei `consecutive_failures == 3`: **Auto-Repair-Versuch** über LLM
  - Prompt enthält: Watch-Name, current Params, Fehlertext, Liste valider Actions aus Schema
  - LLM antwortet strukturiert mit `can_repair`, `reason`, `corrected_params`
  - Bei `can_repair: true` → neue Params werden geschrieben + sofortiges Retry
  - Retry erfolgreich → `consecutive_failures = 0`, Watch ist geheilt
  - Retry erneut fehlgeschlagen → neue Params bleiben (LLM's beste Vermutung), Zähler steigt weiter
- Bei `consecutive_failures >= 6`: **Auto-Disable** + einmalige Telegram-Info-Message ("Watch X disabled. Korrigiere im WebUI oder mit watch-Skill.")

`WatchRepository`: neue Methoden `incrementFailures(id)`, `resetFailures(id)`, `markRepairAttempted(id)`. `Watch`-Type erhält `consecutiveFailures?: number`, `lastRepairAt?: string`.

### Tests
8 neue Vitests für `validateSkillAction` inkl. Regression-Tests für die 4 konkreten Halluzinationen (`list_entities`, `get_state`, `get_entity_state`, `check_job_runtime`).

## [0.19.0-multi-ha.594] - 2026-05-18

### Fixed — Runbook-Reflector Cold-Start-Flood (kritisch)

v593-Deploy produzierte 28 pending Confirmations + 3 Auto-Drafts beim ersten Reflector-Lauf, alle für nur 1-2 Conversations (Beispiel: 10 Confirmations zum gleichen "aWATTar-Rechnungen" Thema mit minimal variierendem LLM-Output).

Root Causes:
1. Marker an `last_message_id` gekoppelt — neue Tool-Messages während laufender Analyse → Marker-Mismatch → Re-Analyse derselben Session
2. Kein Concurrency-Guard auf `tick()` — überlappende LLM-Calls möglich
3. Kein Cold-Start-Backfill — alle historischen quiet Sessions wurden auf einmal analysiert
4. Confidence-Threshold 0.8 zu niedrig — minimale Variationen lösten je eine Confirmation aus

Sechs Fixes in `ChatSessionRunbookReflector`:

- **R1** Marker per `conversation_id` (nicht `+last_message_id`), TTL = 24h. Re-Analyse erst am nächsten Tag bei substantieller Conversation-Erweiterung möglich
- **R2** Concurrency-Guard `tickRunning`: läuft ein Tick noch, wird der nächste geskipped
- **R3** Per-Tick-Limit: max 3 LLM-Extractions pro Polling-Iteration. Backlog wird über mehrere Ticks abgebaut
- **R4** Session-Age-Window-Filter: nur Sessions mit `last_message_at` ≤7 Tage werden überhaupt betrachtet. Alte Conversations werden ignoriert
- **R5** Cold-Start-Backfill (one-shot per User): beim ersten Reflector-Run für einen User werden ALLE existing qualifying Conversations als "processed" markiert OHNE LLM-Call. Marker `_internal_runbook_reflector_backfilled` verhindert Re-Backfill
- **R6** Confidence-Thresholds verschärft: `≥0.9` für Confirmation (vorher 0.8), `0.65-0.9` als Auto-Draft (vorher 0.5-0.8), `<0.65` skip

### DB-Cleanup
- 28 pending Runbook-Confirmations auf `status='expired'` gesetzt (Produktion)
- 3 Auto-Drafts bleiben in `runbooks` Tabelle — über `/alfred/runbooks/` reviewbar

### Tests
- 34 Tests insgesamt (vorher 27): +9 für aktualisierte Confidence-Routing, Window-Filter, Per-Tick-Limit

## [0.19.0-multi-ha.593] - 2026-05-03

### Added — Runbook-WebUI + Chat-Pipeline-Integration

v591/v592 hatten Runbooks erstellt, ABER:
- Drafts aus Trigger C waren ohne Browser unsichtbar
- Chat-Pipeline nutzte Runbooks NICHT (nur Reasoning-Engine)

v593 schließt beide Lücken.

#### W1 — WebUI `/alfred/runbooks/`
- Sidebar-Eintrag "Runbooks" mit 📖-Icon
- Liste links mit Status-Badge (draft/verified/deprecated) + Quelle (ITSM/Project/Chat/Manual) + Tags
- Detail-Pane rechts mit Symptom/Ursache/Schritte/Verifikation/Rollback
- Filter: Status, Quelle, Volltext-Suche (Titel/Symptom/Tags)
- Aktionen: ✓ Verifizieren, Deprecate, Löschen
- Inline-Editor: alle Felder bearbeitbar inkl. Schritte (eine pro Zeile) und Tags

#### W2 — API-Endpoints
- `GET /api/runbooks?status=...&source_type=...`
- `GET /api/runbooks/:id`
- `PATCH /api/runbooks/:id` (mit JSON-Body)
- `DELETE /api/runbooks/:id`
- HttpAdapter: `setRunbookCallbacks()` (auth-checked)

#### W3 — Chat-Pipeline Runbook-Injection (KRITISCH!)
Vorher: Chat-Handler ignorierte Runbooks komplett. Wenn der User fragte "wie hatten wir das letztes Mal gemacht?" sah der LLM keine Runbooks.

Jetzt: `MessagePipeline.handleMessage()` ruft `runbookRepo.findMatching(message.text)` und injiziert passende Runbooks als System-Prompt-Section "Passende Runbooks (frühere Erfahrungen)". Mit Hinweis: "Wenn die User-Anfrage thematisch passt, referenziere konkret. Volltext via `runbook get` mit der 8-stelligen ID."

Damit konsumiert Alfred Runbooks JETZT überall:
- Proaktive Insights (Reasoning-Engine, v591+v592)
- Direkter Chat (Chat-Pipeline, v593)
- LLM-explizit via `runbook` skill (immer)

#### W4 — Tests
4 neue Vitests für W3-Gate (insgesamt 27 in der Runbook-Test-Suite).

## [0.19.0-multi-ha.592] - 2026-05-03

### Changed — Runbooks generisch wie Hermes-Style Erfahrungsgedächtnis

v591 hatte Runbooks zu eng auf Infra/Technik fokussiert. v592 macht sie zum allgemeinen Erfahrungsgedächtnis für JEDE Art von Aufgabe/Problem/Entscheidung — von Bewerbungs-Strukturierung über Sonntag-Logistik bis Server-Debug.

#### B1 — Trigger-C Triage gelockert
`ChatSessionRunbookReflector.tick()`:
- Schwelle `MIN_MESSAGES` von 10 → **6**
- Bedingung von `tool_msgs ≥ 1` → **`tool_msgs ≥ 1 OR assistant_msgs ≥ 3`**
- Reines Konversations-Problemlösen (Bewerbung formulieren, Logistik planen) qualifiziert jetzt

#### B2 — Generische Runbook-Section im Reasoning-Collector
Neue Section "Erfahrungen & Runbooks" (priority 2) — unabhängig von ITSM:
- Läuft für jeden Reasoning-Pass mit meaningful keywords im Context
- Matched gegen alle Runbooks (verified+draft) per title+symptom+tags
- Verifizierte mit ✓ markiert, Drafts mit ·
- Verbirgt sich wenn keine Treffer → keine Token-Verschwendung

#### B3 — Skill-Category korrigiert
`RunbookSkill.category` von `'infrastructure'` → **`'core'`**. Description aktualisiert: explizit erwähnt dass Runbooks Themen-übergreifend sind (technische Probleme, Logistik, Bewerbungen, Family-Planung, Recherche).

#### B4 — LLM-Prompt erweitert (Trigger C)
`ChatSessionRunbookReflector` Prompt:
- Explizite Themenliste in der Anweisung: Bewerbungen, Logistik, Konzepte, Entscheidungen, Recherche
- Tags-Regel: 2-5 thematische Tags in Kleinschreibung (bewerbung/logistik/familie/bmw/etc.)
- Klarstellung: Tags kennzeichnen Thema, NICHT Aktion

#### B5 — Reasoning-Prompt-Hinweis
Detail-Prompt erweitert um Abschnitt "ERFAHRUNG / RUNBOOKS NUTZEN":
- Wenn Runbook-Section Treffer zeigt UND Insight thematisch passt → explizit referenzieren
- Wenn aktuell gerade Problem gelöst wird → erwähnen dass Runbook automatisch entsteht
- Verifizierte (✓) bevorzugen

### Tests
- 6 neue Vitests für widened triage (passt Bewerbungs-Brainstorming durch, blockt Ramble-only-Sessions)

## [0.19.0-multi-ha.591] - 2026-05-03

### Added — Runbook-System (inspired by Hermes-Agent)

Operational Runbooks (Symptom → Cause → Steps → Verification → Rollback) werden automatisch aus erfolgreichen Problemlösungen erfasst — drei unabhängige Trigger:

- **DB-Migrations v60 (SQLite) + v63 (PG)** — `runbooks` Tabelle mit source_type/source_id Tracking, asset_ids, tags, confidence, usage_count, status (draft/verified/deprecated)
- **`RunbookRepository`** — CRUD + `findMatching(symptomText)` Keyword-Overlap-Search + `findBySource()` Dedup + `incrementUsage()` für Statistik
- **`RunbookSkill`** — Actions: list/get/create/update/delete/mark_verified/mark_deprecated/find_matching. Render-Format mit Markdown (Symptom/Ursache/Schritte/Verifikation/Rollback)

#### Trigger A — ITSM-Incident-Resolution
ITSM-Wrapper aus v589 erweitert: wenn `update_incident` mit `status=resolved/closed` UND substantieller `root_cause` + `resolution` → zusätzlich zum Change-Request-Vorschlag jetzt auch Runbook-Vorschlag via ConfirmationQueue. Dedup über `findBySource('itsm_incident', incidentId)`.

#### Trigger B — Project-Agent-Session-Completion
`ProjectAgentRunner.setCompletionCallback()` neu. Bei erfolgreichem Abschluss mit ≥3 Milestones → Runbook-Vorschlag mit Milestones als Steps. Dedup über `findBySource('project_agent', sessionId)`.

#### Trigger C — Chat-Session-Reflection
Neuer `ChatSessionRunbookReflector` (in `core/reflection/`). Polls alle 5min:
- Findet "ruhige" Conversations (≥30min seit letzter Message)
- Triage: ≥10 Messages UND ≥1 Tool-Call (skill-display als role='tool')
- LLM-Call (default tier, ~1500 Token, temp 0.2) extrahiert strukturiertes JSON mit Confidence
- **Confidence ≥0.8** → ConfirmationQueue an User
- **0.5 ≤ Confidence <0.8** → Auto-Save als Status 'draft' (User reviewt später via WebUI)
- **Confidence <0.5** → Skip
- Dedup-Marker `_internal_runbook_processed:<conv>:<msg>` mit 30-Tage-Expiry verhindert Re-Analyse

#### Reasoning-Collector Integration
Bei aktiven Incidents in der ITSM-Section: für jeden Incident werden über `findMatching()` passende Runbooks gesucht (Keyword-Overlap auf title+symptom+tags). Treffer werden als neue Section "Passende Runbooks für aktive Incidents" gerendert. Verifizierte Runbooks mit ✓ markiert. Damit schließt sich der Lern-Loop: Erfahrene Lösungen werden bei neuen Vorkommnissen automatisch im Prompt zitiert.

### Added
- 17 neue Vitests für Confidence-Routing und Trigger-A/B-Gates

### Nächste Stufe (v592 geplant): Auto-Skill-Creation
Hybride Detection (mechanisch + LLM-Naming) für Skill-Sequenzen, die als Workflows aus wiederholten Mustern abgeleitet werden — wird in eigenem Release vorbereitet wenn Runbook-Funktion in Production kalibriert.

## [0.19.0-multi-ha.590] - 2026-05-02

### Added — Full-Text Chat History Search (inspired by Hermes-Agent)

- **DB-Migrations v59 (SQLite FTS5) + v62 (PG tsvector)** — `messages_fts` virtuelle FTS5-Tabelle mit Auto-Sync-Triggern (Insert/Update/Delete) bzw. `content_tsv` GIN-indexed Spalte mit Update-Trigger. Tokenizer: `unicode61 remove_diacritics 2` (SQLite) / `simple` (PG) — keine Stemming, "BMW" matched exakt "BMW".
- **`ConversationRepository.searchMessages()`** — backend-agnostische FTS-Search mit Cross-Conversation-Recall (User sieht NUR seine eigenen Conversations dank Join auf `conversations.user_id`). Time-decay: 30-Tage-Halbwertszeit, neuere Treffer gewinnen bei gleichem Relevanz-Score. SQLite re-rankt in App-Code, PG nativ via `ts_rank * exp(...)`.
- **Neuer Skill `chat_history`** — Action `search` mit `query`, `limit` (default 10, max 50), `since_days` (optional), `roles` (default user+assistant+tool). LLM kann explizit Historie abfragen wenn "wann haben wir mal über X gesprochen?".
- **Opt-in Reasoning-Collector-Section** — `chatHistory` Section läuft nur wenn ≥1 meaningful keyword aus dem aktuellen Context vorliegt UND FTS-Treffer existieren. Spart Tokens bei No-Context-Passes, liefert Wert wenn relevant.

### Roles indexed
- `user` — was du geschrieben hast
- `assistant` — was Alfred geantwortet hat
- `tool` — Skill-Display-Outputs (BMW SoC, Strompreis-Snapshots, etc.) sind damit auch durchsuchbar

## [0.19.0-multi-ha.589] - 2026-05-02

### Added — ITSM-Lifecycle-Aktivierung (5 Patches)

#### Patch B: Asset-Linking bei Auto-Incident
- Monitor-Wrapper resolved jetzt `affectedAssetIds` aus dem Alert-Message-Text gegen alle bekannten CMDB-Asset-Namen (Wortgrenzen-Match). Fuellt die zuvor leere `affected_asset_ids`-Spalte und macht die Asset-Cluster-Erkennung in Pattern-Detection lebendig.

#### Patch A: Pattern-Detection automatisch
- Nach jedem Auto-Incident-Batch laeuft `problemRepo.detectPatterns(windowDays:14, minIncidents:3)` automatisch
- Fuer jeden detektierten Cluster ohne `existingProblemId` wird eine Confirmation an den User enqueueed: "Pattern erkannt: 4 Incidents zu git-server. Soll ich Problem-Ticket erstellen?"
- Dedup ueber `overlapsBatch`: nur Pattern wo NEUE Incidents involviert sind werden vorgeschlagen — nicht jeden Monitor-Run wieder
- Max 3 Pattern-Vorschlaege pro Batch, 24h Confirmation-Timeout

#### Patch C: Recurrence-Stats im Reasoning-Context
- Reasoning-Collector zeigt jetzt zusaetzlich zu "Aktive Incidents" und "Kuerzlich geloest" eine neue Section: "Wiederkehrende Incident-Muster (Problem-Kandidaten)"
- Gruppiert Incidents der letzten 14 Tage nach normalisiertem Titel (Zahlen/Prozente entfernt)
- Beispiel: "git-server RAM usage: 8× in 14d (1 offen, 7 geloest) → Problem-Kandidat"
- LLM sieht damit Recurrence direkt im Prompt — kann fundiert `create_problem` vorschlagen

#### Patch D: Auto-Change-Vorschlag bei Resolution
- ITSM-Skill-Wrapper detektiert Incident-Transitions zu `resolved`/`closed` mit substantiellen `root_cause` UND `resolution` (≥20 Zeichen each)
- Workaround-Heuristik: Resolution mit "workaround/temporary/temporaer/kurzfristig/notfall/manuell.*neustart" wird ausgefiltert (das sind Quick-Fixes, keine Change-Kandidaten)
- Bei echtem Permanent-Fix: Confirmation enqueueed "Permanenten Fix als Change-Request anlegen?"
- Pre-fillt Change-Request mit Root-Cause + Resolution-Text aus Incident

#### Patch E: Weekly Service-Discovery
- Sonntag 4 AM (zusammen mit Temporal-Analyzer): durchlaeuft alle `active` Assets vom Typ server/vm/lxc/container/application/service
- Erstellt Service-Eintrag fuer jedes Asset, das noch in keinem existierenden Service als `assetIds` referenziert ist
- Asset-Type → Service-Category Mapping (server/vm/lxc → infrastructure, container/application → application)
- Environment → Criticality Mapping (production → high, sonst medium)

### Added
- 8 neue Vitests: 3 fuer Recurrence-Grouping (Patch C), 5 fuer Auto-Change-Suggestion-Gate (Patch D)

### Storage
- Neue Repo-Methode `KnowledgeGraphRepository.setEntityAttributes()` (aus v588 — wholesale-Update)

## [0.19.0-multi-ha.588] - 2026-05-02

### Fixed
- **KG: isHome-Persistenz-Bug — Eichgraben & Co.** — Locations wie Eichgraben (Mutter), Bisamberg (Drittort), Linz (Reise) und Wien (Office) hatten `isHome=true` aus Pre-v578-Zeiten gesetzt. Das "nur setzen, nie loeschen"-Pattern verhinderte automatische Korrektur. Cross-Extractor sortierte nach Confidence und linkte Smart-Home-Items, BMW, Wallbox an die FALSCHE Home-Location (typisch Eichgraben statt Altlengbach). Multi-Layer-Fix:
  1. **`describesOtherPersonsHome()` Helper** in beide Extraction-Pfade (extractFromMemories + syncMemoryEntities) — checkt KEY und VALUE auf Marker (mother/mutter/freund/etc.)
  2. **Neues Attribut `isUserHome=true`** — strikter Anker, nur bei eindeutig User-bezogenen Memories gesetzt. Cross-Extractor nutzt isUserHome (Fallback isHome ohne Other-Person-Marker im Address-Text)
  3. **Konflikt-Auflösung** — bei mehreren Kandidaten Warning + älteste firstSeenAt gewinnt
  4. **Maintenance-Cleanup** — taeglicher KG-Maintenance-Lauf clearrt isHome auf Locations deren Address-Attribut Other-Person-Marker enthaelt UND kein isUserHome=true gesetzt ist
- **KG-Repository: `setEntityAttributes()`** — neue Methode fuer wholesale-Update von Entity-Attributen (vorher nur additiv via upsertEntity moeglich)

### DB-Cleanup (one-shot, durchgeführt auf .91 Postgres)
- isHome geloescht auf: Eichgraben, Bisamberg, Linz, Wien (Wien behaelt isWork=true)
- isWork geloescht auf: Altlengbach
- isUserHome=true gesetzt auf: Altlengbach (kanonischer User-Home-Anker)
- 50 falsche cross-extractor Relations geloescht (home_location/located_at zu Eichgraben/Bisamberg/Linz/Wien)

### Added
- 13 neue Vitests fuer `describesOtherPersonsHome()` inkl. Regression-Test fuer den Eichgraben-Bug

## [0.19.0-multi-ha.587] - 2026-05-02

### Fixed
- **Confirmation-Queue: Falsche Auto-Resolve-Heuristik (Mismatch-Bug)** — Wenn der User eine ITSM-Incident-Bestätigung approvte, wurden andere ITSM-Incidents mit nur 2 gemeinsamen Generic-Wörtern (z.B. "ITSM", "dokumentieren") faelschlich als 'expired' markiert. Druckte beim spaeteren Klick auf den 2. Inline-Button "keine zugehoerige offene Aktion" und LLM-Fallback. Behoben durch Topic-Key-basierte Deduplication (siehe `computeTopicKey()`).
- **Confirmation-Queue: Klare Fehlermeldung bei stale Inline-Buttons** — Wenn die Callback-ID auf eine bereits resolvte Bestaetigung zeigt (approved/rejected/expired), antwortet das System jetzt explizit ("ℹ️ Diese Aktion wurde bereits freigegeben am ...") statt durchzufallen zum LLM. Neue Repo-Methode `getByIdAnyStatus()`.

### Changed
- **Confirmation-Queue: Topic-Key-Algorithmus** — `computeTopicKey()` extrahiert kanonisches Topic-Signal pro Bestaetigung. Per-Skill-Regeln: ITSM nutzt `skill_params.title`, Workflow/Watch nutzen `name`, Reminder nutzt erste 8 Worte der Message, generischer Fallback nutzt sortierte Description-Tokens. Auto-Resolve dedupliziert nur bei exaktem Topic-Key-Match.

### Added
- 10 Vitests fuer `computeTopicKey` inkl. Regression-Test fuer den UniFi/Commvault-Bug.

## [0.19.0-multi-ha.586] - 2026-05-01

### Fixed (rollback + correction von v585)
- **Reasoning: Resolver-Pipeline aus deliverOrDefer ENTFERNT** — Der v585-Patch annotierte Datums-Phrasen in LLM-Insight-Output mit `(=YYYY-MM-DD)` basierend auf "now". Das war FALSCH: wenn der LLM "morgen" halluziniert hat (echter Termin Tage entfernt), zementierte die Annotation das halluzinierte Datum programmatisch. Insights verlassen den Reasoning-Pass jetzt unverändert.
- **Reasoning: ABSOLUTE-DATEN-REGEL korrigiert** — Statt fabrizierter Beispiele jetzt klare Anweisung: KOPIERE Datum WÖRTLICH aus Quelle (Calendar/Memory/Korrektur), berechne NICHT selbst. Pflicht-Cross-Check: steht GENAU dieses Datum in der Calendar- oder Memory-Section? Wenn nicht → Datum komplett weglassen.

## [0.19.0-multi-ha.585] - 2026-05-01

### Fixed
- **Reasoning: Insights mit absolut-annotierten Datumsangaben** — Insights vom LLM laufen jetzt ebenfalls durch `resolveRelativeDates()` bevor sie an den User geschickt werden. Bisher wurde nur Memory-Save-Path resolved; Insights mit "morgen 07:00" oder "in 3 Tagen" gingen unannotated raus. Jetzt: idempotente Annotation beim Versand → "morgen (=2026-05-02) 07:00"
- **Reasoning Detail-Prompt: ABSOLUTE-DATEN-REGEL** — Explizite Pflicht-Regel mit Beispielen FALSCH/RICHTIG fuer LLM-Insight-Output. NIEMALS "morgen/heute/uebermorgen/in X Tagen/Montag/etc.", IMMER "Wochentag DD.MM. HH:MM". Sprache muss tagunabhaengig verstaendlich sein.

## [0.19.0-multi-ha.584] - 2026-05-01

### Added
- **WebUI: Memories-Seite** (`/alfred/memories/`) — Liste aller User-Memories mit Status-Badges (AKTIV/RESOLVED/EXPIRED/ABGELAUFEN), Type-Filter (correction/preference/fact/entity/general/pattern), Volltext-Suche, manuellem Löschen. Zeigt erfasst/aktualisiert/Quelle/Konfidenz/relevant_until/expires_at/source_event_refs pro Eintrag
- **API: GET /api/memories** und **DELETE /api/memories/:id** — neue Endpoints im HTTP-Adapter mit Auth-Check, optional `?type=correction` Filter

## [0.19.0-multi-ha.583] - 2026-05-01

### Added
- **Memory: `relevant_until` Spalte** — Migration v58 (SQLite) + v61 (PG). Korrekturen mit temporalen Ausdruecken bekommen automatisch ein Gueltigkeitsdatum (max. aus allen `(=YYYY-MM-DD)` Annotations im Wert). Nach Ablauf werden sie aus dem Korrektur-Block des Reasoning-Prompts gefiltert, bleiben aber in der DB als historische Referenz.
- **Memory: `source_event_refs` Spalte** — Selbe Migration. `_resolved`-Korrekturen bekommen entweder vom LLM uebergebene oder automatisch extrahierte Source-Identifier (Rechnungsnummern, Email-IDs, ISO-Daten). Damit blockiert eine Korrektur "Anthropic ist bezahlt (betrifft: invoice:INV-2026-04-001)" eine NEUE Rechnung INV-2026-05-001 NICHT mehr.
- **Reasoning: Korrektur-Block mit Vorgangs-Gueltigkeit** — Detail-Prompt erklaert dem LLM dass `_resolved` Korrekturen NUR die in "betrifft: ..." gelisteten Vorgaenge blockieren. Neue Vorgaenge mit anderen Refs sind eigene Insights.
- **Reasoning: Backup-Audit-Hook** — `auditResolvedCorrectionOverlap()` loggt wenn Insights mit `_resolved` Korrekturen ueberlappen — als Audit-Trail, ohne Insights zu blockieren (failsafe = durchlassen).
- **Helpers: `extractRelevantUntil()` und `extractSourceEventRefs()`** — neue Util-Funktionen mit 8 Vitests. Erkennen Rechnungsnummern (INV-/RE-/RG-), Email-Message-IDs (`<msg@host>`), Calendar-Refs (`evt:xxx`), ISO-Daten.

### Fixed
- **Memory: Auto-Expiry fuer `_resolved` Korrekturen** — Beim Save automatisch `expires_at = +30 Tage`. Bestehende `_resolved` ohne Expiry bekommen via Migration nachgeholt.
- **Memory-Skill: `source_event_refs` Input-Parameter** — LLM kann beim Save explizit angeben welche Vorgaenge geloest werden. Auto-Extraction aus Wert als Fallback.
- **Reasoning-Collector: Memory-Render mit Annotations** — `(erfasst YYYY-MM-DD; gültig bis YYYY-MM-DD; betrifft: refs)` werden in jede Memory-Zeile geschrieben. Abgelaufene Korrekturen markiert mit "abgelaufen seit YYYY-MM-DD" und vom Reasoning-Engine geskippt.
- **MemoryConsolidator: Pair-Cleanup** — Wenn `correction_x_resolved` existiert, wird das Original `correction_x` automatisch geloescht. Zweistufig: exakter Prefix-Match zuerst, Fallback auf Keyword-Overlap (≥3 Token, ≥5 Zeichen).
- **MemoryConsolidator: Legacy-Migration v582** — Einmalig beim Startup, idempotent via Marker-Memory `_alfred_internal_migration_v582_dates_done`. Resolvet bestehende relative Datumsangaben gegen jeweiliges `updated_at`, fuellt `relevant_until` und `source_event_refs` nach.

## [0.19.0-multi-ha.582] - 2026-05-01

### Fixed
- **KG: Self-referenzielle Pseudo-Entities geblockt** — Memory-Keys mit Prefix `connection_*`, `kg_connection_*`, `insight_*`, `pattern_*`, `temporal_*`, `action_feedback_*`, `llm_usage_*` werden in `extractFromMemories` und `syncMemoryEntities` ignoriert. Vorher wurden Alfreds eigene Cross-Domain-Reflektion-Memories als event-Entities ins KG zurueckgefuettert (115 Pseudo-Entities mit ~400 Junk-Relationen)
- **KG: Asymmetrie-Guard fuer Relations** — `kg_relations.upsertRelation` lehnt inverse Richtung asymmetrischer Relationen ab (parent_of, child_of, works_at, plays_at, member_of, employs, caused_by, depends_on, part_of, owns u.a.). Wenn `User parent_of Sohn` existiert, wird `Sohn parent_of User` blockiert
- **KG: Type-Validierung fuer Relations** — Neuer zentraler Helper `validateRelationTypes()` prueft Source/Target-Type-Kompatibilitaet pro Relation: parent_of nur Person-Person, works_at nur Person-Organization, located_at nur any-Location, same_as nur gleiche Typen. Genutzt vom LLM-Linker und global aufrufbar
- **KG: Markdown-Sanitization bei Text-Extraktion** — `sanitizeEntityName()` entfernt `**`, `__`, Backticks und trailing punctuation vor Entity-Erstellung. Verhindert Pollution durch fettgedruckte Insight-Fragmente wie "Gerichtsentscheidung**" oder "Treffen Sonntag**"

### Cleanup (DB)
- 115 `connection_*` / `kg_connection_*` event-Entities geloescht (mit 395 Junk-Relationen)
- 2 Markdown-pollutierte Entities geloescht
- 12 falsche `parent_of`-Relationen mit Sohn/Tochter als Source geloescht
- 4 falsche `parent_of`-Relationen Maria Dohnal → Enkel geloescht (sollte grandparent_of sein)
- 221 `connection_*` Memory-Eintraege geloescht (Quelle der Selbstrekursion)
- KG-Relations: 1225 → 815 (~33% Junk eliminiert)

## [0.19.0-multi-ha.581] - 2026-05-01

### Fixed
- **OpenAI gpt-5.5: Tools + reasoning_effort Incompatibility** — chat/completions Endpoint akzeptiert bei gpt-5.5 nicht beides gleichzeitig (API verlangt /v1/responses). Wenn Tools im Request, wird reasoning_effort weggelassen → gpt-5.5 nutzt Default-Effort (medium). Tool-lose Calls (z.B. Reasoning-Engine Scan-Pass) behalten den Effort-Parameter

## [0.19.0-multi-ha.580] - 2026-05-01

### Added
- **OpenAI: GPT-5.5 Support** — Frontier-Reasoning-Modell mit 1.05M Context und 128k Output Token. Pricing $5/$30/$0.50 per 1M (Input/Output/Cache-Read), >272K Tokens 2x/1.5x Multiplikator. Knowledge Cutoff 2025-12-01
- **LLM: `reasoning_effort` Parameter** — Optionales `reasoningEffort` Feld auf `LLMRequest` (`none`/`low`/`medium`/`high`/`xhigh`). Steuert Tiefe interner Reasoning-Tokens bei Reasoning-Modellen (gpt-5.5, o-series). Andere Modelle ignorieren den Parameter
- **Model-Router: Tier-Default-Effort** — Automatisches Effort-Mapping je Tier: `fast=low`, `default=medium`, `strong=high`. Spart Output-Tokens bei Reasoning-Modellen ohne Code-Anpassungen in Skills

### Fixed
- **OpenAI Provider: Reasoning-Model-Erkennung** — Regex erweitert um gpt-5.5 (matched jetzt o1-9, gpt-5/5.0/5.1/5.5; chat-Modelle gpt-5.2/5.3/5.4 weiterhin mit Temperature)
- **Token-Costs: Long-Prompt-Multiplikator** — gpt-5.5 Input >272K Tokens wird mit 2x Input und 1.5x Output abgerechnet (offizielle OpenAI-Preisstaffelung)

## [0.19.0-multi-ha.579] - 2026-05-01

### Fixed
- **Memory/Reminder: Relative Zeitangaben werden beim Speichern aufgeloest** — Ausdruecke wie "morgen", "Montag", "naechste Woche", "in 3 Tagen" werden zum Speicherzeitpunkt zu absoluten Datumsangaben annotiert (z.B. "warte bis Montag (=2026-04-27)"). Damit wandert "Montag" nicht mehr mit dem aktuellen Datum mit, und Korrekturen bleiben semantisch stabil ueber Tage hinweg
- **Reasoning: Memory-Erfassungsdatum im Prompt** — Memories und Korrekturen werden mit "(erfasst YYYY-MM-DD)" annotiert. Das LLM kann relative Zeitangaben jetzt korrekt gegen das Erstellungsdatum aufloesen, statt jeden Pass aus heutiger Sicht neu zu interpretieren
- **Reasoning: Korrektur-Block mit Zeit-Hinweis** — Der Hard-Block fuer Korrekturen erklaert dem LLM explizit, dass relative Zeitangaben sich auf das erfasste-Datum beziehen, nicht auf heute

### Added
- **Skills: relative-date-resolver** — Neue Util-Funktion `resolveRelativeDates()` mit 21 Tests: Wochentage (DE/EN), heute/morgen/gestern, in X Tagen/Wochen/Monaten, naechste Woche/Monat/Jahr. Idempotent, Unicode-aware Boundaries fuer Umlaute

## [0.19.0-multi-ha.575] - 2026-04-17

### Improved
- **Reasoning: Strukturierter Scan** — Scan-Pass antwortet als JSON mit Urgency-Stufen (urgent/high/normal/low) statt Freitext
- **Reasoning: Urgency-Gate** — Nur urgent/high Items werden sofort gesendet, normal wird deferred, low wird verworfen
- **Reasoning: Anti-Halluzination** — Fakten-Regel im Detail-Prompt: keine geschaetzten Zahlen/Entfernungen/Preise
- **Reasoning: Memory-Zeitaufloesung** — Relative Zeitangaben in Memories werden gegen Erstellungsdatum geprueft
- **KG: isHome Guard** — `isHome` wird nur fuer User-eigene Adressen gesetzt, nicht fuer Adressen von Familienmitgliedern/Freunden

## [0.19.0-multi-ha.561] - 2026-04-18

### Added
- **Deploy: Auto Git-Token Injection** — Wenn ein GitLab/GitHub Token in der Forge-Config (ALFRED_GITLAB_TOKEN) vorhanden ist, wird er automatisch in HTTP Git-URLs injiziert. Kein manuelles Token in der repo_url noetig

## [0.19.0-multi-ha.568] - 2026-04-19

### Added
- **Project Agent: Session History** — Planner bekommt vorherige Sessions (Goal + Milestones) als Kontext, baut auf bestehender Arbeit auf statt blind zu starten
- **Project Agent: Already-Running Check** — Neue Session wird abgelehnt wenn fuer dasselbe Verzeichnis bereits ein Agent laeuft
- **Project Agent: Interjections per Iteration** — User-Nachrichten werden vor jedem Coding- und Fix-Step verarbeitet statt nur einmal pro Phase
- **Project Agent: Consumed statt Delete** — Interjections werden als consumed markiert statt geloescht (Migration v57 SQLite / v60 PG)
- **Project Agent: Dynamische Phasen** — LLM entscheidet selbst ueber Phasenanzahl (2-4 einfach, 5-8 mittel, 9-15 komplex) statt fixes "Max 8"
- **Project Agent: Runner-Fehler geloggt** — Fehler werden per console.error ausgegeben statt verschluckt

## [0.19.0-multi-ha.560] - 2026-04-18

### Fixed
- **Deploy Default-Branch** — Erkennt automatisch den Default-Branch (main/master/etc.) per `git ls-remote --symref` statt hardcoded `main`
- **PM2 Start-Befehl** — `pm2 start npm --name X -- start` statt fehlerhaftem `pm2 start npm start --name X`
- **Deploy SSH Git-URL** — `git@host:user/repo.git` Format wird akzeptiert

### Added
- **Docker Bridge IP bei Provision** — `clone_vm runtime=docker docker_bridge_ip=192.168.248.1/24` konfiguriert daemon.json automatisch

## [0.19.0-multi-ha.558] - 2026-04-18

### Fixed
- **Deep Scan SSH-User** — SSH User wird jetzt intelligent ermittelt: expliziter `ssh_user` Parameter > Asset-Name-Erkennung (ubuntu/rocky/debian/fedora) > Config-Default. Cloud-Init VMs mit anderem User als Config-Default funktionieren jetzt

## [0.19.0-multi-ha.557] - 2026-04-17

### Fixed
- **Shell-Skill: SSH Remote-Commands nicht mehr geblockt** — Dangerous-Pattern-Check wird fuer SSH-Befehle uebersprungen. Remote-Befehle (sudo, tee, systemctl) auf anderen Hosts sind keine lokale Gefahr. Vorher wurde z.B. `ssh host 'sudo systemctl restart docker'` als "destructive" abgewiesen

## [0.19.0-multi-ha.556] - 2026-04-17

### Added
- **Proxmox clone_vm mit runtime Parameter** — `clone_vm` kann jetzt direkt nach VM-Erstellung Docker/Node/Python installieren. Kein Umweg ueber deploy Skill noetig. LLM muss nur `proxmox clone_vm runtime=docker` aufrufen. Ablauf: Clone → Cloud-Init → Start → SSH warten (3 Min.) → Runtime + qemu-guest-agent installieren
- **Cloud-Init User-Erkennung** im Proxmox-Skill — ubuntu/rocky/debian/fedora automatisch

## [0.19.0-multi-ha.555] - 2026-04-17

### Added
- **qemu-guest-agent** — Wird bei jeder neuen VM/LXC automatisch installiert + aktiviert
- **Provision Skill-Beschreibung** — Klarer formuliert damit LLM `deploy provision` statt `proxmox clone_vm` waehlt

## [0.19.0-multi-ha.554] - 2026-04-17

### Added
- **Deploy `provision` Action** — VM/LXC erstellen + Runtime installieren ohne Code-Deploy. "Erstelle eine Ubuntu VM mit Docker" funktioniert jetzt ohne project/repo_url
- **SSH Retry-Schleife** — Wartet bis zu 3 Minuten auf SSH (alle 15s prüfen) statt nur 45s. Cloud-Init braucht oft 60-120s

## [0.19.0-multi-ha.553] - 2026-04-17

### Fixed
- **Proxmox SSH Key Auto-Injection** — clone_vm und create_lxc lesen SSH Public Key automatisch aus `infra.sshKeyPath` Config. Vorher wurde der Key nur bei full_deploy injiziert, bei direktem clone_vm/create_lxc fehlte er

## [0.19.0-multi-ha.552] - 2026-04-17

### Added
- **Cloud-Init User-Erkennung** — Template-basierte automatische User-Erkennung fuer SSH nach VM-Erstellung:
  - Ubuntu → `ubuntu`, Rocky/Alma/CentOS → `cloud-user`, Debian → `debian`, Fedora → `fedora`, LXC → `root`
  - User kann per `user` Parameter ueberschrieben werden
- **Multi-OS Template Support** — Rocky Linux, Alma, CentOS, Fedora neben Ubuntu/Debian:
  - Paketmanager-Erkennung (apt vs dnf) fuer Node.js, Python, Docker Installation
  - dnf-basiertes NodeSource Setup fuer RHEL-Familie
- **SSH Key Warnung** — Hinweis wenn kein SSH Public Key fuer Cloud-Init gefunden wird
- **Docker-Gruppe Auto-Setup** — Nach VM-Erstellung wird der Cloud-Init User automatisch zur docker-Gruppe hinzugefuegt (fuer Deep Scan)

## [0.19.0-multi-ha.551] - 2026-04-17

### Added
- **Post-Deploy Automation** — Nach `full_deploy` werden automatisch 3 Schritte ausgefuehrt (fire-and-forget):
  1. CMDB Proxmox Discovery — VM/LXC als Asset registrieren
  2. Deep Scan — System-Doku generieren + Docker Container als Assets registrieren
  3. Service-Erstellung — LLM erstellt Service aus Projekt-Beschreibung mit erkannten Komponenten
  - Ergebnis: Vom `full_deploy` bis zum vollstaendigen Service mit Doku — ein Befehl

## [0.19.0-multi-ha.550] - 2026-04-17

### Fixed
- **Deep Scan Docker Auto-Registration** — Vollstaendig funktional: SSH-Callback gibt reinen stdout, Space-Split Parser, updateAsset mit sourceSkill/sourceId, kein sudo (Shell-Skill Block). Diagnose-Logs entfernt

## [0.19.0-multi-ha.549] - 2026-04-17

### Fixed
- **Deep Scan Docker** — `sudo` Fallback entfernt: Shell-Skill blockiert `sudo` als "dangerous pattern", wodurch der gesamte Docker-Command fehlschlug. Docker-Zugriff stattdessen ueber docker-Gruppenmitgliedschaft des SSH-Users

## [0.19.0-multi-ha.546] - 2026-04-17

### Fixed
- **CmdbRepository.updateAsset** — `sourceSkill` und `sourceId` Felder waren nicht in der Update-Map, konnten daher nicht aktualisiert werden. Deep Scan Container-Assets blieben deshalb auf source_skill=NULL

## [0.19.0-multi-ha.545] - 2026-04-17

### Fixed
- **Deep Scan SSH-Callback** — Gibt jetzt reinen stdout zurueck statt formatierten Shell-Output mit "stdout:" Prefix und "exit code:" Suffix. Das war der Grund warum Docker-Container nicht als Assets registriert wurden

## [0.19.0-multi-ha.544] - 2026-04-17

### Fixed
- **Deep Scan Docker Container-Parsing** — `docker ps` Output wird jetzt korrekt geparst (Space-Split statt nur Tab-Split), bestehende manuelle Assets werden aktualisiert statt Duplikate zu erstellen, `findAssetByName` Methode im CmdbRepository

## [0.19.0-multi-ha.543] - 2026-04-17

### Fixed
- **Deep Scan Docker Command** — `sudo -n` (non-interactive) Fallback, verhindert haengendes Password-Prompt

## [0.19.0-multi-ha.542] - 2026-04-17

### Fixed
- **Deep Scan Docker Command** — Fallback auf `sudo docker ps` wenn User keine Docker-Gruppenrechte hat

## [0.19.0-multi-ha.541] - 2026-04-17

### Added
- **Deep Scan: Docker Container als CMDB-Assets** — SSH Deep Scan auf einer VM registriert entdeckte Docker Container automatisch als Assets (Typ: container) mit `runs_on` Relation zum Host
- **Docker Discovery: runs_on Relation** — Docker Discovery Source erstellt jetzt `runs_on` Relationen (Container → Host-VM) per IP-Match

## [0.19.0-multi-ha.540] - 2026-04-17

### Added
- **Service bearbeiten (WebUI)** — Vollstaendiger Edit-Dialog mit 4 Tabs:
  - Grunddaten: Name, Beschreibung, Kritikalitaet, Environment, Owner, URL
  - Komponenten: Hinzufuegen/Entfernen/Bearbeiten inkl. CMDB-Asset, parentComponent, failureImpact
  - Failure Modes: CRUD mit betroffenen Komponenten (Checkbox), Trigger, Impact, Kaskadeneffekte
  - SLA: Aktivieren/Deaktivieren, Verfuegbarkeit-%, MTTR, Response/Resolution-Zeiten, Breach-Alert

## [0.19.0-multi-ha.539] - 2026-04-17

### Fixed
- **Service-Erstellung WebUI** — Komponenten, Failure-Modes und SLA werden jetzt beim Erstellen ueber den Wizard korrekt gespeichert (createService → updateService fuer JSON-Felder)

## [0.19.0-multi-ha.538] - 2026-04-17

### Changed
- **Claude Opus 4.7 Support** — Neues Modell `claude-opus-4-7` (1M Context, 128k Output, $5/$25)
- **Model-Defaults aktualisiert** — Default: `claude-sonnet-4-6`, Strong: `claude-opus-4-7` (deprecated `claude-sonnet-4-20250514`/`claude-opus-4-20250514` ersetzt)
- **Pricing-Tabelle** — `claude-opus-4-7` + `claude-opus-4-1` Eintraege hinzugefuegt

## [0.19.0-multi-ha.537] - 2026-04-17

### Added
- **Hierarchische Komponenten** — Parent-Child Beziehungen fuer Service-Komponenten:
  - `parentComponent` Feld: VM → Docker Container Hierarchie (max 3 Ebenen)
  - `failureImpact` Feld: Expliziter Impact-Override (down/degraded/no_impact) pro Komponente
  - Health-Check: Topologische Sortierung (Parents zuerst), automatische Propagation Parent→Kind
  - Validierung: Zirkul. Referenzen + Max-Tiefe bei add_component
  - WebUI: Hierarchischer Graph (grosse Parent-Nodes, kleine Children, gestrichelte Links)
  - Wizard: Parent-Komponente im Erstellen-Dialog waehlbar
- **SLA Management** — Optionale SLAs auf Service- und Asset-Ebene:
  - `SlaDefinition` Interface: Availability-%, MTTR, Response/Resolution-Zeiten, Breach-Alerts
  - `sla_events` Tabelle: Uptime/Downtime-Tracking, Breach/Warning Events
  - Health-Check SLA-Tracking: Automatische Event-Erstellung bei Status-Aenderungen, Compliance-Pruefung
  - 4 neue ITSM-Actions: `set_sla`, `get_sla_report`, `check_sla_compliance`, `list_sla_breaches`
  - 4 API-Endpoints: /api/sla/set, /api/sla/report/:type/:id, /api/sla/compliance, /api/sla/breaches
  - WebUI: SLA-Sektion mit Verfuegbarkeits-Balken, Compliance-Status, MTTR/Response-Targets
  - Reasoning: SLA-Breaches im Context Collector fuer proaktive Benachrichtigung
  - Migration v56 (SQLite) / v59 (PG): sla Spalten + sla_events Tabelle

## [0.19.0-multi-ha.535] - 2026-04-17

### Added
- **Service Management System** — Vollstaendiges Service-Management mit Failure-Modes, Impact-Analyse und Auto-Dokumentation:
  - **Service per Chat erstellen:** `create_service_from_description` — User beschreibt Service natuerlich ("Alfred HA Cluster: .91 ist DB, .92 node-a, .93 node-b"), LLM parst Komponenten + Failure-Modes, matcht CMDB-Assets
  - **Failure-Mode CRUD:** `add_failure_mode`, `remove_failure_mode`, `update_failure_mode` — pro Service definierbar mit Trigger, Impact (down/degraded), Cascade-Effekte, Recovery-Zeit
  - **Impact-Analyse:** `service_impact_analysis` — "Was passiert wenn .91 ausfaellt?" zeigt alle betroffenen Services mit Impact + Failure-Mode-SOPs
  - **Auto-Doku:** `generate_service_docs` — Background-Generierung: Service-Doku + SOP pro Failure-Mode aus vorhandenen System-Dokus (Deep-Scan)
  - **N:M Asset-Sharing:** Ein Asset kann in mehreren Services unterschiedliche Rollen/Impact haben (z.B. PostgreSQL: required fuer Alfred, optional fuer Monitoring)
  - **ITSM-Integration:** create_incident erkennt automatisch Service-Impact und zeigt betroffene Services
  - **WebUI /services:** Service-Liste mit Health-Status, ForceGraph2D Komponentengraph, Failure-Mode Editor, Linked Documents, 4-Schritt Erstellen-Wizard
  - **9 API-Endpoints:** /api/services CRUD + failure-modes + impact + generate-docs
  - **Migration v58:** failure_modes JSON-Spalte auf cmdb_services

## [0.19.0-multi-ha.529] - 2026-04-17

### Added
- **IT Documentation Platform (Phase B — WebUI)** — Vollstaendiger Dokumentations-Browser im WebUI:
  - **Baumansicht:** Sidebar mit Assets, Services, und unverknuepften Dokumenten. Eingeklappt/Ausgeklappt per Klick. Doc-Count Badges
  - **Dokument-Viewer:** Markdown-Rendering mit react-markdown + remark-gfm. Dark-Theme Syntax-Highlighting fuer Code-Bloecke, Tabellen, Listen
  - **Inline-Editor:** Textarea + Live-Markdown-Preview Side-by-Side. Speichern erstellt neue Version
  - **Versionen-Panel:** Alle Versionen mit Datum und Generator. Klick laedt aeltere Version
  - **Erstellen-Dialog:** Dokumenttyp waehlen, Titel, optionale Entity-Verknuepfung, Markdown-Content
  - **Suche:** Volltextsuche ueber alle Dokumente
  - **Loeschen:** Mit Bestaetigungs-Schritt
  - **Generator-Tab:** Bestehende Generate/Export Funktionalitaet bleibt erhalten
  - **API Client:** 7 neue Methoden (fetchDocTree, fetchDoc, fetchDocVersions, createDoc, updateDoc, deleteDoc, searchDocs)

- **IT Documentation Platform (Phase C — DocReflector)** — Monatliche automatische Dokumentations-Pflege:
  - **Stale-Doc-Erkennung:** Dokumente aelter als 90 Tage → "Update empfohlen" Vorschlag
  - **Runbook-Validierung:** Prueft ob verknuepfte Assets noch existieren. Geloeschte/decommissioned → Warnung
  - **Config-Snapshot-Freshness:** Assets ohne aktuellen Config-Snapshot (>30 Tage) → Vorschlag
  - **Konfigurierbar:** reflection.docs.configSnapshotIntervalDays, staleDocWarningDays, runbookValidation

## [0.19.0-multi-ha.528] - 2026-04-17

### Added
- **IT Documentation Platform (Phase A)** — InfraDocs Skill von 7 auf 25 Actions erweitert. Vollstaendiges Dokumentations-Management per Chat:
  - **CRUD (6 Actions):** create_doc, get_doc, update_doc, delete_doc, list_docs, search_docs — Volltextsuche ueber Titel + Inhalt
  - **Auto-Generate (4 Actions):** generate_system_doc (Asset-Scan via CMDB/Proxmox/Docker), generate_service_doc (Service + Komponenten), generate_network_doc (MikroTik/pfSense/Cloudflare/UniFi), generate_config_snapshot (Config-Dump)
  - **Runbook Management (5 Actions):** create_runbook (manuell oder LLM-generiert aus Incident/Service-Kontext), get_runbook, update_runbook, suggest_runbook (Keyword-Match gegen Incidents), execute_runbook (Schritte als Workflow-Steps)
  - **Versioning (3 Actions):** doc_versions (alle Versionen auflisten), doc_diff (zeilenweiser Vergleich), doc_revert (auf aeltere Version zuruecksetzen)
  - **9 Dokumenttypen:** system_doc, service_doc, setup_guide, config_snapshot, runbook, sop, network_doc, policy, custom
  - **ITSM Integration:** Auto-Suggest passende Runbooks bei Incident-Erstellung (Keyword-Match auf Titel + Symptoms)
  - **CMDB Integration:** asset_docs Action — alle Dokumente fuer ein Asset/Service auflisten
  - **API Endpoints (8 neu):** /api/docs/list, /api/docs/tree, /api/docs/search, /api/docs/{id}, /api/docs/{id}/versions, POST/PATCH/DELETE
  - **DB Migration v57:** runbook_id Spalte auf cmdb_change_requests
  - **Repository:** searchDocuments, getDocumentVersions, updateDocument, deleteDocument, getDocumentTree

## [0.19.0-multi-ha.526] - 2026-04-17

### Added
- **Commvault Skill: Vollstaendiger Ausbau — 60 Actions, 8 Module** — Komplette CommServe-Administration per Chat. Gegen offizielle OpenAPI3 Spec (246 Endpoints) validiert:
  - **Storage (12 Actions):** Alle Pool-Typen (Disk, Cloud, Local, HyperScale, Tape) + CRUD + DDB + Arrays + Backup Locations + Mount Content
  - **Jobs (7):** Liste, Detail, Historie, Start/Stop/Retry, Browse Backup-Daten
  - **Plans (8):** Server/Laptop Plans CRUD, Auto-Assignment Regeln, Entity-Zuweisung
  - **Clients (8):** Clients, Server, Gruppen, Subclients, VMs, File Server, Retire
  - **Media Agents (4):** Liste, Detail, DDB Media Agents, Installation
  - **Alerts (8):** Triggered Alerts (List/Detail/Read/Pin/Delete/Notes), Definitionen, Typen
  - **Commcell (12):** Operations Enable/Disable (9 Ops), Settings, Lizenz, Schedules, Replication, Failover, Recovery Targets, Anomalien
  - **Monitoring (4):** Status, SLA Report, LLM-Analyse, Anomalien
  - Modulare Architektur: `commvault/` Verzeichnis mit 8 separaten Dateien statt einer 786-Zeilen Datei
  - HIGH_RISK Actions (Create/Delete/Retire/Failover/Enable/Disable) erfordern Confirmation

## [0.19.0-multi-ha.524] - 2026-04-17

### Fixed
- **Commvault API: Storage + Alerts gegen offizielle API-Doku korrigiert**
  - **Storage Pool-Name:** `storagePoolEntity.storagePoolName` statt direkt `storagePoolName` (verschachtelt laut API-Docs)
  - **Storage Free Space:** `totalFreeSpace` statt `freeCapacity` (falscher Feldname laut API-Docs)
  - **Alerts Endpoint:** `GET /V4/Alert` statt `/AlertRule` — AlertRule listet Alert-DEFINITIONEN, nicht ausgeloeste Alerts. Fallback auf AlertRule wenn V4 nicht verfuegbar
  - **Alert Severity:** String-basiert (`CRITICAL`, `MAJOR`, `INFORMATION`) statt numerisch (1, 2, 3) laut API-Docs
  - **Alert Felder:** `info` statt `alertName`, `notes` statt `description`, `detectedTime` als Unix-Epoch
  - Alle 6 betroffenen Code-Stellen korrigiert (getStorage, getAlerts, getStatus, getReport/analyze, pollAndReport, buildReasoningContext)
- **Reasoning: Email-Chronologie im Prompt** — Neue Regel: Receipt/Invoice/Bestätigung NACH einer Fehler-Email (payment failed, error, suspended) bedeutet Problem GELÖST. Die neuere Email hat Vorrang. Verhindert dass das LLM "Zahlungsmethode aktualisieren" meldet obwohl eine Receipt-Email die Bezahlung beweist
- **Chat: User-Bestätigungen als Correction speichern** — Wenn der User sagt "ist bezahlt/erledigt/gefixt" als Reaktion auf ein von Alfred gemeldetes Problem, speichert Alfred das jetzt als `type: correction` (nicht `fact`). Corrections landen im harten Korrekturen-Block des Reasoning-Prompts und werden nicht ignoriert
- **Reasoning: AUTO-Emails bei Problem-Lösung beachten** — Receipt-Emails mit ℹ️ AUTO Status werden nicht mehr pauschal als "ignorieren" behandelt wenn sie ein vorheriges Problem lösen

### Fixed
- **Logging: Log-Rotation mit Datum im Dateinamen** — pino-roll `dateFormat` Option aktiviert: `alfred.log.2026-04-17` statt `alfred.log.1`. Loesung fuer das Problem dass pino-roll bei Prozess-Neustarts die Nummerierung nicht korrekt fortfuehrt (schrieb in alte `.1` statt neue `.3` zu erstellen). Dateien mit Datum sind eindeutig und ueberleben Restarts. LogViewer: Datei-Suche per Directory-Scan statt nummeriertem Pattern (erkennt beide Formate). Audit-Logger ebenfalls umgestellt

### Changed
- **Reasoning: Kontext-Aware Memory Retrieval** — Memories werden nicht mehr blind nach Confidence geladen sondern passend zum aktuellen Kontext. Zwei-Phasen-Collect: Phase 1 fetcht alle Sections ausser Memories parallel, Phase 2 extrahiert Keywords aus den Ergebnissen und sucht passende Memories. Wenn der Kalender "Kapfenberg" enthaelt, wird die Kapfenberg-Correction geladen. Wenn Email "Anthropic" enthaelt, wird der "bezahlt"-Fact geladen. Garantierte Slots: corrections(10) + preferences(5) + patterns(5). Kontext-Match fuellt dynamisch auf. maxTokens 1200. Latenz: +11ms pro Pass

### Fixed
- **Reasoning: Erledigte Themen wurden nicht als erledigt erkannt** — Wenn der User "ist bezahlt/erneuert" sagt, speichert Alfred das als `fact` (confidence 1.0). Facts mit confidence 1.0 wurden von der Memory-Priorisierung verdraengt. Fix: Memory-Priorisierung nach Confidence >= 1.0 (exakt user-bestaetigte) VOR patterns/connections. Corrections-Block bleibt nur fuer `[correction]` Type (keine Facts, zu hohes Risiko fuer false-positives)
- **Reasoning: ACK-Wörter fuer Insight-Resolved erweitert** — "bezahlt", "erneuert", "aktualisiert", "gefixt", "gelöst", "behoben" triggern jetzt das insight_resolved System (vorher nur "danke/ok/erledigt/done"). "bereits" und "schon" bewusst NICHT aufgenommen (zu generisch, wuerden false-positives erzeugen)
- **Reasoning: Corrections wurden aus Memory-Section verdraengt** — Die Memory-Priorisierung setzte patterns/connections VOR alle anderen Typen. Corrections (confidence 1.0) landeten in der Rest-Gruppe und wurden durch die 800-Token Pre-Truncation abgeschnitten. Der Corrections-Prompt-Block (v512) war leer weil keine `[correction]` Zeilen im truncated Output waren. Fix: Priorisierung jetzt: corrections/preferences ZUERST, dann patterns/connections, dann Rest. Diagnostic-Logs bestaetigen: `hasCorrection: false, memoryLines: 11, preview: [pattern]...`

## [0.19.0-multi-ha.515] - 2026-04-16

### Fixed
- **Reasoning: Reminder-Cancel findet ID per Keyword-Match** — Wenn das LLM "Erinnerung 17:45 loeschen" vorschlaegt aber keine reminderId mitgibt, wird jetzt per Keyword-Match aus der Beschreibung der passende aktive Reminder gefunden. Sucht in pending Reminders nach >=2 gemeinsamen Woertern mit der Action-Description
- **Reasoning: call_service richtig dokumentiert statt verboten** — Prompt erklaert jetzt die required Parameters (domain, service, entityId, serviceData). Domain wird automatisch aus entityId abgeleitet (`light.wohnzimmer` → domain=`light`). call_service ist die maechtigste HA-Action (Heizung, Rollos, Dimmer) — verbieten war falsch
- **Reasoning: Fehlermeldungen verstaendlich + Lern-Aufforderung** — Statt technischer Dumps ("Missing required domain parameter") sieht der User: "Aktion nicht moeglich: [Beschreibung]. Sag mir wie ich das umsetzen soll, dann merke ich es mir." Alfred lernt aus der Antwort
- **Reasoning: Reminder-Cancel Parameter-Fix** — Prompt-Beispiel zeigte `"id"` aber Skill erwartet `"reminderId"`. Normalisierung in processActions: `id→reminderId`, `delete→cancel`. Prompt-Beispiel korrigiert mit Hinweis auf 8-stellige Hex-ID aus Erinnerungen-Liste
- **Reasoning: snake_case Konvertierung nur fuer camelCase-Skills** — Die pauschale snake_case→camelCase Konvertierung (v509) brach Skills die bewusst snake_case verwenden (watch: `skill_name`, itsm: `incident_id`). Fix: Konvertierung nur fuer `homeassistant`, `goe_charger`, `bmw`
- **Reasoning: Fehlgeschlagene proaktive Actions leise loggen** — Technische Fehlermeldungen wie "Missing required domain parameter" werden nicht mehr dem User gezeigt (er kann nichts damit anfangen). Nur geloggt fuer Debugging
- **Reasoning: Corrections als harter Prompt-Block** — Correction-Memories werden nicht mehr nur als passive Zeilen im memories-Abschnitt mitgegeben sondern als eigener Abschnitt `=== KORREKTUREN (ABSOLUTER VORRANG) ===` direkt nach dem Datum, VOR allen Kontext-Sections. Jede Korrektur mit ❌-Prefix. Verhindert dass das LLM Corrections in einem langen Kontext uebersieht (Kapfenberg-Distanz-Bug)
- **Reasoning: Token-Budget 3500 → 5000** — Mehr Kontext fuer das LLM. Memories, Emails, SmartHome, Feeds haben mehr Platz. Kostenerhöhung ~30% pro Pass (~$0.04 statt $0.03)
- **Reasoning: Doppel-Insights nach Deferred-Flush** — Deferred Insights werden jetzt nach dem Flush mit `markSent()` markiert. Der nachfolgende Scheduled Pass erkennt sie als Duplikate und generiert sie nicht erneut
- **Reasoning: call_service aus Prompt entfernt** — LLM soll nur turn_on/turn_off/toggle/activate_scene verwenden. call_service erfordert domain+service Parameter die das LLM nicht zuverlaessig kennt
- **Reasoning: Halluzinierte Actions zeigten Fehlermeldung** — Schema-Validierung (ist die Action im Skill definiert?) wurde erst in `executeDirectly` geprüft, NACH der Entscheidung den User zu informieren. User sah "Proaktive Aktion fehlgeschlagen: Action view existiert nicht". Fix: Schema-Check jetzt VOR der Autonomie-Entscheidung. Halluzinierte Actions werden leise uebersprungen
- **KG LLM-Linker Timeout 30s → 60s** — Bei grossen Knowledge Graphs (2000+ Entities) reichten 30 Sekunden nicht fuer den LLM-Call. Timeout auf 60s erhoeht

### Added
- **Knowledge Gate fuer proaktive Aktionen** — Wissensbasierte Autonomie statt pauschaler Regeln:
  - **Bekannte Entity → proaktiv handeln:** Wenn Alfred eine Memory ueber die Ziel-Entity hat und keine Warnung, fuehrt er die Action aus + informiert den User
  - **Unbekannte Entity → fragen:** Wenn Alfred KEINE Memory ueber die Entity hat, wird die Action zur Confirmation downgraded. User-Antwort wird als Memory gespeichert → naechstes Mal proaktiv
  - **Correction blockiert → reject:** Wenn eine Correction-Memory sagt "nicht steuern", "regelt sich selbst", "nicht kritisch" → Action wird blockiert, User sieht warum
  - **Gated Skills:** homeassistant (write-actions: turn_on/off, call_service, create_automation etc.), goe_charger (start/stop_charging). Read-Actions bleiben ungegated
  - **ITSM Correction-Check:** create_incident prüft Correction-Memories bevor Severity zugewiesen wird. "Nicht kritisch" → Incident wird blockiert
  - **Generischer Prompt:** Smart-Home Entity-Namen NICHT aus Namen ableiten, Sensor-Batterie ≠ Hausbatterie ≠ Fahrzeug-Batterie, ESS regelt sich selbst, Infra-Probleme nicht pauschal als Cascade verknüpfen

## [0.19.0-multi-ha.509] - 2026-04-16

### Fixed
- **Reasoning: Proaktive Aktionen meldeten Erfolg bei Fehlschlag** — `executeDirectly` gab keinen Rueckgabewert, User bekam "Proaktiv ausgefuehrt" auch wenn die Action abgelehnt (halluzinierte Action) oder fehlgeschlagen war (falscher Parameter). Fix: `executeDirectly` gibt `{ success, error }` zurueck. Bei Fehler: "Proaktive Aktion fehlgeschlagen: ..." statt falscher Erfolgsmeldung
- **Reasoning: snake_case → camelCase Konvertierung fuer Skill-Parameter** — LLM benutzt `entity_id` (snake_case), HA-Skill erwartet `entityId` (camelCase). Fix: automatische Konvertierung in `executeDirectly` vor Skill-Ausfuehrung. Betrifft alle proaktiven und autonomen Actions
- **Reasoning: Actions-Parser Fallback fuer Haiku-Format** — Dritter Parsing-Ansatz: findet standalone JSON-Objekte im Text wenn weder Array-Parse noch Code-Block-Extraktion funktionieren. Haiku schreibt Actions manchmal als inline JSON ohne Code-Fences oder Array-Wrapper
- **WebUI LogViewer: Rotierte Logs jetzt anzeigbar** — Datei-Dropdown zeigt alle verfuegbaren Log-Dateien (sortiert nach Datum, neueste zuerst). Aktuelle Datei markiert mit "(aktuell)", aeltere zeigen Datum + Groesse. Live-Tail nur fuer aktuelle Datei. API: `?file=0` (neueste, default), `?file=1` (vorherige), etc. Betrifft Application Logs und Audit Logs
- **WebUI LogViewer: Zeigte gestrige statt aktuelle Logs** — pino-roll nummeriert aufsteigend (.1=älteste, .2=neuere). Der LogViewer suchte die erste existierende Datei (.1) statt die neueste. Fix: Datei-Suche nach mtime sortiert (neueste zuerst). Betrifft sowohl Log-Lesen als auch Live-Tail Streaming
- **Reasoning: Correction-Memories werden jetzt als gelöste Themen erkannt** — `annotateResolvedTopics` suchte nur nach Content-Keywords (erledigt, resolved, geklärt) aber ignorierte `[correction]` Type-Memories. Eine Correction mit "kein offener Konflikt zwischen Linus-Training und Noah-Abholung" wurde nicht erkannt weil der Text keins der Suchbegriffe enthielt. Fix: alle `[correction]`-Zeilen im Memory-Content werden erkannt, Topic-Words aus Key UND Value extrahiert und gegen Kalender/andere Sections gematcht. Annotation: `KORREKTUR: ... — NICHT als offenes Problem darstellen`

## [0.19.0-multi-ha.504] - 2026-04-16

### Added
- **AutomationBuilder — Workflow als Automation-Plattform (Phase 2)** — Der bestehende Workflow-Skill wird zur vollwertigen n8n-Alternative. Jeder der 90+ Skills ist ein Node:
  - **Persistente Trigger** — Workflows koennen periodisch oder event-basiert laufen: `cron` (Zeitplan), `interval` (alle N Minuten), `webhook` (externe HTTP-Calls), `watch` (Watch-Alert triggert Workflow), `mqtt` (geplant). Migration v56: `monitoring`, `last_triggered_at`, `guards` Spalten
  - **Guard-Conditions** — Bedingungen die VOR dem Workflow-Start geprueft werden: `time_window` ("22:00-06:00"), `weekday` ("mon-fri"), `skill_condition` (Skill-Abfrage als Pre-Check, z.B. "nur wenn BMW SoC < 60%"). Workflow wird uebersprungen wenn Guard false
  - **Script-Node** — Alfred generiert Python/Node.js/Bash Scripts und fuehrt sie als Workflow-Step aus. Code wird in `./data/scripts/` gespeichert. JSON-Output fliesst in nachfolgende Steps. Timeout konfigurierbar
  - **DB-Query-Node** — SQL SELECT/INSERT/UPDATE/CREATE TABLE als Workflow-Step. Template-Referenzen in SQL (`{{steps.0.price}}`). Alfred kann eigene Tabellen fuer Automation-Daten erstellen
  - **TriggerManager** — Orchestriert alle Trigger-Typen: pollt cron/interval jede 60s, empfaengt Webhook/Watch Events push-basiert. Guard-Evaluation vor jedem Start. Double-Fire Prevention
  - **Natuerliche Sprach-Erstellung** — `create_from_prompt` Action: User beschreibt Automation in natuerlicher Sprache ("Wenn Strompreis < 15ct und BMW < 60%, starte Wallbox"), Alfred baut den Workflow via LLM. Dry-Run vor Aktivierung
  - **Neue Workflow-Actions:** `create_from_prompt` (LLM-Parsing), `dry_run` (Workflow testen), `activate` (Trigger scharfschalten)
  - **Self-Healing** via ReflectionEngine (Phase 1): Fehlgeschlagene Automationen werden erkannt, gemeldet, nach Schwellwert deaktiviert

## [0.19.0-multi-ha.503] - 2026-04-16

### Added
- **ReflectionEngine — Alfreds Selbstreflexion (Phase 1)** — Alfred evaluiert taeglich sein eigenes Verhalten und optimiert sich selbst:
  - **WatchReflector** — Evaluiert alle aktiven Watches: stale Watches (>14 Tage ohne Trigger) bekommen laengeres Intervall (auto), Watches >30 Tage ohne Trigger werden geloescht (proactive + User informiert), zu haeufigesTriggern (>10x/Tag) erhoht Cooldown (auto), wiederholte Action-Fehler (>=3x) deaktiviert Watch (proactive)
  - **WorkflowReflector** — Evaluiert Workflows: nie ausgefuehrte Workflows >30 Tage werden dem User gemeldet, wiederholte Step-Fehler (>=3x) erzeugen Verbesserungsvorschlag
  - **ReminderReflector** — Erkennt erledigte Themen (insight_resolved Memories) und loescht zugehoerige Reminder automatisch. Erkennt wiederkehrende Reminder-Muster (3x gleicher Typ in 7 Tagen) und schlaegt Recurring-Reminder oder Watch vor
  - **ConversationReflector** — Analysiert Chat-Patterns: wiederholte Skill-Sequenzen (>=3x in 7 Tagen) → Workflow-Vorschlag. Wiederholte Fragen (LLM-basierte Intent-Erkennung) → Automation-Vorschlag
  - **ActionExecutor** — Fuehrt Reflexions-Ergebnisse nach Risk-Level aus: auto (leise), proactive (ausfuehren + User informieren), confirm (nur vorschlagen)
  - **Konfigurierbar** — Alle Schwellwerte per Config/ENV anpassbar: `ALFRED_REFLECTION_ENABLED`, `ALFRED_REFLECTION_SCHEDULE`, `ALFRED_REFLECTION_WATCHES_STALE_AFTER_DAYS` etc.
  - **HA-safe** — Distributed Dedup ueber reasoning_slots Tabelle (nur ein Node fuehrt Reflexion pro Tag aus)
  - **Timer-Scheduling** — Default 4:00 AM taeglich (nach PatternAnalyzer 3:30, TemporalAnalyzer 4:00 Sunday)

## [0.19.0-multi-ha.502] - 2026-04-15

### Fixed
- **Reasoning: 5 Qualitäts-Verbesserungen** — Insight-Redundanz eliminiert, Event-Spam gestoppt, Doppel-Nachrichten behoben, Resolved-Topics besser erkannt, mehr Autonomie:
  - **P1: Insight-Dedup auf Topic-Ebene** — Insights werden jetzt mit zwei Hashes dedupliziert: Content-Hash (erste 100 Zeichen) UND Topic-Hash (sortierte Keywords ≥4 Zeichen). "BMW-Ladestatus bestätigt" und "BMW-Ladefenster morgen kritisch" haben verschiedene Content-Hashes aber denselben Topic-Hash → werden als Duplikat erkannt
  - **P2: Event-Trigger Spam gestoppt** — User-initiierte Skill-Ausführungen im Chat (email read, calendar list, todo list) triggern KEIN Reasoning mehr. Nur noch Watch-Alerts, Kalender-Notificationen und Todo-Overdue-Events in alfred.ts lösen Event-Reasoning aus. Eliminiert nutzlose Insights wie "E-Mail-Leseoperation konsistent mit Abend-Muster"
  - **P3: Doppel-Nachrichten behoben** — Deferred-Insights wurden an ZWEI Stellen geflusht: am Anfang von tick() UND in deliverOrDefer(). User bekam deferred + neue + nochmal deferred Insights im selben Tick. Jetzt nur noch in tick()
  - **P4: Resolved-Topics aus Insight-Tracking** — annotateResolvedTopics erkennt jetzt auch "BESTÄTIGT" Einträge aus dem Insight-Tracking-System (nicht nur Memory-Keywords wie "erledigt"). Wenn der User auf einen Insight reagiert hat ("ja", "erledigt", "passt"), wird das Thema als gelöst markiert und nicht erneut gemeldet. Zusätzlich: "geklärt" und "bereits gesagt" als neue Resolution-Keywords
  - **P5: Autonomie-Level Default proactive** — PROACTIVE_SKILLS (reminder, todo, note, calendar, homeassistant, sonos, spotify, watch) werden jetzt automatisch ausgeführt und der User wird informiert ("Proaktiv ausgeführt: ...") statt eine Bestätigungsfrage zu stellen. HIGH_RISK Skills (email senden, delegate, workflow, bmw, deploy, itsm) erfordern weiterhin Bestätigung. User kann per Memory `autonomy_level: confirm_all` zurückwechseln

## [0.19.0-multi-ha.501] - 2026-04-15

### Added
- **WebUI: Log Viewer** (`/logs`) — Enterprise-Grade Log-Viewer im WebUI:
  - **Application Logs:** Tabelle mit Level-Farben (INFO grün, WARN gelb, ERROR rot), Zeitstempel, Component, Message
  - **Audit Logs:** Separater Tab für Security/Audit-Log
  - **Filter:** Level-Filter (Trace→Fatal), Text-Suche (Message, Component, beliebiger JSON-Key), Enter zum Suchen
  - **Live Tail:** SSE-basiertes Echtzeit-Streaming neuer Log-Zeilen mit Auto-Scroll
  - **JSON-Expand:** Klick auf Zeile zeigt strukturierte Details (alle zusätzlichen Felder)
  - **API:** `GET /api/logs/app?lines=200&level=info&filter=reasoning`, `GET /api/logs/app/stream` (SSE), `GET /api/logs/audit?lines=100`

- **WebUI: Cluster & Operations Dashboard** (`/cluster`) — HA-Cluster-Übersicht und Operationsstatus:
  - **Node-Übersicht:** Alle Cluster-Nodes mit Status (alive/dead), Uptime, Version, Hostname, Adapters. Aktueller Node markiert
  - **Adapter Claims:** Tabelle aller Platform-Claims (Telegram, Discord etc.) mit Node-Zuordnung, Claimed/Expires Zeitstempel, Active/Expired Status
  - **Reasoning Slots:** Letzte 20 Reasoning-Passes mit Slot-Key, ausführendem Node, Zeitstempel
  - **Operations Status:** Reasoning Schedule, Backup Schedule
  - **Single-Node-Kompatibel:** Zeigt synthetischen Node-Eintrag wenn kein Cluster aktiv
  - **Auto-Refresh:** Alle 15 Sekunden
  - **API:** `GET /api/cluster/health`

### Changed
- **Reasoning: Email-Kontext erweitert — 15 Emails mit Preview statt 5** — Eigene `fetchEmailForReasoning()` Methode statt generischer `inbox` Action. Alle Emails (UNREAD, READ, REPLIED, AUTO) mit 80-Zeichen-Preview für Cross-Domain-Reasoning (Email-Inhalt + Kalender + KG-Personen = Zusammenhänge). Status-Tags (🔴📖✅ℹ️) zeigen dem LLM den Bearbeitungsstand. Laufende Nummern statt Graph-IDs (152 Zeichen/ID = untragbar). maxTokens 500, Pre-Truncation schneidet älteste Emails zuerst ab (~11 Emails passen)

## [0.19.0-multi-ha.497] - 2026-04-15

### Added
- **Enterprise-Grade Logging** — Rotating File-Logs mit pino-roll, Version in jeder Log-Zeile, aggregiertes Reasoning-Logging:
  - **File-Logging mit Rotation** — pino-roll Transport: konfigurierbar per Config/ENV (`ALFRED_LOG_FILE_ENABLED=true`). Default: `./data/logs/alfred.log`, 10MB Rotation, 10 Dateien behalten, tägliche Rotation. Logs werden bei Restart NICHT mehr überschrieben
  - **Audit-Log Rotation** — AuditLogger nutzt jetzt pino-roll statt pino.destination (30 Tage Retention)
  - **Version in jedem Log** — Jede Log-Zeile enthält die Alfred-Version als `version`-Feld. Startup-Log zeigt Version, Node-Version und PID
  - **Reasoning-Collector Logging** — Ein aggregierter Info-Log nach Source-Fetch: Gesamtdauer, fulfilled/rejected/empty Counts, Truncations, langsame Sources (>2s). fitToBudget loggt jetzt gedroppte und budget-truncated Sections auf Info-Level (vorher debug = unsichtbar)
  - **fitToBudget Faktor-Korrektur** — Truncation-Faktor von `* 4` / `/ 4` auf `* 3.5` / `/ 3.5` korrigiert (konsistent mit Token-Schätzer, vgl. CHANGELOG v0.9.64)
  - **Stdout-Schutz** — Wenn File-Logging aktiv und kein TTY (nohup/systemd), wird stdout-Transport übersprungen. Verhindert EIO-Crash bei geschlossenem Terminal
  - **Config** — `logger.file.enabled`, `logger.file.path`, `logger.file.maxSize`, `logger.file.maxFiles`, `logger.file.frequency` (Zod-Schema + ENV-Mappings)

## [0.19.0-multi-ha.495] - 2026-04-15

### Fixed
- **Reasoning: Email verschwand aus Kontext — maxTokens pro Source nie erzwungen** — `maxTokens` in den SourceDefs war ein toter Wert: definiert aber nirgends durchgesetzt. `memories` lieferte 1744 Tokens (statt max 500), `smarthome` bis 1127 (statt max 400). Der fitToBudget-Algorithmus (3500 Token-Budget) füllte mit kleinen Sections auf und droppte Email (624 Tokens) weil kein Platz mehr war. Produktions-Logs bestätigen: Email erschien nur zufällig wenn wenige andere Sources aktiv waren. Fixes:
  - **Pre-Truncation in `collect()`** — Content wird nach Fetch auf `Math.floor(maxTokens * 3.5)` Zeichen begrenzt. Faktor 3.5 konsistent mit Token-Schätzer (`content.length / 3.5`, etabliert seit v0.9.64). Zeilenweiser Cut (kein harter Schnitt mitten in Einträgen)
  - **memories maxTokens 500→800** — Wichtigste P1-Source für Personalisierung. 11 von 25 Entries bleiben (höchste confidence zuerst, `getRecentForPrompt` sortiert nach `confidence DESC`)
  - **email maxTokens 250→400** — 5 Emails mit Subject, Absender und Preview passen in 400 Tokens
  - **email Parameter `limit`→`count`** — Email-Skill erwartet `count`, Collector schickte `limit` (wurde ignoriert, default 10 statt gewünschte 5)
  - **Diagnostic-Logging** — `collect()` loggt REJECTED und EMPTY Sources. `fetchSkillData` loggt Timing und Email-Result-Details. Für Verifizierung nach Deploy

## [0.19.0-multi-ha.489] - 2026-04-14

### Added
- **Autonome Multi-Step-Planung** — Alfreds Killer-Feature. Wenn das Reasoning ein komplexes Szenario erkennt (Reise + Laden + Wetter + Logistik), erstellt es einen zusammenhängenden Plan statt einzelner Actions:
  - **PlanningAgent** + **PlanExecutor** — erstellt, persistiert und führt Pläne schrittweise aus
  - **3 Risk-Levels:** AUTO (läuft ohne Frage), CHECKPOINT (pausiert für User-Entscheidung), PROACTIVE (läuft mit Benachrichtigung)
  - **LLM Re-Evaluation** — nach jedem 3. Schritt prüft das LLM ob der Plan noch sinnvoll ist
  - **Plan-Persistenz** — Migration v55: `plans` Tabelle (PG + SQLite). Pläne überleben Neustarts
  - **Reasoning-Integration** — neuer Action-Typ `execute_plan` im Prompt, aktive Pläne im Kontext (verhindert Duplikate)
  - **ConfirmationQueue** — Plan-Bestätigung als Ganzes, Checkpoint-Handling
  - **Template-Resolution** — Schritte können Ergebnisse vorheriger Schritte referenzieren: `{{step_0.distance_km}}`
  - **Sicherheit:** Min 1 Checkpoint pro Plan, max 10 Schritte, max 3 Re-Plannings, 24h Timeout

## [0.19.0-multi-ha.491] - 2026-04-15

### Fixed
- **Insight-Tracker: Fundamentaler Redesign** — Das System bestrafte Alfred für nützliche Insights die keine Antwort brauchten. 6 Fixes:
  - **Informativ vs Handlungsrelevant:** Neue `classifyInsightType()` — informative Insights (Wetter, Crypto, Status) werden nicht mehr getrackt. Nur handlungsrelevante Insights (Konflikte, Warnungen, Deadlines) erwarten eine Reaktion
  - **Batch-Tracking:** Gebündelte Insights (5 in einer Nachricht) werden als 1 Batch getrackt statt 5 einzelne Einträge. User-Reaktion gilt für alle Kategorien im Batch
  - **Reaktionsfenster 30min → 2h:** User liest Insights oft erst 1h später
  - **Nur explizite Ablehnungen zählen:** Threshold von `ignoredRate >= 0.7` auf `negativeRate >= 0.5`. Stille = neutral, nicht negativ
  - **System B → System A Bridge:** `insight_resolved` (konversationsbasiert, genauer) speist jetzt in InsightTracker Preference-Learning ein
  - **Deferred Insights werden getrackt:** Flush-Pfade rufen jetzt `trackInsightBatch()` auf
  - **LLM-Prompt:** "EXPLIZIT abgelehnt — reduzieren, NICHT eliminieren" statt "weniger senden"
  - **DB Cleanup:** 18 falsche "ignoriert"-Preferences + Stats resetted

## [0.19.0-multi-ha.488] - 2026-04-14

### Added
- **Personality-Config** — Konfigurierbarer Persönlichkeits-Block im System-Prompt: Ton, Humor, Direktheit, Sprache, Custom-Text. Wird im cachebaren Prefix platziert (vor Core Principles). Config über `personality:` Block in YAML oder ENV (`ALFRED_PERSONALITY_TONE` etc.)
- **Delegate Prompt-Modes** — Sub-Agents bekommen nur noch task-relevante Skills als Tools statt alle 65+. Keyword-Matching auf Task-Text filtert irrelevante Skills. Spart 2.000-8.000 Tokens pro Delegate-Iteration. Fallback auf volles Set wenn <5 Skills matchen
- **Onboarding Skill** — Geführte Ersteinrichtung: fragt Name, Wohnort, Arbeitgeber, Partner, Kinder, Sprache nacheinander ab und speichert als Memories. 4 Actions: start, step, skip, status

## [0.19.0-multi-ha.487] - 2026-04-14

### Added
- **Memory: pgvector-Unterstützung für PostgreSQL** — `EmbeddingRepository.vectorSearch()` nutzt pgvector für DB-seitige Nearest-Neighbor-Suche statt JS-seitigem Full-Table-Scan. Automatische Erkennung: wenn pgvector Extension verfügbar → DB-Pfad, sonst → bestehender JS-Fallback. `embedding_vec` Spalte wird automatisch hinzugefügt und bestehende BYTEA-Embeddings on-demand backfilled. Docker-Image auf `pgvector/pgvector:pg16` wechseln um pgvector zu aktivieren
- **Memory: Semantische Consolidation** — `MemoryConsolidator.findSimilarGroups()` prüft jetzt auch Value-Ähnlichkeit (Jaccard ≥0.7) zusätzlich zu Key-Ähnlichkeit (≥0.5). Findet Memories mit verschiedenen Keys aber ähnlichem Inhalt (z.B. `home_address` ↔ `wohnort_user`)

## [0.19.0-multi-ha.486] - 2026-04-14

### Fixed
- **Memory: Temporal Decay auf Fallback-Pfade erweitert** — Wenn `MemoryRetriever` nicht verfügbar ist, sortieren die Fallback-Pfade in `message-pipeline.ts` jetzt ebenfalls nach 30-Tage exponentieller Halbwertszeit × Confidence. Aktuelle Memories werden bevorzugt
- **Memory: Embedding-Cleanup nach Consolidation** — `MemoryConsolidator` räumt jetzt verwaiste Embeddings auf wenn Memories gelöscht oder gemerged werden. Verhindert unbegrenztes Wachstum der Embeddings-Tabelle

## [0.19.0-multi-ha.485] - 2026-04-14

### Fixed
- **KG: 4 verbleibende Müll-Quellen gefixt**
  - "Frau Alex" Duplikat: Canonical-Map Substring-Match (alex→alexandra)
  - Satzfragmente als Organisationen: Validierung verschärft (Großbuchstabe, keine Klammern, Verb-Blacklist, PERSON_BLACKLIST)
  - LLM-Linker Müll-Entities: newEntity-Validierung (keine Phrasen mit von/und/der, keine Satzzeichen, max 40 Zeichen)
  - Calendar-Events: Kurze/generische Titel gefiltert (Bot, Von...), Route-Texte als Location ausgeschlossen
  - DB bereinigt: 12 Müll-Entities gelöscht

## [0.19.0-multi-ha.484] - 2026-04-14

### Added
- **BMW: 3 neue Actions (dedizierte Endpunkte)**
  - `tyre_diagnosis` — Smart Maintenance Reifendiagnose: Dimension, Verschleiß, Defekte, Montage-Datum, Hersteller, Profil für alle 4 Räder + eingelagerte Reifen. Nutzt `/smartMaintenanceTyreDiagnosis` Endpunkt
  - `basic_data` — Fahrzeug-Basisdaten: Marke, Typ, Antrieb, Farbe, Baujahr, Land, Motor, Lademodi, SA-Codes. Nutzt `/basicData` Endpunkt
  - `image` — Fahrzeugbild als PNG (Base64-encoded). Nutzt `/image` Endpunkt

## [0.19.0-multi-ha.480] - 2026-04-14

### Added
- **MikroTik RouterOS Management Skill** — RouterOS REST API v7.x, Multi-Router-fähig. 34 Actions:
  - **Monitoring:** status, interfaces, traffic, resources, logs, dhcp_leases, arp, routes, dns_cache, connections, neighbors, wireless
  - **Konfiguration:** firewall_rules, add/remove/enable/disable_firewall, nat_rules, add/remove_nat, set_dns, add/remove_address, enable/disable_interface, add/remove_route, add_dhcp_static, set_queue, backup_config
  - **Troubleshooting:** ping, traceroute, torch
  - **Verwaltung:** list_routers, add/remove_router, configure
  - Multi-Router: benannte Verbindungen mit Default-Router, dynamisch hinzufügbar
  - Proaktives Monitoring: Interface up/down, CPU/RAM-Warnungen, ITSM-Auto-Incident
  - Reasoning-Integration: Router-Status im proaktiven Denken
  - Cluster-aware Monitoring (AdapterClaimManager)

## [0.19.0-multi-ha.479] - 2026-04-14

### Added
- **Commvault Backup Management Skill** — Vollständige CommServe REST API v2 Integration mit 15 Actions:
  - **Operativ:** status, jobs, job_detail, clients, client_detail, storage, alerts
  - **Strategisch:** report (SLA/Compliance mit RPO-Prüfung), analyze (LLM-basierte Fehleranalyse + Optimierungsvorschläge)
  - **Aktiv:** start_job, stop_job, retry_job, restore, modify_schedule
  - **Auth:** API Token oder Username/Password mit Auto-Renewal
  - **Proaktives Monitoring:** Konfigurierbares Polling (default 30min), Auto-Retry fehlgeschlagener Jobs, Storage-Warnungen, SLA-Verletzungserkennung
  - **ITSM-Integration:** Automatische Incident-Erstellung bei Backup-Fehlern (mit Dedup)
  - **Reasoning-Integration:** Commvault-Status im Reasoning-Kontext (fehlgeschlagene Jobs, Storage-Warnungen)
  - **Konfigurierbar:** confirmation_mode (Schreibaktionen über Confirmation Queue), polling_interval, auto_retry, auto_incident, storage_warning_pct, sla_rpo_hours
  - **Cluster-aware:** AdapterClaimManager für Monitoring-Dedup in HA-Setup
  - **Bekannte Fehlercodes:** Integrierte Lookup-Tabelle für VSS, Netzwerk, Storage I/O, DDB Fehler

## [0.19.0-multi-ha.475] - 2026-04-14

### Added
- **Backup & Restore** — Zwei neue Komponenten:
  - **Database-Skill: `backup`/`restore` Actions** — Backup/Restore für alle 7 DB-Provider (PostgreSQL, MySQL, MS SQL, SQLite, MongoDB, Redis, InfluxDB). MS SQL unterstützt Backup-Ketten: `copy_only` (default, bricht keine Kette), `full`, `differential`, `log` (Transaction Log für Point-in-Time Recovery)
  - **System-Backup-Skill** — Sichert Alfreds eigene Datenbank (PG/SQLite) + Token-Dateien + Config. 6 Actions: backup, restore, list, status, configure, delete. Konfigurierbar: Zeitplan (Cron), Retention (pro Backup individuell oder global), Speicherort (lokal/S3/beides/keins), Restore per Chat (default: aus). Cluster-aware via AdapterClaimManager. Labels + permanente Backups

## [0.19.0-multi-ha.472] - 2026-04-13

### Fixed
- **WebUI KG: Node-Click funktionierte nicht** — `nodeCanvasObjectMode='replace'` überschreibt das Standard-Rendering, aber ForceGraph2D nutzt für die Klick-Erkennung eine interne Hitbox die nicht mit dem custom Canvas-Objekt übereinstimmt. Fix: `nodePointerAreaPaint` definiert die klickbare Fläche explizit passend zum gezeichneten Kreis. Minimum-Hitbox 6px für kleine Nodes

## [0.19.0-multi-ha.470] - 2026-04-13

### Fixed
- **KG: Attribut-Enrichment auf bestehende Entities** — LLM-Linker `corrections` kann jetzt Attribute auf bestehende Entities setzen ohne den Typ zu ändern. Wenn Alfred lernt "Mutter wohnt in Eichgraben", passiert: (1) Attribut `livesIn: Eichgraben` auf Maria Dohnal, (2) Location-Entity "Eichgraben" erstellt, (3) Relation Maria→lives_in→Eichgraben. Prompt in beiden LLM-Pfaden (normaler Linker + wöchentlicher Chat-Lauf) erklärt das Pattern mit Beispiel

## [0.19.0-multi-ha.469] - 2026-04-13

### Fixed
- **KG: Wöchentlicher Chat-LLM-Lauf hatte ungeschützten Prompt** — `analyzeRecentChats` hatte einen eigenen Prompt ohne User-Identität, Kinder-Liste, oder Attribut-Verbot. Konnte falsche Entities und Relations vorschlagen. Jetzt: gleiche Schutzregeln wie der normale LLM-Linker-Prompt
- **KG: Personen-Attribute aus Memories** — `syncMemoryEntities` liest jetzt `child_*_full_name`, `spouse_full_name`, `user_birthday` Memories und setzt `fullName`/`birthday` als Attribute auf die Person-Entities. Passiert automatisch bei jedem Reasoning-Zyklus
- **KG DB bereinigt** — `Verbindungsprobleme` Entity gelöscht, Route-Text Locations gelöscht, falsche `isHome` auf Bisamberg/Kapfenberg/Tulln/Eichgraben korrigiert, User-Attribute (Geburtstag, Staatsbürgerschaft, Adresse) gesetzt, Kinder fullNames gesetzt

## [0.19.0-multi-ha.468] - 2026-04-13

### Fixed
- **KG: Vollständige Bereinigung der Entity-Erstellung (9 Fixes)** — Tiefgehende Analyse aller 23 Entity-Erstellungspfade, 6 Relation-Mechanismen und aller Downstream-Konsumenten (Chat-Prompt, Reasoning, WebUI, LLM-Linker, Memory-Rückkanal):
  - **F1:** PERSON_BLACKLIST um Gruppen-Wörter erweitert (kinder, eltern, familie, geschwister, enkel) → "Kinder" wird nie als Person-Entity erstellt
  - **F2:** DB-Fuzzy-Dedup vor Person-Erstellung — bestehende Person-Entities werden in die canonical-Map geladen. "Frau Alex" wird nicht mehr erstellt wenn "Alexandra" existiert (Vorname-Match "alex" in "alexandra")
  - **F3:** Legacy-Personen-Erstellung in `extractFromMemories` entfernt (Zeile 1413-1420). Wird vollständig von `syncMemoryEntities` abgedeckt. `chef`-Keyword in Relation-Ableitung aufgenommen (→ works_with)
  - **F4:** SmartHome `person.*` Entities: Lowercase-/Kurznamen (z.B. "madh") werden als `item` statt `person` erstellt. HA-Personen mit korrekten Namen (Alexandra, Noah) bleiben Personen
  - **F5:** `extractFromReminders` deaktiviert — Reminder-Ganztexte als Event-Entities erzeugten nur Rauschen. Reminders sind im System-Prompt direkt verfügbar
  - **F6:** Calendar-Location vor erstem Komma abgeschnitten — verhindert "Höglinger Denzel GesmbH, Estermannstraße 2-4, 4020 Linz" als Entity
  - **F7:** HA↔Memory Person-Merge: `migrateEntityRelations` statt `same_as` — HA-Entity wird in Memory-Entity gemerged (Relationen migriert, HA-Entity gelöscht). `same_as` wurde nirgends gelesen/interpretiert
  - **F9:** LLM-Linker Prompt: Entities für Attribute (Geburtsdatum, Staatsbürgerschaft etc.) explizit verboten

## [0.19.0-multi-ha.467] - 2026-04-13

### Fixed
- **KG: LLM Entity-Linker weiß jetzt wer der User ist** — Prompt enthält User-Identität (Realname), Kinder-Liste, und explizite Regel: persönliche Relationen (owns, works_at, monitors, prefers, dislikes) gehören zum User nicht zu Kindern. Code-Validierung blockt `owns/monitors/prefers/dislikes/uses/subscribes_to` von Sohn/Tochter-Entities. DB bereinigt: 29 falsche Relationen gelöscht (Noah plays_at SV Altlengbach, Sohn Noah same_as Sohn Linus, Tochter Lena same_as Tochter Hannah, "Kinder"-Entity komplett entfernt, Maria parent_of→grandparent_of korrigiert, etc.)

## [0.19.0-multi-ha.466] - 2026-04-13

### Fixed
- **KG: User-Name falsch aufgelöst → Sohn bekam alle User-Relationen** — `upsertUserEntity` suchte Memories mit `search(userId, 'name')` und fand `child_linus_full_name` ("Linus Dohnal") vor `user_full_name` ("Mein vollständiger Name ist Markus Dohnal"). Dadurch wurde "Linus Dohnal" als `realName` gesetzt, Phantom Detection mergte "Markus Dohnal" in "Linus Dohnal", und der Sohn bekam Cryptos, BMW, Arbeitgeber, Ehefrau. Fixes:
  - `user_full_name` als erster Key in der nameKeys-Liste (direkte Abfrage vor Suche)
  - Memory-Search filtert Keys mit `child_`, `friend_`, `spouse_` etc. Prefix aus
  - Satz-Parsing für Memory-Werte die keine reinen Namen sind (z.B. "Mein Name ist X Y")
  - `same_as` zwischen Personen nur bei übereinstimmendem Vornamen (LLM Entity-Linker)
  - DB bereinigt: User.realName→"Markus Dohnal", Linus Dohnal source→memories, "Markus Dohnal" Entity in "User" gemerged, 32 falsche Relationen gelöscht

## [0.19.0-multi-ha.465] - 2026-04-13

### Fixed
- **KG: `same_as` zwischen Personen mit gleichem Nachnamen verhindert** — LLM Entity-Linker schlug `Linus Dohnal same_as Markus Dohnal` vor (Sohn = Vater) weil beide "Dohnal" heißen. Dadurch bekam Linus alle Relationen von Markus (Cryptos, BMW, Arbeitgeber, Ehefrau). Jetzt: `same_as` zwischen Personen nur wenn Vorname übereinstimmt oder ein Name den anderen enthält (Alias/Spitzname). 27 falsche Relationen aus DB bereinigt

## [0.19.0-multi-ha.464] - 2026-04-13

### Fixed
- **BMW pollToken: refreshToken ging bei Token-Exchange verloren** — Nach Device-Code-Exchange wurde `data.refresh_token` (undefined bei manchen BMW-Responses) direkt als refreshToken gespeichert → Datei hatte keinen gültigen refreshToken → MQTT konnte nach Neustart nicht refreshen. Jetzt: Fallback auf existierenden refreshToken wenn BMW keinen neuen liefert. VIN/containerId werden aus bestehender Datei übernommen statt separat gelesen

## [0.19.0-multi-ha.463] - 2026-04-13

### Fixed
- **BMW MQTT nach Authorize immer neustarten** — Nach erfolgreichem authorize wurde MQTT nur neugestartet wenn `streamingActive || mqttClient` true war. Wenn MQTT im Backoff hing (beides false), wurde es nicht neugestartet → MQTT blieb tot mit altem kaputtem Token. Jetzt: `stopStreaming()` + `startStreaming()` immer nach authorize

## [0.19.0-multi-ha.462] - 2026-04-13

### Fixed
- **BMW Authorize: Token-Verlust bei fetchVin/ensureContainer Fehler** — Nach erfolgreichem Token-Exchange crashte `fetchVin` oder `ensureContainer` (z.B. Rate-Limit), und die Exception wurde in authorize's catch-Block geschluckt → Token ging verloren, User bekam "pending" statt Erfolg. Jetzt: Tokens werden SOFORT nach Exchange gespeichert, VIN/containerId aus vorheriger Session preserved, fetchVin und ensureContainer sind non-fatal

## [0.19.0-multi-ha.461] - 2026-04-13

### Fixed
- **BMW MQTT Streaming HA-Failover** — BMW MQTT Streaming hatte keinen Cluster-Failover. Wenn der Node starb der das Streaming hielt, übernahm der andere Node nicht. Ursache: `bmw-streaming` wurde nicht als `registerPlatform` registriert und der `onAcquired`-Callback behandelte nur Messaging-Adapter. Jetzt: `bmw-streaming` wird registriert, bei Claim-Übernahme (toter Node, expired TTL) startet der übernehmende Node automatisch `startStreaming()`

## [0.19.0-multi-ha.460] - 2026-04-13

### Fixed
- **BMW Authorize-Schleife: `access_denied`/`expired_token` wurde als "pending" maskiert** — Wenn BMW `access_denied` oder `expired_token` zurückgab, fing der catch-Block den Fehler und sagte dem User "bitte im Browser bestätigen" — obwohl BMW die Autorisierung klar abgelehnt hatte. Jetzt: terminale Fehler (`access_denied`, `expired_token`, `invalid_grant`) räumen den alten deviceCode auf (Disk + DB) und generieren sofort einen neuen Code. Nur transiente Fehler (Netzwerk, Timeout) werden als "pending" maskiert

## [0.19.0-multi-ha.459] - 2026-04-13

### Fixed
- **BMW pollToken: Disk-First statt DB-First für codeVerifier** — pollToken las den PKCE codeVerifier zuerst aus der DB (Key `partial`), wo ein alter Wert von einem früheren Authorize-Versuch liegen konnte. Jetzt: Disk zuerst (savePartialTokens schreibt immer dorthin, MQTT-Refresh preservt es), DB nur als Fallback. Zusätzlich: deviceCode-Matching — der Verifier wird nur akzeptiert wenn er zum aktuellen deviceCode passt
- **BMW pollToken Logging** — Diagnostik-Logs für verifier-Quelle und BMW-Antwort bei Fehler

## [0.19.0-multi-ha.458] - 2026-04-13

### Fixed
- **BMW Container-Descriptors: API-verifizierte Key-Liste** — Alle 293 CarData Elements gegen die BMW Container-API getestet. Ergebnis: Nur 33 Keys sind als REST-Container-Descriptor gültig (Charging, GPS, Odometer, Trunk). Doors, Windows, Lock, CBS, checkControl, Tires, Service-Daten sind ausschließlich MQTT-only. DESCRIPTORS-Array korrigiert: 30 base + GPS lat/lon/heading + Odometer + Trunk = 35 Keys. Ungültige Keys entfernt die CU-402 "Telematic key is invalid" verursachten
- **BMW GPS-Keys korrigiert** — `vehicle.location.gps.*` (MQTT-only) durch `vehicle.cabin.infotainment.navigation.currentLocation.*` (REST-valid) ersetzt. GPS kommt jetzt über REST UND MQTT
- **BMW MQTT_ALT_KEYS bidirektional** — Mappings in beide Richtungen (REST→MQTT und MQTT→REST) für GPS, Lock, Doors, Trunk, Windows. `tvm()` findet Daten unabhängig davon ob MQTT oder REST als Quelle dient
- **BMW Container Auto-Update beim ersten REST-Call** — `resolveContainerId` prüft einmal pro Prozess-Lifetime ob die Descriptor-Anzahl stimmt und erstellt den Container automatisch neu. Kein manuelles `authorize` nötig nach Code-Updates

## [0.19.0-multi-ha.456] - 2026-04-13

### Fixed
- **BMW Authorize Endlosschleife: `saveTokens` überschrieb `deviceCode`** — `saveTokens` (aufgerufen alle 60-120s vom MQTT Token-Refresh) schrieb das komplette BMWTokens-Objekt auf Disk und überschrieb dabei den von `savePartialTokens` gespeicherten `deviceCode`/`codeVerifier`. Der User hatte ein Zeitfenster von <60s um den Browser-Code zu bestätigen UND Alfred erneut aufzurufen — praktisch unmöglich. Fix: `saveTokens` liest vor dem Schreiben die bestehende Datei und preservt `deviceCode`/`codeVerifier` falls vorhanden. Nach erfolgreichem Token-Exchange in `pollToken` wird `deviceCode`/`codeVerifier` explizit aus der Datei entfernt damit es nicht ewig drin bleibt. Der Freshness-Guard (v424) kann jetzt endlich wirken weil der deviceCode zwischen den authorize-Calls überlebt

## [0.19.0-multi-ha.455] - 2026-04-13

### Fixed
- **BMW: `savePartialTokens` nutzte `activeUserId` statt `tokenUserId`** — Bei der tokenUserId-Konsolidierung (v424) wurde `savePartialTokens` vergessen. Es schrieb deviceCode/codeVerifier in die FALSCHE Datei (`bmw-tokens-91df4602-*.json` via `activeUserId`) während `loadTokensFromDisk` aus der RICHTIGEN Datei las (`bmw-tokens-f165df7a-*.json` via `tokenUserId`). Folge: `bmw authorize` konnte den gespeicherten deviceCode nie finden und generierte bei jedem Aufruf einen neuen Code → Endlosschleife. Fix: `getTokenPath(this.activeUserId)` → `getTokenPath(this.tokenUserId)` an beiden Stellen (Zeile 961 + 981)

## [0.19.0-multi-ha.454] - 2026-04-13

### Added
- **BMW: CBS, HU/AU, CheckControl und Reifendruck Descriptors registriert** — 11 neue Keys in der DESCRIPTORS-Liste. Beim nächsten Alfred-Restart wird der Container mit den erweiterten Descriptors neu erstellt (1 API-Call). Ab dann liefert MQTT diese Daten kostenlos:
  - `vehicle.status.conditionBasedServices` — Wartungsbedarf (Ölwechsel, Bremsen, Fahrzeugcheck)
  - `vehicle.status.serviceTime.inspectionDateLegal` — nächste HU/AU
  - `vehicle.status.checkControl` — Warnmeldungen (Scheibenwaschwasser, Reifendruck-Alarm, Motorleuchte)
  - `vehicle.chassis.axle.row{1,2}.wheel.{left,right}.tire.pressure` + `pressureTarget` — Reifendruck aller 4 Räder (bereits per MQTT geliefert, jetzt auch für REST-Fallback registriert)
- **Kein Display/Parsing in diesem Release** — Datenformat von CBS/checkControl wird erst nach Eintreffen der echten MQTT-Daten in der DB analysiert, dann implementiert

## [0.19.0-multi-ha.453] - 2026-04-13

### Fixed
- **Email Skill: Reply-Draft Instruktion explizit** — LLM rief `action='draft'` mit `to` + `subject='RE: ...'` auf statt mit `messageId`. Ergebnis: neues Email das aussieht wie ein Reply aber NICHT im Thread ist. Fix: Skill-Description erklärt jetzt explizit: "REPLY DRAFT: Use action='draft' WITH messageId (NOT with to/subject!) to create an in-thread reply draft"

## [0.19.0-multi-ha.452] - 2026-04-13

### Fixed
- **Email Draft-Reply: gleiche HTML-Konvertierung wie Send-Reply** — `createDraft()` mit `replyTo` sendete den Body ebenfalls als Plain Text statt HTML an Graph's `createReply` Endpoint. Gleicher Fix wie v451 (Plain → HTML mit `<p>`, `<br>`, Entity-Escaping) auch für den Draft-Pfad angewendet

## [0.19.0-multi-ha.451] - 2026-04-13

### Fixed
- **Email Reply: Plain-Text → HTML Konvertierung für Graph API** — Microsoft Graph's `reply` Endpoint interpretiert das `comment`-Feld als HTML, aber Alfred sendete Plain Text mit `\n`. Folge: der Reply war ein einziger Fließtext-Block ohne Absätze. Fix: Automatische Konvertierung in `microsoft-provider.ts:sendMessage()`: `\n\n` → `</p><p>` (Absätze), `\n` → `<br>` (Zeilenumbrüche), HTML-Entities escaped (`&`, `<`, `>`). Gilt für beide Reply-Pfade (mit und ohne Attachments)

## [0.19.0-multi-ha.450] - 2026-04-12

### Fixed
- **Email Search: Microsoft Graph `$search` Quote-Sanitizing** — LLM sendete Queries mit verschachtelten Anführungszeichen und Gmail-Operatoren (`from:support@ui.com subject:"Ubiquiti Support"`) die Graph `$search` nicht versteht → 400 Bad Request. Fix: `searchMessages()` in `microsoft-provider.ts` strippt jetzt alle `"` Zeichen und Gmail-Operatoren (`from:`, `to:`, `subject:`, `is:`, `has:`) aus dem Query bevor er in `$search` eingesetzt wird. Der sanitierte Query enthält nur die Keywords die Graph tatsächlich matchen kann
- **Email Skill Description: Reply + Search Instruktionen** — LLM versuchte Emails per search zu finden statt die bekannte messageId direkt zu nutzen, und verwendete Gmail-Syntax die Microsoft Graph nicht unterstützt. Neue Skill-Description instruiert: (1) Reply direkt mit bekannter messageId aufrufen, nicht nochmal suchen (2) Search-Queries als einfache Keywords, keine Gmail-Operatoren

## [0.19.0-multi-ha.449] - 2026-04-12

### Fixed
- **Microsoft Email: Graph API Error-Body im Fehler sichtbar** — `graphRequest()` warf bei HTTP-Fehlern nur `"Graph API error: 400"` ohne den Response-Body. Der Body enthält die eigentliche Fehlerbeschreibung (z.B. `ErrorItemNotFound`, `ErrorInvalidRecipients`, `ErrorAccessDenied`). Fix: Error-Body (max 300 Zeichen) wird jetzt in die Error-Message aufgenommen. Betrifft sowohl den primären als auch den Retry-Pfad (nach 401 Token-Refresh). Kritisch für Debugging des Email-Reply-400-Fehlers

## [0.19.0-multi-ha.448] - 2026-04-12

### Fixed
- **KRITISCH: ITSM/Problem/Service UPDATE mit Short-ID hat 0 Rows affected** — `updateIncident`, `updateService`, `updateChangeRequest`, `updateProblem` nutzten die vom Caller übergebene ID (oft 8-stellige Short-ID vom LLM) im `WHERE id = ?` Clause. Aber `getIncidentById` findet via `LIKE 'a5b8a0f2%'` (prefix match), die `UPDATE` braucht den exakten Full-UUID. Folge: `getIncidentById` findet → Update SQL matched 0 Rows → keine Änderung → Return des unveränderten Incident als "success" = **False Positive**. Fix: Alle 4 UPDATE-Methoden nutzen jetzt `existing.id` (Full-UUID aus DB) statt `id` (caller's Short-ID). Betrifft `itsm-repository.ts` (Incidents, Services, Changes) und `problem-repository.ts` (Problems)

## [0.19.0-multi-ha.447] - 2026-04-12

### Fixed
- **Insight-Delivered Memory TTL: 7 Tage → 48 Stunden** — Insight-Tracking-Memories (`insight_delivered:*`) hatten ein 7-Tage-TTL. Zustandsbeschreibungen wie "Email ist ungelesen" blieben deshalb eine volle Woche im Kontext — auch nachdem die Email längst gelesen wurde. Das LLM wiederholte den veralteten Zustand in jedem Insight. Fix: TTL von 7 auf 2 Tage reduziert (48h). Gibt dem User genug Reaktionszeit für Follow-ups, verhindert aber dass stale Zustände den Kontext eine Woche verunreinigen
- DB-Cleanup: 31 stale Spond/Fußball Insight-Tracking-Memories expired die "ungelesen" Zustände beschrieben die nicht mehr aktuell sind

## [0.19.0-multi-ha.446] - 2026-04-12

### Fixed
- **ITSM `list_incidents` zeigt jetzt Incident-IDs** — Die Display-Tabelle hatte keine ID-Spalte. Alfred konnte Incidents sehen aber nicht per ID referenzieren. Fix: ID-Spalte (8-stellig) + Hinweis "Nutze die ID für update_incident" in der Tabelle
- **ITSM System-Prompt-Filter war zu restriktiv** — Der Chat-Prompt-Injector filterte `status='open'`, aber der UDM Pro Incident hatte `status='acknowledged'` → wurde nicht geladen. Fix: Kein Status-Filter im DB-Query, stattdessen client-seitig auf active statuses (open/acknowledged/investigating/mitigating) filtern

## [0.19.0-multi-ha.445] - 2026-04-12

### Fixed
- **ITSM: Aktive Incidents im Chat-System-Prompt** — Alfred konnte in Chat-Konversationen keine Incidents updaten weil die Incident-IDs nur im Reasoning-Kontext (alle 30 Min) verfügbar waren, nicht im Chat-System-Prompt. Wenn der User sagte "update den Incident", kannte Alfred die ID nicht und der Tool-Call schlug fehl. Fix: `message-pipeline.ts` lädt jetzt bei jedem Chat aktive ITSM-Incidents (max 10, status: open/acknowledged/investigating/mitigating) per `itsm list_incidents` und fügt sie als `## Aktive ITSM-Incidents` Section in den System-Prompt ein, mit 8-stelliger Short-ID die der LLM direkt für `update_incident` verwenden kann

## [0.19.0-multi-ha.444] - 2026-04-12

### Added
- **Email: Volle Lifecycle-Awareness in 5 Levels** — Alfred kennt jetzt den vollständigen Status jeder Email (gelesen, beantwortet, automatisch) statt nur Subject/From/Date:
  - **Level 1 — Body-Preview + Read-Status:** `bodyPreview` (bereits von Graph geladen, aber nie angezeigt) wird jetzt im Display gezeigt (120 Zeichen). Expliziter Read-Status: 🔴 UNREAD, 📖 READ, ✅ REPLIED, ℹ️ AUTO
  - **Level 2 — Reply-Detection:** `conversationId` wird von Graph geladen. Neue Methode `detectReplies()` in Microsoft-Provider: batch-queried Sent Items (letzte 14 Tage) und matched conversationIds gegen Inbox. Emails die der User beantwortet hat bekommen `replied: true` → Display zeigt ✅ REPLIED. 1 extra Graph-Call pro fetchInbox, gecached pro Pass
  - **Level 3 — Automatische Kategorisierung:** `importance` und `inferenceClassification` (focused/other) von Graph geladen. Neue `AUTOMATED_SENDERS` Regex (`no_reply@`, `noreply@`, `notifications@`, `ci@`, `npm`, `github.com`, `gitlab.com`, `sentry.io`). Mails von automatischen Sendern oder mit `classification=other` bekommen ℹ️ AUTO Status. Inbox-Summary zeigt `needsReplyCount` (unread + unreplied + non-automated)
  - **Level 4+5 — Reasoning-Prompt Email-Lifecycle:** Neuer Prompt-Abschnitt "E-MAIL INSIGHTS" im Reasoning-Detail-Prompt: ✅ REPLIED ist erledigt (nicht als Handlungsbedarf), ℹ️ AUTO nur bei Anomalie erwähnen, 📖 READ ohne REPLIED könnte Antwort brauchen (kontextabhängig), bereits in Insight erwähnte Emails nicht erneut melden

### Changed
- **EmailMessage Interface erweitert** (`email-provider.ts`): Neue Felder `conversationId`, `replied`, `importance`, `classification`
- **Microsoft Provider `fetchInbox`:** Graph-Request enthält jetzt `conversationId,importance,inferenceClassification` + Reply-Detection via Sent-Items-Batch-Query
- **Email Display-Format:** Von `"1. [id][UNREAD] Subject\n   From: ... Date: ..."` zu `"1. [id] 🔴 UNREAD Subject\n   From: ... | 12.04. 11:15\n   Preview: erste 120 Zeichen..."` — reicheres Format mit Status-Icons, Datum im deutschen Format, Body-Preview

## [0.19.0-multi-ha.443] - 2026-04-12

### Fixed
- **Memory: `expires_at` Filter endlich aktiv in allen Queries** — Die `expires_at` Spalte existierte bereits (seit Migration v26) mit `setExpiry()`, `saveWithTTL()` und `cleanupExpired()` Methoden, aber die kritischen Lese-Methoden filterten NICHT darauf:
  - **`getRecentForPrompt()`**: Lädt jetzt nur Memories mit `expires_at IS NULL OR expires_at > now()`. Vorher: alle Memories inklusive abgelaufene → stale Event-Planungen landeten im Reasoning-Kontext und das LLM erfand daraus falsche zukünftige Termine
  - **`search()`**: Gleicher Filter ergänzt
  - **`getByType()`**: Gleicher Filter ergänzt (betrifft connection/pattern Memories im Reasoning-Kontext)
- **Memory-Cleanup in wöchentlicher Maintenance** — `cleanupExpired()` wird jetzt im Sonntag-4AM-Zyklus aufgerufen (zusammen mit TemporalAnalyzer, KG-Maintenance, ActionFeedbackTracker). Löscht abgelaufene Memories dauerhaft aus der DB
- **Generische Korrekturen statt datumsspezifische** — Neuer Prompt-Hinweis im Chat-System-Prompt (`prompt-builder.ts`): Wenn der User einen geplanten Trip/Termin korrigiert ("kein Trip", "findet nicht statt"), soll Alfred eine GENERISCHE Korrektur-Memory speichern (`correction_no_{topic}`) OHNE spezifisches Datum, plus `expires_at` auf den stale Planning-Memories setzen. Vorher: Alfred erstellte datumspezifische Korrekturen ("kein Trip am 12.04") die am nächsten Tag nicht mehr galten → LLM erfand den Trip für einen anderen Tag
- **DB-Cleanup: 14 stale Kapfenberg-Memories expired** — Trip-Planungen, datumspezifische Korrekturen und erledigte Insight-Delivery-Records zu Kapfenberg-Fahrten die nicht mehr aktuell sind. Permanente Fakten (Noah Internat, Distanz, Routenvergleich) unberührt

### Notes
- Keine DB-Migration nötig — `expires_at` Spalte existiert seit v26 (SQLite) und PG-Schema
- Die `extractFutureEventDate()` Methode im Memory-Extractor setzte bereits `expires_at` für erkannte Event-Dates — aber nur bei der Chat-Extraktion. KG-Connection-Memories und manuelle Saves nutzten es nicht. Mit dem Filter in den Read-Methoden wirkt `expires_at` jetzt durchgehend

## [0.19.0-multi-ha.442] - 2026-04-12

### Fixed
- **Reasoning-Engine: LLM darf keine Termine aus Memory-Fragmenten erfinden** — Neue Prompt-Sektion "KRITISCH — TERMINE UND DATEN" im Reasoning-Detail-Prompt. Verbietet dem LLM explizit, konkrete Datum+Uhrzeit-Kombinationen in Insights zu nennen die NICHT im Kalender-Block stehen. Memory-Einträge über vergangene Fahrten/Erinnerungen sind keine zukünftigen Termine. Hintergrund: Alfred hat wiederholt "Kapfenberg-Abfahrt 18.04. 18:00" in Insights genannt obwohl kein solcher Kalendertermin existiert — das LLM hat aus persistenten Memory-Fragmenten ("Kapfenberg 18:00" von einem alten Reminder, "Kapfenberg-Fahrten erfordern BMW-Ladeplanung" aus KG-Connections) ein falsches Datum konstruiert

## [0.19.0-multi-ha.441] - 2026-04-12

### Fixed
- **Kalender: DATUM fehlte im System-Prompt → LLM hat Tage geraten und falsch zugeordnet** — Root-Cause für das wiederkehrende Problem dass Alfred falsche Kalender-Daten nennt (z.B. "Noah-Termin am 14.04" statt 17.04). Die Ursache: `prompt-builder.ts:375` formatierte Events als `"08:45-09:45: Titel @ Ort"` OHNE das Datum. 21 Events über 7 Tage in einer flachen Liste, nur mit Uhrzeit — das LLM hatte keine Möglichkeit zu wissen welcher Tag welches Event hat und hat geraten. Fix: Jedes Event bekommt jetzt das Datum vorangestellt im Format `"Do. 17.04. 08:45–09:45: Titel @ Ort"` via `toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' })`. Ganztags-Events als "Ganztägig" statt "All day". En-Dash statt Hyphen für Zeitspannen

## [0.19.0-multi-ha.440] - 2026-04-12

### Added
- **MS Teams Adapter: Cluster-aware ConversationReference-Persistenz** — ConversationReferences werden bei jedem eingehenden Turn in der `skill_state` DB-Tabelle gespeichert (Key: `conv_ref:{chatId}`, Skill: `msteams`, User: `_system`). Beim `connect()` werden alle gespeicherten Refs aus der DB geladen. Dadurch:
  - **Cluster-Failover:** Wenn Node A crasht und Node B den `msteams` Adapter-Claim übernimmt, lädt B die ConversationRefs aus der DB und kann sofort proaktive Messages senden (Insights, Reminders) — ohne dass der User erneut schreiben muss
  - **Restart-Safe:** Nach Alfred-Restart gehen keine Conversation-Kontexte verloren
  - Interface `MSTeamsDbCallback` mit `saveConversationRef()` und `loadAllConversationRefs()` — Dependency-Injection Pattern (kein Storage-Import im messaging-Package nötig)
  - Wiring in `alfred.ts:initializeAdapters()`: DB-Adapter wird durchgereicht, nutzt `skill_state` Tabelle mit UPSERT-Pattern (ON CONFLICT UPDATE)

## [0.19.0-multi-ha.439] - 2026-04-12

### Added
- **MS Teams Messaging Adapter (Phase 1: Basic Chat)** — Alfred als Teams-Bot für 1:1 DMs, Gruppenchats und Channels:
  - Neuer Adapter `packages/messaging/src/adapters/msteams.ts` basierend auf Microsoft Bot Framework SDK (`botbuilder`)
  - Webhook-Listener (HTTP POST `/api/messages`) empfängt Bot Framework Activities
  - Eingehende Nachrichten werden zu `NormalizedMessage` gemappt (wie Telegram/Discord)
  - `@mention`-Stripping in Channels (Teams prefixed automatisch "@BotName")
  - Typing-Indicator sofort bei Nachrichteneingang
  - Proactive Messaging via `ConversationReference` — Alfred kann ohne vorherige User-Nachricht in bestehende Chats schreiben
  - `editMessage` und `deleteMessage` Support via Bot Framework `updateActivity`/`deleteActivity`
  - Health-Endpoint auf `/health` für Monitoring
  - Access Control: `dmPolicy` (open/allowlist/disabled), `allowedUsers` (AAD Object IDs), `requireMention` (Channels)
  - Config: `MSTeamsConfig` in `packages/types/src/config.ts` mit appId, appPassword, tenantId, webhookPort, webhookPath, dmPolicy, allowedUsers, requireMention, replyStyle
  - ENV-Overrides: `ALFRED_MSTEAMS_APP_ID`, `ALFRED_MSTEAMS_APP_PASSWORD`, `ALFRED_MSTEAMS_TENANT_ID`, `ALFRED_MSTEAMS_WEBHOOK_PORT`, etc.
  - Platform `'msteams'` zu `Platform` Union-Type hinzugefügt
  - `botbuilder@^4.23.0` als externalisierte Dependency in CLI package (lazy-loaded via `Function('return import(...)')()`)
  - Adapter-Registrierung in `alfred.ts:initializeAdapters()` wenn `config.msteams.enabled && config.msteams.appId`
  - Spec-Dokument: `docs/specs/msteams-adapter.md` mit Phase 2 (Files, History, Proactive) und Phase 3 (Adaptive Cards) Roadmap

### Notes — MS Teams Setup (einmalig nötig vor Nutzung)
1. Azure Bot Resource erstellen (App ID, Client Secret, Tenant ID)
2. Messaging Endpoint setzen auf `https://<public-url>/api/messages`
3. Teams App Manifest (ZIP) mit botId erstellen und sideloaden
4. Config setzen: `msteams.enabled=true`, `msteams.appId=...`, `msteams.appPassword=...`, `msteams.tenantId=...`
5. DNS + Nginx Proxy einrichten (z.B. teams.lokalkraft.at → Alfred:3978)

## [0.19.0-multi-ha.438] - 2026-04-12

### Fixed
- **KG Location-Validierung v2: Nominatim False-Positive-Rate drastisch reduziert** — Die v433-Nominatim-Validierung war zu breit: `r.class === 'place'` matched Farmen, Kioske und Bushaltestellen weltweit. Drei neue Schutzschichten:
  - **DACH-Country-Filter** (`countrycodes=at,de,ch`) in der Nominatim-URL — eliminiert Tennessee-Hamlets und irische Admin-Boundaries für deutsche Alltagswörter
  - **Importance-Threshold ≥ 0.3** — verifiziert: niedrigster echter DACH-Ort (Bisamberg) = 0.406, höchster False-Positive (Schritt/Farm) = 0.107. Sicherer Abstand
  - **Name-Match-Check** — `display_name` muss mit dem Suchbegriff beginnen (case-insensitive). Verhindert Fuzzy-Matches wie "Hause" → "Aglasterhausen"
  - **Type-Only-Filter statt Class-Catch-All** — akzeptiert nur `city/town/village/hamlet/suburb/municipality/administrative/country/state`. Schließt aus: `farm/isolated_dwelling/restaurant/fast_food/kiosk/highway/boatyard`
  - Konstanten `VALID_PLACE_TYPES` und `MIN_GEOCODE_IMPORTANCE` als statische Klassenfelder
- **PERSON_BLACKLIST erweitert** um 25+ neue deutsche Alltagswörter die als falsche Locations/Orgs aufgetaucht waren: `hause`, `match`, `schritt`, `memory`, `stelle`, `grunde`, `laufe`, `rahmen`, `sinne`, `summe`, `zuge`, `nähe`, `verbindungsprobleme`, `verfügung`, `vergleich`, `vorschlag` etc.
- **LLM Entity-Linker: Blacklist-Check hinzugefügt** (`llm-entity-linker.ts`) — der Linker erstellte Entities wie "Zuhause" (Organization) und "Verbindungsprobleme" (Organization) obwohl "zuhause" bereits in der PERSON_BLACKLIST war, weil der Linker die Blacklist komplett umging. Neue Methode `isBlacklistedEntityName()` mit eigener Wortliste + Heuristik (rein-lowercase single-word → skip) wird jetzt VOR `upsertEntity` geprüft
- DB-Cleanup: 6 falsche Entities gelöscht (Match, Hause, Schritt, Memory, Zuhause, Verbindungsprobleme) + 22 zugehörige Relations

## [0.19.0-multi-ha.437] - 2026-04-12

### Fixed
- **Microsoft Email: readMessage markiert Mails als gelesen** — Microsoft Graph GET auf Messages setzt `isRead` nicht automatisch (anders als Outlook Client oder IMAP FETCH mit `\Seen` Flag). Neuer PATCH-Call nach dem GET setzt `isRead: true`. Kritisch für Scheduled Tasks die ungelesene Mails verarbeiten: ohne diesen Fix wird dieselbe Mail bei jedem Cron-Tick erneut verarbeitet weil sie immer als ungelesen erscheint. Best-effort (try/catch), scheitert nicht wenn Mark-as-Read fehlschlägt

## [0.19.0-multi-ha.436] - 2026-04-11

### Fixed
- **Reasoning Action-Parser robuster gegen Emoji-Header und Multi-Block-JSON** — Behebt ein UX-Problem bei dem Roh-JSON-Action-Vorschläge des LLM als sichtbarer Text in Insights beim User landen statt verarbeitet zu werden:
  - **Header-Regex (`reasoning-engine.ts:830-870`)** akzeptiert jetzt Emojis und beliebige Zeichen zwischen `##` und `ACTIONS`. Vorher: `#{1,3}\s*ACTIONS?` (nur Whitespace erlaubt) → matched nicht `## 🔧 ACTIONS`. Jetzt: `#{1,3}[^\w\n]*ACTIONS?` (Emojis, Punktuation, Spaces erlaubt). Konstanten als statische Klassenfelder `ACTIONS_HEADER_REGEX` und `ACTIONS_HEADER_TRAILING_REGEX` ausgelagert
  - **Multi-Block-Parser (`tryParseActions`)** unterstützt jetzt drei Formate: (1) einzelnes JSON-Objekt `{...}`, (2) JSON-Array `[{...}, {...}]`, (3) mehrere separate JSON-Codeblöcke ```` ```json {...} ``` ```` mit Markdown dazwischen. Vorher wurde nur ein Array akzeptiert. Neue Hilfsmethode `parseSingleJsonExpression()` parst sowohl Objekte als auch Arrays
  - **Defensive Strip (`stripUnparsedActions`)** als Sicherheitsnetz: selbst wenn der Parser gar keine Actions extrahieren konnte, werden ACTIONS-Section-Header, JSON-Codeblöcke und Pseudo-Header `**Aktion #N: ...**` aus dem visible insight text wegstrippt. Verhindert dass Roh-JSONs jemals beim User landen
- **Symptom des behobenen Bugs**: Im 22:35 Insight vom 11.04. landeten zwei vollständige LLM-Action-JSON-Blöcke (`itsm:create_incident` + `reminder:set`) als sichtbarer Text in der Telegram-Nachricht beim User. Ursache: LLM hatte `## 🔧 ACTIONS` mit Emoji als Section-Header benutzt, der alte Regex erlaubte kein Emoji zwischen `##` und `ACTIONS`. Plus: zwei separate Codeblöcke statt einem Array → auch der Last-Resort-Parser griff nicht. Folge: 0 Actions geparst, kompletter Text inkl. JSON wurde als Insight ausgegeben

### Notes
- Beide Action-Vorschläge aus dem genannten 22:35 Insight wären auch nach diesem Fix nicht doppelt erstellt worden — der ITSM-Skill `createIncident` hat eine eigene Dedup-Schicht (`findOpenIncidentForAsset`), die den vorgeschlagenen "Infrastruktur-Fehler"-Incident gegen den existierenden `homeassistant: Health check failed`-Incident gemacht hätte (3+ shared keywords). Der Reminder-Vorschlag wäre durch den Reminder-Dedup-Gate in `processActions` gegen den existierenden 09:31-Reminder gefiltert worden. Der Fix ändert also primär das **Erscheinungsbild** (kein Roh-JSON mehr im Chat) und stellt sicher dass legitime Vorschläge zumindest in die Confirmation-Queue kommen statt verloren zu gehen

## [0.19.0-multi-ha.435] - 2026-04-10

### Added
- **ITSM Auto-Recovery für Monitor-Incidents** — Incidents die vom Monitor-Skill automatisch erstellt wurden, werden jetzt automatisch auf `resolved` gesetzt wenn die zugrundeliegende Bedingung sich selbst erledigt hat. Vermeidet Zombie-Incidents:
  - Neue Repo-Methode `findRecoveryCandidates()` in `itsm-repository.ts` mit strikten Filter-Kriterien: `status='open'` + `detected_by='monitor'` + `updated_at > 60min alt` + keine User-Notes (`investigation_notes`, `lessons_learned`, `action_items`, `postmortem` leer) + nicht zu einem Problem verlinkt (`problem_id IS NULL`)
  - Monitor-Wrapper in `alfred.ts` erweitert um Recovery-Scan: läuft nach Alert-Processing auf JEDEM erfolgreichen Monitor-Run (auch bei leerem Alert-Result — genau dann ist Recovery möglich)
  - Source-Safety: Recovery-Kandidaten werden nur für Sources ausgeführt die (a) im aktuellen Run gecheckt wurden und (b) keinen "Health check failed" Alert lieferten. API-Timeouts führen nicht zu fälschlichem Auto-Resolve
  - Input-`checks`-Scope wird respektiert: Monitor-Call mit `{ checks: ['proxmox'] }` resolved nur Proxmox-Incidents, nicht UniFi/HA/PBS
  - Title-Prefix-Match gegen clean sources (`proxmox:` / `unifi:` / `homeassistant:` / `proxmox_backup:`) — konsistent mit bestehender Dedup-Logik
  - Resolution-Text: `🔄 Auto-resolved: Monitor-Bedingung für "{source}" ist seit {N}min nicht mehr aufgetreten. Finaler Close liegt beim User.`
- **Reasoning Context Enhancement**: `reasoning-context-collector.ts` unterscheidet in "Kürzlich gelöst (24h)" Section jetzt zwischen normalen Resolves `(resolved)` und Auto-Resolves `(🔄 auto-resolved)` via Resolution-Prefix-Check. Dadurch kann das LLM auto-resolvte Incidents im nächsten proaktiven Briefing distinct erwähnen ohne neue Notification-Infrastruktur

### Fixed
- Monitor-Wrapper lief bisher nur wenn `result.data.length > 0`. Restrukturiert auf `if (result.success)` damit der neue Recovery-Scan auch auf clean runs (0 Alerts) ausgeführt wird. Alert-Processing + health_check Verhalten bleibt unverändert

## [0.19.0-multi-ha.434] - 2026-04-10

### Fixed
- **KG Location: Designfehler in TRUSTED_SOURCES behoben + Address-Pollution gestoppt** — Nachfolge-Fix zu v433:
  - **Designfehler:** v433 trustete Locations mit `sources: ['memories'|'bmw'|'weather'|'llm_linking']`. Aber `sources` enthält sectionKey-Strings, NICHT echte Provenance — ein Regex-Hit in Memory-Text ergibt automatisch `sources: ['memories']`, auch wenn der Treffer Mist ist. Dadurch konnten "Fußball-Match", "Bedarf", "Internat Kapfenberg" trotzdem in `knownLocationsLower` landen
  - **Fix:** `refreshKnownLocations()` lädt jetzt AUSSCHLIESSLICH Entities mit `geocodeValidated: true` Attribut. Source-basiertes Trust komplett entfernt
  - **Self-Reinforcing Loop in `extractFromMemories()`:** beim Address-Scan wurde der KOMPLETTE Memory-Text als `address`-Feld der Location-Entity gespeichert (deshalb stand bei "Fußball-Match" eine ganze Briefing-Zusammenfassung im address-Feld). Fix: nur den passenden Satz, max 200 Zeichen
  - DB-Cleanup: 3 zombie Locations gelöscht (Fußball-Match, Bedarf, Internat Kapfenberg)
  - Saubere Echte (Hamburg, Düsseldorf, Eichgraben, Eggelsberg, Sankt Pölten) heilen sich automatisch: bei nächster Text-Extraktion → Nominatim → ✅ → upsert mit `geocodeValidated: true`

## [0.19.0-multi-ha.433] - 2026-04-10

### Fixed
- **KG Location-Erkennung: Nominatim-Validierung statt Hardcoded-Liste** — generische, dynamische Lösung gegen False Positives ("Memories", "Hinweis", "Bitcoin", "Microsoft Todo", "Ladeort"):
  - Neue Methode `validateLocationViaGeocoding()`: prüft jeden Geo-Regex-Candidate per Nominatim (`nominatim.openstreetmap.org/search`) auf reale Existenz als Ort (`class=place|boundary` oder `type=city|town|village|hamlet|suburb|municipality|administrative|country|state`)
  - In-Memory `geocodeCache` Map verhindert wiederholte Lookups für gleiche Candidates
  - Rate-Limit konform (1 Request/Sekunde via `lastGeocodeFetchAt` Throttle)
  - 5s HTTP-Timeout + konservativer Fallback (bei Fehler → kein Entity erstellen)
  - `extractLocations()` Pfad 2 (geo_pattern) ruft Validierung VOR `upsertEntity` auf — markiert validierte Locations mit `geocodeValidated: true` Attribut
  - `refreshKnownLocations()` lädt nur Entities aus TRUSTED_SOURCES (`memories`, `bmw`, `weather`, `llm_linking`) ODER mit `geocodeValidated: true` Flag → durchbricht den Self-Reinforcing Feedback-Loop
  - `insightTracking` Section in Exclude-Listen ergänzt (war Quelle vieler False Positives)
  - DB-Cleanup: 7 falsche Locations entfernt (Memories, Hinweis, Bitcoin, Microsoft Todo, Ladeort, West Europe, Altengbach)

## [0.19.0-multi-ha.424] - 2026-04-09

### Fixed
- **BMW: Token-userId nachhaltig gelöst** — Grundlegende Architektur-Bereinigung statt Quickfix:
  - Neues `tokenUserId` Feld: einmal gesetzt durch `setServiceResolver(ownerMasterUserId)`, danach fix für alle Token-Operationen
  - Token-Getter/Setter, `loadTokensFromDisk`, `saveTokens`, `resolveDbAccess` nutzen alle konsistent `tokenUserId`
  - `startStreaming()`: kein userId-Loop mehr, direkter Load über `tokenUserId`
  - `reconnectWithFreshToken()`: kein Multi-Path-Workaround, einfacher RAM-Clear + Reload
  - `execute()`: setzt `tokenUserId` als Fallback wenn nicht durch `setServiceResolver` initialisiert
  - Token-Migration beim Start: konsolidiert alte `bmw-tokens-default.json` / `bmw-tokens-{alfredUserId}.json` in die kanonische `bmw-tokens-{ownerMasterUserId}.json`

## [0.19.0-multi-ha.422] - 2026-04-09

### Fixed
- **Reasoning: Deferred Insights Cross-Node Flush** — Flush-Check am Anfang jedes Reasoning-Ticks statt nur innerhalb `deliverOrDefer()`. Activity-Detection via DB-Query (letzter User-Message Timestamp), nicht lokaler RAM. Funktioniert cross-node: Reasoning auf .93 erkennt User-Activity auf .92.

## [0.19.0-multi-ha.420] - 2026-04-09

### Fixed
- **BMW MQTT: Token-Reload vor Reconnect** — `reconnectWithFreshToken()` lädt jetzt IMMER den Token von Disk/DB bevor er refresht wird. Wenn ein `bmw authorize` auf einem anderen Node oder über Chat einen frischen Token gespeichert hat, wird dieser beim nächsten Reconnect gefunden statt den alten ungültigen Token endlos zu recyclen.

## [0.19.0-multi-ha.419] - 2026-04-09

### Fixed
- **BMW: Token-Refresh Resilienz** — 3 Ursachen für häufiges Re-Authorize behoben:
  1. `this.tokens = null` nur noch bei echtem 400/401 (invalid refresh token), NICHT bei Netzwerk-Fehlern oder 5xx. Transiente Fehler → Token bleibt im RAM, nächster Reconnect versucht erneut.
  2. Retry-Mechanismus: 1 automatischer Retry nach 3s bei Netzwerk/Timeout/5xx Fehlern.
  3. Logging: BMW-API Response-Status wird geloggt bei Fehler (vorher nur generischer Fehlertext).

## [0.19.0-multi-ha.418] - 2026-04-09

### Fixed
- **BMW MQTT: Reconnect-Logik überarbeitet**
  - Normal-Disconnect (BMW schließt Idle-Verbindungen) → fester 60s Reconnect, KEIN Backoff
  - Error-Disconnect (Bad Password, Connection Refused) → Exponential Backoff wie bisher
  - Authorize → setzt Backoff-Counter + Error-Flag auf 0 zurück
  - `startStreaming()` Guard gelockert: disconnected Client wird aufgeräumt statt blockiert

## [0.19.0-multi-ha.417] - 2026-04-09

### Added
- **ITSM Problem Management — Phase 5: WebUI komplett**
  - Neuer "Problems" Tab in ITSM-Seite mit Filter (Status, Priority), Tabelle, Detail-Panel
  - Problem-Lifecycle: Logged→Analyzing→Root Cause→Fix in Progress→Resolved→Closed mit Transition-Modals
  - EditableTextField: Description, Root Cause, Workaround, Proposed Fix
  - Known Error Toggle + Beschreibung (amber callout)
  - Analysis Notes append-only (wie Incident Investigation Notes)
  - Verknüpfte Incidents + Linked Change Request Anzeige
  - Timeline (Detected, Analyzed, Root Cause, Resolved, Closed)
  - Create Problem Modal (Titel, Priority, Category, Description, Workaround)
  - 7 neue API-Client-Methoden

## [0.19.0-multi-ha.416] - 2026-04-09

### Added
- **ITSM Problem Management — Phase 3+4: HTTP + Reasoning**
  - 10 neue API-Endpoints: CRUD Problems, link/unlink Incidents, fix-change, detect-patterns, dashboard
  - snake→camelCase Mapping für Problem-Updates (konsistent mit Incident/Change)
  - Reasoning-Prompt: Problem-Regeln (3+ Incidents → Problem, Known Error → Workaround zitieren, permanent Fix → Change)
  - Reasoning-Kontext: Aktive Probleme + Known Errors mit Workaround-Preview im CMDB/ITSM-Block

## [0.19.0-multi-ha.415] - 2026-04-09

### Added
- **ITSM Problem Management — Phase 2: Skill Layer**
  - 11 neue Skill-Actions: create_problem, update_problem, get_problem, list_problems, link_incident_to_problem, unlink_incident_from_problem, promote_to_problem, create_fix_change, mark_known_error, detect_problem_patterns, problem_dashboard
  - ProblemRepository an ItsmSkill-Constructor angebunden
  - promote_to_problem: Incident→Problem Hochstufung mit Auto-Link + Severity→Priority Mapping
  - create_fix_change: Change Request als permanenten Fix mit bidirektionaler Verknüpfung + auto Status-Advance
  - detect_problem_patterns: Keyword+Asset+Service Clustering mit Markdown-Tabelle

## [0.19.0-multi-ha.414] - 2026-04-09

### Added
- **ITSM Problem Management — Phase 1: Types + Storage**
  - `CmdbProblem` Interface: 27 Felder, 6-Status-Lifecycle (logged→analyzing→root_cause_identified→fix_in_progress→resolved→closed), Known-Error-Flag, Root-Cause-Analyse, bidirektionale Incident/Change-Verknüpfung
  - `ProblemRepository`: CRUD, linkIncident/unlinkIncident (bidirektional mit Denormalisierung), linkChangeRequest, appendAnalysisNotes (atomic), detectPatterns (Keyword+Asset+Service Clustering), getDashboard
  - Migration v54: `cmdb_problems` Tabelle + `problem_id` auf Incidents + `linked_problem_id` auf Change Requests
  - `CmdbIncident.problemId` + `CmdbChangeRequest.linkedProblemId` Felder

## [0.19.0-multi-ha.413] - 2026-04-09

### Added
- **ITSM: Change-Prozess vollständig** — Analog zum Incident-Lifecycle:
  - `update_change` + `get_change` Skill-Actions (Pläne editierbar, Details abrufbar)
  - WebUI: EditableTextField für Implementation Plan, Rollback Plan, Test Plan, Description
  - WebUI: Transition-Modal mit Pflichtfeldern (Complete → result, Rollback → result)
  - WebUI: Asset-Verknüpfung mit Name-Auflösung + Dropdown-Picker
  - WebUI: Result-Anzeige im Detail-Panel

## [0.19.0-multi-ha.412] - 2026-04-09

### Fixed
- **Code Review: letzte 3 MEDIUM Bugs**
  1. CMDB Tags: Refetch nach Save statt optimistischem string[]-to-string Cast
  2. ITSM `generateRunbook`: doppelter `itsmListServices` Fetch eliminiert
  3. ON CONFLICT Guards: SQL-Kommentar dokumentiert das Schutz-Verhalten (manual, correction)

## [0.19.0-multi-ha.411] - 2026-04-09

### Fixed
- **Code Review: 10 MEDIUM Bugs gefixt**
  1. `fetchInsightTracking`: Key-Prefix-Filter statt LIKE-Suche (verhindert false positives)
  2. Token-Schätzung: `/4` → `/3.5` im Reasoning-Collector (konsistent mit prompt-builder)
  3. Family Inference: liest jetzt `rel.context` UND `memoryKey` für Mutter/Vater/Geschwister-Erkennung
  4. `searchEntitiesWithRelations`: Kommentar korrigiert ("bounded N+1" statt "Single query")
  5. HA `update_*` Actions: zeigen jetzt "updated" statt "created" in Success-Message
  6. InfraDocs Mermaid: Cluster-Shape `[[[...]]]` → `[[...]]` (valides Subroutine-Shape)
  7. BMW Non-Chunked Path: Dedup mit `seenIds` Set (konsistent mit Chunked-Path)
  8. SEED_LOCATIONS: durchlaufen jetzt `isPlausibleLocation()` Gate bei Initialisierung
  9. (MEDIUM 24/25/31 übersprungen — Frontend Tags Typ-Mismatch, doppelter Fetch, ON CONFLICT Doku — niedrig priorisiert)

## [0.19.0-multi-ha.410] - 2026-04-09

### Fixed
- **Code Review: 10 HIGH Bugs gefixt**
  1. `buildPersonalContext`: `lives_at` Switch-Case hinzugefügt — Locations nicht mehr stillschweigend verworfen
  2. LLM-Linker: `newName` jetzt auch im Haupt-Prompt `buildPrompt` dokumentiert (war nur in `analyzeRecentChats`)
  3. `insightTracking`: P2→P1 mit 150 Token — wird nicht mehr als letztes truncated
  4. `queryRelevantContext` Dedup: case-insensitive Wort-Match statt `includes()` Substring
  5. `appendSymptoms`: atomic SQL CASE-Append statt Read-Modify-Write (HA race-safe)
  6. `findOpenIncidentForAsset`: 1 Query mit `IN(...)` statt 4 separate Queries
  7. `tickRunning` Class-Field entfernt (war shadowed durch lokale Variable, dead code)
  8. Priority Dropdown: `Number()` Cast entfernt — sendet jetzt konsistent String
  9. Transition Modal: `transitionFields` nach Submit gecleared — keine stale Fields mehr
  10. BMW Chunk-Boundary: `chunkEnd = chunkStart - 1` verhindert Overlap an Wochengrenzen

## [0.19.0-multi-ha.409] - 2026-04-09

### Fixed
- **5-Team Code Review: 8 CRITICAL Bugs gefixt**
  1. `updateChange`/`updateService` API: snake→camelCase Mapping fehlte — WebUI PATCH Updates taten nichts
  2. `personalContext` Cache: In-Memory dirty-Flag → DB-basierte 5min TTL (HA cross-node safe)
  3. Proxmox Storage Discovery: `list_storage` nutzte `defaultNode` statt cluster-weiten `/storage` Endpoint
  4. `get_incident` Display: investigationNotes, lessonsLearned, actionItems fehlten in der Ausgabe
  5. Memory Skill Schema: `correction` Typ in `inputSchema.enum` ergänzt (war nur in Runtime allowedTypes)
  6. ITSM Incident Dedup: Keywords jetzt aus Content nach `:` statt vollem Titel, generische Wörter gefiltert
  7. `upsertRelation`: Re-fetch aus DB nach ON CONFLICT statt stale In-Memory Daten zurückgeben
  8. Prompt Injection: `eventData`/`eventDescription` in Reasoning-Prompt sanitized (Newlines, `=` entfernt)

## [0.19.0-multi-ha.408] - 2026-04-09

### Fixed
- **Revert: FeedbackService Keyword-Overwrite** — Gefährlicher Keyword-Match der korrekte Memories hätte überschreiben können wurde entfernt. Korrekturen werden wieder sicher als separate Einträge gespeichert (type: correction, source: manual).
- **Revert: "Ich merke mir" Double-Trigger** — Unnötiger doppelter Active-Learning-Trigger entfernt. Active Learning wird bereits bei Zeile 990 ausgelöst; "habe korrigiert" matchte auch Tool-Call-Responses.
- **LLM Linker: `newName` im Prompt** — Das `newName` Feld war im LLM-Correction-Schema nicht dokumentiert → wurde nie ausgelöst. Jetzt im Prompt als optionales Feld für Entity-Rename sichtbar.

## [0.19.0-multi-ha.407] - 2026-04-09

### Fixed
- **Korrektur-Pipeline: 8 Bugs vollständig gefixt**
  - **Bug 1**: FeedbackService überschreibt jetzt das falsche Memory direkt (Keyword-Match + Key-Reuse) statt einen Timestamp-Key daneben zu legen. Korrektur wird als `type: correction`, `source: manual`, `confidence: 1.0` gespeichert.
  - **Bug 2**: canonicalPersons prüft jetzt Correction-Memories vor der Kanonisierung. "Noah heißt Habel" → canonical Name wird auf "Noah Habel" aktualisiert statt "Noah Dohnal" zu behalten.
  - **Bug 3**: `correction` Typ hat jetzt garantierten Slot im Chat-Prompt (neben `pattern` + `connection`). Korrekturen werden nicht mehr von generischen Memories verdrängt.
  - **Bug 4**: Post-Processing erkennt "Ich merke mir"/"habe korrigiert" im LLM-Response und triggert Active-Learning falls kein Memory-Tool-Call gemacht wurde.
  - **Bug 5**: Memory-Skill `allowedTypes` erweitert um `correction`. LLM kann jetzt explizit Korrektur-Memories anlegen.
  - **Bug 6**: ON CONFLICT Guard schützt jetzt auch `correction`-Type Memories vor auto-Overwrite (zusätzlich zu `manual` Source).
  - **Bug 7**: Reasoning Detail-Prompt enthält explizite Regel: "manual-Source + correction-Type Memories haben ABSOLUTEN Vorrang vor eigenen Beobachtungen."
  - **Bug 8**: LLM Entity Linker kann jetzt Entity-Namen korrigieren (`newName` Feld in `LLMCorrection`). Neue Repository-Methode `renameEntity()`.

## [0.19.0-multi-ha.406] - 2026-04-08

### Fixed
- **Reasoning: Insight-Tracking als eigene Context-Section** — `insight_delivered` Memories von Typ `connection` → `feedback` mit 7-Tage Expiry umgestellt. Eigene P2-Section "Insight-Tracking" (100 Token Budget) im Reasoning-Kontext statt Memory-Connection-Slots. Active-Learning Connections werden nicht mehr von Insight-Logs verdrängt.

## [0.19.0-multi-ha.405] - 2026-04-08

### Added
- **HomeAssistant: `update_automation/script/scene` Actions** — Aliases für `create_*` (HA Config API ist idempotent — POST mit gleicher ID = Update). Schließt die CRUD-Lücke die zu LLM-Halluzinationen führte.
- **Reasoning: Action-Schema-Validierung** — Vorgeschlagene Actions werden gegen das Skill-Schema (`inputSchema.properties.action.enum`) validiert bevor sie ausgeführt oder in die Confirmation Queue enqueued werden. Halluzinierte Actions werden mit Warnung geloggt und übersprungen.

## [0.19.0-multi-ha.404] - 2026-04-08

### Fixed
- **BMW: Lade-Sessions Pagination** — BMW API liefert max ~10 Sessions pro Call. Bei Zeiträumen >14 Tage wird jetzt in 7-Tage-Chunks iterativ abgefragt mit Dedup. Laufende Nummer, Gesamtzähler + Summe kWh am Ende.

## [0.19.0-multi-ha.403] - 2026-04-08

### Fixed
- **KG: Location Quality-Gate `isPlausibleLocation()`** — Zentrale Validierung an 3 Stellen (refreshKnownLocations, registerLocation, extractLocations). Filtert: <4 Zeichen ("Ort"), Tech-Keywords ("Sovereign Cloud", "Digital Hub"), Noun-Suffixe, Sonderzeichen, Blacklist.
- **CMDB: Storage Discovery `enabled` Filter** — `!s.enabled` filterte `undefined` als disabled. Fix: nur explizit `false`/`0` skippen.
- **CMDB: Alte Daten unter falscher userId bereinigt** — 2206 Assets + 98 Relations + 1976 KG-Entities unter alfredUserId gelöscht (ownerMasterUserId-Fix v383 war korrekt, alte Daten nie aufgeräumt).

## [0.19.0-multi-ha.400] - 2026-04-08

### Added
- **Brain: Persönliches Umfeld im Chat (Tier 1)** — `buildPersonalContext()` liefert kompakten Kontext-Block: engste Familie (Spouse, Kinder, Eltern, Geschwister), Arbeitgeber, Wohnsitz/Büro, Fahrzeug, Smart Home Geräte-Zähler, Metriken. Gecached (1h/dirty-Flag). Ersetzt `buildDeviceContext` im Chat-Prompt. Max ~150 Token.
- **Brain: Query-aware KG-Kontext (Tier 2)** — `queryRelevantContext()` extrahiert Keywords aus der User-Nachricht, findet relevante KG-Entities + 1-Hop Relations, dedupliziert gegen Tier 1. Neue Repository-Methode `searchEntitiesWithRelations()` (Single JOIN). 0-200 Token, nur wenn relevant.
- **Brain: Insight-Feedback-Loop** — Gesendete Insights werden als `insight_delivered:` Memory gespeichert. User-Acknowledgments (danke/ok/erledigt) erzeugen `insight_resolved:` Memory. Reasoning-Prompt enthält Follow-up Regel für unerledigte Insights >24h.

## [0.19.0-multi-ha.399] - 2026-04-08

### Fixed
- **KG: Location Quality-Gate** — `refreshKnownLocations()` filtert Garbage-Entities (Newlines, Sonderzeichen, deutsche Noun-Suffixe, Blacklist-Wörter) aus der dynamischen Location-Liste. Verhindert dass alte Fehl-Entities die Erkennung vergiften.
- **KG: Suffix-Filter ohne Length-Guard** — Deutsche Noun-Suffixe (-ung, -heit, -keit, -schaft, -tion, -tät, -nis, -ment, -tag, -zeit, -stück) werden unabhängig von der Wortlänge gefiltert. "Führung" (7 Zeichen) wird jetzt korrekt als Nicht-Ort erkannt.
- **KG: Newline/Sonderzeichen Guard** — `extractLocations()` lehnt Candidates mit `\n\r\t/|` ab. Verhindert "Altlengbach\nGemerkt" etc.
- **KG: Location-Blacklist** — PERSON_BLACKLIST erweitert um häufige "in X" False-Positives: Stunden, Absprache, Abstimmung, Home Assistant, etc.
- **KG: DB-Bereinigung** — 8 falsche Location-Entities + 7 falsche Person-Entities gelöscht (Home Assistant, Führung, Stunden, Noah Fußball, Wien Haupt, etc.)

## [0.19.0-multi-ha.398] - 2026-04-08

### Changed
- **KG: Dynamische Location-Erkennung** — `KNOWN_LOCATIONS` (35 hardcoded österreichische Städte) ersetzt durch selbstlernendes System:
  - **Seed-Liste** als Kaltstart-Schutz (bleibt, wird aber beim Start mit KG-Entities vom Typ `location` gemergt)
  - **PLZ-Regex** erkennt Orte aus Adressen generisch ("3033 Altlengbach", "80331 München", "10115 Berlin")
  - **Geo-Präposition** erkennt neue Orte aus Chat ("nach Berlin", "in London") — registriert sie für zukünftige Erkennung ohne Präposition
  - **Dynamische KG-Liste** wächst mit: einmal erkannter Ort wird in allen 8 Erkennungsstellen genutzt
  - **Wetter-Location** im Reasoning-Collector: PLZ-Regex + Komma-Extraktion statt hardcoded 8-Städte-Liste
- **KG: `isInvalidPersonName` dynamisch** — Person-Guard prüft gegen dynamische Location-Liste statt hardcoded Array

## [0.19.0-multi-ha.397] - 2026-04-08

### Added
- **CMDB: Proxmox Cluster Discovery** — `/cluster/status` API liefert Cluster-Asset (Name, Quorum, Version, Node-Count) + Node-IPs (Corosync Ring0). Bei Single-Node graceful skip.
- **CMDB: Proxmox Storage Discovery** — Cluster-weite Storage-Assets (Name, Typ, Content, Kapazität). `cluster → connects_to → storage` Relations.
- **CMDB: Asset-Typen `cluster` + `storage`** — Neue CmdbAssetType-Werte, keine DB-Migration nötig (TEXT-Spalte).
- **CMDB: Node → Cluster `part_of` Relations** — Jeder Proxmox-Node ist `part_of` seines Clusters.
- **KG: cluster/storage Typ-Mapping** — Beide mappen auf KG-Entity-Typ `server` (Infrastruktur).
- **WebUI: Cluster Farbe + Größe** — Lila (#c084fc), größter Node im Topologie-Graph (val=8).
- **Topologie: Cluster + Storage Shapes** — Mermaid: Cluster = Subroutine (Doppelrahmen), Storage = Zylinder. Eigene CSS-Klassen.

### Fixed
- **CMDB: Proxmox Node-IPs** — Waren immer `undefined` weil `/nodes` keine IPs liefert. Jetzt aus `/cluster/status` Node-Entries extrahiert.

## [0.19.0-multi-ha.396] - 2026-04-08

### Fixed
- **ITSM: Timestamps in Lokalzeit** — Symptoms + Investigation Notes Append-Timestamps in Server-Timezone (Europe/Vienna) statt UTC. Format: `08.04.2026, 01:30` statt `[2026-04-07T23:30:00.000Z]`.

## [0.19.0-multi-ha.395] - 2026-04-08

### Fixed
- **ITSM: Append-Separator `---`** — Symptoms + Investigation Notes verwenden wieder `---` als visuelles Trennzeichen zwischen Einträgen, konsistent mit dem bestehenden Format.

## [0.19.0-multi-ha.394] - 2026-04-08

### Fixed
- **ITSM: Severity + Priority editierbar (WebUI)** — Inline-Dropdowns im Incident-Detail statt read-only Badges. Bei geschlossenen Incidents read-only.

## [0.19.0-multi-ha.393] - 2026-04-08

### Fixed
- **ITSM: Migration v53** — lessons_learned + action_items Spalten als eigene Migration (v52 war bereits deployed mit nur investigation_notes). Behebt HTTP 500 beim Speichern von Lessons Learned / Action Items im WebUI.
- **ITSM: Review-Fixes** — 6 Bugs/Gaps behoben: Transition-Modal State-Leak bei acknowledged, Note-State bei Incident-Wechsel nicht zurückgesetzt, EditableTextField stale bei Wechsel, appendSymptoms Format inkonsistent, 5→1 DB-Calls für Reasoning-Kontext, lessons_learned/action_items im Prompt.

## [0.19.0-multi-ha.391] - 2026-04-07

### Added
- **ITSM: investigation_notes, lessons_learned, action_items Felder** — 3 neue DB-Felder (Migration v52). investigation_notes = chronologisches Append-Feld für Analysen/Tätigkeiten. lessons_learned + action_items = optional bei Close oder jederzeit editierbar.
- **ITSM: Status-Transition-Modal (WebUI)** — Statuswechsel-Buttons öffnen Modal mit kontextabhängigen Pflichtfeldern: investigating → investigation_notes, mitigating → workaround, resolved → root_cause + resolution, closed → lessons_learned + action_items (optional).
- **ITSM: Inline-Editing im Detail-Panel** — "Notiz hinzufügen" Button für investigation_notes jederzeit (nicht nur bei Statuswechsel). Lessons Learned + Action Items als editierbare Felder mit Speichern/Abbrechen.
- **ITSM: Asset/Service-Verknüpfung (WebUI)** — Betroffene Assets und Services: Name statt UUID anzeigen, Dropdown-Picker zum Hinzufügen, ×-Button zum Entfernen. CMDB-Assets werden beim Laden mitgeladen.
- **ITSM: Mitigating Button + Badge** — Fehlender UI-Button + Status-Badge für "mitigating" hinzugefügt.
- **ITSM: Reasoning sieht alle aktiven Incidents** — Nicht nur "open", sondern auch acknowledged/investigating/mitigating + kürzlich gelöste (24h). Root-Cause wird im Kontext mitgeliefert.

### Fixed
- **ITSM: update_incident Schema erweitert** — investigation_notes, lessons_learned, action_items, postmortem, related_incident_id waren in DB aber nicht im Skill-Schema. symptoms + investigation_notes als Append-Felder (chronologisch mit Timestamp).
- **ITSM: Postmortem-Template** — Zeigt investigation_notes, liest lessons_learned + action_items aus DB (Fallback: dynamisch generiert). Hinweise welcher Status welches Feld befüllt.
- **ITSM: Reasoning Incident-Lifecycle** — Prompt erklärt vollständigen Lifecycle (open→acknowledged→investigating→mitigating→resolved→closed) mit Feld-Zuordnung pro Status.

## [0.19.0-multi-ha.368] - 2026-04-07

### Fixed
- **KG: User realName aus Profil** — User-Entity bekommt dynamisch `realName` aus Profil/Memories. LLM sieht `[person] "User" (Realname: ...)` und erstellt keine Duplikat-Entities mehr.
- **KG: Generische Duplikat-Regel** — LLM-Prompt: "Keine Entities erstellen die eine existierende Entity unter anderem Namen beschreiben."
- **KG: Spouse Guard** — `spouse` Relation braucht `sources.includes('memories')` wie `sibling`.
- **KG: Location-Patterns** — Geo-Präpositions-Extraktion: "nach Köln", "in London", "Messe in Berlin" → Location-Entity. Nicht mehr nur KNOWN_LOCATIONS.
- **KG: Phantom-Entity Cleanup** — `migrateEntityRelations()` + automatische Erkennung in Maintenance.

## [0.19.0-multi-ha.366] - 2026-04-07

### Added
- **KG: Relation-Decay** — `decayOldRelations(30, 0.1)` analog zu Entity-Decay. Stale Relations verlieren Strength über Zeit und werden bei <0.2 gepruned. Verhindert Noise-Akkumulation.
- **KG: LLM sieht existierende Relations** — Top-50 Relations als Kontext im LLM-Linker-Prompt. LLM kann veraltete Relations identifizieren und `weaken`/`remove` vorschlagen.
- **KG: LLM kann Relations schwächen/entfernen** — Neue Actions `weaken` (Strength halbieren) und `remove` (löschen) für veraltete/falsche Relations.
- **KG: Confidence nach Source-Qualität** — Memory: +0.3, CMDB: +0.2, Chat: +0.15, LLM/SmartHome: +0.1, Feeds: +0.05 statt pauschal +0.1.
- **KG: `mentioned_with` statt `relates_to`** — Generic-Linker erzeugt semantisch ehrlicheren Relation-Typ. LLM-Linker kann zu spezifischem Typ upgraden.
- **KG: Entity Cap 200→500, Relation Cap 500→1000** — `getFullGraph()` Limits erhöht. Log-Warnung wenn Cap erreicht wird.

## [0.19.0-multi-ha.365] - 2026-04-07

### Fixed
- **Reminder-Spam behoben** — 3 Fixes: (1) Keyword-Dedup nutzte falsche userId (Telegram-Chat-ID statt masterUserId) → Dedup fand nie existierende Reminders. (2) Gefeuerte Reminders (letzte 24h) im Reasoning-Kontext sichtbar als "✅ BEREITS ERINNERT" → LLM sieht dass Thema schon behandelt wurde. (3) Action-Hash Expiry-Check repariert → wasNotified prüft jetzt das Ablaufdatum.

## [0.19.0-multi-ha.364] - 2026-04-06

### Fixed
- **LLM Entity-Linker: CMDB-only Entities gefiltert** — Entities mit `sources === ['cmdb']` werden aus dem Linker-Prompt ausgeschlossen. Reduziert ~2.700 → ~500 Entities (identisch mit vor CMDB). Cross-Domain Entities (CMDB + andere Source) bleiben erhalten. Behebt den permanenten 30s Timeout seit CMDB-Discovery.
- **LLM Entity-Linker: lastRunAt bei Fehler setzen** — Verhindert Retry bei jedem Reasoning-Zyklus. Bei Timeout/Fehler wartet der Linker bis zum nächsten Schedule statt 48 Fehl-Calls/Tag.
- **KG Generic-Linker: CMDB-only Filter** — `buildGenericEntityLinks` filtert CMDB-only Entities. Reduziert O(n²) von 7,3 Mio auf ~250k Regex-Operationen pro Zyklus.

## [0.19.0-multi-ha.363] - 2026-04-06

### Fixed
- **Monitor→Incident: userId auf ownerMasterUserId** — Incidents werden jetzt unter der korrekten Master-UUID erstellt statt der rohen Telegram-Chat-ID. Verhindert dass Incidents in der API/WebUI unsichtbar sind.
- **Monitor→Incident: Fehler loggen** — `catch {}` → `catch (err) { logger.warn(...) }`. Fehlgeschlagene Incident-Erstellungen werden jetzt geloggt statt still geschluckt.

## [0.19.0-multi-ha.362] - 2026-04-06

### Fixed
- **Reasoning: LLM bekommt jetzt Datum/Uhrzeit** — `ctx.dateTime` wird als erste Zeile in alle Reasoning-Prompts injiziert. LLM halluziniert keine Zeitstempel mehr.
- **Reasoning: User-Timezone** — Reasoning-Engine, Context-Collector und DeliveryScheduler nutzen jetzt die User-Timezone (aus Profil) statt Server-UTC. Alle Stunden-Buckets (Activity-Profile, Delivery-Entscheidung) sind timezone-korrekt.
- **DeliveryScheduler: Timezone-aware** — `getHours()` → `toLocaleString` mit User-Timezone. Activity-Profile wird in User-Stunden gebaut. Delivery-Entscheidung prüft User-Stunde, nicht UTC-Stunde.
- **Deferred Insights: Alter-Hinweis** — Insights die >30 Min deferred waren zeigen "(erstellt vor Xh)" im Titel bei Zustellung.

## [0.19.0-multi-ha.361] - 2026-04-06

### Fixed
- **ITSM Incident-Dedup** — ItsmSkill prüft vor Erstellung ob ein ähnlicher Incident bereits offen ist (Keyword-Match). Bei Duplikat: existierenden Incident zurückgeben + Symptoms anhängen statt neuen erstellen.
- **Monitor-Batch Verknüpfung** — Alerts gleicher Source im selben Monitor-Lauf werden über `relatedIncidentId` verknüpft. Keyword-Match → Symptoms-Append, verschiedenes Thema → neuer verknüpfter Incident.
- **Zeitfenster-Dedup** — Gleiche Source innerhalb 4h → neuer Incident bekommt `relatedIncidentId` auf den zeitlich näheren offenen Incident.
- **Reasoning Kontext** — Offene Incident-Titel (Top 10, nach Severity) im Reasoning-Kontext. LLM sieht jetzt "Offene Incidents: [high] Proxmox Replication Job fehlgeschlagen (open)" statt nur "7 offen".
- **relatedIncidentId** — Wird jetzt in ItsmSkill, Monitor-Hook, UI Detail-Panel und Chat-Display angezeigt. `updateIncident` unterstützt das Feld.

## [0.19.0-multi-ha.360] - 2026-04-06

### Fixed
- **Skill-Filter: Superset nur für Watch/Schedule** — Shell, CodeAgent, Script, Befehl, automatisch triggern nicht mehr den Superset (80+ Tools). Nur Watch/Schedule/Background/Alert/Zeitangaben triggern Cross-Category-Zugriff. Spart ~3000-5000 Token pro Nicht-Watch-Automation-Request.
- **Skill-Filter: 5 generische Keywords entfernt** — `clone`, `klone`, `template`, `regel`, `npm` aus Infrastructure entfernt (waren false-positives für Git-Clone, E-Mail-Templates, deutsche Idiome, Node Package Manager). Infra-Kontext wird durch spezifischere Keywords (proxmox, vm, lxc, firewall, nginx, proxy) korrekt erkannt.
- **Skill-Filter: `monitor` in Infrastructure** — MonitorSkill jetzt auch ohne Automation-Superset erreichbar. "Monitor Status" routet zu Infrastructure statt 80+ Tools.

## [0.19.0-multi-ha.359] - 2026-04-05

### Fixed
- **Skill-Filter: Infra-Keywords fehlten** — CMDB, ITSM, InfraDocs, Cloudflare, NPM, pfSense, Deploy Skills wurden vom Category-Keyword-Filter ausgeschlossen und nie zum LLM geschickt. 40+ fehlende Keywords ergänzt (cmdb, dns, cloudflare, firewall, proxy, deploy, vlan, gateway, arp, dhcp, incident, runbook, etc.).

## [0.19.0-multi-ha.358] - 2026-04-05

### Added
- **pfSense: 4 neue Actions** — `list_vlans`, `list_gateways`, `list_dhcp_leases`, `list_arp`. VLANs, Gateways und ARP/DHCP-Tabelle jetzt abrufbar.
- **Proxmox Discovery: VM IP-Adressen** — LXC Config IPs aus `net0` Feld + QEMU Guest Agent IPs. MAC-Adressen aus VM-Config für Cross-Reference.
- **pfSense Discovery erweitert** — Entdeckt jetzt Interfaces (mit Subnet/VLAN), VLANs, Gateways als network Assets. Nicht mehr nur Firewall-Regeln.
- **Cross-Source IP Resolution** — pfSense ARP + DHCP + UniFi Client MACs gegen Proxmox VM-Config MACs gematcht → fehlende IPs automatisch zugeordnet.
- **Proxmox `api_raw` Action** — Generischer API-Zugriff für Discovery-Callbacks (LXC/QEMU Config, Guest Agent).

### Fixed
- **Deploy: Gateway nicht mehr hardcoded /24** — `gateway` und `subnet_prefix` Parameter konfigurierbar, Fallback auf /24 + .1.
- **Deploy: fullDeploy Input-Validation** — Project, Domain, Host werden validiert bevor SSH-Calls passieren.
- **Deploy: SSH Timeout 2→5 Min** — Lange `npm install` Builds laufen nicht mehr in Timeout.
- **Deploy: Rollback → `git revert`** — Statt `git checkout HEAD~1` (detached HEAD) wird `git revert --no-edit HEAD` verwendet.
- **Deploy: Warnungen bei übersprungenen Steps** — Firewall/Proxy/DNS zeigt Warnung wenn Skill nicht konfiguriert statt stillem Skip.

## [0.19.0-multi-ha.357] - 2026-04-05

### Fixed
- **NPM Schema: `additional_domains` fehlte `items`** — OpenAI lehnte Tool-Schema ab → Alfred konnte nicht antworten. Gefixt mit `items: { type: 'string' }`.
- **pfSense v2.7.6: `list_rules` → `/firewall/rules` (Plural)** — v2.7.6 API braucht Plural-Endpoints für Listen. Fallback auf Singular für ältere Versionen.
- **pfSense: `list_interfaces` → `/interfaces` (Plural)** — Gleicher Fix für Interface-Liste.

## [0.19.0-multi-ha.356] - 2026-04-05

### Fixed
- **Cloudflare Discovery: `zone` → `domain`** — Discovery übergab falschen Parameter an Cloudflare-Skill. Alle DNS Records wurden übersprungen.

## [0.19.0-multi-ha.355] - 2026-04-05

### Fixed
- **InfraDocs Review** — 6 Issues gefixt: PG-kompatible Prune-Query, SQLite ALTER TABLE idempotent, Version-Race via Transaction, persistDoc fire-and-forget, Write-Back nur bei leerem Feld, UI-State Reset bei Tab-Wechsel.

## [0.19.0-multi-ha.354] - 2026-04-05

### Added
- **InfraDocs Persistenz** — Alle generierten Dokumente werden in `cmdb_documents` archiviert (Versionierung, Entity-Verknüpfung).
- **Runbook Write-Back** — Generierte Runbooks werden automatisch in `cmdb_services.documentation` gespeichert.
- **Postmortem Write-Back** — Generierte Incident-Reports werden in `cmdb_incidents.postmortem` gespeichert (neues Feld).
- **Migration v50** — `cmdb_documents` Tabelle + `cmdb_incidents.postmortem` Spalte.
- **WebUI: Service Runbook-Button** — "Runbook generieren" direkt im ITSM Service-Detail-Panel + Dokumenten-Historie.
- **WebUI: Incident Postmortem-Button** — "Postmortem generieren" direkt im ITSM Incident-Detail-Panel.
- **WebUI: Asset Linked Documents** — CMDB Asset-Detail zeigt verknüpfte Dokumente.
- **WebUI: Docs Archiv** — Neuer Archiv-Tab in InfraDocsPage mit Versionshistorie aller generierten Dokumente.
- **2 neue API-Endpoints** — `/api/cmdb/documents` (Liste) + `/api/cmdb/documents/:id` (Detail).

## [0.19.0-multi-ha.353] - 2026-04-05

### Fixed
- **CMDB/ITSM Review** — 18 Issues gefixt (4 Critical, 6 High, 5 Medium, 3 Low): API-Wiring Guard, Manual-Asset-Dedup, Monitor→Incident Keyword-Dedup, resolveUser Fallback, Auto-Discovery/Health-Check Timer, Error-Handling, Mermaid Node-ID Uniqueness, JSON-Parse 400, Tags-Typ, markStaleAssets, getTopology Cap, Reasoning-Prompt conditional.
- **Monitor: data-Feld fehlte** — `result.data = alerts` setzen damit ITSM Auto-Incident-Hook feuert.
- **CMDB Timer-Cleanup** — Discovery + Health-Check Intervals werden bei Shutdown sauber aufgeräumt.

## [0.19.0-multi-ha.352] - 2026-04-04

### Added
- **CMDB Skill** — Zentrales Configuration Management Database mit Auto-Discovery aus allen Infra-Skills (Proxmox, Docker, UniFi, Cloudflare DNS, NPM, pfSense, HomeAssistant). 13 Actions: discover, list/get/add/update/decommission/delete assets, add/remove relations, search, topology, stats.
- **ITSM Skill** — IT Service Management mit Incident-Tracking, Change-Management und Service-Katalog. 16 Actions inkl. Impact-Analysis (transitive Graph-Traversierung), Health-Checks und Dashboard.
- **InfraDocs Skill** — Infrastruktur-Dokumentation: Inventar-Reports, Mermaid-Topologie-Diagramme, Service-Dependency-Maps, LLM-generierte Runbooks, Change-Logs, Incident-Postmortem-Templates, CMDB-Export.
- **CMDB Auto-Discovery** — Entdeckt automatisch Assets aus Proxmox (Nodes+VMs/LXCs), Docker (Container), UniFi (Devices+Networks), Cloudflare (DNS Records), NPM (Proxy Hosts+Certs), pfSense (Firewall Rules), HomeAssistant (Devices+Automations). Cross-Source-Relation-Discovery via IP-Matching.
- **CMDB→KG Sync** — Assets werden automatisch als Knowledge-Graph-Entities gespiegelt (server, service, container, network_device, certificate). KG-Text-Extractor ignoriert CMDB-Entity-Namen (Blacklist).
- **ITSM Auto-Incidents** — Monitor-Alerts erzeugen automatisch Incidents mit Dedup (offene Incidents gleichen Assets werden nicht dupliziert).
- **Deploy→CMDB Integration** — Nach full_deploy werden alle erstellten Assets + Relationen automatisch im CMDB registriert.
- **Reasoning CMDB-Awareness** — CMDB-Summary im Reasoning-Kontext (P2, 150 Token). Reasoning kann Incidents/Changes/Discovery vorschlagen.
- **WebUI: CMDB-Seite** — Asset-Inventar mit Tabellen- und Topologie-Ansicht (Force-Graph), Filter, Detail-Panel mit Relationen + Change-History, inline Edit, Decommission, Discovery-Trigger.
- **WebUI: ITSM-Seite** — 3-Tab-Layout: Incidents (Severity-basiert, Status-Transitions), Change Requests (Approve/Start/Complete/Rollback), Service-Katalog (Health-Checks, Impact-Analysis).
- **WebUI: InfraDocs-Seite** — Dokumentations-Viewer mit Inventar, Topologie-Diagramme, Service-Maps, Change-Logs, Export.
- **24 neue API-Endpoints** — CMDB CRUD (assets, relations, discover, stats), ITSM CRUD (incidents, changes, services, health-check, dashboard), Docs (generate, export).
- **Migration v49** — 6 neue Tabellen: cmdb_assets, cmdb_asset_relations, cmdb_changes, cmdb_incidents, cmdb_services, cmdb_change_requests (SQLite + PostgreSQL).
- **Stale-Asset-Detection** — Assets die bei Discovery nicht mehr gefunden werden → nach konfigurierbarem Threshold als 'unknown' markiert. Nie auto-delete.
- **KG Entity-Typen erweitert** — server, service, container, network_device, certificate als neue Entity-Typen.

## [0.19.0-multi-ha.329] - 2026-04-03

### Fixed
- **BMW: Reasoning verbrauchte 88% REST-Quota** — Collector liest jetzt direkt aus DB statt Skill-Call. basicData im RAM gecacht. 0 REST-Calls für Reasoning.
- **BMW: Rate-Limit-Flag** — nach CU-429 keine REST-Calls bis 00:00 UTC. Reset bei Re-Authorize.
- **BMW: Graceful Degradation** — letzte DB-Daten ohne TTL-Cutoff als Fallback mit Altershinweis.
- **BMW: ensureContainer nicht-destruktiv** — neuer Container erst erstellen, dann alten löschen.
- **BMW: MQTT Token-Refresh nach Re-Authorize** — Streaming wird mit neuem Token neu gestartet.
- **BMW: MQTT Exponential Backoff** — 60s→120s→240s→max 15 Min, Reset bei Data-Receive.
- **BMW: ContainerId Self-Healing** — leere containerId wird beim nächsten Status-Call automatisch erstellt.
- **KG: Generic-Linker False-Positives** — SOL/ETH/BTC in Wörtern ("also", "Elisabeth") wurden fälschlich verknüpft. Fix: Word-Boundary-Regex + Mindestlänge 4 Zeichen statt Substring-Match.
- **KG: LLM-Linker nur Event↔Event** — LLM verknüpfte nur Events untereinander, nicht mit Personen/Locations/Vehicles. Fix: Entity-Mix sendet Core-Entities (Personen, Orte, Fahrzeuge, Orgs) als erste zu analysierende Entities.
- **KG: HA-Person ↔ Memory-Person Fuzzy** — "Alexandra" (SmartHome) wurde nicht mit "Frau Alex" (Memory) verknüpft. Fix: Fuzzy-Match in maintenance() erstellt `same_as` Relations.
- **KG: Event-Dedup aggressiver** — Events mit fast identischen Keys (`rtx_5090` vs `rtx5090`) werden zusammengeführt.
- **KG: Manuelle Analyse per Chat** — Neue Memory-Skill Action `kg_analyze`. User sagt "Analysiere deinen Knowledge Graph" → Alfred führt sofort Ingest + Generic Linking + Family Inference + LLM Linking durch und meldet Ergebnis (X Entities, Y Relations, Z neue, W Korrekturen).
- **KG: Chat-Messages als Quelle** — Entity-Extraktion aus jeder User-Message + Alfred-Antwort per Regex. Kein LLM-Call, fire-and-forget. Erwähnte Personen, Orte, Organisationen, Items werden automatisch im KG erfasst.
- **KG: Document-Chunks im LLM-Linker** — LLM bekommt ersten Chunk (200 Zeichen) jedes Dokuments als Kontext. CV-Inhalt, Zahlungslisten-Details werden für semantische Verknüpfung genutzt.
- **KG: Wöchentliche Chat-LLM-Analyse** — Sunday Maintenance: letzte 100 User-Messages per LLM analysieren. Extrahiert implizites Wissen (Interessen, Gewohnheiten, Zusammenhänge) das kein Regex erkennt.
- **KG: Familien-Inferenz** — Universelle Regeln: Spouse→parent_of Kinder, Kinder→siblings, Mutter/Vater→grandparent_of Kinder, Schwester/Bruder→aunt_uncle_of Kinder, Spouse→knows Familie. Funktioniert automatisch für jedes neue Familienmitglied.
- **LLM-Linker: Transitive Inferenz** — Prompt erweitert um Inferenz-Regeln + Entity-Typ-Korrektur-Hinweis. Neue Relationstypen: sibling, grandparent_of, aunt_uncle_of, plays_at.
- **Confirmation: Auto-Cleanup bei Approve** — Wenn User eine Confirmation bestätigt, werden alle anderen pending Confirmations für denselben Skill automatisch aufgeräumt. Verhindert "⏰ abgelaufen" Meldungen für bereits erledigte Themen.
- **DeliveryScheduler: WAKING reicht für normal** — `normal` urgency brauchte `ACTIVE` (prob ≥ 0.5), das existierte bei jungem Profil nie → Insights wurden nie zugestellt. Fix: `WAKING` reicht. Fallback: bei <3 Tagen Profil-Daten immer zustellen.
- **KG: Entity-Typ-Routing statt blind Person** — `extractPersons()` → `extractEntitiesFromText()` mit `classifyEntityName()`: Locations (KNOWN_LOCATIONS), Organizations (AG/GmbH/ICT), Items (deutsche Komposita >7 Zeichen, Geräte-Prefixe, Nomen-Suffixe) werden korrekt typisiert. "Zürich Versicherungs AG" → organization, "Hausbatterie" → item, "Linus" → person. Block 1 Name-Extraktion stoppt nach Vorname wenn nächstes Wort ein Konzept ist ("Noah Fußball" → nur "Noah"). Employment-Sync: Duplikat-Schutz + User≠Organization.
- **Reasoning: Notes, Reminders, Documents im Kontext** — 3 neue Sources im Collector: Reminders (P2, 100 Tokens, pending/24h), Notes (P2, 200 Tokens, letzte 10 mit Preview), Documents (P3, 150 Tokens, nur Index). KG-Extractors für alle drei. Reminders im Kontext → Reasoning sieht bestehende Reminders und schlägt keine Duplikate vor.
- **KG: Personen aus Memory-Keys** — `friend_bernhard_birthday`, `friend_bernhard_spouse_name` → Person "Bernhard" + `User→knows→Bernhard` + `Bernhard→spouse→Sabine`. Geburtstage als Attribute. Funktioniert generisch für alle Prefixe (friend, colleague, neighbor, contact). Sub-Person-Birthdays korrekt zugeordnet.
- **KG: Canonical Person Names** — Verschiedene Memories für dieselbe Person ("Sohn Linus" aus child_linus + "Linus" aus linus_football_club) erzeugen jetzt EINE Entity. canonicalPersons-Map resolved über Vornamen. Sonderzeichen (: . ,) werden gestrippt. Kontextinfos (Fußballverein) als separate Organization-Entities + `plays_at` Relationen statt im Person-Namen.
- **KG: Person-Name-Extraktion (REPLACED)** — Memory-Sync extrahierte ganze Sätze als Person-Namen ("Linus SV Altlengbach", "Kinder: Linus"). Fix: nur Titel + Vorname ("Sohn Linus"). Friend-Memories korrekt als `knows` statt `spouse` (Sabine = Bernhards Frau, nicht Users).
- **KG: Falsche Relationen bereinigt** — User→spouse→Sabine → knows, User→works_at→User gelöscht, Alexandra→works_at→Event gelöscht, User als Organization gelöscht, Axians-Duplikat gemergt.
- **KG: Generic-Linker Vorname-Match** — Personen werden auch per Vorname gematcht ("linus" in Event-Keys findet "Sohn Linus"). Verknüpft 8+ bisher isolierte Events.
- **KG: LLM-Linker Validierung** — works_at nur→organization, parent_of/spouse/family nur person→person, located_at nur→location. Verhindert semantisch falsche Relationen.
- **Reasoning: Reminder-Spam** — Selbe Aktion wurde bei jedem Pass erneut vorgeschlagen (26× Domain-Reminder) weil Dedup auf exaktem Wortlaut hashte und das LLM die Message jedes Mal anders formulierte. Fix: Themen-basierter Hash aus sortierten Keywords (≥4 Zeichen) statt exaktem JSON-Wortlaut. Duplikat-Reminders bereinigt.

## [0.19.0-multi-ha.314] - 2026-04-03

### Added
- **Mistral Pricing-Tabelle aktualisiert** — mistral-small ($0.15/$0.60), magistral-medium ($2/$5), magistral-small ($0.50/$1.50), ministral-8b ($0.15/$0.15). Neue Modelle: pixtral-large/12b, ministral-3b/14b, devstral, mistral-moderation, open-mixtral, open-mistral-nemo/7b.
- **Dashboard: AI Services Sektion** — Zeigt konfigurierte Services (STT, TTS, OCR, Moderation, Embeddings) mit Provider und Modellname im Dashboard an.
- **Service Usage Tracking** — Neue `service_usage` Tabelle (Migration v46) trackt STT (Minuten), TTS (Zeichen), OCR (Seiten), Moderation (Tokens) mit Kosten. Callback-basierte Instrumentierung in speech-transcriber, speech-synthesizer, ocr-service, moderation-service. Dashboard zeigt Service-Kosten-Tabelle (lila, getrennt von LLM-Token-Kosten).
- **Smart Delivery Timing** — DeliveryScheduler lernt User-Aktivitätsmuster (30-Tage Messages + Confirmations → Stunden-Profil ACTIVE/WAKING/QUIET). Nicht-dringende Insights werden in QUIET-Stunden aufgeschoben und bei nächster ACTIVE-Stunde gebatcht zugestellt (max 5). Stale-TTL: urgent=sofort, high=6h, normal=12h, low=24h. Neue `deferred_insights` Tabelle (Migration v47).
- **Urgency-Klassifikation** — LLM klassifiziert Insights als urgent/high/normal/low. DeliveryScheduler entscheidet basierend darauf ob sofort oder aufgeschoben.
- **Confirmation Queue: Callback-ID Routing** — Inline-Button-Clicks nutzten immer die älteste pending Confirmation statt der angeklickten. Fix: `getById(callbackId)`.
- **Confirmation Queue: Skill-Ergebnis anzeigen** — Bestätigte Aktionen zeigten nur "✅ Ausgeführt" statt das eigentliche Skill-Ergebnis. Bei BMW authorize muss der User den Device-Code + URL sehen. Fix: `result.display` wird vollständig angezeigt, wie bei einer normalen Chat-Interaktion.
- **Reasoning: Action-Dedup bei expired/rejected zurücksetzen** — BMW authorize wurde nach 12h Dedup nie erneut vorgeschlagen, obwohl die vorherige Confirmation abgelaufen war. Fix: Dedup wird umgangen wenn die letzte Confirmation `expired` oder `rejected` war.
- **Reminder: ISO-Zeitformat `T` nicht erkannt** — `parseTriggerAt` akzeptierte nur `YYYY-MM-DD HH:MM` (Leerzeichen), aber LLM sendet `2026-04-03T09:00` (ISO mit T). Reminder wurde nie erstellt, Confirmation Queue meldete trotzdem "✅ Ausgeführt". Fix: Regex akzeptiert `T` und Leerzeichen. Confirmation Queue prüft jetzt `result.success` und zeigt "❌ Fehlgeschlagen" bei `success: false`.
- **Reasoning: Intelligentere Action-Vorschläge** — Prompt-Regeln verhindern delegate für User-Aufgaben (Browser/Login). BMW Token-Fehler → authorize statt delegate. Zahlungsprobleme → reminder statt delegate. triggerAt muss in der Zukunft liegen.
- **KG: Entity-Typ-Routing** — Neues `organization` Routing: Firmennamen (GmbH/AG/ICT/Inc + bekannte Marken) werden als Organization statt Person erkannt. Employment-Sync aus Memories (current_employment → Organization + works_at Relation). Cross-Extractor verknüpft Organizations mit Work-Location.
- **KG: Person-Blacklist + Name-Extraktion** — Erweiterte Blacklist (generische Wörter, Marken, technische Begriffe). Memory-Entities extrahieren nur den Eigennamen, nicht den ganzen Satz. KNOWN_LOCATIONS Check verhindert Orte als Personen. Digits/Sonderzeichen/lowercase Filter.
- **KG: SmartHome Internal-Filter** — Victron-Internals (vebus_*, settings_ess_*), system_relay_*, Shelly-Hex-IDs werden aus dem KG gefiltert. HA person.* Entities als KG-Person statt Item.
- **KG: LLM-basiertes Entity-Linking** — Optionaler `LLMEntityLinker` (Mistral/OpenAI) findet semantische Zusammenhänge die Text-Matching nicht kann (Synonyme, implizite Referenzen, Kausalketten). Erstellt neue Relationen, neue Entities und korrigiert Entity-Typen. Konfig: `reasoning.llmLinking: { enabled, provider, model, schedule }`. Läuft per Schedule (daily/weekly) oder manuell. ENV: `ALFRED_REASONING_LLM_LINKING_*`.
- **KG: Generisches Entity-Linking** — Neuer `buildGenericEntityLinks()` Pass nach allen Extraktoren. Matcht jede Entity (Name, Attributes, Value) gegen alle anderen Entity-Namen. Erstellt `relates_to` Relationen automatisch — keine domain-spezifischen Rules nötig. Events, Notizen, Dokumente, Todos werden mit allen referenzierten Entities verknüpft (BMW, Gamescom, Personen, Locations etc.).
- **KG: Person-Memory-Relationen** — Familien/Freunde aus Memory-Keys: child→parent_of, spouse→spouse, mother/sister→family, friend→knows. Alle 10 Personen jetzt mit User verknüpft.
- **KG: SmartHome alle Items verknüpft** — Rule 5 slice(0,5) Limit entfernt. Alle SmartHome-Items bekommen located_at→Home.
- **KG: Feed-Locations nicht mehr erstellt** — RSS-Feeds erstellen keine Location-Entities mehr (Braunau, Graz etc. waren nutzlos unverknüpft).
- **KG: Duplikat-Bereinigung + Event-Expiry** — maintenance() merged Entities mit gleichem normalized_name+type (höherer mention_count gewinnt). Stale Connection-Events (>30 Tage, <0.8 Confidence) werden gepruned. DB-Cleanup: 77 Müll-/Duplikat-Entities entfernt (209→132).
- **Reasoning: Resolved-Memory-Enrichment** — Wenn der User ein Thema als erledigt markiert hat (Memory mit "erledigt/resolved/überholt"), werden alle Kontext-Sections die dasselbe Thema enthalten automatisch annotiert: "✅ ERLEDIGT laut User-Memory — NICHT als offenes Problem darstellen." Verhindert dass Emails/Daten zu erledigten Themen immer wieder als Insights gemeldet werden.
- **BMW CarData MQTT Streaming** — Echtzeit-Fahrzeugdaten über BMW Customer Streaming API (MQTT). Kein REST-Quota-Verbrauch für Türen, GPS, Geschwindigkeit, km-Stand, Reifendruck. Cluster-aware (nur ein Node streamt via AdapterClaimManager). Token-Refresh vor Connect, disconnect/offline Logging.
- **BMW Telematik DB-Persistenz** — Neue `bmw_telematic_log` Tabelle (Migration v45). MQTT-Events werden als Merged Snapshots gespeichert (5s Debounce), REST-Responses ebenfalls. 3-Tier-Lookup: RAM → DB → REST. Beide HA-Nodes lesen aus derselben DB. REST-Quota nur bei Cache-Miss (REST 25 Min, MQTT 60 Min TTL).
- **BMW MQTT + REST Merge** — MQTT liefert Echtzeitdaten (GPS, Türen, Geschwindigkeit, km-Stand), REST liefert Batterie (SoC, SoH, Kapazität). Status merged beide Quellen. Getrenntes `getLatestBySource()` pro Datenquelle.
- **BMW History Action** — Neue Action `history` zeigt Telematik-Zeitreihe (SoC, Reichweite, Verriegelung, km-Stand, Standort) als Tabelle. Default: 7 Tage. Pruning nach 90 Tagen.
- **BMW Reverse Geocoding** — GPS-Koordinaten werden per Nominatim (OSM) in lesbare Adressen aufgelöst (Straße, Ort). 5s Timeout, Fallback auf Koordinaten.
- **BMW Deskriptor-Mapping REST↔MQTT** — `tvm()` Funktion mit Fallback-Mapping für unterschiedliche Pfade (z.B. `door.status` vs `centralLocking.isLocked`). Normalisiert LOCKED/SECURED/UNLOCKED/SELECTIVELOCKED.
- **Reasoning: Vorgeschlagene Aktionen im Insight sichtbar** — Am Ende der Insight-Nachricht: "⚡ Beschreibung" für jede vorgeschlagene Aktion.

### Fixed
- **BMW MQTT Streaming: Zod-Schema fehlte `streaming`** — `AlfredConfigSchema.parse()` strippte das `streaming`-Objekt. Fix: Schema erweitert + `NUMERIC_ENV_KEYS` für Port.
- **BMW MQTT Streaming: Cluster-Aware** — Beide Nodes verbanden sich gleichzeitig → `Connection refused`. Fix: AdapterClaimManager, Claim in `start()` statt `initialize()`.
- **BMW MQTT Parser** — BMW sendet Object-Format, nicht Array. Fix: Object-Parser als primär.
- **BMW MQTT DB: Merged Snapshots** — 314 Einzelzeilen pro Burst → ein Snapshot nach 5s Debounce.
- **Reasoning Actions-JSON dem User angezeigt** — LLM nutzte `**ACTIONS**` statt `---ACTIONS---` Marker. Fix: Robuster Parser erkennt alle Varianten + JSON-Codeblöcke.
- **Reasoning: Reminder-Actions funktionierten nicht** — Prompt nutzte falsche Parameter (`action:"create"`, `title`, `due`), Skill erwartet (`action:"set"`, `message`, `triggerAt`). User bestätigte → "✅ Ausgeführt" → keine Erinnerung erstellt. Fix: Prompt korrigiert + Fallback-Normalisierung in `processActions()`.
- **KG: Wien fälschlich als Home-Location** — Memory-Sync setzte Wien `isHome=true` wegen "Wohnort" im Kontext. Fix: Satz-basierte Negationserkennung ("nicht der Wohnort" → `isHome=false`). `homeLocation`-Suche schließt `isWork=true` aus, höchste Confidence gewinnt.

## [0.19.0-multi-ha.267] - 2026-04-01

### Added
- **KG Relations: Cross-Extractor Relation Builder** — Neuer `buildCrossExtractorRelations()` Pass nach allen Extractors. Erstellt automatisch Relationen zwischen Entities aus verschiedenen Quellen: Vehicle↔Charger (charges_at), Strompreis→Wallbox/Batterie (affects_cost), Vehicle/Charger→Home (located_at/home_location), SmartHome→Home, RSS-Artikel→bestehende Entities (relevant_to).
- **KG Relations: Per-Extractor Relations** — Vehicle (User→owns→BMW), Charger (User→owns→Wallbox, car_connected Attribut), Energy (User→monitors→Strompreis), Crypto (User→owns→BTC/ETH).
- **KG Relations: Feed→Entity Matching** — RSS-Artikel-Titel werden gegen alle bestehenden KG-Entities gematcht. "Bitcoin steigt" + KG hat BTC Entity → `relevant_to` Relation.
- **KG Memory Integration: Patterns, Feedback, Connections** — syncMemoryEntities erweitert: Behavioral Patterns → User→has_pattern, Action Feedback → User→prefers/dislikes Skill, Memory Connections → Event-Entities im KG.
- **Verbindungskarte: Graph-Pfade** — Neue Section zeigt 2-Hop Verbindungsketten (z.B. BMW→charges_at→Wallbox→affects_cost→Strompreis). Token-Budget 600→1200.
- **KG Repository: updateRelationStrength()** — Methode für Feedback-basierte Relation-Stärke-Anpassung.

## [0.19.0-multi-ha.261] - 2026-04-01

### Fixed
- **KG: masterUserId in enrichWithKnowledgeGraph** — `ingest()` und `buildConnectionMap()` nutzten `defaultChatId` statt masterUserId. KG-Entities wurden unter falscher User-ID gespeichert → Relations konnten nicht erstellt werden (0 Relations bei 152 Entities). Fix: `resolveUserId()` cached in ReasoningEngine.
- **half_hourly: markRun() Slot-Rounding** — `markRun()` speicherte die exakte Minute statt den gerundeten Slot (:00 oder :30). Bei bestimmten Timer-Offsets konnte der :30 Slot übersprungen werden. Fix: Minute wird auf 0 oder 30 gerundet.
- **KG: Person-Extraktor filtert RSS-Feeds** — Generischer Person-Extraktor lief auf feeds/infra/activity Sections und extrahierte RSS-Artikeltitel als Personen ("Cyberangriffen", "Investoren"). Fix: Diese Sections werden übersprungen. Zusätzlich: Plural-Nomen (-en, -ung, -keit, -heit, -tion, -mus) werden gefiltert.
- **KG: SmartHome Zigbee-ID Filter** — Entities mit hex-IDs (`0xa4c13800ac483d44`) oder Name "-" werden jetzt gefiltert statt als Items gespeichert.
- **Müll-Entities bereinigt** — 91 falsche Entities (Personen aus RSS, Zigbee-IDs, "-") aus DB gelöscht.

## [0.19.0-multi-ha.260] - 2026-03-31

### Fixed
- **Collector: masterUserId Auflösung** — Alle Memory-Lookups im Collector nutzten `defaultChatId` (Telegram-ID `5060785419`) statt `masterUserId` (interne ID `f165df7a-...`). Memories (HA-Entities, Wetter-Adresse, Trends, Feedback, Insight-Prefs) wurden nie gefunden. Fix: `getEffectiveUserId()` löst beim ersten `collect()` die masterUserId auf und cached sie.

## [0.19.0-multi-ha.259] - 2026-03-31

### Fixed
- **Timeouts: feed_reader 15s→25s, monitor eigener Fetch 30s** — Beide Skills fetchen externe Dienste und brauchen mehr Zeit. Generische `fetchWithTimeout()` Methode für Skills mit Custom-Timeout. Code-Duplikation bei fetchFeeds reduziert.

## [0.19.0-multi-ha.258] - 2026-03-31

### Changed
- **Smart Home: Additives 4-Schichten-System** — Alle Schichten werden KOMBINIERT (nicht überschrieben):
  1. Default-Domains (light, person, input_boolean, climate) — immer geladen
  2. binary_sensor gefiltert nach device_class (door, window, motion, occupancy, smoke, plug) — Türen, Bewegungsmelder, Rauchmelder, Fahrzeug-Verbindung
  3. User-Domains via Memory (`briefing_ha_domains`) — ZUSÄTZLICH zu Defaults
  4. User-Entities via Memory (`briefing_ha_entities`) — ZUSÄTZLICH zu Domains
- Verifiziert gegen echte HA-Installation: 1909 Entities, 1015 Sensoren, 213 Switches (151 davon UniFi). Default-System liefert ~43 relevante Entities statt 1909.

## [0.19.0-multi-ha.257] - 2026-03-31

### Changed
- **Smart Home: 2-Strategie-Ansatz** — Strategie 1: Wenn User spezifische Entities via Memory konfiguriert hat (`briefing_ha_entities = sensor.victron_system_battery_soc, ...`), werden diese einzeln per `getState()` abgerufen — präzise, keine Datenflut. Strategie 2 (Fallback): Nur kleine Domains (light, switch, climate) abfragen — `sensor` (1015 Entities!) und `binary_sensor` (158) werden übersprungen. User kann eigene Domains via Memory setzen (`briefing_ha_domains`).

## [0.19.0-multi-ha.256] - 2026-03-31

### Changed
- **Smart Home Domain-Filterung** — Collector fragt HA nicht mehr mit 1909 Entities ab, sondern pro Domain gefiltert. Default-Domains: light, switch, climate, binary_sensor, sensor. User kann eigene Domains via Memory setzen (`briefing_ha_domains` = "light, switch, sensor, climate"). Max 10 Entities pro Domain, max 8 Domains.
- **KG SmartHome Extractor** — Entity-Limit von 20 auf 50 erhöht (weniger Müll durch Domain-Filterung). Verifiziert gegen echte HA API (1909 Entities, Pipe-Format bestätigt).

## [0.19.0-multi-ha.255] - 2026-03-31

### Fixed
- **KG SmartHome Extractor** — Komplett neugeschrieben für HA Pipe-Format (`| entity_id | state | name | unit |`). Vorher: Regex erwartete "Licht: an" Format, erzeugte Müll-Entities aus Sensor-IDs + Timestamps. Jetzt: Parsed Markdown-Tabelle korrekt, nutzt friendly_name, filtert System-Entities (sun, conversation, geo_location), überspringt Timestamp-States und unavailable. Max 20 Entities pro Lauf. 12 Müll-Entities aus DB bereinigt.

## [0.19.0-multi-ha.254] - 2026-03-31

### Fixed
- **RSS-Feeds Timeout** — `check_all` fetcht mehrere externe Server und braucht mehr als 5s. Eigener Fetch mit 15s Timeout (wie Weather). Feeds auf Priority 2 hochgestuft (statt P3) für zuverlässige Relevanz-Filterung.

## [0.19.0-multi-ha.253] - 2026-03-31

### Changed
- **Intelligentes RSS-Filtering statt Watch-Reasoning** — RSS-Watch-Alerts triggern kein Event-Reasoning mehr (spart 2 LLM-Calls pro 15-Min-Check). Stattdessen werden RSS-Feeds im stündlichen Reasoning als Kontext geladen und nach Relevanz für den User gefiltert (KG-Entities, Kalender, Interessen). Nur relevante Artikel werden als Insight gemeldet. Watch-Benachrichtigungen (Titel+URL) funktionieren weiterhin unverändert.
- **Feeds-Section Token-Budget** — Von 150 auf 400 Tokens erhöht für Titel + Snippets (inhaltliche Relevanz-Bewertung).
- **WatchEngine Callback** — `onWatchTriggered` Signatur um `skillName` erweitert für skill-basiertes Routing.

## [0.19.0-multi-ha.252] - 2026-03-31

### Added
- **Dynamischer Geräte-Kontext aus Knowledge Graph** — Chat-System-Prompt und Reasoning-Prompts bekommen eine user-spezifische "Konfigurierte Geräte & Systeme" Section. Keine hardcodierten "BMW", "Victron" etc. — Geräte werden aus KG-Entities (vehicle, item, metric) gelesen. Fallback auf registrierte Skills wenn KG noch leer.
- **`KnowledgeGraphService.buildDeviceContext()`** — Generiert Geräteliste aus KG für Chat + Reasoning.
- **`SystemPromptContext.deviceContext`** — Neues Feld im prompt-builder für dynamische Geräte-Section.
- **Pipeline KG-Zugang** — `setKnowledgeGraphService()` auf MessagePipeline für device context im Chat.

### Changed
- **Reasoning-Prompts: Hardcoded entfernt** — "BMW: FAHRZEUG-Daten" Block ersetzt durch generische Typen-Definitionen + dynamischen Device-Block aus KG. Alle BMW/Victron-Referenzen durch "Fahrzeug"/"Hausbatterie" ersetzt.

## [0.19.0-multi-ha.251] - 2026-03-31

### Fixed
- **KG: PostgreSQL MIN() Skalarfunktion existiert nicht** — `MIN(1.0, confidence + 0.1)` durch `CASE WHEN confidence + 0.1 > 1.0 THEN 1.0 ELSE confidence + 0.1 END` ersetzt. Funktioniert auf SQLite UND PostgreSQL. KG-Entities und Relations werden jetzt korrekt upsertet.
- **Reasoning: Insight-Qualität — KEINE_INSIGHTS bevorzugt** — Prompts instruieren das LLM jetzt explizit: "Alles läuft gut" ist KEIN Insight. Status-Berichte ohne Handlung sind KEINE Insights. Lieber 0-2 echte Insights als 5 Füller. KEINE_INSIGHTS ist die bevorzugte Antwort.

## [0.19.0-multi-ha.250] - 2026-03-31

### Added
- **Transiente vs Persistente Fehler-Erkennung** — Collector trackt pro Datenquelle ob der vorherige Lauf erfolgreich war. Transiente Fehler (letzter Lauf ok, jetzt Fehler) werden mit "⚠️ TRANSIENTER FEHLER — wahrscheinlich vorübergehend, KEIN Handlungsbedarf" annotiert. Persistente Fehler (2+ Läufe fehlgeschlagen) mit "🔴 PERSISTENTER FEHLER — Handlungsbedarf möglich". Gilt für alle 20+ Datenquellen generisch.

## [0.19.0-multi-ha.249] - 2026-03-31

### Fixed
- **KG Ingest: PostgreSQL MIN() Type-Mismatch** — `MIN(1.0, confidence + 0.1)` schlug fehl weil `1.0` als `double precision` interpretiert wurde, `confidence` aber `REAL` ist. Fix: `CAST(1.0 AS REAL)`. KG-Entities und Relations werden jetzt korrekt upsertet.
- **Feed-Reader: Unbekannte Action `recent`** — Collector rief `{action: 'recent'}` auf, Skill kennt nur `check_all`. Fix: `check_all` verwenden.
- **Wetter: Location-Resolution aus Memories** — Wenn `defaultLocation` nicht konfiguriert ist, wird die Heimadresse aus Memories gesucht (Schlüssel: heim/home/adress/wohn). Wenn keine Adresse gefunden: hilfreiche Fehlermeldung statt Skill-Error.

## [0.19.0-multi-ha.248] - 2026-03-31

### Fixed
- **Reasoning-Prompts: Balance Offenheit vs Korrektheit** — "NUR IDENTISCHE Entities" (zu restriktiv) ersetzt durch "Alle Domains kombinierbar, aber Typen nicht verwechseln". Datenquellen-Definitionen und negative Beispiele bleiben (BMW≠Hausbatterie, RSS≠Monitor), Cross-Domain-Kombinationen sind weiterhin erlaubt.
- **Insight-Nachrichten konsistent** — Event-getriggerte und geplante Insights nutzen jetzt beide "💡 Alfred Insights" (vorher: Singular vs Plural).

## [0.19.0-multi-ha.247] - 2026-03-31

### Fixed
- **Reasoning: Datenquellen-Typen-Definitionen** — Alle Prompts definieren jetzt explizit was jede Datenquelle IST und KANN: RSS=News (read-only), Watches=Skill-Monitor, BMW=Fahrzeug (≠Hausbatterie), E-Mail-Antworten≠Spam. Verhindert Domain-Verwechslungen.
- **Reasoning: Konservative Qualitätsregeln** — "Verbinde BELIEBIGE Domains" ersetzt durch "NUR IDENTISCHE Entities verbinden". Negative Beispiele: BMW-Akku≠Hausbatterie, RSS≠Preis-Monitor, Willhaben-Antworten≠Spam. Lieber 2 korrekte Insights als 5 mit Fehlern.
- **Reasoning: Keine Verhaltensbewertungen** — LLM darf Nutzerverhalten nicht werten ("Risiko für unkurierte Informationsansammlung" ist bevormundend).

## [0.19.0-multi-ha.246] - 2026-03-31

### Fixed
- **HA: CalendarWatcher/TodoWatcher Claim-First** — Atomic `claimNotification()` (INSERT ON CONFLICT DO NOTHING, changes=1 check) statt wasNotified→send→markNotified Race. Verhindert doppelte Benachrichtigungen bei gleichzeitiger Verarbeitung auf beiden Nodes.
- **HA: KG upsertEntity Atomic** — INSERT ON CONFLICT DO UPDATE statt SELECT→INSERT Race. Verhindert PostgreSQL UNIQUE-Violation die den gesamten KG-Ingest abbricht.
- **HA: KG upsertRelation Atomic** — Gleicher Fix für Relations.
- **HA: Weekly Maintenance Distributed Dedup** — Sonntag 4AM Timer nutzt jetzt `reasoning_slots` Tabelle. Nur ein Node führt TemporalAnalyzer + KG Maintenance + ActionFeedbackTracker aus. Verhindert doppelten Confidence-Decay.
- **HA: triggerOnEvent Slot-Key Klarheit** — Kommentare verdeutlichen dass der Window-basierte Slot-Key deterministisch ist und beide Nodes den gleichen Key generieren.

## [0.19.0-multi-ha.245] - 2026-03-31

### Fixed
- **Reasoning: Concurrent tick Guard** — setInterval-Callback prüft jetzt ob ein vorheriger Lauf noch aktiv ist. Verhindert doppelte LLM-Calls und Insights bei langsamen Reasoning-Passes. Unhandled Promise Rejections werden gefangen.
- **Reasoning: Event-Dedup Slot Key** — `Date.now()` (unique pro Node) ersetzt durch deterministischen 5-Min-Window-Key. Beide HA-Nodes generieren jetzt den gleichen Slot-Key → nur einer prozessiert.
- **Reasoning: Distributed Slot INSERT in try/catch** — DB-Fehler bei Slot-Claim (z.B. fehlende Tabelle) wird jetzt gefangen statt als unhandled rejection zu propagieren.
- **KG: Entity Attribute Merge** — `upsertEntity` exact-match Pfad überschrieb alle Attribute statt zu mergen. Jetzt werden bestehende + neue Attribute zusammengeführt (neue gewinnen bei Konflikt).
- **Activity: `skillUsageByUser` Event-Type** — Query suchte nach `'skill_execution'` (existiert nicht), Logger schreibt `'skill_exec'`. Dashboard zeigte immer 0 Ergebnisse.
- **Activity: ISO Week Bucketing** — SQLite `strftime('%W')` stimmt am Jahresende nicht mit ISO-Wochen überein. Bucketing jetzt in Application-Code mit korrekter ISO-8601-Wochenberechnung.
- **Watch-Engine: Quiet-Hours Digest stahl Watches** — `flushQuietHoursDigest()` rief `claimDue()` auf (destruktive Claim-Operation), statt read-only `getEnabled()`. Watches wurden vom normalen Poll-Zyklus gestohlen.
- **Email: executeLock Mutex Race Condition** — `while(lock) await lock` hatte TOCTOU-Race bei mehreren gleichzeitigen Aufrufen. Durch proper async Mutex ersetzt.
- **PostgreSQL: NOW() Timestamp-Format** — `DEFAULT NOW()` in PG-Migrations produzierte non-ISO-Timestamps. Ersetzt durch `to_char(now() AT TIME ZONE 'UTC', ...)` für konsistentes ISO-8601-Format.
- **DB-Adapter: adaptSql String-Literal Safety** — `?`-Placeholder-Replacement ersetzte auch `?` innerhalb von SQL-String-Literals. Jetzt werden nur `?` außerhalb von Quotes ersetzt.
- **Briefing: Doppelte resolveAddresses** — Memory-Queries für Adress-Auflösung liefen 2x pro Briefing (runBriefing + runCommuteCheck). Adressen werden jetzt einmal aufgelöst und durchgereicht.

## [0.19.0-multi-ha.244] - 2026-03-31

### Added
- **Memory → KG Sync** — Memory-Entities (type=entity/relationship/fact) werden beim KG-Ingest als strukturierte KG-Entities eingespeist. Adressen aus Memories werden als Location-Entities mit isHome/isWork Flag extrahiert. Beide Systeme kennen sich jetzt gegenseitig.
- **ContactsSkill Email-Resolution** — E-Mail-Absender werden über 4-stufige Kaskade aufgelöst: 1. KG (email-Attribut), 2. Memories, 3. ContactsSkill (Microsoft/Google/CardDAV), 4. Regex-Fallback.
- **Fuzzy Entity-Dedup** — "Müller" matcht "Franz Müller" per Teilstring-Suche. Bei Fuzzy-Match wird der längere (spezifischere) Name behalten und Attribute/Sources gemergt.
- **6 neue KG-Extractors** — weather (Temperatur, Bedingung), energy (Strompreis), smarthome (Geräte-Status), crypto (Portfolio-Positionen), feeds (RSS-Artikel), charger (Wallbox-Status). Alle Datenquellen füttern jetzt den KG.
- **KG → Memory Rückkanal** — Cross-Domain-Entities mit ≥3 Quellen werden als connection-Memories gespeichert → sichtbar im normalen Chat-Kontext der Message-Pipeline.
- **Entity-Type `metric`** — Neuer KG-Entity-Typ für Messwerte (Temperatur, Strompreis, etc.).

## [0.19.0-multi-ha.243] - 2026-03-31

### Changed
- **Reasoning-Prompts für holistisches System aktualisiert** — Scan-, Detail- und Event-Prompts referenzieren jetzt explizit die VERBINDUNGSKARTE (Cross-Domain Entities/Relations aus dem Knowledge Graph), Trends & Anomalien, User-Feedback, und Enrichment-Daten. LLM wird instruiert BELIEBIGE Domain-Kombinationen zu finden statt nur die in Beispielen genannten. Keine Beschränkung auf bestimmte Empfehlungstypen.

## [0.19.0-multi-ha.242] - 2026-03-31

### Changed
- **Generische Cross-Domain-Analyse** — Verbindungskarte komplett ersetzt: statt 4 hardcodierter Empfehlungsregeln (Laden, Timing, Abholung, Dringlichkeit) jetzt dynamische Analyse aller KG-Daten. Zeigt ALLE Cross-Domain Entities (≥2 Quellen), ALLE Cross-Domain Relations (zwischen verschiedenen Domains), und bemerkenswerte Attribute (overdue, battery, price, priority). Das LLM generiert beliebige Empfehlungen aus den strukturierten Daten — jede Domain-Kombination möglich, nicht auf 4 Typen beschränkt.

### Removed
- 4 hardcodierte Recommendation-Methoden (recommendCharging, recommendTodoTiming, recommendPickup, recommendOverduePriority) — das LLM übernimmt das Reasoning.

## [0.19.0-multi-ha.241] - 2026-03-31

### Added
- **Recommendation Engine** — Regelbasierte Cross-Domain-Empfehlungen in der Verbindungskarte. 4 Empfehlungstypen: Lade-Empfehlung (BMW-Akku + Ziel-Distanz), Zeitmanagement (voller Kalender + offene Todos), Abholung (Shopping-Item + Kalender-Event am selben Ort), Überfälligkeits-Dringlichkeit (Todo + Person + bevorstehendes Meeting). Max 5 Empfehlungen pro Reasoning-Pass, kein LLM-Call.

## [0.19.0-multi-ha.240] - 2026-03-31

### Added
- **E-Mail → KG Integration** — E-Mail-Absender werden als Person-Entities im Knowledge Graph extrahiert und mit bestehenden Personen dedupliziert. E-Mail-Betreffe als Event-Entities mit `sent`-Relationen. Generische Adressen (info@, noreply@, support@, etc.) werden automatisch gefiltert. Ermöglicht Verbindungen wie "Franz Mueller hat E-Mail geschickt + Meeting mit Müller im Kalender".

## [0.19.0-multi-ha.239] - 2026-03-31

### Added
- **Feedback Loop (ActionFeedbackTracker)** — Berechnet Akzeptanzraten pro Skill aus Confirmation-Outcomes der letzten 30 Tage. Speichert Rates als Memories für das Reasoning-System.
- **Action-Gating** — `processActions()` überspringt Skills mit <20% historischer Akzeptanz. Verhindert Confirmation-Spam für ungewollte Aktionen.
- **Feedback im Reasoning-Prompt** — Neue Priority-2-Section "User-Feedback (Aktionen & Insights)" zeigt dem LLM: Akzeptanzraten, Insight-Präferenzen (positiv/negativ), Autonomie-Vorschlag.
- **Autonomie-Level-Vorschlag** — Bei >90% Akzeptanz: Upgrade auf autonomous empfohlen. Bei <50%: Downgrade auf confirm_all. Gespeichert als Memory.
- **Insight-Präferenzen integriert** — InsightTracker-Kategorien (positiv/negativ/ignoriert) fließen in die Feedback-Section des Reasoning-Prompts ein.

## [0.19.0-multi-ha.238] - 2026-03-31

### Added
- **Persistenter Knowledge Graph (Migration v44)** — Neue Tabellen `kg_entities` und `kg_relations` für persistente Entity-Extraktion und Relation-Building über alle Datenquellen. Entities wachsen mit der Zeit: Confidence steigt bei jeder Wiederbestätigung (+0.1), mention_count trackt Häufigkeit. Alte Entities verfallen (30d Decay, Prune bei <0.2).
- **Entity-Deduplication** — "Müller" im Kalender + "Müller" im Todo = eine Entity mit sources: ["calendar", "todos"]. Normalisierung via UNIQUE(user_id, entity_type, normalized_name).
- **Verbindungskarte** — Strukturierte Priority-1-Section im Reasoning-Prompt: Personen-Cluster (multi-source), Ort-Verbindungen, Konflikte (BMW-Reichweite vs. Distanz), Gelegenheiten (Shopping + Arzttermin am selben Ort).
- **Relation Strength** — Relationen werden stärker je öfter sie bestätigt werden (strength +0.1). Schwache Relations (<0.2) werden wöchentlich bereinigt.
- **Graph Traversal** — `getConnectedEntities()`, `getRelationsFrom()/To()`, `getFullGraph()` für Abfragen über den Graphen.
- **KG Maintenance** — Wöchentliches Decay + Prune zusammen mit TemporalAnalyzer (Sonntag 4 AM).

## [0.19.0-multi-ha.237] - 2026-03-31

### Added
- **Temporale Analyse (TemporalAnalyzer)** — Neues Modul erkennt wöchentliche Trends (↑/↓ >30% vs. 3-Wochen-Baseline) und Anomalien (Error-Spikes, Usage-Spikes, Performance-Degradation, Usage-Drops) über ein 4-Wochen-Fenster. Läuft automatisch Sonntag 4:00 AM.
- **Weekly Skill Stats** — `ActivityRepository.weeklySkillStats()`: SQL-basierte wöchentliche Aggregation (Calls, Errors, Avg Duration pro Woche pro Skill). Unterstützt SQLite + PostgreSQL.
- **Stündliche Verteilung** — `ActivityRepository.hourlyDistribution()`: Aktivität nach Tageszeit für Anomalie-Erkennung.
- **Trends im Reasoning** — Neue Priority-2-Section "Trends & Anomalien (4 Wochen)" im ReasoningContextCollector. Reasoning sieht Veränderungen über die Zeit, nicht nur den aktuellen Zustand.
- **Enrichment-Topic trend_analysis** — Scan kann bei Bedarf detaillierte Trend-Daten aus der temporalen Analyse anfordern.

## [0.19.0-multi-ha.236] - 2026-03-31

### Added
- **Multi-Step Reasoning mit Enrichment** — Scan-Pass identifiziert Themen (z.B. "BMW Akku niedrig + Termin in Linz"), System fetcht gezielt tiefere Daten (BMW Detail-Status, Routing, Wetter-Prognose, etc.), Detail-Pass bekommt angereicherten Kontext für quantitative Empfehlungen.
- **Topic-Extraktion** — LLM gibt nach Scan strukturierte Topics aus (---TOPICS--- JSON), die automatisch zu Skill-Aufrufen gemappt werden. 8 Enrichment-Topics: vehicle_battery, routing, weather_forecast, email_detail, calendar_detail, smarthome_detail, crypto_detail, energy_forecast.
- **Enrichment Token-Budget** — Separates 1500-Token-Budget für Enrichment-Daten mit 8s Timeout pro Skill, unabhängig vom Basis-Kontext (3500 Tokens). Graceful Degradation bei fehlenden Skills oder Timeouts.
- **Event-Reasoning mit Enrichment** — Auch event-getriggerte Reasoning-Passes (Watch, Calendar, Todo, Post-Skill) nutzen jetzt Two-Pass + Enrichment für tiefere Analyse.

## [0.19.0-multi-ha.235] - 2026-03-31

### Added
- **Holistisches Reasoning-System** — Reasoning analysiert jetzt 20+ Datenquellen statt 12: E-Mail, BMW, Smart Home, RSS-Feeds, Crypto/Bitpanda, Microsoft To Do, Infrastruktur-Monitoring kommen zu Kalender, Todos, Watches, Wetter, Energie, Charger, Meal-Plan, Travel hinzu.
- **Two-Pass Reasoning** — Scan-Pass (schnell, max 512 Tokens) prüft ob Auffälligkeiten existieren. Detail-Pass (max 1536 Tokens) nur wenn der Scan etwas findet. Spart LLM-Kosten wenn nichts Relevantes passiert.
- **ReasoningContextCollector** — Neues Modul für strukturierte Datensammlung mit Priority-Tiers (1=kritisch, 2=wichtig, 3=nice-to-have), Change-Detection zwischen Läufen, und Token-Budget-Management mit Priority-basierter Truncation.
- **CalendarWatcher → Reasoning** — Kalender-Benachrichtigungen triggern fokussiertes Reasoning (Querverbindungen: Termin + Ort + Shopping-Watch? Zeitkonflikt mit Todos?).
- **TodoWatcher → Reasoning** — Todo-Erinnerungen (fällig/überfällig) triggern fokussiertes Reasoning.
- **Post-Skill Reasoning** — Nach erfolgreicher Ausführung von calendar, todo, microsoft_todo, email, homeassistant wird ein fokussierter Reasoning-Pass gestartet.
- **Event-Trigger Debounce** — Max ein event-getriggertes Reasoning pro 5 Minuten (verhindert Trigger-Storms).

### Changed
- **Reasoning Tier: fast → default** — Standard-Tier von Haiku auf Sonnet/GPT-5.4 geändert für bessere Cross-Domain-Inferenz. ENV `ALFRED_REASONING_TIER=fast` weiterhin verfügbar für Kostenkontrolle.
- **Kalender-Fenster: 24h → 48h** — Reasoning sieht jetzt Termine der nächsten 48 Stunden statt nur 24.

## [0.19.0-multi-ha.229] - 2026-03-30

### Added
- **ProjectAgent: Git Push nach Fertigstellung** — Nach der letzten Phase wird automatisch gepusht. Token aus Forge-Config wird temporär in die Remote-URL injiziert und danach entfernt. Wenn ein Remote bereits existiert wird es wiederverwendet (kein neues Repo). Git-Befehle laufen als der richtige User (runAsUser). Push-Fehler brechen das Projekt nicht ab.

### Fixed
- **ProjectAgent + CodeAgent: chown-Safety** — `chown -R` nur bei Pfad-Tiefe ≥ 2 (verhindert versehentliches Ownership-Ändern von `/root/` oder `/home/`).
- **Build-Validator: User-Awareness** — Build-Commands laufen jetzt als gleicher User wie der Agent (sudo -u madh) statt als root.

## [0.19.0-multi-ha.226] - 2026-03-30

### Fixed
- **Semantic Search: UUID statt Memory-Key** — `semanticSearch()` gab die Memory-UUID als Key zurück statt den echten Key (z.B. `home_address`). Der MemoryRetriever konnte Semantic-Ergebnisse nicht mit Keyword-Ergebnissen zusammenführen → halbe Scores, doppelte Einträge, Kern-Memories nicht gefunden. Fix: Key wird jetzt aus dem Embedding-Content extrahiert.
- **Diversity-Filter: Type-spezifische Limits** — `MAX_PER_TYPE` war pauschal 3 für alle Types. entity/fact (Kern-Daten) fielen heraus wenn mehr als 3 vorhanden. Jetzt: entity(8), fact(8), rule(10), connection(5), pattern(5), general(5), default(5).
- **System-Prompt: Memory-Recall-Instruktion** — LLM wusste nicht dass der Memory-Block im Prompt eine AUSWAHL ist. Jetzt: Explizite Instruktion bei fehlenden Fakten den Memory-Skill zu nutzen statt "weiß ich nicht" zu sagen.

## [0.19.0-multi-ha.224] - 2026-03-30

### Fixed
- **Embedding-Modell-Wechsel: Automatische Invalidierung + Re-Generierung** — Beim Wechsel des Embedding-Providers (z.B. OpenAI → Mistral) wurden alte Embeddings nicht invalidiert. Cosine-Similarity zwischen verschiedenen Modellen/Dimensionen (1536 vs 256) ergibt Nonsens → Semantic Memory Search fand nichts. Fix: Beim Start wird das aktuelle Modell mit dem DB-Modell verglichen. Bei Mismatch: alle alten Embeddings löschen + im Hintergrund mit dem neuen Modell neu generieren. Memories bleiben intakt.

## [0.19.0-multi-ha.222] - 2026-03-30

### Changed
- **Memory-Architektur bereinigt** — Neue `skill_state`-Tabelle (Migration v43) für internen Skill-State. Feed-Subscriptions, Sonos-Radio-Cache, Voice-IDs und InsightTracker-Stats aus `memories` in `skill_state` migriert. Die `memories`-Tabelle enthält jetzt NUR noch LLM-relevante User-Daten (Fakten, Entities, Patterns, Connections, Regeln, Feedback). Feed-Entries verdrängen nie wieder `home_address` aus dem System-Prompt.
- **SkillStateRepository** — Neues Repository für transienten Skill-State mit CRUD, TTL-Support und Skill-Isolation.
- **FeedReaderSkill** nutzt `SkillStateRepository` statt `MemoryRepository`
- **SonosSkill** Radio-Cache nutzt `SkillStateRepository`
- **VoiceSkill** Voice-Profile nutzen `SkillStateRepository`
- **InsightTracker** Stats nutzen `SkillStateRepository`
- **SpeechSynthesizer** Voice-Default aus `SkillStateRepository`
- Alle Refactors mit Fallback auf `MemoryRepository` für Backward-Kompatibilität

## [0.19.0-multi-ha.221] - 2026-03-30

### Fixed
- **Memory-Search nutzt keywordSearch statt LIKE** — `memory.search` nutzte den gesamten Query-String als einen LIKE-Pattern (`%Heimadresse Zuhause Adresse%`), was nie matcht. Jetzt wird `keywordSearch()` verwendet die den Query in einzelne Wörter aufteilt und JEDES Wort separat sucht. "Adresse" findet jetzt `home_address`.
- **Kern-Memories auf korrekte Types migriert** — `home_address`, `work_address`, `current_employment` etc. waren noch `type: "general"` (vor v193). Jetzt `type: "fact"`. `children` → `type: "entity"`.

## [0.19.0-multi-ha.220] - 2026-03-30

### Fixed
- **Sonos Radio: 6 Fixes** —
  1. Memory-Lookup: Gelernte Sender-URLs werden zuerst geprüft (sofortiger Start)
  2. Sonos-Favoriten: `getFavorites()` wird vor TuneIn durchsucht
  3. URL-Speicherung: Funktionierende Stream-URLs werden als Memory gespeichert
  4. play_favorite: `setAVTransportURI` + `play()` statt `playNotification` (Radio hing)
  5. play_uri: `play()` nach `setAVTransportURI` hinzugefügt
  6. Skill-Description: LLM wird angeleitet URLs als Memory zu speichern

## [0.19.0-multi-ha.219] - 2026-03-30

### Fixed
- **Reasoning Insights: `isNoInsights()` komplett vereinfacht** — Alle natürlichsprachlichen Phrasen-Filter entfernt. Nur noch exakter `KEINE_INSIGHTS`-Marker wird geprüft. Vorher: 6 Phrasen wie "keine relevanten", "kein Zusammenhang" filterten echte Insights die diese Wörter als Teilsatz enthielten. Jetzt: Alles außer exakt "KEINE_INSIGHTS" ist ein Insight.
- **Reasoning LLM-Response wird geloggt** — Debug-Log zeigt die ersten 500 Zeichen der LLM-Antwort. Bei "no insights" werden die ersten 200 Zeichen im Info-Log angezeigt. Ermöglicht Diagnose was das LLM tatsächlich antwortet.
- **Reasoning-Prompt verbessert** — Weniger restriktiv formuliert ("finde Zusammenhänge" statt "nur nicht-offensichtliche"). Klare Instruktion: "KEINE_INSIGHTS" ist die EINZIGE akzeptierte Antwort wenn nichts zu melden ist. Event-triggered Prompt ebenfalls entschärft.

## [0.19.0-multi-ha.218] - 2026-03-30

### Fixed
- **Regel-Explosion (117 → max 30)** — Skill-Error-Learning hatte keine Limits. Fix: Max 3 Regeln pro Skill, max 30 total. Cleanup löscht Regeln mit Confidence < 0.5 und die ältesten über dem Limit.
- **Voice-Messages: fehlende Skills** — Skill-Filter lief auf `"[Voice message]"` bevor die Transkription stattfand → Infrastructure-Skills (HomeAssistant, MQTT, BMW) fehlten. Fix: Bei Audio-Attachments wird der Skill-Filter übersprungen, alle Kategorien geladen.
- **InsightTracker: kein Bug** — System funktioniert korrekt. Reasoning hat seit dem isNoInsights-Fix keine Insights gesendet → pending leer → nichts zu tracken. Wird sich lösen sobald Reasoning wieder Insights produziert.

## [0.19.0-multi-ha.216] - 2026-03-30

### Fixed
- **Embeddings 401** — Mistral-Key wurde vom Default-Tier-Key überschrieben. Fix: Mistral-Key-Propagierung überschreibt jetzt immer wenn der Tier-Provider `mistral` ist.
- **Kalender Timeout** — Ein nicht erreichbarer CalDAV-Account (fam@dohnal.co) blockierte jeden Request 30 Sekunden. Fix: 5-Sekunden-Timeout pro Account mit `Promise.race`. Nicht erreichbare Accounts werden übersprungen mit Warning.
- **Port-Kollision** — Sonos HTTP-Fallback und Cluster Discovery nutzten beide Port 3421. Fix: Sonos HTTP jetzt auf Port+2 (3422).

## [0.19.0-multi-ha.214] - 2026-03-30

### Fixed
- **BMW Token-Persistierung HA-safe** — Tokens werden jetzt in der DB gespeichert (analog zum Spotify-Fix v125-133). Injizierter `ServiceResolver` unabhängig vom Request-Context. Globale Config nutzt `'__global__'` als User-Key. Partial Tokens (Device-Auth-Flow) ebenfalls DB-fähig. Disk-Fallback bleibt für Single-Node-Setups. Tokens überleben Restarts und Node-Wechsel im HA-Betrieb.

## [0.19.0-multi-ha.212] - 2026-03-30

### Added
- **Sonos-Durchsage-Integration** — VoiceSkill `announce` spielt Audio direkt auf Sonos ab:
  1. Mistral TTS generiert Audio (MP3)
  2. Audio wird als Temp-Datei gespeichert (`/tmp/alfred-tts/<uuid>.mp3`)
  3. Alfred HTTP-Server serviert die Datei unter `/files/tts/<uuid>.mp3` (kein Auth, Sonos-kompatibel)
  4. Sonos-Skill `play_uri` wird mit der URL aufgerufen
  5. Temp-Datei wird nach 5 Min automatisch gelöscht
- **HTTP-Endpoint `/files/tts/`** — Serviert temporäre Audio-Dateien für Sonos. Kein Auth (Sonos braucht direkten Zugriff). Path-Traversal-Schutz. Auto-Cleanup > 5 Min.
- **Auto-Detect LAN-IP** — Wenn `ALFRED_API_PUBLIC_URL` nicht gesetzt, wird die erste nicht-Loopback IPv4-Adresse für Sonos-URLs verwendet.
- **Fallback:** Wenn Sonos nicht verfügbar → Audio als Telegram-Attachment (wie bisher).

## [0.19.0-multi-ha.202] - 2026-03-29

### Fixed
- **VoiceSkill: Audio aus Sprachnachrichten** — Voice-Messages wurden transkribiert und das Audio verworfen. VoiceSkill konnte kein Sample für Voice Cloning bekommen. Fix: `messageAttachments` Feld im SkillContext — Pipeline behält Audio-Daten für Skills. VoiceSkill liest Audio automatisch aus der Sprachnachricht wenn kein expliziter `sample_audio` Parameter gegeben ist.

## [0.19.0-multi-ha.201] - 2026-03-29

### Fixed
- **Mistral STT Modellname (erneut)** — `voxtral-mini-transcribe-2602` existiert nicht als STT-Modell. Korrigiert zu `voxtral-mini-2602` (verifiziert gegen die tatsächliche Mistral Models API).

## [0.19.0-multi-ha.200] - 2026-03-29

### Fixed
- **Mistral STT Modellname** — `mistral-stt-latest` existiert nicht. Korrigiert zu `voxtral-mini-transcribe-2602` (das tatsächliche Mistral STT Modell).
- **Mistral TTS Modellname** — `mistral-tts-latest` existiert nicht. Korrigiert zu `voxtral-mini-tts-2603` (das tatsächliche Voxtral TTS Modell).

## [0.19.0-multi-ha.199] - 2026-03-29

### Added
- **VoiceSkill** — Voice-Management über Mistral Voxtral TTS:
  - `create_voice`: Stimme aus Audio-Sample erstellen (min. 2-3 Sek, Voice Cloning)
  - `list_voices`: Alle gespeicherten Stimmen anzeigen
  - `delete_voice`: Stimme löschen
  - `speak`: Text zu Audio mit eigener Stimme, Rückgabe als Audio-Attachment
  - `announce`: Text zu Audio für Sonos-Durchsagen
  - `set_default`: Stimme als Alfreds Standard-TTS setzen
- **Default Voice-ID in TTS-Pipeline** — Wenn eine Voice per `set_default` oder `ALFRED_TTS_VOICE_ID` gesetzt ist, verwendet Alfreds TTS automatisch diese Stimme.
- **Config:** `ALFRED_VOICE_MANAGEMENT`, `ALFRED_TTS_VOICE_ID` ENV-Variablen
- **Skill-Filter:** Voice-Keywords (stimme, durchsage, ansage, vorlesen, klonen) im media-Regex
- Automatisch aktiv wenn Mistral TTS Provider + API-Key konfiguriert. Explizit deaktivierbar mit `ALFRED_VOICE_MANAGEMENT=false`.

## [0.19.0-multi-ha.198] - 2026-03-29

### Improved
- **Mistral-Dienste unabhängig vom LLM-Provider** — Neuer `ALFRED_MISTRAL_API_KEY` als eigenständiger Key. OCR, Moderation, STT, TTS und Embeddings funktionieren jetzt auch wenn der Haupt-LLM-Provider Anthropic, OpenAI oder ein anderer ist. Beispiel: Claude als Haupt-LLM + Mistral für OCR und Moderation.
- **Setup-Wizard erweitert** — Fragt jetzt nach Mistral API-Key, Moderation, STT/TTS Provider-Wahl.
- **README: Mistral AI Dienste Sektion** — Dokumentation aller optionalen Mistral-Dienste mit ENV-Variablen.
- **Key-Propagierung** — `ALFRED_MISTRAL_API_KEY` wird automatisch an LLM-Tiers, Embeddings, STT, TTS und Moderation weitergereicht wenn deren Provider auf `mistral` steht aber kein eigener Key gesetzt ist.

## [0.19.0-multi-ha.197] - 2026-03-29

### Added
- **Mistral Embeddings aktiviert** — `supportsEmbeddings()` auf `true` gesetzt. Mistral-Embeddings API ist OpenAI-kompatibel, funktioniert sofort für Semantic Memory Search.
- **Preistabelle erweitert** — 7 neue Mistral-Modelle: mistral-small/medium/large-latest, magistral-medium/small-latest, ministral-8b-latest, mistral-embed.
- **Optionaler Moderation-Service** — Content-Safety-Check für User-Input UND LLM-Output. Unterstützt Mistral (`/v1/moderations`) und OpenAI. Vollständig optional: `ALFRED_MODERATION_ENABLED=true`. Kein separater API-Key nötig (nutzt den LLM-Provider-Key). Wenn nicht konfiguriert → Alfred funktioniert wie bisher.
- **OCR im Document-Skill** — Mistral OCR für PDFs und Bilder (Handschrift, Tabellen, Rechnungen → strukturierter Markdown). Automatisch aktiv wenn Mistral als LLM-Provider konfiguriert ist. Fallback auf bisheriges pdf-parse wenn OCR fehlschlägt oder nicht verfügbar.
- **STT/TTS Provider-Wahl** — Speech-to-Text und Text-to-Speech unterstützen jetzt Mistral als Alternative zu OpenAI. Config: `ALFRED_STT_PROVIDER=mistral`, `ALFRED_TTS_PROVIDER=mistral`. Kein separater Key nötig. Fallback auf OpenAI wenn Mistral nicht konfiguriert.

## [0.19.0-multi-ha.196] - 2026-03-29

### Improved
- **Sprachbindung dynamisch** — Regel-LLM-Prompts verwenden jetzt "Antworte in derselben Sprache wie die User-Nachricht/Korrektur" statt hardcodiertem "Antworte auf Deutsch". PatternAnalyzer (nachts) leitet Sprache aus bestehenden Memories ab. Funktioniert für alle Sprachen ohne Konfiguration.

## [0.19.0-multi-ha.195] - 2026-03-29

### Fixed
- **Regel-Boost-Semantik** — Regeln werden nur noch geboostet wenn keine ähnlichen Korrekturen in den letzten 7 Tagen vorliegen (Jaccard-Similarity gegen Feedback-Memories). Vorher: Boost bei jeder beliebigen User-Aktivität.
- **Fingerprint-Kollision** — Skill-Error-Keys verwenden jetzt MD5-Hash (12 Hex-Zeichen) statt Truncation. Zwei verschiedene Fehler erzeugen nie denselben Key.
- **Race Condition Multi-Node** — Boost verwendet UPSERT statt additivem Delta + 20h-Guard gegen Double-Boost am selben Tag. Beide Nodes können gleichzeitig analysieren ohne Duplikate.
- **Rule-Merge-Schutz** — `rule`-Memories werden jetzt wie `entity`/`fact` vom Consolidator-Merge ausgeschlossen.
- **Stale-Deletion schließt Regeln aus** — `findStale()` ignoriert jetzt `type='rule'`. Regeln haben ihr eigenes Cleanup (confidence < 0.3 + 30 Tage).
- **Sprachbindung** — Alle Regel-LLM-Prompts erzwingen jetzt deutsche Ausgabe ("Antworte auf Deutsch").
- **Rate-Limiting** — Maximal 1 Regel-Extraktion pro 60 Sekunden, verhindert LLM-Kosten bei Korrektur-Spam.
- **Feedback-Akkumulation** — Maximal 20 Feedback-Memories pro User, älteste werden automatisch gelöscht.

## [0.19.0-multi-ha.194] - 2026-03-29

### Added
- **Regel-Lernsystem (MetaClaw-inspiriert)** — Alfred lernt jetzt aus Fehlern und User-Korrekturen:
  1. **Korrektur → Regel:** User-Korrekturen werden via LLM zu generalisierbaren Verhaltensregeln destilliert (z.B. "Antworte immer in 2-3 Sätzen"). Bisherige Feedback-Speicherung bleibt als Rohdaten-Archiv erhalten.
  2. **Skill-Error-Learning:** PatternAnalyzer erkennt nachts wiederkehrende Skill-Fehler (≥3x gleicher Typ) und leitet Vermeidungsregeln ab (z.B. "YouTube immer mit Channel-ID statt Name").
  3. **Regel-Confidence:** Neue Regeln starten bei 0.7. Regeln die funktionieren steigen nachts (+0.05), Regeln die trotzdem zu Korrekturen führen werden verfeinert oder sinken. Regeln mit confidence < 0.3 nach 30 Tagen werden automatisch entfernt.
  4. **Dynamische Auswahl:** Unbegrenzte Regel-Bibliothek in der DB. Pro Prompt werden die 10 relevantesten Regeln via Hybrid-Retrieval (Keyword + Confidence) ausgewählt.
  5. **Prompt-Sektion:** Eigene "Verhaltensregeln"-Sektion VOR den Memories im System-Prompt.
- **Memory-Type `rule`** — Neuer persistenter Type für gelernte Verhaltensregeln mit Confidence-Scoring und automatischem Lifecycle.

## [0.19.0-multi-ha.193] - 2026-03-29

### Added
- **Memory-Schutz für Kern-Erinnerungen** — 4-Ebenen-Schutz für wichtige Memories:
  1. **Type-Parameter im MemorySkill**: LLM kann `entity` (Personen), `fact` (Adressen, Arbeitgeber), `general` (Default) oder `preference` als Type setzen
  2. **UPSERT-Schutz**: Manuell gespeicherte Memories (`source='manual'`) werden nicht mehr von automatischer Extraktion (`source='auto'`) überschrieben
  3. **Consolidator-Guard**: Entity-, Fact- und Manual-Memories werden nie automatisch gemergt oder gelöscht
  4. **Delete-Guard**: Entity/Fact-Memories brauchen `confirm: true` beim Löschen — verhindert autonomes Löschen durch das LLM
- **System-Prompt Memory-Instruktion**: LLM wird instruiert wann entity/fact/general zu verwenden ist

## [0.19.0-multi-ha.192] - 2026-03-29

### Improved
- **Watch Quiet-Hours Digest** — Alerts während Quiet-Hours werden nicht mehr verworfen, sondern in einer Queue gesammelt. Nach Ende der Nachtruhe wird ein gebündelter Digest gesendet ("📋 Watch-Digest: X Alerts während Nachtruhe"). Keine Nachrichten gehen mehr verloren.
- **Reasoning Memory-Cap auf 40 erhöht** — 25 war zu wenig (26 Pattern+Connection-Memories + 10 General = 36). Jetzt 40 mit Priorität für Pattern + Connection.

## [0.19.0-multi-ha.191] - 2026-03-29

### Added
- **Watch: Quiet-Hours** — Neues `quiet_hours_start` / `quiet_hours_end` Feld (HH:MM Format). Alerts werden während des Quiet-Windows unterdrückt (last_value wird trotzdem aktualisiert). Unterstützt Overnight-Ranges (z.B. 22:00-06:30). Migration v42.
- **Watch: `update`-Action** — Bestehende Watches können jetzt geändert werden: `cooldown_minutes`, `interval_minutes`, `quiet_hours_start`, `quiet_hours_end`, `enabled`. Ownership-Check inkludiert.
- **ReasoningEngine: `watch` in PROACTIVE_SKILLS** — Reasoning kann jetzt autonom Watch-Parameter anpassen (Quiet-Hours setzen, Cooldown ändern) und den User darüber informieren.

### Fixed
- **Reasoning: `isNoInsights()` entschärft** — Die breite Catch-all-Regel (jeder Text mit "keine"+"erkenntnis/hinweis") filterte echte Insights. Entfernt — nur noch exakte Marker und Kurztext-Check (< 50 Zeichen). Behebt das Problem dass seit v183 ALLE scheduled Reasoning-Passes "no insights" meldeten.
- **Reasoning: Memory-Volumen begrenzt** — Max 25 Memories im Reasoning-Prompt. Pattern + Connection haben Vorrang, Rest wird mit Recent aufgefüllt. Verhindert Prompt-Überladung die den LLM zu zusammenfassenden "keine Erkenntnisse"-Phrasen verleitet.

## [0.19.0-multi-ha.190] - 2026-03-28

### Fixed
- **CodeAgent: chown cwd bei sudo -u** — Wenn der Agent via `sudo -u <user>` als nicht-root User läuft, wird das Arbeitsverzeichnis automatisch dem User zugewiesen (`chown -R`). Behebt das Problem dass Claude Code als `madh` keine Dateien in root-owned Verzeichnissen schreiben kann.

## [0.19.0-multi-ha.189] - 2026-03-28

### Fixed
- **CodeAgent: cwd Auto-Erstellung** — Arbeitsverzeichnis wird automatisch erstellt wenn es nicht existiert. Vorher: `spawn` schlug mit Exit 127/ENOENT fehl wenn das Verzeichnis fehlte.

## [0.19.0-multi-ha.188] - 2026-03-28

### Fixed
- **Shopping: Relevanz-Filter** — Geizhals-Freitextsuche liefert oft irrelevante Zubehör-Treffer (z.B. "RTX 5090" → DisplayPort-Kabel). Neuer `filterByRelevance()`: Prüft ob der Produktname mindestens ein signifikantes Wort (≥3 Zeichen) aus der Suchanfrage enthält. "DisplayPort Kabel" wird bei "RTX 5090"-Suche gefiltert, bleibt aber bei "DisplayPort Kabel"-Suche. Wenn kein relevantes Ergebnis bleibt, werden alle zurückgegeben (Fallback ans LLM).

## [0.19.0-multi-ha.187] - 2026-03-28

### Fixed
- **Shopping: Zubehör-Filter entfernt** — Der Filter der Accessoire-URLs (`-a\d+.html`) entfernte war falsch: User die Zubehör suchen (Kabel, Adapter) bekamen leere Ergebnisse. Relevanz-Entscheidung wird dem LLM überlassen — das erkennt korrekt wenn Treffer nicht zum Suchbegriff passen und wechselt automatisch auf Kategorie-Suche.

## [0.19.0-multi-ha.186] - 2026-03-28

### Fixed
- **Shopping/Geizhals: Korrekte CSS-Selektoren** — Geizhals verwendet `galleryview__item`, `galleryview__name-link`, `galleryview__price-link` Klassen. Puppeteer DOM-Extraktion und Regex-Parser jetzt auf die tatsächliche Geizhals-HTML-Struktur angepasst. Regex-Parser erkennt beide Attribut-Reihenfolgen (`href...title` und `title...href`).

## [0.19.0-multi-ha.185] - 2026-03-28

### Fixed
- **Shopping/Geizhals: DOM-basierte Produktextraktion** — Geizhals ist eine JS-SPA, der bisherige Regex-Ansatz auf statischem HTML lieferte Zubehör/Banner statt echte Suchergebnisse. Neuer primärer Pfad: Puppeteer mit `networkidle2` + `waitForSelector` wartet auf vollständiges JS-Rendering, dann `page.evaluate()` extrahiert Produkte direkt aus dem DOM (Name, Preis, URL strukturiert). Regex-Parsing als Fallback beibehalten.
- **Shopping: Zubehör-Filter** — Im Regex-Fallback werden Accessoire-URLs (`-a\d+.html`) gefiltert wenn echte Produkte (`-v\d+.html`) vorhanden sind.
- **Shopping: Preiszuordnung** — Positionsbasierte Preis-Zuordnung (`allPrices[i]`) ersetzt durch kontextbasierte Extraktion: Preis wird im HTML-Fenster um den jeweiligen Produkt-Link gesucht.

## [0.19.0-multi-ha.184] - 2026-03-28

### Fixed
- **5 Test-Failures behoben** — WatchEngine-Tests (4): `updateActionError` und `updateSkillParams` Mock fehlte in `createMockWatchRepo()`. Skill-Filter-Test (1): Trennbares Verb "lade...herunter" — `herunter\w*` als separates Keyword zum `files`-Regex hinzugefügt.
- **Travel-Skill Fehlermeldung** — Verwies fälschlich auf `ALFRED_TRAVEL_KIWI_API_KEY` (Dead Code). Korrigiert zu `ALFRED_TRAVEL_BOOKING_RAPID_API_KEY`.

## [0.19.0-multi-ha.183] - 2026-03-28

### Fixed
- **Cross-Context Connection-Memories funktionieren jetzt** — Signal-Scanner blockierte aktionsorientierte Nachrichten (Fragen, Requests "kannst du", "zeig mir") als `low` Signal → Memory-Extraktion wurde übersprungen → Connections nie extrahiert. Fix: Separater Connection-Scan-Path der unabhängig vom Signal-Level läuft wenn User ≥5 Memories hat. Neue `extractConnectionsOnly()` Methode im MemoryExtractor.
- **InsightTracker Persistence** — Stats (positive/negative/ignored Counts pro Insight-Kategorie) werden jetzt in der DB persistiert statt nur In-Memory. Bei Deploy/Restart wird der State aus der DB geladen. Preferences können jetzt über mehrere Restarts akkumulieren und die MIN_SAMPLES-Schwelle (5) erreichen.
- **Rate-Limit Counter in Active-Learning** — Erster Extraktions-Call pro User/Tag wurde nicht im Counter registriert. Fix: Timestamp wird jetzt auch beim ersten Call gespeichert.
- **Memory-Extractor Silent Catch** — DB-Fehler beim Laden existierender Memories für Cross-Context-Analyse wurden verschluckt. Jetzt geloggt als Warning.
- **getRecentForPrompt Sortierung** — Memories für LLM-Prompt werden jetzt nach `confidence DESC` statt `updated_at DESC` sortiert. Hochwertige Memories (Adresse, Arbeitgeber) haben Priorität über kürzlich aktualisierte Feed-Entries.

## [0.19.0-multi-ha.182] - 2026-03-28

### Improved
- **YouTube Watch: automatische Channel-ID-Auflösung** — Wenn ein Watch mit `channelName` (z.B. "Citystate") angelegt wird, löst der YouTube-Skill beim ersten Poll den Namen zur stabilen `channelId` (UC...) auf und **schreibt die ID dauerhaft in die Watch-Params**. Alle folgenden Polls verwenden direkt die ID — kein Search-API-Call mehr, 100 Quota-Units/Poll gespart, keine inkonsistenten Ergebnisse mehr.
- **Watch-Engine: Skill-Param-Mutation** — Wenn ein Skill seine Input-Parameter ändert (z.B. Name→ID Auflösung), werden die geänderten Params automatisch in der DB persistiert via `updateSkillParams()`.

## [0.19.0-multi-ha.181] - 2026-03-27

### Fixed
- **YouTube Channel-ID Caching** — Aufgelöste Channel-IDs werden im Speicher gecacht. Watches mit `channelName` müssen die Search API (100 Quota-Units) nur beim ersten Poll aufrufen, danach wird die stabile `UC...`-ID aus dem Cache verwendet. Verhindert Fehler wenn die Search API inkonsistente Ergebnisse liefert (z.B. "Citystate" wurde nach ein paar Stunden nicht mehr gefunden).
- **YouTube Channel-ID Hinweis** — Bei Channel-Abfragen per Name wird die aufgelöste Channel-ID im Ergebnis angezeigt, damit Watches direkt mit der stabilen ID angelegt werden können.

## [0.19.0-multi-ha.180] - 2026-03-27

### Fixed
- **YouTube-Skill Error-Handling** — Bei 403/429-Fehlern wird jetzt der Google-API-Fehlergrund angezeigt (z.B. `quotaExceeded`, `accessNotConfigured`, `forbidden`) statt nur `403 Forbidden`. Ermöglicht Diagnose ob API nicht aktiviert, Quota erschöpft oder Key-Restriction das Problem ist.

## [0.19.0-multi-ha.179] - 2026-03-27

### Added
- **always_* Watch-Operatoren aktiviert** — `always_gt`, `always_lt`, `always_gte`, `always_lte` sind jetzt über die Watch-Skill API verfügbar. Triggern bei JEDEM Poll wo Bedingung erfüllt ist (kein State-Change nötig). Nützlich für wiederkehrende Alerts (z.B. "Temperatur > 30°C bei jedem Check melden"). Waren zuvor vollständig implementiert (Typ, Evaluierung, Labels) aber nicht im InputSchema/VALID_OPERATORS registriert.

## [0.19.0-multi-ha.178] - 2026-03-27

### Added
- **Tests: condition-evaluator** — 65 Tests für extractField, evaluateCondition (alle 16 Operatoren inkl. always_*), Baseline-Verhalten, State-Change, evaluateCompositeCondition (AND/OR)
- **Tests: feed-reader** — 14 Tests für findLastKnownIndex (Multi-Identifier), fallbackByDate, checkSingleFeed
- **Tests: calendar-skill** — 11 Tests für Vergangenheits-Check, Duplikat-Erkennung, Provider-Resolution

### Improved
- **README Skills-Tabelle aktualisiert** — Von "46+" auf "60+" Skills. Neue Kategorien: Finance (crypto_price, bitpanda, trading), Productivity (onedrive). Fehlende Skills ergänzt: recipe, mqtt, travel, goe_charger, shopping, spotify, sonos.
- **any-Reduktion** — `calendarSkill?: any` → `CalendarSkill`, WeatherSkill `GeoResult` um `country_code` ergänzt, TradingSkill `CcxtExchange` Interface statt `any`, MqttSkill `MqttClient` Interface statt `any`.

## [0.19.0-multi-ha.177] - 2026-03-27

### Security
- **SQL-Injection in Database-Skill behoben** — MySQL `describeTable()` und MSSQL `describeTable()` verwendeten unsichere String-Interpolation für Tabellennamen. Jetzt parameterisierte Queries (`INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?` bzw. `@tableName`).
- **HTTP-Adapter Auth-Bypass behoben** — `checkAuth()` gab fälschlich `true` zurück wenn kein apiToken aber authCb konfiguriert war. Jetzt: 401 Unauthorized wenn kein gültiger Token vorgelegt wird.
- **Code-Sandbox ENV-Isolation** — Sandbox-Prozesse erben nicht mehr alle Umgebungsvariablen. ALFRED_*, ANTHROPIC_*, OPENAI_*, AWS_* und andere Secret-Patterns werden gefiltert. Verhindert Exfiltration von API-Keys durch kompromittierten Code.
- **Skill-Input-Logging redaktiert** — Sensible Felder (password, token, secret, apiKey etc.) werden vor dem Logging auf `[REDACTED]` gesetzt.
- **TradingSkill Limit-Check fail-safe** — Bei Ticker-Fehler wird die Order jetzt abgelehnt statt ohne Limit-Prüfung ausgeführt.

### Fixed
- **SpotifySkill Race Condition (Multi-User)** — `activeConfigs`/`mergedConfigs` waren Instanzvariablen die bei parallelen Requests im `finally`-Block zurückgesetzt wurden. Jetzt lokale Variablen pro Request — kein Singleton-Konflikt mehr bei Multi-User.
- **Memory Leak: anonyme setInterval** — Memory-Consolidator, Pattern-Analyzer und Cluster-Monitor Intervalle werden jetzt in `stop()` korrekt bereinigt.
- **InsightTracker.processExpired()** — Wird jetzt alle 30 Min aufgerufen. Vorher: nie aufgerufen → "ignorierte" Insights wurden nie gezählt → Preference-Learning unvollständig.
- **Telegram-Hardcode für Proaktivität entfernt** — ReasoningEngine, CalendarWatcher und TodoWatcher verwenden jetzt den ersten aktiven Adapter statt hart `telegram`. Proaktive Nachrichten erreichen jetzt auch Discord/Signal/Matrix-User.

## [0.19.0-multi-ha.176] - 2026-03-27

### Fixed
- **Kalender Duplikat-Prävention (alle Provider)** — Provider-agnostischer Duplikat-Check direkt im CalendarSkill: Vor jedem `create_event` werden existierende Events im selben Zeitfenster abgefragt und auf gleichen Titel geprüft (case-insensitive, ±5 Min Toleranz). Schützt ALLE Codepaths: User-Request, ReasoningEngine-Autonomie, Watch-Actions. Vorher: Nur Microsoft hatte `transactionId`, CalDAV und Google hatten NULL Duplikatschutz.
- **Kalender Vergangenheits-Check** — Events in der Vergangenheit werden abgelehnt mit klarer Fehlermeldung. Vorher: LLM konnte beliebige vergangene Daten senden und Alfred erstellte den Termin ohne Warnung.

## [0.19.0-multi-ha.175] - 2026-03-27

### Fixed
- **Feed-Reader GUID-Instabilität** — RSS-Watches triggerten nur einmal statt bei jedem neuen Artikel. Ursache: Wenn ein Feed instabile GUIDs hat (z.B. Tracking-Parameter in URLs), fand `lastEntryId` den letzten bekannten Artikel nicht mehr → immer "neue" Items → `newCount` blieb dauerhaft >0 → kein State-Change → Watch triggert nie wieder. Fix: Robuste Multi-Identifier-Erkennung (guid, link, title separat) + Fallback auf pubDate wenn kein ID-Match. Keine false Positives mehr bei instabilen Feeds.

## [0.19.0-multi-ha.174] - 2026-03-27

### Fixed
- **Watch Baseline-Bug** — Neue Watches mit Schwellwert-Operatoren (gt, lt, eq, contains etc.) triggerten beim ersten Poll NIE, auch wenn die Bedingung sofort erfüllt war. Ursache: Baseline-Check (`lastValue === null → never trigger`) galt für ALLE Operatoren. Fix: Baseline-Check nur noch für Change-Detection Operatoren (changed, increased, decreased). Schwellwert-Operatoren triggern sofort wenn die Bedingung erfüllt ist.

### Fixed
- **Pattern/Connection Memories immer im Prompt** — Pattern-Memories (Verhaltensmuster) und Connection-Memories (Cross-Context Verbindungen) werden jetzt IMMER geladen, unabhängig von Keyword/Semantic-Relevanz zur aktuellen Nachricht. Vorher: Nur geladen wenn zufällig relevant zur Nachricht oder in den neuesten 20 Memories. Betrifft sowohl Pipeline (System-Prompt) als auch ReasoningEngine.
- **`getByType()` Methode** in MemoryRepository — Lädt Memories nach Type (pattern, connection) sortiert nach Confidence.
- **`connection` Label im Prompt** — Connection-Memories werden jetzt als "Cross-Context Connections" gruppiert statt unter dem rohen Type-Namen.

### Fixed
- **Bundle: mqtt + sonos inline** — `mqtt` und `sonos` npm-Pakete werden jetzt ins Bundle eingebunden statt externalisiert. User muss keine Pakete mehr manuell installieren (`npm install mqtt/sonos`). Funktioniert sofort nach `npm install -g @madh-io/alfred-ai`.

### Added
- **Insight-Preference Learning** — Alfred lernt welche proaktiven Hinweise der User schätzt. Tracking: positive Reaktion (<30 Min, "danke/super/ok"), negative ("stopp/nervig"), ignoriert (keine Reaktion). Nach 5+ Interaktionen pro Kategorie wird eine Präferenz als pattern-Memory gespeichert. ReasoningEngine sieht die Präferenzen im Prompt und priorisiert/reduziert Insight-Kategorien entsprechend.

## [0.19.0-multi-ha.164] - 2026-03-26

### Added
- **Continuous Conversation-Learning (Pattern-Analyzer)** — Analysiert das Nutzungsverhalten der letzten 7 Tage (Activity-Log) und extrahiert Verhaltensmuster: Timing-Gewohnheiten, Themen-Affinität, Kommunikationsstil, Routinen. Läuft täglich nachts, speichert Muster als `pattern` Memories. LLM sieht die Muster im System-Prompt und passt sich an.
- **MQTT-Skill** — Direkte Kommunikation mit MQTT-Brokern (Mosquitto etc.). 6 Actions: publish, subscribe, status, devices (Zigbee2MQTT Discovery), set/get (Zigbee2MQTT Shortcut). Persistente Broker-Verbindung, Auto-Reconnect. Watch-kompatibel für Sensor-Alerts. Setup per ENV (`ALFRED_MQTT_BROKER_URL`).

## [0.19.0-multi-ha.163] - 2026-03-26

### Changed
- **Kalender Duplikat-Prävention via Microsoft Graph `transactionId`** — Eigene Dedup-Logik (listEvents + Titel-Match + Zeitfenster) komplett entfernt. Stattdessen: Deterministischer `transactionId` aus normalisiertem Titel + Datum (MD5 → GUID). Microsoft Graph blockiert Duplikate serverseitig — zuverlässiger als clientseitige Prüfung. Titel-Varianten ("Sommercamp SVA" vs "Sommercamp des SVA") und Zeit-Varianz (±10 Min) werden durch Normalisierung abgefangen.

### Fixed
- **Kalender Dedup Root Cause** — Duplikate entstanden weil das LLM den Titel leicht variiert ("Sommercamp SVA" vs "Sommercamp des SVA"). Der exakte Titel-Match fand das existierende Event nicht. Fix: Flexibler Titel-Match (contains + gemeinsame Schlüsselwörter) mit ±5 Min Zeitfenster (nicht 30 Min oder 2h — das würde echte separate Termine blockieren).
- **Kalender Duplikat-Erkennung verstärkt** — Zeitfenster von ±5 Min auf ±2 Stunden erweitert (fängt Timezone-Shifts). Titel-Vergleich flexibler: exact match ODER contains ODER gemeinsame Schlüsselwörter (fängt "Linus – Sommercamp" vs "Sommercamp des SVA"). Verhindert wiederholtes Eintragen des gleichen Events bei Watch-Runs.

### Added
- **go-e Charger Skill** — Wallbox-Steuerung über lokale HTTP API (kein Cloud nötig). 13 Actions: Status, Laden starten/stoppen, Ampere setzen (6-32A), Phasenumschaltung (1-phasig/Auto/3-phasig), 5 Lademodi (Off/PV/MinSoC/Zeitgesteuert/PV-Überschuss), aWATTar Eco-Laden mit automatischer Endpreis→Marktpreis Umrechnung, Energielimit pro Session, Trip-Planung (Abfahrtszeit). API v1+v2 Auto-Detection (go-e V2/V3/V4/Gemini/HOMEfix). ReasoningEngine-Integration (Wallbox + BMW + Energiepreis = autonomes Lademanagement). Setup per Chat oder ENV (`ALFRED_GOE_HOST`).

## [0.19.0-multi-ha.157] - 2026-03-26

### Fixed
- **Kalender list_accounts Parsing** — `handleListAccounts()` gibt `{ accounts: string[] }` zurück, nicht ein direktes Array. Pipeline prüfte `Array.isArray(data)` was `false` war → Fallback auf leeren Default-Account. Fix: `data.accounts` extrahieren. Root Cause für "keine Kalendereinträge" trotz Events im Shared Calendar.
- **Proaktives Denken Prompt** — Überarbeitet: Nur DIREKT relevante Verbindungen (Kalender-Konflikte, Kinder-Termine). Keine erzwungenen Verbindungen (Einkaufsliste hat nichts mit einer Reise zu tun). Explizite Anweisung: "Do NOT stretch connections".
- **Kalender-Events ALLE Accounts** — Pipeline fragte nur den Default-Kalender ab (war leer). Jetzt: `list_accounts` → für JEDEN Account `list_events` → dedupliziert + sortiert. Shared Calendar (`fam@dohnal.co`) wird korrekt im System-Prompt angezeigt.
- **Kalender-Events im System-Prompt** — `todayEvents` wurde vom PromptBuilder unterstützt aber von der Pipeline NIE übergeben (war immer `undefined`). Das LLM hat nie Kalender-Termine im Kontext gesehen. Fix: Pipeline lädt jetzt Events der nächsten 7 Tage via Calendar-Skill (mit korrektem Multi-User/Shared-Calendar Context) und übergibt sie an den PromptBuilder. Abschnitt umbenannt zu "Upcoming events (next 7 days)".

### Changed
- **Proaktives Denken im System-Prompt** — Statt eines separaten Parallel-LLM-Calls (`generateProactiveInsight`) wird das LLM jetzt direkt im System-Prompt angewiesen proaktiv zu denken. Neuer Abschnitt "Proactive thinking" instruiert: bei Plänen/Orten/Zeiten → Kalender prüfen, Memories querverweisen, Todos checken, Bedürfnisse antizipieren. Kein extra LLM-Call, keine extra Tokens, nutzt den bereits korrekt aufgebauten Kontext (Multi-User, Shared Kalender, Memories).
- **Entfernt: `generateProactiveInsight`, `hasReasoningSignal`** — Der Parallel-LLM-Call Ansatz war architektonisch falsch (eigener Context-Aufbau parallel zur Pipeline, Shared Kalender nicht erreichbar, fragile Signal-Regex). Der richtige Ort für proaktives Denken ist der System-Prompt.

### Fixed
- **Conversation-Reasoning Kontext** — Nutzt jetzt den echten SkillContext (mit userServiceResolver, masterUserId, linkedPlatformUserIds) statt eines Fake-Contexts. Shared Kalender (`fam@dohnal.co`) und Microsoft Todo werden korrekt abgefragt. Kalender-Fenster auf 7 Tage erweitert statt 48h.
- **Conversation-Reasoning Prompt** — Überarbeitet für bessere Cross-Context Verbindungen. Explizite Beispiele (Kalender-Konflikte, Kinder-Termine, Shopping-Watches, offene Todos, BMW-Akku). Weniger streng — findet jetzt auch implizite Verbindungen.

### Added
- **Conversation-Reasoning** — Bei "Signal-Nachrichten" (Ortsangaben, Zeitangaben, Fahrten, Käufe) führt Alfred einen schnellen Cross-Context Check durch: Memories + Kalender + Todos werden gegen die Nachricht geprüft. Proaktive Hinweise (Zeitkonflikte, Gelegenheiten, vergessene Verpflichtungen) werden direkt an die Antwort angehängt. ~250 extra Tokens pro Signal-Nachricht (fast-tier). Reagiert sofort, nicht erst beim nächsten Reasoning-Pass.

### Fixed
- **Reasoning "No Insights" Filterung** — LLM erklärt manchmal WARUM es keine Insights gibt statt einfach "KEINE_INSIGHTS" zu antworten. Neue `isNoInsights()` Funktion erkennt Varianten: "keine relevanten", "kein Zusammenhang", "keine Verbindung", "keine Handlungsempfehlung" etc. Verhindert dass leere Begründungen als Insights an den User gesendet werden.
- **Wetter Wien → Missouri** — Geocoding bevorzugt jetzt AT/DE/CH Ergebnisse. Open-Meteo mit `language=de` und `count=5`, dann Auswahl nach Country-Code Priorität. "Wien" gibt jetzt Wien, Österreich statt Vienna, Missouri.

### Added
- **Autonomie-Levels** — User kann per Memory (`autonomy_level`) steuern wie autonom Alfred handelt: `confirm_all` (Default, wie bisher — immer fragen), `proactive` (Low/Medium-Risk autonom ausführen + informieren), `autonomous` (alles außer High-Risk autonom). Setzbar per Chat: "Merke dir: autonomy_level = proactive".
- **Event-getriebenes Reasoning** — Watch-Alerts triggern sofort einen fokussierten Reasoning-Pass der das Event im Kontext (Kalender, Todos, Memories) analysiert. Beispiel: "RTX 5090 Preis gefallen" + "User hat morgen Termin in Wien" → "Abholung bei Cyberport Wien wäre auf dem Weg möglich."
- **Reasoning Default auf hourly** — Statt 3x/Tag (morning_noon_evening) denkt Alfred jetzt stündlich. Konfigurierbar über `ALFRED_REASONING_SCHEDULE`.

## [0.19.0-multi-ha.146] - 2026-03-25

### Added
- **Cross-Context Memory Enrichment** — Memory-Extraktion erkennt jetzt Verbindungen zwischen neuen Aussagen und bestehenden Memories. Neuer Memory-Typ `connection` für cross-domain Insights (z.B. "User fährt morgen nach Wien + RTX 5090 Watch aktiv → Abholung bei Cyberport Wien möglich"). Die letzten 20 Memories werden als Kontext mitgegeben, das LLM sucht proaktiv nach Querverbindungen. Kostet ~200-400 extra Tokens pro Extraktion.
- **Erweiterte Low-Risk Skills im Reasoning** — Weather, Energy, CryptoPrice, Shopping, Recipe, Transit, Routing, FeedReader als autonome read-only Skills im ReasoningEngine. Können ohne User-Bestätigung ausgeführt werden für proaktive Informationsbeschaffung.

### Fixed
- **Shopping-Skill Puppeteer Fallback** — Bei Cloudflare JS-Challenge (403) wechselt der Skill automatisch auf Puppeteer (headless Chromium). Erster Request via fetch() (schnell), bei 403 Switch auf Puppeteer (löst JS-Challenge). Browser-Instanz wird wiederverwendet. Benötigt Chromium auf dem Server (`apt install chromium-browser`).
- **Shopping-Skill Cloudflare Challenge** — Geizhals nutzt dynamische Cloudflare JS-Challenges die reinen HTTP-Fetch blocken (403). Fix: Cookie-Persistenz über Requests (Cloudflare `__cf_bm` und `_cfuvid` Cookies werden extrahiert und bei Folge-Requests mitgeschickt). Retry-Kette mit steigenden Delays (2s, 3s, 5s). Reduziert 403-Rate deutlich.

### Added
- **Shopping/Preisvergleich-Skill** — Produktsuche und Preisvergleich über Geizhals.at (HTML-Parsing, kein API-Key nötig). Actions: search (Freitextsuche), category (Kategorie mit Filtern), detail (alle Anbieter), price_history (Preisverlauf), compare (Produktvergleich), cheapest (günstigstes Angebot, Watch-kompatibel für Preis-Alerts). Unterstützt alle Geizhals-Kategorien (Notebooks, Smartphones, GPUs, TVs etc.). Self-Throttling (2s zwischen Requests). Ergänzt den bestehenden MarketplaceSkill (eBay/Willhaben) um Neuware-Preisvergleich.

## [0.19.0-multi-ha.141] - 2026-03-25

### Fixed
- **Kalender Event-ID Account-Zuordnung** — Bei Multi-Account Kalendern (z.B. `microsoft` + `fam@dohnal.co`) wurde die Event-ID beim Löschen/Updaten dem falschen Account zugeordnet. Root Cause: `listEvents` gab rohe IDs ohne Account-Prefix zurück → `decodeId` fiel auf den Default-Account (`microsoft`) zurück → Delete ging an `/me/calendar/events/` statt `/users/fam@dohnal.co/calendar/events/`. Fix: (1) Event-IDs werden jetzt mit `account::rawId` Prefix zurückgegeben, (2) `updateEvent`/`deleteEvent` akzeptieren expliziten `account` Parameter als Override.
- **Kalender Update/Delete 404 auf Shared Calendars** — Microsoft Graph API Pfad von `/users/{email}/events/{id}` auf `/users/{email}/calendar/events/{id}` geändert. Ohne `/calendar/` gibt Graph 404 für Events auf freigegebenen Kalendern zurück. Betrifft `updateEvent`, `deleteEvent` und `createEvent`.
- **Kalender Duplikat-Erkennung** — Vor `createEvent` wird geprüft ob ein Event mit gleichem Titel und Start-Zeit (±5 Min) bereits existiert. Falls ja, wird das bestehende Event zurückgegeben statt ein Duplikat zu erstellen. Verhindert mehrfache Einträge bei LLM-Retries.

### Added
- **OneDrive-Skill** — Microsoft OneDrive Dateiverwaltung über bestehende MS Graph Integration. Dateien auflisten, suchen, hoch-/herunterladen, Ordner erstellen, verschieben, kopieren, löschen, teilen (View/Edit Links). Zugriff auf eigene Dateien und freigegebene Ordner (SharedUser). Document-Ingest (RAG) direkt aus OneDrive. Nutzt denselben OAuth-Token wie Email/Kalender/Kontakte/Todo — kein zusätzliches Setup. MS Graph Scope um Files.ReadWrite.All + Sites.Read.All erweitert (erfordert erneutes auth_microsoft für OneDrive-Zugriff).

## [0.19.0-multi-ha.138] - 2026-03-24

### Added
- **Secrets-Redaction in LLM Tool-Results** — Sensitive Felder (`refreshToken`, `clientSecret`, `accessToken`, `password`, `apiKey`, JWT-Tokens) werden aus Tool-Results maskiert bevor sie ans LLM gesendet werden. Verhindert dass Tokens in Chat-Antworten oder Conversation-History landen. Auch finale Antworten werden beim Speichern gescrubt.
- **IMAP-Passwort Sicherheitshinweis** — Bei `setup_service` mit Passwort-Feld wird ein Hinweis angezeigt: App-spezifische Passwörter oder Microsoft 365 (auth_microsoft) empfohlen.

### Fixed
- **Skill-Filter Plural-Bug (ALLE Kategorien)** — `\w*`-Suffix auf alle Keywords in ALLEN 7 Kategorien angewendet (automation, files, infrastructure, identity zusätzlich zu productivity, information, media). Vorher: "Watches", "Dateien", "VMs", "Lichter", "Datenbanken", "Nachrichten" etc. wurden nicht erkannt → FALLBACK. 26/26 Test-Nachrichten matchen jetzt korrekt.
- **Skill-Filter Plural-Bug** — `\b(rezept)\b` matchte "Rezepte" NICHT (Plural), `\b(hotel)\b` matchte "Hotels" NICHT etc. Dadurch FALLBACK auf alle 43 Skills (~13.500 Tokens) statt gezielter Kategorie (~2.500-6.600 Tokens). Alle Keywords auf `\w*`-Suffix umgestellt (rezept→rezept\w*, hotel→hotels?\w* etc.). Massive Token-Reduktion: -50% bis -80% Input pro Request.
- **Sonos Timeout** — Von 15s auf 30s erhöht. UPnP-Discovery + Stream-Setup brauchen bei langsamem Netzwerk mehr Zeit.
- **Sonos Discovery-Cache** — Von 5 Min auf 10 Min erhöht. Weniger Re-Discovery bei aufeinanderfolgenden Befehlen.
- **Media Skill-Filter** — Raumnamen (Halle, Küche, Wohnzimmer, Bad, Schlafzimmer) und "spiel*" als Keywords ergänzt. "Spiel Ö3 auf Halle" wird jetzt korrekt als media-Kategorie erkannt.
- **Travel-Skill Kategorie** — Von `'information'` auf `'productivity'` geändert. Die Reise-Keywords (flug, hotel, reise, barcelona) standen im productivity-Regex des Skill-Filters, aber der Skill hatte category `'information'` — wurde daher nie dem LLM angeboten.

### Changed
- **Flugsuche** — Kiwi-Provider komplett auf RapidAPI umgestellt (`kiwi-com-cheap-flights.p.rapidapi.com`). Nutzt jetzt denselben RapidAPI-Key wie Booking.com — kein separater `ALFRED_TRAVEL_KIWI_API_KEY` mehr nötig. City-Code-Mapping für 50+ Städte (Wien, Barcelona, Berlin etc.). One-Way und Round-Trip Suche.

### Fixed
- **Spotify Token-Rotation** — Spotify gibt bei jedem Token-Refresh einen neuen Refresh-Token zurück und revoked den alten. `refreshAccessToken()` speichert den neuen Token jetzt in DB + Memory. Vorher: Token nach erstem Refresh ungültig.
- **Spotify Restricted Device Hinweis** — Bei 403/restricted Fehlern wird jetzt ein klarer Hinweis gegeben: "Nutze den Sonos-Skill für Playback-Steuerung auf Sonos-Speakern." Statt generischem API-Fehler.
- **Spotify Token-Persistenz HA-definitiv** — `UserServiceResolver` wird direkt in den SpotifySkill injiziert (`setServiceResolver()`) statt aus SkillContext. Verfügbar auf ALLEN Nodes, nicht nur dem der `authorize()` ausgeführt hat. Resolver-Kaskade: injected → pending.context → lastContext → userServiceResolverRef.
- **Sonos Ö3 Stream** — Stream-URL korrigiert: `oe3shoutcast.sf.apa.at` (tot) → `orf-live.ors-shoutcast.at/oe3-q1a` (funktioniert). Alle ORF-Sender auf einheitliche `ors-shoutcast.at` Domain umgestellt. Alle 9 ORF-Landesradios hinzugefügt.
- **Sonos Radio** — TuneIn-Suche durch direkte Stream-URLs ersetzt (Ö3, Ö1, FM4, Kronehit, Radio Wien, Radio NÖ, Lounge FM, Klassik Radio). `playTuneinRadio()` war unzuverlässig — jetzt `setAVTransportURI()` mit bekannten Streams als Primary, TuneIn als Fallback.
- **Spotify + Sonos Abgrenzung** — Skill-Description informiert LLM dass Sonos-Speaker über Spotify Connect "restricted" sind. Playback-Start, Lautstärke und Transfer auf Sonos-Speakern müssen über den Sonos-Skill laufen, nicht über Spotify.

### Improved
- **Rezept-Skill** — Rezeptnamen, Zutaten und Zubereitungsschritte werden dynamisch in die Benutzersprache (aus Profil) übersetzt statt hardcoded Deutsch.

### Fixed
- **Sonos TuneIn Radio** — Erweiterte Sender-Mappings für "ORF Hitradio Ö3", "Hitradio Ö3", Kronehit, Radio NÖ etc. Input-Normalisierung (Umlaute, Präfixe).
- **Sonos TuneIn Radio** — UPnP 402 Fehler bei österreichischen Sendern (Ö3, Ö1, FM4). Automatisches Mapping auf TuneIn-kompatible Namen (z.B. "Ö3" → "Hitradio OE3", "OE3", "ORF Radio OE3") mit Fallback-Kette.
- **Sonos Favoriten** — `getFavorites()` Response-Parsing für verschiedene node-sonos Versionen und XML-Formate (items, Result, ContentDirectory).
- **Spotify OAuth HA-Problem** — Bei Active-Active HA landete der OAuth-Callback auf einem anderen Node als `authorize()`. Die `pendingAuths` (codeVerifier, userId) waren nur im Memory des einen Nodes. Fix: Alle Auth-Daten werden im `state`-Parameter an Spotify übergeben und kommen im Callback zurück — jeder Node kann den Exchange abschließen. Zusätzlich persistenter `userServiceResolverRef` als Fallback für Token-Speicherung.
- **Spotify Device-Discovery** — Sonos-Speaker über Spotify Connect haben `is_restricted: true` und erscheinen NICHT im `/me/player/devices` Endpoint. Neuer `getAllDevices()` Helper merged `/me/player/devices` mit dem aktiven Device aus `/me/player`. Sonos-Speaker werden jetzt korrekt erkannt und angesteuert.
- **Spotify OAuth Token-Persistenz** — Refresh-Token wurde bei Re-Autorisierung nicht in DB gespeichert weil der SkillContext aus dem pendingAuth fehlte. Jetzt wird der Context direkt im pendingAuth mitgespeichert. Fehler beim DB-Save werden nicht mehr verschluckt sondern propagiert.
- **Spotify Premium-Erkennung** — Fehlender OAuth-Scope `user-read-private` ergänzt. Ohne diesen Scope gab `/me` kein `product`-Feld zurück, weshalb Premium-Accounts fälschlich als Free erkannt wurden. **Erfordert erneute Spotify-Autorisierung** (neuer Scope muss genehmigt werden).

### Added
- **Spotify confirm_auth Action** — Manuelle Auth-Bestätigung für Self-signed Cert Umgebungen. Wenn der Spotify-Redirect wegen Self-signed Cert fehlschlägt, kann der User die Callback-URL aus der Browser-Adressleiste kopieren und an Alfred schicken. Alfred extrahiert den Auth-Code und vervollständigt die Verbindung.

### Fixed
- **Skill-Filter Keywords** — Rezept/Kochen, Spotify/Musik, Sonos/Speaker und Reise/Flug/Hotel Keywords in der Skill-Kategorie-Erkennung ergänzt. Ohne diese Keywords wurden die neuen Skills vom LLM nicht als Tools angeboten.
- **Booking.com API** — Fehlenden `filter_by_currency` Parameter ergänzt (422-Fehler bei Hotelsuche).
- **OAuth Redirect-URI** — Spotify/Sonos OAuth nutzt jetzt `ALFRED_API_PUBLIC_URL` statt hardcoded `localhost:3420`. Konfigurierbar über `.env` für remote-Installationen.
- **TLS Self-Signed Cert** — Auto-generiertes Zertifikat enthält jetzt die konfigurierte Host-IP und `publicUrl` im SAN (Subject Alternative Name). Altes Cert unter `~/.alfred/tls/` muss gelöscht werden damit es neu generiert wird.

## [0.19.0-multi-ha.116] - 2026-03-23

### Added
- **Reise-Skill** — Flugsuche (Kiwi/Tequila), Hotelsuche (Booking.com/RapidAPI), optional Mietwagen/Aktivitäten (Amadeus, nur mit Production-Key). Strukturierte Reisepläne in DB mit Budget-Tracking, Kalender-Integration und Pack-/Checklisten-Generierung. Provider-Pattern (erweiterbar). Watch-kompatibel (Preis-Alerts). ReasoningEngine-Integration für Reise-Insights. Migration v41 (travel_plans, travel_plan_items). Setup per Chat oder ENV.

## [0.19.0-multi-ha.115] - 2026-03-23

### Added
- **Sonos-Skill** — Sonos-Speaker im Netzwerk steuern via UPnP (node-sonos). Lokale Auto-Discovery als Primary, Sonos Cloud API als Fallback. Actions: Speaker-Liste, Playback (Play/Pause/Stop/Next/Previous), Lautstärke (einzeln + Gruppe), Gruppierung (group/ungroup/group_all), Radio/TuneIn, Sonos-Favoriten, Sleep-Timer, Nachtmodus, Speech Enhancement, Line-In/TV-Audio, Stereopaare, Queue-Verwaltung. S1+S2 Support. Spotify-Playback läuft über den Spotify-Skill (Spotify Connect). OAuth für Cloud-API per Chat.

## [0.19.0-multi-ha.114] - 2026-03-23

### Added
- **Spotify-Skill** — Playback-Steuerung (Play, Pause, Skip, Lautstärke, Shuffle, Repeat), Geräte-Wechsel (inkl. Sonos via Spotify Connect), Suche (Tracks, Alben, Artists, Playlists), Playlist-Verwaltung (erstellen, Tracks hinzufügen/entfernen), Queue-Management, Like/Unlike, Top-Tracks/Artists, Zuletzt gehört, Empfehlungen. OAuth2 PKCE Flow für sichere Autorisierung. Multi-Account Support mit per-User Konfiguration. Generischer OAuth-Callback Endpoint `/api/oauth/callback` in HTTP API (wiederverwendbar für zukünftige OAuth-Skills). Setup per Chat (`authorize`) oder ENV (`ALFRED_SPOTIFY_CLIENT_ID`, `ALFRED_SPOTIFY_CLIENT_SECRET`). Benötigt Spotify Premium für Playback-Steuerung, Suche/Playlists funktionieren auch mit Free.

## [0.19.0-multi-ha.113] - 2026-03-23

### Added
- **Rezepte/Kochen-Skill** — Rezeptsuche (Spoonacular + Edamam Fallback), Nährwert-Infos (Open Food Facts), Favoriten-Verwaltung, Wochenplan/Meal-Planning mit Kalender-Sync, Einkaufslisten-Generierung (LLM orchestriert über bestehende todo/microsoft_todo Skills). Diät-Preferences pro User (vegetarisch, Allergien etc.) als Default-Filter, jederzeit überschreibbar. Watch-kompatibel, ReasoningEngine-Integration für cross-domain Insights. Migration v40 (recipe_favorites, meal_plans). Setup per Chat (`setup_service`) oder ENV (`ALFRED_RECIPE_SPOONACULAR_API_KEY`, `ALFRED_RECIPE_EDAMAM_APP_ID`).

## [0.19.0-multi-ha.112] - 2026-03-23

### Added
- **Trading-Skill (CCXT)** — Crypto-Trading auf 110+ Exchanges (Binance, Kraken, Coinbase, Bitget etc.). Actions: `balance`, `price`, `buy`, `sell`, `limit_buy`, `limit_sell`, `orders`, `cancel`, `history`, `exchanges`. Sicherheitslimit `maxOrderEur` (Default 500€), Sandbox-Modus für Testnets, Admin-only. Setup-Integration mit dynamischen Exchange-Credentials. Watch-kompatibel für Preis-Alerts.

## [0.19.0-multi-ha.111] - 2026-03-23

### Fixed
- **Bitpanda Skill Cleanup** — Buy/Sell komplett entfernt (Personal API v1 hat kein Trading). riskLevel auf 'read' korrigiert. Schema-Ballast (amount, buy/sell enum) bereinigt. Gegen offizielle API-Referenz verifiziert.

## [0.19.0-multi-ha.108] - 2026-03-23

### Added
- **Bitpanda-Skill** — Portfolio, Fiat-Guthaben, Trade-Historie und Ticker-Preise via Bitpanda REST API. Actions: `portfolio` (alle Holdings mit aktuellem Wert), `balance` (Fiat-Wallets), `trades` (letzte Käufe/Verkäufe), `ticker` (aktuelle Preise ohne API-Key). Watch-kompatibel (data.totalValueEur, data.totalEur). Setup-Integration mit `ALFRED_BITPANDA_API_KEY`.

## [0.19.0-multi-ha.107] - 2026-03-23

### Added
- **Crypto-Preis-Skill** — Kryptowährungspreise und Marktdaten via CoinGecko API (kostenlos, kein API-Key nötig). Actions: `price` (aktueller Preis), `top` (Top N nach Marktkapitalisierung), `search` (Coin suchen), `history` (Preisverlauf). Watch-kompatibel für Preis-Alerts. 60s Cache für Rate-Limiting. Symbol-Aliase (btc→bitcoin, eth→ethereum etc.).

## [0.19.0-multi-ha.106] - 2026-03-23

### Fixed
- **Setup: Cluster-Config bei Re-Setup nicht verloren** — Bestehende Cluster-Werte (nodeId, token, redisUrl) werden als Defaults geladen. Vorher: Re-Setup überschrieb Cluster-Config wenn User "Nein" bei Cluster antwortete.
- **Setup: `primaryHost` Dead Code entfernt** — HA ist Active-Active ohne Primary. Die verwirrende "Primary-Host" Frage wurde entfernt, Setup fragt jetzt nur Redis URL + Token.

## [0.19.0-multi-ha.105] - 2026-03-23

### Fixed
- **Project Agent Stop-Signal bei HA** — Interjection-Inbox von In-Memory Map auf DB-Tabelle umgestellt (`project_agent_interjections`). Stop/Interject-Nachrichten erreichen den Agent jetzt auch wenn sie auf einem anderen Node empfangen werden. Migration v39 (SQLite + PG). Fallback auf In-Memory wenn kein Repo konfiguriert.

## [0.19.0-multi-ha.104] - 2026-03-22

### Fixed
- **Review-Fixes (7 Findings):**
  - WatchRepository.create() gab `threadId` nicht im Return-Objekt zurück
  - ScheduledActionRepository: `threadId` fehlte in CreateInput, INSERT und mapRow — Thread-Routing für Scheduled Actions war non-funktional
  - Email-Skill Race Condition: `mergedProviders` als Instance-State → bei gleichzeitigen Requests Provider-Cross-Contamination möglich. Fix: Execute-Lock serialisiert Zugriffe
  - Base64-Erkennung in write_store: Regex erforderte `=` Padding — ungepadded Base64 (exakte 3-Byte-Vielfache) wurde als UTF-8 gespeichert statt binär → stille Datenkorruption
  - gemini-3.1-flash fehlte in Pricing-Tabelle — Kosten wurden als $0 getrackt

## [0.19.0-multi-ha.103] - 2026-03-22

### Added
- **Memory Consolidator aktiviert** — Tägliches Housekeeping um 3:00 Uhr: löscht veraltete Low-Confidence Memories (>60 Tage, <0.5), merged ähnliche Memories per LLM (Jaccard-Similarity ≥50%).
- **Reasoning Engine Low-Risk Auto-Approve** — Low-Risk Skills (memory, reminder, note, todo, calculator) werden direkt ausgeführt statt in die Confirmation Queue gestellt. High-Risk Skills (homeassistant, email, shell etc.) erfordern weiterhin Bestätigung.

## [0.19.0-multi-ha.102] - 2026-03-22

### Added
- **Thread/Topic-Routing für Watches und Scheduled Actions** — Neuer `thread_id` Parameter bei Watch-Erstellung. Alerts werden in Telegram-Topics gesendet statt den Hauptchat zu fluten. Auch Scheduled Actions unterstützen `thread_id`. Migration v38 (SQLite + PG).

## [0.19.0-multi-ha.101] - 2026-03-22

### Added
- **Skill-Health Reset als User-Action** — `configure` Skill um `skill_health` (zeigt degradierte/disabled Skills) und `reset_skill` (reaktiviert disabled Skill) erweitert. Kein manueller DB-Zugriff mehr nötig.

## [0.19.0-multi-ha.100] - 2026-03-22

### Fixed
- **Browser-Skill wird vom LLM nicht verwendet** — Description suggerierte Fallback-Rolle ("Use when http skill returns empty"). Jetzt: "Use whenever the user asks to open/visit/browse a URL. Preferred over http skill." Skill-Filter: `brows\b` → `brows\w*` + `öffne`, `webseite`, `website`, `url` als Keywords.

## [0.19.0-multi-ha.99] - 2026-03-22

### Fixed
- **Document ingest PostgreSQL Null-Byte-Fehler** — `pdf-parse` liefert Text mit `\0` Bytes die PostgreSQL in TEXT-Spalten ablehnt (`invalid byte sequence for encoding "UTF8": 0x00`). Fix: Null-Bytes nach PDF-Extraktion entfernen.

## [0.19.0-multi-ha.98] - 2026-03-22

### Added
- **Document ingest aus FileStore** — Neuer `store_key` Parameter für `document ingest`. PDFs direkt aus S3 FileStore ingestieren ohne lokalen Dateipfad. Löst das Problem dass der Delegate FileStore-PDFs nicht lesen konnte (Security-Block auf `/root/` + kein RAG-Index nach Upload).

## [0.19.0-multi-ha.97] - 2026-03-21

### Fixed
- **write_store konnte keine lokalen Dateien hochladen** — `write_store` akzeptierte nur `content` als String. Binärdateien (PDFs etc.) wurden als Pfad-Text gespeichert (59 Bytes statt echte Datei). Jetzt: wenn kein `content` angegeben, wird `path` als lokale Datei gelesen und binär in S3 hochgeladen. Optional `destination` als S3-Key.

## [0.19.0-multi-ha.96] - 2026-03-21

### Fixed
- **Gemini Cache-Tokens nicht erfasst** — `cachedContentTokenCount` aus `usageMetadata` wurde ignoriert. Cached Input wurde zum vollen Preis berechnet statt zum Cache-Preis (90% Rabatt auf Gemini 2.5+).
- **Mistral Pricing veraltet** — Large $2.00→$0.50, Small $0.20→$0.10, Medium und Codestral neu. Alte Preise waren von Mistral Large 2407.

## [0.19.0-multi-ha.95] - 2026-03-21

### Fixed
- **OpenAI Prompt-Cache-Tokens nicht erfasst** — `prompt_tokens_details.cached_tokens` wurde ignoriert. Alle Input-Tokens wurden zum vollen Preis berechnet statt zum Cache-Preis. Betrifft `complete()` und `stream()`.
- **Embedding-Usage nicht getrackt** — Embedding-Aufrufe erzeugten keinen Cost-Record. Jetzt werden Token-Counts aus der API-Response gelesen und über den CostTracker erfasst. Embedding-Preise in Pricing-Tabelle ergänzt.

## [0.19.0-multi-ha.94] - 2026-03-21

### Fixed
- **LLM Pricing-Tabelle vollständig korrigiert** — Alle Provider gegen offizielle Preisseiten abgeglichen:
  - OpenAI: GPT-5.4 cacheRead $1.25→$0.25, GPT-5 $2.00/$8.00→$0.625/$5.00, GPT-4.1-mini/nano halbiert. GPT-5.4-mini/nano neu.
  - Anthropic: Opus 4.6/4.5 ($5/$25) vs Opus 4.0/4.1 ($15/$75) getrennt. Haiku 3.5 neu ($0.80/$4).
  - Gemini: Prefix `gemini-3.0-pro` → `gemini-3-pro`, `gemini-3.0-flash` → `gemini-3-flash`. Flash-Lite neu.

## [0.19.0-multi-ha.93] - 2026-03-21

### Fixed
- **Email read/reply/forward/draft/attachment "Unknown account"** — Handler für `read`, `reply`, `forward`, `draft`, `attachment` nutzten `activeProviders` statt `mergedProviders`. Admin-Accounts (z.B. "default") wurden nicht gefunden wenn per-user Providers aktiv waren.

## [0.19.0-multi-ha.92] - 2026-03-21

### Fixed
- **Kalender createEvent in falschem Kalender** — `createEvent()` war hardcoded auf `/me/events` statt `${this.userPath}/events`. Events im Shared-Kalender (z.B. fam@dohnal.co) landeten im Admin-Kalender. `listEvents`, `updateEvent`, `deleteEvent` waren korrekt.
- **Ganztags-Events Graph API 400** — End-Datum war gleich Start-Datum (Zero-Duration). Graph API erwartet exklusives End-Datum (Tag nach letztem Tag). Fix: End automatisch auf Start + 1 Tag setzen wenn End ≤ Start.

## [0.19.0-multi-ha.90] - 2026-03-21

### Fixed
- **LLM Context-Window-Größen vollständig aktualisiert** — Alle Provider geprüft und korrigiert:
  - Claude: Opus 4.6 (1M/128K), Sonnet 4.6 (1M/64K), Opus/Sonnet 4.5 (1M/64K), Haiku 4.5 (200K/64K)
  - OpenAI: GPT-4 Output 4K→8K, GPT-5.4-mini/nano hinzugefügt (400K/128K)
  - Mistral: Large/Small/Codestral auf 256K, Medium auf 131K, Magistral-Medium auf 40K
  - DeepSeek-R1 Output 8K→64K, Gemma3 Output 8K→128K, Phi4 Input 128K→16K

## [0.19.0-multi-ha.88] - 2026-03-21

### Added
- **document read Action** — Vollständigen Dokumentinhalt aus RAG-Chunks zurückgeben. `search` gibt nur Snippets, `read` gibt den ganzen Text.

### Fixed
- **Usage-Tracking Doppelzählung** — `setPersist` und Pipeline schrieben beide in `llm_usage`. Jetzt: `setPersist` → `llm_usage` (global), Pipeline → nur `llm_usage_by_user` (per-user).
- **Feed-Reader "All feeds failed"** — Ein kaputter Feed (XML-Fehler) ließ alle Feeds scheitern weil `results.length === 0` statt `successCount === 0` geprüft wurde.
- **MS Token-Refresh public vs. confidential** — Device Code Flow Tokens (public client) scheiterten beim Refresh mit `client_secret` (AADSTS700025). Fix: try mit Secret, bei public client Error retry ohne. Betrifft: Calendar, Email, Contacts, Todo.
- **Microsoft Todo Token-Refresh Scope** — Todo hatte noch den alten Scope (`Tasks.ReadWrite offline_access`) statt `openid offline_access`.

## [0.19.0-multi-ha.83] - 2026-03-20

### Added
- **Multi-Account Calendar, Contacts, Todo** — Wie Email-Skill: Map-basierte Provider-Architektur. Eigener Account + freigegebene Ressourcen gleichzeitig nutzbar. `list_accounts` Action, `account` Parameter pro Abfrage.
- **add_shared_resource Action** — Freigegebene MS 365 Ressourcen (Kalender, Postfach, Kontakte, Todo) als zusätzlichen Account hinzufügen. Nutzt bestehende Credentials, fügt `sharedCalendar`/`sharedMailbox`/`sharedUser` hinzu.
- **/stop Befehl** — Laufende Anfragen per Chat abbrechen. AbortController pro chatId:userId.
- **Thinking-Status sofort** — `onProgress('Thinking...')` am Anfang von `process()` statt nach der ganzen Vorarbeit.

### Fixed
- **MS Token-Refresh** — Nur `openid offline_access` beim Refresh anfordern. Microsoft gibt Token mit Original-Scopes zurück. Vorher: Refresh mit `.Shared` Scopes scheiterte wenn Original-Token diese nicht hatte.
- **Admin behält globale Provider** — Per-user Services (shared Kalender) überschrieben globale Provider. Jetzt Merge: global + per-user. `mergedProviders` für alle Actions, nicht nur `list_accounts`.
- **Calendar per-user Provider Fehler** — Fehler werden geloggt statt still verschluckt.
- **Device Code Flow** — `timeoutMs: 900_000` (15 Min) für User-Management Skill. Code wird sofort via `onProgress` gesendet, nicht erst nach Polling. Token-Polling mit detaillierter `error_description`.
- **Skill-Filter Einkaufsliste** — `einkaufsliste`, `einkauf`, `shopping`, `liste` als productivity Keywords.
- **Skill-Filter Routing** — `route`, `routing`, `fahrzeit`, `anfahrt`, `heimfahrt`, `navigation`, `navi` als information Keywords. Routing-Skill wurde bei Fahrzeit-Anfragen nicht geladen.
- **always_gt/lt/gte/lte Watch-Operatoren** — Triggern bei JEDEM Check wenn Bedingung erfüllt, ohne State-Change-Detection. Für Feeds mit vielen Quellen wo `gt` nur einmal beim Übergang feuerte.

## [0.19.0-multi-ha.69] - 2026-03-20

### Fixed
- **Skill-Filter Einkaufsliste** — `einkaufsliste`, `einkauf`, `shopping`, `liste` als productivity Keywords. Ohne diese wurden Todo-Skills bei "Einkaufsliste" nicht geladen. Betrifft nur Kategorie-Auswahl, nicht Tool-Wahl.

## [0.19.0-multi-ha.68] - 2026-03-20

### Added
- **/stop Befehl** — Laufende Anfragen per Chat abbrechen. AbortController pro chatId:userId (Gruppen-Chat safe). Abort-Check vor jedem LLM-Call und Tool-Ausführung. Dummy-Antwort bei Abbruch verhindert Conversation-Corruption.
- **send_to_self Action** — Dateien/Nachrichten an sich selbst auf anderer Plattform senden ohne Username.
- **Alfred-Username im User-Profil** — LLM kennt eigenen Username für Self-Send.

### Fixed
- **auth_microsoft tenantId** — Device Code Flow nutzte hardcoded `common` statt Admin-tenantId aus Config. Scheiterte mit AADSTS50059 bei Single-Tenant Apps. Optional: User kann eigenen tenant_id angeben.
- **Feed-Alerts ohne Links** — LLM (fast tier) ließ Links bei RSS-Alerts weg. Fix: statisches Format für Feeds (deterministisch, immer mit Links, kein LLM-Call). LLM nur noch für komplexe Alerts (Marketplace Filtering).
- **send_to_user Matrix Room-ID** — Matrix braucht Room-ID, nicht User-ID. Conversation-DB Lookup + chatId-Format Parsing. sendDirectMessage für User-IDs.
- **send_to_user Self-Send** — Erkennt Alfred-Username, Display-Name, Self-Keywords (ich/mir/me). username optional bei Self-Send.
- **Skill-Filter Plattform-Keywords** — matrix, telegram, whatsapp, discord, signal als identity Keywords.
- **platform Parameter** — Description inkludiert jetzt send_to_user, LLM übergibt den Parameter.

## [0.19.0-multi-ha.65] - 2026-03-20

### Added
- **send_to_user / send_to_self** — Nachrichten und Dateien an andere Personen oder sich selbst auf einer anderen Plattform senden. Unterstützt Telegram, Matrix, Discord, WhatsApp, Signal. Empfänger per Alfred-Username, Display-Name oder chatId. Dateien aus FileStore (S3) als Attachment. Rate-Limiting (10/min).
- **Alfred-Username im User-Profil** — LLM kennt den eigenen Alfred-Username für Self-Send Auflösung.

### Fixed
- **Matrix Room-ID Auflösung** — Matrix braucht Room-ID (`!xxx:server`), nicht User-ID (`@user:server`). Conversation-DB wird genutzt um Room-ID aufzulösen. chatId-Format `!roomId:server:@user:server` wird korrekt auf Room-ID getrimmt.
- **Matrix sendDirectMessage** — `sendFile` und `sendMessage` nutzen `sendDirectMessage` wenn Ziel eine User-ID ist (erstellt/findet DM-Room automatisch).
- **Self-Send Erkennung** — Erkennt Alfred-Username, Display-Name, Platform-Username und Self-Keywords (ich/mir/me/self). `send_to_self` Action braucht keinen Username.
- **Skill-Filter Plattform-Keywords** — `matrix`, `telegram`, `whatsapp`, `discord`, `signal` als identity Keywords. `schick mir X auf Matrix` wurde nicht als identity erkannt.
- **platform Parameter Description** — LLM ignorierte `platform` bei `send_to_user` weil Description nur "for send_message or unlink" sagte.

## [0.19.0-multi-ha.52] - 2026-03-20

### Added
- **send_to_user** — Nachrichten und Dateien an andere Personen senden über jede Plattform (Telegram, Matrix, Discord, WhatsApp, Signal). Empfänger per Alfred-Username oder chatId. Dateien aus FileStore (S3) als Attachment. Rate-Limiting (10/min).

## [0.19.0-multi-ha.51] - 2026-03-20

### Added
- **Web-UI Auth-Gate** — Login-Bildschirm wenn `api.token` konfiguriert ist. Ohne gültigen Einmal-Code kein Zugriff auf Chat, Dashboard oder Settings. Neuer Endpunkt `/api/auth/required` für Frontend-Check.

### Fixed
- **Web-Sicherheit** — `/api/metrics` und `/api/auth/me` waren ohne Auth zugänglich. Jetzt hinter `checkAuth`.
- **Device Code Flow Scopes** — `.Shared` Scopes (Mail, Calendar, Contacts) hinzugefügt für Zugriff auf freigegebene Ressourcen.

## [0.19.0-multi-ha.50] - 2026-03-19

### Fixed
- **Device Code Flow Scopes** — `.Shared` Scopes für freigegebene Postfächer/Kalender/Kontakte.

## [0.19.0-multi-ha.49] - 2026-03-19

### Added
- **Microsoft 365 Device Code Flow** — `auth_microsoft` Action: User sagt "verbinde mein Microsoft Konto" → bekommt Code + URL → meldet sich im Browser an → Email, Kalender, Kontakte, Todo werden automatisch konfiguriert. Funktioniert für gleichen und verschiedenen Tenant (`common`). Azure App Credentials kommen aus der Admin-Config, jeder User bekommt seinen eigenen refreshToken.

## [0.19.0-multi-ha.48] - 2026-03-19

### Fixed
- **MS 365 Shared Resources — Admin-Account-Schutz** — `share_service` für Microsoft 365 erfordert jetzt `shared_resource` (Email des freigegebenen Postfachs/Kalenders). Ohne shared_resource wird das Sharing verweigert → Admin-Account kann nicht versehentlich freigegeben werden. Config wird mit `sharedMailbox`/`sharedCalendar`/`sharedUser` angereichert → User greift auf `/users/{shared-email}` zu, nie auf `/me`.

## [0.19.0-multi-ha.47] - 2026-03-19

### Fixed
- **Email Account-Info Leak** — Skill-Description listete Admin-Account-Namen (outlook, gmail) auf, sichtbar für alle User. Entfernt. Neue `list_accounts` Action zeigt nur die für den jeweiligen User verfügbaren Accounts.

## [0.19.0-multi-ha.46] - 2026-03-19

### Fixed
- **Skill-Filter Identity-Keywords** — "einrichten", "konfigurieren", "Postfach", "verbinde", "richte...ein" fehlten → `setup_service` wurde bei Email-Setup Anfragen nicht geladen.

## [0.19.0-multi-ha.45] - 2026-03-19

### Fixed
- **PostgreSQL ON CONFLICT ambiguous column** — `ON CONFLICT DO UPDATE SET calls = calls + excluded.calls` ist auf PostgreSQL mehrdeutig. LLM-Usage und Skill-Health wurden nie auf PG geschrieben (Fehler still verschluckt). Fix: qualifizierte Spaltennamen (`llm_usage.calls`, `skill_health.fail_count`).

## [0.19.0-multi-ha.44] - 2026-03-19

### Added
- **Email-Provider-Templates** — `setup_service` für Email: bekannte Provider (GMX, Gmail, Yahoo, Outlook, iCloud, web.de, posteo, mailbox.org, aon, a1, hotmail) werden automatisch konfiguriert. Nur email + password nötig.

## [0.19.0-multi-ha.43] - 2026-03-19

### Fixed
- **Multi-User Isolation** — Email, Kalender, Kontakte, BMW, Microsoft Todo: Nicht-Admin User bekamen Zugriff auf Admin-Daten (Fallback auf globale Provider aus .env). Geschlossen.

## [0.19.0-multi-ha.42] - 2026-03-19

### Fixed
- **Skill-Filter Identity-Keywords** — `user_management` Skill wurde bei User-Management Anfragen nicht geladen. Keywords `user`, `benutzer`, `rolle`, `invite`, `connect` etc. fehlten.

## [0.19.0-multi-ha.41] - 2026-03-19

### Fixed
- **MS Graph Reply + Attachments** — Reply-Endpoint ignorierte Attachments. Fix: Draft→Attach→Send.
- **Fehlende awaits** — `recordFailure()`/`recordSuccess()` in watch-engine und workflow-runner ohne await.
- **Skill-Filter** — `code_sandbox` (Kategorie `automation`) wurde bei PDF-Anfragen gefiltert. Fix: `files` inkludiert jetzt `automation`.

## [0.19.0-multi-ha.40] - 2026-03-19

### Fixed
- **Rollen-Zugriffe** — `user` Rolle fehlten `file`, `code_sandbox`, `document`, `scheduled_task`, `microsoft_todo`, `sharing`, `background_task`. `family` fehlten `file`, `document`, `scheduled_task`.

## [0.19.0-multi-ha.39] - 2026-03-19

### Fixed
- **code_sandbox Kategorie** — War `automation`, wurde bei PDF/DOCX-Anfragen (Kategorie `files`) aus der Tool-Liste gefiltert. LLM sagte "nicht verfügbar". Fix: Kategorie auf `files`.

## [0.19.0-multi-ha.38] - 2026-03-19

### Added
- **FileStore-Integration** — File-Skill: `read_store`, `write_store`, `list_store`, `delete_store` Actions für S3/NFS-Zugriff. `send` erkennt S3-Keys automatisch.
- **Code Sandbox → S3** — Generierte Dateien werden auf S3 gespeichert. Response enthält `fileStoreKeys`.
- **Email-Attachments** — `attachmentKeys` Parameter für send/draft/reply. Standard-IMAP (nodemailer) und Microsoft Graph.
- **System-Prompt** — File-Upload-Kontext, FileStore-Keys, Email-Attachment-Flow dokumentiert.

## [0.19.0-multi-ha.37] - 2026-03-19

### Added
- **SkillContext.fileStore** — FileStore-Interface im SkillContext für S3/NFS-Zugriff aus Skills.
- **File Skill Store-Actions** — `read_store`, `list_store`, `delete_store`. `send` erkennt S3-Keys automatisch.
- **Pipeline FileStore-aware** — `[Saved to FileStore (s3): key="..."]` statt rohem S3-Key. Duplikat-Löschung via `fileStore.delete()`.

## [0.19.0-multi-ha.36] - 2026-03-19

### Added
- **Dependencies** — `pdfkit`, `docx` als Dependencies für PDF/Word-Erzeugung im code_sandbox.
- **code_sandbox Skill-Description** — docx für Word-DOCX Erzeugung dokumentiert.

## [0.19.0-multi-ha.35] - 2026-03-18

### Fixed
- **System-Prompt File-Upload** — LLM wusste nicht dass `[File received]` und `[Saved to]` bedeuten dass die Datei bereits gespeichert ist. Fragte stattdessen nach Dateipfad.

## [0.19.0-multi-ha.34] - 2026-03-18

### Added
- **puppeteer-core** als optionalDependency für Browser-Skill Fallback.

## [0.19.0-multi-ha.33] - 2026-03-18

### Fixed
- **Watch-Engine/Background-Tasks — fehlendes await** — `skillHealthTracker.isDisabled()` ohne `await` → `if (promise)` immer truthy → alle Watches/Tasks als disabled übersprungen.
- **S3 FileStore — fehlende Dependency** — `@aws-sdk/client-s3` fehlte in Dependencies. File-Uploads auf S3 schlugen fehl.

## [0.19.0-multi-ha.32] - 2026-03-18

### Fixed
- **BackgroundTaskRunner — fehlendes await** bei `isDisabled()`. Gleicher Bug wie Watch-Engine.

## [0.19.0-multi-ha.31] - 2026-03-18

### Fixed
- **Watch-Engine — fehlendes await bei isDisabled()** — Root-Cause für Watch-Skills die nie ausgeführt wurden. `if (promise)` ist immer truthy → jede Watch wurde als disabled übersprungen.

## [0.19.0-multi-ha.30] - 2026-03-18

### Fixed
- **Feed-Reader — Fehler sichtbar machen** — `catch {}` in check_all schluckte alle Fehler still. Jetzt werden Fehler gesammelt und als `success: false` zurückgegeben.

## [0.19.0-multi-ha.29] - 2026-03-18

### Fixed
- **Watch Poll-Error Reporting** — Skill-Fehler beim Watch-Poll werden in `last_action_error` geschrieben statt nur ins Log.

## [0.19.0-multi-ha.28] - 2026-03-18

### Fixed
- **Feed-Reader — createRequire mit realpathSync** — `/usr/bin/alfred` Symlink wurde von `createRequire` nicht aufgelöst. `realpathSync` löst den Symlink → `node_modules` wird gefunden.

## [0.19.0-multi-ha.27] - 2026-03-18

### Fixed
- **Feed-Reader — createRequire mit process.argv[1]** — `import.meta.url` im Bundle resolvet falsch. `process.argv[1]` ist der tatsächliche Entry-Point.

## [0.19.0-multi-ha.26] - 2026-03-18

### Fixed
- **Feed-Reader — rss-parser Import-Fallback** — `await import('rss-parser')` scheitert im ESM-Bundle. Fix: `createRequire`-Fallback wenn ESM-Import fehlschlägt.

## [0.19.0-multi-ha.25] - 2026-03-18

### Added
- **Migration v37** — `user_id` Spalte in watches Tabelle (SQLite + PostgreSQL).

### Fixed
- **Watch Owner-Kontext** — Watch-Engine nutzte `chatId` als User-ID für Skill-Kontext. In Gruppen-Chats falsche User-Auflösung. Fix: `user_id` in Watch gespeichert, Watch-Engine nutzt es.
- **JSON.stringify(undefined)** — Watch `last_value` wurde `undefined` statt String. Fix: Fallback auf `"null"`.


## [0.19.0-multi-ha.4] - 2026-03-17

### Fixed
- **ENV-Overrides für Cluster/API** — `ALFRED_CLUSTER_ENABLED`, `ALFRED_CLUSTER_NODE_ID`, `ALFRED_CLUSTER_REDIS_URL`, `ALFRED_API_PORT`, `ALFRED_API_HOST`, `ALFRED_API_TOKEN` fehlten im Config Loader. Cluster-Modus konnte nicht per ENV aktiviert werden.
- **Numerische ENV-Werte** — `coerceEnvValue` konvertiert numerische Strings (`"3420"`) zu Numbers. Behebt `ALFRED_API_PORT` als String statt Number.

## [0.19.0-multi-ha.3] - 2026-03-17

### Fixed
- **AdapterClaimManager** — Auf Class-Field gespeichert, `stop()` bei Shutdown (Claims werden freigegeben)
- **ClusterConfig.role** — Optional in Zod Schema (Active-Active braucht keine Rolle)
- **Dead Code** — Redis-Failover-Monitoring durch Node-Status-Logging ersetzt
- **Message-Dedup** — Fallback-Key wenn `message.id` fehlt (`chatId:userId:timestamp`)
- **Redis-Ausfall** — Explizite Warnung im Log statt stille Degradierung
- **PG Heartbeat** — Migration läuft vor erstem Heartbeat (Tabellen existieren beim INSERT)
- **UDP Discovery** — Role-Check entfernt (jeder Node broadcastet)
- **processed_messages Cleanup** — Bei Startup verdrahtet

## [0.19.0-multi-ha.2] - 2026-03-16

### Added
- **HA Active-Active** — Split-Brain-sicheres Design. Atomare DB-Claims via `FOR UPDATE SKIP LOCKED` statt Redis-Locks. Skalierbar auf N Nodes.
- **Adapter-Claims** — Messaging-Adapter (Telegram, Discord, Matrix, Signal) werden via DB-Tabelle von genau einem Node betrieben. Automatisches Failover bei Node-Ausfall.
- **Message-Dedup** — `processed_messages` Tabelle verhindert doppelte Nachrichtenverarbeitung bei HA.
- **PG Migrator** — Inkrementelles Migrationssystem für PostgreSQL (`PgMigrator`, `PG_MIGRATIONS`). Migration v36: HA-Tabellen + Claim-Spalten.
- **PG Heartbeat** — Fallback Heartbeat via PostgreSQL `node_heartbeats` Tabelle wenn Redis nicht verfügbar.
- **nodeId in SkillContext** — Node-lokale Skills (shell, file, docker, etc.) annotieren Responses mit `[nodeId]` bei HA.

### Fixed
- **BMW Token-Isolation** — Tokens werden in DB gespeichert (HA-sicher), Datei als Fallback für Single-Instance.
- **ConfigureSkill HA-Warnung** — Warnung dass `.env`-Änderungen nur lokal gelten bei HA-Modus.
- **FileStore User-Isolation** — `read(key, requestingUserId)` prüft User-Prefix im Key.
- **HA Validierung** — `cluster.enabled` ohne PostgreSQL → Fehler. Ohne S3/NFS FileStore → Warnung.
- **Redis-Locks entfernt** — Alle Scheduler (Reminder, Proactive, Watch, Reasoning) nutzen ausschließlich DB-Claims.
- **Active-Active Architektur** — Kein Primary/Secondary mehr. `ClusterConfig.role` deprecated.

## [0.19.0-multi-ha.1] - 2026-03-16

### Added
- **Multi-User** — Rollen (admin/user/family/guest/service), Invite-Codes, Plattform-Verknüpfung, rollenbasierte Skill-Filter
- **Per-User Service Config** — Email, Kalender, Contacts, BMW, Microsoft Todo pro User konfigurierbar per Chat (`setup_service`, `my_services`, `remove_service`)
- **MS 365 Shared Resources** — Geteilte Postfächer, Kalender, Kontakte, Todos über Graph API Delegated Access (`sharedMailbox`, `sharedCalendar` Config)
- **Sharing** — Notizen, Todo-Listen, Dokumente und Service-Configs zwischen Usern teilen
- **PostgreSQL Backend** — Optionales Storage-Backend für HA. AsyncDbAdapter für SQLite und PostgreSQL. `alfred migrate-db` Migrationstool
- **HA Cluster** — Redis Distributed Locks für Reminder, Scheduler, Watch Engine, Reasoning Engine. Heartbeat, Failover Detection, Cross-Node Messaging
- **File Storage Abstraction** — Local/NFS/S3 Backend für Uploads und Dokumente. FileStore verdrahtet in Pipeline und DocumentProcessor
- **DM-Redirect** — Gruppen-Privacy für alle Plattformen: Telegram, Discord (`createDM()`), Matrix (DM-Room), Signal
- **HelpSkill** — Interaktive Hilfe: `overview` (alle Skills nach Kategorie), `detail` (Parameter-Info), `search` (Stichwortsuche). Rollenbasiert gefiltert
- **Web Sessions persistent** — Login-Tokens in Datenbank statt In-Memory Map, überlebt Restart
- **Setup Wizard** — Storage-Backend (SQLite/PostgreSQL), File Store (Local/NFS/S3) Konfiguration

### Fixed
- **User-Isolation** — Vollständige Datentrennung: Notizen, Todos, Memories, Conversations, Dokumente, Embeddings pro User isoliert
- **PG Schema** — 16 Tabellen korrigiert, 40+ fehlende Indexes ergänzt, Spalten an SQLite-Migrationen angeglichen
- **SQLite Transaction** — Manual BEGIN/COMMIT statt broken async better-sqlite3 Transaction
- **PG Transaction** — PostgresClientAdapter bindet alle Queries an den Transaction-Client (Atomizität)
- **Security** — Ownership-Checks für WatchSkill (toggle/delete), ProjectAgentSkill (interject/stop), BMWSkill Token-Isolation per User
- **DocumentProcessor** — Akzeptiert Buffer für S3-Kompatibilität (kein lokaler Dateizugriff nötig)
- **datetime('now')** — Alle DB-Zeitvergleiche nutzen JS-Timestamps statt SQLite/PG-spezifische Funktionen

## [0.18.2] - 2026-03-16

### Fixed
- **Database Skill: Intelligenterer CSV-Schwellwert** — CSV ab >20 Zeilen oder >8 Spalten (vorher: >10/>6). Kleinere Ergebnisse wie 18 Zeilen × 5 Spalten bleiben als Markdown-Tabelle im Chat
- **Database Skill: Format-Parameter** — `format: "table"` erzwingt Markdown, `format: "csv"` erzwingt CSV, `format: "auto"` (Default) entscheidet automatisch
- **Database Skill: LLM-Weiterverarbeitung** — `data.rows` wird auf maximal 20 Zeilen gekürzt um Pipeline-Truncation zu vermeiden. Vollständige Daten nur in der CSV-Datei

## [0.18.1] - 2026-03-15

### Added
- **Database Skill: CSV-Export** — Query-Ergebnisse mit >10 Zeilen oder >6 Spalten werden automatisch als CSV-Datei angehängt. Chat zeigt Zusammenfassung + 3-Zeilen-Vorschau. Kleine Ergebnisse bleiben als Markdown-Tabelle

## [0.18.0] - 2026-03-15

### Added
- **Database Skill** — Neuer Skill `database` für Multi-DB-Zugriff. Unterstützt PostgreSQL, MySQL/MariaDB, MS SQL, MongoDB, InfluxDB, SQLite, Redis. Aktionen: `connect` (per Chat konfigurieren), `disconnect`, `list`, `schema` (Tabellen/Collections), `describe` (Spalten), `query` (SQL/Flux/MQL/Redis), `test`. Verbindungen persistent in DB gespeichert. Read-Only Default, Row-Limit (100), Query-Timeout (30s). Watch-kompatibel (`query → rowCount`). DB Migration v30

## [0.17.7] - 2026-03-15

### Fixed
- **Dashboard: Kosten-Balkendiagramm** — Balken nutzen absolute Pixelhöhen statt CSS-Prozent (funktioniert nicht zuverlässig in Flex-Containern). Minimum 4px Höhe für sichtbare Balken

## [0.17.6] - 2026-03-15

### Added
- **Dashboard: Messaging-Adapter** — Zeigt alle verbundenen Adapter (Telegram, Matrix, API) mit Online/Offline-Status und farbigen Indikatoren
- **Dashboard: LLM Provider** — Zeigt alle konfigurierten Model-Tiers (default, strong, fast, embeddings) mit Model-Name und Verfügbarkeit

## [0.17.5] - 2026-03-15

### Added
- **Dashboard: Offene Reminder** — Zeigt alle ausstehenden Erinnerungen mit Fälligkeitsdatum, Nachricht und Plattform. Überfällige Reminder werden rot markiert
- **Setup: API Host + Token** — Frage ob API remote erreichbar sein soll (0.0.0.0 vs localhost). Bei Remote: TLS-Frage (Default Y) und optionaler API Token. Config enthält jetzt korrekte Host/Token-Werte

## [0.17.4] - 2026-03-15

### Fixed
- **TLS: ESM-Kompatibilität** — `resolveTls()` nutzt `await import('node:crypto')` und `await import('node:child_process')` statt `require()` (nicht verfügbar in ESM-Bundles). Self-signed Cert-Generierung funktioniert jetzt. Zusätzlich `execFileSync` Array-Form statt Shell-String für openssl-Aufruf

## [0.17.3] - 2026-03-15

### Fixed
- **YouTube Skill: Transkript-Import** — `youtube-transcript` Package hat kaputtes Export-Mapping (`"main"` zeigt auf CJS, aber `"type": "module"`). Fix: direkter Import von `dist/youtube-transcript.esm.js`. Transkript-Extraktion funktioniert jetzt

## [0.17.2] - 2026-03-15

### Fixed
- **YouTube Skill: Channel-Handle-Auflösung** — `@Handle` wird jetzt über die YouTube Channels API (`forHandle`) aufgelöst statt nur über Search. Channel-URLs (`youtube.com/@name`) werden korrekt erkannt
- **YouTube Skill: Channel-URL bei info/transcript** — Wenn eine Channel-URL statt einer Video-URL übergeben wird, leitet der Skill automatisch zur `channel` Aktion weiter statt einen Fehler zu werfen
- **YouTube Skill: Bessere Fehlermeldungen** — Klarere Fehlertexte mit Hinweis auf erwartetes Format

## [0.17.1] - 2026-03-15

### Added
- **YouTube Skill: Setup-Wizard** — Frage im Wizard mit Anleitung (Google Cloud Console → YouTube Data API v3), optionaler Supadata Key
- **YouTube Skill: README Doku** — Eigene Sektion mit Beispielen, Config, ENV-Variablen

## [0.17.0] - 2026-03-15

### Added
- **YouTube Skill** — Neuer Skill `youtube` mit 4 Aktionen: `search` (YouTube-Suche), `info` (Video-Details mit Views/Likes/Dauer), `transcript` (Transkript-Extraktion mit Timestamps), `channel` (Letzte Videos eines Channels). Self-hosted Transkripte via `youtube-transcript` npm (kostenlos, kein API-Key). Supadata als optionaler Fallback. Watch-kompatibel (`channel → newCount`). Skill-Filter: YouTube/Video/Transkript Keywords für `information` Category

## [0.16.7] - 2026-03-15

### Added
- **TLS/HTTPS Support** — HTTP API kann verschlüsselt laufen. Selbstsigniertes Zertifikat wird automatisch generiert (`~/.alfred/tls/`), eigenes Cert über `api.tls.cert` + `api.tls.key` konfigurierbar. Setup-Wizard fragt TLS-Aktivierung ab

## [0.16.6] - 2026-03-15

### Fixed
- **Web Chat: Status/Response Trennung** — Status-Nachrichten ("Thinking...") werden für die API-Platform als `status` SSE Event gesendet (nicht `response`). Verhindert dass Status-Text in der Antwort erscheint

## [0.16.5] - 2026-03-15

### Fixed
- **Web Chat: crypto.randomUUID Fehler** — `crypto.randomUUID()` ist in HTTP-Kontexten (ohne TLS) nicht verfügbar. Ersetzt durch `Math.random()` + `Date.now()` basierte ID-Generierung

## [0.16.4] - 2026-03-15

### Added
- **Web Chat: Persistenter User** — userId und chatId werden in localStorage gespeichert (einmalig generiert). Konversationshistorie bleibt über Seitenaufrufe erhalten. Cross-Platform-Verlinkung mit Telegram/Matrix via "Link my account" Befehl möglich

## [0.16.3] - 2026-03-15

### Fixed
- **HTTP API SSE: Stream sofort gelöscht** — `req.on('close')` feuert nach dem Request-Body-Read, nicht bei Client-Disconnect. Stream wurde sofort gelöscht bevor die Response geschrieben werden konnte. Fix: `res.on('close')` statt `req.on('close')`. Behebt den Web Chat der keine Antworten zeigte

## [0.16.2] - 2026-03-15

### Added
- **Dashboard: LLM Kosten & Token-Verbrauch** — Neue Sektion mit Kosten heute/Woche/All-Time, Token-Verbrauch (Input/Output), 7-Tage-Kosten-Balkendiagramm, Kosten-Aufschlüsselung pro Model. Uptime-Anzeige und Adapter-Status im Header
- **Dashboard API: Usage-Daten** — `GET /api/dashboard` liefert jetzt `usage` (today, week, total), `uptime`, `startedAt`, `adapters`

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
