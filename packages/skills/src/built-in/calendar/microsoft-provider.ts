import { CalendarProvider } from './calendar-provider.js';
import type { CalendarEvent, CreateEventInput } from './calendar-provider.js';
import type { MicrosoftCalendarConfig } from '@alfred/types';

export class MicrosoftCalendarProvider extends CalendarProvider {
  private client: any;
  private accessToken = '';
  /** Graph API user path. '/me' for own calendar, '/users/{email}' for shared. */
  private readonly userPath: string;

  constructor(private readonly config: MicrosoftCalendarConfig & { sharedCalendar?: string }) {
    super();
    this.userPath = config.sharedCalendar ? `/users/${config.sharedCalendar}` : '/me';
  }

  async initialize(): Promise<void> {
    // Get access token via client credentials + refresh token
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const doRefresh = async (includeSecret: boolean) => {
      const params: Record<string, string> = {
        client_id: this.config.clientId,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
        scope: 'openid offline_access',
      };
      if (includeSecret && this.config.clientSecret) params.client_secret = this.config.clientSecret;
      return fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    };

    let res = await doRefresh(true);
    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('AADSTS700025') || errText.includes('Client is public')) {
        res = await doRefresh(false);
      } else {
        throw new Error(`Microsoft token refresh failed: ${res.status} — ${errText.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
  }

  private async graphRequest(path: string, options: RequestInit = {}): Promise<any> {
    // Always request UTC responses so parseGraphDateTime() can reliably append 'Z'.
    // Without this, create/update responses return times in the calendar's local timezone
    // which parseGraphDateTime() would wrongly interpret as UTC (causing 1h offset).
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.timezone="UTC"',
      ...(options.headers as Record<string, string> ?? {}),
    };

    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      await this.refreshAccessToken();
      headers.Authorization = `Bearer ${this.accessToken}`;
      const retry = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers,
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

    const data = await this.graphRequest(`${this.userPath}/calendarView?${params}`);
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
      const startDate = this.formatDateInTz(input.start, tz).slice(0, 10);
      let endDate = this.formatDateInTz(input.end, tz).slice(0, 10);
      // Graph API: end date is exclusive — must be at least day after start
      if (endDate <= startDate) {
        const d = new Date(startDate + 'T12:00:00');
        d.setDate(d.getDate() + 1);
        endDate = d.toISOString().slice(0, 10);
      }
      event.start = { dateTime: startDate + 'T00:00:00', timeZone: tz };
      event.end = { dateTime: endDate + 'T00:00:00', timeZone: tz };
    } else {
      event.start = { dateTime: this.formatDateInTz(input.start, tz), timeZone: tz };
      event.end = { dateTime: this.formatDateInTz(input.end, tz), timeZone: tz };
    }

    // Deduplicate: check if event with same title + similar start already exists
    // Use ±2h window and flexible title matching to catch duplicates across timezone shifts
    try {
      const checkStart = new Date(input.start.getTime() - 30 * 60_000);
      const checkEnd = new Date(input.start.getTime() + 30 * 60_000);
      const existing = await this.listEvents(checkStart, checkEnd);
      const inputTitleLower = input.title.toLowerCase();
      const duplicate = existing.find(e => {
        const titleLower = (e.title ?? '').toLowerCase();
        // Exact match or one contains the other (catches "Linus – Sommercamp" vs "Sommercamp des SVA")
        const titleMatch = titleLower === inputTitleLower
          || titleLower.includes(inputTitleLower)
          || inputTitleLower.includes(titleLower)
          || (inputTitleLower.split(/[\s–—-]+/).filter(w => w.length > 3).some(w => titleLower.includes(w))
              && titleLower.split(/[\s–—-]+/).filter(w => w.length > 3).some(w => inputTitleLower.includes(w)));
        const timeClose = Math.abs(e.start.getTime() - input.start.getTime()) < 30 * 60_000;
        return titleMatch && timeClose;
      });
      if (duplicate) {
        return duplicate; // Already exists — return without creating again
      }
    } catch { /* ignore dedup check failures — proceed with create */ }

    // Use /calendar/events (not /events) — required for shared calendars
    const data = await this.graphRequest(`${this.userPath}/calendar/events`, {
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

    // Use /calendar/events (not /events) — required for shared calendars
    const data = await this.graphRequest(`${this.userPath}/calendar/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    return this.mapEvent(data);
  }

  async deleteEvent(id: string): Promise<void> {
    // Use /calendar/events (not /events) — required for shared calendars
    await this.graphRequest(`${this.userPath}/calendar/events/${id}`, { method: 'DELETE' });
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
   * We request UTC via Prefer header, but Graph does NOT always respect it for
   * create/update responses — those may return times in the event's local timezone.
   * So we must check dt.timeZone and convert accordingly.
   */
  private parseGraphDateTime(dt: { dateTime?: string; timeZone?: string }): Date {
    if (!dt?.dateTime) return new Date();
    const clean = dt.dateTime.replace(/(\.\d{3})\d*$/, '$1');
    const tz = dt.timeZone;

    // UTC response — just append Z
    if (!tz || tz === 'UTC' || tz.includes('Utc')) {
      return new Date(clean + 'Z');
    }

    // Non-UTC: datetime is in the given timezone, convert to proper UTC Date
    return this.parseDateInTimezone(clean, tz);
  }

  /**
   * Convert a datetime string (without timezone suffix) that represents a time
   * in a specific timezone into a proper UTC Date object.
   * Uses the "UTC guess + offset" trick via Intl.DateTimeFormat.
   */
  private parseDateInTimezone(dateTimeStr: string, tz: string): Date {
    // 1. Treat the datetime as UTC (initial guess)
    const utcGuess = new Date(dateTimeStr + 'Z');

    // 2. Format this UTC time in the target timezone
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(utcGuess);
    const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    const inTzDate = new Date(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}Z`);

    // 3. Offset = how the target TZ shifts from UTC
    const offsetMs = inTzDate.getTime() - utcGuess.getTime();

    // 4. Actual UTC = guess minus the offset
    return new Date(utcGuess.getTime() - offsetMs);
  }
}
