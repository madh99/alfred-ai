import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface TravelPlan {
  id: string;
  userId: string;
  destination: string;
  dateFrom: string;
  dateTo: string;
  budget?: number;
  budgetSpent: number;
  travelers: number;
  status: 'draft' | 'booked' | 'completed' | 'cancelled';
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TravelPlanItem {
  id: string;
  planId: string;
  type: 'flight' | 'hotel' | 'car' | 'activity';
  title: string;
  dateFrom?: string;
  dateTo?: string;
  price?: number;
  currency: string;
  detailsJson?: string;
  bookingRef?: string;
  status: string;
  sortOrder: number;
  createdAt: string;
}

export class TravelPlanRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(
    userId: string,
    plan: { destination: string; dateFrom: string; dateTo: string; budget?: number; travelers?: number; notes?: string },
  ): Promise<TravelPlan> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.adapter.execute(
      'INSERT INTO travel_plans (id, user_id, destination, date_from, date_to, budget, travelers, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, plan.destination, plan.dateFrom, plan.dateTo, plan.budget ?? null, plan.travelers ?? 1, plan.notes ?? null, now, now],
    );

    return {
      id, userId, destination: plan.destination, dateFrom: plan.dateFrom, dateTo: plan.dateTo,
      budget: plan.budget, budgetSpent: 0, travelers: plan.travelers ?? 1,
      status: 'draft', notes: plan.notes, createdAt: now, updatedAt: now,
    };
  }

  async get(planId: string): Promise<(TravelPlan & { items: TravelPlanItem[] }) | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM travel_plans WHERE id = ?', [planId]) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const plan = this.mapPlan(row);
    const items = await this.getItems(planId);
    return { ...plan, items };
  }

  async list(userId: string, status?: string): Promise<TravelPlan[]> {
    let sql = 'SELECT * FROM travel_plans WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY date_from ASC';
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => this.mapPlan(r));
  }

  async update(planId: string, fields: Partial<Pick<TravelPlan, 'destination' | 'dateFrom' | 'dateTo' | 'budget' | 'travelers' | 'status' | 'notes'>>): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      sets.push(`${col} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return false;

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(planId);

    const result = await this.adapter.execute(
      `UPDATE travel_plans SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
    return result.changes > 0;
  }

  async delete(planId: string): Promise<boolean> {
    // Items are deleted by CASCADE
    const result = await this.adapter.execute('DELETE FROM travel_plans WHERE id = ?', [planId]);
    return result.changes > 0;
  }

  async addItem(
    planId: string,
    item: { type: string; title: string; dateFrom?: string; dateTo?: string; price?: number; currency?: string; detailsJson?: string; bookingRef?: string; sortOrder?: number },
  ): Promise<TravelPlanItem> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.adapter.execute(
      'INSERT INTO travel_plan_items (id, plan_id, type, title, date_from, date_to, price, currency, details_json, booking_ref, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, planId, item.type, item.title, item.dateFrom ?? null, item.dateTo ?? null, item.price ?? null, item.currency ?? 'EUR', item.detailsJson ?? null, item.bookingRef ?? null, item.sortOrder ?? 0, now],
    );

    // Update budget_spent
    await this.updateBudgetSpent(planId);

    return {
      id, planId, type: item.type as TravelPlanItem['type'], title: item.title,
      dateFrom: item.dateFrom, dateTo: item.dateTo, price: item.price,
      currency: item.currency ?? 'EUR', detailsJson: item.detailsJson,
      bookingRef: item.bookingRef, status: 'planned', sortOrder: item.sortOrder ?? 0, createdAt: now,
    };
  }

  async getItems(planId: string): Promise<TravelPlanItem[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM travel_plan_items WHERE plan_id = ? ORDER BY sort_order, created_at',
      [planId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapItem(r));
  }

  async removeItem(itemId: string): Promise<boolean> {
    // Get plan_id before deleting to update budget
    const item = await this.adapter.queryOne('SELECT plan_id FROM travel_plan_items WHERE id = ?', [itemId]) as Record<string, unknown> | undefined;
    const result = await this.adapter.execute('DELETE FROM travel_plan_items WHERE id = ?', [itemId]);
    if (result.changes > 0 && item) {
      await this.updateBudgetSpent(item.plan_id as string);
    }
    return result.changes > 0;
  }

  async updateBudgetSpent(planId: string): Promise<void> {
    const row = await this.adapter.queryOne(
      'SELECT COALESCE(SUM(price), 0) as total FROM travel_plan_items WHERE plan_id = ?',
      [planId],
    ) as Record<string, unknown> | undefined;
    const total = Number(row?.total ?? 0);
    await this.adapter.execute(
      'UPDATE travel_plans SET budget_spent = ?, updated_at = ? WHERE id = ?',
      [total, new Date().toISOString(), planId],
    );
  }

  private mapPlan(r: Record<string, unknown>): TravelPlan {
    return {
      id: r.id as string,
      userId: (r.user_id ?? r.userId) as string,
      destination: r.destination as string,
      dateFrom: (r.date_from ?? r.dateFrom) as string,
      dateTo: (r.date_to ?? r.dateTo) as string,
      budget: r.budget != null ? Number(r.budget) : undefined,
      budgetSpent: Number(r.budget_spent ?? r.budgetSpent ?? 0),
      travelers: Number(r.travelers ?? 1),
      status: r.status as TravelPlan['status'],
      notes: (r.notes as string) || undefined,
      createdAt: (r.created_at ?? r.createdAt) as string,
      updatedAt: (r.updated_at ?? r.updatedAt) as string,
    };
  }

  private mapItem(r: Record<string, unknown>): TravelPlanItem {
    return {
      id: r.id as string,
      planId: (r.plan_id ?? r.planId) as string,
      type: r.type as TravelPlanItem['type'],
      title: r.title as string,
      dateFrom: (r.date_from ?? r.dateFrom) as string | undefined,
      dateTo: (r.date_to ?? r.dateTo) as string | undefined,
      price: r.price != null ? Number(r.price) : undefined,
      currency: (r.currency as string) ?? 'EUR',
      detailsJson: (r.details_json ?? r.detailsJson) as string | undefined,
      bookingRef: (r.booking_ref ?? r.bookingRef) as string | undefined,
      status: (r.status as string) ?? 'planned',
      sortOrder: Number(r.sort_order ?? r.sortOrder ?? 0),
      createdAt: (r.created_at ?? r.createdAt) as string,
    };
  }
}
