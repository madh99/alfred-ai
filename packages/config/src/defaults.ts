import type { AlfredConfig } from '@alfred/types';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export const DEFAULT_CONFIG: DeepPartial<AlfredConfig> = {
  name: 'Alfred',
  telegram: {
    token: '',
    enabled: false,
  },
  discord: {
    token: '',
    enabled: false,
  },
  whatsapp: {
    enabled: false,
    dataPath: './data/whatsapp',
  },
  matrix: {
    homeserverUrl: 'https://matrix.org',
    accessToken: '',
    userId: '',
    enabled: false,
  },
  signal: {
    apiUrl: 'http://localhost:8080',
    phoneNumber: '',
    enabled: false,
  },
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
  },
  storage: {
    path: './data/alfred.db',
  },
  logger: {
    level: 'info',
    pretty: true,
  },
  security: {
    rulesPath: './config/rules',
    defaultEffect: 'deny',
  },
};
