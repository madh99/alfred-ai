/**
 * Spec Schwachstellen-Überwachung §3.3/§3.4, Owner-Entscheidungen 25.11. (Fristen bestätigt) — Stufe je Treffer ohne Modell:
 *   kritisch: KEV, CVSS ≥ 9, oder CVSS ≥ 7 und von außen erreichbar — Frist 48 h
 *   hoch:     CVSS ≥ 7 oder EPSS ≥ 10 %                               — Frist 7 Tage
 *   mittel:   CVSS ≥ 4                                                — Frist 30 Tage
 *   niedrig:  Rest (nur Ansicht und Bericht)
 * Ohne Score zählt die Schwere der Quelle. Befund je Komponente ab hoch: kritisch immer, hoch nur mit behobener Version (sonst gibt
 * es nichts zu tun — steht in der Ansicht). Frist ab dem ersten Erkennen.
 *
 * Kalibrierung (Owner 25.11. nach dem ersten Lauf: 2001 „kritisch“, 99 % Trivy-Treffer in Basis-Paketen alter Images) — für Pakete im
 * Image (Trivy, `basis`) entscheidet die tatsächliche Gefährdung, nicht der NVD-Höchstwert:
 *   kritisch: KEV, oder EPSS ≥ 10 % und von außen erreichbar
 *   hoch:     EPSS ≥ 10 %, oder CVSS ≥ 9 mit behobener Version
 *   mittel:   CVSS ≥ 4 (nur Ansicht)
 * Gezählt wird je CVE und Komponente (nicht je Paket), Basis-Pakete ergeben einen Sammel-Befund „Image aktualisieren“.
 */
import type { Auffaelligkeit } from '../bericht.js';
import { rang, type Advisory, type Schwere } from './quellen.js';

export type Stufe = 'kritisch' | 'hoch' | 'mittel' | 'niedrig';
export const FRIST_H: Record<Stufe, number | undefined> = { kritisch: 48, hoch: 7 * 24, mittel: 30 * 24, niedrig: undefined };

/** `basis`: Paket im Image (Trivy), nicht die Anwendung selbst */
export interface Treffer extends Advisory { paket: string; installiert: string; epss?: number; kev?: string; stufe: Stufe; erkannt?: string; basis?: boolean }

const EPSS_HOCH = 0.1;

export function stufe(t: Pick<Advisory, 'cvss' | 'schwere'> & { epss?: number; kev?: string; basis?: boolean; behoben?: string }, erreichbar: boolean): Stufe {
  const s = typeof t.cvss === 'number' ? t.cvss : undefined;
  const r = (x: Schwere) => rang(t.schwere) >= rang(x);
  const ep = (t.epss ?? 0) >= EPSS_HOCH;
  if (t.basis) {
    if (t.kev || (ep && erreichbar)) return 'kritisch';
    if (ep || ((s !== undefined ? s >= 9 : r('kritisch')) && !!t.behoben)) return 'hoch';
    return (s !== undefined ? s >= 4 : r('mittel')) ? 'mittel' : 'niedrig';
  }
  if (t.kev || (s !== undefined ? s >= 9 : r('kritisch')) || (erreichbar && (s !== undefined ? s >= 7 : r('hoch')))) return 'kritisch';
  if ((s !== undefined ? s >= 7 : r('hoch')) || ep) return 'hoch';
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
  /** eine Quelle (Anwendung, Trivy, OSV, EPSS/KEV) ist in diesem Lauf ausgefallen — der Befund darf nicht als gelöst gelten */
  quellenFehler: boolean;
}

const STUFEN: Stufe[] = ['kritisch', 'hoch', 'mittel', 'niedrig'];
export const hoechste = (t: Treffer[]): Stufe | undefined => STUFEN.find(s => t.some(x => x.stufe === s));
/** je CVE (Kennung) einmal, mit ihrer höchsten Stufe — eine Lücke in zehn Unterpaketen derselben Bibliothek zählt einmal */
export function zaehle(t: Treffer[]): Record<Stufe, number> {
  const je = new Map<string, number>();
  for (const x of t) { const i = STUFEN.indexOf(x.stufe); const alt = je.get(x.id); if (alt === undefined || i < alt) je.set(x.id, i); }
  const z = { kritisch: 0, hoch: 0, mittel: 0, niedrig: 0 } as Record<Stufe, number>;
  for (const i of je.values()) z[STUFEN[i]!]++;
  return z;
}
/** Zählung über mehrere Komponenten: je Komponente und CVE einmal */
export const zaehleKomponenten = (k: Komponente[]): Record<Stufe, number> => {
  const z = { kritisch: 0, hoch: 0, mittel: 0, niedrig: 0 } as Record<Stufe, number>;
  for (const c of k) { const n = zaehle(c.treffer); for (const s of STUFEN) z[s] += n[s]; }
  return z;
};
/** kleinste Version, die alle Treffer einer Anwendung behebt, ist nicht sicher bestimmbar — genannt wird die höchste behobene */
function zielVersion(t: Treffer[], anwendung?: string): string | undefined {
  const v = t.filter(x => anwendung && x.paket === anwendung && x.behoben).map(x => x.behoben!.split(/\s*,\s*/)[0]!);
  return v.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}

const frist = (erkannt: string | undefined, s: Stufe, jetzt: Date): string | undefined => {
  const h = FRIST_H[s]; if (!h) return undefined;
  return new Date((erkannt ? Date.parse(erkannt) : jetzt.getTime()) + h * 3_600_000).toISOString();
};

/** CVSS-Angabe für Texte — ohne Score (manche GitHub-/OSV-Einträge) die Schwere der Quelle statt „—“ */
const cvssAngabe = (t: Pick<Treffer, 'cvss' | 'schwere'>) => (t.cvss !== undefined ? `höchster CVSS ${t.cvss}` : `ohne CVSS-Wert, Schwere laut Quelle ${t.schwere}`);

