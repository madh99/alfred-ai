import { describe, it, expect, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';

vi.mock('./pair.js', () => ({ speichereKonfig: vi.fn() }));
import { pruefePin, willkommenSicherheit, befehlPruefen, sicherheitsStand } from './satellit-sicherheit.js';
import { ladeOderErzeugeBefehlsSchluessel, signiereBefehl, spkiHex } from '@alfred/core';
import type { GeraetKonfig } from './pair.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// öffentliches Zertifikat des Gehirns (nur das Zertifikat, kein Schlüssel) als feste Testdaten
function zertifikat(): Buffer {
  const pem = fs.readFileSync(path.join(__dirname, '__testdaten__', 'server.pem'), 'utf8');
  return new X509Certificate(pem).raw;
}

const k = (o: Partial<GeraetKonfig> = {}): GeraetKonfig => ({ server: 'https://s:3420', geraetId: 'g1', token: 't', name: 'PC', insecure: true, freigegebeneVerzeichnisse: [], erlaubteProgramme: [], ...o });

describe('v1531 Satelliten-Sicherheit', () => {
  it('Pin: erster Kontakt lernt, dann ok; anderer Schlüssel abweichend; streng lernt nie', () => {
    const der = zertifikat();
    const fp = spkiHex(der);
    const a = k();
    expect(pruefePin(a, der)).toBe('gelernt');
    expect(a.serverSchluessel).toEqual([fp]);
    expect(pruefePin(a, der)).toBe('ok');
    const b = k({ serverSchluessel: ['00'.repeat(32)] });
    expect(pruefePin(b, der)).toBe('abweichend');
    const c = k({ sicherheitStreng: true });
    expect(pruefePin(c, der)).toBe('abweichend');
    expect(c.serverSchluessel).toBeUndefined();
  });
  it('Willkommen: Befehls-Schlüssel gemerkt; streng nur mit gelerntem Pin und Schlüssel, einseitig', () => {
    const s = ladeOderErzeugeBefehlsSchluessel(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sat-sich-')), 'k.pem'));
    const log: string[] = [];
    const ohnePin = k();
    willkommenSicherheit(ohnePin, { befehlsKey: s.oeffentlichPem, streng: true }, t => log.push(t));
    expect(ohnePin.befehlsKey).toBe(s.oeffentlichPem);
    expect(ohnePin.sicherheitStreng).toBeFalsy(); // kein Pin → nicht aussperren
    const mitPin = k({ serverSchluessel: ['ab'] });
    willkommenSicherheit(mitPin, { befehlsKey: s.oeffentlichPem }, () => undefined);
    willkommenSicherheit(mitPin, { befehlsKey: s.oeffentlichPem, streng: true }, () => undefined);
    expect(mitPin.sicherheitStreng).toBe(true);
    willkommenSicherheit(mitPin, { befehlsKey: s.oeffentlichPem, streng: false }, () => undefined);
    expect(mitPin.sicherheitStreng).toBe(true); // nur am Gerät zurücknehmbar
  });
  it('Befehle: Stufe lernen führt mit Warnung aus, streng lehnt ab', () => {
    const s = ladeOderErzeugeBefehlsSchluessel(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sat-sich-')), 'k.pem'));
    const roh = (id: string) => ({ id, zeit: new Date().toISOString(), version: 1, typ: 'aktion', aktion: 'liste', params: {} });
    const lernen = k({ befehlsKey: s.oeffentlichPem });
    const log: string[] = [];
    expect(befehlPruefen(lernen, JSON.parse(JSON.stringify(signiereBefehl(roh('x1'), 'g1', s))), t => log.push(t))).toEqual({ erlaubt: true, ergebnis: 'ok' });
    expect(befehlPruefen(lernen, roh('x2'), t => log.push(t))).toEqual({ erlaubt: true, ergebnis: 'fehlt' });
    expect(log[0]).toContain('noch ausgeführt');
    const streng = k({ befehlsKey: s.oeffentlichPem, sicherheitStreng: true, serverSchluessel: ['ab'] });
    expect(befehlPruefen(streng, roh('x3'), () => undefined).erlaubt).toBe(false);
    expect(befehlPruefen(streng, JSON.parse(JSON.stringify(signiereBefehl(roh('x4'), 'g2', s))), () => undefined)).toEqual({ erlaubt: false, ergebnis: 'fremd' });
    expect(sicherheitsStand(streng).streng).toBe(true);
  });
});
