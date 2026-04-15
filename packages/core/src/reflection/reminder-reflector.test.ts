import { describe, it, expect, vi } from 'vitest';
import { ReminderReflector } from './reminder-reflector.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as any;

const defaultConfig = {
  repeatPatternDays: 7,
  quickDismissSeconds: 30,
};

describe('ReminderReflector', () => {
  it('returns empty when adapter is undefined', async () => {
    const memoryRepo = { search: vi.fn() } as any;
    const reflector = new ReminderReflector(
      undefined,
      memoryRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');
    expect(results).toEqual([]);
    expect(memoryRepo.search).not.toHaveBeenCalled();
  });

  it('auto-deletes reminder for resolved topic', async () => {
    const memoryRepo = {
      search: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          userId: 'user1',
          key: 'insight_resolved:steuer_abgabe',
          value: 'Steuererklaerung wurde rechtzeitig eingereicht und abgegeben',
          type: 'auto',
          updatedAt: new Date().toISOString(),
        },
      ]),
    } as any;

    const adapter = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('fired = 0')) {
          return Promise.resolve([
            {
              id: 'r1',
              message: 'Steuererklaerung rechtzeitig abgeben',
              trigger_at: new Date(Date.now() + 86400_000).toISOString(),
              fired: 0,
              user_id: 'user1',
              chat_id: 'c1',
              created_at: new Date().toISOString(),
            },
          ]);
        }
        // repeated reminders query
        return Promise.resolve([]);
      }),
      execute: vi.fn(),
    } as any;

    const reflector = new ReminderReflector(
      adapter,
      memoryRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    const del = results.find(
      (r) => r.target.id === 'r1' && r.action === 'delete',
    );
    expect(del).toBeDefined();
    expect(del!.risk).toBe('auto');
    expect(del!.finding).toContain('erledigtes Thema');
  });

  it('suggests recurring when same reminder repeated 3+ times', async () => {
    const memoryRepo = {
      search: vi.fn().mockResolvedValue([]),
    } as any;

    const adapter = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('fired = 0')) {
          return Promise.resolve([]);
        }
        if (sql.includes('GROUP BY')) {
          return Promise.resolve([
            { message: 'Medikament einnehmen', cnt: 5 },
          ]);
        }
        return Promise.resolve([]);
      }),
      execute: vi.fn(),
    } as any;

    const reflector = new ReminderReflector(
      adapter,
      memoryRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    const suggest = results.find(
      (r) => r.action === 'suggest' && r.target.name === 'Medikament einnehmen',
    );
    expect(suggest).toBeDefined();
    expect(suggest!.risk).toBe('confirm');
    expect(suggest!.params).toEqual({
      suggestRecurring: true,
      message: 'Medikament einnehmen',
    });
  });

  it('returns empty when no resolved topics match', async () => {
    const memoryRepo = {
      search: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          userId: 'user1',
          key: 'insight_resolved:kochen',
          value: 'Rezept ausprobiert und gekocht',
          type: 'auto',
          updatedAt: new Date().toISOString(),
        },
      ]),
    } as any;

    const adapter = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('fired = 0')) {
          return Promise.resolve([
            {
              id: 'r1',
              message: 'Auto zum Service bringen',
              trigger_at: new Date(Date.now() + 86400_000).toISOString(),
              fired: 0,
              user_id: 'user1',
              chat_id: 'c1',
              created_at: new Date().toISOString(),
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      execute: vi.fn(),
    } as any;

    const reflector = new ReminderReflector(
      adapter,
      memoryRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    expect(results.length).toBe(0);
  });
});
