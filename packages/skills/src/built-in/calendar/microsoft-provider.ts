import { CalendarProvider } from './calendar-provider.js';
import type { CalendarEvent, CreateEventInput } from './calendar-provider.js';
import type { MicrosoftCalendarConfig } from '@alfred/types';

export class MicrosoftCalendarProvider extends CalendarProvider {
  private client: any;
  private accessToken = '';

  constructor(private readonly config: MicrosoftCalendarConfig) {
    super();
  }

  async initialize(): Promise<void> {
    // Get access token via client credentials + refresh token
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite offline_access',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async graphRequest(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 401) {
      await this.refreshAccessToken();
      const retry = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      if (!retry.ok) throw new Error(`Graph API error: ${retry.status}`);
      return retry.json();
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    if (res.status === 204) return undefined;
    return res.json();
  }

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $orderby: 'start/dateTime',
      $top: '50',
    });

    const data = await this.graphRequest(`/me/calendarView?${params}`);
    return (data.value ?? []).map((item: any) => this.mapEvent(item));
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const tz = this.timezone;
    const event: Record<string, unknown> = {
      subject: input.title,
      body: input.description ? { contentType: 'text', content: input.description } : undefined,
      location: input.location ? { displayName: input.location } : undefined,
      isAllDay: input.allDay ?? false,
    };

    if (input.allDay) {
      event.start = { dateTime: this.formatDateInTz(input.start, tz).slice(0, 10) + 'T00:00:00', timeZone: tz };
      event.end = { dateTime: this.formatDateInTz(input.end, tz).slice(0, 10) + 'T00:00:00', timeZone: tz };
    } else {
      event.start = { dateTime: this.formatDateInTz(input.start, tz), timeZone: tz };
      event.end = { dateTime: this.formatDateInTz(input.end, tz), timeZone: tz };
    }

    const data = await this.graphRequest('/me/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });

    return this.mapEvent(data);
  }

  async updateEvent(id: string, input: Partial<CreateEventInput>): Promise<CalendarEvent> {
    const patch: Record<string, unknown> = {};
    if (input.title) patch.subject = input.title;
    if (input.description) patch.body = { contentType: 'text', content: input.description };
    if (input.location) patch.location = { displayName: input.location };
    if (input.start) {
      patch.start = { dateTime: this.formatDateInTz(input.start, this.timezone), timeZone: this.timezone };
    }
    if (input.end) {
      patch.end = { dateTime: this.formatDateInTz(input.end, this.timezone), timeZone: this.timezone };
    }

    const data = await this.graphRequest(`/me/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    return this.mapEvent(data);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.graphRequest(`/me/events/${id}`, { method: 'DELETE' });
  }

  async checkAvailability(start: Date, end: Date): Promise<{ available: boolean; conflicts: CalendarEvent[] }> {
    const events = await this.listEvents(start, end);
    const conflicts = events.filter(e => !e.allDay && e.start < end && e.end > start);
    return { available: conflicts.length === 0, conflicts };
  }

  /** Format a Date as a timezone-local datetime string (no Z, no offset) for Graph API. */
  private formatDateInTz(date: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
  }

  private mapEvent(item: any): CalendarEvent {
    return {
      id: item.id,
      title: item.subject ?? '(No title)',
      start: this.parseGraphDateTime(item.start),
      end: this.parseGraphDateTime(item.end),
      location: item.location?.displayName ?? undefined,
      description: item.body?.content ?? undefined,
      allDay: item.isAllDay ?? false,
    };
  }

  /**
   * Parse a Microsoft Graph dateTime object ({ dateTime, timeZone }) into a proper Date.
   * Graph returns dateTime WITHOUT offset (e.g. "2026-03-08T18:00:00.0000000").
   * Without correction, `new Date()` treats it as UTC, shifting times by the local offset.
   * We use the provider's timezone to interpret the datetime correctly.
   */
  private parseGraphDateTime(dt: { dateTime?: string; timeZone?: string }): Date {
    if (!dt?.dateTime) return new Date();
    // Strip trailing fractional zeros and build an unambiguous local-time string.
    // Use Intl to find the UTC offset for the provider's timezone at that moment,
    // then append it so `new Date()` interprets it correctly.
    const raw = dt.dateTime.replace(/\.?\d*$/, ''); // "2026-03-08T18:00:00"
    // Create a temp date assuming UTC to find the offset at that point in time
    const tempUtc = new Date(raw + 'Z');
    const tz = this.timezone;
    // Get the local representation in the target timezone
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(tempUtc);
    const g = (t: string) => local.find(p => p.type === t)?.value ?? '00';
    const localStr = `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
    // The difference between tempUtc and localStr tells us the offset
    const localAsUtc = new Date(localStr + 'Z');
    const offsetMs = localAsUtc.getTime() - tempUtc.getTime();
    // The raw datetime IS in local time, so subtract the offset to get true UTC
    return new Date(tempUtc.getTime() - offsetMs);
  }
}
