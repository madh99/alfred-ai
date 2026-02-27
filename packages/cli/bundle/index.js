#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../config/dist/schema.js
import { z } from "zod";
var TelegramConfigSchema, DiscordConfigSchema, WhatsAppConfigSchema, MatrixConfigSchema, SignalConfigSchema, StorageConfigSchema, LoggerConfigSchema, SecurityConfigSchema, LLMProviderConfigSchema, SearchConfigSchema, EmailConfigSchema, SpeechConfigSchema, AlfredConfigSchema;
var init_schema = __esm({
  "../config/dist/schema.js"() {
    "use strict";
    TelegramConfigSchema = z.object({
      token: z.string().default(""),
      enabled: z.boolean()
    });
    DiscordConfigSchema = z.object({
      token: z.string().default(""),
      enabled: z.boolean()
    });
    WhatsAppConfigSchema = z.object({
      enabled: z.boolean(),
      dataPath: z.string()
    });
    MatrixConfigSchema = z.object({
      homeserverUrl: z.string(),
      accessToken: z.string().default(""),
      userId: z.string().default(""),
      enabled: z.boolean()
    });
    SignalConfigSchema = z.object({
      apiUrl: z.string(),
      phoneNumber: z.string().default(""),
      enabled: z.boolean()
    });
    StorageConfigSchema = z.object({
      path: z.string()
    });
    LoggerConfigSchema = z.object({
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
      pretty: z.boolean(),
      auditLogPath: z.string().optional()
    });
    SecurityConfigSchema = z.object({
      rulesPath: z.string(),
      defaultEffect: z.enum(["allow", "deny"]),
      ownerUserId: z.string().optional()
    });
    LLMProviderConfigSchema = z.object({
      provider: z.enum(["anthropic", "openai", "openrouter", "ollama"]),
      apiKey: z.string().default(""),
      baseUrl: z.string().optional(),
      model: z.string(),
      temperature: z.number().optional(),
      maxTokens: z.number().optional()
    });
    SearchConfigSchema = z.object({
      provider: z.enum(["brave", "searxng", "tavily", "duckduckgo"]),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional()
    });
    EmailConfigSchema = z.object({
      imap: z.object({
        host: z.string(),
        port: z.number(),
        secure: z.boolean()
      }),
      smtp: z.object({
        host: z.string(),
        port: z.number(),
        secure: z.boolean()
      }),
      auth: z.object({
        user: z.string(),
        pass: z.string()
      })
    });
    SpeechConfigSchema = z.object({
      provider: z.enum(["openai", "groq"]),
      apiKey: z.string(),
      baseUrl: z.string().optional()
    });
    AlfredConfigSchema = z.object({
      name: z.string(),
      telegram: TelegramConfigSchema,
      discord: DiscordConfigSchema.optional(),
      whatsapp: WhatsAppConfigSchema.optional(),
      matrix: MatrixConfigSchema.optional(),
      signal: SignalConfigSchema.optional(),
      llm: LLMProviderConfigSchema,
      storage: StorageConfigSchema,
      logger: LoggerConfigSchema,
      security: SecurityConfigSchema,
      search: SearchConfigSchema.optional(),
      email: EmailConfigSchema.optional(),
      speech: SpeechConfigSchema.optional()
    });
  }
});

// ../config/dist/defaults.js
var DEFAULT_CONFIG;
var init_defaults = __esm({
  "../config/dist/defaults.js"() {
    "use strict";
    DEFAULT_CONFIG = {
      name: "Alfred",
      telegram: {
        token: "",
        enabled: false
      },
      discord: {
        token: "",
        enabled: false
      },
      whatsapp: {
        enabled: false,
        dataPath: "./data/whatsapp"
      },
      matrix: {
        homeserverUrl: "https://matrix.org",
        accessToken: "",
        userId: "",
        enabled: false
      },
      signal: {
        apiUrl: "http://localhost:8080",
        phoneNumber: "",
        enabled: false
      },
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.7,
        maxTokens: 4096
      },
      storage: {
        path: "./data/alfred.db"
      },
      logger: {
        level: "info",
        pretty: true
      },
      security: {
        rulesPath: "./config/rules",
        defaultEffect: "deny"
      }
    };
  }
});

// ../config/dist/loader.js
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import yaml from "js-yaml";
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (sourceVal !== null && sourceVal !== void 0 && typeof sourceVal === "object" && !Array.isArray(sourceVal) && targetVal !== null && targetVal !== void 0 && typeof targetVal === "object" && !Array.isArray(targetVal)) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
function applyEnvOverrides(config) {
  const result = { ...config };
  for (const [envVar, keyPath] of Object.entries(ENV_MAP)) {
    const value = process.env[envVar];
    if (value === void 0)
      continue;
    let current = result;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      if (current[key] === void 0 || current[key] === null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current[key] = { ...current[key] };
      current = current[key];
    }
    current[keyPath[keyPath.length - 1]] = value;
  }
  return result;
}
var ENV_MAP, ConfigLoader;
var init_loader = __esm({
  "../config/dist/loader.js"() {
    "use strict";
    init_schema();
    init_defaults();
    ENV_MAP = {
      ALFRED_TELEGRAM_TOKEN: ["telegram", "token"],
      ALFRED_DISCORD_TOKEN: ["discord", "token"],
      ALFRED_MATRIX_HOMESERVER_URL: ["matrix", "homeserverUrl"],
      ALFRED_MATRIX_ACCESS_TOKEN: ["matrix", "accessToken"],
      ALFRED_MATRIX_USER_ID: ["matrix", "userId"],
      ALFRED_SIGNAL_API_URL: ["signal", "apiUrl"],
      ALFRED_SIGNAL_PHONE_NUMBER: ["signal", "phoneNumber"],
      ALFRED_ANTHROPIC_API_KEY: ["llm", "apiKey"],
      ALFRED_OPENAI_API_KEY: ["llm", "apiKey"],
      ALFRED_OPENROUTER_API_KEY: ["llm", "apiKey"],
      ALFRED_LLM_PROVIDER: ["llm", "provider"],
      ALFRED_LLM_MODEL: ["llm", "model"],
      ALFRED_LLM_BASE_URL: ["llm", "baseUrl"],
      ALFRED_STORAGE_PATH: ["storage", "path"],
      ALFRED_LOG_LEVEL: ["logger", "level"],
      ALFRED_OWNER_USER_ID: ["security", "ownerUserId"],
      ALFRED_SEARCH_PROVIDER: ["search", "provider"],
      ALFRED_SEARCH_API_KEY: ["search", "apiKey"],
      ALFRED_SEARCH_BASE_URL: ["search", "baseUrl"],
      ALFRED_EMAIL_USER: ["email", "auth", "user"],
      ALFRED_EMAIL_PASS: ["email", "auth", "pass"],
      ALFRED_SPEECH_PROVIDER: ["speech", "provider"],
      ALFRED_SPEECH_API_KEY: ["speech", "apiKey"],
      ALFRED_SPEECH_BASE_URL: ["speech", "baseUrl"]
    };
    ConfigLoader = class {
      loadConfig(configPath) {
        loadDotenv();
        const resolvedPath = configPath ?? process.env["ALFRED_CONFIG_PATH"] ?? "./config/default.yml";
        let fileConfig = {};
        const absolutePath = path.resolve(resolvedPath);
        if (fs.existsSync(absolutePath)) {
          const raw = fs.readFileSync(absolutePath, "utf-8");
          const parsed = yaml.load(raw);
          if (parsed && typeof parsed === "object") {
            fileConfig = parsed;
          }
        }
        const merged = deepMerge(DEFAULT_CONFIG, fileConfig);
        const withEnv = applyEnvOverrides(merged);
        const validated = AlfredConfigSchema.parse(withEnv);
        return validated;
      }
    };
  }
});

// ../config/dist/index.js
var init_dist = __esm({
  "../config/dist/index.js"() {
    "use strict";
    init_schema();
    init_defaults();
    init_loader();
  }
});

// ../logger/dist/logger.js
import pino from "pino";
function createLogger(name, level) {
  const logLevel = level ?? process.env.LOG_LEVEL ?? "info";
  const usePretty = logLevel === "debug" || logLevel === "trace" || process.env.NODE_ENV !== "production";
  if (usePretty) {
    const transport = pino.transport({
      target: "pino-pretty",
      options: { colorize: true }
    });
    return pino({ name, level: logLevel }, transport);
  }
  return pino({ name, level: logLevel });
}
var init_logger = __esm({
  "../logger/dist/logger.js"() {
    "use strict";
  }
});

// ../logger/dist/audit.js
import pino2 from "pino";
var init_audit = __esm({
  "../logger/dist/audit.js"() {
    "use strict";
  }
});

// ../logger/dist/index.js
var init_dist2 = __esm({
  "../logger/dist/index.js"() {
    "use strict";
    init_logger();
    init_audit();
  }
});

// ../storage/dist/migrations/migrator.js
var Migrator;
var init_migrator = __esm({
  "../storage/dist/migrations/migrator.js"() {
    "use strict";
    Migrator = class {
      db;
      constructor(db) {
        this.db = db;
        this.ensureMigrationsTable();
      }
      ensureMigrationsTable() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at TEXT NOT NULL
      )
    `);
      }
      /** Get current schema version */
      getCurrentVersion() {
        const row = this.db.prepare("SELECT MAX(version) as version FROM _migrations").get();
        return row?.version ?? 0;
      }
      /** Run all pending migrations */
      migrate(migrations) {
        const sorted = [...migrations].sort((a, b) => a.version - b.version);
        const currentVersion = this.getCurrentVersion();
        for (const migration of sorted) {
          if (migration.version <= currentVersion) {
            continue;
          }
          const run = this.db.transaction(() => {
            migration.up(this.db);
            this.db.prepare("INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.description, (/* @__PURE__ */ new Date()).toISOString());
          });
          run();
        }
      }
      /** Get list of applied migrations */
      getAppliedMigrations() {
        const rows = this.db.prepare("SELECT version, applied_at FROM _migrations ORDER BY version ASC").all();
        return rows.map((row) => ({
          version: row.version,
          appliedAt: row.applied_at
        }));
      }
    };
  }
});

// ../storage/dist/migrations/index.js
var MIGRATIONS;
var init_migrations = __esm({
  "../storage/dist/migrations/index.js"() {
    "use strict";
    init_migrator();
    MIGRATIONS = [
      {
        version: 1,
        description: "Initial schema \u2014 conversations, messages, users, audit_log",
        up(_db) {
        }
      },
      {
        version: 2,
        description: "Add plugin_skills table for tracking loaded external plugins",
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
        }
      },
      {
        version: 3,
        description: "Add memories and reminders tables",
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
        }
      },
      {
        version: 4,
        description: "Add notes table for persistent note storage",
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
        }
      }
    ];
  }
});

// ../storage/dist/database.js
import BetterSqlite3 from "better-sqlite3";
import fs2 from "node:fs";
import path2 from "node:path";
var Database;
var init_database = __esm({
  "../storage/dist/database.js"() {
    "use strict";
    init_migrator();
    init_migrations();
    Database = class {
      db;
      constructor(dbPath) {
        const dir = path2.dirname(dbPath);
        fs2.mkdirSync(dir, { recursive: true });
        this.db = new BetterSqlite3(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
        this.runMigrations();
      }
      initTables() {
        this.db.exec(`
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
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        rule_id TEXT,
        effect TEXT NOT NULL,
        platform TEXT NOT NULL,
        chat_id TEXT,
        context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_platform_chat
        ON conversations(platform, chat_id);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_users_platform
        ON users(platform, platform_user_id);
    `);
      }
      runMigrations() {
        const migrator = new Migrator(this.db);
        migrator.migrate(MIGRATIONS);
      }
      getDb() {
        return this.db;
      }
      close() {
        this.db.close();
      }
    };
  }
});

// ../storage/dist/repositories/conversation-repository.js
import crypto from "node:crypto";
var ConversationRepository;
var init_conversation_repository = __esm({
  "../storage/dist/repositories/conversation-repository.js"() {
    "use strict";
    ConversationRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      create(platform, chatId, userId) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const conversation = {
          id: crypto.randomUUID(),
          platform,
          chatId,
          userId,
          createdAt: now,
          updatedAt: now
        };
        this.db.prepare(`
      INSERT INTO conversations (id, platform, chat_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversation.id, conversation.platform, conversation.chatId, conversation.userId, conversation.createdAt, conversation.updatedAt);
        return conversation;
      }
      findById(id) {
        const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
        if (!row)
          return void 0;
        return this.mapRow(row);
      }
      findByPlatformChat(platform, chatId) {
        const row = this.db.prepare("SELECT * FROM conversations WHERE platform = ? AND chat_id = ?").get(platform, chatId);
        if (!row)
          return void 0;
        return this.mapRow(row);
      }
      addMessage(conversationId, role, content, toolCalls) {
        const message = {
          id: crypto.randomUUID(),
          conversationId,
          role,
          content,
          toolCalls,
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.id, message.conversationId, message.role, message.content, message.toolCalls ?? null, message.createdAt);
        return message;
      }
      getMessages(conversationId, limit = 50) {
        const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?").all(conversationId, limit);
        return rows.map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          role: row.role,
          content: row.content,
          toolCalls: row.tool_calls ?? void 0,
          createdAt: row.created_at
        }));
      }
      updateTimestamp(id) {
        this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), id);
      }
      mapRow(row) {
        return {
          id: row.id,
          platform: row.platform,
          chatId: row.chat_id,
          userId: row.user_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
    };
  }
});

// ../storage/dist/repositories/user-repository.js
import crypto2 from "node:crypto";
var UserRepository;
var init_user_repository = __esm({
  "../storage/dist/repositories/user-repository.js"() {
    "use strict";
    UserRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      findOrCreate(platform, platformUserId, username, displayName) {
        const existing = this.db.prepare("SELECT * FROM users WHERE platform = ? AND platform_user_id = ?").get(platform, platformUserId);
        if (existing) {
          return this.mapRow(existing);
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const user = {
          id: crypto2.randomUUID(),
          platform,
          platformUserId,
          username,
          displayName,
          createdAt: now,
          updatedAt: now
        };
        this.db.prepare(`
      INSERT INTO users (id, platform, platform_user_id, username, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.platform, user.platformUserId, user.username ?? null, user.displayName ?? null, user.createdAt, user.updatedAt);
        return user;
      }
      findById(id) {
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        if (!row)
          return void 0;
        return this.mapRow(row);
      }
      update(id, data) {
        const fields = [];
        const values = [];
        if (data.username !== void 0) {
          fields.push("username = ?");
          values.push(data.username ?? null);
        }
        if (data.displayName !== void 0) {
          fields.push("display_name = ?");
          values.push(data.displayName ?? null);
        }
        if (fields.length === 0)
          return;
        fields.push("updated_at = ?");
        values.push((/* @__PURE__ */ new Date()).toISOString());
        values.push(id);
        this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      }
      mapRow(row) {
        return {
          id: row.id,
          platform: row.platform,
          platformUserId: row.platform_user_id,
          username: row.username ?? void 0,
          displayName: row.display_name ?? void 0,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
    };
  }
});

// ../storage/dist/repositories/audit-repository.js
var AuditRepository;
var init_audit_repository = __esm({
  "../storage/dist/repositories/audit-repository.js"() {
    "use strict";
    AuditRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      log(entry) {
        this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, user_id, action, risk_level, rule_id, effect, platform, chat_id, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.timestamp.toISOString(), entry.userId, entry.action, entry.riskLevel, entry.ruleId ?? null, entry.effect, entry.platform, entry.chatId ?? null, entry.context ? JSON.stringify(entry.context) : null);
      }
      query(filters) {
        const conditions = [];
        const values = [];
        if (filters.userId) {
          conditions.push("user_id = ?");
          values.push(filters.userId);
        }
        if (filters.action) {
          conditions.push("action = ?");
          values.push(filters.action);
        }
        if (filters.effect) {
          conditions.push("effect = ?");
          values.push(filters.effect);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = filters.limit ?? 100;
        values.push(limit);
        const rows = this.db.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`).all(...values);
        return rows.map((row) => this.mapRow(row));
      }
      count(filters) {
        const conditions = [];
        const values = [];
        if (filters.userId) {
          conditions.push("user_id = ?");
          values.push(filters.userId);
        }
        if (filters.effect) {
          conditions.push("effect = ?");
          values.push(filters.effect);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const row = this.db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...values);
        return row.count;
      }
      mapRow(row) {
        return {
          id: row.id,
          timestamp: new Date(row.timestamp),
          userId: row.user_id,
          action: row.action,
          riskLevel: row.risk_level,
          ruleId: row.rule_id ?? void 0,
          effect: row.effect,
          platform: row.platform,
          chatId: row.chat_id ?? void 0,
          context: row.context ? JSON.parse(row.context) : void 0
        };
      }
    };
  }
});

// ../storage/dist/repositories/memory-repository.js
import { randomUUID } from "node:crypto";
var MemoryRepository;
var init_memory_repository = __esm({
  "../storage/dist/repositories/memory-repository.js"() {
    "use strict";
    MemoryRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      save(userId, key, value, category = "general") {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const existing = this.db.prepare("SELECT id FROM memories WHERE user_id = ? AND key = ?").get(userId, key);
        if (existing) {
          this.db.prepare("UPDATE memories SET value = ?, category = ?, updated_at = ? WHERE id = ?").run(value, category, now, existing.id);
          return {
            id: existing.id,
            userId,
            key,
            value,
            category,
            createdAt: this.db.prepare("SELECT created_at FROM memories WHERE id = ?").get(existing.id).created_at,
            updatedAt: now
          };
        }
        const id = randomUUID();
        this.db.prepare("INSERT INTO memories (id, user_id, key, value, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, userId, key, value, category, now, now);
        return { id, userId, key, value, category, createdAt: now, updatedAt: now };
      }
      recall(userId, key) {
        const row = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND key = ?").get(userId, key);
        if (!row)
          return void 0;
        return this.mapRow(row);
      }
      search(userId, query) {
        const pattern = `%${query}%`;
        const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC").all(userId, pattern, pattern);
        return rows.map((row) => this.mapRow(row));
      }
      listByCategory(userId, category) {
        const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC").all(userId, category);
        return rows.map((row) => this.mapRow(row));
      }
      listAll(userId) {
        const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC").all(userId);
        return rows.map((row) => this.mapRow(row));
      }
      delete(userId, key) {
        const result = this.db.prepare("DELETE FROM memories WHERE user_id = ? AND key = ?").run(userId, key);
        return result.changes > 0;
      }
      getRecentForPrompt(userId, limit = 20) {
        const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(userId, limit);
        return rows.map((row) => this.mapRow(row));
      }
      mapRow(row) {
        return {
          id: row.id,
          userId: row.user_id,
          key: row.key,
          value: row.value,
          category: row.category,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
    };
  }
});

// ../storage/dist/repositories/reminder-repository.js
import { randomUUID as randomUUID2 } from "node:crypto";
var ReminderRepository;
var init_reminder_repository = __esm({
  "../storage/dist/repositories/reminder-repository.js"() {
    "use strict";
    ReminderRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      create(userId, platform, chatId, message, triggerAt) {
        const entry = {
          id: randomUUID2(),
          userId,
          platform,
          chatId,
          message,
          triggerAt: triggerAt.toISOString(),
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          fired: false
        };
        this.db.prepare(`
      INSERT INTO reminders (id, user_id, platform, chat_id, message, trigger_at, created_at, fired)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.userId, entry.platform, entry.chatId, entry.message, entry.triggerAt, entry.createdAt, 0);
        return entry;
      }
      getDue() {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const rows = this.db.prepare(`SELECT * FROM reminders WHERE fired = 0 AND trigger_at <= ? ORDER BY trigger_at ASC`).all(now);
        return rows.map((row) => this.mapRow(row));
      }
      getByUser(userId) {
        const rows = this.db.prepare(`SELECT * FROM reminders WHERE fired = 0 AND user_id = ? ORDER BY trigger_at ASC`).all(userId);
        return rows.map((row) => this.mapRow(row));
      }
      markFired(id) {
        this.db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`).run(id);
      }
      cancel(id) {
        const result = this.db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
        return result.changes > 0;
      }
      mapRow(row) {
        return {
          id: row.id,
          userId: row.user_id,
          platform: row.platform,
          chatId: row.chat_id,
          message: row.message,
          triggerAt: row.trigger_at,
          createdAt: row.created_at,
          fired: row.fired === 1
        };
      }
    };
  }
});

// ../storage/dist/repositories/note-repository.js
import { randomUUID as randomUUID3 } from "node:crypto";
var NoteRepository;
var init_note_repository = __esm({
  "../storage/dist/repositories/note-repository.js"() {
    "use strict";
    NoteRepository = class {
      db;
      constructor(db) {
        this.db = db;
      }
      save(userId, title, content) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const id = randomUUID3();
        this.db.prepare("INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, title, content, now, now);
        return { id, userId, title, content, createdAt: now, updatedAt: now };
      }
      getById(noteId) {
        const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
        return row ? this.mapRow(row) : void 0;
      }
      list(userId, limit = 50) {
        const rows = this.db.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(userId, limit);
        return rows.map((r) => this.mapRow(r));
      }
      search(userId, query) {
        const pattern = `%${query}%`;
        const rows = this.db.prepare("SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC").all(userId, pattern, pattern);
        return rows.map((r) => this.mapRow(r));
      }
      update(noteId, title, content) {
        const existing = this.getById(noteId);
        if (!existing)
          return void 0;
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const newTitle = title ?? existing.title;
        const newContent = content ?? existing.content;
        this.db.prepare("UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(newTitle, newContent, now, noteId);
        return { ...existing, title: newTitle, content: newContent, updatedAt: now };
      }
      delete(noteId) {
        const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
        return result.changes > 0;
      }
      mapRow(row) {
        return {
          id: row.id,
          userId: row.user_id,
          title: row.title,
          content: row.content,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
    };
  }
});

// ../storage/dist/index.js
var init_dist3 = __esm({
  "../storage/dist/index.js"() {
    "use strict";
    init_database();
    init_conversation_repository();
    init_user_repository();
    init_audit_repository();
    init_memory_repository();
    init_migrator();
    init_migrations();
    init_reminder_repository();
    init_note_repository();
  }
});

// ../llm/dist/provider.js
function lookupContextWindow(model) {
  if (KNOWN_CONTEXT_WINDOWS[model])
    return KNOWN_CONTEXT_WINDOWS[model];
  for (const [key, value] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (model.startsWith(key))
      return value;
  }
  return void 0;
}
var KNOWN_CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, LLMProvider;
var init_provider = __esm({
  "../llm/dist/provider.js"() {
    "use strict";
    KNOWN_CONTEXT_WINDOWS = {
      // Anthropic
      "claude-opus-4-20250514": { maxInputTokens: 2e5, maxOutputTokens: 32e3 },
      "claude-sonnet-4-20250514": { maxInputTokens: 2e5, maxOutputTokens: 16e3 },
      "claude-haiku-3-5-20241022": { maxInputTokens: 2e5, maxOutputTokens: 8192 },
      // OpenAI
      "gpt-4o": { maxInputTokens: 128e3, maxOutputTokens: 16384 },
      "gpt-4o-mini": { maxInputTokens: 128e3, maxOutputTokens: 16384 },
      "gpt-4-turbo": { maxInputTokens: 128e3, maxOutputTokens: 4096 },
      "gpt-4": { maxInputTokens: 8192, maxOutputTokens: 4096 },
      "gpt-3.5-turbo": { maxInputTokens: 16384, maxOutputTokens: 4096 },
      "o1": { maxInputTokens: 2e5, maxOutputTokens: 1e5 },
      "o1-mini": { maxInputTokens: 128e3, maxOutputTokens: 65536 },
      "o3-mini": { maxInputTokens: 2e5, maxOutputTokens: 1e5 },
      // Common Ollama models
      "llama3.2": { maxInputTokens: 128e3, maxOutputTokens: 4096 },
      "llama3.1": { maxInputTokens: 128e3, maxOutputTokens: 4096 },
      "llama3": { maxInputTokens: 8192, maxOutputTokens: 4096 },
      "mistral": { maxInputTokens: 32e3, maxOutputTokens: 4096 },
      "mistral-small": { maxInputTokens: 32e3, maxOutputTokens: 4096 },
      "mixtral": { maxInputTokens: 32e3, maxOutputTokens: 4096 },
      "gemma2": { maxInputTokens: 8192, maxOutputTokens: 4096 },
      "qwen2.5": { maxInputTokens: 128e3, maxOutputTokens: 4096 },
      "phi3": { maxInputTokens: 128e3, maxOutputTokens: 4096 },
      "deepseek-r1": { maxInputTokens: 128e3, maxOutputTokens: 8192 },
      "command-r": { maxInputTokens: 128e3, maxOutputTokens: 4096 }
    };
    DEFAULT_CONTEXT_WINDOW = { maxInputTokens: 8192, maxOutputTokens: 4096 };
    LLMProvider = class {
      config;
      contextWindow = DEFAULT_CONTEXT_WINDOW;
      constructor(config) {
        this.config = config;
      }
      getContextWindow() {
        return this.contextWindow;
      }
    };
  }
});

// ../llm/dist/providers/anthropic.js
import Anthropic from "@anthropic-ai/sdk";
var AnthropicProvider;
var init_anthropic = __esm({
  "../llm/dist/providers/anthropic.js"() {
    "use strict";
    init_provider();
    AnthropicProvider = class extends LLMProvider {
      client;
      constructor(config) {
        super(config);
      }
      async initialize() {
        this.client = new Anthropic({ apiKey: this.config.apiKey });
        const cw = lookupContextWindow(this.config.model);
        if (cw)
          this.contextWindow = cw;
      }
      async complete(request) {
        const messages = this.mapMessages(request.messages);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const params = {
          model: this.config.model,
          max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
          temperature: request.temperature ?? this.config.temperature,
          system: request.system,
          messages,
          tools
        };
        const response = await this.client.messages.create(params);
        return this.mapResponse(response);
      }
      async *stream(request) {
        const messages = this.mapMessages(request.messages);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const stream = this.client.messages.stream({
          model: this.config.model,
          max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
          temperature: request.temperature ?? this.config.temperature,
          system: request.system,
          messages,
          tools
        });
        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              yield {
                type: "tool_use_delta",
                toolCall: { input: event.delta.partial_json }
              };
            }
          } else if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              yield {
                type: "tool_use_start",
                toolCall: {
                  id: event.content_block.id,
                  name: event.content_block.name
                }
              };
            }
          } else if (event.type === "message_stop") {
            const finalMessage = await stream.finalMessage();
            yield {
              type: "message_complete",
              response: this.mapResponse(finalMessage)
            };
          }
        }
      }
      isAvailable() {
        return !!this.config.apiKey;
      }
      mapMessages(messages) {
        return messages.map((msg) => {
          if (typeof msg.content === "string") {
            return { role: msg.role, content: msg.content };
          }
          const blocks = msg.content.map((block) => {
            switch (block.type) {
              case "text":
                return { type: "text", text: block.text };
              case "image":
                return {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: block.source.media_type,
                    data: block.source.data
                  }
                };
              case "tool_use":
                return {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input
                };
              case "tool_result":
                return {
                  type: "tool_result",
                  tool_use_id: block.tool_use_id,
                  content: block.content,
                  is_error: block.is_error
                };
            }
          });
          return { role: msg.role, content: blocks };
        });
      }
      mapTools(tools) {
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema
        }));
      }
      mapResponse(response) {
        let textContent = "";
        const toolCalls = [];
        for (const block of response.content) {
          if (block.type === "text") {
            textContent += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              name: block.name,
              input: block.input
            });
          }
        }
        return {
          content: textContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens
          },
          stopReason: response.stop_reason
        };
      }
    };
  }
});

