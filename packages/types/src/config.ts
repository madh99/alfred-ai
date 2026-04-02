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
  backend?: 'sqlite' | 'postgres';
  connectionString?: string;  // PostgreSQL connection string (for HA cluster)
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
  moderation?: {
    enabled?: boolean;
    provider?: 'mistral' | 'openai';
    model?: string;
  };
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
  /** Override STT provider (default: uses main speech provider). */
  sttProvider?: 'openai' | 'groq' | 'mistral';
  /** Override TTS provider (default: uses main speech provider). */
  ttsProvider?: 'openai' | 'mistral';
  /** API key for the STT provider (if different from main speech apiKey). */
  sttApiKey?: string;
  /** API key for the TTS provider (if different from main speech apiKey). */
  ttsApiKey?: string;
  /** Enable voice management skill (create/manage custom Mistral voices). Default: true when ttsProvider is mistral. */
  voiceManagement?: boolean;
  /** Default Mistral voice ID for TTS (overrides default voice). */
  defaultVoiceId?: string;
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
  vorlauf?: {
    enabled: boolean;
    minutesBefore: number;
    enrichWithRoute?: boolean;
    enrichWithMemories?: boolean;
  };
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

export interface ApiTlsConfig {
  enabled?: boolean;
  cert?: string;
  key?: string;
}

export interface ApiConfig {
  enabled: boolean;
  port: number;
  host: string;
  token?: string;
  corsOrigin?: string;
  publicUrl?: string;
  webUi?: boolean;
  tls?: ApiTlsConfig;
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

export interface ProjectAgentTemplateConfig {
  name: string;
  buildCommands: string[];
  testCommands: string[];
  description?: string;
}

export interface ProjectAgentsConfig {
  enabled: boolean;
  templates?: ProjectAgentTemplateConfig[];
  defaultMaxDurationHours?: number;
  defaultProgressEveryN?: number;
  maxFixAttemptsPerIteration?: number;
  buildCommandTimeoutMs?: number;
}

export interface DatabaseConnectionConfig {
  name: string;
  type: 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'influx' | 'sqlite' | 'redis';
  host: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  options?: {
    ssl?: boolean;
    readOnly?: boolean;
    timeoutMs?: number;
    rowLimit?: number;
  };
}

export interface DatabaseConfig {
  enabled: boolean;
  defaultRowLimit?: number;
  defaultTimeoutMs?: number;
  allowWrite?: boolean;
  connections?: DatabaseConnectionConfig[];
}

export interface YouTubeConfig {
  apiKey: string;
  supadata?: {
    enabled?: boolean;
    apiKey?: string;
  };
}

export interface FileStoreConfig {
  backend: 'local' | 'nfs' | 's3';
  basePath?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

export interface ClusterNodeConfig {
  id: string;
  host: string;
  port: number;
  priority: number;
}

export interface ClusterConfig {
  enabled: boolean;
  nodeId: string;
  /** @deprecated Active-Active has no role distinction. Kept for backward compatibility. */
  role?: 'primary' | 'secondary';
  redisUrl: string;
  token?: string;
  nodes?: ClusterNodeConfig[];
  heartbeatIntervalMs?: number;
  failoverAfterMs?: number;
  adapters?: string[];
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

export interface GoeChargerConfig {
  host: string;
}

export interface BMWCarDataConfig {
  clientId: string;
  /** MQTT Streaming — credentials from BMW Customer Portal */
  streaming?: {
    /** GCID username from portal */
    username: string;
    /** VIN topic from portal */
    topic: string;
    /** Enable MQTT streaming (default: false) */
    enabled?: boolean;
    /** MQTT broker host (default: customer.streaming-cardata.bmwgroup.com) */
    host?: string;
    /** MQTT broker port (default: 9000) */
    port?: number;
  };
}

export interface RoutingConfig {
  apiKey: string;
}

export interface BitpandaConfig {
  apiKey?: string;
}

export interface TradingConfig {
  exchanges?: Record<string, { apiKey: string; secret: string }>;
  defaultExchange?: string;
  defaultQuote?: string;
  maxOrderEur?: number;
  sandbox?: boolean;
}

export interface EnergyPriceConfig {
  gridName?: string;
  gridUsageCt?: number;       // Netznutzungsentgelt ct/kWh
  gridLossCt?: number;        // Netzverlustentgelt ct/kWh
  gridCapacityFee?: number;   // Leistungspauschale €/Monat netto
  gridMeterFee?: number;      // Messentgelt €/Monat netto
}

export interface LLMLinkingConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  /** 'daily' | 'weekly' | 'manual' (default: daily) */
  schedule?: 'daily' | 'weekly' | 'manual';
  maxEntitiesPerPass?: number;
}

export interface ReasoningConfig {
  enabled?: boolean;
  /** 'morning_noon_evening' = 3×/Tag (7h,12h,18h), 'hourly', 'half_hourly' */
  schedule?: 'morning_noon_evening' | 'hourly' | 'half_hourly';
  /** LLM tier to use (default: 'fast' = Haiku, cheapest) */
  tier?: 'fast' | 'default';
  /** Hours to suppress duplicate insights (default: 12) */
  deduplicationHours?: number;
  /** Optional LLM-based entity linking for semantic relationships. */
  llmLinking?: LLMLinkingConfig;
}

export interface BriefingConfig {
  location?: string;
  homeAddress?: string;
  officeAddress?: string;
  homeAssistant?: {
    entities?: string[];
    domains?: string[];
  };
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

export interface WebhookConfig {
  name: string;
  secret: string;
  watchId?: string;
  chatId?: string;
  platform?: string;
}

export interface ProxmoxBackupConfig {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  maxAgeHours?: number;
  verifyTls?: boolean;
}

export interface RecipeConfig {
  spoonacular?: { apiKey: string };
  edamam?: { appId: string; appKey: string };
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
}

export interface SonosConfig {
  cloud?: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
  };
}

export interface TravelConfig {
  kiwi?: { apiKey: string };
  booking?: { rapidApiKey: string };
  amadeus?: { clientId: string; clientSecret: string };
  defaultCurrency?: string;
  defaultOrigin?: string;
}

export interface MqttConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  topicPrefix?: string;
}

export interface AlfredConfig {
  name: string;
  /** Standalone Mistral API key — enables OCR, moderation, STT, TTS, embeddings independently of LLM provider. */
  mistralApiKey?: string;
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
  projectAgents?: ProjectAgentsConfig;
  youtube?: YouTubeConfig;
  database?: DatabaseConfig;
  cluster?: ClusterConfig;
  fileStore?: FileStoreConfig;
  proxmox?: ProxmoxConfig;
  unifi?: UniFiConfig;
  homeassistant?: HomeAssistantConfig;
  contacts?: ContactsConfig;
  docker?: DockerConfig;
  goeCharger?: GoeChargerConfig;
  bmw?: BMWCarDataConfig;
  routing?: RoutingConfig;
  todo?: MicrosoftTodoConfig;
  energy?: EnergyPriceConfig;
  bitpanda?: BitpandaConfig;
  trading?: TradingConfig;
  recipe?: RecipeConfig;
  spotify?: SpotifyConfig;
  sonos?: SonosConfig;
  travel?: TravelConfig;
  marketplace?: MarketplaceConfig;
  briefing?: BriefingConfig;
  reasoning?: ReasoningConfig;
  webhooks?: WebhookConfig[];
  proxmoxBackup?: ProxmoxBackupConfig;
  mqtt?: MqttConfig;
  conversation?: {
    maxHistoryMessages?: number;
  };
}
