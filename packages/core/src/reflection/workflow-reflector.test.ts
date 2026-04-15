import { describe, it, expect, vi } from 'vitest';
import { WorkflowReflector } from './workflow-reflector.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as any;

const defaultConfig = {
  staleAfterDays: 30,
  failedStepsBeforeSuggest: 3,
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf1',
    name: 'Test Workflow',
    userId: 'user1',
    chatId: 'chat1',
    platform: 'telegram',
    steps: [],
    triggerType: 'manual',
    enabled: true,
    createdAt: new Date(Date.now() - 35 * 86400_000).toISOString(),
    ...overrides,
  };
}

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ex1',
    chainId: 'wf1',
    status: 'completed',
    stepsCompleted: 3,
    totalSteps: 3,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('WorkflowReflector', () => {
  it('flags stale workflow (never run, >30 days)', async () => {
    const workflowRepo = {
      findByUser: vi.fn().mockResolvedValue([makeWorkflow()]),
      getRecentExecutions: vi.fn().mockResolvedValue([]),
    } as any;
    const activityRepo = { query: vi.fn().mockResolvedValue([]) } as any;

    const reflector = new WorkflowReflector(workflowRepo, activityRepo, mockLogger, defaultConfig);
    const results = await reflector.reflect('user1');

    expect(results).toHaveLength(1);
    expect(results[0].target.type).toBe('workflow');
    expect(results[0].target.id).toBe('wf1');
    expect(results[0].action).toBe('suggest');
    expect(results[0].risk).toBe('confirm');
    expect(results[0].finding).toContain('nie ausgefuehrt');
  });

  it('flags workflow with repeated failures', async () => {
    const failures = Array.from({ length: 4 }, (_, i) =>
      makeExecution({ id: `ex${i}`, status: 'failed', error: 'step failed' }),
    );
    const workflowRepo = {
      findByUser: vi.fn().mockResolvedValue([makeWorkflow()]),
      getRecentExecutions: vi.fn().mockResolvedValue(failures),
    } as any;
    const activityRepo = { query: vi.fn().mockResolvedValue([]) } as any;

    const reflector = new WorkflowReflector(workflowRepo, activityRepo, mockLogger, defaultConfig);
    const results = await reflector.reflect('user1');

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('suggest');
    expect(results[0].risk).toBe('confirm');
    expect(results[0].finding).toContain('fehlgeschlagen');
  });

  it('returns empty for active healthy workflows', async () => {
    const executions = [
      makeExecution({ status: 'completed' }),
      makeExecution({ id: 'ex2', status: 'completed' }),
    ];
    const workflowRepo = {
      findByUser: vi.fn().mockResolvedValue([makeWorkflow()]),
      getRecentExecutions: vi.fn().mockResolvedValue(executions),
    } as any;
    const activityRepo = { query: vi.fn().mockResolvedValue([]) } as any;

    const reflector = new WorkflowReflector(workflowRepo, activityRepo, mockLogger, defaultConfig);
    const results = await reflector.reflect('user1');

    expect(results).toHaveLength(0);
  });

  it('returns empty when workflowRepo is undefined', async () => {
    const activityRepo = { query: vi.fn().mockResolvedValue([]) } as any;

    const reflector = new WorkflowReflector(undefined, activityRepo, mockLogger, defaultConfig);
    const results = await reflector.reflect('user1');

    expect(results).toHaveLength(0);
  });
});
