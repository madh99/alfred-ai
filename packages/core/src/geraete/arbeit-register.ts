/**
 * v1975 — Owner 28.11.: „warum sieht man weder in der App noch im Web, was Alfred gerade macht?“
 * Die Ereignisse des Arbeits-Melders (v1354) gingen nur an verbundene Geräte; wer später öffnete (oder das Web) sah nichts.
 * Das Register hält die laufenden Anfragen der Owner-Gespräche, damit App und Web den Stand jederzeit abfragen können
 * (`GET /api/geraete/arbeit`, `GET /api/gespraeche/arbeit`). Nur im Speicher; ein Neustart beendet ohnehin alle Läufe.
 */
import type { ArbeitsEreignis } from './arbeits-melder.js';

export interface LaufendeArbeit {
  arbeit: string;
  faden: string | null;
  /** anfragender Kanal-Chat (die App blendet ihre eigenen Anfragen aus) */
  von: string;
  kanal: string;
  frage: string;
  seit: string;
  status?: string;
  modell?: string;
  kostenUsd?: number;
  runde?: number;
  /** letztes Lebenszeichen (ISO) */
  zuletzt: string;
}

/** Läufe ohne Lebenszeichen länger als das gelten als verwaist (Ende verpasst) — großzügig: ein Modellaufruf am Ausgabelimit dauert Minuten. */
export const ARBEIT_VERWAIST_MS = 45 * 60_000;

export class ArbeitRegister {
  private readonly laufend = new Map<string, LaufendeArbeit>();
  constructor(private readonly jetzt: () => number = Date.now) {}

  anwenden(e: ArbeitsEreignis, kanal: string): void {
    const zuletzt = new Date(this.jetzt()).toISOString();
    if (e.phase === 'ende') { this.laufend.delete(e.arbeit); return; }
    const alt = this.laufend.get(e.arbeit);
    if (e.phase === 'start' || !alt) {
      this.laufend.set(e.arbeit, { arbeit: e.arbeit, faden: e.faden, von: e.von.chatId, kanal, frage: (e.frage ?? alt?.frage ?? '').slice(0, 300), seit: e.seit ?? alt?.seit ?? zuletzt, zuletzt });
      if (e.phase === 'start') return;
    }
    const a = this.laufend.get(e.arbeit)!;
    if (e.text) a.status = e.text;
    if (e.modell) a.modell = e.modell;
    if (typeof e.kostenUsd === 'number') a.kostenUsd = e.kostenUsd;
    if (typeof e.runde === 'number') a.runde = e.runde;
    a.zuletzt = zuletzt;
  }

  liste(): LaufendeArbeit[] {
    const grenze = this.jetzt() - ARBEIT_VERWAIST_MS;
    for (const [id, a] of this.laufend) if (Date.parse(a.zuletzt) < grenze) this.laufend.delete(id);
    return [...this.laufend.values()].sort((x, y) => x.seit.localeCompare(y.seit)).map(a => ({ ...a }));
  }
}
