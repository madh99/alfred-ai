import { execFile, spawn } from 'node:child_process';
import os from 'node:os';

/**
 * v1339 — Bedienen unter Linux/Wayland (Owner-Freigabe 09.10. „linux tippen auch freigegeben"; Spec §17 Punkt 4 / §18).
 *
 * Unter GNOME Wayland gibt es keinen generischen Zugriff auf fremde Fenster (Titel, Elemente); synthetische Eingaben
 * laufen über uinput (`ydotool`, Zugriff auf /dev/uinput über udev-Regel + Gruppe input). Deshalb Stufe A „light":
 *  - Tasten: `ydotool key ctrl+s` (Tastennamen; ydotool 0.1.8 kennt KEINE Keycode-Form „29:1")
 *  - Text: NICHT tippen — uinput ist layoutblind (deutsches Layout: „YDOTOOL-TEST > /tmp" wurde „ZDOTOOLßTEST : -tmp",
 *    Realfall 09.10. 22:16). Text geht in die Zwischenablage (`wl-copy`) und wird mit Strg+V bzw. Strg+Umschalt+V
 *    (Terminals) eingefügt.
 *  - Maus: Klick nach Bildschirmkoordinaten (`klicken_bei` auf das letzte Bildschirmfoto); ydotool 0.1.8 bewegt relativ,
 *    deshalb erst in die linke obere Ecke und dann um (x, y).
 *  - Notbremse: Leerlauf über Mutter IdleMonitor (D-Bus, auch unter Wayland).
 *  - Element-Karte: zwei feste Ziele (aktives Fenster, Terminalfenster), weil Wayland keine Elemente liefert.
 * `gnome-screenshot` (Foto), `wl-clipboard` und `ydotool` müssen installiert sein; die Sitzungsumgebung (D-Bus, Wayland)
 * ergänzt `linuxSitzungsUmgebung()` für Dienste ohne Anmeldesitzung.
 */

export const LINUX_ZIELE = [
  { nr: 1, typ: 'fenster', name: 'Aktives Fenster — Text wird über die Zwischenablage mit Strg+V eingefügt', passwort: false, x: 0, y: 0, w: 0, h: 0, id: 'fenster' },
  { nr: 2, typ: 'terminal', name: 'Terminalfenster (aktiv) — Text wird mit Strg+Umschalt+V eingefügt', passwort: false, x: 0, y: 0, w: 0, h: 0, id: 'terminal' },
] as const;

const MODS: Record<string, string> = { strg: 'ctrl', ctrl: 'ctrl', control: 'ctrl', steuerung: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', umschalt: 'shift', win: 'super', super: 'super', meta: 'super', cmd: 'super', windows: 'super', altgr: 'rightalt' };
const TASTEN: Record<string, string> = {
  enter: 'enter', eingabe: 'enter', return: 'enter', tab: 'tab', tabulator: 'tab', esc: 'esc', escape: 'esc',
  backspace: 'backspace', rücktaste: 'backspace', ruecktaste: 'backspace', delete: 'delete', entf: 'delete', del: 'delete', einfg: 'insert', insert: 'insert',
  space: 'space', leer: 'space', leertaste: 'space',
  up: 'up', hoch: 'up', oben: 'up', down: 'down', runter: 'down', unten: 'down', left: 'left', links: 'left', right: 'right', rechts: 'right',
  home: 'home', pos1: 'home', end: 'end', ende: 'end', pageup: 'pageup', bildauf: 'pageup', 'bild auf': 'pageup', pagedown: 'pagedown', bildab: 'pagedown', 'bild ab': 'pagedown',
  druck: 'sysrq', print: 'sysrq', menu: 'compose', menü: 'compose',
};

export type LinuxTaste = { art: 'taste'; keys: string } | { art: 'text'; text: string };

/** „strg+s", „alt+f4", „enter", „shift+tab" → ydotool-Tastenfolge; einzelne Zeichen wie * + / = werden über die Zwischenablage eingefügt (layoutsicher). */
export function linuxTaste(kombi: string): LinuxTaste {
  const roh = kombi.trim().toLowerCase();
  if (!roh) throw new Error('Taste fehlt');
  const teile = roh.split('+').map(t => t.trim()).filter(Boolean);
  if (/\+\s*$/.test(kombi)) teile.push('+');
  const mods: string[] = []; let taste = '';
  for (const t of teile) {
    if (t in MODS) { mods.push(MODS[t]!); continue; }
    if (taste) throw new Error(`Nur eine Taste je Kombination: ${kombi}`);
    taste = t;
  }
  if (!taste) throw new Error('Taste fehlt (nur Modifikatoren)');
  if (taste in TASTEN) return { art: 'taste', keys: [...mods, TASTEN[taste]!].join('+') };
  if (/^f([1-9]|1[0-2])$/.test(taste)) return { art: 'taste', keys: [...mods, taste].join('+') };
  if (/^[a-z0-9]$/.test(taste)) return { art: 'taste', keys: [...mods, taste].join('+') };
  if (taste.length === 1 && mods.length === 0) return { art: 'text', text: taste }; // * + / = usw.: Zwischenablage, Layout egal
  const wort: Record<string, string> = { mal: '*', stern: '*', plus: '+', minus: '-', geteilt: '/', slash: '/', gleich: '=', komma: ',', punkt: '.', prozent: '%' };
  if (taste in wort && mods.length === 0) return { art: 'text', text: wort[taste]! };
  throw new Error(`Unbekannte Taste: ${taste}`);
}

/** Sitzungsumgebung für Dienste ohne Anmeldesitzung: D-Bus-Sitzungsbus, Wayland-Display, XDG_RUNTIME_DIR des Benutzers. */
export function linuxSitzungsUmgebung(env: NodeJS.ProcessEnv = process.env, uid: number = typeof process.getuid === 'function' ? process.getuid() : 1000): NodeJS.ProcessEnv {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
    WAYLAND_DISPLAY: env.WAYLAND_DISPLAY || 'wayland-0',
    DISPLAY: env.DISPLAY || ':0',
  };
}

