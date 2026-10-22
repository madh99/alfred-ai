import { describe, it, expect } from 'vitest';
import { abschnittsEnde, faelligeBenachrichtigungen, inRegel, regelFehler, regelText, startPruefen, wienZeit, type BenachrichtigungsRegel, type KalenderEintrag } from './wartung.js';

// I4b Teil 1 — Wartungsfenster, Sperrzeiten, Benachrichtigungen (Zeiten in Wien)
const t = (s: string) => Date.parse(s);
const nachts: KalenderEintrag = { id: 'f1', art: 'fenster', name: 'werktags nachts', geltung: { global: true }, regel: { art: 'woechentlich', tage: [1, 2, 3, 4, 5], von: '22:00', bis: '06:00' }, aktiv: true };
const urlaub: KalenderEintrag = { id: 's1', art: 'sperre', name: 'Urlaub', geltung: { global: true }, regel: { art: 'einmalig', von: '2026-10-28T00:00:00+01:00', bis: '2026-10-30T00:00:00+01:00' }, aktiv: true };
const matrix: KalenderEintrag = { id: 'f2', art: 'fenster', name: 'Matrix Di', geltung: { assetIds: ['a-matrix'] }, regel: { art: 'woechentlich', tage: [2], von: '22:00', bis: '23:59' }, aktiv: true };

describe('I4b Wartungsfenster', () => {
  it('Wiener Zeit, Regeln über Mitternacht, Abschnittsende, Prüfung', () => {
    expect(wienZeit(t('2026-10-22T20:30:00Z'))).toMatchObject({ tag: 4, minute: 22 * 60 + 30 }); // Do 22:30 MESZ
    expect(inRegel(nachts.regel, t('2026-10-22T20:30:00Z'))).toBe(true);   // Do 22:30
    expect(inRegel(nachts.regel, t('2026-10-23T03:00:00Z'))).toBe(true);   // Fr 05:00 (vom Do)
    expect(inRegel(nachts.regel, t('2026-10-24T21:00:00Z'))).toBe(false);  // Sa 23:00
    expect(inRegel(nachts.regel, t('2026-10-24T02:00:00Z'))).toBe(true);   // Sa 04:00 (vom Fr)
    expect(abschnittsEnde(nachts.regel, t('2026-10-22T20:30:00Z'))).toBe(t('2026-10-23T04:00:00Z')); // Fr 06:00 MESZ
    expect(regelFehler({ art: 'woechentlich', tage: [7], von: '22:00', bis: '06:00' })).toContain('tage');
    expect(regelFehler({ art: 'einmalig', von: '2026-10-28T00:00:00Z', bis: '2026-10-27T00:00:00Z' })).toContain('nach von');
    expect(regelText(nachts.regel)).toBe('Mo, Di, Mi, Do, Fr 22:00–06:00 (über Mitternacht)');
  });
  it('Start nur im geltenden Fenster mit genug Restzeit; Sperre blockiert; Notfall frei; ohne Fenster jederzeit', () => {
    const c = { notfall: false, assetIds: ['a-x'], ausfallMinuten: 60 };
    expect(startPruefen(c, [], t('2026-10-22T10:00:00Z')).erlaubt).toBe(true);
    const tag = startPruefen(c, [nachts], t('2026-10-22T10:00:00Z'));
    expect(tag).toMatchObject({ erlaubt: false, grund: 'außerhalb der Wartungsfenster' });
    expect(tag.naechsterStart).toBe(t('2026-10-22T20:00:00Z')); // Do 22:00 MESZ
    expect(startPruefen(c, [nachts], t('2026-10-22T20:30:00Z')).erlaubt).toBe(true);
    expect(startPruefen(c, [nachts], t('2026-10-23T03:30:00Z')).erlaubt).toBe(false); // 05:30, nur 30 min Rest < 60
    const imUrlaub = startPruefen(c, [nachts, urlaub], t('2026-10-28T21:30:00Z'));
    expect(imUrlaub).toMatchObject({ erlaubt: false, grund: 'Sperrzeit „Urlaub“' });
    expect(imUrlaub.naechsterStart).toBe(t('2026-10-29T23:00:00Z')); // Fr 30.10. 00:00 MEZ, noch im Do-Fenster
    expect(startPruefen({ ...c, notfall: true }, [nachts, urlaub], t('2026-10-28T12:00:00Z')).erlaubt).toBe(true);
    // Fenster nur für Matrix: gilt nicht für andere Assets
    expect(startPruefen(c, [matrix], t('2026-10-22T10:00:00Z')).erlaubt).toBe(true);
    expect(startPruefen({ ...c, assetIds: ['a-matrix'] }, [matrix], t('2026-10-22T10:00:00Z')).erlaubt).toBe(false);
  });
  it('Benachrichtigungen 24 h und 1 h vorher, je einmal', () => {
    const r: BenachrichtigungsRegel = { id: 'r1', name: 'Familie bei HA', geltung: { assetIds: ['a-ha'] }, empfaenger: [{ art: 'owner' }], kanaele: ['push'], zeitpunkte: ['24h_vorher', '1h_vorher', 'start'], aktiv: true };
    const c = { id: 'c', assetIds: ['a-ha'], startGeplant: t('2026-10-23T20:00:00Z') };
    expect(faelligeBenachrichtigungen(c, [r], t('2026-10-22T19:00:00Z'), new Set()).map(x => x.zeitpunkt)).toEqual([]);
    const f = faelligeBenachrichtigungen(c, [r], t('2026-10-22T20:05:00Z'), new Set());
    expect(f.map(x => x.zeitpunkt)).toEqual(['24h_vorher']);
    expect(faelligeBenachrichtigungen(c, [r], t('2026-10-23T19:10:00Z'), new Set([f[0]!.schluessel])).map(x => x.zeitpunkt)).toEqual(['1h_vorher']);
    expect(faelligeBenachrichtigungen({ ...c, assetIds: ['a-x'] }, [r], t('2026-10-23T19:10:00Z'), new Set())).toEqual([]);
  });
});
