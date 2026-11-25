/**
 * Spec Schwachstellen-Überwachung §3.2 — Abfragen der Quellen (nur lesend, normale TLS-Prüfung, keine Weiterleitung).
 *
 * Realfall 25.11. (Vaultwarden 1.30.5): OSV fand 7 Advisories, NVD per CPE 16, die Repo-Advisories des Herstellers 37 — darunter die
 * bei OSV/NVD fehlende GHSA-69q9-v8p6-xvx3 (8.1). Deshalb alle drei je Anwendung, zusammengeführt über CVE- bzw. GHSA-Kennung.
 */
import { betroffen } from './versionen.js';

export type Abruf = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Schwere = 'kritisch' | 'hoch' | 'mittel' | 'niedrig' | 'unbekannt';
export interface Advisory {
  /** CVE-Kennung, sonst GHSA/OSV-Kennung */
  id: string; aliase: string[]; titel: string; cvss?: number; vektor?: string; schwere: Schwere; behoben?: string; link: string; quellen: string[];
}

export const schwereAusScore = (s: number | undefined): Schwere => (s === undefined ? 'unbekannt' : s >= 9 ? 'kritisch' : s >= 7 ? 'hoch' : s >= 4 ? 'mittel' : 'niedrig');
const schwereAusText = (t: unknown): Schwere => {
  const x = String(t ?? '').toLowerCase();
  return x === 'critical' ? 'kritisch' : x === 'high' ? 'hoch' : x === 'medium' || x === 'moderate' ? 'mittel' : x === 'low' ? 'niedrig' : 'unbekannt';
};
const RANG: Record<Schwere, number> = { kritisch: 4, hoch: 3, mittel: 2, niedrig: 1, unbekannt: 0 };
export const rang = (s: Schwere) => RANG[s];

/** GitHub-Repo-Advisories (veröffentlicht), betroffen nach Bereich und behobener Version */
export async function githubAdvisories(abruf: Abruf, repo: string, version: string, token?: string): Promise<Advisory[]> {
  const aus: Advisory[] = [];
  for (let seite = 1; seite <= 5; seite++) {
    const r = await abruf(`https://api.github.com/repos/${repo}/security-advisories?per_page=100&state=published&page=${seite}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!r.ok) throw new Error(`GitHub ${repo}: HTTP ${r.status}`);
    const l = await r.json() as Array<{ ghsa_id: string; cve_id: string | null; summary?: string; severity?: string; html_url?: string; cvss?: { score?: number | null; vector_string?: string | null }; cvss_severities?: { cvss_v3?: { score?: number | null; vector_string?: string | null }; cvss_v4?: { score?: number | null; vector_string?: string | null } }; vulnerabilities?: Array<{ vulnerable_version_range?: string | null; patched_versions?: string | null }> }>;
    if (!Array.isArray(l)) throw new Error(`GitHub ${repo}: unerwartete Antwort`);
    for (const a of l) {
      const v = a.vulnerabilities ?? [];
      const treffer = v.map(x => betroffen(version, x.vulnerable_version_range ?? undefined, x.patched_versions ?? undefined));
      if (!treffer.some(t => t === true)) continue;
      const fix = v.map(x => x.patched_versions ?? '').filter(Boolean)[0];
      const c3 = a.cvss_severities?.cvss_v3; const c4 = a.cvss_severities?.cvss_v4;
      const score = c3?.score ?? a.cvss?.score ?? c4?.score ?? undefined;
      const vektor = c3?.vector_string ?? a.cvss?.vector_string ?? c4?.vector_string ?? undefined;
      aus.push({ id: a.cve_id ?? a.ghsa_id, aliase: [a.ghsa_id, ...(a.cve_id ? [a.cve_id] : [])], titel: (a.summary ?? '').slice(0, 300), ...(typeof score === 'number' ? { cvss: score } : {}), ...(vektor ? { vektor } : {}),
        schwere: typeof score === 'number' ? schwereAusScore(score) : schwereAusText(a.severity), ...(fix ? { behoben: fix } : {}), link: a.html_url ?? `https://github.com/${repo}/security/advisories/${a.ghsa_id}`, quellen: ['github'] });
    }
    if (l.length < 100) break;
  }
  return aus;
}

