import type { Logger } from 'pino';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { BackgroundTaskRepository, UserRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, BackgroundTask } from '@alfred/types';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';
import type { SkillHealthTracker } from './skill-health-tracker.js';
import type { PersistentAgentRunner } from './persistent-agent-runner.js';

export class BackgroundTaskRunner {
  private pollTimer?: ReturnType<typeof setInterval>;
  private running = 0;
  private polling = false;
  private readonly maxConcurrent = 3;
  private readonly pollIntervalMs = 5000;
  private readonly taskTimeoutMs = 5 * 60_000; // 5 minutes max per task
  private persistentRunner?: PersistentAgentRunner;

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly taskRepo: BackgroundTaskRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
    private readonly skillHealthTracker?: SkillHealthTracker,
  ) {}

  setPersistentRunner(runner: PersistentAgentRunner): void {
    this.persistentRunner = runner;
  }

  start(): void {
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.logger.info('Background task runner started');
    // Recover interrupted persistent tasks from previous process
    this.persistentRunner?.recoverInterrupted().catch(err => {
      this.logger.error({ err }, 'Failed to recover interrupted persistent tasks');
    });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.logger.info('Background task runner stopped');
  }

  private async poll(): Promise<void> {
    if (this.polling || this.running >= this.maxConcurrent) return;
    this.polling = true;

    try {
      const available = this.maxConcurrent - this.running;
      const tasks = await this.taskRepo.claimPending(available);

      for (const task of tasks) {
        this.running++;
        this.runTask(task).finally(() => { this.running--; });
      }
    } catch (err) {
      this.logger.error({ err }, 'Error polling for background tasks');
    } finally {
      this.polling = false;
    }
  }

  private async runTask(task: BackgroundTask): Promise<void> {
    // Delegate to persistent runner if task has max_duration_hours set
    if (task.maxDurationHours && this.persistentRunner) {
      await this.persistentRunner.runPersistent(task);
      return;
    }

    // Status already set to 'running' by claimPending()
    const startMs = Date.now();

    try {
      const skill = this.skillRegistry.get(task.skillName);
      if (!skill) {
        await this.taskRepo.updateStatus(task.id, 'failed', undefined, `Unknown skill: ${task.skillName}`);
        return;
      }

      // Skip if skill is auto-disabled
      if (this.skillHealthTracker?.isDisabled(task.skillName)) {
        await this.taskRepo.updateStatus(task.id, 'failed', undefined, `Skill "${task.skillName}" is temporarily disabled due to repeated failures`);
        return;
      }

      let input: Record<string, unknown>;
      try { input = JSON.parse(task.skillInput); }
      catch (err) {
        this.logger.warn({ taskId: task.id, err }, 'Malformed skill input JSON');
        await this.taskRepo.updateStatus(task.id, 'failed', undefined, 'Malformed skill input JSON');
        return;
      }
      const { context } = await buildSkillContext(this.users, {
        userId: task.userId,
        platform: task.platform as Platform,
        chatId: task.chatId,
        chatType: 'dm',
      });

      // Enforce task timeout
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Background task timed out')), this.taskTimeoutMs);
      });
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, context),
        timeoutPromise,
      ]).finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle); });
      const resultJson = JSON.stringify(result.data ?? result.display ?? result.error);

      await this.taskRepo.updateStatus(
        task.id,
        result.success ? 'completed' : 'failed',
        resultJson,
        result.error,
      );
      this.activityLogger?.logBackgroundTask({
        taskId: task.id, skillName: task.skillName,
        platform: task.platform, chatId: task.chatId, userId: task.userId,
        outcome: result.success ? 'success' : 'error',
        durationMs: Date.now() - startMs, error: result.error,
      });
      // Record skill health
      if (this.skillHealthTracker) {
        if (result.success) {
          this.skillHealthTracker.recordSuccess(task.skillName);
        } else {
          this.skillHealthTracker.recordFailure(task.skillName, result.error ?? 'Unknown error');
        }
      }

      const adapter = this.adapters.get(task.platform as Platform);
      if (adapter) {
        const message = result.success
          ? `\u2705 Background task completed: ${task.description}\n\nResult: ${result.display ?? JSON.stringify(result.data)}`
          : `\u274C Background task failed: ${task.description}\n\nError: ${result.error}`;
        await adapter.sendMessage(task.chatId, message);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.taskRepo.updateStatus(task.id, 'failed', undefined, errorMsg);
      this.logger.error({ taskId: task.id, err }, 'Background task failed');
      this.activityLogger?.logBackgroundTask({
        taskId: task.id, skillName: task.skillName,
        platform: task.platform, chatId: task.chatId, userId: task.userId,
        outcome: 'error', durationMs: Date.now() - startMs, error: errorMsg,
      });
      this.skillHealthTracker?.recordFailure(task.skillName, errorMsg);

      const adapter = this.adapters.get(task.platform as Platform);
      if (adapter) {
        await adapter.sendMessage(
          task.chatId,
          `\u274C Background task failed: ${task.description}\n\nError: ${errorMsg}`,
        );
      }
    }
  }
}
