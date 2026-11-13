import { describe, it, expect } from 'vitest';
import { anforderungInf, pruefeAnforderung, pruefeGenehmigung, genehmigenSkript, anfordernSkript, installierenSkript, erneuerungStatusSkript, bewerteZertifikat, warnstufe, SQL_TLS_PROVIDER, type ZertifikatBefund } from './windows-sqltls.js';
import { vorlageAnlegenSkript, profilSqlTls } from './windows-codesignatur.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';
import { aktionsArt } from './change-schritte.js';

// Etappe 3b — Spec 252217f3 Pos. 11–15
const SANS = ['sql01.ad.3033.at', 'sql02.ad.3033.at', 'sqlag01.ad.3033.at', 'sql01', 'sql02', 'sqlag01'];
const CA = 'pkiiss01.ad.3033.at\\AD3033 Issuing CA 01';
const ausChange = { ausChange: true } as never;
const ad = (o: unknown) => `ALFRED-AD ${JSON.stringify(o)}\n`;

describe('Etappe 3b SQL-TLS — Bausteine', () => {
  it('Anforderung: nur DNS-Namen, eigener FQDN enthalten, CA-Konfiguration', () => {
    expect(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: SANS, ca: CA })).toMatchObject({ vorlage: 'AD3033-SQL-TLS-v1', erneuerung: false });
    expect(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: ['*.ad.3033.at'], ca: CA })).toContain('sans');
    expect(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: ['sql02.ad.3033.at'], ca: CA })).toContain('eigene Knoten-FQDN');
    expect(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: SANS, ca: 'pkiiss01' })).toContain('ca:');
  });
  it('INF nach Spec: SChannel-CSP, AT_KEYEXCHANGE, 3072, nicht exportierbar, Maschinenschlüssel, nur ServerAuth, SAN-Allowlist, Vorlage', () => {
    const inf = anforderungInf({ vorlage: 'AD3033-SQL-TLS-v1', cn: 'sql01.ad.3033.at', sans: SANS });
    for (const t of ['Subject = "CN=sql01.ad.3033.at"', 'KeyLength = 3072', 'KeySpec = 1', 'Exportable = FALSE', 'MachineKeySet = TRUE', `ProviderName = "${SQL_TLS_PROVIDER}"`, 'KeyUsage = 0xa0', 'OID=1.3.6.1.5.5.7.3.1']) expect(inf).toContain(t);
    expect(inf).not.toContain('RequestAttributes'); // v1854 — Vorlage erst beim Einreichen
    expect(inf).toContain('2.5.29.17 = "{text}dns=sql01.ad.3033.at&dns=sql02.ad.3033.at&dns=sqlag01.ad.3033.at&dns=sql01&dns=sql02&dns=sqlag01"');
    expect(inf).toContain('\r\n');
  });
  it('Anfordern als SYSTEM mit frischem Computer-Ticket; RequestId wird gemerkt', () => {
    const roh = anfordernSkript(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: SANS, ca: CA }) as never);
    expect(roh).toContain("MitKonto 'SYSTEM' ''");
    const s = roh.replace(/''/g, "'");
    expect(s.indexOf('klist.exe -li 0x3e7 purge')).toBeLessThan(s.indexOf('certreq.exe -submit'));
    expect(s).toContain('sqltls-anforderung.json');
  });
  it('Genehmigen: Anforderer, Vorlage, Subject, Bits, nur DNS und genau die Allowlist — erst dann resubmit', () => {
    const g = pruefeGenehmigung({ request_id: 7, cn: 'sql01.ad.3033.at', sans: SANS });
    const s = genehmigenSkript(g as never).replace(/''/g, "'");
    for (const t of ['CertificateAuthority.View', 'Request.RawRequest', 'X509Enrollment.CX509CertificateRequestPkcs10', 'CX509ExtensionAlternativeNames', 'ist nicht das Computerkonto', 'statt Allowlist', 'SAN außer DNS']) expect(s).toContain(t);
    expect(s.indexOf('NICHT genehmigt')).toBeLessThan(s.indexOf('-resubmit'));
    expect(pruefeGenehmigung({ request_id: 0, cn: 'sql01.ad.3033.at', sans: SANS })).toContain('request_id');
  });
  it('Installieren: abholen, annehmen, Engine-Konto Lesen auf genau den Schlüssel', () => {
    const s = installierenSkript({ request_id: 7, ca: CA, cn: 'sql01.ad.3033.at', dienstkonto: 'AD3033\\gmsa-sqleng$' }).replace(/''/g, "'");
    for (const t of ['certreq.exe -retrieve -f -q', 'certreq.exe -accept -q -machine', 'UniqueKeyContainerName', 'MachineKeys', 'FileSystemRights]::Read']) expect(s).toContain(t);
  });
  it('Vorlage SQL-TLS: Profil über $p, Gruppe nur mit den vorgesehenen Computerkonten', () => {
    const s = vorlageAnlegenSkript({ vorlage: 'AD3033-SQL-TLS-v1', anzeige: 'AD3033 SQL TLS v1', gueltig_tage: 365, schluessel_bits: 3072, profil: profilSqlTls({ name: 'PKI-SQL-TLS-Registrieren', ou: 'Server', mitglieder: ['SQL01$', 'SQL02$'] }) }).replace(/''/g, "'");
    for (const t of ['"eku":"1.3.6.1.5.5.7.3.1"', '"keySpec":1', 'Microsoft RSA SChannel Cryptographic Provider', '"ueberlappungTage":56', '"adminsRegistrieren":false', 'hat weitere Mitglieder', "'msPKI-Enrollment-Flag', 2", "'msPKI-Private-Key-Flag', 0"]) expect(s).toContain(t);
  });
  it('Lesend vs. ändernd', () => {
    expect(aktionsArt('windows_pki', 'zertifikat_pruefen')).toBe('lesen');
    expect(aktionsArt('windows_pki', 'erneuerung_status')).toBe('lesen');
    expect(aktionsArt('windows_pki', 'sql_tls_genehmigen')).toBe('aendern');
  });
});

