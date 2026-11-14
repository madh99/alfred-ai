import { describe, it, expect } from 'vitest';
import {
  LAB_WAECHTER, labNamenSkript, labCaSkript, labRootLesenSkript, labRootVertrauenSkript, labSqlInstallierenSkript, labAusstellenSkript, labSperrenSkript, labCrlDienstSkript,
  labBindenSkript, labTestSkript, pruefeLabNamen, pruefeLabAusstellen, pruefeLabTest, bewerteLabTest, type LabBefund, type LabTest,
} from './pki-lab.js';
import { PkiLabSkill } from './pki-lab-skill.js';
import { aktionsArt } from './change-schritte.js';

// v1866 — PKI Etappe 5: TLS-Negativtest-Lab (Spec Pos. 25, Owner 14.11.)
const T = 'A'.repeat(40);
describe('PKI-Lab: Wächter vor jeder Änderung', () => {
  const skripte: Array<[string, string]> = [
    ['namen', labNamenSkript({ eintraege: [{ name: 'labsrv01.pkilab.test', ip: '10.203.32.2' }] })],
    ['ca', labCaSkript({ crl_host: 'labsrv01.pkilab.test' })],
    ['root lesen', labRootLesenSkript()],
    ['root vertrauen', labRootVertrauenSkript({ thumbprint: T })],
    ['sql', labSqlInstallierenSkript()],
    ['ausstellen', labAusstellenSkript({ art: 'gueltig', dns: ['labsrv01.pkilab.test'] })],
    ['sperren', labSperrenSkript({ thumbprint: T })],
    ['crl', labCrlDienstSkript({ an: false, crl_host: 'labsrv01.pkilab.test' })],
    ['binden', labBindenSkript({ thumbprint: T })],
    ['test', labTestSkript({ ziel: 'labsrv01.pkilab.test', fall: 'gueltig', erwarteter_thumbprint: T })],
  ];
  it.each(skripte)('%s: Domäne, Name LAB… und Lab-Adresse geprüft, bevor etwas geschieht', (_n, s) => {
    const w = s.indexOf(LAB_WAECHTER[0]!);
    expect(w).toBeGreaterThan(-1);
    for (const z of LAB_WAECHTER) expect(s).toContain(z);
    const erste = ['Set-ItemProperty', 'Install-WindowsFeature', 'WriteAllText', 'certreq', 'certutil.exe -revoke', 'Stop-Service', 'Restart-Service', 'urlcache', '$st.Add', 'MitKonto ']
      .map(x => s.indexOf(x)).filter(i => i >= 0);
    if (erste.length) expect(Math.min(...erste)).toBeGreaterThan(w);
  });
  it('Lab-Netz /28 im Wächter, Domänenmitglied abgewiesen', () => {
    expect(LAB_WAECHTER.join('\n')).toContain(String.raw`'^10\.203\.32\.([0-9]|1[0-5])$'`);
    expect(LAB_WAECHTER.join('\n')).toContain('$cs.PartOfDomain');
  });
  it('CA ohne Freigabeordner, Sperrliste über HTTP, Ausstellen sofort nur im Lab', () => {
    // der Rumpf läuft als SYSTEM-Aufgabe und steht deshalb in einfachen Anführungszeichen (Hochkommas verdoppelt)
    const s = labCaSkript({ crl_host: 'labsrv01.pkilab.test' }).replace(/''/g, "'");
    expect(s).toContain("SetDatabaseInformation($db, $db, '', $true)");
    expect(s).toContain(String.raw`http://' + $p.crl_host + '/pki/lab%8.crl`);
    expect(s).toContain(String.raw`Reg 'policy\RequestDisposition' '1'`);
  });
});

describe('PKI-Lab: Eingaben', () => {
  it('nur Lab-Namen und Lab-Adressen', () => {
    expect(pruefeLabNamen({ eintraege: [{ name: 'sql01.ad.3033.at', ip: '10.203.32.2' }] })).toContain('pkilab.test');
    expect(pruefeLabNamen({ eintraege: [{ name: 'labsrv01.pkilab.test', ip: '10.203.30.2' }] })).toContain('10.203.32.0/28');
    expect(pruefeLabNamen({ eintraege: [{ name: 'labsrv01.pkilab.test', ip: '10.203.32.16' }] })).toContain('10.203.32.0/28');
    expect(pruefeLabAusstellen({ art: 'gueltig', dns: ['sql01.ad.3033.at'] })).toContain('pkilab.test');
    expect(pruefeLabAusstellen({ art: 'kurzlebig', dns: ['labsrv01.pkilab.test'], minuten: 2 })).toContain('minuten');
    expect(pruefeLabTest({ ziel: 'sqlag01.ad.3033.at', fall: 'gueltig', erwarteter_thumbprint: T })).toContain('Lab-Name');
  });
  it('Skill nur in Changes und nur mit Lab-Zugang; Change-Motor: ändernd', async () => {
    const sk = new PkiLabSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    expect((await sk.execute({ action: 'tls_negativtest', zugang: 'labcli01' }, {} as never)).error).toContain('freigegebenen Changes');
    expect((await sk.execute({ action: 'lab_zertifikat_binden', zugang: 'sql01', thumbprint: T }, { ausChange: true } as never)).error).toContain('Lab-Rechners');
    expect(aktionsArt('pki_lab', 'tls_negativtest')).toBe('aendern');
  });
});

