/**
 * v1520 — Ablage fürs Handy, solange die App im Hintergrund ist: Alfred legt hier ab, das Handy bekommt einen Push ohne Inhalt
 * und holt beim Antippen oder Öffnen über die geprüfte Verbindung ab.
 * - Text (Zwischenablage): nur im Arbeitsspeicher, 24 h, vertraulich 30 min, je Gerät höchstens 5.
 * - v1521 Datei (`datei_ablegen`): nur der Verweis auf den Dateispeicher (quelle), nie der Inhalt; 24 h, je Gerät höchstens 10.
 * Ein Neustart leert die Ablage (die Dateien selbst bleiben im Dateispeicher).
 */
import { randomUUID } from 'node:crypto';

export interface AblageDatei { quelle: string; name: string; ordner?: string; groesse?: number }
export interface AblageEintrag { id: string; geraetId: string; art: 'text' | 'datei'; text: string; vertraulich: boolean; zeit: number; datei?: AblageDatei }

export const ABLAGE_JE_GERAET = 5;
export const ABLAGE_DATEIEN_JE_GERAET = 10;
export const ABLAGE_GUELTIG_MS = 24 * 3600_000;
export const ABLAGE_VERTRAULICH_MS = 30 * 60_000;

export class HandyAblage {
  private eintraege = new Map<string, AblageEintrag>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private aufraeumen(): void {
    const jetzt = this.now();
    for (const [id, e] of this.eintraege) if (jetzt - e.zeit > (e.vertraulich ? ABLAGE_VERTRAULICH_MS : ABLAGE_GUELTIG_MS)) this.eintraege.delete(id);
  }

  private begrenze(geraetId: string, art: AblageEintrag['art'], max: number): void {
    const eigene = [...this.eintraege.values()].filter(x => x.geraetId === geraetId && x.art === art).sort((a, b) => a.zeit - b.zeit);
    for (const alt of eigene.slice(0, Math.max(0, eigene.length - max))) this.eintraege.delete(alt.id);
  }

  lege(geraetId: string, text: string, vertraulich: boolean): AblageEintrag {
    this.aufraeumen();
    const e: AblageEintrag = { id: randomUUID(), geraetId, art: 'text', text, vertraulich, zeit: this.now() };
    this.eintraege.set(e.id, e);
    this.begrenze(geraetId, 'text', ABLAGE_JE_GERAET);
    return e;
  }

  /** v1521 — Datei zum Ablegen auf dem Handy vormerken (nur Verweis). */
  legeDatei(geraetId: string, datei: AblageDatei): AblageEintrag {
    this.aufraeumen();
    const e: AblageEintrag = { id: randomUUID(), geraetId, art: 'datei', text: '', vertraulich: false, zeit: this.now(), datei };
    this.eintraege.set(e.id, e);
    this.begrenze(geraetId, 'datei', ABLAGE_DATEIEN_JE_GERAET);
    return e;
  }

  /** Offene Einträge des Geräts, neuester zuerst. */
  offene(geraetId: string): AblageEintrag[] {
    this.aufraeumen();
    return [...this.eintraege.values()].filter(e => e.geraetId === geraetId).sort((a, b) => b.zeit - a.zeit);
  }

  hole(geraetId: string, id: string): AblageEintrag | undefined {
    this.aufraeumen();
    const e = this.eintraege.get(id);
    return e && e.geraetId === geraetId ? e : undefined;
  }

  /** Abgeholt: Eintrag entfernen (nur der eigene). */
  erledige(geraetId: string, id: string): boolean {
    const e = this.eintraege.get(id);
    if (!e || e.geraetId !== geraetId) return false;
    this.eintraege.delete(id);
    return true;
  }
}
