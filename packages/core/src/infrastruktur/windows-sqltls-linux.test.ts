import { describe, it, expect } from 'vitest';
import { powershellVorhanden, parseSkripte } from './powershell-parser.testhilfe.js';
import { createHash } from 'node:crypto';
import {
  pruefeCsrForm, pruefeFremdAusstellung, fremdAusstellenSkript, linuxTlsSans, profilSqlTlsLinux, csrSha256,
  SQL_TLS_LINUX_VORLAGE, SQL_TLS_LINUX_ANZEIGE, SQL_TLS_LINUX_GRUPPE, SQL_TLS_LINUX_ANFORDERER,
} from './windows-sqltls-linux.js';
import { vorlageAnlegenSkript, vorlageEntfernenSkript } from './windows-codesignatur.js';
import { genehmigenSkript, pruefeGenehmigung } from './windows-sqltls.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';
import { aktionsArt } from './change-schritte.js';

// I8e Etappe 3 Task 3 — Linux-Vorlage und Ausstellung fremder Anforderungen (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md)
const ausChange = { ausChange: true } as never;
const ad = (o: unknown) => `ALFRED-AD ${JSON.stringify(o)}\n`;
const roh = (befehl: string) => Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le');

/** Form einer CSR (Inhalt beliebig, Node hat keinen CSR-Parser — die inhaltliche Prüfung macht der Baustein auf pkiiss01) */
function pem(der: Buffer): string {
  const b = der.toString('base64');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}
const DER = Buffer.concat([Buffer.from([0x30, 0x82, 0x04, 0x00]), Buffer.alloc(900, 7)]);
const CSR = pem(DER);
const SHA = createHash('sha256').update(DER).digest('hex');
const SANS01 = ['sqllnx01', 'sqllnx01.ad.3033.at', 'sqllnxag01', 'sqllnxag01.ad.3033.at'];
const ROH_ZERT = '-----BEGIN CERTIFICATE-----\nMIIBzert\n-----END CERTIFICATE-----\n';

function welt(antworten: object[]) {
  const aufrufe: Array<{ zugang: string; befehl: string; eingabe?: string; zweck: string }> = [];
  const gelesen: string[] = [];
  const skill = new WindowsPkiSkill({
    skript: async (zugang, befehl, eingabe, _t, zweck) => {
      aufrufe.push({ zugang, befehl, ...(eingabe !== undefined ? { eingabe } : {}), zweck });
      const a = antworten.shift();
      if (!a) throw new Error('keine Antwort');
      return { code: 0, stdout: ad(a), stderr: '' };
    },
    tresor: { namen: async () => new Set(['win-dc01-admin', 'ad-svc-pki-linuxreq']), lies: async n => { gelesen.push(n); return `geheim-${n}`; } },
  });
  return { skill, aufrufe, gelesen };
}

