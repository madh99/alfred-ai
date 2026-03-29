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
  {
    version: 37,
    description: 'Watch owner — user_id column for correct skill context resolution',
    async up(db) {
      await db.exec(`ALTER TABLE watches ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL`);
    },
  },
  {
    version: 38,
    description: 'Thread/Topic routing for watches and scheduled actions',
    async up(db) {
      await db.exec(`
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS thread_id TEXT DEFAULT NULL;
        ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS thread_id TEXT DEFAULT NULL
      `);
    },
  },
  {
    version: 39,
    description: 'Project agent interjection inbox in DB for HA',
    async up(db) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS project_agent_interjections (
          id SERIAL PRIMARY KEY,
          task_id TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_interjections_task ON project_agent_interjections(task_id)
      `);
    },
  },
  {
    version: 40,
    description: 'Recipe favorites and meal plans',
    async up(db) {
      await db.execute(`CREATE TABLE IF NOT EXISTS recipe_favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        image_url TEXT,
        prep_time_minutes INTEGER,
        servings INTEGER,
        tags TEXT,
        nutrition_summary TEXT,
        ingredients_json TEXT,
        created_at TEXT NOT NULL DEFAULT NOW()
      )`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_recipe_fav_user ON recipe_favorites(user_id)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_fav_unique ON recipe_favorites(user_id, recipe_id)`, []);

      await db.execute(`CREATE TABLE IF NOT EXISTS meal_plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week TEXT NOT NULL,
        day TEXT NOT NULL,
        meal TEXT NOT NULL,
        recipe_id TEXT,
        source TEXT,
        title TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT NOW(),
        updated_at TEXT NOT NULL DEFAULT NOW()
      )`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_meal_plan_user_week ON meal_plans(user_id, week)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_plan_slot ON meal_plans(user_id, week, day, meal)`, []);
    },
  },
  {
    version: 41,
    description: 'Travel plans and plan items',
    async up(db) {
      await db.execute(`CREATE TABLE IF NOT EXISTS travel_plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        budget REAL,
        budget_spent REAL DEFAULT 0,
        travelers INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT NOW(),
        updated_at TEXT NOT NULL DEFAULT NOW()
      )`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_travel_plan_user ON travel_plans(user_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_travel_plan_status ON travel_plans(user_id, status)`, []);

      await db.execute(`CREATE TABLE IF NOT EXISTS travel_plan_items (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES travel_plans(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        date_from TEXT,
        date_to TEXT,
        price REAL,
        currency TEXT DEFAULT 'EUR',
        details_json TEXT,
        booking_ref TEXT,
        status TEXT DEFAULT 'planned',
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT NOW()
      )`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_travel_item_plan ON travel_plan_items(plan_id)`, []);
    },
  },
  {
    version: 42,
    description: 'Watch quiet hours — suppresses alerts during defined time windows',
    async up(db) {
      await db.exec(`
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT DEFAULT NULL;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT DEFAULT NULL
      `);
    },
  },
];
