/**
 * Portainer-Skill (Owner 27.11.2026) — Stacks über die Portainer-API statt am Portainer vorbei.
 *
 * Anlass: NPM (373bea9e) brauchte einen Owner-Schritt in Portainer, Node-RED (42ed9669) brach mit NR_STACK_ENV_DRIFT ab — Portainer führt
 * Stack-Variablen in seiner Datenbank, nicht in der Compose-Datei. Ein Neuaufbau mit `docker compose` an Portainer vorbei verliert sie.
 * Über die API stellt Portainer selbst neu bereit: Datei + gespeicherte Variablen, Projektname und Stack-Zuordnung bleiben.
 *
 * Sicherheit:
 *  - API-Token nur aus dem Tresor (`portainer-<zugang>`), nie an das Modell, nie in Logs; jede Ausgabe ohne den Wert.
 *  - HTTPS mit Zertifikat-Pinning: der SHA-256-Fingerabdruck wird bei jedem Aufruf über den vorhandenen SSH-Fernzugang vom Host
 *    gelesen (Zertifikat im /data-Mount des Portainer-Containers) und auf derselben TLS-Verbindung geprüft, die das Token trägt.
 *    Kein Klartext-HTTP (Port 9000), keine abgeschaltete Zertifikatsprüfung.
 *  - lesend (list_stacks) auch außerhalb von Changes; ändernd (image_setzen, stack_zuruecksetzen) nur als Schritt eines
 *    freigegebenen Changes. image_setzen sichert die bisherige Datei; Rückweg genau stack_zuruecksetzen.
 *  - Variablenwerte und Dateiinhalt gehen nie ans Modell (nur Namen, Dienste, Images, SHA-256).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { ohneGeheimnisse } from './tresor.js';

export const PORTAINER_LESEND = new Set(['list_stacks']);
export const PORTAINER_NUR_IM_CHANGE = new Set(['image_setzen', 'stack_zuruecksetzen']);
const ZUGANG = /^[A-Za-z0-9][\w.-]{0,63}$/;
/** Image-Referenz: repo[:tag][@sha256:…] ohne Leerzeichen/Anführungszeichen */
const IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,200}(@sha256:[0-9a-f]{64})?$/;
const DIENST = /^[A-Za-z0-9][\w.-]{0,63}$/;

export const tresorName = (zugang: string) => `portainer-${zugang.toLowerCase()}`;
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** Fester Leseschritt auf dem Host: Port 9443 und Fingerabdruck des Portainer-Zertifikats (keine Eingaben des Modells im Befehl). */
export const FINGERABDRUCK_SKRIPT = [
  'set -eu',
  "c=$(docker ps --format '{{.ID}} {{.Image}}' | grep -E ' (docker\\.io/)?portainer/portainer-(ce|ee)([:@]|$)' || true)",
  '[ "$(printf \'%s\\n\' "$c" | grep -c .)" = 1 ] || { echo PORTAINER_NICHT_EINDEUTIG; exit 3; }',
  'id=${c%% *}',
  "d=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Source}}{{end}}{{end}}' \"$id\")",
  "p=$(docker inspect --format '{{with index .NetworkSettings.Ports \"9443/tcp\"}}{{(index . 0).HostPort}}{{end}}' \"$id\")",
  '[ -n "$d" ] && [ -n "$p" ] && [ -f "$d/certs/cert.pem" ] || { echo PORTAINER_OHNE_9443_ODER_ZERTIFIKAT; exit 3; }',
  'f=$(openssl x509 -in "$d/certs/cert.pem" -noout -fingerprint -sha256)',
  'echo "PORTAINER $p ${f#*=}"',
].join('\n');

export function leseFingerabdruck(ausgabe: string): { port: number; fingerabdruck: string } {
  const m = /PORTAINER (\d{2,5}) ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})\s*$/m.exec(ausgabe);
  if (!m) throw new Error(/PORTAINER_[A-Z0-9_]+/.exec(ausgabe)?.[0] ?? 'Portainer-Zertifikat auf dem Host nicht lesbar');
  return { port: Number(m[1]), fingerabdruck: m[2]! };
}

