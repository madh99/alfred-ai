import { describe, it, expect } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { baueAbnahme, baueTestprotokoll } from './builder.js';
import { findeChange, verlaufVon, itsmQuellen, type DokuQuellen, type ItsmLesend } from './sammler.js';
import { pruefeDokument } from './arten.js';
import type { Block, Dokument } from './modell.js';
import type { VerlaufEintrag } from '../change-lauf.js';

// Fixtures nach echten Läufen (PKI-Lab 14.11.): Aufbau, Negativtests, Abbau — je drei Schritte
const JETZT = '2026-11-15T09:27:53.000Z';
type Schritt = { nr: number; titel: string; skill?: string; aktion: string; daten?: unknown; ausgabe?: string; ok?: boolean };
function change(id: string, title: string, schritte: Schritt[], extra: Partial<CmdbChangeRequest> = {}, mitLauf = true): CmdbChangeRequest {
  return {
    id, userId: 'u', title, type: 'normal', status: 'completed', riskLevel: 'low', affectedAssetIds: [], affectedServiceIds: [],
    createdAt: '2026-11-14T07:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z',
    fingerabdruck: 'abcdef0123456789abcdef', freigabeFingerabdruck: 'abcdef0123456789abcdef', freigegebenAt: '2026-11-14T07:30:00.000Z', freigegebenUeber: 'frage',
    schritte: schritte.map(s => ({ nr: s.nr, titel: s.titel, art: 'aktion', skill: s.skill ?? 'fernzugriff', aktion: s.aktion, zeitlimitS: 60, beiFehler: 'anhalten' })),
    ...(mitLauf ? {
      lauf: {
        phase: 'fertig', schritt: schritte.length, start: '2026-11-14T08:00:00.000Z', ende: '2026-11-14T08:30:00.000Z',
        ergebnisse: schritte.map(s => ({ nr: s.nr, ok: s.ok ?? true, start: '2026-11-14T08:00:00.000Z', ende: '2026-11-14T08:01:00.000Z', ausgabe: s.ausgabe ?? `${s.titel} erledigt`, ...(s.daten !== undefined ? { daten: s.daten } : {}) })),
      },
    } : {}),
    ...extra,
  } as CmdbChangeRequest;
}

const aufbau = change('288c3716-1111-2222-3333-444444444444', 'PKI-Lab aufbauen', [
  { nr: 1, titel: 'Lab-Netz anlegen', skill: 'unifi', aktion: 'create_network', ausgabe: 'Netz pki-lab VLAN 77 angelegt (10.77.0.0/24)' },
  { nr: 2, titel: 'Verbindung SQL02 → Lab', aktion: 'verbindung_pruefen', ausgabe: 'TCP 1433 erreichbar' },
  { nr: 3, titel: 'TLS mit gültigem Zertifikat', aktion: 'lesen', daten: { ergebnis: 'LAB_TLS_OK' }, ausgabe: 'Verbindung verschlüsselt, password=Geheim123!' },
]);
const negativ = change('3a5b7c9d-1111-2222-3333-444444444444', 'PKI-Lab Negativtests', [
  { nr: 1, titel: 'Abgelaufenes Zertifikat', aktion: 'lesen', daten: { ergebnis: 'EXPECTED_TLS_FAILURE', grund: 'Zertifikat abgelaufen' } },
  { nr: 2, titel: 'Falscher Name', aktion: 'lesen', daten: { ergebnis: 'EXPECTED_TLS_FAILURE' }, ausgabe: 'The target principal name is incorrect' },
  { nr: 3, titel: 'Protokoll sichern', aktion: 'lesen' },
]);
const abbau = change('9f8e7d6c-1111-2222-3333-444444444444', 'PKI-Lab abbauen', [
  { nr: 1, titel: 'Lab-VM löschen', skill: 'proxmox', aktion: 'delete_vm' },
  { nr: 2, titel: 'Firewall-Regel entfernen', skill: 'unifi', aktion: 'delete_firewall_policy' },
  { nr: 3, titel: 'Lab-Netz löschen', skill: 'unifi', aktion: 'delete_network' },
]);

const kap = (d: Dokument, id: string) => d.kapitel.find(k => k.id === id)!;
const text = (bs: Block[]) => JSON.stringify(bs);
const tabellen = (bs: Block[]) => bs.filter((b): b is Extract<Block, { art: 'tabelle' }> => b.art === 'tabelle');
const leer = new Map<string, { eintraege: VerlaufEintrag[]; quelle: string }>();

