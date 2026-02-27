import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { BackgroundTaskRepository } from '@alfred/storage';

type BackgroundTaskAction = 'schedule' | 'list' | 'cancel';

export class BackgroundTaskSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'background_task',
    description:
      'Schedule, list, or cancel background tasks that run independently. ' +
      'Use "schedule" to queue a skill to execute in the background (user will be notified when done). ' +
      'Use "list" to see active/recent tasks. Use "cancel" to stop a pending or running task.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['schedule', 'list', 'cancel'],
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
          description: 'Task ID (for cancel)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly taskRepo: BackgroundTaskRepository) {
    super();
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
        return this.cancelTask(input);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: schedule, list, cancel`,
        };
    }
  }

  private scheduleTask(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const description = input.description as string | undefined;
    const skillName = input.skill_name as string | undefined;
    const skillInput = input.skill_input as Record<string, unknown> | undefined;

    if (!description || typeof description !== 'string') {
      return { success: false, error: 'Missing required field "description" for schedule action' };
    }
    if (!skillName || typeof skillName !== 'string') {
      return { success: false, error: 'Missing required field "skill_name" for schedule action' };
    }

    const task = this.taskRepo.create(
      context.userId,
      context.platform,
      context.chatId,
      description,
      skillName,
      JSON.stringify(skillInput ?? {}),
    );

    return {
      success: true,
      data: { taskId: task.id, description, skillName, status: task.status },
      display: `Background task scheduled (${task.id}): "${description}" using skill "${skillName}". You'll be notified when it completes.`,
    };
  }

  private listTasks(context: SkillContext): SkillResult {
    const tasks = this.taskRepo.getByUser(context.userId);

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

  private cancelTask(input: Record<string, unknown>): SkillResult {
    const taskId = input.task_id as string | undefined;

    if (!taskId || typeof taskId !== 'string') {
      return { success: false, error: 'Missing required field "task_id" for cancel action' };
    }

    const cancelled = this.taskRepo.cancel(taskId);

    if (!cancelled) {
      return {
        success: false,
        error: `Task "${taskId}" not found or already completed`,
      };
    }

    return {
      success: true,
      data: { taskId },
      display: `Background task "${taskId}" cancelled.`,
    };
  }
}
