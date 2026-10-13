import { randomBytes } from 'node:crypto';

/**
 * v1437 B14 (Spec R4-Erweiterung, Owner 13.10. „ok freigegeben“) — Deploy eines Geräte-Projekts auf einen anderen Rechner: das Gerät
 * pusht (B13), der vorhandene Deploy-Skill holt den Stand aufs Ziel. Neu: Ziel je Projekt, jeder Deploy und Rollback mit Bestätigung,
 * Nachkontrolle (Status, HTTP, Log-Muster) statt „Erfolg auch bei Fehlschlag“, Rollback auf den Commit VOR dem Deploy, optional
 * „in dev automatisch nach grüner Abnahme“ (Schalter je Projekt, Standard aus). Ohne Deploy-Ziel bleibt alles wie bisher.
 */

export type Stufe = 'dev' | 'test' | 'prod';
export type Prozess = 'pm2' | 'systemd' | 'docker-compose';
export interface DeployZiel {
  host: string; user?: string; prozess: Prozess; runtime?: 'node' | 'python' | 'static';
  appPort?: number; branch?: string; envStage?: string; stufe: Stufe; autoDev?: boolean; name?: string;
}

const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const NAME = /^[A-Za-z0-9._-]{1,60}$/;

/** Eingabe (Gespräch, App) prüfen; `alt` = bisheriges Ziel (Teiländerungen). */
export function zielPruefen(roh: Record<string, unknown>, alt?: DeployZiel): { ok: true; ziel: DeployZiel } | { ok: false; fehler: string } {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const host = s(roh.host) ?? alt?.host;
  if (!host || !HOST.test(host)) return { ok: false, fehler: 'host fehlt oder ungültig (z. B. 192.168.1.96 oder server.lan)' };
  const user = s(roh.user) ?? alt?.user;
  if (user && !NAME.test(user)) return { ok: false, fehler: 'user ungültig' };
  const prozess = (s(roh.process_manager ?? roh.prozess) ?? alt?.prozess ?? 'pm2') as Prozess;
  if (!['pm2', 'systemd', 'docker-compose'].includes(prozess)) return { ok: false, fehler: 'process_manager muss pm2, systemd oder docker-compose sein' };
  const runtime = (s(roh.runtime) ?? alt?.runtime) as DeployZiel['runtime'];
  if (runtime && !['node', 'python', 'static'].includes(runtime)) return { ok: false, fehler: 'runtime muss node, python oder static sein' };
  const portRoh = roh.app_port ?? roh.port;
  const appPort = portRoh !== undefined && portRoh !== '' ? Number(portRoh) : alt?.appPort;
  if (appPort !== undefined && (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535)) return { ok: false, fehler: 'app_port muss 1–65535 sein' };
  const branch = s(roh.branch) ?? alt?.branch;
  if (branch && !/^[A-Za-z0-9._\/-]{1,100}$/.test(branch)) return { ok: false, fehler: 'branch ungültig' };
  const envStage = s(roh.env_stage) ?? alt?.envStage;
  const stufe = (s(roh.stufe) ?? alt?.stufe ?? 'dev') as Stufe;
  if (!['dev', 'test', 'prod'].includes(stufe)) return { ok: false, fehler: 'stufe muss dev, test oder prod sein' };
  const autoDev = typeof roh.auto_dev === 'boolean' ? roh.auto_dev : alt?.autoDev;
  if (autoDev && stufe !== 'dev') return { ok: false, fehler: 'automatisch deployen gibt es nur für die Stufe dev (test/prod immer mit Bestätigung)' };
  const name = s(roh.name) ?? alt?.name;
  if (name && !NAME.test(name)) return { ok: false, fehler: 'name (Ordner am Ziel) nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich' };
  return { ok: true, ziel: { host, ...(user ? { user } : {}), prozess, ...(runtime ? { runtime } : {}), ...(appPort ? { appPort } : {}), ...(branch ? { branch } : {}), ...(envStage ? { envStage } : {}), stufe, ...(autoDev ? { autoDev: true } : {}), ...(name ? { name } : {}) } };
}

export function zielText(z: DeployZiel): string {
  return `${z.stufe} · ${z.user ?? 'root'}@${z.host} · ${z.prozess}${z.runtime ? `/${z.runtime}` : ''}${z.appPort ? ` · Port ${z.appPort}` : ''}${z.branch ? ` · Zweig ${z.branch}` : ''}${z.envStage ? ` · ENV ${z.envStage}` : ''}${z.autoDev ? ' · automatisch nach grüner Abnahme' : ''}`;
}

/** Ordnername am Ziel (Deploy-Skill: /home/<user>/<name>). */
export function zielName(z: DeployZiel, pfad: string): string {
  if (z.name) return z.name;
  const b = pfad.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? 'projekt';
  return b.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'projekt';
}

// „Error“ auch am Wortende (TypeError, ReferenceError …); „errors“ (Zählwort) nicht
const FEHLERMUSTER = /(error|exception)\b|\b(fatal|unhandled|traceback|panic|segmentation fault|eaddrinuse|econnrefused|cannot find module|exited with code [1-9])\b/i;
const HARMLOS = /\b(0 errors?|no errors?|errors?: 0|without errors?)\b/i;

