import type { Platform } from './messaging.js';

export interface Conversation {
  id: string;
  platform: Platform;
  chatId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: string;
  createdAt: string;
}

export interface User {
  id: string;
  platform: Platform;
  platformUserId: string;
  username?: string;
  displayName?: string;
  timezone?: string;
  language?: string;
  bio?: string;
  preferences?: Record<string, unknown>;
  masterUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkToken {
  id: string;
  code: string;
  userId: string;
  platform: string;
  createdAt: string;
  expiresAt: string;
}

export interface BackgroundTask {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  description: string;
  skillName: string;
  skillInput: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'checkpointed' | 'resuming' | 'cancelled';
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  agentState?: string;
  checkpointAt?: string;
  resumeCount?: number;
  maxDurationHours?: number;
}

export interface AgentCheckpoint {
  conversationHistory: Array<{ role: string; content: string }>;
  partialResults: unknown[];
  currentIteration: number;
  totalIterations: number;
  startedAt: string;
  lastActivityAt: string;
  /** Serialized data store entries from DelegateSkill (large tool results). */
  dataStore?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ProjectAgentMeta {
  projectPhase: 'planning' | 'coding' | 'validating' | 'fixing' | 'committing' | 'awaiting_user' | 'done';
  projectIteration: number;
  projectGoal: string;
  buildCommands: string[];
  testCommands: string[];
  projectCwd: string;
  lastBuildOutput: string;
  lastCommitSha?: string;
  injectedMessages: string[];
  totalFilesChanged: number;
  milestonesReached: string[];
  consecutiveFixFailures: number;
  agentName: string;
}

export interface ScheduledAction {
  id: string;
  userId: string;
  platform: string;
  chatId: string;
  name: string;
  description: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  skillName: string;
  skillInput: string;
  promptTemplate?: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  threadId?: string;
}

export interface WatchCondition {
  field: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'changed' | 'increased' | 'decreased' | 'always_gt' | 'always_lt' | 'always_gte' | 'always_lte';
  value?: string | number;
}

export interface CompositeCondition {
  logic: 'and' | 'or';
  conditions: WatchCondition[];
}

export interface Watch {
  id: string;
  userId?: string;
  chatId: string;
  platform: string;
  name: string;
  skillName: string;
  skillParams: Record<string, unknown>;
  condition: WatchCondition;
  intervalMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastTriggeredAt: string | null;
  lastValue: string | null;
  createdAt: string;
  messageTemplate?: string;
  compositeCondition?: CompositeCondition;
  actionSkillName?: string;
  actionSkillParams?: Record<string, unknown>;
  actionOnTrigger: 'alert' | 'action_only' | 'alert_and_action' | 'trigger_watch';
  lastActionError?: string;
  requiresConfirmation?: boolean;
  triggerWatchId?: string;
  threadId?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export interface PendingConfirmation {
  id: string;
  chatId: string;
  platform: string;
  source: 'watch' | 'scheduled' | 'reasoning';
  sourceId: string;
  description: string;
  skillName: string;
  skillParams: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface Document {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  contentHash?: string;
  visibility: 'private' | 'shared' | 'public';
  createdAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embeddingId?: string;
  createdAt: string;
}

export interface WorkflowActionStep {
  type?: 'action';  // optional for backward compat — undefined treated as 'action'
  skillName: string;
  inputMapping: Record<string, unknown>;  // Key → Template "{{prev.field}}" or nested objects with templates
  onError: 'stop' | 'skip' | 'retry';
  maxRetries?: number;
  jumpTo?: number | 'end';  // override next step: index or 'end' to terminate workflow
}

export interface WorkflowConditionExpr {
  field: string;             // dot-path into template context: "prev.rain", "steps.0.temp"
  operator: WatchCondition['operator'];
  value?: string | number;
}

export interface WorkflowConditionStep {
  type: 'condition';
  condition: WorkflowConditionExpr;
  then: number | 'end' | null;   // step index, 'end', or null (next step)
  else: number | 'end' | null;
  label?: string;
}

export type WorkflowStep = WorkflowActionStep | WorkflowConditionStep;

export interface WorkflowChain {
  id: string;
  name: string;
  userId: string;
  chatId: string;
  platform: string;
  steps: WorkflowStep[];
  triggerType: 'manual' | 'watch' | 'scheduled';
  triggerConfig?: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

export interface WorkflowExecution {
  id: string;
  chainId: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  stepsCompleted: number;
  totalSteps: number;
  stepResults?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