// ../llm/dist/providers/openai.js
import OpenAI from "openai";
var OpenAIProvider;
var init_openai = __esm({
  "../llm/dist/providers/openai.js"() {
    "use strict";
    init_provider();
    OpenAIProvider = class extends LLMProvider {
      client;
      constructor(config) {
        super(config);
      }
      async initialize() {
        this.client = new OpenAI({
          apiKey: this.config.apiKey,
          baseURL: this.config.baseUrl
        });
        const cw = lookupContextWindow(this.config.model);
        if (cw)
          this.contextWindow = cw;
      }
      async complete(request) {
        const messages = this.mapMessages(request.messages, request.system);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const params = {
          model: this.config.model,
          max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
          temperature: request.temperature ?? this.config.temperature,
          messages,
          ...tools ? { tools } : {}
        };
        const response = await this.client.chat.completions.create(params);
        return this.mapResponse(response);
      }
      async *stream(request) {
        const messages = this.mapMessages(request.messages, request.system);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const stream = await this.client.chat.completions.create({
          model: this.config.model,
          max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
          temperature: request.temperature ?? this.config.temperature,
          messages,
          ...tools ? { tools } : {},
          stream: true
        });
        let currentToolCallId;
        let currentToolCallName;
        let currentToolCallArgs = "";
        let fullContent = "";
        const toolCalls = [];
        let finishReason = null;
        let promptTokens = 0;
        let completionTokens = 0;
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice)
            continue;
          const delta = choice.delta;
          if (delta?.content) {
            fullContent += delta.content;
            yield { type: "text_delta", text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const toolCallDelta of delta.tool_calls) {
              if (toolCallDelta.id) {
                if (currentToolCallId) {
                  toolCalls.push({
                    id: currentToolCallId,
                    name: currentToolCallName,
                    input: JSON.parse(currentToolCallArgs || "{}")
                  });
                }
                currentToolCallId = toolCallDelta.id;
                currentToolCallName = toolCallDelta.function?.name;
                currentToolCallArgs = toolCallDelta.function?.arguments ?? "";
                yield {
                  type: "tool_use_start",
                  toolCall: {
                    id: currentToolCallId,
                    name: currentToolCallName
                  }
                };
              } else if (toolCallDelta.function?.arguments) {
                currentToolCallArgs += toolCallDelta.function.arguments;
                yield {
                  type: "tool_use_delta",
                  toolCall: {
                    input: toolCallDelta.function.arguments
                  }
                };
              }
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }
        if (currentToolCallId) {
          toolCalls.push({
            id: currentToolCallId,
            name: currentToolCallName,
            input: JSON.parse(currentToolCallArgs || "{}")
          });
        }
        yield {
          type: "message_complete",
          response: {
            content: fullContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
            usage: {
              inputTokens: promptTokens,
              outputTokens: completionTokens
            },
            stopReason: this.mapStopReason(finishReason)
          }
        };
      }
      isAvailable() {
        return !!this.config.apiKey;
      }
      mapMessages(messages, system) {
        const mapped = [];
        if (system) {
          mapped.push({ role: "system", content: system });
        }
        for (const msg of messages) {
          if (typeof msg.content === "string") {
            mapped.push({ role: msg.role, content: msg.content });
            continue;
          }
          const textParts = [];
          const toolUseParts = [];
          const toolResultParts = [];
          for (const block of msg.content) {
            switch (block.type) {
              case "text":
                textParts.push({ type: "text", text: block.text });
                break;
              case "image":
                textParts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`
                  }
                });
                break;
              case "tool_use":
                toolUseParts.push({
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input)
                  }
                });
                break;
              case "tool_result":
                toolResultParts.push({
                  tool_call_id: block.tool_use_id,
                  content: block.content
                });
                break;
            }
          }
          if (msg.role === "assistant" && toolUseParts.length > 0) {
            const textContent = textParts.map((p) => p.text).join("");
            mapped.push({
              role: "assistant",
              content: textContent || null,
              tool_calls: toolUseParts
            });
          } else if (toolResultParts.length > 0) {
            for (const result of toolResultParts) {
              mapped.push({
                role: "tool",
                tool_call_id: result.tool_call_id,
                content: result.content
              });
            }
          } else if (textParts.length > 0) {
            if (msg.role === "user") {
              mapped.push({ role: "user", content: textParts });
            } else {
              mapped.push({ role: msg.role, content: textParts.map((p) => p.text).join("") });
            }
          }
        }
        return mapped;
      }
      mapTools(tools) {
        return tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }));
      }
      mapResponse(response) {
        const choice = response.choices[0];
        const message = choice?.message;
        const content = message?.content ?? "";
        const toolCalls = message?.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        }));
        return {
          content,
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : void 0,
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0
          },
          stopReason: this.mapStopReason(choice?.finish_reason ?? null)
        };
      }
      mapStopReason(finishReason) {
        switch (finishReason) {
          case "stop":
            return "end_turn";
          case "tool_calls":
            return "tool_use";
          case "length":
            return "max_tokens";
          default:
            return "end_turn";
        }
      }
    };
  }
});

// ../llm/dist/providers/openrouter.js
var OpenRouterProvider;
var init_openrouter = __esm({
  "../llm/dist/providers/openrouter.js"() {
    "use strict";
    init_openai();
    OpenRouterProvider = class extends OpenAIProvider {
      constructor(config) {
        super({
          ...config,
          baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1"
        });
      }
      isAvailable() {
        return !!this.config.apiKey;
      }
    };
  }
});

// ../llm/dist/providers/ollama.js
var OllamaProvider;
var init_ollama = __esm({
  "../llm/dist/providers/ollama.js"() {
    "use strict";
    init_provider();
    OllamaProvider = class extends LLMProvider {
      baseUrl = "";
      constructor(config) {
        super(config);
      }
      apiKey = "";
      async initialize() {
        const raw = this.config.baseUrl ?? "http://localhost:11434";
        this.baseUrl = raw.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
        this.apiKey = this.config.apiKey ?? "";
        const cw = lookupContextWindow(this.config.model);
        if (cw) {
          this.contextWindow = cw;
        } else {
          await this.fetchModelContextWindow();
        }
      }
      async fetchModelContextWindow() {
        try {
          const res = await fetch(`${this.baseUrl}/api/show`, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify({ name: this.config.model })
          });
          if (!res.ok)
            return;
          const data = await res.json();
          const info = data.model_info ?? {};
          const ctxKey = Object.keys(info).find((k) => k.includes("context_length") || k === "num_ctx");
          const ctxLen = ctxKey ? Number(info[ctxKey]) : 0;
          if (ctxLen > 0) {
            this.contextWindow = {
              maxInputTokens: ctxLen,
              maxOutputTokens: Math.min(ctxLen, 4096)
            };
          }
        } catch {
        }
      }
      getHeaders() {
        const headers = { "Content-Type": "application/json" };
        if (this.apiKey) {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        return headers;
      }
      async complete(request) {
        const messages = this.buildMessages(request.messages, request.system);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const body = {
          model: this.config.model,
          messages,
          stream: false,
          options: this.buildOptions(request)
        };
        if (tools && tools.length > 0) {
          body.tools = tools;
        }
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Ollama API error (${res.status}): ${errorText}`);
        }
        const data = await res.json();
        return this.mapResponse(data);
      }
      async *stream(request) {
        const messages = this.buildMessages(request.messages, request.system);
        const tools = request.tools ? this.mapTools(request.tools) : void 0;
        const body = {
          model: this.config.model,
          messages,
          stream: true,
          options: this.buildOptions(request)
        };
        if (tools && tools.length > 0) {
          body.tools = tools;
        }
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Ollama API error (${res.status}): ${errorText}`);
        }
        if (!res.body) {
          throw new Error("Ollama streaming response has no body");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let promptEvalCount = 0;
        let evalCount = 0;
        const toolCalls = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed)
                continue;
              let chunk;
              try {
                chunk = JSON.parse(trimmed);
              } catch {
                continue;
              }
              if (chunk.message?.content) {
                fullContent += chunk.message.content;
                yield { type: "text_delta", text: chunk.message.content };
              }
              if (chunk.message?.tool_calls) {
                for (const tc of chunk.message.tool_calls) {
                  const toolCall = {
                    id: `ollama_tool_${toolCalls.length}`,
                    name: tc.function.name,
                    input: tc.function.arguments
                  };
                  toolCalls.push(toolCall);
                  yield {
                    type: "tool_use_start",
                    toolCall: { id: toolCall.id, name: toolCall.name }
                  };
                  yield {
                    type: "tool_use_delta",
                    toolCall: { input: toolCall.input }
                  };
                }
              }
              if (chunk.done) {
                promptEvalCount = chunk.prompt_eval_count ?? 0;
                evalCount = chunk.eval_count ?? 0;
                yield {
                  type: "message_complete",
                  response: {
                    content: fullContent,
                    toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
                    usage: {
                      inputTokens: promptEvalCount,
                      outputTokens: evalCount
                    },
                    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn"
                  }
                };
              }
            }
          }
          if (buffer.trim()) {
            let chunk;
            try {
              chunk = JSON.parse(buffer.trim());
            } catch {
              return;
            }
            if (chunk.message?.content) {
              fullContent += chunk.message.content;
              yield { type: "text_delta", text: chunk.message.content };
            }
            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                const toolCall = {
                  id: `ollama_tool_${toolCalls.length}`,
                  name: tc.function.name,
                  input: tc.function.arguments
                };
                toolCalls.push(toolCall);
                yield {
                  type: "tool_use_start",
                  toolCall: { id: toolCall.id, name: toolCall.name }
                };
                yield {
                  type: "tool_use_delta",
                  toolCall: { input: toolCall.input }
                };
              }
            }
            if (chunk.done) {
              promptEvalCount = chunk.prompt_eval_count ?? 0;
              evalCount = chunk.eval_count ?? 0;
              yield {
                type: "message_complete",
                response: {
                  content: fullContent,
                  toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
                  usage: {
                    inputTokens: promptEvalCount,
                    outputTokens: evalCount
                  },
                  stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn"
                }
              };
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      isAvailable() {
        try {
          return this.baseUrl.length > 0;
        } catch {
          return false;
        }
      }
      buildOptions(request) {
        const options = {};
        const temperature = request.temperature ?? this.config.temperature;
        if (temperature !== void 0) {
          options.temperature = temperature;
        }
        const maxTokens = request.maxTokens ?? this.config.maxTokens;
        if (maxTokens !== void 0) {
          options.num_predict = maxTokens;
        }
        return options;
      }
      buildMessages(messages, system) {
        const mapped = [];
        if (system) {
          mapped.push({ role: "system", content: system });
        }
        for (const msg of messages) {
          if (typeof msg.content === "string") {
            mapped.push({ role: msg.role, content: msg.content });
          } else {
            mapped.push(this.mapContentBlocks(msg.role, msg.content));
          }
        }
        return mapped;
      }
      mapContentBlocks(role, blocks) {
        const textParts = [];
        const images = [];
        for (const block of blocks) {
          switch (block.type) {
            case "text":
              textParts.push(block.text);
              break;
            case "image":
              images.push(block.source.data);
              break;
            case "tool_use":
              textParts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`);
              break;
            case "tool_result":
              textParts.push(`[Tool result for ${block.tool_use_id}]: ${block.content}`);
              break;
          }
        }
        const msg = { role, content: textParts.join("\n") };
        if (images.length > 0) {
          msg.images = images;
        }
        return msg;
      }
      mapTools(tools) {
        return tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }));
      }
      mapResponse(data) {
        const toolCalls = [];
        if (data.message.tool_calls) {
          for (const tc of data.message.tool_calls) {
            toolCalls.push({
              id: `ollama_tool_${toolCalls.length}`,
              name: tc.function.name,
              input: tc.function.arguments
            });
          }
        }
        return {
          content: data.message.content,
          toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
          usage: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0
          },
          stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn"
        };
      }
    };
  }
});

// ../llm/dist/provider-factory.js
function createLLMProvider(config) {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "openrouter":
      return new OpenRouterProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
var init_provider_factory = __esm({
  "../llm/dist/provider-factory.js"() {
    "use strict";
    init_anthropic();
    init_openai();
    init_openrouter();
    init_ollama();
  }
});

// ../llm/dist/prompt-builder.js
function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}
function estimateMessageTokens(msg) {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content) + 4;
  }
  let tokens = 4;
  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        tokens += estimateTokens(block.text);
        break;
      case "image":
        tokens += 1e3;
        break;
      case "tool_use":
        tokens += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
        break;
      case "tool_result":
        tokens += estimateTokens(block.content);
        break;
    }
  }
  return tokens;
}
var PromptBuilder;
var init_prompt_builder = __esm({
  "../llm/dist/prompt-builder.js"() {
    "use strict";
    PromptBuilder = class {
      buildSystemPrompt(memories, skills) {
        const os3 = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
        const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || "~";
        let prompt = `You are Alfred, a personal AI assistant. You run on ${os3} (home: ${homeDir}).

## Core principles
- ACT, don't just talk. When the user asks you to do something, USE YOUR TOOLS immediately. Never say "I could do X" \u2014 just do X.
- Respond in the same language the user writes in.
- Be concise. No filler text, no unnecessary explanations.
- If a tool fails or is denied, explain why and try an alternative approach.

## Multi-step reasoning
For complex tasks, work through multiple steps:
1. **Understand** what the user wants.
2. **Execute** using the right tools \u2014 chain multiple tool calls if needed.
3. **Continue** after each tool result. If the task isn't done, use the next tool. Don't stop after one call.
4. **Summarize** the final result clearly.

## Environment
- OS: ${os3}
- Home: ${homeDir}
- Documents: ${homeDir}/Documents
- Desktop: ${homeDir}/Desktop
- Downloads: ${homeDir}/Downloads`;
        if (skills && skills.length > 0) {
          prompt += "\n\n## Available tools\n";
          for (const s of skills) {
            prompt += `- **${s.name}** (${s.riskLevel}): ${s.description}
`;
          }
        }
        if (memories && memories.length > 0) {
          prompt += "\n\n## Memories about this user\n";
          for (const m of memories) {
            prompt += `- [${m.category}] ${m.key}: ${m.value}
`;
          }
          prompt += "\nUse these memories to personalize your responses. When the user tells you new facts or preferences, use the memory tool to save them.";
        } else {
          prompt += "\n\nWhen the user tells you facts about themselves or preferences, use the memory tool to save them for future reference.";
        }
        return prompt;
      }
      buildMessages(history) {
        return history.filter((msg) => msg.role === "user" || msg.role === "assistant").map((msg) => {
          if (msg.toolCalls) {
            const toolCalls = JSON.parse(msg.toolCalls);
            const content = [];
            if (msg.content) {
              content.push({ type: "text", text: msg.content });
            }
            for (const tc of toolCalls) {
              content.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.input
              });
            }
            return { role: msg.role, content };
          }
          return { role: msg.role, content: msg.content };
        });
      }
      buildTools(skills) {
        return skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema
        }));
      }
    };
  }
});

// ../llm/dist/index.js
var init_dist4 = __esm({
  "../llm/dist/index.js"() {
    "use strict";
    init_provider();
    init_anthropic();
    init_openai();
    init_openrouter();
    init_ollama();
    init_provider_factory();
    init_prompt_builder();
  }
});

// ../security/dist/rate-limiter.js
var RateLimiter;
var init_rate_limiter = __esm({
  "../security/dist/rate-limiter.js"() {
    "use strict";
    RateLimiter = class {
      buckets = /* @__PURE__ */ new Map();
      check(key, limit) {
        const now = Date.now();
        const windowMs = limit.windowSeconds * 1e3;
        const bucket = this.buckets.get(key);
        if (!bucket) {
          return {
            allowed: true,
            remaining: limit.maxInvocations,
            resetsAt: now + windowMs
          };
        }
        if (now > bucket.windowStart + windowMs) {
          return {
            allowed: true,
            remaining: limit.maxInvocations,
            resetsAt: now + windowMs
          };
        }
        const remaining = Math.max(0, limit.maxInvocations - bucket.count);
        return {
          allowed: bucket.count < limit.maxInvocations,
          remaining,
          resetsAt: bucket.windowStart + windowMs
        };
      }
      increment(key, limit) {
        const now = Date.now();
        const windowMs = limit.windowSeconds * 1e3;
        const bucket = this.buckets.get(key);
        if (!bucket || now > bucket.windowStart + windowMs) {
          this.buckets.set(key, { count: 1, windowStart: now });
        } else {
          bucket.count += 1;
        }
      }
      reset() {
        this.buckets.clear();
      }
    };
  }
});

// ../security/dist/rule-engine.js
var RuleEngine;
var init_rule_engine = __esm({
  "../security/dist/rule-engine.js"() {
    "use strict";
    init_rate_limiter();
    RuleEngine = class {
      rules = [];
      rateLimiter = new RateLimiter();
      loadRules(rules) {
        this.rules = [...rules].sort((a, b) => a.priority - b.priority);
      }
      getRules() {
        return this.rules;
      }
      evaluate(context) {
        for (const rule of this.rules) {
          if (this.ruleMatches(rule, context)) {
            if (rule.rateLimit && rule.effect === "allow") {
              const rateLimitResult = this.checkRateLimit(rule, context);
              if (!rateLimitResult) {
                return {
                  allowed: false,
                  matchedRule: rule,
                  reason: `Rate limit exceeded for rule: ${rule.id}`,
                  timestamp: /* @__PURE__ */ new Date()
                };
              }
            }
            return {
              allowed: rule.effect === "allow",
              matchedRule: rule,
              reason: `Matched rule: ${rule.id}`,
              timestamp: /* @__PURE__ */ new Date()
            };
          }
        }
        return {
          allowed: false,
          matchedRule: void 0,
          reason: "No matching rule found \u2014 default deny",
          timestamp: /* @__PURE__ */ new Date()
        };
      }
      /**
       * Checks and increments the rate limit counter for a given rule and context.
       * Returns true if the action is within the rate limit, false if exceeded.
       */
      checkRateLimit(rule, context) {
        if (!rule.rateLimit) {
          return true;
        }
        const scopeKey = this.getScopeKey(rule.scope, context);
        const key = `${rule.id}:${scopeKey}`;
        const result = this.rateLimiter.check(key, rule.rateLimit);
        if (!result.allowed) {
          return false;
        }
        this.rateLimiter.increment(key, rule.rateLimit);
        return true;
      }
      /**
       * Resets all rate limit counters. Useful for testing.
       */
      resetRateLimits() {
        this.rateLimiter.reset();
      }
      getScopeKey(scope, context) {
        switch (scope) {
          case "global":
            return "global";
          case "user":
            return context.userId;
          case "conversation":
            return context.chatId ?? "unknown";
          case "platform":
            return context.platform;
        }
      }
      ruleMatches(rule, context) {
        if (!rule.actions.includes("*") && !rule.actions.includes(context.action)) {
          return false;
        }
        if (!rule.riskLevels.includes(context.riskLevel)) {
          return false;
        }
        if (rule.conditions) {
          if (rule.conditions.users && rule.conditions.users.length > 0) {
            if (!rule.conditions.users.includes(context.userId)) {
              return false;
            }
          }
          if (rule.conditions.platforms && rule.conditions.platforms.length > 0) {
            if (!rule.conditions.platforms.includes(context.platform)) {
              return false;
            }
          }
          if (rule.conditions.chatType && context.chatType) {
            if (rule.conditions.chatType !== context.chatType) {
              return false;
            }
          }
          if (rule.conditions.timeWindow) {
            if (!this.matchesTimeWindow(rule.conditions.timeWindow)) {
              return false;
            }
          }
        }
        return true;
      }
      matchesTimeWindow(timeWindow) {
        if (!timeWindow) {
          return true;
        }
        const now = /* @__PURE__ */ new Date();
        if (timeWindow.daysOfWeek && timeWindow.daysOfWeek.length > 0) {
          if (!timeWindow.daysOfWeek.includes(now.getDay())) {
            return false;
          }
        }
        const currentHour = now.getHours();
        if (timeWindow.startHour !== void 0 && timeWindow.endHour !== void 0) {
          if (timeWindow.startHour <= timeWindow.endHour) {
            if (currentHour < timeWindow.startHour || currentHour >= timeWindow.endHour) {
              return false;
            }
          } else {
            if (currentHour < timeWindow.startHour && currentHour >= timeWindow.endHour) {
              return false;
            }
          }
        } else if (timeWindow.startHour !== void 0) {
          if (currentHour < timeWindow.startHour) {
            return false;
          }
        } else if (timeWindow.endHour !== void 0) {
          if (currentHour >= timeWindow.endHour) {
            return false;
          }
        }
        return true;
      }
    };
  }
});

// ../security/dist/rule-loader.js
var VALID_EFFECTS, VALID_SCOPES, VALID_RISK_LEVELS, RuleLoader;
var init_rule_loader = __esm({
  "../security/dist/rule-loader.js"() {
    "use strict";
    VALID_EFFECTS = ["allow", "deny"];
    VALID_SCOPES = ["global", "user", "conversation", "platform"];
    VALID_RISK_LEVELS = ["read", "write", "destructive", "admin"];
    RuleLoader = class {
      /**
       * Validates and returns a typed array of SecurityRule objects from a
       * pre-parsed data object. The config/bootstrap layer is responsible for
       * YAML parsing; this method only validates structure.
       */
      loadFromObject(data) {
        if (!data || !Array.isArray(data.rules)) {
          throw new Error('Invalid data: expected an object with a "rules" array');
        }
        return data.rules.map((raw, index) => this.validateRule(raw, index));
      }
      validateRule(raw, index) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error(`Rule at index ${index} is not an object`);
        }
        const rule = raw;
        if (typeof rule.id !== "string" || rule.id.length === 0) {
          throw new Error(`Rule at index ${index} is missing a valid "id" string`);
        }
        if (typeof rule.effect !== "string" || !VALID_EFFECTS.includes(rule.effect)) {
          throw new Error(`Rule "${rule.id}" has invalid "effect": expected one of ${VALID_EFFECTS.join(", ")}`);
        }
        if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) {
          throw new Error(`Rule "${rule.id}" is missing a valid "priority" number`);
        }
        if (typeof rule.scope !== "string" || !VALID_SCOPES.includes(rule.scope)) {
          throw new Error(`Rule "${rule.id}" has invalid "scope": expected one of ${VALID_SCOPES.join(", ")}`);
        }
        if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
          throw new Error(`Rule "${rule.id}" is missing a valid "actions" array`);
        }
        for (const action of rule.actions) {
          if (typeof action !== "string") {
            throw new Error(`Rule "${rule.id}" has a non-string entry in "actions"`);
          }
        }
        if (!Array.isArray(rule.riskLevels) || rule.riskLevels.length === 0) {
          throw new Error(`Rule "${rule.id}" is missing a valid "riskLevels" array`);
        }
        for (const level of rule.riskLevels) {
          if (!VALID_RISK_LEVELS.includes(level)) {
            throw new Error(`Rule "${rule.id}" has invalid risk level "${level}": expected one of ${VALID_RISK_LEVELS.join(", ")}`);
          }
        }
        const validated = {
          id: rule.id,
          effect: rule.effect,
          priority: rule.priority,
          scope: rule.scope,
          actions: rule.actions,
          riskLevels: rule.riskLevels
        };
        if (rule.conditions !== void 0) {
          if (typeof rule.conditions !== "object" || rule.conditions === null) {
            throw new Error(`Rule "${rule.id}" has invalid "conditions": expected an object`);
          }
          validated.conditions = rule.conditions;
        }
        if (rule.rateLimit !== void 0) {
          if (typeof rule.rateLimit !== "object" || rule.rateLimit === null) {
            throw new Error(`Rule "${rule.id}" has invalid "rateLimit": expected an object`);
          }
          const rl = rule.rateLimit;
          if (typeof rl.maxInvocations !== "number" || typeof rl.windowSeconds !== "number") {
            throw new Error(`Rule "${rule.id}" has invalid "rateLimit": expected maxInvocations and windowSeconds numbers`);
          }
          validated.rateLimit = rule.rateLimit;
        }
        return validated;
      }
    };
  }
});

// ../security/dist/security-manager.js
import crypto3 from "node:crypto";
var SecurityManager;
var init_security_manager = __esm({
  "../security/dist/security-manager.js"() {
    "use strict";
    SecurityManager = class {
      ruleEngine;
      auditRepository;
      logger;
      constructor(ruleEngine, auditRepository, logger) {
        this.ruleEngine = ruleEngine;
        this.auditRepository = auditRepository;
        this.logger = logger;
      }
      evaluate(context) {
        const evaluation = this.ruleEngine.evaluate(context);
        const auditEntry = {
          id: crypto3.randomUUID(),
          timestamp: evaluation.timestamp,
          userId: context.userId,
          action: context.action,
          riskLevel: context.riskLevel,
          ruleId: evaluation.matchedRule?.id,
          effect: evaluation.allowed ? "allow" : "deny",
          platform: context.platform,
          chatId: context.chatId,
          context: {
            chatType: context.chatType,
            reason: evaluation.reason
          }
        };
        try {
          this.auditRepository.log(auditEntry);
        } catch (err) {
          this.logger.error({ err, auditEntry }, "Failed to write audit log entry");
        }
        this.logger.debug({
          userId: context.userId,
          action: context.action,
          allowed: evaluation.allowed,
          ruleId: evaluation.matchedRule?.id,
          reason: evaluation.reason
        }, "Security evaluation completed");
        return evaluation;
      }
    };
  }
});

// ../security/dist/index.js
var init_dist5 = __esm({
  "../security/dist/index.js"() {
    "use strict";
    init_rule_engine();
    init_rate_limiter();
    init_rule_loader();
    init_security_manager();
  }
});

// ../skills/dist/skill.js
var Skill;
var init_skill = __esm({
  "../skills/dist/skill.js"() {
    "use strict";
    Skill = class {
    };
  }
});

// ../skills/dist/skill-registry.js
var SkillRegistry;
var init_skill_registry = __esm({
  "../skills/dist/skill-registry.js"() {
    "use strict";
    SkillRegistry = class {
      skills = /* @__PURE__ */ new Map();
      register(skill) {
        const { name } = skill.metadata;
        if (this.skills.has(name)) {
          throw new Error(`Skill "${name}" is already registered`);
        }
        this.skills.set(name, skill);
      }
      get(name) {
        return this.skills.get(name);
      }
      getAll() {
        return [...this.skills.values()];
      }
      has(name) {
        return this.skills.has(name);
      }
      toToolDefinitions() {
        return this.getAll().map((skill) => ({
          name: skill.metadata.name,
          description: skill.metadata.description,
          inputSchema: skill.metadata.inputSchema
        }));
      }
    };
  }
});

