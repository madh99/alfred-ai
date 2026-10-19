/**
 * v1520 — Zwischenablage fürs Handy, solange die App im Hintergrund ist: Alfred legt den Text hier ab, das Handy bekommt
 * einen Push „Zum Kopieren antippen“ (ohne Inhalt) und holt ihn beim Antippen oder Öffnen über die geprüfte Verbindung.
 * Nur im Arbeitsspeicher — nichts davon landet auf der Platte (die Zwischenablage enthält oft Vertrauliches); ein Neustart
 * leert die Ablage. Je Gerät höchstens 5 Einträge; normal 24 h gültig, vertrauliche 30 min.
 */
import { randomUUID } from 'node:crypto';

export interface AblageEintrag { id: string; geraetId: string; text: string; vertraulich: boolean; zeit: number }

export const ABLAGE_JE_GERAET = 5;
export const ABLAGE_GUELTIG_MS = 24 * 3600_000;
export const ABLAGE_VERTRAULICH_MS = 30 * 60_000;

export class HandyAblage {
  private eintraege = new Map<string, AblageEintrag>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private aufraeumen(): void {
    const jetzt = this.now();
    for (const [id, e] of this.eintraege) if (jetzt - e.zeit > (e.vertraulich ? ABLAGE_VERTRAULICH_MS : ABLAGE_GUELTIG_MS)) this.eintraege.delete(id);
  }

  lege(geraetId: string, text: string, vertraulich: boolean): AblageEintrag {
    this.aufraeumen();
    const e: AblageEintrag = { id: randomUUID(), geraetId, text, vertraulich, zeit: this.now() };
    this.eintraege.set(e.id, e);
    const eigene = [...this.eintraege.values()].filter(x => x.geraetId === geraetId).sort((a, b) => a.zeit - b.zeit);
    for (const alt of eigene.slice(0, Math.max(0, eigene.length - ABLAGE_JE_GERAET))) this.eintraege.delete(alt.id);
    return e;
  }

  /** Offene Einträge des Geräts, neuester zuerst. */
  offene(geraetId: string): AblageEintrag[] {
    this.aufraeumen();
    return [...this.eintraege.values()].filter(e => e.geraetId === geraetId).sort((a, b) => b.zeit - a.zeit);
  }

  /** Abgeholt: Eintrag entfernen (nur der eigene). */
  erledige(geraetId: string, id: string): boolean {
    const e = this.eintraege.get(id);
    if (!e || e.geraetId !== geraetId) return false;
    this.eintraege.delete(id);
    return true;
  }
}
