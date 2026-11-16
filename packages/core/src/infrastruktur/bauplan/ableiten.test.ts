/**
 * V4 Task 1 — Bauplan ableiten (rein): Kandidaten, Verweise über Change-Grenzen, Entwurf mit Annahmen und Schutzregeln.
 * Quelle: die echten PKI-Lab-Changes (ableiten.fixture.ts) plus kleine I8c-artige Beispiele für Sonderfälle.
 */
import { describe, it, expect } from 'vitest';
import { baueEntwurf, findeEntscheidungen, findeKandidaten, findeVerweise, standVon, type Entscheid, type Kandidat, type QuellChange } from './ableiten.js';
import { PKI_QUELLEN } from './ableiten.fixture.js';
import { I8C_QUELLEN } from './ableiten-i8c.fixture.js';
import { pruefeSchema } from './schema.js';
import { pruefeVorlage } from './validierung.js';
import { eingebauteVorlage } from './vorlagen/index.js';
import { ProxmoxSkill, UniFiSkill } from '@alfred/skills';
import { ChangePlanung } from '../change-planung.js';
import { PkiLabSkill } from '../pki-lab-skill.js';
import { WindowsClusterSkill } from '../windows-cluster-skill.js';
import { WindowsAdSkill } from '../windows-ad-skill.js';
import { FernzugriffSkill } from '../../fernzugriff/fernzugriff-skill.js';

const quellen = (): QuellChange[] => JSON.parse(JSON.stringify(PKI_QUELLEN)) as QuellChange[];
const [AUFBAU, TEST, ABBAU] = PKI_QUELLEN.map(q => q.id) as [string, string, string];
const kand = (k: Kandidat[], typ: string, wert: string | number): Kandidat => {
  const x = k.find(c => c.typ === typ && c.wert === wert);
  expect(x, `Kandidat ${typ} ${String(wert)}`).toBeDefined();
  return x!;
};
const orte = (c: Kandidat, change: string) => c.fundstellen.filter(f => f.change === change).map(f => `${f.schritt}:${f.pfad}${f.ganz ? '' : '~'}`);
const kopf = { key: 'pki_lab_abgeleitet', titel: 'PKI-Lab abgeleitet', zweck: 'Abgeleitet aus den PKI-Lab-Changes', dokumentart: 'testprotokoll' as const };
/** Final-Welle: alle noch offenen Entscheidungen (feste IDs, vom Paket angelegte Werte, übrige Teilvorkommen) „fest“ setzen — basis gewinnt */
function mitFest(q: QuellChange[], auswahl: Record<number | string, unknown>, basis: Entscheid = {}) {
  const e: Entscheid = { ...basis };
  let r = baueEntwurf(q, auswahl as never, kopf, e);
  for (let i = 0; i < 3 && r.offen.length; i++) { for (const p of r.offen) e[p.id] ??= 'fest'; r = baueEntwurf(q, auswahl as never, kopf, e); }
  return { r, e };
}

/** Kleiner Change in Planform; Schritte nummeriert wie im echten Plan */
function change(id: string, schluessel: string, schritte: Array<Record<string, unknown>>, mehr: Partial<QuellChange> & { abhaengigVon?: string[]; betroffen?: string[] } = {}): QuellChange {
  return {
    id, schluessel, betroffenNamen: mehr.betroffenNamen ?? { 'asset-pve1': 'pve1' }, ergebnisse: mehr.ergebnisse ?? [],
    plan: { titel: `Change ${schluessel}`, begruendung: 'Beispiel', typ: 'normal', risiko: 'medium', betroffen: mehr.betroffen ?? ['asset-pve1'], abhaengigVon: mehr.abhaengigVon ?? [], schritte: schritte.map((s, i) => ({ nr: i + 1, art: 'aktion', zeitlimitS: 600, beiFehler: 'anhalten', ...s })) },
  };
}