// ../skills/dist/skill-sandbox.js
var DEFAULT_TIMEOUT_MS, SkillSandbox;
var init_skill_sandbox = __esm({
  "../skills/dist/skill-sandbox.js"() {
    "use strict";
    DEFAULT_TIMEOUT_MS = 3e4;
    SkillSandbox = class {
      logger;
      constructor(logger) {
        this.logger = logger;
      }
      async execute(skill, input2, context, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const { name } = skill.metadata;
        this.logger.info({ skill: name, input: input2 }, "Skill execution started");
        try {
          const result = await Promise.race([
            skill.execute(input2, context),
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error(`Skill "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
            })
          ]);
          this.logger.info({ skill: name, success: result.success }, "Skill execution completed");
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error({ skill: name, error: message }, "Skill execution failed");
          return {
            success: false,
            error: message
          };
        }
      }
    };
  }
});

// ../skills/dist/plugin-loader.js
import fs3 from "node:fs";
import path3 from "node:path";
var init_plugin_loader = __esm({
  "../skills/dist/plugin-loader.js"() {
    "use strict";
    init_skill();
  }
});

// ../skills/dist/built-in/calculator.js
var ALLOWED_PATTERN, SAFE_EXPRESSION_PATTERN, CalculatorSkill;
var init_calculator = __esm({
  "../skills/dist/built-in/calculator.js"() {
    "use strict";
    init_skill();
    ALLOWED_PATTERN = /^[\d+\-*/().,%\s]|Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)/;
    SAFE_EXPRESSION_PATTERN = /^[0-9+\-*/().,\s%]*(Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)[(0-9+\-*/().,\s%]*)*$/;
    CalculatorSkill = class extends Skill {
      metadata = {
        name: "calculator",
        description: "Evaluate mathematical expressions. Use for any calculation, unit conversion, or math question the user asks.",
        riskLevel: "read",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "The mathematical expression to evaluate"
            }
          },
          required: ["expression"]
        }
      };
      async execute(input2, _context) {
        const expression = input2.expression;
        if (!expression || typeof expression !== "string") {
          return {
            success: false,
            error: "Invalid expression: input must be a non-empty string"
          };
        }
        const trimmed = expression.trim();
        if (!ALLOWED_PATTERN.test(trimmed)) {
          return {
            success: false,
            error: `Invalid expression: "${trimmed}" contains disallowed characters`
          };
        }
        if (!SAFE_EXPRESSION_PATTERN.test(trimmed)) {
          return {
            success: false,
            error: `Invalid expression: "${trimmed}" contains disallowed constructs`
          };
        }
        try {
          const fn = new Function("Math", `"use strict"; return (${trimmed});`);
          const result = fn(Math);
          if (typeof result !== "number" || !isFinite(result)) {
            return {
              success: false,
              error: `Invalid expression: "${trimmed}" did not produce a finite number`
            };
          }
          return {
            success: true,
            data: result,
            display: `${trimmed} = ${result}`
          };
        } catch {
          return {
            success: false,
            error: `Invalid expression: "${trimmed}"`
          };
        }
      }
    };
  }
});

// ../skills/dist/built-in/system-info.js
var SystemInfoSkill;
var init_system_info = __esm({
  "../skills/dist/built-in/system-info.js"() {
    "use strict";
    init_skill();
    SystemInfoSkill = class extends Skill {
      metadata = {
        name: "system_info",
        description: 'Get system information: current date/time (datetime), system stats (general), memory usage (memory), or uptime (uptime). Use "datetime" when the user asks what day/time it is.',
        riskLevel: "read",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["general", "memory", "uptime", "datetime"],
              description: "Category of system info (use datetime for current date/time)"
            }
          },
          required: ["category"]
        }
      };
      async execute(input2, _context) {
        const category = input2.category;
        switch (category) {
          case "general":
            return this.getGeneralInfo();
          case "memory":
            return this.getMemoryInfo();
          case "uptime":
            return this.getUptimeInfo();
          case "datetime":
            return this.getDateTimeInfo();
          default:
            return {
              success: false,
              error: `Unknown category: "${String(category)}". Valid categories: general, memory, uptime`
            };
        }
      }
      getGeneralInfo() {
        const info = {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch
        };
        return {
          success: true,
          data: info,
          display: `Node.js ${info.nodeVersion} on ${info.platform} (${info.arch})`
        };
      }
      getMemoryInfo() {
        const mem = process.memoryUsage();
        const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
        const info = {
          rss: `${toMB(mem.rss)} MB`,
          heapTotal: `${toMB(mem.heapTotal)} MB`,
          heapUsed: `${toMB(mem.heapUsed)} MB`,
          external: `${toMB(mem.external)} MB`
        };
        return {
          success: true,
          data: info,
          display: `Memory \u2014 RSS: ${info.rss}, Heap: ${info.heapUsed} / ${info.heapTotal}, External: ${info.external}`
        };
      }
      getUptimeInfo() {
        const totalSeconds = process.uptime();
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor(totalSeconds % 3600 / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const info = {
          uptimeSeconds: totalSeconds,
          formatted: `${hours}h ${minutes}m ${seconds}s`
        };
        return {
          success: true,
          data: info,
          display: `Uptime: ${info.formatted}`
        };
      }
      getDateTimeInfo() {
        const now = /* @__PURE__ */ new Date();
        const info = {
          iso: now.toISOString(),
          date: now.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
          time: now.toLocaleTimeString("de-DE"),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timestamp: now.getTime()
        };
        return {
          success: true,
          data: info,
          display: `${info.date}, ${info.time} (${info.timezone})`
        };
      }
    };
  }
});

// ../skills/dist/built-in/web-search.js
var WebSearchSkill;
var init_web_search = __esm({
  "../skills/dist/built-in/web-search.js"() {
    "use strict";
    init_skill();
    WebSearchSkill = class extends Skill {
      config;
      metadata = {
        name: "web_search",
        description: "Search the internet for current information, news, facts, or anything the user asks about that you don't know. Use this whenever you need up-to-date information.",
        riskLevel: "read",
        version: "1.1.0",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query"
            },
            count: {
              type: "number",
              description: "Number of results to return (default: 5, max: 10)"
            }
          },
          required: ["query"]
        }
      };
      constructor(config) {
        super();
        this.config = config;
      }
      async execute(input2, _context) {
        const query = input2.query;
        const count = Math.min(Math.max(1, input2.count || 5), 10);
        if (!query || typeof query !== "string") {
          return { success: false, error: 'Invalid input: "query" must be a non-empty string' };
        }
        if (!this.config) {
          return {
            success: false,
            error: "Web search is not configured. Run `alfred setup` to configure a search provider."
          };
        }
        const needsKey = this.config.provider === "brave" || this.config.provider === "tavily";
        if (needsKey && !this.config.apiKey) {
          return {
            success: false,
            error: `Web search requires an API key for ${this.config.provider}. Run \`alfred setup\` to configure it.`
          };
        }
        try {
          let results;
          switch (this.config.provider) {
            case "brave":
              results = await this.searchBrave(query, count);
              break;
            case "searxng":
              results = await this.searchSearXNG(query, count);
              break;
            case "tavily":
              results = await this.searchTavily(query, count);
              break;
            case "duckduckgo":
              results = await this.searchDuckDuckGo(query, count);
              break;
            default:
              return { success: false, error: `Unknown search provider: ${this.config.provider}` };
          }
          if (results.length === 0) {
            return {
              success: true,
              data: { results: [] },
              display: `No results found for "${query}".`
            };
          }
          const display = results.map((r, i) => `${i + 1}. **${r.title}**
   ${r.url}
   ${r.snippet}`).join("\n\n");
          return {
            success: true,
            data: { query, results },
            display: `Search results for "${query}":

${display}`
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Search failed: ${msg}` };
        }
      }
      // ── Brave Search ──────────────────────────────────────────────
      async searchBrave(query, count) {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(count));
        const response = await fetch(url.toString(), {
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": this.config.apiKey
          }
        });
        if (!response.ok) {
          throw new Error(`Brave Search API returned ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return (data.web?.results ?? []).slice(0, count).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description
        }));
      }
      // ── SearXNG ───────────────────────────────────────────────────
      async searchSearXNG(query, count) {
        const base = (this.config.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");
        const url = new URL(`${base}/search`);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("pageno", "1");
        const response = await fetch(url.toString(), {
          headers: { "Accept": "application/json" }
        });
        if (!response.ok) {
          throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return (data.results ?? []).slice(0, count).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content
        }));
      }
      // ── Tavily ────────────────────────────────────────────────────
      async searchTavily(query, count) {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: this.config.apiKey,
            query,
            max_results: count,
            include_answer: false
          })
        });
        if (!response.ok) {
          throw new Error(`Tavily API returned ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return (data.results ?? []).slice(0, count).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content
        }));
      }
      // ── DuckDuckGo (HTML scraping, no API key) ────────────────────
      async searchDuckDuckGo(query, count) {
        const url = new URL("https://html.duckduckgo.com/html/");
        url.searchParams.set("q", query);
        const response = await fetch(url.toString(), {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Alfred/1.0)"
          }
        });
        if (!response.ok) {
          throw new Error(`DuckDuckGo returned ${response.status}: ${response.statusText}`);
        }
        const html = await response.text();
        return this.parseDuckDuckGoHtml(html, count);
      }
      parseDuckDuckGoHtml(html, count) {
        const results = [];
        const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const links = [];
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
          const rawUrl = match[1];
          const title = this.stripHtml(match[2]).trim();
          const actualUrl = this.extractDdgUrl(rawUrl);
          if (title && actualUrl) {
            links.push({ url: actualUrl, title });
          }
        }
        const snippets = [];
        while ((match = snippetRegex.exec(html)) !== null) {
          snippets.push(this.stripHtml(match[1]).trim());
        }
        for (let i = 0; i < Math.min(links.length, count); i++) {
          results.push({
            title: links[i].title,
            url: links[i].url,
            snippet: snippets[i] ?? ""
          });
        }
        return results;
      }
      extractDdgUrl(rawUrl) {
        try {
          if (rawUrl.includes("uddg=")) {
            const parsed = new URL(rawUrl, "https://duckduckgo.com");
            const uddg = parsed.searchParams.get("uddg");
            if (uddg)
              return decodeURIComponent(uddg);
          }
        } catch {
        }
        if (rawUrl.startsWith("http"))
          return rawUrl;
        return "";
      }
      stripHtml(html) {
        return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
      }
    };
  }
});

// ../skills/dist/built-in/reminder.js
var ReminderSkill;
var init_reminder = __esm({
  "../skills/dist/built-in/reminder.js"() {
    "use strict";
    init_skill();
    ReminderSkill = class extends Skill {
      reminderRepo;
      metadata = {
        name: "reminder",
        description: 'Set timed reminders that notify the user later. Use when the user says "remind me", "erinnere mich", or asks to be notified about something at a specific time.',
        riskLevel: "write",
        version: "2.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["set", "list", "cancel"],
              description: "The reminder action to perform"
            },
            message: {
              type: "string",
              description: "The reminder message (required for set)"
            },
            delayMinutes: {
              type: "number",
              description: "Minutes until the reminder triggers (required for set)"
            },
            reminderId: {
              type: "string",
              description: "The ID of the reminder to cancel (required for cancel)"
            }
          },
          required: ["action"]
        }
      };
      constructor(reminderRepo) {
        super();
        this.reminderRepo = reminderRepo;
      }
      async execute(input2, context) {
        const action = input2.action;
        switch (action) {
          case "set":
            return this.setReminder(input2, context);
          case "list":
            return this.listReminders(context);
          case "cancel":
            return this.cancelReminder(input2);
          default:
            return {
              success: false,
              error: `Unknown action: "${String(action)}". Valid actions: set, list, cancel`
            };
        }
      }
      setReminder(input2, context) {
        const message = input2.message;
        const delayMinutes = input2.delayMinutes;
        if (!message || typeof message !== "string") {
          return {
            success: false,
            error: 'Missing required field "message" for set action'
          };
        }
        if (delayMinutes === void 0 || typeof delayMinutes !== "number" || delayMinutes <= 0) {
          return {
            success: false,
            error: 'Missing or invalid "delayMinutes" for set action (must be a positive number)'
          };
        }
        const triggerAt = new Date(Date.now() + delayMinutes * 60 * 1e3);
        const entry = this.reminderRepo.create(context.userId, context.platform, context.chatId, message, triggerAt);
        return {
          success: true,
          data: { reminderId: entry.id, message, triggerAt: entry.triggerAt },
          display: `Reminder set (${entry.id}): "${message}" in ${delayMinutes} minute(s)`
        };
      }
      listReminders(context) {
        const reminders = this.reminderRepo.getByUser(context.userId);
        const reminderList = reminders.map((r) => ({
          reminderId: r.id,
          message: r.message,
          triggerAt: r.triggerAt
        }));
        return {
          success: true,
          data: reminderList,
          display: reminderList.length === 0 ? "No active reminders." : `Active reminders:
${reminderList.map((r) => `- ${r.reminderId}: "${r.message}" (triggers at ${r.triggerAt})`).join("\n")}`
        };
      }
      cancelReminder(input2) {
        const reminderId = input2.reminderId;
        if (!reminderId || typeof reminderId !== "string") {
          return {
            success: false,
            error: 'Missing required field "reminderId" for cancel action'
          };
        }
        const deleted = this.reminderRepo.cancel(reminderId);
        if (!deleted) {
          return {
            success: false,
            error: `Reminder "${reminderId}" not found`
          };
        }
        return {
          success: true,
          data: { reminderId },
          display: `Reminder "${reminderId}" cancelled.`
        };
      }
    };
  }
});

// ../skills/dist/built-in/note.js
var NoteSkill;
var init_note = __esm({
  "../skills/dist/built-in/note.js"() {
    "use strict";
    init_skill();
    NoteSkill = class extends Skill {
      noteRepo;
      metadata = {
        name: "note",
        description: "Save, list, search, or delete persistent notes (stored in SQLite). Use when the user wants to write down or retrieve text notes, lists, or ideas.",
        riskLevel: "write",
        version: "2.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["save", "list", "search", "delete"],
              description: "The note action to perform"
            },
            title: {
              type: "string",
              description: "The note title (required for save)"
            },
            content: {
              type: "string",
              description: "The note content (required for save)"
            },
            noteId: {
              type: "string",
              description: "The ID of the note to delete (required for delete)"
            },
            query: {
              type: "string",
              description: "Search query to filter notes (required for search)"
            }
          },
          required: ["action"]
        }
      };
      constructor(noteRepo) {
        super();
        this.noteRepo = noteRepo;
      }
      async execute(input2, context) {
        const action = input2.action;
        switch (action) {
          case "save":
            return this.saveNote(input2, context);
          case "list":
            return this.listNotes(context);
          case "search":
            return this.searchNotes(input2, context);
          case "delete":
            return this.deleteNote(input2);
          default:
            return {
              success: false,
              error: `Unknown action: "${String(action)}". Valid actions: save, list, search, delete`
            };
        }
      }
      saveNote(input2, context) {
        const title = input2.title;
        const content = input2.content;
        if (!title || typeof title !== "string") {
          return { success: false, error: 'Missing required field "title" for save action' };
        }
        if (!content || typeof content !== "string") {
          return { success: false, error: 'Missing required field "content" for save action' };
        }
        const entry = this.noteRepo.save(context.userId, title, content);
        return {
          success: true,
          data: { noteId: entry.id, title: entry.title },
          display: `Note saved: "${title}"`
        };
      }
      listNotes(context) {
        const notes = this.noteRepo.list(context.userId);
        if (notes.length === 0) {
          return { success: true, data: [], display: "No notes found." };
        }
        const display = notes.map((n) => `- **${n.title}** (${n.id.slice(0, 8)}\u2026)
  ${n.content.slice(0, 100)}${n.content.length > 100 ? "\u2026" : ""}`).join("\n");
        return { success: true, data: notes, display: `${notes.length} note(s):
${display}` };
      }
      searchNotes(input2, context) {
        const query = input2.query;
        if (!query || typeof query !== "string") {
          return { success: false, error: 'Missing required field "query" for search action' };
        }
        const matches = this.noteRepo.search(context.userId, query);
        if (matches.length === 0) {
          return { success: true, data: [], display: `No notes matching "${query}".` };
        }
        const display = matches.map((n) => `- **${n.title}** (${n.id.slice(0, 8)}\u2026)
  ${n.content.slice(0, 100)}${n.content.length > 100 ? "\u2026" : ""}`).join("\n");
        return { success: true, data: matches, display: `Found ${matches.length} note(s):
${display}` };
      }
      deleteNote(input2) {
        const noteId = input2.noteId;
        if (!noteId || typeof noteId !== "string") {
          return { success: false, error: 'Missing required field "noteId" for delete action' };
        }
        const deleted = this.noteRepo.delete(noteId);
        if (!deleted) {
          return { success: false, error: `Note "${noteId}" not found` };
        }
        return { success: true, data: { noteId }, display: `Note deleted.` };
      }
    };
  }
});

// ../skills/dist/built-in/weather.js
var WEATHER_CODES, WeatherSkill;
var init_weather = __esm({
  "../skills/dist/built-in/weather.js"() {
    "use strict";
    init_skill();
    WEATHER_CODES = {
      0: "Clear sky",
      1: "Mainly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Depositing rime fog",
      51: "Light drizzle",
      53: "Moderate drizzle",
      55: "Dense drizzle",
      61: "Slight rain",
      63: "Moderate rain",
      65: "Heavy rain",
      71: "Slight snow",
      73: "Moderate snow",
      75: "Heavy snow",
      77: "Snow grains",
      80: "Slight rain showers",
      81: "Moderate rain showers",
      82: "Violent rain showers",
      85: "Slight snow showers",
      86: "Heavy snow showers",
      95: "Thunderstorm",
      96: "Thunderstorm with slight hail",
      99: "Thunderstorm with heavy hail"
    };
    WeatherSkill = class extends Skill {
      metadata = {
        name: "weather",
        description: "Get current weather for any location. Uses Open-Meteo (free, no API key). Use when the user asks about weather, temperature, or conditions somewhere.",
        riskLevel: "read",
        version: "2.0.0",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: 'City or place name (e.g. "Vienna", "New York", "Tokyo")'
            }
          },
          required: ["location"]
        }
      };
      async execute(input2, _context) {
        const location = input2.location;
        if (!location || typeof location !== "string") {
          return { success: false, error: 'Missing required field "location"' };
        }
        try {
          const geo = await this.geocode(location);
          if (!geo) {
            return { success: false, error: `Location "${location}" not found` };
          }
          const weather = await this.fetchWeather(geo.latitude, geo.longitude);
          const condition = WEATHER_CODES[weather.weathercode] ?? `Code ${weather.weathercode}`;
          const locationLabel = geo.admin1 ? `${geo.name}, ${geo.admin1}, ${geo.country}` : `${geo.name}, ${geo.country}`;
          const data = {
            location: locationLabel,
            temperature: weather.temperature,
            unit: "\xB0C",
            condition,
            windSpeed: weather.windspeed,
            windDirection: weather.winddirection,
            isDay: weather.is_day === 1
          };
          const display = `${locationLabel}: ${weather.temperature}\xB0C, ${condition}
Wind: ${weather.windspeed} km/h`;
          return { success: true, data, display };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Weather fetch failed: ${msg}` };
        }
      }
      async geocode(query) {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
        const res = await fetch(url);
        if (!res.ok)
          throw new Error(`Geocoding API returned ${res.status}`);
        const data = await res.json();
        return data.results?.[0];
      }
      async fetchWeather(lat, lon) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok)
          throw new Error(`Weather API returned ${res.status}`);
        const data = await res.json();
        return data.current_weather;
      }
    };
  }
});

