import type { AsyncDbAdapter } from '@alfred/storage';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

type Urgency = 'urgent' | 'high' | 'normal' | 'low';
type HourClass = 'ACTIVE' | 'WAKING' | 'WINDING_DOWN' | 'QUIET';

/** Stale TTL per urgency — how long a deferred insight remains relevant. */
const STALE_TTL_MS: Record<Urgency, number> = {
  urgent: 0,           // never deferred
  high: 6 * 60 * 60_000,
  normal: 12 * 60 * 60_000,
  low: 24 * 60 * 60_000,
};

/** Minimum hour classification required to deliver each urgency level. */
const MIN_HOUR_CLASS: Record<Urgency, HourClass> = {
  urgent: 'QUIET',       // always deliver
  high: 'WAKING',
  normal: 'WAKING',      // WAKING reicht — ACTIVE ist zu restriktiv bei wenig Daten
  low: 'WINDING_DOWN',
};

const CLASS_ORDER: Record<HourClass, number> = { QUIET: 0, WAKING: 1, WINDING_DOWN: 2, ACTIVE: 3 };

export interface ActivityProfile {
  /** Response probability per hour (0-23). 0.0 = never responds, 1.0 = always responds. */
  hourly: number[];
  /** Hour classifications derived from probabilities. */
  classifications: HourClass[];
  /** When this profile was last computed. */
  computedAt: string;
}

/**
 * Smart delivery timing: learns when the user is active and defers
 * non-urgent insights to times with high response probability.
 */
export class DeliveryScheduler {
  private profile?: ActivityProfile;
  private readonly timezone: string;