describe('findeKandidaten', () => {
  it('VMIDs 157/158 und VLAN 832 mit allen typtreuen Fundstellen über die drei Changes', () => {
    const k = findeKandidaten(quellen());
    const v157 = kand(k, 'vmid', 157);
    expect(orte(v157, AUFBAU)).toEqual(expect.arrayContaining([
      '14:parameter.add_vmids[0]', '14:pruefung.erwartet~', '14:rueckweg.parameter.add_vmids[0]', '15:parameter.new_vmid', '15:rueckweg.parameter.vmid',
      '20:parameter.vmid', '20:rueckweg.parameter.vmid', '21:parameter.vmid', '21:pruefung.parameter.vmid', '28:parameter.vmid',
    ]));
    expect(orte(v157, ABBAU)).toEqual(expect.arrayContaining(['4:parameter.vmid', '6:parameter.vmid', '8:pruefung.befehl~', '10:parameter.remove_vmids[0]', '24:pruefung.befehl~']));
    // "157.conf" ist kein Token („.“ nur am Satzende), "vm-157-" auch nicht — beides nur Teilvorkommen
    expect(orte(v157, AUFBAU)).not.toContain('1:pruefung.befehl~');
    expect(orte(v157, ABBAU)).not.toContain('8:pruefung.nichtEnthalten~');
    expect(v157.teilvorkommen.map(f => `${f.change === AUFBAU ? 'A' : 'C'}${f.schritt}:${f.pfad}`)).toEqual(expect.arrayContaining(['A1:pruefung.befehl', 'C8:pruefung.nichtEnthalten']));
    const v158 = kand(k, 'vmid', 158);
    expect(orte(v158, AUFBAU)).toEqual(expect.arrayContaining(['16:parameter.new_vmid', '14:parameter.add_vmids[1]', '22:parameter.vmid']));
    const vlan = kand(k, 'vlan', 832);
    expect(orte(vlan, AUFBAU)).toEqual(expect.arrayContaining(['5:parameter.vlan', '15:parameter.vlan_tag', '16:parameter.vlan_tag']));
    expect(orte(vlan, ABBAU)).toEqual(expect.arrayContaining(['22:rueckweg.parameter.vlan']));
    // "VLAN832"/"Lab832" im Titel ist zusammengeschrieben → keine Fundstelle
    expect(orte(vlan, AUFBAU).filter(o => o.startsWith('0:') || o.endsWith('titel~'))).toEqual([]);
    expect(vlan.vorschlag).toBe('vlan');
    expect(v157.vorschlag).toBe('new_vmid');
    expect(v158.vorschlag).toBe('new_vmid_2');
    // Nummern fortlaufend ab 1
    expect(k.map(c => c.nr)).toEqual(k.map((_c, i) => i + 1));
  });

  it('pve in data2-pve ist keine Fundstelle; Speicher und Knoten sind getrennte Kandidaten', () => {
    const k = findeKandidaten(quellen());
    const pve = kand(k, 'node', 'pve');
    expect(pve.fundstellen.some(f => f.pfad === 'parameter.storage')).toBe(false);
    expect(orte(pve, ABBAU)).not.toContain('8:pruefung.befehl~');
    expect(orte(pve, AUFBAU)).toEqual(expect.arrayContaining(['15:parameter.node', '21:parameter.node']));
    // zugang "pve" ist ein Name (eigener Kandidat), nicht der node-Kandidat
    expect(orte(pve, AUFBAU)).not.toContain('1:pruefung.zugang');
    expect(orte(kand(k, 'name', 'pve'), AUFBAU)).toContain('1:pruefung.zugang');
    // /etc/pve/… ist ein Pfadteil, kein Knotenname
    expect(orte(pve, ABBAU)).not.toContain('6:pruefung.befehl~');
    expect(orte(kand(k, 'name', 'pve'), AUFBAU)).not.toContain('14:pruefung.befehl~');
    expect(pve.teilvorkommen.some(f => f.change === ABBAU && f.schritt === 6 && f.pfad === 'pruefung.befehl')).toBe(true);
    const sto = kand(k, 'storage', 'data2-pve');
    expect(orte(sto, ABBAU)).toEqual(expect.arrayContaining(['8:pruefung.befehl~']));
  });

  it('157 steckt nicht in 1157; gleicher Wert 152 als VMID und als Port bleibt getrennt (Port ist kein Kandidat)', () => {
    const q = [change('aaaaaaaa-1', 'c1', [
      { titel: 'dc01 (152) bereitstellen', skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { titel: 'Port 1152 und Port 152 prüfen', art: 'pruefung', pruefung: { typ: 'port', host: '10.0.0.5', port: 152 } },
      { titel: 'VM 1157 neu starten, nicht 157.', skill: 'proxmox', aktion: 'reboot_vm', parameter: { vmid: 1157, node: 'pve1' } },
      { titel: 'VM 152 stoppen', skill: 'proxmox', aktion: 'stop_vm', parameter: { vmid: 152, node: 'pve1' } },
    ])];
    const k = findeKandidaten(q);
    const v152 = kand(k, 'vmid', 152);
    expect(orte(v152, 'aaaaaaaa-1')).toEqual(['1:titel~', '1:parameter.new_vmid', '2:titel~', '4:titel~', '4:parameter.vmid']);
    expect(v152.fundstellen.some(f => f.pfad === 'pruefung.port')).toBe(false);
    expect(k.filter(c => c.wert === 152)).toHaveLength(1);
    // 1157 ist eigener VMID-Kandidat; 157 kommt nur als „157.“ am Satzende vor und ist nicht typisiert → kein Kandidat
    expect(orte(kand(k, 'vmid', 1157), 'aaaaaaaa-1')).toEqual(['3:titel~', '3:parameter.vmid']);
    expect(k.some(c => c.wert === 157)).toBe(false);
  });
});

describe('findeVerweise', () => {
  it('Abbau-policy_id/network_id = daten.id des erzeugenden Aufbau-Schritts (Position im Quell-Plan)', () => {
    const r = findeVerweise(quellen());
    expect(r.verweise.map(v => [v.change === ABBAU ? 'abbau' : v.change, v.schritt, v.pfad, v.quelle.change === AUFBAU ? 'aufbau' : v.quelle.change, v.quelle.schritt, v.quelle.feld, v.art ?? 'ganz'])).toEqual([
      ['abbau', 13, 'parameter.policy_id', 'aufbau', 7, 'id', 'ganz'],
      ['abbau', 13, 'pruefung.nichtEnthalten', 'aufbau', 7, 'id', 'praefix'],
      ['abbau', 15, 'parameter.policy_id', 'aufbau', 8, 'id', 'ganz'],
      ['abbau', 15, 'pruefung.nichtEnthalten', 'aufbau', 8, 'id', 'praefix'],
      ['abbau', 16, 'parameter.policy_id', 'aufbau', 9, 'id', 'ganz'],
      ['abbau', 28, 'parameter.network_id', 'aufbau', 5, 'id', 'ganz'],
    ]);
    expect(r.verweise[0]!.wert).toBe('e5d24ae1-c8b7-4582-afd3-20735646c44d');
    // nichtEnthalten "e5d24ae1" ist der ganze Wert → Verweis ohne Textposition
    expect(r.verweise[1]).toMatchObject({ wert: 'e5d24ae1' });
    expect(r.verweise[1]!.start).toBeUndefined();
    // nur Titel-Teile der IDs bleiben fest, mit Hinweis; die Prüfungen sind kein Hinweis mehr
    expect(r.hinweise.join('\n')).toMatch(/855e212f-4c48-4b10-b559-f6b8e5fca822/);
    expect(r.hinweise.join('\n')).not.toMatch(/Schritt 1[35] pruefung/);
    // Echo der Eingabe (job_id alfred-pbs-taeglich steht schon im Aufbau-Plan) ist keine erzeugte ID
    expect(r.verweise.some(v => v.wert === 'alfred-pbs-taeglich')).toBe(false);
  });

  it('ID aus einem nicht gewählten Change → kein Verweis, Hinweis', () => {
    const r = findeVerweise(quellen().filter(q => q.id !== AUFBAU));
    expect(r.verweise).toEqual([]);
    // Final-Welle I1: feste ID außerhalb von Titeln → Entscheidungspunkt (nur „fest“), nicht bloß Hinweis
    expect(r.feste.some(f => f.wert === 'e5d24ae1-c8b7-4582-afd3-20735646c44d' && f.pfad === 'parameter.policy_id' && /keinem gewählten Change/.test(f.grund))).toBe(true);
  });

  it('Quelle außerhalb der abhaengigVon-Hülle oder mehrdeutig → kein Verweis, Hinweis', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_zone', parameter: { zone_name: 'Z1' } }], { ergebnisse: [{ nr: 1, ok: true, daten: { id: uuid } }] });
    const b = change('bbbbbbbb-2', 'c2', [{ skill: 'unifi', aktion: 'create_zone', parameter: { zone_name: 'Z2' } }], { ergebnisse: [{ nr: 1, ok: true, daten: { zone_id: uuid } }] });
    const c = change('cccccccc-3', 'c3', [{ skill: 'unifi', aktion: 'delete_zone', parameter: { zone_id: uuid } }], { abhaengigVon: ['aaaaaaaa-1'] });
    expect(findeVerweise([a, c]).verweise).toHaveLength(1);
    // b liegt nicht in der Hülle von c → nur a
    expect(findeVerweise([a, b, c]).verweise.map(v => v.quelle.change)).toEqual(['aaaaaaaa-1']);
    // beide in der Hülle → mehrdeutig
    const c2 = change('cccccccc-3', 'c3', c.plan.schritte as Array<Record<string, unknown>>, { abhaengigVon: ['aaaaaaaa-1', 'bbbbbbbb-2'] });
    const r = findeVerweise([a, b, c2]);
    expect(r.verweise).toEqual([]);
    expect(r.feste.some(f => f.wert === uuid && /mehrdeutig/.test(f.grund))).toBe(true);
    // fehlgeschlagenes Ergebnis ist keine Quelle
    const aFail = { ...a, ergebnisse: [{ nr: 1, ok: false, daten: { id: uuid } }] };
    expect(findeVerweise([aFail, c]).verweise).toEqual([]);
  });

  it('Echo-Ausschluss nur bei ganzem Wert: ID im eigenen Titel/Text bleibt erzeugte ID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const a = change('aaaaaaaa-1', 'c1', [
      { titel: `Zone anlegen (vorher ${uuid} entfernt)`, skill: 'unifi', aktion: 'create_zone', parameter: { zone_name: 'Z1' }, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_zones', parameter: {}, nichtEnthalten: `alt ${uuid}` } },
    ], { ergebnisse: [{ nr: 1, ok: true, daten: { id: uuid } }] });
    const c = change('cccccccc-3', 'c2', [{ skill: 'unifi', aktion: 'delete_zone', parameter: { zone_id: uuid } }], { abhaengigVon: ['aaaaaaaa-1'] });
    expect(findeVerweise([a, c]).verweise.map(v => v.pfad)).toEqual(['parameter.zone_id']);
    // ganzer Wert im eigenen Plan bleibt Echo
    const aEcho = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_zone', parameter: { zone_name: 'Z1', vorlage_id: uuid } }], { ergebnisse: [{ nr: 1, ok: true, daten: { id: uuid } }] });
    expect(findeVerweise([aEcho, c]).verweise).toEqual([]);
  });

  it('ID-Anfang als Wort in einer Prüfung → Verweis mit Textposition; nicht in Parametern', () => {
    const uuid = 'e5d24ae1-c8b7-4582-afd3-20735646c44d';
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_firewall_policy', parameter: { policy_name: 'X' } }], { ergebnisse: [{ nr: 1, ok: true, daten: { id: uuid } }] });
    const c = change('cccccccc-3', 'c2', [
      { skill: 'unifi', aktion: 'delete_firewall_policy', parameter: { policy_id: uuid, notiz: 'e5d24ae1' }, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_firewall_policies', parameter: {}, nichtEnthalten: 'Policy e5d24ae1 aktiv' } },
    ], { abhaengigVon: ['aaaaaaaa-1'] });
    const r = findeVerweise([a, c]);
    expect(r.verweise.map(v => [v.pfad, v.art ?? 'ganz', v.start, v.ende])).toEqual([['parameter.policy_id', 'ganz', undefined, undefined], ['pruefung.nichtEnthalten', 'praefix', 7, 15]]);
    const { r: e } = mitFest([a, c], {});
    expect(e.fehler).toEqual([]);
    expect((e.vorlage!.changes[1]!.schritte[0]!.pruefung as Record<string, unknown>).nichtEnthalten).toBe('Policy {{change:c1.schritt1.id}} aktiv');
    expect((e.vorlage!.changes[1]!.schritte[0]!.parameter as Record<string, unknown>).notiz).toBe('e5d24ae1');
  });

  it('ID-Anfang nur bei Hex-IDs: name-artige IDs (alfred-pbs-taeglich) und UPIDs bleiben unberührt', () => {
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'proxmox', aktion: 'create_backup_job', parameter: { storage: 'pbs' } }],
      { ergebnisse: [{ nr: 1, ok: true, daten: { id: 'alfred-pbs-taeglich', upid: 'UPID:pve:0022BB1C:0458B354:6AF969C2:qmreboot:157:root@pam!alfred-ai:' } }] });
    const c = change('cccccccc-3', 'c2', [
      { art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'pve', befehl: 'cat /etc/pve/jobs.cfg', nichtEnthalten: 'alfred-pbs', erwartet: 'UPID:pve:0022BB1C' } },
    ], { abhaengigVon: ['aaaaaaaa-1'] });
    expect(findeVerweise([a, c]).verweise).toEqual([]);
    const e = baueEntwurf([a, c], {}, kopf);
    expect(e.fehler).toEqual([]);
    expect(e.vorlage!.changes[1]!.schritte[0]!.pruefung).toMatchObject({ nichtEnthalten: 'alfred-pbs', erwartet: 'UPID:pve:0022BB1C' });
    // Thumbprint (Hex ohne Bindestriche) zählt als Hex-ID
    const t = change('aaaaaaaa-1', 'c1', [{ skill: 'pki_lab', aktion: 'lab_zertifikat_ausstellen', parameter: { zugang: 'lab' } }],
      { ergebnisse: [{ nr: 1, ok: true, daten: { thumbprint: 'D28A26DF743C1F200630618CE835DC80FBB98946' } }] });
    const u = change('cccccccc-3', 'c2', [{ art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'lab', befehl: 'x', erwartet: 'D28A26DF743C' } }], { abhaengigVon: ['aaaaaaaa-1'] });
    expect(findeVerweise([t, u]).verweise.map(v => [v.pfad, v.art])).toEqual([['pruefung.erwartet', 'praefix']]);
  });
});

