import type { Logger } from 'pino';
import type { InsightsRepository, InsightCandidate } from '@alfred/storage';

export interface DomainAdapter {
  readonly name: string;
  generate(ctx: AdapterContext): Promise<InsightCandidate[]>;
}

export interface AdapterContext {
  userId: string;
  /** Linked user IDs (Telegram + Matrix + Discord etc.). The adapters can use these for
   *  per-platform lookups while staying scoped to the owner. */
  linkedUserIds: string[];
  logger: Logger;
}

/**
 * v638 — Insight-Engine: Cross-Domain-Reflector.
 *
 * Sammelt periodisch von allen registrierten DomainAdaptern Insight-Candidates ein und
 * persistiert sie über das InsightsRepository. Dedup per `dedupeKey` (Adapter-Verantwortung).
 *
 * Adapter sind dünn und domänen-spezifisch — sie kennen ihre Quell-Daten und produzieren
 * normalisierte Candidates. Die Engine entscheidet nichts inhaltlich.
 */
export class InsightEngine {
  private readonly adapters: DomainAdapter[] = [];

  constructor(
    private readonly repo: InsightsRepository,
    private readonly logger: Logger,
  ) {}

  register(adapter: DomainAdapter): void {
    this.adapters.push(adapter);
    this.logger.debug({ adapter: adapter.name }, 'InsightEngine: adapter registered');
  }

  /**
   * One sweep — run all adapters in parallel (with isolation), upsert candidates,
   * expire stale + reactivate due snoozes. Returns aggregated counts for telemetry.
   */
  async sweep(ctx: AdapterContext): Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }> {
    // Housekeeping first
    try { await this.repo.expireSnoozes(ctx.userId); } catch { /* non-critical */ }
    try { await this.repo.expireStale(ctx.userId, 21); } catch { /* non-critical */ }

    const perAdapter: Record<string, number> = {};
    const errors: string[] = [];
    let inserted = 0;
    let refreshed = 0;

    const results = await Promise.allSettled(
      this.adapters.map(async (a) => {
        try {
          const candidates = await a.generate(ctx);
          perAdapter[a.name] = candidates.length;
          for (const c of candidates) {
            try {
              const r = await this.repo.upsertCandidate(ctx.userId, c);
              if (r.inserted) inserted++;
              else refreshed++;
            } catch (err) {
              this.logger.warn({ err, adapter: a.name }, 'Insight upsert failed');
            }
          }
        } catch (err) {
          errors.push(`${a.name}: ${(err as Error).message}`);
          this.logger.warn({ err, adapter: a.name }, 'Adapter execution failed');
        }
      }),
    );
    void results;

    this.logger.info({ inserted, refreshed, adapters: perAdapter, errors: errors.length }, 'Insight sweep complete');
    return { inserted, refreshed, perAdapter, errors };
  }

  listRegistered(): string[] {
    return this.adapters.map(a => a.name);
  }
}
