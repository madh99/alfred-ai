import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CmdbAsset, CmdbChangeRequest, CmdbDocument, SkillContext } from '@alfred/types';
import { DokumentationSkill, DokumenteDienst, type DokumenteDeps } from './dokumente-skill.js';
import { lege, type AblageDeps } from './ablage.js';
import type { Dokument } from './modell.js';
import type { BetriebQuellen } from './betrieb-quellen.js';

const JETZT = '2026-11-15T09:27:53.000Z';
const CTX = { userId: 'o', platform: 'api', chatId: 'c' } as unknown as SkillContext;

function change(id: string, title: string, extra: Partial<CmdbChangeRequest> = {}): CmdbChangeRequest {
  return {
    id, userId: 'o', title, type: 'normal', status: 'completed', riskLevel: 'low', affectedAssetIds: [], affectedServiceIds: [],
    createdAt: '2026-11-14T07:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z',
    fingerabdruck: 'abcdef0123456789abcdef', freigabeFingerabdruck: 'abcdef0123456789abcdef', freigegebenAt: '2026-11-14T07:30:00.000Z', freigegebenUeber: 'frage',
    schritte: [
      { nr: 1, titel: 'Lab-Netz anlegen', art: 'aktion', skill: 'unifi', aktion: 'create_network', zeitlimitS: 60, beiFehler: 'anhalten' },
      { nr: 2, titel: 'TLS prüfen', art: 'aktion', skill: 'pki_lab', aktion: 'tls_negativtest', zeitlimitS: 60, beiFehler: 'anhalten' },
    ],
    lauf: {
      phase: 'fertig', schritt: 2, start: '2026-11-14T08:00:00.000Z', ende: '2026-11-14T08:30:00.000Z',
      ergebnisse: [
        { nr: 1, ok: true, start: '2026-11-14T08:00:00.000Z', ende: '2026-11-14T08:01:00.000Z', ausgabe: 'Netz pki-lab angelegt — Größe „ok“' },
        { nr: 2, ok: true, start: '2026-11-14T08:02:00.000Z', ende: '2026-11-14T08:03:00.000Z', ausgabe: 'password=Geheim123!', daten: { ergebnis: 'EXPECTED_TLS_FAILURE' } },
      ],
    },
    ...extra,
  } as CmdbChangeRequest;
}

const A = change('288c3716-1111-2222-3333-444444444444', 'PKI-Lab aufbauen');
const B = change('288c9999-1111-2222-3333-444444444444', 'Anderer Change');
const C = change('7335dfeb-1111-2222-3333-444444444444', 'PKI-Lab abbauen');

function aufbau(opts: { changes?: CmdbChangeRequest[]; abgeschnitten?: boolean; langsam?: boolean; pve2?: (z: string, l: string) => Promise<{ ok: boolean; fehler?: string }> } = {}) {
  const gespeichert: Array<Parameters<DokumenteDeps['cmdb']['saveDocument']>[1] & { id: string; version: number }> = [];
  const lokal = new Map<string, Buffer>();
  const pve2: Array<{ ziel: string; lokal: string }> = [];
  const instanzen: Array<{ id: string; name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[]; status: string; createdAt: string; vorlageKey?: string; vorlageVersion?: number }> = [];
  const ablage: AblageDeps = {
    schreibeLokal: vi.fn(async (p: string, b: Buffer) => { lokal.set(p, b); }),
    sendeAnPve2: vi.fn(async (z: string, l: string) => { pve2.push({ ziel: z, lokal: l }); return opts.pve2 ? opts.pve2(z, l) : { ok: true }; }),
  };
  const deps: DokumenteDeps = {
    owner: () => 'o',
    istOwner: () => true,
    quellen: { changes: async () => ({ changes: opts.changes ?? [A, B, C], abgeschnitten: opts.abgeschnitten ?? false }), haltIncidents: async () => ({ incidents: [], abgeschnitten: false }) },
    cmdb: {
      saveDocument: vi.fn(async (_u, doc) => {
        const version = gespeichert.filter(g => g.docType === doc.docType && g.linkedEntityId === doc.linkedEntityId).length + 1;
        // langsam: Version wird vor dem Einfügen bestimmt (wie MAX(version)+1 ohne Sperre) — ohne Serialisierung bekämen beide v1
        if (opts.langsam) await new Promise(r => setTimeout(r, 20));
        const e = { ...doc, id: `doc-${gespeichert.length + 1}`, version };
        gespeichert.push(e);
        return { ...e, userId: 'o', format: 'markdown', createdAt: JETZT } as CmdbDocument;
      }),
      getDocumentById: async (_u, id) => {
        const e = gespeichert.find(g => g.id === id);
        return e ? ({ ...e, userId: 'o', format: 'markdown', createdAt: JETZT } as CmdbDocument) : null;
      },
    },
    instanzen: {
      anlegen: async (_u, d: Parameters<DokumenteDeps['instanzen']['anlegen']>[1] & { vorlageKey?: string; vorlageVersion?: number }) => { const i = { id: `inst-${instanzen.length + 1}`, ...d, status: 'aktiv', createdAt: JETZT }; instanzen.push(i); return i; },
      finde: async (_u, x) => instanzen.find(i => i.id === x || i.name === x),
      aendern: async (_u, id, d) => { const i = instanzen.find(z => z.id === id); if (i) Object.assign(i, d); },
      findeNachChange: async (_u, cid) => instanzen.find(i => i.changeIds.includes(cid)),
    },
    ablage,
    datenOrdner: '/daten',
    jetzt: () => JETZT,
  };
  return { skill: new DokumentationSkill(new DokumenteDienst(deps)), deps, gespeichert, lokal, pve2, ablage, cmdbSave: deps.cmdb.saveDocument };
}

