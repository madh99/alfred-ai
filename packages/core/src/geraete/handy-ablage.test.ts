import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { HandyAblage, ABLAGE_JE_GERAET, ABLAGE_DATEIEN_JE_GERAET, ABLAGE_VERTRAULICH_MS } from './handy-ablage.js';
import { GeraeteGateway } from './gateway.js';
import { pruefeManifest } from './protokoll.js';

describe('HandyAblage — v1520 Zwischenablage fürs Handy im Hintergrund', () => {
  it('je Gerät neueste zuerst, höchstens 5, nur das eigene Gerät holt ab', () => {
    let jetzt = 1_000;
    const a = new HandyAblage(() => jetzt);
    for (let i = 0; i < ABLAGE_JE_GERAET + 2; i++) { jetzt += 1; a.lege('g1', `t${i}`, false); }
    a.lege('g2', 'fremd', false);
    const offen = a.offene('g1');
    expect(offen.map(e => e.text)).toEqual(['t6', 't5', 't4', 't3', 't2']);
    expect(a.erledige('g2', offen[0].id)).toBe(false);
    expect(a.erledige('g1', offen[0].id)).toBe(true);
    expect(a.offene('g1')).toHaveLength(4);
  });

  it('v1521 Dateien: nur Verweis, eigene Grenze (10), Texte bleiben unberührt, nur das eigene Gerät liest', () => {
    let jetzt = 0;
    const a = new HandyAblage(() => jetzt);
    a.lege('g', 'text', false);
    for (let i = 0; i < ABLAGE_DATEIEN_JE_GERAET + 3; i++) { jetzt += 1; a.legeDatei('g', { quelle: `k${i}`, name: `d${i}.pdf`, ordner: 'Downloads' }); }
    const offen = a.offene('g');
    expect(offen.filter(e => e.art === 'datei')).toHaveLength(ABLAGE_DATEIEN_JE_GERAET);
    expect(offen.filter(e => e.art === 'text')).toHaveLength(1);
    const neu = offen[0];
    expect(neu.datei).toEqual({ quelle: 'k12', name: 'd12.pdf', ordner: 'Downloads' });
    expect(a.hole('fremd', neu.id)).toBeUndefined();
    expect(a.hole('g', neu.id)?.datei?.quelle).toBe('k12');
  });

  it('vertraulich verfällt nach 30 min, normal nach 24 h', () => {
    let jetzt = 0;
    const a = new HandyAblage(() => jetzt);
    a.lege('g', 'geheim', true); a.lege('g', 'normal', false);
    jetzt = ABLAGE_VERTRAULICH_MS + 1;
    expect(a.offene('g').map(e => e.text)).toEqual(['normal']);
    jetzt = 25 * 3600_000;
    expect(a.offene('g')).toEqual([]);
  });
});

describe('GeraeteGateway — Handy-Werkzeug ohne Verbindung', () => {
  it('Handy mit Aktionen: Werkzeug angemeldet, Aktion geht an offlineAktion; Desktop/ohne Aktionen nicht', async () => {
    const registriert: string[] = [];
    const skillRegistry = { has: (n: string) => registriert.includes(n), register: (s: { metadata: { name: string } }) => { registriert.push(s.metadata.name); }, unregister: (n: string) => { registriert.splice(registriert.indexOf(n), 1); } };
    const manifest = (aktionen: unknown[]) => ({ protokoll: 1, plattform: 'ios', hostname: 'x', satellitVersion: 'app-1', aktionen, sinne: [] });
    const zb = [{ name: 'zwischenablage_setzen', beschreibung: 'x', autonomie: 'auto' }];
    const geraete = [
      { id: 'h1', userId: 'o', name: 'iPhone', plattform: 'ios', manifest: manifest(zb), scopes: [], status: 'aktiv', erstellt: '' },
      { id: 'h2', userId: 'o', name: 'Altes iPhone', plattform: 'ios', manifest: manifest([]), scopes: [], status: 'aktiv', erstellt: '' },
      { id: 'p1', userId: 'o', name: 'PC', plattform: 'windows', manifest: { ...manifest(zb), plattform: 'windows' }, scopes: [], status: 'aktiv', erstellt: '' },
      { id: 'h3', userId: 'o', name: 'Weg', plattform: 'ios', manifest: manifest(zb), scopes: [], status: 'widerrufen', erstellt: '' },
    ];
    const aufrufe: string[] = [];
    const gw = new GeraeteGateway({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, repo: { liste: async () => geraete }, skillRegistry, serverVersion: 't', ownerUserId: () => 'o',
      transferOrdner: path.join(os.tmpdir(), 'alfred-test-transfers'),
      offlineAktion: (g: { name: string }, aktion: string) => aktion === 'zwischenablage_setzen' ? (aufrufe.push(`${g.name}:${aktion}`), Promise.resolve({ success: true, display: 'liegt bereit', dauerMs: 0 })) : undefined,
    } as never);
    expect(await gw.handyWerkzeugeAnmelden()).toBe(1);
    expect(registriert).toEqual(['geraet_iphone']);
    expect(await gw.sendeAktion('h1', 'zwischenablage_setzen', { text: 'x' })).toMatchObject({ success: true, display: 'liegt bereit' });
    expect((await gw.sendeAktion('h1', 'anderes', {})).error).toContain('nicht verbunden');
    expect(aufrufe).toEqual(['iPhone:zwischenablage_setzen']);
  });
});

describe('Manifest der Handy-App (lib/handy_verbindung.dart handyAktionen)', () => {
  it('wird angenommen: zwischenablage_setzen auto mit text und vertraulich, Sinne', () => {
    const r = pruefeManifest({ protokoll: 1, plattform: 'ios', hostname: 'iPhone', satellitVersion: 'app-1.54.0', sinne: ['akku', 'netz', 'audio', 'system'],
      aktionen: [{ name: 'zwischenablage_setzen', beschreibung: 'Legt Text in die Zwischenablage dieses Handys („kopier mir das aufs Handy“). Ist die App im Hintergrund, kommt eine Mitteilung „Zum Kopieren antippen“.', autonomie: 'auto',
        parameter: { text: { type: 'string', description: 'Text' }, vertraulich: { type: 'boolean', description: 'true bei Passwort/Token: bleibt auf diesem Gerät, verfällt nach 2 min' } } },
        { name: 'datei_ablegen', beschreibung: 'Legt eine Datei vom Server auf diesem Handy ab (quelle = FileStore-key), überschreibt nie. ordner: Alfred, Downloads (Standard Alfred). App im Hintergrund: Mitteilung, gespeichert beim Öffnen.', autonomie: 'auto',
          parameter: { quelle: { type: 'string', description: 'FileStore-Schlüssel oder Serverpfad' }, ordner: { type: 'string', description: 'Zielordner: Alfred | Downloads' }, name: { type: 'string', description: 'Dateiname (optional)' } } }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.aktionen.map(a => a.name)).toEqual(['zwischenablage_setzen', 'datei_ablegen']);
  });
});