/**
 * Nachkontrolle nach dem Deploy (deterministisch): läuft der Dienst, antwortet er per HTTP (falls Port bekannt), und stehen in den
 * Logs seit dem Deploy keine Fehlermuster? pm2-Logs haben keinen Zeitfilter → dort nur Hinweis, nicht rot.
 */
export function nachkontrolle(o: { prozess: Prozess; deployOk: boolean; deployFehler?: string; status?: string; appPort?: number; httpOk?: boolean; logs?: string }):
  { ok: boolean; gruende: string[]; hinweise: string[]; fehlerzeilen: string[] } {
  const gruende: string[] = []; const hinweise: string[] = [];
  if (!o.deployOk) gruende.push(`Deploy fehlgeschlagen: ${(o.deployFehler ?? 'unbekannt').slice(0, 300)}`);
  const st = o.status ?? '';
  const laeuft = o.prozess === 'pm2' ? /status\s*[│|]\s*online|\bonline\b/i.test(st) && !/\b(errored|stopped)\b/i.test(st)
    : o.prozess === 'systemd' ? /Active:\s*active \(running\)/.test(st)
    : /\b(Up|running)\b/.test(st) && !/\b(Exited|Restarting|unhealthy)\b/i.test(st);
  if (o.deployOk) {
    if (!st) gruende.push('Status nicht lesbar');
    else if (!laeuft) gruende.push(`Dienst läuft nicht (${o.prozess})`);
    if (o.appPort && o.httpOk === false) gruende.push(`keine HTTP-Antwort auf Port ${o.appPort} (≈90 s gewartet)`);
    if (!o.appPort) hinweise.push('kein Port hinterlegt — HTTP nicht geprüft');
  }
  const fehlerzeilen = (o.logs ?? '').split('\n').map(z => z.trim()).filter(z => z && FEHLERMUSTER.test(z) && !HARMLOS.test(z)).slice(-5);
  if (fehlerzeilen.length) {
    if (o.prozess === 'pm2') hinweise.push(`${fehlerzeilen.length} Fehlerzeile(n) in den pm2-Logs (ohne Zeitfilter, evtl. älter)`);
    else if (o.deployOk) gruende.push(`${fehlerzeilen.length} Fehlerzeile(n) in den Logs seit dem Deploy`);
  }
  return { ok: gruende.length === 0, gruende, hinweise, fehlerzeilen };
}

/** Einmal-Kennungen für bestätigte Deploys/Rollbacks (die Bestätigung des Owners trägt sie; das Modell kann sie nicht erraten). */
export type FreigabeArt = 'deploy' | 'rollback' | 'ziel';

