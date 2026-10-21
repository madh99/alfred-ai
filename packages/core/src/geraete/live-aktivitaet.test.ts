import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { LiveAktivitaet, liveKoerper, liveZustand } from './live-aktivitaet.js';
import { lageKurz } from '../lebenszeichen/lage-kurz.js';

// v1540 — Live-Aktivität bei roter Lage: Start per Push-to-Start, Update bei Änderung, Ende nach 5 ruhigen Minuten
const T1 = 'a'.repeat(64), T2 = 'b'.repeat(64);
const rot = (n = 1) => lageKurz({ offen: Array.from({ length: n }, () => ({})) }, [], 0);
const gruen = lageKurz({}, [], 0);

function aufbau() {
  let jetzt = new Date('2026-10-21T20:00:00Z');
  const gesendet: Array<{ token: string; koerper: Record<string, unknown>; prio: number }> = [];
  const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-')), 'live.json');
  const live = new LiveAktivitaet({
    datei, jetzt: () => jetzt, logger: { info: () => undefined, warn: () => undefined },
    apns: { sendeLive: async (token, _u, koerper, prio) => { gesendet.push({ token, koerper: JSON.parse(koerper), prio }); return { ok: true, status: 200, tokenUngueltig: false }; } },
  });
  return { live, gesendet, datei, weiter: (min: number) => { jetzt = new Date(jetzt.getTime() + min * 60_000); } };
}

describe('v1540 Live-Aktivität', () => {
  it('Körper: start mit Attributen und Hinweis, end mit Ausblendzeit; Zustand ohne Namen', () => {
    const z = liveZustand(rot(2), new Date('2026-10-21T20:05:00Z'));
    expect(z).toEqual({ ampel: 'bad', titel: 'Störung', zeile: '2 Wächter-Meldungen', anzahl: 2, stand: '22:05' });
    const s = JSON.parse(liveKoerper('start', z, 1000)).aps;
    expect(s).toMatchObject({ event: 'start', 'attributes-type': 'LageAttribute', attributes: { name: 'Alfred' }, alert: { title: 'Alfred: Störung' }, 'stale-date': 1000 + 3 * 3600 });
    expect(JSON.parse(liveKoerper('end', z, 1000)).aps['dismissal-date']).toBe(1000 + 900);
  });

  it('Token prüfen; nur gültige Meldungen werden gemerkt und überstehen einen Neustart', () => {
    const t = aufbau();
    expect(t.live.merke('g1', { art: 'start', token: 'xyz', umgebung: 'production' })).toMatchObject({ ok: false });
    expect(t.live.merke('g1', { art: 'start', token: T1, umgebung: 'sandbox?' })).toMatchObject({ ok: false });
    expect(t.live.merke('g1', { art: 'start', token: T1, umgebung: 'production' })).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(t.datei, 'utf8')).geraete.g1.startToken).toBe(T1);
  });

  it('rot → Start; gleich → nichts; Änderung → Update an die Aktivität; grün erst nach 5 min → Ende', async () => {
    const t = aufbau();
    t.live.merke('g1', { art: 'start', token: T1, umgebung: 'production' });
    expect(await t.live.pruefe(gruen)).toBe('unveraendert');
    expect(await t.live.pruefe(rot(1))).toBe('gestartet');
    expect(t.gesendet[0]).toMatchObject({ token: T1, prio: 10, koerper: { aps: { event: 'start' } } });
    t.live.merke('g1', { art: 'aktivitaet', token: T2, id: 'akt-1', umgebung: 'production' });
    expect(await t.live.pruefe(rot(1))).toBe('unveraendert');
    expect(await t.live.pruefe(rot(2))).toBe('aktualisiert');
    expect(t.gesendet[1]).toMatchObject({ token: T2, prio: 5, koerper: { aps: { event: 'update', 'content-state': { zeile: '2 Wächter-Meldungen' } } } });
    expect(await t.live.pruefe(gruen)).toBe('unveraendert'); // gerade erst grün
    t.weiter(3);
    expect(await t.live.pruefe(gruen)).toBe('unveraendert');
    t.weiter(3);
    expect(await t.live.pruefe(gruen)).toBe('beendet');
    expect(t.gesendet[2]).toMatchObject({ token: T2, koerper: { aps: { event: 'end', 'content-state': { titel: 'Entwarnung' } } } });
    expect(t.live.aktiv).toBe(false);
  });

  it('kurzer Aussetzer: wieder rot innerhalb von 5 min → läuft weiter, kein neuer Start', async () => {
    const t = aufbau();
    t.live.merke('g1', { art: 'start', token: T1, umgebung: 'production' });
    await t.live.pruefe(rot(1));
    await t.live.pruefe(gruen);
    t.weiter(2);
    expect(await t.live.pruefe(rot(1))).toBe('unveraendert');
    t.weiter(10);
    expect(await t.live.pruefe(gruen)).toBe('unveraendert'); // Uhr beginnt neu
    expect(t.gesendet.filter(g => (g.koerper.aps as { event: string }).event === 'start')).toHaveLength(1);
  });
});
