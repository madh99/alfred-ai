import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1434 B13 (Spec R4-Erweiterung, Owner 13.10. „ok freigegeben“) — Git-Teil für Geräte-Projekte: ein Projekt, das auf GitLab liegt,
 * aufs Gerät holen (Remote bleibt) und nach jeder abgenommenen Etappe pushen. Das Token kommt je Aufruf vom Gehirn (Projektumgebung)
 * und wird nur als Kopfzeile über die Umgebung an git gegeben: nicht in der Befehlszeile, nicht in .git/config, nicht im Remote.
 */

/** Erlaubte Repo-Adressen: https://host/pfad oder git@host:pfad — ohne Zugangsdaten in der Adresse, ohne lokale/Transport-Tricks. */
export function pruefeRepoUrl(url: string): { ok: true; url: string } | { ok: false; fehler: string } {
  const u = url.trim();
  if (!u || u.startsWith('-')) return { ok: false, fehler: 'Repo-Adresse fehlt' };
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._\/-]+$/.test(u)) return { ok: true, url: u };
  let p: URL;
  try { p = new URL(u); } catch { return { ok: false, fehler: `keine gültige Repo-Adresse: ${u}` }; }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return { ok: false, fehler: 'nur https://… oder git@host:… erlaubt' };
  if (p.username || p.password) return { ok: false, fehler: 'Zugangsdaten gehören nicht in die Adresse — das Token kommt aus der Projektumgebung' };
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(p.pathname) || p.search || p.hash) return { ok: false, fehler: `ungewöhnlicher Repo-Pfad: ${p.pathname}` };
  // v1440 — immer mit .git: ohne leitet GitLab weiter (301), und Weiterleitungen sind für Aufrufe mit Token bewusst aus
  return { ok: true, url: `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '')}${/\.git$/i.test(p.pathname.replace(/\/+$/, '')) ? '' : '.git'}` };
}

/** Leeres Gerät für git (Windows: os.devNull = \.
ul lehnt git ab, NUL geht). */
export const LEER = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Adresse ohne Zugangsdaten (für Anzeige und Speicher). */
export function ohneZugang(url: string): string { return url.replace(/^(https?:\/\/)[^@/]+@/, '$1'); }

/** Adresse vergleichbar machen (ohne Zugangsdaten, ohne .git und Schrägstrich am Ende, Kleinschreibung). */
// v1442 — http/https desselben Repos gelten als gleich (gepusht wird ohnehin an die erwartete Adresse, mit Token nur über https)
export function repoSchluessel(url: string): string { return ohneZugang(url.trim()).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.git$/, ''); }

/**
 * Umgebung für einen git-Aufruf (Sicherheitsprüfungen 13.10.): nie Rückfragen, keine Weiterleitungen, keine Hooks (Pfad LEER —
 * dort kann niemand Hooks ablegen), keine Credential-Helper, keine globale und keine System-Konfiguration (~/.gitconfig ist für Claude
 * Code schreibbar: Proxy, insteadOf, CA …). Das Token gilt als Kopfzeile NUR für den Host des erwarteten Repos, nie für git@-Adressen.
 * Mit Token nur in einem frischen Repo ohne fremde Konfiguration verwenden (Klon in neuen Ordner, Push aus temporärem Repo).
 */
