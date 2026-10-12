/**
 * v1411 — R3d Vertrauensstufe „projekt" (Owner 13.10.: „Schalter bauen"; Spec: nur lokal am Gerät setzbar, nie aus dem Chat).
 * v1413: deckt nur shell (Erlaubnisliste), pruefen_befehl und excel_schreiben — nicht auftrag_starten, nicht datei_ablegen.
 * Der Satellit meldet aktive Freigaben (`alfred einstellungen vertrauen <pfad> bis <zeit>`) in seinen Sinnen; das Gehirn
 * überspringt die Einzelbestätigung nur für Aktionen, die nachweislich in diesem Verzeichnis bleiben. Installieren, Bedienen,
 * Programme, Entkoppeln und alles außerhalb bleiben bestätigungspflichtig.
 */
export interface Vertrauen { pfad: string; bis: string }

/** Aktionen, die die Vertrauensstufe abdeckt (Pfad-Parameter je Aktion). */
// v1413 — ohne auftrag_starten: ein Claude-Code-Auftrag kann im Auto-Modus fast alles (Sicherheitsprüfung 13.10.); Projekte deckt die Plan-Freigabe
// v1413 — ohne datei_ablegen: sonst könnte ein eingeschleuster Auftrag erst Code ablegen und ihn dann mit „node datei.js" ohne Rückfrage ausführen
export const VERTRAUEN_AKTIONEN = ['shell', 'pruefen_befehl', 'excel_schreiben'] as const;

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
  // v1412 — Sicherheitsprüfung 13.10.: eine Sperrliste über freie Shell-Befehle ist keine Grenze. Deshalb nur bekannte
  // Entwicklungswerkzeuge ohne Shell-Sonderzeichen und ohne Code-als-Text (node -e, python -c); alles andere fragt nach.
  if (/[$`;|&<>()\\\r\n{}]/.test(befehl)) return false;
  const teile = befehl.trim().split(/\s+/);
  const prog = (teile[0] ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  const regel = ERLAUBTE_PROGRAMME[prog];
  if (!regel || !regel(teile.slice(1))) return false;
  if (/(^|[\s;&|(`$])(sudo|su|doas|runas|pkexec)(\s|$)/i.test(befehl)) return false;
  if (/(^|[\s"'=:/\\])\.\.([\\/]|\s|$|["'])/.test(befehl)) return false;
  const pfade = befehl.match(/(?:^|[\s"'=])((?:~|\/|[A-Za-z]:[\\/])[^\s"';|&<>()]*)/g) ?? [];
  return pfade.map(t => t.replace(/^[\s"'=]+/, '')).every(t => t !== '/' && !t.startsWith('~') && imVerzeichnis(t, basis, win));
}

/** v1412 — erlaubte Programme unter der Vertrauensstufe und ihre Argumentregel (true = erlaubt). */
const keinCodeText = (a: string[]) => !a.some(x => /^(-e|--eval|-p|--print|-c|-m|--command|-r|--require|--import|--loader)$/.test(x));
const mitUnterbefehl = (erlaubt: string[]) => (a: string[]) => a.length > 0 && erlaubt.includes(a[0]!.toLowerCase());
export const ERLAUBTE_PROGRAMME: Record<string, (args: string[]) => boolean> = {
  npm: mitUnterbefehl(['test', 't', 'run', 'run-script', 'install', 'i', 'ci', 'ls', 'outdated', 'audit', 'start', 'build']),
  pnpm: mitUnterbefehl(['test', 'run', 'install', 'i', 'ls', 'outdated', 'audit', 'start', 'build']),
  yarn: (a) => a.length === 0 || ['test', 'run', 'install', 'start', 'build'].includes(a[0]!.toLowerCase()),
  node: (a) => a.length > 0 && keinCodeText(a) && !a[0]!.startsWith('-'),
  python: (a) => a.length > 0 && keinCodeText(a) && !a[0]!.startsWith('-'),
  python3: (a) => a.length > 0 && keinCodeText(a) && !a[0]!.startsWith('-'),
  pytest: () => true,
  go: mitUnterbefehl(['test', 'build', 'vet']),
  cargo: mitUnterbefehl(['test', 'build', 'check', 'clippy']),
  make: () => true, flutter: mitUnterbefehl(['test', 'build', 'analyze', 'pub']), dart: mitUnterbefehl(['test', 'analyze', 'format']),
  git: mitUnterbefehl(['status', 'log', 'diff', 'show', 'add', 'commit', 'branch']),
  ls: () => true, tree: () => true, cat: () => true, head: () => true, tail: () => true, wc: () => true,
};

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
