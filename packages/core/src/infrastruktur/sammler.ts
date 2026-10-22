/**
 * Spec Infrastruktur-Vorhaben, I1 (Owner 22.10.2026 „I1 wie vorgeschlagen umsetzen“) — Bestandsaufnahme, nur lesend.
 *
 * Feste Sammler je Plattform statt freier Befehle: dieselben Lesebefehle für jeden Linux-Host (alle auf der Leseliste des
 * Fernzugriffs oder im Lese-Käfig), Parser ohne Modell. Ergebnis ist ein strukturierter Host-Bestand für CMDB und Bericht.
 */

export interface ContainerBestand {
  name: string; image: string; zustand: string; status: string; gesundheit?: 'healthy' | 'unhealthy' | 'starting';
  ports: string; netze: string[]; mounts: string[]; composeProjekt?: string; composeDienst?: string;
}
export interface HostBestand {
  zugang: string; host: string;
  os?: { name: string; id?: string; version?: string };
  kernel?: string; cpus?: number;
  ram?: { gesamt: number; belegt: number };
  dateisysteme: Array<{ mount: string; groesse: string; belegt: string; prozent: number; typ?: string }>;
  dienste: string[];
  ports: Array<{ adresse: string; port: number; prozess?: string }>;
  updates?: { anzahl: number; sicherheit: number };
  container: ContainerBestand[];
  compose: Array<{ name: string; status: string; dateien: string }>;
  volumes: Array<{ name: string; groesse: string }>;
  fehler: string[];
}

/** Die festen Lesebefehle (Schlüssel → Befehl). Docker nur, wenn vorhanden; Updates je Paketverwaltung. */
export const LINUX_BEFEHLE = {
  os: 'cat /etc/os-release',
  kernel: 'uname -r',
  cpus: 'nproc',
  ram: 'free -b',
  df: 'df -hT',
  dienste: 'systemctl list-units --type=service --state=running --no-pager',
  ports: 'ss -tlnp',
  updatesApt: 'apt list --upgradable',
  docker: "docker ps -a --no-trunc --format '{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Networks}}\\t{{.Mounts}}'",
  compose: 'docker compose ls -a',
  volumes: 'docker system df -v',
} as const;

/** Compose-Zuordnung je Container (nur diese beiden Labels, keine Umgebung). */
export function composeBefehl(namen: string[]): string {
  return `docker inspect --format '{{.Name}},{{index .Config.Labels "com.docker.compose.project"}},{{index .Config.Labels "com.docker.compose.service"}}' ${namen.join(' ')}`;
}

export function leseOs(t: string): HostBestand['os'] | undefined {
  const w: Record<string, string> = {};
  for (const z of t.split(/\r?\n/)) { const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(z.trim()); if (m) w[m[1]!] = m[3]!; }
  if (!w.PRETTY_NAME && !w.NAME) return undefined;
  return { name: w.PRETTY_NAME ?? w.NAME!, id: w.ID, version: w.VERSION_ID };
}

export function leseRam(t: string): HostBestand['ram'] | undefined {
  const z = t.split(/\r?\n/).find(l => /^Mem:/i.test(l.trim()));
  if (!z) return undefined;
  const n = z.trim().split(/\s+/);
  return { gesamt: Number(n[1]) || 0, belegt: Number(n[2]) || 0 };
}

export function leseDf(t: string): HostBestand['dateisysteme'] {
  const aus: HostBestand['dateisysteme'] = [];
  for (const z of t.split(/\r?\n/).slice(1)) {
    const n = z.trim().split(/\s+/);
    if (n.length < 7) continue;
    const [, typ, groesse, belegt, , pro, mount] = n;
    if (/^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|fuse\.lxcfs|nsfs)$/.test(typ!) || mount!.startsWith('/run') || mount!.startsWith('/dev')) continue;
    aus.push({ mount: mount!, groesse: groesse!, belegt: belegt!, prozent: Number(pro!.replace('%', '')) || 0, typ });
  }
  return aus;
}

export function leseDienste(t: string): string[] {
  return t.split(/\r?\n/).map(z => /^\s*●?\s*([\w@.-]+)\.service\s+loaded\s+active\s+running/.exec(z)?.[1]).filter((x): x is string => !!x);
}

export function lesePorts(t: string): HostBestand['ports'] {
  const aus: HostBestand['ports'] = [];
  for (const z of t.split(/\r?\n/).slice(1)) {
    const n = z.trim().split(/\s+/);
    if (n[0] !== 'LISTEN' || !n[3]) continue;
    const m = /^(.*):(\d+)$/.exec(n[3]);
    if (!m) continue;
    const prozess = /users:\(\("([^"]+)"/.exec(z)?.[1];
    const port = Number(m[2]);
    if (!aus.some(p => p.port === port && p.adresse === m[1])) aus.push({ adresse: m[1]!, port, ...(prozess ? { prozess } : {}) });
  }
  return aus.sort((a, b) => a.port - b.port);
}

