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
];
