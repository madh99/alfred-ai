import type { MultiModelConfig } from './llm.js';

export interface TelegramConfig {
  token: string;
  enabled: boolean;
}

export interface DiscordConfig {
  token: string;
  enabled: boolean;
}

export interface WhatsAppConfig {
  enabled: boolean;
  dataPath: string;
}

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  enabled: boolean;
}

export interface SignalConfig {
  apiUrl: string;
  phoneNumber: string;
  enabled: boolean;
}

export interface StorageConfig {
  path: string;
}

export interface LoggerConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  pretty: boolean;
  auditLogPath?: string;
}

export interface SecurityConfig {
  rulesPath: string;
  defaultEffect: 'allow' | 'deny';
  ownerUserId?: string;
}

export interface SearchConfig {
  provider: 'brave' | 'searxng' | 'tavily' | 'duckduckgo';
  apiKey?: string;
  baseUrl?: string;
}

export interface EmailImapConfig {
  host: string;
  port: number;
  secure: boolean;
}

export interface EmailSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
}

export interface EmailAuthConfig {
  user: string;
  pass: string;
}

export interface EmailConfig {
  imap: EmailImapConfig;
  smtp: EmailSmtpConfig;
  auth: EmailAuthConfig;
}

export interface SpeechConfig {
  provider: 'openai' | 'groq';
  apiKey: string;
  baseUrl?: string;
}

export interface CalDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
}

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface MicrosoftCalendarConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  refreshToken: string;
}

export interface CalendarConfig {
  provider: 'caldav' | 'google' | 'microsoft';
  caldav?: CalDAVConfig;
  google?: GoogleCalendarConfig;
  microsoft?: MicrosoftCalendarConfig;
}

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

export interface CodeSandboxConfig {
  enabled: boolean;
  allowedLanguages?: ('javascript' | 'python')[];
  maxTimeoutMs?: number;
  allowNetwork?: boolean;
}

export interface AlfredConfig {
  name: string;
  telegram: TelegramConfig;
  discord?: DiscordConfig;
  whatsapp?: WhatsAppConfig;
  matrix?: MatrixConfig;
  signal?: SignalConfig;
  llm: MultiModelConfig;
  storage: StorageConfig;
  logger: LoggerConfig;
  security: SecurityConfig;
  search?: SearchConfig;
  email?: EmailConfig;
  speech?: SpeechConfig;
  calendar?: CalendarConfig;
  mcp?: MCPConfig;
  codeSandbox?: CodeSandboxConfig;
}
