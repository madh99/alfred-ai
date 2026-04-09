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

export interface CloudflareConfig {
  apiToken: string;
}

export interface NginxProxyManagerConfig {
  baseUrl: string;
  email: string;
  password: string;
}

export interface PfSenseConfig {
  baseUrl: string;
  authMethod?: 'apikey' | 'jwt' | 'basic';
  apiKey?: string;
  username?: string;
  password?: string;
  verifyTls?: boolean;
}

export interface InfraDefaultsConfig {
  network?: string;
  proxmoxNode?: string;
  sshUser?: string;
  sshKeyPath?: string;
  processManager?: 'pm2' | 'systemd' | 'docker-compose';
  runtime?: 'node' | 'python' | 'static';
}

// ── CMDB / ITSM ─────────────────────────────────────────────

export type CmdbAssetType =
  | 'server' | 'vm' | 'lxc' | 'container' | 'cluster' | 'storage'
  | 'service' | 'application'
  | 'dns_record' | 'proxy_host' | 'firewall_rule' | 'certificate'
  | 'network' | 'network_device'
  | 'automation' | 'iot_device';

export type CmdbAssetStatus =
  | 'active' | 'inactive' | 'degraded' | 'decommissioned' | 'planned' | 'unknown';

export type CmdbRelationType =
  | 'hosted_on' | 'runs_on' | 'depends_on' | 'routes_to'
  | 'protects' | 'resolves_to' | 'proxied_by' | 'part_of'
  | 'manages' | 'monitors' | 'backs_up' | 'replicates_to' | 'connects_to';

export type CmdbEnvironment = 'production' | 'staging' | 'development' | 'test' | 'lab';

export type CmdbChangeType =
  | 'discovered' | 'created' | 'updated' | 'deleted' | 'decommissioned'
  | 'status_changed' | 'attribute_changed' | 'relation_added' | 'relation_removed';

export type CmdbChangeCategory =
  | 'auto_discovery' | 'manual' | 'deploy' | 'incident_resolution' | 'maintenance';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';

export type IncidentStatus =
  | 'open' | 'acknowledged' | 'investigating' | 'mitigating' | 'resolved' | 'closed' | 'cancelled';

export type ChangeRequestType = 'standard' | 'normal' | 'emergency';

export type ChangeRequestStatus =
  | 'draft' | 'submitted' | 'approved' | 'in_progress'
  | 'completed' | 'failed' | 'rolled_back' | 'cancelled';

export type ServiceCategory =
  | 'web' | 'api' | 'database' | 'messaging' | 'monitoring'
  | 'automation' | 'media' | 'network' | 'security' | 'storage';

export type ServiceHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export type ServiceCriticality = 'critical' | 'high' | 'medium' | 'low';

