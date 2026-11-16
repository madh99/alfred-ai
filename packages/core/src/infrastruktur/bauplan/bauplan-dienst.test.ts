import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { BauplanVorlageZeile, BauplanVorlageStatus } from '@alfred/storage';
import { BauplanDienst, heikleAktionen, type BauplanDeps } from './bauplan-dienst.js';
import { BauplanSkill, bauplanNachJa } from './bauplan-skill.js';
import type { SkillContext } from '@alfred/types';
import { testVorlage } from './testvorlage.fixture.js';
import type { Pruefung } from '../change-schritte.js';
import { ChangePlanung } from '../change-planung.js';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchrittDaten } from '@alfred/storage';
import { baueEntwurf, findeKandidaten, findeVerweise, standVon, type Entscheid, type QuellChange } from './ableiten.js';
import { PKI_QUELLEN } from './ableiten.fixture.js';
import { I8C_QUELLEN } from './ableiten-i8c.fixture.js';

type Roh = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha = (n: string) => createHash('sha256').update(n).digest('hex');

/** Vorlage nach Brief: Change aufbau mit {{schritt2.id}} in Schritt 3, abbau mit {{change:aufbau.schritt2.id}} */
function vorlage(aendern: (r: Roh) => void = () => {}): Roh {
  const r = testVorlage() as Roh;
  r.changes[0].schritte.push({ nr: 3, titel: 'VM starten', art: 'aktion', skill: 'proxmox', aktion: 'start_vm', parameter: { id: '{{schritt2.id}}' }, zeitlimitS: 300, beiFehler: 'anhalten' });
  r.changes[1].schritte.unshift({ nr: 1, titel: 'VM löschen', art: 'aktion', skill: 'proxmox', aktion: 'delete_vm', parameter: { id: '{{change:aufbau.schritt2.id}}' }, zeitlimitS: 300, beiFehler: 'anhalten' });
  r.changes[1].schritte[1].nr = 2;
  aendern(r);
  return r;
}

function aufbau(o: { probeFehler?: string[]; pruefung?: (p: Pruefung) => { ok: boolean; text: string }; changes?: CmdbChangeRequest[]; assetNamen?: Record<string, string>; assetFehler?: string } = {}) {
  const ladungen = { changes: 0 };
  const zeilen: BauplanVorlageZeile[] = [];
  const instanzen: Array<{ name: string; dokumentart: string; changeIds: string[]; parameter?: string; vorlageKey?: string; vorlageVersion?: number }> = [];
  const geplant: unknown[][] = [];
  const anfragen: Array<{ ids: string[]; zusatz?: string }> = [];
  const fragen: Array<{ text: string; params: Record<string, unknown> }> = [];
  const meldungen: string[] = [];
  const pruefungen: Pruefung[] = [];
  const verworfen: Array<{ id: string; grund: string }> = [];
  let jetzt = Date.parse('2026-11-16T10:00:00Z');
  const zustand = { probeFehler: o.probeFehler ?? [] as string[] };
  const deps: BauplanDeps = {
    repo: {
      speichere: async (_u, d) => {
        const version = Math.max(0, ...zeilen.filter(z => z.key === d.key).map(z => z.version)) + 1;
        const z: BauplanVorlageZeile = { id: `id-${d.key}-${version}`, key: d.key, version, json: d.json, abdruck: d.abdruck, status: 'entwurf', ...(d.abgeleitetAus ? { abgeleitetAus: d.abgeleitetAus } : {}), ...(d.ableitung ? { ableitung: d.ableitung } : {}), createdAt: 'x', updatedAt: 'x' };
        zeilen.push(z); return { ...z };
      },
      finde: async (_u, key, version) => {
        const l = zeilen.filter(z => z.key === key && (version === undefined || z.version === version)).sort((a, b) => b.version - a.version);
        return l[0] ? { ...l[0] } : undefined;
      },
      liste: async () => zeilen.map(z => ({ ...z })),
      setze: async (_u, id, d) => {
        const z = zeilen.find(x => x.id === id)!;
        for (const [k, w] of Object.entries(d)) if (w !== undefined) (z as unknown as Record<string, unknown>)[k] = w === '' ? undefined : w;
      },
    },
    instanzen: {
      anlegen: async (_u, d) => { instanzen.push(d); return { id: `inst-${instanzen.length}`, name: d.name }; },
      finde: async (_u, name) => instanzen.find(i => i.name === name),
    },
    pruefeNur: async () => [...zustand.probeFehler],
    planen: async (_u, roh) => { geplant.push(roh); return { ok: true, ids: roh.map((_, i) => `chg-${i + 1}`) }; },
    freigabeAnfragen: async (_u, ids, zusatz) => { anfragen.push({ ids, ...(zusatz ? { zusatz } : {}) }); return { ok: true, text: 'Freigabe-Frage gestellt' }; },
    pruefe: async (p) => { pruefungen.push(p); return o.pruefung ? o.pruefung(p) : { ok: true, text: 'passt' }; },
    frage: async (text, params) => { fragen.push({ text, params }); return true; },
    melde: async (_u, t) => { meldungen.push(t); },
    verwerfen: async (_u, id, grund) => { verworfen.push({ id, grund }); },
    jetzt: () => jetzt,
    ...(o.changes ? {
      ableitenQuellen: { changes: async () => { ladungen.changes++; return { changes: o.changes!, abgeschnitten: false }; } },
      assetName: async (_u: string, id: string) => { if (o.assetFehler) throw new Error(o.assetFehler); return o.assetNamen?.[id]; },
    } : {}),
  };
  const dienst = new BauplanDienst(deps);
  return { dienst, zeilen, instanzen, geplant, anfragen, fragen, meldungen, pruefungen, verworfen, zustand, ladungen, setzeJetzt: (t: number) => { jetzt = t; } };
}

/** Speichern, anfragen, Ja — liefert die freigegebene Version */
async function freigegeben(t: ReturnType<typeof aufbau>, roh: Roh = vorlage()) {
  const s = await t.dienst.speichern('o', roh);
  if (!s.ok) throw new Error(s.fehler.join('\n'));
  const a = await t.dienst.freigabeAnfragen('o', s.zeile.key);
  if (!a.ok) throw new Error(a.fehler.join('\n'));
  const p = t.fragen.at(-1)!.params;
  const j = await t.dienst.freigebenNachJa('o', String(p.key), Number(p.version), p.freigabe);
  if (!j.ok) throw new Error(j.text);
  return s.zeile;
}

const eingabe = { vlan: 832, netz: '10.203.32.0/28', vmid: 157, name_server: 'labsrv01' };

describe('BauplanDienst — speichern', () => {
  it('gültig → neue Version als Entwurf; jede weitere Speicherung = nächste Version', async () => {
    const t = aufbau();
    const a = await t.dienst.speichern('o', vorlage());
    expect(a.ok).toBe(true);
    const b = await t.dienst.speichern('o', vorlage(r => { r.zweck = 'anders'; }));
    expect(b).toMatchObject({ ok: true, zeile: { version: 2, status: 'entwurf' } });
    expect(t.zeilen).toHaveLength(2);
  });
  it('Fehler (Schema/Probe) → nichts gespeichert', async () => {
    const t = aufbau();
    expect((await t.dienst.speichern('o', vorlage(r => { r.version = 3; }))).ok).toBe(false);
    t.zustand.probeFehler = ['Change aufbau: Skill fehlt'];
    const r = await t.dienst.speichern('o', vorlage());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fehler.join('\n')).toContain('Probe: Change aufbau: Skill fehlt');
    expect(t.zeilen).toHaveLength(0);
  });
});

