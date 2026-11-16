/**
 * V3 Task 6 — Bauplan-Vorlage pki_lab (eingebaut: vorlagen/pki_lab.ts) aus den Changes 2cfde1a2 (Aufbau), 7335dfeb (Test) und
 * 288c3716 (Abbau) vom 15.11.2026: Schema, Platzhalter, Parameter-Nutzung, Verweise über Change-Grenzen und Einsetzen offline.
 * Die echte Probe gegen die lebenden Skills (ChangePlanung.pruefeNur) läuft nach dem Deploy live (bauplan_speichern).
 */
import { describe, it, expect } from 'vitest';
import { pruefeSchema, type BauplanVorlage } from './schema.js';
import { pruefeVorlage } from './validierung.js';
import { loeseParameter, setzeEin } from './parameter.js';
import { ProxmoxSkill, UniFiSkill } from '@alfred/skills';
import { ChangePlanung } from '../change-planung.js';
import { pruefeChangePlan, type PruefKontext } from '../change-schritte.js';
import { PkiLabSkill } from '../pki-lab-skill.js';
import { WindowsClusterSkill } from '../windows-cluster-skill.js';
import { WindowsAdSkill } from '../windows-ad-skill.js';
import { FernzugriffSkill } from '../../fernzugriff/fernzugriff-skill.js';
import { eingebauteVorlage } from './vorlagen/index.js';
import { BauplanDienst } from './bauplan-dienst.js';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchrittDaten } from '@alfred/storage';

// Final-Welle I2 — einzige Quelle ist die eingebaute Vorlage (Register), je Test eine frische Kopie
const roh = (): Record<string, unknown> => eingebauteVorlage('pki_lab') as Record<string, unknown>;

function beispielWerte(v: BauplanVorlage): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  for (const p of v.parameter) if (!p.ableitung && p.beispiel !== undefined) e[p.name] = p.beispiel;
  const r = loeseParameter(v, e);
  expect(r.fehler).toEqual([]);
  return r.werte;
}
const schritteVon = (v: BauplanVorlage, k: string) => v.changes.find(c => c.schluessel === k)!.schritte;

