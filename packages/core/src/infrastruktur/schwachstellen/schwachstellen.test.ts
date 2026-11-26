import { describe, it, expect } from 'vitest';
import { betroffen, vergleiche, leseBereich } from './versionen.js';
import { githubAdvisories, nvdCpe, osv, zusammenfuehren, epss, kev, type Abruf } from './quellen.js';
import { leseTrivy, trivyArgumente, TRIVY_IMAGE } from './trivy.js';
import { imageRepo, laufendeVersion, veroeffentlichtePorts, vonAussenErreichbar } from './zuordnung.js';
import { stufe, befunde, lageText, zaehle, type Komponente } from './bewertung.js';
import { schwachstellenLauf, type LaufDeps } from './lauf.js';

// Realfall 25.11.: Vaultwarden 1.30.5 — Bereichsangaben genau wie in den Repo-Advisories
describe('Versionen und Bereiche', () => {
  it('vergleicht Versionen mit v-Präfix und Zusätzen', () => {
    expect(vergleiche('1.30.5', '1.37.4')).toBeLessThan(0);
    expect(vergleiche('v1.9.8', '1.9.8')).toBe(0);
    expect(vergleiche('4.18.0-r0', '4.19')).toBeLessThan(0);
    expect(vergleiche('latest', '1.0')).toBeUndefined();
  });
  it('liest freie Bereiche', () => {
    expect(leseBereich('>= 1.33.0, <= 1.37.3')).toEqual([{ op: '>=', v: '1.33.0' }, { op: '<=', v: '1.37.3' }]);
    expect(leseBereich('≤ 1.36.0 ')).toEqual([{ op: '<=', v: '1.36.0' }]);
    expect(leseBereich('1.35.3')).toEqual([{ op: '<=', v: '1.35.3' }]);
  });
  it('betroffen nach behobener Version und unterer Grenze', () => {
    expect(betroffen('1.30.5', '<=1.37.3', '1.37.4')).toBe(true);
    expect(betroffen('1.37.5', '<=1.37.3', '1.37.4')).toBe(false);
    expect(betroffen('1.30.5', '>= 1.33.0, <= 1.37.3', '1.37.4')).toBe(false);
    expect(betroffen('1.30.5', '1.35.3', '1.35.4')).toBe(true);
    expect(betroffen('1.30.5', '>1.36.0, < 1.37.0', '1.37.0')).toBe(false);
    expect(betroffen('1.30.5', '<1.35.8', undefined)).toBe(true);
    expect(betroffen('latest', '<1.35.8', '1.36.0')).toBeUndefined();
  });
});

function abrufMit(antworten: Record<string, unknown>): { abruf: Abruf; urls: string[] } {
  const urls: string[] = [];
  return { urls, abruf: async (url) => { urls.push(url); const k = Object.keys(antworten).find(x => url.includes(x)); return k ? { ok: true, status: 200, json: async () => antworten[k] } : { ok: false, status: 404, json: async () => ({}) }; } };
}

