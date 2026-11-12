import { describe, it, expect } from 'vitest';
import { pkiStatusSkript, pkiStatusText } from './windows-pki.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';

describe('v1810 windows_pki status', () => {
  it('liest CA-Konfiguration aus der Registry und das CA-Zertifikat mit pathLen', () => {
    const s = pkiStatusSkript();
    expect(s).toContain('CertSvc\\Configuration');
    expect(s).toContain("'2.5.29.19'");
    expect(s).toContain('PhysicalAdapter=TRUE');
  });
  it('Text: keine CA vs. PKI_STATUS_OK', () => {
    const basis = { rechner: 'PKIROOT01', domaene: '', workgroup: 'WORKGROUP', netzwerkkarten: [], jetzt: '2026-11-12T12:00:00', feature: false, dienst: 'fehlt', zustand: 'keine CA', ca: null };
    expect(pkiStatusText(basis, 'gastagent')).toContain('keine Netzwerkkarte, über Gastagent');
    const mit = { ...basis, feature: true, dienst: 'Running', zustand: 'CA läuft', ca: { name: 'AD3033 Root CA', typ: 'StandaloneRoot', crlPeriode: '26 Weeks', crlUeberlappung: '4 Weeks', deltaCrl: '0 Days', gueltigkeitAusgestellt: '10 Years', cdp: ['http://pki.ad.3033.at/pki/root.crl'], aia: [], crlDateien: [],
      zertifikat: { thumbprint: 'AB', subject: 'CN=AD3033 Root CA', aussteller: 'CN=AD3033 Root CA', von: 'a', bis: 'b', schluessel: 'RSA 4096', signatur: 'sha256RSA', pathLen: '1', kette: ['CN=AD3033 Root CA'], ketteOk: true, privaterSchluessel: true } } };
    const t = pkiStatusText(mit, 'gastagent');
    expect(t.startsWith('PKI_STATUS_OK')).toBe(true);
    expect(t).toContain('pathLen 1');
  });
  it('verlangt genau einen Weg und beim Gastagenten den VM-Namen', async () => {
    const sk = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }), gast: async () => ({ code: 0, stdout: 'ALFRED-AD {"rechner":"X","domaene":"","workgroup":"W","netzwerkkarten":[],"jetzt":"t","feature":false,"dienst":"fehlt","zustand":"keine CA","ca":null}', stderr: '' }) });
    expect((await sk.execute({ action: 'status' })).error).toContain('entweder zugang');
    expect((await sk.execute({ action: 'status', zugang: 'pkiiss01', vmid: 150, vm_name: 'pkiroot01' })).error).toContain('entweder zugang');
    expect((await sk.execute({ action: 'status', vmid: 150 })).error).toContain('vm_name');
    const r = await sk.execute({ action: 'status', vmid: 150, vm_name: 'pkiroot01' });
    expect(r.success).toBe(true);
    expect(r.display).toContain('über Gastagent');
  });
});

