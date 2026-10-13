import { describe, it, expect } from 'vitest';
import { OwnerAnsichten } from '../geraete/owner-ansichten.js';

// v1401 — App-Ansicht „Projekte": Durchreichen an die Projektdienste, Weiterarbeiten nur mit Text
describe('OwnerAnsichten: Projekte', () => {
  const aufrufe: string[] = [];
  const protokoll: string[] = [];
  const a = new OwnerAnsichten({
    owner: 'u', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null,
    protokoll: (was) => { protokoll.push(was); },
    projekte: {
      liste: async () => [{ id: 'p1' }],
      detail: async (id) => (id === 'p1' ? { id } : null),
      stand: async (id) => { aufrufe.push(`stand ${id}`); return { success: true, display: 'Stand' }; },
      weiter: async (id, text) => { aufrufe.push(`weiter ${id} ${text}`); return { success: true, display: 'geplant' }; },
    },
  });
  it('Liste, Detail, Stand, Weiterarbeiten', async () => {
    expect(await a.projekte()).toEqual({ projekte: [{ id: 'p1' }] });
    expect(await a.projekt('p1')).toEqual({ id: 'p1' });
    expect(await a.projekt('px')).toBeNull();
    expect((await a.projektAktion('p1', 'stand', undefined)).display).toBe('Stand');
    expect((await a.projektAktion('p1', 'weiter', '  Merkliste teilen  ')).success).toBe(true);
    expect(aufrufe).toEqual(['stand p1', 'weiter p1 Merkliste teilen']);
    expect(protokoll).toEqual(['Projekt weiter']);
  });
  it('ohne Text oder unbekannte Aktion: nichts ausgelöst', async () => {
    aufrufe.length = 0;
    expect((await a.projektAktion('p1', 'weiter', '   ')).error).toMatch(/text fehlt/);
    expect((await a.projektAktion('p1', 'loeschen', 'x')).error).toMatch(/stand, weiter, frage, fortsetzen, diff, protokoll, konventionen, freigeben oder ablehnen/);
    expect(aufrufe).toEqual([]);
  });
});

// v1403 — offene Frage eines Laufs direkt aus der App entscheiden
describe('OwnerAnsichten: Lauf entscheiden', () => {
  const aufrufe: string[] = [];
  const a = new OwnerAnsichten({
    owner: 'u', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null,
    projekte: {
      liste: async () => [], detail: async () => null, stand: async () => ({ success: true }), weiter: async () => ({ success: true }),
      entscheiden: async (id, lauf, e) => { aufrufe.push(`${id} ${lauf} ${e}`); return { success: true, display: 'Freigegeben' }; },
    },
  });
  it('freigeben/ablehnen mit Lauf; ohne Lauf nichts', async () => {
    expect((await a.projektAktion('p1', 'freigeben', undefined, 'sat-9')).success).toBe(true);
    expect((await a.projektAktion('p1', 'ablehnen', undefined, 'sat-9')).success).toBe(true);
    expect((await a.projektAktion('p1', 'freigeben', undefined, undefined)).error).toBe('lauf fehlt');
    expect(aufrufe).toEqual(['p1 sat-9 freigeben', 'p1 sat-9 ablehnen']);
  });
});
