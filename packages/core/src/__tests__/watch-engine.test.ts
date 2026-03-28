import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchEngine } from '../watch-engine.js';

function createMockWatchRepo(watches: any[] = []) {
  return {
    claimDue: vi.fn(() => watches),
    updateAfterCheck: vi.fn(),
    updateActionError: vi.fn(),
    updateSkillParams: vi.fn(),
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

  it('watch with alert_and_action — both executed', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 40 } });

    const actionSkill = { name: 'home_assistant' };
    const watch = {
      id: 'w-action-1',
      name: 'Wallbox Watch',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: '30',
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'alert_and_action' as const,
      actionSkillName: 'home_assistant',
      actionSkillParams: { entity: 'switch.wallbox', action: 'turn_on' },
      requiresConfirmation: false,
      compositeCondition: undefined,
    };

    const watchRepo = createMockWatchRepo([watch]);
    watchRepo.updateActionError = vi.fn();

    engine = new WatchEngine(
      watchRepo,
      createMockSkillRegistry({ system_info: {}, home_assistant: actionSkill }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Action skill was executed (second call to sandbox.execute)
    expect(sandbox.execute).toHaveBeenCalledTimes(2);
    expect(sandbox.execute).toHaveBeenCalledWith(
      actionSkill,
      { entity: 'switch.wallbox', action: 'turn_on' },
      expect.anything(),
    );
    // Alert was also sent
    expect(adapter.sendMessage).toHaveBeenCalled();
    expect(watchRepo.updateActionError).toHaveBeenCalledWith('w-action-1', null);
  });

  it('action skill fails — alert still sent with error', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    // First call: monitoring skill succeeds, second call: action skill fails
    sandbox.execute
      .mockResolvedValueOnce({ success: true, data: { temperature: 40 } })
      .mockRejectedValueOnce(new Error('Connection refused'));

    const watch = {
      id: 'w-action-err',
      name: 'Wallbox Watch',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: '30',
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'alert_and_action' as const,
      actionSkillName: 'home_assistant',
      actionSkillParams: { entity: 'switch.wallbox', action: 'turn_on' },
      requiresConfirmation: false,
      compositeCondition: undefined,
    };

    const watchRepo = createMockWatchRepo([watch]);
    watchRepo.updateActionError = vi.fn();

    engine = new WatchEngine(
      watchRepo,
      createMockSkillRegistry({ system_info: {}, home_assistant: { name: 'home_assistant' } }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Alert was sent and contains error text
    expect(adapter.sendMessage).toHaveBeenCalled();
    const alertText = adapter.sendMessage.mock.calls[0][1] as string;
    expect(alertText).toContain('Connection refused');

    // updateActionError was called with the error message
    expect(watchRepo.updateActionError).toHaveBeenCalledWith('w-action-err', 'Connection refused');
  });

  it('action_only — no alert sent, only action', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 40 } });

    const actionSkill = { name: 'home_assistant' };
    const watch = {
      id: 'w-action-only',
      name: 'Silent Action',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: '30',
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'action_only' as const,
      actionSkillName: 'home_assistant',
      actionSkillParams: { entity: 'switch.wallbox', action: 'turn_on' },
      requiresConfirmation: false,
      compositeCondition: undefined,
    };

    const watchRepo = createMockWatchRepo([watch]);
    watchRepo.updateActionError = vi.fn();

    engine = new WatchEngine(
      watchRepo,
      createMockSkillRegistry({ system_info: {}, home_assistant: actionSkill }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Action skill was executed
    expect(sandbox.execute).toHaveBeenCalledTimes(2);
    // No alert message sent
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('composite AND — all conditions must match', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { price: 10, soc: 50 } });

    const watch = {
      id: 'w-composite-and',
      name: 'Composite AND',
      skillName: 'system_info',
      skillParams: {},
      condition: { field: 'price', operator: 'lt', value: 15 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: JSON.stringify({ price: 20, soc: 90 }),
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'alert' as const,
      compositeCondition: {
        logic: 'and' as const,
        conditions: [
          { field: 'price', operator: 'lt' as const, value: 15 },
          { field: 'soc', operator: 'lt' as const, value: 80 },
        ],
      },
      requiresConfirmation: false,
    };

    const watchRepo = createMockWatchRepo([watch]);
    engine = new WatchEngine(
      watchRepo, createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Both conditions match → triggered → alert sent
    expect(adapter.sendMessage).toHaveBeenCalled();
    expect(watchRepo.updateAfterCheck).toHaveBeenCalled();
    const updateCall = watchRepo.updateAfterCheck.mock.calls[0][1];
    expect(updateCall.lastTriggeredAt).toBeDefined();
  });

  it('composite AND — partial match no trigger', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    // price=10 < 15 matches, but soc=90 is NOT < 80
    sandbox.execute.mockResolvedValue({ success: true, data: { price: 10, soc: 90 } });

    const watch = {
      id: 'w-composite-partial',
      name: 'Composite AND Partial',
      skillName: 'system_info',
      skillParams: {},
      condition: { field: 'price', operator: 'lt', value: 15 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: JSON.stringify({ price: 20, soc: 70 }),
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'alert' as const,
      compositeCondition: {
        logic: 'and' as const,
        conditions: [
          { field: 'price', operator: 'lt' as const, value: 15 },
          { field: 'soc', operator: 'lt' as const, value: 80 },
        ],
      },
      requiresConfirmation: false,
    };

    const watchRepo = createMockWatchRepo([watch]);
    engine = new WatchEngine(
      watchRepo, createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Only one condition matches → AND not satisfied → no alert
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(watchRepo.updateAfterCheck).toHaveBeenCalled();
    const updateCall = watchRepo.updateAfterCheck.mock.calls[0][1];
    expect(updateCall.lastTriggeredAt).toBeUndefined();
  });

  it('requiresConfirmation — action enqueued, not executed', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockResolvedValue({ success: true, data: { temperature: 40 } });

    const confirmationQueue = { enqueue: vi.fn().mockResolvedValue(undefined) } as any;

    const watch = {
      id: 'w-confirm',
      name: 'Confirm Watch',
      skillName: 'system_info',
      skillParams: { action: 'status' },
      condition: { field: 'temperature', operator: 'gt', value: 35 },
      platform: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      cooldownMinutes: 60,
      lastValue: '30',
      lastTriggeredAt: null,
      lastCheckedAt: null,
      actionOnTrigger: 'alert_and_action' as const,
      actionSkillName: 'home_assistant',
      actionSkillParams: { entity: 'switch.wallbox', action: 'turn_on' },
      requiresConfirmation: true,
      compositeCondition: undefined,
    };

    const watchRepo = createMockWatchRepo([watch]);
    engine = new WatchEngine(
      watchRepo, createMockSkillRegistry({ system_info: {} }),
      sandbox, adapters, createMockUsers(), createMockLogger(),
      confirmationQueue,
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Confirmation queue was called instead of executing action directly
    expect(confirmationQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        platform: 'telegram',
        source: 'watch',
        sourceId: 'w-confirm',
        skillName: 'home_assistant',
        skillParams: { entity: 'switch.wallbox', action: 'turn_on' },
      }),
    );

    // Action was NOT executed via sandbox (only monitoring skill was)
    expect(sandbox.execute).toHaveBeenCalledTimes(1);

    // Alert was still sent (because mode is alert_and_action)
    expect(adapter.sendMessage).toHaveBeenCalled();
    const alertText = adapter.sendMessage.mock.calls[0][1] as string;
    expect(alertText).toContain('Bestätigung');
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
    expect(watchRepo.claimDue).toHaveBeenCalledTimes(2);
  });
});
