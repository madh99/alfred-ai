import { execFile } from 'node:child_process';

/**
 * v1283 — Bedienen auf macOS über die Bedienhilfen (System Events / Accessibility), Gegenstück zu Windows UIA.
 * Element-Karte: sichtbare Bedienelemente des vordersten Fensters (JXA, `entireContents`), Betätigen per Rolle,
 * Name und Position, Tippen per `value` oder Tastatur, Tastenkombinationen über `keystroke`/`key code`.
 * Voraussetzung: Berechtigung „Bedienungshilfen" für den Prozess des Satelliten (node) unter Systemeinstellungen →
 * Datenschutz & Sicherheit → Bedienungshilfen; fehlt sie, meldet osascript „not allowed assistive access" (-25211).
 * Vom Owner zu testen (07.10.: „ok").
 */
export interface MacElement { nr: number; typ: string; name: string; wert?: string | null; zustand?: string | null; passwort: boolean; x: number; y: number; w: number; h: number; id?: string | null }

function jxa(script: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr).trim();
        if (/assistive access|-25211|-1719/.test(text)) return reject(new Error('Bedienhilfen-Berechtigung fehlt: Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen → node (Satellit) erlauben'));
        return reject(new Error(`osascript: ${text.slice(0, 300) || err.message}`));
      }
      resolve(String(stdout).trim());
    });
  });
}

const ROLLEN: Record<string, string> = {
  AXButton: 'Button', AXTextField: 'Edit', AXSecureTextField: 'Edit', AXTextArea: 'Document', AXCheckBox: 'CheckBox', AXRadioButton: 'RadioButton',
  AXPopUpButton: 'ComboBox', AXMenuButton: 'MenuButton', AXComboBox: 'ComboBox', AXLink: 'Hyperlink', AXTab: 'TabItem', AXMenuItem: 'MenuItem',
  AXSlider: 'Slider', AXIncrementor: 'Spinner', AXRow: 'ListItem', AXCell: 'DataItem', AXDisclosureTriangle: 'Expander', AXToolbarButton: 'Button',
};

const JS_LESEN = `
const se = Application('System Events');
const suche = __SUCHE__;
let proc = null;
if (suche) { const alle = se.applicationProcesses(); for (const p of alle) { try { if (p.name().toLowerCase().includes(suche.toLowerCase())) { proc = p; break; } } catch (e) {} } }
if (!proc) { const f = se.applicationProcesses.whose({ frontmost: true })(); proc = f.length ? f[0] : null; }
if (!proc) { JSON.stringify({ fehler: 'Kein Programm im Vordergrund' }); }
else {
  let win = null; try { const ws = proc.windows(); win = ws.length ? ws[0] : null; } catch (e) {}
  if (!win) { JSON.stringify({ fehler: 'Programm ' + proc.name() + ' hat kein Fenster' }); }
  else {
    const rollen = __ROLLEN__;
    const out = []; let nr = 0;
    let inhalt = []; try { inhalt = win.entireContents(); } catch (e) {}
    for (const el of inhalt) {
      if (out.length >= 150) break;
      let rolle = ''; try { rolle = el.role(); } catch (e) { continue; }
      if (!rollen[rolle]) continue;
      let enabled = true; try { enabled = el.enabled(); } catch (e) {}
      if (enabled === false) continue;
      let name = ''; try { name = el.name() || ''; } catch (e) {}
      if (!name) { try { name = el.description() || ''; } catch (e) {} }
      if (!name) { try { name = el.title() || ''; } catch (e) {} }
      let wert = null; try { const v = el.value(); if (v !== null && v !== undefined && typeof v !== 'object') wert = String(v).slice(0, 80); } catch (e) {}
      let pos = [0, 0], size = [0, 0]; try { pos = el.position(); size = el.size(); } catch (e) {}
      if (!size[0] || !size[1]) continue;
      nr++;
      const typ = rollen[rolle];
      const zustand = (rolle === 'AXCheckBox' || rolle === 'AXRadioButton') && wert !== null ? (wert === '1' ? 'On' : 'Off') : null;
      out.push({ nr, typ, name, wert: (rolle === 'AXCheckBox' || rolle === 'AXRadioButton') ? null : wert, zustand, passwort: rolle === 'AXSecureTextField', x: Math.round(pos[0]), y: Math.round(pos[1]), w: Math.round(size[0]), h: Math.round(size[1]), id: rolle });
    }
    let titel = ''; try { titel = win.name() || ''; } catch (e) {}
    JSON.stringify({ fenster: titel, programm: proc.name(), pid: proc.unixId(), elemente: out });
  }
}
`;

