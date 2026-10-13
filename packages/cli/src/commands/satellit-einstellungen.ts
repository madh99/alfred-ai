import os from 'node:os';
import path from 'node:path';
import { statSync } from 'node:fs';
import type { GeraetKonfig } from './pair.js';

/**
 * v1309 — Einstellungen des Satelliten (Owner 08.10.: „es fehlt eine setup bzw config oberfläche"). Alles, was in
 * `~/.alfred/geraet.json` lebt und der Owner selbst ändern darf, als Liste mit Titel und Wert — und als textuelle Befehle,
 * die Sitzung (Ink-Bild und `/einstellungen …`), `alfred einstellungen …` und der Chat (freigabe_aendern) gleich verstehen.
 * Nicht änderbar: Server, Gerätename, Kopplung (dafür `alfred pair` / entkoppeln).
 */
export interface Einstellung { schluessel: string; titel: string; wert: string; art: 'info' | 'text' | 'schalter' | 'liste'; hinweis?: string; eintraege?: string[] }

export const EINSTELLUNGEN_HILFE = [
  'freigabe <pfad> lesen|schreiben|keins   Verzeichnis freigeben (lesen: liste/öffnen/holen; schreiben: auch ablegen/shell) oder entfernen',
  'fenster-sperre + <muster> | - <muster>   Fenster, die Alfred nie bedient (Titelmuster; Standard: Banking, PayPal, Kasse …)',
  'foto-sperre + <muster> | - <muster>      kein Bildschirmfoto, wenn der Fenstertitel das Muster enthält',
  'wort <Aktivierungswort>                  Wort fürs Zuhören (Standard: Alfred)',
  'sinne-fenster an|aus                     Fenstertitel in den Sinnen mitsenden (aus = nur Leerlauf/Akku)',
  'oberflaeche ink|einfach                  Sitzung mit Ink-Oberfläche oder einfacher Ausgabe starten',
  'sudo-sperre an|aus                       Claude-Code-Aufträge dürfen kein sudo verwenden (Systemänderungen nur über „installieren" mit Bestätigung)',
  'beobachter an|aus                        Beobachter dieses Geräts (Ordner u. a.) erlauben oder alle abschalten — die Regeln bleiben am Server',
  'vertrauen <pfad> bis <zeit> | - <pfad>   Vertrauensstufe projekt: Entwicklungsbefehle (npm, git, …) und Prüfungen in diesem Ordner ohne Einzelbestätigung (zeit: 18:00, 4h, 2d, 2026-10-20 18:00; höchstens 30 Tage; nur hier am Gerät, nie aus dem Chat)',
];

const gleich = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const heim = (p: string) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function einstellungen(k: GeraetKonfig, extra: { version: string; dienst: string }): Einstellung[] {
  const frei = k.freigegebeneVerzeichnisse.map(p => `${p} (schreiben)`);
  const lesen = (k.nurLesen ?? []).map(p => `${p} (lesen)`);
  return [
    { schluessel: 'geraet', titel: 'Gerät', wert: `${k.name} · Satellit ${extra.version} · ${extra.dienst}`, art: 'info' },
    { schluessel: 'server', titel: 'Server', wert: `${k.server}${k.insecure ? ' (ohne Zertifikatsprüfung)' : ''} · Gerät ${k.geraetId.slice(0, 8)}`, art: 'info', hinweis: 'ändern mit alfred pair / entkoppeln' },
    { schluessel: 'freigabe', titel: 'Freigaben', wert: `${frei.length + lesen.length} Verzeichnisse`, art: 'liste', eintraege: [...frei, ...lesen], hinweis: 'Enter: lesen ↔ schreiben · Entf: entfernen · +: hinzufügen' },
    { schluessel: 'fenster-sperre', titel: 'Gesperrte Fenster', wert: k.gesperrteFenster ? `${k.gesperrteFenster.length} Muster` : 'Standardliste', art: 'liste', eintraege: k.gesperrteFenster ?? [], hinweis: 'Titelmuster; leer = Standard (Banking, PayPal, Kasse …)' },
    { schluessel: 'foto-sperre', titel: 'Foto-Sperre', wert: k.fotoSperre?.length ? `${k.fotoSperre.length} Muster` : 'keine', art: 'liste', eintraege: k.fotoSperre ?? [] },
    { schluessel: 'wort', titel: 'Aktivierungswort', wert: k.aktivierungswort ?? 'Alfred', art: 'text' },
    { schluessel: 'sinne-fenster', titel: 'Fenstertitel in den Sinnen', wert: k.sinneOhneFenster ? 'aus' : 'an', art: 'schalter' },
    { schluessel: 'oberflaeche', titel: 'Sitzungs-Oberfläche', wert: k.sitzungEinfach ? 'einfach' : 'ink', art: 'schalter' },
    { schluessel: 'vertrauen', titel: 'Vertrauensstufe projekt', wert: aktivesVertrauen(k).length ? `${aktivesVertrauen(k).length} Ordner` : 'keine', art: 'liste', eintraege: aktivesVertrauen(k).map(v => `${v.pfad} bis ${new Date(v.bis).toLocaleString('de-AT')}`), hinweis: 'nur lokal setzbar; Installieren bleibt bestätigungspflichtig' }, // v1411
    { schluessel: 'beobachter', titel: 'Beobachter (Ordner u. a.)', wert: k.beobachterAus ? 'aus' : 'an', art: 'schalter', hinweis: 'aus: dieses Gerät beobachtet nichts, egal was am Server eingestellt ist' }, // v1429
    { schluessel: 'sudo-sperre', titel: 'sudo in Claude-Code-Aufträgen', wert: k.sudoSperre ? 'gesperrt' : 'erlaubt', art: 'schalter', hinweis: 'gesperrt: Systemänderungen nur über installieren mit Bestätigung' }, // v1409
  ];
}

