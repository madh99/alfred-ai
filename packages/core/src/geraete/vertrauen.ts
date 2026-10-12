/**
 * v1411 — R3d Vertrauensstufe „projekt" (Owner 13.10.: „Schalter bauen"; Spec: nur lokal am Gerät setzbar, nie aus dem Chat).
 * Der Satellit meldet aktive Freigaben (`alfred einstellungen vertrauen <pfad> bis <zeit>`) in seinen Sinnen; das Gehirn
 * überspringt die Einzelbestätigung nur für Aktionen, die nachweislich in diesem Verzeichnis bleiben. Installieren, Bedienen,
 * Programme, Entkoppeln und alles außerhalb bleiben bestätigungspflichtig.
 */
export interface Vertrauen { pfad: string; bis: string }

/** Aktionen, die die Vertrauensstufe abdeckt (Pfad-Parameter je Aktion). */
export const VERTRAUEN_AKTIONEN = ['shell', 'datei_ablegen', 'auftrag_starten', 'pruefen_befehl', 'excel_schreiben'] as const;

const norm = (p: string, win: boolean): string => { const x = p.trim().replace(/\\/g, '/').replace(/\/+$/, ''); return win ? x.toLowerCase() : x; };

/** Liegt `p` im Verzeichnis `basis` (oder ist es)? Ohne `..`-Segmente. */
export function imVerzeichnis(p: string, basis: string, win = false): boolean {
  if (!p || /(^|[\\/])\.\.([\\/]|$)/.test(p)) return false;
  const a = norm(p, win); const b = norm(basis, win);
  return !!b && (a === b || a.startsWith(`${b}/`));
}

/**
 * Befehl bleibt im Verzeichnis: kein sudo/su, keine `..`-Segmente, jeder absolute Pfad (/…, ~…, C:\…) liegt im Verzeichnis.
 * Bewusst streng — im Zweifel Bestätigung.
 */
export function befehlBleibtIm(befehl: string, basis: string, win = false): boolean {
  if (!befehl.trim()) return false;
  if (/(^|[\s;&|(`$])(sudo|su|doas|runas|pkexec)(\s|$)/i.test(befehl)) return false;
  if (/(^|[\s"'=:/\\])\.\.([\\/]|\s|$|["'])/.test(befehl)) return false;
  const pfade = befehl.match(/(?:^|[\s"'=])((?:~|\/|[A-Za-z]:[\\/])[^\s"';|&<>()]*)/g) ?? [];
  return pfade.map(t => t.replace(/^[\s"'=]+/, '')).every(t => t !== '/' && !t.startsWith('~') && imVerzeichnis(t, basis, win));
}

function nurLokal(url: string): boolean {
  try { const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h); } catch { return false; }
}

/** Deckt eine aktive Vertrauensstufe diese Aktion? Liefert den Eintrag oder undefined. */
export function vertrauenDeckt(aktion: string, params: Record<string, unknown>, liste: Vertrauen[] | undefined, o: { jetzt?: number; win?: boolean } = {}): Vertrauen | undefined {
  if (!liste?.length || !(VERTRAUEN_AKTIONEN as readonly string[]).includes(aktion)) return undefined;
  const jetzt = o.jetzt ?? Date.now();
  const win = !!o.win;
  for (const v of liste) {
    const bis = Date.parse(v.bis);
    if (!Number.isFinite(bis) || bis <= jetzt || !v.pfad) continue;
    const drin = (p: unknown) => typeof p === 'string' && imVerzeichnis(p, v.pfad, win);
    switch (aktion) {
      case 'shell': if (drin(params.cwd) && befehlBleibtIm(String(params.command ?? ''), v.pfad, win)) return v; break;
      case 'datei_ablegen': if (drin(params.path)) return v; break;
      case 'auftrag_starten': if (drin(params.projekt)) return v; break;
      case 'excel_schreiben': if (drin(params.datei)) return v; break;
      case 'pruefen_befehl': {
        const l = Array.isArray(params.pruefungen) ? params.pruefungen as Array<Record<string, unknown>> : [];
        const ok = l.length > 0 && l.every(x => {
          if (x.art === 'befehl') return drin(x.cwd) && befehlBleibtIm(String(x.ziel ?? ''), v.pfad, win);
          if (x.art === 'datei') return drin(x.ziel);
          if (x.art === 'http') return nurLokal(String(x.ziel ?? '')); // v1384: ohne Bestätigung nur das Gerät selbst (SSRF)
          return x.art === 'fenster'; // lesend
        });
        if (ok) return v;
        break;
      }
    }
  }
  return undefined;
}
