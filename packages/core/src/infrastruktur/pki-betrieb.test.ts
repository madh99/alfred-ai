import { describe, it, expect } from 'vitest';
import { pkiBefunde, PKI_BETRIEB, type PkiAufruf } from './pki-betrieb.js';
import { VORLAGEN, type StandardKontext } from './standard-vorlagen.js';
import { pruefeChangePlan, type PruefKontext, aktionsArt } from './change-schritte.js';
import { caSicherungAufraeumenSkript } from './windows-pki.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';
import { uebernehmen } from './befund-problems.js';

// PKI Etappe 5 — Betrieb (Owner 14.11.: täglicher Prüfjob + wöchentliche CA-Sicherung)
const jetzt = new Date('2026-11-14T08:00:00Z');
const B = PKI_BETRIEB.basis;
function welt(o: { tage?: [number, number]; issuerNu?: string; rootNu?: string; status?: number; alterH?: [number, number]; defekt?: boolean; fehlt?: string } = {}): PkiAufruf {
  return async (aktion, p) => {
    if (o.fehlt === aktion) return { success: false, error: 'nicht erreichbar' };
    if (aktion === 'erneuerung_status') return { success: true, data: (p.zugaenge as string[]).map((z, i) => ({ zugang: z, zertifikate: [{ thumbprint: i ? '690EC1B8649EBBC07870DE2C6AA74ED1B7E6A745' : '4E073ED074CAB15E515ECD4471B0820C45E440E1', bis: '2027-11-13T21:51:55', tage: (o.tage ?? [364, 364])[i] }], warnstufe: null })) };
    if (aktion === 'publication_pruefen') return { success: (o.status ?? 200) === 200, data: { abrufe: (p.urls as string[]).map(u => ({ url: u, status: u.endsWith('issuing1.crt') ? (o.status ?? 200) : 200, ...(u.endsWith('.crl') ? { nummer: '0a', nextUpdate: u.includes('issuing') ? (o.issuerNu ?? '2026-11-20T10:00:00') : (o.rootNu ?? '2027-05-14T15:00:00') } : {}) })) } };
    if (aktion === 'ca_sicherung_status') { const i = p.zugang === 'pkiiss01' ? 0 : 1; return { success: true, data: { saetze: [{ satz: 'ca-20261113-114935', ok: !o.defekt, alterStunden: (o.alterH ?? [20, 20])[i], ...(o.defekt ? { grund: 'Hash' } : {}) }] } }; }
    return { success: false, error: `unbekannt ${aktion}` };
  };
}

describe('PKI-Betrieb: tägliche Prüfung', () => {
  it('alles frisch → keine Problems, alle vier Hosts erfasst', async () => {
    const r = await pkiBefunde(welt(), PKI_BETRIEB, jetzt);
    expect(r.befunde.filter(uebernehmen)).toEqual([]);
    expect([...r.erfasst].sort()).toEqual(['fs01', 'pkiiss01', 'sql01', 'sql02']);
    expect(r.zeilen.join(' ')).toContain('ad3033-root.crl: Nr. 0a');
  });
  it('Zertifikats-Warnstufen 90/60/30/14', async () => {
    const r = await pkiBefunde(welt({ tage: [13, 45] }), PKI_BETRIEB, jetzt);
    const s = Object.fromEntries(r.befunde.filter(b => b.schluessel!.endsWith(':sql-tls')).map(b => [b.zugang, b.schwere]));
    expect(s).toEqual({ sql01: 'hoch', sql02: 'niedrig' });
    expect((await pkiBefunde(welt({ tage: [29, 364] }), PKI_BETRIEB, jetzt)).befunde[0]).toMatchObject({ schwere: 'mittel', kategorie: 'pki', schluessel: 'pki:sql01:sql-tls' });
  });
  it('Sperrlisten: Issuer < 3 Tage mittel / < 1 Tag hoch, Root < 30 mittel / < 14 hoch; nicht abrufbar hoch', async () => {
    const r = await pkiBefunde(welt({ issuerNu: '2026-11-15T20:00:00Z', rootNu: '2026-11-25T00:00:00Z', status: 404 }), PKI_BETRIEB, jetzt);
    const t = r.befunde.map(b => `${b.schwere} ${b.schluessel}`);
    expect(t).toContain('mittel pki:sql01:crl:ad3033-issuing1.crl');
    expect(t).toContain('hoch pki:sql01:crl:ad3033-root.crl');
    expect(t).toContain('hoch pki:sql01:abruf:ad3033-issuing1.crt');
    expect(r.befunde.find(b => b.schluessel === 'pki:sql01:crl:ad3033-root.crl')!.text).toContain('Offline-Zeremonie');
  });
  it('Sicherungsalter > 8 Tage mittel, > 15 hoch; fehlerhafter Satz mittel; gescheiterte Prüfung = nicht erfasst', async () => {
    const r = await pkiBefunde(welt({ alterH: [10 * 24, 20 * 24] }), PKI_BETRIEB, jetzt);
    expect(r.befunde.map(b => `${b.schwere} ${b.schluessel}`)).toEqual(expect.arrayContaining(['mittel pki:pkiiss01:sicherung-alter', 'hoch pki:fs01:sicherung-alter']));
    const d = await pkiBefunde(welt({ defekt: true }), PKI_BETRIEB, jetzt);
    expect(d.befunde.map(b => b.schluessel)).toContain('pki:pkiiss01:sicherung-defekt:ca-20261113-114935');
    const f = await pkiBefunde(welt({ fehlt: 'erneuerung_status' }), PKI_BETRIEB, jetzt);
    expect(f.erfasst.has('sql02')).toBe(false);
    expect(f.fehler[0]).toContain('Zertifikate');
  });
});