describe('Teilvorkommen ausdrücklich entscheiden', () => {
  const tv = (c: Kandidat, token: string) => {
    const t = c.teilvorkommen.filter(x => x.token === token);
    expect(t.length, `Teilvorkommen ${token}`).toBeGreaterThan(0);
    return t;
  };

  it('echte Fälle mit stabiler id und umgebendem Wort, nie in Titeln', () => {
    const k = findeKandidaten(quellen());
    const v157 = kand(k, 'vmid', 157);
    const conf = tv(v157, '/etc/pve/qemu-server/157.conf');
    expect(conf.map(t => t.id)).toContain(`${AUFBAU}:1:pruefung.befehl:vmid|157#0`);
    expect(tv(v157, 'vm-157-').map(t => t.id)).toContain(`${ABBAU}:8:pruefung.nichtEnthalten:vmid|157#0`);
    expect(v157.teilvorkommen.some(t => t.pfad === 'titel')).toBe(false);
    expect(new Set(v157.teilvorkommen.map(t => t.id)).size).toBe(v157.teilvorkommen.length);
    const srv = kand(k, 'name', 'labsrv01');
    expect(tv(srv, 'labsrv01.pkilab.test').length).toBeGreaterThan(0);
    // I8c: VLAN 829 in der Bridge vmbr829
    const i8c = change('b0e35618-x', 'c1', [
      { skill: 'unifi', aktion: 'create_network', parameter: { network_name: 'AD-Identity', vlan: 829, subnet: '10.203.29.0/27', dhcp: false } },
      { skill: 'proxmox', aktion: 'create_vlan_bridge', parameter: { node: 'pve1', vlan: 829, ueber: 'vmbr0', bridge: 'vmbr829' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_networks', parameter: { node: 'pve1' }, erwartet: 'vmbr829' } },
    ]);
    const vlan = kand(findeKandidaten([i8c]), 'vlan', 829);
    expect(vlan.teilvorkommen.map(t => [t.id, t.token])).toEqual([['b0e35618-x:2:parameter.bridge:vlan|829#0', 'vmbr829'], ['b0e35618-x:2:pruefung.erwartet:vlan|829#0', 'vmbr829']]);
  });

  it('fehlende Entscheidung → Fehler mit allen offenen Teilvorkommen, keine Vorlage', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const v157 = kand(k, 'vmid', 157);
    const r = baueEntwurf(q, { [v157.nr]: 'vmid_server' }, kopf);
    expect(r.vorlage).toBeUndefined();
    const f = r.fehler.join('\n');
    for (const t of v157.teilvorkommen) expect(f).toContain(t.id);
    expect(f).toContain('/etc/pve/qemu-server/157.conf');
    // unbekannte id und ungültige Entscheidung
    const alle = Object.fromEntries(v157.teilvorkommen.map(t => [t.id, 'fest' as const]));
    expect(baueEntwurf(q, { [v157.nr]: 'vmid_server' }, kopf, { ...alle, 'xxxxxxxx:1:pruefung.befehl:0': 'fest' }).fehler.join('\n')).toMatch(/gehört zu keinem gewählten Wert/);
    expect(baueEntwurf(q, { [v157.nr]: 'vmid_server' }, kopf, { ...alle, [v157.teilvorkommen[0]!.id]: 'vielleicht' as never }).fehler.join('\n')).toMatch(/„ersetzen“ oder „fest“/);
  });

  it('ersetzen → genau dieses Vorkommen wird Parameter; fest → Hinweis', async () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const v157 = kand(k, 'vmid', 157);
    const ids = v157.teilvorkommen.map(t => t.id);
    const confId = `${AUFBAU}:1:pruefung.befehl:vmid|157#0`;
    const vmId = `${ABBAU}:8:pruefung.nichtEnthalten:vmid|157#0`;
    const entscheid = Object.fromEntries(ids.map(id => [id, id === confId || id === vmId ? 'ersetzen' as const : 'fest' as const]));
    const { r } = mitFest(q, { [v157.nr]: 'vmid_server' }, entscheid);
    expect(r.fehler).toEqual([]);
    const v = r.vorlage!;
    const befehl = (v.changes[0]!.schritte[0]!.pruefung as Record<string, string>).befehl;
    expect(befehl).toBe('test ! -e /etc/pve/qemu-server/{{param.vmid_server}}.conf && test ! -e /etc/pve/lxc/157.conf && test ! -e /etc/pve/qemu-server/158.conf && test ! -e /etc/pve/lxc/158.conf && echo PKILAB_IDS_FREI');
    expect((v.changes[2]!.schritte[7]!.pruefung as Record<string, string>).nichtEnthalten).toBe('vm-{{param.vmid_server}}-');
    expect(r.hinweise).toContain(`bewusst fest: /etc/pve/lxc/157.conf in ${AUFBAU.slice(0, 8)} Schritt 1 pruefung.befehl`);
    expect(r.hinweise.filter(h => h.startsWith('bewusst fest:'))).toHaveLength(ids.length - 2);
    // V3-Regeln: vmid im Befehlsfeld erlaubt, Platzhalter auflösbar, Schema gültig
    expect(pruefeSchema(v).fehler).toEqual([]);
    expect((await pruefeVorlage(v, { probe: async () => [] })).fehler).toEqual([]);
  });

  it('Tresor-Teil bleibt abgelehnt, auch mit „ersetzen“', () => {
    const b = change('bbbbbbbb-2', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { skill: 'windows_ad', aktion: 'wald_anlegen', parameter: { zugang: 'dc01', domaene: 'ad.3033.at' } },
    ]);
    const c = change('cccccccc-3', 'c2', [
      { skill: 'windows_ad', aktion: 'dc_hinzufuegen', parameter: { zugang: 'dc02', domaene: 'ad.3033.at', konto_tresor: 'win-dc01-admin' } },
    ], { abhaengigVon: ['bbbbbbbb-2'] });
    const dc01 = kand(findeKandidaten([b, c]), 'name', 'dc01');
    const t = dc01.teilvorkommen.find(x => x.token === 'win-dc01-admin')!;
    expect(t.tresor).toBe('win-dc01-admin');
    const r = baueEntwurf([b, c], { [dc01.nr]: 'dc_name' }, kopf, { [t.id]: 'ersetzen' });
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toContain('dc01 steckt im Tresor-Namen win-dc01-admin');
  });

  it('Ersetzen darf keinen ungültigen Platzhalter bilden', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 300, hostname: 'srvneu', node: 'pve1' } },
      { art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'pve1', befehl: 'echo {300}', erwartet: '300' } },
    ]);
    const v = kand(findeKandidaten([a]), 'vmid', 300);
    const r = baueEntwurf([a], { [v.nr]: 'vmid_neu' }, kopf);
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toMatch(/ungültigen Platzhalter/);
  });

  it('gleiches Wort im selben Schritt braucht die gleiche Entscheidung (VM157_ABWESEND in befehl und erwartet)', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const v157 = kand(k, 'vmid', 157);
    const abw = v157.teilvorkommen.filter(t => t.token === 'VM157_ABWESEND');
    expect(abw.map(t => t.pfad).sort()).toEqual(['pruefung.befehl', 'pruefung.erwartet']);
    const basis = Object.fromEntries(v157.teilvorkommen.map(t => [t.id, 'fest' as const]));
    const r = baueEntwurf(q, { [v157.nr]: 'vmid_server' }, kopf, { ...basis, [abw[0]!.id]: 'ersetzen' });
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toContain(abw[0]!.id);
    expect(r.fehler.join('\n')).toContain(abw[1]!.id);
    expect(r.fehler.join('\n')).toMatch(/VM157_ABWESEND.*gleich entscheiden/);
    // beide gleich → ok, Prüftext passt weiter zum Befehl
    const { r: ok } = mitFest(q, { [v157.nr]: 'vmid_server' }, { ...basis, [abw[0]!.id]: 'ersetzen', [abw[1]!.id]: 'ersetzen' });
    expect(ok.fehler).toEqual([]);
    const s = ok.vorlage!.changes[2]!.schritte.find(x => JSON.stringify(x).includes('VM{{param.vmid_server}}_ABWESEND'))!;
    expect((s.pruefung as Record<string, string>).erwartet).toBe('VM{{param.vmid_server}}_ABWESEND');
  });

  it('ids tragen die volle Change-ID (gleicher 8-Zeichen-Anfang kollidiert nicht)', () => {
    const a = change('aaaaaaaa-1111', 'c1', [{ skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 300, hostname: 'srvneu', node: 'pve1' }, pruefung: { typ: 'befehl', zugang: 'pve1', befehl: 'ls vm-300-disk', erwartet: 'x' } }]);
    const b = change('aaaaaaaa-2222', 'c2', [{ skill: 'proxmox', aktion: 'start_vm', parameter: { vmid: 300, node: 'pve1' }, pruefung: { typ: 'befehl', zugang: 'pve1', befehl: 'ls vm-300-disk', erwartet: 'x' } }], { abhaengigVon: ['aaaaaaaa-1111'] });
    const v = kand(findeKandidaten([a, b]), 'vmid', 300);
    expect(v.teilvorkommen.map(t => t.id)).toEqual(['aaaaaaaa-1111:1:pruefung.befehl:vmid|300#0', 'aaaaaaaa-2222:1:pruefung.befehl:vmid|300#0']);
    const { r } = mitFest([a, b], { [v.nr]: 'vmid_neu' }, { 'aaaaaaaa-1111:1:pruefung.befehl:vmid|300#0': 'ersetzen', 'aaaaaaaa-2222:1:pruefung.befehl:vmid|300#0': 'fest' });
    expect(r.fehler).toEqual([]);
    expect((r.vorlage!.changes[0]!.schritte[0]!.pruefung as Record<string, string>).befehl).toBe('ls vm-{{param.vmid_neu}}-disk');
    expect((r.vorlage!.changes[1]!.schritte[0]!.pruefung as Record<string, string>).befehl).toBe('ls vm-300-disk');
  });

  it('VMID/VLAN nie unter Port-/Zähl-Schlüsseln (destination_port "152")', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { skill: 'unifi', aktion: 'create_firewall_policy', parameter: { policy_name: 'X', destination_port: '152', anzahl: '152,153' } },
    ]);
    const v = kand(findeKandidaten([a]), 'vmid', 152);
    expect(v.fundstellen.map(f => `${f.schritt}:${f.pfad}`)).toEqual(['1:parameter.new_vmid']);
    expect(v.teilvorkommen).toEqual([]);
  });
});

