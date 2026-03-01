import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { ReminderRepository } from '@alfred/storage';

type ReminderAction = 'set' | 'list' | 'cancel';

export class ReminderSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'reminder',
    description:
      'Set timed reminders that notify the user later. Use when the user says "remind me", "erinnere mich", or asks to be notified about something at a specific time. ' +
      'Prefer triggerAt (absolute time like "14:30" or "2026-02-28 09:00") over delayMinutes — it is more precise and avoids calculation errors.',
    riskLevel: 'write',
    version: '3.0.0',
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
        triggerAt: {
          type: 'string',
          description:
            'Absolute time for the reminder. Accepts "HH:MM" for today or "YYYY-MM-DD HH:MM" for a specific date. ' +
            'Preferred over delayMinutes for time-specific reminders.',
        },
        delayMinutes: {
          type: 'number',
          description: 'Minutes until the reminder triggers. Use triggerAt instead when the user specifies a clock time.',
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

  private effectiveUserId(context: SkillContext): string {
    return context.masterUserId ?? context.userId;
  }

  /** Get all user IDs to query (masterUserId + platform userId) for backward compat. */
  private allUserIds(context: SkillContext): string[] {
    const ids = [this.effectiveUserId(context)];
    if (context.masterUserId && context.masterUserId !== context.userId) {
      ids.push(context.userId);
    }
    return ids;
  }

  /** Get reminders for all linked user IDs (handles old data stored under platform ID). */
  private getAllReminders(context: SkillContext): import('@alfred/storage').ReminderEntry[] {
    const seen = new Set<string>();
    const results: import('@alfred/storage').ReminderEntry[] = [];
    for (const uid of this.allUserIds(context)) {
      for (const r of this.reminderRepo.getByUser(uid)) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          results.push(r);
        }
      }
    }
    return results;
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
        return this.cancelReminder(input, context);
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
    const triggerAtStr = input.triggerAt as string | undefined;
    const delayMinutes = input.delayMinutes as number | undefined;

    if (!message || typeof message !== 'string') {
      return {
        success: false,
        error: 'Missing required field "message" for set action',
      };
    }

    let triggerAt: Date;

    if (triggerAtStr && typeof triggerAtStr === 'string') {
      // Parse absolute time
      const parsed = this.parseTriggerAt(triggerAtStr, context.timezone);
      if (!parsed) {
        return {
          success: false,
          error: `Could not parse triggerAt "${triggerAtStr}". Use "HH:MM" for today or "YYYY-MM-DD HH:MM" for a specific date.`,
        };
      }
      if (parsed.getTime() <= Date.now()) {
        return {
          success: false,
          error: `The time "${triggerAtStr}" is in the past. Please specify a future time.`,
        };
      }
      triggerAt = parsed;
    } else if (delayMinutes !== undefined && typeof delayMinutes === 'number' && delayMinutes > 0) {
      // Relative delay
      triggerAt = new Date(Date.now() + delayMinutes * 60 * 1000);
    } else {
      return {
        success: false,
        error: 'Provide either "triggerAt" (e.g. "14:30") or "delayMinutes" (positive number) for set action.',
      };
    }

    const entry = this.reminderRepo.create(
      this.effectiveUserId(context),
      context.platform,
      context.chatId,
      message,
      triggerAt,
    );

    const delayMs = triggerAt.getTime() - Date.now();
    const mins = Math.round(delayMs / 60_000);
    const timeLabel = triggerAt.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(context.timezone ? { timeZone: context.timezone } : {}),
    });

    return {
      success: true,
      data: { reminderId: entry.id, message, triggerAt: entry.triggerAt },
      display: `Reminder set (${entry.id}): "${message}" at ${timeLabel} (in ${mins} min)`,
    };
  }

  /**
   * Parse a trigger time string into a Date.
   *
   * Supported formats:
   * - "HH:MM"            → today at that time in the given timezone
   * - "YYYY-MM-DD HH:MM" → specific date+time
   */
  private parseTriggerAt(str: string, timezone?: string): Date | undefined {
    const trimmed = str.trim();

    // "HH:MM" — today at that time
    const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (timeOnly) {
      const hours = parseInt(timeOnly[1], 10);
      const minutes = parseInt(timeOnly[2], 10);
      if (hours > 23 || minutes > 59) return undefined;
      return this.buildDateInTimezone(hours, minutes, undefined, timezone);
    }

    // "YYYY-MM-DD HH:MM"
    const dateTime = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (dateTime) {
      const year = parseInt(dateTime[1], 10);
      const month = parseInt(dateTime[2], 10) - 1;
      const day = parseInt(dateTime[3], 10);
      const hours = parseInt(dateTime[4], 10);
      const minutes = parseInt(dateTime[5], 10);
      if (hours > 23 || minutes > 59 || month > 11 || day > 31) return undefined;
      return this.buildDateInTimezone(hours, minutes, { year, month, day }, timezone);
    }

    return undefined;
  }

  /**
   * Build a Date object for a given time in the user's timezone.
   * Uses iterative offset correction to handle DST edge cases.
   */
  private buildDateInTimezone(
    hours: number,
    minutes: number,
    date?: { year: number; month: number; day: number },
    timezone?: string,
  ): Date {
    // If no timezone, just use local server time
    if (!timezone) {
      const d = date
        ? new Date(date.year, date.month, date.day, hours, minutes, 0, 0)
        : new Date();
      if (!date) {
        d.setHours(hours, minutes, 0, 0);
      }
      return d;
    }

    // Build a rough Date in UTC, then adjust for the timezone offset.
    // We use the Intl API to figure out what time it is in that timezone.
    const now = new Date();
    const refDate = date
      ? new Date(Date.UTC(date.year, date.month, date.day, hours, minutes, 0))
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0));

    // Get the timezone offset by comparing formatted time to UTC
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // Format "now" in the target timezone to get today's date there
    if (!date) {
      const parts = formatter.formatToParts(now);
      const tzYear = parseInt(parts.find(p => p.type === 'year')!.value, 10);
      const tzMonth = parseInt(parts.find(p => p.type === 'month')!.value, 10) - 1;
      const tzDay = parseInt(parts.find(p => p.type === 'day')!.value, 10);

      // Build target: "today in that timezone at HH:MM"
      // Start with a guess and iterate
      let guess = new Date(Date.UTC(tzYear, tzMonth, tzDay, hours, minutes, 0));

      // Check what time our guess is in the target timezone
      const guessParts = formatter.formatToParts(guess);
      const guessHour = parseInt(guessParts.find(p => p.type === 'hour')!.value, 10);
      const guessMinute = parseInt(guessParts.find(p => p.type === 'minute')!.value, 10);

      // Adjust by the difference
      const diffMinutes = (hours - guessHour) * 60 + (minutes - guessMinute);
      guess = new Date(guess.getTime() + diffMinutes * 60_000);
      return guess;
    }

    // Specific date provided — same approach
    let guess = refDate;
    const guessParts = formatter.formatToParts(guess);
    const guessHour = parseInt(guessParts.find(p => p.type === 'hour')!.value, 10);
    const guessMinute = parseInt(guessParts.find(p => p.type === 'minute')!.value, 10);
    const diffMinutes = (hours - guessHour) * 60 + (minutes - guessMinute);
    guess = new Date(guess.getTime() + diffMinutes * 60_000);
    return guess;
  }

  private listReminders(context: SkillContext): SkillResult {
    const reminders = this.getAllReminders(context);

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

  private cancelReminder(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const reminderId = input.reminderId as string | undefined;

    if (!reminderId || typeof reminderId !== 'string') {
      return {
        success: false,
        error: 'Missing required field "reminderId" for cancel action',
      };
    }

    // Verify ownership: only allow canceling own reminders
    const userReminders = this.getAllReminders(context);
    const ownsReminder = userReminders.some(r => r.id === reminderId);
    if (!ownsReminder) {
      return {
        success: false,
        error: `Reminder "${reminderId}" not found`,
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
