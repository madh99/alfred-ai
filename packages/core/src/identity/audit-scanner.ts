import type { Logger } from 'pino';
import type { AsyncDbAdapter } from '@alfred/storage';
import { randomUUID } from 'node:crypto';
import { classifyUserIdFormat } from '@alfred/types';

/**
 * v808 — UserIdAuditScanner: scant DB-Tabellen mit user_id-Spalten, flaggt
 * non-UUID-Werte in `user_id_format_audit`.
 *
 * Komplementiert die v804-Migration die nur die Audit-Tabelle anlegt — hier
 * der Populate-Code. Wird beim Alfred-Startup einmal aufgerufen + ggf. periodic.
 *
 * Idempotent: Eintrag (table_name, column_name, row_id) wird nur einmal
 * geschrieben. Bestehende-Migration-A-Cleanups (v805) sollten zu 0 neuen Flags
 * führen.
 */
export interface UserIdAuditTarget {
  /** Tabellenname */
  table: string;
  /** PK-Spaltenname (für row_id) */
  pk: string;
  /** user_id-Spaltenname (meist 'user_id', manchmal 'owner_id' o.ä.) */
  uidColumn: string;
}

const DEFAULT_TARGETS: UserIdAuditTarget[] = [
  { table: 'memories', pk: 'id', uidColumn: 'user_id' },
  { table: 'documents', pk: 'id', uidColumn: 'user_id' },
  { table: 'document_chunks', pk: 'id', uidColumn: 'user_id' },
  { table: 'todos', pk: 'id', uidColumn: 'user_id' },
  { table: 'notes', pk: 'id', uidColumn: 'user_id' },
  { table: 'reminders', pk: 'id', uidColumn: 'user_id' },
  { table: 'conversations', pk: 'id', uidColumn: 'user_id' },
  { table: 'projects', pk: 'id', uidColumn: 'user_id' },
  { table: 'background_tasks', pk: 'id', uidColumn: 'user_id' },
  { table: 'agent_sessions', pk: 'id', uidColumn: 'user_id' },
  { table: 'sandboxes', pk: 'id', uidColumn: 'user_id' },
  { table: 'project_automations', pk: 'id', uidColumn: 'user_id' },
  { table: 'goals', pk: 'id', uidColumn: 'user_id' },
  { table: 'runbooks', pk: 'id', uidColumn: 'user_id' },
  { table: 'insights', pk: 'id', uidColumn: 'user_id' },
];

export interface AuditScanResult {
  scanned: number;
  flaggedNew: number;
  alreadyFlagged: number;
  skippedTables: string[];
}

export class UserIdAuditScanner {
  constructor(
    private readonly adapter: AsyncDbAdapter,
    private readonly logger: Logger,
    private readonly targets: UserIdAuditTarget[] = DEFAULT_TARGETS,
  ) {}

  async scan(): Promise<AuditScanResult> {
    const result: AuditScanResult = {
      scanned: 0,
      flaggedNew: 0,
      alreadyFlagged: 0,
      skippedTables: [],
    };

    const now = new Date().toISOString();

    for (const target of this.targets) {
      try {
        const rows = await this.adapter.query(
          `SELECT ${target.pk} AS row_id, ${target.uidColumn} AS uid FROM ${target.table} WHERE ${target.uidColumn} IS NOT NULL`,
        ) as Array<{ row_id: string; uid: string }>;

        for (const row of rows) {
          result.scanned += 1;
          const fmt = classifyUserIdFormat(row.uid);
          if (fmt === 'uuid') continue;

          const existing = await this.adapter.queryOne(
            `SELECT id FROM user_id_format_audit WHERE table_name = ? AND column_name = ? AND row_id = ?`,
            [target.table, target.uidColumn, String(row.row_id)],
          );
          if (existing) {
            result.alreadyFlagged += 1;
            continue;
          }

          await this.adapter.execute(
            `INSERT INTO user_id_format_audit (id, table_name, column_name, row_id, user_id_value, format_class, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), target.table, target.uidColumn, String(row.row_id), row.uid, fmt, now],
          );
          result.flaggedNew += 1;
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        // Tabelle existiert evtl. nicht in dieser DB-Variante (z.B. Optional-Feature)
        if (/no such table|does not exist|relation .* does not exist/i.test(msg)) {
          result.skippedTables.push(target.table);
          continue;
        }
        this.logger.warn({ err, table: target.table }, 'v808 audit-scan failed for table (continuing)');
      }
    }

    if (result.flaggedNew > 0) {
      this.logger.warn({
        scanned: result.scanned,
        flaggedNew: result.flaggedNew,
        alreadyFlagged: result.alreadyFlagged,
        skipped: result.skippedTables.length,
      }, 'v808 UserIdAudit: non-UUID user_id rows detected — see user_id_format_audit table');
    } else {
      this.logger.debug({
        scanned: result.scanned,
        alreadyFlagged: result.alreadyFlagged,
        skipped: result.skippedTables.length,
      }, 'v808 UserIdAudit: scan complete, all user_id rows have UUID format');
    }

    return result;
  }
}
