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

export interface MSTeamsConfig {
  /** Enable/disable MS Teams adapter. */
  enabled?: boolean;
  /** Azure Bot / Entra App Registration Client ID. */
  appId: string;
  /** Client Secret from Entra App Registration. */
  appPassword: string;
  /** Azure AD Tenant ID (single-tenant mode). */
  tenantId: string;
  /** Port for Bot Framework webhook listener. Default: 3978. */
  webhookPort?: number;
  /** Path for Bot Framework webhook endpoint. Default: /api/messages. */
  webhookPath?: string;
  /** Who may DM the bot. Default: 'open'. */
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  /** AAD Object IDs of allowed DM users (for dmPolicy='allowlist'). */
  allowedUsers?: string[];
  /** Require @mention in channels before responding. Default: true. */
  requireMention?: boolean;
  /** Reply style in channels/groups: in-thread or top-level. Default: 'thread'. */
  replyStyle?: 'thread' | 'top-level';
}

export interface StorageConfig {
  path: string;
  backend?: 'sqlite' | 'postgres';
  connectionString?: string;  // PostgreSQL connection string (for HA cluster)
}

export interface LogFileConfig {
  enabled?: boolean;
  path?: string;
  maxSize?: string;
  maxFiles?: number;
  frequency?: 'daily' | 'hourly' | null;
}

export interface LoggerConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  pretty: boolean;
  auditLogPath?: string;
  file?: LogFileConfig;
}

