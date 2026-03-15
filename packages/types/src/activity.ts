export interface ActivityEntry {
  id: string;
  timestamp: string;
  eventType: string;
  source: 'user' | 'watch' | 'scheduled' | 'background' | 'system' | 'workflow' | 'reasoning';
  sourceId?: string;
  userId?: string;
  platform?: string;
  chatId?: string;
  action: string;
  outcome: 'success' | 'error' | 'denied' | 'approved' | 'rejected' | 'expired' | 'skipped' | 'disabled' | 're-enabled' | 'degraded';
  errorMessage?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface ActivityQuery {
  eventType?: string;
  source?: string;
  outcome?: string;
  userId?: string;
  since?: string;
  limit?: number;
}

export interface ActivityStats {
  eventType: string;
  outcome: string;
  count: number;
}
