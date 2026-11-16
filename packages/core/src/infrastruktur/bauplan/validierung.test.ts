import { describe, it, expect } from 'vitest';
import { pruefeChangePlan, type PruefKontext } from '../change-schritte.js';
import { ChangePlanung } from '../change-planung.js';
import { pruefeVorlage } from './validierung.js';
import { testVorlage } from './testvorlage.fixture.js';

type Roh = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ohneProbe = { probe: async () => [] as string[] };
async function pruefe(aendern: (r: Roh) => void = () => {}, ctx: { probe: (roh: unknown[]) => Promise<string[]> } = ohneProbe) {
  const r = testVorlage() as Roh; aendern(r); return pruefeVorlage(r, ctx);
}

describe('pruefeVorlage — Platzhalter', () => {
  it('gültige Vorlage ohne Fehler und Hinweise', async () => {
    const r = await pruefe();
    expect(r.fehler).toEqual([]);
    expect(r.hinweise).toEqual([]);
    expect(r.vorlage?.key).toBe('test_lab');
  });
  it('Schemafehler stoppen vor der Probe', async () => {
    let gerufen = false;
    const r = await pruefe(v => { v.key = 'X'; }, { probe: async () => { gerufen = true; return []; } });
    expect(r.fehler.length).toBeGreaterThan(0);
    expect(r.vorlage).toBeUndefined();
    expect(gerufen).toBe(false);
  });
  it('unbekannter Parameter', async () => {
    const r = await pruefe(v => { v.changes[0].schritte[0].parameter.x = '{{param.gibtsnicht}}'; });
    expect(r.fehler.join('\n')).toMatch(/gibtsnicht/);
  });
  it('{{schrittN}} nur auf frühere Schritte desselben Change', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.x = '{{schritt1.id}}'; })).fehler.join('\n')).toMatch(/schritt1/);
    expect((await pruefe(v => { v.changes[0].schritte[1].parameter.x = '{{schritt0.id}}'; })).fehler.join('\n')).toMatch(/schritt0/);
    expect((await pruefe(v => { v.changes[0].schritte[1].parameter.x = '{{schritt3.id}}'; })).fehler.join('\n')).toMatch(/schritt3/);
    expect((await pruefe(v => { v.changes[0].titel = 'X {{schritt1.id}}'; })).fehler.join('\n')).toMatch(/schritt1/);
  });
  it('{{change:…}} nur auf die transitive Abhängigkeits-Hülle', async () => {
    // a → b ohne Abhängigkeit
    const r = await pruefe(v => { v.changes[0].schritte[1].parameter.x = '{{change:abbau.schritt1.id}}'; });
    expect(r.fehler.join('\n')).toMatch(/change:abbau/);
    // transitiv: drei → abbau → aufbau
    const t = await pruefe(v => {
      v.changes.push({ schluessel: 'drei', titel: 'D', begruendung: 'b', typ: 'normal', risiko: 'low', abhaengigVon: ['abbau'],
        schritte: [{ nr: 1, titel: 's', art: 'aktion', skill: 'unifi', aktion: 'x', parameter: { id: '{{change:aufbau.schritt2.id}}' }, zeitlimitS: 60, beiFehler: 'anhalten' }] });
    });
    expect(t.fehler).toEqual([]);
    // Schrittnummer über die Länge des Ziel-Change
    const n = await pruefe(v => { v.changes[1].schritte[0].parameter.id = '{{change:aufbau.schritt3.id}}'; });
    expect(n.fehler.join('\n')).toMatch(/schritt3/);
  });
  it('{{change:…}} und {{schrittN}} nicht in Annahmen', async () => {
    const r = await pruefe(v => { v.annahmen[0].pruefung.parameter.x = '{{change:aufbau.schritt1.id}}'; });
    expect(r.fehler.join('\n')).toMatch(/Annahme/);
  });
  it('andere {{…}} sind Fehler, geheim/geheimdatei und Docker-Format erlaubt', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.x = '{{host_id}}'; })).fehler.join('\n')).toMatch(/host_id/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.x = '{{param.vlan}'; })).fehler).toEqual([]); // kein vollständiger Platzhalter → Sache des Change-Validators
    const ok = await pruefe(v => {
      v.changes[0].schritte[0].parameter.datei = '{{geheimdatei:lab-ca}}';
      v.changes[0].schritte[0].parameter.befehl = "docker ps --format '{{.Names}} {{json .State}}'";
    });
    expect(ok.fehler).toEqual([]);
  });
  it('text/liste-Parameter in Befehlsfeldern verboten', async () => {
    const r = await pruefe(v => {
      v.parameter.push({ name: 'befehl_text', typ: 'text', pflicht: false, beschreibung: 'x' });
      v.parameter.push({ name: 'hosts', typ: 'liste', pflicht: false, beschreibung: 'x' });
      v.changes[0].schritte[0].parameter.befehl = 'echo {{param.befehl_text}}';
      v.changes[0].schritte[1].pruefung = { typ: 'befehl', befehl: 'ping {{param.hosts}}' };
      v.changes[0].schritte[1].parameter.script = ['{{param.befehl_text}}'];
    });
    const f = r.fehler.join('\n');
    expect(f).toMatch(/befehl_text.*befehl/);
    expect(f).toMatch(/hosts/);
    expect(f).toMatch(/script/);
  });
  it('name-Parameter in Befehlsfeldern erlaubt', async () => {
    const r = await pruefe(v => { v.changes[0].schritte[0].parameter.befehl = 'hostname {{param.name_server}}'; });
    expect(r.fehler).toEqual([]);
  });
  it('unbenutzter Parameter → Hinweis, kein Fehler', async () => {
    const r = await pruefe(v => { v.parameter.push({ name: 'frei', typ: 'zahl', pflicht: false, beschreibung: 'x' }); });
    expect(r.fehler).toEqual([]);
    expect(r.hinweise.join('\n')).toMatch(/frei/);
  });
  it('Parameter nur als Ableitungsquelle gilt als benutzt', async () => {
    const r = await pruefe(v => { v.changes[0].schritte[0].parameter.netz = 'fest'; });
    expect(r.hinweise).toEqual([]);
  });
});

