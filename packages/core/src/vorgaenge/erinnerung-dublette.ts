/**
 * v1492 — Gleiche Erinnerung? (Owner 17.10. „1–3 umsetzen, wenn vollständig analysiert und sicher“.) Realfall 10.–17.10.:
 * 4 Erinnerungen „noahhabel bei easyname verlängern“, 3 „Batterie Temp Terrasse wechseln“ — die bisherige Prüfung
 * (≥ 3 gemeinsame Wörter, an Leerzeichen getrennt, ausgelöste nur 24 h) erkannte in 30 Tagen KEINE der 95 Erinnerungen.
 * Jetzt: Gegenstands-Erkennung aus v1428 (Wortstämme + Anker), dazu harte Gegenproben, kalibriert an allen
 * Erinnerungen 16.09.–17.10.: widersprechen sich Domains, Kennungen (Ticket-, Rechnungs-, Hex-Nummern) oder Monate, ist
 * es ein anderer Gegenstand; Sammel-Erinnerungen („1) … 2) …“) sperren keine einzelne und werden nie gesperrt.
 * Datum, Uhrzeit und Prozent dürfen sich ändern (Frist 18.10. → 19.10., Akku 15 % → 1 % = dieselbe Sache).
 */
import { objektTreffer } from '../insights/objekt-hinweis.js';
import { inhaltsWoerter } from '../insights/hinweis-pruefung.js';

const MONATE = ['januar', 'jänner', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

/** Registrare und Dienste, die in vielen Erinnerungen vorkommen, ohne der Gegenstand zu sein (Kalibrierung: „easyname.com“ machte pinkribbons.club und dohnal.dev gleich). */
const KEIN_GEGENSTAND = /^(easyname\.(com|at|de)|nic\.at|github\.com|apple\.com|google\.com|gmail\.com|outlook\.com|microsoft\.com)$/;

/** Merkmale, die einen Gegenstand eindeutig unterscheiden (je Art). Links zählen nicht. */
export function unterscheidendeMerkmale(s: string): Record<'domain' | 'kennung' | 'monat', Set<string>> {
  const t = s.toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  const domain = new Set([...t.matchAll(/\b([a-z0-9-]+\.(?:com|at|de|net|org|io|eu|ch|it|dev|club|app|info))\b/g)].map(m => m[1]!).filter(x => !KEIN_GEGENSTAND.test(x)));
  const kennung = new Set<string>([
    ...[...s.matchAll(/#\s?(\d{4,})/g)].map(m => `#${m[1]}`),
    ...[...s.matchAll(/\b([A-Z]{2,4}-?\d{4,})\b/g)].map(m => m[1]!.replace('-', '').toUpperCase()),
    ...[...s.matchAll(/\b([0-9a-f]{8,})\b/gi)].filter(m => /\d/.test(m[1]!) && /[a-f]/i.test(m[1]!)).map(m => m[1]!.toLowerCase()),
  ]);
  const monat = new Set(MONATE.filter(m => new RegExp(`\\b${m}\\b`).test(t)).map(m => (m === 'jänner' ? 'januar' : m)));
  return { domain, kennung, monat };
}

/** Sammel-Erinnerung: mehrere nummerierte Punkte („1) … 2) …“ oder Zeilen „1. …“). */
export function istSammelErinnerung(s: string): boolean {
  return (s.match(/(?:^|\s)\d\)\s/g)?.length ?? 0) >= 2 || (s.match(/(?:^|\n)\s*\d\.\s/g)?.length ?? 0) >= 2;
}

/** Anteil des neuen Texts, der in der bestehenden Erinnerung vorkommen muss (kalibriert an 95 Erinnerungen 16.09.–17.10.). */
export const NEU_ABGEDECKT = 0.5;
const stamm = (w: string) => (w.length >= 8 ? w.slice(0, 7) : w);
const staemme = (s: string) => new Set([...inhaltsWoerter(s.replace(/https?:\/\/\S+/g, ' '))].map(stamm));

/** Art des Zustands — gleiches Gerät, anderes Problem ist ein anderer Gegenstand (Kalibrierung: Wallbox offline ≠ Wallbox Temperatur). */
const ZUSTAENDE: Array<[string, RegExp]> = [
  ['erreichbar', /\b(offline|nicht (mehr )?erreichbar|getrennt|ausgefallen|down)\b/i],
  ['temperatur', /\b(temperatur|überhitz\w*|zu heiß|°c)\b/i],
  ['batterie', /\b(batterie\w*|akku\w*|leer)\b/i],
];
const zustaende = (s: string) => new Set(ZUSTAENDE.filter(([, r]) => r.test(s)).map(([n]) => n));

function widerspruch(a: string, b: string): string | undefined {
  const ma = unterscheidendeMerkmale(a), mb = unterscheidendeMerkmale(b);
  for (const art of ['domain', 'kennung', 'monat'] as const) {
    const x = ma[art], y = mb[art];
    if (x.size && y.size && ![...x].some(v => y.has(v))) return art;
  }
  // konkrete Domain nur auf einer Seite: allgemein („Domains verlängern“) ≠ konkret („pinkribbons.club verlängern“)
  if ((ma.domain.size > 0) !== (mb.domain.size > 0)) return 'domain-einseitig';
  const za = zustaende(a), zb = zustaende(b);
  if (za.size && zb.size && ![...za].some(v => zb.has(v))) return 'zustand';
  return undefined;
}

export interface ErinnerungTreffer { id: string; text: string }

/** Die erste bestehende Erinnerung zum selben Gegenstand, sonst null. Im Zweifel null — dann wird erinnert wie bisher. */
export function gleicheErinnerung(neu: string, bestehende: Array<{ id: string; text: string }>): ErinnerungTreffer | null {
  if (!neu.trim() || istSammelErinnerung(neu)) return null;
  const kandidaten = bestehende.filter(e => e.text.trim() && !istSammelErinnerung(e.text) && !widerspruch(neu, e.text));
  const t = objektTreffer(neu, kandidaten.map(e => ({ art: 'vorgang' as const, id: e.id, titel: e.text, signatur: '' })));
  if (!t) return null;
  const e = kandidaten.find(k => k.id === t.objekt.id)!;
  // Auch der neue Text muss überwiegend abgedeckt sein (Kalibrierung: „Wallbox offline“ ≠ „Wallbox Temperatur“, Sammeltexte)
  const wn = staemme(neu), we = staemme(e.text);
  let gemeinsam = 0; for (const w of wn) if (we.has(w)) gemeinsam++;
  if (wn.size === 0 || gemeinsam / wn.size < NEU_ABGEDECKT) return null;
  return { id: e.id, text: e.text };
}

/** v1492 — dieselbe Prüfung für Vorgänge (Aktion ↔ offener Vorgang; kalibriert an 103 Aktions-Vorgängen 16.09.–17.10.). */
export const gleicherGegenstand = gleicheErinnerung;
