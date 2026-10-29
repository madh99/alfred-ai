/**
 * Anwendungs-Update-Bericht (Owner 29.10.: „auch bei VMs, die Anwendungen nativ und nicht in Docker installiert haben, wie pgsql“) —
 * nur lesend. Zwei Quellen je Host:
 *  1. native Pakete (apt): installierte → verfügbare Version, Sicherheitsquelle, neue HAUPTVERSION einer Paketfamilie
 *     (postgresql-17 → postgresql-18 wird nie per Upgrade eingespielt, deshalb eigens gesucht);
 *  2. Container: Image (Tag/Digest) gegen die Registry — gleicher Tag mit neuerem Build, neuere Versionen derselben Reihe.
 * Je Eintrag eine Art: datenbank (nie Standard), mit_daten (eigener Change mit Sicherung), zustandslos (Vorlage d möglich).
 */

export type UpdateArt = 'datenbank' | 'mit_daten' | 'zustandslos' | 'system';
export const DATENBANK = /(postgres|mariadb|mysql|mongo|redis|valkey|influx|timescale|clickhouse|elasticsearch|opensearch|cassandra|home-?assistant|zigbee2mqtt|mosquitto)/i;
/** Anwendungen mit eigener Datenbank oder Schema-Migrationen (ein Update ist ohne Wiederherstellung nicht umkehrbar) */
export const MIT_DATEN = /(synapse|vaultwarden|bitwarden|wordpress|nextcloud|gitlab|gitea|immich|paperless|guacamole|pgadmin|open-webui|grafana|n8n|authentik|keycloak|sydent)/i;

// ── native Pakete ──────────────────────────────────────────────

export interface AptUpdate { paket: string; quelle: string; neu: string; alt: string; sicherheit: boolean }

