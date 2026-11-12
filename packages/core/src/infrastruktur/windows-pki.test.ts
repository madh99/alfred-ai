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
