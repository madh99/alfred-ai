import type { LLMProviderConfig } from './llm.js';

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

export interface AlfredConfig {
  name: string;
  telegram: TelegramConfig;
  discord?: DiscordConfig;
  whatsapp?: WhatsAppConfig;
  matrix?: MatrixConfig;
  signal?: SignalConfig;
  llm: LLMProviderConfig;
  storage: StorageConfig;
  logger: LoggerConfig;
  security: SecurityConfig;
}
