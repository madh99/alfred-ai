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
];