describe('pruefeVorlage — Geheimnisse', () => {
  it('Kennwort im Schritt-Parameter', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.password = 'geheim'; })).fehler.join('\n')).toMatch(/password/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.password = '{{geheim:pkilab-sql}}'; })).fehler).toEqual([]);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.password = 'x{{geheim:pkilab-sql}}'; })).fehler.join('\n')).toMatch(/password/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.api_key = '{{param.name_server}}'; })).fehler.join('\n')).toMatch(/api_key/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.token = 1234; })).fehler.join('\n')).toMatch(/token/);
  });
  it('verschachtelt und in Annahmen', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.zugang = { Kennwort: 'abc' }; })).fehler.join('\n')).toMatch(/Kennwort/);
    expect((await pruefe(v => { v.annahmen[0].pruefung.parameter.secret = 'abc'; })).fehler.join('\n')).toMatch(/secret/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.credentials = { password: '{{geheim:a-b}}' }; })).fehler).toEqual([]);
  });
  it('Kennwort im beispiel', async () => {
    const r = await pruefe(v => { v.parameter.push({ name: 'sql_passwort', typ: 'text', pflicht: false, beschreibung: 'x', beispiel: 'Geheim123' }); });
    expect(r.fehler.join('\n')).toMatch(/sql_passwort/);
    const o = await pruefe(v => { v.parameter[4].beispiel = { password: 'x' }; });
    expect(o.fehler.join('\n')).toMatch(/password/);
  });
  it('Wahrheitswert unter Geheimnis-Namen ist kein Geheimnis', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.passwordNeverExpires = false; })).fehler).toEqual([]);
  });
});