  constructor(
    private readonly adapter: AsyncDbAdapter,
    private readonly logger: Logger,
    timezone?: string,
  ) {
    this.timezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Get current hour in the user's timezone. */
  private getHourInUserTz(): number {
    return parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: this.timezone }), 10);
  }

  /** Get hour from a UTC ISO string in the user's timezone. */
  private getHourFromIsoInUserTz(iso: string): number {
    return parseInt(new Date(iso).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: this.timezone }), 10);
  }

  /** Load cached profile from skill_state or compute fresh one. */
  async loadOrComputeProfile(userId: string): Promise<ActivityProfile> {
    // Try cached profile
    if (this.profile && (Date.now() - new Date(this.profile.computedAt).getTime()) < 24 * 60 * 60_000) {
      return this.profile;
    }

    try {
      const cached = await this.adapter.queryOne(
        "SELECT value FROM skill_state WHERE user_id = ? AND skill = 'delivery_scheduler' AND key = 'activity_profile'",
        [userId],
      ) as { value: string } | undefined;

      if (cached) {
        const parsed = JSON.parse(cached.value) as ActivityProfile;
        if (Date.now() - new Date(parsed.computedAt).getTime() < 7 * 24 * 60 * 60_000) {
          this.profile = parsed;
          return parsed;
        }
      }
    } catch { /* compute fresh */ }

    return this.computeProfile(userId);
  }

  /** Analyze 30 days of user activity → hourly response probability. */
  async computeProfile(userId: string): Promise<ActivityProfile> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();

    // Count user messages per hour
    const messageRows = await this.adapter.query(
      `SELECT created_at FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE user_id = ?
      ) AND role = 'user' AND created_at > ?`,
      [userId, since],
    ) as Array<{ created_at: string }>;

    // Count confirmation responses per hour
    const confirmRows = await this.adapter.query(
      `SELECT resolved_at, status FROM pending_confirmations WHERE chat_id = ? AND resolved_at IS NOT NULL AND created_at > ?`,
      [userId, since],
    ) as Array<{ resolved_at: string; status: string }>;

    // Bucket by hour
    const msgByHour = new Array(24).fill(0);
    for (const row of messageRows) {
      try { msgByHour[this.getHourFromIsoInUserTz(row.created_at)]++; } catch { /* skip */ }
    }

    const confirmByHour = new Array(24).fill(0);
    const expiredByHour = new Array(24).fill(0);
    for (const row of confirmRows) {
      try {
        const hour = this.getHourFromIsoInUserTz(row.resolved_at);
        if (row.status === 'approved' || row.status === 'rejected') confirmByHour[hour]++;
        else if (row.status === 'expired') expiredByHour[hour]++;
      } catch { /* skip */ }
    }

    // Compute probability per hour (messages + confirmations weighted)
    const maxMsg = Math.max(...msgByHour, 1);
    const hourly: number[] = [];
    for (let h = 0; h < 24; h++) {
      const msgProb = msgByHour[h] / maxMsg;
      const totalConfirm = confirmByHour[h] + expiredByHour[h];
      const confirmProb = totalConfirm > 0 ? confirmByHour[h] / totalConfirm : msgProb;
      // Blend: 70% message activity, 30% confirmation response rate
      hourly.push(Math.min(1, msgProb * 0.7 + confirmProb * 0.3));
    }

    // Classify hours
    const classifications: HourClass[] = hourly.map(p => {
      if (p >= 0.5) return 'ACTIVE';
      if (p >= 0.25) return 'WAKING';
      if (p >= 0.1) return 'WINDING_DOWN';
      return 'QUIET';
    });

    const profile: ActivityProfile = { hourly, classifications, computedAt: new Date().toISOString() };
    this.profile = profile;

    // Persist to skill_state
    try {
      await this.adapter.execute(
        `INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
         VALUES (?, ?, 'delivery_scheduler', 'activity_profile', ?, ?)
         ON CONFLICT (user_id, skill, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [randomUUID(), userId, JSON.stringify(profile), new Date().toISOString()],
      );
    } catch { /* non-critical */ }

    this.logger.info({ classifications: classifications.map((c, i) => `${i}h:${c}`).filter(s => !s.endsWith(':QUIET')).join(' ') }, 'Activity profile computed');
    return profile;
  }

  /** Should this insight be delivered now, or deferred? */
  shouldDeliverNow(urgency: Urgency, profile: ActivityProfile): boolean {
    if (urgency === 'urgent') return true;
    // If profile is too young (<7 days of data), always deliver (not enough data to defer)
    const profileAge = Date.now() - new Date(profile.computedAt).getTime();
    const hasActiveHours = profile.classifications.some(c => c === 'ACTIVE' || c === 'WAKING');
    if (profileAge < 3 * 24 * 60 * 60_000 && !hasActiveHours) return true; // <3 days, no active hours → deliver
    const hour = this.getHourInUserTz();
    const currentClass = profile.classifications[hour];
    const minClass = MIN_HOUR_CLASS[urgency];
    return CLASS_ORDER[currentClass] >= CLASS_ORDER[minClass];
  }

  /** Defer an insight for later delivery. */
  async defer(chatId: string, platform: string, urgency: Urgency, message: string, actions: string): Promise<void> {
    const staleTtl = STALE_TTL_MS[urgency] || STALE_TTL_MS.normal;
    const staleAt = new Date(Date.now() + staleTtl).toISOString();

    await this.adapter.execute(
      `INSERT INTO deferred_insights (id, chat_id, platform, urgency, message, actions, created_at, stale_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), chatId, platform, urgency, message, actions, new Date().toISOString(), staleAt],
    );
    this.logger.info({ urgency, chatId }, 'Insight deferred for later delivery');
  }

  /** Get pending deferred insights that are not stale. Max 5 (batching). */
  async getPendingDeferred(chatId: string): Promise<Array<{ id: string; message: string; actions: string; urgency: string; created_at: string }>> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      `SELECT id, message, actions, urgency, created_at FROM deferred_insights
       WHERE chat_id = ? AND delivered = 0 AND stale_at > ?
       ORDER BY created_at ASC LIMIT 5`,
      [chatId, now],
    ) as Array<{ id: string; message: string; actions: string; urgency: string; created_at: string }>;
    return rows;
  }

  /** Mark deferred insights as delivered. */
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.adapter.execute(
      `UPDATE deferred_insights SET delivered = 1 WHERE id IN (${placeholders})`,
      ids,
    );
  }

  /** Cleanup old deferred insights (stale or delivered). */
  async cleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM deferred_insights WHERE delivered = 1 OR stale_at < ?`,
      [cutoff],
    );
    return result.changes;
  }
}
