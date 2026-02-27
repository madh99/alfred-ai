import type { Logger } from 'pino';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { BackgroundTaskRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, BackgroundTask } from '@alfred/types';

export class BackgroundTaskRunner {
  private pollTimer?: ReturnType<typeof setInterval>;
  private running = 0;
  private readonly maxConcurrent = 3;
  private readonly pollIntervalMs = 5000;

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly taskRepo: BackgroundTaskRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.logger.info('Background task runner started');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.logger.info('Background task runner stopped');
  }

  private async poll(): Promise<void> {
    if (this.running >= this.maxConcurrent) return;

    try {
      const available = this.maxConcurrent - this.running;
      const tasks = this.taskRepo.getPending(available);

      for (const task of tasks) {
        this.running++;
        this.runTask(task).finally(() => { this.running--; });
      }
    } catch (err) {
      this.logger.error({ err }, 'Error polling for background tasks');
    }
  }

  private async runTask(task: BackgroundTask): Promise<void> {
    this.taskRepo.updateStatus(task.id, 'running');

    try {
      const skill = this.skillRegistry.get(task.skillName);
      if (!skill) {
        this.taskRepo.updateStatus(task.id, 'failed', undefined, `Unknown skill: ${task.skillName}`);
        return;
      }

      const input = JSON.parse(task.skillInput);
      const context = {
        userId: task.userId,
        chatId: task.chatId,
        platform: task.platform,
        conversationId: '',
        chatType: 'dm' as const,
      };

      const result = await this.skillSandbox.execute(skill, input, context);
      const resultJson = JSON.stringify(result.data ?? result.display ?? result.error);

      this.taskRepo.updateStatus(
        task.id,
        result.success ? 'completed' : 'failed',
        resultJson,
        result.error,
      );

      const adapter = this.adapters.get(task.platform as Platform);
      if (adapter) {
        const message = result.success
          ? `\u2705 Background task completed: ${task.description}\n\nResult: ${result.display ?? JSON.stringify(result.data)}`
          : `\u274C Background task failed: ${task.description}\n\nError: ${result.error}`;
        await adapter.sendMessage(task.chatId, message);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskRepo.updateStatus(task.id, 'failed', undefined, errorMsg);
      this.logger.error({ taskId: task.id, err }, 'Background task failed');

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
