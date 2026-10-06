/**
 * v1220 — Jarvis Schicht 3, Teil 3: die Lage als Delta.
 *
 * Kein Schlüsselwort, keine Schablone: Die Lage ist ein Datenblock aus Befunden (Identität,
 * Dauer, Zähler) und Vorgängen (offen je Kategorie, älteste, neu und erledigt in 24 h), der im
 * Weltmodell-Block des Chat-Prompts steht. Das Modell formuliert frei, hat aber nur belegte
 * Objekte vor sich — „E-Mail-Skill deaktiviert" oder „BMW funktioniert wieder" können daraus
 * nicht entstehen, weil es dafür keinen Befund gibt. Rein, deterministisch, testbar.
 */
import { quelleZuKategorie } from '../ereignisse/befunde.js';

export interface LageBefund { quelle: string; gegenstand: string; titel: string; entstanden: string; erledigtAm?: string; gesehenAnzahl: number }
export interface LageVorgang { titel: string; kategorie?: string; status: string; erstellt: string; aktualisiert: string; frist?: string; ergebnis?: string }

export interface LageEingang {
  befundeOffen: LageBefund[];
  befundeErledigt24h: LageBefund[];
  vorgaengeOffen: LageVorgang[];
  vorgaengeAbgeschlossen24h: LageVorgang[];
}

export const LAGE_MAX_BEFUNDE = 6;
export const LAGE_MAX_ZEICHEN = 1100;

function zeit(iso: string, now: Date): string {
  const d = new Date(iso);
  const heute = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  if (heute) return `seit ${hm}`;
  const gestern = new Date(now.getTime() - 86_400_000).toDateString() === d.toDateString();
  if (gestern) return `seit gestern ${hm}`;
  return `seit ${d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })}`;
}

function kurzDatum(iso: string): string {
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
}

export function formatiereLage(e: LageEingang, now: Date = new Date()): string {
  const stand = now.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  const zeilen: string[] = [`### Lage (Befunde und Vorgänge, Stand ${stand})`];

  const offen = [...e.befundeOffen].sort((a, b) => a.entstanden.localeCompare(b.entstanden));
  if (offen.length === 0) {
    zeilen.push('Offene Befunde: keine — das Weltmodell führt derzeit nichts als auffällig.');
  } else {
    const teile = offen.slice(0, LAGE_MAX_BEFUNDE).map(b => `[${quelleZuKategorie(b.quelle)}] ${b.titel} — ${zeit(b.entstanden, now)}, ${b.gesehenAnzahl}× gesehen`);
    const rest = offen.length - teile.length;
    zeilen.push(`Offene Befunde (${offen.length}): ${teile.join(' · ')}${rest > 0 ? ` · … und ${rest} weitere` : ''}`);
  }
  if (e.befundeErledigt24h.length > 0) {
    zeilen.push(`Seit 24 h von selbst erledigt (${e.befundeErledigt24h.length}): ${e.befundeErledigt24h.slice(0, 4).map(b => `[${quelleZuKategorie(b.quelle)}] ${b.titel}`).join(' · ')}`);
  }

  const vo = e.vorgaengeOffen;
  if (vo.length === 0) {
    zeilen.push('Offene Vorgänge: keine.');
  } else {
    const jeKat = new Map<string, number>();
    for (const v of vo) jeKat.set(v.kategorie ?? 'sonstiges', (jeKat.get(v.kategorie ?? 'sonstiges') ?? 0) + 1);
    const kats = [...jeKat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
    const aelteste = [...vo].sort((a, b) => a.erstellt.localeCompare(b.erstellt))[0];
    const wartet = vo.filter(v => v.status === 'wartet').length;
    zeilen.push(`Offene Vorgänge: ${vo.length} (${kats})${wartet ? `, davon ${wartet} warten auf dich` : ''}; älteste: „${aelteste.titel.slice(0, 80)}" (seit ${kurzDatum(aelteste.erstellt)}${aelteste.frist ? `, Frist ${kurzDatum(aelteste.frist)}` : ''})`);
  }
  const seit24 = new Date(now.getTime() - 86_400_000).toISOString();
  const neu24 = vo.filter(v => v.erstellt >= seit24).length;
  const erledigt = e.vorgaengeAbgeschlossen24h.filter(v => v.status === 'erledigt').length;
  const verworfen = e.vorgaengeAbgeschlossen24h.filter(v => v.status === 'verworfen').length;
  zeilen.push(`Letzte 24 h: ${neu24} neue Vorgänge, ${erledigt} erledigt, ${verworfen} verworfen.`);
  zeilen.push('Hinweis: Das ist der belegte Stand. Was hier nicht steht, ist nicht bekannt — nichts erfinden; für Details ein Werkzeug nutzen.');

  const text = zeilen.join('\n');
  return text.length > LAGE_MAX_ZEICHEN ? `${text.slice(0, LAGE_MAX_ZEICHEN).trimEnd()}…` : text;
}