// ../skills/dist/built-in/shell.js
import { exec } from "node:child_process";
function truncate(text) {
  if (text.length > MAX_OUTPUT_SIZE) {
    return text.slice(0, MAX_OUTPUT_SIZE) + "\n[output truncated]";
  }
  return text;
}
var DEFAULT_TIMEOUT, MAX_OUTPUT_SIZE, ShellSkill;
var init_shell = __esm({
  "../skills/dist/built-in/shell.js"() {
    "use strict";
    init_skill();
    DEFAULT_TIMEOUT = 3e4;
    MAX_OUTPUT_SIZE = 1e4;
    ShellSkill = class extends Skill {
      metadata = {
        name: "shell",
        description: "Execute shell commands on the host system. Use this for ANY task involving files, folders, system operations, or running programs: ls, cat, find, file, du, mkdir, cp, mv, grep, etc. When the user asks about their documents, files, or anything on disk \u2014 use this tool.",
        riskLevel: "admin",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute"
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (default: 30000)"
            },
            cwd: {
              type: "string",
              description: "Working directory for the command"
            }
          },
          required: ["command"]
        }
      };
      async execute(input2, _context) {
        const command = input2.command;
        if (!command || typeof command !== "string") {
          return {
            success: false,
            error: 'Missing required field "command"'
          };
        }
        const timeout = typeof input2.timeout === "number" && input2.timeout > 0 ? input2.timeout : DEFAULT_TIMEOUT;
        const cwd = typeof input2.cwd === "string" && input2.cwd.length > 0 ? input2.cwd : void 0;
        try {
          const { stdout, stderr, exitCode } = await this.run(command, timeout, cwd);
          const parts = [];
          if (stdout)
            parts.push(`stdout:
${truncate(stdout)}`);
          if (stderr)
            parts.push(`stderr:
${truncate(stderr)}`);
          if (parts.length === 0)
            parts.push("(no output)");
          parts.push(`exit code: ${exitCode}`);
          return {
            success: exitCode === 0,
            data: { stdout, stderr, exitCode },
            display: parts.join("\n\n"),
            ...exitCode !== 0 && { error: `Command exited with code ${exitCode}` }
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Shell execution failed: ${message}`
          };
        }
      }
      run(command, timeout, cwd) {
        return new Promise((resolve) => {
          exec(command, { timeout, cwd }, (error, stdout, stderr) => {
            const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
            resolve({
              stdout: typeof stdout === "string" ? stdout : "",
              stderr: typeof stderr === "string" ? stderr : "",
              exitCode
            });
          });
        });
      }
    };
  }
});

// ../skills/dist/built-in/memory.js
var MemorySkill;
var init_memory = __esm({
  "../skills/dist/built-in/memory.js"() {
    "use strict";
    init_skill();
    MemorySkill = class extends Skill {
      memoryRepo;
      metadata = {
        name: "memory",
        description: "Store and retrieve persistent memories. Use this to remember user preferences, facts, and important information across conversations.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["save", "recall", "search", "list", "delete"],
              description: "The memory action to perform"
            },
            key: {
              type: "string",
              description: "The memory key/label"
            },
            value: {
              type: "string",
              description: "The value to remember (for save)"
            },
            category: {
              type: "string",
              description: "Optional category (for save/list)"
            },
            query: {
              type: "string",
              description: "Search query (for search)"
            }
          },
          required: ["action"]
        }
      };
      constructor(memoryRepo) {
        super();
        this.memoryRepo = memoryRepo;
      }
      async execute(input2, context) {
        const action = input2.action;
        switch (action) {
          case "save":
            return this.saveMemory(input2, context);
          case "recall":
            return this.recallMemory(input2, context);
          case "search":
            return this.searchMemories(input2, context);
          case "list":
            return this.listMemories(input2, context);
          case "delete":
            return this.deleteMemory(input2, context);
          default:
            return {
              success: false,
              error: `Unknown action: "${String(action)}". Valid actions: save, recall, search, list, delete`
            };
        }
      }
      saveMemory(input2, context) {
        const key = input2.key;
        const value = input2.value;
        const category = input2.category;
        if (!key || typeof key !== "string") {
          return {
            success: false,
            error: 'Missing required field "key" for save action'
          };
        }
        if (!value || typeof value !== "string") {
          return {
            success: false,
            error: 'Missing required field "value" for save action'
          };
        }
        const entry = this.memoryRepo.save(context.userId, key, value, category ?? "general");
        return {
          success: true,
          data: entry,
          display: `Remembered "${key}" = "${value}" (category: ${entry.category})`
        };
      }
      recallMemory(input2, context) {
        const key = input2.key;
        if (!key || typeof key !== "string") {
          return {
            success: false,
            error: 'Missing required field "key" for recall action'
          };
        }
        const entry = this.memoryRepo.recall(context.userId, key);
        if (!entry) {
          return {
            success: true,
            data: null,
            display: `No memory found for key "${key}".`
          };
        }
        return {
          success: true,
          data: entry,
          display: `${key} = "${entry.value}" (category: ${entry.category}, updated: ${entry.updatedAt})`
        };
      }
      searchMemories(input2, context) {
        const query = input2.query;
        if (!query || typeof query !== "string") {
          return {
            success: false,
            error: 'Missing required field "query" for search action'
          };
        }
        const entries = this.memoryRepo.search(context.userId, query);
        return {
          success: true,
          data: entries,
          display: entries.length === 0 ? `No memories matching "${query}".` : `Found ${entries.length} memory(ies):
${entries.map((e) => `- ${e.key}: "${e.value}"`).join("\n")}`
        };
      }
      listMemories(input2, context) {
        const category = input2.category;
        const entries = category && typeof category === "string" ? this.memoryRepo.listByCategory(context.userId, category) : this.memoryRepo.listAll(context.userId);
        const label = category ? `in category "${category}"` : "total";
        return {
          success: true,
          data: entries,
          display: entries.length === 0 ? `No memories found${category ? ` in category "${category}"` : ""}.` : `${entries.length} memory(ies) ${label}:
${entries.map((e) => `- [${e.category}] ${e.key}: "${e.value}"`).join("\n")}`
        };
      }
      deleteMemory(input2, context) {
        const key = input2.key;
        if (!key || typeof key !== "string") {
          return {
            success: false,
            error: 'Missing required field "key" for delete action'
          };
        }
        const deleted = this.memoryRepo.delete(context.userId, key);
        return {
          success: true,
          data: { key, deleted },
          display: deleted ? `Memory "${key}" deleted.` : `No memory found for key "${key}".`
        };
      }
    };
  }
});

// ../skills/dist/built-in/delegate.js
var MAX_SUB_AGENT_ITERATIONS, DelegateSkill;
var init_delegate = __esm({
  "../skills/dist/built-in/delegate.js"() {
    "use strict";
    init_skill();
    MAX_SUB_AGENT_ITERATIONS = 5;
    DelegateSkill = class extends Skill {
      llm;
      skillRegistry;
      skillSandbox;
      securityManager;
      metadata = {
        name: "delegate",
        description: 'Delegate a complex sub-task to an autonomous sub-agent that has full tool access. The sub-agent can use shell, web search, calculator, memory, email, and all other tools. Use when a task is independent enough to run in parallel or when it requires a focused, multi-step workflow (e.g. "research X and summarize", "find all TODO files and list them", "check the weather and draft a packing list"). The sub-agent runs up to 5 tool iterations autonomously.',
        riskLevel: "write",
        version: "2.0.0",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The task to delegate to the sub-agent. Be specific about what you want."
            },
            context: {
              type: "string",
              description: "Additional context the sub-agent needs (optional)"
            }
          },
          required: ["task"]
        }
      };
      constructor(llm, skillRegistry, skillSandbox, securityManager) {
        super();
        this.llm = llm;
        this.skillRegistry = skillRegistry;
        this.skillSandbox = skillSandbox;
        this.securityManager = securityManager;
      }
      async execute(input2, context) {
        const task = input2.task;
        const additionalContext = input2.context;
        if (!task || typeof task !== "string") {
          return {
            success: false,
            error: 'Missing required field "task"'
          };
        }
        const tools = this.buildSubAgentTools();
        const systemPrompt = "You are a sub-agent of Alfred, a personal AI assistant. Complete the assigned task using the tools available to you. Work step by step: use tools to gather information, then synthesize a clear result. Be concise and return only the final answer when done.";
        let userContent = task;
        if (additionalContext && typeof additionalContext === "string") {
          userContent = `${task}

Additional context: ${additionalContext}`;
        }
        const messages = [
          { role: "user", content: userContent }
        ];
        try {
          let iteration = 0;
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          while (true) {
            const response = await this.llm.complete({
              messages,
              system: systemPrompt,
              tools: tools.length > 0 ? tools : void 0,
              maxTokens: 2048
            });
            totalInputTokens += response.usage.inputTokens;
            totalOutputTokens += response.usage.outputTokens;
            if (!response.toolCalls || response.toolCalls.length === 0 || iteration >= MAX_SUB_AGENT_ITERATIONS) {
              return {
                success: true,
                data: {
                  response: response.content,
                  iterations: iteration,
                  usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
                },
                display: response.content
              };
            }
            iteration++;
            const assistantContent = [];
            if (response.content) {
              assistantContent.push({ type: "text", text: response.content });
            }
            for (const tc of response.toolCalls) {
              assistantContent.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.input
              });
            }
            messages.push({ role: "assistant", content: assistantContent });
            const toolResultBlocks = [];
            for (const toolCall of response.toolCalls) {
              const result = await this.executeSubAgentTool(toolCall, context);
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolCall.id,
                content: result.content,
                is_error: result.isError
              });
            }
            messages.push({ role: "user", content: toolResultBlocks });
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Sub-agent failed: ${errorMessage}`
          };
        }
      }
      buildSubAgentTools() {
        if (!this.skillRegistry)
          return [];
        return this.skillRegistry.getAll().filter((s) => s.metadata.name !== "delegate").map((s) => ({
          name: s.metadata.name,
          description: s.metadata.description,
          inputSchema: s.metadata.inputSchema
        }));
      }
      async executeSubAgentTool(toolCall, context) {
        const skill = this.skillRegistry?.get(toolCall.name);
        if (!skill) {
          return { content: `Error: Unknown tool "${toolCall.name}"`, isError: true };
        }
        if (this.securityManager) {
          const evaluation = this.securityManager.evaluate({
            userId: context.userId,
            action: toolCall.name,
            riskLevel: skill.metadata.riskLevel,
            platform: context.platform,
            chatId: context.chatId,
            chatType: context.chatType
          });
          if (!evaluation.allowed) {
            return {
              content: `Access denied: ${evaluation.reason}`,
              isError: true
            };
          }
        }
        if (this.skillSandbox) {
          const result = await this.skillSandbox.execute(skill, toolCall.input, context);
          return {
            content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? "Unknown error"),
            isError: !result.success
          };
        }
        try {
          const result = await skill.execute(toolCall.input, context);
          return {
            content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? "Unknown error"),
            isError: !result.success
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Skill execution failed: ${msg}`, isError: true };
        }
      }
    };
  }
});

// ../skills/dist/built-in/email.js
var EmailSkill;
var init_email = __esm({
  "../skills/dist/built-in/email.js"() {
    "use strict";
    init_skill();
    EmailSkill = class extends Skill {
      config;
      metadata = {
        name: "email",
        description: "Access the user's email: check inbox, read messages, search emails, or send new emails. Use when the user asks about their emails or wants to send one.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["inbox", "read", "search", "send"],
              description: "The email action to perform"
            },
            count: {
              type: "number",
              description: "Number of emails to fetch (for inbox, default: 10)"
            },
            messageId: {
              type: "string",
              description: "Message sequence number to read (for read action)"
            },
            query: {
              type: "string",
              description: "Search query (for search action)"
            },
            to: {
              type: "string",
              description: "Recipient email address (for send action)"
            },
            subject: {
              type: "string",
              description: "Email subject (for send action)"
            },
            body: {
              type: "string",
              description: "Email body text (for send action)"
            }
          },
          required: ["action"]
        }
      };
      constructor(config) {
        super();
        this.config = config;
      }
      async execute(input2, _context) {
        if (!this.config) {
          return {
            success: false,
            error: "Email is not configured. Run `alfred setup` to configure email access."
          };
        }
        const action = input2.action;
        try {
          switch (action) {
            case "inbox":
              return await this.fetchInbox(input2.count);
            case "read":
              return await this.readMessage(input2.messageId);
            case "search":
              return await this.searchMessages(input2.query, input2.count);
            case "send":
              return await this.sendMessage(input2.to, input2.subject, input2.body);
            default:
              return { success: false, error: `Unknown action: ${action}. Use: inbox, read, search, send` };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Email error: ${msg}` };
        }
      }
      // ── IMAP: Fetch inbox ──────────────────────────────────────────
      async fetchInbox(count) {
        const limit = Math.min(Math.max(1, count ?? 10), 50);
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({
          host: this.config.imap.host,
          port: this.config.imap.port,
          secure: this.config.imap.secure,
          auth: this.config.auth,
          logger: false
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock("INBOX");
          try {
            const messages = [];
            const mb = client.mailbox;
            const totalMessages = mb && typeof mb === "object" ? mb.exists ?? 0 : 0;
            if (totalMessages === 0) {
              return { success: true, data: { messages: [] }, display: "Inbox is empty." };
            }
            const startSeq = Math.max(1, totalMessages - limit + 1);
            const range = `${startSeq}:*`;
            for await (const msg of client.fetch(range, {
              envelope: true,
              flags: true
            })) {
              const from = msg.envelope?.from?.[0];
              const fromStr = from ? from.name ? `${from.name} <${from.address}>` : from.address ?? "unknown" : "unknown";
              messages.push({
                seq: msg.seq,
                from: fromStr,
                subject: msg.envelope?.subject ?? "(no subject)",
                date: msg.envelope?.date?.toISOString() ?? "",
                seen: msg.flags?.has("\\Seen") ?? false
              });
            }
            messages.reverse();
            const display = messages.length === 0 ? "No messages found." : messages.map((m, i) => {
              const unread = m.seen ? "" : " [UNREAD]";
              return `${i + 1}. [#${m.seq}]${unread} ${m.subject}
   From: ${m.from}
   Date: ${m.date}`;
            }).join("\n\n");
            const unreadCount = messages.filter((m) => !m.seen).length;
            return {
              success: true,
              data: { messages, totalMessages, unreadCount },
              display: `Inbox (${totalMessages} total, ${unreadCount} unread):

${display}`
            };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }
      // ── IMAP: Read single message ──────────────────────────────────
      async readMessage(messageId) {
        if (!messageId) {
          return { success: false, error: "messageId is required. Use the sequence number from inbox." };
        }
        const seq = parseInt(messageId, 10);
        if (isNaN(seq) || seq < 1) {
          return { success: false, error: "messageId must be a positive number (sequence number)." };
        }
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({
          host: this.config.imap.host,
          port: this.config.imap.port,
          secure: this.config.imap.secure,
          auth: this.config.auth,
          logger: false
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock("INBOX");
          try {
            const msg = await client.fetchOne(String(seq), {
              envelope: true,
              source: true
            });
            if (!msg) {
              return { success: false, error: `Message #${seq} not found.` };
            }
            const from = msg.envelope?.from?.[0];
            const fromStr = from ? from.name ? `${from.name} <${from.address}>` : from.address ?? "unknown" : "unknown";
            const to = msg.envelope?.to?.map((t) => t.name ? `${t.name} <${t.address}>` : t.address ?? "").join(", ") ?? "";
            const rawSource = msg.source?.toString() ?? "";
            const body = this.extractTextBody(rawSource);
            return {
              success: true,
              data: {
                seq,
                from: fromStr,
                to,
                subject: msg.envelope?.subject ?? "(no subject)",
                date: msg.envelope?.date?.toISOString() ?? "",
                body
              },
              display: [
                `From: ${fromStr}`,
                `To: ${to}`,
                `Subject: ${msg.envelope?.subject ?? "(no subject)"}`,
                `Date: ${msg.envelope?.date?.toISOString() ?? ""}`,
                "",
                body.slice(0, 3e3) + (body.length > 3e3 ? "\n\n... (truncated)" : "")
              ].join("\n")
            };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }
      // ── IMAP: Search messages ──────────────────────────────────────
      async searchMessages(query, count) {
        if (!query) {
          return { success: false, error: "query is required for search." };
        }
        const limit = Math.min(Math.max(1, count ?? 10), 50);
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({
          host: this.config.imap.host,
          port: this.config.imap.port,
          secure: this.config.imap.secure,
          auth: this.config.auth,
          logger: false
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock("INBOX");
          try {
            const rawResult = await client.search({
              or: [
                { subject: query },
                { from: query },
                { body: query }
              ]
            });
            const searchResult = Array.isArray(rawResult) ? rawResult : [];
            if (searchResult.length === 0) {
              return { success: true, data: { results: [] }, display: `No emails found for "${query}".` };
            }
            const seqNums = searchResult.slice(-limit);
            const messages = [];
            for await (const msg of client.fetch(seqNums, { envelope: true })) {
              const from = msg.envelope?.from?.[0];
              const fromStr = from ? from.name ? `${from.name} <${from.address}>` : from.address ?? "unknown" : "unknown";
              messages.push({
                seq: msg.seq,
                from: fromStr,
                subject: msg.envelope?.subject ?? "(no subject)",
                date: msg.envelope?.date?.toISOString() ?? ""
              });
            }
            messages.reverse();
            const display = messages.map((m, i) => `${i + 1}. [#${m.seq}] ${m.subject}
   From: ${m.from}
   Date: ${m.date}`).join("\n\n");
            return {
              success: true,
              data: { query, results: messages, totalMatches: seqNums.length },
              display: `Search results for "${query}" (${seqNums.length} matches):

${display}`
            };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }
      // ── SMTP: Send message ─────────────────────────────────────────
      async sendMessage(to, subject, body) {
        if (!to)
          return { success: false, error: '"to" (recipient email) is required.' };
        if (!subject)
          return { success: false, error: '"subject" is required.' };
        if (!body)
          return { success: false, error: '"body" is required.' };
        const nodemailer = await import("nodemailer");
        const transport = nodemailer.createTransport({
          host: this.config.smtp.host,
          port: this.config.smtp.port,
          secure: this.config.smtp.secure,
          auth: this.config.auth
        });
        const info = await transport.sendMail({
          from: this.config.auth.user,
          to,
          subject,
          text: body
        });
        return {
          success: true,
          data: { messageId: info.messageId, to, subject },
          display: `Email sent to ${to}
Subject: ${subject}
Message ID: ${info.messageId}`
        };
      }
      // ── Helper: extract text body from raw email source ────────────
      extractTextBody(rawSource) {
        const parts = rawSource.split(/\r?\n\r?\n/);
        if (parts.length < 2)
          return rawSource;
        const headers = parts[0].toLowerCase();
        if (!headers.includes("multipart")) {
          return this.decodeBody(parts.slice(1).join("\n\n"));
        }
        const boundaryMatch = headers.match(/boundary="?([^"\s;]+)"?/i) ?? rawSource.match(/boundary="?([^"\s;]+)"?/i);
        if (!boundaryMatch) {
          return parts.slice(1).join("\n\n").slice(0, 5e3);
        }
        const boundary = boundaryMatch[1];
        const sections = rawSource.split(`--${boundary}`);
        for (const section of sections) {
          const sectionLower = section.toLowerCase();
          if (sectionLower.includes("content-type: text/plain") || sectionLower.includes("content-type:text/plain")) {
            const bodyStart = section.indexOf("\n\n");
            if (bodyStart >= 0) {
              return this.decodeBody(section.slice(bodyStart + 2));
            }
            const bodyStartCr = section.indexOf("\r\n\r\n");
            if (bodyStartCr >= 0) {
              return this.decodeBody(section.slice(bodyStartCr + 4));
            }
          }
        }
        return this.decodeBody(parts.slice(1).join("\n\n").slice(0, 5e3));
      }
      decodeBody(body) {
        return body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).trim();
      }
    };
  }
});

// ../skills/dist/built-in/http.js
var MAX_RESPONSE_SIZE, HttpSkill;
var init_http = __esm({
  "../skills/dist/built-in/http.js"() {
    "use strict";
    init_skill();
    MAX_RESPONSE_SIZE = 1e5;
    HttpSkill = class extends Skill {
      metadata = {
        name: "http",
        description: "Make HTTP requests to fetch web pages or call REST APIs. Use when you need to read a URL, call an API endpoint, or fetch data from the web. Supports GET, POST, PUT, PATCH, DELETE methods.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to request"
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              description: "HTTP method (default: GET)"
            },
            headers: {
              type: "object",
              description: "Request headers as key-value pairs (optional)"
            },
            body: {
              type: "string",
              description: "Request body for POST/PUT/PATCH (optional)"
            }
          },
          required: ["url"]
        }
      };
      async execute(input2, _context) {
        const url = input2.url;
        const method = (input2.method ?? "GET").toUpperCase();
        const headers = input2.headers;
        const body = input2.body;
        if (!url || typeof url !== "string") {
          return { success: false, error: 'Missing required field "url"' };
        }
        try {
          new URL(url);
        } catch {
          return { success: false, error: `Invalid URL: "${url}"` };
        }
        try {
          const fetchOptions = {
            method,
            headers: {
              "User-Agent": "Alfred/1.0",
              ...headers ?? {}
            },
            signal: AbortSignal.timeout(15e3)
          };
          if (body && ["POST", "PUT", "PATCH"].includes(method)) {
            fetchOptions.body = body;
            if (!headers?.["Content-Type"] && !headers?.["content-type"]) {
              fetchOptions.headers["Content-Type"] = "application/json";
            }
          }
          const res = await fetch(url, fetchOptions);
          const contentType = res.headers.get("content-type") ?? "";
          const text = await res.text();
          const truncated = text.length > MAX_RESPONSE_SIZE;
          const responseBody = truncated ? text.slice(0, MAX_RESPONSE_SIZE) + "\n\n[... truncated]" : text;
          let display = responseBody;
          if (contentType.includes("text/html")) {
            display = this.stripHtml(responseBody).slice(0, 1e4);
          }
          const data = {
            status: res.status,
            statusText: res.statusText,
            contentType,
            bodyLength: text.length,
            truncated,
            body: responseBody
          };
          if (!res.ok) {
            return {
              success: true,
              data,
              display: `HTTP ${res.status} ${res.statusText}

${display.slice(0, 2e3)}`
            };
          }
          return {
            success: true,
            data,
            display: `HTTP ${res.status} OK (${text.length} bytes)

${display.slice(0, 5e3)}`
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `HTTP request failed: ${msg}` };
        }
      }
      stripHtml(html) {
        return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      }
    };
  }
});

// ../skills/dist/built-in/file.js
import fs4 from "node:fs";
import path4 from "node:path";
var MAX_READ_SIZE, FileSkill;
var init_file = __esm({
  "../skills/dist/built-in/file.js"() {
    "use strict";
    init_skill();
    MAX_READ_SIZE = 5e5;
    FileSkill = class extends Skill {
      metadata = {
        name: "file",
        description: 'Read, write, move, or copy files. Use for reading file contents, writing text to files, saving binary data, listing directory contents, moving/copying files, or getting file info. Prefer this over shell for file operations. When a user sends a file attachment, it is saved to the inbox \u2014 use "move" to relocate it.',
        riskLevel: "write",
        version: "2.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["read", "write", "write_binary", "append", "list", "info", "exists", "move", "copy", "delete"],
              description: "The file operation to perform"
            },
            path: {
              type: "string",
              description: "Absolute or relative file/directory path (~ expands to home)"
            },
            destination: {
              type: "string",
              description: "Destination path for move/copy actions (~ expands to home)"
            },
            content: {
              type: "string",
              description: "Content to write (required for write/append; base64-encoded for write_binary)"
            }
          },
          required: ["action", "path"]
        }
      };
      async execute(input2, _context) {
        const action = input2.action;
        const rawPath = input2.path;
        const content = input2.content;
        const destination = input2.destination;
        if (!action || !rawPath) {
          return { success: false, error: 'Missing required fields "action" and "path"' };
        }
        const resolvedPath = this.resolvePath(rawPath);
        switch (action) {
          case "read":
            return this.readFile(resolvedPath);
          case "write":
            return this.writeFile(resolvedPath, content);
          case "write_binary":
            return this.writeBinaryFile(resolvedPath, content);
          case "append":
            return this.appendFile(resolvedPath, content);
          case "list":
            return this.listDir(resolvedPath);
          case "info":
            return this.fileInfo(resolvedPath);
          case "exists":
            return this.fileExists(resolvedPath);
          case "move":
            return this.moveFile(resolvedPath, destination);
          case "copy":
            return this.copyFile(resolvedPath, destination);
          case "delete":
            return this.deleteFile(resolvedPath);
          default:
            return { success: false, error: `Unknown action "${action}". Valid: read, write, write_binary, append, list, info, exists, move, copy, delete` };
        }
      }
      resolvePath(raw) {
        const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
        const expanded = raw.startsWith("~") ? raw.replace("~", home) : raw;
        return path4.resolve(expanded);
      }
      readFile(filePath) {
        try {
          const stat = fs4.statSync(filePath);
          if (stat.isDirectory()) {
            return { success: false, error: `"${filePath}" is a directory, not a file. Use action "list" instead.` };
          }
          if (stat.size > MAX_READ_SIZE) {
            const content2 = fs4.readFileSync(filePath, "utf-8").slice(0, MAX_READ_SIZE);
            return {
              success: true,
              data: { path: filePath, size: stat.size, truncated: true },
              display: `${filePath} (${stat.size} bytes, truncated to ${MAX_READ_SIZE}):

${content2}`
            };
          }
          const content = fs4.readFileSync(filePath, "utf-8");
          return {
            success: true,
            data: { path: filePath, size: stat.size, content },
            display: content
          };
        } catch (err) {
          return { success: false, error: `Cannot read "${filePath}": ${err.message}` };
        }
      }
      writeFile(filePath, content) {
        if (content === void 0 || content === null) {
          return { success: false, error: 'Missing "content" for write action' };
        }
        try {
          const dir = path4.dirname(filePath);
          fs4.mkdirSync(dir, { recursive: true });
          fs4.writeFileSync(filePath, content, "utf-8");
          return {
            success: true,
            data: { path: filePath, bytes: Buffer.byteLength(content) },
            display: `Written ${Buffer.byteLength(content)} bytes to ${filePath}`
          };
        } catch (err) {
          return { success: false, error: `Cannot write "${filePath}": ${err.message}` };
        }
      }
      appendFile(filePath, content) {
        if (content === void 0 || content === null) {
          return { success: false, error: 'Missing "content" for append action' };
        }
        try {
          fs4.appendFileSync(filePath, content, "utf-8");
          return {
            success: true,
            data: { path: filePath, appendedBytes: Buffer.byteLength(content) },
            display: `Appended ${Buffer.byteLength(content)} bytes to ${filePath}`
          };
        } catch (err) {
          return { success: false, error: `Cannot append to "${filePath}": ${err.message}` };
        }
      }
      listDir(dirPath) {
        try {
          const entries = fs4.readdirSync(dirPath, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file"
          }));
          const display = items.length === 0 ? `${dirPath}: (empty)` : items.map((i) => `${i.type === "dir" ? "\u{1F4C1}" : "\u{1F4C4}"} ${i.name}`).join("\n");
          return { success: true, data: { path: dirPath, entries: items }, display };
        } catch (err) {
          return { success: false, error: `Cannot list "${dirPath}": ${err.message}` };
        }
      }
      fileInfo(filePath) {
        try {
          const stat = fs4.statSync(filePath);
          const info = {
            path: filePath,
            type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
            size: stat.size,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            permissions: stat.mode.toString(8)
          };
          return {
            success: true,
            data: info,
            display: `${info.type}: ${filePath}
Size: ${stat.size} bytes
Modified: ${info.modified}`
          };
        } catch (err) {
          return { success: false, error: `Cannot stat "${filePath}": ${err.message}` };
        }
      }
      fileExists(filePath) {
        const exists = fs4.existsSync(filePath);
        return {
          success: true,
          data: { path: filePath, exists },
          display: exists ? `Yes, "${filePath}" exists` : `No, "${filePath}" does not exist`
        };
      }
      writeBinaryFile(filePath, base64Content) {
        if (!base64Content) {
          return { success: false, error: 'Missing "content" (base64-encoded) for write_binary action' };
        }
        try {
          const dir = path4.dirname(filePath);
          fs4.mkdirSync(dir, { recursive: true });
          const buffer = Buffer.from(base64Content, "base64");
          fs4.writeFileSync(filePath, buffer);
          return {
            success: true,
            data: { path: filePath, bytes: buffer.length },
            display: `Written ${buffer.length} bytes (binary) to ${filePath}`
          };
        } catch (err) {
          return { success: false, error: `Cannot write "${filePath}": ${err.message}` };
        }
      }
      moveFile(source, destination) {
        if (!destination) {
          return { success: false, error: 'Missing "destination" for move action' };
        }
        const resolvedDest = this.resolvePath(destination);
        try {
          const destDir = path4.dirname(resolvedDest);
          fs4.mkdirSync(destDir, { recursive: true });
          fs4.renameSync(source, resolvedDest);
          return {
            success: true,
            data: { from: source, to: resolvedDest },
            display: `Moved ${source} \u2192 ${resolvedDest}`
          };
        } catch (err) {
          try {
            fs4.copyFileSync(source, resolvedDest);
            fs4.unlinkSync(source);
            return {
              success: true,
              data: { from: source, to: resolvedDest },
              display: `Moved ${source} \u2192 ${resolvedDest}`
            };
          } catch (err2) {
            return { success: false, error: `Cannot move "${source}" to "${resolvedDest}": ${err2.message}` };
          }
        }
      }
      copyFile(source, destination) {
        if (!destination) {
          return { success: false, error: 'Missing "destination" for copy action' };
        }
        const resolvedDest = this.resolvePath(destination);
        try {
          const destDir = path4.dirname(resolvedDest);
          fs4.mkdirSync(destDir, { recursive: true });
          fs4.copyFileSync(source, resolvedDest);
          return {
            success: true,
            data: { from: source, to: resolvedDest },
            display: `Copied ${source} \u2192 ${resolvedDest}`
          };
        } catch (err) {
          return { success: false, error: `Cannot copy "${source}" to "${resolvedDest}": ${err.message}` };
        }
      }
      deleteFile(filePath) {
        try {
          if (!fs4.existsSync(filePath)) {
            return { success: false, error: `"${filePath}" does not exist` };
          }
          const stat = fs4.statSync(filePath);
          if (stat.isDirectory()) {
            return { success: false, error: `"${filePath}" is a directory. Use shell for directory deletion.` };
          }
          fs4.unlinkSync(filePath);
          return {
            success: true,
            data: { path: filePath },
            display: `Deleted ${filePath}`
          };
        } catch (err) {
          return { success: false, error: `Cannot delete "${filePath}": ${err.message}` };
        }
      }
    };
  }
});

// ../skills/dist/built-in/clipboard.js
import { execSync } from "node:child_process";
var ClipboardSkill;
var init_clipboard = __esm({
  "../skills/dist/built-in/clipboard.js"() {
    "use strict";
    init_skill();
    ClipboardSkill = class extends Skill {
      metadata = {
        name: "clipboard",
        description: "Read or write the system clipboard. Use when the user asks to copy something, paste from clipboard, or check what is in their clipboard.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["read", "write"],
              description: '"read" to get clipboard contents, "write" to set clipboard contents'
            },
            text: {
              type: "string",
              description: "Text to copy to clipboard (required for write)"
            }
          },
          required: ["action"]
        }
      };
      async execute(input2, _context) {
        const action = input2.action;
        switch (action) {
          case "read":
            return this.readClipboard();
          case "write":
            return this.writeClipboard(input2.text);
          default:
            return { success: false, error: `Unknown action "${action}". Valid: read, write` };
        }
      }
      readClipboard() {
        try {
          let content;
          switch (process.platform) {
            case "darwin":
              content = execSync("pbpaste", { encoding: "utf-8", timeout: 5e3 });
              break;
            case "win32":
              content = execSync("powershell -NoProfile -Command Get-Clipboard", {
                encoding: "utf-8",
                timeout: 5e3
              }).replace(/\r\n$/, "");
              break;
            default:
              content = execSync("xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output", {
                encoding: "utf-8",
                timeout: 5e3
              });
              break;
          }
          if (!content || content.trim().length === 0) {
            return { success: true, data: { content: "" }, display: "Clipboard is empty." };
          }
          return {
            success: true,
            data: { content },
            display: content.length > 2e3 ? content.slice(0, 2e3) + "\n\n[... truncated]" : content
          };
        } catch (err) {
          return { success: false, error: `Failed to read clipboard: ${err.message}` };
        }
      }
      writeClipboard(text) {
        if (!text || typeof text !== "string") {
          return { success: false, error: 'Missing "text" for write action' };
        }
        try {
          switch (process.platform) {
            case "darwin":
              execSync("pbcopy", { input: text, timeout: 5e3 });
              break;
            case "win32":
              execSync('powershell -NoProfile -Command "$input | Set-Clipboard"', {
                input: text,
                timeout: 5e3
              });
              break;
            default:
              execSync("xclip -selection clipboard 2>/dev/null || xsel --clipboard --input", {
                input: text,
                timeout: 5e3
              });
              break;
          }
          return {
            success: true,
            data: { copiedLength: text.length },
            display: `Copied ${text.length} characters to clipboard.`
          };
        } catch (err) {
          return { success: false, error: `Failed to write clipboard: ${err.message}` };
        }
      }
    };
  }
});

// ../skills/dist/built-in/screenshot.js
import { execSync as execSync2 } from "node:child_process";
import path5 from "node:path";
import os from "node:os";
var ScreenshotSkill;
var init_screenshot = __esm({
  "../skills/dist/built-in/screenshot.js"() {
    "use strict";
    init_skill();
    ScreenshotSkill = class extends Skill {
      metadata = {
        name: "screenshot",
        description: "Take a screenshot of the current screen and save it to a file. Use when the user asks to capture their screen or take a screenshot.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Output file path (optional, defaults to ~/Desktop/screenshot-<timestamp>.png)"
            }
          }
        }
      };
      async execute(input2, _context) {
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const defaultDir = path5.join(os.homedir(), "Desktop");
        const outputPath = input2.path || path5.join(defaultDir, `screenshot-${timestamp}.png`);
        try {
          switch (process.platform) {
            case "darwin":
              execSync2(`screencapture -x "${outputPath}"`, { timeout: 1e4 });
              break;
            case "win32":
              execSync2(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bitmap.Save('${outputPath.replace(/'/g, "''")}'); $graphics.Dispose(); $bitmap.Dispose()"`, { timeout: 1e4 });
              break;
            default:
              try {
                execSync2(`scrot "${outputPath}"`, { timeout: 1e4 });
              } catch {
                try {
                  execSync2(`import -window root "${outputPath}"`, { timeout: 1e4 });
                } catch {
                  execSync2(`gnome-screenshot -f "${outputPath}"`, { timeout: 1e4 });
                }
              }
              break;
          }
          return {
            success: true,
            data: { path: outputPath },
            display: `Screenshot saved to ${outputPath}`
          };
        } catch (err) {
          return { success: false, error: `Screenshot failed: ${err.message}` };
        }
      }
    };
  }
});