export interface CmdbAsset {
  id: string;
  userId: string;
  assetType: CmdbAssetType;
  name: string;
  identifier?: string;
  sourceSkill?: string;
  sourceId?: string;
  environment?: CmdbEnvironment;
  status: CmdbAssetStatus;
  ipAddress?: string;
  hostname?: string;
  fqdn?: string;
  location?: string;
  owner?: string;
  purpose?: string;
  attributes: Record<string, unknown>;
  tags?: string;
  notes?: string;
  discoveredAt?: string;
  lastSeenAt?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CmdbAssetRelation {
  id: string;
  userId: string;
  sourceAssetId: string;
  targetAssetId: string;
  relationType: CmdbRelationType;
  autoDiscovered: boolean;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CmdbChange {
  id: string;
  userId: string;
  assetId?: string;
  changeType: CmdbChangeType;
  category: CmdbChangeCategory;
  fieldName?: string;
  oldValue?: string;
  newValue?: string;
  description?: string;
  source?: string;
  createdAt: string;
}

export interface CmdbIncident {
  id: string;
  userId: string;
  title: string;
  description?: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  priority: number;
  affectedAssetIds: string[];
  affectedServiceIds: string[];
  symptoms?: string;
  investigationNotes?: string;
  rootCause?: string;
  resolution?: string;
  workaround?: string;
  lessonsLearned?: string;
  actionItems?: string;
  postmortem?: string;
  detectedBy?: string;
  relatedIncidentId?: string;
  problemId?: string;
  openedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ServiceComponentRole = 'database' | 'cache' | 'storage' | 'compute' | 'api' | 'proxy' | 'messaging' | 'monitoring' | 'dns' | 'other';

export interface ServiceComponent {
  assetId?: string;
  serviceId?: string;
  externalUrl?: string;
  role: ServiceComponentRole;
  name: string;
  required: boolean;
  healthStatus?: ServiceHealthStatus;
  healthReason?: string;
}

export interface CmdbService {
  id: string;
  userId: string;
  name: string;
  description?: string;
  category?: ServiceCategory;
  environment?: CmdbEnvironment;
  url?: string;
  healthCheckUrl?: string;
  healthStatus: ServiceHealthStatus;
  healthReason?: string;
  lastHealthCheck?: string;
  criticality?: ServiceCriticality;
  dependencies: string[];
  assetIds: string[];
  components: ServiceComponent[];
  owner?: string;
  documentation?: string;
  slaNotes?: string;
  maintenanceWindow?: string;
  tags?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CmdbChangeRequest {
  id: string;
  userId: string;
  title: string;
  description?: string;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  riskLevel: IncidentSeverity;
  affectedAssetIds: string[];
  affectedServiceIds: string[];
  implementationPlan?: string;
  rollbackPlan?: string;
  testPlan?: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  linkedIncidentId?: string;
  linkedProblemId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Problem Management ──────────────────────────────────────

export type ProblemStatus =
  | 'logged' | 'analyzing' | 'root_cause_identified'
  | 'fix_in_progress' | 'resolved' | 'closed';

export type ProblemPriority = 'critical' | 'high' | 'medium' | 'low';

export type ProblemCategory =
  | 'infrastructure' | 'software' | 'configuration' | 'capacity'
  | 'security' | 'network' | 'data' | 'process' | 'external' | 'unknown';

export interface CmdbProblem {
  id: string;
  userId: string;
  title: string;
  description?: string;
  status: ProblemStatus;
  priority: ProblemPriority;
  category?: ProblemCategory;
  rootCauseDescription?: string;
  rootCauseCategory?: ProblemCategory;
  workaround?: string;
  proposedFix?: string;
  isKnownError: boolean;
  knownErrorDescription?: string;
  analysisNotes?: string;
  linkedIncidentIds: string[];
  linkedChangeRequestId?: string;
  affectedAssetIds: string[];
  affectedServiceIds: string[];
  detectedBy: 'auto' | 'manual' | 'user_report';
  detectionMethod?: string;
  detectedAt: string;
  analyzedAt?: string;
  rootCauseIdentifiedAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CmdbDocType = 'runbook' | 'postmortem' | 'inventory' | 'topology' | 'service_map' | 'change_log' | 'problem_analysis' | 'custom';
export type CmdbDocFormat = 'markdown' | 'mermaid';
export type CmdbLinkedEntityType = 'asset' | 'service' | 'incident' | 'change_request' | 'problem';

export interface CmdbDocument {
  id: string;
  userId: string;
  docType: CmdbDocType;
  title: string;
  content: string;
  format: CmdbDocFormat;
  linkedEntityType?: CmdbLinkedEntityType;
  linkedEntityId?: string;
  version: number;
  generatedBy?: string;
  createdAt: string;
}

export interface CmdbConfig {
  enabled?: boolean;
  autoDiscoveryIntervalHours?: number;
  staleThresholdDays?: number;
  autoIncidentFromMonitor?: boolean;
  kgSync?: boolean;
  healthCheckIntervalMinutes?: number;
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
  cloudflare?: CloudflareConfig;
  nginxProxyManager?: NginxProxyManagerConfig;
  pfsense?: PfSenseConfig;
  infra?: InfraDefaultsConfig;
  cmdb?: CmdbConfig;
  conversation?: {
    maxHistoryMessages?: number;
  };
}