describe('Skill dokumentation', () => {
  it('(a) mehrdeutige Change-ID: Fehler nennt beide, nichts gespeichert, nichts abgelegt', async () => {
    const t = aufbau();
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: '288c' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('288c3716');
    expect(r.error).toContain('288c9999');
    expect(t.gespeichert).toHaveLength(0);
    expect(t.ablage.schreibeLokal).not.toHaveBeenCalled();
    expect(t.ablage.sendeAnPve2).not.toHaveBeenCalled();
  });

  it('(b) eindeutiger Change: gespeichert als abnahme mit Struktur, Anhänge PDF/DOCX/Rohlauf/PRUEFUNG, Ablage lokal und pve2', async () => {
    const t = aufbau();
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: '288c3716', zweck: 'Lab für TLS-Tests' }, CTX);
    expect(r.success, r.error).toBe(true);
    expect(t.gespeichert).toHaveLength(1);
    const g = t.gespeichert[0]!;
    expect(g.docType).toBe('abnahme');
    expect(g.linkedEntityType).toBe('change_request');
    expect(g.linkedEntityId).toBe(A.id);
    expect(g.generatedBy).toBe('vorlage:abnahme@1');
    const d = JSON.parse(g.struktur!) as Dokument;
    expect(d.kopf.art).toBe('abnahme');
    expect(g.content).toContain('Lab für TLS-Tests');
    expect(JSON.stringify(g)).not.toContain('Geheim123!');
    expect(r.attachments!.map(a => a.fileName)).toEqual(['abnahme-288c3716-v1.pdf', 'abnahme-288c3716-v1.docx', 'rohlauf-288c3716.json', 'PRUEFUNG.txt']);
    expect(r.attachments![0]!.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.attachments![1]!.data.subarray(0, 2).toString()).toBe('PK');
    const lokal = path.join('/daten', 'dokumente', 'change-288c3716', 'v1');
    expect([...t.lokal.keys()]).toEqual(r.attachments!.map(a => path.join(lokal, a.fileName)));
    expect(t.pve2.map(p => p.ziel)).toEqual(r.attachments!.map(a => `/srv/alfred-dokumente/change-288c3716/v1/${a.fileName}`));
    expect(r.display).toContain(d.kopf.titel);
    expect(r.display).toContain('Version 1');
    expect(r.display).toContain(lokal);
    expect(r.display).toContain('pve2: ok');
  });

  it('Rohlauf-Datei: SHA-256 der Bytes = Zeile in PRUEFUNG.txt (sha256sum -c), ohne BOM', async () => {
    const t = aufbau();
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    const roh = r.attachments!.find(a => a.fileName === 'rohlauf-288c3716.json')!;
    const pruef = r.attachments!.find(a => a.fileName === 'PRUEFUNG.txt')!.data.toString('utf8');
    expect(roh.data[0]).not.toBe(0xef);
    const summe = createHash('sha256').update(roh.data).digest('hex');
    expect(pruef.split('\n')).toContain(`${summe}  rohlauf-288c3716.json`);
    expect(r.display).toContain(summe);
    // lokal abgelegt sind exakt dieselben Bytes
    const lokal = [...t.lokal.entries()].find(([p]) => p.endsWith('rohlauf-288c3716.json'))![1];
    expect(createHash('sha256').update(lokal).digest('hex')).toBe(summe);
  });

  it('Freitextgrenze gilt nach der Schwärzung: verlängert sie den Text über die Grenze, klare Meldung statt „Dokument ungültig“', async () => {
    const t = aufbau();
    const frei = 'password=Geheim123! ' + 'x'.repeat(580); // 600 Zeichen, geschwärzt 602
    expect(frei.length).toBeLessThanOrEqual(600);
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id, zweck: frei }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/zweck zu lang: \d+ Zeichen nach der Schwärzung/);
    expect(r.error).not.toContain('Dokument ungültig');
    expect(t.gespeichert).toHaveLength(0);
  });

  it('(c) zweck mit 601 Zeichen → Fehler, nichts gespeichert', async () => {
    const t = aufbau();
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id, zweck: 'x'.repeat(601) }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/zweck/);
    expect(t.gespeichert).toHaveLength(0);
  });

  it('Markdown über 500 000 Zeichen → Fehler statt gekürzt zu speichern', async () => {
    const riesig = change(A.id, 'Riesig', {
      schritte: Array.from({ length: 400 }, (_, i) => ({ nr: i + 1, titel: `Schritt ${i + 1} ${'t'.repeat(1500)}`, art: 'aktion', skill: 'x', aktion: 'y', zeitlimitS: 60, beiFehler: 'anhalten' })) as never,
      lauf: { phase: 'fertig', schritt: 400, ergebnisse: Array.from({ length: 400 }, (_, i) => ({ nr: i + 1, ok: true, ausgabe: 'a'.repeat(1400) })) } as never,
    });
    const t = aufbau({ changes: [riesig] });
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/500.?000/);
    expect(t.gespeichert).toHaveLength(0);
    expect(t.ablage.schreibeLokal).not.toHaveBeenCalled();
  });

  it('(d) instanz_anlegen + testprotokoll_erzeugen → an die Bauplan-Instanz gebunden', async () => {
    const t = aufbau();
    const i = await t.skill.execute({ action: 'instanz_anlegen', name: 'pki-lab-2026-11-15', dokumentart: 'testprotokoll', changes: ['288c3716', '7335dfeb'] }, CTX);
    expect(i.success, i.error).toBe(true);
    const r = await t.skill.execute({ action: 'testprotokoll_erzeugen', instanz: 'pki-lab-2026-11-15', befunde_produktion: 'SqlClient prüft keinen Widerruf' }, CTX);
    expect(r.success, r.error).toBe(true);
    const g = t.gespeichert[0]!;
    expect(g.docType).toBe('testprotokoll');
    expect(g.linkedEntityType).toBe('bauplan_instanz');
    expect(g.linkedEntityId).toBe('inst-1');
    expect(g.generatedBy).toBe('vorlage:testprotokoll@1');
    expect(r.attachments!.map(a => a.fileName)).toEqual(['testprotokoll-pki-lab-2026-11-15-v1.pdf', 'testprotokoll-pki-lab-2026-11-15-v1.docx', 'rohlauf-288c3716.json', 'rohlauf-7335dfeb.json', 'PRUEFUNG.txt']);
    expect(t.pve2[0]!.ziel).toBe('/srv/alfred-dokumente/pki-lab-2026-11-15/v1/testprotokoll-pki-lab-2026-11-15-v1.pdf');
  });

  it('instanz_anlegen: ungültiger Name, mehrdeutiger Change und doppelter Name werden abgewiesen', async () => {
    const t = aufbau();
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: '../x', dokumentart: 'testprotokoll', changes: [A.id] }, CTX)).success).toBe(false);
    // Ordner der Abnahmeprotokolle (change-…, serie-…) sind für Instanzen gesperrt
    for (const name of ['change-288c3716', 'serie-51515151', 'Change-x', 'SERIE-x']) {
      const r = await t.skill.execute({ action: 'instanz_anlegen', name, dokumentart: 'testprotokoll', changes: [A.id] }, CTX);
      expect(r.success, name).toBe(false);
      expect(r.error).toContain('change-');
    }
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'changes-lab', dokumentart: 'testprotokoll', changes: [A.id] }, CTX)).success).toBe(true);
    const m = await t.skill.execute({ action: 'instanz_anlegen', name: 'lab', dokumentart: 'testprotokoll', changes: ['288c'] }, CTX);
    expect(m.success).toBe(false);
    expect(m.error).toContain('mehrdeutig');
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'lab', dokumentart: 'testprotokoll', changes: [A.id] }, CTX)).success).toBe(true);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'lab', dokumentart: 'testprotokoll', changes: [A.id] }, CTX)).success).toBe(false);
  });

  it('(e) Ablage-Name ../x → Fehler, sendeAnPve2 und schreibeLokal nie aufgerufen', async () => {
    const t = aufbau();
    const d = { kopf: { art: 'abnahme', artVersion: 1, titel: 't', ordner: '../x', erzeugt: JETZT, quellen: [], verweise: [] }, kapitel: [], anhaenge: [] } as Dokument;
    await expect(lege(d, 1, [{ name: 'a.pdf', inhalt: Buffer.from('x') }], t.ablage, '/daten')).rejects.toThrow(/ungültig/);
    await expect(lege({ ...d, kopf: { ...d.kopf, ordner: 'ok' } }, 1, [{ name: '../x', inhalt: Buffer.from('x') }], t.ablage, '/daten')).rejects.toThrow(/ungültig/);
    await expect(lege({ ...d, kopf: { ...d.kopf, ordner: '..' } }, 1, [{ name: 'a', inhalt: Buffer.from('x') }], t.ablage, '/daten')).rejects.toThrow(/ungültig/);
    expect(t.ablage.sendeAnPve2).not.toHaveBeenCalled();
    expect(t.ablage.schreibeLokal).not.toHaveBeenCalled();
  });

  it('(f) pve2-Fehler → trotzdem erfolgreich, display meldet „pve2: fehlgeschlagen“, lokale Ablage bleibt', async () => {
    const t = aufbau({ pve2: async () => ({ ok: false, fehler: 'Fernzugriff nicht verfügbar' }) });
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('pve2: fehlgeschlagen');
    expect(r.display).toContain('Fernzugriff nicht verfügbar');
    expect(t.lokal.size).toBe(4);
    expect(t.gespeichert).toHaveLength(1);
  });

  it('dokument_exportieren rendert aus der Struktur (nicht aus Markdown) und legt erneut ab', async () => {
    const t = aufbau();
    await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    t.gespeichert[0]!.content = 'VERFÄLSCHT';
    const r = await t.skill.execute({ action: 'dokument_exportieren', doc_id: 'doc-1' }, CTX);
    expect(r.success, r.error).toBe(true);
    expect(r.attachments!.map(a => a.fileName)).toEqual(['abnahme-288c3716-v1.pdf', 'abnahme-288c3716-v1.docx', 'rohlauf-288c3716.json', 'PRUEFUNG.txt']);
    expect(t.pve2).toHaveLength(8);
    expect((await t.skill.execute({ action: 'dokument_exportieren', doc_id: 'fehlt' }, CTX)).success).toBe(false);
  });

  it('nur für den Owner', async () => {
    const t = aufbau();
    t.deps.istOwner = () => false;
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    expect(r.success).toBe(false);
    expect(t.gespeichert).toHaveLength(0);
  });

  it('zwei gleichzeitige abnahme_erzeugen für denselben Change → Versionen 1 und 2, getrennte Ordner', async () => {
    const t = aufbau({ langsam: true });
    const [r1, r2] = await Promise.all([
      t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX),
      t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX),
    ]);
    expect(r1.success && r2.success).toBe(true);
    expect(t.gespeichert.map(g => g.version).sort()).toEqual([1, 2]);
    const ordner = new Set([...t.lokal.keys()].map(p => path.basename(path.dirname(p))));
    expect([...ordner].sort()).toEqual(['v1', 'v2']);
    expect(r1.attachments![0]!.fileName).not.toBe(r2.attachments![0]!.fileName);
    // ein Fehler in der Kette blockiert die nächste Erzeugung nicht
    const t2 = aufbau();
    const [f, ok] = await Promise.all([
      t2.skill.execute({ action: 'abnahme_erzeugen', change: A.id, zweck: 'x'.repeat(601) }, CTX),
      t2.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX),
    ]);
    expect(f.success).toBe(false);
    expect(ok.success).toBe(true);
  });

  it('abgeschnittene Change-Liste: Präfix wird nicht als „nicht gefunden“ gemeldet, Testprotokoll nennt die Grenze', async () => {
    const t = aufbau({ abgeschnitten: true });
    const r = await t.skill.execute({ action: 'abnahme_erzeugen', change: 'ffff' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Abfragegrenze');
    expect((await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX)).success).toBe(true);
    await t.deps.instanzen.anlegen('o', { name: 'lab', dokumentart: 'testprotokoll', changeIds: ['nicht-geladen'] });
    const tp = await t.skill.execute({ action: 'testprotokoll_erzeugen', instanz: 'lab' }, CTX);
    expect(tp.error).toContain('Abfragegrenze');
  });

  it('dokument_exportieren: gespeicherte artVersion 1 (= aktuell) wird exportiert, unbekannte Versionen nicht', async () => {
    // Heute gibt es je Art nur Version 1; der Export prüft die Struktur, weist aber eine ältere bekannte Version nicht ab.
    // Mit erzwungener artVersion 1 muss er gelingen; 0 und eine neuere (unbekannte) Version werden abgewiesen.
    const t = aufbau();
    await t.skill.execute({ action: 'abnahme_erzeugen', change: A.id }, CTX);
    const setze = (v: number) => { const d = JSON.parse(t.gespeichert[0]!.struktur!) as Dokument; d.kopf.artVersion = v; t.gespeichert[0]!.struktur = JSON.stringify(d); };
    setze(1);
    expect((await t.skill.execute({ action: 'dokument_exportieren', doc_id: 'doc-1' }, CTX)).success).toBe(true);
    for (const v of [0, 99]) {
      setze(v);
      const r = await t.skill.execute({ action: 'dokument_exportieren', doc_id: 'doc-1' }, CTX);
      expect(r.success).toBe(false);
      expect(r.error).toContain('unbekannt');
    }
  });

});

