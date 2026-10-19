import { describe, it, expect } from 'vitest';
import { OwnerAnsichten, faelligkeit, type OwnerAnsichtenDeps } from '../geraete/owner-ansichten.js';

// v1353 — native Ansichten der Desktop-App: Aufgaben, Erinnerungen, Gedächtnis, Vorgänge — nur Einträge des Owners
const OWNER = 'owner-1';

function aufbau() {
  const todos = [
    { id: 't1', userId: OWNER, list: 'default', title: 'Ohne Termin', priority: 'high', completed: false },
    { id: 't2', userId: OWNER, list: 'default', title: 'Morgen', priority: 'low', dueDate: '2026-10-12T08:00:00.000Z', completed: false },
    { id: 't3', userId: 'fremd', list: 'default', title: 'Fremd', priority: 'normal', completed: false },
  ] as Array<{ id: string; userId: string; list: string; title: string; priority: string; dueDate?: string | null; completed: boolean }>;
  const reminders = [
    { id: 'r1', userId: OWNER, message: 'Anrufen', triggerAt: '2026-10-12T09:00:00Z', fired: false },
    { id: 'r2', userId: 'fremd', message: 'Fremd', triggerAt: '2026-10-12T09:00:00Z', fired: false },
  ];
  const memories = [
    { id: 'm1', user_id: OWNER, key: 'wohnort', value: 'Wohnt in Linz', type: 'fact', source: 'auto', updated_at: '2026-10-10' },
    { id: 'm2', user_id: OWNER, key: 'insight_delivered:x', value: 'Hausbatterie', type: 'feedback', source: 'auto', updated_at: '2026-10-11' },
    { id: 'm3', user_id: 'fremd', key: 'wohnort', value: 'Wien', type: 'fact', source: 'auto', updated_at: '2026-10-11' },
  ];
  const sql: string[] = [];
  const deps: OwnerAnsichtenDeps = {
    owner: OWNER,
    todos: {
      list: async (u) => todos.filter(t => t.userId === u && !t.completed) as any,
      add: async (u, title, o) => { const t = { id: 'neu', userId: u, list: o?.list ?? 'default', title, priority: o?.priority ?? 'normal', dueDate: o?.dueDate, completed: false }; todos.push(t); return t as any; },
      getByIdForUser: async (id, u) => todos.find(t => t.id === id && t.userId === u) as any,
      update: async (id, u, p) => { const t = todos.find(x => x.id === id && x.userId === u)!; if (p.title) t.title = p.title; if (p.dueDate !== undefined) t.dueDate = p.dueDate; if (p.priority) t.priority = p.priority; return t as any; },
      complete: async (id) => { todos.find(t => t.id === id)!.completed = true; return true; },
      uncomplete: async (id) => { todos.find(t => t.id === id)!.completed = false; return true; },
    },
    erinnerungen: {
      getByUser: async (u) => reminders.filter(r => r.userId === u),
      getById: async (id) => reminders.find(r => r.id === id),
      cancel: async (id) => { const i = reminders.findIndex(r => r.id === id); if (i < 0) return false; reminders.splice(i, 1); return true; },
    },
    db: {
      query: async (s, p) => { sql.push(s); return memories.filter(m => m.user_id === p[0]); },
      execute: async (s, p) => {
        sql.push(s);
        const id = p[p.length - 2]; const u = p[p.length - 1];
        const i = memories.findIndex(m => m.id === id && m.user_id === u);
        if (i < 0) return { changes: 0 };
        if (s.startsWith('DELETE')) memories.splice(i, 1); else { memories[i].value = String(p[0]); memories[i].source = 'manual'; }
        return { changes: 1 };
      },
    },
    vorgangEntscheiden: async (u, id, status) => (u === OWNER && id === 'v1' ? { titel: `Vorgang ${status}` } : null),
    merken: async (o, t) => { memories.push({ id: 'm-neu', user_id: o, key: 'gemerkt:1', value: t, type: 'fact', source: 'manual', updated_at: '2026-10-19' }); return 'm-neu'; }, // v1510
  };
  return { a: new OwnerAnsichten(deps), todos, reminders, memories, sql };
}

describe('OwnerAnsichten — Aufgaben und Erinnerungen', () => {
  it('nur Einträge des Owners, fällige zuerst', async () => {
    const { a } = aufbau();
    const r = await a.aufgaben();
    expect(r.aufgaben.map(t => t.id)).toEqual(['t2', 't1']);
    expect(r.erinnerungen.map(e => e.id)).toEqual(['r1']);
  });

  it('anlegen, verschieben, erledigen, wieder öffnen', async () => {
    const { a, todos } = aufbau();
    const neu = await a.aufgabeNeu({ titel: '  Milch kaufen ', faellig: '2026-10-13T10:00:00+02:00', prioritaet: 'unsinn' });
    expect(neu.titel).toBe('Milch kaufen');
    expect(neu.faellig).toBe('2026-10-13T08:00:00.000Z');
    expect(neu.prioritaet).toBe('normal');
    expect((await a.aufgabeAendern('t1', { faellig: '2026-10-14T07:00:00Z' }))?.faellig).toBe('2026-10-14T07:00:00.000Z');
    expect((await a.aufgabeAendern('t1', { faellig: '' }))?.faellig).toBeUndefined();
    expect((await a.aufgabeAendern('t1', { erledigt: true }))?.erledigt).toBe(true);
    expect((await a.aufgabeAendern('t1', { erledigt: false }))?.erledigt).toBe(false);
    expect(todos.find(t => t.id === 't1')?.completed).toBe(false);
  });

  it('fremde Aufgaben und Erinnerungen bleiben unberührt', async () => {
    const { a, todos, reminders } = aufbau();
    expect(await a.aufgabeAendern('t3', { erledigt: true })).toBeNull();
    expect(todos.find(t => t.id === 't3')?.completed).toBe(false);
    expect(await a.erinnerungLoeschen('r2')).toBe(false);
    expect(reminders).toHaveLength(2);
    expect(await a.erinnerungLoeschen('r1')).toBe(true);
    expect(reminders.map(r => r.id)).toEqual(['r2']);
  });

  it('ohne Titel oder mit kaputtem Datum: Fehler statt stiller Annahme', async () => {
    const { a } = aufbau();
    await expect(a.aufgabeNeu({ titel: '  ' })).rejects.toThrow('titel');
    await expect(a.aufgabeNeu({ titel: 'x', faellig: 'morgen' })).rejects.toThrow('faellig');
    expect(faelligkeit(undefined)).toBeUndefined();
    expect(faelligkeit(null)).toBeNull();
  });
});

