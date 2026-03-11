import type { ActivityRepository } from '@alfred/storage';
import type { Logger } from 'pino';

/**
 * Central activity logger — wraps ActivityRepository with convenience methods.
 * All methods are fire-and-forget (never throw).
 */
export class ActivityLogger {
  constructor(
    private readonly repo: ActivityRepository,
    private readonly logger: Logger,
  ) {}

  logSkillExec(opts: {
    userId: string;
    platform: string;
    chatId: string;
    skillName: string;
    outcome: 'success' | 'error' | 'denied';
    durationMs?: number;
    error?: string;
    details?: Record<string, unknown>;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'skill_exec',
      source: 'user',
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.skillName,
      outcome: opts.outcome,
      durationMs: opts.durationMs,
      errorMessage: opts.error,
      details: opts.details,
    }));
  }

  logWatchTrigger(opts: {
    watchId: string;
    watchName: string;
    value: string;
    platform: string;
    chatId: string;
    outcome: 'success' | 'error';
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'watch_trigger',
      source: 'watch',
      sourceId: opts.watchId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.watchName,
      outcome: opts.outcome,
      errorMessage: opts.error,
      details: { value: opts.value },
    }));
  }

  logWatchAction(opts: {
    watchId: string;
    watchName: string;
    skillName: string;
    platform: string;
    chatId: string;
    outcome: 'success' | 'error';
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'watch_action',
      source: 'watch',
      sourceId: opts.watchId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.skillName,
      outcome: opts.outcome,
      errorMessage: opts.error,
      details: { watchName: opts.watchName },
    }));
  }

  logConfirmation(opts: {
    confirmationId: string;
    skillName: string;
    description: string;
    source: 'watch' | 'scheduled';
    sourceId: string;
    outcome: 'approved' | 'rejected' | 'expired' | 'error';
    userId?: string;
    platform?: string;
    chatId?: string;
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'confirmation',
      source: opts.source,
      sourceId: opts.sourceId,
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.skillName,
      outcome: opts.outcome,
      errorMessage: opts.error,
      details: { confirmationId: opts.confirmationId, description: opts.description },
    }));
  }

  logScheduledExec(opts: {
    actionId: string;
    actionName: string;
    skillName?: string;
    platform: string;
    chatId: string;
    userId: string;
    outcome: 'success' | 'error';
    durationMs?: number;
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'scheduled_exec',
      source: 'scheduled',
      sourceId: opts.actionId,
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.actionName,
      outcome: opts.outcome,
      durationMs: opts.durationMs,
      errorMessage: opts.error,
      details: opts.skillName ? { skillName: opts.skillName } : undefined,
    }));
  }

  logBackgroundTask(opts: {
    taskId: string;
    skillName: string;
    platform: string;
    chatId: string;
    userId: string;
    outcome: 'success' | 'error';
    durationMs?: number;
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'background_task',
      source: 'background',
      sourceId: opts.taskId,
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.skillName,
      outcome: opts.outcome,
      durationMs: opts.durationMs,
      errorMessage: opts.error,
    }));
  }

  logCalendarNotify(opts: {
    eventId: string;
    eventTitle: string;
    platform: string;
    chatId: string;
    outcome: 'success' | 'error';
    error?: string;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'calendar_notify',
      source: 'system',
      sourceId: opts.eventId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.eventTitle,
      outcome: opts.outcome,
      errorMessage: opts.error,
    }));
  }

  logWorkflowExec(opts: {
    chainId: string;
    chainName: string;
    executionId: string;
    platform: string;
    chatId: string;
    userId: string;
    outcome: 'success' | 'error';
    error?: string;
    details?: Record<string, unknown>;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'workflow_exec',
      source: 'workflow',
      sourceId: opts.chainId,
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.chainName,
      outcome: opts.outcome,
      errorMessage: opts.error,
      details: { executionId: opts.executionId, ...opts.details },
    }));
  }

  logAgentLifecycle(opts: {
    taskId: string;
    skillName: string;
    event: string;
    platform: string;
    chatId: string;
    userId: string;
    details?: Record<string, unknown>;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'agent_lifecycle',
      source: 'background',
      sourceId: opts.taskId,
      userId: opts.userId,
      platform: opts.platform,
      chatId: opts.chatId,
      action: opts.event,
      outcome: 'success',
      details: { skillName: opts.skillName, ...opts.details },
    }));
  }

  logSkillHealth(opts: {
    skillName: string;
    outcome: 'disabled' | 're-enabled' | 'degraded';
    details?: Record<string, unknown>;
  }): void {
    this.safe(() => this.repo.log({
      eventType: 'skill_health',
      source: 'system',
      action: opts.skillName,
      outcome: opts.outcome,
      details: opts.details,
    }));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn({ err }, 'Failed to write activity log entry');
    }
  }
}
