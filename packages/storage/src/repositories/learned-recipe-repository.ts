import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v722 — LearnedRecipe: maschinen-lesbare "wie macht Alfred X" Rezepte,
 * die der Reasoning-Engine VOR jedem LLM-Call präsentiert werden.
 *
 * Ersetzt prosaisch-aussehende Auto-Rule-Memories ("merke dir wie du
 * Radio-GÖD startest") durch strukturierte action_sequences die direkt
 * ausführbar sind.
 *
 * Quellen:
 *  - RefusalCorrectionReflector (skill verweigert → User korrigiert → Skill funktioniert)
 *  - Skill-Result-Augmentation (leere Result → Memory-Hint nutzte → success)
 *  - User-Confirmation "soll ich mir das merken" → memory.learn_recipe Action
 */
export interface LearnedRecipe {
  id: string;
  userId: string;
  /** Was der User typischerweise sagt: "starte radio göd", "spiel ö1 dab+". */
  triggerPhrase: string;
  /** Pre-tokenized Keywords (lowercase, ≥4 chars) für schnelles Matching im Reasoning-Pre-Hook. */
  triggerKeywords: string[];
  /** Strukturierte Skill-Action-Sequenz (JSON). Direkt ausführbar via processActions. */
  actionSequence: RecipeAction[];
  /** Optionaler Kontext-Hint für Prompt-Inclusion ("Stream-URL aus Memory radio_stream_oe1"). */
  contextHint?: string;
  /** 0..1 — initial 0.5, +0.1 pro Success, -0.2 pro Fail, ≥0.95 = auto-execute ohne LLM-Pass. */
  confidence: number;
  /** Wo das Rezept herkam. */
  source: 'refusal_correction' | 'skill_result_augmentation' | 'manual' | 'audit';
  successCount: number;
  failCount: number;
  lastUsedAt?: string;
  /** Wenn gesetzt: Rezept ist invalidiert (User-Reject ODER Audit). */
  invalidatedAt?: string;
  /** Wenn gesetzt: ID des Rezepts das dieses ersetzt. */
  supersededBy?: string;
  createdAt: string;
}

export interface RecipeAction {
  skill: string;
  action?: string;
  params: Record<string, unknown>;
  /** Optional: vorheriger Step muss success returned haben. */
  requiresPreviousSuccess?: boolean;
}

export interface CreateRecipeInput {
  userId: string;
  triggerPhrase: string;
  triggerKeywords: string[];
  actionSequence: RecipeAction[];
  contextHint?: string;
  source: LearnedRecipe['source'];
  confidence?: number;
}

export class LearnedRecipeRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: CreateRecipeInput): Promise<LearnedRecipe> {
    // v1147 — P2: zentrale Validierung für ALLE Schreiber (memory.learn_recipe
    // UND die Auto-Extraktion). Das v722-Feature hatte in Monaten genau EINEN
    // Eintrag produziert — mit leerer Trigger-Phrase, den der Pipeline-Matcher
    // nie finden konnte. Kaputte Rezepte sind schlimmer als keine.
    if (!input.triggerPhrase || input.triggerPhrase.trim().length < 5) {
      throw new Error('Recipe abgelehnt: trigger_phrase fehlt oder ist zu kurz (min. 5 Zeichen) — ohne sie kann das Rezept nie matchen.');
    }
    if (!Array.isArray(input.actionSequence) || input.actionSequence.length === 0
      || input.actionSequence.some(s => !s || typeof (s as { skill?: unknown }).skill !== 'string')) {
      throw new Error('Recipe abgelehnt: action_sequence muss ein nicht-leeres Array von {skill, action?, params}-Schritten sein.');
    }
    if (!Array.isArray(input.triggerKeywords) || input.triggerKeywords.length === 0) {
      input = { ...input, triggerKeywords: input.triggerPhrase.toLowerCase().split(/\s+/).filter(w => w.length >= 3) };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = input.confidence ?? 0.5;
    await this.adapter.execute(
      `INSERT INTO learned_recipes
       (id, user_id, trigger_phrase, trigger_keywords, action_sequence, context_hint, confidence, source, success_count, fail_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id, input.userId, input.triggerPhrase,
        JSON.stringify(input.triggerKeywords),
        JSON.stringify(input.actionSequence),
        input.contextHint ?? null,
        confidence, input.source, now,
      ],
    );
    return {
      id, userId: input.userId,
      triggerPhrase: input.triggerPhrase,
      triggerKeywords: input.triggerKeywords,
      actionSequence: input.actionSequence,
      contextHint: input.contextHint,
      confidence, source: input.source,
      successCount: 0, failCount: 0,
      createdAt: now,
    };
  }

  async getById(id: string): Promise<LearnedRecipe | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM learned_recipes WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Reasoning-Pre-Hook: Findet aktive Rezepte deren Keywords im User-Text matchen.
   * Sortiert nach confidence DESC, success_count DESC.
   * Threshold: min 1 Keyword muss matchen (wir filtern weiter im Pre-Hook auf Score).
   */
  async findMatching(userId: string, userText: string, limit = 5): Promise<LearnedRecipe[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM learned_recipes
       WHERE user_id = ? AND invalidated_at IS NULL
       ORDER BY confidence DESC, success_count DESC
       LIMIT 50`,
      [userId],
    ) as Array<Record<string, unknown>>;
    const lc = userText.toLowerCase();
    const scored = rows.map(r => {
      const recipe = this.mapRow(r);
      const matches = recipe.triggerKeywords.filter(k => lc.includes(k));
      return { recipe, score: matches.length, matchedKeywords: matches };
    }).filter(s => s.score > 0);
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.recipe.confidence - a.recipe.confidence;
    });
    return scored.slice(0, limit).map(s => s.recipe);
  }

  async list(userId: string, opts?: { includeInvalidated?: boolean; limit?: number }): Promise<LearnedRecipe[]> {
    const limit = opts?.limit ?? 100;
    const where = opts?.includeInvalidated
      ? 'user_id = ?'
      : 'user_id = ? AND invalidated_at IS NULL';
    const rows = await this.adapter.query(
      `SELECT * FROM learned_recipes WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      [userId, limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async recordSuccess(id: string): Promise<void> {
    const now = new Date().toISOString();
    const r = await this.getById(id);
    if (!r) return;
    const newConf = Math.min(1, r.confidence + 0.1);
    await this.adapter.execute(
      `UPDATE learned_recipes
       SET success_count = success_count + 1, last_used_at = ?, confidence = ?
       WHERE id = ?`,
      [now, newConf, id],
    );
  }

  async recordFail(id: string): Promise<void> {
    const now = new Date().toISOString();
    const r = await this.getById(id);
    if (!r) return;
    const newConf = Math.max(0, r.confidence - 0.2);
    await this.adapter.execute(
      `UPDATE learned_recipes
       SET fail_count = fail_count + 1, last_used_at = ?, confidence = ?
       WHERE id = ?`,
      [now, newConf, id],
    );
    // Auto-invalidate bei zu vielen Fails
    if (r.failCount + 1 >= 3 && newConf < 0.2) {
      await this.invalidate(id);
    }
  }

  async invalidate(id: string, supersededBy?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      `UPDATE learned_recipes SET invalidated_at = ?, superseded_by = ? WHERE id = ?`,
      [now, supersededBy ?? null, id],
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.adapter.execute(`DELETE FROM learned_recipes WHERE id = ?`, [id]);
  }

  private mapRow(row: Record<string, unknown>): LearnedRecipe {
    let triggerKeywords: string[] = [];
    let actionSequence: RecipeAction[] = [];
    try { triggerKeywords = JSON.parse(row.trigger_keywords as string); } catch { /* empty */ }
    try { actionSequence = JSON.parse(row.action_sequence as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      triggerPhrase: row.trigger_phrase as string,
      triggerKeywords,
      actionSequence,
      contextHint: (row.context_hint as string | null) ?? undefined,
      confidence: row.confidence as number,
      source: row.source as LearnedRecipe['source'],
      successCount: (row.success_count as number | null) ?? 0,
      failCount: (row.fail_count as number | null) ?? 0,
      lastUsedAt: (row.last_used_at as string | null) ?? undefined,
      invalidatedAt: (row.invalidated_at as string | null) ?? undefined,
      supersededBy: (row.superseded_by as string | null) ?? undefined,
      createdAt: row.created_at as string,
    };
  }
}