const JS_AKTION = `
const se = Application('System Events');
const pid = __PID__, rolle = __ROLLE__, name = __NAME__, x = __X__, y = __Y__, aktion = __AKTION__, text = __TEXT__, enter = __ENTER__;
const procs = se.applicationProcesses.whose({ unixId: pid })();
if (!procs.length) { JSON.stringify({ ok: false, fehler: 'Programm läuft nicht mehr' }); }
else {
  const proc = procs[0]; let win = null; try { const ws = proc.windows(); win = ws.length ? ws[0] : null; } catch (e) {}
  if (!win) { JSON.stringify({ ok: false, fehler: 'Fenster weg' }); }
  else {
    let ziel = null, ersatz = null;
    for (const el of win.entireContents()) {
      let r = ''; try { r = el.role(); } catch (e) { continue; }
      if (r !== rolle) continue;
      let n = ''; try { n = el.name() || ''; } catch (e) {} if (!n) { try { n = el.description() || ''; } catch (e) {} } if (!n) { try { n = el.title() || ''; } catch (e) {} }
      if (n !== name) continue;
      let p = [0, 0]; try { p = el.position(); } catch (e) {}
      if (Math.round(p[0]) === x && Math.round(p[1]) === y) { ziel = el; break; }
      if (!ersatz) ersatz = el;
    }
    ziel = ziel || ersatz;
    if (!ziel) { JSON.stringify({ ok: false, fehler: 'Element nicht mehr vorhanden — Fenster neu lesen' }); }
    else if (rolle === 'AXSecureTextField') { JSON.stringify({ ok: false, fehler: 'Passwortfeld — gesperrt' }); }
    else {
      proc.frontmost = true;
      let wie = '';
      if (aktion === 'klicken') { try { ziel.actions.byName('AXPress').perform(); wie = 'AXPress'; } catch (e) { ziel.click(); wie = 'click'; } }
      else if (aktion === 'tippen') {
        let gesetzt = false;
        if (rolle === 'AXTextField' || rolle === 'AXTextArea' || rolle === 'AXComboBox') { try { ziel.value = text; gesetzt = true; wie = 'value'; } catch (e) {} }
        if (!gesetzt) { try { ziel.focused = true; } catch (e) { try { ziel.click(); } catch (e2) {} } delay(0.15); se.keystroke(text); wie = 'keystroke'; }
        if (enter) se.keyCode(36);
      }
      delay(0.15);
      let titel = ''; try { titel = win.name() || ''; } catch (e) {}
      JSON.stringify({ ok: true, wie, fenster: titel });
    }
  }
}
`;

const KEYCODES: Record<string, number> = { enter: 36, eingabe: 36, tab: 48, esc: 53, escape: 53, backspace: 51, rücktaste: 51, entf: 117, delete: 117, del: 117, pos1: 115, home: 115, ende: 119, end: 119, hoch: 126, up: 126, runter: 125, down: 125, links: 123, left: 123, rechts: 124, right: 124, bildauf: 116, pageup: 116, bildab: 121, pagedown: 121, leer: 49, space: 49, leertaste: 49, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const MODS: Record<string, string> = { cmd: 'command down', befehl: 'command down', command: 'command down', strg: 'control down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down', umschalt: 'shift down' };

/** „cmd+s", „strg+c", „enter", „alt+f4" → JXA-Aufruf. Unter macOS ist cmd die übliche Taste; strg bleibt control. */
export function macTaste(kombi: string): string {
  const teile = kombi.toLowerCase().split('+').map(t => t.trim()).filter(Boolean);
  if (/\+\s*$/.test(kombi)) teile.push('+');
  const mods: string[] = []; let taste = '';
  for (const t of teile) {
    if (t in MODS) { mods.push(MODS[t]!); continue; }
    if (taste) throw new Error(`Nur eine Taste je Kombination: ${kombi}`);
    taste = t;
  }
  if (!taste) throw new Error('Taste fehlt (nur Modifikatoren)');
  const using = mods.length ? `, { using: [${mods.map(m => `'${m}'`).join(', ')}] }` : '';
  if (taste in KEYCODES) return `Application('System Events').keyCode(${KEYCODES[taste]}${using}); 'ok'`;
  if (taste.length === 1) return `Application('System Events').keystroke(${JSON.stringify(taste)}${using}); 'ok'`;
  throw new Error(`Unbekannte Taste: ${taste}`);
}

export async function macFensterLesen(suche?: string): Promise<{ fehler?: string; fenster?: string; programm?: string; pid?: number; elemente?: MacElement[] }> {
  const out = await jxa(JS_LESEN.replace('__SUCHE__', JSON.stringify(suche ?? '')).replace('__ROLLEN__', JSON.stringify(ROLLEN)), 60_000);
  return JSON.parse(out || '{}');
}

export async function macAktion(pid: number, e: MacElement, aktion: 'klicken' | 'tippen', text = '', enter = false): Promise<{ ok: boolean; wie?: string; fehler?: string; fenster?: string }> {
  const script = JS_AKTION.replace('__PID__', String(pid)).replace('__ROLLE__', JSON.stringify(e.id ?? '')).replace('__NAME__', JSON.stringify(e.name ?? '')).replace('__X__', String(e.x)).replace('__Y__', String(e.y)).replace('__AKTION__', JSON.stringify(aktion)).replace('__TEXT__', JSON.stringify(text)).replace('__ENTER__', enter ? 'true' : 'false');
  return JSON.parse((await jxa(script)) || '{}');
}

export async function macTasteSenden(kombi: string): Promise<string> {
  await jxa(macTaste(kombi), 15_000);
  return kombi;
}

/** Leerlauf seit der letzten Eingabe in ms (HIDIdleTime, Nanosekunden). */
export async function macLeerlaufMs(): Promise<number> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'"], { timeout: 10_000 }, (err, stdout) => {
      const ns = Number(String(stdout).trim());
      resolve(err || !Number.isFinite(ns) ? Number.NaN : ns / 1e6);
    });
  });
}

/** Klick nach Bildschirmkoordinaten, nur wenn das Programm des vordersten Fensters dem erwarteten entspricht. */
export async function macKlickenBei(x: number, y: number, doppelt = false): Promise<{ ok: boolean; fehler?: string; pid?: number }> {
  const script = `
const se = Application('System Events');
const f = se.applicationProcesses.whose({ frontmost: true })();
if (!f.length) { JSON.stringify({ ok: false, fehler: 'Kein Programm im Vordergrund' }); }
else {
  se.click(null, { at: [${Math.round(x)}, ${Math.round(y)}] });
  ${doppelt ? `delay(0.08); se.click(null, { at: [${Math.round(x)}, ${Math.round(y)}] });` : ''}
  JSON.stringify({ ok: true, pid: f[0].unixId() });
}`;
  return JSON.parse((await jxa(script, 20_000)) || '{}');
}
