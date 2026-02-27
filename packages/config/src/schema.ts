import { z } from 'zod';

export const TelegramConfigSchema = z.object({
  token: z.string().optional(),
  enabled: z.boolean(),
});

export const DiscordConfigSchema = z.object({
  token: z.string().optional(),
  enabled: z.boolean(),
});

export const WhatsAppConfigSchema = z.object({
  enabled: z.boolean(),
  dataPath: z.string(),
});

export const MatrixConfigSchema = z.object({
  homeserverUrl: z.string(),
  accessToken: z.string().optional(),
  userId: z.string().optional(),
  enabled: z.boolean(),
});

export const SignalConfigSchema = z.object({
  apiUrl: z.string(),
  phoneNumber: z.string().optional(),
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
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

export const SearchConfigSchema = z.object({
  provider: z.enum(['brave', 'searxng', 'tavily', 'duckduckgo']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const EmailConfigSchema = z.object({
  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
  }),
  smtp: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
  }),
  auth: z.object({
    user: z.string(),
    pass: z.string(),
  }),
});

export const SpeechConfigSchema = z.object({
  provider: z.enum(['openai', 'groq']),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
});

export const CalDAVConfigSchema = z.object({
  serverUrl: z.string(),
  username: z.string(),
  password: z.string(),
});

export const GoogleCalendarConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  refreshToken: z.string(),
});

export const MicrosoftCalendarConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tenantId: z.string(),
  refreshToken: z.string(),
});

export const CalendarConfigSchema = z.object({
  provider: z.enum(['caldav', 'google', 'microsoft']),
  caldav: CalDAVConfigSchema.optional(),
  google: GoogleCalendarConfigSchema.optional(),
  microsoft: MicrosoftCalendarConfigSchema.optional(),
});

export const MCPServerConfigSchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
});

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerConfigSchema),
});

export const CodeSandboxConfigSchema = z.object({
  enabled: z.boolean(),
  allowedLanguages: z.array(z.enum(['javascript', 'python'])).optional(),
  maxTimeoutMs: z.number().optional(),
  allowNetwork: z.boolean().optional(),
});

export const AlfredConfigSchema = z.object({
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
  speech: SpeechConfigSchema.optional(),
  calendar: CalendarConfigSchema.optional(),
  mcp: MCPConfigSchema.optional(),
  codeSandbox: CodeSandboxConfigSchema.optional(),
});