describe('PKI-Lab: Bewertung je Fall', () => {
  const t = (fall: LabTest['fall'], ziel = 'labsrv01.pkilab.test'): LabTest => ({ ziel, fall, erwarteter_thumbprint: T });
  const b = (status: string[], anm: LabBefund['anmeldung'], extra: Partial<LabBefund['probe']> = {}): LabBefund => ({
    probe: { thumbprint: T, subjekt: 'CN=labsrv01.pkilab.test', aussteller: 'CN=PKI-Lab Root CA', sans: ['labsrv01.pkilab.test'], von: '2026-11-15T10:00:00', bis: '2027-11-15T10:00:00', kette: status.length === 0, kettenStatus: status, antwortUnverschluesselt: 3, zeit: '2026-11-15T11:00:00', ...extra },
    anmeldung: anm, cacheGeleert: true,
  });
  it('gueltig → LAB_TLS_OK', () => {
    expect(bewerteLabTest(t('gueltig'), b([], { server: 'LABSRV01', verschluesselt: true })).ergebnis).toBe('LAB_TLS_OK');
  });
  it('falscher Name → EXPECTED_TLS_FAILURE nur mit Namensfehler des Treibers', () => {
    const e = bewerteLabTest(t('falscher_name', 'labalias.pkilab.test'), b([], { fehler: 'A connection was successfully established ... The target principal name is incorrect.' }));
    expect(e.ergebnis).toBe('EXPECTED_TLS_FAILURE');
    expect(e.grund).toContain('nicht im SAN');
    expect(bewerteLabTest(t('falscher_name', 'labalias.pkilab.test'), b([], { server: 'LABSRV01', verschluesselt: true })).ergebnis).toBe('NICHT_BEWIESEN');
  });
  it('unbekannte CA, abgelaufen, gesperrt, Sperrliste nicht erreichbar — je nur mit dem passenden Kettenstatus', () => {
    expect(bewerteLabTest(t('unbekannte_ca'), b(['UntrustedRoot'], { fehler: 'The certificate chain was issued by an authority that is not trusted.' })).ergebnis).toBe('EXPECTED_TLS_FAILURE');
    expect(bewerteLabTest(t('abgelaufen'), b(['NotTimeValid'], { fehler: 'The certificate chain was issued by an authority that is not trusted.' }, { bis: '2026-11-15T10:30:00' })).ergebnis).toBe('EXPECTED_TLS_FAILURE');
    expect(bewerteLabTest(t('abgelaufen'), b(['NotTimeValid'], { fehler: 'certificate' }, { bis: '2026-11-15T12:00:00' })).ergebnis).toBe('NICHT_BEWIESEN');
    const gesperrt = bewerteLabTest(t('gesperrt'), b(['Revoked'], { server: 'LABSRV01', verschluesselt: true }));
    expect(gesperrt.ergebnis).toBe('EXPECTED_TLS_FAILURE');
    expect(bewerteLabTest(t('gesperrt'), b(['RevocationStatusUnknown', 'OfflineRevocation'], {})).ergebnis).toBe('NICHT_BEWIESEN');
    expect(bewerteLabTest(t('crl_unerreichbar'), b(['RevocationStatusUnknown', 'OfflineRevocation'], {})).ergebnis).toBe('EXPECTED_TLS_FAILURE');
    expect(bewerteLabTest(t('crl_unerreichbar'), b(['Revoked'], {})).ergebnis).toBe('NICHT_BEWIESEN');
  });
  it('kein Beweis aus einem Verbindungsfehler oder mit fremdem Zertifikat', () => {
    expect(bewerteLabTest(t('unbekannte_ca'), { probe: { zeit: 'x', fehler: 'keine Verbindung zu labsrv01.pkilab.test:1433' }, anmeldung: { fehler: 'network-related' }, cacheGeleert: true }).ergebnis).toBe('NICHT_BEWIESEN');
    expect(bewerteLabTest(t('unbekannte_ca'), b(['UntrustedRoot'], { fehler: 'not trusted' }, { thumbprint: 'B'.repeat(40) })).befunde.join()).toContain('statt Fixture');
  });
});
