import { describe, it, expect } from 'vitest';
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
  it('Probe erhält eingesetzte Pläne ohne kapitel, change-Verweise als „probe“', async () => {
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
    expect(b.schritte[0].parameter.id).toBe('probe');
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