describe('baueEntwurf', () => {
  const auswahlPki = (k: Kandidat[]) => ({
    [kand(k, 'vmid', 157).nr]: 'vmid_server', [kand(k, 'vmid', 158).nr]: 'vmid_client', [kand(k, 'vlan', 832).nr]: 'vlan',
  });
  /** Alle Teilvorkommen der gewählten Kandidaten gleich entscheiden (Tresor-Teile bleiben ohnehin abgelehnt) */
  const entscheide = (k: Kandidat[], auswahl: Record<number, string>, e: 'ersetzen' | 'fest') => Object.fromEntries(
    k.filter(c => Object.keys(auswahl).map(Number).includes(c.nr)).flatMap(c => c.teilvorkommen.map(t => [t.id, e] as const)));

  it('PKI-Lab mit vmid_server/vmid_client/vlan: gültiges Schema, Verweise statt Policy-IDs, beispiel = Originalwert', async () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const { r } = mitFest(q, auswahlPki(k), entscheide(k, auswahlPki(k), 'fest'));
    expect(r.fehler).toEqual([]);
    const v = r.vorlage!;
    expect(pruefeSchema(v).fehler).toEqual([]);
    expect(v.changes.map(c => [c.schluessel, c.abhaengigVon])).toEqual([['c1', []], ['c2', ['c1']], ['c3', ['c1', 'c2']]]);
    const json = JSON.stringify(v);
    for (const id of ['e5d24ae1-c8b7-4582-afd3-20735646c44d', 'd2adc74e-33cd-44e8-b3f7-14cd87126441', '014f89d7-f2b6-4f8b-b7a5-1f7f6e3390e7']) expect(json).not.toContain(id);
    const abbau = v.changes[2]!.schritte;
    expect((abbau[12]!.parameter as Record<string, unknown>).policy_id).toBe('{{change:c1.schritt7.id}}');
    expect((abbau[27]!.parameter as Record<string, unknown>).network_id).toBe('{{change:c1.schritt5.id}}');
    expect(v.parameter.map(p => [p.name, p.typ, p.pflicht, p.beispiel])).toEqual([['vlan', 'vlan', true, 832], ['vmid_server', 'vmid', true, 157], ['vmid_client', 'vmid', true, 158]]);
    // Reihenfolge der Parameter = Reihenfolge der Kandidaten (erstes Vorkommen), nicht die der Auswahl
    for (const p of v.parameter) expect(p.beschreibung).toMatch(/^abgeleitet aus [0-9a-f]{8} /);
    const aufbau = v.changes[0]!.schritte;
    expect(aufbau[14]!.parameter).toMatchObject({ new_vmid: '{{param.vmid_server}}', vlan_tag: '{{param.vlan}}', hostname: 'labsrv01' });
    expect(aufbau[13]!.parameter).toMatchObject({ add_vmids: ['{{param.vmid_server}}', '{{param.vmid_client}}'] });
    expect((aufbau[13]!.pruefung as Record<string, unknown>).erwartet).toBe('{{param.vmid_server}},{{param.vmid_client}}');
    // Laufzeitfelder weg; zeitlimitS nur, wenn vom Standard abweichend
    expect(aufbau[0]).not.toHaveProperty('nr');
    expect(aufbau[2]).not.toHaveProperty('einordnung');
    expect(aufbau[0]).not.toHaveProperty('zeitlimitS');
    expect(aufbau[14]!.zeitlimitS).toBe(3000);
    // zweck/ohneSicherungGrund übernommen
    expect(v.changes[2]!.zweck).toBe('stilllegung');
    expect(v.changes[0]!.ohneSicherungGrund).toMatch(/^Nur Neubau/);
    // volle V3-Validierung (Platzhalter in der Hülle, keine Geheimniswerte) mit Fake-Probe
    const voll = await pruefeVorlage(v, { probe: async () => [] });
    expect(voll.fehler).toEqual([]);
    // Vorlage wird nicht aus Laufwerten befüllt: kein Thumbprint und keine UPID im Entwurf
    expect(json).not.toMatch(/D28A26DF743C|UPID:/);
  });

  it('echter Change-Validator offline (Metadaten der echten Skills): abgeleitetes Paket samt Eingangskontrolle ohne Fehler', async () => {
    const q = quellen();
    const { r } = mitFest(q, auswahlPki(findeKandidaten(q)), entscheide(findeKandidaten(q), auswahlPki(findeKandidaten(q)), 'ersetzen'));
    expect(r.fehler).toEqual([]);
    const skills: Record<string, unknown> = {
      proxmox: new ProxmoxSkill({ baseUrl: 'https://proxmox.invalid', tokenId: 't', tokenSecret: 's' } as never),
      unifi: new UniFiSkill({ baseUrl: 'https://unifi.invalid', apiKey: 'k' } as never),
      pki_lab: new PkiLabSkill({} as never), windows_cluster: new WindowsClusterSkill({} as never),
      windows_ad: new WindowsAdSkill({} as never), fernzugriff: new FernzugriffSkill({} as never),
    };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => skills[n] as never,
      assets: async () => [{ id: 'b4e48d79-2872-45aa-9a45-6843a2a85c0f', name: 'pve' }, { id: '3c4f9a1b-ce68-4bf0-95b1-3d9635d09c5e', name: 'UDMPRO' }, { id: '460657cf-7370-4cef-8a46-61b7a3560694', name: 'sql01' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    const voll = await pruefeVorlage(r.vorlage, { probe: p => pl.pruefeNur('o', p) });
    expect(voll.fehler).toEqual([]);
  });

  it('ungültiger oder doppelter Parametername, unbekannte Nummer → Fehler, keine Vorlage', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const n157 = kand(k, 'vmid', 157).nr; const n158 = kand(k, 'vmid', 158).nr;
    for (const auswahl of [{ [n157]: 'VMID-Server' }, { [n157]: 'vmid', [n158]: 'vmid' }, { 9999: 'x' }, { [n157]: 'admin_passwort' }]) {
      const r = baueEntwurf(q, auswahl as Record<number, string>, kopf);
      expect(r.vorlage, JSON.stringify(auswahl)).toBeUndefined();
      expect(r.fehler.length).toBeGreaterThan(0);
    }
    expect(baueEntwurf(q, { [n157]: 'vmid', [n158]: 'vmid' }, kopf).fehler.join('\n')).toMatch(/doppelt/);
  });

  it('Annahmen: vmid/vlan/netzname ergeben genau die pki_lab-Muster (ohne id/text)', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const netz = kand(k, 'name', 'PKI-Lab');
    const { r } = mitFest(q, { ...auswahlPki(k), [netz.nr]: 'netzname' }, entscheide(k, { ...auswahlPki(k), [netz.nr]: 'netzname' }, 'fest'));
    expect(r.fehler).toEqual([]);
    const pki = (eingebauteVorlage('pki_lab') as { annahmen: Array<{ id: string; pruefung: unknown }> }).annahmen.filter(a => a.id !== 'richtlinien_frei');
    const sortiert = (l: unknown[]) => l.map(x => JSON.stringify(x, Object.keys(x as object).sort())).sort();
    expect(sortiert(r.vorlage!.annahmen.map(a => a.pruefung))).toEqual(sortiert(pki.map(a => a.pruefung)));
    expect(r.vorlage!.annahmen.map(a => a.pruefung)).toEqual(expect.arrayContaining(pki.map(a => a.pruefung)));
    expect(r.vorlage!.annahmen.map(a => [a.id, a.text])).toEqual([
      ['netzname_frei', 'Netzname netzname ist in UniFi frei'], ['vlan_frei', 'VLAN vlan ist in UniFi keinem Netz zugeordnet'],
      ['vmid_server_frei', 'VMID vmid_server ist clusterweit frei'], ['vmid_client_frei', 'VMID vmid_client ist clusterweit frei'],
    ]);
  });

  it('nur benutztes VLAN (kein create_network in der Auswahl) → keine Annahme, sondern Hinweis; angelegte VMID schon', () => {
    const q = [change('aaaaaaaa-1', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 300, hostname: 'srvneu', node: 'pve1', vlan_tag: 832 } },
      { skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 9102, node: 'pve1', name: 'vorher' } },
    ])];
    const k = findeKandidaten(q);
    const { r } = mitFest(q, { [kand(k, 'vmid', 300).nr]: 'vmid_neu', [kand(k, 'vlan', 832).nr]: 'vlan', [kand(k, 'vmid', 9102).nr]: 'vmid_probe' });
    expect(r.fehler).toEqual([]);
    expect(r.vorlage!.annahmen.map(a => a.id)).toEqual(['vmid_neu_frei']);
    expect(r.hinweise).toEqual(expect.arrayContaining(['keine automatische Vorab-Kontrolle für vlan (vlan)', 'keine automatische Vorab-Kontrolle für vmid_probe (vmid)']));
  });

  it('gewählter Name steckt in einem Tresor-Namen → Fehler mit Erklärung, nichts entsteht', () => {
    const b = change('bbbbbbbb-2', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { skill: 'windows_ad', aktion: 'wald_anlegen', parameter: { zugang: 'dc01', domaene: 'ad.3033.at' } },
    ]);
    const c = change('cccccccc-3', 'c2', [
      { skill: 'windows_ad', aktion: 'dc_hinzufuegen', parameter: { zugang: 'dc02', domaene: 'ad.3033.at', konto_tresor: 'win-dc01-admin' } },
    ], { abhaengigVon: ['bbbbbbbb-2'] });
    const k = findeKandidaten([b, c]);
    const dc01 = kand(k, 'name', 'dc01');
    expect(dc01.teilvorkommen.map(f => f.pfad)).toContain('parameter.konto_tresor');
    const r = baueEntwurf([b, c], { [dc01.nr]: 'dc_name' }, kopf);
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toContain('dc01 steckt im Tresor-Namen win-dc01-admin — die Vorlage würde die Geheimnisse der Original-Instanz wiederverwenden; Wert fest lassen oder Vorlage von Hand anpassen');
    // auch in einem {{geheim:…}}-Verweis
    const d = change('dddddddd-4', 'c2', [
      { skill: 'windows_ad', aktion: 'wald_anlegen', parameter: { zugang: 'dc01', dsrm: '{{geheim:ad-3033-dsrm-dc01}}' } },
    ], { abhaengigVon: ['bbbbbbbb-2'] });
    const r2 = baueEntwurf([b, d], { [kand(findeKandidaten([b, d]), 'name', 'dc01').nr]: 'dc_name' }, kopf);
    expect(r2.vorlage).toBeUndefined();
    expect(r2.fehler.join('\n')).toContain('dc01 steckt im Tresor-Namen ad-3033-dsrm-dc01');
    // ein nicht gewählter Wert stört nicht
    expect(mitFest([b, c], { [kand(k, 'vmid', 152).nr]: 'vmid' }).r.fehler).toEqual([]);
  });

  it('betroffen: Asset, das das Paket selbst anlegt, fällt weg; leerer Change → Fehler mit Nennung', () => {
    const namen = { 'asset-pve1': 'pve1', 'asset-dc01': 'DC01' };
    const b = change('bbbbbbbb-2', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { skill: 'windows_ad', aktion: 'grundstruktur', parameter: { zugang: 'dc01' } },
    ], { betroffen: ['asset-pve1', 'asset-dc01'], betroffenNamen: namen });
    const k = findeKandidaten([b]);
    const { r } = mitFest([b], { [kand(k, 'name', 'dc01').nr]: 'dc_name' });
    expect(r.fehler).toEqual([]);
    expect(r.vorlage!.changes[0]!.betroffen).toEqual(['asset-pve1']);
    expect(r.hinweise.some(h => h.includes('asset-dc01') && h.includes('DC01'))).toBe(true);
    // ohne pve1 bleibt der Change ohne betroffen
    const nurDc = change('bbbbbbbb-2', 'c1', b.plan.schritte as Array<Record<string, unknown>>, { betroffen: ['asset-dc01'], betroffenNamen: namen });
    const { r: r2 } = mitFest([nurDc], { [kand(findeKandidaten([nurDc]), 'name', 'dc01').nr]: 'dc_name' });
    expect(r2.vorlage).toBeUndefined();
    expect(r2.fehler.join('\n')).toMatch(/bbbbbbbb.*betroffen/);
  });

  it('Vorgänger außerhalb der Auswahl → Fehler mit ID', () => {
    const r = baueEntwurf(quellen().filter(q => q.id !== AUFBAU), {}, kopf);
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toContain(AUFBAU);
    expect(TEST).toBeTruthy();
  });
});

