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

// packages/config/dist/schema.js
import { z } from "zod";
var TelegramConfigSchema, DiscordConfigSchema, WhatsAppConfigSchema, MatrixConfigSchema, SignalConfigSchema, StorageConfigSchema, LoggerConfigSchema, SecurityConfigSchema, LLMProviderConfigSchema, AlfredConfigSchema;
var init_schema = __esm({
  "packages/config/dist/schema.js"() {
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
      security: SecurityConfigSchema
    });
  }
});

// packages/config/dist/defaults.js
var DEFAULT_CONFIG;
var init_defaults = __esm({
  "packages/config/dist/defaults.js"() {
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

// packages/config/dist/loader.js
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
  "packages/config/dist/loader.js"() {
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
      ALFRED_OWNER_USER_ID: ["security", "ownerUserId"]
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

// packages/config/dist/index.js
var init_dist = __esm({
  "packages/config/dist/index.js"() {
    "use strict";
    init_schema();
    init_defaults();
    init_loader();
  }
});

// packages/logger/dist/logger.js
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
  "packages/logger/dist/logger.js"() {
    "use strict";
  }
});

// packages/logger/dist/audit.js
import pino2 from "pino";
var init_audit = __esm({
  "packages/logger/dist/audit.js"() {
    "use strict";
  }
});

// packages/logger/dist/index.js
var init_dist2 = __esm({
  "packages/logger/dist/index.js"() {
    "use strict";
    init_logger();
    init_audit();
  }
});

// packages/storage/dist/database.js
import BetterSqlite3 from "better-sqlite3";
import fs2 from "node:fs";
import path2 from "node:path";
var Database;
var init_database = __esm({
  "packages/storage/dist/database.js"() {
    "use strict";
    Database = class {
      db;
      constructor(dbPath) {
        const dir = path2.dirname(dbPath);
        fs2.mkdirSync(dir, { recursive: true });
        this.db = new BetterSqlite3(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
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
      getDb() {
        return this.db;
      }
      close() {
        this.db.close();
      }
    };
  }
});

// packages/storage/dist/repositories/conversation-repository.js
import crypto from "node:crypto";
var ConversationRepository;
var init_conversation_repository = __esm({
  "packages/storage/dist/repositories/conversation-repository.js"() {
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

// packages/storage/dist/repositories/user-repository.js
import crypto2 from "node:crypto";
var UserRepository;
var init_user_repository = __esm({
  "packages/storage/dist/repositories/user-repository.js"() {
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

// packages/storage/dist/repositories/audit-repository.js
var AuditRepository;
var init_audit_repository = __esm({
  "packages/storage/dist/repositories/audit-repository.js"() {
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

// packages/storage/dist/repositories/memory-repository.js
import { randomUUID } from "node:crypto";
var MemoryRepository;
var init_memory_repository = __esm({
  "packages/storage/dist/repositories/memory-repository.js"() {
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

// packages/storage/dist/migrations/migrator.js
var init_migrator = __esm({
  "packages/storage/dist/migrations/migrator.js"() {
    "use strict";
  }
});

// packages/storage/dist/migrations/index.js
var init_migrations = __esm({
  "packages/storage/dist/migrations/index.js"() {
    "use strict";
    init_migrator();
  }
});

// packages/storage/dist/repositories/reminder-repository.js
import { randomUUID as randomUUID2 } from "node:crypto";
var ReminderRepository;
var init_reminder_repository = __esm({
  "packages/storage/dist/repositories/reminder-repository.js"() {
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

// packages/storage/dist/index.js
var init_dist3 = __esm({
  "packages/storage/dist/index.js"() {
    "use strict";
    init_database();
    init_conversation_repository();
    init_user_repository();
    init_audit_repository();
    init_memory_repository();
    init_migrator();
    init_migrations();
    init_reminder_repository();
  }
});

// packages/llm/dist/provider.js
var LLMProvider;
var init_provider = __esm({
  "packages/llm/dist/provider.js"() {
    "use strict";
    LLMProvider = class {
      config;
      constructor(config) {
        this.config = config;
      }
    };
  }
});

// packages/llm/dist/providers/anthropic.js
import Anthropic from "@anthropic-ai/sdk";
var AnthropicProvider;
var init_anthropic = __esm({
  "packages/llm/dist/providers/anthropic.js"() {
    "use strict";
    init_provider();
    AnthropicProvider = class extends LLMProvider {
      client;
      constructor(config) {
        super(config);
      }
      async initialize() {
        this.client = new Anthropic({ apiKey: this.config.apiKey });
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

// packages/llm/dist/providers/openai.js
import OpenAI from "openai";
var OpenAIProvider;
var init_openai = __esm({
  "packages/llm/dist/providers/openai.js"() {
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

// packages/llm/dist/providers/openrouter.js
var OpenRouterProvider;
var init_openrouter = __esm({
  "packages/llm/dist/providers/openrouter.js"() {
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

// packages/llm/dist/providers/ollama.js
var OllamaProvider;
var init_ollama = __esm({
  "packages/llm/dist/providers/ollama.js"() {
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
        for (const block of blocks) {
          switch (block.type) {
            case "text":
              textParts.push(block.text);
              break;
            case "tool_use":
              textParts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`);
              break;
            case "tool_result":
              textParts.push(`[Tool result for ${block.tool_use_id}]: ${block.content}`);
              break;
          }
        }
        return { role, content: textParts.join("\n") };
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

// packages/llm/dist/provider-factory.js
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
  "packages/llm/dist/provider-factory.js"() {
    "use strict";
    init_anthropic();
    init_openai();
    init_openrouter();
    init_ollama();
  }
});

// packages/llm/dist/prompt-builder.js
var PromptBuilder;
var init_prompt_builder = __esm({
  "packages/llm/dist/prompt-builder.js"() {
    "use strict";
    PromptBuilder = class {
      buildSystemPrompt(memories) {
        let prompt = "You are Alfred, a personal AI assistant. You are helpful, precise, and security-conscious. You have access to various tools (skills) that you can use to help the user. Always explain what you are doing before using a tool. Be concise but thorough.";
        if (memories && memories.length > 0) {
          prompt += "\n\nYou have the following memories about this user. Use them to personalize your responses:\n";
          for (const m of memories) {
            prompt += `- [${m.category}] ${m.key}: ${m.value}
`;
          }
          prompt += "\nWhen the user tells you new facts or preferences, use the memory tool to save them for future reference.";
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

// packages/llm/dist/index.js
var init_dist4 = __esm({
  "packages/llm/dist/index.js"() {
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

// packages/security/dist/rate-limiter.js
var RateLimiter;
var init_rate_limiter = __esm({
  "packages/security/dist/rate-limiter.js"() {
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

// packages/security/dist/rule-engine.js
var RuleEngine;
var init_rule_engine = __esm({
  "packages/security/dist/rule-engine.js"() {
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

// packages/security/dist/rule-loader.js
var VALID_EFFECTS, VALID_SCOPES, VALID_RISK_LEVELS, RuleLoader;
var init_rule_loader = __esm({
  "packages/security/dist/rule-loader.js"() {
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

// packages/security/dist/security-manager.js
import crypto3 from "node:crypto";
var SecurityManager;
var init_security_manager = __esm({
  "packages/security/dist/security-manager.js"() {
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

// packages/security/dist/index.js
var init_dist5 = __esm({
  "packages/security/dist/index.js"() {
    "use strict";
    init_rule_engine();
    init_rate_limiter();
    init_rule_loader();
    init_security_manager();
  }
});

// packages/skills/dist/skill.js
var Skill;
var init_skill = __esm({
  "packages/skills/dist/skill.js"() {
    "use strict";
    Skill = class {
    };
  }
});

// packages/skills/dist/skill-registry.js
var SkillRegistry;
var init_skill_registry = __esm({
  "packages/skills/dist/skill-registry.js"() {
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

// packages/skills/dist/skill-sandbox.js
var DEFAULT_TIMEOUT_MS, SkillSandbox;
var init_skill_sandbox = __esm({
  "packages/skills/dist/skill-sandbox.js"() {
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

// packages/skills/dist/plugin-loader.js
import fs3 from "node:fs";
import path3 from "node:path";
var init_plugin_loader = __esm({
  "packages/skills/dist/plugin-loader.js"() {
    "use strict";
    init_skill();
  }
});

// packages/skills/dist/built-in/calculator.js
var ALLOWED_PATTERN, SAFE_EXPRESSION_PATTERN, CalculatorSkill;
var init_calculator = __esm({
  "packages/skills/dist/built-in/calculator.js"() {
    "use strict";
    init_skill();
    ALLOWED_PATTERN = /^[\d+\-*/().,%\s]|Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)/;
    SAFE_EXPRESSION_PATTERN = /^[0-9+\-*/().,\s%]*(Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)[(0-9+\-*/().,\s%]*)*$/;
    CalculatorSkill = class extends Skill {
      metadata = {
        name: "calculator",
        description: "Evaluate mathematical expressions safely",
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

// packages/skills/dist/built-in/system-info.js
var SystemInfoSkill;
var init_system_info = __esm({
  "packages/skills/dist/built-in/system-info.js"() {
    "use strict";
    init_skill();
    SystemInfoSkill = class extends Skill {
      metadata = {
        name: "system_info",
        description: "Get system information about the Alfred bot",
        riskLevel: "read",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["general", "memory", "uptime"],
              description: "Category of system info"
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
    };
  }
});

// packages/skills/dist/built-in/web-search.js
var WebSearchSkill;
var init_web_search = __esm({
  "packages/skills/dist/built-in/web-search.js"() {
    "use strict";
    init_skill();
    WebSearchSkill = class extends Skill {
      metadata = {
        name: "web_search",
        description: "Search the web (placeholder \u2014 returns mock results)",
        riskLevel: "read",
        version: "0.1.0",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query"
            }
          },
          required: ["query"]
        }
      };
      async execute(input2, _context) {
        const query = input2.query;
        return {
          success: true,
          data: {
            note: "Web search is not yet connected to a search API"
          },
          display: `Web search for "${query}" is not yet implemented. This skill will be connected to a search API in a future update.`
        };
      }
    };
  }
});

// packages/skills/dist/built-in/reminder.js
var ReminderSkill;
var init_reminder = __esm({
  "packages/skills/dist/built-in/reminder.js"() {
    "use strict";
    init_skill();
    ReminderSkill = class extends Skill {
      reminderRepo;
      metadata = {
        name: "reminder",
        description: "Set, list, or cancel reminders",
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

// packages/skills/dist/built-in/note.js
import { randomUUID as randomUUID3 } from "node:crypto";
var NoteSkill;
var init_note = __esm({
  "packages/skills/dist/built-in/note.js"() {
    "use strict";
    init_skill();
    NoteSkill = class extends Skill {
      metadata = {
        name: "note",
        description: "Save, list, search, or delete notes",
        riskLevel: "write",
        version: "1.0.0",
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
      notes = /* @__PURE__ */ new Map();
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
          return {
            success: false,
            error: 'Missing required field "title" for save action'
          };
        }
        if (!content || typeof content !== "string") {
          return {
            success: false,
            error: 'Missing required field "content" for save action'
          };
        }
        const noteId = randomUUID3();
        const createdAt = Date.now();
        this.notes.set(noteId, {
          noteId,
          userId: context.userId,
          title,
          content,
          createdAt
        });
        return {
          success: true,
          data: { noteId, title, createdAt },
          display: `Note saved (${noteId}): "${title}"`
        };
      }
      listNotes(context) {
        const userNotes = [];
        for (const [, entry] of this.notes) {
          if (entry.userId === context.userId) {
            userNotes.push({
              noteId: entry.noteId,
              title: entry.title,
              createdAt: entry.createdAt
            });
          }
        }
        return {
          success: true,
          data: userNotes,
          display: userNotes.length === 0 ? "No notes found." : `Notes:
${userNotes.map((n) => `- ${n.noteId}: "${n.title}"`).join("\n")}`
        };
      }
      searchNotes(input2, context) {
        const query = input2.query;
        if (!query || typeof query !== "string") {
          return {
            success: false,
            error: 'Missing required field "query" for search action'
          };
        }
        const lowerQuery = query.toLowerCase();
        const matches = [];
        for (const [, entry] of this.notes) {
          if (entry.userId !== context.userId) {
            continue;
          }
          if (entry.title.toLowerCase().includes(lowerQuery) || entry.content.toLowerCase().includes(lowerQuery)) {
            matches.push({
              noteId: entry.noteId,
              title: entry.title,
              content: entry.content
            });
          }
        }
        return {
          success: true,
          data: matches,
          display: matches.length === 0 ? `No notes matching "${query}".` : `Found ${matches.length} note(s):
${matches.map((n) => `- ${n.noteId}: "${n.title}"`).join("\n")}`
        };
      }
      deleteNote(input2) {
        const noteId = input2.noteId;
        if (!noteId || typeof noteId !== "string") {
          return {
            success: false,
            error: 'Missing required field "noteId" for delete action'
          };
        }
        const entry = this.notes.get(noteId);
        if (!entry) {
          return {
            success: false,
            error: `Note "${noteId}" not found`
          };
        }
        this.notes.delete(noteId);
        return {
          success: true,
          data: { noteId },
          display: `Note "${noteId}" deleted.`
        };
      }
    };
  }
});

// packages/skills/dist/built-in/summarize.js
var DEFAULT_MAX_LENGTH, SummarizeSkill;
var init_summarize = __esm({
  "packages/skills/dist/built-in/summarize.js"() {
    "use strict";
    init_skill();
    DEFAULT_MAX_LENGTH = 280;
    SummarizeSkill = class extends Skill {
      metadata = {
        name: "summarize",
        description: "Produce an extractive summary of the given text",
        riskLevel: "read",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to summarize"
            },
            maxLength: {
              type: "number",
              description: "Maximum character length for the summary (default: 280)"
            }
          },
          required: ["text"]
        }
      };
      async execute(input2, _context) {
        const text = input2.text;
        const maxLength = input2.maxLength ?? DEFAULT_MAX_LENGTH;
        if (!text || typeof text !== "string") {
          return {
            success: false,
            error: 'Invalid input: "text" must be a non-empty string'
          };
        }
        if (text.length <= maxLength) {
          return {
            success: true,
            data: { summary: text },
            display: text
          };
        }
        const summary = this.extractiveSummarize(text, maxLength);
        return {
          success: true,
          data: { summary },
          display: summary
        };
      }
      extractiveSummarize(text, maxLength) {
        const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
        if (sentences.length === 0) {
          return text.slice(0, maxLength);
        }
        const wordFrequency = this.buildWordFrequency(text);
        const scored = sentences.map((sentence, index) => ({
          sentence,
          index,
          score: this.scoreSentence(sentence, wordFrequency)
        }));
        const ranked = [...scored].sort((a, b) => b.score - a.score);
        const selected = [];
        let currentLength = 0;
        for (const entry of ranked) {
          const addition = currentLength === 0 ? entry.sentence.length : entry.sentence.length + 1;
          if (currentLength + addition > maxLength) {
            continue;
          }
          selected.push(entry);
          currentLength += addition;
        }
        if (selected.length === 0) {
          return sentences[0].slice(0, maxLength);
        }
        selected.sort((a, b) => a.index - b.index);
        return selected.map((s) => s.sentence).join(" ");
      }
      buildWordFrequency(text) {
        const stopWords = /* @__PURE__ */ new Set([
          "the",
          "a",
          "an",
          "is",
          "are",
          "was",
          "were",
          "be",
          "been",
          "being",
          "have",
          "has",
          "had",
          "do",
          "does",
          "did",
          "will",
          "would",
          "could",
          "should",
          "may",
          "might",
          "shall",
          "can",
          "to",
          "of",
          "in",
          "for",
          "on",
          "with",
          "at",
          "by",
          "from",
          "as",
          "into",
          "through",
          "during",
          "before",
          "after",
          "and",
          "but",
          "or",
          "nor",
          "not",
          "so",
          "yet",
          "both",
          "either",
          "neither",
          "each",
          "every",
          "all",
          "any",
          "few",
          "more",
          "most",
          "other",
          "some",
          "such",
          "no",
          "only",
          "own",
          "same",
          "than",
          "too",
          "very",
          "just",
          "because",
          "if",
          "when",
          "where",
          "how",
          "what",
          "which",
          "who",
          "whom",
          "this",
          "that",
          "these",
          "those",
          "it",
          "its",
          "i",
          "me",
          "my",
          "we",
          "our",
          "you",
          "your",
          "he",
          "him",
          "his",
          "she",
          "her",
          "they",
          "them",
          "their"
        ]);
        const frequency = /* @__PURE__ */ new Map();
        const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
        for (const word of words) {
          if (stopWords.has(word) || word.length < 3) {
            continue;
          }
          frequency.set(word, (frequency.get(word) ?? 0) + 1);
        }
        return frequency;
      }
      scoreSentence(sentence, wordFrequency) {
        const words = sentence.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
        let score = 0;
        for (const word of words) {
          score += wordFrequency.get(word) ?? 0;
        }
        return score;
      }
    };
  }
});

// packages/skills/dist/built-in/translate.js
var TranslateSkill;
var init_translate = __esm({
  "packages/skills/dist/built-in/translate.js"() {
    "use strict";
    init_skill();
    TranslateSkill = class extends Skill {
      metadata = {
        name: "translate",
        description: "Translate text between languages (placeholder \u2014 requires external API)",
        riskLevel: "read",
        version: "0.1.0",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to translate"
            },
            targetLanguage: {
              type: "string",
              description: 'The language to translate into (e.g. "es", "fr", "de")'
            },
            sourceLanguage: {
              type: "string",
              description: "The source language (optional, auto-detected if omitted)"
            }
          },
          required: ["text", "targetLanguage"]
        }
      };
      async execute(input2, _context) {
        const text = input2.text;
        const targetLanguage = input2.targetLanguage;
        const sourceLanguage = input2.sourceLanguage;
        if (!text || typeof text !== "string") {
          return {
            success: false,
            error: 'Invalid input: "text" must be a non-empty string'
          };
        }
        if (!targetLanguage || typeof targetLanguage !== "string") {
          return {
            success: false,
            error: 'Invalid input: "targetLanguage" must be a non-empty string'
          };
        }
        const sourceLabel = sourceLanguage ? ` from "${sourceLanguage}"` : "";
        return {
          success: true,
          data: {
            note: "Translation is not yet connected to a translation API",
            text,
            targetLanguage,
            sourceLanguage: sourceLanguage ?? "auto"
          },
          display: `Translation${sourceLabel} to "${targetLanguage}" is not yet implemented. This skill will be connected to a translation API in a future update.

Requested text: "${text}"`
        };
      }
    };
  }
});

// packages/skills/dist/built-in/weather.js
var WeatherSkill;
var init_weather = __esm({
  "packages/skills/dist/built-in/weather.js"() {
    "use strict";
    init_skill();
    WeatherSkill = class extends Skill {
      metadata = {
        name: "weather",
        description: "Get weather information for a location (placeholder \u2014 requires API key)",
        riskLevel: "read",
        version: "0.1.0",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: 'The location to get weather for (e.g. "London", "New York, NY")'
            },
            units: {
              type: "string",
              enum: ["metric", "imperial"],
              description: "Unit system for temperature (default: metric)"
            }
          },
          required: ["location"]
        }
      };
      async execute(input2, _context) {
        const location = input2.location;
        const units = input2.units ?? "metric";
        if (!location || typeof location !== "string") {
          return {
            success: false,
            error: 'Invalid input: "location" must be a non-empty string'
          };
        }
        return {
          success: true,
          data: {
            note: "Weather data is not yet available \u2014 API key configuration required",
            location,
            units
          },
          display: `Weather for "${location}" (${units}) is not yet implemented. This skill requires a weather API key to be configured.`
        };
      }
    };
  }
});

// packages/skills/dist/built-in/shell.js
import { exec } from "node:child_process";
function truncate(text) {
  if (text.length > MAX_OUTPUT_SIZE) {
    return text.slice(0, MAX_OUTPUT_SIZE) + "\n[output truncated]";
  }
  return text;
}
var DEFAULT_TIMEOUT, MAX_OUTPUT_SIZE, ShellSkill;
var init_shell = __esm({
  "packages/skills/dist/built-in/shell.js"() {
    "use strict";
    init_skill();
    DEFAULT_TIMEOUT = 3e4;
    MAX_OUTPUT_SIZE = 1e4;
    ShellSkill = class extends Skill {
      metadata = {
        name: "shell",
        description: "Execute shell commands on the host system and return stdout/stderr output. Use this tool to run CLI commands, scripts, or system utilities. Commands run in a child process with a configurable timeout and working directory.",
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

// packages/skills/dist/built-in/memory.js
var MemorySkill;
var init_memory = __esm({
  "packages/skills/dist/built-in/memory.js"() {
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

// packages/skills/dist/built-in/delegate.js
var DelegateSkill;
var init_delegate = __esm({
  "packages/skills/dist/built-in/delegate.js"() {
    "use strict";
    init_skill();
    DelegateSkill = class extends Skill {
      llm;
      metadata = {
        name: "delegate",
        description: "Delegate a complex sub-task to a separate AI agent. The sub-agent will process the task independently and return a result. Use this for tasks that require focused attention or multiple steps.",
        riskLevel: "write",
        version: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The task to delegate to a sub-agent"
            },
            context: {
              type: "string",
              description: "Additional context for the sub-agent (optional)"
            }
          },
          required: ["task"]
        }
      };
      constructor(llm) {
        super();
        this.llm = llm;
      }
      async execute(input2, _context) {
        const task = input2.task;
        const additionalContext = input2.context;
        if (!task || typeof task !== "string") {
          return {
            success: false,
            error: 'Missing required field "task"'
          };
        }
        const systemPrompt = "You are a sub-agent of Alfred. Complete the following task concisely and return the result. Do not use tools.";
        let userContent = task;
        if (additionalContext && typeof additionalContext === "string") {
          userContent = `${task}

Additional context: ${additionalContext}`;
        }
        const messages = [
          {
            role: "user",
            content: userContent
          }
        ];
        try {
          const response = await this.llm.complete({
            messages,
            system: systemPrompt,
            maxTokens: 2048
          });
          return {
            success: true,
            data: { response: response.content, usage: response.usage },
            display: response.content
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Sub-agent failed: ${errorMessage}`
          };
        }
      }
    };
  }
});

// packages/skills/dist/index.js
var init_dist6 = __esm({
  "packages/skills/dist/index.js"() {
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
    init_summarize();
    init_translate();
    init_weather();
    init_shell();
    init_memory();
    init_delegate();
  }
});

// packages/core/dist/conversation-manager.js
var ConversationManager;
var init_conversation_manager = __esm({
  "packages/core/dist/conversation-manager.js"() {
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

// packages/core/dist/message-pipeline.js
var MAX_TOOL_ITERATIONS, MessagePipeline;
var init_message_pipeline = __esm({
  "packages/core/dist/message-pipeline.js"() {
    "use strict";
    init_dist4();
    MAX_TOOL_ITERATIONS = 10;
    MessagePipeline = class {
      llm;
      conversationManager;
      users;
      logger;
      skillRegistry;
      skillSandbox;
      securityManager;
      memoryRepo;
      promptBuilder;
      constructor(llm, conversationManager, users, logger, skillRegistry, skillSandbox, securityManager, memoryRepo) {
        this.llm = llm;
        this.conversationManager = conversationManager;
        this.users = users;
        this.logger = logger;
        this.skillRegistry = skillRegistry;
        this.skillSandbox = skillSandbox;
        this.securityManager = securityManager;
        this.memoryRepo = memoryRepo;
        this.promptBuilder = new PromptBuilder();
      }
      async process(message) {
        const startTime = Date.now();
        this.logger.info({ platform: message.platform, userId: message.userId, chatId: message.chatId }, "Processing message");
        try {
          const user = this.users.findOrCreate(message.platform, message.userId, message.userName, message.displayName);
          const conversation = this.conversationManager.getOrCreateConversation(message.platform, message.chatId, user.id);
          const history = this.conversationManager.getHistory(conversation.id);
          this.conversationManager.addMessage(conversation.id, "user", message.text);
          let memories;
          if (this.memoryRepo) {
            try {
              memories = this.memoryRepo.getRecentForPrompt(user.id, 20);
            } catch {
            }
          }
          const system = this.promptBuilder.buildSystemPrompt(memories);
          const messages = this.promptBuilder.buildMessages(history);
          messages.push({ role: "user", content: message.text });
          const tools = this.skillRegistry ? this.promptBuilder.buildTools(this.skillRegistry.getAll().map((s) => s.metadata)) : void 0;
          let response;
          let iteration = 0;
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
              const result = await this.executeToolCall(toolCall, {
                userId: user.id,
                chatId: message.chatId,
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
            messages.push({ role: "user", content: toolResultBlocks });
          }
          const responseText = response.content || "(no response)";
          this.conversationManager.addMessage(conversation.id, "assistant", responseText, response.toolCalls ? JSON.stringify(response.toolCalls) : void 0);
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
            chatId: context.chatId
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
    };
  }
});

// packages/core/dist/reminder-scheduler.js
var ReminderScheduler;
var init_reminder_scheduler = __esm({
  "packages/core/dist/reminder-scheduler.js"() {
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

// packages/messaging/dist/adapter.js
import { EventEmitter } from "node:events";
var MessagingAdapter;
var init_adapter = __esm({
  "packages/messaging/dist/adapter.js"() {
    "use strict";
    MessagingAdapter = class extends EventEmitter {
      status = "disconnected";
      getStatus() {
        return this.status;
      }
    };
  }
});

// packages/messaging/dist/adapters/telegram.js
import { Bot } from "grammy";
function mapParseMode(mode) {
  if (mode === "markdown")
    return "MarkdownV2";
  if (mode === "html")
    return "HTML";
  return void 0;
}
var TelegramAdapter;
var init_telegram = __esm({
  "packages/messaging/dist/adapters/telegram.js"() {
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
          const msg = ctx.message;
          const normalized = {
            id: String(msg.message_id),
            platform: "telegram",
            chatId: String(msg.chat.id),
            chatType: msg.chat.type === "private" ? "dm" : "group",
            userId: String(msg.from.id),
            userName: msg.from.username ?? String(msg.from.id),
            displayName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
            text: msg.text,
            timestamp: new Date(msg.date * 1e3),
            replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : void 0
          };
          this.emit("message", normalized);
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
    };
  }
});

// packages/messaging/dist/adapters/discord.js
import { Client, GatewayIntentBits, Events } from "discord.js";
var DiscordAdapter;
var init_discord = __esm({
  "packages/messaging/dist/adapters/discord.js"() {
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
        this.client.on(Events.MessageCreate, (message) => {
          if (message.author.bot)
            return;
          const normalized = {
            id: message.id,
            platform: "discord",
            chatId: message.channelId,
            chatType: message.channel.isDMBased() ? "dm" : "group",
            userId: message.author.id,
            userName: message.author.username,
            displayName: message.author.displayName,
            text: message.content,
            timestamp: message.createdAt,
            replyToMessageId: message.reference?.messageId ?? void 0
          };
          this.emit("message", normalized);
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
    };
  }
});

// packages/messaging/dist/adapters/matrix.js
var MatrixAdapter;
var init_matrix = __esm({
  "packages/messaging/dist/adapters/matrix.js"() {
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
        this.homeserverUrl = homeserverUrl;
        this.accessToken = accessToken;
        this.botUserId = botUserId;
      }
      async connect() {
        this.status = "connecting";
        const { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } = await import("matrix-bot-sdk");
        const storageProvider = new SimpleFsStorageProvider("./data/matrix-storage");
        this.client = new MatrixClient(this.homeserverUrl, this.accessToken, storageProvider);
        AutojoinRoomsMixin.setupOnClient(this.client);
        this.client.on("room.message", (roomId, event) => {
          if (event.sender === this.botUserId)
            return;
          if (event.content?.msgtype !== "m.text")
            return;
          const normalized = {
            id: event.event_id,
            platform: "matrix",
            chatId: roomId,
            chatType: "group",
            userId: event.sender,
            userName: event.sender.split(":")[0].slice(1),
            text: event.content.body,
            timestamp: new Date(event.origin_server_ts),
            replyToMessageId: event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id
          };
          this.emit("message", normalized);
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
    };
  }
});

// packages/messaging/dist/adapters/whatsapp.js
var WhatsAppAdapter;
var init_whatsapp = __esm({
  "packages/messaging/dist/adapters/whatsapp.js"() {
    "use strict";
    init_adapter();
    WhatsAppAdapter = class extends MessagingAdapter {
      platform = "whatsapp";
      socket;
      dataPath;
      constructor(dataPath) {
        super();
        this.dataPath = dataPath;
      }
      async connect() {
        this.status = "connecting";
        const baileys = await import("@whiskeysockets/baileys");
        const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys.default ?? baileys;
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
            const text = message.message.conversation ?? message.message.extendedTextMessage?.text;
            if (!text)
              continue;
            const normalized = {
              id: message.key.id ?? "",
              platform: "whatsapp",
              chatId: message.key.remoteJid ?? "",
              chatType: message.key.remoteJid?.endsWith("@g.us") ? "group" : "dm",
              userId: message.key.participant ?? message.key.remoteJid ?? "",
              userName: message.pushName ?? message.key.participant ?? message.key.remoteJid ?? "",
              text,
              timestamp: new Date(message.messageTimestamp * 1e3),
              replyToMessageId: message.message.extendedTextMessage?.contextInfo?.stanzaId ?? void 0
            };
            this.emit("message", normalized);
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
    };
  }
});

// packages/messaging/dist/adapters/signal.js
var SignalAdapter;
var init_signal = __esm({
  "packages/messaging/dist/adapters/signal.js"() {
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
          if (!dataMessage?.message)
            continue;
          const data = envelope.envelope;
          const chatId = dataMessage.groupInfo?.groupId ? `group.${dataMessage.groupInfo.groupId}` : data.sourceNumber ?? data.source ?? "";
          const normalized = {
            id: String(dataMessage.timestamp ?? Date.now()),
            platform: "signal",
            chatId,
            chatType: dataMessage.groupInfo ? "group" : "dm",
            userId: data.sourceNumber ?? data.source ?? "",
            userName: data.sourceName ?? data.sourceNumber ?? data.source ?? "",
            displayName: data.sourceName,
            text: dataMessage.message,
            timestamp: new Date(dataMessage.timestamp ?? Date.now())
          };
          this.emit("message", normalized);
        }
      }
    };
  }
});

// packages/messaging/dist/index.js
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
  "packages/messaging/dist/index.js"() {
    "use strict";
    init_adapter();
    init_telegram();
    init_discord();
    init_matrix();
    init_whatsapp();
    init_signal();
  }
});

// packages/core/dist/alfred.js
var Alfred;
var init_alfred = __esm({
  "packages/core/dist/alfred.js"() {
    "use strict";
    init_dist2();
    init_dist3();
    init_dist4();
    init_dist5();
    init_dist6();
    init_conversation_manager();
    init_message_pipeline();
    init_reminder_scheduler();
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
        this.logger.info("Storage initialized");
        const ruleEngine = new RuleEngine();
        const securityManager = new SecurityManager(ruleEngine, auditRepo, this.logger.child({ component: "security" }));
        this.logger.info("Security engine initialized");
        const llmProvider = createLLMProvider(this.config.llm);
        await llmProvider.initialize();
        this.logger.info({ provider: this.config.llm.provider, model: this.config.llm.model }, "LLM provider initialized");
        const skillRegistry = new SkillRegistry();
        skillRegistry.register(new CalculatorSkill());
        skillRegistry.register(new SystemInfoSkill());
        skillRegistry.register(new WebSearchSkill());
        skillRegistry.register(new ReminderSkill(reminderRepo));
        skillRegistry.register(new NoteSkill());
        skillRegistry.register(new SummarizeSkill());
        skillRegistry.register(new TranslateSkill());
        skillRegistry.register(new WeatherSkill());
        skillRegistry.register(new ShellSkill());
        skillRegistry.register(new MemorySkill(memoryRepo));
        skillRegistry.register(new DelegateSkill(llmProvider));
        this.logger.info({ skills: skillRegistry.getAll().map((s) => s.metadata.name) }, "Skills registered");
        const skillSandbox = new SkillSandbox(this.logger.child({ component: "sandbox" }));
        const conversationManager = new ConversationManager(conversationRepo);
        this.pipeline = new MessagePipeline(llmProvider, conversationManager, userRepo, this.logger.child({ component: "pipeline" }), skillRegistry, skillSandbox, securityManager, memoryRepo);
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
            const response = await this.pipeline.process(message);
            await adapter.sendMessage(message.chatId, response);
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
    };
  }
});

// packages/core/dist/index.js
var init_dist8 = __esm({
  "packages/core/dist/index.js"() {
    "use strict";
    init_alfred();
    init_message_pipeline();
    init_conversation_manager();
    init_reminder_scheduler();
  }
});

// packages/cli/dist/commands/start.js
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
  "packages/cli/dist/commands/start.js"() {
    "use strict";
    init_dist();
    init_dist2();
    init_dist8();
  }
});

// packages/cli/dist/commands/setup.js
var setup_exports = {};
__export(setup_exports, {
  setupCommand: () => setupCommand
});
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs4 from "node:fs";
import path4 from "node:path";
import yaml2 from "js-yaml";
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
  const configPath = path4.join(projectRoot, "config", "default.yml");
  if (fs4.existsSync(configPath)) {
    try {
      const parsed = yaml2.load(fs4.readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        Object.assign(config, parsed);
      }
    } catch {
    }
  }
  const envPath = path4.join(projectRoot, ".env");
  if (fs4.existsSync(envPath)) {
    try {
      const lines = fs4.readFileSync(envPath, "utf-8").split("\n");
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
  return { config, env };
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
      const existingUrl = existing.config.llm?.baseUrl ?? "http://localhost:11434";
      console.log("");
      baseUrl = await askWithDefault(rl, "Ollama URL (use a remote address if Ollama runs on another machine)", existingUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""));
      baseUrl = baseUrl.replace(/\/+$/, "");
      console.log(`  ${green(">")} Ollama URL: ${dim(baseUrl)}`);
    }
    const existingModel = existing.config.llm?.model ?? provider.defaultModel;
    console.log("");
    const model = await askWithDefault(rl, "Which model?", existingModel);
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
    const existingOwnerId = existing.config.security?.ownerUserId ?? existing.env["ALFRED_OWNER_USER_ID"] ?? "";
    console.log("");
    let ownerUserId;
    if (existingOwnerId) {
      ownerUserId = await askWithDefault(rl, "Owner user ID (for elevated permissions)", existingOwnerId);
    } else {
      const input2 = (await rl.question(`${BOLD}Owner user ID${RESET} ${dim("(optional, for elevated permissions)")}: ${YELLOW}`)).trim();
      process.stdout.write(RESET);
      ownerUserId = input2;
    }
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
    envLines.push("", "# === Security ===", "");
    if (ownerUserId) {
      envLines.push(`ALFRED_OWNER_USER_ID=${ownerUserId}`);
    } else {
      envLines.push("# ALFRED_OWNER_USER_ID=");
    }
    envLines.push("");
    const envPath = path4.join(projectRoot, ".env");
    fs4.writeFileSync(envPath, envLines.join("\n"), "utf-8");
    console.log(`  ${green("+")} ${dim(".env")} written`);
    const configDir = path4.join(projectRoot, "config");
    if (!fs4.existsSync(configDir)) {
      fs4.mkdirSync(configDir, { recursive: true });
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
        temperature: 0.7,
        maxTokens: 4096
      },
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
    const yamlStr = "# Alfred \u2014 Configuration\n# Generated by `alfred setup`\n# Edit manually or re-run `alfred setup` to reconfigure.\n\n" + yaml2.dump(config, { lineWidth: 120, noRefs: true, sortKeys: false });
    const configPath = path4.join(configDir, "default.yml");
    fs4.writeFileSync(configPath, yamlStr, "utf-8");
    console.log(`  ${green("+")} ${dim("config/default.yml")} written`);
    const dataDir = path4.join(projectRoot, "data");
    if (!fs4.existsSync(dataDir)) {
      fs4.mkdirSync(dataDir, { recursive: true });
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
    if (ownerUserId) {
      console.log(`  ${bold("Owner ID:")}       ${ownerUserId}`);
    }
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
  "packages/cli/dist/commands/setup.js"() {
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
        baseUrl: "http://localhost:11434/v1"
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

// packages/cli/dist/commands/config.js
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
  "packages/cli/dist/commands/config.js"() {
    "use strict";
    init_dist();
    SENSITIVE_KEYS = ["token", "apikey", "api_key", "accesstoken", "secret", "password"];
  }
});

// packages/cli/dist/commands/rules.js
var rules_exports = {};
__export(rules_exports, {
  rulesCommand: () => rulesCommand
});
import fs5 from "node:fs";
import path5 from "node:path";
import yaml3 from "js-yaml";
async function rulesCommand() {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const rulesPath = path5.resolve(config.security.rulesPath);
  if (!fs5.existsSync(rulesPath)) {
    console.log(`Rules directory not found: ${rulesPath}`);
    console.log("No security rules loaded.");
    return;
  }
  const stat = fs5.statSync(rulesPath);
  if (!stat.isDirectory()) {
    console.error(`Rules path is not a directory: ${rulesPath}`);
    process.exit(1);
  }
  const files = fs5.readdirSync(rulesPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  if (files.length === 0) {
    console.log(`No YAML rule files found in: ${rulesPath}`);
    return;
  }
  const ruleLoader = new RuleLoader();
  const allRules = [];
  const errors = [];
  for (const file of files) {
    const filePath = path5.join(rulesPath, file);
    try {
      const raw = fs5.readFileSync(filePath, "utf-8");
      const parsed = yaml3.load(raw);
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
  "packages/cli/dist/commands/rules.js"() {
    "use strict";
    init_dist();
    init_dist5();
  }
});

// packages/cli/dist/commands/status.js
var status_exports = {};
__export(status_exports, {
  statusCommand: () => statusCommand
});
import fs6 from "node:fs";
import path6 from "node:path";
import yaml4 from "js-yaml";
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
  const dbPath = path6.resolve(config.storage.path);
  const dbExists = fs6.existsSync(dbPath);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Status:   ${dbExists ? "exists" : "not yet created"}`);
  console.log("");
  const rulesPath = path6.resolve(config.security.rulesPath);
  let ruleCount = 0;
  let ruleFileCount = 0;
  if (fs6.existsSync(rulesPath) && fs6.statSync(rulesPath).isDirectory()) {
    const files = fs6.readdirSync(rulesPath).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    ruleFileCount = files.length;
    const ruleLoader = new RuleLoader();
    for (const file of files) {
      const filePath = path6.join(rulesPath, file);
      try {
        const raw = fs6.readFileSync(filePath, "utf-8");
        const parsed = yaml4.load(raw);
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
  "packages/cli/dist/commands/status.js"() {
    "use strict";
    init_dist();
    init_dist5();
  }
});

// packages/cli/dist/commands/logs.js
var logs_exports = {};
__export(logs_exports, {
  logsCommand: () => logsCommand
});
import fs7 from "node:fs";
import path7 from "node:path";
async function logsCommand(tail) {
  const configLoader = new ConfigLoader();
  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error.message);
    process.exit(1);
  }
  const dbPath = path7.resolve(config.storage.path);
  if (!fs7.existsSync(dbPath)) {
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
  "packages/cli/dist/commands/logs.js"() {
    "use strict";
    init_dist();
    init_dist3();
  }
});

// packages/cli/dist/index.js
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
