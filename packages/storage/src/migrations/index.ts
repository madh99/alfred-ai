export { Migrator } from './migrator.js';
export type { Migration } from './migrator.js';

import type { Migration } from './migrator.js';

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema — conversations, messages, users, audit_log',
    up(_db) {
      // This is the initial schema that Database already creates.
      // Keep it here for documentation and future reference.
      // The actual table creation is already handled by Database constructor.
      // This migration is marked as "applied" retroactively.
    },
  },
  {
    version: 2,
    description: 'Add plugin_skills table for tracking loaded external plugins',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_skills (
          name TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          version TEXT NOT NULL,
          loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
          enabled INTEGER NOT NULL DEFAULT 1
        )
      `);
    },
  },
  {
    version: 3,
    description: 'Add memories and reminders tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'general',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, key)
        );

        CREATE INDEX IF NOT EXISTS idx_memories_user
          ON memories(user_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_memories_user_category
          ON memories(user_id, category);

        CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message TEXT NOT NULL,
          trigger_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          fired INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_due
          ON reminders(fired, trigger_at);

        CREATE INDEX IF NOT EXISTS idx_reminders_user
          ON reminders(user_id, fired);
      `);
    },
  },
  {
    version: 4,
    description: 'Add notes table for persistent note storage',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notes_user
          ON notes(user_id, updated_at DESC);
      `);
    },
  },
  {
    version: 5,
    description: 'Add user profile fields (timezone, language, bio, preferences)',
    up(db) {
      db.exec(`
        ALTER TABLE users ADD COLUMN timezone TEXT;
        ALTER TABLE users ADD COLUMN language TEXT;
        ALTER TABLE users ADD COLUMN bio TEXT;
        ALTER TABLE users ADD COLUMN preferences TEXT;
      `);
    },
  },
  {
    version: 6,
    description: 'Add embeddings table for semantic search',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_embeddings_user
          ON embeddings(user_id);

        CREATE INDEX IF NOT EXISTS idx_embeddings_source
          ON embeddings(source_type, source_id);
      `);
    },
  },
  {
    version: 7,
    description: 'Background tasks table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS background_tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          description TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          skill_input TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
      `);
    },
  },
  {
    version: 8,
    description: 'Scheduled actions for proactive behavior',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_actions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          skill_input TEXT NOT NULL,
          prompt_template TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    description: 'Cross-platform user linking',
    up(db) {
      db.exec(`
        ALTER TABLE users ADD COLUMN master_user_id TEXT REFERENCES users(id);

        CREATE TABLE IF NOT EXISTS link_tokens (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_link_tokens_code ON link_tokens(code);
      `);
    },
  },
  {
    version: 10,
    description: 'Document intelligence tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS document_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id),
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding_id TEXT REFERENCES embeddings(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON document_chunks(document_id);
      `);
    },
  },
  {
    version: 11,
    description: 'Active learning: memory metadata (type, confidence, source, access tracking)',
    up(db) {
      db.exec(`
        ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'general';
        ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
        ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
        ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;
        ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type);
        CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(user_id, confidence DESC);
      `);
    },
  },
  {
    version: 12,
    description: 'Add ON DELETE CASCADE to messages and document_chunks, add missing indexes',
    up(db) {
      db.exec(`
        -- Recreate messages table with ON DELETE CASCADE
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_calls TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO messages_new SELECT * FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
          ON messages(conversation_id, created_at);

        -- Recreate document_chunks table with ON DELETE CASCADE
        CREATE TABLE document_chunks_new (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding_id TEXT REFERENCES embeddings(id),
          created_at TEXT NOT NULL
        );
        INSERT INTO document_chunks_new SELECT * FROM document_chunks;
        DROP TABLE document_chunks;
        ALTER TABLE document_chunks_new RENAME TO document_chunks;
        CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON document_chunks(document_id);

        -- Add missing indexes
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts ON audit_log(user_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_background_tasks_user ON background_tasks(user_id);
      `);
    },
  },
  {
    version: 13,
    description: 'Add todos table for todo list management',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          list TEXT NOT NULL DEFAULT 'default',
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT NOT NULL DEFAULT 'normal',
          due_date TEXT,
          completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_todos_user_list
          ON todos(user_id, list, completed, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_todos_user_due
          ON todos(user_id, completed, due_date);
      `);
    },
  },
  {
    version: 14,
    description: 'Document deduplication: content_hash + cleanup broken documents',
    up(db) {
      db.exec(`
        ALTER TABLE documents ADD COLUMN content_hash TEXT;
        CREATE INDEX IF NOT EXISTS idx_documents_user_hash ON documents(user_id, content_hash);
      `);

      // Clean up broken documents (chunk_count = 0) from FK bug:
      // embedAndStore succeeded but addChunk failed → orphaned embeddings
      const brokenDocs = db.prepare(
        "SELECT id FROM documents WHERE chunk_count = 0"
      ).all() as { id: string }[];
      for (const doc of brokenDocs) {
        db.prepare(
          "DELETE FROM embeddings WHERE source_type = 'document' AND source_id LIKE ? || ':%'"
        ).run(doc.id);
      }
      db.exec(`
        DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE chunk_count = 0);
        DELETE FROM documents WHERE chunk_count = 0;
      `);
    },
  },
  {
    version: 15,
    description: 'Watches table for condition-based alerts',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS watches (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          name TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          skill_params TEXT NOT NULL DEFAULT '{}',
          condition_field TEXT NOT NULL,
          condition_operator TEXT NOT NULL,
          condition_value TEXT,
          interval_minutes INTEGER NOT NULL DEFAULT 15,
          cooldown_minutes INTEGER NOT NULL DEFAULT 30,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_checked_at TEXT,
          last_triggered_at TEXT,
          last_value TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          message_template TEXT
        );
        CREATE INDEX idx_watches_chat ON watches(chat_id, platform);
        CREATE INDEX idx_watches_enabled ON watches(enabled);
      `);
    },
  },
  {
    version: 16,
    description: 'Running conversation summaries for long conversations',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_summaries (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_user_message TEXT,
          last_assistant_message TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 17,
    description: 'LLM usage tracking with daily aggregation',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          UNIQUE(date, model)
        );
        CREATE INDEX IF NOT EXISTS idx_llm_usage_date ON llm_usage(date);
      `);
    },
  },
  {
    version: 18,
    description: 'Watch actions — skill execution on trigger',
    up(db) {
      db.exec(`
        ALTER TABLE watches ADD COLUMN action_skill_name TEXT DEFAULT NULL;
        ALTER TABLE watches ADD COLUMN action_skill_params TEXT DEFAULT NULL;
        ALTER TABLE watches ADD COLUMN action_on_trigger TEXT NOT NULL DEFAULT 'alert';
        ALTER TABLE watches ADD COLUMN last_action_error TEXT DEFAULT NULL;
      `);
    },
  },
  {
    version: 19,
    description: 'Composite watch conditions (AND/OR)',
    up(db) {
      db.exec(`
        ALTER TABLE watches ADD COLUMN conditions_json TEXT DEFAULT NULL;
      `);
    },
  },
  {
    version: 20,
    description: 'Calendar notification dedup table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_notifications (
          event_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          notified_at TEXT NOT NULL,
          event_start TEXT NOT NULL,
          PRIMARY KEY (event_id, chat_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cal_notif_cleanup ON calendar_notifications(event_start);
      `);
    },
  },
  {
    version: 21,
    description: 'Human-in-the-loop confirmation queue for watch actions',
    up(db) {
      db.exec(`
        ALTER TABLE watches ADD COLUMN requires_confirmation INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE IF NOT EXISTS pending_confirmations (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          description TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          skill_params TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_conf ON pending_confirmations(chat_id, platform, status);
      `);
    },
  },
  {
    version: 22,
    description: 'Activity log for comprehensive audit trail',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT,
          user_id TEXT,
          platform TEXT,
          chat_id TEXT,
          action TEXT NOT NULL,
          outcome TEXT NOT NULL,
          error_message TEXT,
          duration_ms INTEGER,
          details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type, timestamp);
        CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source, source_id);
        CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, timestamp);
      `);
    },
  },
  {
    version: 23,
    description: 'Skill health tracking for self-healing',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_health (
          skill_name TEXT PRIMARY KEY,
          success_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          consecutive_fails INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_error_at TEXT,
          disabled_until TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 24,
    description: 'Workflow chains and executions',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_chains (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          steps TEXT NOT NULL,
          trigger_type TEXT NOT NULL DEFAULT 'manual',
          trigger_config TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_chains_user ON workflow_chains(user_id);
        CREATE INDEX IF NOT EXISTS idx_workflow_chains_chat ON workflow_chains(chat_id, platform);

        CREATE TABLE IF NOT EXISTS workflow_executions (
          id TEXT PRIMARY KEY,
          chain_id TEXT NOT NULL REFERENCES workflow_chains(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running',
          steps_completed INTEGER NOT NULL DEFAULT 0,
          total_steps INTEGER NOT NULL,
          step_results TEXT,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_exec_chain ON workflow_executions(chain_id);
      `);
    },
  },
  {
    version: 25,
    description: 'Persistent agent checkpoint/resume support',
    up(db) {
      db.exec(`
        ALTER TABLE background_tasks ADD COLUMN agent_state TEXT DEFAULT NULL;
        ALTER TABLE background_tasks ADD COLUMN checkpoint_at TEXT DEFAULT NULL;
        ALTER TABLE background_tasks ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE background_tasks ADD COLUMN max_duration_hours REAL DEFAULT NULL;
      `);
    },
  },
  {
    version: 26,
    description: 'Memory TTL — optional expiration for short-lived memories',
    up(db) {
      db.exec(`ALTER TABLE memories ADD COLUMN expires_at TEXT DEFAULT NULL`);
      db.exec(`CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL`);
    },
  },
  {
    version: 27,
    description: 'Watch Chains — trigger_watch_id for chained watch execution',
    up(db) {
      db.exec(`ALTER TABLE watches ADD COLUMN trigger_watch_id TEXT DEFAULT NULL`);
    },
  },
  {
    version: 28,
    description: 'Feedback Loop — feedback_events table for rejection/correction tracking',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          feedback_type TEXT NOT NULL,
          source_id TEXT,
          context_key TEXT NOT NULL,
          description TEXT NOT NULL,
          raw_context TEXT,
          occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_events_user_key ON feedback_events(user_id, context_key, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_feedback_events_user_type ON feedback_events(user_id, feedback_type, occurred_at DESC);
      `);
    },
  },
  {
    version: 29,
    description: 'Project Agent — session tracking table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_agent_sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE,
          goal TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          current_phase TEXT NOT NULL DEFAULT 'planning',
          current_iteration INTEGER NOT NULL DEFAULT 0,
          total_files_changed INTEGER NOT NULL DEFAULT 0,
          last_build_passed INTEGER NOT NULL DEFAULT 0,
          last_commit_sha TEXT,
          last_progress_at TEXT,
          milestones TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_project_sessions_task ON project_agent_sessions(task_id);
      `);
    },
  },
  {
    version: 30,
    description: 'Database Skill — connection storage',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS database_connections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER,
          database_name TEXT,
          username TEXT,
          auth_config TEXT,
          options TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 31,
    description: 'Multi-User — users, user_services, user_platform_links tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alfred_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'user',
          display_name TEXT,
          invite_code TEXT,
          invite_expires_at TEXT,
          created_by TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          settings TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_alfred_users_username ON alfred_users(username);
        CREATE INDEX IF NOT EXISTS idx_alfred_users_invite ON alfred_users(invite_code) WHERE invite_code IS NOT NULL;

        CREATE TABLE IF NOT EXISTS user_services (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES alfred_users(id) ON DELETE CASCADE,
          service_type TEXT NOT NULL,
          service_name TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, service_type, service_name)
        );
        CREATE INDEX IF NOT EXISTS idx_user_services_user ON user_services(user_id);

        CREATE TABLE IF NOT EXISTS user_platform_links (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES alfred_users(id) ON DELETE CASCADE,
          platform TEXT NOT NULL,
          platform_user_id TEXT NOT NULL,
          linked_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(platform, platform_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_platform_links_platform ON user_platform_links(platform, platform_user_id);
      `);
    },
  },
  {
    version: 32,
    description: 'Multi-User — per-user LLM usage tracking',
    up(db) {
      db.exec(`ALTER TABLE llm_usage ADD COLUMN user_id TEXT DEFAULT NULL`);
    },
  },
  {
    version: 33,
    description: 'Multi-User — shared resources (todos, db connections)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shared_resources (
          id TEXT PRIMARY KEY,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          shared_with_user_id TEXT,
          shared_with_group_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(resource_type, resource_id, shared_with_user_id),
          UNIQUE(resource_type, resource_id, shared_with_group_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shared_resources_user ON shared_resources(shared_with_user_id);
        CREATE INDEX IF NOT EXISTS idx_shared_resources_group ON shared_resources(shared_with_group_id);

        ALTER TABLE database_connections ADD COLUMN user_id TEXT DEFAULT NULL;
        ALTER TABLE database_connections ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 34,
    description: 'Multi-User — document visibility (private/shared/public)',
    up(db) {
      db.exec(`ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
    },
  },
  {
    version: 35,
    description: 'Multi-User — separate per-user usage table (fixes double-counting)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_usage_by_user (
          date TEXT NOT NULL,
          user_id TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (date, user_id, model)
        );
        DELETE FROM llm_usage WHERE date LIKE '%:%';
      `);
    },
  },
  {
    version: 36,
    description: 'HA Active-Active: claim columns, processed_messages, node_heartbeats, adapter_claims, reasoning_slots',
    up(db) {
      db.exec(`ALTER TABLE reminders ADD COLUMN claimed_by TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE reminders ADD COLUMN claim_expires_at TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE scheduled_actions ADD COLUMN claimed_by TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE scheduled_actions ADD COLUMN claim_expires_at TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE watches ADD COLUMN claimed_by TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE watches ADD COLUMN claim_expires_at TEXT DEFAULT NULL`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_messages (
          message_key TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_messages_expires ON processed_messages(expires_at)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_heartbeats (
          node_id TEXT PRIMARY KEY,
          host TEXT NOT NULL DEFAULT '',
          last_seen_at TEXT NOT NULL,
          started_at TEXT NOT NULL,
          uptime_s INTEGER NOT NULL DEFAULT 0,
          adapters TEXT NOT NULL DEFAULT '[]',
          version TEXT NOT NULL DEFAULT ''
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS reasoning_slots (
          slot_key TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS adapter_claims (
          platform TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 37,
    description: 'Watch owner — user_id column for correct skill context resolution',
    up(db) {
      db.exec(`ALTER TABLE watches ADD COLUMN user_id TEXT DEFAULT NULL`);
    },
  },
  {
    version: 38,
    description: 'Thread/Topic routing for watches and scheduled actions',
    up(db) {
      db.exec(`ALTER TABLE watches ADD COLUMN thread_id TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE scheduled_actions ADD COLUMN thread_id TEXT DEFAULT NULL`);
    },
  },
  {
    version: 39,
    description: 'Project agent interjection inbox in DB for HA',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS project_agent_interjections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_interjections_task ON project_agent_interjections(task_id)`);
    },
  },
  {
    version: 40,
    description: 'Recipe favorites and meal plans',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS recipe_favorites (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_recipe_fav_user ON recipe_favorites(user_id)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_fav_unique ON recipe_favorites(user_id, recipe_id)`);

      db.exec(`CREATE TABLE IF NOT EXISTS meal_plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week TEXT NOT NULL,
        day TEXT NOT NULL,
        meal TEXT NOT NULL,
        recipe_id TEXT,
        source TEXT,
        title TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_meal_plan_user_week ON meal_plans(user_id, week)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_plan_slot ON meal_plans(user_id, week, day, meal)`);
    },
  },
  {
    version: 41,
    description: 'Travel plans and plan items',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS travel_plans (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_travel_plan_user ON travel_plans(user_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_travel_plan_status ON travel_plans(user_id, status)`);

      db.exec(`CREATE TABLE IF NOT EXISTS travel_plan_items (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_travel_item_plan ON travel_plan_items(plan_id)`);
    },
  },
  {
    version: 42,
    description: 'Watch quiet hours — suppresses alerts during defined time windows',
    up(db) {
      db.exec(`ALTER TABLE watches ADD COLUMN quiet_hours_start TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE watches ADD COLUMN quiet_hours_end TEXT DEFAULT NULL`);
    },
  },
  {
    version: 43,
    description: 'Skill state table — separates transient skill data from semantic memories',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_state (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          skill TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT DEFAULT NULL,
          UNIQUE(user_id, skill, key)
        );
        CREATE INDEX IF NOT EXISTS idx_skill_state_user_skill ON skill_state(user_id, skill);
      `);

      // Migrate feed entries
      db.exec(`
        INSERT OR IGNORE INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'feed_reader', key, value, updated_at FROM memories WHERE category = 'feed'
      `);

      // Migrate sonos entries
      db.exec(`
        INSERT OR IGNORE INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'sonos', key, value, updated_at FROM memories WHERE category = 'sonos'
      `);

      // Migrate voice entries
      db.exec(`
        INSERT OR IGNORE INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'voice', key, value, updated_at FROM memories WHERE category = 'voice'
      `);

      // Migrate insight_tracker_stats (key transformed: insight_tracker_stats → stats)
      db.exec(`
        INSERT OR IGNORE INTO skill_state (id, user_id, skill, key, value, updated_at)
        SELECT id, user_id, 'insight_tracker', 'stats', value, updated_at FROM memories WHERE key = 'insight_tracker_stats'
      `);

      // Cleanup migrated entries from memories
      db.exec(`DELETE FROM memories WHERE category IN ('feed', 'sonos', 'voice')`);
      db.exec(`DELETE FROM memories WHERE key = 'insight_tracker_stats'`);
    },
  },
  {
    version: 44,
    description: 'Knowledge Graph — persistent entities and relations',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kg_entities (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          attributes TEXT DEFAULT '{}',
          sources TEXT DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.5,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          mention_count INTEGER NOT NULL DEFAULT 1,
          UNIQUE(user_id, entity_type, normalized_name)
        );
        CREATE INDEX IF NOT EXISTS idx_kg_entities_user ON kg_entities(user_id);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(user_id, entity_type);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(user_id, normalized_name);

        CREATE TABLE IF NOT EXISTS kg_relations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
          target_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          strength REAL NOT NULL DEFAULT 0.5,
          context TEXT,
          source_section TEXT,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          mention_count INTEGER NOT NULL DEFAULT 1,
          UNIQUE(user_id, source_entity_id, target_entity_id, relation_type)
        );
        CREATE INDEX IF NOT EXISTS idx_kg_relations_source ON kg_relations(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_target ON kg_relations(target_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_user ON kg_relations(user_id);
      `);
    },
  },
  {
    version: 45,
    description: 'BMW telematic log — persists MQTT + REST data for cross-node access and history',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bmw_telematic_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          vin TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'rest',
          telematic_data TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bmw_telematic_user_vin ON bmw_telematic_log(user_id, vin, created_at);
      `);
    },
  },
  {
    version: 46,
    description: 'Service usage — tracks non-token costs (STT, TTS, OCR, Moderation)',
    up(db) {
      db.exec(`
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
        );
        CREATE INDEX IF NOT EXISTS idx_service_usage_date ON service_usage(date);
      `);
    },
  },
  {
    version: 47,
    description: 'Deferred insights — smart delivery timing for reasoning insights',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deferred_insights (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          urgency TEXT NOT NULL DEFAULT 'normal',
          message TEXT NOT NULL,
          actions TEXT DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          stale_at TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_deferred_insights_pending ON deferred_insights(chat_id, delivered, stale_at);
      `);
    },
  },
  {
    version: 48,
    description: 'Brainstorming sessions and items',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS brainstorming_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          context TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_brainstorm_user ON brainstorming_sessions(user_id, status);

        CREATE TABLE IF NOT EXISTS brainstorming_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES brainstorming_sessions(id) ON DELETE CASCADE,
          phase TEXT NOT NULL DEFAULT 'ideas',
          category TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          linked_entity_id TEXT,
          linked_action_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_brainstorm_items_session ON brainstorming_items(session_id);
      `);
    },
  },
  {
    version: 49,
    description: 'CMDB assets, relations, changes, incidents, services, change requests',
    up(db) {
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_assets_user ON cmdb_assets(user_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_assets_type ON cmdb_assets(asset_type);
        CREATE INDEX IF NOT EXISTS idx_cmdb_assets_status ON cmdb_assets(status);
        CREATE INDEX IF NOT EXISTS idx_cmdb_assets_ip ON cmdb_assets(ip_address);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cmdb_assets_source ON cmdb_assets(user_id, source_skill, source_id);

        CREATE TABLE IF NOT EXISTS cmdb_asset_relations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_asset_id TEXT NOT NULL REFERENCES cmdb_assets(id) ON DELETE CASCADE,
          target_asset_id TEXT NOT NULL REFERENCES cmdb_assets(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          auto_discovered INTEGER NOT NULL DEFAULT 0,
          attributes TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_rel_source ON cmdb_asset_relations(source_asset_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_rel_target ON cmdb_asset_relations(target_asset_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cmdb_rel_unique ON cmdb_asset_relations(user_id, source_asset_id, target_asset_id, relation_type);

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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_changes_asset ON cmdb_changes(asset_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_changes_created ON cmdb_changes(created_at);
        CREATE INDEX IF NOT EXISTS idx_cmdb_changes_type ON cmdb_changes(change_type);

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
          opened_at TEXT NOT NULL DEFAULT (datetime('now')),
          acknowledged_at TEXT,
          resolved_at TEXT,
          closed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_user_status ON cmdb_incidents(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_severity ON cmdb_incidents(severity);
        CREATE INDEX IF NOT EXISTS idx_cmdb_incidents_created ON cmdb_incidents(created_at);

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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_services_user ON cmdb_services(user_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_services_health ON cmdb_services(health_status);
        CREATE INDEX IF NOT EXISTS idx_cmdb_services_category ON cmdb_services(category);

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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_cr_user_status ON cmdb_change_requests(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_cmdb_cr_type ON cmdb_change_requests(type);
        CREATE INDEX IF NOT EXISTS idx_cmdb_cr_scheduled ON cmdb_change_requests(scheduled_at);
      `);
    },
  },
  {
    version: 50,
    description: 'CMDB documents archive + incidents postmortem column',
    up(db) {
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_docs_user ON cmdb_documents(user_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_docs_entity ON cmdb_documents(linked_entity_type, linked_entity_id);
        CREATE INDEX IF NOT EXISTS idx_cmdb_docs_type ON cmdb_documents(doc_type);
        CREATE INDEX IF NOT EXISTS idx_cmdb_docs_created ON cmdb_documents(created_at);
      `);
      // ALTER TABLE ADD COLUMN is not idempotent in SQLite — wrap in try-catch
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN postmortem TEXT`); } catch { /* column already exists */ }
    },
  },
  {
    version: 51,
    description: 'Service components + health_reason on cmdb_services',
    up(db) {
      try { db.exec(`ALTER TABLE cmdb_services ADD COLUMN components TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_services ADD COLUMN health_reason TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 52,
    description: 'Add investigation_notes to cmdb_incidents',
    up(db) {
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN investigation_notes TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 53,
    description: 'Add lessons_learned, action_items to cmdb_incidents',
    up(db) {
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN lessons_learned TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN action_items TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 54,
    description: 'Problem Management — cmdb_problems + problem_id on incidents + linked_problem_id on changes',
    up(db) {
      db.exec(`
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
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          analyzed_at TEXT,
          root_cause_identified_at TEXT,
          resolved_at TEXT,
          closed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cmdb_problems_user_status ON cmdb_problems(user_id, status);
      `);
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN problem_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_change_requests ADD COLUMN linked_problem_id TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 55,
    description: 'Autonomous Planning — plans table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          steps TEXT NOT NULL DEFAULT '[]',
          current_step_index INTEGER NOT NULL DEFAULT 0,
          context TEXT NOT NULL DEFAULT '{}',
          trigger_source TEXT NOT NULL DEFAULT 'reasoning',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_user_status ON plans(user_id, status)`);
    },
  },
  {
    version: 56,
    description: 'SLA Management — sla columns + sla_events table',
    up(db) {
      try { db.exec(`ALTER TABLE cmdb_services ADD COLUMN sla TEXT DEFAULT NULL`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_assets ADD COLUMN sla TEXT DEFAULT NULL`); } catch { /* exists */ }
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sla_events_target ON sla_events(target_type, target_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_sla_events_type ON sla_events(event_type);
      `);
    },
  },
  {
    version: 57,
    description: 'Project Agent — interjections consumed column',
    up(db) {
      try { db.exec(`ALTER TABLE project_agent_interjections ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_interjections_consumed ON project_agent_interjections(task_id, consumed)`);
    },
  },
  {
    version: 58,
    description: 'Memories — relevant_until + source_event_refs columns for correction lifecycle',
    up(db) {
      try { db.exec(`ALTER TABLE memories ADD COLUMN relevant_until TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE memories ADD COLUMN source_event_refs TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_relevant_until ON memories(user_id, relevant_until) WHERE relevant_until IS NOT NULL`);
    },
  },
  {
    version: 59,
    description: 'Messages — FTS5 full-text search index with auto-sync triggers',
    up(db) {
      // FTS5 virtual table — content-less external-content mode so the data lives in
      // `messages` and FTS only stores the inverted index. Saves space + keeps writes
      // atomic via the triggers below.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          conversation_id UNINDEXED,
          role UNINDEXED,
          content='messages',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      // Backfill existing rows
      db.exec(`INSERT INTO messages_fts(rowid, content, conversation_id, role)
               SELECT rowid, content, conversation_id, role FROM messages
               WHERE rowid NOT IN (SELECT rowid FROM messages_fts)`);
      // Keep FTS in sync on INSERT/UPDATE/DELETE
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content, conversation_id, role)
          VALUES (new.rowid, new.content, new.conversation_id, new.role);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role)
          VALUES ('delete', old.rowid, old.content, old.conversation_id, old.role);
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role)
          VALUES ('delete', old.rowid, old.content, old.conversation_id, old.role);
          INSERT INTO messages_fts(rowid, content, conversation_id, role)
          VALUES (new.rowid, new.content, new.conversation_id, new.role);
        END;
      `);
    },
  },
  {
    version: 61,
    description: 'Watches + scheduled_actions — consecutive_failures counter for auto-repair',
    up(db) {
      try { db.exec(`ALTER TABLE watches ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE watches ADD COLUMN last_repair_at TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE scheduled_actions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE scheduled_actions ADD COLUMN last_repair_at TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 60,
    description: 'Runbooks — captured operational procedures from incidents/sessions/chats',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runbooks_user_status ON runbooks(user_id, status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runbooks_source ON runbooks(source_type, source_id)`);
    },
  },
  {
    version: 62,
    description: 'Projects — long-lived containers for project-agent/code-agent/delegate sessions + open items + decisions',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_cwd ON projects(cwd)`);
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_sessions_project ON project_sessions(project_id, started_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_sessions_source ON project_sessions(session_type, source_id)`);
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_open_items_project_status ON project_open_items(project_id, status)`);
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_project ON project_decisions(project_id, created_at DESC)`);
    },
  },
  {
    version: 63,
    description: 'Projects — health-check log for git/build/deps/http probes per project',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_health_log_project ON project_health_log(project_id, checked_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_health_log_probe ON project_health_log(project_id, probe, checked_at DESC)`);
    },
  },
  {
    version: 64,
    description: 'Workflows + project_open_items — auto-extraction columns, auto_run flag, ITSM cross-linking',
    up(db) {
      try { db.exec(`ALTER TABLE workflow_chains ADD COLUMN source_session_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE workflow_chains ADD COLUMN related_runbook_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE workflow_chains ADD COLUMN auto_extracted INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE workflow_chains ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE workflow_chains ADD COLUMN description TEXT`); } catch { /* exists */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_chains_source ON workflow_chains(source_session_id)`); } catch { /* exists */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_chains_name ON workflow_chains(user_id, name)`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN linked_incident_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN linked_change_id TEXT`); } catch { /* exists */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_open_items_linked_incident ON project_open_items(linked_incident_id)`); } catch { /* exists */ }
    },
  },
  {
    version: 65,
    description: 'Skill-Pattern-Memory — host-specific skill failures (v607 D7)',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_host_failures_skill ON skill_host_failures(skill_name, host)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_host_failures_last ON skill_host_failures(last_seen DESC)`);
    },
  },
  {
    version: 66,
    description: 'Host capabilities — persisted facts per (host,user) like compose variant (v608 F6)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS host_capabilities (
          host TEXT NOT NULL,
          user_name TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          probed_at TEXT NOT NULL,
          PRIMARY KEY (host, user_name, key)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_host_capabilities_host ON host_capabilities(host)`);
    },
  },
  {
    version: 67,
    description: 'v633 T3 — Incident recurrence_count + cmdb_metric_samples for capacity-forecast',
    up(db) {
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN recurrence_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_incidents ADD COLUMN last_recurrence_at TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE cmdb_change_requests ADD COLUMN pr_url TEXT`); } catch { /* exists */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS cmdb_metric_samples (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          asset_id TEXT,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT,
          sampled_at TEXT NOT NULL,
          source TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_metric_samples_asset_metric_time ON cmdb_metric_samples(asset_id, metric_name, sampled_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_metric_samples_user_time ON cmdb_metric_samples(user_id, sampled_at DESC)`);
    },
  },
  {
    version: 68,
    description: 'v634 T4 — Service-Cascade observations for cross-service-dependency learning',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cmdb_service_cascades (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          observed_count INTEGER NOT NULL DEFAULT 1,
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          avg_delay_minutes REAL NOT NULL DEFAULT 0,
          UNIQUE(user_id, source_service_id, target_service_id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_service_cascades_source ON cmdb_service_cascades(user_id, source_service_id)`);
    },
  },
  {
    version: 69,
    description: 'v638 — alfred_insights table for cross-domain Insight-Engine',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alfred_insights (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_insights_user_status_created ON alfred_insights(user_id, status, created_at DESC)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_dedupe_unique ON alfred_insights(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_insights_category ON alfred_insights(user_id, category, status)`);
    },
  },
  {
    version: 70,
    description: 'v639 — alfred_goals + alfred_goal_checkpoints for Goal-Tracker',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_user_status ON alfred_goals(user_id, status)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS alfred_goal_checkpoints (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          status TEXT,
          evidence TEXT,
          notes TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal ON alfred_goal_checkpoints(goal_id, checked_at DESC)`);
    },
  },
  {
    version: 71,
    description: 'v640 — kg_questions table for question-generator with ignore-learning',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_kg_questions_user_status ON kg_questions(user_id, status, asked_at DESC)`);
    },
  },
  {
    version: 72,
    description: 'v641 — project_open_items.auto_resolved_by for OpenItemMatcher attribution',
    up(db) {
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN auto_resolved_by TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN auto_resolved_confidence REAL`); } catch { /* exists */ }
    },
  },
  {
    version: 73,
    description: 'v643 — project_agent_commits + session.last_push_url + project.default_branch',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_commits_session ON project_agent_commits(session_id, committed_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_commits_project ON project_agent_commits(project_id, committed_at DESC)`);
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN last_push_url TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN default_branch TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 74,
    description: 'v644 — conversations: pinned_at, custom_label, deleted_at, branched_from for lifecycle ops',
    up(db) {
      try { db.exec(`ALTER TABLE conversations ADD COLUMN pinned_at TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE conversations ADD COLUMN custom_label TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE conversations ADD COLUMN deleted_at TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE conversations ADD COLUMN branched_from_conversation_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE conversations ADD COLUMN branched_at_message_id TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_lifecycle ON conversations(user_id, pinned_at, updated_at DESC)`);
    },
  },
  {
    version: 75,
    description: 'v648 — project_agent_plans + sessions.resumed_from_task_id for Resume-Foundation',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_plans_session ON project_agent_plans(session_id, phase_idx)`);
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN resumed_from_task_id TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 76,
    description: 'v652 — Project-Agent Smart: failure_insight + auto_resume_count + lessons',
    up(db) {
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN failure_insight TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_agent_lessons (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          pattern TEXT NOT NULL,
          advice TEXT NOT NULL,
          occurrences INTEGER NOT NULL DEFAULT 1,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_lessons_cwd ON project_agent_lessons(cwd, last_seen_at DESC)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pa_lessons_cwd_pattern ON project_agent_lessons(cwd, pattern)`);
    },
  },
  {
    version: 77,
    description: 'v656 — llm_usage_hourly für stundenweise Darstellung (Retention 62 Tage, Lokalzeit)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_usage_hourly (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hour_bucket TEXT NOT NULL,
          model TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          UNIQUE(hour_bucket, model)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_usage_hourly_bucket ON llm_usage_hourly(hour_bucket)`);
    },
  },
  {
    version: 78,
    description: 'v657 — pending_confirmations.extra_actions für Multi-Action-Buttons (Open-Item-Eskalation u.a.)',
    up(db) {
      try { db.exec(`ALTER TABLE pending_confirmations ADD COLUMN extra_actions TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 79,
    description: 'v658 — conversations.project_id für Projekt-Chat (eigene Conversation pro Projekt mit Kontext-Injection)',
    up(db) {
      try { db.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)`);
    },
  },
  {
    version: 80,
    description: 'v663a — projects.conventions (README/CHANGELOG/Versioning) + project_open_items roadmap-Felder',
    up(db) {
      try { db.exec(`ALTER TABLE projects ADD COLUMN conventions TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN roadmap_milestone TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN roadmap_order INTEGER`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN estimated_hours REAL`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_open_items_roadmap ON project_open_items(project_id, roadmap_milestone, roadmap_order)`);
    },
  },
  {
    version: 81,
    description: 'v663b — project_automations Tabelle für Templates (Standup, Release-Pflege, etc.)',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_automations_project ON project_automations(project_id, enabled)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_automations_next ON project_automations(next_run_at, enabled)`);
    },
  },
  {
    version: 82,
    description: 'v665a — projects storage_type/share_id/node_id/locked_by_node_id/locked_until für Cluster-Shares + Project-Lock',
    up(db) {
      try { db.exec(`ALTER TABLE projects ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'local'`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN share_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN node_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN locked_by_node_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN locked_until TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_share ON projects(share_id, storage_type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_locks ON projects(locked_by_node_id, locked_until)`);
    },
  },
  {
    version: 83,
    description: 'v670 — todo_notes: Arbeitsnotizen/Fortschritte pro Todo (mit Verlauf + Timestamps)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS todo_notes (
          id TEXT PRIMARY KEY,
          todo_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_notes_todo ON todo_notes(todo_id, created_at DESC)`);
    },
  },
  {
    version: 84,
    description: 'v671 — Spiegel-Link Todo ↔ Project-Open-Item (bidirektionale Referenz)',
    up(db) {
      try { db.exec(`ALTER TABLE todos ADD COLUMN linked_project_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE todos ADD COLUMN linked_open_item_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE project_open_items ADD COLUMN linked_todo_id TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_linked_open_item ON todos(linked_open_item_id) WHERE linked_open_item_id IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_open_items_linked_todo ON project_open_items(linked_todo_id) WHERE linked_todo_id IS NOT NULL`);
    },
  },
  {
    version: 85,
    description: 'v672 — todo_note_links: Many-to-many Verknüpfung zwischen Todos und Notes',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS todo_note_links (
          todo_id TEXT NOT NULL,
          note_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (todo_id, note_id),
          FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_note_links_note ON todo_note_links(note_id)`);
    },
  },
  {
    version: 86,
    description: 'v673 — generische attachments-Tabelle für Todos + Notes (Documents, Files, URLs, Uploads)',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC)`);
    },
  },
  {
    version: 87,
    description: 'v696 — Project-Agent Sandbox + Live-Preview Foundation (opt-in, kein User-Verhalten ohne Aktivierung)',
    up(db) {
      // Sandbox-State pro Session (oder project-level für zukünftige Erweiterungen)
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandboxes_session ON project_agent_sandboxes(session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandboxes_active ON project_agent_sandboxes(status, last_active_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandboxes_project ON project_agent_sandboxes(project_id, status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandboxes_user ON project_agent_sandboxes(user_id, status)`);

      // Session-Mode (default 'classic' für ALLE existierenden + neuen Sessions).
      // Werte: 'classic' | 'sandbox' | 'sandbox-preview' | 'interactive-chat'
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'classic'`); } catch { /* exists */ }

      // Project-Level Defaults (NULL = Global-Setting verwenden)
      try { db.exec(`ALTER TABLE projects ADD COLUMN sandbox_default_mode TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN merge_strategy TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 88,
    description: 'v703 — sandbox_chat_messages: persistente Chat-History pro Sandbox für Interactive-Mode',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandbox_chat_sandbox ON sandbox_chat_messages(sandbox_id, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sandbox_chat_task ON sandbox_chat_messages(task_id)`);
    },
  },
  {
    version: 89,
    description: 'v721 — sandbox_id auf project_agent_sessions damit Interactive-Chat-Tasks zum Original-Project bind statt Ghost-Project zu erzeugen',
    up(db) {
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN sandbox_id TEXT`); } catch { /* exists */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_sandbox ON project_agent_sessions(sandbox_id)`);
    },
  },
  {
    version: 90,
    description: 'v722 — learned_recipes: maschinen-lesbare Recipes statt prosaischer Auto-Rules',
    up(db) {
      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_user ON learned_recipes(user_id, invalidated_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_confidence ON learned_recipes(user_id, confidence DESC, success_count DESC)`);
    },
  },
  {
    version: 91,
    description: 'v726 — project_environments + project_db_seeds für Sandbox/Deploy-ENV-Management',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_environments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          vars_encrypted BLOB NOT NULL,
          iv BLOB NOT NULL,
          auth_tag BLOB NOT NULL,
          encryption_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, stage)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_environments_project ON project_environments(project_id)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_db_seeds (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          storage_ref TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_db_seeds_project ON project_db_seeds(project_id)`);
      try { db.exec(`ALTER TABLE projects ADD COLUMN default_env_stage TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE projects ADD COLUMN default_db_seed_id TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 92,
    description: 'v731 — mentioned_item_ids auf project_agent_sessions (Auto-Done-Mark nach Run)',
    up(db) {
      try { db.exec(`ALTER TABLE project_agent_sessions ADD COLUMN mentioned_item_ids TEXT`); } catch { /* exists */ }
    },
  },
];
