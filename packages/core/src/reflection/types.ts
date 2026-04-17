import type { Logger } from 'pino';
import type { WatchRepository, MemoryRepository, ActivityRepository, WorkflowRepository, CmdbRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import type { Platform } from '@alfred/types';

export interface ReflectionResult {
  target: {
    type: 'watch' | 'workflow' | 'reminder' | 'suggestion';
    id?: string;
    name?: string;
  };
  finding: string;
  action: 'adjust' | 'delete' | 'create' | 'suggest' | 'deactivate' | 'pause';
  params?: Record<string, unknown>;
  risk: 'auto' | 'proactive' | 'confirm';
  reasoning: string;
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

export interface ReflectorDeps {
  watchRepo: WatchRepository;
  workflowRepo?: WorkflowRepository;
  memoryRepo: MemoryRepository;
  activityRepo: ActivityRepository;
  cmdbRepo?: CmdbRepository;
  skillRegistry: SkillRegistry;
  skillSandbox: SkillSandbox;
  llm: LLMProvider;
  adapters: Map<Platform, MessagingAdapter>;
  logger: Logger;
  defaultChatId: string;
  defaultPlatform: Platform;
  nodeId: string;
  config: Required<ReflectionConfig>;
}

export function resolveReflectionConfig(partial?: ReflectionConfig): Required<ReflectionConfig> {
  return {
    enabled: partial?.enabled ?? true,
    schedule: partial?.schedule ?? '0 4 * * *',
    watches: {
      staleAfterDays: partial?.watches?.staleAfterDays ?? 14,
      deleteAfterDays: partial?.watches?.deleteAfterDays ?? 30,
      maxTriggersPerDay: partial?.watches?.maxTriggersPerDay ?? 10,
      ignoredAlertsBeforePause: partial?.watches?.ignoredAlertsBeforePause ?? 5,
      failedActionsBeforeDisable: partial?.watches?.failedActionsBeforeDisable ?? 3,
    },
    workflows: {
      staleAfterDays: partial?.workflows?.staleAfterDays ?? 30,
      failedStepsBeforeSuggest: partial?.workflows?.failedStepsBeforeSuggest ?? 3,
    },
    reminders: {
      repeatPatternDays: partial?.reminders?.repeatPatternDays ?? 7,
      quickDismissSeconds: partial?.reminders?.quickDismissSeconds ?? 30,
    },
    conversation: {
      repeatQueryThreshold: partial?.conversation?.repeatQueryThreshold ?? 3,
      repeatSequenceThreshold: partial?.conversation?.repeatSequenceThreshold ?? 3,
      analysisWindowDays: partial?.conversation?.analysisWindowDays ?? 7,
    },
    docs: {
      configSnapshotIntervalDays: partial?.docs?.configSnapshotIntervalDays ?? 30,
      staleDocWarningDays: partial?.docs?.staleDocWarningDays ?? 90,
      runbookValidation: partial?.docs?.runbookValidation ?? true,
    },
    autonomy: {
      adjustParams: partial?.autonomy?.adjustParams ?? 'auto',
      deleteWatch: partial?.autonomy?.deleteWatch ?? 'proactive',
      createAutomation: partial?.autonomy?.createAutomation ?? 'confirm',
      deactivate: partial?.autonomy?.deactivate ?? 'proactive',
    },
  };
}
