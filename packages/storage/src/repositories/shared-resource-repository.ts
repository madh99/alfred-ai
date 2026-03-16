import type BetterSqlite3 from 'better-sqlite3';
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
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * Share a resource with a specific user or group.
   */
  share(opts: {
    resourceType: string;
    resourceId: string;
    ownerUserId: string;
    sharedWithUserId?: string;
    sharedWithGroupId?: string;
  }): SharedResource {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO shared_resources (id, resource_type, resource_id, owner_user_id, shared_with_user_id, shared_with_group_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.resourceType, opts.resourceId, opts.ownerUserId, opts.sharedWithUserId ?? null, opts.sharedWithGroupId ?? null, now);
    return { id, ...opts, createdAt: now };
  }

  /**
   * Remove sharing for a resource.
   */
  unshare(resourceType: string, resourceId: string, sharedWithUserId?: string, sharedWithGroupId?: string): boolean {
    if (sharedWithUserId) {
      return this.db.prepare('DELETE FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_user_id = ?').run(resourceType, resourceId, sharedWithUserId).changes > 0;
    }
    if (sharedWithGroupId) {
      return this.db.prepare('DELETE FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_group_id = ?').run(resourceType, resourceId, sharedWithGroupId).changes > 0;
    }
    return false;
  }

  /**
   * Check if a user has access to a resource (owned or shared).
   */
  hasAccess(resourceType: string, resourceId: string, userId: string, groupIds?: string[]): boolean {
    // Direct user share
    const userShare = this.db.prepare(
      'SELECT 1 FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND (owner_user_id = ? OR shared_with_user_id = ?)',
    ).get(resourceType, resourceId, userId, userId);
    if (userShare) return true;

    // Group share
    if (groupIds && groupIds.length > 0) {
      const placeholders = groupIds.map(() => '?').join(',');
      const groupShare = this.db.prepare(
        `SELECT 1 FROM shared_resources WHERE resource_type = ? AND resource_id = ? AND shared_with_group_id IN (${placeholders})`,
      ).get(resourceType, resourceId, ...groupIds);
      if (groupShare) return true;
    }

    return false;
  }

  /**
   * Get all resources shared with a user (directly or via groups).
   */
  getSharedWith(userId: string, resourceType?: string, groupIds?: string[]): SharedResource[] {
    const results: SharedResource[] = [];

    // Direct shares
    let sql = 'SELECT * FROM shared_resources WHERE shared_with_user_id = ?';
    const params: unknown[] = [userId];
    if (resourceType) { sql += ' AND resource_type = ?'; params.push(resourceType); }
    const directRows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    results.push(...directRows.map(r => this.mapRow(r)));

    // Group shares
    if (groupIds && groupIds.length > 0) {
      const placeholders = groupIds.map(() => '?').join(',');
      let groupSql = `SELECT * FROM shared_resources WHERE shared_with_group_id IN (${placeholders})`;
      const groupParams: unknown[] = [...groupIds];
      if (resourceType) { groupSql += ' AND resource_type = ?'; groupParams.push(resourceType); }
      const groupRows = this.db.prepare(groupSql).all(...groupParams) as Record<string, unknown>[];
      results.push(...groupRows.map(r => this.mapRow(r)));
    }

    return results;
  }

  /**
   * Get all shares for a resource owned by a user.
   */
  getSharesForResource(resourceType: string, resourceId: string): SharedResource[] {
    const rows = this.db.prepare('SELECT * FROM shared_resources WHERE resource_type = ? AND resource_id = ?').all(resourceType, resourceId) as Record<string, unknown>[];
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
