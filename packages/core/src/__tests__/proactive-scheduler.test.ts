import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProactiveScheduler } from '../proactive-scheduler.js';

function createMockActionRepo(actions: any[] = []) {
  return {
    claimDue: vi.fn(() => actions),
    updateLastRun: vi.fn(),
    setEnabled: vi.fn(),
  } as any;
}

function createMockSkillRegistry(skills: Record<string, any> = {}) {
  return {
    has: vi.fn((name: string) => name in skills),
    get: vi.fn((name: string) => skills[name]),
    getAll: vi.fn(() => Object.values(skills)),
  } as any;
}

function createMockSkillSandbox() {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, data: {}, display: 'result' }),
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createMockLLM() {
  return {
    complete: vi.fn().mockResolvedValue({ content: 'LLM response' }),
  } as any;
}

function createMockUsers() {
  return {
    findById: vi.fn(() => ({ id: 'user-1', platformUserId: 'plat-1', username: 'test' })),
    findOrCreate: vi.fn(() => ({ id: 'user-1', platformUserId: 'plat-1' })),
    getMasterUserId: vi.fn(() => 'master-1'),
    getLinkedUsers: vi.fn(() => []),
    getProfile: vi.fn(() => ({})),
  } as any;
}

describe('ProactiveScheduler', () => {
  let scheduler: ProactiveScheduler;
  let actionRepo: ReturnType<typeof createMockActionRepo>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start/stop — interval is set and cleared', () => {
    actionRepo = createMockActionRepo();
    logger = createMockLogger();
    scheduler = new ProactiveScheduler(
      actionRepo, createMockSkillRegistry(), createMockSkillSandbox(),
      createMockLLM(), new Map(), createMockUsers(), logger,
    );

    scheduler.start();
    expect(logger.info).toHaveBeenCalledWith('Proactive scheduler started');

    scheduler.stop();
    expect(logger.info).toHaveBeenCalledWith('Proactive scheduler stopped');
  });

  it('tick executes due actions with skill path', async () => {
    const mockSkill = { metadata: { name: 'test-skill' } };
    const skillRegistry = createMockSkillRegistry({ 'test-skill': mockSkill });
    const sandbox = createMockSkillSandbox();
    const adapter = { sendMessage: vi.fn().mockResolvedValue('msg-1'), status: 'connected' };
    const adapters = new Map([['telegram', adapter]]) as any;

    actionRepo = createMockActionRepo([{
      id: 'action-1',
      name: 'Test Action',
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'chat-1',
      skillName: 'test-skill',
      skillInput: '{}',
      scheduleType: 'once',
      scheduleValue: '',
    }]);

    scheduler = new ProactiveScheduler(
      actionRepo, skillRegistry, sandbox, createMockLLM(),
      adapters, createMockUsers(), createMockLogger(),
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(actionRepo.claimDue).toHaveBeenCalled();
    expect(sandbox.execute).toHaveBeenCalled();
  });

  it('tick skips non-due actions (empty claimDue)', async () => {
    actionRepo = createMockActionRepo([]);
    const sandbox = createMockSkillSandbox();

    scheduler = new ProactiveScheduler(
      actionRepo, createMockSkillRegistry(), sandbox, createMockLLM(),
      new Map(), createMockUsers(), createMockLogger(),
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(actionRepo.claimDue).toHaveBeenCalled();
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it('error in action does not stop the scheduler', async () => {
    logger = createMockLogger();
    const sandbox = createMockSkillSandbox();
    sandbox.execute.mockRejectedValue(new Error('Skill failed'));
    const mockSkill = { metadata: { name: 'failing-skill' } };

    actionRepo = createMockActionRepo([{
      id: 'action-err',
      name: 'Failing',
      userId: 'user-1',
      platform: 'telegram',
      chatId: 'chat-1',
      skillName: 'failing-skill',
      skillInput: '{}',
      scheduleType: 'once',
      scheduleValue: '',
    }]);

    scheduler = new ProactiveScheduler(
      actionRepo, createMockSkillRegistry({ 'failing-skill': mockSkill }), sandbox,
      createMockLLM(), new Map(), createMockUsers(), logger,
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    // Scheduler should still be running — tick again without crashing
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actionRepo.claimDue).toHaveBeenCalledTimes(2);
  });
});