describe('v1812 Rolle, Offline-Root, Artefakte', () => {
  it('Root-Parameter: Standardwerte aus f583a405 und Grenzen', async () => {
    const { pruefeRoot } = await import('./windows-pki.js');
    const r = pruefeRoot({ ca_name: 'AD3033 Root CA' });
    expect(r).toEqual({ ca_name: 'AD3033 Root CA', key_bits: 4096, hash: 'SHA256', validity_years: 20, path_length: 1, crl_wochen: 26, crl_ueberlappung_wochen: 4, ausgestellt_jahre: 10 });
    expect(typeof pruefeRoot({ ca_name: 'CN=x,O=y' })).toBe('string');
    expect(typeof pruefeRoot({ ca_name: 'AD3033 Root CA', ausgestellt_jahre: 20 })).toBe('string');
    expect(typeof pruefeRoot({ ca_name: 'AD3033 Root CA', key_bits: 2048 })).toBe('string');
  });
  it('Root-Skript bricht bei Netzwerkkarte, Domäne oder fremder CA ab; CAPolicy ohne CDP/AIA mit kritischem pathLen', async () => {
    const { pruefeRoot, rootInitSkript, rootCapolicy } = await import('./windows-pki.js');
    const r = pruefeRoot({ ca_name: 'AD3033 Root CA' }) as Exclude<ReturnType<typeof pruefeRoot>, string>;
    const s = rootInitSkript(r);
    expect(s).toContain("Offline-Root nur OHNE Netzwerkkarte");
    expect(s).toContain("if ($cs.PartOfDomain)");
    expect(s).toContain("CAType = 'StandaloneRootCA'");
    expect(s.indexOf('PhysicalAdapter=TRUE')).toBeLessThan(s.indexOf('Install-AdcsCertificationAuthority'));
    const c = rootCapolicy(r);
    expect(c).toContain('PathLength=1');
    expect(c).toContain('Critical=Yes');
    expect(c).not.toMatch(/CDP|AIA|URL/i);
  });
  it('Skill: ändernde Aktionen nur im Change, root_initialisieren nur über den Gastagenten', async () => {
    const { WindowsPkiSkill } = await import('./windows-pki-skill.js');
    const sk = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    expect((await sk.execute({ action: 'root_initialisieren', vmid: 150, vm_name: 'pkiroot01', ca_name: 'AD3033 Root CA' })).error).toContain('nur als Schritt');
    expect((await sk.execute({ action: 'root_initialisieren', zugang: 'pkiroot01', ca_name: 'AD3033 Root CA' }, { ausChange: true } as never)).error).toContain('nur über den Gastagenten');
  });
});

describe('v1812 Issuing-Kette', () => {
  it('Publikation: lokal + HTTP (+ UNC), kein LDAP; Rückweg roh; Grenzen', async () => {
    const { pruefePublikation } = await import('./windows-pki.js');
    const p = pruefePublikation({ datei_name: 'ad3033-root', http_basis: 'http://pki.ad.3033.at/pki/' });
    expect(p).toEqual({ cdp: ['1:%windir%\\system32\\CertSrv\\CertEnroll\\ad3033-root%8%9.crl', '2:http://pki.ad.3033.at/pki/ad3033-root%8%9.crl'], aia: ['1:%windir%\\system32\\CertSrv\\CertEnroll\\ad3033-root%4.crt', '2:http://pki.ad.3033.at/pki/ad3033-root%4.crt'] });
    expect(JSON.stringify(p)).not.toMatch(/ldap/i);
    const u = pruefePublikation({ datei_name: 'ad3033-issuing1', http_basis: 'http://pki.ad.3033.at/pki/', unc_ziel: '\\\\fs01.ad.3033.at\\pki$\\', crl_einheit: 'Days', crl_anzahl: 1, ueberlappung_einheit: 'Days', ueberlappung_anzahl: 6 }) as { cdp: string[]; crl: unknown };
    expect(u.cdp[2]).toBe('1:file://\\\\fs01.ad.3033.at\\pki$\\ad3033-issuing1%8%9.crl');
    expect(u.crl).toEqual({ periode: 'Days', anzahl: 1, ueberlappungPeriode: 'Days', ueberlappungAnzahl: 6 });
    expect(pruefePublikation({ cdp_roh: ['1:C:\\x.crl'], aia_roh: ['2:http://a/b.crt'] })).toEqual({ cdp: ['1:C:\\x.crl'], aia: ['2:http://a/b.crt'] });
    expect(typeof pruefePublikation({ datei_name: 'AD 3033', http_basis: 'http://pki.ad.3033.at/pki/' })).toBe('string');
    expect(typeof pruefePublikation({ datei_name: 'x1', http_basis: 'https://pki/' })).toBe('string');
  });
  it('Signieren: Hash, Subject und pathLen werden geprüft; Base64 nur über stdin', async () => {
    const { pruefeSignieren, signierenSkript, pruefeAktivieren, aktivierenSkript, issuerAnfordernSkript, pruefeIssuer, issuerCapolicy } = await import('./windows-pki.js');
    const sha = 'a'.repeat(64);
    expect(typeof pruefeSignieren({ erwartet_csr_sha256: 'x', erwartet_subject: 'AD3033 Issuing CA 1', csr_base64: 'A'.repeat(200) })).toBe('string');
    const sp = pruefeSignieren({ erwartet_csr_sha256: sha, erwartet_subject: 'AD3033 Issuing CA 1', csr_base64: 'A'.repeat(200) }) as never;
    const s = signierenSkript(sp);
    expect(s).toContain('$e.csr_base64');
    expect(s).not.toContain('AAAAAAAAAA');
    expect(s).toContain("if ((Hex $der) -ne $p.erwartet_csr_sha256)");
    expect(s).toContain('Zertifikat NICHT übergeben');
    expect(typeof pruefeAktivieren({ erwartet_zert_sha256: sha, erwartet_root_sha256: sha, erwartet_crl_sha256: 'kurz', zert_base64: 'A'.repeat(200), root_base64: 'A'.repeat(200), crl_base64: 'A'.repeat(200) })).toBe('string');
    const ap = pruefeAktivieren({ erwartet_zert_sha256: sha, erwartet_root_sha256: sha, erwartet_crl_sha256: sha, zert_base64: 'A'.repeat(200), root_base64: 'A'.repeat(200), crl_base64: 'A'.repeat(200) }) as never;
    expect(aktivierenSkript(ap)).toContain('-addstore Root $cd');
    const ip = pruefeIssuer({ ca_name: 'AD3033 Issuing CA 1' }) as never;
    expect(issuerAnfordernSkript(ip)).toContain('-CAType EnterpriseSubordinateCA');
    expect(issuerAnfordernSkript(ip)).toContain('$e.kennwort');
    expect(issuerCapolicy(ip)).toContain('LoadDefaultTemplates=0');
    expect(typeof pruefeIssuer({ ca_name: 'AD3033 Issuing CA 1', path_length: 1 })).toBe('string');
  });
});