// ../skills/dist/built-in/browser.js
import path6 from "node:path";
import os2 from "node:os";
var MAX_TEXT_LENGTH, BrowserSkill;
var init_browser = __esm({
  "../skills/dist/built-in/browser.js"() {
    "use strict";
    init_skill();
    MAX_TEXT_LENGTH = 5e4;
    BrowserSkill = class extends Skill {
      browser = null;
      page = null;
      metadata = {
        name: "browser",
        description: "Open web pages in a real browser (Puppeteer/Chromium). Renders JavaScript, so it works with SPAs and dynamic sites. Can also interact with pages: click buttons, fill forms, take screenshots. Use when http skill returns empty/broken content, or when you need to interact with a web page.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["open", "screenshot", "click", "type", "evaluate", "close"],
              description: "open = navigate to URL and return page text. screenshot = save screenshot of current page. click = click element by CSS selector. type = type text into input by CSS selector. evaluate = run JavaScript on the page. close = close the browser."
            },
            url: {
              type: "string",
              description: 'URL to open (required for "open", optional for "screenshot")'
            },
            selector: {
              type: "string",
              description: 'CSS selector for the element (required for "click" and "type")'
            },
            text: {
              type: "string",
              description: 'Text to type (required for "type")'
            },
            script: {
              type: "string",
              description: 'JavaScript code to evaluate (required for "evaluate")'
            },
            path: {
              type: "string",
              description: "File path to save screenshot (optional, defaults to Desktop)"
            }
          },
          required: ["action"]
        }
      };
      async execute(input2, _context) {
        const action = input2.action;
        if (action === "close") {
          return this.closeBrowser();
        }
        const pup = await this.loadPuppeteer();
        if (!pup) {
          return {
            success: false,
            error: "Puppeteer is not installed. Run: npm install -g puppeteer\nOr add it to Alfred: npm install puppeteer"
          };
        }
        switch (action) {
          case "open":
            return this.openPage(pup, input2);
          case "screenshot":
            return this.screenshotPage(pup, input2);
          case "click":
            return this.clickElement(input2);
          case "type":
            return this.typeText(input2);
          case "evaluate":
            return this.evaluateScript(input2);
          default:
            return { success: false, error: `Unknown action "${action}". Valid: open, screenshot, click, type, evaluate, close` };
        }
      }
      async loadPuppeteer() {
        try {
          const mod = await Function('return import("puppeteer")')();
          return this.resolvePuppeteerModule(mod);
        } catch {
          try {
            const mod = await Function('return import("puppeteer-core")')();
            return this.resolvePuppeteerModule(mod);
          } catch {
            return null;
          }
        }
      }
      resolvePuppeteerModule(mod) {
        const m = mod;
        if (typeof m.launch === "function")
          return m;
        const def = m.default;
        return def;
      }
      async ensureBrowser(pup) {
        if (this.browser && this.browser.connected) {
          return this.browser;
        }
        this.browser = await pup.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
        return this.browser;
      }
      async ensurePage(pup) {
        const browser = await this.ensureBrowser(pup);
        if (!this.page) {
          this.page = await browser.newPage();
          await this.page.setViewport({ width: 1280, height: 900 });
        }
        return this.page;
      }
      async openPage(pup, input2) {
        const url = input2.url;
        if (!url) {
          return { success: false, error: 'Missing "url" for open action' };
        }
        try {
          const page = await this.ensurePage(pup);
          await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 });
          const title = await page.title();
          const text = await page.evaluate(`
        (() => {
          document.querySelectorAll('script, style, noscript').forEach(el => el.remove());
          return document.body?.innerText ?? '';
        })()
      `);
          const trimmed = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "\n\n[... truncated]" : text;
          const cleaned = trimmed.replace(/\n{3,}/g, "\n\n").trim();
          return {
            success: true,
            data: { url: page.url(), title, length: text.length },
            display: `**${title}** (${page.url()})

${cleaned}`
          };
        } catch (err) {
          return { success: false, error: `Failed to open "${url}": ${err.message}` };
        }
      }
      async screenshotPage(pup, input2) {
        try {
          const page = await this.ensurePage(pup);
          const url = input2.url;
          if (url) {
            await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 });
          }
          const currentUrl = page.url();
          if (currentUrl === "about:blank") {
            return { success: false, error: 'No page is open. Use action "open" with a URL first, or provide a URL.' };
          }
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const outputPath = input2.path || path6.join(os2.homedir(), "Desktop", `browser-${timestamp}.png`);
          await page.screenshot({ path: outputPath, fullPage: false });
          return {
            success: true,
            data: { path: outputPath, url: currentUrl },
            display: `Screenshot saved to ${outputPath}`
          };
        } catch (err) {
          return { success: false, error: `Screenshot failed: ${err.message}` };
        }
      }
      async clickElement(input2) {
        const selector = input2.selector;
        if (!selector) {
          return { success: false, error: 'Missing "selector" for click action' };
        }
        if (!this.page) {
          return { success: false, error: 'No page is open. Use action "open" first.' };
        }
        try {
          await this.page.waitForSelector(selector, { timeout: 5e3 });
          await this.page.click(selector);
          try {
            await this.page.waitForNavigation({ timeout: 3e3 });
          } catch {
          }
          const title = await this.page.title();
          return {
            success: true,
            data: { selector, url: this.page.url(), title },
            display: `Clicked "${selector}" \u2014 now on: ${title} (${this.page.url()})`
          };
        } catch (err) {
          return { success: false, error: `Click failed on "${selector}": ${err.message}` };
        }
      }
      async typeText(input2) {
        const selector = input2.selector;
        const text = input2.text;
        if (!selector)
          return { success: false, error: 'Missing "selector" for type action' };
        if (!text)
          return { success: false, error: 'Missing "text" for type action' };
        if (!this.page) {
          return { success: false, error: 'No page is open. Use action "open" first.' };
        }
        try {
          await this.page.waitForSelector(selector, { timeout: 5e3 });
          await this.page.click(selector);
          await this.page.type(selector, text, { delay: 50 });
          return {
            success: true,
            data: { selector, textLength: text.length },
            display: `Typed ${text.length} characters into "${selector}"`
          };
        } catch (err) {
          return { success: false, error: `Type failed on "${selector}": ${err.message}` };
        }
      }
      async evaluateScript(input2) {
        const script = input2.script;
        if (!script) {
          return { success: false, error: 'Missing "script" for evaluate action' };
        }
        if (!this.page) {
          return { success: false, error: 'No page is open. Use action "open" first.' };
        }
        try {
          const result = await this.page.evaluate(script);
          const output2 = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return {
            success: true,
            data: { result },
            display: output2?.slice(0, 1e4) ?? "(no output)"
          };
        } catch (err) {
          return { success: false, error: `Evaluate failed: ${err.message}` };
        }
      }
      async closeBrowser() {
        try {
          this.page = null;
          if (this.browser) {
            await this.browser.close();
            this.browser = null;
          }
          return { success: true, display: "Browser closed." };
        } catch (err) {
          this.browser = null;
          this.page = null;
          return { success: false, error: `Close failed: ${err.message}` };
        }
      }
    };
  }
});

// ../skills/dist/index.js
var init_dist6 = __esm({
  "../skills/dist/index.js"() {
    "use strict";
    init_skill();
    init_skill_registry();
    init_skill_sandbox();
    init_plugin_loader();
    init_calculator();
    init_system_info();
    init_web_search();
    init_reminder();
    init_note();
    init_weather();
    init_shell();
    init_memory();
    init_delegate();
    init_email();
    init_http();
    init_file();
    init_clipboard();
    init_screenshot();
    init_browser();
  }
});

// ../core/dist/conversation-manager.js
var ConversationManager;
var init_conversation_manager = __esm({
  "../core/dist/conversation-manager.js"() {
    "use strict";
    ConversationManager = class {
      conversations;
      constructor(conversations) {
        this.conversations = conversations;
      }
      getOrCreateConversation(platform, chatId, userId) {
        const existing = this.conversations.findByPlatformChat(platform, chatId);
        if (existing) {
          this.conversations.updateTimestamp(existing.id);
          return existing;
        }
        return this.conversations.create(platform, chatId, userId);
      }
      addMessage(conversationId, role, content, toolCalls) {
        return this.conversations.addMessage(conversationId, role, content, toolCalls);
      }
      getHistory(conversationId, limit = 20) {
        return this.conversations.getMessages(conversationId, limit);
      }
    };
  }
});