/** NVD über die CPE (vendor:product) und die laufende Version */
export async function nvdCpe(abruf: Abruf, cpe: string, version: string, apiKey?: string): Promise<Advisory[]> {
  const v = version.replace(/^v/i, '').split(/[-+]/)[0]!;
  const r = await abruf(`https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=${encodeURIComponent(`cpe:2.3:a:${cpe}:${v}:*:*:*:*:*:*:*`)}&resultsPerPage=200`, { headers: apiKey ? { apiKey } : {} });
  if (!r.ok) throw new Error(`NVD ${cpe}: HTTP ${r.status}`);
  const j = await r.json() as { vulnerabilities?: Array<{ cve: { id: string; descriptions?: Array<{ lang: string; value: string }>; metrics?: Record<string, Array<{ cvssData: { baseScore: number; vectorString: string } }>> } }> };
  return (j.vulnerabilities ?? []).map(({ cve }) => {
    const m = cve.metrics ?? {};
    const s = (m.cvssMetricV31 ?? m.cvssMetricV30 ?? m.cvssMetricV40 ?? [])[0]?.cvssData;
    return { id: cve.id, aliase: [cve.id], titel: (cve.descriptions?.find(d => d.lang === 'en')?.value ?? '').slice(0, 300), ...(s ? { cvss: s.baseScore, vektor: s.vectorString } : {}),
      schwere: schwereAusScore(s?.baseScore), link: `https://nvd.nist.gov/vuln/detail/${cve.id}`, quellen: ['nvd'] };
  });
}

/** OSV: Advisories zu Paket und Version eines Ökosystems (crates.io, PyPI, npm, Go, Maven, Debian:12, Ubuntu:24.04:LTS …) */
export async function osv(abruf: Abruf, oekosystem: string, paket: string, version: string): Promise<Advisory[]> {
  const r = await abruf('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package: { ecosystem: oekosystem, name: paket }, version }) });
  if (!r.ok) throw new Error(`OSV ${oekosystem}/${paket}: HTTP ${r.status}`);
  const j = await r.json() as { vulns?: Array<{ id: string; aliases?: string[]; summary?: string; details?: string; severity?: Array<{ type: string; score: string }>; database_specific?: { severity?: string }; affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> }> };
  return (j.vulns ?? []).map(x => {
    const cve = [x.id, ...(x.aliases ?? [])].find(a => a.startsWith('CVE-'));
    const fix = (x.affected ?? []).flatMap(a => a.ranges ?? []).flatMap(rg => rg.events ?? []).map(e => e.fixed).find(Boolean);
    const vektor = x.severity?.find(s => s.type === 'CVSS_V3')?.score ?? x.severity?.find(s => s.type === 'CVSS_V4')?.score;
    return { id: cve ?? x.id, aliase: [...new Set([x.id, ...(x.aliases ?? [])])], titel: (x.summary ?? x.details ?? '').slice(0, 300), ...(vektor ? { vektor } : {}),
      schwere: schwereAusText(x.database_specific?.severity), ...(fix ? { behoben: fix } : {}), link: `https://osv.dev/vulnerability/${x.id}`, quellen: ['osv'] };
  });
}

/** Zusammenführen über CVE/GHSA-Kennung: höchster Score, Vektor, Titel und behobene Version aus der ersten Quelle, die sie hat */
export function zusammenfuehren(listen: Advisory[][]): Advisory[] {
  const aus: Advisory[] = [];
  for (const a of listen.flat()) {
    const schl = new Set([a.id, ...a.aliase]);
    const da = aus.find(x => x.id === a.id || x.aliase.some(y => schl.has(y)));
    if (!da) { aus.push({ ...a, aliase: [...schl] }); continue; }
    if (a.id.startsWith('CVE-') && !da.id.startsWith('CVE-')) da.id = a.id;
    da.aliase = [...new Set([...da.aliase, ...schl])];
    if (typeof a.cvss === 'number' && (da.cvss === undefined || a.cvss > da.cvss)) { da.cvss = a.cvss; if (a.vektor) da.vektor = a.vektor; }
    if (rang(a.schwere) > rang(da.schwere)) da.schwere = a.schwere;
    if (!da.behoben && a.behoben) da.behoben = a.behoben;
    if (!da.titel && a.titel) da.titel = a.titel;
    da.quellen = [...new Set([...da.quellen, ...a.quellen])];
  }
  return aus;
}

/** EPSS je CVE (Wahrscheinlichkeit 0..1), Abruf in Blöcken zu 100 */
export async function epss(abruf: Abruf, cves: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const liste = [...new Set(cves.filter(c => /^CVE-\d{4}-\d+$/.test(c)))];
  for (let i = 0; i < liste.length; i += 100) {
    const r = await abruf(`https://api.first.org/data/v1/epss?cve=${liste.slice(i, i + 100).join(',')}`);
    if (!r.ok) throw new Error(`EPSS: HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<{ cve: string; epss: string }> };
    for (const d of j.data ?? []) m.set(d.cve, Number(d.epss));
  }
  return m;
}

/** CISA KEV: nachweislich ausgenutzte CVEs mit Aufnahmedatum */
export async function kev(abruf: Abruf): Promise<Map<string, string>> {
  const r = await abruf('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
  if (!r.ok) throw new Error(`KEV: HTTP ${r.status}`);
  const j = await r.json() as { vulnerabilities?: Array<{ cveID: string; dateAdded: string }> };
  return new Map((j.vulnerabilities ?? []).map(v => [v.cveID, v.dateAdded]));
}
