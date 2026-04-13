# Backup & Restore — Design Spec

## Überblick

Zwei Komponenten:
1. **Database-Skill Erweiterung** — `backup`/`restore` Actions für beliebige konfigurierte DB-Connections
2. **System-Backup-Skill** — Alfred-eigenes Backup (DB + Tokens + Config), Zeitplan, Retention, Chat-Interface

## 1. Database-Skill Erweiterung

Neue Actions im bestehenden `database-skill.ts`:

### `backup`
- Parameter: `connection` (Name), `format` (sql/custom/archive, default: custom), `label` (optional)
- Pro Provider:
  - **PostgreSQL:** `pg_dump --format=custom`
  - **MySQL/MariaDB:** `mysqldump`
  - **MS SQL:** `BACKUP DATABASE ... TO DISK` (T-SQL über bestehende Verbindung)
  - **SQLite:** `.backup()` API
  - **MongoDB:** `mongodump`
  - **Redis:** `BGSAVE` + Kopie der RDB-Datei
  - **InfluxDB:** `influx backup` CLI
- Speichert unter konfiguriertem Pfad mit Timestamp
- Gibt Dateipfad + Größe zurück

### `restore`
- Parameter: `connection` (Name), `backup_id` oder `file` (Pfad)
- Pro Provider:
  - **PostgreSQL:** `pg_restore`
  - **MySQL/MariaDB:** `mysql < dump.sql`
  - **MS SQL:** `RESTORE DATABASE ... FROM DISK` (T-SQL über bestehende Verbindung)
  - **SQLite:** Datei ersetzen + reconnect
  - **MongoDB:** `mongorestore`
  - **Redis:** RDB-Datei ersetzen + `DEBUG RELOAD`
  - **InfluxDB:** `influx restore` CLI
- Zeigt Backup-Details (Datum, Größe, Quelle)
- Führt Restore nur aus wenn global oder per Connection `restore_via_query: true` konfiguriert
- Default: zeigt nur Info, kein Restore

## 2. System-Backup-Skill

Neuer Skill: `system_backup` in `packages/skills/src/built-in/system-backup.ts`

### Actions

| Action | Beschreibung | Parameter |
|--------|-------------|-----------|
| `backup` | Manuelles Backup erstellen | `label?`, `retention_days?`, `permanent?`, `include?` (array) |
| `restore` | Backup wiederherstellen oder auflisten | `backup_id?` (ohne = Liste anzeigen) |
| `list` | Verfügbare Backups anzeigen | `limit?` (default 10) |
| `status` | Letztes Backup, nächstes geplantes, Speicherverbrauch | — |
| `configure` | Zeitplan/Retention/Speicherort ändern | `schedule?`, `retention_days?`, `storage?`, `restore_via_chat?` |
| `delete` | Spezifisches Backup löschen | `backup_id` |

### Was wird gesichert

| Komponente | Methode | Default |
|-----------|---------|---------|
| Alfred DB (PostgreSQL) | `pg_dump --format=custom` | immer |
| Alfred DB (SQLite) | SQLite `.backup()` API | immer (wenn SQLite-Modus) |
| Token-Dateien | Kopie `~/.alfred/bmw-tokens-*.json` etc. | konfigurierbar (`include_tokens: true`) |
| Config-Datei | Kopie `config.yaml` / `.env` | konfigurierbar (`include_config: true`) |
| MinIO-Buckets | `mc mirror` oder S3 API | konfigurierbar (`include_minio: false`) |

### Backup-Metadaten

Pro Backup wird eine Metadaten-Datei gespeichert (`{id}.meta.json`):

```json
{
  "id": "2026-04-14_030000",
  "timestamp": "2026-04-14T03:00:00Z",
  "type": "scheduled",
  "retention_days": 30,
  "permanent": false,
  "storage": "both",
  "size_bytes": 52428800,
  "includes": ["database", "tokens", "config"],
  "label": "vor KG cleanup",
  "node_id": "node-a",
  "alfred_version": "0.19.0-multi-ha.474",
  "db_type": "postgres",
  "db_version": "16.2"
}
```

### Speicherziele

Konfigurierbar pro Installation:
- **local** — `{local_path}/{id}/` (DB-Dump + Token-Kopien + Config + meta.json)
- **s3** — `s3://{bucket}/{id}/` (gleiche Struktur)
- **both** — lokal + S3
- **none** — kein automatisches Speicherziel, nur manuell mit explizitem Pfad