describe('Quellen', () => {
  it('GitHub-Repo-Advisories: nur betroffene, Score v3, behobene Version', async () => {
    const { abruf } = abrufMit({ 'repos/dani-garcia/vaultwarden/security-advisories': [
      { ghsa_id: 'GHSA-69q9-v8p6-xvx3', cve_id: null, summary: 'Organization member revocation', severity: 'high', cvss_severities: { cvss_v3: { score: 8.1, vector_string: 'CVSS:3.1/AV:N' } }, vulnerabilities: [{ vulnerable_version_range: '<= 1.37.3', patched_versions: '1.37.4' }] },
      { ghsa_id: 'GHSA-v576-3wvq-xh3c', cve_id: null, severity: 'medium', cvss_severities: { cvss_v3: { score: 6.8 } }, vulnerabilities: [{ vulnerable_version_range: '>= 1.33.0, <= 1.37.3', patched_versions: '1.37.4' }] },
      { ghsa_id: 'GHSA-569v-845w-g82p', cve_id: 'CVE-2026-43912', severity: 'high', cvss_severities: { cvss_v3: { score: 8.7 } }, vulnerabilities: [{ vulnerable_version_range: '<=1.35.4', patched_versions: '1.35.5' }] },
    ] });
    const a = await githubAdvisories(abruf, 'dani-garcia/vaultwarden', '1.30.5');
    expect(a.map(x => [x.id, x.cvss, x.schwere, x.behoben])).toEqual([['GHSA-69q9-v8p6-xvx3', 8.1, 'hoch', '1.37.4'], ['CVE-2026-43912', 8.7, 'hoch', '1.35.5']]);
  });
  it('NVD per CPE und OSV; Zusammenführen über CVE und GHSA', async () => {
    const { abruf, urls } = abrufMit({
      'services.nvd.nist.gov': { vulnerabilities: [{ cve: { id: 'CVE-2026-43912', descriptions: [{ lang: 'en', value: 'cross-org' }], metrics: { cvssMetricV31: [{ cvssData: { baseScore: 8.7, vectorString: 'CVSS:3.1/X' } }] } } }, { cve: { id: 'CVE-2024-55225', metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, vectorString: 'V' } }] } } }] },
      'api.osv.dev': { vulns: [{ id: 'GHSA-x7m9-mv49-fv73', aliases: ['CVE-2024-55225'], database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '1.32.6' }] }] }] }] },
    });
    const n = await nvdCpe(abruf, 'dani-garcia:vaultwarden', 'v1.30.5');
    expect(urls[0]).toContain(encodeURIComponent('cpe:2.3:a:dani-garcia:vaultwarden:1.30.5:'));
    const o = await osv(abruf, 'crates.io', 'vaultwarden', '1.30.5');
    const z = zusammenfuehren([n, o]);
    const c = z.find(x => x.id === 'CVE-2024-55225')!;
    expect(c).toMatchObject({ cvss: 9.8, schwere: 'kritisch', behoben: '1.32.6', quellen: ['nvd', 'osv'] });
    expect(c.aliase).toContain('GHSA-x7m9-mv49-fv73');
    expect(z).toHaveLength(2);
  });
  it('EPSS in Blöcken, KEV', async () => {
    const { abruf, urls } = abrufMit({ 'api.first.org': { data: [{ cve: 'CVE-1-1', epss: '0.42' }] }, 'cisa.gov': { vulnerabilities: [{ cveID: 'CVE-1-1', dateAdded: '2026-01-02' }] } });
    expect((await epss(abruf, Array.from({ length: 150 }, (_, i) => `CVE-2026-${i}`))).size).toBe(1);
    expect(urls.filter(u => u.includes('first.org'))).toHaveLength(2);
    expect((await kev(abruf)).get('CVE-1-1')).toBe('2026-01-02');
  });
  it('Fehler der Quelle werden geworfen, nicht verschluckt', async () => {
    await expect(githubAdvisories(abrufMit({}).abruf, 'x/y', '1.0')).rejects.toThrow('GitHub x/y: HTTP 404');
  });
});

