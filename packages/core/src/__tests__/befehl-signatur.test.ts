import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kanonisch, signiereBefehl, pruefeBefehl, ladeOderErzeugeBefehlsSchluessel, BEFEHL_ZEIT_TOLERANZ_MS } from '../geraete/befehl-signatur.js';

describe('v1531 Befehlssignatur', () => {
  const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-befehl-')), 'k.pem');
  const s = ladeOderErzeugeBefehlsSchluessel(datei);
  const jetzt = Date.parse('2026-10-20T16:00:00Z');
  const befehl = (o: Record<string, unknown> = {}) => ({ id: 'a1', zeit: new Date(jetzt).toISOString(), version: 1, typ: 'aktion', aktion: 'shell', params: { command: 'npm test', cwd: 'C:\\x', leer: undefined, n: 1.5 }, ...o });
  // so kommt es am Gerät an: über die Leitung (JSON)
  const leitung = <T>(x: T): Record<string, unknown> => JSON.parse(JSON.stringify(x));

  it('Schlüssel bleibt nach Neustart derselbe', () => {
    expect(ladeOderErzeugeBefehlsSchluessel(datei).oeffentlichPem).toBe(s.oeffentlichPem);
  });
  it('kanonisch: Reihenfolge der Schlüssel egal, undefined fällt weg', () => {
    expect(kanonisch({ b: 1, a: { d: [1, 'x'], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
  it('gültig über die Leitung; jede Änderung, anderes Gerät, alt oder doppelt wird erkannt', () => {
    const n = leitung(signiereBefehl(befehl(), 'geraet-1', s));
    const gesehen = new Map<string, number>();
    const pruef = (x: Record<string, unknown>, geraetId = 'geraet-1', t = jetzt) => pruefeBefehl(x, { schluesselPem: s.oeffentlichPem, geraetId, jetzt: t, gesehen });
    expect(pruef(n)).toBe('ok');
    expect(pruef(n)).toBe('doppelt'); // Wiederholung
    const geaendert = leitung(signiereBefehl(befehl({ id: 'a2' }), 'geraet-1', s));
    (geaendert.params as Record<string, unknown>).command = 'rm -rf /';
    expect(pruef(geaendert)).toBe('ungueltig');
    expect(pruef(leitung(signiereBefehl(befehl({ id: 'a3' }), 'geraet-2', s)))).toBe('fremd');
    expect(pruef(leitung(signiereBefehl(befehl({ id: 'a4' }), 'geraet-1', s)), 'geraet-1', jetzt + BEFEHL_ZEIT_TOLERANZ_MS + 1000)).toBe('alt');
    const ohne = leitung(befehl({ id: 'a5' }));
    expect(pruef(ohne)).toBe('fehlt');
    expect(pruefeBefehl(n, { geraetId: 'geraet-1', gesehen: new Map() })).toBe('kein_schluessel');
    // fremder Schlüssel
    const anders = ladeOderErzeugeBefehlsSchluessel(path.join(path.dirname(datei), 'anders.pem'));
    expect(pruefeBefehl(leitung(signiereBefehl(befehl({ id: 'a6' }), 'geraet-1', anders)), { schluesselPem: s.oeffentlichPem, geraetId: 'geraet-1', jetzt, gesehen })).toBe('ungueltig');
  });
});
