import type { Logger } from 'pino';
import type { EmbeddingRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import { isNearDuplicateTitle, storyIdentity, cosineSimilarity } from '@alfred/skills';

export interface BlockedStory {
  /** Content-Item-ID (für persistierte Embeddings); ohne id nur in-memory. */
  id?: string;
  title: string;
  body?: string;
  /**
   * v975 — Termin-Ankündigungen (performance.terminBis): ihre Identität ist
   * der TERMIN, nicht der Text — Ort/Format teilen sich alle Ankündigungen
   * („Public Viewing im …-Pub"), Token- und Embedding-Nähe sind hier normal.
   * Einträge mit terminAt gehören NICHT in die Token-/Semantik-Gates.
   */
  terminAt?: string;
}

export interface CandidateStory {
  title: string;
  body: string;
}

export interface EmbedFn {
  (text: string): Promise<{ embedding: number[]; model: string; dimensions: number } | undefined>;
}

const EMBEDDING_SOURCE_TYPE = 'social-item';

/**
 * v973 — Semantische Story-Dedup für das Content-Studio (Schicht 2 des
 * Duplikat-Fixes; Schicht 1 = vollständige Token-Sperrliste, Schicht 3 =
 * Prompt/Rohstoff-Hygiene).
 *
 * Problem (DB-bewiesen): Token-Ähnlichkeit fängt Paraphrasen strukturell
 * nicht — „Alaba hält sich alle Optionen offen" vs. „Alaba lässt Zukunft
 * offen — Comeback möglich?" hat nur 40% Token-Overlap, ist aber dieselbe
 * Story. Fünf solcher Varianten landeten im selben Kanal.
 *
 * Lösung: Story-Identität (Titel + Body-Anfang) als Embedding; Kandidat mit
 * Cosine ≥ Schwelle zu einem gesperrten Item = Duplikat. Embeddings werden
 * je Content-Item persistiert (EmbeddingRepository, sourceType 'social-item')
 * und für Bestand lazy nachberechnet. Ohne Embedding-Support: LLM-Judge als
 * Fallback (EIN Call pro Batch); fällt auch der aus → fail-open auf die
 * Token-Schicht (lieber ein Duplikat als gar kein Content).
 */
export class StoryDeduper {
  /** In-Memory-Cache für Identitäten ohne Item-ID (Batch-Runden). */
  private memoryCache = new Map<string, number[]>();

  constructor(
    private readonly embed: EmbedFn | undefined,
    private readonly embeddingRepo: EmbeddingRepository | undefined,
    private readonly llm: Pick<LLMProvider, 'complete'> | undefined,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
    private readonly opts: { threshold?: number } = {},
  ) {}

  get threshold(): number {
    return this.opts.threshold ?? 0.85;
  }

  /**
   * Filtert Kandidaten gegen die Sperrliste: erst Token-Gate (billig), dann
   * semantisches Gate. @returns überlebende Kandidaten in Original-Reihenfolge.
   */
  async filterCandidates<T extends CandidateStory>(
    candidates: T[], blocked: BlockedStory[],
  ): Promise<{ accepted: T[]; droppedToken: number; droppedSemantic: number }> {
    const blockedTitles = blocked.map(b => b.title);
    const afterToken: T[] = [];
    let droppedToken = 0;
    for (const c of candidates) {
      if (isNearDuplicateTitle(c.title || c.body.slice(0, 60), blockedTitles)
        // auch gegen bereits akzeptierte Kandidaten dieses Batches
        || isNearDuplicateTitle(c.title || c.body.slice(0, 60), afterToken.map(a => a.title))) {
        droppedToken++;
        continue;
      }
      afterToken.push(c);
    }
    if (afterToken.length === 0) return { accepted: [], droppedToken, droppedSemantic: 0 };

    // Schicht 2 — Embeddings
    if (this.embed) {
      const accepted: T[] = [];
      let droppedSemantic = 0;
      const blockedVectors = await this.blockedEmbeddings(blocked);
      const acceptedVectors: number[][] = [];
      for (const c of afterToken) {
        const vec = await this.embedIdentity(storyIdentity(c));
        if (!vec) { accepted.push(c); continue; } // Embedding-Ausfall → Token-Schicht galt
        const dup = [...blockedVectors, ...acceptedVectors].some(b => cosineSimilarity(vec, b) >= this.threshold);
        if (dup) { droppedSemantic++; continue; }
        acceptedVectors.push(vec);
        accepted.push(c);
      }
      return { accepted, droppedToken, droppedSemantic };
    }

    // Schicht-2-Fallback — LLM-Judge (EIN Call pro Batch)
    if (this.llm && blocked.length > 0) {
      const dupIndexes = await this.judgeDuplicates(afterToken, blockedTitles);
      if (dupIndexes !== null) {
        const accepted = afterToken.filter((_, i) => !dupIndexes.has(i));
        return { accepted, droppedToken, droppedSemantic: afterToken.length - accepted.length };
      }
    }

    return { accepted: afterToken, droppedToken, droppedSemantic: 0 };
  }

  /**
   * Embedding eines neu erstellten Items persistieren (best-effort) — damit
   * spätere Läufe den Bestand nicht neu berechnen müssen.
   */
  async embedStory(itemId: string, story: { title?: string; body?: string }): Promise<void> {
    if (!this.embed || !this.embeddingRepo) return;
    try {
      const identity = storyIdentity(story);
      const result = await this.embed(identity);
      if (!result) return;
      await this.embeddingRepo.store({
        userId: this.ownerUserId,
        sourceType: EMBEDDING_SOURCE_TYPE,
        sourceId: itemId,
        content: identity.slice(0, 500),
        embedding: result.embedding,
        model: result.model,
        dimensions: result.dimensions,
      });
    } catch (err) {
      this.logger.debug({ err: (err as Error).message, itemId }, 'v973 embedStory failed (non-critical)');
    }
  }

  /** Embeddings der Sperrliste: persistiert lesen, fehlende berechnen + speichern. */
  private async blockedEmbeddings(blocked: BlockedStory[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const story of blocked) {
      try {
        if (story.id && this.embeddingRepo) {
          const stored = await this.embeddingRepo.findBySource(EMBEDDING_SOURCE_TYPE, story.id, this.ownerUserId);
          if (stored) { out.push(stored.embedding); continue; }
        }
        const identity = storyIdentity(story);
        const vec = await this.embedIdentity(identity);
        if (!vec) continue;
        out.push(vec);
        if (story.id && this.embeddingRepo) {
          const result = { embedding: vec };
          // Modell/Dimensionen für die Persistenz erneut aus dem Cache-Pfad holen
          // wäre doppelt — embedIdentity persistiert bewusst NICHT; hier speichern:
          await this.embeddingRepo.store({
            userId: this.ownerUserId, sourceType: EMBEDDING_SOURCE_TYPE, sourceId: story.id,
            content: identity.slice(0, 500), embedding: result.embedding,
            model: this.lastModel ?? 'unknown', dimensions: result.embedding.length,
          }).catch(() => { /* non-critical */ });
        }
      } catch { /* einzelne Story überspringen */ }
    }
    return out;
  }

  private lastModel: string | undefined;

  private async embedIdentity(identity: string): Promise<number[] | undefined> {
    const cached = this.memoryCache.get(identity);
    if (cached) return cached;
    if (!this.embed) return undefined;
    try {
      const result = await this.embed(identity);
      if (!result) return undefined;
      this.lastModel = result.model;
      this.memoryCache.set(identity, result.embedding);
      // Cache begrenzen (ein Studio-Lauf über viele Kanäle)
      if (this.memoryCache.size > 500) {
        const first = this.memoryCache.keys().next().value;
        if (first !== undefined) this.memoryCache.delete(first);
      }
      return result.embedding;
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'v973 embed failed');
      return undefined;
    }
  }

  /** LLM-Judge: welche Kandidaten erzählen dieselbe Story wie ein Bestandstitel? */
  private async judgeDuplicates(candidates: CandidateStory[], blockedTitles: string[]): Promise<Set<number> | null> {
    if (!this.llm) return null;
    try {
      const prompt = `Prüfe, welche KANDIDATEN dieselbe Story/Nachricht behandeln wie ein bereits vorhandener Beitrag — auch wenn sie anders formuliert sind. Gleiches Ereignis/gleiche Personalie = Duplikat; nur gleiches Oberthema (z.B. beide über die WM, aber andere Ereignisse) = KEIN Duplikat.

BEREITS VORHANDEN:
${blockedTitles.slice(0, 80).map(t => `- ${t}`).join('\n')}

KANDIDATEN:
${candidates.map((c, i) => `${i}: ${c.title || c.body.slice(0, 80)}`).join('\n')}

Antworte NUR mit einem JSON-Array der Duplikat-Indizes, z.B. [0, 2] oder [].`;
      const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 200, tier: 'fast' });
      const match = response.content?.match(/\[[\d,\s]*\]/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return null;
      return new Set(parsed.filter((n: unknown) => typeof n === 'number' && n >= 0 && n < candidates.length));
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'v973 judge fallback failed — fail-open auf Token-Schicht');
      return null;
    }
  }
}
