import type { SkillMetadata, SkillContext, SkillResult, CalendarConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { CalendarProvider, CalendarEvent } from './calendar-provider.js';

type CalendarAction = 'list_events' | 'create_event' | 'update_event' | 'delete_event' | 'check_availability' | 'find_free_slot' | 'check_conflicts' | 'list_accounts';

export class CalendarSkill extends Skill {
  readonly metadata: SkillMetadata;

  private readonly providers: Map<string, CalendarProvider>;
  private readonly defaultAccount: string;
  private readonly timezone?: string;

  /** Per-request override for user-specific providers (set in execute, cleared in finally). */
  private activeProviders?: Map<string, CalendarProvider>;

  constructor(providers?: Map<string, CalendarProvider> | CalendarProvider, timezone?: string) {
    super();

    if (providers instanceof Map) {
      this.providers = providers;
    } else if (providers) {
      this.providers = new Map([['default', providers]]);
    } else {
      this.providers = new Map();
    }

    this.defaultAccount = [...this.providers.keys()][0] ?? 'default';
    this.timezone = timezone;

    const accountProp = {
      account: {
        type: 'string' as const,
        description: 'Calendar account name. Use list_accounts to see available accounts.',
      },
    };

    const description = 'Manage calendar events. List upcoming events, create new events, update or delete existing ones, check availability and find free slots. Use "list_accounts" to see available calendar accounts.';

    this.metadata = {
      name: 'calendar',
      category: 'productivity',
      description,
      riskLevel: 'write',
      version: '2.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_events', 'create_event', 'update_event', 'delete_event', 'check_availability', 'find_free_slot', 'check_conflicts', 'list_accounts'],
            description: 'The calendar action to perform. Use find_free_slot to find available time windows.',
          },
          ...accountProp,
          start: {
            type: 'string',
            description: 'Start date/time in ISO 8601 format WITHOUT timezone suffix (e.g. "2026-03-09T14:00:00", NOT "2026-03-09T14:00:00Z"). Times are interpreted in the user\'s local timezone.',
          },
          end: {
            type: 'string',
            description: 'End date/time in ISO 8601 format WITHOUT timezone suffix (e.g. "2026-03-09T14:30:00"). Times are interpreted in the user\'s local timezone.',
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
          duration_minutes: {
            type: 'number',
            description: 'Duration in minutes to find a free slot for (for find_free_slot)',
          },
          working_hours_only: {
            type: 'boolean',
            description: 'If true, only consider 08:00-18:00 for free slots (default: true)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    // Resolve per-user calendar providers if available
    const userProviders = await this.resolveUserProviders(context);
    this.activeProviders = userProviders ?? undefined;

    try {
      // Multi-user: non-admin users must have their own calendar config, no fallback to global
      let providers: Map<string, CalendarProvider>;
      if (this.activeProviders) {
        if (context.userRole === 'admin' || !context.alfredUserId) {
          // Admin: merge global providers + per-user providers (per-user overrides global with same name)
          providers = new Map([...this.providers, ...this.activeProviders]);
        } else {
          providers = this.activeProviders;
        }
      } else {
        providers = (context.userRole === 'admin' || !context.alfredUserId) ? this.providers : new Map();
      }
      if (providers.size === 0) {
        return { success: false, error: 'Kalender ist nicht konfiguriert. Nutze "setup_service" um einen Kalender zu verbinden.' };
      }

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
        case 'find_free_slot':
          return this.findFreeSlot(input);
        case 'check_conflicts':
          return this.checkConflicts(input);
        case 'list_accounts':
          return this.handleListAccounts(providers);
        default:
          return { success: false, error: `Unknown action: "${String(action)}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Calendar error: ${msg}` };
    } finally {
      this.activeProviders = undefined;
    }
  }

  // ── Provider Resolution ──────────────────────────────────────────

  /**
   * Resolve per-user calendar providers from UserServiceResolver.
   * Returns null if no per-user config is available (fall back to global).
   */
  private async resolveUserProviders(context: SkillContext): Promise<Map<string, CalendarProvider> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'calendar');
    if (services.length === 0) return null;

    const providers = new Map<string, CalendarProvider>();
    for (const svc of services) {
      try {
        const { createCalendarProvider } = await import('./factory.js');
        const provider = await createCalendarProvider(svc.config as unknown as CalendarConfig);
        providers.set(svc.serviceName, provider);
      } catch { /* skip broken per-user configs */ }
    }
    return providers.size > 0 ? providers : null;
  }

  private resolveProvider(input: Record<string, unknown>, contextTimezone?: string): { provider: CalendarProvider; account: string } | SkillResult {
    const providers = this.activeProviders ?? this.providers;
    const accountNames = [...providers.keys()];
    const defaultAccount = accountNames[0] ?? 'default';
    const account = (input.account as string) ?? defaultAccount;
    const provider = providers.get(account);
    if (!provider) {
      return {
        success: false,
        error: `Unbekannter Kalender-Account "${account}". Verfügbar: ${accountNames.join(', ')}`,
      };
    }
    // Propagate timezone to the provider
    if (contextTimezone) {
      provider.timezone = contextTimezone;
    }
    return { provider, account };
  }

  private accountLabel(account: string, text: string): string {
    const providers = this.activeProviders ?? this.providers;
    return providers.size > 1 ? `[${account}] ${text}` : text;
  }

  private encodeId(account: string, rawId: string): string {
    const providers = this.activeProviders ?? this.providers;
    return providers.size > 1 ? `${account}::${rawId}` : rawId;
  }

  private decodeId(compositeId: string): { account: string; rawId: string } {
    const providers = this.activeProviders ?? this.providers;
    if (providers.size > 1) {
      const idx = compositeId.indexOf('::');
      if (idx >= 0) {
        return { account: compositeId.slice(0, idx), rawId: compositeId.slice(idx + 2) };
      }
    }
    const defaultAccount = [...providers.keys()][0] ?? this.defaultAccount;
    return { account: defaultAccount, rawId: compositeId };
  }

  // ── Public API for CalendarWatcher / ReasoningEngine ─────────────

  /**
   * Get today's events using the first global provider.
   * Used by CalendarWatcher and ReasoningEngine — NOT affected by multi-account.
   */
  async getTodayEvents(): Promise<CalendarEvent[]> {
    const calendarProvider = this.providers.get(this.defaultAccount);
    if (!calendarProvider) return [];

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    try {
      return await calendarProvider.listEvents(startOfDay, endOfDay);
    } catch (err) {
      console.error('[calendar] Failed to fetch today events', err);
      return [];
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────

  private async listEvents(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const start = input.start ? new Date(input.start as string) : new Date();
    const end = input.end
      ? new Date(input.end as string)
      : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000); // Default: 7 days

    try {
      const events = await provider.listEvents(start, end);

      if (events.length === 0) {
        return { success: true, data: [], display: this.accountLabel(account, 'No events found in this time range.') };
      }

      const display = events
        .map(e => this.formatEvent(e, provider))
        .join('\n');

      return { success: true, data: events, display: this.accountLabel(account, `${events.length} event(s):\n${display}`) };
    } catch (err) {
      return { success: false, error: `Failed to list events: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Strip trailing 'Z' from ISO strings to ensure they're parsed as local time.
   * LLMs sometimes send "2026-03-09T14:00:00Z" even though we tell them not to.
   * The Z would cause JavaScript to parse it as UTC instead of user-local time.
   */
  private parseLocalTime(iso: string): Date {
    return new Date(iso.replace(/Z$/i, ''));
  }

  private async createEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    const start = input.start as string;
    const end = input.end as string;

    if (!title) return { success: false, error: 'Missing required field "title"' };
    if (!start) return { success: false, error: 'Missing required field "start"' };
    if (!end) return { success: false, error: 'Missing required field "end"' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const event = await provider.createEvent({
        title,
        start: this.parseLocalTime(start),
        end: this.parseLocalTime(end),
        location: input.location as string | undefined,
        description: input.description as string | undefined,
        allDay: input.all_day as boolean | undefined,
      });

      return {
        success: true,
        data: event,
        display: this.accountLabel(account, `Event created: ${this.formatEvent(event, provider)}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to create event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async updateEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const eventId = input.event_id as string;
    if (!eventId) return { success: false, error: 'Missing required field "event_id"' };

    const { account, rawId } = this.decodeId(eventId);
    const providers = this.activeProviders ?? this.providers;
    const provider = providers.get(account);
    if (!provider) {
      return { success: false, error: `Unbekannter Kalender-Account "${account}".` };
    }

    try {
      const event = await provider.updateEvent(rawId, {
        title: input.title as string | undefined,
        start: input.start ? this.parseLocalTime(input.start as string) : undefined,
        end: input.end ? this.parseLocalTime(input.end as string) : undefined,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
        allDay: input.all_day as boolean | undefined,
      });

      return {
        success: true,
        data: event,
        display: this.accountLabel(account, `Event updated: ${this.formatEvent(event, provider)}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to update event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async deleteEvent(input: Record<string, unknown>): Promise<SkillResult> {
    const eventId = input.event_id as string;
    if (!eventId) return { success: false, error: 'Missing required field "event_id"' };

    const { account, rawId } = this.decodeId(eventId);
    const providers = this.activeProviders ?? this.providers;
    const provider = providers.get(account);
    if (!provider) {
      return { success: false, error: `Unbekannter Kalender-Account "${account}".` };
    }

    try {
      await provider.deleteEvent(rawId);
      return { success: true, data: { deleted: rawId }, display: this.accountLabel(account, `Event "${rawId}" deleted.`) };
    } catch (err) {
      return { success: false, error: `Failed to delete event: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async checkAvailability(input: Record<string, unknown>): Promise<SkillResult> {
    const start = input.start as string;
    const end = input.end as string;
    if (!start || !end) return { success: false, error: 'Missing required fields "start" and "end"' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const result = await provider.checkAvailability(this.parseLocalTime(start), this.parseLocalTime(end));
      const display = result.available
        ? 'Time slot is available.'
        : `Time slot has ${result.conflicts.length} conflict(s):\n${result.conflicts.map(e => this.formatEvent(e, provider)).join('\n')}`;

      return { success: true, data: result, display: this.accountLabel(account, display) };
    } catch (err) {
      return { success: false, error: `Failed to check availability: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async findFreeSlot(input: Record<string, unknown>): Promise<SkillResult> {
    const durationMinutes = (input.duration_minutes as number) ?? 60;
    const start = input.start ? new Date(input.start as string) : new Date();
    const end = input.end
      ? new Date(input.end as string)
      : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000); // Default: 7 days
    const workingHoursOnly = input.working_hours_only !== false; // default true

    if (durationMinutes < 5 || durationMinutes > 480) {
      return { success: false, error: 'duration_minutes must be between 5 and 480' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const events = await provider.listEvents(start, end);
      // Sort by start time
      const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());

      const durationMs = durationMinutes * 60_000;
      const slots: Array<{ start: Date; end: Date }> = [];
      const workStart = 8; // 08:00
      const workEnd = 18; // 18:00

      // Walk through the range finding gaps
      let cursor = start.getTime();
      const rangeEnd = end.getTime();

      for (const event of sorted) {
        const eventStart = event.start.getTime();
        const eventEnd = event.end.getTime();

        // Skip all-day events for slot calculation (they don't block specific times)
        if (event.allDay) continue;

        if (eventStart > cursor) {
          // There's a gap between cursor and event start
          this.collectSlots(cursor, eventStart, durationMs, workingHoursOnly, workStart, workEnd, slots);
        }
        cursor = Math.max(cursor, eventEnd);
        if (slots.length >= 5) break;
      }

      // Check gap after last event to range end
      if (slots.length < 5 && cursor < rangeEnd) {
        this.collectSlots(cursor, rangeEnd, durationMs, workingHoursOnly, workStart, workEnd, slots);
      }

      if (slots.length === 0) {
        return { success: true, data: { slots: [] }, display: this.accountLabel(account, `No free ${durationMinutes}-minute slots found in the given range.`) };
      }

      const tz = provider.timezone || this.timezone;
      const timeOpts: Intl.DateTimeFormatOptions = {
        weekday: 'short', day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
        ...(tz ? { timeZone: tz } : {}),
      };
      const lines = slots.slice(0, 5).map((s, i) => {
        const startStr = s.start.toLocaleString('de-AT', timeOpts);
        const endStr = s.end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
        return `${i + 1}. ${startStr} – ${endStr}`;
      });

      return {
        success: true,
        data: { slots: slots.slice(0, 5).map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() })) },
        display: this.accountLabel(account, `Free ${durationMinutes}-minute slots:\n${lines.join('\n')}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to find free slots: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private collectSlots(
    gapStart: number,
    gapEnd: number,
    durationMs: number,
    workingHoursOnly: boolean,
    workStart: number,
    workEnd: number,
    slots: Array<{ start: Date; end: Date }>,
  ): void {
    let cursor = gapStart;
    while (cursor + durationMs <= gapEnd && slots.length < 5) {
      const d = new Date(cursor);
      const hour = d.getHours();
      const endTime = cursor + durationMs;
      const endHour = new Date(endTime).getHours() + new Date(endTime).getMinutes() / 60;

      if (workingHoursOnly) {
        // Skip weekends
        const day = d.getDay();
        if (day === 0 || day === 6) {
          // Jump to next Monday 08:00
          const daysToMon = day === 0 ? 1 : 2;
          const nextMon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysToMon, workStart);
          cursor = nextMon.getTime();
          continue;
        }
        // Before working hours — jump to start
        if (hour < workStart) {
          cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), workStart).getTime();
          continue;
        }
        // After working hours — jump to next day
        if (hour >= workEnd || endHour > workEnd) {
          const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, workStart);
          cursor = next.getTime();
          continue;
        }
      }

      slots.push({ start: new Date(cursor), end: new Date(endTime) });
      // Move cursor past this slot to find more
      cursor = endTime;
    }
  }

  private async checkConflicts(input: Record<string, unknown>): Promise<SkillResult> {
    const start = input.start as string;
    const end = input.end as string;
    const title = (input.title as string) ?? 'New Event';
    if (!start || !end) return { success: false, error: 'Missing required fields "start" and "end"' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    try {
      const result = await provider.checkAvailability(
        this.parseLocalTime(start),
        this.parseLocalTime(end),
      );

      if (result.available) {
        return {
          success: true,
          data: { conflicts: [], available: true },
          display: this.accountLabel(account, `No conflicts found for "${title}" (${start} – ${end}). The time slot is free.`),
        };
      }

      const lines = result.conflicts.map(e => this.formatEvent(e, provider));
      return {
        success: true,
        data: { conflicts: result.conflicts, available: false },
        display: this.accountLabel(account, `"${title}" has ${result.conflicts.length} conflict(s):\n${lines.join('\n')}`),
      };
    } catch (err) {
      return { success: false, error: `Failed to check conflicts: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private handleListAccounts(providers: Map<string, CalendarProvider>): SkillResult {
    const names = [...providers.keys()];
    if (names.length === 0) {
      return { success: true, data: { accounts: [] }, display: 'Keine Kalender-Accounts konfiguriert.\nNutze "setup_service" um einen Kalender zu verbinden.' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfügbare Kalender-Accounts:\n${names.map((n, i) => `${i === 0 ? '• ' + n + ' (Standard)' : '• ' + n}`).join('\n')}`,
    };
  }

  // ── Formatting ───────────────────────────────────────────────────

  private formatEvent(event: CalendarEvent, provider: CalendarProvider): string {
    // Use provider timezone (updated per-request from context) over constructor timezone
    const tz = provider.timezone || this.timezone;
    const timeOpts: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      ...(tz ? { timeZone: tz } : {}),
    };
    const dateOpts: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      ...(tz ? { timeZone: tz } : {}),
    };

    const loc = event.location ? ` @ ${event.location}` : '';
    const idTag = event.id ? ` [id:${event.id}]` : '';
    const dateStr = event.start.toLocaleDateString('de-AT', dateOpts);

    if (event.allDay) {
      return `- ${dateStr} ganztägig: ${event.title}${loc}${idTag}`;
    }

    const startTime = event.start.toLocaleTimeString('en-GB', timeOpts);
    const endTime = event.end.toLocaleTimeString('en-GB', timeOpts);
    return `- ${dateStr} ${startTime}-${endTime}: ${event.title}${loc}${idTag}`;
  }
}
