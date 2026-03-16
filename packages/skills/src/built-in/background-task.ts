import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { BackgroundTaskRepository } from '@alfred/storage';
import { effectiveUserId, allUserIds } from '../user-utils.js';

type BackgroundTaskAction = 'schedule' | 'list' | 'cancel' | 'pause' | 'resume';

interface PersistentRunnerInterface {
  pause(taskId: string): Promise<void>;
  resume(task: import('@alfred/types').BackgroundTask): Promise<void>;
  cancel(taskId: string): Promise<void>;
}

export class BackgroundTaskSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'background_task',
    category: 'automation',
    description:
      'Schedule, list, cancel, pause, or resume background tasks that run a SINGLE skill call asynchronously. ' +
      'Use "schedule" to queue ONE skill execution in the background (user will be notified when done). ' +
      'NOT for multi-step tasks — use "delegate" instead when a task needs multiple tool calls ' +
      '(e.g. search + read + process + generate). ' +
      'Use "list" to see active/recent tasks. Use "cancel" to stop a pending or running task. ' +
      'Use "pause" to checkpoint a persistent task and "resume" to continue it. ' +
      'Set persistent=true and max_duration_hours for long-running persistent tasks.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['schedule', 'list', 'cancel', 'pause', 'resume'],
          description: 'The background task action to perform',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what the task does (for schedule)',
        },
        skill_name: {
          type: 'string',
          description: 'The skill to run in the background (for schedule)',
        },
        skill_input: {
          type: 'object',
          description: 'Input to pass to the skill (for schedule)',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (for cancel, pause, resume)',
        },
        persistent: {
          type: 'boolean',
          description: 'If true, creates a persistent task with checkpoint/resume support (for schedule)',
        },
        max_duration_hours: {
          type: 'number',
          description: 'Maximum duration in hours for persistent tasks (default: 24)',
        },
      },
      required: ['action'],
    },
  };

  private persistentRunner?: PersistentRunnerInterface;

  constructor(private readonly taskRepo: BackgroundTaskRepository) {
    super();
  }

  setPersistentRunner(runner: PersistentRunnerInterface): void {
    this.persistentRunner = runner;
  }

  /** Get tasks for all linked user IDs. */
  private async getAllTasks(context: SkillContext): Promise<import('@alfred/types').BackgroundTask[]> {
    const seen = new Set<string>();
    const results: import('@alfred/types').BackgroundTask[] = [];
    for (const uid of allUserIds(context)) {
      for (const t of await this.taskRepo.getByUser(uid)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          results.push(t);
        }
      }
    }
    return results;
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as BackgroundTaskAction;

    switch (action) {
      case 'schedule':
        return this.scheduleTask(input, context);
      case 'list':
        return this.listTasks(context);
      case 'cancel':
        return this.cancelTask(input, context);
      case 'pause':
        return this.pauseTask(input, context);
      case 'resume':
        return this.resumeTask(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: schedule, list, cancel`,
        };
    }
  }

  private async scheduleTask(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const description = input.description as string | undefined;
    const skillName = input.skill_name as string | undefined;
    const skillInput = input.skill_input as Record<string, unknown> | undefined;
    const persistent = input.persistent as boolean | undefined;
    const maxDurationHours = input.max_duration_hours as number | undefined;

    if (!description || typeof description !== 'string') {
      return { success: false, error: 'Missing required field "description" for schedule action' };
    }
    if (!skillName || typeof skillName !== 'string') {
      return { success: false, error: 'Missing required field "skill_name" for schedule action' };
    }

    const task = await this.taskRepo.create(
      effectiveUserId(context),
      context.platform,
      context.chatId,
      description,
      skillName,
      JSON.stringify(skillInput ?? {}),
    );

    // Set persistent config if requested
    if (persistent && maxDurationHours) {
      await this.taskRepo.updatePersistentConfig(task.id, maxDurationHours);
      task.maxDurationHours = maxDurationHours;
    } else if (persistent) {
      await this.taskRepo.updatePersistentConfig(task.id, 24);
      task.maxDurationHours = 24;
    }

    const persistLabel = persistent ? ' (persistent)' : '';
    return {
      success: true,
      data: { taskId: task.id, description, skillName, status: task.status, persistent: !!persistent },
      display: `Background task scheduled${persistLabel} (${task.id}): "${description}" using skill "${skillName}". You'll be notified when it completes.`,
    };
  }

  private async listTasks(context: SkillContext): Promise<SkillResult> {
    const tasks = await this.getAllTasks(context);

    if (tasks.length === 0) {
      return {
        success: true,
        data: [],
        display: 'No active or recent background tasks.',
      };
    }

    const statusIcon: Record<string, string> = {
      pending: '\u23F3',
      running: '\u25B6\uFE0F',
      completed: '\u2705',
      failed: '\u274C',
      checkpointed: '\u23F8\uFE0F',
      resuming: '\u21BB',
      cancelled: '\u23F9',
    };

    const lines = tasks.map(
      (t) => `- ${statusIcon[t.status] ?? '?'} ${t.id}: "${t.description}" [${t.status}] (${t.skillName})`,
    );

    return {
      success: true,
      data: tasks.map((t) => ({
        taskId: t.id,
        description: t.description,
        status: t.status,
        skillName: t.skillName,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
      display: `Background tasks:\n${lines.join('\n')}`,
    };
  }

  private async cancelTask(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;

    if (!taskId || typeof taskId !== 'string') {
      return { success: false, error: 'Missing required field "task_id" for cancel action' };
    }

    // Verify ownership: only allow canceling own tasks
    const userTasks = await this.getAllTasks(context);
    const task = userTasks.find(t => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: `Task "${taskId}" not found or already completed`,
      };
    }

    // Use persistent runner for persistent tasks, regular cancel for normal tasks
    if (task.maxDurationHours && this.persistentRunner) {
      await this.persistentRunner.cancel(taskId);
    } else {
      const cancelled = await this.taskRepo.cancel(taskId);
      if (!cancelled) {
        // Try cancelTask (UPDATE) as fallback for checkpointed/resuming tasks
        await this.taskRepo.cancelTask(taskId);
      }
    }

    return {
      success: true,
      data: { taskId },
      display: `Background task "${taskId}" cancelled.`,
    };
  }

  private async pauseTask(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;

    if (!taskId || typeof taskId !== 'string') {
      return { success: false, error: 'Missing required field "task_id" for pause action' };
    }

    if (!this.persistentRunner) {
      return { success: false, error: 'Persistent agent runner is not available' };
    }

    // Verify ownership
    const userTasks = await this.getAllTasks(context);
    const task = userTasks.find(t => t.id === taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found` };
    }
    if (task.status !== 'running' && task.status !== 'resuming') {
      return { success: false, error: `Task "${taskId}" is not running (status: ${task.status})` };
    }

    await this.persistentRunner.pause(taskId);
    return {
      success: true,
      data: { taskId },
      display: `Persistent task "${taskId}" paused. Use resume to continue.`,
    };
  }

  private async resumeTask(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;

    if (!taskId || typeof taskId !== 'string') {
      return { success: false, error: 'Missing required field "task_id" for resume action' };
    }

    if (!this.persistentRunner) {
      return { success: false, error: 'Persistent agent runner is not available' };
    }

    // Verify ownership
    const userTasks = await this.getAllTasks(context);
    const task = userTasks.find(t => t.id === taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found` };
    }
    if (task.status !== 'checkpointed') {
      return { success: false, error: `Task "${taskId}" is not checkpointed (status: ${task.status})` };
    }

    // Fire-and-forget: resume runs asynchronously, errors handled by runner
    this.persistentRunner.resume(task).catch(() => { /* logged by PersistentAgentRunner */ });
    return {
      success: true,
      data: { taskId },
      display: `Persistent task "${taskId}" resuming. You'll be notified when it completes.`,
    };
  }
}