describe('BauplanDienst — Freigabe', () => {
  it('Frage nennt Titel, Zweck, Parameter, Changes, Abdruck und Netz/Firewall/Löschung; DB hat nur den Hash', async () => {
    const t = aufbau();
    const s = await t.dienst.speichern('o', vorlage());
    if (!s.ok) throw new Error();
    expect((await t.dienst.freigabeAnfragen('o', 'test_lab')).ok).toBe(true);
    const f = t.fragen[0]!;
    expect(f.text).toContain('Test-Lab');
    expect(f.text).toContain('Isoliertes Lab für Tests');
    expect(f.text).toMatch(/vlan \(vlan, Pflicht\)/);
    expect(f.text).toMatch(/gateway \(ipv4, optional/);
    expect(f.text).toMatch(/aufbau: Aufbau VLAN \{\{param\.vlan\}\} — 3 Schritte/);
    expect(f.text).toContain(s.zeile.abdruck.slice(0, 12));
    expect(f.text).toMatch(/Enthält Netz\/Firewall\/Löschung: .*unifi\.create_network.*unifi\.delete_network/s);
    expect(f.params).toMatchObject({ action: 'bauplan_freigeben', key: 'test_lab', version: 1 });
    expect(typeof f.params.freigabe).toBe('string');
    expect(t.zeilen[0]!.status).toBe('angefragt');
    expect(t.zeilen[0]!.frageHash).toBe(sha(String(f.params.freigabe)));
    expect(t.zeilen[0]!.frageHash).not.toBe(f.params.freigabe);
  });
  it('ohne Netz/Firewall/Lösch-Schritte keine solche Zeile', async () => {
    const t = aufbau();
    const s = await t.dienst.speichern('o', vorlage(r => {
      r.changes = [{ ...r.changes[0], titel: 'Aufbau', schritte: [{ titel: 'VM anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_vm', parameter: { vmid: '{{param.vmid}}', name: '{{param.name_server}}' }, zeitlimitS: 600, beiFehler: 'anhalten' }] }];
      r.parameter = r.parameter.filter((p: Roh) => p.name === 'vmid' || p.name === 'name_server');
    }));
    expect(s).toMatchObject({ ok: true });
    expect((await t.dienst.freigabeAnfragen('o', 'test_lab')).ok).toBe(true);
    expect(t.fragen[0]!.text).not.toContain('Netz/Firewall/Löschung');
  });
  it('falscher Nonce, abgelaufen, geänderter Abdruck, ältere Version → nicht freigegeben; einmal verwendbar', async () => {
    const t = aufbau();
    await t.dienst.speichern('o', vorlage());
    await t.dienst.freigabeAnfragen('o', 'test_lab');
    const p = t.fragen[0]!.params;
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 1, 'erfunden')).ok).toBe(false);
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 1, undefined)).ok).toBe(false);
    // abgelaufen
    t.setzeJetzt(Date.parse('2026-11-17T10:00:01Z'));
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 1, p.freigabe)).ok).toBe(false);
    expect(t.zeilen[0]!.status).toBe('angefragt');
    // neu anfragen, dann JSON in der DB verändert → Abdruck passt nicht
    t.setzeJetzt(Date.parse('2026-11-16T12:00:00Z'));
    await t.dienst.freigabeAnfragen('o', 'test_lab');
    const p2 = t.fragen[1]!.params;
    const alt = t.zeilen[0]!.json;
    t.zeilen[0]!.json = alt.replace('Isoliertes Lab', 'Verändertes Lab');
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 1, p2.freigabe)).ok).toBe(false);
    t.zeilen[0]!.json = alt;
    // ältere Version: nach der Frage eine neue Version gespeichert
    await t.dienst.speichern('o', vorlage(r => { r.zweck = 'v2'; }));
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 1, p2.freigabe)).ok).toBe(false);
    expect(t.zeilen[0]!.status).toBe('angefragt');
    // richtige Frage für v2 → ja, zweites Mal → nein
    await t.dienst.freigabeAnfragen('o', 'test_lab');
    const p3 = t.fragen[2]!.params;
    expect(p3.version).toBe(2);
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 2, p3.freigabe)).ok).toBe(true);
    expect(t.zeilen[1]!.status).toBe('freigegeben');
    expect(t.zeilen[1]!.freigegebenAt).toBeTruthy();
    expect((await t.dienst.freigebenNachJa('o', 'test_lab', 2, p3.freigabe)).ok).toBe(false);
  });
  it('widerrufen trifft die höchste freigegebene Version', async () => {
    const t = aufbau();
    await freigegeben(t);
    await t.dienst.speichern('o', vorlage(r => { r.zweck = 'v2'; }));
    const r = await t.dienst.widerrufen('o', 'test_lab');
    expect(r.ok).toBe(true);
    expect(t.zeilen[0]!.status).toBe('widerrufen');
    expect(t.zeilen[1]!.status).toBe('entwurf');
    expect((await t.dienst.widerrufen('o', 'test_lab')).ok).toBe(false);
  });
});