describe('abnahmeNachEnde (Automatik nach Change-Ende, V2)', () => {
  const zeileVon = async (d: DokumenteDienst, o: string, c: CmdbChangeRequest, s?: 'completed' | 'failed' | 'rolled_back' | 'cancelled') => (await d.abnahmeNachEnde(o, c, s))?.zeile;
  const std = (id: string, title: string, abhaengigVon: string[] = []) => change(id, title, { type: 'standard', abhaengigVon });
  const S1 = std('51515151-1111-2222-3333-444444444444', 'Serie Teil 1');
  const S2 = std('52525252-1111-2222-3333-444444444444', 'Serie Teil 2', [S1.id]);
  const S3 = std('53535353-1111-2222-3333-444444444444', 'Serie Teil 3', [S2.id, A.id]);

  it('(c) normaler Change: Abnahme mit linkedEntityId = Change-ID, aus dem neu geladenen (gespeicherten) Lauf', async () => {
    const t = aufbau();
    // der Motor übergibt einen Stand ohne Lauf; maßgeblich ist der gespeicherte Change
    const veraltet = { ...C, lauf: undefined } as CmdbChangeRequest;
    const zeile = await zeileVon(new DokumenteDienst(t.deps), 'o', veraltet);
    expect(zeile).toContain('Abnahmeprotokoll erstellt');
    expect(zeile).toContain('7335dfeb');
    expect(t.gespeichert).toHaveLength(1);
    expect(t.gespeichert[0]!.docType).toBe('abnahme');
    expect(t.gespeichert[0]!.linkedEntityType).toBe('change_request');
    expect(t.gespeichert[0]!.linkedEntityId).toBe(C.id);
    expect((JSON.parse(t.gespeichert[0]!.struktur!) as Dokument).anhaenge.map(a => a.name)).toContain('rohlauf-7335dfeb.json');
  });

  it('(b) mittleres Glied einer Standard-Serie → Hinweiszeile, nichts gespeichert; letztes Glied → ein Sammelprotokoll über alle Glieder', async () => {
    const t = aufbau({ changes: [A, S1, S2, S3] });
    const dienst = new DokumenteDienst(t.deps);
    expect(await zeileVon(dienst, 'o', S1)).toBe('Sammelprotokoll folgt mit dem letzten Glied der Serie (52525252)');
    expect(await zeileVon(dienst, 'o', S2)).toBe('Sammelprotokoll folgt mit dem letzten Glied der Serie (53535353)');
    expect(t.cmdbSave).not.toHaveBeenCalled();
    const zeile = await zeileVon(dienst, 'o', S3);
    expect(zeile).toContain('Sammelprotokoll');
    expect(t.gespeichert).toHaveLength(1);
    const d = JSON.parse(t.gespeichert[0]!.struktur!) as Dokument;
    // Reihenfolge Vorgänger zuerst; der normale Change A gehört nicht zur Serie
    expect(d.kopf.verweise).toEqual([`change:${S1.id}`, `change:${S2.id}`, `change:${S3.id}`]);
    expect(d.kopf.ordner).toBe('serie-51515151');
    expect(t.gespeichert[0]!.linkedEntityId).toBe(S3.id);
  });

  it('mittleres Glied endet gescheitert/zurückgerollt/abgebrochen → Sammelprotokoll sofort über die Serie bis hierher (Nachfolger startet nie)', async () => {
    for (const s of ['failed', 'rolled_back', 'cancelled'] as const) {
      const t = aufbau({ changes: [S1, S2, S3] });
      const zeile = await zeileVon(new DokumenteDienst(t.deps), 'o', { ...S2, status: s } as CmdbChangeRequest, s);
      expect(zeile).toContain('Sammelprotokoll erstellt');
      expect(t.gespeichert).toHaveLength(1);
      const d = JSON.parse(t.gespeichert[0]!.struktur!) as Dokument;
      expect(d.kopf.verweise).toEqual([`change:${S1.id}`, `change:${S2.id}`]);
      expect(t.gespeichert[0]!.linkedEntityId).toBe(S2.id);
    }
    // abgeschlossen → weiter Hinweis auf das letzte Glied
    const t = aufbau({ changes: [S1, S2, S3] });
    expect(await zeileVon(new DokumenteDienst(t.deps), 'o', S2, 'completed')).toContain('Sammelprotokoll folgt');
  });

  it('Zustellung an den Owner: Ergebnis trägt PDF und DOCX als Anhänge', async () => {
    const t = aufbau();
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', C, 'completed');
    expect(r!.anhaenge!.map(a => a.fileName)).toEqual(['abnahme-7335dfeb-v1.pdf', 'abnahme-7335dfeb-v1.docx']);
    expect(r!.anhaenge![0]!.data.subarray(0, 5).toString()).toBe('%PDF-');
    // Hinweis- und Fehlerzeilen tragen keine Anhänge
    const t2 = aufbau({ changes: [S1, S2] });
    expect((await new DokumenteDienst(t2.deps).abnahmeNachEnde('o', S1, 'completed'))!.anhaenge).toBeUndefined();
  });

  it('Standard-Serie mit Zyklus in den Vorgängern bricht ab und nimmt jedes Glied einmal', async () => {
    const Z1 = std('61616161-1111-2222-3333-444444444444', 'Z1', ['62626262-1111-2222-3333-444444444444']);
    const Z2 = std('62626262-1111-2222-3333-444444444444', 'Z2', [Z1.id]);
    const Z3 = std('63636363-1111-2222-3333-444444444444', 'Z3', [Z2.id]);
    const t = aufbau({ changes: [Z1, Z2, Z3] });
    expect(await zeileVon(new DokumenteDienst(t.deps), 'o', Z3)).toContain('Sammelprotokoll');
    const d = JSON.parse(t.gespeichert[0]!.struktur!) as Dokument;
    expect(d.kopf.verweise).toEqual([`change:${Z1.id}`, `change:${Z2.id}`, `change:${Z3.id}`]);
  });

  it('einzelner Standard-Change ohne Nachfolger → Sammelprotokoll über ihn allein; vor dem Start verworfener Nachfolger zählt nicht', async () => {
    const verworfen = { ...std('70707070-1111-2222-3333-444444444444', 'verworfen', [S1.id]), status: 'cancelled', lauf: undefined } as CmdbChangeRequest;
    const t = aufbau({ changes: [S1, verworfen] });
    expect(await zeileVon(new DokumenteDienst(t.deps), 'o', S1)).toContain('Abnahmeprotokoll erstellt');
    expect(t.gespeichert).toHaveLength(1);
    expect(t.gespeichert[0]!.linkedEntityId).toBe(S1.id);
  });

  it('Fehler → Zeile „Abnahmeprotokoll nicht erstellt: <grund>“, wirft nie; pve2-Fehler wird in der Zeile genannt', async () => {
    const t = aufbau();
    t.deps.cmdb.saveDocument = async () => { throw new Error('DB weg'); };
    const log: string[] = [];
    t.deps.protokoll = (m) => { log.push(m); };
    expect(await zeileVon(new DokumenteDienst(t.deps), 'o', C)).toBe('Abnahmeprotokoll nicht erstellt: DB weg');
    expect(log.some(m => m.includes('nicht erstellt'))).toBe(true);
    const t2 = aufbau({ pve2: async () => ({ ok: false, fehler: 'Fernzugriff nicht verfügbar' }) });
    const z = await zeileVon(new DokumenteDienst(t2.deps), 'o', C);
    expect(z).toContain('Abnahmeprotokoll erstellt');
    expect(z).toContain('pve2: fehlgeschlagen');
    expect(z).toContain('Fernzugriff nicht verfügbar');
    // Change-Liste nicht ladbar: normaler Change → aus dem übergebenen, gerade gespeicherten Stand; Standard → nicht erstellt
    const t3 = aufbau();
    t3.deps.quellen = { ...t3.deps.quellen, changes: async () => { throw new Error('Liste weg'); } };
    const z3 = await zeileVon(new DokumenteDienst(t3.deps), 'o', C);
    expect(z3).toContain('Abnahmeprotokoll erstellt');
    expect(t3.gespeichert).toHaveLength(1);
    expect(t3.gespeichert[0]!.linkedEntityId).toBe(C.id);
    expect(await zeileVon(new DokumenteDienst(t3.deps), 'o', change('80808080-1111-2222-3333-444444444444', 'Std', { type: 'standard' }))).toBe('Abnahmeprotokoll nicht erstellt: Liste weg');
    expect(t3.gespeichert).toHaveLength(1);
  });

  it('Standard-Change, abgeschnittene Change-Liste → nicht erstellt (Nachfolger nicht sicher prüfbar), nie geglättet', async () => {
    const t = aufbau({ changes: [S1], abgeschnitten: true });
    const z = await zeileVon(new DokumenteDienst(t.deps), 'o', S1);
    expect(z).toMatch(/^Abnahmeprotokoll nicht erstellt: .*Abfragegrenze/);
    expect(t.gespeichert).toHaveLength(0);
  });
});