### Zeitplan + Retention

- **Schedule:** Cron-Syntax, default `0 3 * * *` (täglich 03:00). Per Chat änderbar.
- **Retention:** Global default (Tage). Per Backup überschreibbar. `permanent: true` = wird nie gelöscht.
- **Cleanup:** Läuft nach jedem Backup. Löscht Backups deren `timestamp + retention_days < now` und `permanent !== true`.
- **Cluster-aware:** `AdapterClaimManager.tryClaim('system-backup')` — nur ein Node führt geplante Backups aus.

### Restore-Sicherheit

- Default: `restore_via_chat: false`
  - `restore` Action zeigt verfügbare Backups (Datum, Größe, Label, Alter)
  - Restore-Ausführung nur per SSH/CLI
- Konfigurierbar: `restore_via_chat: true`
  - Restore über Chat möglich
  - Geht durch Confirmation Queue als HIGH_RISK
  - Alfred zeigt vorher: was wird restored, wie alt, aktuelle DB wird überschrieben
  - User muss explizit bestätigen

### Config-Schema

```yaml
backup:
  enabled: true
  schedule: "0 3 * * *"
  retention_days: 30
  storage: local              # local | s3 | both | none
  local_path: /root/alfred/backups
  s3_bucket: alfred-backups
  restore_via_chat: false
  include_tokens: true
  include_config: true
  include_minio: false
```

ENV-Overrides:
```
ALFRED_BACKUP_ENABLED=true
ALFRED_BACKUP_SCHEDULE=0 3 * * *
ALFRED_BACKUP_RETENTION_DAYS=30
ALFRED_BACKUP_STORAGE=local
ALFRED_BACKUP_LOCAL_PATH=/root/alfred/backups
ALFRED_BACKUP_S3_BUCKET=alfred-backups
ALFRED_BACKUP_RESTORE_VIA_CHAT=false
ALFRED_BACKUP_INCLUDE_TOKENS=true
ALFRED_BACKUP_INCLUDE_CONFIG=true
ALFRED_BACKUP_INCLUDE_MINIO=false
```

### Chat-Beispiele

| User sagt | Alfred tut |
|-----------|-----------|
| "Mach ein Backup" | Erstellt Backup mit Default-Settings |
| "Backup mit Label 'vor Update'" | Backup mit Label |
| "Mach ein Backup das 90 Tage behalten wird" | Backup mit individueller Retention |
| "Behalte das Backup von gestern für immer" | Setzt `permanent: true` auf das Backup |
| "Zeig mir die Backups" | Liste der letzten 10 Backups |
| "Backup Status" | Letztes Backup, nächstes geplantes, Speicher |
| "Ändere Backup-Zeitplan auf alle 6 Stunden" | `schedule: "0 */6 * * *"` |
| "Setze Retention auf 14 Tage" | Ändert globalen Default |
| "Restore Backup 2026-04-13" | Zeigt Details (wenn restore_via_chat=false) oder Confirmation (wenn true) |
| "Lösche Backup 2026-04-10" | Löscht nach Bestätigung |

### Abhängigkeiten

- `@alfred/storage` — DB-Adapter Typ-Erkennung (PG vs SQLite)
- `@alfred/config` — Zod-Schema für BackupConfig
- `@alfred/types` — BackupConfig Interface
- `child_process` — `pg_dump`, `pg_restore` Ausführung
- `@aws-sdk/client-s3` (optional) — S3/MinIO Upload (bereits als optionalDependency)
- `AdapterClaimManager` — Cluster-Dedup für geplante Backups
- `ScheduledTaskRunner` oder eigener Cron — Zeitplan-Ausführung

### Dateien die erstellt/geändert werden

| Datei | Änderung |
|-------|----------|
| `packages/types/src/config.ts` | `BackupConfig` Interface |
| `packages/config/src/schemas.ts` | Zod-Schema für BackupConfig |
| `packages/config/src/loader.ts` | ENV-Overrides für Backup |
| `packages/skills/src/built-in/system-backup.ts` | Neuer Skill |
| `packages/skills/src/built-in/database/database-skill.ts` | `backup`/`restore` Actions |
| `packages/skills/src/built-in/database/db-providers.ts` | `backup()`/`restore()` Methoden pro Provider |
| `packages/core/src/alfred.ts` | Skill-Registrierung + Cron-Setup + ClaimManager |
| `packages/storage/src/migrations/` | Optional: backup_history Tabelle für Metadaten |
