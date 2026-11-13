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
    expect(p).toEqual({ cdp: ['1:C:\\Windows\\System32\\CertSrv\\CertEnroll\\ad3033-root%8%9.crl', '2:http://pki.ad.3033.at/pki/ad3033-root%8%9.crl'], aia: ['1:C:\\Windows\\System32\\CertSrv\\CertEnroll\\ad3033-root%4.crt', '2:http://pki.ad.3033.at/pki/ad3033-root%4.crt'] });
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
  it('v1841 CA-Sicherung außerhalb von SYSTEM als SYSTEM-Aufgabe, Kennwort nie im Aufgabenskript', async () => {
    const { caSicherungSkript } = await import('./windows-pki.js');
    const s = caSicherungSkript({ ziel_ordner: 'B:\\CA-Sicherung' });
    expect(s).toContain('GetCurrent().IsSystem');
    expect(s).toContain("MitKonto 'SYSTEM' '' $innen 900");
    expect(s).toContain("ProtectedData]::Protect(");
    expect(s.indexOf('Set-Acl -Path $ad')).toBeLessThan(s.indexOf('WriteAllBytes($kd'));
    // das innere Skript enthält nur den Dateiverweis, nicht $e.kennwort
    const innen = s.slice(s.indexOf('$innen = '), s.indexOf("$innen = $innen.Replace"));
    expect(innen).not.toContain('$e.kennwort');
    expect(innen).toContain("Remove-Item -LiteralPath ''__KDATEI__'' -Force");
  });
  it('v1842 gescheiterte Sicherung entfernt den eigenen Satz ohne Manifest', async () => {
    const { caSicherungSkript } = await import('./windows-pki.js');
    const s = caSicherungSkript({ ziel_ordner: 'B:\\CA-Sicherung' });
    const t = s.indexOf('try {\nif ([Security.Principal.WindowsIdentity]');
    const c = s.indexOf("} catch { if (-not (Test-Path -LiteralPath (Join-Path $d 'manifest.json'))) { Remove-Item -LiteralPath $d -Recurse -Force");
    expect(t).toBeGreaterThan(s.indexOf('New-Item -ItemType Directory -Path $d'));
    expect(c).toBeGreaterThan(s.indexOf("WriteAllText((Join-Path $d 'manifest.json')"));
    expect(s.slice(c)).toMatch(/; throw \}/);
  });
  it('v1841 Belege bis zu 4 Minuten auf Replikation warten, MitKonto-Grenze darüber', async () => {
    const { adVeroeffentlichenSkript } = await import('./windows-pki.js');
    const s = adVeroeffentlichenSkript({ dcs: ['dc01.ad.3033.at', 'dc02.ad.3033.at'], erwartet_root_sha256: 'a'.repeat(64), mit_sub: true, erwartet_sub_sha256: 'b'.repeat(64) });
    expect(s).toContain('AddMinutes(4)');
    expect(s).toContain('while (-not $alle -and (Get-Date) -lt $bis)');
    expect(s).toMatch(/' 420\n/);
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

describe('v1818 lokaler CDP/AIA-Pfad', () => {
  it('kein %windir% (die CA kennt nur %1–%11)', async () => {
    const { pruefePublikation } = await import('./windows-pki.js');
    const p = pruefePublikation({ datei_name: 'ad3033-root', http_basis: 'http://pki.ad.3033.at/pki/' }) as { cdp: string[]; aia: string[] };
    expect(JSON.stringify(p)).not.toContain('%windir%');
    expect(p.cdp[0]).toBe('1:C:\\Windows\\System32\\CertSrv\\CertEnroll\\ad3033-root%8%9.crl');
  });
});

describe('v1822 CA-Sicherung Summe', () => {
  it('summiert die Dateigrößen ohne Measure-Object -Property auf Hashtables', async () => {
    const m = await import('./windows-pki.js') as Record<string, unknown>;
    const quelle = Object.values(m).filter(f => typeof f === 'function').map(f => String(f)).join('\n');
    expect(quelle).not.toContain('Measure-Object -Property bytes');
    expect(quelle).toContain("[long]$_['bytes']");
  });
});

describe('v1828 appcmd-Argumente', () => {
  it('Bindung als EIN Argument (kein „/bindings:(…)“)', async () => {
    const { webSkript } = await import('./windows-pki.js');
    const s = webSkript({ site: 'Alfred-PKI', pfad: 'W:\\PKI', host: 'pki.ad.3033.at' } as never);
    expect(s).not.toContain('/bindings:(');
    expect(s).toContain("$aBind = '/bindings:http/*:80:' + $p.host");
    expect(s).toContain('& $ac add site $aName $aBind $aPfad');
  });
});

describe('v1829 PKI-Alias im Baustein', () => {
  it('alias wird geprüft und als virtuelles Verzeichnis angelegt, Konflikt bricht ab', async () => {
    const { pruefeWeb, webSkript } = await import('./windows-pki.js');
    expect(typeof pruefeWeb({ host_header: 'pki.ad.3033.at', pfad: 'W:\\PKI', alias: '../x' })).toBe('string');
    const w = pruefeWeb({ host_header: 'pki.ad.3033.at', pfad: 'W:\\PKI', alias: '/pki' }) as { alias?: string };
    expect(w.alias).toBe('pki');
    const s = webSkript(w as never);
    expect(s).toContain("$aVd = '/path:/' + $p.alias");
    expect(s).toContain('& $ac add vdir $aApp $aVd $aPfad');
    expect(s).toContain('Alias-Konflikt');
    expect(webSkript(pruefeWeb({ host_header: 'pki.ad.3033.at', pfad: 'W:\\PKI' }) as never)).toContain('if ($p.alias)');
  });
});

describe('v1831 IIS-Leserecht', () => {
  it('IUSR und IIS_IUSRS bekommen Lesen auf den Ordner', async () => {
    const { webSkript } = await import('./windows-pki.js');
    const s = webSkript({ site: 'Alfred-PKI', pfad: 'W:\PKI', host: 'pki.ad.3033.at' } as never);
    expect(s).toContain("@('S-1-5-17', 'S-1-5-32-568')");
    expect(s).toContain("'ReadAndExecute'");
  });
});

describe('v1832 exakte Alias-Prüfung', () => {
  it('prüft das virtuelle Verzeichnis über den exakten Namen in der Liste', async () => {
    const { webSkript, pruefeWeb } = await import('./windows-pki.js');
    const s = webSkript(pruefeWeb({ host_header: 'pki.ad.3033.at', pfad: 'W:\PKI', alias: 'pki' }) as never);
    expect(s).toContain('function VdirPfad($name)');
    expect(s).not.toContain('list vdir $vd /text:physicalPath');
    expect(s).toContain('if (-not $ist -or $ist.TrimEnd(');
  });
});

describe('v1834 Issuer-Aktivierung mit Domänen-Anmeldung', () => {
  it('certutil -installcert läuft über MitKonto als Administrator, Kennwort nur aus der Eingabe', async () => {
    const { aktivierenSkript } = await import('./windows-pki.js');
    const s = aktivierenSkript({ erwartet_zert_sha256: 'a'.repeat(64), erwartet_root_sha256: 'b'.repeat(64), erwartet_crl_sha256: 'c'.repeat(64) });
    expect(s).toContain('function MitKonto');
    expect(s).toContain('$e.kennwort');
    expect(s).toMatch(/MitKonto \(.*Administrator/);
    expect(s).not.toMatch(/\n {2}\$aus = \(& certutil\.exe -installcert/);
  });
  it('v1840 ExitCode: Handle vor dem Warten abfragen, leerer ExitCode zählt als Fehler', async () => {
    const { aktivierenSkript } = await import('./windows-pki.js');
    const s = aktivierenSkript({ erwartet_zert_sha256: 'a'.repeat(64), erwartet_root_sha256: 'b'.repeat(64), erwartet_crl_sha256: 'c'.repeat(64) });
    expect(s.indexOf('$null = $pr.Handle')).toBeGreaterThan(-1);
    expect(s.indexOf('$null = $pr.Handle')).toBeLessThan(s.indexOf('$pr.WaitForExit(180000)'));
  });
  it('v1840 certutil -crl nach dem Neustart bis zu 90 s wiederholen', async () => {
    const { publikationSkript, pruefePublikation } = await import('./windows-pki.js');
    const pb = pruefePublikation({ zugang: 'pkiiss01', unc_ziel: '\\\\fs01.ad.3033.at\\pki$\\', crl_anzahl: 1, datei_name: 'ad3033-issuing1', http_basis: 'http://pki.ad.3033.at/pki/', crl_einheit: 'Days', ueberlappung_anzahl: 6, ueberlappung_einheit: 'Days' });
    expect(typeof pb).not.toBe('string');
    const s = publikationSkript(pb as never);
    expect(s).toContain('AddSeconds(90); do { & certutil.exe -crl');
    expect(s).toContain('if ($crlExit -eq 0) { break }');
  });
});

describe('v1836 unvollständige Issuer-Installation', () => {
  it('„schon aktiv“ nur ohne offene SetupStatus-Flags 0x4/0x8', async () => {
    const { aktivierenSkript } = await import('./windows-pki.js');
    const s = aktivierenSkript({ erwartet_zert_sha256: 'a'.repeat(64), erwartet_root_sha256: 'b'.repeat(64), erwartet_crl_sha256: 'c'.repeat(64) });
    expect(s).toContain('-band 0xC) -ne 0');
    expect(s).toContain('$hatSchon = (-not $offen) -and');
  });
});

describe('v1838 Issuer neu aufsetzen', () => {
  it('Zurücksetzen nur bei unvollständiger CA, als Domänen-Administrator, genau dieses Zertifikat', async () => {
    const { pruefeIssuerReset, issuerResetSkript } = await import('./windows-pki.js');
    expect(typeof pruefeIssuerReset({ ca_name: 'AD3033 Issuing CA 01', erwartet_thumbprint: 'xyz' })).toBe('string');
    const r = pruefeIssuerReset({ ca_name: 'AD3033 Issuing CA 01', erwartet_thumbprint: 'a314af14351e5cf613ec60f834fbfca74a3de3a6' }) as { erwartet_thumbprint: string };
    expect(r.erwartet_thumbprint).toBe('A314AF14351E5CF613EC60F834FBFCA74A3DE3A6');
    const s = issuerResetSkript(r as never);
    expect(s).toContain("-band 0xC) -eq 0) { throw");
    expect(s).toContain('Uninstall-AdcsCertificationAuthority -Force');
    expect(s).toMatch(/MitKonto \(.*Administrator/);
    expect(s).toContain('-DeleteKey');
  });
  it('v1839 verwaister Schlüssel: nur exakter Name, nur ohne Zertifikat dieses CN, danach nachgeprüft', async () => {
    const { issuerResetSkript } = await import('./windows-pki.js');
    const s = issuerResetSkript({ ca_name: 'AD3033 Issuing CA 01', erwartet_thumbprint: 'A314AF14351E5CF613EC60F834FBFCA74A3DE3A6' });
    expect(s).toContain("([string]$_).Trim() -eq $p.ca_name");
    expect(s).toContain('Schlüssel nicht entfernt');
    expect(s).toContain('-delkey $p.ca_name');
    expect(s).toContain('noch vorhanden');
    expect(s).toContain("keine CA eingerichtet und kein Schlüssel dieses Namens");
    // beide Zweige rufen das Entfernen, Klammern ausgeglichen
    expect(s.split('$n = SchluesselEntfernen').length - 1).toBe(2);
    expect((s.match(/\{/g) ?? []).length).toBe((s.match(/\}/g) ?? []).length);
  });
  it('Sperren nur mit eindeutiger Seriennummer und passendem CN, Nachprüfung auf 21', async () => {
    const { pruefeSperre, sperrSkript } = await import('./windows-pki.js');
    expect(typeof pruefeSperre({ seriennummer: 'zz', erwartet_cn: 'AD3033 Issuing CA 01' })).toBe('string');
    const r = pruefeSperre({ seriennummer: '7C00000003ADBEB3A610CF3D09000000000003', erwartet_cn: 'AD3033 Issuing CA 01' }) as { grund: number; seriennummer: string };
    expect(r.grund).toBe(4);
    expect(r.seriennummer).toBe('7c00000003adbeb3a610cf3d09000000000003');
    const s = sperrSkript(r as never);
    expect(s).toContain('certutil.exe -revoke');
    expect(s).toContain('nicht eindeutig');
  });
});
