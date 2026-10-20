/**
 * v1528 — iOS-Fokus über Fokusfilter (Owner 20.10.: „Weg B wie vorgeschlagen“). Der Owner legt in den iOS-Einstellungen je Fokus
 * fest, wie Alfred sich verhält (Name, Hinweise, Vorlesen); iOS ruft die App beim Ein- und Ausschalten auf und sie meldet hier.
 * Hinweise: `alle` (normal), `nurDringend` (nur dringend/hoch sofort), `keine` (nur Notfälle sofort, der Rest später).
 * Datei data/handy-fokus.json übersteht Neustarts.
 */
import fs from 'node:fs';
import path from 'node:path';

export type FokusHinweise = 'alle' | 'nurDringend' | 'keine';
export interface FokusStand { name: string; hinweise: FokusHinweise; vorlesen: boolean; seit: string }

const HINWEISE = new Set<FokusHinweise>(['alle', 'nurDringend', 'keine']);

export class HandyFokus {
  private stand: Record<string, FokusStand> = {};

  constructor(private readonly datei?: string, private readonly now: () => number = () => Date.now()) {
    if (datei) { try { this.stand = JSON.parse(fs.readFileSync(datei, 'utf8')) as Record<string, FokusStand>; } catch { this.stand = {}; } }
  }

  von(geraetId: string): FokusStand | undefined { return this.stand[geraetId]; }

  /** Jüngster aktiver Fokus über alle Handys des Owners (für die Zustellung). */
  aktiv(): FokusStand | undefined {
    return Object.values(this.stand).sort((a, b) => b.seit.localeCompare(a.seit))[0];
  }

  /** Meldung des Handys: `aktiv: false` = Fokus aus. Ergebnis: geändert? */
  melde(geraetId: string, m: { aktiv?: unknown; name?: unknown; hinweise?: unknown; vorlesen?: unknown }): boolean {
    const alt = this.stand[geraetId];
    if (m.aktiv !== true) {
      if (!alt) return false;
      delete this.stand[geraetId]; this.speichern(); return true;
    }
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 40) : 'Fokus';
    const hinweise: FokusHinweise = typeof m.hinweise === 'string' && HINWEISE.has(m.hinweise as FokusHinweise) ? m.hinweise as FokusHinweise : 'nurDringend';
    const vorlesen = m.vorlesen === true;
    const gleich = alt && alt.name === name && alt.hinweise === hinweise && alt.vorlesen === vorlesen;
    this.stand[geraetId] = { name, hinweise, vorlesen, seit: gleich ? alt.seit : new Date(this.now()).toISOString() };
    this.speichern();
    return !gleich;
  }

  private speichern(): void {
    if (!this.datei) return;
    try { fs.mkdirSync(path.dirname(this.datei), { recursive: true }); fs.writeFileSync(this.datei, JSON.stringify(this.stand, null, 2)); } catch { /* best effort */ }
  }
}
