import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { randomUUID } from 'node:crypto';
import { Skill } from '../skill.js';

interface ReminderEntry {
  userId: string;
  message: string;
  triggerAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

type ReminderAction = 'set' | 'list' | 'cancel';

export class ReminderSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'reminder',
    description: 'Set, list, or cancel reminders',
    riskLevel: 'write',
    version: '1.0.0',
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

  private readonly reminders: Map<string, ReminderEntry> = new Map();

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

    const reminderId = randomUUID();
    const triggerAt = Date.now() + delayMinutes * 60 * 1000;

    const timeout = setTimeout(() => {
      this.reminders.delete(reminderId);
    }, delayMinutes * 60 * 1000);

    this.reminders.set(reminderId, {
      userId: context.userId,
      message,
      triggerAt,
      timeout,
    });

    return {
      success: true,
      data: { reminderId, message, triggerAt },
      display: `Reminder set (${reminderId}): "${message}" in ${delayMinutes} minute(s)`,
    };
  }

  private listReminders(context: SkillContext): SkillResult {
    const userReminders: Array<{ reminderId: string; message: string; triggerAt: number }> = [];

    for (const [reminderId, entry] of this.reminders) {
      if (entry.userId === context.userId) {
        userReminders.push({
          reminderId,
          message: entry.message,
          triggerAt: entry.triggerAt,
        });
      }
    }

    return {
      success: true,
      data: userReminders,
      display:
        userReminders.length === 0
          ? 'No active reminders.'
          : `Active reminders:\n${userReminders.map((r) => `- ${r.reminderId}: "${r.message}" (triggers at ${new Date(r.triggerAt).toISOString()})`).join('\n')}`,
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

    const entry = this.reminders.get(reminderId);

    if (!entry) {
      return {
        success: false,
        error: `Reminder "${reminderId}" not found`,
      };
    }

    clearTimeout(entry.timeout);
    this.reminders.delete(reminderId);

    return {
      success: true,
      data: { reminderId },
      display: `Reminder "${reminderId}" cancelled.`,
    };
  }
}
