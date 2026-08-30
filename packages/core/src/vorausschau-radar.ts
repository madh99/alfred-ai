import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { KnowledgeGraphRepository, MemoryRepository } from '@alfred/storage';
import { INTERNAL_MEMORY_KEY_PREFIXES } from './knowledge-graph.js';
import { spaetestesDatumImText } from './reasoning-context-collector.js';

/**
 * v1145 — K3: Vorausschau-Radar. Erkennt kommende Ereignisse DETERMINISTISCH
 * aus dem vorhandenen Wissen und erinnert mit Vorlauf — 7 Tage vorher und am
 * Vortag, je Ereignis+Jahr+Stufe genau einmal (Insight-dedupeKey).
 *
 * Quellen:
 *  1. Geburtstage aus KG-Personen (birthdate/birthday/birth_date) — jährlich.
 *  2. Zukunfts-Termine aus Memories (relevant_until oder Datum im Text).
 *
 * Die ERKENNUNG ist reiner Code und funktioniert mit jedem Modell — nur der
 * Vorschlags-Satz („ein nettes Geschenk wäre …") kommt vom LLM und entfällt
 * still, wenn kein Modell antwortet. Grundsatz: Alfred bleibt auf der ganzen
 * Fallback-Kette funktionsfähig.
 */

export interface VorausschauEreignis {
  /** Stabiler Schlüssel (z. B. `geburtstag:<entityId>` oder `memory:<key>`). */
  schluessel: string;
  titel: string;
  datum: Date;
  /** 'geburtstag' | 'termin' — steuert Emoji und Vorschlags-Prompt. */
  art: 'geburtstag' | 'termin';
  /** Kontext fürs LLM (Rolle, Alter, Interessen bzw. Memory-Text). */
  kontext: string;
}

/** Nächstes Vorkommen eines jährlichen Datums (Geburtstag) ab `heute` (inkl. heute). */
export function naechstesVorkommen(geburtsdatum: Date, heute: Date): Date {
  const kandidat = new Date(heute.getFullYear(), geburtsdatum.getMonth(), geburtsdatum.getDate(), 12);
  const heuteMittag = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate(), 12);
  if (kandidat.getTime() < heuteMittag.getTime()) kandidat.setFullYear(heute.getFullYear() + 1);
  return kandidat;
}

/** Ganze Tage bis zum Ereignis (0 = heute). */
export function tageBis(datum: Date, heute: Date): number {
  const a = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());
  const b = new Date(datum.getFullYear(), datum.getMonth(), datum.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Vorlauf-Stufe: 7 Tage vorher und am Vortag — sonst keine Meldung. */
export function vorlaufStufe(tage: number): '7tage' | 'vortag' | null {
  if (tage === 7) return '7tage';
  if (tage === 1) return 'vortag';
  return null;
}

/** Geburtsdatum aus KG-Attributen parsen (ISO oder dd.mm.yyyy). */
export function parseGeburtsdatum(attrs: Record<string, unknown> | undefined): Date | null {
  const roh = String(attrs?.birthdate ?? attrs?.birthday ?? attrs?.birth_date ?? '').trim();
  if (!roh) return null;
  let m = roh.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12);
  m = roh.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 12);
  return null;
}

interface InsightsSink {
  upsertCandidate(userId: string, candidate: {
    category: string; title: string; body: string; confidence: number;
    sourceData?: Record<string, unknown>; dedupeKey?: string;
  }): Promise<unknown>;
}

