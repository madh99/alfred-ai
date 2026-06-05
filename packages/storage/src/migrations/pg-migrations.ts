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
  {
    version: 58,
    description: 'Service Management — failure_modes column',
    async up(db) {
      await db.execute("ALTER TABLE cmdb_services ADD COLUMN IF NOT EXISTS failure_modes TEXT DEFAULT '[]'", []);
    },
  },
  {
    version: 59,
    description: 'SLA Management — sla columns + sla_events table',
    async up(db) {
      await db.execute("ALTER TABLE cmdb_services ADD COLUMN IF NOT EXISTS sla TEXT DEFAULT NULL", []);
      await db.execute("ALTER TABLE cmdb_assets ADD COLUMN IF NOT EXISTS sla TEXT DEFAULT NULL", []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS sla_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_minutes REAL,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (now()::text)
        )
      `, []);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sla_events_target ON sla_events(target_type, target_id, started_at)", []);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sla_events_type ON sla_events(event_type)", []);
    },
  },
  {
    version: 60,
    description: 'Project Agent — interjections consumed column',
    async up(db) {
      await db.execute('ALTER TABLE project_agent_interjections ADD COLUMN IF NOT EXISTS consumed INTEGER NOT NULL DEFAULT 0', []);
      await db.execute('CREATE INDEX IF NOT EXISTS idx_interjections_consumed ON project_agent_interjections(task_id, consumed)', []);
    },
  },
  {
    version: 61,
    description: 'Memories — relevant_until + source_event_refs columns for correction lifecycle',
    async up(db) {
      await db.execute('ALTER TABLE memories ADD COLUMN IF NOT EXISTS relevant_until TEXT', []);
      await db.execute('ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_event_refs TEXT', []);
      await db.execute('CREATE INDEX IF NOT EXISTS idx_memories_relevant_until ON memories(user_id, relevant_until) WHERE relevant_until IS NOT NULL', []);
    },
  },
  {
    version: 62,
    description: 'Messages — tsvector full-text search column with auto-update trigger',
    async up(db) {
      // German+English text search config: 'simple' tokenizes without stemming
      // (better recall for technical terms); 'german' would stem aggressively.
      // We pick 'simple' for predictability — searches for "BMW" find "BMW", not stems.
      await db.execute(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv tsvector`, []);
      await db.execute(`
        UPDATE messages SET content_tsv = to_tsvector('simple', coalesce(content, ''))
        WHERE content_tsv IS NULL
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_content_tsv ON messages USING gin(content_tsv)`, []);
      // Trigger keeps the column in sync without app-level effort
      await db.execute(`
        CREATE OR REPLACE FUNCTION messages_tsv_update() RETURNS trigger AS $$
        BEGIN
          NEW.content_tsv := to_tsvector('simple', coalesce(NEW.content, ''));
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
      `, []);
      // Drop+create to ensure trigger is current
      await db.execute(`DROP TRIGGER IF EXISTS messages_tsv_trigger ON messages`, []);
      await db.execute(`
        CREATE TRIGGER messages_tsv_trigger
        BEFORE INSERT OR UPDATE OF content ON messages
        FOR EACH ROW EXECUTE FUNCTION messages_tsv_update()
      `, []);
    },
  },
  {
    version: 64,
    description: 'Watches + scheduled_actions — consecutive_failures counter for auto-repair',
    async up(db) {
      await db.execute(`ALTER TABLE watches ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0`, []);
      await db.execute(`ALTER TABLE watches ADD COLUMN IF NOT EXISTS last_repair_at TEXT`, []);
      await db.execute(`ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0`, []);
      await db.execute(`ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS last_repair_at TEXT`, []);
    },
  },
  {
    version: 63,
    description: 'Runbooks — captured operational procedures from incidents/sessions/chats',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS runbooks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          symptom TEXT,
          cause TEXT,
          steps TEXT NOT NULL,
          verification TEXT,
          rollback TEXT,
          source_type TEXT,
          source_id TEXT,
          asset_ids TEXT,
          tags TEXT,
          confidence REAL NOT NULL DEFAULT 0.7,
          usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_runbooks_user_status ON runbooks(user_id, status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_runbooks_source ON runbooks(source_type, source_id)`, []);
    },
  },
  {
    version: 65,
    description: 'Projects — long-lived containers for project-agent/code-agent/delegate sessions + open items + decisions',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          description TEXT,
          cwd TEXT,
          repo_url TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          health_mode TEXT NOT NULL DEFAULT 'full',
          tags TEXT,
          created_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          next_check_at TEXT,
          UNIQUE(user_id, slug)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_projects_cwd ON projects(cwd)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_type TEXT NOT NULL,
          source_id TEXT,
          summary_json TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_sessions_project ON project_sessions(project_id, started_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_sessions_source ON project_sessions(session_type, source_id)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_open_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'open',
          due_at TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_open_items_project_status ON project_open_items(project_id, status)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_decisions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT,
          title TEXT NOT NULL,
          choice TEXT NOT NULL,
          rationale TEXT,
          alternatives_considered TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_decisions_project ON project_decisions(project_id, created_at DESC)`, []);
    },
  },
  {
    version: 66,
    description: 'Projects — health-check log for git/build/deps/http probes per project',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_health_log (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          probe TEXT NOT NULL,
          status TEXT NOT NULL,
          details TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          checked_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_health_log_project ON project_health_log(project_id, checked_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_health_log_probe ON project_health_log(project_id, probe, checked_at DESC)`, []);
    },
  },
  {
    version: 67,
    description: 'Workflows + project_open_items — auto-extraction columns, auto_run flag, ITSM cross-linking',
    async up(db) {
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS source_session_id TEXT`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS related_runbook_id TEXT`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS auto_extracted INTEGER NOT NULL DEFAULT 0`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS auto_run INTEGER NOT NULL DEFAULT 0`, []);
      await db.execute(`ALTER TABLE workflow_chains ADD COLUMN IF NOT EXISTS description TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_workflow_chains_source ON workflow_chains(source_session_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_workflow_chains_name ON workflow_chains(user_id, name)`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS linked_incident_id TEXT`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS linked_change_id TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_open_items_linked_incident ON project_open_items(linked_incident_id)`, []);
    },
  },
  {
    version: 68,
    description: 'Skill-Pattern-Memory — host-specific skill failures (v607 D7)',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS skill_host_failures (
          id TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          host TEXT NOT NULL,
          error_class TEXT NOT NULL,
          error_message TEXT,
          count INTEGER NOT NULL DEFAULT 1,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          UNIQUE(skill_name, host, error_class)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_skill_host_failures_skill ON skill_host_failures(skill_name, host)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_skill_host_failures_last ON skill_host_failures(last_seen DESC)`, []);
    },
  },
  {
    version: 69,
    description: 'Host capabilities — persisted facts per (host,user) like compose variant (v608 F6)',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS host_capabilities (
          host TEXT NOT NULL,
          user_name TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          probed_at TEXT NOT NULL,
          PRIMARY KEY (host, user_name, key)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_host_capabilities_host ON host_capabilities(host)`, []);
    },
  },
  {
    version: 70,
    description: 'v633 T3 — Incident recurrence_count + cmdb_metric_samples table for capacity-forecast',
    async up(db) {
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS recurrence_count INTEGER DEFAULT 0`, []);
      await db.execute(`ALTER TABLE cmdb_incidents ADD COLUMN IF NOT EXISTS last_recurrence_at TEXT`, []);
      // Per-incident change-request PR URL (v633 T3.6)
      await db.execute(`ALTER TABLE cmdb_change_requests ADD COLUMN IF NOT EXISTS pr_url TEXT`, []);

      // Capacity / time-series samples — written by monitor when numeric values are parsed from alerts
      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_metric_samples (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          asset_id TEXT,
          metric_name TEXT NOT NULL,
          value DOUBLE PRECISION NOT NULL,
          unit TEXT,
          sampled_at TEXT NOT NULL,
          source TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_metric_samples_asset_metric_time ON cmdb_metric_samples(asset_id, metric_name, sampled_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_metric_samples_user_time ON cmdb_metric_samples(user_id, sampled_at DESC)`, []);
    },
  },
  {
    version: 71,
    description: 'v634 T4 — Service-Cascade observations for cross-service-dependency learning',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS cmdb_service_cascades (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          observed_count INTEGER NOT NULL DEFAULT 1,
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          avg_delay_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
          UNIQUE(user_id, source_service_id, target_service_id)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_service_cascades_source ON cmdb_service_cascades(user_id, source_service_id)`, []);
    },
  },
  {
    version: 72,
    description: 'v638 — alfred_insights table for cross-domain Insight-Engine',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS alfred_insights (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          source_data TEXT,
          action_skill TEXT,
          action_params TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          snoozed_until TEXT,
          dedupe_key TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          acted_at TEXT,
          dismissed_at TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_insights_user_status_created ON alfred_insights(user_id, status, created_at DESC)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_dedupe_unique ON alfred_insights(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_insights_category ON alfred_insights(user_id, category, status)`, []);
    },
  },
  {
    version: 73,
    description: 'v639 — alfred_goals + alfred_goal_checkpoints for Goal-Tracker',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS alfred_goals (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT,
          cadence TEXT,
          target_metric TEXT,
          source TEXT NOT NULL DEFAULT 'user',
          source_conversation_id TEXT,
          source_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          check_frequency_days INTEGER NOT NULL DEFAULT 7,
          last_checked_at TEXT,
          last_status TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_goals_user_status ON alfred_goals(user_id, status)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS alfred_goal_checkpoints (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          status TEXT,
          evidence TEXT,
          notes TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal ON alfred_goal_checkpoints(goal_id, checked_at DESC)`, []);
    },
  },
  {
    version: 74,
    description: 'v640 — kg_questions table for question-generator with ignore-learning',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS kg_questions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          attribute TEXT NOT NULL,
          question_text TEXT NOT NULL,
          asked_at TEXT NOT NULL,
          asked_via_platform TEXT,
          asked_via_chat_id TEXT,
          status TEXT NOT NULL DEFAULT 'asked',
          answered_at TEXT,
          answer_text TEXT,
          parsed_value TEXT,
          ignore_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE(user_id, target_kind, target_id, attribute)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_kg_questions_user_status ON kg_questions(user_id, status, asked_at DESC)`, []);
    },
  },
  {
    version: 75,
    description: 'v641 — project_open_items.auto_resolved_by for OpenItemMatcher attribution',
    async up(db) {
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS auto_resolved_by TEXT`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS auto_resolved_confidence DOUBLE PRECISION`, []);
    },
  },
  {
    version: 76,
    description: 'v643 — project_agent_commits + session.last_push_url + project.default_branch',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_agent_commits (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_id TEXT,
          sha TEXT NOT NULL,
          message TEXT NOT NULL,
          phase_idx INTEGER,
          phase_description TEXT,
          files_changed INTEGER NOT NULL DEFAULT 0,
          branch TEXT,
          committed_at TEXT NOT NULL,
          pushed_at TEXT,
          push_url TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_pa_commits_session ON project_agent_commits(session_id, committed_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_pa_commits_project ON project_agent_commits(project_id, committed_at DESC)`, []);
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS last_push_url TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_branch TEXT`, []);
    },
  },
  {
    version: 77,
    description: 'v644 — conversations: pinned_at, custom_label, deleted_at, branched_from for lifecycle ops',
    async up(db) {
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at TEXT`, []);
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS custom_label TEXT`, []);
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TEXT`, []);
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS branched_from_conversation_id TEXT`, []);
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS branched_at_message_id TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(user_id, pinned_at DESC NULLS LAST, updated_at DESC) WHERE deleted_at IS NULL`, []);
    },
  },
  {
    version: 78,
    description: 'v648 — project_agent_plans + sessions.resumed_from_task_id for Resume-Foundation',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_agent_plans (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          phase_idx INTEGER NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planned',
          started_at TEXT,
          ended_at TEXT,
          UNIQUE(session_id, phase_idx)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_pa_plans_session ON project_agent_plans(session_id, phase_idx)`, []);
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS resumed_from_task_id TEXT`, []);
    },
  },
  {
    version: 79,
    description: 'v652 — Project-Agent Smart: failure_insight + auto_resume_count + lessons',
    async up(db) {
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS failure_insight TEXT`, []);
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS auto_resume_count INTEGER NOT NULL DEFAULT 0`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_agent_lessons (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          pattern TEXT NOT NULL,
          advice TEXT NOT NULL,
          occurrences INTEGER NOT NULL DEFAULT 1,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_pa_lessons_cwd ON project_agent_lessons(cwd, last_seen_at DESC)`, []);
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pa_lessons_cwd_pattern ON project_agent_lessons(cwd, pattern)`, []);
    },
  },
  {
    version: 80,
    description: 'v656 — llm_usage_hourly für stundenweise Darstellung (Retention 62 Tage, Lokalzeit)',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS llm_usage_hourly (
          id SERIAL PRIMARY KEY,
          hour_bucket TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          UNIQUE(hour_bucket, model)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_llm_usage_hourly_bucket ON llm_usage_hourly(hour_bucket)`, []);
    },
  },
  {
    version: 81,
    description: 'v657 — pending_confirmations.extra_actions für Multi-Action-Buttons (Open-Item-Eskalation u.a.)',
    async up(db) {
      await db.execute(`ALTER TABLE pending_confirmations ADD COLUMN IF NOT EXISTS extra_actions TEXT`, []);
    },
  },
  {
    version: 82,
    description: 'v658 — conversations.project_id für Projekt-Chat',
    async up(db) {
      await db.execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)`, []);
    },
  },
  {
    version: 83,
    description: 'v663a — projects.conventions + project_open_items roadmap-Felder',
    async up(db) {
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS conventions TEXT`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS roadmap_milestone TEXT`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS roadmap_order INTEGER`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS estimated_hours DOUBLE PRECISION`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_open_items_roadmap ON project_open_items(project_id, roadmap_milestone, roadmap_order)`, []);
    },
  },
  {
    version: 84,
    description: 'v663b — project_automations Tabelle',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_automations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          template_kind TEXT NOT NULL,
          schedule TEXT,
          prompt_override TEXT,
          output_destination TEXT NOT NULL DEFAULT 'telegram',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          last_run_status TEXT,
          last_run_output TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_automations_project ON project_automations(project_id, enabled)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_automations_next ON project_automations(next_run_at, enabled)`, []);
    },
  },
  {
    version: 85,
    description: 'v665a — projects storage_type/share_id/node_id/locks für Cluster-Shares',
    async up(db) {
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS storage_type TEXT NOT NULL DEFAULT 'local'`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_id TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS node_id TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS locked_by_node_id TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS locked_until TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_projects_share ON projects(share_id, storage_type)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_projects_locks ON projects(locked_by_node_id, locked_until)`, []);
    },
  },
  {
    version: 86,
    description: 'v670 — todo_notes: Arbeitsnotizen/Fortschritte pro Todo',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS todo_notes (
          id TEXT PRIMARY KEY,
          todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_todo_notes_todo ON todo_notes(todo_id, created_at DESC)`, []);
    },
  },
  {
    version: 87,
    description: 'v671 — Spiegel-Link Todo ↔ Project-Open-Item',
    async up(db) {
      await db.execute(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS linked_project_id TEXT`, []);
      await db.execute(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS linked_open_item_id TEXT`, []);
      await db.execute(`ALTER TABLE project_open_items ADD COLUMN IF NOT EXISTS linked_todo_id TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_todos_linked_open_item ON todos(linked_open_item_id) WHERE linked_open_item_id IS NOT NULL`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_open_items_linked_todo ON project_open_items(linked_todo_id) WHERE linked_todo_id IS NOT NULL`, []);
    },
  },
  {
    version: 88,
    description: 'v672 — todo_note_links: Many-to-many Verknüpfung zwischen Todos und Notes',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS todo_note_links (
          todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (todo_id, note_id)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_todo_note_links_note ON todo_note_links(note_id)`, []);
    },
  },
  {
    version: 89,
    description: 'v673 — generische attachments-Tabelle für Todos + Notes',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          label TEXT,
          mime_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, created_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC)`, []);
    },
  },
  {
    version: 90,
    description: 'v696 — Project-Agent Sandbox + Live-Preview Foundation (opt-in)',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_agent_sandboxes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT,
          user_id TEXT NOT NULL,

          worktree_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          base_commit_sha TEXT NOT NULL,

          container_id TEXT,
          container_image TEXT NOT NULL,
          host_port INTEGER,
          internal_port INTEGER NOT NULL,
          project_type TEXT,

          status TEXT NOT NULL,
          status_reason TEXT,
          node_id TEXT NOT NULL,

          ram_peak_mb INTEGER,
          disk_used_mb INTEGER,

          created_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          destroyed_at TEXT,

          result TEXT,
          result_pr_url TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandboxes_session ON project_agent_sandboxes(session_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandboxes_active ON project_agent_sandboxes(status, last_active_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandboxes_project ON project_agent_sandboxes(project_id, status)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandboxes_user ON project_agent_sandboxes(user_id, status)`, []);

      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'classic'`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_default_mode TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS merge_strategy TEXT`, []);
    },
  },
  {
    version: 91,
    description: 'v703 — sandbox_chat_messages: persistente Chat-History pro Sandbox',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS sandbox_chat_messages (
          id TEXT PRIMARY KEY,
          sandbox_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          task_id TEXT,
          task_phase TEXT,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandbox_chat_sandbox ON sandbox_chat_messages(sandbox_id, created_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandbox_chat_task ON sandbox_chat_messages(task_id)`, []);
    },
  },
  {
    version: 92,
    description: 'v721 — sandbox_id auf project_agent_sessions damit Interactive-Tasks korrekt zum Original-Project binden',
    async up(db) {
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS sandbox_id TEXT`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_sandbox ON project_agent_sessions(sandbox_id)`, []);
    },
  },
  {
    version: 93,
    description: 'v722 — learned_recipes: maschinen-lesbare Recipes statt prosaischer Auto-Rules',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS learned_recipes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          trigger_phrase TEXT NOT NULL,
          trigger_keywords TEXT NOT NULL,
          action_sequence TEXT NOT NULL,
          context_hint TEXT,
          confidence REAL NOT NULL DEFAULT 0.5,
          source TEXT NOT NULL,
          success_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          invalidated_at TEXT,
          superseded_by TEXT,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_recipes_user ON learned_recipes(user_id, invalidated_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_recipes_confidence ON learned_recipes(user_id, confidence DESC, success_count DESC)`, []);
    },
  },
  {
    version: 94,
    description: 'v726 — project_environments + project_db_seeds für Sandbox/Deploy-ENV-Management',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_environments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          vars_encrypted BYTEA NOT NULL,
          iv BYTEA NOT NULL,
          auth_tag BYTEA NOT NULL,
          encryption_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, stage)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_environments_project ON project_environments(project_id)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_db_seeds (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          storage_ref TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_db_seeds_project ON project_db_seeds(project_id)`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_env_stage TEXT`, []);
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_db_seed_id TEXT`, []);
    },
  },
  {
    version: 95,
    description: 'v731 — mentioned_item_ids auf project_agent_sessions (Auto-Done-Mark nach Run)',
    async up(db) {
      await db.execute(`ALTER TABLE project_agent_sessions ADD COLUMN IF NOT EXISTS mentioned_item_ids TEXT`, []);
    },
  },
  {
    version: 96,
    description: 'v751 — sandbox_templates für wiederverwendbare Sandbox-Konfigurationen',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS sandbox_templates (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          project_id TEXT,
          name TEXT NOT NULL,
          description TEXT,
          mode TEXT NOT NULL,
          env_stage TEXT,
          db_seed_id TEXT,
          initial_goal TEXT,
          tags TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandbox_templates_user ON sandbox_templates(user_id, updated_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_sandbox_templates_project ON sandbox_templates(project_id)`, []);
    },
  },
  {
    version: 97,
    description: 'v755 — projects.max_concurrent_sandboxes für Per-Project-Quota',
    async up(db) {
      await db.execute(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_concurrent_sandboxes INTEGER`, []);
    },
  },
  {
    version: 98,
    description: 'v779 — agent_sessions: persistente CLI-Coding-Agent-Sessions pro Sandbox×Agent für tool-cache-retention',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          sandbox_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          cli_session_id TEXT,
          state_path TEXT,
          capabilities_json TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          total_tokens_input INTEGER NOT NULL DEFAULT 0,
          total_tokens_output INTEGER NOT NULL DEFAULT 0,
          total_cached_tokens INTEGER NOT NULL DEFAULT 0,
          total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          last_health_ok BIGINT,
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          UNIQUE(sandbox_id, agent_name)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_sandbox ON agent_sessions(sandbox_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_used ON agent_sessions(last_used_at DESC)`, []);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_session_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          event_data TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_session_events_session ON agent_session_events(session_id, iteration, created_at)`, []);
    },
  },
  {
    version: 99,
    description: 'v804 — User-ID-Format-Sanity: rows mit non-UUID user_id finden + loggen (no destructive change).',
    async up(db) {
      // Reine Read-Only-Validation. Wir loggen die Anzahl problematischer Rows,
      // löschen/ändern aber NICHTS — das macht ein gezielter Migration-Task auf
      // Applikations-Ebene (mit user-resolution via IdentityResolver) später.
      // Hier nur eine Audit-Tabelle damit wir sehen wie viele Daten betroffen sind.
      await db.execute(`
        CREATE TABLE IF NOT EXISTS user_id_format_audit (
          id TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          column_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          user_id_value TEXT NOT NULL,
          format_class TEXT NOT NULL, -- 'uuid' | 'platform' | 'invalid'
          detected_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_uid_audit_table ON user_id_format_audit(table_name, format_class)`, []);
    },
  },
  {
    version: 100,
    description: 'v810 — agent_sessions.last_health_ok INTEGER→BIGINT (Date.now()-ms überläuft int32).',
    async up(db) {
      // Bug: last_health_ok speichert Date.now() (ms, ~1.78e12) in eine int32-Spalte
      // (max 2.147e9) → jeder Health-Check-Update warf "value out of range for type
      // integer" (code 22003), die Spalte blieb NULL, Stale-Session-Detection broken.
      // SQLite ist nicht betroffen (dynamic typing, 64-bit INTEGER).
      try {
        await db.execute(`ALTER TABLE agent_sessions ALTER COLUMN last_health_ok TYPE BIGINT`, []);
      } catch {
        // Tabelle/Spalte existiert evtl. noch nicht (frische DB legt sie bereits als
        // korrekten Typ an) — non-fatal.
      }
    },
  },
  {
    version: 101,
    description: 'v812 — project_sessions.merge_state + sandbox_id: Sandbox-Runs erst bei Merge in die Projekt-Historie übernehmen.',
    async up(db) {
      try { await db.execute(`ALTER TABLE project_sessions ADD COLUMN merge_state TEXT NOT NULL DEFAULT 'applied'`, []); } catch { /* exists */ }
      try { await db.execute(`ALTER TABLE project_sessions ADD COLUMN sandbox_id TEXT`, []); } catch { /* exists */ }
      try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_sessions_sandbox ON project_sessions(sandbox_id)`, []); } catch { /* exists */ }
    },
  },
  {
    version: 102,
    description: 'v817 — sandbox runtime tracking: total_run_seconds + last_resumed_at + last_paused_at.',
    async up(db) {
      try { await db.execute(`ALTER TABLE project_agent_sandboxes ADD COLUMN total_run_seconds INTEGER NOT NULL DEFAULT 0`, []); } catch { /* */ }
      try { await db.execute(`ALTER TABLE project_agent_sandboxes ADD COLUMN last_resumed_at TEXT`, []); } catch { /* */ }
      try { await db.execute(`ALTER TABLE project_agent_sandboxes ADD COLUMN last_paused_at TEXT`, []); } catch { /* */ }
      try { await db.execute(`UPDATE project_agent_sandboxes SET last_resumed_at = created_at WHERE last_resumed_at IS NULL AND status = 'running'`, []); } catch { /* */ }
    },
  },
  {
    version: 103,
    description: 'v823 — project conventions + history + patterns + violations + test_runs (Phasen 1-4 atomar, PG-Spiegel zu SQLite v99).',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_conventions (
          project_id TEXT NOT NULL,
          package_path TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          draft_content TEXT,
          neutral_format TEXT NOT NULL DEFAULT '{}',
          scan_hash TEXT NOT NULL DEFAULT '',
          content_hash TEXT NOT NULL DEFAULT '',
          generated_by TEXT NOT NULL DEFAULT 'manual',
          generated_at TEXT,
          last_applied_at TEXT,
          last_drift_check_at TEXT,
          drift_score REAL NOT NULL DEFAULT 0,
          source_scan TEXT,
          lessons TEXT NOT NULL DEFAULT '[]',
          files_written TEXT NOT NULL DEFAULT '[]',
          skill_contributions TEXT NOT NULL DEFAULT '{}',
          language TEXT NOT NULL DEFAULT 'de',
          inherits_from TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, package_path)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_project ON agent_conventions(project_id)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_drift ON agent_conventions(drift_score DESC)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_conventions_history (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          package_path TEXT NOT NULL DEFAULT '',
          applied_at TEXT NOT NULL,
          applied_by TEXT NOT NULL,
          prev_content_hash TEXT,
          new_content_hash TEXT NOT NULL,
          prev_content_snapshot TEXT,
          diff_summary TEXT,
          trigger_source TEXT NOT NULL,
          trigger_session_id TEXT,
          rolled_back_at TEXT,
          rolled_back_by TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_hist_project ON agent_conventions_history(project_id, package_path, applied_at DESC)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS convention_patterns (
          id TEXT PRIMARY KEY,
          master_user_id TEXT NOT NULL,
          pattern_text TEXT NOT NULL,
          pattern_section TEXT NOT NULL DEFAULT 'gotchas',
          category TEXT NOT NULL DEFAULT 'gotcha',
          framework_tags TEXT NOT NULL DEFAULT '[]',
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          applies_to_count INTEGER NOT NULL DEFAULT 0,
          confidence REAL NOT NULL DEFAULT 0.5,
          embedding_id TEXT,
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          retired_at TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_patterns_user ON convention_patterns(master_user_id, retired_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_patterns_occur ON convention_patterns(occurrence_count DESC)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS convention_pattern_sources (
          pattern_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          lesson_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (pattern_id, project_id, lesson_id)
        )
      `, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS convention_violations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          package_path TEXT NOT NULL DEFAULT '',
          convention_section TEXT NOT NULL,
          convention_excerpt TEXT NOT NULL,
          session_id TEXT,
          violated_at TEXT NOT NULL,
          resolved_anyway INTEGER NOT NULL DEFAULT 0,
          manual_override INTEGER NOT NULL DEFAULT 0,
          detection_source TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_violations_project ON convention_violations(project_id, package_path, violated_at DESC)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS convention_test_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          conventions_version_hash TEXT NOT NULL,
          canonical_task_id TEXT NOT NULL,
          stack TEXT NOT NULL,
          with_conventions INTEGER NOT NULL,
          outcome_passed INTEGER NOT NULL,
          outcome_details TEXT,
          fix_attempts INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          ran_at TEXT NOT NULL
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_testruns_task ON convention_test_runs(canonical_task_id, ran_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_conv_testruns_proj ON convention_test_runs(project_id, ran_at DESC)`, []);
    },
  },
  {
    version: 104,
    description: 'v834 — Per-Project Settings-Overrides für Agent-Conventions (PG-Spiegel zu SQLite v100).',
    async up(db) {
      try { await db.execute(`ALTER TABLE agent_conventions ADD COLUMN config_overrides TEXT NOT NULL DEFAULT '{}'`, []); } catch { /* exists */ }
    },
  },
  {
    version: 105,
    description: 'v847 — project_chat_actions: tracking-table für Chat-getriggerte Skill-Arbeit (PG-Spiegel zu SQLite v101).',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_chat_actions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          conversation_id TEXT,
          user_id TEXT NOT NULL,
          request_text TEXT NOT NULL,
          response_text TEXT,
          skills_called TEXT NOT NULL DEFAULT '[]',
          total_skill_count INTEGER NOT NULL DEFAULT 0,
          total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          total_duration_ms BIGINT NOT NULL DEFAULT 0,
          commit_shas TEXT NOT NULL DEFAULT '[]',
          modified_files TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','error')),
          started_at TEXT NOT NULL,
          ended_at TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_actions_project ON project_chat_actions(project_id, started_at DESC)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_actions_running ON project_chat_actions(status, started_at DESC) WHERE status='running'`, []);
    },
  },
  {
    version: 106,
    description: 'v849 — projects.sandbox_mode + persist_db_volumes für Multi-Service Compose-Stack Support (PG-Spiegel zu SQLite v102).',
    async up(db) {
      try { await db.execute(`ALTER TABLE projects ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'single' CHECK (sandbox_mode IN ('single','compose'))`, []); } catch { /* exists */ }
      try { await db.execute(`ALTER TABLE projects ADD COLUMN persist_db_volumes BOOLEAN NOT NULL DEFAULT FALSE`, []); } catch { /* exists */ }
      try { await db.execute(`ALTER TABLE projects ADD COLUMN db_seed_strategy TEXT NOT NULL DEFAULT 'first-start-only' CHECK (db_seed_strategy IN ('none','first-start-only','every-start'))`, []); } catch { /* exists */ }
    },
  },
  {
    version: 107,
    description: 'v851 — project_features + project_feature_history für Cross-Project Knowledge Transfer (PG-Spiegel zu SQLite v103).',
    async up(db) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_features (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          tech_stack TEXT NOT NULL DEFAULT '[]',
          source_files TEXT NOT NULL DEFAULT '[]',
          git_sha_introduced TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','role-shared','global')),
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual','imported')),
          status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','rejected')),
          embedding_id TEXT,
          derived_from_feature_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          retired_at TEXT,
          UNIQUE (project_id, name)
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_features_project ON project_features(project_id, retired_at)`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_features_visibility ON project_features(visibility, retired_at) WHERE retired_at IS NULL`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_features_pending ON project_features(status, project_id) WHERE status='pending'`, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_features_user ON project_features(user_id, retired_at)`, []);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS project_feature_history (
          id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL REFERENCES project_features(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          archived_at TEXT NOT NULL,
          archived_reason TEXT
        )
      `, []);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_feature_history_feature ON project_feature_history(feature_id, version DESC)`, []);
    },
  },
];
