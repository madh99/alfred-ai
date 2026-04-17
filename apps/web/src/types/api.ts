export interface SseEvent {
  event: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
  status?: string;
}

export interface Attachment {
  type: 'image' | 'file' | 'voice';
  data: string;
  fileName?: string;
  caption?: string;
}

export interface WatchItem {
  id: string;
  name: string;
  skillName: string;
  enabled: boolean;
  intervalMinutes: number;
  lastCheckedAt: string | null;
  lastTriggeredAt: string | null;
  lastValue: string | null;
}

export interface ScheduledItem {
  id: string;
  name: string;
  description: string;
  scheduleType: string;
  scheduleValue: string;
  enabled: boolean;
  nextRunAt?: string;
}

export interface SkillHealthItem {
  skillName: string;
  consecutiveFails: number;
  totalSuccesses: number;
  totalFailures: number;
  lastError?: string;
  disabledUntil?: string;
}

export interface UsageRecord {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface DailyUsageSummary {
  date: string;
  models: UsageRecord[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface UsageData {
  today: DailyUsageSummary | null;
  week: DailyUsageSummary[];
  total: UsageRecord[];
}

export interface ReminderItem {
  id: string;
  message: string;
  triggerAt: string;
  platform: string;
}

export interface LlmProviderInfo {
  model: string;
  available: boolean;
}

export interface DashboardData {
  watches: WatchItem[];
  scheduled: ScheduledItem[];
  skillHealth: SkillHealthItem[];
  reminders?: ReminderItem[];
  usage?: UsageData;
  uptime?: number;
  startedAt?: string;
  adapters?: Record<string, string>;
  llmProviders?: Record<string, LlmProviderInfo>;
  userUsage?: Array<{ userId: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  userSkillUsage?: Array<{ userId: string; skillName: string; calls: number; successes: number; errors: number }>;
  services?: Array<{ name: string; provider: string; model: string; status: string }>;
  serviceUsage?: {
    today: Array<{ service: string; model: string; calls: number; units: number; unitType: string; costUsd: number }>;
    week: Array<{ service: string; model: string; calls: number; units: number; unitType: string; costUsd: number }>;
    total: Array<{ service: string; model: string; calls: number; units: number; unitType: string; costUsd: number }>;
  };
}

export interface HealthData {
  status: string;
  db: boolean;
  uptime: number;
  startedAt?: string;
  timestamp: string;
}

// ── Log Viewer ──────────────────────────────────────────────

export interface LogEntry {
  level: number;
  time: number;
  pid: number;
  name?: string;
  msg: string;
  version?: string;
  hostname?: string;
  component?: string;
  [key: string]: unknown;
}

export interface LogFile {
  name: string;
  size: number;
  modified: string;
}

export interface LogResponse {
  lines: LogEntry[];
  total: number;
  file: string;
  files?: LogFile[];
}

// ── Infra Docs ────────────────────────────────────────────

export interface DocTreeNode {
  id: string;
  name: string;
  type?: string;
  category?: string;
  docs: Array<{ id: string; title: string; docType: string; version: number; createdAt: string }>;
}

export interface DocTree {
  assets: DocTreeNode[];
  services: DocTreeNode[];
  unlinked: Array<{ id: string; title: string; docType: string; version: number; createdAt: string }>;
}

export interface DocDetail {
  id: string;
  userId: string;
  docType: string;
  title: string;
  content: string;
  format: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
  version: number;
  generatedBy?: string;
  createdAt: string;
}

// ── Service Management ──────────────────────────────────────

export interface ServiceComponent {
  name: string; role: string; assetId?: string; serviceId?: string;
  externalUrl?: string; required: boolean; failureImpact: string;
  failureDescription?: string; dependsOn?: string[]; ports?: number[];
  protocol?: string; dns?: string; ip?: string;
  healthCheckUrl?: string; healthStatus?: string; healthReason?: string;
  parentComponent?: string;
}

export interface FailureMode {
  name: string; trigger: string; affectedComponents: string[];
  serviceImpact: string; cascadeEffects?: string[];
  runbookId?: string; sopId?: string; estimatedRecoveryMinutes?: number;
}

export interface ServiceDetail {
  id: string; name: string; description?: string; category?: string;
  environment?: string; url?: string; healthStatus: string;
  criticality?: string; components: ServiceComponent[];
  failureModes: FailureMode[]; dependencies?: string[];
  assetIds?: string[]; owner?: string; documentation?: string;
  sla?: SlaDefinition; createdAt?: string; updatedAt?: string;
}

export interface SlaTargets {
  availabilityPercent?: number;
  maxDowntimeMinutesPerMonth?: number;
  mttrMinutes?: number;
  responseTimeMinutes?: number;
  resolutionTimeMinutes?: number;
}

export interface SlaDefinition {
  name: string;
  enabled: boolean;
  targets: SlaTargets;
  monitoring: { trackAvailability: boolean; breachAlertEnabled: boolean; warningThresholdPercent?: number };
}

export interface SlaEvent {
  id: string;
  targetType: 'service' | 'asset';
  targetId: string;
  eventType: string;
  startedAt: string;
  endedAt?: string;
  durationMinutes?: number;
  details?: string;
}

export interface SlaReport {
  targetType: 'service' | 'asset';
  targetId: string;
  targetName: string;
  sla: SlaDefinition;
  periodStart: string;
  periodEnd: string;
  uptimePercent: number;
  downtimeMinutes: number;
  totalMinutes: number;
  breaches: SlaEvent[];
  compliant: boolean;
}

// ── Cluster / HA Operations ─────────────────────────────────

export interface ClusterNode {
  nodeId: string;
  host: string;
  lastSeenAt: string;
  startedAt: string;
  uptimeS: number;
  adapters: string[];
  version: string;
  alive: boolean;
}

export interface AdapterClaim {
  platform: string;
  nodeId: string;
  claimedAt: string;
  expiresAt: string;
  active: boolean;
}

export interface ReasoningSlotEntry {
  slotKey: string;
  nodeId: string;
  claimedAt: string;
}

export interface OperationsStatus {
  reasoning: {
    schedule: string;
    lastPass?: string;
    nodeId?: string;
  };
  backup?: {
    schedule: string;
    lastRun?: string;
  };
  cmdbDiscovery?: {
    lastRun?: string;
    intervalHours?: number;
  };
  memoryConsolidation?: {
    lastRun?: string;
  };
}

export interface ClusterHealthData {
  clusterEnabled: boolean;
  thisNodeId: string;
  nodes: ClusterNode[];
  claims: AdapterClaim[];
  recentReasoningSlots: ReasoningSlotEntry[];
  operations: OperationsStatus;
}
