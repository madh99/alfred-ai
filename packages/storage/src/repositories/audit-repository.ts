import type { AsyncDbAdapter } from '../db-adapter.js';
import type { AuditEntry, RiskLevel, RuleEffect } from '@alfred/types';

export class AuditRepository {
  private readonly adapter: AsyncDbAdapter;

  constructor(adapter: AsyncDbAdapter) {
    this.adapter = adapter;
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.adapter.execute(`
      INSERT INTO audit_log (id, timestamp, user_id, action, risk_level, rule_id, effect, platform, chat_id, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id,
      entry.timestamp.toISOString(),
      entry.userId,
      entry.action,
      entry.riskLevel,
      entry.ruleId ?? null,
      entry.effect,
      entry.platform,
      entry.chatId ?? null,
      entry.context ? JSON.stringify(entry.context) : null,
    ]);
  }

  async query(filters: { userId?: string; action?: string; effect?: string; limit?: number }): Promise<AuditEntry[]> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (filters.userId) {
      conditions.push('user_id = ?');
      values.push(filters.userId);
    }
    if (filters.action) {
      conditions.push('action = ?');
      values.push(filters.action);
    }
    if (filters.effect) {
      conditions.push('effect = ?');
      values.push(filters.effect);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    values.push(limit);

    const rows = await this.adapter.query(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`,
      values
    ) as Record<string, string>[];

    return rows.map((row) => this.mapRow(row));
  }

  async count(filters: { userId?: string; effect?: string }): Promise<number> {
    const conditions: string[] = [];
    const values: string[] = [];

    if (filters.userId) {
      conditions.push('user_id = ?');
      values.push(filters.userId);
    }
    if (filters.effect) {
      conditions.push('effect = ?');
      values.push(filters.effect);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const row = await this.adapter.queryOne(
      `SELECT COUNT(*) as count FROM audit_log ${where}`,
      values
    ) as { count: number };

    return row.count;
  }

  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = await this.adapter.execute(
      'DELETE FROM audit_log WHERE timestamp < ?',
      [cutoff]
    );
    return result.changes;
  }

  private mapRow(row: Record<string, string>): AuditEntry {
    return {
      id: row.id,
      timestamp: new Date(row.timestamp),
      userId: row.user_id,
      action: row.action,
      riskLevel: row.risk_level as RiskLevel,
      ruleId: row.rule_id ?? undefined,
      effect: row.effect as RuleEffect,
      platform: row.platform,
      chatId: row.chat_id ?? undefined,
      context: row.context ? JSON.parse(row.context) : undefined,
    };
  }
}
