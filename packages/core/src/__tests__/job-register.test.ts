import { describe, it, expect, vi } from 'vitest';
import { JobRegister, istJobFaellig } from '../lebenszeichen/job-register.js';

// Jarvis Schicht 0 — Lebenszeichen. Realfälle: KG-Wartung 16 Tage tot wegen
// Stunden-Timer mit Minuten-Fenster (v1158); ITSM-Block nie registriert (v1154);
// Nachtjobs liefen für 8 Login-Aliase statt 2 Menschen (v1159).

const um = (h: number, m: number, tag = 28) => new Date(2026, 8, tag, h, m, 0);

function makeRegister(now: () => Date, opts: { slotFrei?: boolean } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  const runs = { start: vi.fn(async () => 'run-1'), finish: vi.fn(async () => undefined) };
  const claimSlot = vi.fn(async () => opts.slotFrei ?? true);
  const reg = new JobRegister({
    logger: log as never, nodeId: 'test',
    listMasters: async () => [{ id: 'master-a' }, { id: 'master-b' }],
    listAll: async () => [{ id: 'master-a' }, { id: 'master-b' }, { id: 'alias-1' }, { id: 'alias-2' }],
    claimSlot, runs, now,
  });
  return { reg, log, runs, claimSlot };
}

describe('istJobFaellig', () => {
  it('täglich: Realfall 04:28 nicht, 04:30 ja, am selben Tag nie zweimal', () => {
    const takt = { art: 'taeglich' as const, um: '04:30' };
    expect(istJobFaellig(takt, um(4, 28), { zuletztTag: '' })).toBeNull();
    expect(istJobFaellig(takt, um(4, 30), { zuletztTag: '' })).toBe('2026-09-28');
    expect(istJobFaellig(takt, um(21, 0), { zuletztTag: '2026-09-28' })).toBeNull();
  });

  it('wöchentlich: nur am Zieltag', () => {
    const takt = { art: 'woechentlich' as const, tag: 0, um: '19:15' };
    expect(istJobFaellig(takt, um(19, 20, 27), { zuletztTag: "" })).not.toBeNull(); // 27.09.2026 = Sonntag
    expect(istJobFaellig(takt, um(19, 20, 28), { zuletztTag: "" })).toBeNull();     // 28.09.2026 = Montag
  });

  it('intervall: nach Ablauf der Minuten wieder fällig', () => {
    const takt = { art: 'intervall' as const, minuten: 30 };
    const t0 = um(10, 0);
    expect(istJobFaellig(takt, t0, { zuletztTag: '' })).not.toBeNull();
    expect(istJobFaellig(takt, um(10, 20), { zuletztTag: '', zuletztMs: t0.getTime() })).toBeNull();
    expect(istJobFaellig(takt, um(10, 30), { zuletztTag: '', zuletztMs: t0.getTime() })).not.toBeNull();
  });

  it('intervall 10 min auf dem 10-min-Raster: 29 s zu früh gilt noch als fällig (Jitter), 31 s nicht', () => {
    const takt = { art: 'intervall' as const, minuten: 10 };
    const t0 = um(10, 0).getTime();
    expect(istJobFaellig(takt, new Date(t0 + 10 * 60_000 - 29_000), { zuletztTag: '', zuletztMs: t0 })).not.toBeNull();
    expect(istJobFaellig(takt, new Date(t0 + 10 * 60_000 - 31_000), { zuletztTag: '', zuletztMs: t0 })).toBeNull();
  });
});

describe('JobRegister', () => {
  it('Registrierung loggt; Lauf je Master (nicht je Alias) mit job_runs-Eintrag und Zählern', async () => {
    let now = um(4, 35);
    const { reg, log, runs } = makeRegister(() => now);
    const run = vi.fn(async ({ userId }: { userId: string | null }) => ({ ok: true, zaehler: { junk: userId === 'master-a' ? 3 : 0 } }));
    reg.registriere({ key: 'kg-maintenance', beschreibung: 'Test', takt: { art: 'taeglich', um: '04:30' }, bereich: 'master', slot: true, run });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ job: 'kg-maintenance' }), 'Lebenszeichen: Job registriert');

    await reg.tick(now);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(c => c[0].userId)).toEqual(['master-a', 'master-b']);
    expect(runs.start).toHaveBeenCalledTimes(2);
    expect(runs.finish).toHaveBeenCalledWith('run-1', true, { junk: 3 }, undefined);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ job: 'kg-maintenance', users: 2, junk: 3 }), 'Lebenszeichen: Job gelaufen');

    // Zweiter Tick am selben Tag: kein zweiter Lauf
    now = um(5, 5);
    await reg.tick(now);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Nachholen: Restart um 21:28 → der Tageslauf wird einmalig nachgeholt', async () => {
    const { reg } = makeRegister(() => um(21, 28));
    const run = vi.fn(async () => ({ ok: true }));
    reg.registriere({ key: 'consolidation', beschreibung: 'Test', takt: { art: 'taeglich', um: '03:00' }, bereich: 'master', run });
    await reg.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Slot von anderem Node → kein Lauf, aber Tag gilt als erledigt', async () => {
    const { reg, claimSlot } = makeRegister(() => um(4, 35), { slotFrei: false });
    const run = vi.fn(async () => ({ ok: true }));
    reg.registriere({ key: 'kg-maintenance', beschreibung: 'Test', takt: { art: 'taeglich', um: '04:30' }, bereich: 'master', slot: true, run });
    await reg.tick();
    expect(claimSlot).toHaveBeenCalledWith('kg-maintenance:2026-09-28');
    expect(run).not.toHaveBeenCalled();
  });

  it('Fehler eines Users bricht die anderen nicht ab und landet in job_runs + Warn-Log', async () => {
    const { reg, log, runs } = makeRegister(() => um(4, 35));
    const run = vi.fn(async ({ userId }: { userId: string | null }) => { if (userId === 'master-a') throw new Error('kaputt'); return { ok: true }; });
    reg.registriere({ key: 'pattern-analysis', beschreibung: 'Test', takt: { art: 'taeglich', um: '03:30' }, bereich: 'master', run });
    await reg.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(runs.finish).toHaveBeenCalledWith('run-1', false, undefined, 'kaputt');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ job: 'pattern-analysis', ok: 1, fehler: ['kaputt'] }), 'Lebenszeichen: Job fehlgeschlagen');
  });

  it('global-Jobs laufen genau einmal ohne User; doppelte Schlüssel werden abgewiesen', async () => {
    const { reg } = makeRegister(() => um(10, 0));
    const run = vi.fn(async (_ctx: { userId: string | null }) => ({ ok: true }));
    reg.registriere({ key: 'probe', beschreibung: 'Test', takt: { art: 'intervall', minuten: 30 }, bereich: 'global', run });
    expect(() => reg.registriere({ key: 'probe', beschreibung: 'Dup', takt: { art: 'intervall', minuten: 5 }, bereich: 'global', run })).toThrow(/doppelt/);
    await reg.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ userId: null });
  });
});
