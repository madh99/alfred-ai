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
    const event: Record<string, unknown> = {
      subject: input.title,
      body: input.description ? { contentType: 'text', content: input.description } : undefined,
      location: input.location ? { displayName: input.location } : undefined,
      isAllDay: input.allDay ?? false,
    };

    if (input.allDay) {
      event.start = { dateTime: input.start.toISOString().slice(0, 10) + 'T00:00:00', timeZone: 'UTC' };
      event.end = { dateTime: input.end.toISOString().slice(0, 10) + 'T00:00:00', timeZone: 'UTC' };
    } else {
      event.start = { dateTime: input.start.toISOString(), timeZone: 'UTC' };
      event.end = { dateTime: input.end.toISOString(), timeZone: 'UTC' };
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
      patch.start = { dateTime: input.start.toISOString(), timeZone: 'UTC' };
    }
    if (input.end) {
      patch.end = { dateTime: input.end.toISOString(), timeZone: 'UTC' };
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

  private mapEvent(item: any): CalendarEvent {
    return {
      id: item.id,
      title: item.subject ?? '(No title)',
      start: new Date(item.start?.dateTime),
      end: new Date(item.end?.dateTime),
      location: item.location?.displayName ?? undefined,
      description: item.body?.content ?? undefined,
      allDay: item.isAllDay ?? false,
    };
  }
}