describe('I8e Etappe 3 Task 3 — Eingaben', () => {
  it('SANs je Host genau nach Global Constraints', () => {
    expect(linuxTlsSans('sqllnx01')).toEqual(SANS01);
    expect(linuxTlsSans('sqllnx02')).toEqual(['sqllnx02', 'sqllnx02.ad.3033.at', 'sqllnxag01', 'sqllnxag01.ad.3033.at']);
    expect(linuxTlsSans('sqllnxcfg')).toEqual(['sqllnxcfg', 'sqllnxcfg.ad.3033.at']);
    expect(linuxTlsSans('sql01')).toBeUndefined();
  });
  it('pruefeCsrForm: wohlgeformte PEM-Anforderung ja, Müll und > 8 KB nein', () => {
    expect(pruefeCsrForm(CSR)).toBeUndefined();
    expect(pruefeCsrForm(CSR.replace(/\n/g, '\r\n'))).toBeUndefined();
    expect(pruefeCsrForm('hallo')).toContain('csr_pem');
    expect(pruefeCsrForm('')).toContain('csr_pem');
    expect(pruefeCsrForm(CSR.replace('CERTIFICATE REQUEST', 'PRIVATE KEY'))).toContain('csr_pem');
    expect(pruefeCsrForm(CSR.replace(/\n[A-Za-z0-9+/]{10}/, '\n$$$$$$$$$$'))).toContain('csr_pem');
    expect(pruefeCsrForm(`${CSR}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`)).toContain('csr_pem');
    expect(pruefeCsrForm(pem(Buffer.from([0x02, ...Buffer.alloc(200, 1)])))).toContain('csr_pem');
    const gross = pem(Buffer.concat([Buffer.from([0x30, 0x82, 0x20, 0x00]), Buffer.alloc(6200, 7)]));
    expect(Buffer.byteLength(gross)).toBeGreaterThan(8192);
    expect(pruefeCsrForm(gross)).toContain('8 KB');
    expect(csrSha256(CSR)).toBe(SHA);
  });
  it('pruefeFremdAusstellung: CN aus den Linux-Hosts, SANs exakt (Reihenfolge egal), csr_sha256 Pflicht und passend', () => {
    const gut = { cn: 'sqllnx01.ad.3033.at', sans: [...SANS01].reverse(), csr_sha256: SHA, csr_pem: CSR };
    expect(pruefeFremdAusstellung(gut)).toMatchObject({ cn: 'sqllnx01.ad.3033.at', sans: SANS01, csr_sha256: SHA });
    expect(pruefeFremdAusstellung({ ...gut, csr_sha256: undefined })).toContain('csr_sha256');
    expect(pruefeFremdAusstellung({ ...gut, csr_sha256: 'abc' })).toContain('csr_sha256');
    expect(pruefeFremdAusstellung({ ...gut, csr_sha256: 'f'.repeat(64) })).toContain('passt nicht');
    expect(pruefeFremdAusstellung({ ...gut, sans: [...SANS01, 'extra.ad.3033.at'] })).toContain('sans');
    expect(pruefeFremdAusstellung({ ...gut, sans: SANS01.slice(1) })).toContain('sans');
    expect(pruefeFremdAusstellung({ ...gut, cn: 'sql01.ad.3033.at' })).toContain('cn');
    expect(pruefeFremdAusstellung({ ...gut, csr_pem: 'x' })).toContain('csr_pem');
  });
});

