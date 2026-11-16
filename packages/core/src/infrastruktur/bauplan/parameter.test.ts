import { describe, it, expect } from 'vitest';
import { pruefeWert, ableiten, loeseParameter, setzeEin, setzeEinPruefung } from './parameter.js';
import { pruefeSchema, type BauplanParameter, type BauplanVorlage } from './schema.js';
import { testVorlage } from './testvorlage.fixture.js';

const p = (typ: BauplanParameter['typ'], extra: Partial<BauplanParameter> = {}): BauplanParameter => ({ name: 'x', typ, pflicht: true, beschreibung: 'x', ...extra });
const vorlage = (): BauplanVorlage => { const r = pruefeSchema(testVorlage()); expect(r.fehler).toEqual([]); return r.vorlage!; };

describe('pruefeWert', () => {
  it('name/node/storage', () => {
    for (const t of ['name', 'node', 'storage'] as const) {
      expect(pruefeWert(p(t), 'labsrv01')).toBeUndefined();
      expect(pruefeWert(p(t), 'data2-pve')).toBeUndefined();
      expect(pruefeWert(p(t), 'x; rm -rf /')).toBeTypeOf('string');
      expect(pruefeWert(p(t), 'mit leerzeichen')).toBeTypeOf('string');
      expect(pruefeWert(p(t), '-start')).toBeTypeOf('string');
      expect(pruefeWert(p(t), 'a'.repeat(64))).toBeTypeOf('string');
      expect(pruefeWert(p(t), 12)).toBeTypeOf('string');
    }
  });
  it('ipv4', () => {
    expect(pruefeWert(p('ipv4'), '10.203.32.1')).toBeUndefined();
    expect(pruefeWert(p('ipv4'), '256.1.1.1')).toBeTypeOf('string');
    expect(pruefeWert(p('ipv4'), '10.1.1')).toBeTypeOf('string');
    expect(pruefeWert(p('ipv4'), '010.1.1.1')).toBeTypeOf('string');
    expect(pruefeWert(p('ipv4'), '10.1.1.1 ')).toBeTypeOf('string');
  });
  it('cidr', () => {
    expect(pruefeWert(p('cidr'), '10.203.32.0/28')).toBeUndefined();
    expect(pruefeWert(p('cidr'), '0.0.0.0/0')).toBeUndefined();
    expect(pruefeWert(p('cidr'), '10.0.0.5/24')).toMatch(/Netzanfang/);
    expect(pruefeWert(p('cidr'), '10.0.0.0/33')).toBeTypeOf('string');
    expect(pruefeWert(p('cidr'), '10.0.0.0')).toBeTypeOf('string');
  });
  it('vlan', () => {
    expect(pruefeWert(p('vlan'), 832)).toBeUndefined();
    expect(pruefeWert(p('vlan'), 2)).toBeUndefined();
    expect(pruefeWert(p('vlan'), 4094)).toBeUndefined();
    expect(pruefeWert(p('vlan'), 4095)).toBeTypeOf('string');
    expect(pruefeWert(p('vlan'), 1)).toBeTypeOf('string');
    expect(pruefeWert(p('vlan'), 8.5)).toBeTypeOf('string');
    expect(pruefeWert(p('vlan'), '832')).toBeTypeOf('string');
  });
  it('vmid', () => {
    expect(pruefeWert(p('vmid'), 157)).toBeUndefined();
    expect(pruefeWert(p('vmid'), 99)).toBeTypeOf('string');
    expect(pruefeWert(p('vmid'), 1_000_000_000)).toBeTypeOf('string');
  });
  it('zahl mit min/max', () => {
    expect(pruefeWert(p('zahl'), 3.5)).toBeUndefined();
    expect(pruefeWert(p('zahl'), Infinity)).toBeTypeOf('string');
    expect(pruefeWert(p('zahl', { grenzen: { min: 1, max: 4 } }), 5)).toBeTypeOf('string');
    expect(pruefeWert(p('zahl', { grenzen: { min: 1, max: 4 } }), 0)).toBeTypeOf('string');
    expect(pruefeWert(p('zahl', { grenzen: { min: 1, max: 4 } }), 4)).toBeUndefined();
  });
  it('text', () => {
    expect(pruefeWert(p('text'), 'Lab; mit Semikolon')).toBeUndefined();
    expect(pruefeWert(p('text'), 'mit {{param.x}}')).toBeTypeOf('string');
    expect(pruefeWert(p('text'), 'zwei\nzeilen')).toBeTypeOf('string');
    expect(pruefeWert(p('text'), 'a'.repeat(201))).toBeTypeOf('string');
    expect(pruefeWert(p('text', { grenzen: { laenge: 5 } }), 'abcdef')).toBeTypeOf('string');
  });
  it('liste', () => {
    expect(pruefeWert(p('liste'), ['a', 'b-1'])).toBeUndefined();
    expect(pruefeWert(p('liste'), ['a', 'x; rm'])).toBeTypeOf('string');
    expect(pruefeWert(p('liste'), Array.from({ length: 21 }, (_, i) => `n${i}`))).toBeTypeOf('string');
    expect(pruefeWert(p('liste'), 'a,b')).toBeTypeOf('string');
  });
  it('grenzen.regex gilt zusätzlich', () => {
    const q = p('name', { grenzen: { regex: '^lab' } });
    expect(pruefeWert(q, 'labsrv01')).toBeUndefined();
    expect(pruefeWert(q, 'srv01')).toBeTypeOf('string');
    expect(pruefeWert(p('liste', { grenzen: { regex: '^lab' } }), ['lab1', 'x'])).toBeTypeOf('string');
  });
});