describe('Skill dokumentation — Betriebs-Instanz', () => {
  const VID = 'a1b2c3d4-0000-0000-0000-000000000001';
  const DID = 'd0c0d0c0-0000-0000-0000-000000000009';
  const DID2 = 'e1e1e1e1-0000-0000-0000-000000000002';
  const assets = [
    { id: 'aaaaaaaa-1111', name: 'pkiiss01', assetType: 'vm' },
    { id: 'bbbbbbbb-2222', name: 'pkiroot01', assetType: 'vm' },
    { id: 'cccccccc-3333', name: 'dopp', assetType: 'vm', status: 'active', sourceSkill: 'proxmox' },
    { id: 'dddddddd-4444', name: 'Dopp', assetType: 'vm', status: 'active', sourceSkill: 'infrastruktur' },
    { id: 'eeeeeeee-5555', name: 'alt', assetType: 'vm', status: 'decommissioned' },
    { id: '99999999-8888', name: 'beide', assetType: 'vm', status: 'decommissioned' },
    { id: '99999999-9999', name: 'beide', assetType: 'server', status: 'decommissioned' },
    // echtes Muster: VM (Proxmox) und Server (Fernzugang) gleichen Namens aktiv, dazu alte VM außer Betrieb
    { id: 'dc010000-0001', name: 'dc01', assetType: 'vm', status: 'active', sourceSkill: 'proxmox' },
    { id: 'dc010000-0002', name: 'dc01', assetType: 'server', status: 'active', sourceSkill: 'fernzugriff' },
    { id: 'dc010000-0003', name: 'dc01', assetType: 'vm', status: 'decommissioned', sourceSkill: 'infrastruktur' },
    { id: 'dc010000-0004', name: 'DC02', assetType: 'vm', status: 'inactive', sourceSkill: 'proxmox' },
  ];
  function mitBetrieb() {
    const t = aufbau();
    t.deps.betrieb = {
      assetsNachName: async (_u, n) => assets.filter(a => a.name.toLowerCase() === n.toLowerCase()),
      assetNachId: async (_u, id) => assets.find(a => a.id.startsWith(id)) ?? null,
      vorhaben: async (_u, k) => (VID.startsWith(k) ? { id: VID, changeIds: [A.id, C.id] } : null),
      dokument: async (_u, k) => (DID.startsWith(k) ? { id: DID } : DID2.startsWith(k) ? { id: DID2 } : null),
      standardVorlagen: () => [{ key: 'os_updates', titel: '(h) Betriebssystem-Updates (Updates v2)' }, { key: 'ca_sicherung', titel: '(k) Wöchentliche Sicherung der Issuing-CA' }],
      jobKeys: () => ['pki-betrieb', 'os-updates'],
      tresorNamen: async () => ['pki-iss-sicherung', 'dc01-admin'],
    };
    return t;
  }

  it('aufbau_changes: über ID-Anfang aufgelöst, Reihenfolge bleibt; Unbekanntes und Doppeltes abgewiesen', async () => {
    const t = mitBetrieb();
    const ok = await t.skill.execute({ action: 'instanz_anlegen', name: 'a1', dokumentart: 'betrieb', assets: ['pkiiss01'], aufbau_changes: ['7335dfeb', '288c3716'] }, CTX);
    expect(ok.success, ok.error).toBe(true);
    expect(JSON.parse((await t.deps.instanzen.finde('o', 'a1'))!.parameter!).aufbauChangeIds).toEqual([C.id, A.id]);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'a2', dokumentart: 'betrieb', assets: ['pkiiss01'], aufbau_changes: ['ffffffff'] }, CTX)).error).toContain('aufbau_changes');
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'a3', dokumentart: 'betrieb', assets: ['pkiiss01'], aufbau_changes: ['288c3716', A.id] }, CTX)).error).toContain('doppelt');
    expect(await t.deps.instanzen.finde('o', 'a2')).toBeUndefined();
  });

  it('standard_vorlagen: Buchstabe „k“ wird zum echten Schlüssel, Unbekanntes nennt die gültigen; jobs und tresor gegen die Bestände geprüft', async () => {
    const t = mitBetrieb();
    const ok = await t.skill.execute({ action: 'instanz_anlegen', name: 'v1', dokumentart: 'betrieb', assets: ['pkiiss01'], standard_vorlagen: ['k', 'os_updates'], jobs: ['pki-betrieb'], tresor: ['pki-iss-sicherung'] }, CTX);
    expect(ok.success, ok.error).toBe(true);
    const par = JSON.parse((await t.deps.instanzen.finde('o', 'v1'))!.parameter!);
    expect(par.standardVorlagen).toEqual(['ca_sicherung', 'os_updates']);
    expect(par.tresor).toEqual(['pki-iss-sicherung']);
    const v = await t.skill.execute({ action: 'instanz_anlegen', name: 'v2', dokumentart: 'betrieb', assets: ['pkiiss01'], standard_vorlagen: ['z'] }, CTX);
    expect(v.error).toContain('Standard-Vorlage „z“ unbekannt');
    expect(v.error).toContain('ca_sicherung (k)');
    const d = await t.skill.execute({ action: 'instanz_anlegen', name: 'v3', dokumentart: 'betrieb', assets: ['pkiiss01'], standard_vorlagen: ['k', 'ca_sicherung'] }, CTX);
    expect(d.error).toContain('doppelt');
    const j = await t.skill.execute({ action: 'instanz_anlegen', name: 'v4', dokumentart: 'betrieb', assets: ['pkiiss01'], jobs: ['pki-betreib'] }, CTX);
    expect(j.error).toContain('„pki-betreib“');
    expect(j.error).toContain('gültig: os-updates, pki-betrieb');
    const tr = await t.skill.execute({ action: 'instanz_anlegen', name: 'v5', dokumentart: 'betrieb', assets: ['pkiiss01'], tresor: ['gibtsnicht'] }, CTX);
    expect(tr.error).toContain('„gibtsnicht“ gibt es nicht');
    for (const n of ['v2', 'v3', 'v4', 'v5']) expect(await t.deps.instanzen.finde('o', n)).toBeUndefined();
  });

  it('instanz_aendern: nur das angegebene Feld wird ersetzt, alles andere bleibt; id und Name gleich', async () => {
    const t = mitBetrieb();
    const r0 = await t.skill.execute({
      action: 'instanz_anlegen', name: 'pki', dokumentart: 'betrieb', assets: ['pkiiss01', 'bbbbbbbb'],
      vorhaben: 'a1b2c3', architektur_doc: 'd0c0d0', jobs: ['pki-betrieb'], standard_vorlagen: ['k'], restore_change: '7335dfeb', aufbau_changes: ['288c3716'],
    }, CTX);
    expect(r0.success, r0.error).toBe(true);
    const vorher = (await t.deps.instanzen.finde('o', 'pki'))!;
    const r = await t.skill.execute({ action: 'instanz_aendern', instanz: 'pki', architektur_doc: 'e1e1e1' }, CTX);
    expect(r.success, r.error).toBe(true);
    const nachher = (await t.deps.instanzen.finde('o', 'pki'))!;
    expect(nachher.id).toBe(vorher.id);
    expect(nachher.changeIds).toEqual([A.id, C.id]);
    expect(JSON.parse(nachher.parameter!)).toEqual({ ...JSON.parse(vorher.parameter!), architekturDocId: DID2 });
  });

  it('instanz_aendern: Fehler bei unbekanntem Verweis ändert nichts; ohne Felder, unbekannte und Testprotokoll-Instanz abgewiesen', async () => {
    const t = mitBetrieb();
    await t.skill.execute({ action: 'instanz_anlegen', name: 'pki', dokumentart: 'betrieb', assets: ['pkiiss01'], architektur_doc: 'd0c0d0' }, CTX);
    const vorher = (await t.deps.instanzen.finde('o', 'pki'))!.parameter;
    const f = await t.skill.execute({ action: 'instanz_aendern', instanz: 'pki', architektur_doc: 'zzzzzz' }, CTX);
    expect(f.error).toContain('nicht geändert');
    expect(f.error).toContain('Architektur-Dokument');
    expect((await t.deps.instanzen.finde('o', 'pki'))!.parameter).toBe(vorher);
    expect((await t.skill.execute({ action: 'instanz_aendern', instanz: 'pki' }, CTX)).error).toContain('Nichts zu ändern');
    expect((await t.skill.execute({ action: 'instanz_aendern', instanz: 'gibtsnicht', architektur_doc: 'd0c0d0' }, CTX)).error).toContain('nicht gefunden');
    await t.deps.instanzen.anlegen('o', { name: 'lab', dokumentart: 'testprotokoll', changeIds: [] });
    expect((await t.skill.execute({ action: 'instanz_aendern', instanz: 'lab', architektur_doc: 'd0c0d0' }, CTX)).error).toContain('keine Betriebs-Instanz');
  });

  it('unbekanntes Asset: Fehler nennt den Namen, nichts gespeichert', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 'pki-betrieb', dokumentart: 'betrieb', assets: ['pkiiss01', 'gibtsnicht'] }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('gibtsnicht');
    expect(r.error).not.toContain('„pkiiss01“ unbekannt');
    expect(await t.deps.instanzen.finde('o', 'pki-betrieb')).toBeUndefined();
  });

  it('mehrdeutiger Name (zwei aktive gleichen Typs, nur Schreibung verschieden): Fehler listet Kandidaten mit Typ, Status, Quelle', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 'x1', dokumentart: 'betrieb', assets: ['dopp'] }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('mehrdeutig');
    expect(r.error).toContain('cccccccc');
    expect(r.error).toContain('dddddddd');
    expect(r.error).toContain('proxmox');
    expect(r.error).toContain('active');
    expect(await t.deps.instanzen.finde('o', 'x1')).toBeUndefined();
  });

  it('eindeutige Namen und IDs: gespeichert mit aufgelösten IDs, Change-IDs des Vorhabens, ohne Changes-Eingabe', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({
      action: 'instanz_anlegen', name: 'pki-betrieb', dokumentart: 'betrieb', assets: ['pkiiss01', 'bbbbbbbb'],
      vorhaben: 'a1b2c3', architektur_doc: 'd0c0d0', jobs: ['pki-betrieb'], standard_vorlagen: ['ca_sicherung'], restore_change: '7335dfeb',
    }, CTX);
    expect(r.success, r.error).toBe(true);
    const i = await t.deps.instanzen.finde('o', 'pki-betrieb');
    expect(i?.dokumentart).toBe('betrieb');
    expect(i?.changeIds).toEqual([A.id, C.id]);
    expect(JSON.parse(i!.parameter!)).toEqual({
      assets: ['aaaaaaaa-1111', 'bbbbbbbb-2222'], vorhabenId: VID, architekturDocId: DID, jobs: ['pki-betrieb'], standardVorlagen: ['ca_sicherung'], restoreChangeId: C.id,
    });
  });

  it('VM und Server gleichen Namens: alle aktiven Assets gehören dazu, außer Betrieb Genommenes nicht, Name ohne Groß/Klein', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 's1', dokumentart: 'betrieb', assets: ['DC01', 'dc02'] }, CTX);
    expect(r.success, r.error).toBe(true);
    expect(JSON.parse((await t.deps.instanzen.finde('o', 's1'))!.parameter!).assets).toEqual(['dc010000-0001', 'dc010000-0002', 'dc010000-0004']);
  });

  it('nur außer Betrieb: abgewiesen (Name und ID), nichts gespeichert', async () => {
    const t = mitBetrieb();
    const alt = await t.skill.execute({ action: 'instanz_anlegen', name: 's2', dokumentart: 'betrieb', assets: ['pkiiss01', 'alt'] }, CTX);
    expect(alt.success).toBe(false);
    expect(alt.error).toContain('außer Betrieb');
    expect(await t.deps.instanzen.finde('o', 's2')).toBeUndefined();
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 's3', dokumentart: 'betrieb', assets: ['beide'] }, CTX)).error).toContain('außer Betrieb');
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 's4', dokumentart: 'betrieb', assets: ['eeeeeeee'] }, CTX)).error).toContain('außer Betrieb');
  });

  it('Name und ID desselben Systems: keine doppelten IDs, doppelte Angabe wird gemeldet', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 's5', dokumentart: 'betrieb', assets: ['dc01', 'dc010000-0001'] }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('doppelt');
  });

  it('bis 40 Namen mit mehreren IDs erlaubt (bis 80 IDs), 41 Namen nicht', async () => {
    const t = mitBetrieb();
    const viele = Array.from({ length: 40 }, (_, k) => "sys" + k);
    const gross = [...assets, ...viele.flatMap(n => [{ id: `${n}-v`, name: n, assetType: 'vm', status: 'active' }, { id: `${n}-s`, name: n, assetType: 'server', status: 'active' }])];
    t.deps.betrieb!.assetsNachName = async (_u, n) => gross.filter(a => a.name === n);
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 's6', dokumentart: 'betrieb', assets: viele }, CTX);
    expect(r.success, r.error).toBe(true);
    expect(JSON.parse((await t.deps.instanzen.finde('o', 's6'))!.parameter!).assets).toHaveLength(80);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 's7', dokumentart: 'betrieb', assets: [...viele, 'dc01'] }, CTX)).error).toContain('höchstens 40');
  });

  it('unbekanntes Vorhaben, Dokument und Restore-Change werden gemeldet, nichts gespeichert', async () => {
    const t = mitBetrieb();
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 'y', dokumentart: 'betrieb', assets: ['pkiiss01'], vorhaben: 'zzzzzz', architektur_doc: 'zzzzzz', restore_change: 'ffffffff' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Vorhaben');
    expect(r.error).toContain('Architektur-Dokument');
    expect(r.error).toContain('restore_change');
    expect(t.deps.instanzen.finde).toBeDefined();
    expect(await t.deps.instanzen.finde('o', 'y')).toBeUndefined();
  });

  it('keine Assets, zu viele Assets, ungültiger Job-Schlüssel, change-Präfix und doppelter Name werden abgewiesen', async () => {
    const t = mitBetrieb();
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'z', dokumentart: 'betrieb', assets: [] }, CTX)).error).toContain('mindestens ein Asset');
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'z', dokumentart: 'betrieb', assets: Array.from({ length: 41 }, (_, k) => `a${k}`) }, CTX)).error).toContain('höchstens 40');
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'z', dokumentart: 'betrieb', assets: ['pkiiss01'], jobs: ['a b'] }, CTX)).success).toBe(false);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'change-x', dokumentart: 'betrieb', assets: ['pkiiss01'] }, CTX)).success).toBe(false);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'ok', dokumentart: 'betrieb', assets: ['pkiiss01'] }, CTX)).success).toBe(true);
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'ok', dokumentart: 'betrieb', assets: ['pkiiss01'] }, CTX)).error).toContain('gibt es schon');
  });

  it('ohne CMDB-Anbindung: klarer Fehler; Testprotokoll-Instanz ohne parameter bleibt unverändert', async () => {
    const t = aufbau();
    expect((await t.skill.execute({ action: 'instanz_anlegen', name: 'b', dokumentart: 'betrieb', assets: ['x'] }, CTX)).error).toContain('nicht verfügbar');
    const r = await t.skill.execute({ action: 'instanz_anlegen', name: 'tp', dokumentart: 'testprotokoll', changes: [A.id] }, CTX);
    expect(r.success).toBe(true);
    expect((await t.deps.instanzen.finde('o', 'tp'))?.parameter).toBeUndefined();
  });
});