describe('I8e Etappe 3 Task 3 — Skripttexte', () => {
  it('Linux-Vorlage: Benutzer-Vorlage ohne CSP-Vorgabe, nur ServerAuth, Erneuerung 8 Wochen, Gruppe mit genau svc-pki-linuxreq', () => {
    const p = profilSqlTlsLinux('Dienstkonten');
    expect(p).toMatchObject({ eku: '1.3.6.1.5.5.7.3.1', csp: '', ueberlappungTage: 56, adminsRegistrieren: false, maschine: false, gruppe: { name: SQL_TLS_LINUX_GRUPPE, ou: 'Dienstkonten', mitglieder: ['svc-pki-linuxreq'] } });
    const s = vorlageAnlegenSkript({ vorlage: SQL_TLS_LINUX_VORLAGE, anzeige: SQL_TLS_LINUX_ANZEIGE, gueltig_tage: 365, schluessel_bits: 3072, profil: p }).replace(/''/g, "'");
    expect(s).toContain("if ($p.profil.csp) { $t.Put('pKIDefaultCSPs'");
    expect(s).toContain('"maschine":false');
    expect(s).toContain("'msPKI-Enrollment-Flag', 2");
    expect(s).toContain("'msPKI-Certificate-Name-Flag', 1");
  });
  it('fremd_csr_ausstellen: erst prüfen, dann als svc-pki-linuxreq einreichen, dann genehmigen und abholen; Geheimnisse nur über stdin', () => {
    const s = fremdAusstellenSkript({ cn: 'sqllnx01.ad.3033.at', sans: SANS01, csr_sha256: SHA });
    const t = s.replace(/''/g, "'");
    expect(t).toContain('[Console]::In.ReadLine()');
    expect(t).toContain('$e.kennwort'); expect(t).toContain('$e.csr_pem');
    expect(t).not.toContain('geheim');
    for (const x of ['X509Enrollment.CX509CertificateRequestPkcs10', 'CX509ExtensionAlternativeNames', 'statt Allowlist', 'SAN außer DNS', '1.2.840.113549.1.1.1', 'nichts eingereicht']) expect(t).toContain(x);
    // Reihenfolge: Hash/Inhalt prüfen → (ggf.) als svc-pki-linuxreq einreichen → genehmigen (bestehender Baustein, Anforderer exakt) → abholen
    const pruef = t.indexOf("Fehler (($gruende -join '; ')");
    const ein = t.indexOf('AlsBenutzer $p.anforderer $e.kennwort');
    expect(pruef).toBeGreaterThan(0); expect(ein).toBeGreaterThan(pruef);
    expect(t.indexOf('$sha -ne $p.csr_sha256')).toBeLessThan(ein);
    expect(t).toContain("-attrib ('CertificateTemplate:' + $p.vorlage)");
    expect(t).toContain(`"vorlage":"${SQL_TLS_LINUX_VORLAGE}"`);
    expect(t).toContain('"anforderer":"AD3033\\\\svc-pki-linuxreq"');
    expect(t.indexOf('NICHT genehmigt')).toBeGreaterThan(ein);
    expect(t.indexOf('NICHT genehmigt')).toBeLessThan(t.indexOf('-resubmit'));
    expect(t.indexOf('-resubmit')).toBeLessThan(t.indexOf('certreq.exe -retrieve'));
    expect(s).toContain("MitKonto 'SYSTEM' ''");
    // kein privater Schlüssel: nur CSR und Zertifikate
    expect(t).not.toMatch(/PRIVATE KEY/);
  });
  it('sql_tls_genehmigen unverändert für Windows-Knoten (Computerkonto), mit anforderer exakt', () => {
    const g = genehmigenSkript(pruefeGenehmigung({ request_id: 7, cn: 'sql01.ad.3033.at', sans: ['sql01.ad.3033.at'] }) as never).replace(/''/g, "'");
    expect(g).toContain('ist nicht das Computerkonto');
    expect(g).toContain("if ($p.anforderer) { if ($wer -ne [string]$p.anforderer)");
    expect(SQL_TLS_LINUX_ANFORDERER).toBe('AD3033\\svc-pki-linuxreq');
  });
  it('Fix 1 (ESC6): SAN in Anforderungsattributen und EDITF_ATTRIBUTESUBJECTALTNAME2 sind Befunde VOR Genehmigung bzw. Einreichen', () => {
    // gemeinsamer Genehmigungsteil (Windows und Linux): beide Prüfungen vor „NICHT genehmigt“ und vor -resubmit
    const g = genehmigenSkript(pruefeGenehmigung({ request_id: 7, cn: 'sql01.ad.3033.at', sans: ['sql01.ad.3033.at'] }) as never).replace(/''/g, "'");
    const attrSan = g.indexOf("if ($attr -match '(^|\\s|&)san:')"); const editf = g.indexOf('-band 0x40000');
    expect(attrSan).toBeGreaterThan(0); expect(editf).toBeGreaterThan(0);
    expect(g).toContain('EDITF_ATTRIBUTESUBJECTALTNAME2');
    expect(g).toContain("'\\PolicyModules'");
    for (const i of [attrSan, editf]) { expect(i).toBeLessThan(g.indexOf('NICHT genehmigt')); expect(i).toBeLessThan(g.indexOf('-resubmit')); }
    // Linux-Vorprüfung: Name-Wert-Paar SAN und EditFlags vor dem Einreichen als svc-pki-linuxreq
    const t = fremdAusstellenSkript({ cn: 'sqllnx01.ad.3033.at', sans: SANS01, csr_sha256: SHA }).replace(/''/g, "'");
    const nv = t.indexOf('$r.NameValuePairs'); const ef = t.indexOf('-band 0x40000'); const ein = t.indexOf('AlsBenutzer $p.anforderer $e.kennwort');
    expect(nv).toBeGreaterThan(0); expect(ef).toBeGreaterThan(0);
    expect(nv).toBeLessThan(t.indexOf("Fehler (($gruende -join '; ')")); expect(ef).toBeLessThan(t.indexOf("Fehler (($gruende -join '; ')"));
    expect(ef).toBeLessThan(ein);
    // und im Genehmigungsteil nach dem Einreichen erneut vor dem resubmit
    expect(t.indexOf("if ($attr -match '(^|\\s|&)san:')")).toBeLessThan(t.indexOf('-resubmit'));
    expect(t.lastIndexOf('-band 0x40000')).toBeLessThan(t.indexOf('-resubmit'));
    expect(t.lastIndexOf('-band 0x40000')).toBeGreaterThan(ein);
  });
  it('lesend vs. ändernd', () => {
    for (const a of ['sql_tls_linux_vorlage_anlegen', 'sql_tls_linux_vorlage_entfernen', 'fremd_csr_ausstellen']) expect(aktionsArt('windows_pki', a)).toBe('aendern');
  });
});

