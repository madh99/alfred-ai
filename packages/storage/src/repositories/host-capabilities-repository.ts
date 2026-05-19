import type { AsyncDbAdapter } from '../db-adapter.js';

/**
 * v608 F6 — Persisted host facts (e.g. compose variant) that survive restarts.
 *
 * Replaces the in-memory `composeVariantCache` in the Deploy skill so we don't
 * re-probe a host every cluster failover. Generic key/value to also fit future
 * facts like "runtime=python3.11", "has_systemd=true", etc.
 */
export class HostCapabilitiesRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async get(host: string, user: string, key: string): Promise<string | null | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT value FROM host_capabilities WHERE host = ? AND user_name = ? AND key = ?`,
      [host, user, key],
    ) as { value: string | null } | undefined;
    if (!row) return undefined;
    return row.value;
  }

  async set(host: string, user: string, key: string, value: string | null): Promise<void> {
    const now = new Date().toISOString();
    const upd = await this.adapter.execute(
      `UPDATE host_capabilities SET value = ?, probed_at = ? WHERE host = ? AND user_name = ? AND key = ?`,
      [value, now, host, user, key],
    );
    if (upd.changes === 0) {
      try {
        await this.adapter.execute(
          `INSERT INTO host_capabilities (host, user_name, key, value, probed_at) VALUES (?, ?, ?, ?, ?)`,
          [host, user, key, value, now],
        );
      } catch {
        await this.adapter.execute(
          `UPDATE host_capabilities SET value = ?, probed_at = ? WHERE host = ? AND user_name = ? AND key = ?`,
          [value, now, host, user, key],
        );
      }
    }
  }

  async listForHost(host: string): Promise<Array<{ user: string; key: string; value: string | null; probedAt: string }>> {
    const rows = await this.adapter.query(
      `SELECT user_name, key, value, probed_at FROM host_capabilities WHERE host = ? ORDER BY user_name, key`,
      [host],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      user: r.user_name as string,
      key: r.key as string,
      value: (r.value as string | null),
      probedAt: r.probed_at as string,
    }));
  }
}