// ../core/dist/message-pipeline.js
import fs5 from "node:fs";
import path7 from "node:path";
var MAX_TOOL_ITERATIONS, TOKEN_BUDGET_RATIO, MAX_INLINE_FILE_SIZE, MessagePipeline;
var init_message_pipeline = __esm({
  "../core/dist/message-pipeline.js"() {
    "use strict";
    init_dist4();
    MAX_TOOL_ITERATIONS = 10;
    TOKEN_BUDGET_RATIO = 0.85;
    MAX_INLINE_FILE_SIZE = 1e5;
    MessagePipeline = class {
      llm;
      conversationManager;
      users;
      logger;
      skillRegistry;
      skillSandbox;
      securityManager;
      memoryRepo;
      speechTranscriber;
      inboxPath;
      promptBuilder;
      constructor(llm, conversationManager, users, logger, skillRegistry, skillSandbox, securityManager, memoryRepo, speechTranscriber, inboxPath) {
        this.llm = llm;
        this.conversationManager = conversationManager;
        this.users = users;
        this.logger = logger;
        this.skillRegistry = skillRegistry;
        this.skillSandbox = skillSandbox;
        this.securityManager = securityManager;
        this.memoryRepo = memoryRepo;
        this.speechTranscriber = speechTranscriber;
        this.inboxPath = inboxPath;
        this.promptBuilder = new PromptBuilder();
      }
      async process(message, onProgress) {
        const startTime = Date.now();
        this.logger.info({ platform: message.platform, userId: message.userId, chatId: message.chatId }, "Processing message");
        try {
          const user = this.users.findOrCreate(message.platform, message.userId, message.userName, message.displayName);
          const conversation = this.conversationManager.getOrCreateConversation(message.platform, message.chatId, user.id);
          const history = this.conversationManager.getHistory(conversation.id, 50);
          this.conversationManager.addMessage(conversation.id, "user", message.text);
          let memories;
          if (this.memoryRepo) {
            try {
              memories = this.memoryRepo.getRecentForPrompt(user.id, 20);
            } catch {
            }
          }
          const skillMetas = this.skillRegistry ? this.skillRegistry.getAll().map((s) => s.metadata) : void 0;
          const tools = skillMetas ? this.promptBuilder.buildTools(skillMetas) : void 0;
          const system = this.promptBuilder.buildSystemPrompt(memories, skillMetas);
          const allMessages = this.promptBuilder.buildMessages(history);
          const userContent = await this.buildUserContent(message, onProgress);
          allMessages.push({ role: "user", content: userContent });
          const messages = this.trimToContextWindow(system, allMessages);
          let response;
          let iteration = 0;
          onProgress?.("Thinking...");
          while (true) {
            response = await this.llm.complete({
              messages,
              system,
              tools: tools && tools.length > 0 ? tools : void 0
            });
            if (!response.toolCalls || response.toolCalls.length === 0 || iteration >= MAX_TOOL_ITERATIONS) {
              if (iteration >= MAX_TOOL_ITERATIONS && response.toolCalls?.length) {
                this.logger.warn({ iteration }, "Max tool iterations reached, stopping loop");
              }
              break;
            }
            iteration++;
            this.logger.info({ iteration, toolCalls: response.toolCalls.length }, "Processing tool calls");
            const assistantContent = [];
            if (response.content) {
              assistantContent.push({ type: "text", text: response.content });
            }
            for (const tc of response.toolCalls) {
              assistantContent.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.input
              });
            }
            messages.push({ role: "assistant", content: assistantContent });
            const toolResultBlocks = [];
            for (const toolCall of response.toolCalls) {
              const toolLabel = this.getToolLabel(toolCall.name, toolCall.input);
              onProgress?.(toolLabel);
              const result = await this.executeToolCall(toolCall, {
                userId: message.userId,
                chatId: message.chatId,
                chatType: message.chatType,
                platform: message.platform,
                conversationId: conversation.id
              });
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: toolCall.id,
                content: result.content,
                is_error: result.isError
              });
            }
            const toolCallSummary = response.toolCalls.map((tc) => `[Used ${tc.name}: ${JSON.stringify(tc.input)}]`).join("\n");
            const toolResultSummary = toolResultBlocks.map((tr) => {
              const output2 = tr.type === "tool_result" ? String(tr.content).slice(0, 1e3) : "";
              return `[Result: ${output2}]`;
            }).join("\n");
            this.conversationManager.addMessage(conversation.id, "assistant", `${response.content ? response.content + "\n" : ""}${toolCallSummary}`, JSON.stringify(response.toolCalls));
            this.conversationManager.addMessage(conversation.id, "user", toolResultSummary);
            messages.push({ role: "user", content: toolResultBlocks });
            if (iteration < MAX_TOOL_ITERATIONS) {
              onProgress?.("Thinking...");
            }
          }
          const responseText = response.content || "(no response)";
          this.conversationManager.addMessage(conversation.id, "assistant", responseText);
          const duration = Date.now() - startTime;
          this.logger.info({ duration, tokens: response.usage, stopReason: response.stopReason, toolIterations: iteration }, "Message processed");
          return responseText;
        } catch (error) {
          this.logger.error({ err: error }, "Failed to process message");
          throw error;
        }
      }
      async executeToolCall(toolCall, context) {
        const skill = this.skillRegistry?.get(toolCall.name);
        if (!skill) {
          this.logger.warn({ tool: toolCall.name }, "Unknown skill requested");
          return { content: `Error: Unknown tool "${toolCall.name}"`, isError: true };
        }
        if (this.securityManager) {
          const evaluation = this.securityManager.evaluate({
            userId: context.userId,
            action: toolCall.name,
            riskLevel: skill.metadata.riskLevel,
            platform: context.platform,
            chatId: context.chatId,
            chatType: context.chatType
          });
          if (!evaluation.allowed) {
            this.logger.warn({ tool: toolCall.name, reason: evaluation.reason, rule: evaluation.matchedRule?.id }, "Skill execution denied by security rules");
            return {
              content: `Access denied: ${evaluation.reason}`,
              isError: true
            };
          }
        }
        if (this.skillSandbox) {
          const result = await this.skillSandbox.execute(skill, toolCall.input, context);
          return {
            content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? "Unknown error"),
            isError: !result.success
          };
        }
        try {
          const result = await skill.execute(toolCall.input, context);
          return {
            content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? "Unknown error"),
            isError: !result.success
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Skill execution failed: ${msg}`, isError: true };
        }
      }
      getToolLabel(toolName, input2) {
        switch (toolName) {
          case "shell":
            return `Running: ${String(input2.command ?? "").slice(0, 60)}`;
          case "web_search":
            return `Searching: ${String(input2.query ?? "")}`;
          case "email":
            return `Email: ${String(input2.action ?? "")}`;
          case "memory":
            return `Memory: ${String(input2.action ?? "")}`;
          case "reminder":
            return `Reminder: ${String(input2.action ?? "")}`;
          case "calculator":
            return `Calculating...`;
          case "system_info":
            return `Getting system info...`;
          case "delegate":
            return `Delegating sub-task...`;
          case "http":
            return `Fetching: ${String(input2.url ?? "").slice(0, 60)}`;
          case "file":
            return `File: ${String(input2.action ?? "")} ${String(input2.path ?? "").slice(0, 50)}`;
          case "clipboard":
            return `Clipboard: ${String(input2.action ?? "")}`;
          case "screenshot":
            return `Taking screenshot...`;
          case "browser":
            return `Browser: ${String(input2.action ?? "")} ${String(input2.url ?? "").slice(0, 50)}`;
          case "weather":
            return `Weather: ${String(input2.location ?? "")}`;
          case "note":
            return `Note: ${String(input2.action ?? "")}`;
          default:
            return `Using ${toolName}...`;
        }
      }
      /**
       * Trim messages to fit within the LLM's context window.
       * Keeps the system prompt, the latest user message, and as many
       * recent history messages as possible. Drops oldest messages first.
       * Injects a summary note when messages are trimmed.
       */
      trimToContextWindow(system, messages) {
        const contextWindow = this.llm.getContextWindow();
        const maxInputTokens = Math.floor(contextWindow.maxInputTokens * TOKEN_BUDGET_RATIO);
        const systemTokens = estimateTokens(system);
        const latestMsg = messages[messages.length - 1];
        const latestTokens = estimateMessageTokens(latestMsg);
        const reservedTokens = systemTokens + latestTokens + 200;
        let availableTokens = maxInputTokens - reservedTokens;
        if (availableTokens <= 0) {
          this.logger.warn({ maxInputTokens, systemTokens, latestTokens }, "Context window very tight, sending only latest message");
          return [latestMsg];
        }
        const keptMessages = [];
        for (let i = messages.length - 2; i >= 0; i--) {
          const msgTokens = estimateMessageTokens(messages[i]);
          if (msgTokens > availableTokens)
            break;
          availableTokens -= msgTokens;
          keptMessages.unshift(messages[i]);
        }
        const trimmedCount = messages.length - 1 - keptMessages.length;
        if (trimmedCount > 0) {
          this.logger.info({ trimmedCount, totalMessages: messages.length, maxInputTokens }, "Trimmed conversation history to fit context window");
          keptMessages.unshift({
            role: "user",
            content: `[System note: ${trimmedCount} older message(s) were omitted to fit the context window. The conversation continues from the most recent messages.]`
          });
        }
        keptMessages.push(latestMsg);
        return keptMessages;
      }
      /**
       * Build the user content for the LLM request.
       * Handles images (as vision blocks), audio (transcribed via Whisper),
       * documents/files (saved to inbox), and plain text.
       */
      async buildUserContent(message, onProgress) {
        const attachments = message.attachments?.filter((a) => a.data) ?? [];
        if (attachments.length === 0) {
          return message.text;
        }
        const blocks = [];
        for (const attachment of attachments) {
          if (attachment.type === "image" && attachment.data) {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: attachment.mimeType ?? "image/jpeg",
                data: attachment.data.toString("base64")
              }
            });
            this.logger.info({ mimeType: attachment.mimeType, size: attachment.size }, "Image attached to LLM request");
          } else if (attachment.type === "audio" && attachment.data) {
            if (this.speechTranscriber) {
              onProgress?.("Transcribing voice...");
              try {
                const transcript = await this.speechTranscriber.transcribe(attachment.data, attachment.mimeType ?? "audio/ogg");
                const label = message.text === "[Voice message]" ? "" : `${message.text}

`;
                blocks.push({
                  type: "text",
                  text: `${label}[Voice transcript]: ${transcript}`
                });
                this.logger.info({ transcriptLength: transcript.length }, "Voice message transcribed");
                return blocks.length === 1 ? blocks[0].type === "text" ? blocks[0].text : blocks : blocks;
              } catch (err) {
                this.logger.error({ err }, "Voice transcription failed");
                blocks.push({
                  type: "text",
                  text: "[Voice message could not be transcribed]"
                });
              }
            } else {
              blocks.push({
                type: "text",
                text: "[Voice message received but speech-to-text is not configured. Add speech config to enable transcription.]"
              });
            }
          } else if ((attachment.type === "document" || attachment.type === "video" || attachment.type === "other") && attachment.data) {
            const savedPath = this.saveToInbox(attachment);
            if (savedPath) {
              const isTextFile = this.isTextMimeType(attachment.mimeType);
              let fileNote = `[File received: "${attachment.fileName ?? "unknown"}" (${this.formatBytes(attachment.data.length)}, ${attachment.mimeType ?? "unknown type"})]
[Saved to: ${savedPath}]`;
              if (isTextFile && attachment.data.length <= MAX_INLINE_FILE_SIZE) {
                const textContent = attachment.data.toString("utf-8");
                fileNote += `
[File content]:
${textContent}`;
              }
              blocks.push({ type: "text", text: fileNote });
              this.logger.info({ fileName: attachment.fileName, savedPath, size: attachment.data.length }, "File saved to inbox");
            }
          }
        }
        const skipTexts = ["[Photo]", "[Voice message]", "[Video]", "[Video note]", "[Document]", "[File]"];
        if (message.text && !skipTexts.includes(message.text)) {
          blocks.push({ type: "text", text: message.text });
        } else if (blocks.some((b) => b.type === "image") && !blocks.some((b) => b.type === "text")) {
          blocks.push({ type: "text", text: "What do you see in this image?" });
        } else if (blocks.length === 0) {
          blocks.push({ type: "text", text: message.text || "(empty message)" });
        }
        return blocks;
      }
      /**
       * Save an attachment to the inbox directory.
       * Returns the saved file path, or undefined on failure.
       */
      saveToInbox(attachment) {
        if (!attachment.data)
          return void 0;
        const inboxDir = this.inboxPath ?? path7.resolve("./data/inbox");
        try {
          fs5.mkdirSync(inboxDir, { recursive: true });
        } catch {
          this.logger.error({ inboxDir }, "Cannot create inbox directory");
          return void 0;
        }
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const originalName = attachment.fileName ?? `file_${timestamp}`;
        const safeName = originalName.replace(/[<>:"/\\|?*]/g, "_");
        const fileName = `${timestamp}_${safeName}`;
        const filePath = path7.join(inboxDir, fileName);
        try {
          fs5.writeFileSync(filePath, attachment.data);
          return filePath;
        } catch (err) {
          this.logger.error({ err, filePath }, "Failed to save file to inbox");
          return void 0;
        }
      }
      isTextMimeType(mimeType) {
        if (!mimeType)
          return false;
        const textTypes = [
          "text/",
          "application/json",
          "application/xml",
          "application/javascript",
          "application/typescript",
          "application/x-yaml",
          "application/yaml",
          "application/toml",
          "application/x-sh",
          "application/sql",
          "application/csv",
          "application/x-csv"
        ];
        return textTypes.some((t) => mimeType.startsWith(t));
      }
      formatBytes(bytes) {
        if (bytes < 1024)
          return `${bytes} B`;
        if (bytes < 1024 * 1024)
          return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      }
    };
  }
});

// ../core/dist/reminder-scheduler.js
var ReminderScheduler;
var init_reminder_scheduler = __esm({
  "../core/dist/reminder-scheduler.js"() {
    "use strict";
    ReminderScheduler = class {
      reminderRepo;
      sendMessage;
      logger;
      intervalId;
      checkIntervalMs;
      constructor(reminderRepo, sendMessage, logger, checkIntervalMs = 15e3) {
        this.reminderRepo = reminderRepo;
        this.sendMessage = sendMessage;
        this.logger = logger;
        this.checkIntervalMs = checkIntervalMs;
      }
      start() {
        this.logger.info("Reminder scheduler started");
        this.intervalId = setInterval(() => this.checkDueReminders(), this.checkIntervalMs);
        this.checkDueReminders();
      }
      stop() {
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = void 0;
        }
        this.logger.info("Reminder scheduler stopped");
      }
      async checkDueReminders() {
        try {
          const due = this.reminderRepo.getDue();
          for (const reminder of due) {
            try {
              await this.sendMessage(reminder.platform, reminder.chatId, `\u23F0 Reminder: ${reminder.message}`);
              this.reminderRepo.markFired(reminder.id);
              this.logger.info({ reminderId: reminder.id }, "Reminder fired");
            } catch (err) {
              this.logger.error({ err, reminderId: reminder.id }, "Failed to send reminder");
            }
          }
        } catch (err) {
          this.logger.error({ err }, "Error checking due reminders");
        }
      }
    };
  }
});

// ../core/dist/speech-transcriber.js
var SpeechTranscriber;
var init_speech_transcriber = __esm({
  "../core/dist/speech-transcriber.js"() {
    "use strict";
    SpeechTranscriber = class {
      logger;
      apiKey;
      baseUrl;
      constructor(config, logger) {
        this.logger = logger;
        this.apiKey = config.apiKey;
        if (config.provider === "groq") {
          this.baseUrl = config.baseUrl ?? "https://api.groq.com/openai/v1";
        } else {
          this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
        }
      }
      async transcribe(audioBuffer, mimeType) {
        const ext = this.mimeToExtension(mimeType);
        const formData = new FormData();
        formData.append("file", new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
        formData.append("model", "whisper-1");
        try {
          const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.apiKey}`
            },
            body: formData
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Whisper API ${response.status}: ${errorText}`);
          }
          const data = await response.json();
          this.logger.info({ textLength: data.text.length }, "Voice transcribed");
          return data.text;
        } catch (err) {
          this.logger.error({ err }, "Voice transcription failed");
          throw err;
        }
      }
      mimeToExtension(mimeType) {
        const map = {
          "audio/ogg": "ogg",
          "audio/mpeg": "mp3",
          "audio/mp4": "m4a",
          "audio/wav": "wav",
          "audio/webm": "webm",
          "audio/x-m4a": "m4a"
        };
        return map[mimeType] ?? "ogg";
      }
    };
  }
});

// ../messaging/dist/adapter.js
import { EventEmitter } from "node:events";
var MessagingAdapter;
var init_adapter = __esm({
  "../messaging/dist/adapter.js"() {
    "use strict";
    MessagingAdapter = class extends EventEmitter {
      status = "disconnected";
      async sendPhoto(_chatId, _photo, _caption) {
        return void 0;
      }
      async sendFile(_chatId, _file, _fileName, _caption) {
        return void 0;
      }
      getStatus() {
        return this.status;
      }
    };
  }
});

// ../messaging/dist/adapters/telegram.js
import { Bot, InputFile } from "grammy";
function mapParseMode(mode) {
  if (mode === "markdown")
    return "MarkdownV2";
  if (mode === "html")
    return "HTML";
  return void 0;
}
var TelegramAdapter;
var init_telegram = __esm({
  "../messaging/dist/adapters/telegram.js"() {
    "use strict";
    init_adapter();
    TelegramAdapter = class extends MessagingAdapter {
      platform = "telegram";
      bot;
      constructor(token) {
        super();
        this.bot = new Bot(token);
      }
      async connect() {
        this.status = "connecting";
        this.bot.on("message:text", (ctx) => {
          this.emit("message", this.normalizeMessage(ctx.message, ctx.message.text));
        });
        this.bot.on("message:photo", async (ctx) => {
          const msg = ctx.message;
          const caption = msg.caption ?? "";
          const text = caption || "[Photo]";
          const photo = msg.photo[msg.photo.length - 1];
          const attachment = await this.downloadAttachment(photo.file_id, "image", "image/jpeg");
          const normalized = this.normalizeMessage(msg, text);
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:voice", async (ctx) => {
          const msg = ctx.message;
          const attachment = await this.downloadAttachment(msg.voice.file_id, "audio", msg.voice.mime_type ?? "audio/ogg");
          const normalized = this.normalizeMessage(msg, "[Voice message]");
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:audio", async (ctx) => {
          const msg = ctx.message;
          const caption = msg.caption ?? "";
          const text = caption || `[Audio: ${msg.audio.file_name ?? "audio"}]`;
          const attachment = await this.downloadAttachment(msg.audio.file_id, "audio", msg.audio.mime_type ?? "audio/mpeg");
          const normalized = this.normalizeMessage(msg, text);
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:video", async (ctx) => {
          const msg = ctx.message;
          const caption = msg.caption ?? "";
          const text = caption || "[Video]";
          const attachment = await this.downloadAttachment(msg.video.file_id, "video", msg.video.mime_type ?? "video/mp4");
          const normalized = this.normalizeMessage(msg, text);
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:document", async (ctx) => {
          const msg = ctx.message;
          const doc = msg.document;
          const caption = msg.caption ?? "";
          const text = caption || `[Document: ${doc.file_name ?? "file"}]`;
          const attachment = await this.downloadAttachment(doc.file_id, "document", doc.mime_type ?? "application/octet-stream", doc.file_name);
          const normalized = this.normalizeMessage(msg, text);
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:video_note", async (ctx) => {
          const msg = ctx.message;
          const attachment = await this.downloadAttachment(msg.video_note.file_id, "video", "video/mp4");
          const normalized = this.normalizeMessage(msg, "[Video note]");
          normalized.attachments = attachment ? [attachment] : void 0;
          this.emit("message", normalized);
        });
        this.bot.on("message:sticker", (ctx) => {
          const msg = ctx.message;
          const emoji = msg.sticker.emoji ?? "\u{1F3F7}\uFE0F";
          this.emit("message", this.normalizeMessage(msg, `[Sticker: ${emoji}]`));
        });
        this.bot.catch((err) => {
          this.emit("error", err.error);
        });
        this.bot.start({
          onStart: () => {
            this.status = "connected";
            this.emit("connected");
          }
        });
      }
      async disconnect() {
        await this.bot.stop();
        this.status = "disconnected";
        this.emit("disconnected");
      }
      async sendMessage(chatId, text, options) {
        const result = await this.bot.api.sendMessage(Number(chatId), text, {
          reply_to_message_id: options?.replyToMessageId ? Number(options.replyToMessageId) : void 0,
          parse_mode: mapParseMode(options?.parseMode)
        });
        return String(result.message_id);
      }
      async editMessage(chatId, messageId, text) {
        await this.bot.api.editMessageText(Number(chatId), Number(messageId), text);
      }
      async deleteMessage(chatId, messageId) {
        await this.bot.api.deleteMessage(Number(chatId), Number(messageId));
      }
      async sendPhoto(chatId, photo, caption) {
        const result = await this.bot.api.sendPhoto(Number(chatId), new InputFile(photo, "image.png"), { caption });
        return String(result.message_id);
      }
      async sendFile(chatId, file, fileName, caption) {
        const result = await this.bot.api.sendDocument(Number(chatId), new InputFile(file, fileName), { caption });
        return String(result.message_id);
      }
      normalizeMessage(msg, text) {
        return {
          id: String(msg.message_id),
          platform: "telegram",
          chatId: String(msg.chat.id),
          chatType: msg.chat.type === "private" ? "dm" : "group",
          userId: String(msg.from.id),
          userName: msg.from.username ?? String(msg.from.id),
          displayName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
          text,
          timestamp: new Date(msg.date * 1e3),
          replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : void 0
        };
      }
      async downloadAttachment(fileId, type, mimeType, fileName) {
        try {
          const file = await this.bot.api.getFile(fileId);
          const filePath = file.file_path;
          if (!filePath)
            return void 0;
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
          const response = await fetch(url);
          if (!response.ok)
            return void 0;
          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            type,
            mimeType,
            fileName: fileName ?? filePath.split("/").pop(),
            size: buffer.length,
            data: buffer
          };
        } catch {
          return void 0;
        }
      }
    };
  }
});

// ../messaging/dist/adapters/discord.js
import { Client, GatewayIntentBits, Events } from "discord.js";
var DiscordAdapter;
var init_discord = __esm({
  "../messaging/dist/adapters/discord.js"() {
    "use strict";
    init_adapter();
    DiscordAdapter = class extends MessagingAdapter {
      platform = "discord";
      client = null;
      token;
      constructor(token) {
        super();
        this.token = token;
      }
      async connect() {
        this.status = "connecting";
        this.client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
          ]
        });
        this.client.on(Events.MessageCreate, async (message) => {
          if (message.author.bot)
            return;
          try {
            const attachments = await this.downloadAttachments(message);
            const text = message.content || this.inferTextFromAttachments(attachments);
            const normalized = {
              id: message.id,
              platform: "discord",
              chatId: message.channelId,
              chatType: message.channel.isDMBased() ? "dm" : "group",
              userId: message.author.id,
              userName: message.author.username,
              displayName: message.author.displayName,
              text,
              timestamp: message.createdAt,
              replyToMessageId: message.reference?.messageId ?? void 0,
              attachments: attachments.length > 0 ? attachments : void 0
            };
            this.emit("message", normalized);
          } catch (err) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        });
        this.client.on(Events.ClientReady, () => {
          this.status = "connected";
          this.emit("connected");
        });
        this.client.on(Events.Error, (error) => {
          this.emit("error", error);
        });
        await this.client.login(this.token);
      }
      async disconnect() {
        this.client?.destroy();
        this.client = null;
        this.status = "disconnected";
        this.emit("disconnected");
      }
      async sendMessage(chatId, text, options) {
        if (!this.client)
          throw new Error("Client is not connected");
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("send" in channel)) {
          throw new Error(`Channel ${chatId} is not a text channel`);
        }
        if (options?.replyToMessageId) {
          const original = await channel.messages.fetch(options.replyToMessageId);
          const reply = await original.reply(text);
          return reply.id;
        }
        const message = await channel.send(text);
        return message.id;
      }
      async editMessage(chatId, messageId, text) {
        if (!this.client)
          throw new Error("Client is not connected");
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("messages" in channel)) {
          throw new Error(`Channel ${chatId} is not a text channel`);
        }
        const message = await channel.messages.fetch(messageId);
        await message.edit(text);
      }
      async deleteMessage(chatId, messageId) {
        if (!this.client)
          throw new Error("Client is not connected");
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("messages" in channel)) {
          throw new Error(`Channel ${chatId} is not a text channel`);
        }
        const message = await channel.messages.fetch(messageId);
        await message.delete();
      }
      async sendPhoto(chatId, photo, caption) {
        if (!this.client)
          return void 0;
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("send" in channel))
          return void 0;
        const msg = await channel.send({
          content: caption,
          files: [{ attachment: photo, name: "image.png" }]
        });
        return msg.id;
      }
      async sendFile(chatId, file, fileName, caption) {
        if (!this.client)
          return void 0;
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("send" in channel))
          return void 0;
        const msg = await channel.send({
          content: caption,
          files: [{ attachment: file, name: fileName }]
        });
        return msg.id;
      }
      // ── Private helpers ──────────────────────────────────────────────
      async downloadAttachments(message) {
        const result = [];
        const discordAttachments = message.attachments;
        if (!discordAttachments || discordAttachments.size === 0)
          return result;
        for (const [, att] of discordAttachments) {
          try {
            const res = await fetch(att.url);
            if (!res.ok)
              continue;
            const arrayBuffer = await res.arrayBuffer();
            const data = Buffer.from(arrayBuffer);
            const type = this.classifyContentType(att.contentType);
            result.push({
              type,
              url: att.url,
              mimeType: att.contentType ?? void 0,
              fileName: att.name ?? void 0,
              size: att.size ?? data.length,
              data
            });
          } catch {
          }
        }
        return result;
      }
      classifyContentType(contentType) {
        if (!contentType)
          return "other";
        if (contentType.startsWith("image/"))
          return "image";
        if (contentType.startsWith("audio/"))
          return "audio";
        if (contentType.startsWith("video/"))
          return "video";
        return "document";
      }
      inferTextFromAttachments(attachments) {
        if (attachments.length === 0)
          return "";
        const types = attachments.map((a) => a.type);
        if (types.includes("image"))
          return "[Photo]";
        if (types.includes("audio"))
          return "[Voice message]";
        if (types.includes("video"))
          return "[Video]";
        if (types.includes("document"))
          return "[Document]";
        return "[File]";
      }
    };
  }
});

// ../messaging/dist/adapters/matrix.js
var MatrixAdapter;
var init_matrix = __esm({
  "../messaging/dist/adapters/matrix.js"() {
    "use strict";
    init_adapter();
    MatrixAdapter = class extends MessagingAdapter {
      platform = "matrix";
      client;
      homeserverUrl;
      accessToken;
      botUserId;
      constructor(homeserverUrl, accessToken, botUserId) {
        super();
        this.homeserverUrl = homeserverUrl.replace(/\/+$/, "");
        this.accessToken = accessToken;
        this.botUserId = botUserId;
      }
      async connect() {
        this.status = "connecting";
        const { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } = await import("matrix-bot-sdk");
        const storageProvider = new SimpleFsStorageProvider("./data/matrix-storage");
        this.client = new MatrixClient(this.homeserverUrl, this.accessToken, storageProvider);
        AutojoinRoomsMixin.setupOnClient(this.client);
        this.client.on("room.message", async (roomId, event) => {
          if (event.sender === this.botUserId)
            return;
          const msgtype = event.content?.msgtype;
          if (!msgtype)
            return;
          try {
            const message = await this.normalizeEvent(roomId, event, msgtype);
            if (message) {
              this.emit("message", message);
            }
          } catch (err) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        });
        await this.client.start();
        this.status = "connected";
        this.emit("connected");
      }
      async disconnect() {
        this.client.stop();
        this.status = "disconnected";
        this.emit("disconnected");
      }
      async sendMessage(chatId, text, _options) {
        const eventId = await this.client.sendText(chatId, text);
        return eventId;
      }
      async editMessage(chatId, messageId, text) {
        await this.client.sendEvent(chatId, "m.room.message", {
          "msgtype": "m.text",
          "body": "* " + text,
          "m.new_content": {
            msgtype: "m.text",
            body: text
          },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: messageId
          }
        });
      }
      async deleteMessage(chatId, messageId) {
        await this.client.redactEvent(chatId, messageId);
      }
      async sendPhoto(chatId, photo, caption) {
        const mxcUrl = await this.client.uploadContent(photo, "image/png", "image.png");
        const content = {
          msgtype: "m.image",
          body: caption ?? "image.png",
          url: mxcUrl,
          info: {
            mimetype: "image/png",
            size: photo.length
          }
        };
        const eventId = await this.client.sendEvent(chatId, "m.room.message", content);
        return eventId;
      }
      async sendFile(chatId, file, fileName, caption) {
        const mimeType = this.guessMimeType(fileName);
        const mxcUrl = await this.client.uploadContent(file, mimeType, fileName);
        const content = {
          msgtype: "m.file",
          body: caption ?? fileName,
          filename: fileName,
          url: mxcUrl,
          info: {
            mimetype: mimeType,
            size: file.length
          }
        };
        const eventId = await this.client.sendEvent(chatId, "m.room.message", content);
        return eventId;
      }
      // ── Private helpers ──────────────────────────────────────────────
      async normalizeEvent(roomId, event, msgtype) {
        const base = {
          id: event.event_id,
          platform: "matrix",
          chatId: roomId,
          chatType: "group",
          userId: event.sender,
          userName: event.sender.split(":")[0].slice(1),
          timestamp: new Date(event.origin_server_ts),
          replyToMessageId: event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id
        };
        switch (msgtype) {
          case "m.text":
            return { ...base, text: event.content.body };
          case "m.image": {
            const attachment = await this.downloadAttachment(event.content, "image");
            return {
              ...base,
              text: event.content.body ?? "[Photo]",
              attachments: attachment ? [attachment] : void 0
            };
          }
          case "m.audio": {
            const attachment = await this.downloadAttachment(event.content, "audio");
            return {
              ...base,
              text: event.content.body ?? "[Voice message]",
              attachments: attachment ? [attachment] : void 0
            };
          }
          case "m.video": {
            const attachment = await this.downloadAttachment(event.content, "video");
            return {
              ...base,
              text: event.content.body ?? "[Video]",
              attachments: attachment ? [attachment] : void 0
            };
          }
          case "m.file": {
            const attachment = await this.downloadAttachment(event.content, "document");
            return {
              ...base,
              text: event.content.body ?? "[Document]",
              attachments: attachment ? [attachment] : void 0
            };
          }
          default:
            if (event.content.body) {
              return { ...base, text: event.content.body };
            }
            return void 0;
        }
      }
      /**
       * Download a Matrix media file from an mxc:// URL.
       * Uses the /_matrix/media/v3/download endpoint.
       */
      async downloadAttachment(content, type) {
        const mxcUrl = content.url;
        if (!mxcUrl || !mxcUrl.startsWith("mxc://"))
          return void 0;
        const info = content.info ?? {};
        const mimeType = info.mimetype;
        const size = info.size;
        const fileName = content.filename ?? content.body ?? "file";
        try {
          const mxcParts = mxcUrl.slice(6);
          const downloadUrl = `${this.homeserverUrl}/_matrix/media/v3/download/${mxcParts}`;
          const res = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
          });
          if (!res.ok)
            return void 0;
          const arrayBuffer = await res.arrayBuffer();
          const data = Buffer.from(arrayBuffer);
          return {
            type,
            mimeType,
            fileName,
            size: size ?? data.length,
            data
          };
        } catch {
          return void 0;
        }
      }
      guessMimeType(fileName) {
        const ext = fileName.split(".").pop()?.toLowerCase();
        const mimeMap = {
          pdf: "application/pdf",
          txt: "text/plain",
          json: "application/json",
          csv: "text/csv",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
          mp4: "video/mp4",
          zip: "application/zip",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        };
        return mimeMap[ext ?? ""] ?? "application/octet-stream";
      }
    };
  }
});

// ../messaging/dist/adapters/whatsapp.js
var WhatsAppAdapter;
var init_whatsapp = __esm({
  "../messaging/dist/adapters/whatsapp.js"() {
    "use strict";
    init_adapter();
    WhatsAppAdapter = class extends MessagingAdapter {
      platform = "whatsapp";
      socket;
      downloadMedia;
      dataPath;
      constructor(dataPath) {
        super();
        this.dataPath = dataPath;
      }
      async connect() {
        this.status = "connecting";
        const baileys = await import("@whiskeysockets/baileys");
        const mod = baileys.default ?? baileys;
        const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = mod;
        this.downloadMedia = downloadMediaMessage;
        const { state, saveCreds } = await useMultiFileAuthState(this.dataPath);
        this.socket = makeWASocket({
          auth: state,
          printQRInTerminal: true
        });
        this.socket.ev.on("creds.update", saveCreds);
        this.socket.ev.on("connection.update", (update) => {
          if (update.connection === "open") {
            this.status = "connected";
            this.emit("connected");
          }
          if (update.connection === "close") {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            this.status = "disconnected";
            this.emit("disconnected");
            if (shouldReconnect) {
              this.connect();
            }
          }
        });
        this.socket.ev.on("messages.upsert", ({ messages, type }) => {
          if (type !== "notify")
            return;
          for (const message of messages) {
            if (!message.message)
              continue;
            if (message.key.fromMe)
              continue;
            this.processMessage(message).catch((err) => {
              this.emit("error", err instanceof Error ? err : new Error(String(err)));
            });
          }
        });
      }
      async disconnect() {
        this.socket?.end(void 0);
        this.socket = void 0;
        this.status = "disconnected";
        this.emit("disconnected");
      }
      async sendMessage(chatId, text, options) {
        const msg = await this.socket.sendMessage(chatId, { text }, options?.replyToMessageId ? {
          quoted: {
            key: { remoteJid: chatId, id: options.replyToMessageId },
            message: {}
          }
        } : void 0);
        return msg?.key?.id ?? "";
      }
      async editMessage(chatId, messageId, text) {
        await this.socket.sendMessage(chatId, {
          text,
          edit: {
            remoteJid: chatId,
            id: messageId,
            fromMe: true
          }
        });
      }
      async deleteMessage(chatId, messageId) {
        await this.socket.sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            id: messageId,
            fromMe: true
          }
        });
      }
      async sendPhoto(chatId, photo, caption) {
        const msg = await this.socket.sendMessage(chatId, {
          image: photo,
          caption
        });
        return msg?.key?.id;
      }
      async sendFile(chatId, file, fileName, caption) {
        const msg = await this.socket.sendMessage(chatId, {
          document: file,
          fileName,
          caption,
          mimetype: this.guessMimeType(fileName)
        });
        return msg?.key?.id;
      }
      // ── Private helpers ──────────────────────────────────────────────
      async processMessage(message) {
        const msg = message.message;
        const text = msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption ?? "";
        const attachments = [];
        let fallbackText = text;
        if (msg.imageMessage) {
          const data = await this.downloadMediaSafe(message);
          if (data) {
            attachments.push({
              type: "image",
              mimeType: msg.imageMessage.mimetype ?? "image/jpeg",
              size: msg.imageMessage.fileLength ?? data.length,
              data
            });
          }
          if (!fallbackText)
            fallbackText = "[Photo]";
        } else if (msg.audioMessage) {
          const data = await this.downloadMediaSafe(message);
          if (data) {
            attachments.push({
              type: "audio",
              mimeType: msg.audioMessage.mimetype ?? "audio/ogg",
              size: msg.audioMessage.fileLength ?? data.length,
              data
            });
          }
          if (!fallbackText)
            fallbackText = "[Voice message]";
        } else if (msg.videoMessage) {
          const data = await this.downloadMediaSafe(message);
          if (data) {
            attachments.push({
              type: "video",
              mimeType: msg.videoMessage.mimetype ?? "video/mp4",
              size: msg.videoMessage.fileLength ?? data.length,
              data
            });
          }
          if (!fallbackText)
            fallbackText = "[Video]";
        } else if (msg.documentMessage) {
          const data = await this.downloadMediaSafe(message);
          if (data) {
            attachments.push({
              type: "document",
              mimeType: msg.documentMessage.mimetype ?? "application/octet-stream",
              fileName: msg.documentMessage.fileName ?? "document",
              size: msg.documentMessage.fileLength ?? data.length,
              data
            });
          }
          if (!fallbackText)
            fallbackText = "[Document]";
        } else if (msg.stickerMessage) {
          if (!text)
            return;
        }
        if (!fallbackText && attachments.length === 0)
          return;
        const normalized = {
          id: message.key.id ?? "",
          platform: "whatsapp",
          chatId: message.key.remoteJid ?? "",
          chatType: message.key.remoteJid?.endsWith("@g.us") ? "group" : "dm",
          userId: message.key.participant ?? message.key.remoteJid ?? "",
          userName: message.pushName ?? message.key.participant ?? message.key.remoteJid ?? "",
          text: fallbackText,
          timestamp: new Date(message.messageTimestamp * 1e3),
          replyToMessageId: msg.extendedTextMessage?.contextInfo?.stanzaId ?? void 0,
          attachments: attachments.length > 0 ? attachments : void 0
        };
        this.emit("message", normalized);
      }
      async downloadMediaSafe(message) {
        try {
          if (!this.downloadMedia)
            return void 0;
          const buffer = await this.downloadMedia(message, "buffer", {});
          return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        } catch {
          return void 0;
        }
      }
      guessMimeType(fileName) {
        const ext = fileName.split(".").pop()?.toLowerCase();
        const mimeMap = {
          pdf: "application/pdf",
          txt: "text/plain",
          json: "application/json",
          csv: "text/csv",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
          mp4: "video/mp4",
          zip: "application/zip",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        };
        return mimeMap[ext ?? ""] ?? "application/octet-stream";
      }
    };
  }
});

// ../messaging/dist/adapters/signal.js
var SignalAdapter;
var init_signal = __esm({
  "../messaging/dist/adapters/signal.js"() {
    "use strict";
    init_adapter();
    SignalAdapter = class extends MessagingAdapter {
      apiUrl;
      phoneNumber;
      platform = "signal";
      pollingInterval;
      constructor(apiUrl, phoneNumber) {
        super();
        this.apiUrl = apiUrl;
        this.phoneNumber = phoneNumber;
      }
      async connect() {
        this.status = "connecting";
        try {
          const res = await fetch(`${this.apiUrl}/v1/about`);
          if (!res.ok) {
            throw new Error(`Signal API not reachable: ${res.status}`);
          }
          this.pollingInterval = setInterval(() => {
            this.pollMessages().catch((err) => {
              this.emit("error", err instanceof Error ? err : new Error(String(err)));
            });
          }, 2e3);
          this.status = "connected";
          this.emit("connected");
        } catch (error) {
          this.status = "error";
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      }
      async disconnect() {
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = void 0;
        }
        this.status = "disconnected";
        this.emit("disconnected");
      }
      async sendMessage(chatId, text, _options) {
        const isGroup = chatId.startsWith("group.");
        const body = {
          message: text,
          number: this.phoneNumber
        };
        if (isGroup) {
          body.recipients = [chatId.replace("group.", "")];
        } else {
          body.recipients = [chatId];
        }
        const res = await fetch(`${this.apiUrl}/v2/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          throw new Error(`Signal send failed: ${res.status} ${await res.text()}`);
        }
        const result = await res.json();
        return String(result.timestamp ?? Date.now());
      }
      async editMessage(_chatId, _messageId, _text) {
        throw new Error("Signal does not support message editing");
      }
      async deleteMessage(chatId, messageId) {
        const body = {
          number: this.phoneNumber,
          recipients: [chatId],
          timestamp: Number(messageId)
        };
        const res = await fetch(`${this.apiUrl}/v1/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          throw new Error(`Signal delete failed: ${res.status} ${await res.text()}`);
        }
      }
      async pollMessages() {
        const res = await fetch(`${this.apiUrl}/v1/receive/${this.phoneNumber}`);
        if (!res.ok)
          return;
        const messages = await res.json();
        for (const envelope of messages) {
          const dataMessage = envelope.envelope?.dataMessage;
          if (!dataMessage)
            continue;
          if (!dataMessage.message && (!dataMessage.attachments || dataMessage.attachments.length === 0))
            continue;
          const data = envelope.envelope;
          const chatId = dataMessage.groupInfo?.groupId ? `group.${dataMessage.groupInfo.groupId}` : data.sourceNumber ?? data.source ?? "";
          const attachments = [];
          if (dataMessage.attachments) {
            for (const att of dataMessage.attachments) {
              const downloaded = await this.downloadAttachment(att);
              if (downloaded) {
                attachments.push(downloaded);
              }
            }
          }
          const text = dataMessage.message || this.inferTextFromAttachments(attachments) || "";
          if (!text && attachments.length === 0)
            continue;
          const normalized = {
            id: String(dataMessage.timestamp ?? Date.now()),
            platform: "signal",
            chatId,
            chatType: dataMessage.groupInfo ? "group" : "dm",
            userId: data.sourceNumber ?? data.source ?? "",
            userName: data.sourceName ?? data.sourceNumber ?? data.source ?? "",
            displayName: data.sourceName,
            text,
            timestamp: new Date(dataMessage.timestamp ?? Date.now()),
            attachments: attachments.length > 0 ? attachments : void 0
          };
          this.emit("message", normalized);
        }
      }
      async downloadAttachment(att) {
        if (!att.id)
          return void 0;
        try {
          const res = await fetch(`${this.apiUrl}/v1/attachments/${att.id}`);
          if (!res.ok)
            return void 0;
          const arrayBuffer = await res.arrayBuffer();
          const data = Buffer.from(arrayBuffer);
          const type = this.classifyContentType(att.contentType);
          return {
            type,
            mimeType: att.contentType ?? void 0,
            fileName: att.filename ?? void 0,
            size: att.size ?? data.length,
            data
          };
        } catch {
          return void 0;
        }
      }
      classifyContentType(contentType) {
        if (!contentType)
          return "other";
        if (contentType.startsWith("image/"))
          return "image";
        if (contentType.startsWith("audio/"))
          return "audio";
        if (contentType.startsWith("video/"))
          return "video";
        return "document";
      }
      inferTextFromAttachments(attachments) {
        if (attachments.length === 0)
          return "";
        const types = attachments.map((a) => a.type);
        if (types.includes("image"))
          return "[Photo]";
        if (types.includes("audio"))
          return "[Voice message]";
        if (types.includes("video"))
          return "[Video]";
        if (types.includes("document"))
          return "[Document]";
        return "[File]";
      }
    };
  }
});

// ../messaging/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  DiscordAdapter: () => DiscordAdapter,
  MatrixAdapter: () => MatrixAdapter,
  MessagingAdapter: () => MessagingAdapter,
  SignalAdapter: () => SignalAdapter,
  TelegramAdapter: () => TelegramAdapter,
  WhatsAppAdapter: () => WhatsAppAdapter
});
var init_dist7 = __esm({
  "../messaging/dist/index.js"() {
    "use strict";
    init_adapter();
    init_telegram();
    init_discord();
    init_matrix();
    init_whatsapp();
    init_signal();
  }
});

// ../core/dist/alfred.js
import fs6 from "node:fs";
import path8 from "node:path";
import yaml2 from "js-yaml";
var Alfred;
var init_alfred = __esm({
  "../core/dist/alfred.js"() {
    "use strict";
    init_dist2();
    init_dist3();
    init_dist4();
    init_dist5();
    init_dist6();
    init_conversation_manager();
    init_message_pipeline();
    init_reminder_scheduler();
    init_speech_transcriber();
    Alfred = class {
      config;
      logger;
      database;
      pipeline;
      reminderScheduler;
      adapters = /* @__PURE__ */ new Map();
      constructor(config) {
        this.config = config;
        this.logger = createLogger("alfred", config.logger.level);
      }
      async initialize() {
        this.logger.info("Initializing Alfred...");
        this.database = new Database(this.config.storage.path);
        const db = this.database.getDb();
        const conversationRepo = new ConversationRepository(db);
        const userRepo = new UserRepository(db);
        const auditRepo = new AuditRepository(db);
        const memoryRepo = new MemoryRepository(db);
        const reminderRepo = new ReminderRepository(db);
        const noteRepo = new NoteRepository(db);
        this.logger.info("Storage initialized");
        const ruleEngine = new RuleEngine();
        const rules = this.loadSecurityRules();
        ruleEngine.loadRules(rules);
        const securityManager = new SecurityManager(ruleEngine, auditRepo, this.logger.child({ component: "security" }));
        this.logger.info({ ruleCount: rules.length }, "Security engine initialized");
        const llmProvider = createLLMProvider(this.config.llm);
        await llmProvider.initialize();
        this.logger.info({ provider: this.config.llm.provider, model: this.config.llm.model }, "LLM provider initialized");
        const skillSandbox = new SkillSandbox(this.logger.child({ component: "sandbox" }));
        const skillRegistry = new SkillRegistry();
        skillRegistry.register(new CalculatorSkill());
        skillRegistry.register(new SystemInfoSkill());
        skillRegistry.register(new WebSearchSkill(this.config.search ? {
          provider: this.config.search.provider,
          apiKey: this.config.search.apiKey,
          baseUrl: this.config.search.baseUrl
        } : void 0));
        skillRegistry.register(new ReminderSkill(reminderRepo));
        skillRegistry.register(new NoteSkill(noteRepo));
        skillRegistry.register(new WeatherSkill());
        skillRegistry.register(new ShellSkill());
        skillRegistry.register(new MemorySkill(memoryRepo));
        skillRegistry.register(new DelegateSkill(llmProvider, skillRegistry, skillSandbox, securityManager));
        skillRegistry.register(new EmailSkill(this.config.email ? {
          imap: this.config.email.imap,
          smtp: this.config.email.smtp,
          auth: this.config.email.auth
        } : void 0));
        skillRegistry.register(new HttpSkill());
        skillRegistry.register(new FileSkill());
        skillRegistry.register(new ClipboardSkill());
        skillRegistry.register(new ScreenshotSkill());
        skillRegistry.register(new BrowserSkill());
        this.logger.info({ skills: skillRegistry.getAll().map((s) => s.metadata.name) }, "Skills registered");
        let speechTranscriber;
        if (this.config.speech?.apiKey) {
          speechTranscriber = new SpeechTranscriber(this.config.speech, this.logger.child({ component: "speech" }));
          this.logger.info({ provider: this.config.speech.provider }, "Speech-to-text initialized");
        }
        const conversationManager = new ConversationManager(conversationRepo);
        const inboxPath = path8.resolve(path8.dirname(this.config.storage.path), "inbox");
        this.pipeline = new MessagePipeline(llmProvider, conversationManager, userRepo, this.logger.child({ component: "pipeline" }), skillRegistry, skillSandbox, securityManager, memoryRepo, speechTranscriber, inboxPath);
        this.reminderScheduler = new ReminderScheduler(reminderRepo, async (platform, chatId, text) => {
          const adapter = this.adapters.get(platform);
          if (adapter) {
            await adapter.sendMessage(chatId, text);
          } else {
            this.logger.warn({ platform, chatId }, "No adapter for reminder platform");
          }
        }, this.logger.child({ component: "reminders" }));
        await this.initializeAdapters();
        this.logger.info("Alfred initialized");
      }
      async initializeAdapters() {
        const { config } = this;
        if (config.telegram.enabled && config.telegram.token) {
          const { TelegramAdapter: TelegramAdapter2 } = await Promise.resolve().then(() => (init_dist7(), dist_exports));
          this.adapters.set("telegram", new TelegramAdapter2(config.telegram.token));
          this.logger.info("Telegram adapter registered");
        }
        if (config.discord?.enabled && config.discord.token) {
          const { DiscordAdapter: DiscordAdapter2 } = await Promise.resolve().then(() => (init_dist7(), dist_exports));
          this.adapters.set("discord", new DiscordAdapter2(config.discord.token));
          this.logger.info("Discord adapter registered");
        }
        if (config.whatsapp?.enabled) {
          const { WhatsAppAdapter: WhatsAppAdapter2 } = await Promise.resolve().then(() => (init_dist7(), dist_exports));
          this.adapters.set("whatsapp", new WhatsAppAdapter2(config.whatsapp.dataPath));
          this.logger.info("WhatsApp adapter registered");
        }
        if (config.matrix?.enabled && config.matrix.accessToken) {
          const { MatrixAdapter: MatrixAdapter2 } = await Promise.resolve().then(() => (init_dist7(), dist_exports));
          this.adapters.set("matrix", new MatrixAdapter2(config.matrix.homeserverUrl, config.matrix.accessToken, config.matrix.userId));
          this.logger.info("Matrix adapter registered");
        }
        if (config.signal?.enabled && config.signal.phoneNumber) {
          const { SignalAdapter: SignalAdapter2 } = await Promise.resolve().then(() => (init_dist7(), dist_exports));
          this.adapters.set("signal", new SignalAdapter2(config.signal.apiUrl, config.signal.phoneNumber));
          this.logger.info("Signal adapter registered");
        }
      }
      async start() {
        this.logger.info("Starting Alfred...");
        for (const [platform, adapter] of this.adapters) {
          this.setupAdapterHandlers(platform, adapter);
          await adapter.connect();
          this.logger.info({ platform }, "Adapter connected");
        }
        this.reminderScheduler?.start();
        if (this.adapters.size === 0) {
          this.logger.warn("No messaging adapters enabled. Configure at least one platform.");
        }
        this.logger.info(`Alfred is running with ${this.adapters.size} adapter(s)`);
      }
      async stop() {
        this.logger.info("Stopping Alfred...");
        this.reminderScheduler?.stop();
        for (const [platform, adapter] of this.adapters) {
          try {
            await adapter.disconnect();
            this.logger.info({ platform }, "Adapter disconnected");
          } catch (error) {
            this.logger.error({ platform, err: error }, "Failed to disconnect adapter");
          }
        }
        this.database.close();
        this.logger.info("Alfred stopped");
      }
      setupAdapterHandlers(platform, adapter) {
        adapter.on("message", async (message) => {
          try {
            let statusMessageId;
            let lastStatus = "";
            const onProgress = async (status) => {
              if (status === lastStatus)
                return;
              lastStatus = status;
              try {
                if (!statusMessageId) {
                  statusMessageId = await adapter.sendMessage(message.chatId, status);
                } else {
                  await adapter.editMessage(message.chatId, statusMessageId, status);
                }
              } catch {
              }
            };
            const response = await this.pipeline.process(message, onProgress);
            if (statusMessageId) {
              try {
                await adapter.editMessage(message.chatId, statusMessageId, response);
              } catch {
                await adapter.sendMessage(message.chatId, response);
              }
            } else {
              await adapter.sendMessage(message.chatId, response);
            }
          } catch (error) {
            this.logger.error({ platform, err: error, chatId: message.chatId }, "Failed to handle message");
            try {
              await adapter.sendMessage(message.chatId, "Sorry, I encountered an error processing your message. Please try again.");
            } catch (sendError) {
              this.logger.error({ err: sendError }, "Failed to send error message");
            }
          }
        });
        adapter.on("error", (error) => {
          this.logger.error({ platform, err: error }, "Adapter error");
        });
        adapter.on("connected", () => {
          this.logger.info({ platform }, "Adapter connected");
        });
        adapter.on("disconnected", () => {
          this.logger.warn({ platform }, "Adapter disconnected");
        });
      }
      loadSecurityRules() {
        const rulesPath = path8.resolve(this.config.security.rulesPath);
        const rules = [];
        if (!fs6.existsSync(rulesPath)) {
          this.logger.warn({ rulesPath }, "Security rules directory not found, using default deny");
          return rules;
        }
        const stat = fs6.statSync(rulesPath);
        if (!stat.isDirectory()) {
          this.logger.warn({ rulesPath }, "Security rules path is not a directory");
          return rules;
        }
        const files = fs6.readdirSync(rulesPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
        for (const file of files) {
          try {
            const filePath = path8.join(rulesPath, file);
            const content = fs6.readFileSync(filePath, "utf-8");
            const parsed = yaml2.load(content);
            if (parsed?.rules && Array.isArray(parsed.rules)) {
              rules.push(...parsed.rules);
              this.logger.info({ file, count: parsed.rules.length }, "Loaded security rules");
            }
          } catch (err) {
            this.logger.error({ err, file }, "Failed to load security rules file");
          }
        }
        return rules;
      }
    };
  }
});

// ../core/dist/index.js
var init_dist8 = __esm({
  "../core/dist/index.js"() {
    "use strict";
    init_alfred();
    init_message_pipeline();
    init_conversation_manager();
    init_reminder_scheduler();
    init_speech_transcriber();
  }
});

// dist/commands/start.js
var start_exports = {};
__export(start_exports, {
  startCommand: () => startCommand
});
async function startCommand() {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const logger = createLogger("cli", config.logger.level);
  logger.info({ name: config.name }, "Configuration loaded");
  const alfred = new Alfred(config);
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown)
      return;
    isShuttingDown = true;
    logger.info({ signal }, "Received shutdown signal");
    try {
      await alfred.stop();
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, "Error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ error: err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled rejection");
    shutdown("unhandledRejection");
  });
  try {
    await alfred.initialize();
    await alfred.start();
    logger.info("Alfred is ready");
  } catch (error) {
    logger.fatal({ error }, "Failed to start Alfred");
    process.exit(1);
  }
}
var init_start = __esm({
  "dist/commands/start.js"() {
    "use strict";
    init_dist();
    init_dist2();
    init_dist8();
  }
});

// dist/commands/setup.js
var setup_exports = {};
__export(setup_exports, {
  setupCommand: () => setupCommand
});
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs7 from "node:fs";
import path9 from "node:path";
import yaml3 from "js-yaml";
function green(s) {
  return `${GREEN}${s}${RESET}`;
}
function yellow(s) {
  return `${YELLOW}${s}${RESET}`;
}
function cyan(s) {
  return `${CYAN}${s}${RESET}`;
}
function red(s) {
  return `${RED}${s}${RESET}`;
}
function bold(s) {
  return `${BOLD}${s}${RESET}`;
}
function dim(s) {
  return `${DIM}${s}${RESET}`;
}
function maskKey(key) {
  if (key.length <= 4)
    return "****";
  return "*".repeat(key.length - 4) + key.slice(-4);
}
function loadExistingConfig(projectRoot) {
  const config = {};
  const env = {};
  let shellEnabled = false;
  let writeInGroups = false;
  let rateLimit = 30;
  const configPath = path9.join(projectRoot, "config", "default.yml");
  if (fs7.existsSync(configPath)) {
    try {
      const parsed = yaml3.load(fs7.readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        Object.assign(config, parsed);
      }
    } catch {
    }
  }
  const envPath = path9.join(projectRoot, ".env");
  if (fs7.existsSync(envPath)) {
    try {
      const lines = fs7.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
          continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
      }
    } catch {
    }
  }
  const rulesPath = path9.join(projectRoot, "config", "rules", "default-rules.yml");
  if (fs7.existsSync(rulesPath)) {
    try {
      const rulesContent = yaml3.load(fs7.readFileSync(rulesPath, "utf-8"));
      if (rulesContent?.rules) {
        shellEnabled = rulesContent.rules.some((r) => r.id === "allow-owner-admin" && r.effect === "allow");
        const writeDmRule = rulesContent.rules.find((r) => r.id === "allow-write-for-dm" || r.id === "allow-write-all");
        if (writeDmRule?.id === "allow-write-all") {
          writeInGroups = true;
        }
        const rlRule = rulesContent.rules.find((r) => r.id === "rate-limit-write");
        if (rlRule?.rateLimit?.maxInvocations) {
          rateLimit = rlRule.rateLimit.maxInvocations;
        }
      }
    } catch {
    }
  }
  return { config, env, shellEnabled, writeInGroups, rateLimit };
}
async function setupCommand() {
  const rl = createInterface({ input, output });
  const projectRoot = process.cwd();
  const existing = loadExistingConfig(projectRoot);
  const hasExisting = Object.keys(existing.config).length > 0;
  try {
    printBanner();
    if (hasExisting) {
      console.log(`${CYAN}Existing configuration found \u2014 press Enter to keep current values.${RESET}
${DIM}Only change what you need to update.${RESET}
`);
    } else {
      console.log(`${CYAN}Welcome to the Alfred setup wizard!${RESET}
${DIM}This will walk you through configuring your AI assistant.${RESET}
${DIM}Press Enter to accept defaults shown in [brackets].${RESET}
`);
    }
    const botName = await askWithDefault(rl, "What should your bot be called?", existing.config.name ?? "Alfred");
    const existingProviderIdx = existing.config.llm?.provider ? PROVIDERS.findIndex((p) => p.name === existing.config.llm?.provider) : -1;
    const defaultProviderChoice = existingProviderIdx >= 0 ? existingProviderIdx + 1 : 1;
    console.log(`
${bold("Which LLM provider would you like to use?")}`);
    for (let i = 0; i < PROVIDERS.length; i++) {
      const current = i === existingProviderIdx ? ` ${dim("(current)")}` : "";
      console.log(`  ${cyan(String(i + 1) + ")")} ${PROVIDERS[i].label}${current}`);
    }
    const providerChoice = await askNumber(rl, "> ", 1, PROVIDERS.length, defaultProviderChoice);
    const provider = PROVIDERS[providerChoice - 1];
    console.log(`  ${green(">")} Selected: ${bold(provider.label)}`);
    let apiKey = "";
    const existingApiKey = existing.env[provider.envKeyName] ?? "";
    if (provider.needsApiKey) {
      console.log("");
      if (existingApiKey) {
        apiKey = await askWithDefault(rl, `${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)} API key`, existingApiKey);
      } else {
        apiKey = await askRequired(rl, `Enter your ${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)} API key`);
      }
      console.log(`  ${green(">")} API key set: ${dim(maskKey(apiKey))}`);
    }
    let baseUrl = provider.baseUrl ?? "";
    if (provider.name === "ollama") {
      const existingUrl = existing.config.llm?.baseUrl ?? existing.env["ALFRED_LLM_BASE_URL"] ?? "http://localhost:11434";
      console.log("");
      baseUrl = await askWithDefault(rl, "Ollama URL (use a remote address if Ollama runs on another machine)", existingUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""));
      baseUrl = baseUrl.replace(/\/+$/, "");
      console.log(`  ${green(">")} Ollama URL: ${dim(baseUrl)}`);
    }
    const existingModel = existing.config.llm?.model ?? provider.defaultModel;
    console.log("");
    const model = await askWithDefault(rl, "Which model?", existingModel);
    const searchProviders = ["brave", "tavily", "duckduckgo", "searxng"];
    const existingSearchProvider = existing.config.search?.provider ?? existing.env["ALFRED_SEARCH_PROVIDER"] ?? "";
    const existingSearchIdx = searchProviders.indexOf(existingSearchProvider);
    const defaultSearchChoice = existingSearchIdx >= 0 ? existingSearchIdx + 1 : 0;
    console.log(`
