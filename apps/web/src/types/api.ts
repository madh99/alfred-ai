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
}

export interface HealthData {
  status: string;
  db: boolean;
  uptime: number;
  startedAt?: string;
  timestamp: string;
}
