import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchEngine } from '../watch-engine.js';

function createMockWatchRepo(watches: any[] = []) {
  return {
    getDue: vi.fn(() => watches),
    updateAfterCheck: vi.fn(),
  } as any;
}

function createMockSkillRegistry(skills: Record<string, any> = {}) {
  return {
    has: vi.fn((name: string) => name in skills),
    get: vi.fn((name: string) => skills[name] ?? undefined),
  } as any;
}

function createMockSkillSandbox() {
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: { temperature: 35 },
    }),
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createMockUsers() {
  return {
    findOrCreate: vi.fn(() => ({ id: 'user-1', platformUserId: 'plat-1' })),
    findById: vi.fn(() => ({ id: 'user-1', platformUserId: 'plat-1', username: 'test' })),
    getMasterUserId: vi.fn(() => 'master-1'),
    getLinkedUsers: vi.fn(() => []),
    getProfile: vi.fn(() => ({})),
  } as any;
}

describe('WatchEngine', () => {
  let engine: WatchEngine;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start/stop — interval is set and cleared', () => {
    const logger = createMockLogger();
    engine = new WatchEngine(
      createMockWatchRepo(), createMockSkillRegistry(), createMockSkillSandbox(),
      new Map(), createMockUsers(), logger,
    );

    engine.start();
    expect(logger.info).toHaveBeenCalledWith('Watch engine started');

    engine.stop();
    expect(logger.info).toHaveBeenCalledWith('Watch engine stopped');
  });

  it('check — condition triggered sends notification', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 40 } });

    const watch = {
      id: 'w-1',
      name: 'High Temp',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: '30',       // previous baseline exists — so condition will be evaluated
      lastTriggeredAt: null,
      lastCheckedAt: null,
    };

    const watchRepo = createMockWatchRepo([watch]);
    engine = new WatchEngine(
      watchRepo, createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(adapter.sendMessage).toHaveBeenCalled();
    expect(watchRepo.updateAfterCheck).toHaveBeenCalled();
    const updateCall = watchRepo.updateAfterCheck.mock.calls[0][1];
    expect(updateCall.lastTriggeredAt).toBeDefined();
  });

  it('check — condition not met does not notify', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 30 } });

    const watch = {
      id: 'w-2',
      name: 'Low Temp',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: null,
      lastTriggeredAt: null,
    };

    engine = new WatchEngine(
      createMockWatchRepo([watch]), createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('cooldown — re-trigger within cooldown is skipped', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 40 } });

    const recentTrigger = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const watch = {
      id: 'w-3',
      name: 'Cooldown Watch',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: null,
      lastTriggeredAt: recentTrigger,
    };

    engine = new WatchEngine(
      createMockWatchRepo([watch]), createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('error in skill call is logged, watch stays active', async () => {
    const logger = createMockLogger();
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockRejectedValue(new Error('Network error'));

    const watch = {
      id: 'w-4',
      name: 'Error Watch',
      skillName: 'system_info',
      skillParams: {},
      condition: { field: 'value', operator: 'gt', value: 0 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: null,
      lastTriggeredAt: null,
    };

    const watchRepo = createMockWatchRepo([watch]);
    engine = new WatchEngine(
      watchRepo, createMockSkillRegistry({ system_info: {} }),
      sandbox, new Map(), createMockUsers(), logger,
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(logger.error).toHaveBeenCalled();
    // Engine still runs — next tick works
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchRepo.getDue).toHaveBeenCalledTimes(2);
  });
});
