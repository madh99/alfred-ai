import type { Logger } from 'pino';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { BackgroundTaskRepository, UserRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, BackgroundTask, AgentCheckpoint } from '@alfred/types';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';

const CHECKPOINT_EVERY_N_ITERATIONS = 5;

export class PersistentAgentRunner {
  /** Active abort controllers for running persistent tasks (keyed by task ID). */
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly taskRepo: BackgroundTaskRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {}

  /** Find interrupted tasks from previous process and recover them. */
  async recoverInterrupted(): Promise<void> {
    try {
      const interrupted = this.taskRepo.getInterrupted();
      for (const task of interrupted) {
        if (task.agentState) {
          this.logger.info({ taskId: task.id, resumeCount: task.resumeCount }, 'Recovering interrupted persistent task');
          this.resume(task).catch(err => {
            this.logger.error({ err, taskId: task.id }, 'Failed to recover interrupted task');
          });
        } else {
          // No checkpoint data — mark as failed
          this.taskRepo.updateStatus(task.id, 'failed', undefined, 'Process restarted without checkpoint');
          this.logger.warn({ taskId: task.id }, 'Interrupted task without checkpoint marked as failed');
          this.notifyUser(task, '\u274C Hintergrund-Task abgebrochen (Prozess-Neustart ohne Checkpoint)');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to recover interrupted tasks');
    }
  }

  /** Run a task with periodic checkpointing. */
  async runPersistent(task: BackgroundTask): Promise<void> {
    this.taskRepo.updateStatus(task.id, 'running');
    const maxDurationMs = (task.maxDurationHours ?? 24) * 3600_000;

    // AbortController for cooperative pause/cancel — declared before try so catch can check it
    const abortController = new AbortController();
    this.activeAbortControllers.set(task.id, abortController);

    try {
      const skill = this.skillRegistry.get(task.skillName);
      if (!skill) {
        this.taskRepo.updateStatus(task.id, 'failed', undefined, `Unknown skill: ${task.skillName}`);
        return;
      }

      let input: Record<string, unknown>;
      try { input = JSON.parse(task.skillInput); }
      catch {
        this.taskRepo.updateStatus(task.id, 'failed', undefined, 'Malformed skill input JSON');
        return;
      }

      const { context } = buildSkillContext(this.users, {
        userId: task.userId,
        platform: task.platform as Platform,
        chatId: task.chatId,
        chatType: 'dm',
      });

      // Check max duration against original creation time (survives resume cycles)
      const elapsedMs = Date.now() - new Date(task.createdAt).getTime();
      if (elapsedMs > maxDurationMs) {
        this.taskRepo.updateStatus(task.id, 'failed', undefined, `Max duration of ${task.maxDurationHours}h exceeded`);
        this.notifyUser(task, `\u274C Persistenter Task "${task.description}" abgebrochen: maximale Laufzeit \u00fcberschritten.`);
        this.logLifecycle(task, 'expired');
        return;
      }

      // Restore checkpoint state if resuming
      let resumeState: { conversationHistory: unknown[]; currentIteration: number; totalIterations: number; dataStore?: Record<string, string> } | undefined;
      if (task.agentState) {
        try {
          const checkpoint: AgentCheckpoint = JSON.parse(task.agentState);
          if (checkpoint.conversationHistory?.length > 0) {
            resumeState = {
              conversationHistory: checkpoint.conversationHistory,
              currentIteration: checkpoint.currentIteration,
              totalIterations: checkpoint.totalIterations,
              dataStore: checkpoint.dataStore,
            };
            this.logger.info(
              { taskId: task.id, iteration: checkpoint.currentIteration, totalIterations: checkpoint.totalIterations },
              'Resuming persistent task from checkpoint',
            );
          }
        } catch (parseErr) {
          this.logger.warn({ taskId: task.id, err: parseErr }, 'Failed to parse checkpoint, starting fresh');
        }
      }

      // Inject onIteration callback for checkpoint support (used by DelegateSkill)
      let lastCheckpointIteration = resumeState?.currentIteration ?? 0;
      const execContext = {
        ...context,
        resumeState,
        abortSignal: abortController.signal,
        onIteration: (data: { iteration: number; maxIterations: number; messages: unknown[]; dataStore?: Record<string, string> }) => {
          // Checkpoint every N iterations, or force-write when aborting (pause)
          if (data.iteration - lastCheckpointIteration >= CHECKPOINT_EVERY_N_ITERATIONS || abortController.signal.aborted) {
            lastCheckpointIteration = data.iteration;
            const checkpoint: AgentCheckpoint = {
              conversationHistory: data.messages as AgentCheckpoint['conversationHistory'],
              partialResults: [],
              currentIteration: data.iteration,
              totalIterations: data.maxIterations,
              startedAt: task.startedAt ?? task.createdAt,
              lastActivityAt: new Date().toISOString(),
              dataStore: data.dataStore,
            };
            try {
              this.taskRepo.checkpoint(task.id, JSON.stringify(checkpoint));
              this.logLifecycle(task, 'checkpoint');
              this.logger.debug({ taskId: task.id, iteration: data.iteration }, 'Persistent task checkpointed');
            } catch (err) {
              this.logger.warn({ err, taskId: task.id }, 'Failed to write checkpoint');
            }
          }
        },
      };

      // Enforce remaining time as execution timeout
      const remainingMs = maxDurationMs - elapsedMs;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Max duration of ${task.maxDurationHours}h exceeded`)), remainingMs),
      );
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, execContext),
        timeoutPromise,
      ]);
      this.activeAbortControllers.delete(task.id);

      // If paused via abort, don't overwrite 'checkpointed' status
      if (abortController.signal.aborted) {
        this.logger.info({ taskId: task.id }, 'Persistent task paused via abort');
        this.notifyUser(task, `\u23F8\uFE0F Persistenter Task pausiert: ${task.description}`);
        return;
      }

      const resultJson = JSON.stringify(result.data ?? result.display ?? result.error);

      this.taskRepo.updateStatus(
        task.id,
        result.success ? 'completed' : 'failed',
        resultJson,
        result.error,
      );

      this.notifyUser(
        task,
        result.success
          ? `\u2705 Persistenter Task abgeschlossen: ${task.description}\n\nErgebnis: ${result.display ?? JSON.stringify(result.data)}`
          : `\u274C Persistenter Task fehlgeschlagen: ${task.description}\n\nFehler: ${result.error}`,
      );
    } catch (err) {
      this.activeAbortControllers.delete(task.id);
      const errorMsg = err instanceof Error ? err.message : String(err);

      // If aborted (paused), don't mark as failed — status is already 'checkpointed'
      if (abortController.signal.aborted) {
        this.logger.info({ taskId: task.id }, 'Persistent task paused via abort');
        this.notifyUser(task, `\u23F8\uFE0F Persistenter Task pausiert: ${task.description}`);
        return;
      }

      this.taskRepo.updateStatus(task.id, 'failed', undefined, errorMsg);
      this.logger.error({ taskId: task.id, err }, 'Persistent task failed');
      this.notifyUser(task, `\u274C Persistenter Task fehlgeschlagen: ${task.description}\n\nFehler: ${errorMsg}`);
    }
  }

  /** Resume a checkpointed task. */
  async resume(task: BackgroundTask): Promise<void> {
    this.taskRepo.markResuming(task.id);
    this.logLifecycle(task, 'resume');

    // Re-fetch from DB to get fresh state after markResuming
    const freshTask = this.taskRepo.getById(task.id);
    if (!freshTask) {
      this.logger.warn({ taskId: task.id }, 'Task disappeared during resume');
      return;
    }

    await this.runPersistent(freshTask);
  }

  /** Pause a running task: set status to checkpointed and abort execution. */
  async pause(taskId: string): Promise<void> {
    this.taskRepo.updateStatus(taskId, 'checkpointed');
    // Signal the running skill to stop cooperatively
    const controller = this.activeAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(taskId);
    }
    this.logLifecycle({ id: taskId, skillName: '', platform: '', chatId: '', userId: '' } as BackgroundTask, 'pause');
    this.logger.info({ taskId }, 'Persistent task paused');
  }

  /** Cancel a task permanently. */
  async cancel(taskId: string): Promise<void> {
    // Abort if still running
    const controller = this.activeAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(taskId);
    }
    this.taskRepo.cancelTask(taskId);
    this.logger.info({ taskId }, 'Persistent task cancelled');
  }

  private async notifyUser(task: BackgroundTask, message: string): Promise<void> {
    const adapter = this.adapters.get(task.platform as Platform);
    if (adapter) {
      try { await adapter.sendMessage(task.chatId, message); } catch { /* */ }
    }
  }

  private logLifecycle(task: BackgroundTask, event: string): void {
    this.activityLogger?.logAgentLifecycle({
      taskId: task.id,
      skillName: task.skillName,
      event,
      platform: task.platform,
      chatId: task.chatId,
      userId: task.userId,
    });
  }
}
