export type RiskLevel = 'read' | 'write' | 'destructive' | 'admin';

export type RuleEffect = 'allow' | 'deny';

export type RuleScope = 'global' | 'user' | 'conversation' | 'platform';

export interface TimeWindow {
  daysOfWeek?: number[];
  startHour?: number;
  endHour?: number;
}

export interface RateLimit {
  maxInvocations: number;
  windowSeconds: number;
}

export interface SecurityRuleConditions {
  users?: string[];
  platforms?: string[];
  chatType?: string;
  timeWindow?: TimeWindow;
}

export interface SecurityRule {
  id: string;
  effect: RuleEffect;
  priority: number;
  scope: RuleScope;
  actions: string[];
  riskLevels: RiskLevel[];
  conditions?: SecurityRuleConditions;
  rateLimit?: RateLimit;
}

export interface SecurityEvaluation {
  allowed: boolean;
  matchedRule?: SecurityRule;
  reason: string;
  timestamp: Date;
}

export interface AuditEntry {
  id: string;
  timestamp: Date;
  userId: string;
  action: string;
  riskLevel: RiskLevel;
  ruleId?: string;
  effect: RuleEffect;
  platform: string;
  chatId?: string;
  context?: Record<string, unknown>;
}
