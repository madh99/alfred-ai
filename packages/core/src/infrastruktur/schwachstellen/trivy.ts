/**
 * Spec Schwachstellen-Überwachung §3.2 / Owner-Entscheidung 4 (Trivy ja) — Image-Scan zentral auf dem Alfred-Server: Trivy läuft als
 * Container in fester Version (Digest gepinnt), mit eigenem Cache-Volume, nur lesend gegen die Registry. Images aus der eigenen Registry
 * oder lokal gebaute sind von hier nicht abrufbar → „nicht geprüft“ mit Grund (nie still übergangen).
 */
import { schwereAusScore, type Advisory, type Schwere } from './quellen.js';

/** aquasec/trivy 0.76.2 (05.11.2026), Index-Digest */
export const TRIVY_IMAGE = 'aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb';
const REF = /^[a-z0-9]([a-z0-9._/-]{0,250})(:[\w.-]{1,128})?(@sha256:[0-9a-f]{64})?$/;

/** Argumente für `docker` (ohne Shell) */
export function trivyArgumente(image: string): string[] {
  if (!REF.test(image)) throw new Error(`ungültige Image-Referenz ${image.slice(0, 80)}`);
  return ['run', '--rm', '-v', 'alfred-trivy-cache:/root/.cache/', TRIVY_IMAGE, 'image', '--quiet', '--format', 'json', '--scanners', 'vuln', '--timeout', '15m', '--skip-version-check', image];
}

export interface TrivyTreffer extends Advisory { paket: string; installiert: string; status: string }

const schwereTrivy = (s: unknown): Schwere => {
  const x = String(s ?? '').toUpperCase();
  return x === 'CRITICAL' ? 'kritisch' : x === 'HIGH' ? 'hoch' : x === 'MEDIUM' ? 'mittel' : x === 'LOW' ? 'niedrig' : 'unbekannt';
};

/** Trivy-JSON → Treffer je (Kennung, Paket); Score bevorzugt NVD, sonst GHSA, sonst Hersteller */
export function leseTrivy(json: string, ref?: string): { treffer: TrivyTreffer[]; os?: string; digest?: string } {
  const j = JSON.parse(json) as { Metadata?: { OS?: { Family?: string; Name?: string }; RepoDigests?: string[] }; Results?: Array<{ Target?: string; Vulnerabilities?: Array<{ VulnerabilityID: string; PkgName: string; InstalledVersion?: string; FixedVersion?: string; Status?: string; Severity?: string; Title?: string; PrimaryURL?: string; CVSS?: Record<string, { V3Score?: number; V3Vector?: string; V40Score?: number; V40Vector?: string }> }> }> };
  const treffer: TrivyTreffer[] = []; const gesehen = new Set<string>();
  for (const r of j.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      const k = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion ?? ''}`;
      if (gesehen.has(k)) continue; gesehen.add(k);
      const c = v.CVSS ?? {};
      const quelle = c.nvd ?? c.ghsa ?? Object.values(c)[0];
      const score = quelle?.V3Score ?? quelle?.V40Score;
      const vektor = quelle?.V3Vector ?? quelle?.V40Vector;
      const s = schwereTrivy(v.Severity);
      treffer.push({ id: v.VulnerabilityID, aliase: [v.VulnerabilityID], titel: (v.Title ?? '').slice(0, 300), ...(typeof score === 'number' ? { cvss: score } : {}), ...(vektor ? { vektor } : {}),
        schwere: s !== 'unbekannt' ? s : schwereAusScore(score), ...(v.FixedVersion ? { behoben: v.FixedVersion } : {}), link: v.PrimaryURL ?? `https://avd.aquasec.com/nvd/${v.VulnerabilityID.toLowerCase()}`,
        quellen: ['trivy'], paket: v.PkgName, installiert: v.InstalledVersion ?? '', status: v.Status ?? '' });
    }
  }
  const os = j.Metadata?.OS ? `${j.Metadata.OS.Family ?? ''} ${j.Metadata.OS.Name ?? ''}`.trim() : undefined;
  // v1966 — Digest des gescannten Images (Zielprüfung A2: Ziel-Image genau benennen)
  // nur ein Digest desselben Repositorys wie die gescannte Referenz — sonst keiner (kein Festlegen auf ein anderes Artefakt)
  const digest = ref ? j.Metadata?.RepoDigests?.map(d => /^(.+)@(sha256:[0-9a-f]{64})$/.exec(d)).find(m => !!m && repoVon(m[1]!) === repoVon(ref))?.[2] : undefined;
  return { treffer, ...(os ? { os } : {}), ...(digest ? { digest } : {}) };
}

/** Repository einer Image-Referenz ohne Tag, Digest und Docker-Hub-Präfixe (docker.io/, library/) */
export function repoVon(ref: string): string {
  const ohne = ref.replace(/@sha256:[0-9a-f]{64}$/, '');
  const teile = ohne.split('/'); const letzter = teile.pop()!.split(':')[0]!;
  return [...teile, letzter].join('/').replace(/^(docker\.io\/|index\.docker\.io\/|registry-1\.docker\.io\/)/, '').replace(/^library\//, '');
}
