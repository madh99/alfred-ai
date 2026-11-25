/**
 * Spec Schwachstellen-Überwachung §3.3/§3.4, Owner-Entscheidungen 25.11. (Fristen bestätigt) — Stufe je Treffer ohne Modell:
 *   kritisch: KEV, CVSS ≥ 9, oder CVSS ≥ 7 und von außen erreichbar — Frist 48 h
 *   hoch:     CVSS ≥ 7 oder EPSS ≥ 10 %                               — Frist 7 Tage
 *   mittel:   CVSS ≥ 4                                                — Frist 30 Tage
 *   niedrig:  Rest (nur Ansicht und Bericht)
 * Ohne Score zählt die Schwere der Quelle. Befund je Komponente ab hoch: kritisch immer, hoch nur mit behobener Version (sonst gibt
 * es nichts zu tun — steht in der Ansicht). Frist ab dem ersten Erkennen.
 */
import type { Auffaelligkeit } from '../bericht.js';
import { rang, type Advisory, type Schwere } from './quellen.js';

export type Stufe = 'kritisch' | 'hoch' | 'mittel' | 'niedrig';
export const FRIST_H: Record<Stufe, number | undefined> = { kritisch: 48, hoch: 7 * 24, mittel: 30 * 24, niedrig: undefined };

export interface Treffer extends Advisory { paket: string; installiert: string; epss?: number; kev?: string; stufe: Stufe; erkannt?: string }

export function stufe(t: Pick<Advisory, 'cvss' | 'schwere'> & { epss?: number; kev?: string }, erreichbar: boolean): Stufe {
  const s = typeof t.cvss === 'number' ? t.cvss : undefined;
  const r = (x: Schwere) => rang(t.schwere) >= rang(x);
  if (t.kev || (s !== undefined ? s >= 9 : r('kritisch')) || (erreichbar && (s !== undefined ? s >= 7 : r('hoch')))) return 'kritisch';
  if ((s !== undefined ? s >= 7 : r('hoch')) || (t.epss ?? 0) >= 0.1) return 'hoch';
  if (s !== undefined ? s >= 4 : r('mittel')) return 'mittel';
  return 'niedrig';
}

export interface Komponente {
  schluessel: string; host: string; name: string; art: 'container' | 'host';
  image?: string; version?: string; anwendung?: string; erreichbar: boolean;
  treffer: Treffer[];
  /** was nicht geprüft werden konnte, mit Grund (nie still) */
  nichtGeprueft: string[];
  /** Quellen, die für diese Komponente in diesem Lauf erfolgreich liefen (github, nvd, osv, trivy) — nur deren Treffer dürfen als behoben gelten */
  geprueft: string[];
}

const STUFEN: Stufe[] = ['kritisch', 'hoch', 'mittel', 'niedrig'];
export const hoechste = (t: Treffer[]): Stufe | undefined => STUFEN.find(s => t.some(x => x.stufe === s));
export const zaehle = (t: Treffer[]) => Object.fromEntries(STUFEN.map(s => [s, t.filter(x => x.stufe === s).length])) as Record<Stufe, number>;

/** kleinste Version, die alle Treffer einer Anwendung behebt, ist nicht sicher bestimmbar — genannt wird die höchste behobene */
function zielVersion(t: Treffer[], anwendung?: string): string | undefined {
  const v = t.filter(x => anwendung && x.paket === anwendung && x.behoben).map(x => x.behoben!.split(/\s*,\s*/)[0]!);
  return v.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}

const frist = (erkannt: string | undefined, s: Stufe, jetzt: Date): string | undefined => {
  const h = FRIST_H[s]; if (!h) return undefined;
  return new Date((erkannt ? Date.parse(erkannt) : jetzt.getTime()) + h * 3_600_000).toISOString();
};

/** Befunde je Komponente (Schlüssel sicherheit:<host>:<name>) — Kategorie sicherheit */
export function befunde(k: Komponente[], jetzt = new Date()): Auffaelligkeit[] {
  const aus: Auffaelligkeit[] = [];
  for (const c of k) {
    const relevant = c.treffer.filter(t => t.stufe === 'kritisch' || (t.stufe === 'hoch' && !!t.behoben));
    const h = hoechste(relevant);
    if (!h) continue;
    const z = zaehle(c.treffer);
    const top = [...relevant].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0))[0]!;
    const fr = relevant.filter(t => t.stufe === h).map(t => frist(t.erkannt, h, jetzt)).filter(Boolean).sort()[0];
    const ziel = zielVersion(c.treffer, c.anwendung);
    const was = c.art === 'container' ? `Container ${c.name}${c.anwendung ? ` (${c.anwendung}${c.version ? ` ${c.version}` : ''})` : ''}` : 'ausstehende Sicherheitsupdates';
    aus.push({
      schwere: 'hoch', bereich: c.host, kategorie: 'sicherheit', schluessel: `sicherheit:${c.host}:${c.name}`, zugang: c.host,
      text: `${h === 'kritisch' ? 'KRITISCH — ' : ''}${was}: ${z.kritisch} kritisch, ${z.hoch} hoch, ${z.mittel} mittel; höchster CVSS ${top.cvss ?? '—'} (${top.id}${top.kev ? ', aktiv ausgenutzt (KEV)' : ''})${c.erreichbar ? ', von außen erreichbar' : ''}${ziel ? `; behoben in ${ziel}` : ''}${fr ? `; Frist bis ${new Date(fr).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' })}` : ''}`,
    });
  }
  return aus;
}

/** Tagesdokument / Meldungstext: Lage je Stufe, Komponenten ab hoch, nicht Geprüftes (ohne Modell) */
export function lageText(k: Komponente[], datum: string, fehler: string[]): string {
  const alle = k.flatMap(c => c.treffer);
  const z = zaehle(alle);
  const zeilen = [`# Schwachstellen ${datum}`, '', `${k.length} Komponenten geprüft · offen: ${z.kritisch} kritisch, ${z.hoch} hoch, ${z.mittel} mittel, ${z.niedrig} niedrig`, ''];
  const wichtig = k.map(c => ({ c, h: hoechste(c.treffer), n: zaehle(c.treffer) })).filter(x => x.h === 'kritisch' || x.h === 'hoch')
    .sort((a, b) => (a.h === b.h ? b.n.kritisch * 100 + b.n.hoch - (a.n.kritisch * 100 + a.n.hoch) : a.h === 'kritisch' ? -1 : 1));
  if (wichtig.length) {
    zeilen.push('## Ab hoch', '');
    for (const { c, h, n } of wichtig) {
      const top = [...c.treffer].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0))[0];
      zeilen.push(`- **${c.host} / ${c.name}**${c.anwendung ? ` (${c.anwendung}${c.version ? ` ${c.version}` : ''})` : ''} — ${h}: ${n.kritisch} kritisch, ${n.hoch} hoch, ${n.mittel} mittel${top ? `; höchster CVSS ${top.cvss ?? '—'} ${top.id}` : ''}${c.erreichbar ? ' · von außen erreichbar' : ''}`);
    }
    zeilen.push('');
  }
  const ng = k.filter(c => c.nichtGeprueft.length);
  if (ng.length) {
    zeilen.push('## Nicht (vollständig) geprüft', '');
    for (const c of ng) zeilen.push(`- ${c.host} / ${c.name}: ${c.nichtGeprueft.join('; ')}`);
    zeilen.push('');
  }
  if (fehler.length) zeilen.push('## Quellenfehler', '', ...fehler.map(f => `- ${f}`));
  return zeilen.join('\n');
}