describe('Trivy und Zuordnung', () => {
  it('Argumente ohne Shell, fest gepinnte Version, Referenz geprüft', () => {
    const a = trivyArgumente('vaultwarden/server@sha256:' + 'a'.repeat(64));
    expect(a).toContain(TRIVY_IMAGE);
    expect(TRIVY_IMAGE).toMatch(/^aquasec\/trivy:0\.76\.2@sha256:[0-9a-f]{64}$/);
    expect(a.slice(-1)[0]).toBe('vaultwarden/server@sha256:' + 'a'.repeat(64));
    expect(() => trivyArgumente('x; rm -rf /')).toThrow();
  });
  it('liest Trivy-JSON: Score NVD vor GHSA, behobene Version, einmal je Paket', () => {
    const r = leseTrivy(JSON.stringify({ Metadata: { OS: { Family: 'debian', Name: '12.5' } }, Results: [{ Target: 'x', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2024-1', PkgName: 'openssl', InstalledVersion: '3.0.11', FixedVersion: '3.0.13', Status: 'fixed', Severity: 'HIGH', CVSS: { ghsa: { V3Score: 7 }, nvd: { V3Score: 7.5, V3Vector: 'V' } } },
      { VulnerabilityID: 'CVE-2024-1', PkgName: 'openssl', InstalledVersion: '3.0.11', FixedVersion: '3.0.13', Severity: 'HIGH' },
      { VulnerabilityID: 'CVE-2024-2', PkgName: 'zlib', InstalledVersion: '1', Status: 'will_not_fix', Severity: 'LOW' },
    ] }] }));
    expect(r.os).toBe('debian 12.5');
    expect(r.treffer).toHaveLength(2);
    expect(r.treffer[0]).toMatchObject({ id: 'CVE-2024-1', cvss: 7.5, schwere: 'hoch', behoben: '3.0.13', paket: 'openssl' });
    expect(r.treffer[1]!.behoben).toBeUndefined();
  });
  it('Image-Repo und laufende Version', () => {
    expect(imageRepo('ghcr.io/element-hq/lk-jwt-service:latest')).toBe('element-hq/lk-jwt-service');
    expect(imageRepo('docker.io/library/redis:7')).toBe('redis');
    expect(imageRepo('lscr.io/linuxserver/ombi:latest')).toBe('linuxserver/ombi');
    expect(imageRepo('vaultwarden/server@sha256:abc')).toBe('vaultwarden/server');
    expect(laufendeVersion('vaultwarden/server:latest', '1.30.5')).toBe('1.30.5');
    expect(laufendeVersion('postgres:16')).toBe('16');
    expect(laufendeVersion('ghcr.io/open-webui/open-webui:main', 'main')).toBeUndefined();
  });
  it('von außen erreichbar über NPM auf veröffentlichtem Port', () => {
    const p = veroeffentlichtePorts('0.0.0.0:181->80/tcp, :::181->80/tcp, 127.0.0.1:3012->3012/tcp');
    expect(p).toEqual([181, 3012]);
    expect(vonAussenErreichbar([{ forwardHost: '10.203.23.2', forwardPort: 181 }], { name: 'docker-vault-01', ip: '10.203.23.2' }, p)).toBe(true);
    expect(vonAussenErreichbar([{ forwardHost: '10.203.23.2', forwardPort: 8080 }], { name: 'docker-vault-01', ip: '10.203.23.2' }, p)).toBe(false);
  });
});

