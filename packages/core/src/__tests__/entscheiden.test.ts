import { describe, it, expect } from 'vitest';
import { befundSchluesselAus, nieStummschaltbar, haltefristMin, regelText } from '../vorgaenge/regeln.js';
import { OwnerAnsichten, type RegelLike, type OwnerAnsichtenDeps } from '../geraete/owner-ansichten.js';
import { formatiereLage } from '../interaktion/lage.js';

// v1362 — Spec „Entscheiden statt Abhaken" E1/E2 (Owner 12.10. „ok wie empfohlen", Vorschläge übernehmbar)
describe('Regeln (rein)', () => {
  it('Befund-Schlüssel aus dem Vorgang', () => {
    expect(befundSchluesselAus('befund:energie:hausbatterie:baseline')).toEqual({ quelle: 'energie', gegenstand: 'hausbatterie:baseline' });
    expect(befundSchluesselAus('insight:abc')).toBeNull();
    expect(befundSchluesselAus(undefined)).toBeNull();
  });
  it('nie stummschaltbar: Sicherheit und Alfreds eigener Zustand', () => {
    expect(nieStummschaltbar({ quelle: 'haus', gegenstand: 'haus:rauch:binary_sensor.rauch_gang' })).toBe(true);
    expect(nieStummschaltbar({ quelle: 'haus', gegenstand: 'haus:wasser:binary_sensor.keller' })).toBe(true);
    expect(nieStummschaltbar({ quelle: 'lebenszeichen', gegenstand: 'kosten:guthaben' })).toBe(true);
    expect(nieStummschaltbar({ quelle: 'energie', gegenstand: 'hausbatterie:baseline' })).toBe(false);
  });
  it('Haltefristen (E2, beobachtend)', () => {
    expect(haltefristMin({ quelle: 'energie', gegenstand: 'hausbatterie:baseline' })).toBe(1440);
    expect(haltefristMin({ quelle: 'sensorbatterien', gegenstand: 'sensorbatterie:sensor.x:leer' })).toBe(1440);
    expect(haltefristMin({ quelle: 'infra', gegenstand: 'unifi:ac-mesh:offline' })).toBe(120);
    expect(haltefristMin({ quelle: 'haus', gegenstand: 'haus:rauch:x' })).toBe(0);
    expect(haltefristMin({ quelle: 'haus-check', gegenstand: 'B1:x' })).toBeNull();
  });
  it('Regeltext', () => {
    const j = new Date('2026-10-12T10:00:00Z');
    expect(regelText({ titel: 'Hausbatterie', wirkung: 'stumm', bis: '2026-11-11T10:00:00Z' }, j)).toBe('Hausbatterie: nicht melden bis 11.11.');
    expect(regelText({ titel: 'Hausbatterie', wirkung: 'stumm', bis: '2026-10-01T10:00:00Z' }, j)).toBe('Hausbatterie: abgelaufen am 01.10.');
    expect(regelText({ titel: 'Rauch Gang', wirkung: 'immer_fragen' }, j)).toBe('Rauch Gang: jedes Mal fragen');
  });
});

function ansichten(vorgaenge: Record<string, { titel: string; dedupeKey?: string }>, keinProblem = 0) {
  const regeln: RegelLike[] = [];
  const abgeschlossen: Array<{ id: string; art: string }> = [];
  const log: string[] = [];
  const jetzt = new Date('2026-10-12T10:00:00Z');
  const deps: OwnerAnsichtenDeps = {
    owner: 'o', todos: {} as never, erinnerungen: {} as never, db: {} as never, vorgangEntscheiden: async () => null, jetzt: () => jetzt,
    vorgangHolen: async (_u, id) => (vorgaenge[id] ? { ...vorgaenge[id]!, status: 'offen' } : null),
    vorgangAbschliessen: async (_u, id, e) => { abgeschlossen.push({ id, art: e.art }); return { titel: vorgaenge[id]!.titel, ergebnis: e.art === 'kein_problem' ? `kein Problem — ${e.text ?? ''}` : e.art }; },
    keinProblemAnzahl: async () => keinProblem,
    regeln: {
      liste: async () => regeln,
      anlegen: async (e) => { for (const r of regeln) if (r.quelle === e.quelle && r.gegenstand === e.gegenstand) r.status = 'widerrufen'; const r: RegelLike = { id: `r${regeln.length + 1}`, ...e, status: 'aktiv', erstellt: jetzt.toISOString() }; regeln.push(r); return r; },
      vorschlagen: async (e) => { if (regeln.some(r => r.quelle === e.quelle && r.gegenstand === e.gegenstand && ['aktiv', 'vorgeschlagen'].includes(r.status))) return null; const r: RegelLike = { id: `r${regeln.length + 1}`, ...e, status: 'vorgeschlagen', erstellt: jetzt.toISOString() }; regeln.push(r); return r; },
      setzeStatus: async (id, s, bis) => { const r = regeln.find(x => x.id === id); if (!r) return null; r.status = s; if (bis) r.bis = bis; return r; },
      hole: async (id) => regeln.find(x => x.id === id) ?? null,
    },
    protokoll: (was) => log.push(was),
  };
  return { a: new OwnerAnsichten(deps), regeln, abgeschlossen, log };
}