// ── V4 Final-Welle: einheitliches Entscheidungsmodell, nichts bleibt still auf die Original-Instanz gerichtet ──
describe('Final-Welle — Entscheidungen', () => {
  const I8C = (): QuellChange[] => JSON.parse(JSON.stringify(I8C_QUELLEN)) as QuellChange[];
  const [, IB, IC] = I8C_QUELLEN.map(q => q.id) as [string, string, string, string];
  const s1Befehl = (v: { changes: Array<{ schritte: Array<Record<string, unknown>> }> }) => (v.changes[0]!.schritte[0]!.pruefung as Record<string, string>).befehl;

  it('C1: Teilvorkommen-ids tragen Typ und Wert — node/vmid/Präfix in 2cfde1a2 Schritt 1 einzeln entscheidbar, Ergebnis exakt wie entschieden', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const node = kand(k, 'node', 'pve'); const v157 = kand(k, 'vmid', 157); const v158 = kand(k, 'vmid', 158); const pre = kand(k, 'name', 'PKILAB');
    const auswahl = { [node.nr]: 'node', [v157.nr]: 'vmid_server', [v158.nr]: 'vmid_client', [pre.nr]: 'richtlinien_praefix' };
    const s1 = [node, v157, v158, pre].flatMap(c => c.teilvorkommen.filter(t => t.change === AUFBAU && t.schritt === 1 && t.pfad === 'pruefung.befehl'));
    // 4× pve (/etc/pve/…), je 2× 157 und 158, 1× PKILAB — alle ids verschieden
    expect(s1.map(t => t.id)).toEqual(expect.arrayContaining([
      `${AUFBAU}:1:pruefung.befehl:node|pve#0`, `${AUFBAU}:1:pruefung.befehl:node|pve#3`, `${AUFBAU}:1:pruefung.befehl:vmid|157#1`,
      `${AUFBAU}:1:pruefung.befehl:vmid|158#0`, `${AUFBAU}:1:pruefung.befehl:name|PKILAB#0`,
    ]));
    expect(new Set(s1.map(t => t.id)).size).toBe(s1.length);
    expect(s1).toHaveLength(9);
    // pve überall fest, nur das zweite /etc/pve (lxc von 157) ersetzen; 157 ersetzen, 158 fest, PKILAB ersetzen
    const basis: Entscheid = {};
    for (const t of s1) basis[t.id] = t.id.includes(':vmid|158#') ? 'fest' : t.id.includes(':node|pve#') ? (t.id.endsWith('#1') ? 'ersetzen' : 'fest') : 'ersetzen';
    // gleiches Wort im selben Schritt gleich entscheiden: PKILAB_IDS_FREI steht auch in erwartet
    for (const t of pre.teilvorkommen) basis[t.id] ??= 'ersetzen';
    const { r } = mitFest(q, auswahl, basis);
    expect(r.fehler).toEqual([]);
    expect(s1Befehl(r.vorlage!)).toBe('test ! -e /etc/pve/qemu-server/{{param.vmid_server}}.conf && test ! -e /etc/{{param.node}}/lxc/{{param.vmid_server}}.conf'
      + ' && test ! -e /etc/pve/qemu-server/158.conf && test ! -e /etc/pve/lxc/158.conf && echo {{param.richtlinien_praefix}}_IDS_FREI');
  });

  it('I1: feste ID der Original-Instanz (nicht auflösbar) braucht ausdrücklich „fest“ — auch eine UUID ohne Quelle im Text', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const fremd = 'abcdef01-2222-3333-4444-555555555555';
    const c = change('cccccccc-3', 'c1', [
      { skill: 'unifi', aktion: 'delete_firewall_policy', parameter: { policy_id: uuid } },
      { art: 'pruefung', pruefung: { typ: 'befehl', zugang: 'pve1', befehl: `grep ${fremd} /etc/x`, erwartet: 'ok' } },
    ]);
    const ohne = baueEntwurf([c], {}, kopf);
    expect(ohne.vorlage).toBeUndefined();
    const ids = ohne.offen.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining([`cccccccc-3:1:parameter.policy_id:id|${uuid}`, `cccccccc-3:2:pruefung.befehl:id|${fremd}`]));
    expect(ohne.fehler.join('\n')).toMatch(/Feste IDs.*nur „fest“/);
    expect(ohne.offen.every(p => p.art === 'id' && p.nurFest)).toBe(true);
    // „ersetzen“ gibt es für feste IDs nicht
    const falsch = baueEntwurf([c], {}, kopf, Object.fromEntries(ids.map(id => [id, 'ersetzen' as const])));
    expect(falsch.fehler.join('\n')).toMatch(/nur „fest“ möglich/);
    const ok = baueEntwurf([c], {}, kopf, Object.fromEntries(ids.map(id => [id, 'fest' as const])));
    expect(ok.fehler).toEqual([]);
    expect(ok.fest.map(f => [f.art, f.wort, f.pfad])).toEqual(expect.arrayContaining([['id', uuid, 'parameter.policy_id'], ['id', fremd, 'pruefung.befehl']]));
    expect(ok.hinweise.some(h => h.startsWith('bewusst fest (feste ID)') && h.includes(uuid))).toBe(true);
  });

  it('I4/M-c (echtes I8c): VMIDs, VLAN, Netz und IPs gewählt, Namen nicht → Fehler nennt angelegte Werte samt Zielen; alle „fest“ → Entwurf mit IP-Ableitungen', async () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const auswahl = {
      [kand(k, 'vmid', 152).nr]: 'vmid_dc1', [kand(k, 'vmid', 153).nr]: 'vmid_dc2', [kand(k, 'vlan', 829).nr]: 'vlan',
      [kand(k, 'cidr', '10.203.29.0/27').nr]: 'netz', [kand(k, 'ipv4', '10.203.29.1').nr]: 'gateway', [kand(k, 'ipv4', '10.203.29.2').nr]: 'ip_dc1',
      [kand(k, 'ipv4', '10.203.29.3').nr]: 'ip_dc2', [kand(k, 'ipv4', '10.203.29.30').nr]: 'ip_test',
    };
    // vmbr829 ersetzen, 10.203.29.3 in 10.203.29.30 fest (die .30 hat ihren eigenen Parameter)
    const teil: Entscheid = {};
    for (const t of kand(k, 'vlan', 829).teilvorkommen) teil[t.id] = 'ersetzen';
    for (const t of kand(k, 'ipv4', '10.203.29.3').teilvorkommen) teil[t.id] = 'fest';
    const ohne = baueEntwurf(q, auswahl, kopf, teil);
    expect(ohne.vorlage).toBeUndefined();
    const f = ohne.fehler.join('\n');
    expect(f).toMatch(/Vom Paket angelegt/);
    // zugang dc01 in C Schritt 6 (dns_client) würde den Original-dc01 umkonfigurieren
    expect(f).toContain('anlage:name|dc01');
    expect(f).toContain(`${IC.slice(0, 8)} Schritt 6 parameter.zugang (windows_ad.dns_client)`);
    // DNS-FORWARD der Produktivdomäne, Netz/Zone und Policy-Namen
    expect(f).toContain('anlage:name|ad.3033.at');
    expect(f).toContain(`${IB.slice(0, 8)} Schritt 7 parameter.hostname (unifi.create_dns_record)`);
    expect(f).toContain('anlage:name|AD-Identity');
    for (const p of ['I8c-Probe-DC-TCP', 'I8c-Block-Gateway', 'I8c-DC-Gateway-DNS-Antwort']) expect(f).toContain(`anlage:name|${p}`);
    expect(ohne.offen.filter(p => p.art === 'anlage').map(p => p.wert)).toEqual(expect.arrayContaining(['dc01', 'dc02', 'ad.3033.at', 'AD-Identity']));
    // record_type FORWARD ist eine Art, kein angelegter Name
    expect(ohne.offen.some(p => p.wert === 'FORWARD')).toBe(false);
    // Gewählte Werte sind keine offenen Punkte
    expect(ohne.offen.some(p => p.id === 'anlage:vmid|152' || p.id === 'anlage:vlan|829')).toBe(false);
    // „ersetzen“ ist für angelegte Werte keine Option (dafür als Parameter wählen)
    const ersetzen = baueEntwurf(q, auswahl, kopf, { ...teil, 'anlage:name|dc01': 'ersetzen' });
    expect(ersetzen.fehler.join('\n')).toMatch(/anlage:name\|dc01.*nur „fest“ — oder den Wert als Parameter wählen/);

    const { r, e } = mitFest(q, auswahl, teil);
    expect(r.fehler).toEqual([]);
    expect(e['anlage:name|dc01']).toBe('fest');
    const v = r.vorlage!;
    // M-c: IPs im gewählten Netz werden Ableitungen, Präfix hinter einer ersetzten IP wird praefix(netz)
    const p = (n: string) => v.parameter.find(x => x.name === n)!;
    expect(p('gateway').ableitung).toEqual({ funktion: 'erste_adresse', von: 'netz' });
    expect(p('ip_dc1').ableitung).toEqual({ funktion: 'adresse', von: 'netz', n: 2 });
    expect(p('ip_test').ableitung).toEqual({ funktion: 'adresse', von: 'netz', n: 30 });
    expect(p('netz_praefix')).toMatchObject({ typ: 'zahl', ableitung: { funktion: 'praefix', von: 'netz' } });
    const dc01 = v.changes[1]!.schritte[1]!.parameter as Record<string, unknown>;
    expect(dc01).toMatchObject({ new_vmid: '{{param.vmid_dc1}}', ip: '{{param.ip_dc1}}/{{param.netz_praefix}}', gateway: '{{param.gateway}}', bridge: 'vmbr{{param.vlan}}', hostname: 'dc01' });
    // kein Rest des Original-Netzes außerhalb von Titeln
    const ohneTitel = JSON.stringify(v.changes.map(c => c.schritte.map(({ titel: _t, ...s }) => s)));
    expect(ohneTitel).not.toMatch(/10\.203\.29\./);
    // feste Stellen stehen strukturiert bereit (für die Freigabe-Frage)
    expect(r.fest.some(x => x.id === 'anlage:name|dc01' && x.change8 === IC.slice(0, 8) && x.schritt === 6 && x.pfad === 'parameter.zugang')).toBe(true);
    expect(r.hinweise.some(h => h.startsWith('bewusst fest (vom Paket angelegt): dc01'))).toBe(true);
    expect((await pruefeVorlage(v, { probe: async () => [] })).fehler).toEqual([]);
  });

  it('M-c: Adresse im gewählten Netz, die nur mit Präfix vorkommt (10.0.5.7/24), braucht trotzdem eine Entscheidung', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      { skill: 'unifi', aktion: 'create_network', parameter: { network_name: 'Netz-X', vlan: 50, subnet: '10.0.5.0/24' } },
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 300, hostname: 'srvx', node: 'pve1', ip: '10.0.5.7/24' } },
    ]);
    const k = findeKandidaten([a]);
    const auswahl = { [kand(k, 'cidr', '10.0.5.0/24').nr]: 'netz', [kand(k, 'name', 'Netz-X').nr]: 'netzname', [kand(k, 'vlan', 50).nr]: 'vlan', [kand(k, 'vmid', 300).nr]: 'vmid', [kand(k, 'name', 'srvx').nr]: 'host' };
    const r = baueEntwurf([a], auswahl, kopf);
    expect(r.offen.map(p => p.id)).toEqual(['anlage:ipv4|10.0.5.7']);
    // die Netzadresse selbst (10.0.5.0/24) ist kein Entscheidungspunkt
    expect(findeEntscheidungen([a]).some(p => p.id === 'anlage:ipv4|10.0.5.0')).toBe(false);
  });

  it('I4: angelegter Name auch mit nur einer Fundstelle ist Kandidat (wählbar statt nur fest)', () => {
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_firewall_policy', parameter: { policy_name: 'Einzel-Regel', policy_action: 'BLOCK' } }]);
    const k = findeKandidaten([a]);
    const c = kand(k, 'name', 'Einzel-Regel');
    expect(mitFest([a], { [c.nr]: 'regel' }).r.fehler).toEqual([]);
    expect(baueEntwurf([a], {}, kopf).offen.map(p => p.id)).toEqual(['anlage:name|Einzel-Regel']);
  });

  it('M-a: überlappende Werte (10.203.29.3 in 10.203.29.30) — Meldung nennt den Ausweg „fest“', () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const d3 = kand(k, 'ipv4', '10.203.29.3');
    const auswahl = { [d3.nr]: 'ip_dc2', [kand(k, 'ipv4', '10.203.29.30').nr]: 'ip_test' };
    const { r } = mitFest(q, auswahl, Object.fromEntries(d3.teilvorkommen.map(t => [t.id, 'ersetzen' as const])));
    expect(r.vorlage).toBeUndefined();
    expect(r.fehler.join('\n')).toMatch(/überlappen.*Stelle auf „fest“ setzen.*10\.203\.29\.3 in 10\.203\.29\.30/);
  });

  it('M-b: gleicher Wert in zwei Kandidaten (zugang pve, node pve) auf denselben Parameter — strengerer Typ gewinnt', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const name = kand(k, 'name', 'pve'); const node = kand(k, 'node', 'pve');
    const { r } = mitFest(q, { [name.nr]: 'node', [node.nr]: 'node' });
    expect(r.fehler).toEqual([]);
    expect(r.vorlage!.parameter.filter(p => p.name === 'node').map(p => p.typ)).toEqual(['node']);
    expect((r.vorlage!.changes[0]!.schritte[0]!.pruefung as Record<string, unknown>).zugang).toBe('{{param.node}}');
    expect((r.vorlage!.changes[0]!.schritte[14]!.parameter as Record<string, unknown>).node).toBe('{{param.node}}');
    // verschiedene Werte auf einem Namen bleiben ein Fehler
    expect(baueEntwurf(q, { [name.nr]: 'x', [kand(k, 'vmid', 157).nr]: 'x' }, kopf).fehler.join('\n')).toMatch(/doppelt/);
    // gleiche Stelle, widersprüchlich entschieden → Fehler
    const n0 = name.teilvorkommen.find(t => t.change === AUFBAU && t.schritt === 1)!;
    const d0 = node.teilvorkommen.find(t => t.change === AUFBAU && t.schritt === 1 && t.id.endsWith(n0.id.slice(n0.id.lastIndexOf('#'))))!;
    const w = mitFest(q, { [name.nr]: 'node', [node.nr]: 'node' }, { [n0.id]: 'fest', [d0.id]: 'ersetzen' }).r;
    expect(w.fehler.join('\n')).toMatch(/gleiche Stelle.*gleich entscheiden/);
  });

  it('M-e: Teilvorkommen in Titeln werden ohne Entscheidung ersetzt (Titel haben keine Wirkung)', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const { r } = mitFest(q, { [kand(k, 'vmid', 157).nr]: 'vmid_server', [kand(k, 'vmid', 158).nr]: 'vmid_client', [kand(k, 'vlan', 832).nr]: 'vlan' });
    expect(r.fehler).toEqual([]);
    expect(r.vorlage!.changes[0]!.schritte[0]!.titel).toBe('Eingang VMIDs{{param.vmid_server}}/{{param.vmid_client}} frei');
    expect(r.vorlage!.changes[0]!.titel).toBe('PKI Etappe5 Pos25 A – isoliertes TLS-Lab VLAN{{param.vlan}} und Offline-SQL-Medien');
    // keine Titel-Teile unter den Entscheidungspunkten
    expect(findeEntscheidungen(q).some(p => p.orte.some(o => o.pfad === 'titel'))).toBe(false);
  });

  it('I3: auswahl mit {name, wert} vergleicht den Wert; Stand hängt an Changes, Kandidaten und Entscheidungspunkten', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const vlan = kand(k, 'vlan', 832);
    expect(baueEntwurf(q, { [vlan.nr]: { name: 'vlan', wert: 833 } } as never, kopf).fehler.join('\n')).toMatch(/Kandidat \d+ hat den Wert 832, nicht 833 — Vorschlag neu holen/);
    expect(mitFest(q, { [vlan.nr]: { name: 'vlan', wert: '832' } }).r.fehler).toEqual([]);
    const s = standVon(q);
    expect(s).toMatch(/^[0-9a-f]{12}$/);
    expect(standVon(quellen())).toBe(s);
    // andere Reihenfolge = andere Nummern → anderer Stand (der Dienst ordnet topologisch, darum stabil)
    expect(standVon([...q].reverse())).not.toBe(s);
    const anders = quellen();
    (anders[0]!.plan.schritte as Array<Record<string, Record<string, unknown>>>)[4]!.parameter!.vlan = 833;
    expect(standVon(anders)).not.toBe(s);
  });

  it('PKI: alles ersetzen, zugang/node pve auf denselben Parameter → Schritt 1 genau wie entschieden; Entwurf besteht den echten Validator offline', async () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const w = (typ: string, wert: string | number) => kand(k, typ, wert).nr;
    const auswahl = {
      [w('name', 'PKI-Lab')]: 'netzname', [w('vlan', 832)]: 'vlan', [w('cidr', '10.203.32.0/28')]: 'netz', [w('vmid', 157)]: 'vmid_server', [w('vmid', 158)]: 'vmid_client',
      [w('name', 'labsrv01')]: 'name_server', [w('name', 'labcli01')]: 'name_client', [w('name', 'pve')]: 'node', [w('node', 'pve')]: 'node',
      [w('storage', 'data2-pve')]: 'storage', [w('ipv4', '10.203.32.1')]: 'gateway', [w('ipv4', '10.203.32.2')]: 'ip_server', [w('ipv4', '10.203.32.3')]: 'ip_client',
      [w('name', 'PKILAB')]: 'richtlinien_praefix',
    };
    const teil: Entscheid = {};
    // alles ersetzen — außer pve als Teil von data2-pve (Speicher, eigener Parameter) und pvesm (Befehlsname): dort fest
    for (const nr of Object.keys(auswahl)) for (const t of k.find(c => c.nr === Number(nr))!.teilvorkommen)
      if (!t.tresor) teil[t.id] = /|pve#/.test(t.id) && /data2-pve|pvesm/.test(t.token) ? 'fest' : 'ersetzen';
    const { r } = mitFest(q, auswahl, teil);
    expect(r.fehler).toEqual([]);
    const v = r.vorlage!;
    expect(s1Befehl(v)).toBe('test ! -e /etc/{{param.node}}/qemu-server/{{param.vmid_server}}.conf && test ! -e /etc/{{param.node}}/lxc/{{param.vmid_server}}.conf'
      + ' && test ! -e /etc/{{param.node}}/qemu-server/{{param.vmid_client}}.conf && test ! -e /etc/{{param.node}}/lxc/{{param.vmid_client}}.conf && echo {{param.richtlinien_praefix}}_IDS_FREI');
    expect(v.parameter.filter(p => p.name === 'node')).toHaveLength(1);
    expect(v.parameter.find(p => p.name === 'ip_server')!.ableitung).toEqual({ funktion: 'adresse', von: 'netz', n: 2 });
    expect((v.changes[0]!.schritte[14]!.parameter as Record<string, unknown>).ip).toBe('{{param.ip_server}}/{{param.netz_praefix}}');
    const skills: Record<string, unknown> = {
      proxmox: new ProxmoxSkill({ baseUrl: 'https://proxmox.invalid', tokenId: 't', tokenSecret: 's' } as never),
      unifi: new UniFiSkill({ baseUrl: 'https://unifi.invalid', apiKey: 'k' } as never),
      pki_lab: new PkiLabSkill({} as never), windows_cluster: new WindowsClusterSkill({} as never),
      windows_ad: new WindowsAdSkill({} as never), fernzugriff: new FernzugriffSkill({} as never),
    };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => skills[n] as never,
      assets: async () => [{ id: 'b4e48d79-2872-45aa-9a45-6843a2a85c0f', name: 'pve' }, { id: '3c4f9a1b-ce68-4bf0-95b1-3d9635d09c5e', name: 'UDMPRO' }, { id: '460657cf-7370-4cef-8a46-61b7a3560694', name: 'sql01' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    const voll = await pruefeVorlage(v, { probe: p => pl.pruefeNur('o', p) });
    expect(voll.fehler).toEqual([]);
  });
});

