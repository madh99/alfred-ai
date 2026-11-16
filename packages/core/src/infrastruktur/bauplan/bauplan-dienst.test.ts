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

function aufbau(o: { probeFehler?: string[]; pruefung?: (p: Pruefung) => { ok: boolean; text: string } } = {}) {
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
        const z: BauplanVorlageZeile = { id: `id-${d.key}-${version}`, key: d.key, version, json: d.json, abdruck: d.abdruck, status: 'entwurf', ...(d.abgeleitetAus ? { abgeleitetAus: d.abgeleitetAus } : {}), createdAt: 'x', updatedAt: 'x' };
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
  };
  const dienst = new BauplanDienst(deps);
  return { dienst, zeilen, instanzen, geplant, anfragen, fragen, meldungen, pruefungen, verworfen, zustand, setzeJetzt: (t: number) => { jetzt = t; } };
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
