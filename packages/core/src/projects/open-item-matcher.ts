import type { Logger } from 'pino';
import type { ProjectRepository, ProjectOpenItem, EmbeddingRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { EmbeddingService } from '../embedding-service.js';

/**
 * v813c — Pre-Filter-Schwelle: ab dieser Anzahl offener Items wird Embedding-Vorfilter
 * aktiviert. Unter der Schwelle gehen alle Items direkt ans LLM (kein Overhead).
 */
const PREFILTER_THRESHOLD = 40;
/** v813c — wie viele Top-Treffer aus dem Embedding-Vorfilter ans LLM gehen. */
const PREFILTER_TOP_N = 30;
/**
 * v813c — Hartes Cap für JSON-Stringification. Bei 30 Items × ~600 chars + Header
 * passen wir locker rein. Bei Überschreitung WARN-Log (Option 5).
 */
const PROMPT_JSON_CAP = 16000;

const SYSTEM_PROMPT = `Du bewertest welche offenen Punkte eines Software-Projekts durch einen gerade abgeschlossenen Agent-Lauf erledigt wurden.

Du bekommst:
- Project-Goal (Was sollte der Lauf tun)
- Milestones (was tatsächlich gemacht wurde)
- Geänderte Dateien (relativ zum cwd)
- Eine Liste offener Punkte mit ID + Titel + optional Beschreibung

Antworte als JSON-Array. Jedes Element:
{
  "item_id": "uuid",
  "resolved": true|false,
  "confidence": 0.0-1.0,
  "reason": "Kurzbegründung, warum erledigt (oder nicht)"
}

Sei konservativ: nur als "resolved=true" markieren wenn klar erkennbar ist dass der Lauf den Punkt addressiert hat (Milestone matched semantisch, geänderte Dateien passen zum Item-Inhalt). Im Zweifel resolved=false.`;

interface MatchResult {
  item_id: string;
  resolved: boolean;
  confidence: number;
  reason?: string;
}

/**
 * v641 — Nach jedem erfolgreichen Project-Agent-Lauf:
 *   1. Hole alle 'open'/'in_progress' Items des Projekts
 *   2. Frag den LLM ob/welche der Items mit Milestones + Files gematcht sind
 *   3. Auto-resolve mit Confidence + Attribution
 *
 * Skippt komplett wenn keine Items offen sind ODER LLM-Provider nicht da ODER
 * der Lauf 0 Files änderte.
 */
export class OpenItemMatcher {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
    /**
     * v813c — Optional. Wenn vorhanden + Item-Anzahl > PREFILTER_THRESHOLD,
     * nutzt der Matcher Embedding-Ähnlichkeit um Top-N Kandidaten ans LLM zu
     * schicken statt alle Items in einen 12k-truncated Prompt zu quetschen
     * (der Bug seit v641: bei viel Items wurde JSON mitten abgeschnitten →
     * llmResults=0). Fehlt embeddings → Fallback auf alte Logik mit Cap 16k.
     */
    private readonly embeddings?: { service: EmbeddingService; repo: EmbeddingRepository },
  ) {}

  async matchAfterSession(opts: {
    projectId: string;
    sessionId: string;
    goal: string;
    milestones: string[];
    changedFiles?: string[];
    totalFilesChanged: number;
  }): Promise<{ matched: number; resolved: number }> {
    if (opts.totalFilesChanged === 0) return { matched: 0, resolved: 0 };

    const openItems = await this.projects.listOpenItemsForProject(opts.projectId);
    if (openItems.length === 0) return { matched: 0, resolved: 0 };

    // v813c — Embedding-Vorfilter wenn verfügbar UND Item-Anzahl groß genug.
    // Findet die relevantesten N Items per Cosine-Similarity → nur die gehen ans LLM.
    // Behebt den Truncation-Bug seit v641: 255 Items × 600 chars > 12k slice-Cap →
    // mittendrin abgeschnittenes JSON → LLM versteht nichts → llmResults=0.
    let candidateItems = openItems;
    let prefilterUsed: 'embedding' | 'truncate' | 'all' = 'all';
    if (this.embeddings && openItems.length > PREFILTER_THRESHOLD) {
      const filtered = await this.prefilterByEmbedding(opts, openItems).catch((err) => {
        this.logger.warn({ err, projectId: opts.projectId }, 'v813c embedding pre-filter failed — Fallback');
        return null;
      });
      if (filtered) {
        candidateItems = filtered;
        prefilterUsed = 'embedding';
      } else {
        // Embedding-Pre-Filter nicht verfügbar (z.B. SQLite ohne pgvector) →
        // härter trunkieren statt JSON-Crash zu riskieren.
        candidateItems = openItems.slice(0, PREFILTER_TOP_N);
        prefilterUsed = 'truncate';
      }
    }

    const itemsForPrompt = candidateItems.map(i => ({
      id: i.id,
      title: i.title.slice(0, 200),
      description: (i.description ?? '').slice(0, 400),
    }));

    const payload = {
      goal: opts.goal.slice(0, 1000),
      milestones: opts.milestones.slice(0, 30),
      files: (opts.changedFiles ?? []).slice(0, 80),
      open_items: itemsForPrompt,
    };

    const fullPayloadJson = JSON.stringify(payload, null, 2);
    const truncated = fullPayloadJson.length > PROMPT_JSON_CAP;
    if (truncated) {
      // v813c (Option 5) — sichtbare Warnung statt stiller Truncation. Sollte
      // mit dem Pre-Filter NIE feuern; tut es trotzdem → Symptom ernst nehmen.
      this.logger.warn({
        projectId: opts.projectId, sessionId: opts.sessionId,
        payloadChars: fullPayloadJson.length, cap: PROMPT_JSON_CAP,
        candidates: candidateItems.length, prefilterUsed,
      }, 'OpenItemMatcher: Prompt-JSON würde getrimmt — LLM-Ergebnisse evtl. unvollständig');
    }

    let results: MatchResult[] = [];
    let llmCallFailed = false;
    try {
      const res = await this.llm.complete({
        messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nDaten:\n\`\`\`json\n${fullPayloadJson.slice(0, PROMPT_JSON_CAP)}\n\`\`\`` }],
        tier: 'default' as any,
        maxTokens: 1500,
      });
      const cleaned = res.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
      const start = cleaned.indexOf('[');
      const end = cleaned.lastIndexOf(']');
      if (start >= 0 && end > start) results = JSON.parse(cleaned.slice(start, end + 1));
    } catch (err) {
      // v813c (Option 5) — Parse-/LLM-Fehler waren debug-only seit v641, daher in der
      // Praxis unsichtbar. Jetzt WARN damit Silent-Failures auffallen.
      llmCallFailed = true;
      this.logger.warn({ err, projectId: opts.projectId, sessionId: opts.sessionId }, 'OpenItemMatcher: LLM-Call/Parse fehlgeschlagen');
      return { matched: 0, resolved: 0 };
    }

    const knownIds = new Set(openItems.map(i => i.id));
    let resolved = 0;
    for (const r of results) {
      if (!knownIds.has(r.item_id)) continue;
      if (!r.resolved && (r.confidence ?? 0) < 0.4) continue;
      const ok = await this.projects.autoResolveOpenItem(
        r.item_id,
        `project_agent_session:${opts.sessionId}`,
        r.confidence ?? 0,
        r.resolved,
      ).catch(() => false);
      if (ok && r.resolved && r.confidence >= 0.6) resolved++;
    }

    // v813c (Option 5) — Silent-Failure-Detection: Items waren da, LLM-Call lief
    // durch, aber 0 strukturierte Ergebnisse → Symptom ernst nehmen, nicht stumm.
    if (!llmCallFailed && candidateItems.length > 0 && results.length === 0) {
      this.logger.warn({
        projectId: opts.projectId, sessionId: opts.sessionId,
        considered: openItems.length, candidates: candidateItems.length,
        prefilterUsed, payloadChars: fullPayloadJson.length,
      }, 'OpenItemMatcher: LLM lieferte 0 strukturierte Ergebnisse trotz Kandidaten — möglicher Format-/Truncation-Issue');
    }

    this.logger.info({
      projectId: opts.projectId, sessionId: opts.sessionId,
      considered: openItems.length, candidates: candidateItems.length, prefilterUsed,
      llmResults: results.length, resolved,
    }, 'OpenItemMatcher complete');
    return { matched: results.length, resolved };
  }

  /**
   * v813c — Embedding-Vorfilter. Stellt für alle Items Embeddings sicher (lazy),
   * berechnet ein Query-Embedding aus goal+milestones+files, vectorSearched die
   * Top-Treffer auf den User, filtert auf sourceType='open_item' und liefert
   * die ersten PREFILTER_TOP_N Items zurück.
   * Returns null wenn vectorSearch nicht verfügbar (SQLite ohne pgvector) →
   * der Caller macht dann einen Truncation-Fallback statt JSON-Crash.
   */
  private async prefilterByEmbedding(
    opts: { projectId: string; goal: string; milestones: string[]; changedFiles?: string[] },
    openItems: ProjectOpenItem[],
  ): Promise<ProjectOpenItem[] | null> {
    if (!this.embeddings) return null;
    // userId für embedding-scope — embeddings sind user-scoped.
    const proj = await this.projects.getByIdAnyOwner(opts.projectId).catch(() => null);
    const userId = proj?.userId;
    if (!userId) return null;

    // Lazy: Items ohne Embedding embedden (in 5er Batches damit nicht alles parallel knallt).
    const missing: ProjectOpenItem[] = [];
    for (const item of openItems) {
      const existing = await this.embeddings.repo.findBySource('open_item', item.id, userId).catch(() => undefined);
      if (!existing) missing.push(item);
    }
    if (missing.length > 0) {
      this.logger.debug({ projectId: opts.projectId, missing: missing.length }, 'v813c lazy embedding: backfilling missing item-embeddings');
      for (let i = 0; i < missing.length; i += 5) {
        const slice = missing.slice(i, i + 5);
        await Promise.all(slice.map((it) => {
          const text = `${it.title}\n${it.description ?? ''}`.slice(0, 1000);
          return this.embeddings!.service.embedAndStore(userId, text, 'open_item', it.id).catch(() => null);
        }));
      }
    }

    // Query-Embedding aus dem Run-Kontext.
    const queryText = [opts.goal, ...opts.milestones, ...(opts.changedFiles ?? [])].filter(Boolean).join('\n').slice(0, 4000);
    const queryRes = await this.llm.embed(queryText).catch(() => undefined);
    if (!queryRes?.embedding) return null;

    // vectorSearch filtert nicht nach sourceType — hoch genug ziehen und clientseitig filtern.
    const matches = await this.embeddings.repo.vectorSearch(userId, queryRes.embedding, 300);
    if (!matches) return null; // kein pgvector → Fallback

    const itemIdToObj = new Map(openItems.map((i) => [i.id, i]));
    const ordered: ProjectOpenItem[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      if (m.sourceType !== 'open_item') continue;
      if (seen.has(m.sourceId)) continue;
      const obj = itemIdToObj.get(m.sourceId);
      if (!obj) continue;
      ordered.push(obj);
      seen.add(m.sourceId);
      if (ordered.length >= PREFILTER_TOP_N) break;
    }
    // Falls vectorSearch weniger als PREFILTER_TOP_N relevante open_items lieferte:
    // mit den restlichen Items auffüllen (besser ein paar mehr als zu wenig).
    if (ordered.length < PREFILTER_TOP_N) {
      for (const item of openItems) {
        if (seen.has(item.id)) continue;
        ordered.push(item);
        if (ordered.length >= PREFILTER_TOP_N) break;
      }
    }
    return ordered;
  }
}