export function gitUmgebung(token?: string, fuer?: string): Record<string, string> {
  const cfg: Array<[string, string]> = [['http.followRedirects', 'false'], ['core.hooksPath', LEER], ['credential.helper', '']];
  let basis: string | undefined;
  try { if (fuer && /^https?:\/\//i.test(fuer)) { const u = new URL(fuer); basis = `${u.protocol}//${u.host}/`; } } catch { /* keine */ }
  if (token && basis) cfg.push([`http.${basis}.extraHeader`, `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`]);
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_CONFIG_GLOBAL: LEER, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(cfg.length) };
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

/** Ausgabe ohne Token (roh und als Basic-Kopf) und ohne Zugangsdaten in Adressen. */
export function schwaerzeGit(text: string, token?: string): string {
  let t = text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
  if (token) { t = t.split(token).join('***'); t = t.split(Buffer.from(`oauth2:${token}`).toString('base64')).join('***'); }
  return t;
}

export interface GitLauf { status: number | null; ausgabe: string }
export type GitAusfuehren = (args: string[], cwd: string | undefined, env: Record<string, string>, timeoutMs: number) => Promise<GitLauf>;

/** Asynchron (blockiert den Satelliten nicht: Herzschlag und andere Aktionen laufen weiter). */
export const gitAusfuehren: GitAusfuehren = (args, cwd, env, timeoutMs) => new Promise((resolve) => {
  let ausgabe = '';
  const k = spawn('git', args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const t = setTimeout(() => { try { k.kill(); } catch { /* weg */ } ausgabe += '\n(Zeitlimit)'; }, timeoutMs);
  k.stdout.on('data', (d: Buffer) => { ausgabe += d.toString(); });
  k.stderr.on('data', (d: Buffer) => { ausgabe += d.toString(); });
  k.on('error', (err) => { clearTimeout(t); resolve({ status: null, ausgabe: `${ausgabe}\n${err.message}` }); });
  k.on('close', (code) => { clearTimeout(t); resolve({ status: code, ausgabe }); });
});

const kurz = (t: string) => t.trim().split('\n').slice(-6).join('\n').slice(0, 800);

/** Repo in einen neuen (oder leeren) Ordner holen. */
export async function gitHolen(url: string, ziel: string, token: string | undefined, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; branch: string; sha: string; text: string } | { ok: false; fehler: string }> {
  const p = pruefeRepoUrl(url);
  if (!p.ok) return { ok: false, fehler: p.fehler };
  if (existsSync(ziel) && readdirSync(ziel).length > 0) return { ok: false, fehler: `Zielordner ist nicht leer: ${ziel}` };
  const c = await git(['clone', '--', p.url, ziel], undefined, gitUmgebung(token, p.url), 10 * 60_000);
  if (c.status !== 0) return { ok: false, fehler: `git clone: ${schwaerzeGit(kurz(c.ausgabe), token)}` };
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ziel, gitUmgebung(), 15_000);
  const h = await git(['rev-parse', '--short', 'HEAD'], ziel, gitUmgebung(), 15_000);
  return { ok: true, branch: b.ausgabe.trim() || '?', sha: h.status === 0 ? h.ausgabe.trim() : '', text: `${ohneZugang(p.url)} → ${ziel}` };
}

/**
 * Aktuellen Zweig zum Repo des Projekts pushen.
 * - Nur wenn jede Push-Adresse von origin (nach pushurl/insteadOf) die erwartete Repo-Adresse ist — sonst nichts senden (Claude Code
 *   könnte origin umgebogen haben).
 * - v1436 — Der Push mit Token läuft NICHT im Projekt-Repo (dessen .git/config ist für Claude Code schreibbar: Proxy, Adressauflösung,
 *   CA …), sondern aus einem frischen temporären Repo: erst den Zweig ohne Token lokal dorthin holen, dann an die erwartete Adresse pushen.
 */
export async function gitPush(dir: string, token: string | undefined, erwartet: string | undefined, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; branch: string; sha: string; remote: string; text: string } | { ok: false; fehler: string }> {
  const ziel = erwartet ? pruefeRepoUrl(erwartet) : undefined;
  if (!ziel?.ok) return { ok: false, fehler: ziel ? `erwartete Repo-Adresse ungültig: ${ziel.fehler}` : 'erwartete Repo-Adresse fehlt — ohne sie pusht Alfred nicht' };
  const r = await git(['remote', 'get-url', '--push', '--all', 'origin'], dir, gitUmgebung(), 15_000);
  const adressen = r.ausgabe.split('\n').map(x => x.trim()).filter(Boolean);
  if (r.status !== 0 || !adressen.length) return { ok: false, fehler: 'kein Remote origin im Projekt' };
  if (adressen.some(a => repoSchluessel(a) !== repoSchluessel(ziel.url))) return { ok: false, fehler: `Push-Adresse von origin (${adressen.map(ohneZugang).join(', ')}) ist nicht das Repo des Projekts (${ohneZugang(ziel.url)}) — nicht gepusht` };
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, gitUmgebung(), 15_000);
  const branch = b.ausgabe.trim();
  if (b.status !== 0 || !branch || branch === 'HEAD' || !/^[A-Za-z0-9._\/-]+$/.test(branch)) return { ok: false, fehler: 'kein gültiger Zweig ausgecheckt (detached HEAD?)' };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'alfred-push-'));
  try {
    const i = await git(['init', '-q', '--bare', tmp], undefined, gitUmgebung(), 30_000);
    if (i.status !== 0) return { ok: false, fehler: `temporäres Repo: ${kurz(i.ausgabe)}` };
    const f = await git(['--git-dir', tmp, 'fetch', '-q', '--no-tags', '--', dir, `+HEAD:refs/heads/${branch}`], undefined, gitUmgebung(), 5 * 60_000);
    if (f.status !== 0) return { ok: false, fehler: `Zweig nicht übernommen: ${kurz(f.ausgabe)}` };
    const p = await git(['--git-dir', tmp, 'push', '--no-verify', '--', ziel.url, `refs/heads/${branch}:refs/heads/${branch}`], undefined, gitUmgebung(/^https?:\/\//i.test(ziel.url) ? token : undefined, ziel.url), 5 * 60_000);
    if (p.status !== 0) return { ok: false, fehler: `git push: ${schwaerzeGit(kurz(p.ausgabe), token)}` };
    const h = await git(['rev-parse', '--short', 'HEAD'], dir, gitUmgebung(), 15_000);
    return { ok: true, branch, sha: h.ausgabe.trim(), remote: ohneZugang(ziel.url), text: schwaerzeGit(kurz(p.ausgabe), token) };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* bleibt im Temp */ }
  }
}

const ZWEIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/;

/**
 * v1455 — Merge-Request-Modus: vor der ersten Etappe den Zweig des Laufs (`alfred/<lauf>`) anlegen bzw. auschecken. Nicht eingecheckte
 * Änderungen bleiben in der Arbeitskopie (git nimmt sie mit). Ohne Token, ohne Netz.
 */
export async function gitZweig(dir: string, zweig: string, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; zweig: string; vorher: string; neu: boolean } | { ok: false; fehler: string }> {
  if (!/^alfred\/[A-Za-z0-9._-]{1,80}$/.test(zweig)) return { ok: false, fehler: `ungültiger Zweigname: ${zweig}` };
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, gitUmgebung(), 15_000);
  const vorher = b.ausgabe.trim();
  if (b.status !== 0 || !vorher || vorher === 'HEAD') return { ok: false, fehler: 'kein Zweig ausgecheckt (kein Git-Repository, noch kein Commit oder detached HEAD)' };
  if (vorher === zweig) return { ok: true, zweig, vorher, neu: false };
  const da = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${zweig}`], dir, gitUmgebung(), 15_000)).status === 0;
  const c = await git(da ? ['checkout', '-q', zweig] : ['checkout', '-q', '-b', zweig], dir, gitUmgebung(), 60_000);
  if (c.status !== 0) return { ok: false, fehler: `git checkout ${zweig}: ${kurz(c.ausgabe)}` };
  return { ok: true, zweig, vorher, neu: !da };
}

/**
 * v1455 — nach dem Zusammenführen in GitLab den Zielzweig ans Gerät holen und auschecken (nur Vorspulen). Wie beim Push nie mit Token
 * im Projekt-Repo: erst mit Token in ein frisches temporäres Repo, von dort ohne Token ins Projekt (refs/remotes/origin/<zweig>).
 */
export async function gitAktualisieren(dir: string, token: string | undefined, erwartet: string | undefined, zweig: string, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; zweig: string; sha: string } | { ok: false; fehler: string }> {
  const ziel = erwartet ? pruefeRepoUrl(erwartet) : undefined;
  if (!ziel?.ok) return { ok: false, fehler: ziel ? `erwartete Repo-Adresse ungültig: ${ziel.fehler}` : 'erwartete Repo-Adresse fehlt' };
  if (!ZWEIG_NAME.test(zweig) || zweig.includes('..')) return { ok: false, fehler: `ungültiger Zweigname: ${zweig}` };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'alfred-holen-'));
  try {
    const i = await git(['init', '-q', '--bare', tmp], undefined, gitUmgebung(), 30_000);
    if (i.status !== 0) return { ok: false, fehler: `temporäres Repo: ${kurz(i.ausgabe)}` };
    const f = await git(['--git-dir', tmp, 'fetch', '-q', '--no-tags', '--', ziel.url, `+refs/heads/${zweig}:refs/heads/${zweig}`], undefined, gitUmgebung(/^https?:\/\//i.test(ziel.url) ? token : undefined, ziel.url), 5 * 60_000);
    if (f.status !== 0) return { ok: false, fehler: `git fetch: ${schwaerzeGit(kurz(f.ausgabe), token)}` };
    const l = await git(['fetch', '-q', '--no-tags', '--', tmp, `+refs/heads/${zweig}:refs/remotes/origin/${zweig}`], dir, gitUmgebung(), 5 * 60_000);
    if (l.status !== 0) return { ok: false, fehler: `Stand nicht übernommen: ${kurz(l.ausgabe)}` };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* bleibt im Temp */ }
  }
  const da = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${zweig}`], dir, gitUmgebung(), 15_000)).status === 0;
  const c = await git(da ? ['checkout', '-q', zweig] : ['checkout', '-q', '-b', zweig, `refs/remotes/origin/${zweig}`], dir, gitUmgebung(), 60_000);
  if (c.status !== 0) return { ok: false, fehler: `git checkout ${zweig}: ${kurz(c.ausgabe)}` };
  if (da) {
    const m = await git(['merge', '-q', '--ff-only', `refs/remotes/origin/${zweig}`], dir, gitUmgebung(), 60_000);
    if (m.status !== 0) return { ok: false, fehler: `${zweig} am Gerät weicht vom GitLab-Stand ab (nur Vorspulen erlaubt): ${kurz(m.ausgabe)}` };
  }
  const h = await git(['rev-parse', '--short', 'HEAD'], dir, gitUmgebung(), 15_000);
  return { ok: true, zweig, sha: h.ausgabe.trim() };
}

