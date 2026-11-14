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

describe('PKI Etappe 5: Restore-Test (Spec Pos. 18, netzlose Wegwerf-VM)', () => {
  const CA = '4B07588C254F9705E924EB6349F10DA38C0CCA51'; const ROOT = '2AA90DF95DD62A6A44CD3995EBC59C0F341DE64C';
  const P = { action: 'ca_wiederherstellung_testen', vmid: 160, vm_name: 'pkirestore01', quelle_zugang: 'fs01', quelle_ordner: 'S:\\PKI-Sicherung\\Issuer', satz: 'ca-20261113-114935', passwort_tresor: 'pki-iss-sicherung', erwartet_ca_thumbprint: CA, erwartet_root_thumbprint: ROOT, erwartete_zertifikate: ['4E073ED074CAB15E515ECD4471B0820C45E440E1'] };
  it('Skript: nur netzlos und als SYSTEM, Root ins Vertrauen, Standalone aus der .p12, DatabaseOnly, Abnahme', async () => {
    const { caRestoreSkript } = await import('./windows-pki.js');
    const s = caRestoreSkript({ ordner: 'C:\\Alfred-Restore', satz: 'ca-20261113-114935', erwartet_ca: CA, erwartet_root: ROOT, erwartete_zertifikate: [] });
    const vor = s.slice(0, s.indexOf('Install-AdcsCertificationAuthority'));
    expect(vor).toContain("Where-Object { $_.Status -eq 'Up' }).Count) { throw 'aktiver Netzadapter");
    expect(vor).toContain('IsSystem');
    expect(vor).toContain('schon eine fremde CA eingerichtet');
    expect(s).toContain('-CAType StandaloneSubordinateCA -CertFile $p12.FullName');
    expect(s).toContain('Restore-CARoleService -Path $d -DatabaseOnly -Force');
    expect(s).toContain("certutil.exe '-ca.cert'");
    expect(s).toContain('certutil.exe -verifykeys');
  });
  it('Skill: nur mit vmid (Gastagent), nie über einen Fernzugang; Abnahme schlägt bei falschem CA-Thumbprint fehl', async () => {
    const aufrufe: string[] = [];
    const ad = (o: unknown) => ({ code: 0, stdout: `ALFRED-AD ${JSON.stringify(o)}\n`, stderr: '' });
    const restore = { zustand: 'wiederhergestellt', rechner: 'PKIRESTORE01', satz: P.satz, satzZeit: '2026-11-13T11:49:35', ca: 'AD3033 Issuing CA 01', caThumbprint: CA, dienst: 'Running', schluesselPasst: true, zertifikate: 6, hoechsteRequestId: 6, crlNummer: 9, fehlen: [] as string[] };
    const sk = (r: unknown) => new WindowsPkiSkill({
      skript: async (z, _b) => { aufrufe.push(`ssh:${z}`); return ad(aufrufe.length === 1 ? { satz: P.satz, bytes: 1000, sha256: 'a'.repeat(64), base64: 'QQ==' } : { thumbprint: ROOT, base64: 'QQ==' }); },
      gast: async (vmid, name) => { aufrufe.push(`gast:${vmid}:${name}`); return ad(aufrufe.filter(x => x.startsWith('gast')).length === 1 ? { zustand: 'kopiert, geprüft', dateien: 5, ca: 'AD3033 Issuing CA 01' } : r); },
      tresor: { namen: async () => new Set(['pki-iss-sicherung']), lies: async () => 'pw' },
    });
    expect((await sk(restore).execute({ ...P, vmid: undefined, zugang: 'pkiiss01' }, { ausChange: true } as never)).error).toContain('netzlosen VM');
    expect((await sk(restore).execute(P, {} as never)).success).toBe(false);
    aufrufe.length = 0;
    const ok = await sk(restore).execute(P, { ausChange: true } as never);
    expect(ok.display, String(ok.error)).toContain('CA_RESTORE_VERIFIED');
    expect(aufrufe).toEqual(['ssh:fs01', 'ssh:fs01', 'gast:160:pkirestore01', 'gast:160:pkirestore01']);
    aufrufe.length = 0;
    const falsch = await sk({ ...restore, caThumbprint: 'BC3FAC56D2FB27863A0218CDD8E5D16B587570F1', fehlen: ['4E073ED074CAB15E515ECD4471B0820C45E440E1'] }).execute(P, { ausChange: true } as never);
    expect(falsch.success).toBe(false);
    expect(falsch.error).toMatch(/CA-Zertifikat BC3F.*nicht in der Datenbank: 4E07/);
    expect(aktionsArt('windows_pki', 'ca_wiederherstellung_testen')).toBe('aendern');
  });
});
