/**
 * PostgreSQL schema creation.
 * Creates all tables that the SQLite migrations create, but in PostgreSQL syntax.
 * This is used when initializing a fresh PostgreSQL database for HA cluster.
 */

export const PG_SCHEMA = `
-- Conversations & Messages
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- Users & Auth
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  profile TEXT,
  timezone TEXT,
  language TEXT,
  bio TEXT,
  preferences TEXT,
  master_user_id TEXT REFERENCES users(id),
  UNIQUE(platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS linked_users (
  id TEXT PRIMARY KEY,
  master_user_id TEXT NOT NULL,
  linked_user_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  UNIQUE(linked_user_id)
);

-- Memory & Embeddings
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  confidence REAL NOT NULL DEFAULT 1.0,
  type TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'manual',
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(user_id, confidence DESC);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BYTEA NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);

-- Plugin Skills
CREATE TABLE IF NOT EXISTS plugin_skills (
  name TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  version TEXT NOT NULL,
  loaded_at TEXT NOT NULL DEFAULT NOW(),
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Reminders, Notes, Todos
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message TEXT NOT NULL,
  trigger_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT DEFAULT NULL,
  claim_expires_at TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired, trigger_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, fired);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_todos_user_list ON todos(user_id, list, completed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_user_due ON todos(user_id, completed, due_date);

-- Documents & RAG
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user_hash ON documents(user_id, content_hash);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON document_chunks(document_id);

-- Watches & Automation
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
  created_at TEXT NOT NULL,
  message_template TEXT,
  action_skill_name TEXT,
  action_skill_params TEXT,
  action_on_trigger TEXT NOT NULL DEFAULT 'alert',
  last_action_error TEXT,
  conditions_json TEXT,
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  trigger_watch_id TEXT,
  claimed_by TEXT DEFAULT NULL,
  claim_expires_at TEXT DEFAULT NULL,
  user_id TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id, platform);
CREATE INDEX IF NOT EXISTS idx_watches_enabled ON watches(enabled);

-- Scheduled Actions
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
  created_at TEXT NOT NULL,
  claimed_by TEXT DEFAULT NULL,
  claim_expires_at TEXT DEFAULT NULL
);

-- Background Tasks
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
  completed_at TEXT,
  agent_state TEXT,
  checkpoint_at TEXT,
  resume_count INTEGER NOT NULL DEFAULT 0,
  max_duration_hours REAL
);
CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
CREATE INDEX IF NOT EXISTS idx_background_tasks_user ON background_tasks(user_id);

-- Usage & Activity Tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  user_id TEXT,
  PRIMARY KEY (date, model)
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_date ON llm_usage(date);

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

-- Security & Audit
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  risk_level TEXT,
  rule_id TEXT,
  effect TEXT,
  platform TEXT,
  chat_id TEXT,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts ON audit_log(user_id, timestamp);

-- Confirmations
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

-- Summaries
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_user_message TEXT,
  last_assistant_message TEXT,
  updated_at TEXT NOT NULL
);

-- Calendar Notifications
CREATE TABLE IF NOT EXISTS calendar_notifications (
  event_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  event_start TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (event_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_cal_notif_cleanup ON calendar_notifications(event_start);

-- Skill Health
CREATE TABLE IF NOT EXISTS skill_health (
  skill_name TEXT PRIMARY KEY,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TEXT,
  disabled_until TEXT,
  updated_at TEXT NOT NULL DEFAULT NOW()
);

-- Workflows
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
  created_at TEXT NOT NULL DEFAULT NOW()
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
  started_at TEXT NOT NULL DEFAULT NOW(),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_exec_chain ON workflow_executions(chain_id);

-- Feedback
CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  source_id TEXT,
  context_key TEXT NOT NULL,
  description TEXT NOT NULL,
  raw_context TEXT,
  occurred_at TEXT NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_events_user_key ON feedback_events(user_id, context_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_events_user_type ON feedback_events(user_id, feedback_type, occurred_at DESC);

-- Multi-User
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
  created_at TEXT NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alfred_users_username ON alfred_users(username);

CREATE TABLE IF NOT EXISTS user_services (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES alfred_users(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  service_name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, service_type, service_name)
);
CREATE INDEX IF NOT EXISTS idx_user_services_user ON user_services(user_id);

CREATE TABLE IF NOT EXISTS user_platform_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES alfred_users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_platform_links_platform ON user_platform_links(platform, platform_user_id);

-- Shared Resources
CREATE TABLE IF NOT EXISTS shared_resources (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  shared_with_user_id TEXT,
  shared_with_group_id TEXT,
  created_at TEXT NOT NULL DEFAULT NOW(),
  UNIQUE(resource_type, resource_id, shared_with_user_id),
  UNIQUE(resource_type, resource_id, shared_with_group_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_resources_user ON shared_resources(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_shared_resources_group ON shared_resources(shared_with_group_id);

-- Database Connections
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
  user_id TEXT,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT NOW()
);

-- Project Agent Sessions
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
  created_at TEXT NOT NULL DEFAULT NOW(),
  updated_at TEXT NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_sessions_task ON project_agent_sessions(task_id);

-- Link tokens
CREATE TABLE IF NOT EXISTS link_tokens (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_tokens_code ON link_tokens(code);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version (version) VALUES (36) ON CONFLICT DO NOTHING;

-- HA Active-Active tables
CREATE TABLE IF NOT EXISTS processed_messages (
  message_key  TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_messages_expires ON processed_messages(expires_at);

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
);
`;
