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
  backend: z.enum(['sqlite', 'postgres']).optional(),
  connectionString: z.string().optional(),
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
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama', 'openwebui', 'google', 'mistral']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

export const MultiModelConfigSchema = z.object({
  default: LLMProviderConfigSchema,
  strong: LLMProviderConfigSchema.optional(),
  fast: LLMProviderConfigSchema.optional(),
  embeddings: LLMProviderConfigSchema.optional(),
  local: LLMProviderConfigSchema.optional(),
}).passthrough();

export const LLMConfigSchema = z.union([LLMProviderConfigSchema, MultiModelConfigSchema]);

export const SearchConfigSchema = z.object({
  provider: z.enum(['brave', 'searxng', 'tavily', 'duckduckgo']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const EmailAccountConfigSchema = z.object({
  name: z.string().optional(),
  provider: z.enum(['imap-smtp', 'microsoft']).optional(),
  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
  }).optional(),
  smtp: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
  }).optional(),
  auth: z.object({
    user: z.string(),
    pass: z.string(),
  }).optional(),
  microsoft: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    tenantId: z.string(),
    refreshToken: z.string(),
  }).optional(),
});

export const EmailConfigSchema = z.union([
  z.object({ accounts: z.array(EmailAccountConfigSchema) }),
  EmailAccountConfigSchema,
]);

export const SpeechConfigSchema = z.object({
  provider: z.enum(['openai', 'groq', 'google']),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  ttsEnabled: z.boolean().optional(),
  ttsModel: z.string().optional(),
  ttsVoice: z.string().optional(),
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
  vorlauf: z.object({
    enabled: z.boolean(),
    minutesBefore: z.coerce.number().min(1).max(120).default(15),
    enrichWithRoute: z.boolean().optional(),
    enrichWithMemories: z.boolean().optional(),
  }).optional(),
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

export const ActiveLearningConfigSchema = z.object({
  enabled: z.boolean().optional(),
  minMessageLength: z.number().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  maxExtractionsPerMinute: z.number().optional(),
});

export const ApiTlsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
});

export const ApiConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.coerce.number().int().min(1).max(65535),
  host: z.string(),
  token: z.string().optional(),
  corsOrigin: z.string().optional(),
  webUi: z.boolean().optional(),
  tls: ApiTlsConfigSchema.optional(),
});

export const CodeAgentDefinitionSchema = z.object({
  name: z.string(),
  command: z.string(),
  argsTemplate: z.array(z.string()),
  promptVia: z.enum(['arg', 'stdin']).default('arg'),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().max(900_000).optional(),
});

export const GitHubForgeConfigSchema = z.object({
  token: z.string(),
  baseUrl: z.string().optional(),
});

export const GitLabForgeConfigSchema = z.object({
  token: z.string(),
  baseUrl: z.string().optional(),
});

export const ForgeConfigSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  baseBranch: z.string().optional(),
  github: GitHubForgeConfigSchema.optional(),
  gitlab: GitLabForgeConfigSchema.optional(),
});

export const CodeAgentsConfigSchema = z.object({
  enabled: z.boolean(),
  agents: z.array(CodeAgentDefinitionSchema),
  forge: ForgeConfigSchema.optional(),
});

export const ProjectAgentTemplateSchema = z.object({
  name: z.string(),
  buildCommands: z.array(z.string()),
  testCommands: z.array(z.string()),
  description: z.string().optional(),
});

export const ProjectAgentsConfigSchema = z.object({
  enabled: z.boolean(),
  templates: z.array(ProjectAgentTemplateSchema).optional(),
  defaultMaxDurationHours: z.number().optional(),
  defaultProgressEveryN: z.number().optional(),
  maxFixAttemptsPerIteration: z.number().optional(),
  buildCommandTimeoutMs: z.number().optional(),
});

export const DatabaseConnectionConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['postgres', 'mysql', 'mssql', 'mongodb', 'influx', 'sqlite', 'redis']),
  host: z.string(),
  port: z.coerce.number().optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  options: z.object({
    ssl: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    rowLimit: z.number().optional(),
  }).optional(),
});

export const FileStoreConfigSchema = z.object({
  backend: z.enum(['local', 'nfs', 's3']),
  basePath: z.string().optional(),
  s3Endpoint: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
});

export const ClusterNodeConfigSchema = z.object({
  id: z.string(),
  host: z.string(),
  port: z.coerce.number(),
  priority: z.number(),
});

export const ClusterConfigSchema = z.object({
  enabled: z.boolean(),
  nodeId: z.string(),
  role: z.enum(['primary', 'secondary']).optional(),
  redisUrl: z.string(),
  token: z.string().optional(),
  nodes: z.array(ClusterNodeConfigSchema).optional(),
  heartbeatIntervalMs: z.number().optional(),
  failoverAfterMs: z.number().optional(),
  adapters: z.array(z.string()).optional(),
});

export const DatabaseConfigSchema = z.object({
  enabled: z.boolean(),
  defaultRowLimit: z.number().optional(),
  defaultTimeoutMs: z.number().optional(),
  allowWrite: z.boolean().optional(),
  connections: z.array(DatabaseConnectionConfigSchema).optional(),
});

export const YouTubeConfigSchema = z.object({
  apiKey: z.string(),
  supadata: z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().optional(),
  }).optional(),
});

export const ProxmoxConfigSchema = z.object({
  baseUrl: z.string(),
  tokenId: z.string(),
  tokenSecret: z.string(),
  verifyTls: z.boolean().optional(),
  defaultNode: z.string().optional(),
});

export const UniFiConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  site: z.string().optional(),
  verifyTls: z.boolean().optional(),
});

