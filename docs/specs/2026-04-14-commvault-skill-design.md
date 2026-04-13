# Commvault Backup Management Skill — Design Spec

## Überblick

Neuer Skill `commvault` (category: `infrastructure`) der die Commvault CommServe REST API v2 (`/api/v2/`) anspricht. Drei Ebenen: operativ (Job-Monitoring, Fehleranalyse, Restores), strategisch (Kapazitätsplanung, Compliance, SLA-Reports), proaktiv (Reasoning-Integration, Anomalie-Erkennung, ITSM-Incidents).

Default: voll operativ — Alfred kann eigenständig Jobs starten/stoppen, Restores auslösen, fehlgeschlagene Jobs neu starten. Konfigurierbar: `confirmation_mode: true` → alle Schreibaktionen über Confirmation Queue (HIGH_RISK).

## Actions

| Action | Beschreibung | R/W | Parameter |
|--------|-------------|-----|-----------|
| `status` | Gesamtstatus: fehlgeschlagene Jobs, Alerts, Storage-Auslastung | R | — |
| `jobs` | Jobs auflisten/filtern | R | `status?` (failed/running/completed), `client?`, `hours?` (default 24) |
| `job_detail` | Einzelnen Job im Detail (Dauer, Größe, Fehler, Logs) | R | `job_id` |
| `clients` | Alle Clients mit letztem Backup-Status | R | `filter?` (name pattern) |
| `client_detail` | Client-Details: Subclients, Schedules, letzte Jobs, Recovery Points | R | `client` (Name oder ID) |
| `storage` | Storage Pools/Libraries: Kapazität, Wachstum, Prognose | R | — |
| `alerts` | Aktive Alerts/Warnungen | R | `severity?` (critical/warning/info) |
| `report` | Compliance/SLA-Report: Erfolgsrate, RPO/RTO, Trends | R | `period?` (day/week/month, default week) |
| `analyze` | LLM-basierte Analyse: Fehlerursachen, Muster, Optimierungsvorschläge | R | `focus?` (failures/storage/schedules/all) |
| `start_job` | Backup-Job manuell starten | W | `client`, `subclient?`, `level?` (full/incremental/differential) |
| `stop_job` | Laufenden Job stoppen | W | `job_id` |
| `retry_job` | Fehlgeschlagenen Job erneut starten | W | `job_id` |
| `restore` | Restore auslösen | W | `client`, `point_in_time?`, `destination?`, `overwrite?` |
| `modify_schedule` | Backup-Schedule ändern | W | `client`, `schedule_name`, `frequency?`, `window?`, `retention?` |
| `configure` | Skill-Config ändern | W | `confirmation_mode?`, `polling_interval?`, `auto_retry_failed?`, `auto_incident?` |

## Authentifizierung

Zwei Methoden, konfigurierbar:

### API Token (bevorzugt)
```
POST /api/v2/Auth/Token
Header: Authorization: Bearer {apiToken}
```

### Username/Password (Fallback)
```
POST /api/v2/Login
Body: { "username": "...", "password": "..." }
Response: { "token": "...", "expiry": ... }
```

Token wird gecacht und bei Ablauf automatisch erneuert.

## API-Endpunkte (Commvault REST API v2)

| Action | Endpoint | Method |
|--------|----------|--------|
| Jobs | `/api/v2/Job?completedJobLookupTime={hours}` | GET |
| Job Detail | `/api/v2/Job/{jobId}` | GET |
| Job Logs | `/api/v2/Job/{jobId}/Details` | GET |
| Clients | `/api/v2/Client` | GET |
| Client Detail | `/api/v2/Client/{clientId}` | GET |
| Subclients | `/api/v2/Subclient?clientId={clientId}` | GET |
| Storage Pools | `/api/v2/StoragePool` | GET |
| Media Agents | `/api/v2/MediaAgent` | GET |
| Alerts | `/api/v2/AlertRule` | GET |
| Schedule Policies | `/api/v2/SchedulePolicy` | GET |
| Start Backup | `/api/v2/Subclient/{subclientId}/action/backup` | POST |
| Kill Job | `/api/v2/Job/{jobId}/action/kill` | POST |
| Restore | `/api/v2/CreateTask` (restore task) | POST |
| SLA Report | `/api/v2/Reports/SLA` | GET |
| Storage Summary | `/api/v2/StoragePool/{poolId}/StorageSummary` | GET |

## Reasoning-Integration

### Context Collector Source
Neue Source im `reasoning-context-collector.ts`:
- Key: `commvault`
- Label: `Commvault Backup`
- Priority: 2
- MaxTokens: 200
- Inhalt: fehlgeschlagene Jobs (24h), kritische Alerts, Storage >85%, SLA-Verletzungen
- Nur wenn `commvault.enabled`

### Proaktive Aktionen
Das Reasoning kann vorschlagen:
- `retry_job` bei fehlgeschlagenen Jobs
- `start_job` wenn SLA-RPO gefährdet
- Reminder erstellen wenn manueller Eingriff nötig
- ITSM-Incident bei wiederholten Fehlern

### ITSM-Integration
Wenn `auto_incident: true` und ITSM-Skill aktiv:
- Fehlgeschlagene Jobs → Incident (mit Dedup: kein Duplikat wenn offener Incident für gleichen Client existiert)
- Storage-Schwellwert überschritten → Incident
- SLA-Verletzung → Incident

