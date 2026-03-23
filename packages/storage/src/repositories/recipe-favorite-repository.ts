import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface RecipeFavorite {
  id: string;
  userId: string;
  recipeId: string;
  source: string;
  title: string;
  imageUrl?: string;
  prepTimeMinutes?: number;
  servings?: number;
  tags?: string[];
  nutritionSummary?: { calories?: number; protein?: number; carbs?: number; fat?: number };
  ingredientsJson?: string;
  createdAt: string;
}

export class RecipeFavoriteRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async add(
    userId: string,
    recipe: Omit<RecipeFavorite, 'id' | 'userId' | 'createdAt'>,
  ): Promise<RecipeFavorite> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const tags = recipe.tags ? JSON.stringify(recipe.tags) : null;
    const nutritionSummary = recipe.nutritionSummary ? JSON.stringify(recipe.nutritionSummary) : null;

    await this.adapter.execute(
      'INSERT INTO recipe_favorites (id, user_id, recipe_id, source, title, image_url, prep_time_minutes, servings, tags, nutrition_summary, ingredients_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, recipe.recipeId, recipe.source, recipe.title, recipe.imageUrl ?? null, recipe.prepTimeMinutes ?? null, recipe.servings ?? null, tags, nutritionSummary, recipe.ingredientsJson ?? null, now],
    );

    return {
      id,
      userId,
      recipeId: recipe.recipeId,
      source: recipe.source,
      title: recipe.title,
      imageUrl: recipe.imageUrl,
      prepTimeMinutes: recipe.prepTimeMinutes,
      servings: recipe.servings,
      tags: recipe.tags,
      nutritionSummary: recipe.nutritionSummary,
      ingredientsJson: recipe.ingredientsJson,
      createdAt: now,
    };
  }

  async list(userId: string): Promise<RecipeFavorite[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM recipe_favorites WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async get(userId: string, recipeId: string): Promise<RecipeFavorite | null> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM recipe_favorites WHERE user_id = ? AND recipe_id = ?',
      [userId, recipeId],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async remove(userId: string, recipeId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM recipe_favorites WHERE user_id = ? AND recipe_id = ?',
      [userId, recipeId],
    );
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): RecipeFavorite {
    let tags: string[] | undefined;
    if (row.tags && typeof row.tags === 'string') {
      try { tags = JSON.parse(row.tags); } catch { tags = undefined; }
    }

    let nutritionSummary: RecipeFavorite['nutritionSummary'];
    if (row.nutrition_summary && typeof row.nutrition_summary === 'string') {
      try { nutritionSummary = JSON.parse(row.nutrition_summary); } catch { nutritionSummary = undefined; }
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      recipeId: row.recipe_id as string,
      source: row.source as string,
      title: row.title as string,
      imageUrl: row.image_url as string | undefined,
      prepTimeMinutes: row.prep_time_minutes != null ? Number(row.prep_time_minutes) : undefined,
      servings: row.servings != null ? Number(row.servings) : undefined,
      tags,
      nutritionSummary,
      ingredientsJson: row.ingredients_json as string | undefined,
      createdAt: row.created_at as string,
    };
  }
}
