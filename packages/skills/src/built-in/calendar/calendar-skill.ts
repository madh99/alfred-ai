import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { CalendarProvider, CalendarEvent } from './calendar-provider.js';

type CalendarAction = 'list_events' | 'create_event' | 'update_event' | 'delete_event' | 'check_availability';

export class CalendarSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'calendar',
    category: 'productivity',
    description:
      'Manage calendar events. List upcoming events, create new events, update or delete existing ones, and check availability.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_events', 'create_event', 'update_event', 'delete_event', 'check_availability'],
          description: 'The calendar action to perform',
        },
        start: {
          type: 'string',
          description: 'Start date/time in ISO 8601 format',
        },
        end: {
          type: 'string',
          description: 'End date/time in ISO 8601 format',
        },
        title: {
          type: 'string',
          description: 'Event title (for create/update)',
        },
        location: {
          type: 'string',
          description: 'Event location (for create/update)',
        },
        description: {
          type: 'string',
          description: 'Event description (for create/update)',
        },
        event_id: {
          type: 'string',
          description: 'Event ID (for update/delete)',
        },
        all_day: {
          type: 'boolean',
          description: 'Whether this is an all-day event',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly calendarProvider: CalendarProvider,
    private readonly timezone?: string,
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as CalendarAction;

    switch (action) {
      case 'list_events':
        return this.listEvents(input);
      case 'create_event':
        return this.createEvent(input);
      case 'update_event':
        return this.updateEvent(input);
      case 'delete_event':
        return this.deleteEvent(input);
      case 'check_availability':
        return this.checkAvailability(input);
      default:
        return { success: false, error: `Unknown action: "${String(action)}"` };
    }
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    try {
      return await this.calendarProvider.listEvents(startOfDay, endOfDay);
    } catch (err) {
      console.error('[calendar] Failed to fetch today events', err);
      return [];
    }
  }

  private async listEvents(input: Record<string, unknown>): Promise<SkillResult> {
    const start = input.start ? new Date(input.start as string) : new Date();
    const end = input.end
      ? new Date(input.end as string)
      : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000); // Default: 7 days

    try {
      const events = await this.calendarProvider.listEvents(start, end);

      if (events.length === 0) {
        return { success: true, data: [], display: 'No events found in this time range.' };
      }

      const display = events
        .map(e => this.formatEvent(e))
        .join('\n');

      return { success: true, data: events, display: `${events.length} event(s):\n${display}` };
    } catch (err) {
      return { success: false, error: `Failed to list events: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async createEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    const start = input.start as string;
    const end = input.end as string;

    if (!title) return { success: false, error: 'Missing required field "title"' };
    if (!start) return { success: false, error: 'Missing required field "start"' };
    if (!end) return { success: false, error: 'Missing required field "end"' };

    try {
      const event = await this.calendarProvider.createEvent({
        title,
        start: new Date(start),
        end: new Date(end),
        location: input.location as string | undefined,
        description: input.description as string | undefined,
        allDay: input.all_day as boolean | undefined,
      });

      return {
        success: true,
        data: event,
        display: `Event created: ${this.formatEvent(event)}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to create event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async updateEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const eventId = input.event_id as string;
    if (!eventId) return { success: false, error: 'Missing required field "event_id"' };

    try {
      const event = await this.calendarProvider.updateEvent(eventId, {
        title: input.title as string | undefined,
        start: input.start ? new Date(input.start as string) : undefined,
        end: input.end ? new Date(input.end as string) : undefined,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
        allDay: input.all_day as boolean | undefined,
      });

      return {
        success: true,
        data: event,
        display: `Event updated: ${this.formatEvent(event)}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to update event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async deleteEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const eventId = input.event_id as string;
    if (!eventId) return { success: false, error: 'Missing required field "event_id"' };

    try {
      await this.calendarProvider.deleteEvent(eventId);
      return { success: true, data: { deleted: eventId }, display: `Event "${eventId}" deleted.` };
    } catch (err) {
      return { success: false, error: `Failed to delete event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async checkAvailability(input: Record<string, unknown>): Promise<SkillResult> {
    const start = input.start as string;
    const end = input.end as string;
    if (!start || !end) return { success: false, error: 'Missing required fields "start" and "end"' };

    try {
      const result = await this.calendarProvider.checkAvailability(new Date(start), new Date(end));
      const display = result.available
        ? 'Time slot is available.'
        : `Time slot has ${result.conflicts.length} conflict(s):\n${result.conflicts.map(e => this.formatEvent(e)).join('\n')}`;

      return { success: true, data: result, display };
    } catch (err) {
      return { success: false, error: `Failed to check availability: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private formatEvent(event: CalendarEvent): string {
    const opts: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      ...(this.timezone ? { timeZone: this.timezone } : {}),
    };

    const loc = event.location ? ` @ ${event.location}` : '';
    const idTag = event.id ? ` [id:${event.id}]` : '';

    if (event.allDay) {
      return `- All day: ${event.title}${loc}${idTag}`;
    }

    const startTime = event.start.toLocaleTimeString('en-GB', opts);
    const endTime = event.end.toLocaleTimeString('en-GB', opts);
    return `- ${startTime}-${endTime}: ${event.title}${loc}${idTag}`;
  }
}
