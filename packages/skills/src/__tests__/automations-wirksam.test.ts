import { describe, it, expect, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { extrahiereFeldPfad, sammleFeldPfade } from '../feld-pfade.js';
import { WatchSkill } from '../built-in/watch.js';
import { WorkflowSkill } from '../built-in/workflow.js';
import { ScheduledTaskSkill } from '../built-in/scheduled-task.js';

// v1147 — M/L-Pakete: Watches, die WIRKEN (39/40 triggerten nie — geratene
// Felder), erreichbare Workflow-Trigger (2 Workflows, 0 automatische Läufe je)
// und Scheduled-Generationen, die ersetzt statt danebengelegt werden.

const CTX: SkillContext = { userId: 'u1', chatId: 'c1', platform: 'test', conversationId: 'cv1' } as SkillContext;

describe('Feld-Pfade', () => {
  const daten = { status: { online: false, seit: '2026-08-01' }, soc: 24, alerts: [{ level: 'warn' }] };

  it('extrahiereFeldPfad: verschachtelt, Array-Index, length, fehlend', () => {
    expect(extrahiereFeldPfad(daten, 'status.online')).toBe(false);
    expect(extrahiereFeldPfad(daten, 'soc')).toBe(24);
    expect(extrahiereFeldPfad(daten, 'alerts.length')).toBe(1);
    expect(extrahiereFeldPfad(daten, 'alerts.0.level')).toBe('warn');
    expect(extrahiereFeldPfad(daten, 'api_status')).toBe(undefined);
  });

  it('sammleFeldPfade liefert die echten Pfade', () => {
    const pfade = sammleFeldPfade(daten);
    expect(pfade).toContain('soc');
    expect(pfade).toContain('status.online');
    expect(pfade).toContain('alerts.length');
    expect(pfade).toContain('alerts.0.level');
  });
});

function makeWatchHarness(existing: Array<Record<string, unknown>> = []) {
  const created: Array<Record<string, unknown>> = [];
  const watchRepo = {
    create: vi.fn(async (w: Record<string, unknown>) => { const x = { ...w, id: 'w-neu' }; created.push(x); return x; }),
    findByChatId: vi.fn(async () => existing),
    getById: vi.fn(async () => undefined),
  } as never;
  const registry = {
    get: (name: string) => name === 'bmw' ? { metadata: { name: 'bmw', inputSchema: { type: 'object', properties: {} } } } : undefined,
  } as never;
  const sandbox = {
    execute: vi.fn(async () => ({ success: true, data: { status: { online: false }, soc: 24 } })),
  } as never;
  const skill = new WatchSkill(watchRepo, registry);
  skill.setSkillSandbox(sandbox);
  return { skill, created, sandbox };
}

describe('M1 — Watch-Anlage-Probe (Realfall: geratenes Feld)', () => {
  it('geratenes Feld → Fehler MIT der Liste der echten Felder, nichts angelegt', async () => {
    const { skill, created } = makeWatchHarness();
    const r = await skill.execute({
      action: 'create', name: 'BMW API Offline Alert', skill_name: 'bmw',
      condition_field: 'api_status', condition_operator: 'eq', condition_value: 'offline',
    }, CTX);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('"api_status" existiert nicht');
    expect(String(r.error)).toContain('status.online');
    expect(created.length).toBe(0);
  });

  it('korrektes Feld → Watch wird angelegt', async () => {
    const { skill, created } = makeWatchHarness();
    const r = await skill.execute({
      action: 'create', name: 'BMW SoC niedrig', skill_name: 'bmw',
      condition_field: 'soc', condition_operator: 'lt', condition_value: 20,
    }, CTX);
    expect(r.success).toBe(true);
    expect(created.length).toBe(1);
  });
});

describe('M3 — Watch-Dedup über Bedingungs-Identität (Realfall: 9× „BMW API Offline Alert")', () => {
  it('gleiche Skill+Feld+Operator-Identität wird als Duplikat abgewiesen', async () => {
    const { skill, created } = makeWatchHarness([
      { id: 'w-alt', name: 'BMW API Offline Alarm (60 Min)', enabled: true, skillName: 'bmw', skillParams: {}, condition: { field: 'soc', operator: 'lt' } },
    ]);
    const r = await skill.execute({
      action: 'create', name: 'Völlig anderer Name', skill_name: 'bmw',
      condition_field: 'soc', condition_operator: 'lt', condition_value: 15,
    }, CTX);
    expect(r.success).toBe(true);
    expect((r.data as { duplicate?: boolean }).duplicate).toBe(true);
    expect(created.length).toBe(0);
  });
});

describe('L1/L2 — Workflow-Trigger erreichbar + direkt aktiv', () => {
  function makeWorkflowHarness() {
    const created: Array<Record<string, unknown>> = [];
    const repo = { create: vi.fn(async (c: Record<string, unknown>) => { const x = { ...c, id: 'wf1' }; created.push(x); return x; }) } as never;
    const registry = { get: (n: string) => n === 'email' ? { metadata: { name: 'email', inputSchema: { type: 'object', properties: {} } } } : undefined } as never;
    return { skill: new WorkflowSkill(repo, registry), created };
  }
  const steps = [{ skillName: 'email', inputMapping: { action: 'inbox' }, onError: 'stop' }];

  it('cron ohne Konfiguration → klarer Fehler', async () => {
    const { skill } = makeWorkflowHarness();
    const r = await skill.execute({ action: 'create', name: 'Morgens-Check', steps, trigger_type: 'cron' }, CTX);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('Cron-Ausdruck');
  });

  it('cron mit Konfiguration → Workflow AKTIV mit Trigger angelegt', async () => {
    const { skill, created } = makeWorkflowHarness();
    const r = await skill.execute({
      action: 'create', name: 'Morgens-Check', steps,
      trigger_type: 'cron', trigger_config: { value: '0 7 * * *' },
    }, CTX);
    expect(r.success).toBe(true);
    expect(created[0].triggerType).toBe('cron');
    expect(created[0].enabled).toBe(true);
    expect(String(r.display)).toContain('AUTOMATISCH');
  });

  it('unbekannter Trigger-Typ wird abgelehnt', async () => {
    const { skill } = makeWorkflowHarness();
    const r = await skill.execute({ action: 'create', name: 'X', steps, trigger_type: 'täglich' }, CTX);
    expect(r.success).toBe(false);
  });
});

describe('L4 — Scheduled-Task: Generationen ersetzen (Realfall: doppelte aWATTar-Crons)', () => {
  function makeRepo() {
    const actions: Array<Record<string, unknown>> = [];
    return {
      actions,
      repo: {
        create: vi.fn(async (d: Record<string, unknown>) => { const a = { ...d, id: `a${actions.length + 1}`, enabled: true, nextRunAt: null, createdAt: 'x' }; actions.push(a); return a; }),
        getByUser: vi.fn(async () => actions),
        setEnabled: vi.fn(async (id: string, e: boolean) => { const a = actions.find(x => x.id === id); if (a) a.enabled = e; return !!a; }),
      } as never,
    };
  }

  it('gleicher Name → alte Generation wird deaktiviert und benannt', async () => {
    const { repo, actions } = makeRepo();
    const skill = new ScheduledTaskSkill(repo);
    await skill.execute({ action: 'create', name: 'aWATTar Check', description: 'd', schedule_type: 'cron', schedule_value: '0 7 * * *', skill_name: 'email' }, CTX);
    const r2 = await skill.execute({ action: 'create', name: 'awattar check', description: 'd2', schedule_type: 'cron', schedule_value: '0 8 * * *', skill_name: 'email' }, CTX);
    expect(r2.success).toBe(true);
    expect(String(r2.display)).toContain('♻️');
    expect(actions[0].enabled).toBe(false);
    expect(actions[1].enabled).toBe(true);
  });

  it('gleicher Skill+Zeitplan unter anderem Namen → ebenfalls ersetzt', async () => {
    const { repo, actions } = makeRepo();
    const skill = new ScheduledTaskSkill(repo);
    await skill.execute({ action: 'create', name: 'Alt', description: 'd', schedule_type: 'cron', schedule_value: '0 7 * * *', skill_name: 'email' }, CTX);
    await skill.execute({ action: 'create', name: 'Neu v2', description: 'd', schedule_type: 'cron', schedule_value: '0 7 * * *', skill_name: 'email' }, CTX);
    expect(actions[0].enabled).toBe(false);
  });
});
