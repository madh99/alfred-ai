import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReasoningEngine } from '../reasoning-engine.js';

function createMockCalendarProvider() {
  return {
    listEvents: vi.fn().mockResolvedValue([
      { id: '1', title: 'Meeting', start: new Date('2026-03-11T10:00:00'), end: new Date('2026-03-11T11:00:00') },
      { id: '2', title: 'Arzttermin', start: new Date('2026-03-11T14:00:00'), end: new Date('2026-03-11T15:00:00'), location: 'Wien' },
    ]),
    timezone: 'Europe/Vienna',
  } as any;
}

function createMockTodoRepo() {
  return {
    getOverdue: vi.fn(() => [{ id: 't1', title: 'Steuererklärung', priority: 'high', dueDate: '2026-03-09T23:59:00Z' }]),
    getDueInWindow: vi.fn(() => [{ id: 't2', title: 'Einkaufen', priority: 'normal', dueDate: '2026-03-11T18:00:00Z' }]),
    list: vi.fn(() => [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
  } as any;
}

function createMockWatchRepo() {
  return {
    getEnabled: vi.fn(() => [{
      id: 'w1', name: 'RTX 5090', skillName: 'marketplace', intervalMinutes: 30,
      lastTriggeredAt: '2026-03-10T12:00:00Z', lastValue: '{"listings":[{"title":"RTX 5090","price":1899}]}',
    }]),
  } as any;
}

function createMockMemoryRepo() {
  return {
    getRecentForPrompt: vi.fn(() => [
      { type: 'fact', key: 'Heimadresse', value: 'Alleestraße 6, 3033 Altlengbach' },
      { type: 'preference', key: 'Automarke', value: 'BMW i4' },
    ]),
  } as any;
}

function createMockActivityRepo() {
  return {
    stats: vi.fn(() => [
      { eventType: 'skill_exec', outcome: 'success', count: 42 },
      { eventType: 'watch_trigger', outcome: 'success', count: 3 },
    ]),
  } as any;
}

function createMockSkillHealthRepo() {
  return {
    getDisabled: vi.fn(() => []),
  } as any;
}

function createMockNotifRepo() {
  return {
    wasNotified: vi.fn(() => false),
    markNotified: vi.fn(),
    cleanup: vi.fn(),
  } as any;
}

function createMockSkillRegistry() {
  return {
    has: vi.fn(() => false),
    get: vi.fn(() => undefined),
  } as any;
}

function createMockSkillSandbox() {
  return { execute: vi.fn() } as any;
}

function createMockLLM(response = 'KEINE_INSIGHTS') {
  return {
    complete: vi.fn().mockResolvedValue({ content: response }),
  } as any;
}

function createMockAdapter() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockUserRepo() {
  return {
    findById: vi.fn(() => ({ id: 'owner', platformUserId: 'owner' })),
    findOrCreate: vi.fn(() => ({ id: 'owner', platformUserId: 'owner' })),
    getMasterUserId: vi.fn(() => 'owner'),
    getLinkedUsers: vi.fn(() => []),
    getProfile: vi.fn(() => ({})),
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createEngine(overrides: {
  llmResponse?: string;
  config?: any;
  calendarProvider?: any;
  notifRepo?: any;
} = {}) {
  const adapter = createMockAdapter();
  const adapters = new Map([['telegram', adapter]]) as any;
  const llm = createMockLLM(overrides.llmResponse ?? 'KEINE_INSIGHTS');
  const notifRepo = overrides.notifRepo ?? createMockNotifRepo();

  const engine = new ReasoningEngine(
    'calendarProvider' in overrides ? overrides.calendarProvider : createMockCalendarProvider(),
    createMockTodoRepo(),
    createMockWatchRepo(),
    createMockMemoryRepo(),
    createMockActivityRepo(),
    createMockSkillHealthRepo(),
    notifRepo,
    createMockSkillRegistry(),
    createMockSkillSandbox(),
    llm,
    adapters,
    createMockUserRepo(),
    'owner-chat',
    'telegram' as any,
    overrides.config ?? { enabled: true, schedule: 'morning_noon_evening', tier: 'fast' },
    createMockLogger(),
  );

  return { engine, llm, adapter, notifRepo };
}

describe('ReasoningEngine', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should not start when disabled', () => {
    const { engine, llm } = createEngine({ config: { enabled: false } });
    engine.start();
    // Advance 2 hours — should never call LLM
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(llm.complete).not.toHaveBeenCalled();
    engine.stop();
  });

  it('should run at scheduled hours (morning_noon_evening)', async () => {
    // Set time to 06:59
    vi.setSystemTime(new Date('2026-03-11T06:59:00'));
    const { engine, llm } = createEngine();
    engine.start();

    // Advance to 07:00 — should trigger
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(llm.complete).toHaveBeenCalledTimes(1);

    // Advance to 07:01 — should NOT trigger again
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(llm.complete).toHaveBeenCalledTimes(1);

    engine.stop();
  });

  it('should send insights to user when LLM returns content', async () => {
    vi.setSystemTime(new Date('2026-03-11T11:59:00'));
    const insightText = 'Du hast einen Arzttermin in Wien um 14:00 und die RTX 5090 Watch zeigt ein Angebot in Wien — Abholung wäre auf dem Rückweg möglich.';
    const { engine, adapter, notifRepo } = createEngine({ llmResponse: insightText });
    engine.start();

    vi.advanceTimersByTime(60_000); // → 12:00
    await vi.runOnlyPendingTimersAsync();

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const sentMessage = adapter.sendMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain('Insights');
    expect(sentMessage).toContain('Arzttermin');
    expect(notifRepo.markNotified).toHaveBeenCalled();

    engine.stop();
  });

  it('should NOT send message when LLM returns KEINE_INSIGHTS', async () => {
    vi.setSystemTime(new Date('2026-03-11T11:59:00'));
    const { engine, adapter } = createEngine({ llmResponse: 'KEINE_INSIGHTS' });
    engine.start();

    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    engine.stop();
  });

  it('should deduplicate insights already sent', async () => {
    vi.setSystemTime(new Date('2026-03-11T11:59:00'));
    const notifRepo = createMockNotifRepo();
    notifRepo.wasNotified.mockReturnValue(true); // All insights already sent
    const { engine, adapter } = createEngine({
      llmResponse: 'Du solltest heute früher losfahren wegen Stau.',
      notifRepo,
    });
    engine.start();

    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    engine.stop();
  });

  it('should handle calendar provider being undefined', async () => {
    vi.setSystemTime(new Date('2026-03-11T06:59:00'));
    const { engine, llm } = createEngine({ calendarProvider: undefined });
    engine.start();

    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    // Should still call LLM (calendar section will say "nicht konfiguriert")
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const prompt = llm.complete.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('nicht konfiguriert');

    engine.stop();
  });

  it('should include all context sections in the prompt', async () => {
    vi.setSystemTime(new Date('2026-03-11T06:59:00'));
    const { engine, llm } = createEngine();
    engine.start();

    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    const prompt = llm.complete.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Kalender');
    expect(prompt).toContain('Offene Todos');
    expect(prompt).toContain('Aktive Watches');
    expect(prompt).toContain('Erinnerungen über den User');
    expect(prompt).toContain('Aktivität');
    expect(prompt).toContain('Wetter');
    expect(prompt).toContain('Energiepreise');
    expect(prompt).toContain('Skill-Status');
    // Verify data was collected
    expect(prompt).toContain('Meeting');
    expect(prompt).toContain('RTX 5090');
    expect(prompt).toContain('Steuererklärung');
    expect(prompt).toContain('Heimadresse');

    engine.stop();
  });
});
