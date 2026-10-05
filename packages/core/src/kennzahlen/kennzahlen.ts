/**
 * Jarvis Schicht 4 — Messen & Lernen, Teil 1: die Kennzahlen.
 *
 * Die Engine zählt deterministisch an den Stellen, an denen heute nur Logzeilen
 * entstehen (Vollpass, Rundgang, Mini-Pass, Zustellweg, Gate, Aktionsausgang).
 * Ein Tagesjob schreibt die Zähler als Messwerte (quelle `kennzahl`), die
 * Lern-Telemetrie (So 19:15) summiert die Woche und rechnet die Quoten aus
 * der Spezifikation: Präzision, Erledigungsquote, Kosten je Vorgang.
 *
 * Grundsatz: alles modellunabhängig — gezählt wird, was passiert, nicht was ein
 * Modell behauptet.
 */
import type { SchrittArt } from '@alfred/storage';

export type KennzahlName =
  | 'vollpaesse' | 'rundgaenge' | 'miniPaesse'
  | 'insightsGesendet' | 'insightsAufgeschoben' | 'insightsStill'
  | 'gateTreffer' | 'gateAusgesetzt'
  | 'aktionenAusgefuehrt' | 'aktionenFehlgeschlagen' | 'aktionenBestaetigung' | 'aktionenBlockiert' | 'aktionenUebersprungen'
  | 'vorgaengeAngelegt'
  | 'miniPassDauerMs';

export const KENNZAHL_NAMEN: readonly KennzahlName[] = [
  'vollpaesse', 'rundgaenge', 'miniPaesse',
  'insightsGesendet', 'insightsAufgeschoben', 'insightsStill',
  'gateTreffer', 'gateAusgesetzt',
  'aktionenAusgefuehrt', 'aktionenFehlgeschlagen', 'aktionenBestaetigung', 'aktionenBlockiert', 'aktionenUebersprungen',
  'vorgaengeAngelegt',
  'miniPassDauerMs', // v1192 — Summe der Mini-Pass-Dauern (Ereignis → Reaktion), Ø = Summe / miniPaesse
];

/** Ausgang eines protokollierten Schritts → Kennzahl (vorgeschlagen/notiz/bestaetigt/abgelehnt zählen nicht als Engine-Ausgang). */
export const SCHRITT_ZU_KENNZAHL: Partial<Record<SchrittArt, KennzahlName>> = {
  ausgefuehrt: 'aktionenAusgefuehrt',
  fehlgeschlagen: 'aktionenFehlgeschlagen',
  zur_bestaetigung: 'aktionenBestaetigung',
  blockiert: 'aktionenBlockiert',
  uebersprungen: 'aktionenUebersprungen',
};

/** Präfix der Messwert-Entität, z. B. `kennzahl.vollpaesse`. */
export const KENNZAHL_PREFIX = 'kennzahl.';
export const KENNZAHL_QUELLE = 'kennzahl';

export class Kennzahlen {
  private readonly werte = new Map<KennzahlName, number>();
  private seitIso = new Date().toISOString();

  zaehle(name: KennzahlName | undefined, n = 1): void {
    if (!name || !Number.isFinite(n) || n <= 0) return;
    this.werte.set(name, (this.werte.get(name) ?? 0) + n);
  }

  wert(name: KennzahlName): number { return this.werte.get(name) ?? 0; }

  /** Alle Zähler (fehlende als 0) plus Beginn des Zählfensters. */
  snapshot(): { seit: string; werte: Record<KennzahlName, number> } {
    const werte = {} as Record<KennzahlName, number>;
    for (const n of KENNZAHL_NAMEN) werte[n] = this.werte.get(n) ?? 0;
    return { seit: this.seitIso, werte };
  }

  /** v1203 — Zwischenstand nach Neustart übernehmen (Realfall 05.10.: 8 Deploys → Tageszähler 0). */
  laden(snapshot: { seit: string; werte: Partial<Record<KennzahlName, number>> }): void {
    this.werte.clear();
    for (const [k, v] of Object.entries(snapshot.werte)) if (KENNZAHL_NAMEN.includes(k as KennzahlName) && typeof v === 'number' && v > 0) this.werte.set(k as KennzahlName, v);
    this.seitIso = snapshot.seit;
  }

  /** Nach dem Tagesabschluss: Zähler auf 0, neues Fenster. */
  reset(now = new Date()): void {
    this.werte.clear();
    this.seitIso = now.toISOString();
  }
}

/** Rohdaten für die Quoten — aus DB-Zählungen, nicht aus dem Modell. */
export interface QuotenEingabe {
  /** Insights, auf die der Owner reagiert hat (acted). */
  insightsReagiert: number;
  /** Insights, die der Owner verworfen hat (dismissed). */
  insightsVerworfen: number;
  /** Insights, die ohne Reaktion abgelaufen sind (expired). */
  insightsAbgelaufen: number;
  vorgaengeAngelegt: number;
  vorgaengeErledigt: number;
  kostenUsd: number;
}

export interface Quoten {
  /** reagiert / (reagiert + verworfen + abgelaufen), 0..1; undefined ohne Grundgesamtheit. */
  praezision?: number;
  /** erledigt / angelegt, 0..1; undefined ohne angelegte Vorgänge. */
  erledigungsquote?: number;
  /** Kosten je angelegtem Vorgang in USD; undefined ohne Vorgänge. */
  kostenJeVorgangUsd?: number;
}

