import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerManager } from './trigger-manager.js';

// Mock matchesCron at module level
vi.mock('@alfred/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alfred/types')>();
  return { ...actual, matchesCron: vi.fn() };
});

import { matchesCron } from '@alfred/types';
const matchesCronMock = vi.mocked(matchesCron);

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    triggerType: 'cron',
    triggerConfig: { cron: '*/5 * * * *' },
    guards: undefined as unknown[] | undefined,
    lastTriggeredAt: undefined as string | undefined,
    enabled: true,
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger;
}

describe('TriggerManager', () => {
  let workflowRepo: {
    listTriggered: ReturnType<typeof vi.fn>;
    updateTriggerState: ReturnType<typeof vi.fn>;
  };
  let guardEvaluator: { evaluateAll: ReturnType<typeof vi.fn> };
  let runWorkflow: ReturnType<typeof vi.fn>;
  let logger: import('pino').Logger;
  let manager: TriggerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    workflowRepo = {
      listTriggered: vi.fn().mockResolvedValue([]),
      updateTriggerState: vi.fn().mockResolvedValue(undefined),
    };
    guardEvaluator = { evaluateAll: vi.fn().mockResolvedValue(true) };
    runWorkflow = vi.fn().mockResolvedValue(undefined);
    logger = makeLogger();
    manager = new TriggerManager(
      workflowRepo as never,
      guardEvaluator as never,
      runWorkflow,
      logger,
    );
  });

  it('runs cron-triggered workflow when cron matches', async () => {
    matchesCronMock.mockReturnValue(true);
    workflowRepo.listTriggered.mockResolvedValue([makeWorkflow()]);

    await manager.tick();

    expect(workflowRepo.updateTriggerState).toHaveBeenCalledWith('wf-1', expect.any(String));
    expect(runWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({ triggerType: 'cron' }));
  });

  it('skips cron workflow when cron does not match', async () => {
    matchesCronMock.mockReturnValue(false);
    workflowRepo.listTriggered.mockResolvedValue([makeWorkflow()]);

    await manager.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('runs interval-triggered workflow when interval elapsed', async () => {
    const pastTime = new Date(Date.now() - 31 * 60_000).toISOString(); // 31 min ago
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({
        triggerType: 'interval',
        triggerConfig: { minutes: 30 },
        lastTriggeredAt: pastTime,
      }),
    ]);

    await manager.tick();

    expect(runWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({ triggerType: 'interval' }));
  });

  it('skips interval workflow when interval not yet elapsed', async () => {
    const recentTime = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({
        triggerType: 'interval',
        triggerConfig: { minutes: 30 },
        lastTriggeredAt: recentTime,
      }),
    ]);

    await manager.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('skips workflow when guard fails', async () => {
    matchesCronMock.mockReturnValue(true);
    guardEvaluator.evaluateAll.mockResolvedValue(false);
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({ guards: [{ type: 'weekday', value: 'mon' }] }),
    ]);

    await manager.tick();

    expect(guardEvaluator.evaluateAll).toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('skips manual workflows', async () => {
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({ triggerType: 'manual' }),
    ]);

    await manager.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('onWebhook triggers registered workflow', async () => {
    manager.registerWebhook('deploy-hook', 'wf-2');

    await manager.onWebhook('deploy-hook', { ref: 'main' });

    expect(runWorkflow).toHaveBeenCalledWith('wf-2', expect.objectContaining({
      triggerType: 'webhook',
      webhookName: 'deploy-hook',
      body: { ref: 'main' },
    }));
  });

  it('onWebhook does nothing for unregistered webhook', async () => {
    await manager.onWebhook('unknown', {});
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('onWatchTriggered triggers matching workflow', async () => {
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({ triggerType: 'watch', triggerConfig: { watchId: 'sensor-temp' } }),
    ]);

    await manager.onWatchTriggered('sensor-temp', 42);

    expect(runWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
      triggerType: 'watch',
      watchId: 'sensor-temp',
      watchValue: 42,
    }));
  });

  it('deregisterWebhook removes webhook mapping', async () => {
    manager.registerWebhook('hook-1', 'wf-3');
    manager.deregisterWebhook('hook-1');

    await manager.onWebhook('hook-1', {});
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('prevents cron double-fire within same minute', async () => {
    matchesCronMock.mockReturnValue(true);
    const justNow = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    workflowRepo.listTriggered.mockResolvedValue([
      makeWorkflow({ lastTriggeredAt: justNow }),
    ]);

    await manager.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
  });
});
