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
        created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
        created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
        created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
        created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
  {
    version: 43,
    description: 'Skill state table — separates transient skill data from semantic memories',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS skill_state (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          skill TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          expires_at TEXT DEFAULT NULL,
          UNIQUE(user_id, skill, key)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_skill_state_user_skill ON skill_state(user_id, skill)`, []);

      // Migrate feed entries
      await db.execute(`
        INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'feed_reader', key, value, updated_at FROM memories WHERE category = 'feed'
        ON CONFLICT (user_id, skill, key) DO NOTHING
      `, []);

      // Migrate sonos entries
      await db.execute(`
        INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'sonos', key, value, updated_at FROM memories WHERE category = 'sonos'
        ON CONFLICT (user_id, skill, key) DO NOTHING
      `, []);

      // Migrate voice entries
      await db.execute(`
        INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'voice', key, value, updated_at FROM memories WHERE category = 'voice'
        ON CONFLICT (user_id, skill, key) DO NOTHING
      `, []);

      // Migrate insight_tracker_stats (key transformed: insight_tracker_stats → stats)
      await db.execute(`
        INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'insight_tracker', 'stats', value, updated_at FROM memories WHERE key = 'insight_tracker_stats'
        ON CONFLICT (user_id, skill, key) DO NOTHING
      `, []);

      // Cleanup migrated entries from memories
      await db.execute(`DELETE FROM memories WHERE category IN ('feed', 'sonos', 'voice')`, []);
      await db.execute(`DELETE FROM memories WHERE key = 'insight_tracker_stats'`, []);
    },
  },
  {
    version: 44,
    description: 'Knowledge Graph — persistent entities and relations',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS kg_entities (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          attributes TEXT DEFAULT '{}',
          sources TEXT DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.5,
          first_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          last_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          mention_count INTEGER NOT NULL DEFAULT 1,
          UNIQUE(user_id, entity_type, normalized_name)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_entities_user ON kg_entities(user_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(user_id, entity_type)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(user_id, normalized_name)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS kg_relations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
          target_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          strength REAL NOT NULL DEFAULT 0.5,
          context TEXT,
          source_section TEXT,
          first_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          last_seen_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          mention_count INTEGER NOT NULL DEFAULT 1,
          UNIQUE(user_id, source_entity_id, target_entity_id, relation_type)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_relations_source ON kg_relations(source_entity_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_relations_target ON kg_relations(target_entity_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_relations_user ON kg_relations(user_id)`, []);
    },
  },
  {
    version: 45,
    description: 'BMW telematic log — persists MQTT + REST data for cross-node access and history',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS bmw_telematic_log (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          vin TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'rest',
          telematic_data TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_bmw_telematic_user_vin ON bmw_telematic_log(user_id, vin, created_at)`, []);
    },
  },
  {
    version: 46,
    description: 'Service usage — tracks non-token costs (STT, TTS, OCR, Moderation)',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS service_usage (
          date TEXT NOT NULL,
          service TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          units REAL NOT NULL DEFAULT 0,
          unit_type TEXT NOT NULL,
          cost_usd REAL NOT NULL DEFAULT 0,
          user_id TEXT NOT NULL DEFAULT '',
          UNIQUE(date, service, model, user_id)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_service_usage_date ON service_usage(date)`, []);
    },
  },
  {
    version: 47,
    description: 'Deferred insights — smart delivery timing for reasoning insights',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS deferred_insights (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          urgency TEXT NOT NULL DEFAULT 'normal',
          message TEXT NOT NULL,
          actions TEXT DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          stale_at TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_deferred_insights_pending ON deferred_insights(chat_id, delivered, stale_at)`, []);
    },
  },
  {
    version: 48,
    description: 'Brainstorming sessions and items',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS brainstorming_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          context TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_brainstorm_user ON brainstorming_sessions(user_id, status)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS brainstorming_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES brainstorming_sessions(id) ON DELETE CASCADE,
          phase TEXT NOT NULL DEFAULT 'ideas',
          category TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          linked_entity_id TEXT,
          linked_action_id TEXT,
          created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_brainstorm_items_session ON brainstorming_items(session_id)`, []);
    },
  },
  {
    version: 49,
    description: 'CMDB assets, relations, changes, incidents, services, change requests',
    async up(db) {
      const ts = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_assets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          asset_type TEXT NOT NULL,
          name TEXT NOT NULL,
          identifier TEXT,
          source_skill TEXT,
          source_id TEXT,
          environment TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          ip_address TEXT,
          hostname TEXT,
          fqdn TEXT,
          location TEXT,
          owner TEXT,
          purpose TEXT,
          attributes TEXT NOT NULL DEFAULT '{}',
          tags TEXT,
          notes TEXT,
          discovered_at TEXT,
          last_seen_at TEXT,
          last_verified_at TEXT,
          created_at TEXT NOT NULL DEFAULT ${ts},
          updated_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_assets_user ON cmdb_assets(user_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_assets_type ON cmdb_assets(asset_type)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_assets_status ON cmdb_assets(status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_assets_ip ON cmdb_assets(ip_address)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cmdb_assets_source ON cmdb_assets(user_id, source_skill, source_id)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_asset_relations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_asset_id TEXT NOT NULL REFERENCES cmdb_assets(id) ON DELETE CASCADE,
          target_asset_id TEXT NOT NULL REFERENCES cmdb_assets(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          auto_discovered INTEGER NOT NULL DEFAULT 0,
          attributes TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT ${ts},
          updated_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_rel_source ON cmdb_asset_relations(source_asset_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_rel_target ON cmdb_asset_relations(target_asset_id)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cmdb_rel_unique ON cmdb_asset_relations(user_id, source_asset_id, target_asset_id, relation_type)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_changes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          asset_id TEXT REFERENCES cmdb_assets(id) ON DELETE SET NULL,
          change_type TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'manual',
          field_name TEXT,
          old_value TEXT,
          new_value TEXT,
          description TEXT,
          source TEXT,
          created_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_changes_asset ON cmdb_changes(asset_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_changes_created ON cmdb_changes(created_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_changes_type ON cmdb_changes(change_type)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_incidents (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          severity TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'open',
          priority INTEGER NOT NULL DEFAULT 3,
          affected_asset_ids TEXT NOT NULL DEFAULT '[]',
          affected_service_ids TEXT NOT NULL DEFAULT '[]',
          symptoms TEXT,
          root_cause TEXT,
          resolution TEXT,
          workaround TEXT,
          detected_by TEXT,
          related_incident_id TEXT,
          opened_at TEXT NOT NULL DEFAULT ${ts},
          acknowledged_at TEXT,
          resolved_at TEXT,
          closed_at TEXT,
          created_at TEXT NOT NULL DEFAULT ${ts},
          updated_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_user_status ON cmdb_incidents(user_id, status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_severity ON cmdb_incidents(severity)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_created ON cmdb_incidents(created_at)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_services (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          category TEXT,
          environment TEXT,
          url TEXT,
          health_check_url TEXT,
          health_status TEXT NOT NULL DEFAULT 'unknown',
          last_health_check TEXT,
          criticality TEXT DEFAULT 'medium',
          dependencies TEXT NOT NULL DEFAULT '[]',
          asset_ids TEXT NOT NULL DEFAULT '[]',
          owner TEXT,
          documentation TEXT,
          sla_notes TEXT,
          maintenance_window TEXT,
          tags TEXT,
          created_at TEXT NOT NULL DEFAULT ${ts},
          updated_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_services_user ON cmdb_services(user_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_services_health ON cmdb_services(health_status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_services_category ON cmdb_services(category)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_change_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          type TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'draft',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          affected_asset_ids TEXT NOT NULL DEFAULT '[]',
          affected_service_ids TEXT NOT NULL DEFAULT '[]',
          implementation_plan TEXT,
          rollback_plan TEXT,
          test_plan TEXT,
          scheduled_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          result TEXT,
          linked_incident_id TEXT,
          created_at TEXT NOT NULL DEFAULT ${ts},
          updated_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_cr_user_status ON cmdb_change_requests(user_id, status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_cr_type ON cmdb_change_requests(type)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_cr_scheduled ON cmdb_change_requests(scheduled_at)`, []);
    },
  },
  {
    version: 50,
    description: 'CMDB documents archive + incidents postmortem column',
    async up(db) {
      const ts = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_documents (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'markdown',
          linked_entity_type TEXT,
          linked_entity_id TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          generated_by TEXT DEFAULT 'infra_docs',
          created_at TEXT NOT NULL DEFAULT ${ts}
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_docs_user ON cmdb_documents(user_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_docs_entity ON cmdb_documents(linked_entity_type, linked_entity_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_docs_type ON cmdb_documents(doc_type)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_docs_created ON cmdb_documents(created_at)`, []);
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS postmortem TEXT`, []);
    },
  },
  {
    version: 51,
    description: 'Service components + health_reason on cmdb_services',
    async up(db) {
      await db.execute(`ALTER TABLE cmdb_services ADD COLUMN IF NOT EXISTS components TEXT NOT NULL DEFAULT '[]'`, []);
      await db.execute(`ALTER TABLE cmdb_services ADD COLUMN IF NOT EXISTS health_reason TEXT`, []);
    },
  },
  {
    version: 52,
    description: 'Add investigation_notes to cmdb_incidents',
    async up(db) {
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS investigation_notes TEXT`, []);
    },
  },
  {
    version: 53,
    description: 'Add lessons_learned, action_items to cmdb_incidents',
    async up(db) {
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS lessons_learned TEXT`, []);
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS action_items TEXT`, []);
    },
  },
  {
    version: 54,
    description: 'Problem Management — cmdb_problems + problem_id on incidents + linked_problem_id on changes',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_problems (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'logged',
          priority TEXT NOT NULL DEFAULT 'medium',
          category TEXT,
          root_cause_description TEXT,
          root_cause_category TEXT,
          workaround TEXT,
          proposed_fix TEXT,
          is_known_error INTEGER NOT NULL DEFAULT 0,
          known_error_description TEXT,
          analysis_notes TEXT,
          linked_incident_ids TEXT NOT NULL DEFAULT '[]',
          linked_change_request_id TEXT,
          affected_asset_ids TEXT NOT NULL DEFAULT '[]',
          affected_service_ids TEXT NOT NULL DEFAULT '[]',
          detected_by TEXT NOT NULL DEFAULT 'manual',
          detection_method TEXT,
          detected_at TEXT NOT NULL,
          analyzed_at TEXT,
          root_cause_identified_at TEXT,
          resolved_at TEXT,
          closed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_cmdb_problems_user_status ON cmdb_problems(user_id, status)`, []);
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS problem_id TEXT`, []);
      await db.execute(`ALTER TABLE cmdb_change_requests ADD COLUMN IF NOT EXISTS linked_problem_id TEXT`, []);
    },
  },
  {
    version: 55,
    description: 'Autonomous Planning — plans table',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          steps JSONB NOT NULL DEFAULT '[]',
          current_step_index INTEGER NOT NULL DEFAULT 0,
          context JSONB NOT NULL DEFAULT '{}',
          trigger_source TEXT NOT NULL DEFAULT 'reasoning',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_plans_user_status ON plans(user_id, status)`, []);
    },
  },
  {
    version: 56,
    description: 'Workflow automation — monitoring + last_triggered_at columns',
    async up(db) {
      // monitoring and last_triggered_at are new; trigger_config and trigger_type already exist
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS monitoring TEXT DEFAULT NULL`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS last_triggered_at TEXT DEFAULT NULL`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS guards TEXT DEFAULT NULL`, []);
    },
  },
  {
    version: 57,
    description: 'IT Documentation Platform — runbook_id on change_requests',
    async up(db) {
      await db.execute('ALTER TABLE cmdb_change_requests ADD COLUMN IF NOT EXISTS runbook_id TEXT DEFAULT NULL', []);
    },
  },
];