export class VorausschauRadar {
  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly insightsRepo: InsightsSink,
    private readonly logger: Logger,
    private readonly llm?: LLMProvider,
  ) {}

  /** Ereignisse deterministisch einsammeln (exportierbar testbar über run()). */
  private async sammleEreignisse(userId: string, heute: Date): Promise<VorausschauEreignis[]> {
    const ereignisse: VorausschauEreignis[] = [];

    // 1. Geburtstage aus KG-Personen
    try {
      const personen = await this.kgRepo.getEntitiesByType(userId, 'person');
      for (const p of personen) {
        if (p.name === 'User') continue;
        const geb = parseGeburtsdatum(p.attributes as Record<string, unknown>);
        if (!geb) continue;
        const vorkommen = naechstesVorkommen(geb, heute);
        const alter = vorkommen.getFullYear() - geb.getFullYear();
        const a = (p.attributes ?? {}) as Record<string, unknown>;
        const rolle = String(a.relation_to_user ?? a.rolle ?? a.role ?? '').trim();
        const interessen = ['sport', 'hobby', 'hobbies', 'interessen', 'interests']
          .map(k => a[k]).filter(v => typeof v === 'string').join(', ');
        ereignisse.push({
          schluessel: `geburtstag:${p.id}`,
          titel: `${p.name} hat Geburtstag`,
          datum: vorkommen,
          art: 'geburtstag',
          kontext: `${p.name}${rolle ? ` (${rolle})` : ''}, wird ${alter}${interessen ? `; Interessen: ${interessen}` : ''}`,
        });
      }
    } catch (err) {
      this.logger.debug({ err }, 'Vorausschau: Geburtstags-Scan fehlgeschlagen');
    }

    // 2. Zukunfts-Termine aus Memories (relevant_until oder Datum im Text)
    try {
      const memories = await this.memoryRepo.listAll(userId);
      for (const m of memories) {
        if (INTERNAL_MEMORY_KEY_PREFIXES.test(m.key)) continue;
        let datum: Date | null = null;
        if (m.relevantUntil) {
          const d = new Date(m.relevantUntil);
          if (!isNaN(d.getTime())) datum = d;
        }
        if (!datum) datum = spaetestesDatumImText(m.value, heute);
        if (!datum) continue;
        const tage = tageBis(datum, heute);
        if (tage < 0 || tage > 14) continue; // nur naher Zukunftshorizont
        ereignisse.push({
          schluessel: `memory:${m.key}`,
          titel: m.value.slice(0, 100).replace(/\s+/g, ' ').trim(),
          datum,
          art: 'termin',
          kontext: m.value.slice(0, 300),
        });
      }
    } catch (err) {
      this.logger.debug({ err }, 'Vorausschau: Memory-Scan fehlgeschlagen');
    }

    return ereignisse;
  }

  /** LLM-Veredelung (1 Satz Vorschlag) — best-effort, entfällt still bei Ausfall. */
  private async vorschlag(e: VorausschauEreignis): Promise<string> {
    if (!this.llm) return '';
    try {
      const frage = e.art === 'geburtstag'
        ? `Für diesen Geburtstag: ${e.kontext}. Schlage in EINEM kurzen deutschen Satz eine konkrete, altersgerechte Geschenkidee vor (beginne mit "💡 Geschenkidee:").`
        : `Für diesen anstehenden Termin: ${e.kontext}. Schlage in EINEM kurzen deutschen Satz die sinnvollste Vorbereitung vor (beginne mit "💡 Vorschlag:").`;
      const r = await this.llm.complete({
        messages: [{ role: 'user', content: frage }],
        maxTokens: 120, tier: 'fast',
      });
      const satz = r.content?.trim().split('\n')[0] ?? '';
      return satz.startsWith('💡') && satz.length < 300 ? satz : '';
    } catch {
      return '';
    }
  }

  /** Täglicher Lauf: erinnert 7 Tage vorher + am Vortag, je Stufe genau einmal. */
  async run(userId: string, heute = new Date()): Promise<number> {
    const ereignisse = await this.sammleEreignisse(userId, heute);
    let gemeldet = 0;
    for (const e of ereignisse) {
      const tage = tageBis(e.datum, heute);
      const stufe = vorlaufStufe(tage);
      if (!stufe) continue;
      const wann = stufe === 'vortag' ? 'morgen' : 'in 7 Tagen';
      const datumsText = `${String(e.datum.getDate()).padStart(2, '0')}.${String(e.datum.getMonth() + 1).padStart(2, '0')}.`;
      const emoji = e.art === 'geburtstag' ? '🎂' : '📅';
      const tipp = await this.vorschlag(e);
      try {
        await this.insightsRepo.upsertCandidate(userId, {
          category: 'vorausschau',
          title: `${emoji} ${e.titel} — ${wann} (${datumsText})`,
          body: `${e.kontext}${tipp ? `\n${tipp}` : ''}`,
          confidence: 0.9,
          sourceData: { router: true, urgency: stufe === 'vortag' ? 'normal' : 'low' },
          // Jahr des Vorkommens im Schlüssel: jährliche Ereignisse melden
          // nächstes Jahr wieder, aber nie doppelt je Stufe.
          dedupeKey: `vorausschau:${e.schluessel}:${e.datum.getFullYear()}:${stufe}`,
        });
        gemeldet++;
      } catch (err) {
        this.logger.debug({ err, ereignis: e.schluessel }, 'Vorausschau: Insight fehlgeschlagen');
      }
    }
    // v1149 — auch bei 0 Funden loggen: ein stiller Lauf muss beweisbar sein.
    this.logger.info({ gemeldet, gescannt: ereignisse.length }, 'v1145 Vorausschau-Radar gelaufen');
    return gemeldet;
  }
}