describe('PKI-Betrieb: wöchentliche CA-Sicherung (Vorlage k)', () => {
  const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen } }, required: ['action'] } } });
  const pctx: PruefKontext = { skill: n => (n === 'windows_pki' ? skill('windows_pki', ['ca_sicherung', 'ca_sicherung_kopieren', 'ca_sicherung_status', 'ca_sicherung_aufraeumen']) : undefined) as never, asset: k => ({ id: k, name: k }), changes: [] };
  const k = (anzahl = 0): StandardKontext => ({ jetzt, vm: async () => ({ fehler: 'x' }), vmFuerZugang: async () => undefined, zugangAsset: async z => `a-${z}`, container: () => undefined, snapshots: async () => [], updatesAn: async () => false, anzahl: async () => anzahl });
  const V = VORLAGEN.find(v => v.key === 'ca_sicherung')!;
  it('Plan: sichern → Kopie fs01 → Aufbewahrung 12 + Erstsicherung auf beiden Seiten, besteht die Planprüfung', async () => {
    const e = await V.erzeuge!({}, k());
    expect('plan' in e).toBe(true);
    if (!('plan' in e)) return;
    expect(pruefeChangePlan(e.plan, pctx).fehler).toEqual([]);
    const s = e.plan.schritte as Array<{ aktion: string; parameter: Record<string, unknown> }>;
    expect(s.map(x => x.aktion)).toEqual(['ca_sicherung', 'ca_sicherung_kopieren', 'ca_sicherung_aufraeumen', 'ca_sicherung_aufraeumen']);
    expect(s[2]!.parameter).toMatchObject({ zugang: 'pkiiss01', behalten: 12, schuetzen: ['ca-20261113-114935'] });
    expect(s[3]!.parameter).toMatchObject({ zugang: 'fs01', ziel_ordner: 'S:\\PKI-Sicherung\\Issuer' });
    expect(V.beschreibung).toContain('Root-CA und Offsite nicht enthalten');
  });
  it('höchstens 1× in 5 Tagen', async () => {
    expect(await V.erzeuge!({}, k(1))).toEqual({ fehler: 'pkiiss01: höchstens 1× in 5 Tagen' });
  });
  it('Aufbewahrung: nur geprüfte, neueste bleiben, geschützte bleiben, fehlerhafte werden nie gelöscht; nur im Change', async () => {
    const s = caSicherungAufraeumenSkript({ ziel_ordner: 'B:\\CA-Sicherung', behalten: 12, schuetzen: ['ca-20261113-114935'] });
    expect(s).toContain("throw 'kein geprüfter Sicherungssatz vorhanden — nichts gelöscht'");
    expect(s).toContain('$weg = @($gut | Where-Object { $bleibt -notcontains $_ })');
    expect(s).not.toMatch(/\$defekt[^\n]*Remove-Item/);
    expect(aktionsArt('windows_pki', 'ca_sicherung_aufraeumen')).toBe('aendern');
    const sk = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: 'ALFRED-AD {}\n', stderr: '' }) });
    expect((await sk.execute({ action: 'ca_sicherung_aufraeumen', zugang: 'pkiiss01', ziel_ordner: 'B:\\CA-Sicherung' }, {} as never)).success).toBe(false);
    expect((await sk.execute({ action: 'ca_sicherung_aufraeumen', zugang: 'pkiiss01', ziel_ordner: 'B:\\CA-Sicherung', behalten: 0 }, { ausChange: true } as never)).error).toContain('behalten');
  });
});
