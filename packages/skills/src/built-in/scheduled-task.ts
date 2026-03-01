import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { ScheduledActionRepository } from '@alfred/storage';

type ScheduledTaskAction = 'create' | 'list' | 'enable' | 'disable' | 'delete';

export class ScheduledTaskSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'scheduled_task',
    description:
      'Create, list, enable, disable, or delete scheduled actions that run automatically on a recurring basis. ' +
      'Supports cron expressions (e.g. "0 9 * * *" for daily at 9 AM), intervals (in minutes), and one-time schedules. ' +
      'Each scheduled action executes a skill or sends a prompt to the LLM at the configured time.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'enable', 'disable', 'delete'],
          description: 'The scheduled task action to perform',
        },
        name: {
          type: 'string',
          description: 'Name for the scheduled action (for create)',
        },
        description: {
          type: 'string',
          description: 'What the scheduled action does (for create)',
        },
        schedule_type: {
          type: 'string',
          enum: ['cron', 'interval', 'once'],
          description: 'Type of schedule: cron expression, interval in minutes, or one-time ISO date (for create)',
        },
        schedule_value: {
          type: 'string',
          description: 'Schedule value: cron expression, minutes as string, or ISO date (for create)',
        },
        skill_name: {
          type: 'string',
          description: 'The skill to execute on schedule (for create)',
        },
        skill_input: {
          type: 'object',
          description: 'Input to pass to the skill (for create)',
        },
        prompt_template: {
          type: 'string',
          description: 'Optional LLM prompt to run instead of a skill (for create)',
        },
        action_id: {
          type: 'string',
          description: 'Scheduled action ID (for enable, disable, delete)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly actionRepo: ScheduledActionRepository) {
    super();
  }

  private effectiveUserId(context: SkillContext): string {
    return context.masterUserId ?? context.userId;
  }

  /** All user IDs to query (masterUserId + platform userId) for backward compat. */
  private allUserIds(context: SkillContext): string[] {
    const ids = [this.effectiveUserId(context)];
    if (context.masterUserId && context.masterUserId !== context.userId) {
      ids.push(context.userId);
    }
    return ids;
  }

  /** Get scheduled actions for all linked user IDs. */
  private getAllActions(context: SkillContext): import('@alfred/types').ScheduledAction[] {
    const seen = new Set<string>();
    const results: import('@alfred/types').ScheduledAction[] = [];
    for (const uid of this.allUserIds(context)) {
      for (const a of this.actionRepo.getByUser(uid)) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          results.push(a);
        }
      }
    }
    return results;
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as ScheduledTaskAction;

    switch (action) {
      case 'create':
        return this.createAction(input, context);
      case 'list':
        return this.listActions(context);
      case 'enable':
        return this.toggleAction(input, true, context);
      case 'disable':
        return this.toggleAction(input, false, context);
      case 'delete':
        return this.deleteAction(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: create, list, enable, disable, delete`,
        };
    }
  }

  private createAction(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const name = input.name as string | undefined;
    const description = input.description as string | undefined;
    const scheduleType = input.schedule_type as string | undefined;
    const scheduleValue = input.schedule_value as string | undefined;
    const skillName = input.skill_name as string | undefined;
    const skillInput = input.skill_input as Record<string, unknown> | undefined;
    const promptTemplate = input.prompt_template as string | undefined;

    if (!name || typeof name !== 'string') {
      return { success: false, error: 'Missing required field "name" for create action' };
    }
    if (!description || typeof description !== 'string') {
      return { success: false, error: 'Missing required field "description" for create action' };
    }
    if (!scheduleType || !['cron', 'interval', 'once'].includes(scheduleType)) {
      return { success: false, error: 'Missing or invalid "schedule_type". Must be "cron", "interval", or "once"' };
    }
    if (!scheduleValue || typeof scheduleValue !== 'string') {
      return { success: false, error: 'Missing required field "schedule_value" for create action' };
    }
    if (!skillName || typeof skillName !== 'string') {
      return { success: false, error: 'Missing required field "skill_name" for create action' };
    }

    // Validate schedule_value based on type
    if (scheduleType === 'interval') {
      const minutes = parseInt(scheduleValue, 10);
      if (isNaN(minutes) || minutes <= 0) {
        return { success: false, error: 'For interval schedule, value must be a positive number of minutes' };
      }
    }
    if (scheduleType === 'cron') {
      const parts = scheduleValue.trim().split(/\s+/);
      if (parts.length !== 5) {
        return { success: false, error: 'Cron expression must have 5 fields: minute hour dayOfMonth month dayOfWeek' };
      }
    }
    if (scheduleType === 'once') {
      const date = new Date(scheduleValue);
      if (isNaN(date.getTime())) {
        return { success: false, error: 'For once schedule, value must be a valid ISO date string' };
      }
      if (date.getTime() <= Date.now()) {
        return { success: false, error: 'The scheduled time is in the past. Please specify a future time.' };
      }
    }

    const entry = this.actionRepo.create({
      userId: this.effectiveUserId(context),
      platform: context.platform,
      chatId: context.chatId,
      name,
      description,
      scheduleType: scheduleType as 'cron' | 'interval' | 'once',
      scheduleValue,
      skillName,
      skillInput: JSON.stringify(skillInput ?? {}),
      promptTemplate,
    });

    const scheduleLabel = scheduleType === 'cron'
      ? `cron: ${scheduleValue}`
      : scheduleType === 'interval'
        ? `every ${scheduleValue} minutes`
        : `once at ${scheduleValue}`;

    return {
      success: true,
      data: { actionId: entry.id, name, scheduleType, scheduleValue, skillName },
      display: `Scheduled action created (${entry.id}): "${name}" — ${scheduleLabel}, running "${skillName}"${entry.nextRunAt ? `. Next run: ${entry.nextRunAt}` : ''}`,
    };
  }

  private listActions(context: SkillContext): SkillResult {
    const actions = this.getAllActions(context);

    if (actions.length === 0) {
      return {
        success: true,
        data: [],
        display: 'No scheduled actions.',
      };
    }

    const lines = actions.map((a) => {
      const status = a.enabled ? '\u2705' : '\u23F8\uFE0F';
      const scheduleLabel = a.scheduleType === 'cron'
        ? `cron: ${a.scheduleValue}`
        : a.scheduleType === 'interval'
          ? `every ${a.scheduleValue} min`
          : `once: ${a.scheduleValue}`;
      const nextRun = a.nextRunAt ? ` | next: ${a.nextRunAt}` : '';
      return `- ${status} ${a.id}: "${a.name}" [${scheduleLabel}] → ${a.skillName}${nextRun}`;
    });

    return {
      success: true,
      data: actions.map((a) => ({
        actionId: a.id,
        name: a.name,
        scheduleType: a.scheduleType,
        scheduleValue: a.scheduleValue,
        skillName: a.skillName,
        enabled: a.enabled,
        nextRunAt: a.nextRunAt,
        lastRunAt: a.lastRunAt,
      })),
      display: `Scheduled actions:\n${lines.join('\n')}`,
    };
  }

  private toggleAction(input: Record<string, unknown>, enabled: boolean, context: SkillContext): SkillResult {
    const actionId = input.action_id as string | undefined;

    if (!actionId || typeof actionId !== 'string') {
      return { success: false, error: `Missing required field "action_id" for ${enabled ? 'enable' : 'disable'} action` };
    }

    // Verify ownership before toggling
    const action = this.actionRepo.findById(actionId);
    const userIds = this.allUserIds(context);
    if (!action || !userIds.includes(action.userId)) {
      return { success: false, error: `Scheduled action "${actionId}" not found` };
    }

    const updated = this.actionRepo.setEnabled(actionId, enabled);

    if (!updated) {
      return { success: false, error: `Scheduled action "${actionId}" not found` };
    }

    return {
      success: true,
      data: { actionId, enabled },
      display: `Scheduled action "${actionId}" ${enabled ? 'enabled' : 'disabled'}.`,
    };
  }

  private deleteAction(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const actionId = input.action_id as string | undefined;

    if (!actionId || typeof actionId !== 'string') {
      return { success: false, error: 'Missing required field "action_id" for delete action' };
    }

    // Verify ownership before deleting
    const action = this.actionRepo.findById(actionId);
    const deleteUserIds = this.allUserIds(context);
    if (!action || !deleteUserIds.includes(action.userId)) {
      return { success: false, error: `Scheduled action "${actionId}" not found` };
    }

    const deleted = this.actionRepo.delete(actionId);

    if (!deleted) {
      return { success: false, error: `Scheduled action "${actionId}" not found` };
    }

    return {
      success: true,
      data: { actionId },
      display: `Scheduled action "${actionId}" deleted.`,
    };
  }
}