describe('BauplanDienst — anwenden', () => {
  it.each<[BauplanVorlageStatus]>([['entwurf'], ['angefragt'], ['widerrufen'], ['ueberpruefen']])('Status %s → Fehler mit Status, nichts geplant', async (status) => {
    const t = aufbau();
    await t.dienst.speichern('o', vorlage());
    t.zeilen[0]!.status = status;
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fehler.join(' ')).toContain(status);
    expect(t.geplant).toHaveLength(0);
    expect(t.instanzen).toHaveLength(0);
  });
  it('ältere freigegebene Version zählt nicht, wenn eine neuere existiert', async () => {
    const t = aufbau();
    await freigegeben(t);
    await t.dienst.speichern('o', vorlage(r => { r.zweck = 'v2'; }));
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.fehler.join(' ')).toContain('Version 1 ist freigegeben'); expect(r.fehler.join(' ')).toContain('Version 2'); expect(r.fehler.join(' ')).toContain('entwurf'); }
    expect(t.geplant).toHaveLength(0);
  });
  it('Revalidierung scheitert → Status ueberpruefen, Grund, Meldung, keine Changes', async () => {
    const t = aufbau();
    await freigegeben(t);
    t.zustand.probeFehler = ['Change aufbau: Aktion create_network gibt es nicht mehr'];
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    expect(t.zeilen[0]!.status).toBe('ueberpruefen');
    expect(t.zeilen[0]!.grund).toContain('create_network');
    expect(t.meldungen.join('\n')).toContain('überprüfen');
    expect(t.geplant).toHaveLength(0);
    expect(t.instanzen).toHaveLength(0);
  });
  it('gespeicherter Abdruck passt nicht zum JSON → ueberpruefen', async () => {
    const t = aufbau();
    await freigegeben(t);
    t.zeilen[0]!.json = t.zeilen[0]!.json.replace('Isoliertes Lab', 'Verändertes Lab');
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    expect(t.zeilen[0]!.status).toBe('ueberpruefen');
    expect(t.geplant).toHaveLength(0);
  });
  it('Parameterfehler → Abbruch (Shell-Zeichen im Namen)', async () => {
    const t = aufbau();
    await freigegeben(t);
    const r = await t.dienst.anwenden('o', 'test_lab', { ...eingabe, name_server: 'x; rm -rf /' }, 'lab-1');
    expect(r.ok).toBe(false);
    expect(t.geplant).toHaveLength(0);
    expect(t.zeilen[0]!.status).toBe('freigegeben');
  });
  it('Annahme scheitert live → planen nicht aufgerufen, keine Instanz, Text nennt die Annahme; Parameter in der Annahme eingesetzt', async () => {
    const t = aufbau({ pruefung: () => ({ ok: false, text: 'VM 157 existiert' }) });
    await freigegeben(t);
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fehler.join(' ')).toContain('VMID ist frei');
    expect(t.pruefungen[0]!.parameter).toEqual({ vmid: 157 });
    expect(t.geplant).toHaveLength(0);
    expect(t.instanzen).toHaveLength(0);
    expect(t.anfragen).toHaveLength(0);
  });
  it('Instanzname ungültig oder schon vorhanden → vor dem Planen abgewiesen', async () => {
    const t = aufbau();
    await freigegeben(t);
    for (const n of ['', 'change-x', 'serie-1', 'a b', 'x'.repeat(81), '..']) expect((await t.dienst.anwenden('o', 'test_lab', eingabe, n)).ok).toBe(false);
    t.instanzen.push({ name: 'lab-1', dokumentart: 'testprotokoll', changeIds: [] });
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fehler.join(' ')).toContain('gibt es schon');
    expect(t.geplant).toHaveLength(0);
    expect(t.pruefungen).toHaveLength(0);
  });
  it('Erfolg: Annahmen vorn, Verweise verschoben, kapitel weg, Beschreibung mit Präfix, eine Freigabe-Frage, Instanz mit Vorlage', async () => {
    const t = aufbau();
    await freigegeben(t);
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(t.geplant).toHaveLength(1);
    const [a, b] = t.geplant[0] as Roh[];
    expect(a!.schluessel).toBe('aufbau');
    expect(a!.begruendung).toBe('Bauplan test_lab v1 (lab-1): Lab aufbauen');
    expect(b!.begruendung).toBe('Bauplan test_lab v1 (lab-1): Lab abbauen');
    expect(a!.titel).toBe('Aufbau VLAN 832');
    // Annahme als erster Schritt des Change ohne abhaengigVon, Parameter eingesetzt
    expect(a!.schritte).toHaveLength(4);
    expect(a!.schritte[0]).toMatchObject({ titel: 'Eingangskontrolle: VMID ist frei', art: 'pruefung', beiFehler: 'anhalten', pruefung: { typ: 'skill', parameter: { vmid: 157 } } });
    expect(a!.schritte.map((s: Roh) => s.nr)).toEqual([1, 2, 3, 4]);
    expect(a!.schritte[2].parameter.netz_id).toBe('{{schritt2.id}}');
    expect(a!.schritte[3].parameter.id).toBe('{{schritt3.id}}');
    expect(JSON.stringify(a)).not.toContain('kapitel');
    // b hängt ab → keine Annahme, Verweise auf a verschoben
    expect(b!.schritte).toHaveLength(2);
    expect(b!.schritte[0].parameter.id).toBe('{{change:aufbau.schritt3.id}}');
    expect(b!.schritte[1].parameter.id).toBe('{{change:aufbau.schritt2.id}}');
    // genau eine Freigabe-Frage mit allen IDs; Werte über Change-Grenzen sichtbar
    expect(t.anfragen).toEqual([{ ids: ['chg-1', 'chg-2'], zusatz: expect.any(String) }]);
    const z = t.anfragen[0]!.zusatz!;
    expect(z).toContain('Wert id aus Change aufbau Schritt 3 (proxmox.create_vm)');
    expect(z).toContain('Wert id aus Change aufbau Schritt 2 (unifi.create_network)');
    expect(z).toMatch(/Enthält Netz\/Firewall\/Löschung: .*unifi\.delete_network/s);
    expect(z).toContain('Bauplan test_lab v1');
    // Instanz
    expect(t.instanzen).toEqual([{ name: 'lab-1', dokumentart: 'testprotokoll', changeIds: ['chg-1', 'chg-2'], vorlageKey: 'test_lab', vorlageVersion: 1, parameter: JSON.stringify({ vlan: 832, netz: '10.203.32.0/28', vmid: 157, name_server: 'labsrv01', gateway: '10.203.32.1' }) }]);
    expect(r.text).toContain('Freigabe-Frage gestellt');
  });
  it('planen scheitert → keine Instanz, keine Frage', async () => {
    const t = aufbau();
    await freigegeben(t);
    (t.dienst as unknown as { d: BauplanDeps }).d.planen = async () => ({ ok: false, fehler: ['Change aufbau: Asset fehlt'] });
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fehler.join(' ')).toContain('Asset fehlt');
    expect(t.instanzen).toHaveLength(0);
    expect(t.anfragen).toHaveLength(0);
  });
});

