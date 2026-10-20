/**
 * v1522 — Standortzonen des Handys (Owner 20.10.: „Standardzonen“). iOS überwacht die Zonen selbst (auch bei geschlossener
 * App) und meldet Betreten/Verlassen; hier steht je Gerät die aktuelle Zone — `null` = unterwegs (in keiner Zone).
 * Nur der Zonenname verlässt das Handy, nie Koordinaten. Alfred nutzt die Zone intern (Weltmodell, Lage), meldet Wechsel
 * nicht von sich aus. Datei data/handy-zonen.json übersteht Neustarts.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ZonenStand { zone: string | null; seit: string; gemeldet: string; /** v1526 — Bewegung bei der Meldung (auto, rad, laeuft, geht, still) */ bewegung?: string }

const BEWEGUNGEN = new Set(['auto', 'rad', 'laeuft', 'geht', 'still']);

export class HandyZonen {
  private stand: Record<string, ZonenStand> = {};

  constructor(private readonly datei?: string, private readonly now: () => number = () => Date.now()) {
    if (datei) { try { this.stand = JSON.parse(fs.readFileSync(datei, 'utf8')) as Record<string, ZonenStand>; } catch { this.stand = {}; } }
  }

  von(geraetId: string): ZonenStand | undefined { return this.stand[geraetId]; }

  /**
   * Meldung des Handys. `betreten`/`verlassen` einer benannten Zone, oder `stand` mit der aktuellen Zone (Start, Prüfung).
   * Verlassen einer anderen als der aktuellen Zone ändert nichts (Reihenfolge der iOS-Ereignisse ist nicht garantiert).
   * Ergebnis: geänderter Stand oder undefined.
   */
  melde(geraetId: string, m: { art: string; zone?: string | null; bewegung?: unknown }): { vorher: string | null; jetzt: string | null } | undefined {
    const zone = typeof m.zone === 'string' && m.zone.trim() ? m.zone.trim().slice(0, 40) : null;
    const alt = this.stand[geraetId];
    if (m.art === 'aus') { if (!alt) return undefined; this.vergiss(geraetId); return { vorher: alt.zone, jetzt: null }; } // keine Zonen mehr eingerichtet
    const vorher = alt ? alt.zone : null;
    let jetzt: string | null;
    if (m.art === 'betreten' && zone) jetzt = zone;
    else if (m.art === 'verlassen' && zone) jetzt = vorher === zone ? null : vorher;
    else if (m.art === 'stand') jetzt = zone;
    else return undefined;
    const zeit = new Date(this.now()).toISOString();
    const geaendert = !alt || jetzt !== vorher;
    const bewegung = typeof m.bewegung === 'string' && BEWEGUNGEN.has(m.bewegung) ? m.bewegung : alt?.bewegung;
    this.stand[geraetId] = { zone: jetzt, seit: geaendert ? zeit : alt.seit, gemeldet: zeit, ...(bewegung ? { bewegung } : {}) };
    this.speichern();
    return geaendert ? { vorher, jetzt } : undefined;
  }

  vergiss(geraetId: string): void { delete this.stand[geraetId]; this.speichern(); }

  private speichern(): void {
    if (!this.datei) return;
    try { fs.mkdirSync(path.dirname(this.datei), { recursive: true }); fs.writeFileSync(this.datei, JSON.stringify(this.stand, null, 2)); } catch { /* best effort */ }
  }
}