/** `apt list --upgradable`: „paket/noble-security 1.2 amd64 [upgradable from: 1.1]“ */
export function leseAptListe(t: string): AptUpdate[] {
  const aus: AptUpdate[] = [];
  for (const z of t.split(/\r?\n/)) {
    const m = /^([\w.+-]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/.exec(z.trim());
    if (m) aus.push({ paket: m[1]!, quelle: m[2]!, neu: m[3]!, alt: m[4]!.trim(), sicherheit: /-security\b/.test(m[2]!) });
  }
  return aus;
}

/** Paketfamilien mit Hauptversion im Namen (postgresql-17, php8.3, mariadb-server-10.11 …) — ein Upgrade wechselt sie nie */
const FAMILIE = /^(postgresql|php|nodejs|mariadb-server|mysql-server)-?(\d+(?:\.\d+)?)$/;

export function familieAus(paket: string): { familie: string; version: string } | undefined {
  const m = FAMILIE.exec(paket);
  return m ? { familie: m[1]!, version: m[2]! } : undefined;
}

// v1711 — Präfix „v“ (v1.9.8) zählt nicht: „v1“ war sonst 0 und v0.15.7 galt als neuer (Realfall livekit 29.10.)
const versionTupel = (v: string) => v.replace(/^v(?=\d)/i, '').split(/[.-]/).map(x => Number.parseInt(x, 10)).map(n => (Number.isFinite(n) ? n : 0));
export function versionGroesser(a: string, b: string): boolean {
  const x = versionTupel(a), y = versionTupel(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0; }
  return false;
}

/** Neue Hauptversionen: installierte Familie gegen verfügbare Paketnamen derselben Familie */
export function neueHauptversionen(installiert: string[], verfuegbar: string[]): Array<{ familie: string; installiert: string; verfuegbar: string }> {
  const aus: Array<{ familie: string; installiert: string; verfuegbar: string }> = [];
  const inst = new Map<string, string>();
  for (const p of installiert) { const f = familieAus(p); if (f && (!inst.has(f.familie) || versionGroesser(f.version, inst.get(f.familie)!))) inst.set(f.familie, f.version); }
  for (const [familie, v] of inst) {
    const hoechste = verfuegbar.map(familieAus).filter((f): f is { familie: string; version: string } => !!f && f.familie === familie).map(f => f.version).sort((a, b) => (versionGroesser(a, b) ? -1 : 1))[0];
    if (hoechste && versionGroesser(hoechste, v)) aus.push({ familie, installiert: v, verfuegbar: hoechste });
  }
  return aus;
}

export function aptArt(paket: string): UpdateArt {
  return DATENBANK.test(paket) ? 'datenbank' : MIT_DATEN.test(paket) ? 'mit_daten' : 'system';
}

// ── Container ──────────────────────────────────────────────────

export interface ImageRef { registry: string; repo: string; tag?: string; digest?: string }

/** „nginx:1.27“, „ghcr.io/a/b:2“, „registry.lokalkraft.at/x/y@sha256:…“ → Registry, Repository, Tag/Digest (Docker-Hub-Regeln) */
export function leseImageRef(ref: string): ImageRef {
  let rest = ref.trim(); let digest: string | undefined;
  const at = rest.indexOf('@'); if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); }
  let tag: string | undefined;
  const doppel = rest.lastIndexOf(':'); if (doppel > rest.lastIndexOf('/')) { tag = rest.slice(doppel + 1); rest = rest.slice(0, doppel); }
  const teile = rest.split('/');
  let registry = 'registry-1.docker.io';
  if (teile.length > 1 && /[.:]|^localhost$/.test(teile[0]!)) registry = teile.shift()!;
  if (registry === 'docker.io') registry = 'registry-1.docker.io';
  let repo = teile.join('/');
  if (registry === 'registry-1.docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  return { registry, repo, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

export function containerArt(c: { name: string; image: string; mounts?: unknown[] }): UpdateArt {
  const t = `${c.name} ${c.image}`;
  if (DATENBANK.test(t)) return 'datenbank';
  if (MIT_DATEN.test(t) || (c.mounts?.length ?? 0) > 0) return 'mit_daten';
  return 'zustandslos';
}

/** Neuere Tags derselben Reihe: gleiches Muster (Ziffern ersetzt), höher; getrennt nach gleicher und neuer Hauptversion */
export function neuereTags(tags: string[], aktuell: string): { gleicheHauptversion: string[]; neueHauptversion: string[] } {
  if (!/\d/.test(aktuell) || aktuell === 'latest') return { gleicheHauptversion: [], neueHauptversion: [] };
  const muster = new RegExp(`^${aktuell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+')}$`);
  const haupt = (v: string) => versionTupel(v)[0] ?? 0;
  const hoeher = tags.filter(t => t !== aktuell && muster.test(t) && versionGroesser(t, aktuell)).sort((a, b) => (versionGroesser(a, b) ? -1 : 1));
  return { gleicheHauptversion: hoeher.filter(t => haupt(t) === haupt(aktuell)).slice(0, 3), neueHauptversion: hoeher.filter(t => haupt(t) > haupt(aktuell)).slice(0, 3) };
}

type Abruf = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }>;
const MANIFEST = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json';

/** Anonymer Registry-Zugriff mit Token-Challenge (Docker Hub, ghcr, quay …); Docker Hub zählt HEAD-Anfragen nicht als Pull */
/**
 * Sicherheitsprüfung v1708 (SSRF): Registry-Host kommt aus dem Image-Namen eines fremden Hosts, die Token-Adresse aus der Antwort der
 * Registry — beides darf Alfred nicht an beliebige (interne) Adressen schicken. Deshalb nur diese öffentlichen Registries, Token nur per
 * HTTPS von deren bekannten Token-Diensten, Repository-Namen nur in der üblichen Form; Weiterleitungen behandelt der Aufrufer als Fehler.
 */
export const REGISTRIES: Record<string, string[]> = {
  'registry-1.docker.io': ['auth.docker.io'],
  'ghcr.io': ['ghcr.io'],
  'quay.io': ['quay.io'],
  'lscr.io': ['ghcr.io'],
  'mcr.microsoft.com': ['mcr.microsoft.com'],
  'registry.gitlab.com': ['gitlab.com'],
  'gcr.io': ['gcr.io'],
  'public.ecr.aws': ['public.ecr.aws'],
};
const REPO = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,4}$/;
const TAG = /^[\w][\w.-]{0,127}$/;