describe('BauplanDienst — mit echter ChangePlanung (Probe, Planen, Freigabe-Frage)', () => {
  it('verschobene Verweise bestehen den echten Validator; {{change:…}} wird zur ID; Frage nennt die Werte über Change-Grenzen', async () => {
    const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status', 'clone_vm', 'delete_vm', 'create_snapshot', 'delete_snapshot'] }, vmid: { type: 'number' }, name: { type: 'string' } }, required: ['action'] } } };
    const db = new Map<string, CmdbChangeRequest>(); let n = 0;
    const itsm = {
      liste: async () => [...db.values()],
      hole: async (_o: string, id: string) => db.get(id) ?? null,
      legeAn: async (_o: string, d: ChangeSchrittDaten) => {
        const id = `chg-${String(++n).padStart(4, '0')}-0000-0000-000000000000`;
        db.set(id, { id, userId: 'o', title: d.title, description: d.description, type: d.type, status: 'submitted', riskLevel: d.riskLevel, affectedAssetIds: d.affectedAssetIds, affectedServiceIds: [], implementationPlan: d.implementationPlan, rollbackPlan: d.rollbackPlan, testPlan: d.testPlan, schritte: d.schritte, abhaengigVon: d.abhaengigVon, ausfallMinuten: d.ausfallMinuten, pruefung: d.pruefung, fingerabdruck: d.fingerabdruck, createdAt: 'x', updatedAt: 'x' } as CmdbChangeRequest);
        return db.get(id)!;
      },
      setzeSchritte: async () => { throw new Error('nicht erwartet'); },
      freigeben: async () => { throw new Error('nicht erwartet'); },
      setzeFreigabeAnfrage: async (_o: string, id: string, a: CmdbChangeRequest['freigabeAnfrage'] | null) => { const e = db.get(id)!; if (a) e.freigabeAnfrage = a; else delete e.freigabeAnfrage; },
    };
    const fragen: string[] = [];
    const pl = new ChangePlanung({
      itsm: itsm as never,
      skill: nm => (nm === 'proxmox' ? fakeSkill : undefined) as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
      bestaetigung: async f => { fragen.push(f.description); return true; },
    });
    const t = aufbau();
    t.dienst.d.pruefeNur = (o, roh) => pl.pruefeNur(o, roh);
    t.dienst.d.planen = async (o, roh) => { const r = await pl.planen(o, roh); return r.ok ? { ok: true, ids: r.changes.map(c => c.id) } : r; };
    t.dienst.d.freigabeAnfragen = (o, ids, zusatz) => pl.freigabeAnfragen(o, ids, zusatz);
    const roh = {
      schema: 1, key: 'klon_probe', titel: 'Klon-Probe', zweck: 'Klonen und lesen', dokumentart: 'testprotokoll',
      parameter: [{ name: 'name', typ: 'name', pflicht: true, beschreibung: 'VM-Name', beispiel: 'probe-vm' }, { name: 'vmid', typ: 'vmid', pflicht: true, beschreibung: 'VMID', beispiel: 157 }],
      annahmen: [{ id: 'vm_da', text: 'Proxmox antwortet', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' } } }],
      changes: [
        { schluessel: 'aufbau', titel: 'VM klonen', begruendung: 'Neue VM aus Vorlage klonen', typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: [], betroffen: ['pve'],
          schritte: [
            { titel: 'Sicherung', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: '{{param.vmid}}', name: 'vor-klon' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' } }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: '{{param.vmid}}', name: 'vor-klon' } }, zeitlimitS: 60, beiFehler: 'anhalten' },
            { titel: 'Klonen', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', parameter: { name: '{{param.name}}' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' } }, zeitlimitS: 60, beiFehler: 'anhalten', rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: '{{schritt2.vmid}}' } }, kapitel: '3' },
            { titel: 'Status', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{schritt2.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' },
          ] },
        { schluessel: 'lesen', titel: 'VM lesen', begruendung: 'Zustand der neuen VM lesen', typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: ['aufbau'], betroffen: ['pve'],
          schritte: [{ titel: 'Status', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{change:aufbau.schritt2.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' }] },
      ],
    };
    await freigegeben(t, roh);
    const r = await t.dienst.anwenden('o', 'klon_probe', { name: 'lab-vm', vmid: 158 }, 'klon-1');
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const [a, b] = r.ids.map(id => db.get(id)!);
    expect((a!.schritte as Array<{ titel: string }>).map(s => s.titel)).toEqual(['Eingangskontrolle: Proxmox antwortet', 'Sicherung', 'Klonen', 'Status']);
    expect(JSON.stringify(a!.schritte![2])).toContain('{{schritt3.vmid}}'); // Rückweg von Klonen
    expect(JSON.stringify(a!.schritte![3])).toContain('{{schritt3.vmid}}');
    expect(JSON.stringify(b!.schritte![0])).toContain(`{{change:${a!.id}.schritt3.vmid}}`);
    expect(a!.description).toBe('Bauplan klon_probe v1 (klon-1): Neue VM aus Vorlage klonen');
    expect(fragen).toHaveLength(1);
    expect(fragen[0]).toMatch(/^2 Changes freigeben: /);
    expect(fragen[0]).toContain('Wert vmid aus Change aufbau Schritt 3 (proxmox.clone_vm)');
    expect(fragen[0]).toContain('📐 Bauplan klon_probe v1, Instanz klon-1');
    expect(t.instanzen[0]).toMatchObject({ name: 'klon-1', changeIds: r.ids, vorlageKey: 'klon_probe', vorlageVersion: 1 });
  });
});

describe('Fix-Runde 1', () => {
  it('ohneSicherungGrund wird eingesetzt und in den echten Plan übernommen', async () => {
    const t = aufbau();
    await freigegeben(t, vorlage(r => { r.changes[0].ohneSicherungGrund = 'Neues Lab VLAN {{param.vlan}}'; }));
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const [a, b] = t.geplant[0] as Roh[];
    expect(a!.ohneSicherungGrund).toBe('Neues Lab VLAN 832');
    expect(b!.ohneSicherungGrund).toBeUndefined();
  });
  it('Task 6 — zweck stilllegung wird in den echten Plan übernommen, nur am Change, der ihn trägt', async () => {
    const t = aufbau();
    await freigegeben(t, vorlage(r => { r.changes[1].zweck = 'stilllegung'; }));
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-z');
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const [a, b] = t.geplant[0] as Roh[];
    expect(a!.zweck).toBeUndefined();
    expect(b!.zweck).toBe('stilllegung');
  });
  it('Freigabe-Frage scheitert → alle neuen Changes verworfen, ok:false, Owner-Meldung', async () => {
    const t = aufbau();
    await freigegeben(t);
    t.dienst.d.freigabeAnfragen = async () => ({ ok: false, fehler: ['Prüfung jetzt nicht bestanden'] });
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.fehler.join(' ')).toContain('Prüfung jetzt nicht bestanden'); expect(r.fehler.join(' ')).toContain('chg-1'); }
    expect(t.verworfen.map(v => v.id)).toEqual(['chg-1', 'chg-2']);
    expect(t.verworfen[0]!.grund).toMatch(/^Bauplan-Anwendung abgebrochen: /);
    expect(t.meldungen.join('\n')).toContain('abgebrochen');
  });
  it('Instanz scheitert → Changes verworfen, keine Frage; Eindeutigkeitsverletzung → „Instanzname schon vergeben“', async () => {
    for (const [fehler, erwartet] of [['Datenbank weg', 'Datenbank weg'], ['duplicate key value violates unique constraint "infra_bauplan_instanzen_user_id_name_key"', 'Instanzname schon vergeben'], ['UNIQUE constraint failed: infra_bauplan_instanzen.user_id, infra_bauplan_instanzen.name', 'Instanzname schon vergeben']] as const) {
      const t = aufbau();
      await freigegeben(t);
      t.dienst.d.instanzen.anlegen = async () => { throw new Error(fehler); };
      const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fehler.join(' ')).toContain(erwartet);
      expect(t.verworfen.map(v => v.id)).toEqual(['chg-1', 'chg-2']);
      expect(t.anfragen).toHaveLength(0);
      expect(t.meldungen.length).toBeGreaterThan(0);
    }
  });
  it('Annahmen nur am ersten Change ohne Abhängigkeit; zweite Wurzel startet nach der ersten (Eingangskontrolle zuerst)', async () => {
    const t = aufbau();
    await freigegeben(t, vorlage(r => {
      r.changes.push({ schluessel: 'zwei', titel: 'Zweite Wurzel', begruendung: 'Unabhängig', typ: 'normal', risiko: 'low', abhaengigVon: [],
        schritte: [
          { titel: 'VM anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_vm', parameter: { vmid: '{{param.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' },
          { titel: 'VM starten', art: 'aktion', skill: 'proxmox', aktion: 'start_vm', parameter: { id: '{{schritt1.id}}' }, zeitlimitS: 60, beiFehler: 'anhalten' },
        ] });
    }));
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const [a, , zwei] = t.geplant[0] as Roh[];
    expect(a!.schritte[0].titel).toBe('Eingangskontrolle: VMID ist frei');
    expect(zwei!.schritte).toHaveLength(2);
    expect(zwei!.schritte[0].titel).toBe('VM anlegen');
    expect(zwei!.schritte[1].parameter.id).toBe('{{schritt1.id}}');
    // Final-Welle P1 — jede weitere Wurzel hängt an der ersten, damit die Eingangskontrolle nachweislich zuerst läuft
    expect(zwei!.abhaengigVon).toEqual(['aufbau']);
    expect(a!.abhaengigVon).toEqual([]);
    const z = t.anfragen[0]!.zusatz!;
    expect(z).toContain('zwei startet nach aufbau (Eingangskontrolle)');
    // M4 — Schrittzahl je Change inkl. vorangestellter Eingangskontrolle
    expect(z).toContain('- aufbau: 4 Schritte (davon 1 Eingangskontrolle)');
    expect(z).toContain('- abbau: 2 Schritte');
    expect(z).toContain('- zwei: 2 Schritte');
    // Vorlagen-Frage nennt die Reihenfolge ebenfalls
    expect(t.fragen[0]!.text).toContain('zwei startet nach aufbau (Eingangskontrolle)');
  });
  it('ohne Annahmen keine erzwungene Reihenfolge der Wurzeln', async () => {
    const t = aufbau();
    await freigegeben(t, vorlage(r => {
      r.annahmen = [];
      r.changes.push({ schluessel: 'zwei', titel: 'Zweite Wurzel', begruendung: 'Unabhängig', typ: 'normal', risiko: 'low', abhaengigVon: [],
        schritte: [{ titel: 'VM anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_vm', parameter: { vmid: '{{param.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' }] });
    }));
    const r = await t.dienst.anwenden('o', 'test_lab', eingabe, 'lab-1');
    if (!r.ok) throw new Error(r.fehler.join(' '));
    const [, , zwei] = t.geplant[0] as Roh[];
    expect(zwei!.abhaengigVon).toEqual([]);
    expect(t.anfragen[0]!.zusatz!).not.toContain('startet nach');
  });
  it('Löschungen über aktionsArt erkannt (destroy_vm im Rückweg)', () => {
    const h = heikleAktionen([{ schluessel: 'a', titel: 'a', begruendung: 'a', typ: 'normal', risiko: 'low', abhaengigVon: [],
      schritte: [{ titel: 'VM', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', rueckweg: { skill: 'proxmox', aktion: 'destroy_vm' } }, { titel: 'P', art: 'aktion', skill: 'proxmox', aktion: 'purge_backups' }] }]);
    expect(h).toEqual(['proxmox.destroy_vm (Rückweg)', 'proxmox.purge_backups']);
  });
  it('Frage verspricht kein Anwenden; nach dem Ja feste Meldung statt Modellrunde', async () => {
    const t = aufbau();
    await t.dienst.speichern('o', vorlage());
    await t.dienst.freigabeAnfragen('o', 'test_lab');
    expect(t.fragen[0]!.text).not.toContain('darf Alfred diese Version anwenden');
    expect(t.fragen[0]!.text).toContain('Angewendet wird nur auf ausdrücklichen Auftrag; jede Anwendung braucht die normale Change-Freigabe.');
    expect(bauplanNachJa({ success: true, display: 'Bauplan-Vorlage test_lab v1 ist freigegeben' })).toEqual({ meldung: expect.stringContaining('ist freigegeben') });
    expect(bauplanNachJa({ success: false, error: 'Keine gültige Freigabe' })).toEqual({ meldung: '✗ Keine gültige Freigabe' });
  });
  it('Bestätigungsweg: Skill mit den Button-Parametern (echter Nonce) gibt frei', async () => {
    const t = aufbau();
    await t.dienst.speichern('o', vorlage());
    await t.dienst.freigabeAnfragen('o', 'test_lab');
    const skill = new BauplanSkill(t.dienst, { istOwner: () => true, owner: () => 'o' });
    const r = await skill.execute(t.fragen[0]!.params, { userId: 'owner' } as SkillContext);
    expect(r.success).toBe(true);
    expect(t.zeilen[0]!.status).toBe('freigegeben');
  });
});

// ── V4 — Bauplan aus erfolgreich ausgeführten Changes ableiten ──
const ALLE = PKI_QUELLEN.map(q => q.id) as [string, string, string];
const NAMEN: Record<string, string> = Object.assign({}, ...PKI_QUELLEN.map(q => q.betroffenNamen));
/** QuellChange (Planform) zurück in einen gespeicherten Change mit Lauf */
function alsChange(q: QuellChange, mehr: Partial<CmdbChangeRequest> & { ohneLauf?: boolean } = {}): CmdbChangeRequest {
  const p = q.plan as Roh;
  const { ohneLauf, ...rest } = mehr;
  return {
    id: q.id, userId: 'o', title: p.titel, description: p.begruendung, type: p.typ === 'notfall' ? 'emergency' : 'normal', status: 'completed', riskLevel: p.risiko,
    affectedAssetIds: p.betroffen, affectedServiceIds: [], abhaengigVon: p.abhaengigVon, ausfallMinuten: p.ausfallMinuten, schritte: p.schritte,
    ...(p.ohneSicherungGrund ? { pruefung: { fehler: [], hinweise: [], zeit: 'x', zusatz: { ohneSicherungGrund: p.ohneSicherungGrund } } } : {}),
    ...(ohneLauf ? {} : { lauf: { phase: 'fertig', schritt: 0, start: 'x', ergebnisse: q.ergebnisse.map(e => ({ ...e, start: 'x', ausgabe: 'lang' })) } }),
    createdAt: '2026-11-15T10:00:00Z', updatedAt: 'x', ...rest,
  } as unknown as CmdbChangeRequest;
}
const pkiChanges = () => PKI_QUELLEN.map(q => alsChange(q));
const KOPF = { key: 'pki_lab_abgeleitet', titel: 'PKI-Lab abgeleitet', zweck: 'Abgeleitet aus den PKI-Lab-Changes', dokumentart: 'testprotokoll' as const };
/** Auswahl VLAN + beide VMIDs; alle Teilvorkommen von 157 ersetzen, 158 bewusst fest */
function pkiAuswahl() {
  const k = findeKandidaten(PKI_QUELLEN);
  const nr = (typ: string, wert: unknown) => k.find(c => c.typ === typ && c.wert === wert)!;
  const vlan = nr('vlan', 832), v157 = nr('vmid', 157), v158 = nr('vmid', 158);
  const teil: Record<string, 'ersetzen' | 'fest'> = {};
  for (const t of v157.teilvorkommen) teil[t.id] = 'ersetzen';
  for (const t of v158.teilvorkommen) teil[t.id] = 'fest';
  for (const t of vlan.teilvorkommen) teil[t.id] = 'ersetzen';
  const auswahl = { [String(vlan.nr)]: 'vlan', [String(v157.nr)]: 'vmid_server', [String(v158.nr)]: 'vmid_client' };
  return { auswahl, teil: allesFest(PKI_QUELLEN, auswahl, teil), stand: standVon(PKI_QUELLEN) };
}
/** Final-Welle: übrige offene Entscheidungen (feste IDs, vom Paket angelegte Werte) „fest“ — basis gewinnt */
function allesFest(q: QuellChange[], auswahl: Record<string, unknown>, basis: Entscheid): Entscheid {
  const e: Entscheid = { ...basis };
  for (const p of baueEntwurf(q, auswahl as never, KOPF, e).offen) e[p.id] ??= 'fest';
  return e;
}
const fehlerText = (r: { ok: boolean }) => ((r as { fehler?: string[] }).fehler ?? []).join('\n');

describe('V4 ableiten', () => {
  it('vorschlag: Reihenfolge nach abhaengigVon (Eingabe egal), Präfixe, Kandidaten wie die reine Ableitung; nichts gespeichert', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const r = await t.dienst.ableitenVorschlag('o', [ALLE[2].slice(0, 8), ALLE[0], ALLE[1].slice(0, 10)]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(r.kandidaten).toEqual(findeKandidaten(PKI_QUELLEN));
    expect(r.verweise).toEqual(findeVerweise(PKI_QUELLEN).verweise);
    expect(r.text).toContain('| Nr | Typ | Wert | Vorschlag | Fundstellen |');
    expect(r.text).toMatch(/\| \d+ \| vlan \| 832 \| vlan \| \d+ \|/);
    // Teilvorkommen gruppiert nach Change, Schritt, Wort — mit ids
    const v157 = r.kandidaten.find(k => k.typ === 'vmid' && k.wert === 157)!;
    expect(r.text).toContain('/etc/pve/qemu-server/157.conf');
    expect(r.text).toContain(v157.teilvorkommen[0]!.id);
    // Verweise Change/Schritt/Feld ← Quelle
    expect(r.text).toMatch(/288c3716 Schritt 13 parameter\.policy_id ← 2cfde1a2 Schritt 7\.id/);
    // gleicher Wert in mehreren Kandidaten (pve als zugang und als node)
    expect(r.hinweise.some(h => /gleicher Wert pve in mehreren Kandidaten.*auf denselben Parameter legen oder Stellen fest/.test(h))).toBe(true);
    // Rechnername und FQDN getrennt
    expect(r.hinweise.some(h => /labsrv01 und labsrv01\.pkilab\.test getrennt — beide wählen oder beide fest/.test(h))).toBe(true);
    expect(r.text).toContain('beide wählen oder beide fest');
    expect(t.zeilen).toHaveLength(0);
  });
  it('vorschlag: Teil eines Tresor-Namens wird als gesperrt gezeigt', async () => {
    const q = PKI_QUELLEN.map(x => JSON.parse(JSON.stringify(x)) as QuellChange);
    const s = (q[0]!.plan.schritte as Roh[]).find(x => x.parameter?.konto_tresor)!;
    s.parameter.konto_tresor = 'labsrv01-admin';
    const t = aufbau({ changes: q.map(x => alsChange(x)), assetNamen: NAMEN });
    const r = await t.dienst.ableitenVorschlag('o', ALLE);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(r.text).toMatch(/labsrv01-admin.*gesperrt \(Tresor\)/);
  });
  it('Change nicht completed oder ohne Lauf → Fehler mit voller ID; nichts gespeichert', async () => {
    const c = pkiChanges();
    c[1] = { ...c[1]!, status: 'in_progress' } as CmdbChangeRequest;
    c[2] = alsChange(PKI_QUELLEN[2]!, { ohneLauf: true });
    const t = aufbau({ changes: c, assetNamen: NAMEN });
    const r = await t.dienst.ableitenVorschlag('o', ALLE);
    expect(r.ok).toBe(false);
    const f = fehlerText(r);
    expect(f).toContain(ALLE[1]);
    expect(f).toMatch(/in_progress/);
    expect(f).toContain(ALLE[2]);
    expect(f).toMatch(/ohne Lauf/);
    const e = await t.dienst.ableitenErzeugen('o', ALLE, pkiAuswahl().auswahl, KOPF, pkiAuswahl().teil, pkiAuswahl().stand);
    expect(e.ok).toBe(false);
    expect(t.zeilen).toHaveLength(0);
  });
  it('Vorgänger außerhalb der Auswahl → Fehler mit ID; Zyklus → Fehler; mehr als 30 / leer / unbekannt / doppelt / mehrdeutig', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const r = await t.dienst.ableitenVorschlag('o', [ALLE[1]]);
    expect(r.ok).toBe(false);
    expect(fehlerText(r)).toMatch(new RegExp(`${ALLE[1]}.*Vorgänger ${ALLE[0]}.*nicht in der Auswahl`));
    const a = alsChange(PKI_QUELLEN[0]!, { id: 'aaaaaaaa-0000-0000-0000-000000000001', abhaengigVon: ['bbbbbbbb-0000-0000-0000-000000000002'] });
    const b = alsChange(PKI_QUELLEN[0]!, { id: 'bbbbbbbb-0000-0000-0000-000000000002', abhaengigVon: ['aaaaaaaa-0000-0000-0000-000000000001'] });
    const z = aufbau({ changes: [a, b], assetNamen: NAMEN });
    const rz = await z.dienst.ableitenVorschlag('o', ['aaaaaaaa', 'bbbbbbbb']);
    expect(rz.ok).toBe(false);
    expect(fehlerText(rz)).toMatch(/Zyklus.*aaaaaaaa-0000-0000-0000-000000000001/);
    expect(fehlerText(await t.dienst.ableitenVorschlag('o', Array.from({ length: 31 }, (_, i) => `x${i}`)))).toMatch(/höchstens 30/);
    expect((await t.dienst.ableitenVorschlag('o', [])).ok).toBe(false);
    expect(fehlerText(await t.dienst.ableitenVorschlag('o', ['deadbeef']))).toMatch(/deadbeef.*nicht gefunden/);
    expect(fehlerText(await t.dienst.ableitenVorschlag('o', [ALLE[0], ALLE[0].slice(0, 8)]))).toMatch(/doppelt/);
    const m1 = alsChange(PKI_QUELLEN[0]!, { id: 'cccccccc-1000-0000-0000-000000000001' });
    const m2 = alsChange(PKI_QUELLEN[0]!, { id: 'cccccccc-2000-0000-0000-000000000002' });
    const m = aufbau({ changes: [m1, m2], assetNamen: NAMEN });
    expect(fehlerText(await m.dienst.ableitenVorschlag('o', ['cccccccc']))).toMatch(/mehrdeutig/);
  });
  it('erzeugen: speichert über speichern mit abgeleitetAus (volle IDs in Reihenfolge), Status entwurf, Anzeige mit Parametern, Annahmen, bewusst fest', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const { auswahl, teil, stand } = pkiAuswahl();
    const r = await t.dienst.ableitenErzeugen('o', [ALLE[2], ALLE[1], ALLE[0]], auswahl, KOPF, teil, stand);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(t.zeilen).toHaveLength(1);
    const z = t.zeilen[0]!;
    expect(z.abgeleitetAus).toBe(ALLE.join(','));
    expect(z.status).toBe('entwurf');
    const v = JSON.parse(z.json) as Roh;
    expect(v.parameter.map((p: Roh) => p.name)).toEqual(expect.arrayContaining(['vlan', 'vmid_server', 'vmid_client']));
    expect(v.changes.map((c: Roh) => c.schluessel)).toEqual(['c1', 'c2', 'c3']);
    expect(r.text).toContain(`${KOPF.key} v1`);
    expect(r.text).toContain('entwurf');
    expect(r.text).toContain(z.abdruck.slice(0, 12));
    expect(r.text).toMatch(/vmid_server \(vmid/);
    expect(r.text).toMatch(/vlan_frei/);
    expect(r.text).toMatch(/bewusst fest: .*158/);
    expect(r.text).toMatch(/bauplan_freigabe_anfragen/);
  });
  it('erzeugen: Probe-Fehler und baueEntwurf-Fehler kommen unverändert durch, nichts gespeichert', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN, probeFehler: ['Probe: Schritt 3 kaputt'] });
    const { auswahl, teil, stand } = pkiAuswahl();
    const r = await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, stand);
    expect(r.ok).toBe(false);
    expect(fehlerText(r)).toContain('Probe: Schritt 3 kaputt');
    expect(t.zeilen).toHaveLength(0);
    t.zustand.probeFehler = [];
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, { ...auswahl, [Object.keys(auswahl)[0]!]: 'Kein Name' }, KOPF, teil, stand))).toMatch(/Parametername/);
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, Object.fromEntries(Object.keys(auswahl).map(k => [k, 'gleich'])), KOPF, teil, stand))).toMatch(/doppelt vergeben/);
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, {}, stand))).toMatch(/ohne Entscheidung/);
    expect(t.zeilen).toHaveLength(0);
  });
  it('ohne verdrahtete Change-Quelle → Fehler statt Absturz', async () => {
    const t = aufbau();
    expect((await t.dienst.ableitenVorschlag('o', ALLE)).ok).toBe(false);
  });
});

