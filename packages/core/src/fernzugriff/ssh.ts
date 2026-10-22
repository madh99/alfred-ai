import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { gueltigerHost, gueltigerBenutzer } from './regeln.js';

const execFileAsync = promisify(execFile);

/**
 * v1539 — SSH für den Fernzugriff. Anders als die bisherigen Aufrufe (StrictHostKeyChecking=no, known_hosts=/dev/null) gilt
 * hier ausschließlich der vom Owner bestätigte Host-Schlüssel: eigene known_hosts-Datei je Zugang, StrictHostKeyChecking=yes,
 * BatchMode (nie ein Passwort-Prompt), nur der eigene Schlüssel (IdentitiesOnly).
 */
export interface SshZiel { id: string; host: string; port: number; benutzer: string; schluesselPfad: string; hostSchluessel?: string }
export interface SshErgebnis { code: number; stdout: string; stderr: string; hostSchluesselGeaendert: boolean }

export const AUSGABE_MAX = 4 * 1024 * 1024;

export async function sshAusfuehren(ziel: SshZiel, befehl: string, datenOrdner: string, timeoutMs = 60_000): Promise<SshErgebnis> {
  if (!gueltigerHost(ziel.host) || !gueltigerBenutzer(ziel.benutzer)) throw new Error('Ungültiger Host oder Benutzer');
  if (!ziel.hostSchluessel) throw new Error('Kein bestätigter Host-Schlüssel');
  const ordner = path.join(datenOrdner, 'fernzugriff');
  await mkdir(ordner, { recursive: true, mode: 0o700 });
  const knownHosts = path.join(ordner, `known_hosts_${ziel.id.replace(/[^a-zA-Z0-9-]/g, '')}`);
  await writeFile(knownHosts, ziel.hostSchluessel, { mode: 0o600 });
  const args = [
    '-i', ziel.schluesselPfad, '-p', String(ziel.port),
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR',
    `${ziel.benutzer}@${ziel.host}`, befehl,
  ];
  try {
    const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: timeoutMs, maxBuffer: AUSGABE_MAX });
    return { code: 0, stdout, stderr, hostSchluesselGeaendert: false };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string; killed?: boolean };
    const stderr = e.stderr ?? e.message;
    return {
      code: typeof e.code === 'number' ? e.code : e.killed ? 124 : 255, stdout: e.stdout ?? '', stderr,
      hostSchluesselGeaendert: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr),
    };
  }
}

/**
 * I4c — wie sshAusfuehren, aber `eingabe` geht über stdin (Geheimnisse nie in der Befehlszeile, nicht in ps, nicht im Log).
 */
export async function sshMitEingabe(ziel: SshZiel, befehl: string, datenOrdner: string, eingabe: string, timeoutMs = 60_000): Promise<SshErgebnis> {
  if (!gueltigerHost(ziel.host) || !gueltigerBenutzer(ziel.benutzer)) throw new Error('Ungültiger Host oder Benutzer');
  if (!ziel.hostSchluessel) throw new Error('Kein bestätigter Host-Schlüssel');
  const ordner = path.join(datenOrdner, 'fernzugriff');
  await mkdir(ordner, { recursive: true, mode: 0o700 });
  const knownHosts = path.join(ordner, `known_hosts_${ziel.id.replace(/[^a-zA-Z0-9-]/g, '')}`);
  await writeFile(knownHosts, ziel.hostSchluessel, { mode: 0o600 });
  const args = ['-i', ziel.schluesselPfad, '-p', String(ziel.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', `${ziel.benutzer}@${ziel.host}`, befehl];
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => {
    const p = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', d => { if (stdout.length < AUSGABE_MAX) stdout += d; });
    p.stderr.on('data', d => { if (stderr.length < AUSGABE_MAX) stderr += d; });
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? 124, stdout, stderr, hostSchluesselGeaendert: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr) }); });
    p.on('error', err => { clearTimeout(t); resolve({ code: 255, stdout, stderr: err.message, hostSchluesselGeaendert: false }); });
    p.stdin.end(eingabe);
  });
}

/** Host-Schlüssel lesen (ohne Anmeldung) — Ergebnis bestätigt der Owner, erst dann wird er verwendet. */
export async function keyscan(host: string, port: number): Promise<string> {
  if (!gueltigerHost(host)) throw new Error('Ungültiger Host');
  const { stdout } = await execFileAsync('ssh-keyscan', ['-T', '5', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host], { timeout: 20_000, maxBuffer: 256 * 1024 });
  return stdout;
}

/** Eigener Schlüssel für den Fernzugriff (data/fernzugriff/id_ed25519); wird beim ersten Bedarf erzeugt. */
/** I5 — neuer ed25519-Host-Schlüssel für eine VM; die Dateien liegen nur kurz in einem 700-Ordner unter data/ und werden sofort entfernt. */
export async function hostSchluesselErzeugen(datenOrdner: string): Promise<{ privat: string; oeffentlich: string }> {
  const basis = path.join(datenOrdner, 'fernzugriff');
  await mkdir(basis, { recursive: true, mode: 0o700 });
  const ordner = await mkdtemp(path.join(basis, 'host-'));
  try {
    const pfad = path.join(ordner, 'k');
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', pfad], { timeout: 20_000 });
    return { privat: await readFile(pfad, 'utf8'), oeffentlich: (await readFile(`${pfad}.pub`, 'utf8')).trim() };
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
}

export async function eigenerSchluessel(datenOrdner: string): Promise<{ pfad: string; oeffentlich: string; neu: boolean }> {
  const ordner = path.join(datenOrdner, 'fernzugriff');
  await mkdir(ordner, { recursive: true, mode: 0o700 });
  const pfad = path.join(ordner, 'id_ed25519');
  let neu = false;
  try { await access(pfad); } catch {
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'alfred-fernzugriff', '-f', pfad], { timeout: 20_000 });
    neu = true;
  }
  return { pfad, oeffentlich: (await readFile(`${pfad}.pub`, 'utf8')).trim(), neu };
}