export class DeployFreigaben {
  private readonly offen = new Map<string, { akteId: string; art: FreigabeArt; commit?: string; ziel?: DeployZiel; stufe?: Stufe; bis: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  /** v1438 — Kennung aus dem CSPRNG (128 Bit); `ziel` = vorgeschlagenes Deploy-Ziel (wird erst nach der Bestätigung gespeichert). */
  stelle(akteId: string, art: FreigabeArt, commit?: string, gueltigMs = 72 * 3_600_000, ziel?: DeployZiel, stufe?: Stufe): string {
    const n = `${art}-${randomBytes(16).toString('hex')}`;
    this.offen.set(n, { akteId, art, ...(commit ? { commit } : {}), ...(ziel ? { ziel } : {}), ...(stufe ? { stufe } : {}), bis: this.now() + gueltigMs });
    return n;
  }
  /** Löst die Kennung genau einmal ein (falsches Projekt, falsche Art oder abgelaufen → undefined). */
  loese(nonce: string, akteId: string, art: FreigabeArt): { commit?: string; ziel?: DeployZiel; stufe?: Stufe } | undefined {
    const e = this.offen.get(nonce);
    if (!e) return undefined;
    this.offen.delete(nonce);
    if (e.akteId !== akteId || e.art !== art || e.bis < this.now()) return undefined;
    return { ...(e.commit ? { commit: e.commit } : {}), ...(e.ziel ? { ziel: e.ziel } : {}), ...(e.stufe ? { stufe: e.stufe } : {}) };
  }
}

/** v1438 — nur ein vom Owner bestätigtes Ziel darf automatisch (auto_dev) beliefert werden; der Merker wird nur beim Speichern nach der Bestätigung gesetzt. */
export const zielBestaetigt = (roh: Record<string, unknown> | undefined): boolean => roh?.bestaetigt === true;

/**
 * v1439 (Owner 13.10.) — vorhandenes Forge-Token als Rückfall, aber NUR für Repos auf dessen eigenem Host (GitLab baseUrl bzw.
 * github.com). git@-Adressen bekommen nie ein Token (Schlüssel des Rechners).
 */
export function forgeTokenFuer(repoUrl: string, forge?: { gitlab?: { token?: string; baseUrl?: string }; github?: { token?: string } }): { token: string; quelle: 'gitlab' | 'github' } | undefined {
  // v1442 (Owner 13.10.: „git.lokalkraft.at ist https“) — Konto-Token nur über https, nur für den Host der Forge; http-Adressen vorher
  // mit aufHttps() aufwerten. Über http geht nie ein Konto-Token.
  const teile = (u: string) => { try { if (!/^https?:\/\//i.test(u)) return undefined; const x = new URL(u); return { host: x.host.toLowerCase(), schema: x.protocol }; } catch { return undefined; } };
  const r = teile(repoUrl);
  if (!r || r.schema !== 'https:') return undefined;
  const g = forge?.gitlab?.baseUrl ? teile(forge.gitlab.baseUrl) : undefined;
  if (forge?.gitlab?.token && g && g.host === r.host) return { token: forge.gitlab.token, quelle: 'gitlab' };
  if (forge?.github?.token && r.host === 'github.com') return { token: forge.github.token, quelle: 'github' };
  return undefined;
}

/** v1441 — Klartext für Bestätigungen: welches Token an den Zielrechner geht. */
export function tokenHinweis(quelle: 'projekt' | 'gitlab' | 'github' | undefined, repoUrl?: string): string {
  if (!quelle) return 'Kein Token (öffentliches Repo oder Schlüssel des Zielrechners).';
  const klar = repoUrl && /^http:\/\//i.test(repoUrl) ? ' Achtung: http — unverschlüsselt im Netz.' : '';
  return quelle === 'projekt' ? `Token: Projekt-Token (Projektumgebung).${klar}` : `Token: dein ${quelle === 'gitlab' ? 'GitLab' : 'GitHub'}-Konto-Token (Zugriff auf alle deine Repos) geht für den Abruf an den Zielrechner (nur als Kopfzeile, nicht gespeichert).${klar}`;
}

/** v1442 — http-Adressen auf dem Forge-Host (bzw. github.com) auf https aufwerten; andere Adressen bleiben unverändert. */
export function aufHttps(url: string, forge?: { gitlab?: { baseUrl?: string } }): string {
  try {
    if (!/^http:\/\//i.test(url)) return url;
    const h = new URL(url).host.toLowerCase();
    const g = forge?.gitlab?.baseUrl ? new URL(forge.gitlab.baseUrl).host.toLowerCase() : undefined;
    return h === g || h === 'github.com' ? url.replace(/^http:/i, 'https:') : url;
  } catch { return url; }
}

/**
 * v1443 B15 (Owner 13.10.: „Stages-/ENV-Verwaltung wie im Projektagent“) — je Stage dev/test/prod ein eigenes Ziel. Gespeichert in
 * projects.deploy_ziel als { stufen: { dev: { …Ziel, bestaetigt, letzter } } }; das Einzel-Ziel von v1437/v1438 wird als seine Stufe gelesen.
 */
export const STUFEN: readonly Stufe[] = ['dev', 'test', 'prod'];
export interface LetzterDeploy { zeit: string; ok: boolean; deployOk?: boolean; text: string; vorher?: string; nachher?: string; commit?: string }
export interface StufenEintrag { ziel: DeployZiel; bestaetigt: boolean; letzter?: LetzterDeploy }

export function stufenAus(roh: Record<string, unknown> | undefined): Partial<Record<Stufe, StufenEintrag>> {
  const aus: Partial<Record<Stufe, StufenEintrag>> = {};
  if (!roh) return aus;
  const lies = (e: Record<string, unknown>, s?: Stufe) => {
    const z = zielPruefen({ ...e, ...(s ? { stufe: s } : {}), ...(e.prozess ? { process_manager: e.prozess } : {}), ...(e.appPort ? { app_port: e.appPort } : {}), ...(e.envStage ? { env_stage: e.envStage } : {}), ...(typeof e.autoDev === 'boolean' ? { auto_dev: e.autoDev } : {}) });
    if (!z.ok) return;
    aus[z.ziel.stufe] = { ziel: z.ziel, bestaetigt: e.bestaetigt === true, ...(e.letzter && typeof e.letzter === 'object' ? { letzter: e.letzter as LetzterDeploy } : {}) };
  };
  if (roh.stufen && typeof roh.stufen === 'object') { for (const s of STUFEN) { const e = (roh.stufen as Record<string, unknown>)[s]; if (e && typeof e === 'object') lies(e as Record<string, unknown>, s); } }
  else if (typeof roh.host === 'string') lies(roh); // v1437/v1438: ein Ziel
  return aus;
}

export function stufenSpeicher(st: Partial<Record<Stufe, StufenEintrag>>): Record<string, unknown> {
  const stufen: Record<string, unknown> = {};
  for (const s of STUFEN) { const e = st[s]; if (e) stufen[s] = { ...e.ziel, stufe: s, bestaetigt: e.bestaetigt, ...(e.letzter ? { letzter: e.letzter } : {}) }; }
  return { stufen };
}

export const naechsteStufe = (s: Stufe): Stufe | undefined => (s === 'dev' ? 'test' : s === 'test' ? 'prod' : undefined);
