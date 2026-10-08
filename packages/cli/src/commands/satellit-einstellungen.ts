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
