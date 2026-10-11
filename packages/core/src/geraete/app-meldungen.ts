/**
 * v1351 — Fehlermeldungen der Desktop-App ins Server-Log (Owner-Freigabe 11.10., Punkt 8): bisher standen Fehler der App
 * (Mikrofon, Relais, Update, Verlauf) nur lokal im Fenster und mussten vom Owner gemeldet werden. Grenze je Gerät, damit
 * eine Fehlerschleife das Log nicht flutet: gleicher Text höchstens alle 10 min, insgesamt höchstens 30 je Stunde.
 */
export class AppMeldungsGrenze {
  private readonly zuletzt = new Map<string, number>();
  private readonly stunde = new Map<string, number[]>();

  constructor(private readonly maxJeStunde = 30, private readonly gleicheSperreMs = 10 * 60_000) {}

  erlaube(geraetId: string, text: string, jetzt = Date.now()): boolean {
    const schluessel = `${geraetId}|${text}`;
    const vorher = this.zuletzt.get(schluessel);
    if (vorher !== undefined && jetzt - vorher < this.gleicheSperreMs) return false;
    const liste = (this.stunde.get(geraetId) ?? []).filter(t => jetzt - t < 3_600_000);
    if (liste.length >= this.maxJeStunde) { this.stunde.set(geraetId, liste); return false; }
    liste.push(jetzt);
    this.stunde.set(geraetId, liste);
    this.zuletzt.set(schluessel, jetzt);
    if (this.zuletzt.size > 2000) { for (const [k, t] of this.zuletzt) if (jetzt - t >= this.gleicheSperreMs) this.zuletzt.delete(k); }
    return true;
  }
}