describe('pruefeVorlage — Probe', () => {
  it('Pflichtparameter ohne beispiel', async () => {
    const r = await pruefe(v => { delete v.parameter[0].beispiel; });
    expect(r.fehler.join('\n')).toMatch(/vlan.*beispiel/);
  });
  it('ungültiges beispiel', async () => {
    const r = await pruefe(v => { v.parameter[0].beispiel = 5000; });
    expect(r.fehler.join('\n')).toMatch(/vlan/);
  });
  it('Probe erhält eingesetzte Pläne ohne kapitel, change-Verweise unverändert (Task 3 Fix-Runde 1)', async () => {
    let plaene: unknown[] = [];
    const r = await pruefe(undefined, { probe: async p => { plaene = p; return []; } });
    expect(r.fehler).toEqual([]);
    expect(plaene).toHaveLength(3); // zwei Changes + Eingangskontrolle der Annahmen (Fix-Runde 1, I4)
    const [a, b] = plaene as Array<Record<string, any>>;
    expect(a.schluessel).toBe('aufbau');
    expect(a.titel).toBe('Aufbau VLAN 832');
    expect(a.typ).toBe('normal');
    expect(a.betroffen).toEqual([]);
    expect('kapitel' in a.schritte[0]).toBe(false);
    expect(a.schritte[0].parameter.vlan).toBe(832);
    expect(a.schritte[0].parameter.gateway).toBe('10.203.32.1');
    expect(a.schritte[1].parameter.netz_id).toBe('{{schritt1.id}}');
    expect(b.abhaengigVon).toEqual(['aufbau']);
    expect(b.schritte[0].parameter.id).toBe('{{change:aufbau.schritt1.id}}');
  });
  it('Probe-Fehler kommen mit Präfix', async () => {
    const r = await pruefe(undefined, { probe: async () => ['Schritt 1: Aktion unifi.create_network unbekannt'] });
    expect(r.fehler).toEqual(['Probe: Schritt 1: Aktion unifi.create_network unbekannt']);
    expect(r.vorlage).toBeUndefined();
  });
});

describe('Fix-Runde 1 — Validierung', () => {
  it('I2: eigener Schritt in pruefung und rueckweg erlaubt, in parameter nicht', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[1].pruefung = { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{schritt2.vmid}}' } }; })).fehler).toEqual([]);
    expect((await pruefe(v => { v.changes[0].schritte[0].rueckweg = { skill: 'unifi', aktion: 'delete_network', parameter: { id: '{{schritt1.id}}' } }; })).fehler).toEqual([]);
    expect((await pruefe(v => { v.changes[0].schritte[0].rueckweg = { skill: 'unifi', aktion: 'x', parameter: { id: '{{schritt2.id}}' } }; })).fehler.join('\n')).toMatch(/schritt2/);
    expect((await pruefe(v => { v.changes[0].schritte[1].parameter.x = '{{schritt2.id}}'; })).fehler.join('\n')).toMatch(/schritt2/);
  });
  it('I4: Annahmen gehen als eigener Change in die Probe', async () => {
    let plaene: Array<Record<string, any>> = [];
    const r = await pruefe(undefined, { probe: async p => { plaene = p as Array<Record<string, any>>; return ['Schritt 1: Befehl steht auf der Nie-Liste'] ; } });
    expect(r.fehler).toEqual(['Probe: Schritt 1: Befehl steht auf der Nie-Liste']);
    expect(plaene).toHaveLength(3);
    const a = plaene[2];
    expect(a).toMatchObject({ schluessel: 'annahmen', titel: 'Eingangskontrolle der Vorlage', begruendung: 'Vorab-Prüfungen der Bauplan-Vorlage', typ: 'normal', risiko: 'low', abhaengigVon: [] });
    expect(a.schritte).toHaveLength(1);
    expect(a.schritte[0]).toMatchObject({ titel: 'Eingangskontrolle: VMID ist frei', art: 'pruefung', beiFehler: 'anhalten' });
    expect(a.schritte[0].pruefung.parameter.vmid).toBe(157);
  });
  it('I4: ohne Annahmen kein zusätzlicher Change', async () => {
    let n = 0;
    await pruefe(v => { v.annahmen = []; }, { probe: async p => { n = p.length; return []; } });
    expect(n).toBe(2);
  });
  it('Minor 1: Befehlsfelder ohne Groß-/Kleinschreibung', async () => {
    const r = await pruefe(v => {
      v.parameter.push({ name: 'frei_text', typ: 'text', pflicht: false, beschreibung: 'x' });
      v.changes[0].schritte[0].parameter.Befehl = 'echo {{param.frei_text}}';
      v.changes[0].schritte[1].parameter.COMMAND = 'echo {{param.frei_text}}';
    });
    expect(r.fehler.join('\n')).toMatch(/Befehl/);
    expect(r.fehler.join('\n')).toMatch(/COMMAND/);
  });
  it('Minor 2: {{geheim:…}} nur als ganzer Wert, geheimdatei auch im Text', async () => {
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.notiz = 'pw={{geheim:pkilab-sql}}'; })).fehler.join('\n')).toMatch(/geheim:pkilab-sql/);
    expect((await pruefe(v => { v.changes[0].schritte[0].parameter.befehl = 'cat {{geheimdatei:lab-ca}}'; })).fehler).toEqual([]);
  });
});