export function realmErlaubt(registry: string, realm: string): boolean {
  try { const u = new URL(realm); return u.protocol === 'https:' && !u.port && !u.username && (REGISTRIES[registry] ?? []).includes(u.hostname); } catch { return false; }
}

export async function registryAbfrage(ref: ImageRef, abruf: Abruf): Promise<{ digest?: string; tags?: string[]; tagDigests?: Record<string, string[]>; fehler?: string }> {
  if (!REGISTRIES[ref.registry]) return { fehler: `Registry ${ref.registry} nicht für Abfragen freigegeben` };
  if (!REPO.test(ref.repo) || (ref.tag && !TAG.test(ref.tag))) return { fehler: 'Image-Name nicht in der üblichen Form' };
  const basis = `https://${ref.registry}/v2/${ref.repo}`;
  let token: string | undefined;
  const mit = (h: Record<string, string>) => (token ? { ...h, Authorization: `Bearer ${token}` } : h);
  const hole = async (url: string, method: string, h: Record<string, string>) => {
    let r = await abruf(url, { method, headers: mit(h) });
    if (r.status === 401 && !token) {
      const ch = r.headers.get('www-authenticate') ?? '';
      const realm = /realm="([^"]+)"/.exec(ch)?.[1]; const service = /service="([^"]+)"/.exec(ch)?.[1];
      if (!realm || !realmErlaubt(ref.registry, realm)) return r;
      const t = await abruf(`${realm}?${new URLSearchParams({ ...(service ? { service } : {}), scope: `repository:${ref.repo}:pull` })}`);
      if (t.status !== 200) return r;
      const j = await t.json() as { token?: string; access_token?: string };
      token = j.token ?? j.access_token;
      r = await abruf(url, { method, headers: mit(h) });
    }
    return r;
  };
  try {
    const aus: { digest?: string; tags?: string[]; tagDigests?: Record<string, string[]>; fehler?: string } = {};
    if (ref.tag) {
      const r = await hole(`${basis}/manifests/${ref.tag}`, 'HEAD', { Accept: MANIFEST });
      if (r.status === 200) aus.digest = r.headers.get('docker-content-digest') ?? undefined;
      else aus.fehler = `Manifest ${r.status}`;
    }
    if (ref.registry === 'registry-1.docker.io') {
      // tags/list ist alphabetisch und bei großen Repos (postgres: >5000 Tags) abgeschnitten — Hub-API nach Aktualität
      const t = await abruf(`https://hub.docker.com/v2/repositories/${ref.repo}/tags?page_size=100&ordering=last_updated`);
      if (t.status === 200) {
        const res = ((await t.json()) as { results?: Array<{ name: string; digest?: string; images?: Array<{ digest?: string }> }> }).results ?? [];
        aus.tags = res.map(x => x.name);
        // v1710 — Digest je Tag (Index und Einzel-Images): für Container, die nur per Digest festgelegt sind
        aus.tagDigests = Object.fromEntries(res.map(x => [x.name, [x.digest, ...(x.images ?? []).map(i => i.digest)].filter((y): y is string => !!y)]));
      }
    } else {
      const t = await hole(`${basis}/tags/list?n=1000`, 'GET', {});
      if (t.status === 200) aus.tags = ((await t.json()) as { tags?: string[] }).tags ?? [];
    }
    return aus;
  } catch (err) { return { fehler: (err as Error).message.slice(0, 120) }; }
}

// ── Bericht ────────────────────────────────────────────────────

export interface ContainerStand { host: string; name: string; image: string; art: UpdateArt; tag?: string; neuerBuild?: boolean; gleicheHauptversion: string[]; neueHauptversion: string[]; hinweis?: string }
export interface HostStand { host: string; apt: AptUpdate[]; hauptversionen: Array<{ familie: string; installiert: string; verfuegbar: string }>; updatesSchalter: boolean; fehler?: string }

