import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * v1383 (R1) — Zuordnung Claude-Code-Auftrag → Sitzung des Starts. Als Datei (wie Vorhaben, v1240), damit die Ende-Meldung
 * auch nach einem Neustart des Gehirns in die richtige Sitzung geht (vorher: nur noch Owner-Chat). Einträge älter als
 * 7 Tage verfallen (so weit reicht auch das Nachreichen am Satelliten).
 */
export interface Herkunft { chatId: string; platform: string; userId: string }
interface Eintrag extends Herkunft { seit: number }

const FRIST_MS = 7 * 86_400_000;

export class AuftragHerkunft {
  private readonly eintraege: Map<string, Eintrag>;

  constructor(private readonly datei?: string, private readonly now: () => number = Date.now) {
    let roh: Record<string, Eintrag> = {};
    if (datei) { try { roh = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, Eintrag>; } catch { /* neu */ } }
    const grenze = this.now() - FRIST_MS;
    this.eintraege = new Map(Object.entries(roh).filter(([, e]) => e && typeof e.chatId === 'string' && e.seit >= grenze));
  }

  merke(geraetId: string, auftragId: string, h: Herkunft): void {
    this.eintraege.set(`${geraetId}:${auftragId}`, { chatId: h.chatId, platform: h.platform, userId: h.userId, seit: this.now() });
    this.sichere();
  }

  /** Liefert und entfernt die Herkunft (jedes Ende wird einmal gemeldet). */
  nimm(geraetId: string, auftragId: string): Herkunft | undefined {
    const k = `${geraetId}:${auftragId}`;
    const e = this.eintraege.get(k);
    if (!e) return undefined;
    this.eintraege.delete(k);
    this.sichere();
    return { chatId: e.chatId, platform: e.platform, userId: e.userId };
  }

  private sichere(): void {
    if (!this.datei) return;
    try { mkdirSync(dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify(Object.fromEntries(this.eintraege)), { mode: 0o600 }); } catch { /* Ablage optional */ }
  }
}
