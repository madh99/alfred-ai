import { CalendarProvider } from './calendar-provider.js';
import type { CalendarEvent, CreateEventInput } from './calendar-provider.js';
import type { GoogleCalendarConfig } from '@alfred/types';

export class GoogleCalendarProvider extends CalendarProvider {
  private calendar: any;

  constructor(private readonly config: GoogleCalendarConfig) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      // @ts-expect-error googleapis is an optional dependency, installed in the CLI package
      const { google } = await import('googleapis');
      const auth = new google.auth.OAuth2(
        this.config.clientId,
        this.config.clientSecret,
      );
      auth.setCredentials({ refresh_token: this.config.refreshToken });
      this.calendar = google.calendar({ version: 'v3', auth });
    } catch (err) {
      throw new Error(`Google Calendar initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const response = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (response.data.items ?? []).map((item: any) => this.mapEvent(item));
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const event: Record<string, unknown> = {
      summary: input.title,
      location: input.location,
      description: input.description,
    };

    if (input.allDay) {
      event.start = { date: input.start.toISOString().slice(0, 10) };
      event.end = { date: input.end.toISOString().slice(0, 10) };
    } else {
      event.start = { dateTime: input.start.toISOString() };
      event.end = { dateTime: input.end.toISOString() };
    }

    const response = await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    return this.mapEvent(response.data);
  }

  async updateEvent(id: string, input: Partial<CreateEventInput>): Promise<CalendarEvent> {
    const patch: Record<string, unknown> = {};
    if (input.title) patch.summary = input.title;
    if (input.location) patch.location = input.location;
    if (input.description) patch.description = input.description;
    if (input.start) {
      patch.start = input.allDay
        ? { date: input.start.toISOString().slice(0, 10) }
        : { dateTime: input.start.toISOString() };
    }
    if (input.end) {
      patch.end = input.allDay
        ? { date: input.end.toISOString().slice(0, 10) }
        : { dateTime: input.end.toISOString() };
    }

    const response = await this.calendar.events.patch({
      calendarId: 'primary',
      eventId: id,
      requestBody: patch,
    });

    return this.mapEvent(response.data);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId: 'primary',
      eventId: id,
    });
  }

  async checkAvailability(start: Date, end: Date): Promise<{ available: boolean; conflicts: CalendarEvent[] }> {
    const events = await this.listEvents(start, end);
    const conflicts = events.filter(e => !e.allDay && e.start < end && e.end > start);
    return { available: conflicts.length === 0, conflicts };
  }

  private mapEvent(item: any): CalendarEvent {
    const allDay = !!item.start?.date;
    return {
      id: item.id,
      title: item.summary ?? '(No title)',
      start: new Date(item.start?.dateTime ?? item.start?.date),
      end: new Date(item.end?.dateTime ?? item.end?.date),
      location: item.location ?? undefined,
      description: item.description ?? undefined,
      allDay,
    };
  }
}
