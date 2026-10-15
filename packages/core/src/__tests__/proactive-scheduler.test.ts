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

  it('v1447 Ergebnis aus einem Owner-Faden geht über den Faden-Hook, nicht an die rohe Sitzung', async () => {
    for (const zustaendig of [true, false]) {
      const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), status: 'connected' };
      const repo = createMockActionRepo([{ id: 'a1', name: 'Mac-Angebote', userId: 'user-1', platform: 'api', chatId: 'sitzung:g1:mv55pltv', skillName: 'test-skill', skillInput: '{}', scheduleType: 'once', scheduleValue: '' }]);
      const hook = vi.fn().mockResolvedValue(zustaendig);
      const s = new ProactiveScheduler(repo, createMockSkillRegistry({ 'test-skill': { metadata: { name: 'test-skill' } } }), createMockSkillSandbox(), createMockLLM(), new Map([['api', adapter]]) as any, createMockUsers(), createMockLogger());
      s.setFadenZustellung(hook);
      s.start();
      await vi.advanceTimersByTimeAsync(60_000);
      s.stop();
      expect(hook).toHaveBeenCalledWith('sitzung:g1:mv55pltv', expect.stringMatching(/^⏰ Geplante Aufgabe „Mac-Angebote“\n\n/), 'Mac-Angebote'); // v1459 Kopfzeile auch im Faden
      expect(adapter.sendMessage).toHaveBeenCalledTimes(zustaendig ? 0 : 1);
    }
  });

  it('v1449 Prüfauftrag: Rahmen mit Stand, Nachforderung bei „Notiz gespeichert“, Stand fortgeschrieben, Bericht ohne Stand-Block zugestellt', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), status: 'connected' };
    const repo = createMockActionRepo([{ id: 'a1', name: 'Mac-Angebote', userId: 'user-1', platform: 'telegram', chatId: 'c1', skillName: 'llm_prompt', skillInput: '{}', promptTemplate: 'Prüfe täglich live Willhaben-Angebote … Preisänderungen hervorheben', stand: '789898944 | 2400 EUR | online', standZeit: '2026-10-14T07:00:24Z', scheduleType: 'once', scheduleValue: '' }]);
    repo.setzeStand = vi.fn().mockResolvedValue(undefined);
    const texte: string[] = [];
    const voll = 'Änderungen: 789898944 Preis 2400 → 2300 EUR. ' + 'Übersicht … '.repeat(15) + '\n<<<STAND\n789898944 | 2300 EUR | online\nSTAND>>>';
    const pipeline = { process: vi.fn().mockImplementation(async (m: any) => { texte.push(m.text); return { text: texte.length === 1 ? 'Die Notiz mit dem Prüfstand ist gespeichert. Keine Käufe und keine Verkäuferkontakte.' : voll }; }) } as any;
    const s = new ProactiveScheduler(repo, createMockSkillRegistry(), createMockSkillSandbox(), createMockLLM(), new Map([['telegram', adapter]]) as any, createMockUsers(), createMockLogger(), pipeline);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    s.stop();
    expect(pipeline.process).toHaveBeenCalledTimes(2);
    expect(texte[0]).toContain('Letzter Stand (vom 14.10., 09:00):\n789898944 | 2400 EUR | online');
    expect(texte[0]).toContain('ist NICHT „weg“');
    expect(texte[1]).toContain('vorige Versuch dieses Laufs lieferte keinen vollständigen Bericht');
    expect(repo.setzeStand).toHaveBeenCalledWith('a1', '789898944 | 2300 EUR | online');
    const gesendet = String(adapter.sendMessage.mock.calls[0]?.[1] ?? '');
    expect(gesendet).toContain('2400 → 2300');
    expect(gesendet).not.toContain('<<<STAND');
  });

  it('v1449 Prüfauftrag bleibt unvollständig: ehrliche Meldung, Stand bleibt', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), status: 'connected' };
    const repo = createMockActionRepo([{ id: 'a2', name: 'Mac-Angebote', userId: 'user-1', platform: 'telegram', chatId: 'c1', skillName: 'llm_prompt', skillInput: '{}', promptTemplate: 'Prüfe täglich die Angebote, neue Treffer und Preisänderungen', scheduleType: 'once', scheduleValue: '' }]);
    repo.setzeStand = vi.fn();
    const pipeline = { process: vi.fn().mockResolvedValue({ text: 'Notiz gespeichert.' }) } as any;
    const s = new ProactiveScheduler(repo, createMockSkillRegistry(), createMockSkillSandbox(), createMockLLM(), new Map([['telegram', adapter]]) as any, createMockUsers(), createMockLogger(), pipeline);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    s.stop();
    expect(repo.setzeStand).not.toHaveBeenCalled();
    expect(String(adapter.sendMessage.mock.calls[0]?.[1] ?? '')).toContain('⚠️ Prüflauf „Mac-Angebote“ unvollständig: Bericht und neuer Stand fehlt');
  });

  it('v1450 Gespräch bekommt Markdown mit Kopfzeile, Telegram die HTML-Fassung', async () => {
    const adapter = { sendMessage: vi.fn().mockResolvedValue('m'), status: 'connected' };
    const repo = createMockActionRepo([{ id: 'a3', name: 'aWATTar Rechnung', userId: 'user-1', platform: 'telegram', chatId: 'c1', skillName: 'llm_prompt', skillInput: '{}', promptTemplate: 'Schau nach einer neuen Rechnung', scheduleType: 'once', scheduleValue: '' }]);
    const pipeline = { process: vi.fn().mockResolvedValue({ text: '**Neue Rechnung:** Nein' }) } as any;
    const formatter = { format: vi.fn((t: string) => ({ text: t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'), parseMode: 'html' })) } as any;
    const conv = { getOrCreateConversation: vi.fn().mockResolvedValue({ id: 'conv' }), addMessage: vi.fn(), pruneMessages: vi.fn() } as any;
    const s = new ProactiveScheduler(repo, createMockSkillRegistry(), createMockSkillSandbox(), createMockLLM(), new Map([['telegram', adapter]]) as any, createMockUsers(), createMockLogger(), pipeline, formatter, conv);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    s.stop();
    expect(String(adapter.sendMessage.mock.calls[0]?.[1])).toContain('<b>Neue Rechnung:</b>');
    const gespeichert = conv.addMessage.mock.calls.find((c: unknown[]) => c[0] === 'conv')?.[2];
    expect(gespeichert).toBe('⏰ Geplante Aufgabe „aWATTar Rechnung“\n\n**Neue Rechnung:** Nein');
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