/** Befehl anwenden; ändert `k` an Ort und Stelle. Speichern übernimmt der Aufrufer. */
export function wendeAn(k: GeraetKonfig, befehl: string, arg: string): { ok: boolean; text: string } {
  const b = befehl.trim().toLowerCase();
  const a = arg.trim();
  switch (b) {
    case 'freigabe': {
      const m = /^(.*?)\s+(lesen|schreiben|keins)$/i.exec(a);
      if (!m) return { ok: false, text: 'freigabe <pfad> lesen|schreiben|keins' };
      const pfad = heim(m[1]!.trim().replace(/^"|"$/g, ''));
      const recht = m[2]!.toLowerCase();
      if (recht !== 'keins') { try { if (!statSync(pfad).isDirectory()) return { ok: false, text: `Kein Verzeichnis: ${pfad}` }; } catch { return { ok: false, text: `Verzeichnis nicht gefunden: ${pfad}` }; } }
      k.freigegebeneVerzeichnisse = k.freigegebeneVerzeichnisse.filter(p => !gleich(path.resolve(p), pfad));
      k.nurLesen = (k.nurLesen ?? []).filter(p => !gleich(path.resolve(p), pfad));
      if (recht === 'schreiben') k.freigegebeneVerzeichnisse.push(pfad);
      if (recht === 'lesen') k.nurLesen.push(pfad);
      return { ok: true, text: recht === 'keins' ? `Freigabe entfernt: ${pfad}` : `Freigegeben (${recht}): ${pfad}` };
    }
    case 'fenster-sperre': case 'foto-sperre': {
      const m = /^([+-])\s*(.+)$/.exec(a);
      if (!m) return { ok: false, text: `${b} + <muster> | - <muster>` };
      const feld = b === 'fenster-sperre' ? 'gesperrteFenster' : 'fotoSperre';
      const liste = [...(k[feld] ?? [])];
      const muster = m[2]!.trim();
      const idx = liste.findIndex(x => x.toLowerCase() === muster.toLowerCase());
      if (m[1] === '+') { if (idx < 0) liste.push(muster); } else { if (idx >= 0) liste.splice(idx, 1); }
      k[feld] = liste.length || b === 'foto-sperre' ? liste : undefined;
      return { ok: true, text: `${b === 'fenster-sperre' ? 'Gesperrte Fenster' : 'Foto-Sperre'}: ${liste.length ? liste.join(', ') : (b === 'fenster-sperre' ? 'Standardliste' : 'keine')}` };
    }
    case 'wort': {
      if (!a || /\s/.test(a)) return { ok: false, text: 'wort <ein Wort>' };
      k.aktivierungswort = a;
      return { ok: true, text: `Aktivierungswort: ${a}` };
    }
    case 'sinne-fenster': {
      if (!/^(an|aus)$/i.test(a)) return { ok: false, text: 'sinne-fenster an|aus' };
      k.sinneOhneFenster = a.toLowerCase() === 'aus';
      return { ok: true, text: `Fenstertitel in den Sinnen: ${a.toLowerCase()}` };
    }
    case 'oberflaeche': {
      if (!/^(ink|einfach)$/i.test(a)) return { ok: false, text: 'oberflaeche ink|einfach' };
      k.sitzungEinfach = a.toLowerCase() === 'einfach';
      return { ok: true, text: `Sitzungs-Oberfläche: ${a.toLowerCase()} (gilt für die nächste Sitzung)` };
    }
    case 'vertrauen': { // v1411 R3d — nur lokal (Sitzung, alfred einstellungen), nie aus dem Chat
      const weg = /^-\s*(.+)$/.exec(a);
      if (weg) { const p = heim(weg[1]!.trim().replace(/^"|"$/g, '')); k.vertrauen = (k.vertrauen ?? []).filter(v => !gleich(path.resolve(v.pfad), p)); return { ok: true, text: `Vertrauensstufe entfernt: ${p}` }; }
      const m = /^(.*?)\s+bis\s+(.+)$/i.exec(a);
      if (!m) return { ok: false, text: 'vertrauen <pfad> bis <zeit> | vertrauen - <pfad>' };
      const p = heim(m[1]!.trim().replace(/^"|"$/g, ''));
      try { if (!statSync(p).isDirectory()) return { ok: false, text: `Kein Verzeichnis: ${p}` }; } catch { return { ok: false, text: `Verzeichnis nicht gefunden: ${p}` }; }
      const sep = path.sep;
      if (!k.freigegebeneVerzeichnisse.some(f => { const fr = path.resolve(f); return gleich(fr, p) || (process.platform === 'win32' ? p.toLowerCase().startsWith(fr.toLowerCase() + sep) : p.startsWith(fr + sep)); })) return { ok: false, text: `Nur in einem Verzeichnis mit Schreibrecht: ${p}` };
      const bis = bisAus(m[2]!);
      if (!bis) return { ok: false, text: 'Zeit: 18:00, 4h, 2d oder 2026-10-20 18:00 (höchstens 30 Tage)' };
      k.vertrauen = [...(k.vertrauen ?? []).filter(v => !gleich(path.resolve(v.pfad), p) && Date.parse(v.bis) > Date.now()), { pfad: p, bis: bis.toISOString() }];
      return { ok: true, text: `Vertrauensstufe projekt: ${p} bis ${bis.toLocaleString('de-AT')}` };
    }
    case 'beobachter': { // v1429 R4a — lokales Veto
      if (!/^(an|aus)$/i.test(a)) return { ok: false, text: 'beobachter an|aus' };
      k.beobachterAus = a.toLowerCase() === 'aus';
      return { ok: true, text: `Beobachter auf diesem Gerät: ${k.beobachterAus ? 'aus (nichts wird beobachtet)' : 'an (Regeln vom Server)'}` };
    }
    case 'sudo-sperre': { // v1409 R3b
      if (!/^(an|aus)$/i.test(a)) return { ok: false, text: 'sudo-sperre an|aus' };
      k.sudoSperre = a.toLowerCase() === 'an'; // false statt undefined: Object.assign beim Neuladen übernimmt das Ausschalten (v1410)
      return { ok: true, text: `sudo in Claude-Code-Aufträgen: ${k.sudoSperre ? 'gesperrt' : 'erlaubt'}` };
    }
    default:
      return { ok: false, text: `Unbekannt: ${b}\n${EINSTELLUNGEN_HILFE.join('\n')}` };
  }
}