// ── V4 Final-Welle: Stand, Ableitung in der Freigabe-Frage, alle Fundstellen, Lesefehler, eine Change-Liste, neue Version ──
describe('V4 ableiten — Final-Welle', () => {
  const I8C_IDS = I8C_QUELLEN.map(q => q.id) as [string, string, string, string];
  const I8C_NAMEN: Record<string, string> = Object.assign({}, ...I8C_QUELLEN.map(q => q.betroffenNamen));

  it('vorschlag: Stand, alle Fundstellen mit Pfad (nicht nur drei), Entscheidungspunkte mit ids', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const r = await t.dienst.ableitenVorschlag('o', ALLE);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(r.stand).toBe(standVon(PKI_QUELLEN));
    expect(r.text).toContain(`Stand ${r.stand}`);
    expect(r.text).toContain(`stand "${r.stand}"`);
    // M-d: alle Fundstellen der VLAN 832 einzeln mit Pfad
    const vlan = r.kandidaten.find(k => k.typ === 'vlan' && k.wert === 832)!;
    expect(vlan.fundstellen.length).toBeGreaterThan(3);
    const zeile = r.text.split('\n').find(z => z.startsWith(`- #${vlan.nr} 832:`))!;
    for (const f of vlan.fundstellen) expect(zeile).toContain(f.schritt === 0 ? `${f.change.slice(0, 8)} Titel` : `${f.change.slice(0, 8)} S${f.schritt} ${f.pfad}`);
    // > 40 Fundstellen gruppiert nach Change/Schritt (PKI-Lab: 56)
    const netz = r.kandidaten.find(k => k.wert === 'PKI-Lab')!;
    expect(netz.fundstellen.length).toBeGreaterThan(40);
    expect(r.text.split('\n').find(z => z.startsWith(`- #${netz.nr} PKI-Lab:`))).toMatch(/2cfde1a2 S5 \(parameter\.network_name, pruefung\.erwartet, rueckweg\.parameter\.network_name\)/);
    // Entscheidungspunkte: angelegte Werte mit id
    expect(r.text).toContain('Vom Paket angelegt');
    expect(r.text).toContain('anlage:name|labsrv01');
    expect(r.entscheidungen.some(p => p.id === 'anlage:name|labsrv01')).toBe(true);
  });

  it('erzeugen verlangt den Stand des Vorschlags; abweichender Stand → „Vorschlag neu holen“, nichts gespeichert', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const { auswahl, teil, stand } = pkiAuswahl();
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil))).toMatch(/stand: den Stand aus dem Vorschlag/);
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, 'abcdef012345'))).toMatch(/Stand abcdef012345 passt nicht.*Vorschlag neu holen/);
    expect(t.zeilen).toHaveLength(0);
    // geänderter Change zwischen Vorschlag und erzeugen (Kandidaten verschieben sich) → Stand weicht ab
    const c = JSON.parse(JSON.stringify(pkiChanges())) as CmdbChangeRequest[];
    (c[0]!.schritte as unknown as Roh[])[4]!.parameter.vlan = 833;
    const t2 = aufbau({ changes: c, assetNamen: NAMEN });
    expect(fehlerText(await t2.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, stand))).toMatch(/Vorschlag neu holen/);
    expect(t2.zeilen).toHaveLength(0);
    // Wertvergleich in der Auswahl
    const nr = Object.keys(auswahl).find(k => auswahl[k] === 'vlan')!;
    expect(fehlerText(await t.dienst.ableitenErzeugen('o', ALLE, { ...auswahl, [nr]: { name: 'vlan', wert: 830 } }, KOPF, teil, stand))).toMatch(/hat den Wert 832, nicht 830/);
  });

  it('I2: ableitung wird gespeichert und die Freigabe-Frage zeigt Quellen, bewusst feste Stellen und fehlende Vorab-Kontrollen', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const { auswahl, teil, stand } = pkiAuswahl();
    const r = await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, stand);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    const z = t.zeilen[0]!;
    const ab = JSON.parse(z.ableitung!) as { quellen: string[]; fest: Array<{ id: string; art: string; wort: string }>; ohneAnnahme: string[] };
    expect(ab.quellen).toEqual(ALLE);
    expect(ab.fest.some(f => f.art === 'teil' && f.wort.includes('158'))).toBe(true);
    expect(ab.fest.some(f => f.id === 'anlage:name|labsrv01')).toBe(true);
    // ableitung gehört nicht in den Abdruck
    expect(z.json).not.toContain('anlage:');
    expect(r.text).toMatch(/Bewusst fest: \d+ Stellen \(stehen in der Freigabe-Frage\)/);
    const a = await t.dienst.freigabeAnfragen('o', KOPF.key);
    if (!a.ok) throw new Error(a.fehler.join('\n'));
    const frage = t.fragen.at(-1)!.text;
    expect(frage).toContain(`Abgeleitet aus: ${ALLE.map(x => x.slice(0, 8)).join(', ')}`);
    expect(frage).toMatch(/⚠️ Bewusst fest \(\d+ Stellen\)/);
    expect(frage).toMatch(/Vom Paket angelegt, nicht als Parameter \(\d+ Werte\):\n- SQLServer2025-x64-ENU-EntDev\.iso: \d+ Stellen[^\n]*\n- PKI-Lab: \d+ Stellen/);
    expect(frage).toMatch(/Teilvorkommen \(\d+\):\n- \/etc\/pve\/qemu-server\/158\.conf in 2cfde1a2 S1 pruefung\.befehl/);
    // Tresor-Einträge unter eigener Überschrift (pkilab-sql bewusst wiederverwendet)
    expect(frage).toMatch(/Verwendet bestehende Tresor-Einträge \(dasselbe Geheimnis wie die Original-Instanz; 1 Wert\):\n- pkilab-sql: 8 Stellen/);
    // vlan/vmid_server/vmid_client haben alle eine automatische Annahme
    expect(frage).not.toContain('Ohne automatische Vorab-Kontrolle');
  });

  it('I8c über den Dienst: VMIDs/VLAN/IPs gewählt, Namen nicht → Fehler mit angelegten Werten; alle „fest“ → Entwurf, Freigabe-Frage mit „bewusst fest“', async () => {
    const t = aufbau({ changes: I8C_QUELLEN.map(q => alsChange(q)), assetNamen: I8C_NAMEN });
    const v = await t.dienst.ableitenVorschlag('o', I8C_IDS.map(x => x.slice(0, 8)));
    if (!v.ok) throw new Error(v.fehler.join('\n'));
    const nr = (typ: string, wert: unknown) => String(v.kandidaten.find(c => c.typ === typ && c.wert === wert)!.nr);
    const auswahl = {
      [nr('vmid', 152)]: 'vmid_dc1', [nr('vmid', 153)]: 'vmid_dc2', [nr('vlan', 829)]: 'vlan', [nr('cidr', '10.203.29.0/27')]: 'netz',
      [nr('ipv4', '10.203.29.1')]: 'gateway', [nr('ipv4', '10.203.29.2')]: 'ip_dc1', [nr('ipv4', '10.203.29.3')]: 'ip_dc2', [nr('ipv4', '10.203.29.30')]: 'ip_test',
    };
    const teil: Entscheid = {};
    for (const k of v.kandidaten) {
      if (k.typ === 'vlan' && k.wert === 829) for (const x of k.teilvorkommen) teil[x.id] = 'ersetzen';
      if (k.typ === 'ipv4' && k.wert === '10.203.29.3') for (const x of k.teilvorkommen) teil[x.id] = 'fest';
    }
    const kopf = { key: 'ad_wald', titel: 'AD-Wald', zweck: 'Wald mit zwei DCs', dokumentart: 'betrieb' as const };
    const ohne = await t.dienst.ableitenErzeugen('o', I8C_IDS, auswahl, kopf, teil, v.stand);
    expect(ohne.ok).toBe(false);
    const f = fehlerText(ohne);
    expect(f).toContain(`${I8C_IDS[2].slice(0, 8)} Schritt 6 parameter.zugang (windows_ad.dns_client)`);
    expect(f).toContain('anlage:name|ad.3033.at');
    expect(f).toContain('anlage:name|AD-Identity');
    expect(f).toContain('anlage:name|I8c-Block-Gateway');
    expect(t.zeilen).toHaveLength(0);
    // alle offenen „fest“ (ids aus dem Vorschlag)
    const alle: Entscheid = { ...teil };
    // nicht nötige Entscheidungen (gewählte, vollständig ersetzte Werte) auslassen — erzeugen meldet sie sonst
    const gewaehlt = new Set(Object.keys(auswahl).map(n => String(v.kandidaten.find(c => String(c.nr) === n)!.wert)));
    for (const p of v.entscheidungen) if (p.art !== 'teil' && !gewaehlt.has(p.wert) && p.id !== 'anlage:name|vmbr829') alle[p.id] = 'fest';
    const r = await t.dienst.ableitenErzeugen('o', I8C_IDS, auswahl, kopf, alle, v.stand);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    expect(t.zeilen).toHaveLength(1);
    const a = await t.dienst.freigabeAnfragen('o', 'ad_wald');
    if (!a.ok) throw new Error(a.fehler.join('\n'));
    const frage = t.fragen.at(-1)!.text;
    expect(frage).toMatch(/⚠️ Bewusst fest \(\d+ Stellen\)/);
    expect(frage).toMatch(/\n- dc01: \d+ Stellen/);
    expect(frage).toMatch(/\n- ad\.3033\.at: \d+ Stellen/);
    expect(frage).toMatch(/\n- AD-Identity: \d+ Stellen/);
    // mehr als 15 angelegte Werte → die ersten 15 wörtlich, Rest gezählt
    expect(frage).toMatch(/Vom Paket angelegt, nicht als Parameter \(17 Werte\):[\s\S]*\n {2}… und 2 weitere/);
    // Restpunkte: NetBIOS ist angelegt; dc01-Zeile nennt den Tresor-Namen; veränderte vorhandene Objekte eigene Überschrift
    expect(frage).toMatch(/\n- AD3033: \d+ Stellen/);
    expect(frage).toMatch(/\n- dc01: \d+ Stellen \([^\n]*\) — steckt auch im Tresor-Namen win-dc01-admin/);
    // Sicherheitsbefund v1881 (fail-closed): außer 9102/probe-win25b auch vorhandene Zonen und Quell-IPs der Policies; nie die Träger
    expect(frage).toMatch(/Verändert vorhandene Objekte \(nicht vom Paket angelegt, nicht als Parameter; 7 Werte\):[\s\S]*\n- 9102: \d+ Stellen[^\n]*\n- probe-win25b: \d+ Stellen/);
    for (const w of ['Internal', '192.168.1.223', '192.168.1.92', 'Gateway', 'External']) expect(frage).toContain(`\n- ${w}: `);
    for (const t of ['pve1', 'pve3', 'alfred-pbs-taeglich']) expect(frage).not.toContain(`\n- ${t}: `);
    expect(v.text).toContain('Verändert vorhandene Objekte');
    expect(v.text).toContain('veraendert:name|probe-win25b');
    // record_type ist kein angelegter Wert; 10.203.29.3 in 10.203.29.30 trägt den Parameter der .30 — nicht als „fest“ gemeldet
    expect(frage).not.toContain('FORWARD:');
    expect(frage).toContain('Ohne automatische Vorab-Kontrolle (1): netz');
    expect(frage).not.toMatch(/Teilvorkommen \(/);
  });

  it('M5: vorhandener Key → Anzeige und Freigabe-Frage nennen die neue Version und was sie ersetzt', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    const { auswahl, teil, stand } = pkiAuswahl();
    const r1 = await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, stand);
    if (!r1.ok) throw new Error(r1.fehler.join('\n'));
    expect(r1.text).not.toMatch(/neue Version von/);
    await t.dienst.freigabeAnfragen('o', KOPF.key);
    const p = t.fragen.at(-1)!.params;
    expect((await t.dienst.freigebenNachJa('o', KOPF.key, p.version as number, p.freigabe)).ok).toBe(true);
    const r2 = await t.dienst.ableitenErzeugen('o', ALLE, auswahl, KOPF, teil, stand);
    if (!r2.ok) throw new Error(r2.fehler.join('\n'));
    expect(r2.text).toContain(`neue Version von ${KOPF.key}, ersetzt nach Freigabe v1 (freigegeben)`);
    await t.dienst.freigabeAnfragen('o', KOPF.key);
    expect(t.fragen.at(-1)!.text).toContain(`neue Version von ${KOPF.key}, ersetzt nach Freigabe v1 (freigegeben)`);
  });

  it('M2: Asset-Name nicht lesbar → Fehler mit Asset-ID, kein stilles Weitermachen; M3: Change-Liste einmal je Ableitung', async () => {
    const t = aufbau({ changes: pkiChanges(), assetNamen: NAMEN, assetFehler: 'DB weg' });
    const r = await t.dienst.ableitenVorschlag('o', ALLE);
    expect(r.ok).toBe(false);
    expect(fehlerText(r)).toMatch(/Asset b4e48d79-2872-45aa-9a45-6843a2a85c0f: Name nicht lesbar \(DB weg\)/);
    const m = aufbau({ changes: pkiChanges(), assetNamen: NAMEN });
    await m.dienst.ableitenVorschlag('o', [ALLE[0].slice(0, 8), ALLE[1].slice(0, 8), ALLE[2].slice(0, 8)]);
    expect(m.ladungen.changes).toBe(1);
  });
});
