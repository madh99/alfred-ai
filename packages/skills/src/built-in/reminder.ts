import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { ReminderRepository } from '@alfred/storage';

type ReminderAction = 'set' | 'list' | 'cancel';

export class ReminderSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'reminder',
    description: 'Set, list, or cancel reminders',
    riskLevel: 'write',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'list', 'cancel'],
          description: 'The reminder action to perform',
        },
        message: {
          type: 'string',
          description: 'The reminder message (required for set)',
        },
        delayMinutes: {
          type: 'number',
          description: 'Minutes until the reminder triggers (required for set)',
        },
        reminderId: {
          type: 'string',
          description: 'The ID of the reminder to cancel (required for cancel)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly reminderRepo: ReminderRepository) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as ReminderAction;

    switch (action) {
      case 'set':
        return this.setReminder(input, context);
      case 'list':
        return this.listReminders(context);
      case 'cancel':
        return this.cancelReminder(input);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: set, list, cancel`,
        };
    }
  }

  private setReminder(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const message = input.message as string | undefined;
    const delayMinutes = input.delayMinutes as number | undefined;

    if (!message || typeof message !== 'string') {
      return {
        success: false,
        error: 'Missing required field "message" for set action',
      };
    }

    if (delayMinutes === undefined || typeof delayMinutes !== 'number' || delayMinutes <= 0) {
      return {
        success: false,
        error: 'Missing or invalid "delayMinutes" for set action (must be a positive number)',
      };
    }

    const triggerAt = new Date(Date.now() + delayMinutes * 60 * 1000);

    const entry = this.reminderRepo.create(
      context.userId,
      context.platform,
      context.chatId,
      message,
      triggerAt,
    );

    return {
      success: true,
      data: { reminderId: entry.id, message, triggerAt: entry.triggerAt },
      display: `Reminder set (${entry.id}): "${message}" in ${delayMinutes} minute(s)`,
    };
  }

  private listReminders(context: SkillContext): SkillResult {
    const reminders = this.reminderRepo.getByUser(context.userId);

    const reminderList = reminders.map((r) => ({
      reminderId: r.id,
      message: r.message,
      triggerAt: r.triggerAt,
    }));

    return {
      success: true,
      data: reminderList,
      display:
        reminderList.length === 0
          ? 'No active reminders.'
          : `Active reminders:\n${reminderList.map((r) => `- ${r.reminderId}: "${r.message}" (triggers at ${r.triggerAt})`).join('\n')}`,
    };
  }

  private cancelReminder(input: Record<string, unknown>): SkillResult {
    const reminderId = input.reminderId as string | undefined;

    if (!reminderId || typeof reminderId !== 'string') {
      return {
        success: false,
        error: 'Missing required field "reminderId" for cancel action',
      };
    }

    const deleted = this.reminderRepo.cancel(reminderId);

    if (!deleted) {
      return {
        success: false,
        error: `Reminder "${reminderId}" not found`,
      };
    }

    return {
      success: true,
      data: { reminderId },
      display: `Reminder "${reminderId}" cancelled.`,
    };
  }
}
