import { CalendarProvider } from './calendar-provider.js';
import type { CalendarEvent, CreateEventInput } from './calendar-provider.js';
import type { CalDAVConfig } from '@alfred/types';

export class CalDAVProvider extends CalendarProvider {
  private client: any;

  constructor(private readonly config: CalDAVConfig) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      const tsdav = await import('tsdav');
      const { createDAVClient } = tsdav;
      this.client = await createDAVClient({
        serverUrl: this.config.serverUrl,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
    } catch (err) {
      throw new Error(`CalDAV initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const calendars = await this.client.fetchCalendars();
    if (!calendars || calendars.length === 0) return [];

    const events: CalendarEvent[] = [];
    for (const calendar of calendars) {
      const objects = await this.client.fetchCalendarObjects({
        calendar,
        timeRange: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
      });

      for (const obj of objects) {
        const parsed = this.parseICalEvent(obj.data, obj.url);
        if (parsed) events.push(parsed);
      }
    }

    return events.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const calendars = await this.client.fetchCalendars();
    if (!calendars || calendars.length === 0) {
      throw new Error('No calendars found');
    }

    const uid = `alfred-${Date.now()}@alfred`;
    const ical = this.buildICalEvent(uid, input);

    await this.client.createCalendarObject({
      calendar: calendars[0],
      filename: `${uid}.ics`,
      iCalString: ical,
    });

    return {
      id: uid,
      title: input.title,
      start: input.start,
      end: input.end,
      location: input.location,
      description: input.description,
      allDay: input.allDay,
    };
  }

  async updateEvent(id: string, input: Partial<CreateEventInput>): Promise<CalendarEvent> {
    // CalDAV update requires fetching the existing event and re-creating it
    const calendars = await this.client.fetchCalendars();
    for (const calendar of calendars) {
      const objects = await this.client.fetchCalendarObjects({ calendar });
      for (const obj of objects) {
        if (obj.url?.includes(id) || obj.data?.includes(id)) {
          const existing = this.parseICalEvent(obj.data, obj.url);
          if (!existing) continue;

          const updated = {
            title: input.title ?? existing.title,
            start: input.start ?? existing.start,
            end: input.end ?? existing.end,
            location: input.location ?? existing.location,
            description: input.description ?? existing.description,
            allDay: input.allDay ?? existing.allDay,
          };

          const ical = this.buildICalEvent(id, updated);
          await this.client.updateCalendarObject({
            calendarObject: { ...obj, data: ical },
          });

          return { id, ...updated };
        }
      }
    }
    throw new Error(`Event ${id} not found`);
  }

  async deleteEvent(id: string): Promise<void> {
    const calendars = await this.client.fetchCalendars();
    for (const calendar of calendars) {
      const objects = await this.client.fetchCalendarObjects({ calendar });
      for (const obj of objects) {
        if (obj.url?.includes(id) || obj.data?.includes(id)) {
          await this.client.deleteCalendarObject({ calendarObject: obj });
          return;
        }
      }
    }
    throw new Error(`Event ${id} not found`);
  }

  async checkAvailability(start: Date, end: Date): Promise<{ available: boolean; conflicts: CalendarEvent[] }> {
    const events = await this.listEvents(start, end);
    const conflicts = events.filter(e =>
      !e.allDay && e.start < end && e.end > start,
    );
    return { available: conflicts.length === 0, conflicts };
  }

  private parseICalEvent(data: string, url: string): CalendarEvent | undefined {
    try {
      const lines = data.split('\n').map(l => l.trim());
      const get = (key: string): string | undefined =>
        lines.find(l => l.startsWith(key + ':'))?.slice(key.length + 1);

      const summary = get('SUMMARY');
      const dtstart = get('DTSTART') ?? get('DTSTART;VALUE=DATE');
      const dtend = get('DTEND') ?? get('DTEND;VALUE=DATE');
      const location = get('LOCATION');
      const description = get('DESCRIPTION');
      const uid = get('UID') ?? url;

      if (!summary || !dtstart) return undefined;

      const allDay = dtstart.length === 8; // YYYYMMDD format

      return {
        id: uid,
        title: summary,
        start: this.parseICalDate(dtstart),
        end: dtend ? this.parseICalDate(dtend) : this.parseICalDate(dtstart),
        location: location || undefined,
        description: description || undefined,
        allDay,
      };
    } catch (err) {
      console.error('[caldav] Failed to parse iCal event', err);
      return undefined;
    }
  }

  private parseICalDate(str: string): Date {
    // Handle YYYYMMDD and YYYYMMDDTHHmmssZ formats
    if (str.length === 8) {
      return new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`);
    }
    const clean = str.replace(/[^0-9TZ]/g, '');
    if (clean.length >= 15) {
      return new Date(
        `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`,
      );
    }
    return new Date(str);
  }

  private buildICalEvent(uid: string, input: CreateEventInput & { allDay?: boolean }): string {
    const formatDate = (d: Date, allDay?: boolean): string => {
      if (allDay) {
        return d.toISOString().slice(0, 10).replace(/-/g, '');
      }
      return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };

    let ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Alfred//EN\r\nBEGIN:VEVENT\r\n';
    ical += `UID:${uid}\r\n`;
    ical += `SUMMARY:${input.title}\r\n`;
    if (input.allDay) {
      ical += `DTSTART;VALUE=DATE:${formatDate(input.start, true)}\r\n`;
      ical += `DTEND;VALUE=DATE:${formatDate(input.end, true)}\r\n`;
    } else {
      ical += `DTSTART:${formatDate(input.start)}\r\n`;
      ical += `DTEND:${formatDate(input.end)}\r\n`;
    }
    if (input.location) ical += `LOCATION:${input.location}\r\n`;
    if (input.description) ical += `DESCRIPTION:${input.description}\r\n`;
    ical += `DTSTAMP:${formatDate(new Date())}\r\n`;
    ical += 'END:VEVENT\r\nEND:VCALENDAR\r\n';
    return ical;
  }
}