export function berechneQuoten(e: QuotenEingabe): Quoten {
  const grund = e.insightsReagiert + e.insightsVerworfen + e.insightsAbgelaufen;
  const q: Quoten = {};
  if (grund > 0) q.praezision = e.insightsReagiert / grund;
  if (e.vorgaengeAngelegt > 0) {
    q.erledigungsquote = Math.min(1, e.vorgaengeErledigt / e.vorgaengeAngelegt);
    q.kostenJeVorgangUsd = e.kostenUsd / e.vorgaengeAngelegt;
  }
  return q;
}

function prozent(x?: number): string { return x === undefined ? '–' : `${Math.round(x * 100)} %`; }

/**
 * Zeilen für die Lern-Telemetrie. `summen` sind Tages-Messwerte über den
 * Zeitraum summiert (Schlüssel = Kennzahl-Name ohne Präfix).
 */
export function formatiereKennzahlen(summen: Partial<Record<KennzahlName, number>>, quoten: Quoten, tage: number, kostenUsd?: number): string[] {
  const s = (n: KennzahlName) => Math.round(summen[n] ?? 0);
  const paesse = s('vollpaesse') + s('rundgaenge') + s('miniPaesse');
  const anteilMini = paesse > 0 ? s('miniPaesse') / paesse : undefined;
  // v1192 — Spezifikation Schicht 2: Latenz Ereignis → Reaktion (Ø Mini-Pass-Dauer) und Kosten je Pass
  const dauerMini = s('miniPaesse') > 0 && s('miniPassDauerMs') > 0 ? ` · Ø Mini-Pass ${(s('miniPassDauerMs') / s('miniPaesse') / 1000).toFixed(1)} s` : '';
  const kostenJeVollpass = kostenUsd !== undefined && s('vollpaesse') > 0 ? ` · Kosten je Vollpass $${(kostenUsd / s('vollpaesse')).toFixed(3)}` : '';
  const aktionen = s('aktionenAusgefuehrt') + s('aktionenFehlgeschlagen') + s('aktionenBestaetigung') + s('aktionenBlockiert') + s('aktionenUebersprungen');
  return [
    `Jarvis-Kennzahlen (${tage} Tage): ${s('vollpaesse')} Vollpässe, ${s('rundgaenge')} Rundgänge ohne LLM, ${s('miniPaesse')} Mini-Pässe (Anteil ${prozent(anteilMini)})${dauerMini}${kostenJeVollpass}`,
    `Insights: ${s('insightsGesendet')} gesendet, ${s('insightsAufgeschoben')} aufgeschoben, ${s('insightsStill')} still · Präzision ${prozent(quoten.praezision)}`,
    `Gate: ${s('gateTreffer')} Treffer, ${s('gateAusgesetzt')} durch Weltmodell ausgesetzt`,
    `Aktionen: ${aktionen} gesamt — ${s('aktionenAusgefuehrt')} ausgeführt, ${s('aktionenFehlgeschlagen')} fehlgeschlagen, ${s('aktionenBestaetigung')} zur Bestätigung, ${s('aktionenBlockiert')} blockiert, ${s('aktionenUebersprungen')} übersprungen`,
    `Vorgänge: ${s('vorgaengeAngelegt')} angelegt · Erledigungsquote ${prozent(quoten.erledigungsquote)} · Kosten je Vorgang ${quoten.kostenJeVorgangUsd === undefined ? '–' : `$${quoten.kostenJeVorgangUsd.toFixed(2)}`}`,
  ];
}

export interface KategorieErledigung { kategorie: string; angelegt: number; erledigt: number; verworfen: number; offen: number }

/** Unter dieser Erledigungsquote gilt eine Kategorie als Kandidat für den Digest-Modus (Schicht 4, Konsequenz später). */
export const DIGEST_KANDIDAT_QUOTE = 0.25;
/** Erst ab so vielen abgeschlossenen Vorgängen ist die Quote aussagekräftig. */
export const DIGEST_KANDIDAT_MIN_ABGESCHLOSSEN = 4;

/**
 * v1186 — Erledigungsquote je Kategorie. Quote = erledigt / (erledigt + verworfen);
 * offene zählen nicht (noch keine Entscheidung). Kandidaten werden NUR markiert
 * (beobachtend) — die Konsequenz braucht die Freigabe des Owners.
 */
export function formatiereErledigungJeKategorie(rows: KategorieErledigung[], tage: number): string[] {
  if (rows.length === 0) return [];
  const zeilen = [`Erledigung je Kategorie (${tage} Tage, erledigt/verworfen/offen):`];
  for (const r of rows) {
    const abgeschlossen = r.erledigt + r.verworfen;
    const quote = abgeschlossen > 0 ? r.erledigt / abgeschlossen : undefined;
    const kandidat = quote !== undefined && abgeschlossen >= DIGEST_KANDIDAT_MIN_ABGESCHLOSSEN && quote < DIGEST_KANDIDAT_QUOTE;
    zeilen.push(`- ${r.kategorie}: ${r.erledigt}/${r.verworfen}/${r.offen}${quote === undefined ? '' : ` · Quote ${Math.round(quote * 100)} %`}${kandidat ? ' → Kandidat Digest-Modus' : ''}`);
  }
  return zeilen;
}

/** Messwert-Zeilen (entity → wert) aus Summen je Kennzahl aufbauen. */
export function summiereKennzahlMesswerte(rows: Array<{ entity: string; wert?: number }>): Partial<Record<KennzahlName, number>> {
  const out: Partial<Record<KennzahlName, number>> = {};
  for (const r of rows) {
    if (!r.entity.startsWith(KENNZAHL_PREFIX)) continue;
    const name = r.entity.slice(KENNZAHL_PREFIX.length) as KennzahlName;
    if (!KENNZAHL_NAMEN.includes(name)) continue;
    out[name] = (out[name] ?? 0) + (r.wert ?? 0);
  }
  return out;
}
