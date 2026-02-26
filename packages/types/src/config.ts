import type { LLMProviderConfig } from './llm.js';

export interface TelegramConfig {
  token: string;
  enabled: boolean;
}

export interface DiscordConfig {
  token: string;
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
  llm: LLMProviderConfig;
  storage: StorageConfig;
  logger: LoggerConfig;
  security: SecurityConfig;
}
