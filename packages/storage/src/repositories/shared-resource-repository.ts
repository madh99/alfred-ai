import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface SharedResource {
  id: string;
  resourceType: string;  // 'todo_list' | 'db_connection' | 'calendar'
  resourceId: string;     // the actual resource identifier (list name, connection name, etc.)
  ownerUserId: string;
  sharedWithUserId?: string;
  sharedWithGroupId?: string;
  createdAt: string;
}

export class SharedResourceRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /**
   * Share a resource with a specific user or group.
   */
  async share(opts: {
    resourceType: string;
    resourceId: string;
    ownerUserId: string;
    sharedWithUserId?: string;
    sharedWithGroupId?: string;
  }): Promise<SharedResource> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO shared_resources (id, resource_type, resource_id, owner_user_id, shared_with_user_id, shared_with_group_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `, [id, opts.resourceType, opts.resourceId, opts.ownerUserId, opts.sharedWithUserId ?? null, opts.sharedWithGroupId ?? null, now]);
    return { id, ...opts, createdAt: now };
  }

  /**
   * Remove sharing for a resource.
   */
  async unshare(resourceType: string, resourceId: string, sharedWithUserId?: string, sharedWithGroupId?: string): Promise<boolean> {
    if (sharedWithUserId) {
      const result = await this.adapter.execute('DELETE FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_user_id = ?', [resourceType, resourceId, sharedWithUserId]);
      return result.changes > 0;
    }
    if (sharedWithGroupId) {
      const result = await this.adapter.execute('DELETE FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_group_id = ?', [resourceType, resourceId, sharedWithGroupId]);
      return result.changes > 0;
    }
    return false;
  }

  /**
   * Check if a user has access to a resource (owned or shared).
   */
  async hasAccess(resourceType: string, resourceId: string, userId: string, groupIds?: string[]): Promise<boolean> {
    // Direct user share
    const userShare = await this.adapter.queryOne(
      'SELECT 1 FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND (owner_user_id = ? OR shared_with_user_id = ?)',
      [resourceType, resourceId, userId, userId],
    );
    if (userShare) return true;

    // Group share
    if (groupIds && groupIds.length > 0) {
      const placeholders = groupIds.map(() => '?').join(',');
      const groupShare = await this.adapter.queryOne(
        `SELECT 1 FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_group_id IN (${placeholders})`,
        [resourceType, resourceId, ...groupIds],
      );
      if (groupShare) return true;
    }

    return false;
  }

  /**
   * Get all resources shared with a user (directly or via groups).
   */
  async getSharedWith(userId: string, resourceType?: string, groupIds?: string[]): Promise<SharedResource[]> {
    const results: SharedResource[] = [];

    // Direct shares
    let sql = 'SELECT * FROM shared_resources WHERE shared_with_user_id = ?';
    const params: unknown[] = [userId];
    if (resourceType) { sql += ' AND resource_type = ?'; params.push(resourceType); }
    const directRows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    results.push(...directRows.map(r => this.mapRow(r)));

    // Group shares
    if (groupIds && groupIds.length > 0) {
      const placeholders = groupIds.map(() => '?').join(',');
      let groupSql = `SELECT * FROM shared_resources WHERE shared_with_group_id IN (${placeholders})`;
      const groupParams: unknown[] = [...groupIds];
      if (resourceType) { groupSql += ' AND resource_type = ?'; groupParams.push(resourceType); }
      const groupRows = await this.adapter.query(groupSql, groupParams) as Record<string, unknown>[];
      results.push(...groupRows.map(r => this.mapRow(r)));
    }

    return results;
  }

  /**
   * Get all shares for a resource owned by a user.
   */
  async getSharesForResource(resourceType: string, resourceId: string): Promise<SharedResource[]> {
    const rows = await this.adapter.query('SELECT * FROM shared_resources WHERE resource_type = ? AND resource_id = ?', [resourceType, resourceId]) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): SharedResource {
    return {
      id: row.id as string,
      resourceType: row.resource_type as string,
      resourceId: row.resource_id as string,
      ownerUserId: row.owner_user_id as string,
      sharedWithUserId: row.shared_with_user_id as string | undefined,
      sharedWithGroupId: row.shared_with_group_id as string | undefined,
      createdAt: row.created_at as string,
    };
  }
}
