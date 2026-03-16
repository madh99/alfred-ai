/**
 * Incremental PostgreSQL migrations.
 * Applied by PgMigrator on PG databases that were initialized from PG_SCHEMA.
 * PG_SCHEMA already includes everything up to version 35.
 */
import type { PgMigration } from './pg-migrator.js';

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 36,
    description: 'HA Active-Active: processed_messages, node_heartbeats, reasoning_slots, adapter_claims, claim columns',
    async up(db) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS processed_messages (
          message_key  TEXT PRIMARY KEY,
          node_id      TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          expires_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processed_messages_expires
          ON processed_messages (expires_at);

        CREATE TABLE IF NOT EXISTS node_heartbeats (
          node_id      TEXT PRIMARY KEY,
          host         TEXT NOT NULL DEFAULT '',
          last_seen_at TEXT NOT NULL,
          started_at   TEXT NOT NULL,
          uptime_s     INTEGER NOT NULL DEFAULT 0,
          adapters     TEXT NOT NULL DEFAULT '[]',
          version      TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS reasoning_slots (
          slot_key    TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL,
          claimed_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS adapter_claims (
          platform     TEXT PRIMARY KEY,
          node_id      TEXT NOT NULL,
          claimed_at   TEXT NOT NULL,
          expires_at   TEXT NOT NULL
        )
      `);

      // Add claim columns to scheduler tables (IF NOT EXISTS for idempotency)
      await db.exec(`
        ALTER TABLE reminders ADD COLUMN IF NOT EXISTS claimed_by TEXT DEFAULT NULL;
        ALTER TABLE reminders ADD COLUMN IF NOT EXISTS claim_expires_at TEXT DEFAULT NULL;
        ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS claimed_by TEXT DEFAULT NULL;
        ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS claim_expires_at TEXT DEFAULT NULL;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS claimed_by TEXT DEFAULT NULL;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS claim_expires_at TEXT DEFAULT NULL
      `);
    },
  },
];
