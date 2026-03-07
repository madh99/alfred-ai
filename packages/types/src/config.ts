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

export interface MicrosoftEmailConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  refreshToken: string;
}

export interface EmailAccountConfig {
  name: string;
  provider?: 'imap-smtp' | 'microsoft';
  imap?: EmailImapConfig;
  smtp?: EmailSmtpConfig;
  auth?: EmailAuthConfig;
  microsoft?: MicrosoftEmailConfig;
}

export interface EmailConfig {
  accounts: EmailAccountConfig[];
}

export interface SpeechConfig {
  provider: 'openai' | 'groq' | 'google';
  apiKey: string;
  baseUrl?: string;
  ttsEnabled?: boolean;
  ttsModel?: string;
  ttsVoice?: string;
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

export interface ActiveLearningConfig {
  enabled?: boolean;
  minMessageLength?: number;
  minConfidence?: number;
  maxExtractionsPerMinute?: number;
}

export interface ApiConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export interface CodeAgentDefinitionConfig {
  name: string;
  command: string;
  argsTemplate: string[];
  promptVia?: 'arg' | 'stdin';
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface GitHubForgeConfig {
  token: string;
  baseUrl?: string;
}

export interface GitLabForgeConfig {
  token: string;
  baseUrl?: string;
}

export interface ForgeConfig {
  provider: 'github' | 'gitlab';
  baseBranch?: string;
  github?: GitHubForgeConfig;
  gitlab?: GitLabForgeConfig;
}

export interface CodeAgentsConfig {
  enabled: boolean;
  agents: CodeAgentDefinitionConfig[];
  forge?: ForgeConfig;
}

export interface ProxmoxConfig {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  verifyTls?: boolean;
  defaultNode?: string;
}

export interface UniFiConfig {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  site?: string;
  verifyTls?: boolean;
}

export interface HomeAssistantConfig {
  baseUrl: string;
  accessToken: string;
  verifyTls?: boolean;
}

export interface CardDAVContactsConfig {
  serverUrl: string;
  username: string;
  password: string;
  addressBookPath?: string;
}

export interface GoogleContactsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface MicrosoftContactsConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  refreshToken: string;
}

export interface ContactsConfig {
  provider: 'carddav' | 'google' | 'microsoft';
  carddav?: CardDAVContactsConfig;
  google?: GoogleContactsConfig;
  microsoft?: MicrosoftContactsConfig;
}

export interface DockerConfig {
  socketPath?: string;
  host?: string;
  verifyTls?: boolean;
}

export interface BMWCarDataConfig {
  clientId: string;
}

export interface RoutingConfig {
  apiKey: string;
}

export interface EnergyPriceConfig {
  gridName?: string;
  gridUsageCt?: number;       // Netznutzungsentgelt ct/kWh
  gridLossCt?: number;        // Netzverlustentgelt ct/kWh
  gridCapacityFee?: number;   // Leistungspauschale €/Monat netto
  gridMeterFee?: number;      // Messentgelt €/Monat netto
}

export interface MarketplaceConfig {
  ebay?: {
    appId: string;
    certId: string;
  };
}

export interface MicrosoftTodoConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  refreshToken: string;
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
  activeLearning?: ActiveLearningConfig;
  api?: ApiConfig;
  codeAgents?: CodeAgentsConfig;
  proxmox?: ProxmoxConfig;
  unifi?: UniFiConfig;
  homeassistant?: HomeAssistantConfig;
  contacts?: ContactsConfig;
  docker?: DockerConfig;
  bmw?: BMWCarDataConfig;
  routing?: RoutingConfig;
  todo?: MicrosoftTodoConfig;
  energy?: EnergyPriceConfig;
  marketplace?: MarketplaceConfig;
  conversation?: {
    maxHistoryMessages?: number;
  };
}
