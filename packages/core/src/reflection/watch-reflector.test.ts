import { describe, it, expect, vi } from 'vitest';
import { WatchReflector } from './watch-reflector.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as any;

function makeWatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    name: 'Test Watch',
    skillName: 'energy_price',
    enabled: true,
    intervalMinutes: 30,
    lastCheckedAt: new Date().toISOString(),
    lastTriggeredAt: null,
    lastValue: null,
    createdAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
    chatId: 'chat1',
    platform: 'telegram',
    ...overrides,
  };
}

const defaultConfig = {
  staleAfterDays: 14,
  deleteAfterDays: 30,
  maxTriggersPerDay: 10,
  ignoredAlertsBeforePause: 5,
  failedActionsBeforeDisable: 3,
};

describe('WatchReflector', () => {
  it('flags stale watch for adjustment (>14 days, <30 days)', async () => {
    const watchRepo = {
      getEnabled: vi.fn().mockResolvedValue([makeWatch()]),
    } as any;
    const activityRepo = {
      query: vi.fn().mockResolvedValue([]),
    } as any;

    const reflector = new WatchReflector(
      watchRepo,
      activityRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const stale = results.find(
      (r) => r.target.id === 'w1' && r.action === 'adjust',
    );
    expect(stale).toBeDefined();
    expect(stale!.risk).toBe('auto');
  });

  it('flags watch for deletion after deleteAfterDays', async () => {
    const watch = makeWatch({
      lastTriggeredAt: null,
      createdAt: new Date(Date.now() - 35 * 86400_000).toISOString(),
    });
    const watchRepo = {
      getEnabled: vi.fn().mockResolvedValue([watch]),
    } as any;
    const activityRepo = {
      query: vi.fn().mockResolvedValue([]),
    } as any;

    const reflector = new WatchReflector(
      watchRepo,
      activityRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    const del = results.find(
      (r) => r.target.id === 'w1' && r.action === 'delete',
    );
    expect(del).toBeDefined();
    expect(del!.risk).toBe('proactive');
  });

  it('flags watch triggering too often', async () => {
    const watch = makeWatch({
      lastTriggeredAt: new Date().toISOString(),
    });
    const triggers = Array.from({ length: 15 }, (_, i) => ({
      eventType: 'watch_trigger',
      action: 'w1',
      outcome: 'success',
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
    }));
    const watchRepo = {
      getEnabled: vi.fn().mockResolvedValue([watch]),
    } as any;
    const activityRepo = {
      query: vi.fn().mockResolvedValue(triggers),
    } as any;

    const reflector = new WatchReflector(
      watchRepo,
      activityRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    const tooOften = results.find(
      (r) => r.action === 'adjust' && r.finding.includes('oft'),
    );
    expect(tooOften).toBeDefined();
  });

  it('flags watch with repeated failed actions', async () => {
    const watch = makeWatch({
      lastTriggeredAt: new Date(
        Date.now() - 1 * 86400_000,
      ).toISOString(),
    });
    const failures = Array.from({ length: 4 }, () => ({
      eventType: 'watch_action',
      action: 'w1',
      outcome: 'error',
      createdAt: new Date().toISOString(),
    }));
    const watchRepo = {
      getEnabled: vi.fn().mockResolvedValue([watch]),
    } as any;
    const activityRepo = {
      query: vi.fn().mockImplementation(({ eventType }: any) =>
        eventType === 'watch_action'
          ? Promise.resolve(failures)
          : Promise.resolve([]),
      ),
    } as any;

    const reflector = new WatchReflector(
      watchRepo,
      activityRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    const disabled = results.find((r) => r.action === 'deactivate');
    expect(disabled).toBeDefined();
    expect(disabled!.risk).toBe('proactive');
  });

  it('returns empty for healthy watches', async () => {
    const watch = makeWatch({
      lastTriggeredAt: new Date(
        Date.now() - 2 * 86400_000,
      ).toISOString(),
    });
    const watchRepo = {
      getEnabled: vi.fn().mockResolvedValue([watch]),
    } as any;
    const activityRepo = {
      query: vi.fn().mockResolvedValue([
        {
          eventType: 'watch_trigger',
          action: 'w1',
          outcome: 'success',
          createdAt: new Date().toISOString(),
        },
      ]),
    } as any;

    const reflector = new WatchReflector(
      watchRepo,
      activityRepo,
      mockLogger,
      defaultConfig,
    );
    const results = await reflector.reflect('user1');

    expect(results.length).toBe(0);
  });
});