describe('Etappe 3b SQL-TLS — Zertifikatsprüfung (Pos. 13) und Warnstufen (Pos. 15)', () => {
  const gut: ZertifikatBefund = { gefunden: true, rechner: 'SQL01', zeit: 't', subjekt: 'CN=sql01.ad.3033.at', sans: [...SANS], eku: ['1.3.6.1.5.5.7.3.1'], ku: 'KeyEncipherment, DigitalSignature', anbieter: SQL_TLS_PROVIDER, keySpec: 'Exchange', exportierbar: false, bits: 3072, privat: true, von: '2026-11-13T10:00:00', bis: '2027-11-13T10:00:00', kette: true, kettenStatus: [], glieder: ['a', 'b', 'c'], cdp: 'URL=http://pki.ad.3033.at/pki/ad3033-issuing1.crl' };
  const e = { subjekt: 'CN=sql01.ad.3033.at', sans: SANS, eku: '1.3.6.1.5.5.7.3.1', anbieter: SQL_TLS_PROVIDER, keySpec: 'Exchange', bits: 3072 };
  const jetzt = new Date('2026-12-01T00:00:00Z');
  it('alles passend = CERT_VALID', () => { expect(bewerteZertifikat(gut, e, jetzt)).toEqual({ ok: true, gruende: [] }); });
  it('jede Abweichung ist ein Befund; offline/unbekannt ist kein OK', () => {
    expect(bewerteZertifikat({ ...gut, sans: [...SANS, 'extra'] }, e, jetzt).gruende[0]).toContain('SAN');
    expect(bewerteZertifikat({ ...gut, exportierbar: true }, e, jetzt).ok).toBe(false);
    expect(bewerteZertifikat({ ...gut, exportierbar: null }, e, jetzt).ok).toBe(false);
    expect(bewerteZertifikat({ ...gut, eku: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'] }, e, jetzt).ok).toBe(false);
    expect(bewerteZertifikat({ ...gut, kettenStatus: ['RevocationStatusUnknown', 'OfflineRevocation'] }, e, jetzt).gruende.join()).toContain('OfflineRevocation');
    expect(bewerteZertifikat({ ...gut, anbieter: 'Microsoft Software Key Storage Provider' }, e, jetzt).ok).toBe(false);
    expect(bewerteZertifikat({ ...gut, ku: 'DigitalSignature' }, e, jetzt).ok).toBe(false);
    expect(bewerteZertifikat({ gefunden: false, rechner: 'x', zeit: 't' }, e, jetzt).ok).toBe(false);
  });
  it('Warnstufen 90/60/30/14', () => {
    expect(warnstufe(200)).toBeNull(); expect(warnstufe(80)).toBe(90); expect(warnstufe(45)).toBe(60); expect(warnstufe(20)).toBe(30); expect(warnstufe(3)).toBe(14);
  });
});

describe('Etappe 3b SQL-TLS — Skill', () => {
  it('Vorlage: SQL_TLS_TEMPLATE_OK nur mit Gruppe, ohne breite Gruppen, nicht exportierbar, SChannel', async () => {
    let r: Record<string, unknown> = { zustand: 'angelegt', flags: 131680, vorlage: 'AD3033-SQL-TLS-v1', anzeige: 'AD3033 SQL TLS v1', oid: '1.2', ca: 'CA', aufCa: true, registrieren: ['AD3033\\Enterprise Admins', 'AD3033\\PKI-SQL-TLS-Registrieren'], namensFlag: 1, anmeldeFlag: 2, minSchluessel: 3072, eku: ['1.3.6.1.5.5.7.3.1'], keySpec: 1, csp: ['1,Microsoft RSA SChannel Cryptographic Provider'], privatFlag: 0, gruppeMitglieder: ['SQL01$', 'SQL02$'] };
    const skill = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: ad(r), stderr: '' }), tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async () => 'pw' } });
    const p = { action: 'sql_tls_vorlage_anlegen', zugang: 'pkiiss01' };
    expect((await skill.execute(p, ausChange)).display).toContain('SQL_TLS_TEMPLATE_OK');
    r = { ...r, privatFlag: 0x10, registrieren: [...(r.registrieren as string[]), 'NT AUTHORITY\\Authenticated Users'] };
    const f = await skill.execute(p, ausChange);
    expect(f.success).toBe(false); expect(f.error).toContain('exportierbar'); expect(f.error).toContain('ZU BREIT');
  });
  it('zertifikat_pruefen bewertet den Befund des Knotens', async () => {
    const befund = { gefunden: true, rechner: 'SQL01', zeit: 't', subjekt: 'CN=sql01.ad.3033.at', sans: SANS, eku: ['1.3.6.1.5.5.7.3.1'], ku: 'KeyEncipherment, DigitalSignature', anbieter: SQL_TLS_PROVIDER, keySpec: 'Exchange', exportierbar: false, bits: 3072, privat: true, von: '2026-01-01T00:00:00', bis: '2099-01-01T00:00:00', kette: true, kettenStatus: [], glieder: ['a', 'b', 'c'], cdp: 'URL=http://x' };
    const skill = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: ad(befund), stderr: '' }) });
    const r = await skill.execute({ action: 'zertifikat_pruefen', zugang: 'sql01', thumbprint: 'A'.repeat(40), cn: 'sql01.ad.3033.at', sans: SANS });
    expect(r.display).toContain('CERT_VALID');
  });
});

