import { describe, it, expect } from 'vitest';
import { OwnerAnsichten, type OwnerAnsichtenDeps, type RegelLike, type BefundLike } from '../geraete/owner-ansichten.js';

// v1481 — Aktionen am Befund aus der App (Lage-Kachel, Ansicht „Befunde“)
const befunde: Record<string, BefundLike> = {
  b1: { id: 'b1', quelle: 'infra', gegenstand: 'unifi:device:ac-mesh', titel: 'AC Mesh nicht verbunden', entstanden: '2026-10-08', zuletztGesehen: '2026-10-16', gesehenAnzahl: 405 },
  b2: { id: 'b2', quelle: 'haus', gegenstand: 'haus:rauch:binary_sensor.rauch_gang', titel: 'Rauch Gang', entstanden: '2026-10-16', zuletztGesehen: '2026-10-16', gesehenAnzahl: 1 },
};
function ansichten() {
  const regeln: RegelLike[] = [];
  const vorgaenge: string[] = [];
  const deps: OwnerAnsichtenDeps = {
    owner: 'o', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null, jetzt: () => new Date('2026-10-16T12:00:00Z'),
    befundHolen: async (id) => befunde[id] ?? null,
    befundVorgang: async (b) => { vorgaenge.push(b.id); return { id: `v-${b.id}`, titel: b.titel, neu: true }; },
    regeln: {
      liste: async () => regeln,
      anlegen: async (e) => { const r: RegelLike = { id: `r${regeln.length}`, ...e, status: 'aktiv', erstellt: '2026-10-16' }; regeln.push(r); return r; },
      vorschlagen: async () => null, setzeStatus: async () => null, hole: async () => null,
    },
  };
  return { a: new OwnerAnsichten(deps), regeln, vorgaenge };
}

describe('v1481 Befund-Aktionen', () => {
  it('nicht mehr melden: Regel des Owners mit Ablauf', async () => {
    const { a, regeln } = ansichten();
    const r = await a.befundAktion('b1', { aktion: 'stumm', tage: 30 });
    expect(r?.regel).toBe('AC Mesh nicht verbunden: nicht melden bis 15.11.');
    expect(regeln[0]).toMatchObject({ quelle: 'infra', gegenstand: 'unifi:device:ac-mesh', wirkung: 'stumm', herkunft: 'owner' });
  });

  it('Sicherheit nie stumm; falsche Tage abgelehnt; Vorgang daraus; unbekannt → null', async () => {
    const { a, vorgaenge } = ansichten();
    await expect(a.befundAktion('b2', { aktion: 'stumm' })).rejects.toThrow('nicht stummschaltbar');
    await expect(a.befundAktion('b1', { aktion: 'stumm', tage: 5 })).rejects.toThrow('tage');
    expect(await a.befundAktion('b1', { aktion: 'vorgang' })).toEqual({ titel: 'AC Mesh nicht verbunden', vorgangId: 'v-b1', neu: true });
    expect(vorgaenge).toEqual(['b1']);
    expect(await a.befundAktion('b9', { aktion: 'vorgang' })).toBeNull();
    await expect(a.befundAktion('b1', { aktion: 'x' })).rejects.toThrow('aktion');
  });
});