describe('Skill dokumentation — betrieb_erzeugen', () => {
  const STAND = '2026-11-15T09:27:00.000Z';
  const VM = {
    id: 'a-iss-vm', userId: 'o', assetType: 'vm', name: 'pkiiss01', sourceSkill: 'proxmox', status: 'active', ipAddress: '10.203.29.10',
    attributes: { vmid: 821, node: 'pve' }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-15T05:31:00.000Z',
  } as CmdbAsset;
  /** Fake-Quellen: alles leer, aber belegt; einzelne Quellen per `fehler` scheitern lassen */
  function quellen(fehler: Partial<Record<keyof BetriebQuellen, string>> = {}): BetriebQuellen {
    const q = <T>(k: keyof BetriebQuellen, daten: T) => async () => (fehler[k] ? { stand: STAND, fehler: fehler[k] } : { stand: STAND, daten });
    return {
      assets: q('assets', { gefunden: [VM], fehlend: [] }),
      beziehungen: q('beziehungen', { relationen: [], fremde: {} }),
      proxmox: q('proxmox', [{ vmid: 821, node: 'pve', name: 'pkiiss01', status: 'running', platten: ['scsi0 local-zfs 80G'], ips: ['10.203.29.10'], snapshots: [] }]),
      sicherung: q('sicherung', { jobs: [], letzte: {}, unerreichbar: [] }),
      unifi: q('unifi', { zonen: [], netze: [], policies: [], dnsWeiterleitungen: [] }),
      tresor: q('tresor', []),
      fernzugaenge: q('fernzugaenge', []),
      jobs: q('jobs', []),
      wartung: q('wartung', { fenster: [], vorlagen: [] }),
      problems: q('problems', []),
      changes: q('changes', []),
      abnahmen: q('abnahmen', {}),
      dokument: q('dokument', { id: 'arch', titel: 'Architektur', version: 1 }),
      netzBestand: q('netzBestand', { stand: {}, firewallRegeln: [], netze: [], proxyHosts: [], dnsEintraege: [] }),
    } as BetriebQuellen;
  }
  async function mitInstanz(fehler: Partial<Record<keyof BetriebQuellen, string>> = {}) {
    const t = aufbau();
    t.deps.betriebQuellen = quellen(fehler);
    await t.deps.instanzen.anlegen('o', { name: 'pki-ad3033', dokumentart: 'betrieb', changeIds: [], parameter: JSON.stringify({ assets: [VM.id] }) });
    return t;
  }

  it('(a) Instanz der Art testprotokoll → klare Ablehnung, nichts gespeichert', async () => {
    const t = await mitInstanz();
    await t.deps.instanzen.anlegen('o', { name: 'lab', dokumentart: 'testprotokoll', changeIds: [A.id] });
    const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'lab' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('nicht für ein Betriebsdokument');
    expect(t.gespeichert).toHaveLength(0);
    expect(t.ablage.schreibeLokal).not.toHaveBeenCalled();
    // unbekannte Instanz und fehlende Quellen ebenso klar
    expect((await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'gibtsnicht' }, CTX)).error).toContain('nicht gefunden');
    const ohne = aufbau();
    expect((await ohne.skill.execute({ action: 'betrieb_erzeugen', instanz: 'x' }, CTX)).error).toContain('nicht verfügbar');
  });

  it('(b) gültige Betriebs-Instanz → gespeichert als betrieb an der Instanz, Anhänge nur PDF und DOCX, Ablage <instanz>/v1', async () => {
    const t = await mitInstanz();
    const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'pki-ad3033', zweck: 'PKI der Domäne ad.3033.at' }, CTX);
    expect(r.success, r.error).toBe(true);
    expect(t.gespeichert).toHaveLength(1);
    const g = t.gespeichert[0]!;
    expect(g.docType).toBe('betrieb');
    expect(g.linkedEntityType).toBe('bauplan_instanz');
    expect(g.linkedEntityId).toBe('inst-1');
    expect(g.generatedBy).toBe('vorlage:betrieb@1');
    const d = JSON.parse(g.struktur!) as Dokument;
    expect(d.kapitel).toHaveLength(13);
    expect(d.anhaenge).toEqual([]);
    expect(g.content).toContain('PKI der Domäne ad.3033.at');
    expect(r.attachments!.map(a => a.fileName)).toEqual(['betrieb-pki-ad3033-v1.pdf', 'betrieb-pki-ad3033-v1.docx']);
    expect(r.attachments![0]!.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(t.pve2.map(p => p.ziel)).toEqual(['/srv/alfred-dokumente/pki-ad3033/v1/betrieb-pki-ad3033-v1.pdf', '/srv/alfred-dokumente/pki-ad3033/v1/betrieb-pki-ad3033-v1.docx']);
    expect(r.display).toContain(d.kopf.titel);
    expect(r.display).toContain('Version 1');
    expect(r.display).toContain(path.join('/daten', 'dokumente', 'pki-ad3033', 'v1'));
    expect(r.display).toContain('pve2: ok');
    expect(r.display).toContain('- proxmox: ok');
    expect(r.display).not.toContain('Prüfsummen');
    // zweiter Lauf über die Instanz-ID → Version 2
    const r2 = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'inst-1' }, CTX);
    expect(r2.attachments!.map(a => a.fileName)).toEqual(['betrieb-pki-ad3033-v2.pdf', 'betrieb-pki-ad3033-v2.docx']);
  });

  it('(c) eine Quelle mit Fehler → trotzdem erfolgreich, display nennt die Quelle und „nicht belegt“, Fehler geschwärzt', async () => {
    const t = await mitInstanz({ unifi: 'UniFi nicht erreichbar (password=Geheim123!)' });
    const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'pki-ad3033' }, CTX);
    expect(r.success, r.error).toBe(true);
    const zeile = r.display!.split('\n').find(z => z.startsWith('- unifi:'));
    expect(zeile).toContain('UniFi nicht erreichbar');
    expect(zeile).toContain('nicht belegt');
    expect(r.display).not.toContain('Geheim123!');
    expect(JSON.stringify(t.gespeichert[0])).not.toContain('Geheim123!');
    expect(r.display).toContain('- proxmox: ok');
  });

  it('Quelle mit Hinweis → Anzeige nennt ihn hinter „ok“, geschwärzt', async () => {
    const t = await mitInstanz();
    const q = t.deps.betriebQuellen!;
    q.sicherung = async () => ({ stand: STAND, daten: { jobs: [], letzte: {}, unerreichbar: [{ speicher: 'pbs-unas', grund: 'token=Geheim123!' }] }, hinweis: 'Sicherungsspeicher nicht erreichbar: pbs-unas (token=Geheim123!)' });
    const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'pki-ad3033' }, CTX);
    expect(r.success, r.error).toBe(true);
    const zeile = r.display!.split('\n').find(z => z.startsWith('- sicherung:'))!;
    expect(zeile).toMatch(/^- sicherung: ok \(.+\) — Hinweis: Sicherungsspeicher nicht erreichbar: pbs-unas/);
    expect(r.display).not.toContain('Geheim123!');
    expect(r.display!.split('\n').find(z => z.startsWith('- proxmox:'))).not.toContain('Hinweis');
  });

  it('(d) Freitext mit 601 Zeichen → Fehler, nichts gelesen oder gespeichert', async () => {
    const t = await mitInstanz();
    const assets = vi.spyOn(t.deps.betriebQuellen!, 'assets');
    for (const feld of ['zweck', 'abweichungen']) {
      const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'pki-ad3033', [feld]: 'x'.repeat(601) }, CTX);
      expect(r.success).toBe(false);
      expect(r.error).toContain(`${feld} zu lang`);
    }
    expect(assets).not.toHaveBeenCalled();
    expect(t.gespeichert).toHaveLength(0);
  });

  it('beschädigte Parameter der Instanz → klare Meldung, nichts gespeichert', async () => {
    const t = aufbau();
    t.deps.betriebQuellen = quellen();
    await t.deps.instanzen.anlegen('o', { name: 'kaputt', dokumentart: 'betrieb', changeIds: [], parameter: '{kein json' });
    const r = await t.skill.execute({ action: 'betrieb_erzeugen', instanz: 'kaputt' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('kein gültiges JSON');
    expect(t.gespeichert).toHaveLength(0);
  });
});