// ── Restpunkte nach dem Re-Review: NetBIOS, veränderte vorhandene Objekte (d), Bridge, Tresor-Hinweis ──
describe('Restpunkte — NetBIOS, verändert vorhandene Objekte, Bridge', () => {
  const I8C = (): QuellChange[] => JSON.parse(JSON.stringify(I8C_QUELLEN)) as QuellChange[];
  /** Live-Beweis-Auswahl (VMIDs, VLAN, Netz, IPs); vmbr829 ersetzen, .3 in .30 fest */
  const live = (k: Kandidat[]) => {
    const auswahl: Record<number, string> = {
      [kand(k, 'vmid', 152).nr]: 'vmid_dc1', [kand(k, 'vmid', 153).nr]: 'vmid_dc2', [kand(k, 'vlan', 829).nr]: 'vlan',
      [kand(k, 'cidr', '10.203.29.0/27').nr]: 'netz', [kand(k, 'ipv4', '10.203.29.1').nr]: 'gateway', [kand(k, 'ipv4', '10.203.29.2').nr]: 'ip_dc1',
      [kand(k, 'ipv4', '10.203.29.3').nr]: 'ip_dc2', [kand(k, 'ipv4', '10.203.29.30').nr]: 'ip_test',
    };
    const teil: Entscheid = {};
    for (const t of kand(k, 'vlan', 829).teilvorkommen) teil[t.id] = 'ersetzen';
    for (const t of kand(k, 'ipv4', '10.203.29.3').teilvorkommen) teil[t.id] = 'fest';
    return { auswahl, teil };
  };

  it('NEU-1: Domäne als Parameter, NetBIOS AD3033 nicht → offene Entscheidung; „fest“ steht in der fest-Liste', () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const { auswahl, teil } = live(k);
    const dom = kand(k, 'name', 'ad.3033.at');
    auswahl[dom.nr] = 'domaene';
    for (const t of dom.teilvorkommen) teil[t.id] = 'ersetzen';
    const ohne = baueEntwurf(q, auswahl, kopf, teil);
    expect(ohne.offen.map(p => p.id)).toContain('anlage:name|AD3033');
    // als Parameter wählbar
    expect(kand(k, 'name', 'AD3033')).toBeDefined();
    const { r } = mitFest(q, auswahl, teil);
    expect(r.fehler).toEqual([]);
    expect(r.fest.filter(f => f.id === 'anlage:name|AD3033').map(f => `${f.change8} S${f.schritt} ${f.pfad}`)).toEqual(expect.arrayContaining([
      `${I8C_QUELLEN[1]!.id.slice(0, 8)} S3 parameter.netbios`, `${I8C_QUELLEN[2]!.id.slice(0, 8)} S4 parameter.netbios`, `${I8C_QUELLEN[3]!.id.slice(0, 8)} S6 parameter.netbios`,
    ]));
  });

  it('(d): vorhandene VM probe-win25b / 9102, die Change D verändert (Snapshot, RAM, Neustart, Beitritt) → ausdrücklich entscheiden; Knoten, Speicher, Backup-Job nicht', () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const { auswahl, teil } = live(k);
    const ohne = baueEntwurf(q, auswahl, kopf, teil);
    const ver = ohne.offen.filter(p => p.art === 'veraendert');
    expect(ver.map(p => p.id)).toEqual(expect.arrayContaining(['veraendert:name|probe-win25b', 'veraendert:vmid|9102']));
    expect(ohne.fehler.join('\n')).toMatch(/Verändert vorhandene Objekte.*veraendert:vmid\|9102.*proxmox\.set_vm_resources/);
    // Hosts der Aktion (node pve1/pve3/pve, storage, Backup-Job) sind keine veränderten Objekte
    const verWerte = findeEntscheidungen(q).filter(p => p.art === 'veraendert').map(p => p.wert);
    expect(verWerte).toEqual(expect.arrayContaining(['9102', 'probe-win25b']));
    for (const traeger of ['pve', 'pve1', 'pve3', 'data2-pve1', 'data2-pve3', 'alfred-pbs-taeglich', 'US XG 16']) expect(verWerte).not.toContain(traeger);
    // „ersetzen“ gibt es nicht
    expect(baueEntwurf(q, auswahl, kopf, { ...teil, 'veraendert:vmid|9102': 'ersetzen' }).fehler.join('\n')).toMatch(/veraendert:vmid\|9102.*nur „fest“ — oder den Wert als Parameter wählen/);
    const { r } = mitFest(q, auswahl, teil);
    expect(r.fehler).toEqual([]);
    expect(r.fest.some(f => f.art === 'veraendert' && f.wort === '9102' && f.pfad === 'parameter.vmid')).toBe(true);
    expect(r.hinweise.some(h => h.startsWith('bewusst fest (verändert vorhandenes Objekt): probe-win25b'))).toBe(true);
    // als Parameter gewählt → keine Entscheidung mehr nötig
    const mit = mitFest(q, { ...auswahl, [kand(k, 'vmid', 9102).nr]: 'vmid_probe', [kand(k, 'name', 'probe-win25b').nr]: 'probe' }, teil).r;
    expect(mit.fehler).toEqual([]);
    expect(mit.fest.some(f => f.art === 'veraendert' && (f.wort === '9102' || f.wort === 'probe-win25b'))).toBe(false);
  });

  it('Bridge von create_vlan_bridge ist angelegt (vmbr829 fest → Entscheidung); bridge in provision (vmbr0) nicht', () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const { auswahl, teil } = live(k);
    const fest: Entscheid = { ...teil };
    for (const t of kand(k, 'vlan', 829).teilvorkommen) fest[t.id] = 'fest';
    expect(baueEntwurf(q, auswahl, kopf, fest).offen.map(p => p.id)).toContain('anlage:name|vmbr829');
    expect(baueEntwurf(q, auswahl, kopf, teil).offen.map(p => p.id)).not.toContain('anlage:name|vmbr829');
    expect(findeEntscheidungen(q).some(p => p.id === 'anlage:name|vmbr0')).toBe(false);
  });

  it('Tresor-Vorkommen eines festen Werts stehen an seinem fest-Eintrag (dc01 → win-dc01-admin)', () => {
    const q = I8C();
    const { r } = mitFest(q, live(findeKandidaten(q)).auswahl, live(findeKandidaten(q)).teil);
    expect(r.fehler).toEqual([]);
    const dc01 = r.fest.filter(f => f.id === 'anlage:name|dc01');
    expect(dc01.length).toBeGreaterThan(0);
    expect(dc01.every(f => f.tresor?.includes('win-dc01-admin'))).toBe(true);
    expect(r.hinweise.find(h => h.startsWith('bewusst fest (vom Paket angelegt): dc01'))).toMatch(/Tresor-Namen win-dc01-admin/);
  });
});

