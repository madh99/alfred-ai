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

export interface DashboardData {
  watches: WatchItem[];
  scheduled: ScheduledItem[];
  skillHealth: SkillHealthItem[];
}

export interface HealthData {
  status: string;
  db: boolean;
  uptime: number;
  startedAt?: string;
  timestamp: string;
}