## Proaktives Monitoring

Polling-basiert (konfigurierbar, default: 30 Min):
1. Neue fehlgeschlagene Jobs seit letztem Poll → Insight-Nachricht
2. Storage >85% → Warnung + Kapazitätsprognose (lineares Wachstum der letzten 7 Tage)
3. SLA-Verletzungen → Alert
4. `auto_retry_failed: true` → fehlgeschlagene Jobs automatisch neu starten (max 1 Retry pro Job)
5. Cluster-aware: `AdapterClaimManager.tryClaim('commvault-monitor')` — nur ein Node pollt

## LLM-Analyse (Action: `analyze`)

Input ans LLM:
- Letzte 50 fehlgeschlagene Jobs (Name, Client, Fehlercode, Zeitpunkt, MediaAgent)
- Storage-Auslastung pro Pool + Wachstum (7d/30d)
- Schedule-Übersicht (Frequenz, letzte Ausführung)
- Bekannte Commvault-Fehlercodes mit Lösungshinweisen (als System-Kontext Lookup-Tabelle)

Output:
- Fehlerursachen-Clustering ("5 Jobs scheitern am MediaAgent MA-02 → Storage I/O Problem")
- Optimierungsvorschläge ("Client X: tägliches Full → Incremental spart 70% Storage")
- Kapazitätsprognose ("Pool Y: 92%, +2.1TB/Woche → voll in 12 Tagen")
- SLA-Risiken ("Client Z: letztes erfolgreiches Backup vor 3 Tagen, RPO 24h verletzt")
- Empfohlene Aktionen (direkt ausführbar wenn `confirmation_mode: false`)

## Config-Schema

```yaml
commvault:
  enabled: true
  baseUrl: https://commserve.example.com/api/v2
  # Auth Option 1: API Token
  apiToken: "eyJ..."
  # Auth Option 2: Username/Password
  username: "alfred-api"
  password: "..."
  # Betriebsmodus
  confirmation_mode: false      # true = Schreibaktionen über Confirmation Queue
  polling_interval: 30          # Minuten, 0 = kein Polling
  auto_retry_failed: true       # fehlgeschlagene Jobs automatisch retry (max 1x)
  auto_incident: true           # ITSM-Incident bei Backup-Fehlern
  storage_warning_pct: 85       # Storage-Warnung ab X%
  sla_rpo_hours: 24             # RPO-Schwellwert für SLA-Verletzung
```

ENV-Overrides:
```
ALFRED_COMMVAULT_ENABLED=true
ALFRED_COMMVAULT_BASE_URL=https://commserve.example.com/api/v2
ALFRED_COMMVAULT_API_TOKEN=eyJ...
ALFRED_COMMVAULT_USERNAME=alfred-api
ALFRED_COMMVAULT_PASSWORD=...
ALFRED_COMMVAULT_CONFIRMATION_MODE=false
ALFRED_COMMVAULT_POLLING_INTERVAL=30
ALFRED_COMMVAULT_AUTO_RETRY=true
ALFRED_COMMVAULT_AUTO_INCIDENT=true
ALFRED_COMMVAULT_STORAGE_WARNING_PCT=85
ALFRED_COMMVAULT_SLA_RPO_HOURS=24
```

## Chat-Beispiele

| User sagt | Alfred tut |
|-----------|-----------|
| "Commvault Status" | Gesamtübersicht: Jobs, Alerts, Storage |
| "Zeig fehlgeschlagene Backup Jobs" | `jobs` mit `status=failed` |
| "Was ist mit Client SERVER-01 los?" | `client_detail` + letzte Jobs + Fehleranalyse |
| "Starte Backup für SERVER-01" | `start_job` (direkt oder Confirmation je nach Modus) |
| "Stoppe Job 12345" | `stop_job` (direkt oder Confirmation) |
| "Restore SERVER-01 von gestern" | `restore` mit point_in_time |
| "Wie ist die Storage-Auslastung?" | `storage` mit Kapazität + Prognose |
| "Backup Report letzte Woche" | `report` mit SLA-Compliance, Erfolgsrate |
| "Analysiere die Backup-Fehler" | `analyze` → LLM-basierte Fehlerursachen + Optimierung |
| "Ändere Backup-Schedule für DB-01 auf alle 6 Stunden" | `modify_schedule` |
| "Warum schlägt das Backup von FILESERVER immer fehl?" | `analyze` fokussiert auf einen Client |

## Dateien die erstellt/geändert werden

| Datei | Änderung |
|-------|----------|
| `packages/types/src/config.ts` | `CommvaultConfig` Interface |
| `packages/config/src/schema.ts` | Zod-Schema |
| `packages/config/src/loader.ts` | ENV-Overrides |
| `packages/skills/src/built-in/commvault.ts` | Neuer Skill (alle Actions) |
| `packages/skills/src/index.ts` | Export |
| `packages/core/src/alfred.ts` | Registrierung + Polling-Scheduler + ClaimManager |
| `packages/core/src/reasoning-context-collector.ts` | Neue Source `commvault` |
| `packages/core/src/skill-filter.ts` | Keywords: commvault, backup-job, restore, media-agent, storage-pool etc. |

## Abhängigkeiten

- Keine neuen npm-Packages — Commvault REST API über native `fetch`
- Bestehend: `AdapterClaimManager`, ITSM-Skill (optional), Reasoning-Engine
