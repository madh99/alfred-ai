import { describe, it, expect, vi } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import type { ReflectionResult } from './types.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as any;

function makeResult(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return {
    target: { type: 'watch', id: 'w1', name: 'Test Watch' },
    finding: 'Watch is stale',
    action: 'adjust',
    params: { intervalMinutes: 60 },
    risk: 'auto',
    reasoning: 'No triggers in 14 days',
    ...overrides,
  };
}

function createExecutor(opts: {
  watchRepo?: any;
  workflowRepo?: any;
  adapter?: any;
  sendMessage?: ReturnType<typeof vi.fn>;
} = {}) {
  const sendMessage = opts.sendMessage ?? vi.fn().mockResolvedValue('msg1');
  const messagingAdapter = { sendMessage } as any;
  const adapters = new Map([['telegram', messagingAdapter]]) as any;

  const watchRepo = opts.watchRepo ?? {
    updateSettings: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    toggle: vi.fn().mockResolvedValue(true),
  };

  return {
    executor: new ActionExecutor(
      watchRepo,
      opts.workflowRepo,
      opts.adapter,
      adapters,
      'chat1',
      'telegram' as any,
      mockLogger,
    ),
    watchRepo,
    sendMessage,
  };
}

describe('ActionExecutor', () => {
  it('executes auto actions silently (no user notification)', async () => {
    const { executor, watchRepo, sendMessage } = createExecutor();

    await executor.execute([
      makeResult({ risk: 'auto', action: 'adjust', params: { intervalMinutes: 60 } }),
    ]);

    expect(watchRepo.updateSettings).toHaveBeenCalledWith('w1', { intervalMinutes: 60 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('executes proactive actions and notifies user', async () => {
    const { executor, watchRepo, sendMessage } = createExecutor();

    await executor.execute([
      makeResult({ risk: 'proactive', action: 'delete', reasoning: 'Watch unused for 30 days' }),
    ]);

    expect(watchRepo.delete).toHaveBeenCalledWith('w1');
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Selbst-Optimierung'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Watch unused for 30 days'),
    );
  });

  it('sends confirm actions as suggestions without executing', async () => {
    const { executor, watchRepo, sendMessage } = createExecutor();

    await executor.execute([
      makeResult({
        risk: 'confirm',
        action: 'delete',
        target: { type: 'watch', id: 'w2', name: 'Price Alert' },
        finding: 'Never triggered',
        reasoning: 'Consider removing',
      }),
    ]);

    expect(watchRepo.delete).not.toHaveBeenCalled();
    expect(watchRepo.updateSettings).not.toHaveBeenCalled();
    expect(watchRepo.toggle).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Vorschlag'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Price Alert'),
    );
  });

  it('handles mixed results (auto + proactive + confirm)', async () => {
    const workflowRepo = {
      toggle: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };
    const dbAdapter = {
      execute: vi.fn().mockResolvedValue({ changes: 1 }),
    };
    const { executor, watchRepo, sendMessage } = createExecutor({
      workflowRepo,
      adapter: dbAdapter,
    });

    await executor.execute([
      // auto: adjust watch
      makeResult({ risk: 'auto', action: 'adjust', params: { intervalMinutes: 120 } }),
      // proactive: deactivate workflow
      makeResult({
        risk: 'proactive',
        action: 'deactivate',
        target: { type: 'workflow', id: 'wf1', name: 'Broken Flow' },
        reasoning: 'Workflow failing repeatedly',
      }),
      // confirm: delete reminder suggestion
      makeResult({
        risk: 'confirm',
        action: 'delete',
        target: { type: 'reminder', id: 'r1', name: 'Old Reminder' },
        finding: 'Reminder dismissed 5 times',
        reasoning: 'Seems unnecessary',
      }),
    ]);

    // auto executed silently
    expect(watchRepo.updateSettings).toHaveBeenCalledWith('w1', { intervalMinutes: 120 });

    // proactive executed + notified
    expect(workflowRepo.toggle).toHaveBeenCalledWith('wf1', false);
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Selbst-Optimierung'),
    );

    // confirm: NOT executed, only suggested
    expect(dbAdapter.execute).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.stringContaining('Vorschlag'),
    );

    // 2 calls total: 1 proactive notification + 1 confirm suggestion
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