describe('Fix-Runde 2 — Annahmen-Change besteht den echten Change-Validator', () => {
  const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status', 'create_vm'] }, vmid: { type: 'number' } }, required: ['action'] } } };
  const kontext: PruefKontext = {
    skill: n => (n === 'proxmox' ? fakeSkill : undefined),
    asset: k => (k === 'pve' ? { id: 'a-pve', name: 'pve' } : undefined),
    changes: [], jetzt: new Date('2026-11-16T10:00:00Z'),
  };
  it('ausfallMinuten 0 und betroffen aus der Vereinigung der Changes', async () => {
    let plaene: Array<Record<string, any>> = [];
    const r = await pruefe(v => { v.changes[0].betroffen = ['pve']; v.changes[1].betroffen = ['pve']; }, { probe: async p => { plaene = p as Array<Record<string, any>>; return []; } });
    expect(r.fehler).toEqual([]);
    const a = plaene.find(p => p.schluessel === 'annahmen')!;
    expect(a.ausfallMinuten).toBe(0);
    expect(a.betroffen).toEqual(['pve']);
    const echt = pruefeChangePlan(a, kontext, plaene.map(p => p.schluessel as string));
    expect(echt.fehler).toEqual([]);
  });
});

describe('Fix-Runde 3 — betroffen nach dem Einsetzen', () => {
  const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status'] }, vmid: { type: 'number' } }, required: ['action'] } } };
  const kontext: PruefKontext = {
    skill: n => (n === 'proxmox' ? fakeSkill : undefined),
    asset: k => (k === 'pve' ? { id: 'a-pve', name: 'pve' } : undefined),
    changes: [], jetzt: new Date('2026-11-16T10:00:00Z'),
  };
  it('{{param.node}} in betroffen ist in beiden Probe-Changes eingesetzt und besteht den echten Validator', async () => {
    const roh = {
      schema: 1, key: 'lese_probe', titel: 'Lese-Probe', zweck: 'Nur lesen', dokumentart: 'testprotokoll',
      parameter: [
        { name: 'node', typ: 'node', pflicht: true, beschreibung: 'Knoten', beispiel: 'pve' },
        { name: 'vmid', typ: 'vmid', pflicht: true, beschreibung: 'VMID', beispiel: 157 },
      ],
      annahmen: [{ id: 'vm_da', text: 'VM antwortet', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' } } }],
      changes: [{
        schluessel: 'lesen', titel: 'Status lesen', begruendung: 'Nur den Zustand der VM lesen', typ: 'normal', risiko: 'low', ausfallMinuten: 0,
        abhaengigVon: [], betroffen: ['{{param.node}}'],
        schritte: [{ titel: 'Status', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' }],
      }],
    };
    let plaene: Array<Record<string, any>> = [];
    const r = await pruefeVorlage(roh, { probe: async p => { plaene = p as Array<Record<string, any>>; return []; } });
    expect(r.fehler).toEqual([]);
    expect(plaene.map(p => p.betroffen)).toEqual([['pve'], ['pve']]);
    const schluessel = plaene.map(p => p.schluessel as string);
    for (const p of plaene) expect(pruefeChangePlan(p, kontext, schluessel).fehler, p.schluessel).toEqual([]);
  });
});

describe('Task 3 Fix-Runde 1 — change-Verweis bleibt in der Probe erhalten', () => {
  it('Zahlfeld mit {{change:…}} besteht die Probe über ChangePlanung.pruefeNur', async () => {
    const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status', 'clone_vm'] }, vmid: { type: 'number' }, name: { type: 'string' } }, required: ['action'] } } };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => (n === 'proxmox' ? fakeSkill : undefined) as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    const roh = {
      schema: 1, key: 'klon_probe', titel: 'Klon-Probe', zweck: 'Klonen und lesen', dokumentart: 'testprotokoll',
      parameter: [{ name: 'name', typ: 'name', pflicht: true, beschreibung: 'VM-Name', beispiel: 'probe-vm' }],
      annahmen: [],
      changes: [
        { schluessel: 'aufbau', titel: 'VM klonen', begruendung: 'Neue VM aus Vorlage klonen', typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: [], betroffen: ['pve'],
          schritte: [{ titel: 'Klonen', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', parameter: { name: '{{param.name}}' }, zeitlimitS: 60, beiFehler: 'anhalten', rueckweg: { keiner: 'Probe' } }] },
        { schluessel: 'lesen', titel: 'VM lesen', begruendung: 'Zustand der neuen VM lesen', typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: ['aufbau'], betroffen: ['pve'],
          schritte: [{ titel: 'Status', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{change:aufbau.schritt1.vmid}}' }, zeitlimitS: 60, beiFehler: 'anhalten' }] },
      ],
    };
    let plaene: Array<Record<string, any>> = [];
    const r = await pruefeVorlage(roh, { probe: async p => { plaene = p as Array<Record<string, any>>; return pl.pruefeNur('o', p); } });
    expect(plaene.find(p => p.schluessel === 'lesen')!.schritte[0].parameter.vmid).toBe('{{change:aufbau.schritt1.vmid}}');
    expect(r.fehler.filter(x => /vmid|change/.test(x))).toEqual([]);
    expect(await pl.pruefeNur('o', plaene).then(f => f.filter(x => /vmid|change:/.test(x)))).toEqual([]);
  });
});

describe('Task 4 Fix-Runde 1 — ohneSicherungGrund in der Vorlage', () => {
  it('Vorlage, die nur Neues anlegt: mit ohneSicherungGrund besteht sie die echte Probe, ohne meldet der Validator die fehlende Sicherung', async () => {
    const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status', 'clone_vm', 'delete_vm'] }, vmid: { type: 'number' }, name: { type: 'string' } }, required: ['action'] } } };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => (n === 'proxmox' ? fakeSkill : undefined) as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    const roh = (grund?: string) => ({
      schema: 1, key: 'nur_neu', titel: 'Nur Neues', zweck: 'Neue VM klonen', dokumentart: 'testprotokoll',
      parameter: [{ name: 'name', typ: 'name', pflicht: true, beschreibung: 'VM-Name', beispiel: 'probe-vm' }],
      annahmen: [],
      changes: [{ schluessel: 'aufbau', titel: 'VM klonen', begruendung: 'Neue VM aus Vorlage klonen', typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: [], betroffen: ['pve'],
        ...(grund ? { ohneSicherungGrund: grund } : {}),
        schritte: [{ titel: 'Klonen', art: 'aktion', skill: 'proxmox', aktion: 'clone_vm', parameter: { name: '{{param.name}}' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 1 } }, zeitlimitS: 60, beiFehler: 'anhalten', rueckweg: { skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: '{{schritt1.vmid}}' } } }] }],
    });
    let plaene: Array<Record<string, any>> = [];
    const mit = await pruefeVorlage(roh('Nur neue VM {{param.name}}, nichts Bestehendes betroffen'), { probe: async p => { plaene = p as Array<Record<string, any>>; return pl.pruefeNur('o', p); } });
    expect(mit.fehler).toEqual([]);
    expect(plaene[0]!.ohneSicherungGrund).toBe('Nur neue VM probe-vm, nichts Bestehendes betroffen');
    const ohne = await pruefeVorlage(roh(), { probe: p => pl.pruefeNur('o', p) });
    expect(ohne.fehler.join('\n')).toMatch(/Sicherung.*ohneSicherungGrund/);
    expect((await pruefeVorlage(roh('{{param.gibtsnicht}}'), { probe: p => pl.pruefeNur('o', p) })).fehler.join('\n')).toMatch(/gibtsnicht/);
    expect((await pruefeVorlage(roh(''), { probe: p => pl.pruefeNur('o', p) })).fehler.join('\n')).toMatch(/ohneSicherungGrund/);
  });
});

describe('Task 6 — zweck stilllegung in der Vorlage', () => {
  it('Vorlage mit proxmox.delete_vm besteht die echte Probe nur mit zweck stilllegung; zweck wandert in den Probe-Plan', async () => {
    const fakeSkill = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['vm_status', 'backup_vm', 'delete_vm'] }, vmid: { type: 'number' } }, required: ['action'] } } };
    const pl = new ChangePlanung({
      itsm: { liste: async () => [], hole: async () => null, legeAn: async () => { throw new Error('nie speichern'); } } as never,
      skill: n => (n === 'proxmox' ? fakeSkill : undefined) as never,
      assets: async () => [{ id: 'a-pve', name: 'pve' }] as never,
      auswirkung: async ids => ({ assets: ids, abhaengige: [], services: [], kritisch: false, offeneIncidents: [], ueberschneidungen: [] }),
    });
    const roh = (zweck?: string) => ({
      schema: 1, key: 'vm_weg', titel: 'VM weg', zweck: 'Wegwerf-VM löschen', dokumentart: 'testprotokoll',
      parameter: [{ name: 'vmid', typ: 'vmid', pflicht: true, beschreibung: 'VMID', beispiel: 157 }],
      annahmen: [],
      changes: [{ schluessel: 'abbau', titel: 'VM löschen', begruendung: 'Wegwerf-VM endgültig entfernen', typ: 'normal', risiko: 'high', ausfallMinuten: 0, abhaengigVon: [], betroffen: ['pve'],
        ...(zweck !== undefined ? { zweck } : {}),
        schritte: [
          { titel: 'Sicherung', art: 'aktion', skill: 'proxmox', aktion: 'backup_vm', parameter: { vmid: '{{param.vmid}}' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' } }, zeitlimitS: 600, beiFehler: 'anhalten' },
          { titel: 'Löschen', art: 'aktion', skill: 'proxmox', aktion: 'delete_vm', parameter: { vmid: '{{param.vmid}}' }, pruefung: { typ: 'befehl', zugang: 'pve', befehl: 'qm list', nichtEnthalten: ' {{param.vmid}} ' }, zeitlimitS: 600, beiFehler: 'anhalten', rueckweg: { keiner: 'endgültig' } },
        ] }],
    });
    let plaene: Array<Record<string, any>> = [];
    const mit = await pruefeVorlage(roh('stilllegung'), { probe: async p => { plaene = p as Array<Record<string, any>>; return pl.pruefeNur('o', p); } });
    expect(mit.fehler).toEqual([]);
    expect(plaene[0]!.zweck).toBe('stilllegung');
    const ohne = await pruefeVorlage(roh(), { probe: p => pl.pruefeNur('o', p) });
    expect(ohne.fehler.join('\n')).toMatch(/delete_vm.*zweck stilllegung/);
    expect((await pruefeVorlage(roh('migration'), { probe: p => pl.pruefeNur('o', p) })).fehler.join('\n')).toMatch(/zweck/);
  });
});
