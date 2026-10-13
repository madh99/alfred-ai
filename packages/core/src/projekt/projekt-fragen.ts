import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * v1432 — Frage zum Projekt im Projektfaden (Realfall 13.10. 18:08/18:14: Alfred schrieb eine eigene Antwort, eine Minute später kam
 * die Rohantwort von Claude Code als zweite Nachricht). Jetzt: Alfred schaut zuerst in eigene Daten (Etappenberichte, Commits, frühere
 * Antworten), fragt sonst Claude Code und WARTET auf die Antwort (≤ 2 min), bevor er antwortet. Folgefragen laufen in derselben
 * Claude-Code-Sitzung weiter (nur lesend), solange sie jünger als 24 h ist und kein Lauf seither am Code gearbeitet hat.
 */
export interface FrageAntwort { zeit: number; frage: string; antwort: string; kosten?: number }
interface Eintrag { sitzung?: string; sitzungSeit?: number; antworten: FrageAntwort[] }

export const SITZUNG_MAX_MS = 24 * 3_600_000;
const MAX_ANTWORTEN = 5;

export class ProjektFragen {
  private readonly eintraege: Map<string, Eintrag>;

  constructor(private readonly datei?: string, private readonly now: () => number = Date.now) {
    let roh: Record<string, Eintrag> = {};
    if (datei) { try { roh = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, Eintrag>; } catch { /* neu */ } }
    this.eintraege = new Map(Object.entries(roh).filter(([, e]) => e && Array.isArray(e.antworten)));
  }

  /** Sitzung für eine Folgefrage — nur wenn jünger als 24 h und seit ihrem Beginn kein Lauf am Projekt gearbeitet hat. */
  sitzungFuer(akteId: string, letzteLaufAktivitaet?: number): string | undefined {
    const e = this.eintraege.get(akteId);
    if (!e?.sitzung || e.sitzungSeit === undefined) return undefined;
    if (this.now() - e.sitzungSeit > SITZUNG_MAX_MS) return undefined;
    if (letzteLaufAktivitaet !== undefined && letzteLaufAktivitaet > e.sitzungSeit) return undefined;
    return e.sitzung;
  }

  /** Antwort merken; `fortgesetzt` = die Frage lief in der gemerkten Sitzung (deren Beginn zählt weiter für die 24 h). */
  merke(akteId: string, a: { frage: string; antwort: string; kosten?: number; sitzung?: string; fortgesetzt: boolean }): void {
    const e = this.eintraege.get(akteId) ?? { antworten: [] };
    if (a.sitzung) { if (!a.fortgesetzt || e.sitzungSeit === undefined) e.sitzungSeit = this.now(); e.sitzung = a.sitzung; }
    e.antworten = [...e.antworten, { zeit: this.now(), frage: a.frage.slice(0, 500), antwort: a.antwort.slice(0, 3000), ...(a.kosten !== undefined ? { kosten: a.kosten } : {}) }].slice(-MAX_ANTWORTEN);
    this.eintraege.set(akteId, e);
    this.sichere();
  }

  vergissSitzung(akteId: string): void {
    const e = this.eintraege.get(akteId);
    if (!e?.sitzung) return;
    delete e.sitzung; delete e.sitzungSeit;
    this.sichere();
  }

  antworten(akteId: string): FrageAntwort[] { return [...(this.eintraege.get(akteId)?.antworten ?? [])]; }

  private sichere(): void {
    if (!this.datei) return;
    try { mkdirSync(dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify(Object.fromEntries(this.eintraege)), { mode: 0o600 }); } catch { /* Ablage optional */ }
  }
}

/** Wartende Fragen: das Ende-Ereignis des Auftrags erfüllt das Warten (und wird dann nicht noch einmal gemeldet). */
export class FrageWarten<T> {
  private readonly wartende = new Map<string, (e: T | undefined) => void>();

  warte(auftragId: string, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wartende.delete(auftragId); resolve(undefined); }, ms);
      this.wartende.set(auftragId, (e) => { clearTimeout(t); this.wartende.delete(auftragId); resolve(e); });
    });
  }

  /** true = jemand wartete darauf; das Ereignis ist damit verbraucht. */
  erfuelle(auftragId: string, e: T): boolean {
    const w = this.wartende.get(auftragId);
    if (!w) return false;
    w(e);
    return true;
  }
}

interface LaufFuerWissen {
  id: string; ziel: string; status: string; start: number; aktualisiert: number;
  erledigt: Array<{ nr: number; etappe: string; ok: boolean; zusammenfassung?: string; text?: string; dateien?: string[]; dateienAnzahl?: number; commit?: { sha: string; titel: string } }>;
}

const datum = (ms: number): string => new Date(ms).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const kurz = (t: string, n: number): string => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** Eigene Daten zum Projekt für den Faden-Kontext: letzte Läufe mit Etappenberichten und Commits, frühere Antworten von Claude Code. */
export function projektWissen(laeufe: LaufFuerWissen[], antworten: FrageAntwort[], max = 7000): string | undefined {
  const z: string[] = [];
  for (const l of [...laeufe].sort((a, b) => b.start - a.start).slice(0, 2)) {
    if (!l.erledigt.length) continue;
    z.push(`Lauf ${l.id} (${l.status}, ${datum(l.aktualisiert)}): ${kurz(l.ziel, 160)}`);
    for (const e of l.erledigt.slice(-6)) {
      const dateien = e.dateien?.length ? ` — Dateien: ${e.dateien.slice(0, 8).join(', ')}${(e.dateienAnzahl ?? e.dateien.length) > 8 ? ` (+${(e.dateienAnzahl ?? e.dateien.length) - 8})` : ''}` : '';
      z.push(`- Etappe ${e.nr} ${e.ok ? '✅' : '❌'} ${kurz(e.etappe, 100)}${e.commit ? ` — Commit ${e.commit.sha.slice(0, 7)} „${kurz(e.commit.titel, 80)}“` : ''}${dateien}`);
      const bericht = e.zusammenfassung ?? e.text;
      if (bericht) z.push(`  Bericht: ${kurz(bericht, 600)}`);
    }
  }
  if (antworten.length) {
    z.push('Frühere Antworten von Claude Code auf Fragen (nur lesend):');
    for (const a of antworten.slice(-3)) z.push(`- ${datum(a.zeit)} Frage: ${kurz(a.frage, 160)}\n  Antwort: ${kurz(a.antwort, 900)}`);
  }
  if (!z.length) return undefined;
  const text = z.join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Quellenzeile unter Alfreds Antwort (Beleg, wer nachgesehen hat). */
export function quelleZeile(geraet: string, kosten?: number, fortgesetzt?: boolean): string {
  return `Quelle: Claude Code auf ${geraet}, nur lesend${kosten !== undefined ? `, ${kosten.toFixed(2).replace('.', ',')} $` : ''}${fortgesetzt ? ', Folgefrage in derselben Sitzung' : ''}`;
}