/** Parameter für Logzeilen: Geheimnisse ersetzen (Token, Passwörter). */
export function paramsFuerLog(params: Record<string, unknown>): string {
  return JSON.stringify(params, (k, v) => (/token|passw|secret|kennwort/i.test(k) && v ? '***' : v));
}

/**
 * v1444 — Remote eines bestehenden Projekts setzen bzw. entfernen (Owner 13.10.: „wo stellt man für ein Projekt ohne Remote eins ein?“).
 * Ohne Token (nur Konfiguration); der erste Push läuft danach über gitPush (temporäres Repo, Token nur für den Host).
 */
export async function gitRemoteSetzen(dir: string, url: string | undefined, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; text: string } | { ok: false; fehler: string }> {
  const ist = await git(['rev-parse', '--is-inside-work-tree'], dir, gitUmgebung(), 15_000);
  if (ist.status !== 0) return { ok: false, fehler: 'kein Git-Repository im Projektordner' };
  const vorhanden = (await git(['remote'], dir, gitUmgebung(), 15_000)).ausgabe.split('\n').map(x => x.trim()).includes('origin');
  if (!url) {
    if (!vorhanden) return { ok: true, text: 'kein Remote gesetzt' };
    const r = await git(['remote', 'remove', 'origin'], dir, gitUmgebung(), 15_000);
    return r.status === 0 ? { ok: true, text: 'Remote origin entfernt' } : { ok: false, fehler: kurz(r.ausgabe) };
  }
  const p = pruefeRepoUrl(url);
  if (!p.ok) return { ok: false, fehler: p.fehler };
  const r = await git(vorhanden ? ['remote', 'set-url', 'origin', p.url] : ['remote', 'add', 'origin', p.url], dir, gitUmgebung(), 15_000);
  if (r.status !== 0) return { ok: false, fehler: kurz(r.ausgabe) };
  await git(['config', '--unset-all', 'remote.origin.pushurl'], dir, gitUmgebung(), 15_000); // keine abweichende Push-Adresse
  return { ok: true, text: `origin → ${p.url}` };
}
