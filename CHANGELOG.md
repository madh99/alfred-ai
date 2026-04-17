# Changelog

Alle relevanten Änderungen an Alfred werden in dieser Datei dokumentiert.
Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [Unreleased]

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