describe('I8e Etappe 3 Task 3 — Skill', () => {
  const eingabe = { action: 'fremd_csr_ausstellen', zugang: 'pkiiss01', cn: 'sqllnx01.ad.3033.at', sans: SANS01, csr_sha256: SHA, csr_pem: CSR };
  it('nur im Change', async () => {
    const w = welt([]);
    expect((await w.skill.execute(eingabe)).success).toBe(false);
    expect(w.aufrufe).toHaveLength(0);
  });
  it('ohne csr_sha256 → Validierungsfehler, kein Aufruf, Tresor nicht gelesen', async () => {
    const w = welt([]);
    const r = await w.skill.execute({ ...eingabe, csr_sha256: undefined }, ausChange);
    expect(r.success).toBe(false); expect(r.error).toContain('csr_sha256');
    expect(w.aufrufe).toHaveLength(0); expect(w.gelesen).toHaveLength(0);
  });
  it('SAN-Abweichung im Baustein → success:false, kein zweiter Aufruf', async () => {
    const w = welt([{ zustand: 'fehler', fehler: 'SAN sqllnx01,sqllnx01.ad.3033.at statt Allowlist sqllnx01,sqllnx01.ad.3033.at,sqllnxag01,sqllnxag01.ad.3033.at — nichts eingereicht' }, { zustand: 'ausgestellt' }]);
    const r = await w.skill.execute(eingabe, ausChange);
    expect(r.success).toBe(false); expect(r.error).toContain('SAN'); expect(r.error).toContain('NICHT');
    expect(w.aufrufe).toHaveLength(1);
  });
  it('Kennwort und CSR nur über stdin, nie im Skripttext', async () => {
    const w = welt([{ zustand: 'fehler', fehler: 'x' }]);
    await w.skill.execute(eingabe, ausChange);
    expect(w.gelesen).toEqual(['ad-svc-pki-linuxreq']);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'geheim-ad-svc-pki-linuxreq', csr_pem: CSR });
    const skript = roh(w.aufrufe[0]!.befehl);
    expect(skript).not.toContain('geheim-'); expect(skript).not.toContain(DER.toString('base64').slice(0, 40));
  });
  it('Ausgestellt: Anzeige mit Thumbprint und RequestId, ohne PEM-Block; PEMs in data', async () => {
    const tp = 'AB'.repeat(20);
    const w = welt([{ zustand: 'ausgestellt', requestId: 42, thumbprint: tp, gueltigBis: '2027-11-19T10:00:00', seriennummer: '1a2b', subjekt: 'CN=sqllnx01.ad.3033.at', sans: SANS01.join(','), eku: ['1.3.6.1.5.5.7.3.1'], glieder: 3, zertifikatPem: ROH_ZERT, kettePem: ROH_ZERT + ROH_ZERT }]);
    const r = await w.skill.execute(eingabe, ausChange);
    expect(r.success).toBe(true);
    expect(r.display).toContain('SQL_TLS_LINUX_ISSUED'); expect(r.display).toContain(tp); expect(r.display).toContain('42');
    expect(r.display).not.toContain('BEGIN CERTIFICATE');
    expect((r.data as Record<string, unknown>).zertifikatPem).toBe(ROH_ZERT);
    expect((r.data as Record<string, unknown>).kettePem).toBe(ROH_ZERT + ROH_ZERT);
    expect(w.aufrufe).toHaveLength(1);
  });
  it('Selbstprüfung des Ergebnisses: abweichende SANs/EKU oder fehlende Kette → success:false', async () => {
    const basis = { zustand: 'ausgestellt', requestId: 42, thumbprint: 'AB'.repeat(20), gueltigBis: '2027-11-19T10:00:00', seriennummer: '1a', subjekt: 'CN=sqllnx01.ad.3033.at', sans: SANS01.join(','), eku: ['1.3.6.1.5.5.7.3.1'], glieder: 3, zertifikatPem: ROH_ZERT, kettePem: ROH_ZERT + ROH_ZERT };
    for (const falsch of [{ sans: 'sqllnx01' }, { eku: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'] }, { kettePem: '' }, { zertifikatPem: '' }, { subjekt: 'CN=x' }]) {
      const r = await welt([{ ...basis, ...falsch }]).skill.execute(eingabe, ausChange);
      expect(r.success, JSON.stringify(falsch)).toBe(false);
    }
  });
  it('Linux-Vorlage: SQL_TLS_LINUX_TEMPLATE_OK ohne CSP/KeySpec/Export-Befunde; Gruppe genau svc-pki-linuxreq; nichts zu breit', async () => {
    const r0 = { zustand: 'angelegt', flags: 131616, vorlage: SQL_TLS_LINUX_VORLAGE, anzeige: SQL_TLS_LINUX_ANZEIGE, oid: '1.2', ca: 'CA', aufCa: true, registrieren: ['AD3033\\Enterprise Admins', `AD3033\\${SQL_TLS_LINUX_GRUPPE}`], namensFlag: 1, anmeldeFlag: 2, minSchluessel: 3072, eku: ['1.3.6.1.5.5.7.3.1'], keySpec: 1, csp: [], privatFlag: 0x10, gruppeMitglieder: ['svc-pki-linuxreq'] };
    const p = { action: 'sql_tls_linux_vorlage_anlegen', zugang: 'pkiiss01' };
    const ok = await welt([r0]).skill.execute(p, ausChange);
    expect(ok.success).toBe(true); expect(ok.display).toContain('SQL_TLS_LINUX_TEMPLATE_OK');
    const w = welt([r0]); await w.skill.execute(p, ausChange);
    const s = roh(w.aufrufe[0]!.befehl).replace(/''/g, "'");
    expect(s).toContain(`"vorlage":"${SQL_TLS_LINUX_VORLAGE}"`); expect(s).toContain(`"anzeige":"${SQL_TLS_LINUX_ANZEIGE}"`); expect(s).toContain('"gueltig_tage":365');
    expect(s).toContain('"mitglieder":["svc-pki-linuxreq"]');
    for (const [falsch, text] of [
      [{ gruppeMitglieder: ['svc-pki-linuxreq', 'svc-anderes'] }, 'Gruppe'],
      [{ registrieren: [...r0.registrieren, 'NT AUTHORITY\\Authenticated Users'] }, 'ZU BREIT'],
      [{ eku: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'] }, 'EKU'],
      [{ anmeldeFlag: 0 }, 'CA-Freigabe'],
      [{ minSchluessel: 2048 }, 'Mindestschlüssel'],
      [{ flags: 131680 }, 'Computer-Vorlage'],
      [{ registrieren: ['AD3033\\Enterprise Admins'] }, 'darf nicht registrieren'],
    ] as const) {
      const f = await welt([{ ...r0, ...falsch }]).skill.execute(p, ausChange);
      expect(f.success, text).toBe(false); expect(f.error).toContain(text);
    }
  });
  it('Fix 2: Linux-Vorlage nur mit Mindestschlüssel 3072 (und 365 Tagen) — andere Angaben abgewiesen, kein Aufruf', async () => {
    for (const x of [{ schluessel_bits: 4096 }, { schluessel_bits: 2048 }, { gueltig_tage: 730 }]) {
      const w = welt([]);
      const r = await w.skill.execute({ action: 'sql_tls_linux_vorlage_anlegen', zugang: 'pkiiss01', ...x }, ausChange);
      expect(r.success, JSON.stringify(x)).toBe(false); expect(r.error).toContain('fest');
      expect(w.aufrufe).toHaveLength(0);
    }
    const w = welt([{ zustand: 'angelegt', flags: 131616, vorlage: SQL_TLS_LINUX_VORLAGE, anzeige: SQL_TLS_LINUX_ANZEIGE, oid: '1.2', ca: 'CA', aufCa: true, registrieren: [`AD3033\\${SQL_TLS_LINUX_GRUPPE}`], namensFlag: 1, anmeldeFlag: 2, minSchluessel: 3072, eku: ['1.3.6.1.5.5.7.3.1'], keySpec: 1, csp: [], privatFlag: 0, gruppeMitglieder: ['svc-pki-linuxreq'] }]);
    expect((await w.skill.execute({ action: 'sql_tls_linux_vorlage_anlegen', zugang: 'pkiiss01', schluessel_bits: 3072 }, ausChange)).success).toBe(true);
    expect(roh(w.aufrufe[0]!.befehl)).toContain('"schluessel_bits":3072');
  });
  it('Linux-Vorlage entfernen (Rückweg)', async () => {
    const w = welt([{ vorlage: SQL_TLS_LINUX_VORLAGE, vonCa: true, geloescht: true, oidWeg: true, nochDa: false }]);
    const r = await w.skill.execute({ action: 'sql_tls_linux_vorlage_entfernen', zugang: 'pkiiss01' }, ausChange);
    expect(r.display).toContain('SQL_TLS_LINUX_TEMPLATE_REMOVED');
    expect(roh(w.aufrufe[0]!.befehl).replace(/''/g, "'")).toContain(`"anzeige":"${SQL_TLS_LINUX_ANZEIGE}"`);
  });
});

// PowerShell-Parser (Windows PowerShell 5.1), wenn vorhanden: jedes neue Skript ist syntaktisch gültig (gemeinsame Testhilfe, Skripte als Datei)
const POWERSHELL = powershellVorhanden();
/** Skript und die darin eingebetteten inneren Skripte (psText-Literale mit param([string]$aus)) einzeln parsen */
function innere(s: string): string[] {
  const funde: string[] = [];
  for (const m of s.matchAll(/'param\(\[string\]\$aus\)((?:[^']|'')*)'/g)) funde.push(`param([string]$aus)${m[1]!.replace(/''/g, "'")}`);
  return funde;
}
describe.skipIf(!POWERSHELL)('I8e Etappe 3 Task 3 — PowerShell-Parser', () => {
  it('alle neuen Bausteine (samt inneren Skripten) ohne Parserfehler', () => {
    const fremd = fremdAusstellenSkript({ cn: 'sqllnx01.ad.3033.at', sans: SANS01, csr_sha256: SHA });
    const vorlage = vorlageAnlegenSkript({ vorlage: SQL_TLS_LINUX_VORLAGE, anzeige: SQL_TLS_LINUX_ANZEIGE, gueltig_tage: 365, schluessel_bits: 3072, profil: profilSqlTlsLinux('Dienstkonten') });
    const genehmigen = genehmigenSkript(pruefeGenehmigung({ request_id: 7, cn: 'sql01.ad.3033.at', sans: ['sql01.ad.3033.at'] }) as never);
    const skripte: Record<string, string> = { fremd, vorlage, genehmigen, entfernen: vorlageEntfernenSkript({ vorlage: SQL_TLS_LINUX_VORLAGE, anzeige: SQL_TLS_LINUX_ANZEIGE }) };
    for (const [n, s] of Object.entries({ fremd, vorlage, genehmigen })) innere(s).forEach((x, i) => { skripte[`${n}-innen${i}`] = x; });
    expect(innere(fremd).length).toBe(3);
    const p = parseSkripte(skripte);
    expect(p.gegenprobeErkannt, `Gegenprobe (fehlerhaftes Skript) nicht erkannt: ${p.roh}`).toBe(true);
    for (const [name, ergebnis] of Object.entries(p.ergebnisse)) expect(ergebnis, name).toBe('OK');
  }, 60_000);
});