${bold("Web Search provider (for searching the internet):")}`);
    const searchLabels = [
      "Brave Search \u2014 recommended, free tier (2,000/month)",
      "Tavily \u2014 built for AI agents, free tier (1,000/month)",
      "DuckDuckGo \u2014 free, no API key needed",
      "SearXNG \u2014 self-hosted, no API key needed"
    ];
    const mark = (i) => existingSearchIdx === i ? ` ${dim("(current)")}` : "";
    console.log(`  ${cyan("0)")} None (disable web search)${existingSearchIdx === -1 && existingSearchProvider === "" ? ` ${dim("(current)")}` : ""}`);
    for (let i = 0; i < searchLabels.length; i++) {
      console.log(`  ${cyan(String(i + 1) + ")")} ${searchLabels[i]}${mark(i)}`);
    }
    const searchChoice = await askNumber(rl, "> ", 0, searchProviders.length, defaultSearchChoice);
    let searchProvider;
    let searchApiKey = "";
    let searchBaseUrl = "";
    if (searchChoice >= 1 && searchChoice <= searchProviders.length) {
      searchProvider = searchProviders[searchChoice - 1];
    }
    if (searchProvider === "brave") {
      const existingKey = existing.env["ALFRED_SEARCH_API_KEY"] ?? "";
      if (existingKey) {
        searchApiKey = await askWithDefault(rl, "  Brave Search API key", existingKey);
      } else {
        console.log(`  ${dim("Get your free API key at: https://brave.com/search/api/")}`);
        searchApiKey = await askRequired(rl, "  Brave Search API key");
      }
      console.log(`  ${green(">")} Brave Search: ${dim(maskKey(searchApiKey))}`);
    } else if (searchProvider === "tavily") {
      const existingKey = existing.env["ALFRED_SEARCH_API_KEY"] ?? "";
      if (existingKey) {
        searchApiKey = await askWithDefault(rl, "  Tavily API key", existingKey);
      } else {
        console.log(`  ${dim("Get your free API key at: https://tavily.com/")}`);
        searchApiKey = await askRequired(rl, "  Tavily API key");
      }
      console.log(`  ${green(">")} Tavily: ${dim(maskKey(searchApiKey))}`);
    } else if (searchProvider === "duckduckgo") {
      console.log(`  ${green(">")} DuckDuckGo: ${dim("no API key needed")}`);
    } else if (searchProvider === "searxng") {
      const existingSearxUrl = existing.config.search?.baseUrl ?? existing.env["ALFRED_SEARCH_BASE_URL"] ?? "http://localhost:8080";
      searchBaseUrl = await askWithDefault(rl, "  SearXNG URL", existingSearxUrl);
      searchBaseUrl = searchBaseUrl.replace(/\/+$/, "");
      console.log(`  ${green(">")} SearXNG: ${dim(searchBaseUrl)}`);
    } else {
      console.log(`  ${dim("Web search disabled \u2014 you can configure it later.")}`);
    }
    const currentlyEnabled = [];
    for (let i = 0; i < PLATFORMS.length; i++) {
      const p = PLATFORMS[i];
      const ec = existing.config;
      if (ec[p.configKey]?.enabled) {
        currentlyEnabled.push(i + 1);
      }
    }
    const currentDefault = currentlyEnabled.length > 0 ? currentlyEnabled.join(",") : "";
    console.log(`
${bold("Which messaging platforms do you want to enable?")}`);
    console.log(`${dim("(Enter comma-separated numbers, e.g. 1,3)")}`);
    for (let i = 0; i < PLATFORMS.length; i++) {
      const enabled = currentlyEnabled.includes(i + 1) ? ` ${dim("(enabled)")}` : "";
      console.log(`  ${cyan(String(i + 1) + ")")} ${PLATFORMS[i].label}${enabled}`);
    }
    console.log(`  ${cyan("0)")} None (configure later)`);
    const platformInput = (await rl.question(`${YELLOW}> ${RESET}${currentDefault ? dim(`[${currentDefault}] `) : ""}`)).trim();
    const selectedPlatforms = [];
    const effectiveInput = platformInput || currentDefault;
    if (effectiveInput && effectiveInput !== "0") {
      const nums = effectiveInput.split(",").map((s) => parseInt(s.trim(), 10));
      for (const n of nums) {
        if (n >= 1 && n <= PLATFORMS.length) {
          const plat = PLATFORMS[n - 1];
          if (!selectedPlatforms.includes(plat)) {
            selectedPlatforms.push(plat);
          }
        }
      }
    }
    if (selectedPlatforms.length > 0) {
      console.log(`  ${green(">")} Enabling: ${selectedPlatforms.map((p) => bold(p.label)).join(", ")}`);
    } else {
      console.log(`  ${dim("No platforms selected \u2014 you can configure them later.")}`);
    }
    const platformCredentials = {};
    const envOverrides = {};
    for (const platform of selectedPlatforms) {
      if (platform.credentials.length === 0) {
        if (platform.name === "whatsapp") {
          console.log(`
  ${yellow("i")} WhatsApp: a QR code will be displayed on first start.`);
        }
        continue;
      }
      console.log(`
${bold(platform.label + " configuration:")}`);
      const creds = {};
      for (const cred of platform.credentials) {
        const existingVal = existing.env[cred.envKey] ?? "";
        let value;
        if (existingVal) {
          value = await askWithDefault(rl, `  ${cred.prompt}`, existingVal);
        } else if (cred.defaultValue) {
          value = await askWithDefault(rl, `  ${cred.prompt}`, cred.defaultValue);
        } else if (cred.required) {
          value = await askRequired(rl, `  ${cred.prompt}`);
        } else {
          value = (await rl.question(`  ${cred.prompt}: ${YELLOW}`)).trim();
          process.stdout.write(RESET);
        }
        creds[cred.configField] = value;
        envOverrides[cred.envKey] = value;
        if (cred.configField === "token" || cred.configField === "accessToken") {
          console.log(`    ${green(">")} Set: ${dim(maskKey(value))}`);
        } else {
          console.log(`    ${green(">")} Set: ${dim(value)}`);
        }
      }
      platformCredentials[platform.configKey] = creds;
    }
    const existingEmailUser = existing.config.email?.auth?.user ?? existing.env["ALFRED_EMAIL_USER"] ?? "";
    const hasEmail = !!existingEmailUser;
    const emailDefault = hasEmail ? "Y/n" : "y/N";
    console.log(`
${bold("Email access (read & send emails via IMAP/SMTP)?")}`);
    console.log(`${dim("Works with Gmail, Outlook, or any IMAP/SMTP provider.")}`);
    const emailAnswer = (await rl.question(`${YELLOW}> ${RESET}${dim(`[${emailDefault}] `)}`)).trim().toLowerCase();
    const enableEmail = emailAnswer === "" ? hasEmail : emailAnswer === "y" || emailAnswer === "yes";
    let emailUser = "";
    let emailPass = "";
    let emailImapHost = "";
    let emailImapPort = 993;
    let emailSmtpHost = "";
    let emailSmtpPort = 587;
    if (enableEmail) {
      console.log("");
      emailUser = await askWithDefault(rl, "  Email address", existingEmailUser || "");
      if (!emailUser) {
        emailUser = await askRequired(rl, "  Email address");
      }
      const existingPass = existing.env["ALFRED_EMAIL_PASS"] ?? "";
      if (existingPass) {
        emailPass = await askWithDefault(rl, "  Password / App password", existingPass);
      } else {
        console.log(`  ${dim("For Gmail: use an App Password (not your regular password)")}`);
        console.log(`  ${dim("  \u2192 Google Account \u2192 Security \u2192 2-Step \u2192 App passwords")}`);
        emailPass = await askRequired(rl, "  Password / App password");
      }
      const domain = emailUser.split("@")[1]?.toLowerCase() ?? "";
      const presets = {
        "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
        "googlemail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
        "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
        "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
        "live.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
        "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
        "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
        "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
        "gmx.de": { imap: "imap.gmx.net", smtp: "mail.gmx.net" },
        "gmx.net": { imap: "imap.gmx.net", smtp: "mail.gmx.net" },
        "web.de": { imap: "imap.web.de", smtp: "smtp.web.de" },
        "posteo.de": { imap: "posteo.de", smtp: "posteo.de" },
        "mailbox.org": { imap: "imap.mailbox.org", smtp: "smtp.mailbox.org" },
        "protonmail.com": { imap: "127.0.0.1", smtp: "127.0.0.1" },
        "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1" }
      };
      const preset = presets[domain];
      const defaultImap = existing.config.email?.imap?.host ?? preset?.imap ?? `imap.${domain}`;
      const defaultSmtp = existing.config.email?.smtp?.host ?? preset?.smtp ?? `smtp.${domain}`;
      const defaultImapPort = existing.config.email?.imap?.port ?? 993;
      const defaultSmtpPort = existing.config.email?.smtp?.port ?? 587;
      if (preset) {
        console.log(`  ${green(">")} Detected ${domain} \u2014 using preset server settings`);
      }
      emailImapHost = await askWithDefault(rl, "  IMAP server", defaultImap);
      const imapPortStr = await askWithDefault(rl, "  IMAP port", String(defaultImapPort));
      emailImapPort = parseInt(imapPortStr, 10) || 993;
      emailSmtpHost = await askWithDefault(rl, "  SMTP server", defaultSmtp);
      const smtpPortStr = await askWithDefault(rl, "  SMTP port", String(defaultSmtpPort));
      emailSmtpPort = parseInt(smtpPortStr, 10) || 587;
      console.log(`  ${green(">")} Email: ${dim(emailUser)} via ${dim(emailImapHost)}`);
    } else {
      console.log(`  ${dim("Email disabled \u2014 you can configure it later.")}`);
    }
    const speechProviders = ["openai", "groq"];
    const existingSpeechProvider = existing.config.speech?.provider ?? existing.env["ALFRED_SPEECH_PROVIDER"] ?? "";
    const existingSpeechIdx = speechProviders.indexOf(existingSpeechProvider);
    const defaultSpeechChoice = existingSpeechIdx >= 0 ? existingSpeechIdx + 1 : 0;
    console.log(`
${bold("Voice message transcription (Speech-to-Text via Whisper)?")}`);
    console.log(`${dim("Transcribes voice messages from Telegram, Discord, etc.")}`);
    const speechLabels = [
      "OpenAI Whisper \u2014 best quality",
      "Groq Whisper \u2014 fast & free"
    ];
    console.log(`  ${cyan("0)")} None (disable voice transcription)${existingSpeechIdx === -1 ? ` ${dim("(current)")}` : ""}`);
    for (let i = 0; i < speechLabels.length; i++) {
      const cur = existingSpeechIdx === i ? ` ${dim("(current)")}` : "";
      console.log(`  ${cyan(String(i + 1) + ")")} ${speechLabels[i]}${cur}`);
    }
    const speechChoice = await askNumber(rl, "> ", 0, speechProviders.length, defaultSpeechChoice);
    let speechProvider;
    let speechApiKey = "";
    let speechBaseUrl = "";
    if (speechChoice >= 1 && speechChoice <= speechProviders.length) {
      speechProvider = speechProviders[speechChoice - 1];
    }
    if (speechProvider === "openai") {
      const existingKey = existing.env["ALFRED_SPEECH_API_KEY"] ?? "";
      if (existingKey) {
        speechApiKey = await askWithDefault(rl, "  OpenAI API key (for Whisper)", existingKey);
      } else {
        console.log(`  ${dim("Uses your OpenAI API key for Whisper transcription.")}`);
        speechApiKey = await askRequired(rl, "  OpenAI API key");
      }
      console.log(`  ${green(">")} OpenAI Whisper: ${dim(maskKey(speechApiKey))}`);
    } else if (speechProvider === "groq") {
      const existingKey = existing.env["ALFRED_SPEECH_API_KEY"] ?? "";
      if (existingKey) {
        speechApiKey = await askWithDefault(rl, "  Groq API key", existingKey);
      } else {
        console.log(`  ${dim("Get your free API key at: https://console.groq.com/")}`);
        speechApiKey = await askRequired(rl, "  Groq API key");
      }
      const existingUrl = existing.env["ALFRED_SPEECH_BASE_URL"] ?? "";
      if (existingUrl) {
        speechBaseUrl = await askWithDefault(rl, "  Groq API URL", existingUrl);
      }
      console.log(`  ${green(">")} Groq Whisper: ${dim(maskKey(speechApiKey))}`);
    } else {
      console.log(`  ${dim("Voice transcription disabled \u2014 you can configure it later.")}`);
    }
    console.log(`
