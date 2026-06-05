/**
 * v851 — Goal-Matcher
 *
 * Vor Plan-Erstellung (createProjectPlan) prüft dieser Matcher ob das User-
 * Goal mit bereits implementierten Features in anderen Projekten
 * korrespondiert. Wenn ja: Vorschlag im Chat "Übernehmen + adaptieren?
 * Oder neu implementieren?"
 *
 * Match-Strategie:
 *  1. Embedding/keyword-Suche über project_features (visibility-Filter via repo)
 *  2. Tech-Stack-Overlap-Filter (Jaccard >= 0.5)
 *  3. Confidence-Threshold: nur matches mit >= 0.5 confidence
 *
 * Wenn keine Matches: Goal-Matcher returns empty, Planner läuft normal.
 */

import type { ProjectFeaturesRepository, ProjectFeature } from '@alfred/storage';

export interface GoalMatchInput {
  goal: string;
  userId: string;
  /** Tech-Stack des aktuellen Projekts (für Overlap-Filter). Heuristisch detected. */
  currentTechStack?: string[];
  repo: ProjectFeaturesRepository;
  /** Optional: aktuelles Project-Id damit eigene features nicht als "match" erscheinen. */
  excludeProjectId?: string;
  /**
   * v851.1 — optional EmbeddingService. Wenn gesetzt: semantische Suche
   * über `embeddings` (sourceType='project_feature') wird ergänzend zur
   * Keyword-Suche gemacht. Cosine-Similarity-Score fließt in matchScore ein.
   */
  embeddingService?: {
    semanticSearch(userId: string, query: string, limit?: number): Promise<Array<{ category: string; key: string; value: string; score: number; }>>;
  };
}

export interface GoalMatch {
  feature: ProjectFeature;
  /** 0-1 — Stärke der Übereinstimmung. */
  matchScore: number;
  /** 0-1 — Tech-Stack-Overlap (Jaccard). */
  techStackOverlap: number;
  /** Reason-Text für UI-Display. */
  reason: string;
}

const MIN_MATCH_SCORE = 0.4;
const MIN_TECH_OVERLAP = 0.5;

export async function findGoalMatches(input: GoalMatchInput): Promise<GoalMatch[]> {
  const query = input.goal.slice(0, 500).trim();
  if (query.length < 10) return [];

  // Keyword-Suche (semantic via embeddings ist v851.1)
  // Extrahiere noun-phrases aus goal als suchterme
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Sammele matches über mehrere keyword-queries
  const candidates = new Map<string, { feature: ProjectFeature; hitCount: number; semanticScore: number }>();
  for (const kw of keywords.slice(0, 5)) {
    const features = await input.repo.search(kw, {
      userId: input.userId,
      limit: 10,
      status: 'confirmed',
    });
    for (const f of features) {
      if (input.excludeProjectId && f.projectId === input.excludeProjectId) continue;
      const ex = candidates.get(f.id);
      if (ex) ex.hitCount++;
      else candidates.set(f.id, { feature: f, hitCount: 1, semanticScore: 0 });
    }
  }

  // v851.1 — semantic search via EmbeddingService falls verfügbar.
  // Liefert features sortiert nach cosine-similarity. Ergänzt das Set
  // um IDs die keyword-search ggf. nicht erwischt hat.
  if (input.embeddingService) {
    try {
      const semanticHits = await input.embeddingService.semanticSearch(input.userId, query, 15);
      // Resolve feature-IDs (sourceId in embeddings-Tabelle ist die feature.id)
      const featureHits = semanticHits.filter(h => h.category === 'project_feature');
      const featureIds = featureHits.map(h => h.key.startsWith('p') ? h.value.split(':')[0] : h.key);
      // Embedding-Service returns key=sourceId für non-memory entries
      const idsToFetch = featureHits.map(h => {
        // EmbeddingService returns key=content.split(':')[0] OR sourceId. Wir nehmen sourceId-Pfad.
        return h.value.includes(':') ? '' : '';
      }).filter(Boolean);
      // Pragmatisch: nutze direkt h.key wenn semantic-search keyed
      // ist auf sourceId (was bei project_feature der Fall ist).
      const realIds = featureHits.map(h => h.key);
      if (realIds.length > 0) {
        const fetched = await input.repo.getByIds(realIds);
        for (const f of fetched) {
          if (input.excludeProjectId && f.projectId === input.excludeProjectId) continue;
          const score = featureHits.find(h => h.key === f.id)?.score ?? 0;
          const ex = candidates.get(f.id);
          if (ex) {
            ex.semanticScore = Math.max(ex.semanticScore, score);
          } else {
            candidates.set(f.id, { feature: f, hitCount: 0, semanticScore: score });
          }
        }
      }
    } catch { /* semantic-search ist additiv, fail silent */ }
  }

  // Score-Berechnung
  const matches: GoalMatch[] = [];
  for (const c of candidates.values()) {
    // Keyword-Score: Anzahl Keyword-Hits / Total Keywords
    const keywordScore = keywords.length > 0 ? Math.min(1, c.hitCount / keywords.length) : 0;
    // Tech-Stack-Overlap
    const techOverlap = input.currentTechStack && input.currentTechStack.length > 0
      ? jaccardSimilarity(input.currentTechStack, c.feature.techStack)
      : 1.0;
    // v851.1 — kombinierter Match-Score: keyword + semantic + confidence
    // Wenn KEIN semantic-Hit (score=0): re-normalisiere keyword + confidence
    // damit pre-embedding-Verhalten reproduziert wird (sonst fallen reine
    // Keyword-Matches systematisch durch die Schwelle).
    let matchScore: number;
    if (c.semanticScore > 0) {
      matchScore = 0.4 * keywordScore + 0.4 * c.semanticScore + 0.2 * c.feature.confidence;
    } else {
      matchScore = 0.6 * keywordScore + 0.4 * c.feature.confidence;
    }

    if (matchScore < MIN_MATCH_SCORE) continue;
    if (input.currentTechStack && input.currentTechStack.length > 0 && techOverlap < MIN_TECH_OVERLAP) continue;

    matches.push({
      feature: c.feature,
      matchScore,
      techStackOverlap: techOverlap,
      reason: c.semanticScore > 0
        ? `Hit ${c.hitCount}/${keywords.length} keywords, semantic ${(c.semanticScore * 100).toFixed(0)}%, tech ${(techOverlap * 100).toFixed(0)}%`
        : `Hit ${c.hitCount}/${keywords.length} keywords, tech-overlap ${(techOverlap * 100).toFixed(0)}%`,
    });
  }

  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches.slice(0, 3);
}

/**
 * Naive keyword extraction: lowercase, split, remove stopwords + short tokens.
 */
function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'der', 'die', 'das', 'und', 'oder', 'in', 'im', 'mit', 'für', 'auf',
    'a', 'an', 'the', 'and', 'or', 'in', 'on', 'with', 'for', 'of', 'to', 'is', 'are',
    'this', 'that', 'be', 'do', 'have', 'has', 'will', 'would', 'could',
    'eine', 'einen', 'einer', 'eines', 'ist', 'sind', 'war', 'waren', 'wird',
    'kann', 'soll', 'muss', 'will', 'als', 'wie', 'aus', 'von', 'bei', 'nach',
    'project', 'projekt', 'fix', 'bug', 'feature', 'implementiere', 'baue', 'erstelle',
  ]);
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !stopwords.has(t));
  return Array.from(new Set(tokens));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  let intersect = 0;
  for (const v of setA) if (setB.has(v)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union > 0 ? intersect / union : 0;
}
