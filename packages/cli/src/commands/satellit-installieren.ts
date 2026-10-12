import { spawn } from 'node:child_process';

/**
 * v1410 — R3c (Owner 13.10.: „Quellen vollumfänglich", jede Installation einzeln bestätigt): Werkzeug installieren als feste
 * Geräteaktion statt freiem Befehl. Quelle und Paketname werden geprüft, der Aufruf läuft ohne Shell (keine Einschleusung),
 * höchstens 15 min. apt braucht sudo ohne Passwort (sonst klarer Fehler), winget-system kann eine Windows-Rückfrage auslösen.
 */
export type InstallQuelle = 'apt' | 'brew' | 'winget' | 'winget-system' | 'npm' | 'pip';
export const INSTALL_QUELLEN: InstallQuelle[] = ['apt', 'brew', 'winget', 'winget-system', 'npm', 'pip'];

/** Paketname: ohne Leerzeichen, nicht mit „-" beginnend (keine Optionen), übliche Zeichen (npm @scope/name, winget Hersteller.Name, apt name=version). */
export const PAKET_MUSTER = /^[A-Za-z0-9@][A-Za-z0-9@._+/:=-]{0,99}$/;

/** Befehl je Quelle — null, wenn die Quelle auf dieser Plattform nicht gilt. */
export function installBefehl(quelle: InstallQuelle, paket: string, plattform: NodeJS.Platform = process.platform, pipx = false): { cmd: string; args: string[] } | null {
  switch (quelle) {
    case 'apt': return plattform === 'linux' ? { cmd: 'sudo', args: ['-n', 'apt-get', 'install', '-y', '--', paket] } : null;
    case 'brew': return plattform === 'darwin' || plattform === 'linux' ? { cmd: 'brew', args: ['install', paket] } : null;
    case 'winget': return plattform === 'win32' ? { cmd: 'winget', args: ['install', '--id', paket, '-e', '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] } : null;
    case 'winget-system': return plattform === 'win32' ? { cmd: 'winget', args: ['install', '--id', paket, '-e', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] } : null;
    case 'npm': return { cmd: plattform === 'win32' ? 'npm.cmd' : 'npm', args: ['install', '-g', '--', paket] };
    case 'pip': return pipx ? { cmd: 'pipx', args: ['install', paket] } : { cmd: plattform === 'win32' ? 'python' : 'python3', args: ['-m', 'pip', 'install', '--user', '--', paket] };
  }
}

export function pruefeInstallation(quelle: unknown, paket: unknown): { quelle: InstallQuelle; paket: string } | string {
  const q = String(quelle ?? '').trim().toLowerCase() as InstallQuelle;
  const p = String(paket ?? '').trim();
  if (!INSTALL_QUELLEN.includes(q)) return `quelle muss ${INSTALL_QUELLEN.join(' | ')} sein`;
  if (!PAKET_MUSTER.test(p)) return `Paketname ungültig: ${p.slice(0, 60)} (keine Leerzeichen, nicht mit „-" beginnen)`;
  return { quelle: q, paket: p };
}

/** Ausführen (ohne Shell, außer npm.cmd unter Windows), Ausgabe gekürzt. */
export function installieren(quelle: InstallQuelle, paket: string, o: { pipx?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; exit: number | null; ausgabe: string; befehl: string }> {
  const b = installBefehl(quelle, paket, process.platform, o.pipx);
  if (!b) return Promise.resolve({ ok: false, exit: null, ausgabe: `Quelle ${quelle} gibt es auf ${process.platform} nicht`, befehl: '' });
  const befehl = `${b.cmd} ${b.args.join(' ')}`;
  return new Promise((resolve) => {
    let aus = '';
    const kind = spawn(b.cmd, b.args, { shell: b.cmd.endsWith('.cmd'), windowsHide: true, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    const timer = setTimeout(() => { try { kind.kill(); } catch { /* weg */ } }, o.timeoutMs ?? 15 * 60_000);
    const sammle = (d: Buffer) => { aus = (aus + d.toString('utf8')).slice(-6000); };
    kind.stdout?.on('data', sammle); kind.stderr?.on('data', sammle);
    kind.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, exit: null, ausgabe: err.message, befehl }); });
    kind.on('close', (code) => {
      clearTimeout(timer);
      const passwort = /a password is required|ein Passwort ist notwendig/i.test(aus);
      resolve({ ok: code === 0, exit: code, ausgabe: passwort ? `sudo verlangt ein Passwort — apt-Installationen auf diesem Gerät bitte selbst ausführen oder sudo ohne Passwort für apt einrichten.\n${aus}` : aus, befehl });
    });
  });
}