/** Dienste und Images aus einer Compose-Datei (zeilenbasiert: services → Dienst auf der ersten Einrückung → image:). */
export function dienstImages(datei: string): Array<{ dienst: string; image?: string; zeile?: number }> {
  const z = datei.split(/\r?\n/);
  const aus: Array<{ dienst: string; image?: string; zeile?: number }> = [];
  let inServices = false; let einzug = -1; let akt: { dienst: string; image?: string; zeile?: number } | undefined;
  for (let i = 0; i < z.length; i++) {
    const l = z[i]!;
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const e = l.length - l.trimStart().length;
    if (e === 0) { inServices = /^services:\s*(#.*)?$/.test(l); einzug = -1; akt = undefined; continue; }
    if (!inServices) continue;
    if (einzug < 0) einzug = e;
    if (e === einzug) {
      const m = /^\s*["']?([\w.-]+)["']?:\s*(#.*)?$/.exec(l);
      akt = m ? { dienst: m[1]! } : undefined; if (akt) aus.push(akt);
      continue;
    }
    const im = /^(\s*)image:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(l);
    if (akt && im && e > einzug && akt.image === undefined) { akt.image = im[2]!; akt.zeile = i; }
  }
  return aus;
}

/**
 * v1973 — environment-Schlüssel und env_file eines Dienstes (zeilenbasiert; Listenform „- KEY=…“/„- KEY“ und Mapform „KEY: …“).
 * Nur Namen, nie Werte.
 */
export function dienstUmgebung(datei: string, dienst: string): { schluessel: Set<string>; envFile: boolean } {
  const z = datei.split(/\r?\n/);
  const schluessel = new Set<string>(); let envFile = false;
  let inServices = false; let einzug = -1; let drin = false; let envEinzug = -1;
  for (const l of z) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const e = l.length - l.trimStart().length;
    if (e === 0) { inServices = /^services:\s*(#.*)?$/.test(l); einzug = -1; drin = false; envEinzug = -1; continue; }
    if (!inServices) continue;
    if (einzug < 0) einzug = e;
    if (e === einzug) { drin = new RegExp(`^\\s*["']?${dienst.replace(/[.]/g, '\\.')}["']?:\\s*(#.*)?$`).test(l); envEinzug = -1; continue; }
    if (!drin) continue;
    if (envEinzug >= 0 && e > envEinzug) {
      const m = /^\s*-\s*["']?([A-Za-z_][\w.-]*)/.exec(l) ?? /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*:/.exec(l);
      if (m) schluessel.add(m[1]!);
      continue;
    }
    envEinzug = -1;
    if (/^\s*environment:\s*(#.*)?$/.test(l)) envEinzug = e;
    else if (/^\s*env_file:/.test(l)) envFile = true;
  }
  return { schluessel, envFile };
}

/**
 * v1973 — Laufzeit gegen Image + Stack-Datei (nur Namen): Namen im Container, die die Datei nicht setzt und die nicht (mit gleichem
 * Wert) aus dem Image kommen. Eine Neubereitstellung durch Portainer verlöre genau diese — Werte verlassen die Funktion nie.
 */
export function envAbweichung(container: string[], image: string[], dateiSchluessel: Set<string>): string[] {
  const karte = (l: string[]) => new Map(l.map(v => { const i = v.indexOf('='); return i < 0 ? [v, ''] as const : [v.slice(0, i), v.slice(i + 1)] as const; }));
  const c = karte(container); const im = karte(image);
  return [...c.keys()].filter(n => !dateiSchluessel.has(n) && (!im.has(n) || im.get(n) !== c.get(n))).sort();
}

/** Genau die image-Zeile eines Dienstes ersetzen; alles andere bleibt bytegleich. */
export function imageErsetzen(datei: string, dienst: string, image: string): { datei: string; vorher: string } {
  const d = dienstImages(datei).filter(x => x.dienst === dienst);
  if (d.length !== 1) throw new Error(`Dienst ${dienst} ${d.length ? 'mehrfach' : 'nicht'} in der Stack-Datei`);
  const t = d[0]!;
  if (t.zeile === undefined || !t.image) throw new Error(`Dienst ${dienst} hat keine image-Zeile`);
  const nl = datei.includes('\r\n') ? '\r\n' : '\n';
  const z = datei.split(/\r?\n/);
  const alt = z[t.zeile]!;
  const einzug = alt.slice(0, alt.length - alt.trimStart().length);
  z[t.zeile] = `${einzug}image: ${image}`;
  return { datei: z.join(nl), vorher: t.image };
}

interface PortainerStack { Id: number; Name: string; Type: number; EndpointId: number; Status?: number; Env?: Array<{ name: string; value: string }> }
interface Container { Id: string; Image: string; State: string; Labels?: Record<string, string>; ImageID?: string; Env?: string[] }

export interface PortainerDeps {
  /** fester Leseschritt als root auf dem Fernzugang (FINGERABDRUCK_SKRIPT) */
  hostLesen: (zugang: string, skript: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  hostAdresse: (zugang: string) => Promise<string | undefined>;
  tresor?: { namen(): Promise<Set<string>>; lies(name: string, wofuer: string): Promise<string> };
  /** HTTPS mit Pinning auf derselben Verbindung */
  pinnedFetch: (url: string, init: RequestInit, fingerabdruck: string) => Promise<Response>;
  /** Ordner für gesicherte Stack-Dateien (600) */
  sicherungsOrdner: string;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

export class PortainerSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'portainer',
    category: 'infrastructure',
    description:
      'Portainer-Stacks über die Portainer-API (zugang = Name des Linux-Fernzugangs, auf dem Portainer läuft, z. B. authProxy, dockerhost). '
      + 'Token aus dem Tresor (portainer-<zugang klein>), HTTPS mit Zertifikat-Pinning über den Fernzugang. '
      + 'list_stacks (lesend, auch außerhalb von Changes): je Stack ID, Name, Endpunkt, Status, Dienste mit Image, NAMEN der Portainer-Variablen (keine Werte), SHA-256 der Stack-Datei — '
      + 'Wortlaut je Stack „<zugang>: Stack <name> (ID <id>, Endpunkt <id>, aktiv|inaktiv): Dienste <dienst>=<image>, …; Portainer-Variablen <namen>|keine; Datei-SHA256 <hash>“. '
      + 'NUR als Schritte freigegebener Changes: image_setzen (zugang, stack = ID oder Name, dienst, image = repo:tag@sha256:…, datei_sha256 optional = erwarteter Ist-Stand) — '
      + 'ersetzt genau die image-Zeile des Dienstes, Portainer stellt mit denselben gespeicherten Variablen neu bereit (ohne Pull: Image vorher per Digest holen, ohne Prune), '
      + 'sichert die bisherige Datei; Erfolg nur, wenn die Datei zurückgelesen das neue Image hat und der Container des Dienstes mit genau diesem Image läuft — '
      + 'Wortlaut „PORTAINER_IMAGE_GESETZT <zugang> Stack <name> Dienst <dienst>: <alt> → <neu>; Container läuft“. '
      + 'Rückweg genau stack_zuruecksetzen (zugang, stack) — stellt die vor image_setzen gesicherte Datei wieder bereit, Wortlaut „PORTAINER_ZURUECK <zugang> Stack <name>: Datei <hash> wiederhergestellt; Container laufen“. '
      + 'Statt Compose-Datei in Portainers Datenbereich ändern und docker compose selbst aufrufen.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 900_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PORTAINER_LESEND, ...PORTAINER_NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Fernzugang des Portainer-Hosts' },
        stack: { type: 'string', description: 'image_setzen/stack_zuruecksetzen: Stack-ID oder Name' },
        dienst: { type: 'string', description: 'image_setzen: Dienst im Stack' },
        image: { type: 'string', description: 'image_setzen: neue Referenz, möglichst repo:tag@sha256:<digest>' },
        datei_sha256: { type: 'string', description: 'image_setzen optional: erwarteter SHA-256 der Stack-Datei vor der Änderung (aus list_stacks)' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: PortainerDeps) { super(); }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim();
    if (!PORTAINER_LESEND.has(action) && !PORTAINER_NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action} (${[...PORTAINER_LESEND, ...PORTAINER_NUR_IM_CHANGE].join(', ')})` };
    if (PORTAINER_NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Linux-Fernzugangs, auf dem Portainer läuft' };
    const geheim: string[] = [];
    const lauf = { gewirkt: false };
    try {
      const api = await this.verbindung(zugang, action, geheim);
      if (action === 'list_stacks') return await this.listStacks(zugang, api);
      if (action === 'image_setzen') return await this.imageSetzen(zugang, api, input, lauf);
      return await this.zuruecksetzen(zugang, api, input, lauf);
    } catch (err) {
      // nach dem Neubereitstellen zählt jeder Fehler als „teilweise gewirkt“ (der Motor nimmt dann den Rückweg dieses Schritts mit)
      return { success: false, error: ohneGeheimnisse(`Portainer ${zugang}: ${(err as Error).message}`, geheim), ...(lauf.gewirkt ? { data: { teilweise: true } } : {}) };
    }
  }

  private async verbindung(zugang: string, action: string, geheim: string[]) {
    const t = this.d.tresor; if (!t) throw new Error('Tresor nicht verfügbar');
    const name = tresorName(zugang);
    if (!(await t.namen()).has(name)) throw new Error(`Tresor-Eintrag ${name} fehlt — Owner legt das Portainer-API-Token über die Tresor-Seite an`);
    const host = await this.d.hostAdresse(zugang); if (!host) throw new Error(`Fernzugang ${zugang} unbekannt`);
    const r = await this.d.hostLesen(zugang, FINGERABDRUCK_SKRIPT);
    const { port, fingerabdruck } = leseFingerabdruck(`${r.stdout}\n${r.stderr}`);
    const token = await t.lies(name, `Portainer ${action} auf ${zugang}`); geheim.push(token);
    const basis = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
    const anfrage = async <T>(pfad: string, init: RequestInit = {}, ms = 60_000): Promise<T> => {
      const res = await this.d.pinnedFetch(`${basis}${pfad}`, { ...init, headers: { 'X-API-Key': token, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(ms) }, fingerabdruck);
      const text = await res.text();
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pfad.split('?')[0]}: HTTP ${res.status} ${ohneGeheimnisse(text, [token]).slice(0, 200)}`);
      return (text ? JSON.parse(text) : undefined) as T;
    };
    return { anfrage };
  }

  private async stackFinden(api: Api, ref: string): Promise<PortainerStack> {
    const alle = await api.anfrage<PortainerStack[]>('/api/stacks');
    const t = alle.filter(s => String(s.Id) === ref || s.Name === ref);
    if (t.length !== 1) throw new Error(`Stack „${ref}“ ${t.length ? 'mehrdeutig' : 'nicht gefunden'} (vorhanden: ${alle.map(s => `${s.Id} ${s.Name}`).join(', ')})`);
    if (t[0]!.Type !== 2) throw new Error(`Stack ${t[0]!.Name} ist kein Compose-Stack (Typ ${t[0]!.Type})`);
    return t[0]!;
  }

  private async datei(api: Api, s: PortainerStack): Promise<string> {
    const f = await api.anfrage<{ StackFileContent: string }>(`/api/stacks/${s.Id}/file`);
    if (typeof f?.StackFileContent !== 'string') throw new Error(`Stack-Datei von ${s.Name} nicht lesbar`);
    return f.StackFileContent;
  }

  /** Container des Stacks (bzw. Dienstes) mit Config.Image aus der Inspektion — die Liste zeigt bei verschobenen Tags sonst die Image-ID */
  private async container(api: Api, s: PortainerStack, dienst?: string): Promise<Container[]> {
    const label = [`com.docker.compose.project=${s.Name}`, ...(dienst ? [`com.docker.compose.service=${dienst}`] : [])];
    const liste = await api.anfrage<Container[]>(`/api/endpoints/${s.EndpointId}/docker/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label }))}`);
    const aus: Container[] = [];
    for (const c of liste) {
      const x = await api.anfrage<{ Config?: { Image?: string; Env?: string[] }; State?: { Status?: string }; Image?: string }>(`/api/endpoints/${s.EndpointId}/docker/containers/${encodeURIComponent(c.Id)}/json`);
      aus.push({ ...c, Image: x.Config?.Image ?? c.Image, State: x.State?.Status ?? c.State, ...(x.Image ? { ImageID: x.Image } : {}), Env: x.Config?.Env ?? [] });
    }
    return aus;
  }

  /** v1973 — je Dienst die Env-Namen, die eine Neubereitstellung verlöre (Container gegen Image + Stack-Datei; nur Namen) */
  private async abweichungen(api: Api, s: PortainerStack, datei: string, nurDienst?: string): Promise<Map<string, { namen: string[]; envFile: boolean }>> {
    const aus = new Map<string, { namen: string[]; envFile: boolean }>();
    const imageEnv = new Map<string, string[]>();
    for (const c of await this.container(api, s, nurDienst)) {
      const dienst = c.Labels?.['com.docker.compose.service']; if (!dienst || !c.ImageID) continue;
      if (!imageEnv.has(c.ImageID)) imageEnv.set(c.ImageID, (await api.anfrage<{ Config?: { Env?: string[] } }>(`/api/endpoints/${s.EndpointId}/docker/images/${encodeURIComponent(c.ImageID)}/json`)).Config?.Env ?? []);
      const u = dienstUmgebung(datei, dienst);
      const namen = envAbweichung(c.Env ?? [], imageEnv.get(c.ImageID)!, u.schluessel);
      const alt = aus.get(dienst);
      aus.set(dienst, { namen: [...new Set([...(alt?.namen ?? []), ...namen])].sort(), envFile: u.envFile });
    }
    return aus;
  }

  private async listStacks(zugang: string, api: Api): Promise<SkillResult> {
    const alle = await api.anfrage<PortainerStack[]>('/api/stacks');
    const zeilen: string[] = []; const daten: unknown[] = [];
    for (const s of alle) {
      let dienste = 'Datei nicht lesbar'; let hash = '?'; let liste: unknown[] = []; let laufzeit = 'Laufzeit nicht geprüft'; let abw: Record<string, string[]> = {};
      if (s.Type === 2) {
        try {
          const f = await this.datei(api, s); hash = sha(f); const di = dienstImages(f); liste = di.map(x => ({ dienst: x.dienst, image: x.image })); dienste = di.map(x => `${x.dienst}=${x.image ?? 'ohne image'}`).join(', ') || 'keine';
          try {
            const ab = [...(await this.abweichungen(api, s, f)).entries()].filter(([, v]) => v.namen.length);
            laufzeit = ab.length ? `Laufzeit weicht ab: ${ab.map(([d, v]) => `${d} ${v.namen.join(', ')}${v.envFile ? ' (env_file nicht prüfbar)' : ''}`).join('; ')}` : 'Laufzeit = Datei';
            abw = Object.fromEntries(ab.map(([d, v]) => [d, v.namen]));
          } catch { laufzeit = 'Laufzeit nicht lesbar'; }
        } catch { /* bleibt „nicht lesbar“ */ }
      } else dienste = `kein Compose-Stack (Typ ${s.Type})`;
      const env = (s.Env ?? []).map(e => e.name).filter(Boolean);
      zeilen.push(`${zugang}: Stack ${s.Name} (ID ${s.Id}, Endpunkt ${s.EndpointId}, ${s.Status === 2 ? 'inaktiv' : 'aktiv'}): Dienste ${dienste}; Portainer-Variablen ${env.length ? env.join(', ') : 'keine'}; Datei-SHA256 ${hash}; ${laufzeit}`);
      daten.push({ id: s.Id, name: s.Name, endpunkt: s.EndpointId, aktiv: s.Status !== 2, dienste: liste, variablen: env, dateiSha256: hash, laufzeitAbweichung: abw });
    }
    return { success: true, data: daten, display: zeilen.join('\n') || `${zugang}: keine Stacks` };
  }

  private sicherungsPfad(zugang: string, s: PortainerStack) { return join(this.d.sicherungsOrdner, `${zugang.toLowerCase()}-stack-${s.Id}.yml`); }

  private async bereitstellen(api: Api, s: PortainerStack, datei: string): Promise<void> {
    // dieselben gespeicherten Variablen zurückgeben — sonst verwirft Portainer sie
    await api.anfrage(`/api/stacks/${s.Id}?endpointId=${s.EndpointId}`, { method: 'PUT', body: JSON.stringify({ StackFileContent: datei, Env: s.Env ?? [], Prune: false, PullImage: false }) }, 600_000);
  }

  private async imageSetzen(zugang: string, api: Api, input: Record<string, unknown>, lauf: { gewirkt: boolean }): Promise<SkillResult> {
    const dienst = String(input.dienst ?? '').trim(); const image = String(input.image ?? '').trim();
    if (!DIENST.test(dienst)) return { success: false, error: 'dienst: Name des Dienstes im Stack' };
    if (!IMAGE.test(image)) return { success: false, error: 'image: Referenz wie repo:tag@sha256:<64 hex>' };
    const s = await this.stackFinden(api, String(input.stack ?? '').trim());
    const alt = await this.datei(api, s);
    const erwartet = String(input.datei_sha256 ?? '').trim().toLowerCase();
    if (erwartet && erwartet !== sha(alt)) return { success: false, error: `Stack ${s.Name}: Datei weicht vom erwarteten Stand ab (ist ${sha(alt)}) — nichts geändert` };
    const { datei: neu, vorher } = imageErsetzen(alt, dienst, image);
    // v1973 — eine Neubereitstellung verlöre Env-Namen, die nur im laufenden Container stehen → nichts ändern (fail-closed)
    const ab = (await this.abweichungen(api, s, alt, dienst)).get(dienst);
    if (!ab) return { success: false, error: `Stack ${s.Name} Dienst ${dienst}: kein Container gefunden — Laufzeit nicht prüfbar, nichts geändert` };
    if (ab.namen.length) return { success: false, error: `Stack ${s.Name} Dienst ${dienst}: Laufzeit weicht von Image + Stack-Datei ab (Env ${ab.namen.join(', ')}${ab.envFile ? '; env_file nicht prüfbar' : ''}) — Neubereitstellung verlöre sie, nichts geändert. Erst in die Stack-Datei übernehmen.` };
    if (vorher === image) return { success: true, display: `PORTAINER_IMAGE_GESETZT ${zugang} Stack ${s.Name} Dienst ${dienst}: ${vorher} → ${image}; Container läuft (war schon gesetzt, nichts geändert)` };
    await mkdir(this.d.sicherungsOrdner, { recursive: true, mode: 0o700 });
    const pfad = this.sicherungsPfad(zugang, s);
    await writeFile(pfad, alt, { mode: 0o600 }); await chmod(pfad, 0o600);
    this.d.protokoll?.('Portainer Stack-Datei gesichert', { zugang, stack: s.Name, id: s.Id, sha256: sha(alt) });
    lauf.gewirkt = true;
    await this.bereitstellen(api, s, neu);
    const zurueck = await this.datei(api, s);
    const gelesen = dienstImages(zurueck).find(x => x.dienst === dienst)?.image;
    if (gelesen !== image) return { success: false, error: `Stack ${s.Name}: Datei zurückgelesen hat image ${gelesen ?? '—'} statt ${image}`, data: { teilweise: true } };
    const c = await this.container(api, s, dienst);
    const laufend = c.filter(x => x.State === 'running');
    if (!laufend.length || laufend.some(x => x.Image !== image)) return { success: false, error: `Stack ${s.Name} Dienst ${dienst}: Container ${c.map(x => `${x.State} ${x.Image}`).join(', ') || 'fehlt'} — erwartet running ${image}`, data: { teilweise: true } };
    this.d.protokoll?.('Portainer Image gesetzt', { zugang, stack: s.Name, dienst, vorher, image });
    return { success: true, data: { stack: s.Id, dienst, vorher, image, dateiSha256: sha(zurueck), sicherungSha256: sha(alt) }, display: `PORTAINER_IMAGE_GESETZT ${zugang} Stack ${s.Name} Dienst ${dienst}: ${vorher} → ${image}; Container läuft` };
  }

  private async zuruecksetzen(zugang: string, api: Api, input: Record<string, unknown>, lauf: { gewirkt: boolean }): Promise<SkillResult> {
    const s = await this.stackFinden(api, String(input.stack ?? '').trim());
    let alt: string;
    try { alt = await readFile(this.sicherungsPfad(zugang, s), 'utf8'); } catch { return { success: false, error: `Keine Sicherung für Stack ${s.Name} (ID ${s.Id}) — nichts geändert` }; }
    lauf.gewirkt = true;
    await this.bereitstellen(api, s, alt);
    const zurueck = await this.datei(api, s);
    if (sha(zurueck) !== sha(alt)) return { success: false, error: `Stack ${s.Name}: Datei nach dem Zurücksetzen weicht von der Sicherung ab` };
    const erwartet = dienstImages(alt);
    const c = await this.container(api, s);
    for (const e of erwartet) {
      const lauf = c.filter(x => x.Labels?.['com.docker.compose.service'] === e.dienst && x.State === 'running');
      if (!lauf.length || (e.image && lauf.some(x => x.Image !== e.image))) return { success: false, error: `Stack ${s.Name} Dienst ${e.dienst}: läuft nicht mit ${e.image ?? 'dem gesicherten Image'}` };
    }
    this.d.protokoll?.('Portainer Stack zurückgesetzt', { zugang, stack: s.Name, sha256: sha(alt) });
    return { success: true, display: `PORTAINER_ZURUECK ${zugang} Stack ${s.Name}: Datei ${sha(alt)} wiederhergestellt; Container laufen` };
  }
}

type Api = { anfrage: <T>(pfad: string, init?: RequestInit, ms?: number) => Promise<T> };
