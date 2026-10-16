import { describe, it, expect } from 'vitest';
import { OwnerAnsichten, type OwnerAnsichtenDeps } from '../geraete/owner-ansichten.js';

// v1480 — „Später“ und „Ausführen“ aus der App
describe('v1480 Vorgänge: Später und Ausführen', () => {
  const jetzt = new Date('2026-10-16T10:00:00Z');
  const gesetzt: Array<{ id: string; bis: string | null }> = [];
  const deps: OwnerAnsichtenDeps = {
    owner: 'o', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null, jetzt: () => jetzt,
    vorgangZurueckstellen: async (_u, id, bis) => { gesetzt.push({ id, bis }); return { titel: 'Domain', zurueckBis: bis ?? undefined }; },
    vorgangAusfuehren: async (_u, id) => (id === 'v1' ? { titel: 'Domain', erfolg: true, text: 'Erinnerung gesetzt' } : null),
  };
  const a = new OwnerAnsichten(deps);

  it('stellt um 3 h, bis morgen 08:00 zurück und nimmt wieder auf', async () => {
    await a.vorgangSpaeter('v1', { stunden: 3 });
    await a.vorgangSpaeter('v1', { bis: 'morgen' });
    await a.vorgangSpaeter('v1', { bis: 'zurueck' });
    expect(gesetzt[0]!.bis).toBe('2026-10-16T13:00:00.000Z');
    const m = new Date(gesetzt[1]!.bis!);
    expect(m.getHours()).toBe(8);
    expect(m.getDate()).toBe(new Date(jetzt.getTime() + 86_400_000).getDate());
    expect(gesetzt[2]!.bis).toBeNull();
    await expect(a.vorgangSpaeter('v1', { stunden: 5 })).rejects.toThrow('stunden');
  });

  it('Ausführen gibt das Ergebnis durch; unbekannt → null', async () => {
    expect(await a.vorgangAusfuehren('v1')).toEqual({ titel: 'Domain', erfolg: true, text: 'Erinnerung gesetzt' });
    expect(await a.vorgangAusfuehren('v9')).toBeNull();
  });
});
