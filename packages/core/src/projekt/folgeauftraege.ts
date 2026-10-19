import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * v1512 P1 — Warteschlange für Folgeaufträge je Projektverzeichnis (Owner 19.10.: „das Verhalten hätte ich erwartet“).
 * Realfall 15:52: „sobald die 6 Etappen fertig sind …“ → Alfred legte einen zweiten Lauf im selben Verzeichnis an (und
 * stoppte ihn selbst wieder). Jetzt: läuft im Verzeichnis schon ein Lauf (oder wartet auf die Freigabe), wird der neue
 * Auftrag hier eingereiht und erst nach dem Ende geplant. Verschiedene Projekte laufen weiter parallel (Schlüssel je
 * Gerät + Verzeichnis, nicht je Gerät). Als Datei, damit die Reihe Neustarts übersteht.
 */
export interface FolgeAuftrag {
  id: string;
  geraetId: string;
  geraet: string;
  projekt: string;
  ziel: string;
  befehle: string[];
  /** Start-Optionen des ursprünglichen Auftrags (Budget, Zeit, sudo-Sperre) */
  input: Record<string, unknown>;
  name?: string;
  herkunft?: { chatId: string; platform: string };
  akteId?: string;
  /** Lauf, hinter dem er eingereiht wurde (Anzeige) */
  nach?: string;
  eingereiht: number;
}

/** Pfade gleich behandeln: Schrägstriche am Ende weg, Windows-Pfade ohne Groß/Klein. */
export function pfadSchluessel(geraetId: string, projekt: string): string {
  const p = projekt.trim().replace(/[\\/]+$/, '');
  const win = /^[a-z]:[\\/]/i.test(p) || (p.includes('\\') && !p.includes('/'));
  return `${geraetId}|${win ? p.replace(/\//g, '\\').toLowerCase() : p}`;
}

export class FolgeAuftraege {
  private reihen: Record<string, FolgeAuftrag[]> = {};

  constructor(private readonly datei?: string, private readonly now: () => number = Date.now) {
    if (datei) { try { this.reihen = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, FolgeAuftrag[]>; } catch { /* neu */ } }
  }

  einreihen(e: Omit<FolgeAuftrag, 'id' | 'eingereiht'>): { eintrag: FolgeAuftrag; position: number } {
    const k = pfadSchluessel(e.geraetId, e.projekt);
    const eintrag: FolgeAuftrag = { ...e, id: `folge-${randomUUID().slice(0, 8)}`, eingereiht: this.now() };
    (this.reihen[k] ??= []).push(eintrag);
    this.sichere();
    return { eintrag, position: this.reihen[k]!.length };
  }

  /** Reihe eines Verzeichnisses (erster = als Nächstes dran). */
  reihe(geraetId: string, projekt: string): FolgeAuftrag[] { return [...(this.reihen[pfadSchluessel(geraetId, projekt)] ?? [])]; }

  /** Reihe einer Projektakte (über alle Verzeichnis-Schlüssel, falls die Akte bekannt war). */
  reiheDerAkte(akteId: string, geraetId?: string, projekt?: string): FolgeAuftrag[] {
    if (geraetId && projekt) return this.reihe(geraetId, projekt);
    return Object.values(this.reihen).flat().filter(f => f.akteId === akteId);
  }

  /** Verzeichnisse mit wartenden Folgeaufträgen (für das Nachrücken). */
  verzeichnisse(): Array<{ geraetId: string; projekt: string }> {
    return Object.values(this.reihen).filter(r => r.length).map(r => ({ geraetId: r[0]!.geraetId, projekt: r[0]!.projekt }));
  }

  /** Ersten Eintrag eines Verzeichnisses entnehmen. */
  naechster(geraetId: string, projekt: string): FolgeAuftrag | undefined {
    const k = pfadSchluessel(geraetId, projekt);
    const r = this.reihen[k];
    if (!r?.length) return undefined;
    const e = r.shift()!;
    if (!r.length) delete this.reihen[k];
    this.sichere();
    return e;
  }

  /** Eintrag wieder vorne einsetzen (Nachrücken gescheitert, z. B. Gerät nicht verbunden). */
  vorne(e: FolgeAuftrag): void {
    const k = pfadSchluessel(e.geraetId, e.projekt);
    (this.reihen[k] ??= []).unshift(e);
    this.sichere();
  }

  entferne(id: string): FolgeAuftrag | undefined {
    for (const [k, r] of Object.entries(this.reihen)) {
      const i = r.findIndex(f => f.id === id);
      if (i < 0) continue;
      const [e] = r.splice(i, 1);
      if (!r.length) delete this.reihen[k];
      this.sichere();
      return e;
    }
    return undefined;
  }

  /** Um eine Stelle nach vorne (-1) oder hinten (+1); false, wenn es nicht geht. */
  verschiebe(id: string, richtung: -1 | 1): boolean {
    for (const r of Object.values(this.reihen)) {
      const i = r.findIndex(f => f.id === id);
      if (i < 0) continue;
      const j = i + richtung;
      if (j < 0 || j >= r.length) return false;
      [r[i], r[j]] = [r[j]!, r[i]!];
      this.sichere();
      return true;
    }
    return false;
  }

  private sichere(): void {
    if (!this.datei) return;
    try { mkdirSync(dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify(this.reihen, null, 1), { mode: 0o600 }); } catch { /* Ablage optional */ }
  }
}
