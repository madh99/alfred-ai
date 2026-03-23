import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface MealPlanEntry {
  id: string;
  userId: string;
  week: string;
  day: string;
  meal: string;
  recipeId?: string;
  source?: string;
  title: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export class MealPlanRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async setMeal(
    userId: string,
    week: string,
    day: string,
    meal: string,
    entry: { recipeId?: string; source?: string; title: string; notes?: string },
  ): Promise<MealPlanEntry> {
    const now = new Date().toISOString();
    const id = randomUUID();

    if (this.adapter.type === 'postgres') {
      await this.adapter.execute(
        `INSERT INTO meal_plans (id, user_id, week, day, meal, recipe_id, source, title, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, week, day, meal) DO UPDATE SET
           recipe_id = EXCLUDED.recipe_id,
           source = EXCLUDED.source,
           title = EXCLUDED.title,
           notes = EXCLUDED.notes,
           updated_at = EXCLUDED.updated_at`,
        [id, userId, week, day, meal, entry.recipeId ?? null, entry.source ?? null, entry.title, entry.notes ?? null, now, now],
      );
    } else {
      await this.adapter.execute(
        `INSERT OR REPLACE INTO meal_plans (id, user_id, week, day, meal, recipe_id, source, title, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, week, day, meal, entry.recipeId ?? null, entry.source ?? null, entry.title, entry.notes ?? null, now, now],
      );
    }

    return {
      id,
      userId,
      week,
      day,
      meal,
      recipeId: entry.recipeId,
      source: entry.source,
      title: entry.title,
      notes: entry.notes,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getWeek(userId: string, week: string): Promise<MealPlanEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM meal_plans WHERE user_id = ? AND week = ? ORDER BY day, meal',
      [userId, week],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getDay(userId: string, week: string, day: string): Promise<MealPlanEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM meal_plans WHERE user_id = ? AND week = ? AND day = ? ORDER BY day, meal',
      [userId, week, day],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async deleteMeal(userId: string, week: string, day: string, meal: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM meal_plans WHERE user_id = ? AND week = ? AND day = ? AND meal = ?',
      [userId, week, day, meal],
    );
    return result.changes > 0;
  }

  async deleteWeek(userId: string, week: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM meal_plans WHERE user_id = ? AND week = ?',
      [userId, week],
    );
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): MealPlanEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      week: row.week as string,
      day: row.day as string,
      meal: row.meal as string,
      recipeId: row.recipe_id as string | undefined,
      source: row.source as string | undefined,
      title: row.title as string,
      notes: row.notes as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
