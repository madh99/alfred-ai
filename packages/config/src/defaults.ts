// Use Record<string, unknown> rather than DeepPartial<AlfredConfig> because
// the flat LLM format in defaults is only normalized to MultiModelConfig
// after Zod validation in the loader.
export const DEFAULT_CONFIG: Record<string, unknown> = {
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
  api: {
    enabled: true,
    port: 3420,
    host: '127.0.0.1',
  },
};