describe('Bewertung (Owner 25.11.: Fristen 48 h / 7 Tage / 30 Tage)', () => {
  it('Stufen', () => {
    expect(stufe({ cvss: 9.8, schwere: 'kritisch' }, false)).toBe('kritisch');
    expect(stufe({ cvss: 8.1, schwere: 'hoch' }, true)).toBe('kritisch');
    expect(stufe({ cvss: 8.1, schwere: 'hoch' }, false)).toBe('hoch');
    expect(stufe({ cvss: 5, schwere: 'mittel', kev: '2026-01-01' }, false)).toBe('kritisch');
    expect(stufe({ cvss: 5, schwere: 'mittel', epss: 0.2 }, false)).toBe('hoch');
    expect(stufe({ schwere: 'mittel' }, false)).toBe('mittel');
    expect(stufe({ cvss: 2, schwere: 'niedrig' }, false)).toBe('niedrig');
  });
  // Kalibrierung 25.11. (erster Lauf: 2001 „kritisch“, 99 % Basis-Pakete aus Trivy)
  it('Basis-Pakete: Gefährdung statt NVD-Höchstwert', () => {
    const b = { basis: true as const };
    expect(stufe({ ...b, cvss: 9.8, schwere: 'kritisch' }, true)).toBe('mittel');
    expect(stufe({ ...b, cvss: 9.8, schwere: 'kritisch', behoben: '1.2' }, true)).toBe('hoch');
    expect(stufe({ ...b, cvss: 5, schwere: 'mittel', kev: '2026-01-01' }, false)).toBe('kritisch');
    expect(stufe({ ...b, cvss: 7.5, schwere: 'hoch', epss: 0.3 }, true)).toBe('kritisch');
    expect(stufe({ ...b, cvss: 7.5, schwere: 'hoch', epss: 0.3 }, false)).toBe('hoch');
    expect(stufe({ ...b, cvss: 8.1, schwere: 'hoch', behoben: '2' }, true)).toBe('mittel');
    expect(stufe({ ...b, schwere: 'kritisch', behoben: '2' }, false)).toBe('hoch');
    expect(stufe({ ...b, cvss: 3, schwere: 'niedrig' }, true)).toBe('niedrig');
  });
  it('Zählung je CVE und Komponente, nicht je Paket', () => {
    const p = (id: string, paket: string, st: 'kritisch' | 'hoch' | 'mittel') => ({ id, aliase: [id], titel: '', schwere: 'hoch' as const, link: '', quellen: ['trivy'], paket, installiert: '1', stufe: st, basis: true });
    expect(zaehle([p('CVE-1', 'libssl3', 'hoch'), p('CVE-1', 'openssl', 'hoch'), p('CVE-1', 'libcrypto', 'kritisch'), p('CVE-2', 'zlib', 'mittel')])).toEqual({ kritisch: 1, hoch: 0, mittel: 1, niedrig: 0 });
  });
  const k = (treffer: Komponente['treffer'], o: Partial<Komponente> = {}): Komponente => ({ schluessel: 'docker-vault-01/vaultwarden', host: 'docker-vault-01', name: 'vaultwarden', art: 'container', anwendung: 'Vaultwarden', version: '1.30.5', erreichbar: true, treffer, nichtGeprueft: [], geprueft: [], quellenFehler: false, ...o });
  const t = (id: string, cvss: number, st: 'kritisch' | 'hoch' | 'mittel' | 'niedrig', behoben?: string) => ({ id, aliase: [id], titel: '', cvss, schwere: 'hoch' as const, link: '', quellen: ['github'], paket: 'Vaultwarden', installiert: '1.30.5', stufe: st, ...(behoben ? { behoben } : {}), erkannt: '2026-11-25T05:00:00Z' });
  it('Befund je Komponente: kritisch immer, hoch nur mit Fix; Frist ab erstem Erkennen in Ortszeit', () => {
    const b = befunde([k([t('CVE-2024-55225', 9.8, 'kritisch', '1.32.6'), t('GHSA-69q9', 8.1, 'hoch', '1.37.4'), t('X', 5, 'mittel', '1.37.5')])]);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ schwere: 'hoch', kategorie: 'sicherheit', schluessel: 'sicherheit:docker-vault-01:vaultwarden' });
    expect(b[0]!.text).toBe('KRITISCH — Container vaultwarden (Vaultwarden 1.30.5): 1 kritisch, 1 hoch, 1 mittel; höchster CVSS 9.8 (CVE-2024-55225), von außen erreichbar; behoben in 1.37.5; Frist bis 27.11.26, 06:00');
    expect(befunde([k([t('Y', 8, 'hoch')])])).toEqual([]);
    expect(befunde([k([t('Z', 5, 'mittel', '2')])])).toEqual([]);
  });
  it('ohne CVSS-Wert nennt der Text die Schwere der Quelle statt „—“', () => {
    const ohne = { id: 'GHSA-xyz', aliase: ['GHSA-xyz'], titel: '', schwere: 'kritisch' as const, link: '', quellen: ['github'], paket: 'Synapse', installiert: '1.98.0', stufe: 'kritisch' as const, erkannt: '2026-11-25T05:00:00Z' };
    const b = befunde([k([ohne], { schluessel: 'docker-com-01/synapse', host: 'docker-com-01', name: 'synapse', anwendung: 'Synapse', version: '1.98.0' })]);
    expect(b[0]!.text).toBe('KRITISCH — Container synapse (Synapse 1.98.0): 1 kritisch, 0 hoch, 0 mittel; ohne CVSS-Wert, Schwere laut Quelle kritisch (GHSA-xyz), von außen erreichbar; Frist bis 27.11.26, 06:00');
    expect(lageText([k([ohne])], '26.11.26, 06:00', [])).toContain('ohne CVSS-Wert, Schwere laut Quelle kritisch GHSA-xyz');
  });
  it('Basis-Image: ein Sammel-Befund je Image mit Maßnahme, Anwendung und Basis getrennt', () => {
    const b = (id: string, paket: string, st: 'kritisch' | 'hoch' | 'mittel', x: { kev?: string; epss?: number } = {}) => ({ id, aliase: [id], titel: '', cvss: 7.5, schwere: 'hoch' as const, link: '', quellen: ['trivy'], paket, installiert: '1', behoben: '2', stufe: st, basis: true, erkannt: '2026-11-25T05:00:00Z', ...x });
    const nur = befunde([k([b('CVE-2023-4863', 'libwebp7', 'kritisch', { kev: '2023-09-13' }), b('CVE-2023-4863', 'libwebp-dev', 'kritisch', { kev: '2023-09-13' }), b('CVE-2024-1', 'curl', 'hoch', { epss: 0.4 }), b('CVE-2024-2', 'zlib', 'mittel')],
      { schluessel: 'docker-com-01/guacamole', host: 'docker-com-01', name: 'guacamole', anwendung: undefined, version: undefined, image: 'guacamole/guacamole:1.5.4', erreichbar: false })]);
    expect(nur).toHaveLength(1);
    expect(nur[0]!.text).toBe('KRITISCH — Basis-Image von Container guacamole (guacamole/guacamole:1.5.4): 1 kritisch, 1 hoch in 3 Paketen (u. a. CVE-2023-4863 in libwebp7, aktiv ausgenutzt (KEV)) — Image aktualisieren bzw. neu bauen; Frist bis 27.11.26, 06:00');
    const beide = befunde([k([t('CVE-2024-55225', 9.8, 'kritisch', '1.32.6'), b('CVE-2024-1', 'curl', 'hoch', { epss: 0.4 })])]);
    expect(beide[0]!.text).toBe('KRITISCH — Container vaultwarden (Vaultwarden 1.30.5): 1 kritisch, 0 hoch, 0 mittel; höchster CVSS 9.8 (CVE-2024-55225), von außen erreichbar; behoben in 1.32.6; Basis-Image: 0 kritisch, 1 hoch in 1 Paketen (u. a. CVE-2024-1 in curl, EPSS 40 %) — Image aktualisieren bzw. neu bauen; Frist bis 27.11.26, 06:00');
  });
  it('Lagetext nennt nicht Geprüftes und Quellenfehler', () => {
    const x = lageText([k([t('A', 9.8, 'kritisch', '1')]), k([], { schluessel: 'h/x', name: 'x', anwendung: undefined, nichtGeprueft: ['keine Anwendungs-Zuordnung — nur Trivy', 'Trivy: pull denied'] })], '25.11.26, 16:00', ['KEV: HTTP 503']);
    expect(x).toContain('2 Komponenten geprüft · offen: 1 kritisch');
    expect(x).toContain('- docker-vault-01 / x: keine Anwendungs-Zuordnung — nur Trivy; Trivy: pull denied');
    expect(x).toContain('- KEV: HTTP 503');
  });
});

