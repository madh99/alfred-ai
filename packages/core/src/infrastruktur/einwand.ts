/**
 * Einwand (Owner 22.10.2026) — Widerspruch des Owners zu einem Change oder einer Zielarchitektur, als Objekt mit Pflicht zur Antwort:
 *   - ein offener Einwand nimmt dem Change die Freigabe (zurück in den Entwurf) bzw. setzt das Vorhaben in den Entwurf
 *   - ein überarbeiteter Plan wird erst angenommen, wenn JEDER offene Einwand beantwortet ist (umgesetzt in … / abgelehnt, weil …)
 *   - die Antworten stehen in der nächsten Freigabe-Frage; mit der Freigabe bzw. Annahme sind sie erledigt
 */
import type { Einwand, EinwandZiel } from '@alfred/storage';

export interface EinwandDeps {
  repo: {
    anlegen(o: string, e: { zielArt: EinwandZiel; zielId: string; bezug: string; text: string; quelle: string }): Promise<Einwand>;
    liste(o: string, zielArt: EinwandZiel, zielId: string): Promise<Einwand[]>;
    beantworte(o: string, id: string, art: 'umgesetzt' | 'abgelehnt', antwort: string): Promise<void>;
    erledige(o: string, ids: string[]): Promise<void>;
  };
  /** Change in den Entwurf zurück (Freigabe/Freigabe-Frage verfallen); liefert den neuen Status oder einen Grund */
  sperreChange(o: string, id: string): Promise<string>;
  /** Vorhaben in den Entwurf zurück */
  sperreVorhaben(o: string, id: string): Promise<string>;
  melde?: (text: string) => Promise<void>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}
export interface Antwort { einwand: string; art: 'umgesetzt' | 'abgelehnt'; text: string }

export class EinwandDienst {
  constructor(private readonly d: EinwandDeps) {}

  async erfasse(o: string, e: { zielArt: EinwandZiel; zielId: string; bezug?: string; text: string; quelle: string }): Promise<{ einwand: Einwand; folge: string }> {
    const text = e.text.trim();
    if (text.length < 3) throw new Error('Einwand braucht einen Text (was passt nicht?)');
    const bezug = (e.bezug ?? '').trim() || 'gesamt';
    const einwand = await this.d.repo.anlegen(o, { zielArt: e.zielArt, zielId: e.zielId, bezug, text, quelle: e.quelle });
    const folge = e.zielArt === 'change' ? await this.d.sperreChange(o, e.zielId) : await this.d.sperreVorhaben(o, e.zielId);
    this.d.protokoll?.('Einwand erfasst', { ziel: `${e.zielArt}:${e.zielId}`, bezug, quelle: e.quelle, folge });
    return { einwand, folge };
  }

  async offen(o: string, art: EinwandZiel, id: string): Promise<Einwand[]> { return (await this.d.repo.liste(o, art, id)).filter(x => x.status === 'offen'); }
  async beantwortet(o: string, art: EinwandZiel, id: string): Promise<Einwand[]> { return (await this.d.repo.liste(o, art, id)).filter(x => x.status === 'beantwortet'); }
  liste(o: string, art: EinwandZiel, id: string): Promise<Einwand[]> { return this.d.repo.liste(o, art, id); }

  /** Antworten auf alle offenen Einwände prüfen (Pflicht); liefert Fehler oder die zu speichernden Antworten. */
  async pruefeAntworten(o: string, art: EinwandZiel, id: string, roh: unknown): Promise<{ fehler: string[]; antworten: Antwort[] }> {
    const offen = await this.offen(o, art, id);
    if (!offen.length) return { fehler: [], antworten: [] };
    const liste = (Array.isArray(roh) ? roh : []).map(a => (a ?? {}) as Record<string, unknown>);
    const fehler: string[] = []; const antworten: Antwort[] = [];
    for (const e of offen) {
      const a = liste.find(x => typeof x.einwand === 'string' && (x.einwand === e.id || (x.einwand.length >= 6 && e.id.startsWith(x.einwand))));
      const artA = a?.art === 'umgesetzt' || a?.art === 'abgelehnt' ? a.art : undefined;
      const text = typeof a?.text === 'string' ? a.text.trim() : '';
      if (!a || !artA || text.length < 5) { fehler.push(`Einwand ${e.id.slice(0, 8)} (${e.bezug}: „${e.text.slice(0, 80)}“) ist nicht beantwortet — antworten: [{einwand, art umgesetzt|abgelehnt, text}]`); continue; }
      antworten.push({ einwand: e.id, art: artA, text });
    }
    return { fehler, antworten };
  }

  async speichereAntworten(o: string, antworten: Antwort[]): Promise<void> {
    for (const a of antworten) await this.d.repo.beantworte(o, a.einwand, a.art, a.text);
  }

  /** Zeilen für die Freigabe-Frage: was mit den Einwänden des Owners passiert ist. */
  async antwortText(o: string, art: EinwandZiel, id: string): Promise<string> {
    const b = await this.beantwortet(o, art, id);
    if (!b.length) return '';
    return `Deine Einwände:\n${b.map(e => `  • ${e.bezug}: „${e.text.slice(0, 100)}“ → ${e.antwortArt === 'umgesetzt' ? 'umgesetzt' : 'nicht umgesetzt'}: ${e.antwort?.slice(0, 200)}`).join('\n')}`;
  }

  async erledigeBeantwortete(o: string, art: EinwandZiel, id: string): Promise<void> {
    const b = await this.beantwortet(o, art, id);
    if (b.length) await this.d.repo.erledige(o, b.map(e => e.id));
  }
}