// ── Sicherheitsbefund v1881: Entscheidungspflicht schließt fail-closed ──
describe('Sicherheitsbefund — (d) fail-closed', () => {
  it('HIGH: verändernder Schritt mit IP als zugang/hostname → ohne Entscheidung abgelehnt; „fest“ landet in der fest-Liste', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      { skill: 'windows_ad', aktion: 'beitreten', parameter: { zugang: '10.9.9.9', domaene: 'ad.beispiel.at' } },
      { skill: 'proxmox', aktion: 'set_vm_resources', parameter: { vmid: 777, node: 'pve1', hostname: '10.9.9.10' } },
    ]);
    const ohne = baueEntwurf([a], {}, kopf);
    expect(ohne.vorlage).toBeUndefined();
    expect(ohne.offen.map(p => p.id)).toEqual(expect.arrayContaining(['veraendert:ipv4|10.9.9.9', 'veraendert:ipv4|10.9.9.10']));
    const { r } = mitFest([a], {});
    expect(r.fehler).toEqual([]);
    expect(r.fest.some(f => f.art === 'veraendert' && f.wort === '10.9.9.9' && f.pfad === 'parameter.zugang')).toBe(true);
    expect(r.fest.some(f => f.art === 'veraendert' && f.wort === '10.9.9.10' && f.pfad === 'parameter.hostname')).toBe(true);
  });

  it('MEDIUM: jeder typisierte Wert in parameter.* (auch Listen/verschachtelt) und rueckweg.parameter.* einer verändernden Aktion braucht eine Entscheidung — außer Träger-Feldern und lesenden Aktionen', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      // Liste (dns) und verschachtelter Eintrag; Rückweg mit eigener Aktion
      { skill: 'windows_ad', aktion: 'dns_client', parameter: { dns: ['10.8.8.8'], eintraege: [{ ziel_zone: 'Zone-Alt' }] },
        rueckweg: { skill: 'windows_ad', aktion: 'dns_client', parameter: { zugang: 'srv-alt', dns: ['10.8.8.9'] } } },
      // unbekannte Aktion (kein skill) zählt als verändernd
      { art: 'aktion', parameter: { vm_name: 'vm-unbekannt' } },
      // Träger: node, storage, device, switch_port, job_id — keine Entscheidung
      { skill: 'proxmox', aktion: 'backup_job_exclude', parameter: { job_id: 'job-x', node: 'pve9', storage: 'data9', add_vmids: [] } },
      { skill: 'unifi', aktion: 'allow_network_on_port', parameter: { device: 'switch-9', switch_port: 3, network_name: 'Netz-Alt' } },
      // lesende Aktion — keine Entscheidung
      { skill: 'proxmox', aktion: 'list_vms', parameter: { vmid: 888, zugang: 'nur-lesen' } },
    ]);
    const ids = findeEntscheidungen([a]).filter(p => p.art === 'veraendert').map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      'veraendert:ipv4|10.8.8.8', 'veraendert:name|Zone-Alt', 'veraendert:name|srv-alt', 'veraendert:ipv4|10.8.8.9', 'veraendert:name|vm-unbekannt', 'veraendert:name|Netz-Alt',
    ]));
    for (const nicht of ['pve9', 'data9', 'job-x', 'switch-9', '888', 'nur-lesen']) expect(ids.some(id => id.endsWith(`|${nicht}`))).toBe(false);
    const r = baueEntwurf([a], {}, kopf);
    expect(r.vorlage).toBeUndefined();
    expect(r.offen.filter(p => p.art === 'veraendert').map(p => p.id).sort()).toEqual([...ids].sort());
    // als Parameter gewählt → keine Entscheidung mehr für diesen Wert
    const k = findeKandidaten([a]);
    expect(mitFest([a], { [kand(k, 'name', 'srv-alt').nr]: 'server' }).r.fest.some(f => f.wort === 'srv-alt')).toBe(false);
  });

  it('angelegtes Netz (subnet in create_network) ist angelegt, nicht verändert', () => {
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_network', parameter: { network_name: 'Netz-Neu', vlan: 60, subnet: '10.0.6.0/24' } }]);
    const p = findeEntscheidungen([a]);
    expect(p.some(x => x.id === 'anlage:cidr|10.0.6.0/24')).toBe(true);
    expect(p.some(x => x.art === 'veraendert')).toBe(false);
  });
});

// ── Wertlisten in einem Feld („192.168.1.92,192.168.1.223“) einzeln entscheiden ──
describe('Wertlisten in einem Feld', () => {
  const policy = () => change('aaaaaaaa-1', 'c1', [
    { skill: 'unifi', aktion: 'create_firewall_policy', parameter: {
      policy_name: 'Regel-Neu', policy_action: 'ALLOW', source_ip: '192.168.50.7,192.168.50.8', destination_ip: '10.1.1.0/24 10.1.2.0/24',
      destination_port: '53,88,135', notiz: 'Zugriff von 192.168.50.7 und Freunden',
    } },
    { skill: 'proxmox', aktion: 'backup_job_exclude', parameter: { job_id: 'job-x', exclude_vmids: '157;158' } },
  ]);

  it('jedes Element einer typisierten Liste ist Kandidat und eigener (d)-Punkt; Ports und Freitext bleiben ungeteilt', () => {
    const q = [policy()];
    const k = findeKandidaten(q);
    for (const [typ, w] of [['ipv4', '192.168.50.7'], ['ipv4', '192.168.50.8'], ['cidr', '10.1.1.0/24'], ['cidr', '10.1.2.0/24'], ['vmid', 157], ['vmid', 158]] as const) kand(k, typ, w);
    // Ports sind keine VMIDs/VLANs, Freitext wird nicht zerlegt
    expect(k.some(c => c.wert === 53 || c.wert === 88 || c.wert === 135)).toBe(false);
    const ids = findeEntscheidungen(q).filter(p => p.art === 'veraendert').map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining(['veraendert:ipv4|192.168.50.7', 'veraendert:ipv4|192.168.50.8', 'veraendert:cidr|10.1.1.0/24', 'veraendert:cidr|10.1.2.0/24', 'veraendert:vmid|157', 'veraendert:vmid|158']));
    expect(ids.some(id => /\|(53|88|135)$/.test(id))).toBe(false);
    const r = baueEntwurf(q, {}, kopf);
    expect(r.vorlage).toBeUndefined();
    expect(r.offen.map(p => p.id)).toEqual(expect.arrayContaining(['veraendert:ipv4|192.168.50.7', 'veraendert:cidr|10.1.2.0/24', 'veraendert:vmid|158']));
  });

  it('ein Element als Parameter gewählt → genau dort ersetzt, das andere braucht weiter seine Entscheidung', () => {
    const q = [policy()];
    const k = findeKandidaten(q);
    const auswahl = { [kand(k, 'ipv4', '192.168.50.7').nr]: 'quelle', [kand(k, 'vmid', 157).nr]: 'vmid_a' };
    const ohne = baueEntwurf(q, auswahl, kopf);
    expect(ohne.offen.map(p => p.id)).toContain('veraendert:ipv4|192.168.50.8');
    expect(ohne.offen.map(p => p.id)).not.toContain('veraendert:ipv4|192.168.50.7');
    const { r } = mitFest(q, auswahl);
    expect(r.fehler).toEqual([]);
    const p = r.vorlage!.changes[0]!.schritte[0]!.parameter as Record<string, string>;
    expect(p.source_ip).toBe('{{param.quelle}},192.168.50.8');
    expect(p.destination_port).toBe('53,88,135');
    expect(p.notiz).toBe('Zugriff von {{param.quelle}} und Freunden');
    expect((r.vorlage!.changes[0]!.schritte[1]!.parameter as Record<string, string>).exclude_vmids).toBe('{{param.vmid_a}};158');
    expect(r.fest.some(f => f.art === 'veraendert' && f.wort === '192.168.50.8' && f.pfad === 'parameter.source_ip')).toBe(true);
  });

  it('Liste in einem Anlage-Feld (subnet mit zwei Netzen) → je Element angelegt', () => {
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'unifi', aktion: 'create_network', parameter: { network_name: 'Netz-Zwei', vlan: 61, subnet: '10.0.7.0/24,10.0.8.0/24' } }]);
    const p = findeEntscheidungen([a]).map(x => x.id);
    expect(p).toEqual(expect.arrayContaining(['anlage:cidr|10.0.7.0/24', 'anlage:cidr|10.0.8.0/24']));
    expect(p.some(id => id.startsWith('veraendert:'))).toBe(false);
  });
});

describe('iso_ablegen legt eine Datei an', () => {
  it('PKI: dateiname aus fernzugriff.iso_ablegen ist angelegt (c), nicht verändert (d); Standard-Zonen bleiben Entscheidungspunkte', () => {
    const p = findeEntscheidungen(quellen());
    const iso = 'SQLServer2025-x64-ENU-EntDev.iso';
    expect(p.find(x => x.id === `anlage:name|${iso}`)?.grund).toMatch(/fernzugriff\.iso_ablegen/);
    expect(p.some(x => x.id === `veraendert:name|${iso}`)).toBe(false);
    for (const z of ['Internal', 'External', 'Gateway']) expect(p.some(x => x.id === `veraendert:name|${z}`)).toBe(true);
  });
});

