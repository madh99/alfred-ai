import { z } from 'zod';

export const TelegramConfigSchema = z.object({
  token: z.string().default(''),
  enabled: z.boolean(),
});

export const DiscordConfigSchema = z.object({
  token: z.string(),
  enabled: z.boolean(),
});

export const StorageConfigSchema = z.object({
  path: z.string(),
});

export const LoggerConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  pretty: z.boolean(),
  auditLogPath: z.string().optional(),
});

export const SecurityConfigSchema = z.object({
  rulesPath: z.string(),
  defaultEffect: z.enum(['allow', 'deny']),
  ownerUserId: z.string().optional(),
});

export const LLMProviderConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  apiKey: z.string().default(''),
  baseUrl: z.string().optional(),
  model: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

export const AlfredConfigSchema = z.object({
  name: z.string(),
  telegram: TelegramConfigSchema,
  discord: DiscordConfigSchema.optional(),
  llm: LLMProviderConfigSchema,
  storage: StorageConfigSchema,
  logger: LoggerConfigSchema,
  security: SecurityConfigSchema,
});
