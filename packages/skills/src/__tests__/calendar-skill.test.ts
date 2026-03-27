import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarSkill } from '../built-in/calendar/calendar-skill.js';
import type { CalendarProvider, CalendarEvent, CreateEventInput } from '../built-in/calendar/calendar-provider.js';
import type { SkillContext } from '@alfred/types';

// ── Mock CalendarProvider ─────────────────────────────────────────────

function createMockProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    timezone: 'Europe/Vienna',
    initialize: vi.fn().mockResolvedValue(undefined),
    listEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockImplementation(async (input: CreateEventInput): Promise<CalendarEvent> => ({
      id: 'new-event-1',
      title: input.title,
      start: input.start,
      end: input.end,
      location: input.location,
      description: input.description,
      allDay: input.allDay,
    })),
    updateEvent: vi.fn().mockResolvedValue({ id: '1', title: 'updated', start: new Date(), end: new Date() }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, conflicts: [] }),
    ...overrides,
  } as CalendarProvider;
}

function createContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    userId: 'user1',
    chatId: 'chat1',
    platform: 'test',
    userRole: 'admin',
    ...overrides,
  } as SkillContext;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('CalendarSkill.createEvent', () => {
  let provider: CalendarProvider;
  let skill: CalendarSkill;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    skill = new CalendarSkill(new Map([['default', provider]]), 'Europe/Vienna');
  });

  it('rejects events in the past', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60_000); // yesterday
    const pastEnd = new Date(pastDate.getTime() + 60 * 60_000);

    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'Past meeting',
        start: pastDate.toISOString().replace('Z', ''),
        end: pastEnd.toISOString().replace('Z', ''),
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Vergangenheit');
    expect(provider.createEvent).not.toHaveBeenCalled();
  });

  it('rejects duplicate events (same title + overlapping time)', async () => {
    // Use a local-time ISO string (no Z suffix) to avoid UTC vs local mismatch
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    const startStr = `${y}-${m}-${d}T14:00:00`;
    const endStr = `${y}-${m}-${d}T15:00:00`;
    const startDate = new Date(startStr);
    const endDate = new Date(endStr);

    // listEvents returns an existing event with same title/time
    (provider.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'existing-1',
        title: 'Team Standup',
        start: startDate,
        end: endDate,
      },
    ]);

    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'Team Standup',
        start: startStr,
        end: endStr,
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('existiert bereits');
    expect(provider.createEvent).not.toHaveBeenCalled();
  });

  it('rejects duplicate events case-insensitively', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    const startStr = `${y}-${m}-${d}T14:00:00`;
    const endStr = `${y}-${m}-${d}T15:00:00`;
    const startDate = new Date(startStr);
    const endDate = new Date(endStr);

    (provider.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'existing-1',
        title: 'team standup',
        start: startDate,
        end: endDate,
      },
    ]);

    const result = await skill.execute(
      {
        action: 'create_event',
        title: '  Team Standup  ', // different casing + whitespace
        start: startStr,
        end: endStr,
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('existiert bereits');
  });

  it('creates event successfully when no duplicate and in the future', async () => {
    const futureStart = new Date(Date.now() + 24 * 60 * 60_000);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60_000);

    // listEvents returns no matches (no duplicates)
    (provider.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'New meeting',
        start: futureStart.toISOString().replace('Z', ''),
        end: futureEnd.toISOString().replace('Z', ''),
      },
      createContext(),
    );

    expect(result.success).toBe(true);
    expect(provider.createEvent).toHaveBeenCalledOnce();
    expect(result.data).toBeDefined();
    expect((result.data as CalendarEvent).title).toBe('New meeting');
  });

  it('strips trailing Z from ISO strings (LLM sends UTC suffix)', async () => {
    const futureStart = new Date(Date.now() + 24 * 60 * 60_000);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60_000);

    (provider.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'Z-suffix test',
        start: futureStart.toISOString(), // has trailing Z
        end: futureEnd.toISOString(),     // has trailing Z
      },
      createContext(),
    );

    expect(result.success).toBe(true);
    // Verify createEvent was called with Date objects (not strings)
    const callArgs = (provider.createEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.start).toBeInstanceOf(Date);
    expect(callArgs.end).toBeInstanceOf(Date);
  });

  it('returns error for missing title', async () => {
    const result = await skill.execute(
      {
        action: 'create_event',
        start: '2027-01-01T10:00:00',
        end: '2027-01-01T11:00:00',
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('title');
  });

  it('returns error for missing start', async () => {
    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'No start',
        end: '2027-01-01T11:00:00',
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('start');
  });

  it('returns error for missing end', async () => {
    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'No end',
        start: '2027-01-01T10:00:00',
      },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('end');
  });

  it('proceeds with creation even if duplicate check (listEvents) fails', async () => {
    const futureStart = new Date(Date.now() + 24 * 60 * 60_000);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60_000);

    // listEvents throws — duplicate check should not block creation
    (provider.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    const result = await skill.execute(
      {
        action: 'create_event',
        title: 'Despite error',
        start: futureStart.toISOString().replace('Z', ''),
        end: futureEnd.toISOString().replace('Z', ''),
      },
      createContext(),
    );

    expect(result.success).toBe(true);
    expect(provider.createEvent).toHaveBeenCalledOnce();
  });
});

describe('CalendarSkill — provider resolution', () => {
  it('returns error when no providers are configured', async () => {
    const skill = new CalendarSkill(new Map());

    const result = await skill.execute(
      { action: 'list_events' },
      createContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('nicht konfiguriert');
  });

  it('non-admin user without own config gets no-config error', async () => {
    const provider = createMockProvider();
    const skill = new CalendarSkill(new Map([['default', provider]]));

    const result = await skill.execute(
      { action: 'list_events' },
      createContext({ userRole: 'user', alfredUserId: 'other-user' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('nicht konfiguriert');
  });
});
