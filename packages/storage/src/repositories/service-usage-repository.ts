import type { AsyncDbAdapter } from '../db-adapter.js';

export interface ServiceUsageEntry {
  date: string;
  service: string;
  model: string;
  calls: number;
  units: number;
  unitType: string;
  costUsd: number;
  userId: string;
}

/** Pricing per unit for non-token services. */
const SERVICE_PRICING: Record<string, { costPer: number; unitSize: number; unitType: string }> = {
  'voxtral-mini-tts-2603': { costPer: 0.016, unitSize: 1_000, unitType: 'characters' },
  'voxtral-mini-latest': { costPer: 0.003, unitSize: 1, unitType: 'minutes' },
  'voxtral-mini-2602': { costPer: 0.003, unitSize: 1, unitType: 'minutes' },
  'mistral-ocr-latest': { costPer: 2.00, unitSize: 1_000, unitType: 'pages' },
  'mistral-moderation-latest': { costPer: 0.10, unitSize: 1_000_000, unitType: 'tokens' },
  'mistral-moderation-2603': { costPer: 0.10, unitSize: 1_000_000, unitType: 'tokens' },
  'omni-moderation-latest': { costPer: 0, unitSize: 1, unitType: 'tokens' }, // OpenAI moderation is free
  'whisper-1': { costPer: 0.006, unitSize: 1, unitType: 'minutes' }, // OpenAI Whisper
};

export class ServiceUsageRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /** Calculate cost for a given model and unit count. */
  static calculateCost(model: string, units: number): number {
    const pricing = SERVICE_PRICING[model];
    if (!pricing || pricing.costPer === 0) return 0;
    return (units / pricing.unitSize) * pricing.costPer;
  }

  /** Get the unit type for a model. */
  static getUnitType(model: string): string {
    return SERVICE_PRICING[model]?.unitType ?? 'units';
  }

  /** Record a service usage event (UPSERT — aggregates per day+service+model+user). */
  async record(service: string, model: string, units: number, userId?: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const unitType = ServiceUsageRepository.getUnitType(model);
    const cost = ServiceUsageRepository.calculateCost(model, units);
    const uid = userId ?? '';

    await this.adapter.execute(`
      INSERT INTO service_usage (date, service, model, calls, units, unit_type, cost_usd, user_id)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (date, service, model, user_id) DO UPDATE SET
        calls = service_usage.calls + 1,
        units = service_usage.units + excluded.units,
        cost_usd = service_usage.cost_usd + excluded.cost_usd
    `, [date, service, model, units, unitType, cost, uid]);
  }

  /** Get daily aggregated service usage. */
  async getDaily(date: string): Promise<ServiceUsageEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM service_usage WHERE date = ? AND user_id = ?',
      [date, ''],
    ) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  /** Get service usage over a date range. */
  async getRange(from: string, to: string): Promise<ServiceUsageEntry[]> {
    const rows = await this.adapter.query(
      'SELECT service, model, SUM(calls) as calls, SUM(units) as units, unit_type, SUM(cost_usd) as cost_usd FROM service_usage WHERE date >= ? AND date <= ? AND user_id = ? GROUP BY service, model, unit_type ORDER BY cost_usd DESC',
      [from, to, ''],
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      date: from,
      service: r.service as string,
      model: r.model as string,
      calls: Number(r.calls),
      units: Number(r.units),
      unitType: r.unit_type as string,
      costUsd: Number(r.cost_usd),
      userId: '',
    }));
  }

  /** Get all-time totals per service/model. */
  async getTotal(): Promise<ServiceUsageEntry[]> {
    const rows = await this.adapter.query(
      'SELECT service, model, SUM(calls) as calls, SUM(units) as units, unit_type, SUM(cost_usd) as cost_usd FROM service_usage WHERE user_id = ? GROUP BY service, model, unit_type ORDER BY cost_usd DESC',
      [''],
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      date: '',
      service: r.service as string,
      model: r.model as string,
      calls: Number(r.calls),
      units: Number(r.units),
      unitType: r.unit_type as string,
      costUsd: Number(r.cost_usd),
      userId: '',
    }));
  }

  private map(row: Record<string, unknown>): ServiceUsageEntry {
    return {
      date: row.date as string,
      service: row.service as string,
      model: row.model as string,
      calls: Number(row.calls),
      units: Number(row.units),
      unitType: row.unit_type as string,
      costUsd: Number(row.cost_usd),
      userId: row.user_id as string,
    };
  }
}
