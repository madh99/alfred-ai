import { describe, it, expect } from 'vitest';
import { ProjektAktenUeberProjekte, sitzungsZusammenfassung, akteAusProjekt } from '../projekt/akten-projekte.js';
import { ProjectSkill } from '@alfred/skills';
import type { SkillContext } from '@alfred/types';

// v1399 — Geräte-Projekte im vorhandenen Projekt-System (Owner 12.10.: „ja wie vorgeschlagen machen")
function fakeRepo() {
  const projekte: Array<Record<string, unknown>> = [];
  const sitzungen: Array<Record<string, unknown>> = [];
  const repo = {
    list: async (_u: string, f: { nurGeraete?: boolean }) => projekte.filter(p => !f.nurGeraete || p.geraetId),
    findByGeraetPfad: async (_u: string, g: string, pfad: string) => projekte.find(p => p.geraetId === g && p.cwd === pfad) ?? null,
    create: async (u: string, i: Record<string, unknown>) => { const p = { id: `p${projekte.length + 1}`, userId: u, createdAt: 'c', lastActiveAt: 'l', ...i, status: i.status ?? 'active' }; projekte.push(p); return p; },
    update: async (_u: string, id: string, patch: Record<string, unknown>) => { Object.assign(projekte.find(p => p.id === id)!, patch); return null; },
    updateGeraet: async (id: string, f: Record<string, unknown>) => { const p = projekte.find(x => x.id === id)!; if (f.geraet !== undefined) p.geraet = f.geraet; if (f.pruefBefehle !== undefined) p.pruefBefehle = f.pruefBefehle; },
    touch: async () => undefined,
    findSessionBySource: async (_t: string, src: string) => sitzungen.find(x => x.sourceId === src) ?? null,
    createSession: async (pid: string, i: Record<string, unknown>) => { const x = { id: `s${sitzungen.length + 1}`, projectId: pid, ...i }; sitzungen.push(x); return x; },
    updateSessionSummary: async (id: string, summary: unknown, endedAt?: string) => { Object.assign(sitzungen.find(x => x.id === id)!, { summary, endedAt }); },
  };
  return { repo, projekte, sitzungen };
}
const lauf = { id: 'sat-1', ziel: 'Merkliste', plan: ['A', 'B'], erledigt: [{ nr: 1, ok: true }], status: 'laeuft', kostenUsd: 1.5 };

describe('Akten über das Projekt-System', () => {
  it('anlegen als Geräte-Projekt (Pfad ohne Schrägstrich am Ende, Tag geraet), finden, archivieren', async () => {
    const { repo, projekte } = fakeRepo();
    const a = new ProjektAktenUeberProjekte(repo as never);
    const akte = await a.anlegen({ userId: 'u', name: 'Angebots-Radar', geraetId: 'g1', geraet: 'Ubuntu-VM', pfad: '/home/madh/game/', pruefBefehle: ['npm test'] });
    expect(projekte[0]).toMatchObject({ name: 'Angebots-Radar', cwd: '/home/madh/game', geraetId: 'g1', tags: ['geraet'], pruefBefehle: ['npm test'] });
    expect((await a.findePfad('u', 'g1', '/home/madh/game'))?.id).toBe(akte.id);
    await a.aendern('u', akte.id, { status: 'archiviert', geraet: 'VM' });
    expect(projekte[0]).toMatchObject({ status: 'archived', geraet: 'VM' });
    expect(await a.liste('u')).toEqual([]);
    expect((await a.liste('u', true))[0]!.status).toBe('archiviert');
  });
  it('Lauf = Projekt-Sitzung: einmal angelegt, solange er läuft nicht beendet, beim Ende zusammengefasst', async () => {
    const { repo, sitzungen } = fakeRepo();
    const a = new ProjektAktenUeberProjekte(repo as never);
    await a.sitzung('p1', lauf, 1000);
    await a.sitzung('p1', lauf, 1000);
    expect(sitzungen).toHaveLength(1);
    expect(sitzungen[0]).toMatchObject({ sessionType: 'geraet', sourceId: 'sat-1', startedAt: new Date(1000).toISOString() });
    expect(sitzungen[0]!.endedAt).toBeUndefined();
    await a.sitzung('p1', { ...lauf, status: 'fertig', erledigt: [{ nr: 1, ok: true }, { nr: 2, ok: true }] }, 1000, 5000);
    expect(sitzungen[0]!.endedAt).toBe(new Date(5000).toISOString());
    expect((sitzungen[0]!.summary as { status: string }).status).toBe('success');
  });
  it('Zusammenfassung und Abbildung', () => {
    expect(sitzungsZusammenfassung({ ...lauf, status: 'angehalten', grund: 'Budget erreicht' })).toEqual({ whatWasDone: 'sat-1: Merkliste — 1/2 Etappen, 1.50 USD (Budget erreicht)\n✅ A', status: 'partial' });
    expect(akteAusProjekt({ id: 'p', userId: 'u', name: 'N', cwd: '/x', status: 'active', createdAt: 'c', lastActiveAt: 'l' } as never)).toMatchObject({ pfad: '/x', status: 'aktiv', pruefBefehle: [], geraet: '' });
  });
});

describe('Skill project: Server-Aktionen für Geräte-Projekte gesperrt', () => {
  const repo = {
    getById: async (_u: string, id: string) => ({ id, name: 'Angebots-Radar', cwd: '/home/madh/game', geraetId: 'g1', geraet: 'Ubuntu-VM' }),
    findIdByPrefixOrName: async () => '11111111-1111-1111-1111-111111111111',
  };
  const ctx = { userId: 'u', masterUserId: 'u' } as unknown as SkillContext;
  it('review_codebase, update_dependencies → Hinweis auf projekt_weiter', async () => {
    const skill = new ProjectSkill(repo as never);
    for (const action of ['review_codebase', 'update_dependencies', 'work_on_open_items']) {
      const r = await skill.execute({ action, project_id: 'Angebots-Radar' }, ctx);
      expect(r.success, action).toBe(false);
      expect(r.error).toMatch(/Projekt auf Ubuntu-VM .*action=projekt_weiter projekt="Angebots-Radar"/);
    }
  });
});
