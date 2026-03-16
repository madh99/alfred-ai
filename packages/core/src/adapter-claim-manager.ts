/**
 * Adapter Claim Manager — coordinates which node runs which messaging adapter.
 * Uses PostgreSQL for atomic claims. Each adapter (telegram, discord, etc.)
 * is claimed by exactly one node at a time.
 *
 * In single-instance mode (SQLite): all adapters connect immediately.
 */
import type { AsyncDbAdapter } from '@alfred/storage';
import type { Logger } from 'pino';

export class AdapterClaimManager {
  private renewTimer?: ReturnType<typeof setInterval>;
  private checkTimer?: ReturnType<typeof setInterval>;
  private readonly claimedPlatforms = new Set<string>();
  private readonly claimTtlMs: number;
  private onClaimAcquired?: (platform: string) => void;

  constructor(
    private readonly adapter: AsyncDbAdapter,
    private readonly nodeId: string,
    private readonly logger: Logger,
    claimTtlMs = 60_000,
  ) {
    this.claimTtlMs = claimTtlMs;
  }

  /** Set callback for when a new adapter claim is acquired. */
  onAcquired(callback: (platform: string) => void): void {
    this.onClaimAcquired = callback;
  }

  /**
   * Try to claim an adapter. Returns true if this node owns it.
   */
  async tryClaim(platform: string): Promise<boolean> {
    // SQLite: always claim (single instance)
    if (this.adapter.type === 'sqlite') {
      this.claimedPlatforms.add(platform);
      return true;
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.claimTtlMs).toISOString();

    // Try to insert or take over expired claim
    const result = await this.adapter.execute(
      `INSERT INTO adapter_claims (platform, node_id, claimed_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (platform) DO UPDATE
       SET node_id = excluded.node_id, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
       WHERE adapter_claims.expires_at < ?`,
      [platform, this.nodeId, now, expiresAt, now],
    );

    if (result.changes > 0) {
      this.claimedPlatforms.add(platform);
      return true;
    }

    // Check if we already own it
    const existing = await this.adapter.queryOne(
      'SELECT node_id FROM adapter_claims WHERE platform = ? AND node_id = ?',
      [platform, this.nodeId],
    );
    if (existing) {
      this.claimedPlatforms.add(platform);
      return true;
    }

    return false;
  }

  /**
   * Start renewal (extend our claims) and check (acquire orphaned claims).
   */
  start(): void {
    // Renew our claims every claimTtl/2
    this.renewTimer = setInterval(() => this.renewClaims(), this.claimTtlMs / 2);

    // Check for expired claims every 15s
    this.checkTimer = setInterval(() => this.checkExpiredClaims(), 15_000);
  }

  stop(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.releaseClaims().catch(() => {});
  }

  /** Extend our active claims. */
  private async renewClaims(): Promise<void> {
    if (this.claimedPlatforms.size === 0 || this.adapter.type === 'sqlite') return;

    const expiresAt = new Date(Date.now() + this.claimTtlMs).toISOString();
    for (const platform of this.claimedPlatforms) {
      try {
        await this.adapter.execute(
          'UPDATE adapter_claims SET expires_at = ? WHERE platform = ? AND node_id = ?',
          [expiresAt, platform, this.nodeId],
        );
      } catch (err) {
        this.logger.warn({ err, platform }, 'Failed to renew adapter claim');
      }
    }
  }

  /** Check for expired claims from dead nodes and acquire them. */
  private async checkExpiredClaims(): Promise<void> {
    if (this.adapter.type === 'sqlite') return;

    try {
      const now = new Date().toISOString();
      const expired = await this.adapter.query(
        'SELECT platform FROM adapter_claims WHERE expires_at < ?',
        [now],
      );

      for (const row of expired) {
        const platform = row.platform as string;
        if (this.claimedPlatforms.has(platform)) continue;

        const claimed = await this.tryClaim(platform);
        if (claimed) {
          this.logger.info({ platform, nodeId: this.nodeId }, 'Acquired adapter claim from dead node');
          this.onClaimAcquired?.(platform);
        }
      }
    } catch (err) {
      this.logger.debug({ err }, 'Adapter claim check failed');
    }
  }

  /** Release all claims on shutdown. */
  private async releaseClaims(): Promise<void> {
    if (this.adapter.type === 'sqlite') return;

    for (const platform of this.claimedPlatforms) {
      try {
        await this.adapter.execute(
          'DELETE FROM adapter_claims WHERE platform = ? AND node_id = ?',
          [platform, this.nodeId],
        );
      } catch { /* best effort */ }
    }
    this.claimedPlatforms.clear();
  }

  /** Check if this node owns a specific adapter. */
  owns(platform: string): boolean {
    return this.claimedPlatforms.has(platform);
  }
}
