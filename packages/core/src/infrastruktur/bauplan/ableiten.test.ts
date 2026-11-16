/**
 * V4 Task 1 — Bauplan ableiten (rein): Kandidaten, Verweise über Change-Grenzen, Entwurf mit Annahmen und Schutzregeln.
 * Quelle: die echten PKI-Lab-Changes (ableiten.fixture.ts) plus kleine I8c-artige Beispiele für Sonderfälle.
 */
import { describe, it, expect } from 'vitest';
import { baueEntwurf, findeKandidaten, findeVerweise, type Kandidat, type QuellChange } from './ableiten.js';
import { PKI_QUELLEN } from './ableiten.fixture.js';
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
    expect(r.hinweise.some(h => h.includes('e5d24ae1-c8b7-4582-afd3-20735646c44d') && /keinem gewählten Change/.test(h))).toBe(true);
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
    expect(r.hinweise.some(h => h.includes(uuid) && /mehrdeutig/.test(h))).toBe(true);
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
    const e = baueEntwurf([a, c], {}, kopf);
    expect(e.fehler).toEqual([]);
    expect((e.vorlage!.changes[1]!.schritte[0]!.pruefung as Record<string, unknown>).nichtEnthalten).toBe('Policy {{change:c1.schritt1.id}} aktiv');
    expect((e.vorlage!.changes[1]!.schritte[0]!.parameter as Record<string, unknown>).notiz).toBe('e5d24ae1');
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
    expect(conf.map(t => t.id)).toContain(`${AUFBAU.slice(0, 8)}:1:pruefung.befehl:0`);
    expect(tv(v157, 'vm-157-').map(t => t.id)).toContain(`${ABBAU.slice(0, 8)}:8:pruefung.nichtEnthalten:0`);
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
    expect(vlan.teilvorkommen.map(t => [t.id, t.token])).toEqual([['b0e35618:2:parameter.bridge:0', 'vmbr829'], ['b0e35618:2:pruefung.erwartet:0', 'vmbr829']]);
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
    const confId = `${AUFBAU.slice(0, 8)}:1:pruefung.befehl:0`;
    const vmId = `${ABBAU.slice(0, 8)}:8:pruefung.nichtEnthalten:0`;
    const entscheid = Object.fromEntries(ids.map(id => [id, id === confId || id === vmId ? 'ersetzen' as const : 'fest' as const]));
    const r = baueEntwurf(q, { [v157.nr]: 'vmid_server' }, kopf, entscheid);
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
    const r = baueEntwurf(q, auswahlPki(k), kopf, entscheide(k, auswahlPki(k), 'fest'));
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
    const r = baueEntwurf(q, auswahlPki(findeKandidaten(q)), kopf, entscheide(findeKandidaten(q), auswahlPki(findeKandidaten(q)), 'ersetzen'));
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
      const r = baueEntwurf(q, auswahl, kopf);
      expect(r.vorlage, JSON.stringify(auswahl)).toBeUndefined();
      expect(r.fehler.length).toBeGreaterThan(0);
    }
    expect(baueEntwurf(q, { [n157]: 'vmid', [n158]: 'vmid' }, kopf).fehler.join('\n')).toMatch(/doppelt/);
  });

  it('Annahmen: vmid/vlan/netzname ergeben genau die pki_lab-Muster (ohne id/text)', () => {
    const q = quellen();
    const k = findeKandidaten(q);
    const netz = kand(k, 'name', 'PKI-Lab');
    const r = baueEntwurf(q, { ...auswahlPki(k), [netz.nr]: 'netzname' }, kopf, entscheide(k, { ...auswahlPki(k), [netz.nr]: 'netzname' }, 'fest'));
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
    const r = baueEntwurf(q, { [kand(k, 'vmid', 300).nr]: 'vmid_neu', [kand(k, 'vlan', 832).nr]: 'vlan', [kand(k, 'vmid', 9102).nr]: 'vmid_probe' }, kopf);
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
    expect(baueEntwurf([b, c], { [kand(k, 'vmid', 152).nr]: 'vmid' }, kopf).fehler).toEqual([]);
  });

  it('betroffen: Asset, das das Paket selbst anlegt, fällt weg; leerer Change → Fehler mit Nennung', () => {
    const namen = { 'asset-pve1': 'pve1', 'asset-dc01': 'DC01' };
    const b = change('bbbbbbbb-2', 'c1', [
      { skill: 'proxmox', aktion: 'provision_windows_vm', parameter: { new_vmid: 152, hostname: 'dc01', node: 'pve1' } },
      { skill: 'windows_ad', aktion: 'grundstruktur', parameter: { zugang: 'dc01' } },
    ], { betroffen: ['asset-pve1', 'asset-dc01'], betroffenNamen: namen });
    const k = findeKandidaten([b]);
    const r = baueEntwurf([b], { [kand(k, 'name', 'dc01').nr]: 'dc_name' }, kopf);
    expect(r.fehler).toEqual([]);
    expect(r.vorlage!.changes[0]!.betroffen).toEqual(['asset-pve1']);
    expect(r.hinweise.some(h => h.includes('asset-dc01') && h.includes('DC01'))).toBe(true);
    // ohne pve1 bleibt der Change ohne betroffen
    const nurDc = change('bbbbbbbb-2', 'c1', b.plan.schritte as Array<Record<string, unknown>>, { betroffen: ['asset-dc01'], betroffenNamen: namen });
    const r2 = baueEntwurf([nurDc], { [kand(findeKandidaten([nurDc]), 'name', 'dc01').nr]: 'dc_name' }, kopf);
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