describe('Abschluss mit Ergebnis und Regel', () => {
  const vg = { v1: { titel: 'Hausbatterie: SoC 47 %', dedupeKey: 'befund:energie:hausbatterie:baseline' }, v2: { titel: 'Rauch Gang', dedupeKey: 'befund:haus:haus:rauch:x' }, v3: { titel: 'E-Mail beantworten', dedupeKey: 'insight:abc' } };

  it('„kein Problem" + „nicht mehr melden 30 Tage" legt eine aktive Regel an', async () => {
    const { a, regeln, abgeschlossen } = ansichten(vg);
    const r = await a.vorgangAbschliessen('v1', { ergebnis: { art: 'kein_problem', text: 'Herbst, wenig PV' }, kuenftig: { art: 'stumm', tage: 30 } });
    expect(abgeschlossen).toEqual([{ id: 'v1', art: 'kein_problem' }]);
    expect(r?.regel).toBe('Hausbatterie: SoC 47 %: nicht melden bis 11.11.');
    expect(regeln[0]).toMatchObject({ quelle: 'energie', gegenstand: 'hausbatterie:baseline', herkunft: 'owner', status: 'aktiv' });
  });

  it('Sicherheitsbefund: „nicht mehr melden" wird abgelehnt, BEVOR abgeschlossen wird', async () => {
    const { a, abgeschlossen } = ansichten(vg);
    await expect(a.vorgangAbschliessen('v2', { ergebnis: { art: 'kein_problem' }, kuenftig: { art: 'stumm' } })).rejects.toThrow('nicht stummschaltbar');
    expect(abgeschlossen).toEqual([]);
  });

  it('Regeln nur für Befund-Vorgänge; ungültige Eingaben sind Fehler', async () => {
    const { a } = ansichten(vg);
    await expect(a.vorgangAbschliessen('v3', { ergebnis: { art: 'behoben' }, kuenftig: { art: 'stumm' } })).rejects.toThrow('nur für Vorgänge aus einem Befund');
    await expect(a.vorgangAbschliessen('v1', { ergebnis: { art: 'erledigt' } })).rejects.toThrow('ergebnis.art');
    await expect(a.vorgangAbschliessen('v1', { ergebnis: { art: 'kein_problem' }, kuenftig: { art: 'stumm', tage: 365 } })).rejects.toThrow('kuenftig.tage');
    expect(await a.vorgangAbschliessen('v9', { ergebnis: { art: 'behoben' } })).toBeNull();
  });

  it('drittes „kein Problem" ohne Regel → Alfred schlägt vor; übernehmen setzt die Frist ab jetzt', async () => {
    const { a, regeln } = ansichten(vg, 3);
    const r = await a.vorgangAbschliessen('v1', { ergebnis: { art: 'kein_problem' } });
    expect(r?.vorschlag).toContain('nicht melden bis');
    expect(regeln[0]).toMatchObject({ herkunft: 'alfred', status: 'vorgeschlagen', begruendung: '3× als „kein Problem" abgeschlossen' });
    const liste = await a.regeln();
    expect(liste.vorschlaege).toHaveLength(1);
    expect(liste.aktiv).toHaveLength(0);
    const neu = await a.regelAendern(regeln[0]!.id, 'uebernehmen');
    expect(neu?.text).toBe('Hausbatterie: SoC 47 %: nicht melden bis 11.11.');
    expect((await a.regeln()).aktiv).toHaveLength(1);
    await expect(a.regelAendern(regeln[0]!.id, 'ablehnen')).rejects.toThrow('aktion');
    expect((await a.regelAendern(regeln[0]!.id, 'widerrufen'))?.text).toContain('Hausbatterie');
  });

  it('zweites „kein Problem" → noch kein Vorschlag; Vorschlag ablehnbar', async () => {
    const { a, regeln } = ansichten(vg, 2);
    expect((await a.vorgangAbschliessen('v1', { ergebnis: { art: 'kein_problem' } }))?.vorschlag).toBeUndefined();
    const b = ansichten(vg, 4);
    await b.a.vorgangAbschliessen('v1', { ergebnis: { art: 'kein_problem' } });
    await b.a.regelAendern(b.regeln[0]!.id, 'ablehnen');
    expect(b.regeln[0]!.status).toBe('abgelehnt');
    expect(regeln).toHaveLength(0);
  });
});

describe('Lage', () => {
  it('aktive Regeln als eine Zeile', () => {
    const t = formatiereLage({ befundeOffen: [], befundeErledigt24h: [], vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [], regeln: ['Hausbatterie: nicht melden bis 11.11.'] }, new Date('2026-10-12T10:00:00'));
    expect(t).toContain('Regeln des Owners (1): Hausbatterie: nicht melden bis 11.11.');
  });
});