describe('v1813 Veröffentlichung, AD und Vertrauen', () => {
  it('Web, Ablage und Abruf prüfen Eingaben; Ablage nur über stdin und ohne ältere CRL', async () => {
    const { pruefeWeb, webSkript, pruefeAblage, ablageSkript, abrufSkript } = await import('./windows-pki.js');
    expect(typeof pruefeWeb({ host_header: 'pki', pfad: 'W:\\PKI' })).toBe('string');
    const w = pruefeWeb({ host_header: 'pki.ad.3033.at', pfad: 'W:\\PKI' }) as never;
    expect(webSkript(w)).toContain('/allowDoubleEscaping:true');
    expect(webSkript(w)).toContain("'S-1-5-17'");
    expect(typeof pruefeAblage({ ordner: 'W:\\PKI', datei: '..\\x.crl', erwartet_sha256: 'a'.repeat(64), base64: 'A'.repeat(200) })).toBe('string');
    const a = pruefeAblage({ ordner: 'W:\\PKI', datei: 'ad3033-root.crl', erwartet_sha256: 'a'.repeat(64), base64: 'A'.repeat(200) }) as never;
    const s = ablageSkript(a);
    expect(s).toContain('$e.base64');
    expect(s).toContain('ist älter als die veröffentlichte');
    expect(abrufSkript({ urls: ['http://pki.ad.3033.at/pki/ad3033-root.crl'], erwartet: {} })).toContain('-MaximumRedirection 0');
  });
  it('AD-Veröffentlichung als Enterprise Admin per Kennwort-Anmeldung, ohne NTAuth und ohne CRL', async () => {
    const { adVeroeffentlichenSkript } = await import('./windows-pki.js');
    const s = adVeroeffentlichenSkript({ dcs: ['dc01.ad.3033.at'], erwartet_root_sha256: 'a'.repeat(64), mit_sub: false });
    expect(s).toContain('MitKonto');
    expect(s).toContain('-dspublish -f $rd RootCA');
    expect(s).not.toMatch(/NTAuthCA|dspublish[^\n]*\.crl/);
  });
});

