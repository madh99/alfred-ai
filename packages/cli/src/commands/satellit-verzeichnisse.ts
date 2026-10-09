import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * v1339 — Standardfreigaben je Plattform (Realfall Ubuntu-VM 09.10.: die festen englischen Namen „Documents"/„Desktop"
 * existieren auf einem deutschen Ubuntu nicht — dort heißen sie „Dokumente"/„Schreibtisch" laut
 * `~/.config/user-dirs.dirs`). Die Shell-Aktion nahm das erste freigegebene Verzeichnis als Arbeitsverzeichnis und
 * scheiterte mit „Arbeitsverzeichnis existiert nicht".
 */

/** `XDG_DOCUMENTS_DIR="$HOME/Dokumente"` → { DOCUMENTS: '/home/x/Dokumente', … } */
export function xdgBenutzerVerzeichnisse(home: string, inhalt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zeile of inhalt.split('\n')) {
    const m = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"?([^"\n]*)"?\s*$/.exec(zeile);
    if (!m) continue;
    const wert = m[2]!.replace(/^\$HOME/, home).replace(/^~(?=\/|$)/, home);
    if (wert && wert !== home) out[m[1]!] = wert; // „$HOME" allein = Ordner abgeschaltet → nicht freigeben
  }
  return out;
}

/** Linux: Dokumente/Downloads/Schreibtisch aus user-dirs.dirs, sonst die englischen Namen. */
export function linuxStandardVerzeichnisse(home = os.homedir()): string[] {
  let xdg: Record<string, string> = {};
  try { xdg = xdgBenutzerVerzeichnisse(home, readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8')); } catch { /* keine Datei */ }
  return [xdg.DOCUMENTS ?? path.join(home, 'Documents'), xdg.DOWNLOAD ?? path.join(home, 'Downloads'), xdg.DESKTOP ?? path.join(home, 'Desktop')];
}

/**
 * Beim Start: nicht existierende englische Standardeinträge (Documents, Downloads, Desktop im Home) durch die
 * XDG-Verzeichnisse ersetzen, wenn es die gibt. Nur diese drei Einträge, nur wenn der alte fehlt und der neue existiert —
 * vom Owner gesetzte Freigaben bleiben unberührt. Liefert die Ersetzungen (leer = nichts zu tun).
 */
export function repariereStandardFreigaben(freigaben: string[], home = os.homedir(), xdg: string[] = linuxStandardVerzeichnisse(home), existiert: (p: string) => boolean = existsSync): { alt: string; neu: string }[] {
  const paare: [string, string | undefined][] = [[path.join(home, 'Documents'), xdg[0]], [path.join(home, 'Downloads'), xdg[1]], [path.join(home, 'Desktop'), xdg[2]]];
  const ersetzt: { alt: string; neu: string }[] = [];
  for (const [alt, neu] of paare) {
    const i = freigaben.indexOf(alt);
    if (i < 0 || !neu || neu === alt || existiert(alt) || !existiert(neu)) continue;
    if (freigaben.includes(neu)) { freigaben.splice(i, 1); } else { freigaben[i] = neu; }
    ersetzt.push({ alt, neu });
  }
  return ersetzt;
}
