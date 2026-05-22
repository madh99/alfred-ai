import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v673 — Generische Anhänge an Todos und Notes (später auch andere Entities).
 *
 * `source_kind` definiert wo der eigentliche Inhalt liegt:
 *   - `document`: eine Zeile in der `documents`-Tabelle (RAG). `source_ref` = document.id
 *   - `file`:     ein File im FileStore (S3/NFS/local). `source_ref` = fileStore-key
 *   - `url`:      externer Link. `source_ref` = URL
 *   - `upload`:   frisch via Direct-Upload reingegeben. Praktisch identisch mit 'file'
 *                  (FileStore-key), aber semantisch markiert für UI-Anzeige.
 */
export type AttachmentEntityType = 'todo' | 'note';
export type AttachmentSourceKind = 'document' | 'file' | 'url' | 'upload';

export interface AttachmentEntry {
  id: string;
  userId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  sourceKind: AttachmentSourceKind;
  sourceRef: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export class AttachmentRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async add(input: {
    userId: string;
    entityType: AttachmentEntityType;
    entityId: string;
    sourceKind: AttachmentSourceKind;
    sourceRef: string;
    label?: string;
    mimeType?: string;
    sizeBytes?: number;
  }): Promise<AttachmentEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO attachments
       (id, user_id, entity_type, entity_id, source_kind, source_ref, label, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.userId, input.entityType, input.entityId,
        input.sourceKind, input.sourceRef, input.label ?? null,
        input.mimeType ?? null, input.sizeBytes ?? null, now,
      ],
    );
    return {
      id, userId: input.userId, entityType: input.entityType, entityId: input.entityId,
      sourceKind: input.sourceKind, sourceRef: input.sourceRef, label: input.label,
      mimeType: input.mimeType, sizeBytes: input.sizeBytes, createdAt: now,
    };
  }

  async listForEntity(entityType: AttachmentEntityType, entityId: string): Promise<AttachmentEntry[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC`,
      [entityType, entityId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getById(id: string): Promise<AttachmentEntry | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM attachments WHERE id = ?`, [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM attachments WHERE id = ? AND user_id = ?`,
      [id, userId],
    );
    return result.changes > 0;
  }

  /** Beim Delete einer Entity (Todo/Note) alle ihre Attachments entfernen. */
  async deleteForEntity(entityType: AttachmentEntityType, entityId: string): Promise<number> {
    const result = await this.adapter.execute(
      `DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?`,
      [entityType, entityId],
    );
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): AttachmentEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      entityType: row.entity_type as AttachmentEntityType,
      entityId: row.entity_id as string,
      sourceKind: row.source_kind as AttachmentSourceKind,
      sourceRef: row.source_ref as string,
      label: (row.label as string | null) ?? undefined,
      mimeType: (row.mime_type as string | null) ?? undefined,
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : undefined,
      createdAt: row.created_at as string,
    };
  }
}