const ART_TEXT: Record<UpdateArt, string> = { datenbank: 'Datenbank — nie Standard, eigener Change', mit_daten: 'mit Daten/Schema — eigener Change mit Sicherung', zustandslos: 'zustandslos — Vorlage (d) möglich', system: 'System' };

export function berichtText(hosts: HostStand[], container: ContainerStand[], jetzt: Date): string {
  const z: string[] = [`# Anwendungs-Updates ${jetzt.toISOString().slice(0, 10)}`, '', 'Nur gelesen, nichts geändert. Betriebssystem-Pakete auf Hosts mit Update-Schalter spielt die wöchentliche Vorlage ein; hier steht, was darüber hinaus ansteht.', ''];
  z.push('## Native Anwendungen (apt)', '');
  for (const h of hosts) {
    if (h.fehler) { z.push(`- **${h.host}**: nicht gelesen (${h.fehler})`); continue; }
    const app = h.apt.filter(a => aptArt(a.paket) !== 'system');
    const sys = h.apt.filter(a => aptArt(a.paket) === 'system');
    const sich = h.apt.filter(a => a.sicherheit).length;
    z.push(`- **${h.host}**${h.updatesSchalter ? ' (wöchentliche OS-Updates an)' : ''}: ${h.apt.length} Pakete${sich ? `, davon ${sich} Sicherheit` : ''}${sys.length && !app.length ? ' — nur System' : ''}`);
    for (const a of app) z.push(`  - ${a.paket} ${a.alt} → ${a.neu}${a.sicherheit ? ' **Sicherheit**' : ''} · ${ART_TEXT[aptArt(a.paket)]}`);
    for (const hv of h.hauptversionen) z.push(`  - Neue Hauptversion verfügbar: ${hv.familie} ${hv.installiert} → ${hv.verfuegbar} (nie automatisch; Upgrade nur als geplanter Change)`);
  }
  z.push('', '## Container', '');
  const mitUpdate = container.filter(c => c.neuerBuild || c.gleicheHauptversion.length || c.neueHauptversion.length);
  if (!mitUpdate.length) z.push('- keine neueren Images gefunden');
  for (const c of mitUpdate) {
    const was = [c.neuerBuild ? `neuer Build für ${c.tag}` : '', c.gleicheHauptversion.length ? `neuere Versionen: ${c.gleicheHauptversion.join(', ')}` : '', c.neueHauptversion.length ? `neue Hauptversion: ${c.neueHauptversion.join(', ')}` : ''].filter(Boolean).join(' · ');
    z.push(`- **${c.host} / ${c.name}** (${c.image}): ${was} — ${ART_TEXT[c.art]}`);
  }
  const ohne = container.filter(c => c.hinweis);
  if (ohne.length) z.push('', `Nicht prüfbar: ${ohne.map(c => `${c.host}/${c.name} (${c.hinweis})`).join(', ')}`);
  return z.join('\n');
}

// ── Sammeln (nur Leseliste) ────────────────────────────────────

export const UPDATE_BEFEHLE = {
  os: 'cat /etc/os-release',
  apt: 'apt list --upgradable',
  pakete: 'dpkg -l',
  docker: 'systemctl is-active docker',
  container: "docker ps --format '{{.Names}} {{.Image}} {{.Mounts}}'",
} as const;
export const familienBefehl = (familie: string) => `apt-cache pkgnames ${familie}`;
export const imageBefehl = (images: string[]) => `docker image inspect --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}}' ${images.join(' ')}`;
export const containerBefehl = (namen: string[]) => `docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' ${namen.join(' ')}`;

export interface SammelDeps {
  hosts: Array<{ name: string; updatesSchalter: boolean }>;
  lesen: (zugang: string, befehl: string) => Promise<string>;
  abruf: Abruf;
}

