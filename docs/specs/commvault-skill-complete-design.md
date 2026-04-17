# Commvault Skill — Vollstaendiger Ausbau

## Ziel
Alfred soll einen Commvault CommServe vollumfaenglich verwalten und bedienen koennen.
Alles was ein Backup-Admin in der Commvault Console tut, soll per Chat moeglich sein.

## API-Basis
- OpenAPI3 Spec: `docs/OpenAPI3.yaml` (246 V4 Endpoints)
- Legacy Endpoints: `/Job`, `/Client`, `/Subclient`, `/CreateTask` (nicht in V4 Spec, aber funktional)
- Auth: `Authtoken` Header (Token oder Username/Password Login)

## Actions (60 total)

### Monitoring & Dashboard (4)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `status` | Jobs + Alerts + Storage | Gesamtuebersicht |
| `report` | Jobs + Storage | SLA/Compliance Report |
| `analyze` | Jobs + Storage + LLM | LLM-basierte Fehleranalyse |
| `anomalies` | GET /V4/AnomalousConditions | Anomalie-Erkennung |

### Jobs (7)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `jobs` | GET /Job | Liste (24h, filterbar) |
| `job_detail` | GET /Job/{id} + /Job/{id}/Details | Job-Details + Fortschritt |
| `job_history` | GET /Job?completedJobLookupTime=604800 | 7-Tage-Historie |
| `start_job` | POST /Subclient/{id}/action/backup | Backup starten |
| `stop_job` | POST /Job/{id}/action/kill | Job stoppen |
| `retry_job` | POST /Subclient/{id}/action/backup | Fehlgeschlagenen Job retrien |
| `browse_data` | GET /v4/Cloud/CloudConfig/Job/{id}/Browse | Backup-Daten durchsuchen |

### Storage (12)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `storage` | GET /V4/Storage/Disk + Cloud + Local + HyperScale | Alle Pools uebersicht |
| `storage_detail` | GET /V4/Storage/Disk/{id} | Pool-Details |
| `storage_create_disk` | POST /V4/Storage/Disk | Disk Pool erstellen |
| `storage_create_cloud` | POST /V4/Storage/Cloud | Cloud Pool erstellen |
| `storage_create_local` | POST /V4/Storage/Local | Local Pool erstellen |
| `storage_delete` | DELETE /V4/Storage/Disk/{id} | Pool loeschen |
| `storage_tape` | GET /V4/Storage/Tape | Tape Libraries |
| `storage_tape_detail` | GET /V4/Storage/Tape/{id} + Media + Drives | Tape Details |
| `storage_ddb` | GET /V4/StoragePool/DDB | Dedup DB Pools |
| `storage_arrays` | GET /V4/StorageArrays | Storage Arrays |
| `storage_backup_locations` | GET /V4/Storage/Disk/{id}/BackupLocation | Backup Locations |
| `storage_mount_content` | GET /V4/MountPath/Content | Mount Path Inhalt |

### Plans (8)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `plans` | GET /V4/Plan/Summary | Alle Plaene |
| `plan_ids` | GET /V4/PlanIds | Schnelle ID/Name-Liste |
| `plan_detail` | GET /V4/ServerPlan/{id} | Plan-Details |
| `plan_create_server` | POST /V4/ServerPlan | Server-Plan erstellen |
| `plan_create_laptop` | POST /V4/LaptopPlan | Laptop-Plan erstellen |
| `plan_delete` | DELETE /V4/ServerPlan/{id} | Plan loeschen |
| `plan_rules` | GET /V4/Plan/Rule | Plan-Regeln (Auto-Assignment) |
| `plan_rule_entities` | GET/POST /V4/Plan/Rule/Entities | Entitaeten zu Regeln zuweisen |

### Clients & Servers (8)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `clients` | GET /Client | Alle Clients (Legacy) |
| `client_detail` | GET /Client/{id} + Subclients + Jobs | Client-Details |
| `servers` | GET /V4/Servers | Alle Server |
| `file_servers` | GET /V4/FileServers | File Server |
| `server_groups` | GET /V4/ServerGroup | Server-Gruppen |
| `subclients` | GET /Subclient?clientId={id} | Subclients eines Clients |
| `retire_server` | POST /V4/Servers/Retire | Server retiren |
| `virtual_machines` | GET /V4/VirtualMachines | VMs + Schutzstatus |

### Media Agents (4)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `media_agents` | GET /V4/mediaAgent | Alle Media Agents |
| `media_agent_detail` | GET /V4/mediaAgent/{id} | MA-Details |
| `media_agents_ddb` | GET /V4/DDB/MediaAgents | MAs fuer DDB |
| `install_media_agent` | POST /V4/mediaAgent | MA installieren |

### Alerts (8)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `alerts` | GET /V4/TriggeredAlerts | Ausgeloeste Alerts |
| `alert_detail` | GET /V4/TriggeredAlerts/{id} | Alert-Details |
| `read_alert` | PUT /V4/TriggeredAlerts/{id}/Read | Als gelesen markieren |
| `pin_alert` | PUT /V4/TriggeredAlerts/{id}/Pin | Alert pinnen |
| `delete_alerts` | POST /V4/TriggeredAlerts/Action/Delete | Alerts loeschen |
| `alert_note` | PUT /V4/TriggeredAlerts/{id}/Notes | Notiz hinzufuegen |
| `alert_rules` | GET /V4/AlertDefinitions | Alert-Definitionen |
| `alert_types` | GET /V4/AlertType | Alert-Typen |

### Commcell Operations (7)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `commcell_status` | GET mehrere Enable/Disable Status | Globaler Operations-Status |
| `commcell_enable` | POST /V4/Commcell/{op}/Action/Enable | Operation aktivieren |
| `commcell_disable` | POST /V4/Commcell/{op}/Action/Disable | Operation deaktivieren |
| `global_settings` | GET /V4/GlobalSettings | Globale Einstellungen |
| `license` | GET /V4/License | Lizenz-Info |
| `schedules` | GET /V4/Schedule/list | Alle Schedules |
| `schedule_policies` | GET /V4/SchedulePolicy/list | Schedule-Policies |

### Restore & DR (5)
| Action | Endpoint | Beschreibung |
|---|---|---|
| `restore` | POST /CreateTask (Legacy) | Restore ausfuehren |
| `replication_groups` | GET /V4/ReplicationGroup | Replikations-Gruppen |
| `replication_status` | GET /V4/ArrayReplicationMonitor | Replikations-Monitor |
| `failover` | POST /V4/FailoverGroups | Failover ausloesen |
| `recovery_targets` | GET /V4/RecoveryTargets | Recovery-Ziele |

### Sicherheit (HIGH_RISK Actions die Confirmation brauchen)
- `storage_create_*`, `storage_delete` — Pool-Erstellung/Loeschung
- `plan_create_*`, `plan_delete` — Plan CRUD
- `retire_server` — Server retiren (irreversibel)
- `install_media_agent` — Software-Installation
- `commcell_enable/disable` — Globale Operations-Steuerung
- `failover` — DR-Failover
- `restore` — Daten-Wiederherstellung
- `delete_alerts` — Alert-Loeschung

## Implementierung
- Blockweise: 8 Bloecke (Monitoring, Jobs, Storage, Plans, Clients, MediaAgents, Alerts, Commcell+DR)
- Jeder Block: eigene Methoden, Build+Test nach Block
- Bestehende Actions bleiben erhalten, werden nur korrigiert/erweitert
- inputSchema wird um alle neuen Actions erweitert