describe('Lauf über die Infrastruktur', () => {
  it('Container mit Zuordnung (drei Quellen) + Trivy, Host-Sicherheitsupdates über OSV; Stufen mit EPSS/KEV; Lücken benannt', async () => {
    const { abruf } = abrufMit({
      'repos/dani-garcia/vaultwarden/security-advisories': [{ ghsa_id: 'GHSA-569v', cve_id: 'CVE-2026-43912', severity: 'high', cvss_severities: { cvss_v3: { score: 8.7 } }, vulnerabilities: [{ vulnerable_version_range: '<=1.35.4', patched_versions: '1.35.5' }] }],
      'services.nvd.nist.gov': { vulnerabilities: [{ cve: { id: 'CVE-2026-43912', metrics: { cvssMetricV31: [{ cvssData: { baseScore: 8.7, vectorString: 'V' } }] } } }] },
      'api.osv.dev': { vulns: [{ id: 'USN-1', aliases: ['CVE-2026-9'], database_specific: { severity: 'HIGH' } }] },
      'api.first.org': { data: [{ cve: 'CVE-2026-9', epss: '0.5' }] },
      'cisa.gov': { vulnerabilities: [] },
    });
    const gescannt: string[] = [];
    const r = await schwachstellenLauf({
      container: [
        { host: 'docker-vault-01', name: 'vaultwarden', image: 'vaultwarden/server:latest', label: '1.30.5', digest: 'vaultwarden/server@sha256:' + 'b'.repeat(64) },
        { host: 'docker-com-01', name: 'sydent', image: 'registry.lokal/sydent:latest', lokal: 'lokal gebaut' },
        { host: 'docker-dev-01', name: 'open-webui', image: 'ghcr.io/open-webui/open-webui:main', label: 'main' },
      ],
      hosts: [{ host: 'pve3', os: { id: 'debian', version: '13' }, sicherheit: [{ paket: 'openssl', alt: '3.5.1-1', neu: '3.5.1-1+deb13u1' }] }, { host: 'x', sicherheit: [] }],
      abruf, erreichbar: (h) => h === 'docker-vault-01', pause: async () => undefined,
      trivy: async (ref) => { gescannt.push(ref); return JSON.stringify({ Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-2025-7', PkgName: 'libc6', InstalledVersion: '2.36', FixedVersion: '2.36-9', Severity: 'MEDIUM' }] }] }); },
    });
    const vw = r.komponenten.find(k => k.name === 'vaultwarden')!;
    expect(vw.treffer.find(t => t.id === 'CVE-2026-43912')).toMatchObject({ paket: 'Vaultwarden', stufe: 'kritisch', quellen: ['github', 'nvd'] });
    expect(vw.treffer.find(t => t.id === 'CVE-2025-7')).toMatchObject({ paket: 'libc6', stufe: 'mittel', basis: true });
    expect(vw.treffer.find(t => t.id === 'CVE-2026-43912')!.basis).toBeUndefined();
    expect(vw.geprueft.sort()).toEqual(['github', 'nvd', 'osv', 'trivy']);
    expect(gescannt[0]).toBe('vaultwarden/server@sha256:' + 'b'.repeat(64));
    expect(r.komponenten.find(k => k.name === 'sydent')!.nichtGeprueft).toEqual(['keine Anwendungs-Zuordnung — nur Trivy', 'Trivy: lokal gebaut']);
    expect(r.komponenten.find(k => k.name === 'open-webui')!.nichtGeprueft[0]).toContain('keine laufende Version');
    const pve = r.komponenten.find(k => k.host === 'pve3')!;
    expect(pve.treffer[0]).toMatchObject({ id: 'CVE-2026-9', paket: 'openssl', behoben: '3.5.1-1+deb13u1', epss: 0.5, stufe: 'hoch' });
    expect(r.komponenten.some(k => k.host === 'x')).toBe(false);
    expect(r.fehler).toEqual([]);
  });
  it('Quellenfehler stehen an der Komponente; Trivy-Fehler hält den Rest nicht auf', async () => {
    const r = await schwachstellenLauf({
      container: [{ host: 'h', name: 'vaultwarden', image: 'vaultwarden/server:1.37.5' }],
      hosts: [], abruf: abrufMit({ 'cisa.gov': { vulnerabilities: [] } }).abruf, erreichbar: () => false, pause: async () => undefined,
      trivy: async () => { throw new Error('pull access denied'); },
    });
    const k = r.komponenten[0]!;
    expect(k.nichtGeprueft).toEqual(expect.arrayContaining(['Vaultwarden: GitHub dani-garcia/vaultwarden: HTTP 404', 'Trivy: pull access denied']));
    expect(k.geprueft).toEqual([]);
  });
});

// Befunde des CVE-Laufs gehören nur ihm: der Bestandsabgleich (ohne Schlüssel-Filter) legt sie nicht an und löst sie nicht
describe('Zuständigkeit der Schlüssel sicherheit:', () => {
  it('Bestandsabgleich lässt sicherheit:-Befunde unberührt, der CVE-Lauf löst nur eigene', async () => {
    const { befundeAlsProblems, istSicherheitsSchluessel } = await import('../befund-problems.js');
    const probleme: Array<{ id: string; title: string; status: string; detectionMethod?: string }> = [];
    const z = {
      liste: async () => probleme,
      anlegen: async (d: { title: string; detectionMethod?: string }) => { const id = `p${probleme.length + 1}`; probleme.push({ id, title: d.title, status: 'open', ...(d.detectionMethod ? { detectionMethod: d.detectionMethod } : {}) }); return id; },
      loese: async (id: string) => { probleme.find(p => p.id === id)!.status = 'resolved'; },
      assetFuer: async () => undefined,
    } as never;
    const cve = { schwere: 'hoch' as const, bereich: 'docker-vault-01', text: 'KRITISCH — Container vaultwarden', schluessel: 'sicherheit:docker-vault-01:vaultwarden', kategorie: 'sicherheit' as const, zugang: 'docker-vault-01' };
    const erf = { hosts: new Set(['docker-vault-01']), alle: false };
    expect((await befundeAlsProblems([cve], z, { docId: 's', datum: 'd' }, { ...erf, kategorien: new Set(['sicherheit']), schluessel: istSicherheitsSchluessel })).neu).toEqual(['p1']);
    // Bestandsabgleich ohne Filter: sieht den Befund nicht, legt ihn nicht an, löst ihn nicht
    const b = await befundeAlsProblems([cve], z, { docId: 'b', datum: 'd' }, erf);
    expect(b.neu).toEqual([]); expect(b.geloest).toEqual([]);
    // CVE-Lauf ohne Befund (behoben): löst den eigenen
    expect((await befundeAlsProblems([], z, { docId: 's', datum: 'd' }, { ...erf, kategorien: new Set(['sicherheit']), schluessel: istSicherheitsSchluessel })).geloest).toEqual(['p1']);
  });
});

// v1961 — Realfall 25.11.: nach der Kalibrierung trugen die Problems weiter „772 kritisch“ aus dem ersten Lauf
describe('Befundtext offener Problems nachziehen', () => {
  it('nur mit textNachziehen, nur offene, nur bei geändertem Text', async () => {
    const { befundeAlsProblems, istSicherheitsSchluessel } = await import('../befund-problems.js');
    const probleme = [{ id: 'p1', title: 'docker-ops-01: KRITISCH — Container guacamole (Guacamole): 772 kritisch', status: 'open', detectionMethod: 'infrastruktur-bestand:sicherheit:docker-ops-01:guacamole' }];
    const neu: Array<{ id: string; title: string }> = [];
    const z = { liste: async () => probleme, anlegen: async () => 'x', loese: async () => undefined, aktualisiere: async (id: string, d: { title: string }) => { neu.push({ id, title: d.title }); } } as never;
    const b = { schwere: 'hoch' as const, bereich: 'docker-ops-01', text: 'KRITISCH — Basis-Image von Container guacamole: 34 kritisch', schluessel: 'sicherheit:docker-ops-01:guacamole', kategorie: 'sicherheit' as const, zugang: 'docker-ops-01' };
    const erf = { hosts: new Set(['docker-ops-01']), alle: false, kategorien: new Set(['sicherheit']), schluessel: istSicherheitsSchluessel };
    expect((await befundeAlsProblems([b], z, { docId: 's', datum: 'd' }, erf)).aktualisiert).toBeUndefined();
    const r = await befundeAlsProblems([b], z, { docId: 's', datum: 'd' }, { ...erf, textNachziehen: true });
    expect(r.aktualisiert).toEqual(['p1']); expect(r.neu).toEqual([]);
    expect(neu[0]!.title).toBe('docker-ops-01: KRITISCH — Basis-Image von Container guacamole: 34 kritisch');
    probleme[0]!.title = neu[0]!.title;
    expect((await befundeAlsProblems([b], z, { docId: 's', datum: 'd' }, { ...erf, textNachziehen: true })).aktualisiert).toBeUndefined();
    probleme[0]!.status = 'closed'; probleme[0]!.title = 'alt';
    expect((await befundeAlsProblems([b], z, { docId: 's', datum: 'd' }, { ...erf, textNachziehen: true })).aktualisiert).toBeUndefined();
  });
});

// Security-Review 25.11. — fail-closed bei Quellenausfällen
describe('Fail-closed bei Quellenausfällen', () => {
  const basis = { hosts: [] as LaufDeps['hosts'], pause: async () => undefined };
  it('OSV-Fehler aus dem Zwischenspeicher wird an jedem Host benannt; kein osv in geprueft', async () => {
    const abruf: Abruf = async (url) => (url.includes('api.osv.dev') ? { ok: false, status: 503, json: async () => ({}) } : url.includes('cisa.gov') ? { ok: true, status: 200, json: async () => ({ vulnerabilities: [] }) } : { ok: true, status: 200, json: async () => ({ data: [] }) });
    const r = await schwachstellenLauf({ ...basis, container: [], abruf, erreichbar: () => false,
      hosts: [{ host: 'a', os: { id: 'debian', version: '12' }, sicherheit: [{ paket: 'openssl', alt: '1', neu: '2' }] }, { host: 'b', os: { id: 'debian', version: '12' }, sicherheit: [{ paket: 'openssl', alt: '1', neu: '2' }] }] });
    for (const k of r.komponenten) { expect(k.quellenFehler).toBe(true); expect(k.geprueft).toEqual([]); expect(k.nichtGeprueft[0]).toContain('openssl: OSV Debian:12/openssl: HTTP 503'); }
  });
  it('KEV/EPSS nicht abrufbar: gespeicherte Werte gelten weiter, Stufe bleibt kritisch, Komponente gesperrt', async () => {
    const abruf: Abruf = async (url) => (url.includes('security-advisories') ? { ok: true, status: 200, json: async () => [{ ghsa_id: 'G', cve_id: 'CVE-2026-1', severity: 'medium', cvss_severities: { cvss_v3: { score: 5 } }, vulnerabilities: [{ vulnerable_version_range: '<2', patched_versions: '2' }] }] } : { ok: false, status: 503, json: async () => ({}) });
    const r = await schwachstellenLauf({ ...basis, container: [{ host: 'h', name: 'vaultwarden', image: 'vaultwarden/server:1.0' }], abruf, erreichbar: () => false,
      erkannt: () => new Map([['CVE-2026-1|Vaultwarden', { erkannt: '2026-11-20T00:00:00Z', kev: '2026-11-01' }]]) });
    const k = r.komponenten[0]!;
    expect(k.quellenFehler).toBe(true);
    expect(k.nichtGeprueft).toContain('EPSS und KEV nicht abrufbar — zuletzt gespeicherte Werte');
    expect(k.treffer.find(t => t.id === 'CVE-2026-1')).toMatchObject({ kev: '2026-11-01', stufe: 'kritisch', erkannt: '2026-11-20T00:00:00Z' });
  });
  it('Erreichbarkeit unbekannt wird als erreichbar gewertet und benannt', async () => {
    const r = await schwachstellenLauf({ ...basis, container: [{ host: 'h', name: 'x', image: 'unbekannt/app:1' }], abruf: abrufMit({ 'cisa.gov': { vulnerabilities: [] } }).abruf, erreichbar: () => undefined });
    expect(r.komponenten[0]).toMatchObject({ erreichbar: true });
    expect(r.komponenten[0]!.nichtGeprueft[0]).toBe('Erreichbarkeit unbekannt (keine Port-Daten) — als von außen erreichbar gewertet');
  });
});