/**
 * Handlungsbedarf (Befund, Meldung): kritisch immer, hoch nur mit behobener Version. Owner 26.11.: ein Basis-Paket ohne Fix und
 * ohne KEV (Realfall CVE-2011-3389 BEAST in libgnutls, Vaultwarden 1.37.5) ist nie Handlungsbedarf — ein neues Image hilft nicht;
 * es bleibt in Ansicht und Bericht sichtbar. Aktiv ausgenutzt (KEV) bleibt immer ein Befund, auch ohne Fix.
 */
export const handlungsbedarf = (t: Pick<Treffer, 'stufe' | 'basis' | 'behoben' | 'kev'>): boolean =>
  (t.stufe === 'kritisch' && (!t.basis || !!t.behoben || !!t.kev)) || (t.stufe === 'hoch' && !!t.behoben);

/** Befunde je Komponente (Schlüssel sicherheit:<host>:<name>) — Kategorie sicherheit */
export function befunde(k: Komponente[], jetzt = new Date()): Auffaelligkeit[] {
  const aus: Auffaelligkeit[] = [];
  const relevant = handlungsbedarf;
  for (const c of k) {
    const app = c.treffer.filter(t => !t.basis); const bas = c.treffer.filter(t => t.basis);
    const relApp = app.filter(relevant); const relBas = bas.filter(relevant);
    const h = hoechste([...relApp, ...relBas]);
    if (!h) continue;
    const fr = [...relApp, ...relBas].filter(t => t.stufe === h).map(t => frist(t.erkannt, h, jetzt)).filter(Boolean).sort()[0];
    const teile: string[] = []; const erreichbar = c.erreichbar ? ', von außen erreichbar' : '';
    if (relApp.length) {
      const z = zaehle(app);
      const top = [...relApp].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0))[0]!;
      const was = c.art === 'container' ? `Container ${c.name}${c.anwendung ? ` (${c.anwendung}${c.version ? ` ${c.version}` : ''})` : ''}` : 'ausstehende Sicherheitsupdates';
      const ziel = zielVersion(c.treffer, c.anwendung);
      teile.push(`${was}: ${z.kritisch} kritisch, ${z.hoch} hoch, ${z.mittel} mittel; ${cvssAngabe(top)} (${top.id}${top.kev ? ', aktiv ausgenutzt (KEV)' : ''})${erreichbar}${ziel ? `; behoben in ${ziel}` : ''}`);
    }
    if (relBas.length) {
      // Sammel-Befund je Image: die Maßnahme ist dieselbe (Image aktualisieren bzw. neu bauen), egal wie viele Pakete betroffen sind
      const z = zaehle(relBas);
      const top = [...relBas].sort((a, b) => Number(!!b.kev) - Number(!!a.kev) || (b.epss ?? 0) - (a.epss ?? 0) || (b.cvss ?? 0) - (a.cvss ?? 0))[0]!;
      const grund = top.kev ? ', aktiv ausgenutzt (KEV)' : top.epss !== undefined && top.epss >= EPSS_HOCH ? `, EPSS ${Math.round(top.epss * 100)} %` : top.cvss !== undefined ? `, CVSS ${top.cvss}` : '';
      teile.push(`${relApp.length ? 'Basis-Image' : `Basis-Image von Container ${c.name}${c.image ? ` (${c.image.slice(0, 80)})` : ''}`}: ${z.kritisch} kritisch, ${z.hoch} hoch in ${new Set(relBas.map(t => t.paket)).size} Paketen (u. a. ${top.id} in ${top.paket}${grund})${relApp.length ? '' : erreichbar} — Image aktualisieren bzw. neu bauen`);
    }
    aus.push({
      schwere: 'hoch', bereich: c.host, kategorie: 'sicherheit', schluessel: `sicherheit:${c.host}:${c.name}`, zugang: c.host,
      text: `${h === 'kritisch' ? 'KRITISCH — ' : ''}${teile.join('; ')}${fr ? `; Frist bis ${new Date(fr).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' })}` : ''}`,
    });
  }
  return aus;
}

/** Tagesdokument / Meldungstext: Lage je Stufe, Komponenten ab hoch, nicht Geprüftes (ohne Modell) */
export function lageText(k: Komponente[], datum: string, fehler: string[]): string {
  const z = zaehleKomponenten(k);
  const zeilen = [`# Schwachstellen ${datum}`, '', `${k.length} Komponenten geprüft · offen: ${z.kritisch} kritisch, ${z.hoch} hoch, ${z.mittel} mittel, ${z.niedrig} niedrig`, ''];
  const wichtig = k.map(c => ({ c, h: hoechste(c.treffer), n: zaehle(c.treffer) })).filter(x => x.h === 'kritisch' || x.h === 'hoch')
    .sort((a, b) => (a.h === b.h ? b.n.kritisch * 100 + b.n.hoch - (a.n.kritisch * 100 + a.n.hoch) : a.h === 'kritisch' ? -1 : 1));
  if (wichtig.length) {
    zeilen.push('## Ab hoch', '');
    for (const { c, h, n } of wichtig) {
      const top = [...c.treffer].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0))[0];
      zeilen.push(`- **${c.host} / ${c.name}**${c.anwendung ? ` (${c.anwendung}${c.version ? ` ${c.version}` : ''})` : ''} — ${h}: ${n.kritisch} kritisch, ${n.hoch} hoch, ${n.mittel} mittel${top ? `; ${cvssAngabe(top)} ${top.id}` : ''}${c.erreichbar ? ' · von außen erreichbar' : ''}`);
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