describe('ableiten', () => {
  it('feste Funktionen', () => {
    expect(ableiten('netzadresse', '10.203.32.0/24')).toEqual({ wert: '10.203.32.0' });
    expect(ableiten('erste_adresse', '10.203.32.0/24')).toEqual({ wert: '10.203.32.1' });
    expect(ableiten('adresse', '10.203.32.0/24', 10)).toEqual({ wert: '10.203.32.10' });
    expect(ableiten('praefix', '10.203.32.0/24')).toEqual({ wert: 24 });
    expect(ableiten('adresse', '10.0.0.0/30', 5).fehler).toMatch(/außerhalb/);
    expect(ableiten('adresse', '10.0.0.0/30', 3)).toEqual({ wert: '10.0.0.3' });
    expect(ableiten('erste_adresse', '10.0.0.0/32').fehler).toBeTypeOf('string');
    expect(ableiten('adresse', '10.0.0.0/8', 256 * 256 + 1)).toEqual({ wert: '10.1.0.1' });
  });
});

describe('loeseParameter', () => {
  it('Pflicht, Typ, Ableitung', () => {
    const r = loeseParameter(vorlage(), { vlan: 832, netz: '10.203.32.0/28', vmid: 157, name_server: 'labsrv01' });
    expect(r.fehler).toEqual([]);
    expect(r.werte).toEqual({ vlan: 832, netz: '10.203.32.0/28', gateway: '10.203.32.1', vmid: 157, name_server: 'labsrv01' });
  });
  it('Zahl als Ziffernstring wird Zahl', () => {
    const r = loeseParameter(vorlage(), { vlan: '832', netz: '10.203.32.0/28', vmid: '157', name_server: 'labsrv01' });
    expect(r.fehler).toEqual([]);
    expect(r.werte.vlan).toBe(832);
    expect(r.werte.vmid).toBe(157);
  });
  it('fehlende Pflicht, falscher Typ, unbekannte und abgeleitete Eingabe', () => {
    const r = loeseParameter(vorlage(), { vlan: 4095, netz: '10.203.32.0/28', name_server: 'x; rm -rf /', fremd: 1, gateway: '10.203.32.9' });
    expect(r.fehler.join('\n')).toMatch(/vmid.*fehlt/);
    expect(r.fehler.join('\n')).toMatch(/vlan/);
    expect(r.fehler.join('\n')).toMatch(/name_server/);
    expect(r.fehler.join('\n')).toMatch(/fremd.*unbekannt/i);
    expect(r.fehler.join('\n')).toMatch(/gateway.*abgeleitet/);
  });
});

