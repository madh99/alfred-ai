import os from 'node:os';
import path from 'node:path';

/**
 * v1303 — Tilde im Pfad (Owner-Freigabe 08.10.): das Modell übergibt gern `~/Downloads`; die Freigaben stehen absolut.
 * `~` und `~/…` bzw. `~\…` werden auf das Home-Verzeichnis des angemeldeten Benutzers abgebildet, sonst bleibt der Pfad.
 */
export function heim(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (/^~[\\/]/.test(p)) return path.join(home, p.slice(2));
  return p;
}

/** Pfad-Parameter einer Aktion an Ort und Stelle auflösen (path, pfad, datei, cwd). */
export function heimInParams(params: Record<string, unknown>, home: string = os.homedir()): void {
  for (const key of ['path', 'pfad', 'datei', 'cwd']) {
    const v = params[key];
    if (typeof v === 'string' && v.startsWith('~')) params[key] = heim(v, home);
  }
}