describe('Abnahmeprotokoll', () => {
  it('ein Change: gültig, Kopf mit ID, Rohlauf und Prüfanleitung, nichts Geheimes', () => {
    const d = baueAbnahme([aufbau], leer, { zweck: 'Lab für TLS-Tests' }, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(d.kopf.ordner).toBe('change-288c3716');
    expect(text(kap(d, 'kopf').bloecke)).toContain('288c3716');
    expect(text(kap(d, 'kopf').bloecke)).toContain('abcdef012345');
    expect(d.anhaenge.map(a => a.name)).toEqual(['rohlauf-288c3716.json', 'PRUEFUNG.txt']);
    expect(kap(d, 'zweck').bloecke).toEqual([{ art: 'frei', feld: 'zweck', text: 'Lab für TLS-Tests' }]);
    expect(kap(d, 'abweichungen').bloecke).toEqual([{ art: 'frei', feld: 'abweichungen' }]);
    expect(kap(d, 'verlauf').bloecke).toEqual([{ art: 'nichtBelegt', grund: 'kein Verlauf erfasst' }]);
    expect(JSON.stringify(d)).not.toContain('Geheim123!');
  });

  it('Change ohne Lauf: gültig, Beweise nicht belegt', () => {
    const c = change('aaaabbbb-0000-0000-0000-000000000000', 'Nie gelaufen', [{ nr: 1, titel: 'x', aktion: 'lesen' }], { status: 'approved' }, false);
    const d = baueAbnahme([c], leer, {}, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(kap(d, 'beweise').bloecke).toEqual([{ art: 'nichtBelegt', grund: 'Change ohne Lauf' }]);
    expect(d.anhaenge).toEqual([]);
  });

  it('zwei Standard-Changes: Sammelprotokoll mit einer Zeile je Change', () => {
    const a = { ...aufbau, type: 'standard' } as CmdbChangeRequest;
    const b = { ...abbau, type: 'standard' } as CmdbChangeRequest;
    const v = new Map([[a.id, { eintraege: [{ zeit: '2026-11-14T08:10:00.000Z', art: 'halt' as const, schritt: 2, text: 'Schritt 2: Fehler token=abc123geheim' }], quelle: 'incidents' }]]);
    const d = baueAbnahme([a, b], v, {}, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(d.kopf.ordner).toBe('serie-288c3716');
    expect(tabellen(kap(d, 'kopf').bloecke)[0]!.zeilen.map(z => z[0])).toEqual(['288c3716', '9f8e7d6c']);
    expect(tabellen(kap(d, 'schritte').bloecke)).toHaveLength(2);
    const verlauf = text(kap(d, 'verlauf').bloecke);
    expect(verlauf).toContain('rekonstruiert aus Halte-Incidents');
    expect(verlauf).toContain('kein Verlauf erfasst');
    expect(verlauf).not.toContain('abc123geheim');
    expect(d.anhaenge.map(a => a.name)).toEqual(['rohlauf-288c3716.json', 'rohlauf-9f8e7d6c.json', 'PRUEFUNG.txt']);
  });

  it('zu langes Freitextfeld → Fehler', () => {
    expect(() => baueAbnahme([aufbau], leer, { zweck: 'x'.repeat(601) }, JETZT)).toThrow(/zweck/);
  });
});

describe('Testprotokoll', () => {
  it('Fälle aus daten.ergebnis, Umgebung mit Verbindungsprüfung, Abbau aus dem letzten Change', () => {
    const d = baueTestprotokoll('pki-lab', [aufbau, negativ, abbau], leer, {}, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(d.kopf.ordner).toBe('pki-lab');
    const faelle = tabellen(kap(d, 'faelle').bloecke)[0]!;
    expect(faelle.kopf).toEqual(['Change', 'Schritt', 'Titel', 'Ergebnis', 'Grund']);
    expect(faelle.zeilen.map(z => [z[0], z[1], z[3]])).toEqual([
      ['288c3716', '3', 'LAB_TLS_OK'], ['3a5b7c9d', '1', 'EXPECTED_TLS_FAILURE'], ['3a5b7c9d', '2', 'EXPECTED_TLS_FAILURE'],
    ]);
    expect(faelle.zeilen[1]![4]).toBe('Zertifikat abgelaufen');
    expect(faelle.zeilen[2]![4]).toBe('The target principal name is incorrect');
    expect(text(kap(d, 'faelle').bloecke)).not.toContain('Geheim123!');
    const umgebung = kap(d, 'umgebung').bloecke;
    expect(tabellen(umgebung)[0]!.zeilen).toEqual([['288c3716', '2', 'Verbindung SQL02 → Lab', 'ok']]);
    expect(text(umgebung)).toContain('VLAN 77');
    const abbauText = text(kap(d, 'abbau').bloecke);
    expect(abbauText).toContain('9f8e7d6c');
    expect(abbauText).toContain('Lab-Netz löschen');
    expect(abbauText).not.toContain('Lab-Netz anlegen');
    expect(kap(d, 'befunde').bloecke).toEqual([{ art: 'frei', feld: 'befunde_produktion' }]);
    expect(d.anhaenge.map(a => a.name)).toEqual(['rohlauf-288c3716.json', 'rohlauf-3a5b7c9d.json', 'rohlauf-9f8e7d6c.json', 'PRUEFUNG.txt']);
  });

  it('ohne Testfälle und Verbindungsprüfung → nicht belegt statt geglättet', () => {
    const d = baueTestprotokoll('leer', [abbau], leer, {}, JETZT);
    expect(pruefeDokument(d)).toEqual([]);
    expect(kap(d, 'faelle').bloecke.some(b => b.art === 'nichtBelegt')).toBe(true);
    expect(kap(d, 'umgebung').bloecke.filter(b => b.art === 'nichtBelegt')).toHaveLength(2);
  });
});

function quellen(changes: CmdbChangeRequest[], incidents: Array<{ id: string; createdAt: string; text: string }> = []): DokuQuellen {
  return { changes: async () => ({ changes, abgeschnitten: false }), haltIncidents: async () => ({ incidents, abgeschnitten: false }) };
}

describe('Sammler', () => {
  it('itsmQuellen: Incidents ab Anlage des Changes, Grenze erreicht → abgeschnitten', async () => {
    const aufrufe: Array<{ since?: string; limit: number }> = [];
    const halt = { id: 'i1', createdAt: '2026-11-14T08:10:00.000Z', description: `Change ${aufbau.id} (x) angehalten.\nSchritt 1: Fehler` };
    const fremd = { id: 'i2', createdAt: '2026-11-14T08:11:00.000Z', description: 'Platte voll' };
    const itsm = (incidents: typeof halt[] | Array<typeof fremd>, changes: CmdbChangeRequest[]): ItsmLesend => ({
      listChangeRequests: async () => changes,
      listIncidents: async (_o, f) => { aufrufe.push(f); return incidents.slice(0, f.limit); },
    });
    const q = itsmQuellen(itsm([halt, fremd], [aufbau]), 3);
    expect(await q.haltIncidents('o', aufbau.id, aufbau.createdAt)).toEqual({ incidents: [{ id: 'i1', createdAt: halt.createdAt, text: halt.description }], abgeschnitten: false });
    expect(aufrufe[0]).toEqual({ since: aufbau.createdAt, limit: 3 });
    expect(await q.changes('o')).toEqual({ changes: [aufbau], abgeschnitten: false });
    // Grenze erreicht (auch wenn die Treffer selbst wenige sind)
    const voll = itsmQuellen(itsm([halt, fremd, fremd], [aufbau, abbau]), 2);
    expect((await voll.haltIncidents('o', aufbau.id, aufbau.createdAt)).abgeschnitten).toBe(true);
    expect((await voll.changes('o')).abgeschnitten).toBe(true);
  });

  it('abgeschnittene Change-Liste: volle ID wird gefunden, sonst Hinweis auf die Grenze statt „nicht gefunden“/„eindeutig“', async () => {
    const q: DokuQuellen = { changes: async () => ({ changes: [aufbau, abbau], abgeschnitten: true }), haltIncidents: async () => ({ incidents: [], abgeschnitten: false }) };
    expect(await findeChange(q, 'o', aufbau.id)).toBe(aufbau);
    for (const ref of ['9f8e', 'deadbeef']) {
      const r = await findeChange(q, 'o', ref);
      expect(typeof r).toBe('string');
      expect(r).toContain('Abfragegrenze');
      expect(r).not.toContain('nicht gefunden');
    }
  });

  it('abgeschnittene Incident-Liste: seit = Anlage des Changes, Verlauf trägt die Grenze, Dokument belegt sie offen', async () => {
    const seit: string[] = [];
    const inc = [{ id: 'i1', createdAt: '2026-11-14T08:10:00.000Z', text: `Change ${aufbau.id} (PKI-Lab aufbauen) angehalten.\nSchritt 3: Fehler` }];
    const q: DokuQuellen = { changes: async () => ({ changes: [], abgeschnitten: false }), haltIncidents: async (_o, _id, s) => { seit.push(s); return { incidents: inc, abgeschnitten: true }; } };
    const r = await verlaufVon(q, 'o', aufbau);
    expect(seit).toEqual([aufbau.createdAt]);
    expect(r).toMatchObject({ quelle: 'incidents', abgeschnitten: true });
    const leerAb = await verlaufVon({ ...q, haltIncidents: async () => ({ incidents: [], abgeschnitten: true }) }, 'o', aufbau);
    expect(leerAb).toEqual({ eintraege: [], quelle: 'keine', abgeschnitten: true });
    const grund = `Change 288c3716: Incident-Liste abgeschnitten — Verlauf möglicherweise unvollständig`;
    const d = baueAbnahme([aufbau], new Map([[aufbau.id, leerAb]]), {}, JETZT);
    expect(kap(d, 'verlauf').bloecke).toEqual([{ art: 'nichtBelegt', grund }]);
    const t = baueTestprotokoll('lab', [aufbau], new Map([[aufbau.id, r]]), {}, JETZT);
    expect(kap(t, 'faelle').bloecke).toContainEqual({ art: 'nichtBelegt', grund });
    // ohne Grenze kein Hinweis
    expect(await verlaufVon(quellen([], inc), 'o', aufbau)).not.toHaveProperty('abgeschnitten');
  });

  it('findeChange: volle ID, eindeutiges Präfix, mehrdeutig, unbekannt', async () => {
    const x = change('288c3716-9999-2222-3333-444444444444', 'Zweiter', []);
    const q = quellen([aufbau, x, abbau]);
    expect(await findeChange(q, 'o', aufbau.id)).toBe(aufbau);
    expect(await findeChange(q, 'o', '9f8e')).toBe(abbau);
    const mehr = await findeChange(q, 'o', '288c37');
    expect(typeof mehr).toBe('string');
    expect(mehr).toContain('288c3716-1111');
    expect(mehr).toContain('288c3716-9999');
    expect(await findeChange(q, 'o', 'deadbeef')).toContain('nicht gefunden');
  });

  it('verlaufVon: aus dem Lauf, sonst aus Halte-Incidents, sonst keine', async () => {
    const mitVerlauf = { ...aufbau, lauf: { ...(aufbau.lauf as object), verlauf: [{ zeit: 'z', art: 'wiederholen', schritt: 2, text: 'Schritt wiederholt' }] } } as CmdbChangeRequest;
    expect(await verlaufVon(quellen([]), 'o', mitVerlauf)).toEqual({ eintraege: [{ zeit: 'z', art: 'wiederholen', schritt: 2, text: 'Schritt wiederholt' }], quelle: 'lauf' });

    const inc = [
      { id: 'i1', createdAt: '2026-11-14T08:10:00.000Z', text: `Change ${aufbau.id} (PKI-Lab aufbauen) angehalten.\nSchritt 3 „X“: Fehler` },
      { id: 'i2', createdAt: '2026-11-14T08:11:00.000Z', text: `Change ${abbau.id} (anderer) angehalten.\nSchritt 1: anders` },
    ];
    const r = await verlaufVon(quellen([], inc), 'o', aufbau);
    expect(r.quelle).toBe('incidents');
    expect(r.eintraege).toEqual([{ zeit: '2026-11-14T08:10:00.000Z', art: 'halt', schritt: 3, text: 'Schritt 3 „X“: Fehler' }]);

    expect(await verlaufVon(quellen([]), 'o', aufbau)).toEqual({ eintraege: [], quelle: 'keine' });
  });

  it('verlaufVon: Lauf-Verlauf ohne Halt + Halte-Incidents → eingereiht, ohne Doppel, geschwärzt', async () => {
    const c = { ...aufbau, lauf: { ...(aufbau.lauf as object), verlauf: [{ zeit: '2026-11-15T10:00:00.000Z', art: 'wiederholen', schritt: 3, text: 'Schritt 3 wird wiederholt' }] } } as CmdbChangeRequest;
    const halt = { id: 'i1', createdAt: '2026-11-14T08:10:00.000Z', text: `Change ${aufbau.id} (PKI-Lab aufbauen) angehalten.
Schritt 3: Fehler ${'a'.repeat(270)}
password=Geheim123!` };
    const r = await verlaufVon(quellen([], [halt, halt]), 'o', c);
    expect(r.quelle).toBe('lauf+incidents');
    expect(r.eintraege.map(e => e.art)).toEqual(['halt', 'wiederholen']);
    expect(JSON.stringify(r)).not.toContain('Geheim');
    // derselbe Halt im Lauf (Motor merkt ihn kurz vor dem Anlegen des Incidents): nur der Lauf, kein Doppel
    const mitHalt = { ...aufbau, lauf: { ...(aufbau.lauf as object), verlauf: [{ zeit: '2026-11-14T08:09:59.900Z', art: 'halt', schritt: 3, text: 'x' }] } } as CmdbChangeRequest;
    expect(await verlaufVon(quellen([], [halt]), 'o', mitHalt)).toMatchObject({ quelle: 'lauf', eintraege: [{ text: 'x' }] });
  });

  it('verlaufVon: Halt vor dem Deploy nur im Incident, danach wiederholt und erneut angehalten → alle drei in Reihenfolge', async () => {
    const t0 = '2026-11-14T08:10:00.000Z'; const t1 = '2026-11-15T07:00:00.000Z'; const t2 = '2026-11-15T07:05:00.000Z';
    const c = { ...aufbau, lauf: { ...(aufbau.lauf as object), verlauf: [
      { zeit: t1, art: 'wiederholen', schritt: 3, text: 'Schritt 3 wird wiederholt' },
      { zeit: t2, art: 'halt', schritt: 3, text: 'Schritt 3: wieder Fehler' },
    ] } } as CmdbChangeRequest;
    const inc = [{ id: 'i1', createdAt: t0, text: `Change ${aufbau.id} (PKI-Lab aufbauen) angehalten.\nSchritt 3: erster Fehler` }];
    const r = await verlaufVon(quellen([], inc), 'o', c);
    expect(r.quelle).toBe('lauf+incidents');
    expect(r.eintraege.map(e => [e.zeit, e.art])).toEqual([[t0, 'halt'], [t1, 'wiederholen'], [t2, 'halt']]);
    expect(r.eintraege[0]!.text).toBe('Schritt 3: erster Fehler');
  });

  it('Builder: offene Plan-Korrektur wird genannt statt „kein Verlauf erfasst“; entschiedene nicht', () => {
    const korrektur = { abSchritt: 2, zeit: '2026-11-14T08:20:00.000Z' };
    const offen = { ...aufbau, status: 'in_progress', lauf: { ...(aufbau.lauf as object), phase: 'angehalten', korrektur } } as CmdbChangeRequest;
    const d = baueAbnahme([offen], leer, {}, JETZT);
    const t = text(kap(d, 'verlauf').bloecke);
    expect(t).toContain('Plan ab Schritt 2 am 2026-11-14 08:20:00 UTC');
    expect(t).toContain('noch nicht entschieden (nur die letzte Korrektur ist erfasst)');
    expect(t).not.toContain('kein Verlauf erfasst');
    const tp = baueTestprotokoll('lab', [offen], leer, {}, JETZT);
    expect(text(kap(tp, 'faelle').bloecke)).toContain('noch nicht entschieden');
    const entschieden = new Map([[offen.id, { eintraege: [{ zeit: korrektur.zeit, art: 'plan_geaendert' as const, schritt: 2, text: 'Plan ab Schritt 2 korrigiert' }], quelle: 'lauf' }]]);
    expect(text(kap(baueAbnahme([offen], entschieden, {}, JETZT), 'verlauf').bloecke)).not.toContain('noch nicht entschieden');
    const gemischt = new Map([[offen.id, { eintraege: [{ zeit: 'z', art: 'halt' as const, schritt: 2, text: 'h' }], quelle: 'lauf+incidents' }]]);
    expect(text(kap(baueAbnahme([aufbau], gemischt, {}, JETZT), 'verlauf').bloecke)).toContain('rekonstruiert aus Halte-Incidents');
  });
});