/** Befehlszeile „freigabe C:\\x schreiben" in Befehl und Argument trennen. */
export function trenneBefehl(zeile: string): { befehl: string; arg: string } {
  const t = zeile.trim();
  const i = t.indexOf(' ');
  return i < 0 ? { befehl: t, arg: '' } : { befehl: t.slice(0, i), arg: t.slice(i + 1).trim() };
}

export function einstellungenText(liste: Einstellung[]): string {
  return liste.map(e => `${e.titel}: ${e.wert}${e.eintraege?.length ? '\n' + e.eintraege.map(x => `   - ${x}`).join('\n') : ''}`).join('\n');
}

/** v1411 — aktive (nicht abgelaufene) Vertrauensstufen. */
export function aktivesVertrauen(k: GeraetKonfig, jetzt = Date.now()): Array<{ pfad: string; bis: string }> {
  return (k.vertrauen ?? []).filter(v => Date.parse(v.bis) > jetzt);
}

/** v1411 — Ablaufzeit: „18:00" (heute, sonst morgen), „4h", „2d", „2026-10-20 18:00"; höchstens 30 Tage. */
export function bisAus(t: string, jetzt = new Date()): Date | undefined {
  const s = t.trim();
  let d: Date | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\s*h$/i.exec(s))) d = new Date(jetzt.getTime() + Number(m[1]) * 3_600_000);
  else if ((m = /^(\d+)\s*d$/i.exec(s))) d = new Date(jetzt.getTime() + Number(m[1]) * 86_400_000);
  else if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) { d = new Date(jetzt); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d.getTime() <= jetzt.getTime()) d = new Date(d.getTime() + 86_400_000); }
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s))) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 23), Number(m[5] ?? 59));
  if (!d || Number.isNaN(d.getTime()) || d.getTime() <= jetzt.getTime() || d.getTime() - jetzt.getTime() > 30 * 86_400_000) return undefined;
  return d;
}
