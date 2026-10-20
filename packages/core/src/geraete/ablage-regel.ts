import { imVerzeichnis } from './vertrauen.js';

/**
 * v1529 (Owner 20.10.: „a und b zusammen, Downloads als Standard, aber auch zusätzliche oder andere einstellbar“) —
 * Realfall 11:07: vier Fotos vom iPhone sollten in die Downloads am PC, jedes kam mit eigener Bestätigung.
 *
 * B — ohne Rückfrage nur, wenn alles zutrifft (feste Regeln, kein Modell-Urteil):
 *  1. die Quelle ist ein **eigener Upload** des Owners (App/Teilen, als „owner“ gekennzeichnet) aus den letzten 30 Minuten —
 *     eine eingeschleuste Anweisung aus Mail oder Webseite kann so nur Dateien bewegen, die der Owner selbst geschickt hat;
 *  2. das Ziel liegt in einem **Ablage-Ordner** des Geräts (Standard Downloads; am Gerät einstellbar, nie aus dem Chat);
 *  3. die Anfrage kommt aus einem Gespräch (Herkunft vorhanden).
 * Überschrieben wird ohnehin nie (Satellit), ausführen bleibt `shell` mit Bestätigung — die Kette aus v1413 bleibt getrennt.
 *
 * A — was trotzdem fragen muss, wird gebündelt (siehe GeraetSkill): eine Bestätigung je Gerät und Gespräch.
 */
export const EIGENER_UPLOAD_MS = 30 * 60_000;

export class EigeneUploads {
  private readonly keys = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  merke(key: string): void {
    this.raeumeAuf();
    this.keys.set(key, this.now());
  }

  /** Ist `quelle` ein eigener Upload des Owners, höchstens 30 Minuten alt? */
  istEigen(quelle: string): boolean {
    const t = this.keys.get(quelle);
    return t !== undefined && this.now() - t <= EIGENER_UPLOAD_MS;
  }

  private raeumeAuf(): void { const grenze = this.now() - EIGENER_UPLOAD_MS; for (const [k, t] of this.keys) if (t < grenze) this.keys.delete(k); }
}

/** Liefert den Ablage-Ordner, der das Ablegen ohne Rückfrage erlaubt — oder undefined (dann wird gefragt). */
export function ablageOhneRueckfrage(o: { quelle: unknown; ziel: unknown; eigen: (quelle: string) => boolean; ordner: string[] | undefined; mitHerkunft: boolean; win?: boolean }): string | undefined {
  if (!o.mitHerkunft || !o.ordner?.length) return undefined;
  const quelle = typeof o.quelle === 'string' ? o.quelle.trim() : '';
  const ziel = typeof o.ziel === 'string' ? o.ziel.trim() : '';
  if (!quelle || !ziel || !o.eigen(quelle)) return undefined;
  return o.ordner.find(d => typeof d === 'string' && d && imVerzeichnis(ziel, d, !!o.win));
}