describe('Bauplan-Vorlage pki_lab', () => {
  it('besteht die Strukturprüfung', () => {
    const s = pruefeSchema(roh());
    expect(s.fehler).toEqual([]);
    expect(s.vorlage?.key).toBe('pki_lab');
    expect(s.vorlage?.dokumentart).toBe('testprotokoll');
    expect(s.vorlage?.changes.map(c => [c.schluessel, c.abhaengigVon])).toEqual([['aufbau', []], ['test', ['aufbau']], ['abbau', ['aufbau', 'test']]]);
  });

  it('volle Validierung mit Fake-Probe: keine Fehler, jeder Parameter benutzt, Probe bekommt alle Pläne samt Eingangskontrolle', async () => {
    let plaene: Array<Record<string, unknown>> = [];
    const r = await pruefeVorlage(roh(), { probe: async p => { plaene = p as Array<Record<string, unknown>>; return []; } });
    expect(r.fehler).toEqual([]);
    expect(r.hinweise).toEqual([]);
    expect(plaene.map(p => p.schluessel)).toEqual(['aufbau', 'test', 'abbau', 'annahmen']);
    const json = JSON.stringify(plaene);
    expect(json).not.toMatch(/\{\{\s*param\./);
    // Beispielwerte stehen eingesetzt in den Plänen (Zahl bleibt Zahl)
    const aufbau = plaene[0]!.schritte as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const server = aufbau.find(s => s.aktion === 'provision_windows_vm' && s.parameter.hostname === 'labsrv01')!;
    expect(server.parameter).toMatchObject({ new_vmid: 157, vlan_tag: 832, ip: '10.203.32.2/28', gateway: '10.203.32.1', node: 'pve', storage: 'data2-pve' });
    // Eingangskontrolle: VMIDs, VLAN, Netzname, Policy-Namensanfang — nur lesende Prüfungen
    const annahmen = plaene[3]!.schritte as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(annahmen.map(s => [s.pruefung.skill, s.pruefung.aktion, s.pruefung.nichtEnthalten])).toEqual([
      ['proxmox', 'list_vms', '| 157 |'], ['proxmox', 'list_vms', '| 158 |'], ['unifi', 'list_networks', '| 832 |'],
      ['unifi', 'list_networks', '| PKI-Lab |'], ['unifi', 'list_firewall_policies', '→'],
    ]);
    expect(plaene[3]!.betroffen).toEqual(['pve', 'UDMPRO', 'sql01']);
  });

  it('Abbau löscht die Policies und bereinigt das Netz über die IDs der erzeugenden Aufbau-Schritte', () => {
    const v = pruefeSchema(roh()).vorlage!;
    const aufbau = schritteVon(v, 'aufbau'); const abbau = schritteVon(v, 'abbau');
    const ziel = (ref: string) => { const m = /^\{\{change:aufbau\.schritt(\d+)\.id\}\}$/.exec(ref); expect(m, ref).not.toBeNull(); return aufbau[Number(m![1]) - 1]!; };
    const loeschen = abbau.filter(s => s.aktion === 'delete_firewall_policy');
    expect(loeschen).toHaveLength(3);
    const erzeugt = loeschen.map(s => ziel((s.parameter as Record<string, string>).policy_id));
    expect(erzeugt.map(s => s.aktion)).toEqual(['create_firewall_policy', 'create_firewall_policy', 'create_firewall_policy']);
    expect(erzeugt.map(s => (s.parameter as Record<string, string>).policy_name)).toEqual([
      '{{param.richtlinien_praefix}} Alfred SSH', '{{param.richtlinien_praefix}} BLOCK Internet', '{{param.richtlinien_praefix}} BLOCK Gateway',
    ]);
    // Rückweg jeder Löschung legt genau die Policy wieder an, die der Aufbau-Schritt erzeugt hat
    loeschen.forEach((s, i) => expect((s.rueckweg as Record<string, unknown>).parameter).toEqual(erzeugt[i]!.parameter));
    const netz = ziel((abbau.find(s => s.aktion === 'remove_orphan_zone_networks')!.parameter as Record<string, string>).network_id);
    expect(netz.aktion).toBe('create_network');
    // nur die fünf erwarteten Verweise über Change-Grenzen, keine festen IDs aus dem Lauf vom 15.11.
    const text = JSON.stringify(abbau);
    expect([...text.matchAll(/\{\{change:[^}]+\}\}/g)].map(m => m[0]).sort()).toEqual([
      '{{change:aufbau.schritt4.id}}', '{{change:aufbau.schritt6.id}}', '{{change:aufbau.schritt6.id}}', '{{change:aufbau.schritt7.id}}', '{{change:aufbau.schritt7.id}}', '{{change:aufbau.schritt8.id}}',
    ]);
    expect(JSON.stringify(v)).not.toMatch(/e5d24ae1|d2adc74e|014f89d7|855e212f|6fe2c8cd|d4350b59/);
  });

  it('Schritt-Verweise im Aufbau zeigen auf die erzeugenden Aktionen (ISO-Volume, Policy-IDs)', () => {
    const aufbau = schritteVon(pruefeSchema(roh()).vorlage!, 'aufbau');
    const refs = [...JSON.stringify(aufbau).matchAll(/\{\{schritt(\d+)\.(\w+)\}\}/g)].map(m => [Number(m[1]), m[2]] as const);
    expect(refs.length).toBeGreaterThan(0);
    for (const [n, feld] of refs) {
      const s = aufbau[n - 1]!;
      if (feld === 'volid') expect(s.aktion).toBe('iso_ablegen');
      else { expect(feld).toBe('id'); expect(s.aktion).toBe('create_firewall_policy'); }
    }
  });

  it('setzeEin mit den Beispielwerten lässt keinen {{param.…}} übrig und ändert keinen anderen Platzhalter', () => {
    const v = pruefeSchema(roh()).vorlage!;
    const eingesetzt = setzeEin(v, beispielWerte(v));
    const json = JSON.stringify(eingesetzt);
    expect(json).not.toMatch(/\{\{\s*param\./);
    const rest = (x: string) => [...x.matchAll(/\{\{[^{}]*\}\}/g)].map(m => m[0]).filter(p => !p.startsWith('{{param.')).sort();
    expect(rest(json)).toEqual(rest(JSON.stringify(v.changes)));
    expect(json).toContain('labsrv01.pkilab.test');
    expect(json).toContain('"konto_tresor":"pkilab-sql"');
  });

  it('echter Change-Validator offline (Metadaten der echten Skills): ganzes Paket samt Eingangskontrolle ohne Fehler', async () => {
    const skills: Record<string, unknown> = {
      proxmox: new ProxmoxSkill({ baseUrl: 'https://proxmox.invalid', tokenId: 't', tokenSecret: 's' } as never),
      unifi: new UniFiSkill({ baseUrl: 'https://unifi.invalid', apiKey: 'k' } as never),
      pki_lab: new PkiLabSkill({} as never), windows_cluster: new WindowsClusterSkill({} as never),
      windows_ad: new WindowsAdSkill({} as never), fernzugriff: new FernzugriffSkill({} as never),
    };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => skills[n] as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }, { id: 'a-udm', name: 'UDMPRO' }, { id: 'a-sql', name: 'sql01' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    let plaene: Array<Record<string, unknown>> = [];
    const r = await pruefeVorlage(roh(), { probe: p => { plaene = p as Array<Record<string, unknown>>; return pl.pruefeNur('o', p); } });
    expect(r.fehler).toEqual([]);
    // Fix-Runde 1 (C1) — die PBS-Prüftexte kommen als Text beim Validator an und bleiben im geprüften Plan (txt(157) wäre still entfallen)
    const kontext: PruefKontext = { skill: n => skills[n] as never, asset: () => ({ id: 'a', name: 'a' }), changes: [] };
    const erwartet: Array<[string, number, 'erwartet' | 'nichtEnthalten', string]> = [
      ['aufbau', 13, 'erwartet', ',157,'], ['aufbau', 14, 'erwartet', ',158,'], ['abbau', 11, 'nichtEnthalten', ',157,'], ['abbau', 12, 'nichtEnthalten', ',158,'],
    ];
    for (const [k, nr, feld, wert] of erwartet) {
      const plan = plaene.find(p => p.schluessel === k)!;
      expect((plan.schritte as Array<{ pruefung: Record<string, unknown> }>)[nr - 1]!.pruefung[feld], `${k} ${nr} roh`).toBe(wert);
      const geprueft = pruefeChangePlan(plan, kontext, ['aufbau', 'test', 'abbau']).plan.schritte[nr - 1]!.pruefung as unknown as Record<string, unknown>;
      expect(geprueft[feld], `${k} ${nr} geprüft`).toBe(wert);
      if (k === 'abbau') expect(geprueft.erwartet).toBe('vzdump: alfred-pbs-taeglich');
    }
    // M1 — Rückweg des Aufbau-Ausnahmeschritts entfernt die Ausnahmen wieder
    expect((plaene[0]!.schritte as Array<Record<string, any>>)[12]!.rueckweg.parameter).toEqual({ job_id: 'alfred-pbs-taeglich', remove_vmids: [157, 158] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    // delete_vm im Abbau braucht zweck stilllegung — ohne ihn meldet der echte Validator genau die beiden Lösch-Schritte
    const ohneZweck = roh(); delete (ohneZweck.changes as Array<Record<string, unknown>>)[2]!.zweck;
    expect((await pruefeVorlage(ohneZweck, { probe: p => pl.pruefeNur('o', p) })).fehler).toEqual([7, 8].map(n => `Probe: Change abbau: Schritt ${n}: proxmox.delete_vm entfernt Bestehendes endgültig — nur in einem eigenen Change mit zweck stilllegung`));
  });

  it('enge Parameter: Werte außerhalb dessen, was die pki_lab-Bausteine annehmen, werden abgewiesen', () => {
    const v = pruefeSchema(roh()).vorlage!;
    const basis: Record<string, unknown> = {};
    for (const p of v.parameter) if (!p.ableitung) basis[p.name] = p.beispiel;
    const fehler = (w: Record<string, unknown>) => loeseParameter(v, { ...basis, ...w }).fehler.join('\n');
    expect(fehler({ netz: '10.203.33.0/28' })).toMatch(/Parameter netz/);
    expect(fehler({ domaene: 'lab.local' })).toMatch(/Parameter domaene/);
    expect(fehler({ name_server: 'srv01' })).toMatch(/Parameter name_server/);
    expect(fehler({ sql_konto: 'win-dc01-admin' })).toMatch(/Parameter sql_konto/);
    expect(fehler({ node: 'pve3' })).toMatch(/Parameter node/);
    expect(fehler({ netzname: 'x; rm -rf /' })).toMatch(/Parameter netzname/);
    expect(fehler({})).toBe('');
  });

  it('Final-Welle M1: anwenden offline mit echter ChangePlanung — 0 Fehler, Abbau-Verweise nach der Verschiebung um 5 auf Aufbau 9/11/12/13, Owner-Schritt bleibt Abbau 1', async () => {
    const skills: Record<string, unknown> = {
      proxmox: new ProxmoxSkill({ baseUrl: 'https://proxmox.invalid', tokenId: 't', tokenSecret: 's' } as never),
      unifi: new UniFiSkill({ baseUrl: 'https://unifi.invalid', apiKey: 'k' } as never),
      pki_lab: new PkiLabSkill({} as never), windows_cluster: new WindowsClusterSkill({} as never),
      windows_ad: new WindowsAdSkill({} as never), fernzugriff: new FernzugriffSkill({} as never),
    };
    const db = new Map<string, CmdbChangeRequest>(); let n = 0;
    const itsm = {
      liste: async () => [...db.values()],
      hole: async (_o: string, id: string) => db.get(id) ?? null,
      legeAn: async (_o: string, d: ChangeSchrittDaten) => {
        const id = `c${String(++n).padStart(7, '0')}-0000-0000-0000-000000000000`;
        db.set(id, { id, userId: 'o', title: d.title, description: d.description, type: d.type, status: 'submitted', riskLevel: d.riskLevel, affectedAssetIds: d.affectedAssetIds, affectedServiceIds: [], implementationPlan: d.implementationPlan, rollbackPlan: d.rollbackPlan, testPlan: d.testPlan, schritte: d.schritte, abhaengigVon: d.abhaengigVon, ausfallMinuten: d.ausfallMinuten, pruefung: d.pruefung, fingerabdruck: d.fingerabdruck, createdAt: 'x', updatedAt: 'x' } as CmdbChangeRequest);
        return db.get(id)!;
      },
      setzeSchritte: async () => { throw new Error('nicht erwartet'); },
      freigeben: async () => { throw new Error('nicht erwartet'); },
      setzeFreigabeAnfrage: async () => undefined,
    };
    const pl = new ChangePlanung({
      itsm: itsm as never,
      skill: nm => skills[nm] as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }, { id: 'a-udm', name: 'UDMPRO' }, { id: 'a-sql', name: 'sql01' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
      bestaetigung: async () => true,
    });
    const zeilen: Array<Record<string, unknown>> = [];
    let geplant: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let planFehler: string[] = [];
    const dienst = new BauplanDienst({
      repo: {
        speichere: async (_u, d) => { const z = { id: `z${zeilen.length + 1}`, key: d.key, version: zeilen.length + 1, json: d.json, abdruck: d.abdruck, status: 'entwurf', createdAt: 'x', updatedAt: 'x' }; zeilen.push(z); return { ...z } as never; },
        finde: async (_u, key, version) => { const z = zeilen.filter(x => x.key === key && (version === undefined || x.version === version)).at(-1); return z ? { ...z } as never : undefined; },
        liste: async () => zeilen.map(z => ({ ...z })) as never,
        setze: async (_u, id, d) => { const z = zeilen.find(x => x.id === id)!; for (const [k, w] of Object.entries(d)) if (w !== undefined) z[k] = w === '' ? undefined : w; },
      },
      instanzen: { anlegen: async (_u, d) => ({ id: 'inst-1', name: d.name }), finde: async () => undefined },
      pruefeNur: (o, r) => pl.pruefeNur(o, r),
      planen: async (o, r) => { geplant = r as typeof geplant; const x = await pl.planen(o, r); if (!x.ok) planFehler = x.fehler; return x.ok ? { ok: true, ids: x.changes.map(c => c.id) } : x; },
      freigabeAnfragen: async () => ({ ok: true, text: 'Freigabe-Frage gestellt' }),
      pruefe: async () => ({ ok: true, text: 'frei' }),
      frage: async () => true, melde: async () => undefined, verwerfen: async () => undefined,
    });
    const s = await dienst.speichern('o', roh());
    if (!s.ok) throw new Error(s.fehler.join('\n'));
    await dienst.freigabeAnfragen('o', 'pki_lab');
    zeilen[0]!.status = 'freigegeben'; // Owner-Ja (Nonce-Weg ist in bauplan-dienst.test.ts belegt)
    const v = pruefeSchema(roh()).vorlage!;
    const eingabe: Record<string, unknown> = {};
    for (const p of v.parameter) if (!p.ableitung && p.beispiel !== undefined) eingabe[p.name] = p.beispiel;
    const r = await dienst.anwenden('o', 'pki_lab', eingabe, 'pki-lab-offline');
    expect(planFehler).toEqual([]);
    if (!r.ok) throw new Error(r.fehler.join('\n'));
    // an planen übergeben: 5 Eingangskontrollen vorn im Aufbau, Abbau-Verweise um 5 verschoben
    const [aufbau, test, abbau] = geplant;
    expect(aufbau!.schritte).toHaveLength(39 + 5);
    expect(aufbau!.schritte.slice(0, 5).map((x: Record<string, unknown>) => x.art)).toEqual(['pruefung', 'pruefung', 'pruefung', 'pruefung', 'pruefung']);
    expect(test!.abhaengigVon).toEqual(['aufbau']);
    const refs = [...JSON.stringify(abbau!.schritte).matchAll(/\{\{change:aufbau\.schritt(\d+)\.id\}\}/g)].map(m => Number(m[1]));
    expect([...new Set(refs)].sort((a, b) => a - b)).toEqual([9, 11, 12, 13]);
    const aktionen = Object.fromEntries([9, 11, 12, 13].map(k => [k, `${aufbau!.schritte[k - 1].skill}.${aufbau!.schritte[k - 1].aktion}`]));
    expect(aktionen).toEqual({ 9: 'unifi.create_network', 11: 'unifi.create_firewall_policy', 12: 'unifi.create_firewall_policy', 13: 'unifi.create_firewall_policy' });
    expect(abbau!.schritte[0].art).toBe('owner');
    expect(abbau!.schritte).toHaveLength(32);
    // gespeichert: Verweise zeigen auf die volle ID des Aufbau-Change
    const [ca, , cb] = r.ids.map(id => db.get(id)!);
    expect(JSON.stringify(cb!.schritte)).toContain(`{{change:${ca!.id}.schritt11.id}}`);
    expect((cb!.schritte as Array<{ art: string }>)[0]!.art).toBe('owner');
  });
});
