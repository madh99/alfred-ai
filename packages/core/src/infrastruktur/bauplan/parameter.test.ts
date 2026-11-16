import { describe, it, expect } from 'vitest';
import { pruefeWert, ableiten, loeseParameter, setzeEin } from './parameter.js';
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
