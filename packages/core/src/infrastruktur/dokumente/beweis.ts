// Beweis-Anhang: geschwärzter Rohlauf mit Prüfsumme (deterministisch, ohne I/O).
import { createHash } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import { schwaerze, GEHEIM_NAME } from '../../fernzugriff/kaefig.js';
import type { ChangeLauf, SchrittErgebnis } from '../change-lauf.js';
import type { ChangeSchritt } from '../change-schritte.js';
import type { Anhang, Block } from './modell.js';

const SCHLUESSEL_GEHEIM = new RegExp(`${GEHEIM_NAME.source}|ticket|cookie|authorization`, 'i');
const KUERZUNG = '\n[gekürzt — Volltext im Rohlauf]';

/** Kanonische JSON-Form: Schlüssel rekursiv sortiert, ohne Leerraum. */
export function kanonisch(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        const w = (x as Record<string, unknown>)[k];
        if (w !== undefined) o[k] = norm(w);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Tiefe Kopie, jeder String durch schwaerze(); liefert zusätzlich die Zahl der Schwärzungen. */
function schwaerzeZaehlend<T>(v: T): { wert: T; anzahl: number } {
  // alle Blätter (Text/Zahl) unterhalb eines Geheimnis-Schlüssels, Struktur bleibt
  const alle = (x: unknown): unknown => {
    if (typeof x === 'string' || typeof x === 'number') { anzahl++; return '[geschwärzt]'; }
    if (Array.isArray(x)) return x.map(alle);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, w]) => [k, alle(w)]));
    return x;
  };
  let anzahl = 0;
  const geh = (x: unknown): unknown => {
    if (typeof x === 'string') { const s = schwaerze(x); anzahl += s.anzahl; return s.text; }
    if (Array.isArray(x)) return x.map(geh);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, w] of Object.entries(x as Record<string, unknown>)) {
        // Schwärzung nach Schlüsselname: strukturierte Daten tragen Geheimnisse ohne KEY=Wert-Text
        o[k] = SCHLUESSEL_GEHEIM.test(k) ? alle(w) : geh(w);
      }
      return o;
    }
    return x;
  };
  return { wert: geh(v) as T, anzahl };
}

export function geschwaerzt<T>(v: T): T {
  return schwaerzeZaehlend(v).wert;
}

/** `2026-11-15 09:27:53 UTC (10:27:53 Wien)`; Wiener Zeit aus Intl (Sommer-/Winterzeit korrekt). */
export function zeitText(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const teile = (zone: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(t => [t.type, t.value]));
    return { datum: `${p.year}-${p.month}-${p.day}`, zeit: `${p.hour}:${p.minute}:${p.second}` };
  };
  const u = teile('UTC'); const w = teile('Europe/Vienna');
  return `${u.datum} ${u.zeit} UTC (${w.zeit} Wien)`;
}

const kuerze = (t: string, max: number) => (t.length > max ? t.slice(0, max) + KUERZUNG : t);

export function beweisAnhang(c: CmdbChangeRequest, maxAusgabe = 1500): { bloecke: Block[]; rohlauf?: Anhang; pruefsumme?: string; schwaerzungen: number } {
  const lauf = c.lauf as ChangeLauf | undefined;
  if (!lauf || !Array.isArray(lauf.ergebnisse) || lauf.ergebnisse.length === 0) {
    return { bloecke: [{ art: 'nichtBelegt', grund: 'Change ohne Lauf' }], schwaerzungen: 0 };
  }
  const l = schwaerzeZaehlend(lauf);
  const plan = schwaerzeZaehlend(((c.schritte ?? []) as ChangeSchritt[]).map(s => ({ nr: s.nr, titel: s.titel, skill: s.skill, aktion: s.aktion })));
  const planNr = new Map(plan.wert.map(s => [s.nr, s]));
  const ergebnisse: SchrittErgebnis[] = l.wert.ergebnisse;

  const zeilen = ergebnisse.map(e => {
    const p = planNr.get(e.nr);
    const aktion = p?.skill ? (p.aktion ? `${p.skill}.${p.aktion}` : p.skill) : (p?.aktion ?? '—');
    const ergebnis = e.uebersprungen ? 'übersprungen' : e.ok ? 'ok' : 'Fehler';
    const pruefung = e.pruefung ? (e.pruefung.ok ? 'ok' : 'fehlgeschlagen') : '—';
    return [String(e.nr), p?.titel ?? '—', aktion, zeitText(e.start), zeitText(e.ende), ergebnis, pruefung];
  });
  const bloecke: Block[] = [{ art: 'tabelle', kopf: ['Nr', 'Titel', 'Aktion', 'Start', 'Ende', 'Ergebnis', 'Prüfung'], zeilen }];

  for (const e of ergebnisse) {
    const teile = [e.ausgabe, e.fehler ? `Fehler: ${e.fehler}` : undefined, e.pruefung?.ausgabe ? `Prüfung: ${e.pruefung.ausgabe}` : undefined].filter((x): x is string => !!x);
    if (teile.length === 0) continue;
    // bereits geschwärzt (l.wert), erst danach kürzen — ein Geheimnis an der Schnittstelle kann so nicht halb stehen bleiben
    const titel = planNr.get(e.nr)?.titel ?? '—';
    const kopf = `Schritt ${e.nr} — ${titel.length > 120 ? titel.slice(0, 120) + '…' : titel}\n`;
    bloecke.push({ art: 'code', text: kopf + kuerze(teile.join('\n'),Math.max(0, maxAusgabe - kopf.length)) });
  }

  const inhalt = kanonisch(l.wert);
  const pruefsumme = createHash('sha256').update(inhalt, 'utf8').digest('hex');
  bloecke.push({ art: 'absatz', text: `Prüfsumme (SHA-256, geschwärzter Rohlauf): ${pruefsumme}` });
  return {
    bloecke,
    rohlauf: { name: `rohlauf-${c.id.slice(0, 8)}.json`, mime: 'application/json', inhalt },
    pruefsumme,
    schwaerzungen: l.anzahl + plan.anzahl,
  };
}

/** Erklärung zur Prüfdatei — steht im Kapitel Beweise des Dokuments, nicht in PRUEFUNG.txt. */
export const PRUEF_HINWEIS = [
  'Prüfanleitung: Die Prüfsumme belegt, dass die Datei seit der Erzeugung unverändert ist, sofern die Prüfsumme mit der in Alfreds CMDB hinterlegten übereinstimmt.',
  'Sie gilt für den geschwärzten Rohlauf zum Erzeugungszeitpunkt.',
  'Prüfen: im Ordner der Dateien `sha256sum -c PRUEFUNG.txt` ausführen; jede Datei muss „OK“ melden.',
].join(' ');

/**
 * PRUEFUNG.txt: ausschließlich Zeilen `<hex>  <name>` (Live-Beweis V1: Erklärsätze in der Datei ließen `sha256sum -c` „improperly
 * formatted“ melden — für Dritte sieht das wie ein Fehlschlag aus). Die Erklärung steht als PRUEF_HINWEIS im Dokument.
 */
export function pruefAnleitung(eintraege: Array<{ name: string; pruefsumme: string }>): Anhang {
  return { name: 'PRUEFUNG.txt', mime: 'text/plain', inhalt: eintraege.map(e => `${e.pruefsumme}  ${e.name}\n`).join('') };
}
