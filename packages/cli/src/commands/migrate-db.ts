/**
 * alfred migrate-db — Migrate data from SQLite to PostgreSQL.
 *
 * Reads all tables from the existing SQLite database and copies rows
 * into a PostgreSQL instance. The PG schema is created automatically
 * if it doesn't exist yet (via PG_SCHEMA).
 *
 * Usage:
 *   alfred migrate-db --connection-string postgres://user:pass@host:5432/alfred
 *   alfred migrate-db                  (reads connectionString from config)
 *
 * Options:
 *   --connection-string <url>   PostgreSQL connection string (overrides config)
 *   --batch-size <n>            Rows per INSERT batch (default: 500)
 *   --dry-run                   Show what would be migrated without writing
 *   --skip-existing             Skip tables that already have data in PG
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigLoader } from '@alfred/config';
import { Database, PostgresAsyncAdapter, PG_SCHEMA } from '@alfred/storage';

/** Tables in dependency order (referenced tables first). */
const TABLE_ORDER = [
  // Base tables (no FK deps)
  'conversations',
  'users',
  'memories',
  'reminders',
  'notes',
  'todos',
  'documents',
  'watches',
  'scheduled_actions',
  'llm_usage',
  'llm_usage_by_user',
  'audit_log',
  'activity_log',
  'skill_health',
  'pending_confirmations',
  'conversation_summaries',
  'calendar_notifications',
  'workflow_chains',
  'feedback_events',
  'alfred_users',
  'database_connections',
  'background_tasks',
  'link_tokens',
  'shared_resources',
  'project_agent_sessions',
  'plugin_skills',
  // FK-dependent tables
  'messages',
  'embeddings',
  'document_chunks',
  'linked_users',
  'user_services',
  'user_platform_links',
  'workflow_executions',
  // Schema tracking
  'schema_version',
  '_migrations',
];

interface MigrateOptions {
  connectionString?: string;
  batchSize?: number;
  dryRun?: boolean;
  skipExisting?: boolean;
}