function run(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: linuxSitzungsUmgebung(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { const e = err as NodeJS.ErrnoException; reject(new Error(e.code === 'ENOENT' ? `${cmd} ist nicht installiert` : (String(stderr).trim().split('\n').filter(z => !z.includes('ydotoold backend unavailable')).pop() || err.message))); return; }
      resolve(String(stdout));
    });
  });
}

/** `busctl … GetIdletime` liefert „t 129011" (Millisekunden). */
export function parseLeerlauf(out: string): number {
  const m = /\bt\s+(\d+)/.exec(out);
  return m ? Number(m[1]) : Number.NaN;
}

export async function linuxLeerlaufMs(): Promise<number> {
  try { return parseLeerlauf(await run('busctl', ['--user', 'call', 'org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor', 'GetIdletime'], 10_000)); }
  catch { return Number.NaN; } // ohne GNOME: keine Notbremse über Leerlauf (wie macOS ohne HID)
}

/** Text in die Wayland-Zwischenablage; wl-copy bleibt als Hintergrundprozess am Leben (abgekoppelt, sonst hängt der Aufrufer). */
export function linuxZwischenablage(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn('wl-copy', ['--'], { env: linuxSitzungsUmgebung(), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'ENOENT' ? 'wl-copy ist nicht installiert (Paket wl-clipboard)' : e.message)));
    c.on('spawn', () => { c.stdin.end(text); c.unref(); setTimeout(resolve, 150); });
  });
}

export async function linuxTasteSenden(kombi: string): Promise<string> {
  const t = linuxTaste(kombi);
  if (t.art === 'text') { await linuxZwischenablage(t.text); await run('ydotool', ['key', 'ctrl+v'], 10_000); return `Zwischenablage „${t.text}" + ctrl+v`; }
  await run('ydotool', ['key', t.keys], 10_000);
  return t.keys;
}

/** Text einfügen (Zwischenablage + Strg+V / Strg+Umschalt+V im Terminal), optional Enter. */
export async function linuxAktion(ziel: 'fenster' | 'terminal', aktion: 'klicken' | 'tippen', text = '', enter = false): Promise<{ ok: boolean; wie?: string; fehler?: string }> {
  if (aktion === 'klicken') return { ok: false, fehler: 'Unter Linux/Wayland gibt es keine Element-Karte — klicken_bei mit dem letzten Bildschirmfoto verwenden' };
  if (text) {
    await linuxZwischenablage(text);
    await run('ydotool', ['key', ziel === 'terminal' ? 'ctrl+shift+v' : 'ctrl+v'], 10_000);
  }
  if (enter) await run('ydotool', ['key', '--delay', '150', 'enter'], 10_000);
  return { ok: true, wie: `${text ? `Zwischenablage + ${ziel === 'terminal' ? 'Strg+Umschalt+V' : 'Strg+V'}` : 'nichts eingefügt'}${enter ? ' + Enter' : ''}` };
}

/** Klick nach Bildschirmkoordinaten: erst sicher in die linke obere Ecke (relativ −20000), dann um (x, y), dann Klick. */
export async function linuxKlickenBei(x: number, y: number, doppelt = false): Promise<{ ok: boolean; fehler?: string; pid?: number }> {
  await run('ydotool', ['mousemove', '--', '-20000', '-20000'], 10_000);
  await run('ydotool', ['mousemove', '--', String(Math.round(x)), String(Math.round(y))], 10_000);
  await run('ydotool', ['click', '1'], 10_000);
  if (doppelt) await run('ydotool', ['click', '--delay', '60', '1'], 10_000);
  return { ok: true, pid: 0 };
}

/** Hilfe für den Owner, wenn ydotool oder uinput fehlen. */
export function linuxBedienenHinweis(): string {
  return `ydotool, wl-clipboard und gnome-screenshot installieren; /dev/uinput für die Gruppe input freigeben (udev-Regel KERNEL=="uinput", MODE="0660", GROUP="input") und den Benutzer ${os.userInfo().username} in die Gruppe input aufnehmen; danach den Satellitendienst neu starten.`;
}
