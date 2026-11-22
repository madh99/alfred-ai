/**
 * Spec Stufe ultra U2.3 — Eskalation nach objektivem Fehlschlag. Die nächste Antwort im selben Faden läuft auf ultra, wenn
 *   - die Planprüfung einen Planentwurf (changes_planen / change_aendern) zweimal in Folge abgelehnt hat,
 *   - der Owner einen Einwand zu einem Change oder Vorhaben erhoben hat (Befunde der Gegenprüfung durch ultra zählen nicht),
 *   - die Nachricht einen angehaltenen Change über seine ID anspricht (Korrektur ab dem Haltepunkt), außer bei den festen
 *     Steuerbefehlen (wiederholen, abbrechen, überspringen, Rückweg).
 * Die Stufe gilt, bis ein Entwurf gespeichert ist oder der Owner selbst eine Stufe wählt; spätestens nach GUELTIG_MS.
 * Deterministisch: kein Modell entscheidet, ob eskaliert wird (Architektur-Grundsatz).
 */

export type EskalationsGrund = 'einwand' | 'planpruefung' | `korrektur:${string}`;

export const ESKALATION_GUELTIG_MS = 6 * 3_600_000;
const STEUERBEFEHL = /(wiederhol|abbrech|überspring|ueberspring|rückweg ausführen|rueckweg ausfuehren|verwerf)/i;

export function eskalationsText(grund: EskalationsGrund): string {
  if (grund === 'einwand') return 'du einen Einwand erhoben hast';
  if (grund === 'planpruefung') return 'die Planprüfung den Entwurf zweimal in Folge abgelehnt hat';
  return `Change ${grund.slice('korrektur:'.length)} angehalten ist und korrigiert wird`;
}

export function eskalationsZeile(grund: EskalationsGrund): string {
  return `↗ Auf ultra gewechselt, weil ${eskalationsText(grund)}.`;
}

/** Spricht der Text einen der angehaltenen Changes (IDs) an, ohne ein fester Steuerbefehl zu sein? → dessen ID8 */
export function korrekturZiel(text: string, angehalten: string[]): string | undefined {
  if (!text || STEUERBEFEHL.test(text)) return undefined;
  const t = text.toLowerCase();
  for (const id of angehalten) { const k = id.slice(0, 8).toLowerCase(); if (k.length === 8 && t.includes(k)) return k; }
  return undefined;
}

export class UltraEskalation {
  private aktivJe = new Map<string, { grund: EskalationsGrund; seit: number }>();
  private fehlschlaege = new Map<string, number>();
  constructor(private readonly jetzt: () => number = Date.now) {}

  /** Auslöser setzen (gilt für die nächste Antwort in [chatId] und danach bis zum Ende). */
  setze(chatId: string, grund: EskalationsGrund): void {
    if (!chatId) return;
    this.aktivJe.set(chatId, { grund, seit: this.jetzt() });
  }

  /** Planentwurf abgelehnt; beim zweiten Mal in Folge → Eskalation. Liefert true, wenn jetzt eskaliert wurde. */
  planAbgelehnt(chatId: string): boolean {
    if (!chatId) return false;
    const n = (this.fehlschlaege.get(chatId) ?? 0) + 1;
    this.fehlschlaege.set(chatId, n);
    if (n >= 2 && !this.aktivJe.has(chatId)) { this.setze(chatId, 'planpruefung'); return true; }
    return false;
  }

  /** Entwurf gespeichert → Zähler zurück, Eskalation beendet. */
  planGespeichert(chatId: string): void {
    this.fehlschlaege.delete(chatId);
    this.aktivJe.delete(chatId);
  }

  /** Owner hat ausdrücklich eine Stufe gewählt → Eskalation endet. */
  beende(chatId: string): void { this.aktivJe.delete(chatId); }

  aktiv(chatId: string): EskalationsGrund | undefined {
    const e = this.aktivJe.get(chatId);
    if (!e) return undefined;
    if (this.jetzt() - e.seit > ESKALATION_GUELTIG_MS) { this.aktivJe.delete(chatId); return undefined; }
    return e.grund;
  }
}