// ── Tresor-Einträge ausdrücklich entscheiden (konto_tresor, {{geheim:…}}) ──
describe('Tresor-Einträge', () => {
  const basisAuswahl = (k: Kandidat[]) => ({ [kand(k, 'vmid', 157).nr]: 'vmid_server', [kand(k, 'vmid', 158).nr]: 'vmid_client', [kand(k, 'vlan', 832).nr]: 'vlan' });

  it('PKI: konto_tresor pkilab-sql (8 Stellen) ist Entscheidungspunkt; „ersetzen“ gibt es nicht; „fest“ steht in der fest-Liste', () => {
    const q = quellen();
    const p = findeEntscheidungen(q).find(x => x.id === 'tresor:name|pkilab-sql')!;
    expect(p).toBeDefined();
    expect(p.art).toBe('tresor');
    expect(p.orte).toHaveLength(8);
    const k = findeKandidaten(q);
    const auswahl = basisAuswahl(k);
    const leer = baueEntwurf(q, auswahl, kopf);
    expect(leer.offen.map(x => x.id)).toContain('tresor:name|pkilab-sql');
    const { r, e } = mitFest(q, auswahl);
    expect(e['tresor:name|pkilab-sql']).toBe('fest');
    expect(r.fehler).toEqual([]);
    const fest = r.fest.filter(f => f.id === 'tresor:name|pkilab-sql');
    expect(fest).toHaveLength(8);
    expect(fest.every(f => f.art === 'tresor' && f.wort === 'pkilab-sql' && f.pfad === 'parameter.konto_tresor')).toBe(true);
    expect(r.hinweise.some(h => h.startsWith('bewusst fest (bestehender Tresor-Eintrag): pkilab-sql an 8 Stellen'))).toBe(true);
    expect(baueEntwurf(q, auswahl, kopf, { ...e, 'tresor:name|pkilab-sql': 'ersetzen' }).fehler.join('\n')).toMatch(/tresor:name\|pkilab-sql.*nur „fest“ — oder den Namen als Parameter wählen/);
  });

  it('PKI: pkilab-sql als Parameter (Name, nie Wert) → {{param.sql_konto}} an allen 8 Stellen, V3-Prüfung besteht; Geheimnis-artiger Parametername abgelehnt', async () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const konto = kand(k, 'name', 'pkilab-sql');
    const { r } = mitFest(q, { ...basisAuswahl(k), [konto.nr]: 'sql_konto' });
    expect(r.fehler).toEqual([]);
    const v = r.vorlage!;
    const stellen = JSON.stringify(v.changes).match(/"konto_tresor":"[^"]*"/g)!;
    expect(stellen).toHaveLength(8);
    expect(new Set(stellen)).toEqual(new Set(['"konto_tresor":"{{param.sql_konto}}"']));
    expect(v.parameter.find(p => p.name === 'sql_konto')).toMatchObject({ typ: 'name', beispiel: 'pkilab-sql' });
    expect(r.fest.some(f => f.art === 'tresor')).toBe(false);
    expect((await pruefeVorlage(v, { probe: async () => [] })).fehler).toEqual([]);
    expect(baueEntwurf(q, { ...basisAuswahl(k), [konto.nr]: 'sql_passwort' }, kopf).fehler.join('\n')).toMatch(/klingt nach einem Geheimnis/);
  });

  it('Name in {{geheim:…}} einer verändernden Aktion → nur „fest“ (kein Kandidat); enthält er einen gewählten Wert, bleibt die Ablehnung', () => {
    const a = change('aaaaaaaa-1', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dcx', node: 'pve1' } },
      { skill: 'windows_ad', aktion: 'wald_anlegen', parameter: { zugang: 'dcx', domaene: 'ad.x.at', dsrm: '{{geheim:ad-alt-dsrm}}' } },
    ]);
    const p = findeEntscheidungen([a]).find(x => x.id === 'tresor:name|ad-alt-dsrm')!;
    expect(p).toMatchObject({ art: 'tresor', nurFest: true });
    expect(findeKandidaten([a]).some(c => c.wert === 'ad-alt-dsrm')).toBe(false);
    expect(baueEntwurf([a], {}, kopf).offen.map(x => x.id)).toContain('tresor:name|ad-alt-dsrm');
    const { r } = mitFest([a], {});
    expect(r.fehler).toEqual([]);
    expect(r.fest.some(f => f.id === 'tresor:name|ad-alt-dsrm' && f.pfad === 'parameter.dsrm')).toBe(true);
    expect(baueEntwurf([a], {}, kopf, { 'tresor:name|ad-alt-dsrm': 'ersetzen' }).fehler.join('\n')).toMatch(/nur „fest“/);
    // I8c: win-dc01-admin ist Entscheidungspunkt; mit dc01 gewählt greift wie bisher die Tresor-Ablehnung
    const qi = JSON.parse(JSON.stringify(I8C_QUELLEN)) as QuellChange[];
    expect(findeEntscheidungen(qi).some(x => x.id === 'tresor:name|win-dc01-admin')).toBe(true);
    expect(baueEntwurf(qi, { [kand(findeKandidaten(qi), 'name', 'dc01').nr]: 'dc' }, kopf).fehler.join('\n')).toMatch(/dc01 steckt im Tresor-Namen win-dc01-admin/);
  });
});

// ── Sammel-Entscheidungen (teil:wert|…, anlage:*, veraendert:*, tresor:*, fest:*) ──
describe('Sammel-Entscheidungen', () => {
  const I8C = (): QuellChange[] => JSON.parse(JSON.stringify(I8C_QUELLEN)) as QuellChange[];
  /** Live-Auswahl laut Auftrag (Nummern der aktuellen Kandidatenliste) */
  const AUSWAHL = { 23: 'vmid_dc01', 28: 'vmid_dc02', 2: 'vlan', 3: 'netz', 8: 'ip_dc01', 9: 'ip_dc02', 26: 'gateway', 37: 'ip_probe' };
  const SAMMEL: Entscheid = { 'teil:wert|829': 'ersetzen', 'teil:wert|10.203.29.3': 'fest', 'fest:*': 'fest' };

  it('Nummern der Live-Auswahl zeigen auf die erwarteten Werte', () => {
    const k = findeKandidaten(I8C());
    expect([23, 28, 2, 3, 8, 9, 26, 37].map(n => String(k.find(c => c.nr === n)!.wert))).toEqual(['152', '153', '829', '10.203.29.0/27', '10.203.29.2', '10.203.29.3', '10.203.29.1', '10.203.29.30']);
  });

  it('I8c: teil:wert|829 ersetzen, teil:wert|10.203.29.3 fest, fest:* → Entwurf; fest-Einträge tragen die Gruppe; sammel nennt die Schlüssel', () => {
    const r = baueEntwurf(I8C(), AUSWAHL, kopf, SAMMEL);
    expect(r.fehler).toEqual([]);
    expect((r.vorlage!.changes[0]!.schritte[15]!.parameter as Record<string, unknown>).bridge).toBe('vmbr{{param.vlan}}');
    expect(r.fest.filter(f => f.id === 'anlage:name|dc01').every(f => f.gruppe === 'fest:*')).toBe(true);
    expect(r.fest.some(f => f.id === 'tresor:name|win-dc01-admin' && f.gruppe === 'fest:*')).toBe(true);
    expect(r.sammel.map(s => [s.schluessel, s.entscheidung])).toEqual(expect.arrayContaining([['teil:wert|829', 'ersetzen'], ['teil:wert|10.203.29.3', 'fest'], ['fest:*', 'fest']]));
    expect(r.sammel.find(s => s.schluessel === 'fest:*')!.anzahl).toBe(25);
  });

  it('eine einzelne id geht vor der Gruppe', () => {
    const q = I8C();
    const k = findeKandidaten(q);
    const b2 = kand(k, 'vlan', 829).teilvorkommen.find(t => t.change === I8C_QUELLEN[1]!.id && t.pfad === 'parameter.bridge')!;
    const r = baueEntwurf(q, AUSWAHL, kopf, { ...SAMMEL, [b2.id]: 'fest' });
    expect(r.fehler).toEqual([]);
    expect((r.vorlage!.changes[1]!.schritte[1]!.parameter as Record<string, unknown>).bridge).toBe('vmbr829');
    expect((r.vorlage!.changes[0]!.schritte[15]!.parameter as Record<string, unknown>).bridge).toBe('vmbr{{param.vlan}}');
    const e = r.fest.find(f => f.id === b2.id)!;
    expect(e.gruppe).toBeUndefined();
  });

  it('Fehler: Gruppe mit „ersetzen“ (außer teil:wert), ungenutzter Schlüssel, Wort-Konsistenz gilt auf aufgelösten Entscheidungen, Tresor-Sperre unberührt', () => {
    const q = I8C();
    expect(baueEntwurf(q, AUSWAHL, kopf, { ...SAMMEL, 'anlage:*': 'ersetzen' }).fehler.join('\n')).toMatch(/anlage:\*.*nur „fest“/);
    const a = change('aaaaaaaa-1', 'c1', [{ skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 300, hostname: 'srvneu', node: 'pve1' } }]);
    expect(baueEntwurf([a], {}, kopf, { 'fest:*': 'fest', 'tresor:*': 'fest' }).fehler.join('\n')).toMatch(/Sammel-Schlüssel tresor:\*: trifft keinen offenen Punkt/);
    expect(baueEntwurf([a], {}, kopf, { 'fest:*': 'fest', 'teil:wert|999': 'fest' }).fehler.join('\n')).toMatch(/Sammel-Schlüssel teil:wert\|999: trifft keinen offenen Punkt/);
    // gleiches Wort im selben Schritt: Gruppe ersetzen, eine Stelle einzeln fest → Konflikt
    const p = quellen();
    const v157 = kand(findeKandidaten(p), 'vmid', 157);
    const abw = v157.teilvorkommen.find(t => t.token === 'VM157_ABWESEND')!;
    expect(baueEntwurf(p, { [v157.nr]: 'vmid_server' }, kopf, { 'teil:wert|157': 'ersetzen', [abw.id]: 'fest', 'fest:*': 'fest' }).fehler.join('\n')).toMatch(/VM157_ABWESEND.*gleich entscheiden/);
    // Tresor-Sperre: dc01 gewählt → abgelehnt, egal welche Gruppe
    expect(baueEntwurf(q, { ...AUSWAHL, [kand(findeKandidaten(q), 'name', 'dc01').nr]: 'dc' }, kopf, SAMMEL).fehler.join('\n')).toMatch(/dc01 steckt im Tresor-Namen win-dc01-admin/);
  });

  it('kompakte Fehlermeldung: Sammel-Schlüssel stehen in den ersten 2 KB', () => {
    const r = baueEntwurf(I8C(), AUSWAHL, kopf, { 'teil:wert|829': 'ersetzen', 'teil:wert|10.203.29.3': 'fest' });
    expect(r.vorlage).toBeUndefined();
    const anfang = r.fehler.join('\n').slice(0, 2000);
    for (const s of ['anlage:* — 17 offen', 'veraendert:* — 7 offen', 'tresor:* — 1 offen', '"fest:*"']) expect(anfang).toContain(s);
  });
});