/** Liest alle Hosts nacheinander; Registry-Abfragen je Image nur einmal (mehrere Hosts mit demselben Image) */
export async function sammleAnwendungsUpdates(d: SammelDeps): Promise<{ hosts: HostStand[]; container: ContainerStand[] }> {
  const hosts: HostStand[] = []; const container: ContainerStand[] = [];
  const registry = new Map<string, Promise<Awaited<ReturnType<typeof registryAbfrage>>>>();
  for (const h of d.hosts) {
    const stand: HostStand = { host: h.name, apt: [], hauptversionen: [], updatesSchalter: h.updatesSchalter };
    try {
      const os = await d.lesen(h.name, UPDATE_BEFEHLE.os);
      if (!/^(ID|ID_LIKE)="?[\w ]*(debian|ubuntu)/m.test(os)) { stand.fehler = 'kein apt-System'; hosts.push(stand); continue; }
      stand.apt = leseAptListe(await d.lesen(h.name, UPDATE_BEFEHLE.apt));
      const inst = (await d.lesen(h.name, UPDATE_BEFEHLE.pakete)).split(/\r?\n/).filter(z => /^ii\s/.test(z)).map(z => z.trim().split(/\s+/)[1]!.split(':')[0]!);
      const familien = [...new Set(inst.map(familieAus).filter((f): f is { familie: string; version: string } => !!f).map(f => f.familie))];
      for (const f of familien) {
        const verf = (await d.lesen(h.name, familienBefehl(f)).catch(() => '')).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        stand.hauptversionen.push(...neueHauptversionen(inst.filter(p => familieAus(p)?.familie === f), verf));
      }
    } catch (err) { stand.fehler = (err as Error).message.slice(0, 160); }
    hosts.push(stand);

    const dockerAn = (await d.lesen(h.name, UPDATE_BEFEHLE.docker).catch(() => '')).trim() === 'active';
    if (!dockerAn) continue;
    let liste: Array<{ name: string; image: string; mounts: string[] }> = [];
    try {
      liste = (await d.lesen(h.name, UPDATE_BEFEHLE.container)).split(/\r?\n/).filter(z => z.trim().split(/\s+/).length >= 2).map(z => { const [name, image, m] = z.trim().split(/\s+/); return { name: name!.trim(), image: image!.trim(), mounts: (m ?? '').split(',').map(x => x.trim()).filter(Boolean) }; });
    } catch (err) { stand.fehler = `${stand.fehler ? `${stand.fehler}; ` : ''}Container: ${(err as Error).message.slice(0, 120)}`; continue; }
    if (!liste.length) continue;
    // v1709 — Realfall 29.10.: nach dem Umzug zeigt docker ps nur die Image-ID (Container aus Digest/ID angelegt). Referenz aus
    // Config.Image, Tags und Digests über die Image-ID des Containers.
    const konfig = new Map<string, { ref: string; id: string }>();
    for (const z of (await d.lesen(h.name, containerBefehl(liste.map(c => c.name))).catch(() => '')).split(/\r?\n/)) {
      const [n, ref, id] = z.trim().split(/\s+/);
      if (n && ref && id) konfig.set(n.replace(/^\//, ''), { ref, id });
    }
    const ids = [...new Set([...konfig.values()].map(k => k.id).filter(i => /^sha256:[0-9a-f]{64}$/.test(i)))];
    const bild = new Map<string, { tags: string[]; digests: string[] }>();
    if (ids.length) {
      for (const z of (await d.lesen(h.name, imageBefehl(ids)).catch(() => '')).split(/\r?\n/)) {
        const m = /^(sha256:[0-9a-f]{64}) (\S+) (\S+)$/.exec(z.trim());
        if (!m) continue;
        try { bild.set(m[1]!, { tags: (JSON.parse(m[2]!) as string[] | null) ?? [], digests: (JSON.parse(m[3]!) as string[] | null) ?? [] }); } catch { /* nicht lesbar */ }
      }
    }
    for (const c of liste) {
      const k = konfig.get(c.name); const b = k ? bild.get(k.id) : undefined;
      const referenz = waehleReferenz(c.image, k?.ref, b?.tags ?? []);
      const st: ContainerStand = { host: h.name, name: c.name, image: referenz ?? c.image, art: containerArt({ ...c, image: referenz ?? c.image }), gleicheHauptversion: [], neueHauptversion: [] };
      container.push(st);
      if (!referenz) {
        // v1710 — nur per Digest festgelegt (Umzug per RepoDigest): Tag über den Digest bestimmen (Docker Hub), nie gegen :latest raten
        const dr = (b?.digests ?? [])[0] ?? [c.image, k?.ref].find(x => x?.includes('@'));
        if (!dr) { st.hinweis = 'nur Image-ID'; continue; }
        st.art = containerArt({ ...c, image: dr });
        const ref = leseImageRef(dr); const eigene = new Set((b?.digests ?? [dr]).map(x => x.slice(x.indexOf('@') + 1)));
        st.image = `${ref.registry === 'registry-1.docker.io' ? ref.repo.replace(/^library\//, '') : `${ref.registry}/${ref.repo}`}@…${[...eigene][0]?.slice(-12) ?? ''}`;
        const schl = `${ref.registry}/${ref.repo}`;
        if (!registry.has(schl)) registry.set(schl, registryAbfrage({ registry: ref.registry, repo: ref.repo }, d.abruf));
        const r = await registry.get(schl)!;
        if (!r.tagDigests) { st.hinweis = r.fehler ?? 'per Digest festgelegt — Tag nicht bestimmbar'; continue; }
        const passend = Object.entries(r.tagDigests).filter(([, ds]) => ds.some(x => eigene.has(x))).map(([t]) => t);
        // genaueste reine Version (1.27.3 vor 1.27 vor 1), sonst ein Tag mit Ziffern (1.27-alpine), sonst latest/stable
        const tag = passend.filter(t => /^v?\d+(\.\d+)*$/.test(t)).sort((x, y) => y.length - x.length)[0] ?? passend.filter(t => /\d/.test(t)).sort((x, y) => x.length - y.length)[0] ?? passend[0];
        if (!tag) { st.hinweis = 'per Digest festgelegt — gehört zu keinem der 100 zuletzt aktualisierten Tags (vermutlich veraltet)'; continue; }
        st.tag = tag; st.image = `${st.image} (= ${tag})`; st.neuerBuild = false;
        if (r.tags?.length) Object.assign(st, neuereTags(r.tags, tag));
        continue;
      }
      const ref = leseImageRef(referenz); const tag = ref.tag ?? 'latest';
      st.tag = tag;
      const schluessel = `${ref.registry}/${ref.repo}:${tag}`;
      if (!registry.has(schluessel)) registry.set(schluessel, registryAbfrage({ ...ref, tag }, d.abruf));
      const r = await registry.get(schluessel)!;
      const digests = (b?.digests ?? []).filter(x => leseImageRef(x.slice(0, x.indexOf('@'))).repo === ref.repo).map(x => x.slice(x.indexOf('@') + 1));
      if (r.fehler && !r.digest) st.hinweis = r.fehler;
      else if (r.digest && digests.length) st.neuerBuild = !digests.includes(r.digest);
      else if (!digests.length) st.hinweis = 'lokal gebaut oder ohne Registry-Digest';
      if (r.tags?.length) Object.assign(st, neuereTags(r.tags, tag));
    }
  }
  return { hosts, container };
}

/** Image-Referenz mit Tag: angezeigtes Image, sonst Config.Image, sonst ein RepoTag (bei Digest-Referenz bevorzugt dasselbe Repository) */
export function waehleReferenz(angezeigt: string, konfig: string | undefined, repoTags: string[]): string | undefined {
  const istId = (x: string) => /^sha256:|^[0-9a-f]{12,64}$/.test(x);
  for (const x of [angezeigt, konfig]) if (x && !istId(x) && !x.includes('@')) return x;
  repoTags = repoTags.filter(t => !t.includes('@')); // v1710 — containerd-Image-Store führt Digest-Referenzen auch als RepoTag
  const digestRef = [angezeigt, konfig].find(x => x?.includes('@'));
  if (digestRef) { const repo = leseImageRef(digestRef).repo; return repoTags.find(t => leseImageRef(t).repo === repo); }
  return repoTags[0];
}