${bold("Security configuration:")}`);
    const existingOwnerId = existing.config.security?.ownerUserId ?? existing.env["ALFRED_OWNER_USER_ID"] ?? "";
    let ownerUserId;
    if (existingOwnerId) {
      ownerUserId = await askWithDefault(rl, "Owner user ID (for elevated permissions)", existingOwnerId);
    } else {
      const input2 = (await rl.question(`${BOLD}Owner user ID${RESET} ${dim("(optional, for elevated permissions)")}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      ownerUserId = input2;
    }
    let enableShell = false;
    if (ownerUserId) {
      const shellDefault = existing.shellEnabled ? "Y/n" : "y/N";
      console.log("");
      console.log(`  ${bold("Enable shell access (admin commands) for the owner?")}`);
      console.log(`  ${dim("Allows Alfred to execute shell commands. Only for the owner.")}`);
      const shellAnswer = (await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${shellDefault}] `)}`)).trim().toLowerCase();
      if (shellAnswer === "") {
        enableShell = existing.shellEnabled;
      } else {
        enableShell = shellAnswer === "y" || shellAnswer === "yes";
      }
      if (enableShell) {
        console.log(`    ${green(">")} Shell access ${bold("enabled")} for owner ${dim(ownerUserId)}`);
      } else {
        console.log(`    ${dim("Shell access disabled.")}`);
      }
    }
    const writeGroupsDefault = existing.writeInGroups ? "Y/n" : "y/N";
    console.log("");
    console.log(`  ${bold("Allow write actions (notes, reminders, memory) in group chats?")}`);
    console.log(`  ${dim("By default, write actions are only allowed in DMs.")}`);
    const writeGroupsAnswer = (await rl.question(`  ${YELLOW}> ${RESET}${dim(`[${writeGroupsDefault}] `)}`)).trim().toLowerCase();
    let writeInGroups;
    if (writeGroupsAnswer === "") {
      writeInGroups = existing.writeInGroups;
    } else {
      writeInGroups = writeGroupsAnswer === "y" || writeGroupsAnswer === "yes";
    }
    if (writeInGroups) {
      console.log(`    ${green(">")} Write actions ${bold("enabled")} in groups`);
    } else {
      console.log(`    ${dim("Write actions only in DMs (default).")}`);
    }
    const existingRateLimit = existing.rateLimit ?? 30;
    console.log("");
    const rateLimitStr = await askWithDefault(rl, "  Rate limit (max write actions per hour per user)", String(existingRateLimit));
    const rateLimit = Math.max(1, parseInt(rateLimitStr, 10) || 30);
    console.log(`    ${green(">")} Rate limit: ${bold(String(rateLimit))} per hour`);
    console.log(`
${bold("Writing configuration files...")}`);
    const envLines = [
      "# Alfred Environment Variables",
      "# Generated by `alfred setup`",
      "",
      "# === LLM ===",
      "",
      `ALFRED_LLM_PROVIDER=${provider.name}`
    ];
    if (apiKey) {
      const envKeyName = provider.envKeyName || "ALFRED_OLLAMA_API_KEY";
      envLines.push(`${envKeyName}=${apiKey}`);
    }
    if (model !== provider.defaultModel) {
      envLines.push(`ALFRED_LLM_MODEL=${model}`);
    }
    if (baseUrl) {
      envLines.push(`ALFRED_LLM_BASE_URL=${baseUrl}`);
    }
    envLines.push("", "# === Messaging Platforms ===", "");
    for (const [envKey, envVal] of Object.entries(envOverrides)) {
      envLines.push(`${envKey}=${envVal}`);
    }
    envLines.push("", "# === Web Search ===", "");
    if (searchProvider) {
      envLines.push(`ALFRED_SEARCH_PROVIDER=${searchProvider}`);
      if (searchApiKey) {
        envLines.push(`ALFRED_SEARCH_API_KEY=${searchApiKey}`);
      }
      if (searchBaseUrl) {
        envLines.push(`ALFRED_SEARCH_BASE_URL=${searchBaseUrl}`);
      }
    } else {
      envLines.push("# ALFRED_SEARCH_PROVIDER=brave");
      envLines.push("# ALFRED_SEARCH_API_KEY=");
    }
    envLines.push("", "# === Email ===", "");
    if (enableEmail) {
      envLines.push(`ALFRED_EMAIL_USER=${emailUser}`);
      envLines.push(`ALFRED_EMAIL_PASS=${emailPass}`);
    } else {
      envLines.push("# ALFRED_EMAIL_USER=");
      envLines.push("# ALFRED_EMAIL_PASS=");
    }
    envLines.push("", "# === Speech-to-Text ===", "");
    if (speechProvider) {
      envLines.push(`ALFRED_SPEECH_PROVIDER=${speechProvider}`);
      envLines.push(`ALFRED_SPEECH_API_KEY=${speechApiKey}`);
      if (speechBaseUrl) {
        envLines.push(`ALFRED_SPEECH_BASE_URL=${speechBaseUrl}`);
      }
    } else {
      envLines.push("# ALFRED_SPEECH_PROVIDER=groq");
      envLines.push("# ALFRED_SPEECH_API_KEY=");
    }
    envLines.push("", "# === Security ===", "");
    if (ownerUserId) {
      envLines.push(`ALFRED_OWNER_USER_ID=${ownerUserId}`);
    } else {
      envLines.push("# ALFRED_OWNER_USER_ID=");
    }
    envLines.push("");
    const envPath = path9.join(projectRoot, ".env");
    fs7.writeFileSync(envPath, envLines.join("\n"), "utf-8");
    console.log(`  ${green("+")} ${dim(".env")} written`);
    const configDir = path9.join(projectRoot, "config");
    if (!fs7.existsSync(configDir)) {
      fs7.mkdirSync(configDir, { recursive: true });
    }
    const config = {
      name: botName,
      telegram: {
        token: platformCredentials["telegram"]?.["token"] ?? "",
        enabled: selectedPlatforms.some((p) => p.name === "telegram")
      },
      discord: {
        token: platformCredentials["discord"]?.["token"] ?? "",
        enabled: selectedPlatforms.some((p) => p.name === "discord")
      },
      whatsapp: {
        enabled: selectedPlatforms.some((p) => p.name === "whatsapp"),
        dataPath: "./data/whatsapp"
      },
      matrix: {
        homeserverUrl: platformCredentials["matrix"]?.["homeserverUrl"] ?? "https://matrix.org",
        accessToken: platformCredentials["matrix"]?.["accessToken"] ?? "",
        userId: platformCredentials["matrix"]?.["userId"] ?? "",
        enabled: selectedPlatforms.some((p) => p.name === "matrix")
      },
      signal: {
        apiUrl: platformCredentials["signal"]?.["apiUrl"] ?? "http://localhost:8080",
        phoneNumber: platformCredentials["signal"]?.["phoneNumber"] ?? "",
        enabled: selectedPlatforms.some((p) => p.name === "signal")
      },
      llm: {
        provider: provider.name,
        model,
        ...baseUrl ? { baseUrl } : {},
        temperature: 0.7,
        maxTokens: 4096
      },
      ...searchProvider ? {
        search: {
          provider: searchProvider,
          ...searchApiKey ? { apiKey: searchApiKey } : {},
          ...searchBaseUrl ? { baseUrl: searchBaseUrl } : {}
        }
      } : {},
      ...enableEmail ? {
        email: {
          imap: { host: emailImapHost, port: emailImapPort, secure: emailImapPort === 993 },
          smtp: { host: emailSmtpHost, port: emailSmtpPort, secure: emailSmtpPort === 465 },
          auth: { user: emailUser, pass: emailPass }
        }
      } : {},
      ...speechProvider ? {
        speech: {
          provider: speechProvider,
          apiKey: speechApiKey,
          ...speechBaseUrl ? { baseUrl: speechBaseUrl } : {}
        }
      } : {},
      storage: {
        path: "./data/alfred.db"
      },
      logger: {
        level: "info",
        pretty: true,
        auditLogPath: "./data/audit.log"
      },
      security: {
        rulesPath: "./config/rules",
        defaultEffect: "deny"
      }
    };
    if (ownerUserId) {
      config.security.ownerUserId = ownerUserId;
    }
    const yamlStr = "# Alfred \u2014 Configuration\n# Generated by `alfred setup`\n# Edit manually or re-run `alfred setup` to reconfigure.\n\n" + yaml3.dump(config, { lineWidth: 120, noRefs: true, sortKeys: false });
    const configPath = path9.join(configDir, "default.yml");
    fs7.writeFileSync(configPath, yamlStr, "utf-8");
    console.log(`  ${green("+")} ${dim("config/default.yml")} written`);
    const rulesDir = path9.join(configDir, "rules");
    if (!fs7.existsSync(rulesDir)) {
      fs7.mkdirSync(rulesDir, { recursive: true });
    }
    const ownerAdminRule = enableShell && ownerUserId ? `
  # Allow admin actions (shell, etc.) for the owner only
  - id: allow-owner-admin
    effect: allow
    priority: 50
    scope: global
    actions: ["*"]
    riskLevels: [admin, destructive]
    conditions:
      users: ["${ownerUserId}"]
` : `
  # Allow admin actions (shell, etc.) for the owner only
  # Uncomment and set your user ID to enable:
  # - id: allow-owner-admin
  #   effect: allow
  #   priority: 50
  #   scope: global
  #   actions: ["*"]
  #   riskLevels: [admin, destructive]
  #   conditions:
  #     users: ["${ownerUserId || "YOUR_USER_ID_HERE"}"]
`;
    const writeRule = writeInGroups ? `  # Allow write-level skills everywhere (DMs and groups)
  - id: allow-write-all
    effect: allow
    priority: 200
    scope: global
    actions: ["*"]
    riskLevels: [write]` : `  # Allow write-level skills in DMs only
  - id: allow-write-for-dm
    effect: allow
    priority: 200
    scope: global
    actions: ["*"]
    riskLevels: [write]
    conditions:
      chatType: dm`;
    const rulesYaml = `# Alfred \u2014 Default Security Rules
# Rules are evaluated in priority order (lower number = higher priority).
# First matching rule wins.

rules:
  # Allow all read-level skills (calculator, system_info, web_search) for everyone
  - id: allow-all-read
    effect: allow
    priority: 100
    scope: global
    actions: ["*"]
    riskLevels: [read]

${writeRule}

  # Rate-limit write actions: max ${rateLimit} per hour per user
  - id: rate-limit-write
    effect: allow
    priority: 250
    scope: user
    actions: ["*"]
    riskLevels: [write]
    rateLimit:
      maxInvocations: ${rateLimit}
      windowSeconds: 3600
${ownerAdminRule}
  # Deny destructive and admin actions by default
  - id: deny-destructive
    effect: deny
    priority: 500
    scope: global
    actions: ["*"]
    riskLevels: [destructive, admin]

  # Catch-all deny
  - id: deny-default
    effect: deny
    priority: 9999
    scope: global
    actions: ["*"]
    riskLevels: [read, write, destructive, admin]
`;
    const rulesPath = path9.join(rulesDir, "default-rules.yml");
    fs7.writeFileSync(rulesPath, rulesYaml, "utf-8");
    console.log(`  ${green("+")} ${dim("config/rules/default-rules.yml")} written`);
    const dataDir = path9.join(projectRoot, "data");
    if (!fs7.existsSync(dataDir)) {
      fs7.mkdirSync(dataDir, { recursive: true });
      console.log(`  ${green("+")} ${dim("data/")} directory created`);
    }
    console.log("");
    console.log(`${GREEN}${"=".repeat(52)}${RESET}`);
    console.log(`${GREEN}${BOLD}  Setup complete!${RESET}`);
    console.log(`${GREEN}${"=".repeat(52)}${RESET}`);
    console.log("");
    console.log(`  ${bold("Bot name:")}       ${botName}`);
    console.log(`  ${bold("LLM provider:")}   ${provider.name} (${model})`);
    if (apiKey) {
      console.log(`  ${bold("API key:")}        ${maskKey(apiKey)}`);
    }
    if (selectedPlatforms.length > 0) {
      console.log(`  ${bold("Platforms:")}      ${selectedPlatforms.map((p) => p.label).join(", ")}`);
    } else {
      console.log(`  ${bold("Platforms:")}      none (configure later)`);
    }
    if (searchProvider) {
      const searchLabelMap = {
        brave: "Brave Search",
        tavily: "Tavily",
        duckduckgo: "DuckDuckGo",
        searxng: `SearXNG (${searchBaseUrl})`
      };
      console.log(`  ${bold("Web search:")}     ${searchLabelMap[searchProvider]}`);
    } else {
      console.log(`  ${bold("Web search:")}     ${dim("disabled")}`);
    }
    if (enableEmail) {
      console.log(`  ${bold("Email:")}          ${emailUser} (${emailImapHost})`);
    } else {
      console.log(`  ${bold("Email:")}          ${dim("disabled")}`);
    }
    if (speechProvider) {
      const speechLabelMap = {
        openai: "OpenAI Whisper",
        groq: "Groq Whisper"
      };
      console.log(`  ${bold("Voice:")}          ${speechLabelMap[speechProvider]}`);
    } else {
      console.log(`  ${bold("Voice:")}          ${dim("disabled")}`);
    }
    if (ownerUserId) {
      console.log(`  ${bold("Owner ID:")}       ${ownerUserId}`);
      console.log(`  ${bold("Shell access:")}   ${enableShell ? green("enabled") : dim("disabled")}`);
    }
    console.log(`  ${bold("Write scope:")}    ${writeInGroups ? "DMs + Groups" : "DMs only"}`);
    console.log(`  ${bold("Rate limit:")}     ${rateLimit}/hour per user`);
    console.log("");
    console.log(`${CYAN}Next steps:${RESET}`);
    console.log(`  ${bold("alfred start")}     Start Alfred`);
    console.log(`  ${bold("alfred status")}    Check configuration`);
    console.log(`  ${bold("alfred --help")}    Show all commands`);
    console.log("");
    console.log(`${DIM}Edit ${bold(".env")}${DIM} or ${bold("config/default.yml")}${DIM} for manual configuration.${RESET}`);
    console.log("");
  } finally {
    rl.close();
  }
}
async function askWithDefault(rl, prompt, defaultValue) {
  const answer = (await rl.question(`${BOLD}${prompt}${RESET} ${dim(`[${defaultValue}]`)}: ${YELLOW}`)).trim();
  process.stdout.write(RESET);
  return answer || defaultValue;
}
async function askRequired(rl, prompt) {
  while (true) {
    const answer = (await rl.question(`${BOLD}${prompt}${RESET}: ${YELLOW}`)).trim();
    process.stdout.write(RESET);
    if (answer)
      return answer;
    console.log(`  ${red("!")} This field is required. Please enter a value.`);
  }
}
async function askNumber(rl, prompt, min, max, defaultValue) {
  while (true) {
    const answer = (await rl.question(`${YELLOW}${prompt}${RESET}`)).trim();
    if (!answer)
      return defaultValue;
    const n = parseInt(answer, 10);
    if (!Number.isNaN(n) && n >= min && n <= max)
      return n;
    console.log(`  ${red("!")} Please enter a number between ${min} and ${max}.`);
  }
}
function printBanner() {
  console.log(`
${MAGENTA}${BOLD}     _    _     _____ ____  _____ ____
    / \\  | |   |  ___|  _ \\| ____|  _ \\
   / _ \\ | |   | |_  | |_) |  _| | | | |
  / ___ \\| |___|  _| |  _ <| |___| |_| |
 /_/   \\_\\_____|_|   |_| \\_\\_____|____/ ${RESET}
${DIM}  Personal AI Assistant \u2014 Setup Wizard${RESET}
`);
}
var RESET, BOLD, DIM, GREEN, YELLOW, CYAN, RED, MAGENTA, PROVIDERS, PLATFORMS;
var init_setup = __esm({
  "dist/commands/setup.js"() {
    "use strict";
    RESET = "\x1B[0m";
    BOLD = "\x1B[1m";
    DIM = "\x1B[2m";
    GREEN = "\x1B[32m";
    YELLOW = "\x1B[33m";
    CYAN = "\x1B[36m";
    RED = "\x1B[31m";
    MAGENTA = "\x1B[35m";
    PROVIDERS = [
      {
        name: "anthropic",
        label: "Anthropic (Claude) \u2014 recommended",
        defaultModel: "claude-sonnet-4-20250514",
        envKeyName: "ALFRED_ANTHROPIC_API_KEY",
        needsApiKey: true
      },
      {
        name: "openai",
        label: "OpenAI (GPT)",
        defaultModel: "gpt-4o",
        envKeyName: "ALFRED_OPENAI_API_KEY",
        needsApiKey: true
      },
      {
        name: "openrouter",
        label: "OpenRouter (multiple providers)",
        defaultModel: "anthropic/claude-sonnet-4-20250514",
        envKeyName: "ALFRED_OPENROUTER_API_KEY",
        needsApiKey: true,
        baseUrl: "https://openrouter.ai/api/v1"
      },
      {
        name: "ollama",
        label: "Ollama (local, no API key needed)",
        defaultModel: "llama3.2",
        envKeyName: "",
        needsApiKey: false,
        baseUrl: "http://localhost:11434"
      }
    ];
    PLATFORMS = [
      {
        name: "telegram",
        label: "Telegram",
        configKey: "telegram",
        credentials: [
          {
            envKey: "ALFRED_TELEGRAM_TOKEN",
            configField: "token",
            prompt: "Enter your Telegram Bot token (from @BotFather)",
            required: true
          }
        ]
      },
      {
        name: "discord",
        label: "Discord",
        configKey: "discord",
        credentials: [
          {
            envKey: "ALFRED_DISCORD_TOKEN",
            configField: "token",
            prompt: "Enter your Discord Bot token",
            required: true
          }
        ]
      },
      {
        name: "whatsapp",
        label: "WhatsApp",
        configKey: "whatsapp",
        credentials: []
      },
      {
        name: "matrix",
        label: "Matrix",
        configKey: "matrix",
        credentials: [
          {
            envKey: "ALFRED_MATRIX_HOMESERVER_URL",
            configField: "homeserverUrl",
            prompt: "Enter your Matrix homeserver URL",
            defaultValue: "https://matrix.org",
            required: true
          },
          {
            envKey: "ALFRED_MATRIX_ACCESS_TOKEN",
            configField: "accessToken",
            prompt: "Enter your Matrix access token",
            required: true
          },
          {
            envKey: "ALFRED_MATRIX_USER_ID",
            configField: "userId",
            prompt: "Enter your Matrix user ID (e.g. @bot:matrix.org)",
            required: true
          }
        ]
      },
      {
        name: "signal",
        label: "Signal",
        configKey: "signal",
        credentials: [
          {
            envKey: "ALFRED_SIGNAL_API_URL",
            configField: "apiUrl",
            prompt: "Enter the Signal REST API URL",
            defaultValue: "http://localhost:8080",
            required: true
          },
          {
            envKey: "ALFRED_SIGNAL_PHONE_NUMBER",
            configField: "phoneNumber",
            prompt: "Enter the Signal phone number (e.g. +15551234567)",
            required: true
          }
        ]
      }
    ];
  }
});

// dist/commands/config.js
var config_exports = {};
__export(config_exports, {
  configCommand: () => configCommand
});
function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s));
}
function redactValue(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "(empty)";
  }
  if (value.length <= 8) {
    return "***";
  }
  return value.slice(0, 4) + "..." + value.slice(-4);
}
function redactObject(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = redactValue(value);
    } else if (value !== null && value !== void 0 && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
async function configCommand() {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const redacted = redactObject(config);
  console.log("Alfred \u2014 Resolved Configuration");
  console.log("================================");
  console.log(JSON.stringify(redacted, null, 2));
}
var SENSITIVE_KEYS;
var init_config = __esm({
  "dist/commands/config.js"() {
    "use strict";
    init_dist();
    SENSITIVE_KEYS = ["token", "apikey", "api_key", "accesstoken", "secret", "password"];
  }
});

// dist/commands/rules.js
var rules_exports = {};
__export(rules_exports, {
  rulesCommand: () => rulesCommand
});
import fs8 from "node:fs";
import path10 from "node:path";
import yaml4 from "js-yaml";
async function rulesCommand() {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const rulesPath = path10.resolve(config.security.rulesPath);
  if (!fs8.existsSync(rulesPath)) {
    console.log(`Rules directory not found: ${rulesPath}`);
    console.log("No security rules loaded.");
    return;
  }
  const stat = fs8.statSync(rulesPath);
  if (!stat.isDirectory()) {
    console.error(`Rules path is not a directory: ${rulesPath}`);
    process.exit(1);
  }
  const files = fs8.readdirSync(rulesPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  if (files.length === 0) {
    console.log(`No YAML rule files found in: ${rulesPath}`);
    return;
  }
  const ruleLoader = new RuleLoader();
  const allRules = [];
  const errors = [];
  for (const file of files) {
    const filePath = path10.join(rulesPath, file);
    try {
      const raw = fs8.readFileSync(filePath, "utf-8");
      const parsed = yaml4.load(raw);
      const rules = ruleLoader.loadFromObject(parsed);
      allRules.push(...rules);
    } catch (error) {
      errors.push(`  ${file}: ${error.message}`);
    }
  }
  console.log("Alfred \u2014 Security Rules");
  console.log("=======================");
  console.log(`Rules directory: ${rulesPath}`);
  console.log(`Rule files found: ${files.length}`);
  console.log(`Total rules loaded: ${allRules.length}`);
  console.log("");
  if (errors.length > 0) {
    console.log("Errors:");
    for (const err of errors) {
      console.log(err);
    }
    console.log("");
  }
  if (allRules.length === 0) {
    return;
  }
  allRules.sort((a, b) => a.priority - b.priority);
  console.log("Loaded rules (sorted by priority):");
  console.log("");
  for (const rule of allRules) {
    const rateLimit = rule.rateLimit ? ` | rate-limit: ${rule.rateLimit.maxInvocations}/${rule.rateLimit.windowSeconds}s` : "";
    console.log(`  [${rule.priority}] ${rule.id}`);
    console.log(`       effect: ${rule.effect} | scope: ${rule.scope}`);
    console.log(`       actions: ${rule.actions.join(", ")}`);
    console.log(`       risk levels: ${rule.riskLevels.join(", ")}${rateLimit}`);
    if (rule.conditions) {
      console.log(`       conditions: ${JSON.stringify(rule.conditions)}`);
    }
    console.log("");
  }
}
var init_rules = __esm({
  "dist/commands/rules.js"() {
    "use strict";
    init_dist();
    init_dist5();
  }
});

// dist/commands/status.js
var status_exports = {};
__export(status_exports, {
  statusCommand: () => statusCommand
});
import fs9 from "node:fs";
import path11 from "node:path";
import yaml5 from "js-yaml";
async function statusCommand() {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  console.log("Alfred \u2014 Status");
  console.log("================");
  console.log("");
  const adapters = [
    {
      name: "Telegram",
      enabled: config.telegram.enabled,
      configured: Boolean(config.telegram.token)
    },
    {
      name: "Discord",
      enabled: Boolean(config.discord?.enabled),
      configured: Boolean(config.discord?.token)
    },
    {
      name: "WhatsApp",
      enabled: Boolean(config.whatsapp?.enabled),
      configured: Boolean(config.whatsapp?.dataPath)
    },
    {
      name: "Matrix",
      enabled: Boolean(config.matrix?.enabled),
      configured: Boolean(config.matrix?.accessToken)
    },
    {
      name: "Signal",
      enabled: Boolean(config.signal?.enabled),
      configured: Boolean(config.signal?.phoneNumber)
    }
  ];
  console.log("Messaging Adapters:");
  for (const adapter of adapters) {
    const status = adapter.enabled ? "enabled" : adapter.configured ? "configured (disabled)" : "not configured";
    const icon = adapter.enabled ? "+" : "-";
    console.log(`  [${icon}] ${adapter.name}: ${status}`);
  }
  console.log("");
  console.log("LLM Provider:");
  console.log(`  Provider: ${config.llm.provider}`);
  console.log(`  Model:    ${config.llm.model}`);
  console.log(`  API Key:  ${config.llm.apiKey ? "set" : "not set"}`);
  if (config.llm.baseUrl) {
    console.log(`  Base URL: ${config.llm.baseUrl}`);
  }
  console.log("");
  console.log("Storage:");
  const dbPath = path11.resolve(config.storage.path);
  const dbExists = fs9.existsSync(dbPath);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Status:   ${dbExists ? "exists" : "not yet created"}`);
  console.log("");
  const rulesPath = path11.resolve(config.security.rulesPath);
  let ruleCount = 0;
  let ruleFileCount = 0;
  if (fs9.existsSync(rulesPath) && fs9.statSync(rulesPath).isDirectory()) {
    const files = fs9.readdirSync(rulesPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    ruleFileCount = files.length;
    const ruleLoader = new RuleLoader();
    for (const file of files) {
      const filePath = path11.join(rulesPath, file);
      try {
        const raw = fs9.readFileSync(filePath, "utf-8");
        const parsed = yaml5.load(raw);
        const rules = ruleLoader.loadFromObject(parsed);
        ruleCount += rules.length;
      } catch {
      }
    }
  }
  console.log("Security:");
  console.log(`  Rules path:      ${rulesPath}`);
  console.log(`  Rule files:      ${ruleFileCount}`);
  console.log(`  Rules loaded:    ${ruleCount}`);
  console.log(`  Default effect:  ${config.security.defaultEffect}`);
  if (config.security.ownerUserId) {
    console.log(`  Owner user ID:   ${config.security.ownerUserId}`);
  }
  console.log("");
  console.log("Logger:");
  console.log(`  Level:  ${config.logger.level}`);
  console.log(`  Pretty: ${config.logger.pretty}`);
}
var init_status = __esm({
  "dist/commands/status.js"() {
    "use strict";
    init_dist();
    init_dist5();
  }
});

// dist/commands/logs.js
var logs_exports = {};
__export(logs_exports, {
  logsCommand: () => logsCommand
});
import fs10 from "node:fs";
import path12 from "node:path";
async function logsCommand(tail) {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const dbPath = path12.resolve(config.storage.path);
  if (!fs10.existsSync(dbPath)) {
    console.log(`Database not found at: ${dbPath}`);
    console.log("No audit log entries. Alfred has not been run yet, or the database path is incorrect.");
    return;
  }
  let database;
  try {
    database = new Database(dbPath);
    const auditRepo = new AuditRepository(database.getDb());
    const totalCount = auditRepo.count({});
    const entries = auditRepo.query({ limit: tail });
    console.log("Alfred \u2014 Audit Log");
    console.log("===================");
    console.log(`Total entries: ${totalCount}`);
    console.log(`Showing last ${Math.min(tail, totalCount)} entries:`);
    console.log("");
    if (entries.length === 0) {
      console.log("No audit log entries found.");
      return;
    }
    for (const entry of entries) {
      const timestamp = entry.timestamp.toISOString();
      const effect = entry.effect === "allow" ? "ALLOW" : "DENY ";
      console.log(`  ${timestamp}  [${effect}]  ${entry.action}`);
      console.log(`    user: ${entry.userId} | platform: ${entry.platform} | risk: ${entry.riskLevel}`);
      if (entry.ruleId) {
        console.log(`    rule: ${entry.ruleId}`);
      }
      if (entry.chatId) {
        console.log(`    chat: ${entry.chatId}`);
      }
      if (entry.context) {
        console.log(`    context: ${JSON.stringify(entry.context)}`);
      }
      console.log("");
    }
  } catch (error) {
    console.error("Failed to read audit log:", error.message);
    process.exit(1);
  } finally {
    if (database) {
      database.close();
    }
  }
}
var init_logs = __esm({
  "dist/commands/logs.js"() {
    "use strict";
    init_dist();
    init_dist3();
  }
});

// dist/index.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
function getVersion() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../package.json", "../../package.json"]) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, rel), "utf-8"));
        if (pkg.version)
          return pkg.version;
      } catch {
      }
    }
  } catch {
  }
  return "0.0.0";
}
var VERSION = getVersion();
var HELP_TEXT = `
Alfred CLI v${VERSION}
Personal AI Assistant

Usage:
  alfred <command> [options]

Commands:
  start          Start Alfred (load config, bootstrap, and run)
  setup          Interactive setup wizard (configure LLM, platforms, API keys)
  config         Show current resolved configuration (API keys redacted)
  rules          List loaded security rules from the rules path
  status         Show status overview (adapters, LLM, rules)
  logs [--tail N] Show recent audit log entries (default: 20)

Options:
  --help, -h     Show this help message
  --version, -v  Show version number
`.trim();
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.length > 0 && !args[0].startsWith("-") ? args[0] : "";
  const remaining = command ? args.slice(1) : args;
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < remaining.length && !remaining[i + 1].startsWith("-")) {
        flags[key] = remaining[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < remaining.length && !remaining[i + 1].startsWith("-")) {
        flags[key] = remaining[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { command, flags, positional };
}
async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.flags["help"] || parsed.flags["h"]) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (parsed.flags["version"] || parsed.flags["v"]) {
    console.log(`alfred v${VERSION}`);
    process.exit(0);
  }
  switch (parsed.command) {
    case "start": {
      const { startCommand: startCommand2 } = await Promise.resolve().then(() => (init_start(), start_exports));
      await startCommand2();
      break;
    }
    case "setup": {
      const { setupCommand: setupCommand2 } = await Promise.resolve().then(() => (init_setup(), setup_exports));
      await setupCommand2();
      break;
    }
    case "config": {
      const { configCommand: configCommand2 } = await Promise.resolve().then(() => (init_config(), config_exports));
      await configCommand2();
      break;
    }
    case "rules": {
      const { rulesCommand: rulesCommand2 } = await Promise.resolve().then(() => (init_rules(), rules_exports));
      await rulesCommand2();
      break;
    }
    case "status": {
      const { statusCommand: statusCommand2 } = await Promise.resolve().then(() => (init_status(), status_exports));
      await statusCommand2();
      break;
    }
    case "logs": {
      const tailValue = parsed.flags["tail"];
      let tail = 20;
      if (typeof tailValue === "string") {
        const tailNum = parseInt(tailValue, 10);
        if (Number.isNaN(tailNum) || tailNum <= 0) {
          console.error("Error: --tail must be a positive integer");
          process.exit(1);
        }
        tail = tailNum;
      }
      const { logsCommand: logsCommand2 } = await Promise.resolve().then(() => (init_logs(), logs_exports));
      await logsCommand2(tail);
      break;
    }
    case "help":
      console.log(HELP_TEXT);
      break;
    case "":
      console.log(HELP_TEXT);
      process.exit(0);
      break;
    default:
      console.error(`Unknown command: ${parsed.command}`);
      console.error("");
      console.error('Run "alfred --help" for usage information.');
      process.exit(1);
  }
}
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