export function leseAptUpdates(t: string): HostBestand['updates'] {
  const zeilen = t.split(/\r?\n/).filter(z => /\/\S+\s+\S+\s+\S+\s+\[upgradable from/.test(z));
  return { anzahl: zeilen.length, sicherheit: zeilen.filter(z => /-security\b/.test(z)).length };
}

export function leseDocker(t: string): ContainerBestand[] {
  const aus: ContainerBestand[] = [];
  for (const z of t.split(/\r?\n/)) {
    const n = z.split('\t');
    if (n.length < 7 || !n[0]) continue;
    const status = n[3] ?? '';
    const gesundheit = /\(healthy\)/.test(status) ? 'healthy' : /\(unhealthy\)/.test(status) ? 'unhealthy' : /health: starting/.test(status) ? 'starting' : undefined;
    aus.push({
      name: n[0], image: n[1] ?? '', zustand: n[2] ?? '', status, ...(gesundheit ? { gesundheit } : {}),
      ports: n[4] ?? '', netze: (n[5] ?? '').split(',').map(s => s.trim()).filter(Boolean), mounts: (n[6] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    });
  }
  return aus;
}

export function leseComposeZuordnung(t: string): Map<string, { projekt?: string; dienst?: string }> {
  const m = new Map<string, { projekt?: string; dienst?: string }>();
  for (const z of t.split(/\r?\n/)) {
    const [name, projekt, dienst] = z.split(',');
    if (!name) continue;
    m.set(name.replace(/^\//, '').trim(), { ...(projekt?.trim() && projekt.trim() !== '<no value>' ? { projekt: projekt.trim() } : {}), ...(dienst?.trim() && dienst.trim() !== '<no value>' ? { dienst: dienst.trim() } : {}) });
  }
  return m;
}

export function leseComposeLs(t: string): HostBestand['compose'] {
  const aus: HostBestand['compose'] = [];
  for (const z of t.split(/\r?\n/).slice(1)) {
    const n = z.trim().split(/\s+/);
    if (n.length < 3) continue;
    const dateien = n[n.length - 1]!; // Pfade ohne Leerzeichen, mehrere mit Komma
    aus.push({ name: n[0]!, status: n.slice(1, -1).join(' '), dateien });
  }
  return aus;
}

export function leseVolumes(t: string): HostBestand['volumes'] {
  const aus: HostBestand['volumes'] = [];
  const i = t.search(/Local Volumes space usage:/i);
  if (i < 0) return aus;
  const zeilen = t.slice(i).split(/\r?\n/).slice(1);
  let inTabelle = false;
  for (const z of zeilen) {
    if (!z.trim()) { if (inTabelle) break; continue; } // Leerzeile vor der Tabelle überspringen, nach ihr Ende
    if (/^VOLUME NAME/i.test(z.trim())) { inTabelle = true; continue; }
    const n = z.trim().split(/\s+/);
    if (inTabelle && n.length >= 3) aus.push({ name: n[0]!, groesse: n[n.length - 1]! });
  }
  return aus;
}

/** Sammelt den Bestand eines Linux-Hosts mit den festen Lesebefehlen. `lesen` liefert stdout (geschwärzt) oder wirft. */
export async function sammleLinux(zugang: string, host: string, lesen: (befehl: string) => Promise<string>): Promise<HostBestand> {
  const b: HostBestand = { zugang, host, dateisysteme: [], dienste: [], ports: [], container: [], compose: [], volumes: [], fehler: [] };
  const versuch = async <T>(schluessel: string, befehl: string, f: (t: string) => T): Promise<T | undefined> => {
    try { return f(await lesen(befehl)); } catch (err) { b.fehler.push(`${schluessel}: ${(err as Error).message.slice(0, 160)}`); return undefined; }
  };
  b.os = await versuch('os', LINUX_BEFEHLE.os, leseOs);
  b.kernel = (await versuch('kernel', LINUX_BEFEHLE.kernel, t => t.trim())) || undefined;
  b.cpus = await versuch('cpus', LINUX_BEFEHLE.cpus, t => Number(t.trim()) || undefined);
  b.ram = await versuch('ram', LINUX_BEFEHLE.ram, leseRam);
  b.dateisysteme = (await versuch('df', LINUX_BEFEHLE.df, leseDf)) ?? [];
  b.dienste = (await versuch('dienste', LINUX_BEFEHLE.dienste, leseDienste)) ?? [];
  b.ports = (await versuch('ports', LINUX_BEFEHLE.ports, lesePorts)) ?? [];
  if (/debian|ubuntu/i.test(`${b.os?.id ?? ''} ${b.os?.name ?? ''}`)) b.updates = await versuch('updates', LINUX_BEFEHLE.updatesApt, leseAptUpdates);
  const hatDocker = b.dienste.some(d => /^(docker|containerd)$/.test(d));
  if (hatDocker) {
    b.container = (await versuch('docker', LINUX_BEFEHLE.docker, leseDocker)) ?? [];
    if (b.container.length) {
      const zuordnung = await versuch('compose-zuordnung', composeBefehl(b.container.map(c => c.name)), leseComposeZuordnung);
      for (const c of b.container) { const z = zuordnung?.get(c.name); if (z?.projekt) c.composeProjekt = z.projekt; if (z?.dienst) c.composeDienst = z.dienst; }
    }
    b.compose = (await versuch('compose', LINUX_BEFEHLE.compose, leseComposeLs)) ?? [];
    b.volumes = (await versuch('volumes', LINUX_BEFEHLE.volumes, leseVolumes)) ?? [];
  }
  return b;
}
