import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access, mkdtemp, rm, rename } from 'node:fs/promises';
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

/**
 * v1656 — Realfall 25.10.2026 01:52: zwei gleichzeitige Abfragen an denselben Zugang; die eine leerte beim Neuschreiben die
 * known_hosts-Datei, während die andere sie las → „No ED25519 host key is known … Host key verification failed“ → Zugang gesperrt,
 * obwohl der Schlüssel unverändert war. Jetzt nur bei geändertem Inhalt und atomar (temporäre Datei, dann umbenennen).
 */
export async function schreibeKnownHosts(datei: string, inhalt: string): Promise<void> {
  try { if (await readFile(datei, 'utf8') === inhalt) return; } catch { /* noch nicht vorhanden */ }
  const tmp = `${datei}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, inhalt, { mode: 0o600 });
  try { await rename(tmp, datei); } catch (err) {
    // Windows verweigert das Ersetzen einer gerade geöffneten Datei; steht der richtige Inhalt schon drin, ist alles gut
    await rm(tmp, { force: true });
    let jetzt = ''; try { jetzt = await readFile(datei, 'utf8'); } catch { /* fehlt */ }
    if (jetzt !== inhalt) throw err;
  }
}

/** v1656 — gesperrt wird nur bei einem tatsächlich anderen Schlüssel; fehlt der Schlüssel in der Datei, ist das kein Wechsel. */
export function schluesselGeaendert(stderr: string): boolean {
  return /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/i.test(stderr);
}

export async function sshAusfuehren(ziel: SshZiel, befehl: string, datenOrdner: string, timeoutMs = 60_000): Promise<SshErgebnis> {
  if (!gueltigerHost(ziel.host) || !gueltigerBenutzer(ziel.benutzer)) throw new Error('Ungültiger Host oder Benutzer');
  if (!ziel.hostSchluessel) throw new Error('Kein bestätigter Host-Schlüssel');
  const ordner = path.join(datenOrdner, 'fernzugriff');
  await mkdir(ordner, { recursive: true, mode: 0o700 });
  const knownHosts = path.join(ordner, `known_hosts_${ziel.id.replace(/[^a-zA-Z0-9-]/g, '')}`);
  await schreibeKnownHosts(knownHosts, ziel.hostSchluessel);
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
      hostSchluesselGeaendert: schluesselGeaendert(stderr),
    };
  }
}

/**
 * I4c — wie sshAusfuehren, aber `eingabe` geht über stdin (Geheimnisse nie in der Befehlszeile, nicht in ps, nicht im Log).
 */
export async function sshMitEingabe(ziel: SshZiel, befehl: string, datenOrdner: string, eingabe: string, timeoutMs = 60_000, max = AUSGABE_MAX): Promise<SshErgebnis> {
  if (!gueltigerHost(ziel.host) || !gueltigerBenutzer(ziel.benutzer)) throw new Error('Ungültiger Host oder Benutzer');
  if (!ziel.hostSchluessel) throw new Error('Kein bestätigter Host-Schlüssel');
  const ordner = path.join(datenOrdner, 'fernzugriff');
  await mkdir(ordner, { recursive: true, mode: 0o700 });
  const knownHosts = path.join(ordner, `known_hosts_${ziel.id.replace(/[^a-zA-Z0-9-]/g, '')}`);
  await schreibeKnownHosts(knownHosts, ziel.hostSchluessel);
  const args = ['-i', ziel.schluesselPfad, '-p', String(ziel.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', `${ziel.benutzer}@${ziel.host}`, befehl];
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => {
    const p = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    let zuViel = false;
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8'); // Mehrbyte-Zeichen (Umlaute in Dateinamen) nicht an Chunk-Grenzen zerteilen
    p.stdout.on('data', d => { if (stdout.length < max) stdout += d; else zuViel = true; });
    p.stderr.on('data', d => { if (stderr.length < AUSGABE_MAX) stderr += d; });
    p.on('close', code => { clearTimeout(t); resolve({ code: zuViel ? 125 : code ?? 124, stdout, stderr: zuViel ? `${stderr}\nAusgabe größer als ${max} Bytes` : stderr, hostSchluesselGeaendert: schluesselGeaendert(stderr) }); });
    p.on('error', err => { clearTimeout(t); resolve({ code: 255, stdout, stderr: err.message, hostSchluesselGeaendert: false }); });
    p.stdin.end(eingabe);
  });
}

/**
 * I6 — Strom von Host zu Host über den Server: stdout der Quelle → (Bandbreitengrenze) → stdin des Ziels. Die Daten berühren weder
 * die Platte des Servers noch das Modell; `eingabe` geht an stdin der Quelle (z. B. die Dateiliste für tar -T -).
 */
export async function sshStrom(q: SshZiel, qBefehl: string, qEingabe: string, z: SshZiel, zBefehl: string, datenOrdner: string,
  o: { timeoutMs: number; kbps?: number; fortschritt?: (bytes: number) => void }): Promise<{ codeQuelle: number; codeZiel: number; bytes: number; stderrQuelle: string; stderrZiel: string; hostSchluesselGeaendert: boolean }> {
  const args = async (x: SshZiel, befehl: string) => {
    if (!gueltigerHost(x.host) || !gueltigerBenutzer(x.benutzer)) throw new Error('Ungültiger Host oder Benutzer');
    if (!x.hostSchluessel) throw new Error('Kein bestätigter Host-Schlüssel');
    const ordner = path.join(datenOrdner, 'fernzugriff');
    await mkdir(ordner, { recursive: true, mode: 0o700 });
    const knownHosts = path.join(ordner, `known_hosts_${x.id.replace(/[^a-zA-Z0-9-]/g, '')}`);
    await schreibeKnownHosts(knownHosts, x.hostSchluessel);
    return ['-i', x.schluesselPfad, '-p', String(x.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR', `${x.benutzer}@${x.host}`, befehl];
  };
  const { spawn } = await import('node:child_process');
  const { Transform } = await import('node:stream');
  const qa = await args(q, qBefehl), za = await args(z, zBefehl);
  return new Promise(resolve => {
    const pq = spawn('ssh', qa, { stdio: ['pipe', 'pipe', 'pipe'] });
    const pz = spawn('ssh', za, { stdio: ['pipe', 'pipe', 'pipe'] });
    let eq = '', ez = '', bytes = 0, cq: number | null | undefined, cz: number | null | undefined;
    const start = Date.now();
    const bremse = new Transform({
      transform(chunk: Buffer, _enc, fertig) {
        bytes += chunk.length;
        o.fortschritt?.(bytes);
        const soll = o.kbps ? (bytes / (o.kbps * 1024)) * 1000 : 0;
        const warte = Math.max(0, soll - (Date.now() - start));
        if (warte > 0) setTimeout(() => fertig(null, chunk), Math.min(warte, 5_000)); else fertig(null, chunk);
      },
    });
    const t = setTimeout(() => { pq.kill('SIGKILL'); pz.kill('SIGKILL'); }, o.timeoutMs);
    pq.stderr.on('data', d => { if (eq.length < 64_000) eq += d; });
    pz.stderr.on('data', d => { if (ez.length < 64_000) ez += d; });
    pz.stdout.resume();
    pq.stdout.pipe(bremse).pipe(pz.stdin);
    pz.stdin.on('error', () => undefined);
    const ende = () => {
      if (cq === undefined || cz === undefined) return;
      clearTimeout(t);
      resolve({ codeQuelle: cq ?? 124, codeZiel: cz ?? 124, bytes, stderrQuelle: eq, stderrZiel: ez, hostSchluesselGeaendert: schluesselGeaendert(eq + ez) });
    };
    // Bricht das Ziel ab, darf die Quelle nicht ewig weiterschreiben (und umgekehrt bekommt das Ziel EOF über die Pipe)
    pq.on('close', c => { cq = c; ende(); });
    pz.on('close', c => { cz = c; if (cq === undefined && c !== 0) pq.kill('SIGTERM'); ende(); });
    pq.on('error', err => { eq += err.message; cq = 255; ende(); });
    pz.on('error', err => { ez += err.message; cz = 255; ende(); });
    pq.stdin.on('error', () => undefined);
    pq.stdin.end(qEingabe);
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