export const HomeAssistantConfigSchema = z.object({
  baseUrl: z.string(),
  accessToken: z.string(),
  verifyTls: z.boolean().optional(),
});

export const CardDAVContactsConfigSchema = z.object({
  serverUrl: z.string(),
  username: z.string(),
  password: z.string(),
  addressBookPath: z.string().optional(),
});

export const GoogleContactsConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  refreshToken: z.string(),
});

export const MicrosoftContactsConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tenantId: z.string(),
  refreshToken: z.string(),
});

export const ContactsConfigSchema = z.object({
  provider: z.enum(['carddav', 'google', 'microsoft']),
  carddav: CardDAVContactsConfigSchema.optional(),
  google: GoogleContactsConfigSchema.optional(),
  microsoft: MicrosoftContactsConfigSchema.optional(),
});

export const DockerConfigSchema = z.object({
  socketPath: z.string().optional(),
  host: z.string().optional(),
  verifyTls: z.boolean().optional(),
});

export const BMWCarDataConfigSchema = z.object({
  clientId: z.string(),
});

export const RoutingConfigSchema = z.object({
  apiKey: z.string(),
});

export const BitpandaConfigSchema = z.object({
  apiKey: z.string().optional(),
});

export const TradingConfigSchema = z.object({
  exchanges: z.record(z.object({
    apiKey: z.string(),
    secret: z.string(),
  })).optional(),
  defaultExchange: z.string().optional(),
  defaultQuote: z.string().optional(),
  maxOrderEur: z.coerce.number().optional(),
  sandbox: z.boolean().optional(),
});

export const EnergyPriceConfigSchema = z.object({
  gridName: z.string().optional(),
  gridUsageCt: z.coerce.number().optional(),
  gridLossCt: z.coerce.number().optional(),
  gridCapacityFee: z.coerce.number().optional(),
  gridMeterFee: z.coerce.number().optional(),
});

export const MicrosoftTodoConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tenantId: z.string(),
  refreshToken: z.string(),
});

export const ConversationConfigSchema = z.object({
  maxHistoryMessages: z.number().min(10).max(500).optional(),
}).optional();

export const WebhookConfigSchema = z.object({
  name: z.string(),
  secret: z.string(),
  watchId: z.string().optional(),
  chatId: z.string().optional(),
  platform: z.string().optional(),
});

export const MarketplaceConfigSchema = z.object({
  ebay: z.object({
    appId: z.string(),
    certId: z.string(),
  }).optional(),
});

export const BriefingConfigSchema = z.object({
  location: z.string().optional(),
  homeAddress: z.string().optional(),
  officeAddress: z.string().optional(),
  homeAssistant: z.object({
    entities: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
  }).optional(),
});

export const ReasoningConfigSchema = z.object({
  enabled: z.boolean().optional(),
  schedule: z.enum(['morning_noon_evening', 'hourly', 'half_hourly']).optional(),
  tier: z.enum(['fast', 'default']).optional(),
  deduplicationHours: z.number().optional(),
});

export const ProxmoxBackupConfigSchema = z.object({
  baseUrl: z.string(),
  tokenId: z.string(),
  tokenSecret: z.string(),
  maxAgeHours: z.coerce.number().optional(),
  verifyTls: z.boolean().optional(),
});

export const RecipeConfigSchema = z.object({
  spoonacular: z.object({ apiKey: z.string() }).optional(),
  edamam: z.object({ appId: z.string(), appKey: z.string() }).optional(),
}).optional();

export const AlfredConfigSchema = z.object({
  name: z.string(),
  telegram: TelegramConfigSchema,
  discord: DiscordConfigSchema.optional(),
  whatsapp: WhatsAppConfigSchema.optional(),
  matrix: MatrixConfigSchema.optional(),
  signal: SignalConfigSchema.optional(),
  llm: LLMConfigSchema,
  storage: StorageConfigSchema,
  logger: LoggerConfigSchema,
  security: SecurityConfigSchema,
  search: SearchConfigSchema.optional(),
  email: EmailConfigSchema.optional(),
  speech: SpeechConfigSchema.optional(),
  calendar: CalendarConfigSchema.optional(),
  mcp: MCPConfigSchema.optional(),
  codeSandbox: CodeSandboxConfigSchema.optional(),
  activeLearning: ActiveLearningConfigSchema.optional(),
  api: ApiConfigSchema.optional(),
  codeAgents: CodeAgentsConfigSchema.optional(),
  projectAgents: ProjectAgentsConfigSchema.optional(),
  youtube: YouTubeConfigSchema.optional(),
  database: DatabaseConfigSchema.optional(),
  cluster: ClusterConfigSchema.optional(),
  fileStore: FileStoreConfigSchema.optional(),
  proxmox: ProxmoxConfigSchema.optional(),
  unifi: UniFiConfigSchema.optional(),
  homeassistant: HomeAssistantConfigSchema.optional(),
  contacts: ContactsConfigSchema.optional(),
  docker: DockerConfigSchema.optional(),
  bmw: BMWCarDataConfigSchema.optional(),
  routing: RoutingConfigSchema.optional(),
  todo: MicrosoftTodoConfigSchema.optional(),
  energy: EnergyPriceConfigSchema.optional(),
  bitpanda: BitpandaConfigSchema.optional(),
  trading: TradingConfigSchema.optional(),
  recipe: RecipeConfigSchema,
  marketplace: MarketplaceConfigSchema.optional(),
  briefing: BriefingConfigSchema.optional(),
  reasoning: ReasoningConfigSchema.optional(),
  webhooks: z.array(WebhookConfigSchema).optional(),
  proxmoxBackup: ProxmoxBackupConfigSchema.optional(),
  conversation: ConversationConfigSchema,
});
