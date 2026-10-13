import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

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
  return { ok: true, url: `${p.protocol}//${p.host}${p.pathname}` };
}

/** Adresse ohne Zugangsdaten (für Anzeige und Speicher). */
export function ohneZugang(url: string): string { return url.replace(/^(https?:\/\/)[^@/]+@/, '$1'); }

/** Umgebung für einen git-Aufruf: Token als Kopfzeile (Basic oauth2:<token>), nie Rückfragen. */
export function gitUmgebung(token?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  if (!token) return env;
  return { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}` };
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
  const c = await git(['clone', '--', p.url, ziel], undefined, gitUmgebung(token), 10 * 60_000);
  if (c.status !== 0) return { ok: false, fehler: `git clone: ${schwaerzeGit(kurz(c.ausgabe), token)}` };
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ziel, gitUmgebung(), 15_000);
  const h = await git(['rev-parse', '--short', 'HEAD'], ziel, gitUmgebung(), 15_000);
  return { ok: true, branch: b.ausgabe.trim() || '?', sha: h.status === 0 ? h.ausgabe.trim() : '', text: `${ohneZugang(p.url)} → ${ziel}` };
}

/** Aktuellen Zweig nach origin pushen. */
export async function gitPush(dir: string, token: string | undefined, git: GitAusfuehren = gitAusfuehren): Promise<{ ok: true; branch: string; sha: string; remote: string; text: string } | { ok: false; fehler: string }> {
  const r = await git(['remote', 'get-url', 'origin'], dir, gitUmgebung(), 15_000);
  if (r.status !== 0 || !r.ausgabe.trim()) return { ok: false, fehler: 'kein Remote origin im Projekt' };
  const remote = ohneZugang(r.ausgabe.trim());
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, gitUmgebung(), 15_000);
  const branch = b.ausgabe.trim();
  if (b.status !== 0 || !branch || branch === 'HEAD') return { ok: false, fehler: 'kein Zweig ausgecheckt (detached HEAD)' };
  const p = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir, gitUmgebung(token), 5 * 60_000);
  if (p.status !== 0) return { ok: false, fehler: `git push: ${schwaerzeGit(kurz(p.ausgabe), token)}` };
  const h = await git(['rev-parse', '--short', 'HEAD'], dir, gitUmgebung(), 15_000);
  return { ok: true, branch, sha: h.ausgabe.trim(), remote, text: schwaerzeGit(kurz(p.ausgabe), token) };
}

/** Parameter für Logzeilen: Geheimnisse ersetzen (Token, Passwörter). */
export function paramsFuerLog(params: Record<string, unknown>): string {
  return JSON.stringify(params, (k, v) => (/token|passw|secret|kennwort/i.test(k) && v ? '***' : v));
}