describe('v1814 CA-Sicherung und Issuer-Pfade', () => {
  it('Issuer-Pfade nur auf Datenplatten; Sicherung mit Manifest, Kennwort nur über stdin', async () => {
    const m = await import('./windows-pki.js');
    expect(m.pruefeIssuer({ ca_name: 'AD3033 Issuing CA 01', db_pfad: 'D:\\CertDB', log_pfad: 'D:\\CertLog' })).toMatchObject({ db_pfad: 'D:\\CertDB', log_pfad: 'D:\\CertLog' });
    expect(typeof m.pruefeIssuer({ ca_name: 'AD3033 Issuing CA 01', db_pfad: 'C:\\CertDB' })).toBe('string');
    expect(m.issuerAnfordernSkript(m.pruefeIssuer({ ca_name: 'AD3033 Issuing CA 01', db_pfad: 'D:\\CertDB' }) as never)).toContain('@pfade');
    expect(typeof m.pruefeSicherungsziel({ ziel_ordner: 'C:\\Sicherung' })).toBe('string');
    const s = m.caSicherungSkript({ ziel_ordner: 'B:\\CA-Sicherung' });
    expect(s).toContain('Backup-CARoleService -Path $d -Password $pw');
    expect(s).toContain('$e.kennwort');
    expect(s).toContain("Sicherung ohne Schlüsseldatei (.p12)");
    expect(m.caSatzAblegenSkript({ ziel_ordner: 'S:\\PKI-Sicherung', satz: 'ca-20261112-120000', sha256: 'a'.repeat(64) })).toContain("Kopie unvollständig");
    expect(m.CA_SATZ.test('ca-20261112-120000')).toBe(true);
    expect(m.CA_SATZ.test('..\\x')).toBe(false);
  });
});

describe('v1816 Offline-Root ohne Netzwerkkarte', () => {
  it('lokale Datenbank-/Logpfade, halbe CA ist nicht „schon“', async () => {
    const { pruefeRoot, rootInitSkript } = await import('./windows-pki.js');
    const s = rootInitSkript(pruefeRoot({ ca_name: 'AD3033 Root CA 01' }) as never);
    expect(s).toContain('DatabaseDirectory = $db; LogDirectory = $db');
    expect(s).toContain("System32\\CertLog");
    expect(s).toContain('nur halb eingerichtet');
    expect(s.indexOf('nur halb eingerichtet')).toBeLessThan(s.indexOf('Install-AdcsCertificationAuthority'));
  });
});

describe('v1817 Rest eines abgebrochenen Root-Versuchs', () => {
  it('nur bei „already installed“ ohne konfigurierte CA: Konfiguration entfernen und Schlüssel ersetzen', async () => {
    const { pruefeRoot, rootInitSkript } = await import('./windows-pki.js');
    const s = rootInitSkript(pruefeRoot({ ca_name: 'AD3033 Root CA 01' }) as never);
    expect(s).toContain("if ($_.Exception.Message -notmatch 'already installed') { throw }");
    expect(s).toContain('Uninstall-AdcsCertificationAuthority -Force');
    expect(s).toContain('Install-AdcsCertificationAuthority @ia -OverwriteExistingKey');
    // die Bereinigung steht innerhalb von „if (-not $schon)“ — eine eingerichtete CA wird nie angefasst
    expect(s.indexOf("'if (-not $schon) {'".slice(1, -1))).toBeLessThan(s.indexOf('Uninstall-AdcsCertificationAuthority'));
  });
});