describe('setzeEin', () => {
  it('ganzer Wert behält den Typ, Teilstring wird String, kapitel bleibt', () => {
    const v = vorlage();
    const { werte } = loeseParameter(v, { vlan: 832, netz: '10.203.32.0/28', vmid: 157, name_server: 'labsrv01' });
    const ch = setzeEin(v, werte);
    const s1 = ch[0].schritte[0] as { parameter: Record<string, unknown>; kapitel?: string };
    expect(s1.parameter.vlan).toBe(832);
    expect(s1.parameter.name).toBe('lab-832');
    expect(s1.parameter.gateway).toBe('10.203.32.1');
    expect(s1.kapitel).toBe('3');
    expect(ch[0].titel).toBe('Aufbau VLAN 832');
    const s2 = ch[0].schritte[1] as { parameter: Record<string, unknown> };
    expect(s2.parameter.vmid).toBe(157);
    expect(s2.parameter.netz_id).toBe('{{schritt1.id}}');
    expect((ch[1].schritte[0] as { parameter: Record<string, unknown> }).parameter.id).toBe('{{change:aufbau.schritt1.id}}');
    // Vorlage bleibt unverändert
    expect((v.changes[0].schritte[0] as { parameter: Record<string, unknown> }).parameter.vlan).toBe('{{param.vlan}}');
  });
  it('fehlender optionaler Wert: ganzer Wert entfällt, Teilstring leer', () => {
    const roh = testVorlage();
    (roh.parameter as unknown[]).push({ name: 'notiz', typ: 'text', pflicht: false, beschreibung: 'Notiz' });
    ((roh.changes as Array<{ schritte: Array<{ parameter: Record<string, unknown> }> }>)[0].schritte[0].parameter).notiz = '{{param.notiz}}';
    ((roh.changes as Array<{ schritte: Array<{ parameter: Record<string, unknown> }> }>)[0].schritte[0].parameter).beschreibung = 'Lab {{param.notiz}}';
    const v = pruefeSchema(roh).vorlage!;
    const ch = setzeEin(v, { vlan: 832, vmid: 157, name_server: 'a', netz: '10.0.0.0/24', gateway: '10.0.0.1' });
    const par = (ch[0].schritte[0] as { parameter: Record<string, unknown> }).parameter;
    expect('notiz' in par).toBe(false);
    expect(par.beschreibung).toBe('Lab ');
  });
  it('Liste als ganzer Wert bleibt Array, im Teilstring mit Komma', () => {
    const roh = testVorlage();
    (roh.parameter as unknown[]).push({ name: 'hosts', typ: 'liste', pflicht: true, beschreibung: 'Hosts', beispiel: ['a', 'b'] });
    const par = (roh.changes as Array<{ schritte: Array<{ parameter: Record<string, unknown> }> }>)[0].schritte[0].parameter;
    par.hosts = '{{param.hosts}}'; par.text = 'Hosts: {{param.hosts}}';
    const v = pruefeSchema(roh).vorlage!;
    const ch = setzeEin(v, { vlan: 832, vmid: 157, name_server: 'a', netz: '10.0.0.0/24', gateway: '10.0.0.1', hosts: ['a', 'b'] });
    const out = (ch[0].schritte[0] as { parameter: Record<string, unknown> }).parameter;
    expect(out.hosts).toEqual(['a', 'b']);
    expect(out.text).toBe('Hosts: a,b');
  });
});

