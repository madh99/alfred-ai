import { describe, it, expect, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { UserIdAuditScanner, type UserIdAuditTarget } from './audit-scanner.js';

/**
 * v808 — UserIdAuditScanner Unit Tests.
 *
 * Verifiziert dass non-UUID user_id-Rows korrekt geflaggt werden, dass die
 * Idempotenz-Garantie hält (kein doppelter Insert), und dass fehlende Tabellen
 * graceful übersprungen werden.
 */

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  child: () => noopLogger, level: 'info',
} as any;

const VALID_UUID = 'f165df7a-8689-49b6-9318-41839913846f';
const TELEGRAM_ID = '5060785419';
const MATRIX_ID = '@madh:chat.3033.at';

/** Minimaler In-Memory-Adapter für Tests — emuliert nur was Scanner braucht. */
function makeMemoryAdapter() {
  const rowsByTable = new Map<string, Array<Record<string, string>>>();
  const auditRows: Array<Record<string, string>> = [];

  return {
    seed(table: string, rows: Array<Record<string, string>>) {
      rowsByTable.set(table, rows);
    },
    getAudit() {
      return auditRows;
    },
    adapter: {
      type: 'sqlite' as const,
      async query(sql: string, _params?: unknown[]) {
        const tableMatch = /FROM (\w+)\b/i.exec(sql);
        if (tableMatch && rowsByTable.has(tableMatch[1])) {
          const rows = rowsByTable.get(tableMatch[1])!;
          // Liefert {row_id, uid} entsprechend Scanner-Erwartung
          return rows.map(r => ({ row_id: r.id, uid: r.user_id }));
        }
        if (sql.includes('user_id_format_audit')) return auditRows as any;
        throw new Error(`no such table: ${tableMatch?.[1] ?? '?'}`);
      },
      async queryOne(sql: string, params?: unknown[]) {
        if (sql.includes('user_id_format_audit')) {
          const [table_name, column_name, row_id] = params as string[];
          return auditRows.find(a =>
            a.table_name === table_name &&
            a.column_name === column_name &&
            a.row_id === row_id,
          );
        }
        return undefined;
      },
      async execute(sql: string, params?: unknown[]) {
        if (sql.includes('INSERT INTO user_id_format_audit')) {
          const [id, table_name, column_name, row_id, user_id_value, format_class, detected_at] = params as string[];
          auditRows.push({ id, table_name, column_name, row_id, user_id_value, format_class, detected_at });
        }
        return { changes: 1, lastInsertRowid: 0 } as any;
      },
      async exec(_sql: string) {},
      async transaction<T>(fn: any): Promise<T> { return fn(this); },
      async close() {},
    } as any,
  };
}

const TARGETS: UserIdAuditTarget[] = [
  { table: 'memories', pk: 'id', uidColumn: 'user_id' },
  { table: 'todos', pk: 'id', uidColumn: 'user_id' },
];

describe('UserIdAuditScanner.scan', () => {
  it('flaggt non-UUID Rows und ignoriert UUID-Rows', async () => {
    const mem = makeMemoryAdapter();
    mem.seed('memories', [
      { id: 'mem1', user_id: VALID_UUID },
      { id: 'mem2', user_id: TELEGRAM_ID },
      { id: 'mem3', user_id: MATRIX_ID },
    ]);
    mem.seed('todos', [
      { id: 'todo1', user_id: VALID_UUID },
    ]);
    const scanner = new UserIdAuditScanner(mem.adapter, noopLogger, TARGETS);
    const r = await scanner.scan();
    expect(r.scanned).toBe(4);
    expect(r.flaggedNew).toBe(2);
    expect(r.alreadyFlagged).toBe(0);
    expect(mem.getAudit()).toHaveLength(2);
    const flaggedIds = mem.getAudit().map(a => a.row_id);
    expect(flaggedIds).toContain('mem2');
    expect(flaggedIds).toContain('mem3');
  });

  it('ist idempotent — zweiter Scan flagged nichts Neues', async () => {
    const mem = makeMemoryAdapter();
    mem.seed('memories', [
      { id: 'mem1', user_id: TELEGRAM_ID },
    ]);
    mem.seed('todos', []);
    const scanner = new UserIdAuditScanner(mem.adapter, noopLogger, TARGETS);
    const r1 = await scanner.scan();
    expect(r1.flaggedNew).toBe(1);
    const r2 = await scanner.scan();
    expect(r2.flaggedNew).toBe(0);
    expect(r2.alreadyFlagged).toBe(1);
    expect(mem.getAudit()).toHaveLength(1);
  });

  it('überspringt fehlende Tabellen graceful', async () => {
    const mem = makeMemoryAdapter();
    mem.seed('memories', [{ id: 'mem1', user_id: TELEGRAM_ID }]);
    // todos-Tabelle bewusst NICHT seeded → query wirft "no such table"
    const scanner = new UserIdAuditScanner(mem.adapter, noopLogger, TARGETS);
    const r = await scanner.scan();
    expect(r.flaggedNew).toBe(1);
    expect(r.skippedTables).toContain('todos');
  });

  it('classifiziert Telegram-ID als "platform"', async () => {
    const mem = makeMemoryAdapter();
    mem.seed('memories', [{ id: 'mem1', user_id: TELEGRAM_ID }]);
    mem.seed('todos', []);
    const scanner = new UserIdAuditScanner(mem.adapter, noopLogger, TARGETS);
    await scanner.scan();
    expect(mem.getAudit()[0].format_class).toBe('platform');
  });
});