describe('Testprotokoll am Ende eines Bauplan-Pakets (V3)', () => {
  const P1 = change('a1a1a1a1-1111-2222-3333-444444444444', 'Paket Teil 1');
  const P2 = change('a2a2a2a2-1111-2222-3333-444444444444', 'Paket Teil 2');
  const laeuft = change('a3a3a3a3-1111-2222-3333-444444444444', 'Paket Teil 3', { status: 'in_progress' as CmdbChangeRequest['status'] });
  const paket = async (t: ReturnType<typeof aufbau>, ids: string[], art: 'testprotokoll' | 'betrieb' = 'testprotokoll', vorlageKey: string | null = 'pki-lab') =>
    t.deps.instanzen.anlegen('o', { name: 'lab1', dokumentart: art, changeIds: ids, ...(vorlageKey ? { vorlageKey, vorlageVersion: 1 } : {}) } as never);

  it('letzter Change endet: Testprotokoll an der Instanz, Dateien an den Owner', async () => {
    const t = aufbau({ changes: [P1, P2] });
    const i = await paket(t, [P1.id, P2.id]);
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P2, 'completed');
    const tp = t.gespeichert.filter(g => g.docType === 'testprotokoll');
    expect(tp).toHaveLength(1);
    expect(tp[0]!.linkedEntityType).toBe('bauplan_instanz');
    expect(tp[0]!.linkedEntityId).toBe(i.id);
    expect(r!.zeile).toContain('Abnahmeprotokoll erstellt');
    expect(r!.zeile).toContain('Testprotokoll');
    expect(r!.anhaenge!.some(a => a.fileName.startsWith('testprotokoll'))).toBe(true);
  });

  it('vorletzter Change: nur Hinweis „noch n Changes offen“, kein Testprotokoll', async () => {
    const t = aufbau({ changes: [P1, laeuft] });
    await paket(t, [P1.id, laeuft.id]);
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P1, 'completed');
    expect(t.gespeichert.filter(g => g.docType === 'testprotokoll')).toHaveLength(0);
    expect(r!.zeile).toContain('Bauplan-Paket lab1: noch 1 Changes offen');
  });

  it('Betriebs-Paket: nur Hinweiszeile, kein Dokument', async () => {
    const t = aufbau({ changes: [P1, P2] });
    await paket(t, [P1.id, P2.id], 'betrieb');
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P2, 'completed');
    expect(r!.zeile).toContain('Betriebsdokument: mit betrieb_erzeugen nach instanz_aendern (assets) erzeugen');
    expect(t.gespeichert.filter(g => g.docType === 'betrieb')).toHaveLength(0);
  });

  it('Change ohne Instanz und Instanz ohne vorlageKey: Verhalten wie bisher', async () => {
    const t = aufbau({ changes: [P1, P2] });
    const r0 = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P1, 'completed');
    expect(r0!.zeile).not.toContain('Bauplan-Paket');
    await paket(t, [P1.id, P2.id], 'testprotokoll', null);
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P2, 'completed');
    expect(r!.zeile).not.toContain('Bauplan-Paket');
    expect(t.gespeichert.filter(g => g.docType === 'testprotokoll')).toHaveLength(0);
  });

  it('zwei Changes enden fast gleichzeitig: Testprotokoll nur einmal', async () => {
    const t = aufbau({ changes: [P1, P2], langsam: true });
    await paket(t, [P1.id, P2.id]);
    const d = new DokumenteDienst(t.deps);
    await Promise.all([d.abnahmeNachEnde('o', P1, 'completed'), d.abnahmeNachEnde('o', P2, 'completed')]);
    expect(t.gespeichert.filter(g => g.docType === 'testprotokoll')).toHaveLength(1);
  });

  it('Final-Welle T5(1): Fehler beim Suchen der Instanz ändert hand-gemachte Changes nicht (kein Paket, nur Protokoll)', async () => {
    const t = aufbau({ changes: [P1, P2] });
    const log: Array<{ msg: string; daten: Record<string, unknown> }> = [];
    (t.deps as { protokoll?: unknown }).protokoll = (msg: string, daten: Record<string, unknown>) => { log.push({ msg, daten }); };
    t.deps.instanzen.findeNachChange = async () => { throw new Error('db weg'); };
    const vorher = await new DokumenteDienst({ ...t.deps, instanzen: { ...t.deps.instanzen, findeNachChange: async () => undefined } }).abnahmeNachEnde('o', P1, 'completed');
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P2, 'completed');
    expect(r!.zeile).toContain('Abnahmeprotokoll erstellt');
    expect(r!.zeile).not.toContain('Testprotokoll nicht erstellt');
    expect(r!.zeile.split('\n')).toHaveLength(vorher!.zeile.split('\n').length);
    expect(log.some(l => /Bauplan-Instanz/.test(l.msg) && String(l.daten.fehler).includes('db weg'))).toBe(true);
  });

  it('Fehler beim Testprotokoll verliert die Abnahme nicht', async () => {
    const t = aufbau({ changes: [P1, P2] });
    await paket(t, [P1.id, P2.id]);
    t.deps.instanzen.finde = async () => { throw new Error('db weg'); };
    const r = await new DokumenteDienst(t.deps).abnahmeNachEnde('o', P2, 'completed');
    expect(r!.zeile).toContain('Abnahmeprotokoll erstellt');
    expect(r!.zeile).toContain('Testprotokoll nicht erstellt');
  });
});
