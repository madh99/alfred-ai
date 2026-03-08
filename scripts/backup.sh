#!/bin/bash
DB_PATH="${ALFRED_STORAGE_PATH:-./data/alfred.db}"
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
mkdir -p "$BACKUP_DIR"

# WAL checkpoint + copy
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"
cp "$DB_PATH" "$BACKUP_DIR/alfred-$(date +%Y%m%d-%H%M%S).db"

# Retention: keep last 7 days
find "$BACKUP_DIR" -name "alfred-*.db" -mtime +7 -delete

echo "Backup complete: $BACKUP_DIR"