describe('Fix-Runde 1 — Parameter', () => {
  it('I1: text ohne geschweifte Klammern', () => {
    expect(pruefeWert(p('text'), 'x{')).toMatch(/Klammer/);
    expect(pruefeWert(p('text'), '{schritt9.x}}')).toMatch(/Klammer/);
    expect(pruefeWert(p('text'), 'a}')).toMatch(/Klammer/);
  });
  it('I1: setzeEin bricht ab, wenn durch Einsetzen ein neuer Platzhalter entsteht', () => {
    const roh = testVorlage();
    (roh.parameter as unknown[]).push({ name: 'a', typ: 'text', pflicht: false, beschreibung: 'a' }, { name: 'b', typ: 'text', pflicht: false, beschreibung: 'b' });
    const par = (roh.changes as Array<{ schritte: Array<{ parameter: Record<string, unknown> }> }>)[0].schritte[1].parameter;
    par.notiz = '{{param.a}}{schritt9.geheim}}';
    const v = pruefeSchema(roh).vorlage!;
    const basis = { vlan: 832, vmid: 157, name_server: 'a', netz: '10.0.0.0/24', gateway: '10.0.0.1' };
    // Werte, die loeseParameter abweisen würde, direkt eingesetzt (Schutz in der Tiefe)
    expect(() => setzeEin(v, { ...basis, a: 'x{' })).toThrow(/neuer Platzhalter|Platzhalter/);
    par.notiz = '{{param.a}}{{param.b}}';
    const v2 = pruefeSchema(roh).vorlage!;
    expect(() => setzeEin(v2, { ...basis, a: '{', b: '{schritt9.x}}' })).toThrow(/Platzhalter/);
    par.notiz = '{{{param.a}}}';
    const v3 = pruefeSchema(roh).vorlage!;
    expect(() => setzeEin(v3, { ...basis, a: 'x' })).not.toThrow();
    expect(() => setzeEin(v3, { ...basis, a: '{schritt1.x}' })).toThrow(/Platzhalter/);
    // vorhandene Nicht-Parameter-Platzhalter bleiben erlaubt
    expect(() => setzeEin(v, { ...basis, a: 'x' })).not.toThrow();
  });
  it('I3: Regex wird nur auf begrenzte Werte angewandt', () => {
    expect(pruefeWert(p('text', { grenzen: { regex: '^a+$' } }), 'a'.repeat(201))).toBeTypeOf('string');
  });
});

describe('Task 6 Fix-Runde 1 — Prüftexte bleiben Text', () => {
  it('in pruefung wird ein ganzer Verweis als Text eingesetzt, in parameter behält er den Typ', () => {
    const v = vorlage();
    v.changes[0]!.schritte[1]!.pruefung = {
      typ: 'befehl', zugang: 'pve', befehl: 'qm config {{param.vmid}}', erwartet: '{{param.vmid}}', nichtEnthalten: '{{param.vlan}}', abbruch: '{{param.vmid}}',
    };
    v.changes[0]!.schritte[1]!.rueckweg = { skill: 'proxmox', aktion: 'shutdown_vm', parameter: { vmid: '{{param.vmid}}' } };
    const [c] = setzeEin(v, { vlan: 832, netz: '10.203.32.0/28', gateway: '10.203.32.1', vmid: 157, name_server: 'labsrv01' });
    const s = c!.schritte[1] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.parameter.vmid).toBe(157);
    expect(s.rueckweg.parameter.vmid).toBe(157);
    expect(s.pruefung).toEqual({ typ: 'befehl', zugang: 'pve', befehl: 'qm config 157', erwartet: '157', nichtEnthalten: '832', abbruch: '157' });
  });
  it('pruefung typ skill: parameter und port behalten den Typ, Texte werden Text', () => {
    const p0 = { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}', liste: ['{{param.vmid}}'] }, erwartet: '{{param.vmid}}', port: '{{param.vlan}}' };
    expect(setzeEinPruefung(p0, { vmid: 157, vlan: 832 })).toEqual({ typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: 157, liste: [157] }, erwartet: '157', port: 832 });
  });
  it('fehlender optionaler Wert lässt das Prüffeld wie bisher entfallen', () => {
    expect(setzeEinPruefung({ typ: 'befehl', zugang: 'pve', befehl: 'uptime', erwartet: '{{param.fehlt}}' }, {})).toEqual({ typ: 'befehl', zugang: 'pve', befehl: 'uptime' });
  });
});
