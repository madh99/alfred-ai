/**
 * v1372 — Nachforschen N1/N2 beobachtend: ein Lauf je Befund nach seiner Haltefrist (Owner 12.10. „wie empfohlen").
 * Sammeln ohne Modell (Rezeptschritte, Lese-Katalog bei jedem Aufruf erneut geprüft), eine Deutung (Stufe fast, ohne
 * Werkzeuge), Gegenprobe. Budget: 10 Läufe oder 0,50 USD am Tag; Zeitlimit 60 s; Meldungen bleiben unverändert.
 */
import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import { calculateCost } from '@alfred/llm';
import { rezeptFuer, platzhalterAus, fuelleParams, pruefeRezept, pruefeSchritt, type BefundKurz, type Rezept } from './rezepte.js';
import { belegblock, deutungsPrompt, pruefeDeutung, type Untersuchung } from './deutung.js';

export const BUDGET = { laeufeJeTag: 10, usdJeTag: 0.5, zeitlimitMs: 60_000 };

export interface LaufErgebnis {
  befund: BefundKurz;
  rezept: string | null;
  status: 'untersucht' | 'kein_rezept' | 'rezept_ungueltig' | 'budget' | 'deutung_ungueltig' | 'fehler';
  untersuchung?: Untersuchung;
  belegZeilen?: number;
  gestrichen?: number;
  kostenUsd?: number;
  dauerMs?: number;
  fehler?: string;
}

export interface NachforscherDeps {
  /** Leseaufruf eines Skills; Rückgabe = Text (display) — Fehler werfen. */
  lese: (werkzeug: string, aktion: string, params: Record<string, unknown>) => Promise<string>;
  llm: Pick<LLMProvider, 'complete'>;
  logger: Logger;
  jetzt?: () => number;
  /** v1380 — feste Platzhalter (z. B. {ort} = Wohnort des Owners für das Wetter) */
  standardPlatz?: () => Record<string, string>;
}

export class Nachforscher {
  private tag = '';
  private laeufe = 0;
  private usd = 0;
  constructor(private readonly d: NachforscherDeps) {}

  private budgetFrei(): boolean {
    const heute = new Date(this.d.jetzt?.() ?? Date.now()).toISOString().slice(0, 10);
    if (heute !== this.tag) { this.tag = heute; this.laeufe = 0; this.usd = 0; }
    return this.laeufe < BUDGET.laeufeJeTag && this.usd < BUDGET.usdJeTag;
  }

  async untersuche(b: BefundKurz, rezepte?: Rezept[]): Promise<LaufErgebnis> {
    const r = rezeptFuer(b, rezepte);
    if (!r) return { befund: b, rezept: null, status: 'kein_rezept' };
    const platz = { ...(this.d.standardPlatz?.() ?? {}), ...platzhalterAus(b) };
    const fehler = pruefeRezept(r, platz);
    if (fehler.length) return { befund: b, rezept: r.id, status: 'rezept_ungueltig', fehler: fehler.join('; ') };
    if (!this.budgetFrei()) return { befund: b, rezept: r.id, status: 'budget' };
    this.laeufe++;
    const start = this.d.jetzt?.() ?? Date.now();
    try {
      const ergebnisse: Array<{ zweck: string; text: string }> = [];
      for (const s of r.schritte) {
        if ((this.d.jetzt?.() ?? Date.now()) - start > BUDGET.zeitlimitMs) { ergebnisse.push({ zweck: s.zweck, text: '(Zeitlimit — nicht gelesen)' }); continue; }
        const { params } = fuelleParams(s.params, platz);
        const verboten = pruefeSchritt(s.werkzeug, s.aktion, params); // Positivliste bei jedem Aufruf
        if (verboten) { ergebnisse.push({ zweck: s.zweck, text: `(nicht erlaubt: ${verboten})` }); continue; }
        try {
          ergebnisse.push({ zweck: s.zweck, text: await this.d.lese(s.werkzeug, s.aktion, { action: s.aktion, ...params }) });
        } catch (err) {
          ergebnisse.push({ zweck: s.zweck, text: `(Lesen fehlgeschlagen: ${(err as Error).message.slice(0, 160)})` });
        }
      }
      const block = belegblock(ergebnisse);
      const antwort = await this.d.llm.complete({ messages: [{ role: 'user', content: deutungsPrompt(b, r, block.text) }], maxTokens: 2000, tier: 'fast' });
      const kosten = antwort.model ? calculateCost(antwort.model, antwort.usage) : 0;
      this.usd += kosten;
      const g = pruefeDeutung(antwort.content ?? '', r, block.zeilen);
      const dauerMs = (this.d.jetzt?.() ?? Date.now()) - start;
      if (!g) return { befund: b, rezept: r.id, status: 'deutung_ungueltig', belegZeilen: block.zeilen.size, kostenUsd: kosten, dauerMs, fehler: antwort.stopReason === 'max_tokens' ? 'Antwort am Token-Limit abgeschnitten' : 'kein gültiges JSON' };
      return { befund: b, rezept: r.id, status: 'untersucht', untersuchung: g.u, belegZeilen: block.zeilen.size, gestrichen: g.gestrichen, kostenUsd: kosten, dauerMs };
    } catch (err) {
      return { befund: b, rezept: r.id, status: 'fehler', fehler: (err as Error).message.slice(0, 200), dauerMs: (this.d.jetzt?.() ?? Date.now()) - start };
    }
  }
}