describe('OwnerAnsichten — Gedächtnis', () => {
  it('ohne Typ ohne interne Buchführung, Zähler je Typ, Suche über alle Wörter', async () => {
    const { a } = aufbau();
    const r = await a.gedaechtnis();
    expect(r.eintraege.map(e => e.id)).toEqual(['m1']);
    expect(r.typen).toEqual({ fact: 1, feedback: 1 });
    expect((await a.gedaechtnis({ typ: 'feedback' })).eintraege.map(e => e.id)).toEqual(['m2']);
    expect((await a.gedaechtnis({ q: 'linz wohnt' })).eintraege).toHaveLength(1);
    expect((await a.gedaechtnis({ q: 'wien' })).eintraege).toHaveLength(0);
  });

  it('v1510 Merken: neuer Eintrag beim Owner, leerer oder zu langer Text abgewiesen', async () => {
    const { a, memories } = aufbau();
    expect(await a.gedaechtnisAnlegen('  Heizöl bei Kreuzmayr bestellt  ')).toEqual({ id: 'm-neu' });
    expect(memories.find(m => m.id === 'm-neu')).toMatchObject({ user_id: OWNER, value: 'Heizöl bei Kreuzmayr bestellt' });
    await expect(a.gedaechtnisAnlegen('')).rejects.toThrow('text');
    await expect(a.gedaechtnisAnlegen('x'.repeat(4001))).rejects.toThrow('text');
  });

  it('korrigieren und löschen nur beim Owner; SQL mit user_id', async () => {
    const { a, memories, sql } = aufbau();
    expect(await a.gedaechtnisAendern('m1', 'Wohnt in Steyr')).toBe(true);
    expect(memories.find(m => m.id === 'm1')).toMatchObject({ value: 'Wohnt in Steyr', source: 'manual' });
    expect(await a.gedaechtnisAendern('m3', 'x')).toBe(false);
    expect(await a.gedaechtnisLoeschen('m3')).toBe(false);
    expect(memories.find(m => m.id === 'm3')?.value).toBe('Wien');
    expect(await a.gedaechtnisLoeschen('m1')).toBe(true);
    await expect(a.gedaechtnisAendern('m2', '')).rejects.toThrow('text');
    expect(sql.filter(s => !s.startsWith('SELECT')).every(s => s.includes('user_id = ?'))).toBe(true);
  });
});

describe('OwnerAnsichten — Vorgänge', () => {
  it('nur erledigt oder verworfen', async () => {
    const { a } = aufbau();
    expect(await a.vorgangEntscheiden('v1', 'erledigt', '  passt ')).toEqual({ titel: 'Vorgang erledigt' });
    expect(await a.vorgangEntscheiden('v2', 'verworfen', undefined)).toBeNull();
    await expect(a.vorgangEntscheiden('v1', 'loeschen', undefined)).rejects.toThrow('status');
  });
});

describe('OwnerAnsichten — Befunde (v1359)', () => {
  it('offen und erledigt, Regel aus dem Haus-Check-Schlüssel, ohne Quelle leer', async () => {
    const { OwnerAnsichten } = await import('../geraete/owner-ansichten.js');
    const b = (x: Partial<import('../geraete/owner-ansichten.js').BefundLike>) => ({ id: 'b', quelle: 'haus-check', gegenstand: 'B2:binary_sensor.wk', titel: 'Melder stumm', entstanden: '2026-10-12T00:00:00Z', zuletztGesehen: '2026-10-12T01:00:00Z', gesehenAnzahl: 2, ...x });
    const a = new OwnerAnsichten({
      owner: 'o', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null,
      befunde: async () => ({ offen: [b({}), b({ id: 'c', quelle: 'infra', gegenstand: 'unifi:ac-mesh', vorgangId: 'v' })], erledigt: [b({ id: 'd', erledigtAm: '2026-10-12T02:00:00Z' })] }),
    });
    const r = await a.befunde();
    expect(r.offen.map(x => [x.quelle, x.regel, x.vorgang])).toEqual([['haus-check', 'B2', false], ['infra', undefined, true]]);
    expect(r.erledigt[0]).toMatchObject({ id: 'd', erledigt: '2026-10-12T02:00:00Z', anzahl: 2 });
    const leer = new OwnerAnsichten({ owner: 'o', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null });
    expect(await leer.befunde()).toEqual({ offen: [], erledigt: [] });
  });
});