describe('v1853 erneuerung_status mit Erwartung', () => {
  it('erwartet_zertifikat false/true schlägt bei Abweichung fehl', async () => {
    let zert: unknown[] = [];
    const skill = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: ad({ rechner: 'SQL01', zeit: 't', zertifikate: zert, offeneAnforderung: null }), stderr: '' }) });
    expect((await skill.execute({ action: 'erneuerung_status', zugaenge: ['sql01'], erwartet_zertifikat: false })).success).toBe(true);
    expect((await skill.execute({ action: 'erneuerung_status', zugaenge: ['sql01'], erwartet_zertifikat: true })).error).toContain('Zertifikat erwartet');
    zert = [{ thumbprint: 'A'.repeat(40), subjekt: 'CN=sql01.ad.3033.at', bis: '2027-11-13T00:00:00', tage: 364 }];
    expect((await skill.execute({ action: 'erneuerung_status', zugaenge: ['sql01'], erwartet_zertifikat: true })).success).toBe(true);
    expect((await skill.execute({ action: 'erneuerung_status', zugaenge: ['sql01'], erwartet_zertifikat: false })).success).toBe(false);
  });
});

describe('v1854 Computer-Vorlage und Vorlage beim Einreichen', () => {
  it('SQL-TLS-Profil setzt 0x40, vorhandene Vorlage wird nur im Kennzeichen angeglichen; Einreichen mit -attrib', () => {
    const s = vorlageAnlegenSkript({ vorlage: 'AD3033-SQL-TLS-v1', anzeige: 'AD3033 SQL TLS v1', gueltig_tage: 365, schluessel_bits: 3072, profil: profilSqlTls({ name: 'G', ou: 'Server', mitglieder: ['SQL01$'] }) }).replace(/''/g, "'");
    expect(s).toContain('"maschine":true');
    expect(s).toContain('$sollFlags = 131616 -bor $(if ($p.profil.maschine) { 0x40 } else { 0 })');
    expect(s).toContain("if ([int]$t.flags.Value -ne $sollFlags)");
    const a = anfordernSkript(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: SANS, ca: CA }) as never).replace(/''/g, "'");
    expect(a).toContain("-attrib ('CertificateTemplate:' + $p.vorlage)");
  });
  it('v1855: Zertifikat der Vorlage wird über technischen Namen ODER Anzeigenamen erkannt (Windows zeigt den Anzeigenamen)', () => {
    const treffer = "-replace '^Template=([^(]*)\\(.*$', '$1').Trim() -in @($p.vorlage, ($p.vorlage -replace '-', ' '))";
    expect(erneuerungStatusSkript({ vorlage: 'AD3033-SQL-TLS-v1' })).toContain(treffer);
    const a = anfordernSkript(pruefeAnforderung({ cn: 'sql01.ad.3033.at', sans: SANS, ca: CA }) as never).replace(/''/g, "'");
    expect(a).toContain(treffer);
    expect(a).not.toContain('-match [regex]::Escape($p.vorlage)');
    // Realfall-Format von sql01: dieselbe Regel in JS nachgebildet
    const format = 'Template=AD3033 SQL TLS v1(1.3.6.1.4.1.311.21.8.15542962.14400190), Major Version Number=100, Minor Version Number=2';
    const name = format.replace(/^Template=([^(]*)\(.*$/, '$1').trim();
    expect(['AD3033-SQL-TLS-v1', 'AD3033 SQL TLS v1']).toContain(name);
  });
  it('Vorlage ohne Computer-Kennzeichen ist ein Befund', async () => {
    const r = { zustand: 'schon vorhanden', flags: 131616, vorlage: 'AD3033-SQL-TLS-v1', anzeige: 'AD3033 SQL TLS v1', oid: '1.2', ca: 'CA', aufCa: true, registrieren: ['AD3033\PKI-SQL-TLS-Registrieren'], namensFlag: 1, anmeldeFlag: 2, minSchluessel: 3072, eku: ['1.3.6.1.5.5.7.3.1'], keySpec: 1, csp: ['1,Microsoft RSA SChannel Cryptographic Provider'], privatFlag: 0, gruppeMitglieder: ['SQL01$', 'SQL02$'] };
    const skill = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: ad(r), stderr: '' }), tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async () => 'pw' } });
    const f = await skill.execute({ action: 'sql_tls_vorlage_anlegen', zugang: 'pkiiss01' }, ausChange);
    expect(f.error).toContain('keine Computer-Vorlage');
  });
});