export interface SecurityConfig {
  rulesPath: string;
  defaultEffect: 'allow' | 'deny';
  ownerUserId?: string;
  /** v726 — Master-Key (base64, 32 bytes) für AES-GCM-Verschlüsselung der Project-ENVs.
   *  Wenn nicht gesetzt: ENV-Persistenz nutzt Plain-Text mit Warning-Log. */
  envEncryptionKey?: string;
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
  /**
   * v844 — Output-Format des Agents. Bestimmt wie der Parser stdout interpretiert.
   * - 'text' (Default): Plain text, raw stdout wird durchgereicht
   * - 'claude-stream-json': JSONL aus `claude --output-format stream-json`
   * - 'codex-jsonl': JSONL aus `codex exec --json`
   * - 'vibe-streaming': JSONL aus `vibe -p --output streaming`
   */
  outputFormat?: 'text' | 'claude-stream-json' | 'codex-jsonl' | 'vibe-streaming';
  /**
   * v844 — Zusätzliche Pfade die der fs-mtime-Heartbeat im inactivity-Timer
   * scannen soll. Ergänzt cwd-Scan. Wichtig für Agents die ihre Session-Files
   * außerhalb von cwd schreiben (z.B. claude: ~/.claude/projects/...).
   * Unterstützt `~` und `$HOME` als Prefix.
   */
  additionalHeartbeatPaths?: string[];
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
  /**
   * v850 — MCP-Integration für CLI-Agents (claude-code, codex, vibe).
   *
   * Wenn enabled=true: Alfred patcht beim Start die jeweiligen CLI-Configs
   * (~/.claude/mcp.json, ~/.codex/config.toml, ~/.vibe/config.toml) damit
   * sie `alfred mcp-server` als stdio-MCP-Server kennen. Wird beim Agent-
   * Spawn ein One-Time-Token via env-var übergeben damit der MCP-Server
   * authentifizieren kann.
   *
   * Default: undefined → enabled=false (strict opt-in, sicher).
   * User aktiviert manuell in config.yaml ODER via UI-Toggle in v850.1+.
   */
  mcp?: {
    /** Master-Switch. Wenn false oder undefined: MCP-Integration deaktiviert. */
    enabled: boolean;
    /** Optional: Token-TTL in Sekunden (default 3600 = 1h). */
    tokenTtlSeconds?: number;
    /** Optional: command-Override falls alfred-binary nicht im PATH. */
    alfredCommand?: string;
    /** Optional: args-Override für `alfred mcp-server` invocation. */
    alfredArgs?: string[];
  };
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

export interface ReflectionConfig {
  enabled?: boolean;
  schedule?: string;
  watches?: {
    staleAfterDays?: number;
    deleteAfterDays?: number;
    maxTriggersPerDay?: number;
    ignoredAlertsBeforePause?: number;
    failedActionsBeforeDisable?: number;
  };
  workflows?: {
    staleAfterDays?: number;
    failedStepsBeforeSuggest?: number;
  };
  reminders?: {
    repeatPatternDays?: number;
    quickDismissSeconds?: number;
  };
  conversation?: {
    repeatQueryThreshold?: number;
    repeatSequenceThreshold?: number;
    analysisWindowDays?: number;
  };
  docs?: {
    configSnapshotIntervalDays?: number;
    staleDocWarningDays?: number;
    runbookValidation?: boolean;
  };
  autonomy?: {
    adjustParams?: 'auto' | 'proactive' | 'confirm';
    deleteWatch?: 'auto' | 'proactive' | 'confirm';
    createAutomation?: 'auto' | 'proactive' | 'confirm';
    deactivate?: 'auto' | 'proactive' | 'confirm';
  };
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

/** v665a — Ein Cluster-Share-Mount (NFS/SMB/etc.) auf den shared Projekte verweisen. */
export interface InfraShareConfig {
  id: string;
  name?: string;
  mountPath: string;
  type: 'nfs' | 'smb' | 'virtiofs' | 'cephfs' | 'local-shared';
  readOnly?: boolean;
  preflightCheck?: boolean;
}

export interface InfraDefaultsConfig {
  network?: string;
  proxmoxNode?: string;
  sshUser?: string;
  sshKeyPath?: string;
  processManager?: 'pm2' | 'systemd' | 'docker-compose';
  runtime?: 'node' | 'python' | 'static';
  /** v665a — Cluster-Shares. Identische mountPaths auf allen Nodes erwartet. */
  shares?: InfraShareConfig[];
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
  sla?: SlaDefinition;
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
  /** v633 T3.5 — how many times this incident was re-opened from a 24h recurrence window. */
  recurrenceCount?: number;
  /** v633 T3.5 — timestamp of the last re-open event (informational). */
  lastRecurrenceAt?: string;
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
  parentComponent?: string;
  failureImpact?: 'down' | 'degraded' | 'no_impact';
}

export interface FailureMode {
  name: string;
  trigger: string;
  affectedComponents: string[];
  serviceImpact: 'down' | 'degraded';
  cascadeEffects?: string[];
  runbookId?: string;
  sopId?: string;
  estimatedRecoveryMinutes?: number;
}

export interface SlaTargets {
  availabilityPercent?: number;
  maxDowntimeMinutesPerMonth?: number;
  mttrMinutes?: number;
  responseTimeMinutes?: number;
  resolutionTimeMinutes?: number;
}

export interface SlaMonitoring {
  trackAvailability: boolean;
  breachAlertEnabled: boolean;
  warningThresholdPercent?: number;
}

export interface SlaDefinition {
  name: string;
  enabled: boolean;
  targets: SlaTargets;
  monitoring: SlaMonitoring;
  escalation?: {
    breachNotify?: string[];
    warningNotify?: string[];
  };
}

export interface SlaEvent {
  id: string;
  userId: string;
  targetType: 'service' | 'asset';
  targetId: string;
  eventType: 'up' | 'down' | 'degraded' | 'breach' | 'warning';
  startedAt: string;
  endedAt?: string;
  durationMinutes?: number;
  details?: string;
  createdAt: string;
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
  failureModes?: FailureMode[];
  owner?: string;
  documentation?: string;
  slaNotes?: string;
  sla?: SlaDefinition;
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
  /** v633 T3.6 — GitLab/GitHub Merge-Request URL (auto-populated when change is created by code-agent fix). */
  prUrl?: string;
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
  detectedBy: 'auto' | 'manual' | 'user_report' | 'pattern_detection';
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

export interface ProjectsConfig {
  enabled?: boolean;
  summarizerLlmTier?: 'default' | 'strong';
  autoBindByCwd?: boolean;
  orphanDelegateThresholdToolCalls?: number;
  orphanDelegateThresholdMinutes?: number;
  healthCheckEnabled?: boolean;
  healthCheckIntervalHours?: number;
  healthProbeTimeoutMs?: number;
  /** v665a — Basis-Pfad für 'local' storage_type (z.B. '/home/alfred/projects') */
  localBase?: string;
  /** v665a — Default storage_type für neue Projekte (default: 'local') */
  defaultStorage?: 'local' | 'shared';
  /** v665a — Default share_id falls defaultStorage='shared' */
  defaultShareId?: string;
  /** v665a — rsync-Excludes-Default beim Move (Default: node_modules, dist, build, etc.) */
  rsyncExcludes?: string[];
  /**
   * v838 — Host-Node-V8-Heap-Limit für Subprocesses die Alfred spawnt
   * (build-probe, Plan-Mode validateBuild, canonical-tasks Test-Harness).
   * Default 4096 (= --max-old-space-size=4096). Verhindert V8 SIGABRT
   * (exit 134) bei tsc/vitest auf großen Monorepos. NULL = kein Override.
   */
  hostNodeMaxOldSpaceSizeMb?: number;
}

export interface CmdbConfig {
  enabled?: boolean;
  autoDiscoveryIntervalHours?: number;
  staleThresholdDays?: number;
  autoIncidentFromMonitor?: boolean;
  kgSync?: boolean;
  healthCheckIntervalMinutes?: number;
}

/**
 * v696 — Project-Agent Sandbox + Live-Preview
 * Opt-in feature. Wenn enabled=false: existing project-agent flows komplett unverändert.
 */
export type SandboxSessionMode = 'classic' | 'sandbox' | 'sandbox-preview' | 'interactive-chat';
export type SandboxMergeStrategy = 'direct' | 'pr';

export interface SandboxConfig {
  /** Master-Switch. Default false. Wenn false oder Docker nicht verfügbar:
   *  alle Sessions laufen im classic-Modus (heutiges Verhalten, kein UI-Change). */
  enabled?: boolean;
  /** Default-Modus für neue Sessions ohne explizite Wahl. Default 'classic'. */
  defaultMode?: SandboxSessionMode;
  /** Default-Merge-Strategie für Sandbox-Sessions. Default 'pr'. */
  defaultMergeStrategy?: SandboxMergeStrategy;
  /** Max parallele laufende Sandboxes pro User. Default 3. */
  maxParallelPerUser?: number;
  /** Disk-Quota pro User in MB. Default 5120 (5 GB). */
  diskQuotaPerUserMb?: number;
  /** Disk-Quota pro einzelner Sandbox in MB. Default 2048 (2 GB). */
  diskQuotaPerSandboxMb?: number;
  /** Host-Port-Range für Container-Forwarding [start, end]. Default [9100, 9199]. */
  hostPortRangeStart?: number;
  hostPortRangeEnd?: number;
  /** Idle-Minuten bis status='running' → 'paused'. Default 30. */
  idleTimeoutMin?: number;
  /** Stunden seit destroyed_at OR (paused + last_active_at) bis Cleanup. Default 24. */
  cleanupAfterHours?: number;
  /** Worktree-Base-Path. Default '/var/alfred/worktrees'. HA-Cluster: auf NFS-Mount setzen. */
  worktreeBasePath?: string;
  /** Container-Image für Sandbox-Runtime. Default 'alfred-sandbox:node-22'. */
  containerImage?: string;
  /** Shared pnpm-store mount (optional, beschleunigt npm install). NULL = pro Container eigener Store. */
  pnpmStorePath?: string | null;
  /** v726 — Pfad in dem Upload-DB-Seeds gespeichert werden. Default '/var/alfred/db-seeds'. */
  uploadSeedsPath?: string;
  /**
   * v837 — Container-RAM-Limit in MB. Default 6144 (6 GB).
   * Vorher hardcoded 2048 → tsc/vitest auf großen Monorepos OOM-crashen.
   * Trade-off: höhere Defaults = mehr Host-RAM-Verbrauch pro Sandbox (deshalb
   * `maxConcurrentSandboxes` mit beachten).
   */
  memoryMb?: number;
  /** v837 — Container-CPU-Limit. Default 2. */
  cpus?: number;
  /**
   * v837 — `NODE_OPTIONS=--max-old-space-size=<N>` im Container setzen damit Node
   * den verfügbaren RAM auch nutzt (sonst Default ~1.4 GB unabhängig vom Container-Limit).
   * Default: 67% von memoryMb. NULL um zu deaktivieren.
   */
  nodeMaxOldSpaceSizeMb?: number;
  /**
   * v837 — Merge-Gate-Tests im Container ausführen statt auf Host (eliminiert die
   * Container-vs-Host-Environment-Asymmetrie die zum setup.ts-Bug geführt hat).
   * Default true (= Container wenn vorhanden).
   */
  mergeGateRunInContainer?: boolean;
  /** v815 — Stuck-Threshold-Minuten für Auto-Cleanup. Default 10. */
  stuckThresholdMinutes?: number;
  /** v815 — Stuck-Cleanup-Interval-Minuten. Default 5. */
  stuckCleanupIntervalMinutes?: number;
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
  msteams?: MSTeamsConfig;
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
  reflection?: ReflectionConfig;
  webhooks?: WebhookConfig[];
  proxmoxBackup?: ProxmoxBackupConfig;
  mqtt?: MqttConfig;
  cloudflare?: CloudflareConfig;
  nginxProxyManager?: NginxProxyManagerConfig;
  pfsense?: PfSenseConfig;
  infra?: InfraDefaultsConfig;
  cmdb?: CmdbConfig;
  /** v828 — Agent-Conventions (CLAUDE.md/AGENTS.md) Verwaltung. Opt-in. */
  agentConventions?: import('./agent-conventions.js').AgentConventionsConfig;
  /** v696 — Project-Agent Sandbox (opt-in). Wenn nicht gesetzt: classic-only Verhalten. */
  sandbox?: SandboxConfig;
  projects?: ProjectsConfig;
  backup?: BackupConfig;
  commvault?: CommvaultConfig;
  mikrotik?: MikroTikConfig;
  personality?: PersonalityConfig;
  conversation?: {
    maxHistoryMessages?: number;
  };
}

export interface BackupConfig {
  enabled?: boolean;
  schedule?: string;
  retention_days?: number;
  storage?: 'local' | 's3' | 'both' | 'none';
  local_path?: string;
  s3_bucket?: string;
  restore_via_chat?: boolean;
  include_tokens?: boolean;
  include_config?: boolean;
  include_minio?: boolean;
}

export interface CommvaultConfig {
  enabled?: boolean;
  baseUrl: string;
  apiToken?: string;
  username?: string;
  password?: string;
  verifyTls?: boolean;
  confirmation_mode?: boolean;
  polling_interval?: number;
  auto_retry_failed?: boolean;
  auto_incident?: boolean;
  storage_warning_pct?: number;
  sla_rpo_hours?: number;
}

export interface MikroTikRouterConfig {
  name: string;
  host: string;
  username: string;
  password: string;
  port?: number;
  ssl?: boolean;
  default?: boolean;
}

export interface PersonalityConfig {
  tone?: string;
  humor?: string;
  directness?: string;
  language?: string;
  custom?: string;
}

export interface MikroTikConfig {
  enabled?: boolean;
  confirmation_mode?: boolean;
  polling_interval?: number;
  auto_incident?: boolean;
  cpu_warning_pct?: number;
  ram_warning_pct?: number;
  routers?: MikroTikRouterConfig[];
  // Single-router ENV shorthand
  host?: string;
  username?: string;
  password?: string;
  port?: number;
  ssl?: boolean;
}
