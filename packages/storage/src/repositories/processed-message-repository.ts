/**
 * Message dedup for HA Active-Active.
 * Each inbound message is claimed by exactly one node via INSERT ON CONFLICT.
 */
import type { AsyncDbAdapter } from '../db-adapter.js';

export class ProcessedMessageRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /**
   * Try to claim a message for processing.
   * Returns true if this node claimed it (should process).
   * Returns false if another node already claimed it (skip).
   */
  async markProcessed(messageKey: string, nodeId: string, ttlHours = 24): Promise<boolean> {
    // On SQLite single-instance: always return true (no dedup needed)
    if (this.adapter.type === 'sqlite') return true;

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    const result = await this.adapter.execute(
      `INSERT INTO processed_messages (message_key, node_id, processed_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (message_key) DO NOTHING`,
      [messageKey, nodeId, now, expiresAt],
    );
    return result.changes > 0;
  }

  /** Remove expired entries. */
  async cleanup(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      'DELETE FROM processed_messages WHERE expires_at < ?',
      [now],
    );
    return result.changes;
  }
}