export async function migrateDbCommand(opts: MigrateOptions): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Konfiguration konnte nicht geladen werden:', (error as Error).message);
    process.exit(1);
  }

  const dbPath = path.resolve(config.storage.path);
  const pgUrl = opts.connectionString ?? config.storage.connectionString;
  const batchSize = opts.batchSize ?? 500;

  if (!pgUrl) {
    console.error('Fehler: PostgreSQL Connection-String fehlt.');
    console.error('Entweder --connection-string angeben oder storage.connectionString in der Config setzen.');
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`SQLite-Datenbank nicht gefunden: ${dbPath}`);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Alfred — SQLite → PostgreSQL Migration   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Quelle:  ${dbPath}`);
  console.log(`  Ziel:    ${pgUrl.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  Batch:   ${batchSize} Zeilen pro INSERT`);
  if (opts.dryRun) console.log('  Modus:   DRY RUN (keine Schreiboperationen)');
  if (opts.skipExisting) console.log('  Option:  Skip tables with existing data');
  console.log('');

  // 1. Open SQLite
  const sqliteDb = Database.createSync(dbPath);
  const sqliteAdapter = sqliteDb.getAdapter();

  // 2. Connect to PostgreSQL
  const pgAdapter = new PostgresAsyncAdapter(pgUrl);
  try {
    await pgAdapter.initialize();
  } catch (err) {
    console.error(`PostgreSQL-Verbindung fehlgeschlagen: ${(err as Error).message}`);
    await sqliteDb.close();
    process.exit(1);
  }

  console.log('✓ Beide Datenbanken verbunden\n');

  // 3. Ensure PG schema exists
  try {
    const rows = await pgAdapter.query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
    if (rows.length > 0) {
      console.log(`✓ PostgreSQL Schema vorhanden (Version ${rows[0].version})`);
    } else {
      throw new Error('no schema');
    }
  } catch {
    if (opts.dryRun) {
      console.log('  [DRY RUN] Würde PG Schema erstellen');
    } else {
      console.log('  PostgreSQL Schema wird erstellt...');
      await pgAdapter.exec(PG_SCHEMA);
      console.log('✓ PostgreSQL Schema erstellt');
    }
  }
  console.log('');

  // 4. Discover SQLite tables
  const sqliteTables = await sqliteAdapter.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const availableTables = new Set(sqliteTables.map(r => r.name as string));

  // 5. Migrate table by table
  let totalRows = 0;
  let totalTables = 0;
  const errors: string[] = [];

  for (const tableName of TABLE_ORDER) {
    if (!availableTables.has(tableName)) {
      continue; // Table doesn't exist in SQLite (optional feature not used)
    }

    try {
      // Count source rows
      const countResult = await sqliteAdapter.queryOne(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
      const sourceCount = (countResult?.cnt as number) ?? 0;

      if (sourceCount === 0) {
        console.log(`  ⊘ ${tableName.padEnd(30)} 0 Zeilen (leer, übersprungen)`);
        continue;
      }

      // Check if target already has data
      if (opts.skipExisting) {
        try {
          const pgCount = await pgAdapter.queryOne(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
          if ((pgCount?.cnt as number) > 0) {
            console.log(`  ⊘ ${tableName.padEnd(30)} ${sourceCount} Zeilen (PG hat bereits Daten, übersprungen)`);
            continue;
          }
        } catch { /* table might not exist, continue */ }
      }

      if (opts.dryRun) {
        console.log(`  → ${tableName.padEnd(30)} ${sourceCount} Zeilen würden migriert`);
        totalRows += sourceCount;
        totalTables++;
        continue;
      }

      // Read all rows from SQLite
      const rows = await sqliteAdapter.query(`SELECT * FROM "${tableName}"`);
      if (rows.length === 0) continue;

      // Get column names from first row
      const columns = Object.keys(rows[0]);

      // Wrap in transaction for atomicity (DELETE + all INSERTs or nothing)
      await pgAdapter.transaction(async (tx) => {
        // Clear target table (to allow re-runs)
        if (!opts.skipExisting) {
          await tx.execute(`DELETE FROM "${tableName}"`, []);
        }

        // Batch insert
        let inserted = 0;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          await insertBatchTx(tx, tableName, columns, batch);
          inserted += batch.length;

          // Progress for large tables
          if (rows.length > batchSize) {
            process.stdout.write(`\r  → ${tableName.padEnd(30)} ${inserted}/${sourceCount}`);
          }
        }
      });

      // Verify
      const pgCountResult = await pgAdapter.queryOne(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
      const pgCount = (pgCountResult?.cnt as number) ?? 0;

      if (pgCount === sourceCount) {
        console.log(`\r  ✓ ${tableName.padEnd(30)} ${sourceCount} Zeilen migriert`);
      } else {
        console.log(`\r  ⚠ ${tableName.padEnd(30)} ${sourceCount} → ${pgCount} (Differenz!)`);
        errors.push(`${tableName}: erwartet ${sourceCount}, erhalten ${pgCount}`);
      }

      totalRows += sourceCount;
      totalTables++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${tableName.padEnd(30)} FEHLER: ${msg.slice(0, 80)}`);
      errors.push(`${tableName}: ${msg}`);
    }
  }

  // Also migrate any tables not in TABLE_ORDER (future tables)
  for (const tableName of availableTables) {
    if (TABLE_ORDER.includes(tableName)) continue;
    if (tableName === 'sqlite_sequence') continue;

    try {
      const countResult = await sqliteAdapter.queryOne(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
      const sourceCount = (countResult?.cnt as number) ?? 0;
      if (sourceCount === 0) continue;

      console.log(`  ? ${tableName.padEnd(30)} ${sourceCount} Zeilen (unbekannte Tabelle, übersprungen)`);
    } catch { /* ignore */ }
  }

  // 6. Summary
  console.log('');
  console.log('─'.repeat(50));
  console.log(`  ${opts.dryRun ? 'Würde migrieren' : 'Migriert'}: ${totalTables} Tabellen, ${totalRows} Zeilen`);

  if (errors.length > 0) {
    console.log(`\n  ⚠ ${errors.length} Fehler:`);
    for (const err of errors) {
      console.log(`    • ${err}`);
    }
  } else if (!opts.dryRun && totalRows > 0) {
    console.log('  ✓ Migration erfolgreich abgeschlossen');
    console.log('');
    console.log('  Nächster Schritt:');
    console.log('    storage.backend: postgres');
    console.log(`    storage.connectionString: ${pgUrl.replace(/:[^:@]+@/, ':***@')}`);
    console.log('  in der Config setzen und Alfred neu starten.');
  }

  // Cleanup
  await pgAdapter.close();
  await sqliteDb.close();
}

/**
 * Insert a batch of rows into PostgreSQL.
 * Uses a multi-value INSERT for efficiency.
 *
 * We build $N placeholders directly (not ?), so adaptSql's ?→$N
 * replacement is a no-op. The other transforms (datetime, LIKE)
 * don't affect INSERT VALUES statements.
 */
async function insertBatchTx(
  pg: import('@alfred/storage').AsyncDbAdapter,
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  const colList = columns.map(c => `"${c}"`).join(', ');
  const values: unknown[] = [];
  const valueTuples: string[] = [];

  let paramIdx = 0;
  for (const row of rows) {
    const placeholders: string[] = [];
    for (const col of columns) {
      paramIdx++;
      placeholders.push(`$${paramIdx}`);
      values.push(row[col] ?? null);
    }
    valueTuples.push(`(${placeholders.join(', ')})`);
  }

  // ON CONFLICT DO NOTHING for idempotent re-runs
  const sql = `INSERT INTO "${tableName}" (${colList}) VALUES ${valueTuples.join(', ')} ON CONFLICT DO NOTHING`;

  // execute() calls adaptSql which is a no-op here (no ? placeholders, no datetime/LIKE)
  await pg.execute(sql, values);
}
