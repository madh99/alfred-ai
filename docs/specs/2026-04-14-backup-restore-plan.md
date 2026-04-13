# Backup & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backup & Restore für Alfred — Database-Skill Erweiterung (7 DB-Provider) + System-Backup-Skill (Alfred DB + Tokens + Config) mit Zeitplan, Retention, S3-Upload und Chat-Interface.

**Architecture:** Zwei Komponenten: (1) `DbProvider` Interface bekommt `backup()`/`restore()` Methoden, Database-Skill bekommt `backup`/`restore` Actions. (2) Neuer `SystemBackupSkill` nutzt die Alfred-eigene DB (PG/SQLite) + Dateikopien, mit Cron-Scheduler und ClaimManager für HA.

**Tech Stack:** TypeScript, child_process (pg_dump/pg_restore/mysqldump/mongodump), better-sqlite3 `.backup()`, mssql T-SQL, @aws-sdk/client-s3 (optional), Zod, node-cron pattern matching.

---

### Task 1: BackupConfig Type + Zod Schema + ENV-Overrides

**Files:**
- Modify: `packages/types/src/config.ts`
- Modify: `packages/config/src/schemas.ts`
- Modify: `packages/config/src/loader.ts`

- [ ] **Step 1: Add BackupConfig interface to types**

In `packages/types/src/config.ts`, before the closing `AlfredConfig` interface, add:

```typescript
export interface BackupConfig {
  enabled?: boolean;
  schedule?: string;          // cron syntax, default "0 3 * * *"
  retention_days?: number;    // default 30
  storage?: 'local' | 's3' | 'both' | 'none';
  local_path?: string;        // default /root/alfred/backups
  s3_bucket?: string;
  restore_via_chat?: boolean; // default false
  include_tokens?: boolean;   // default true
  include_config?: boolean;   // default true
  include_minio?: boolean;    // default false
}
```

And add to `AlfredConfig`:
```typescript
  backup?: BackupConfig;
```

- [ ] **Step 2: Add Zod schema**

In `packages/config/src/schemas.ts`, add:

```typescript
const backupSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 3 * * *'),
  retention_days: z.number().default(30),
  storage: z.enum(['local', 's3', 'both', 'none']).default('local'),
  local_path: z.string().default('/root/alfred/backups'),
  s3_bucket: z.string().optional(),
  restore_via_chat: z.boolean().default(false),
  include_tokens: z.boolean().default(true),
  include_config: z.boolean().default(true),
  include_minio: z.boolean().default(false),
}).optional();
```

Add `backup: backupSchema` to the main config schema.

- [ ] **Step 3: Add ENV overrides**

In `packages/config/src/loader.ts`, add to the ENV_MAP:

```typescript
  ALFRED_BACKUP_ENABLED: ['backup', 'enabled'],
  ALFRED_BACKUP_SCHEDULE: ['backup', 'schedule'],
  ALFRED_BACKUP_RETENTION_DAYS: ['backup', 'retention_days'],
  ALFRED_BACKUP_STORAGE: ['backup', 'storage'],
  ALFRED_BACKUP_LOCAL_PATH: ['backup', 'local_path'],
  ALFRED_BACKUP_S3_BUCKET: ['backup', 's3_bucket'],
  ALFRED_BACKUP_RESTORE_VIA_CHAT: ['backup', 'restore_via_chat'],
  ALFRED_BACKUP_INCLUDE_TOKENS: ['backup', 'include_tokens'],
  ALFRED_BACKUP_INCLUDE_CONFIG: ['backup', 'include_config'],
  ALFRED_BACKUP_INCLUDE_MINIO: ['backup', 'include_minio'],
```

- [ ] **Step 4: Build**

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/config.ts packages/config/src/schemas.ts packages/config/src/loader.ts
git commit -m "feat: BackupConfig Type, Zod Schema, ENV-Overrides"
```

---

### Task 2: DbProvider backup()/restore() Interface + PostgreSQL Implementation

**Files:**
- Modify: `packages/skills/src/built-in/database/db-providers.ts`

- [ ] **Step 1: Extend DbProvider interface**

Add to the `DbProvider` interface in `db-providers.ts`:

```typescript
export interface BackupOptions {
  outputPath: string;
  format?: 'sql' | 'custom' | 'archive';
  label?: string;
  backupType?: 'full' | 'differential' | 'log' | 'copy_only'; // MS SQL only
}

export interface RestoreOptions {
  inputPath: string;
  stopAt?: string; // MS SQL point-in-time (ISO date)
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  duration_ms: number;
}

export interface DbProvider {
  type: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  getTables(): Promise<TableInfo[]>;
  describeTable(name: string): Promise<ColumnInfo[]>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  backup?(opts: BackupOptions): Promise<BackupResult>;
  restore?(opts: RestoreOptions): Promise<void>;
}
```

- [ ] **Step 2: Implement PostgreSQL backup**

In the `PostgreSQLProvider` class, add:

```typescript
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const format = opts.format === 'sql' ? 'plain' : 'custom';
    const ext = format === 'plain' ? '.sql' : '.dump';
    const outFile = `${opts.outputPath}${ext}`;

    const args = [
      '--host', this.config.host,
      '--port', String(this.config.port ?? 5432),
      '--dbname', this.config.database ?? 'postgres',
      '--format', format,
      '--file', outFile,
    ];
    if (this.config.username) args.push('--username', this.config.username);

    const env = { ...process.env };
    if (this.config.password) env.PGPASSWORD = this.config.password;

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('pg_dump', args, { env, timeout: 300_000 });

    const { stat } = await import('node:fs/promises');
    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const isCustom = opts.inputPath.endsWith('.dump');
    const cmd = isCustom ? 'pg_restore' : 'psql';
    const args = isCustom
      ? ['--host', this.config.host, '--port', String(this.config.port ?? 5432),
         '--dbname', this.config.database ?? 'postgres', '--clean', '--if-exists', opts.inputPath]
      : ['--host', this.config.host, '--port', String(this.config.port ?? 5432),
         '--dbname', this.config.database ?? 'postgres', '--file', opts.inputPath];
    if (this.config.username) args.push('--username', this.config.username);

    const env = { ...process.env };
    if (this.config.password) env.PGPASSWORD = this.config.password;

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(cmd, args, { env, timeout: 600_000 });
  }
```

- [ ] **Step 3: Build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/built-in/database/db-providers.ts
git commit -m "feat: DbProvider backup/restore Interface + PostgreSQL Implementation"
```

---

### Task 3: MS SQL backup/restore mit Backup-Ketten

**Files:**
- Modify: `packages/skills/src/built-in/database/db-providers.ts`

- [ ] **Step 1: Implement MS SQL backup**

In `MSSQLProvider`, add:

```typescript
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const backupType = opts.backupType ?? 'copy_only';
    const outFile = `${opts.outputPath}.bak`;
    const dbName = this.config.database ?? 'master';

    let sql: string;
    switch (backupType) {
      case 'copy_only':
        sql = `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH COPY_ONLY, FORMAT, INIT, NAME = N'${opts.label ?? 'Alfred Backup'}'`;
        break;
      case 'full':
        sql = `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH FORMAT, INIT, NAME = N'${opts.label ?? 'Alfred Full Backup'}'`;
        break;
      case 'differential':
        sql = `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH DIFFERENTIAL, FORMAT, INIT, NAME = N'${opts.label ?? 'Alfred Diff Backup'}'`;
        break;
      case 'log':
        sql = `BACKUP LOG [${dbName}] TO DISK = N'${outFile.replace('.bak', '.trn')}' WITH FORMAT, INIT, NAME = N'${opts.label ?? 'Alfred Log Backup'}'`;
        break;
      default:
        sql = `BACKUP DATABASE [${dbName}] TO DISK = N'${outFile}' WITH COPY_ONLY, FORMAT, INIT`;
    }

    await this.query(sql);

    // Get file size from SQL Server
    const sizeResult = await this.query(`RESTORE HEADERONLY FROM DISK = N'${backupType === 'log' ? outFile.replace('.bak', '.trn') : outFile}'`);
    const sizeBytes = (sizeResult.rows[0]?.BackupSize as number) ?? 0;

    return { path: backupType === 'log' ? outFile.replace('.bak', '.trn') : outFile, sizeBytes, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const dbName = this.config.database ?? 'master';
    const isLog = opts.inputPath.endsWith('.trn');

    if (isLog && opts.stopAt) {
      await this.query(`RESTORE LOG [${dbName}] FROM DISK = N'${opts.inputPath}' WITH STOPAT = N'${opts.stopAt}'`);
    } else if (isLog) {
      await this.query(`RESTORE LOG [${dbName}] FROM DISK = N'${opts.inputPath}' WITH NORECOVERY`);
    } else {
      await this.query(`RESTORE DATABASE [${dbName}] FROM DISK = N'${opts.inputPath}' WITH REPLACE`);
    }
  }
```

- [ ] **Step 2: Build**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/skills/src/built-in/database/db-providers.ts
git commit -m "feat: MS SQL backup/restore mit Backup-Ketten (copy_only/full/differential/log)"
```

---

### Task 4: MySQL, SQLite, MongoDB, Redis, InfluxDB backup/restore

**Files:**
- Modify: `packages/skills/src/built-in/database/db-providers.ts`

- [ ] **Step 1: MySQL backup/restore**

In `MySQLProvider`, add:

```typescript
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outFile = `${opts.outputPath}.sql`;
    const args = [
      '--host', this.config.host,
      '--port', String(this.config.port ?? 3306),
      '--result-file', outFile,
      '--single-transaction',
      '--routines', '--triggers', '--events',
    ];
    if (this.config.username) args.push('--user', this.config.username);
    if (this.config.database) args.push(this.config.database);

    const env = { ...process.env };
    if (this.config.password) env.MYSQL_PWD = this.config.password;

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('mysqldump', args, { env, timeout: 300_000 });

    const { stat } = await import('node:fs/promises');
    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const args = [
      '--host', this.config.host,
      '--port', String(this.config.port ?? 3306),
    ];
    if (this.config.username) args.push('--user', this.config.username);
    if (this.config.database) args.push('--database', this.config.database);

    const env = { ...process.env };
    if (this.config.password) env.MYSQL_PWD = this.config.password;

    const { execFile } = await import('node:child_process');
    const { readFile } = await import('node:fs/promises');
    const { promisify } = await import('node:util');
    const sql = await readFile(opts.inputPath, 'utf-8');
    const child = promisify(execFile)('mysql', args, { env, timeout: 600_000 });
    // pipe sql via stdin
    const { execSync } = await import('node:child_process');
    execSync(`mysql ${args.join(' ')} < "${opts.inputPath}"`, { env, timeout: 600_000 });
  }
```

- [ ] **Step 2: SQLite backup/restore**

In `SQLiteProvider`, add:

```typescript
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outFile = `${opts.outputPath}.sqlite`;
    const { copyFile, stat } = await import('node:fs/promises');

    // Use SQLite backup API via VACUUM INTO (atomic, consistent)
    await this.db.exec(`VACUUM INTO '${outFile}'`);

    const st = await stat(outFile);
    return { path: outFile, sizeBytes: st.size, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const { copyFile } = await import('node:fs/promises');
    const dbPath = this.config.database ?? this.config.host;
    this.db.close();
    await copyFile(opts.inputPath, dbPath);
    // Reconnect
    await this.connect();
  }
```

- [ ] **Step 3: MongoDB backup/restore**

In `MongoDBProvider`, add:

```typescript
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const outDir = opts.outputPath;
    const args = ['--uri', this.connectionUri, '--out', outDir];
    if (this.config.database) args.push('--db', this.config.database);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('mongodump', args, { timeout: 300_000 });

    // Calculate total size of dump directory
    const { readdir, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let totalSize = 0;
    const files = await readdir(outDir, { recursive: true });
    for (const f of files) {
      try { const st = await stat(join(outDir, f)); totalSize += st.size; } catch { /* skip dirs */ }
    }
    return { path: outDir, sizeBytes: totalSize, duration_ms: Date.now() - start };
  }

  async restore(opts: RestoreOptions): Promise<void> {
    const args = ['--uri', this.connectionUri, '--drop', opts.inputPath];
    if (this.config.database) args.push('--db', this.config.database);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('mongorestore', args, { timeout: 600_000 });
  }
```

- [ ] **Step 4: Redis backup (stub) + InfluxDB backup (stub)**

Redis and InfluxDB get minimal implementations:

```typescript
// RedisProvider
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    await this.client.bgsave();
    // Wait for BGSAVE to complete
    for (let i = 0; i < 30; i++) {
      const info = await this.client.lastsave();
      if (Date.now() / 1000 - (info as number) < 5) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return { path: 'RDB on server', sizeBytes: 0, duration_ms: Date.now() - start };
  }

// InfluxDBProvider
  async backup(opts: BackupOptions): Promise<BackupResult> {
    const start = Date.now();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('influx', ['backup', '--bucket', this.config.database ?? '', '--path', opts.outputPath], { timeout: 300_000 });
    return { path: opts.outputPath, sizeBytes: 0, duration_ms: Date.now() - start };
  }
```

- [ ] **Step 5: Build**

```bash
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/built-in/database/db-providers.ts
git commit -m "feat: backup/restore für MySQL, SQLite, MongoDB, Redis, InfluxDB"
```

---

### Task 5: Database-Skill backup/restore Actions

**Files:**
- Modify: `packages/skills/src/built-in/database/database-skill.ts`

- [ ] **Step 1: Add backup/restore to action enum + inputSchema**

In the `inputSchema.properties.action.enum` array, add `'backup'` and `'restore'`.

Add to `inputSchema.properties`:
```typescript
        backup_type: { type: 'string', enum: ['copy_only', 'full', 'differential', 'log'], description: 'MS SQL Backup-Typ (default: copy_only)' },
        label: { type: 'string', description: 'Backup-Label' },
        backup_id: { type: 'string', description: 'Backup-ID oder Dateipfad für Restore' },
```

Update the `type Action` to include `'backup' | 'restore'`.

- [ ] **Step 2: Add backup/restore switch cases**

In `execute()`:
```typescript
      case 'backup': return this.backupDatabase(input);
      case 'restore': return this.restoreDatabase(input);
```

- [ ] **Step 3: Implement backupDatabase**

```typescript
  private async backupDatabase(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    if (!name) return { success: false, error: 'Missing connection name' };

    const provider = this.providers.get(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found. Use "list" to see available connections.` };
    if (!provider.backup) return { success: false, error: `Backup not supported for ${provider.type}` };

    const backupDir = this.config.backupPath ?? '/tmp/alfred-db-backups';
    const { mkdir } = await import('node:fs/promises');
    await mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${backupDir}/${name}_${timestamp}`;

    const result = await provider.backup({
      outputPath,
      format: (input.format as 'sql' | 'custom' | 'archive') ?? 'custom',
      label: input.label as string | undefined,
      backupType: (input.backup_type as 'full' | 'differential' | 'log' | 'copy_only') ?? 'copy_only',
    });

    const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
    return {
      success: true,
      data: result,
      display: [
        `## Backup erfolgreich`,
        `**Connection:** ${name} (${provider.type})`,
        `**Datei:** ${result.path}`,
        `**Größe:** ${sizeMB} MB`,
        `**Dauer:** ${(result.duration_ms / 1000).toFixed(1)}s`,
        input.label ? `**Label:** ${input.label}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
```

- [ ] **Step 4: Implement restoreDatabase**

```typescript
  private async restoreDatabase(input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.connection as string;
    const file = (input.backup_id ?? input.file) as string;
    if (!name) return { success: false, error: 'Missing connection name' };
    if (!file) return { success: false, error: 'Missing backup_id or file path' };

    const provider = this.providers.get(name);
    if (!provider) return { success: false, error: `Connection "${name}" not found.` };
    if (!provider.restore) return { success: false, error: `Restore not supported for ${provider.type}` };

    // Safety check
    const conn = await this.connRepo.getByName(name);
    if (conn?.readOnly) return { success: false, error: 'Connection is read-only. Cannot restore.' };

    await provider.restore({ inputPath: file, stopAt: input.stop_at as string | undefined });

    return {
      success: true,
      display: `## Restore erfolgreich\n**Connection:** ${name}\n**Datei:** ${file}`,
    };
  }
```

- [ ] **Step 5: Build**

```bash
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/built-in/database/database-skill.ts
git commit -m "feat: Database-Skill backup/restore Actions"
```

---

### Task 6: System-Backup-Skill

**Files:**
- Create: `packages/skills/src/built-in/system-backup.ts`

- [ ] **Step 1: Create the skill file**

```typescript
import type { SkillMetadata, SkillContext, SkillResult, BackupConfig } from '@alfred/types';
import type { AsyncDbAdapter } from '@alfred/storage';
import { Skill } from '../skill.js';
import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

interface BackupMeta {
  id: string;
  timestamp: string;
  type: 'scheduled' | 'manual';
  retention_days: number;
  permanent: boolean;
  storage: string;
  size_bytes: number;
  includes: string[];
  label: string | null;
  node_id: string;
  alfred_version: string;
  db_type: string;
}

export class SystemBackupSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'system_backup',
    category: 'infrastructure',
    description:
      'Alfred System-Backup: Sichert die Alfred-Datenbank (PostgreSQL/SQLite), Token-Dateien und Config. ' +
      '"backup" erstellt ein Backup (optional: label, retention_days, permanent). ' +
      '"restore" zeigt verfügbare Backups oder stellt wieder her (wenn restore_via_chat aktiviert). ' +
      '"list" zeigt die letzten Backups. "status" zeigt den aktuellen Backup-Status. ' +
      '"configure" ändert Zeitplan, Retention, Speicherort. "delete" löscht ein Backup.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['backup', 'restore', 'list', 'status', 'configure', 'delete'] },
        label: { type: 'string', description: 'Backup-Label (für backup)' },
        retention_days: { type: 'number', description: 'Individuelle Retention für dieses Backup' },
        permanent: { type: 'boolean', description: 'Backup niemals automatisch löschen' },
        backup_id: { type: 'string', description: 'Backup-ID (für restore/delete)' },
        limit: { type: 'number', description: 'Anzahl Backups in der Liste (default 10)' },
        schedule: { type: 'string', description: 'Neuer Cron-Zeitplan (für configure)' },
        storage: { type: 'string', description: 'Speicherort: local/s3/both/none (für configure)' },
        restore_via_chat: { type: 'boolean', description: 'Restore per Chat erlauben (für configure)' },
      },
      required: ['action'],
    },
  };

  private config: BackupConfig;
  private readonly dbAdapter: AsyncDbAdapter;
  private readonly nodeId: string;
  private readonly alfredVersion: string;

  constructor(config: BackupConfig, dbAdapter: AsyncDbAdapter, nodeId: string, alfredVersion: string) {
    super();
    this.config = { ...config };
    this.dbAdapter = dbAdapter;
    this.nodeId = nodeId;
    this.alfredVersion = alfredVersion;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    switch (input.action as string) {
      case 'backup': return this.createBackup(input);
      case 'restore': return this.restoreBackup(input);
      case 'list': return this.listBackups(input);
      case 'status': return this.getStatus();
      case 'configure': return this.configure(input);
      case 'delete': return this.deleteBackup(input);
      default: return { success: false, error: `Unknown action "${input.action}"` };
    }
  }

  /** Create a backup of Alfred's database + optional files. */
  async createBackup(input: Record<string, unknown>, type: 'manual' | 'scheduled' = 'manual'): Promise<SkillResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = timestamp;
    const localPath = this.config.local_path ?? '/root/alfred/backups';
    const backupDir = join(localPath, id);
    await mkdir(backupDir, { recursive: true });

    const includes: string[] = [];
    let totalSize = 0;
    const start = Date.now();

    // 1. Database backup
    try {
      if (this.dbAdapter.type === 'postgres') {
        const pgConfig = (this.dbAdapter as any).config ?? {};
        const outFile = join(backupDir, 'alfred.dump');
        const args = [
          '--host', pgConfig.host ?? 'localhost',
          '--port', String(pgConfig.port ?? 5432),
          '--dbname', pgConfig.database ?? 'alfred',
          '--format', 'custom',
          '--file', outFile,
        ];
        if (pgConfig.user) args.push('--username', pgConfig.user);
        const env = { ...process.env };
        if (pgConfig.password) env.PGPASSWORD = pgConfig.password;
        await execFileAsync('pg_dump', args, { env, timeout: 300_000 });
        const st = await stat(outFile);
        totalSize += st.size;
        includes.push('database');
      } else {
        // SQLite — use VACUUM INTO
        const dbPath = (this.dbAdapter as any).dbPath ?? (this.dbAdapter as any).config?.path;
        if (dbPath) {
          const outFile = join(backupDir, 'alfred.sqlite');
          await this.dbAdapter.execute(`VACUUM INTO '${outFile}'`);
          const st = await stat(outFile);
          totalSize += st.size;
          includes.push('database');
        }
      }
    } catch (err) {
      // Non-fatal — continue with file backups
    }

    // 2. Token files
    if (this.config.include_tokens !== false) {
      try {
        const alfredDir = join(homedir(), '.alfred');
        const tokenDir = join(backupDir, 'tokens');
        await mkdir(tokenDir, { recursive: true });
        const files = await readdir(alfredDir);
        for (const f of files) {
          if (f.startsWith('bmw-tokens') || f.endsWith('.json')) {
            await copyFile(join(alfredDir, f), join(tokenDir, f));
            const st = await stat(join(alfredDir, f));
            totalSize += st.size;
          }
        }
        includes.push('tokens');
      } catch { /* no token files */ }
    }

    // 3. Config file
    if (this.config.include_config !== false) {
      try {
        for (const cfgName of ['config.yaml', 'config.yml', '.env', 'alfred.env']) {
          const cfgPath = join(process.cwd(), cfgName);
          try {
            await stat(cfgPath);
            await copyFile(cfgPath, join(backupDir, cfgName));
            includes.push('config');
            break;
          } catch { /* not found, try next */ }
        }
      } catch { /* no config */ }
    }

    // 4. Write metadata
    const meta: BackupMeta = {
      id,
      timestamp: new Date().toISOString(),
      type,
      retention_days: (input.retention_days as number) ?? this.config.retention_days ?? 30,
      permanent: (input.permanent as boolean) ?? false,
      storage: this.config.storage ?? 'local',
      size_bytes: totalSize,
      includes,
      label: (input.label as string) ?? null,
      node_id: this.nodeId,
      alfred_version: this.alfredVersion,
      db_type: this.dbAdapter.type,
    };
    await writeFile(join(backupDir, 'meta.json'), JSON.stringify(meta, null, 2));

    // 5. S3 upload (if configured)
    if (this.config.storage === 's3' || this.config.storage === 'both') {
      try {
        await this.uploadToS3(backupDir, id);
      } catch (err) {
        // Non-fatal
      }
    }

    // 6. Cleanup old backups
    await this.cleanupExpired(localPath);

    const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    return {
      success: true,
      data: meta,
      display: [
        '## Backup erfolgreich',
        '',
        `**ID:** ${id}`,
        meta.label ? `**Label:** ${meta.label}` : '',
        `**Inhalt:** ${includes.join(', ')}`,
        `**Größe:** ${sizeMB} MB`,
        `**Dauer:** ${duration}s`,
        `**Retention:** ${meta.permanent ? 'permanent' : `${meta.retention_days} Tage`}`,
        `**Speicher:** ${meta.storage}`,
      ].filter(Boolean).join('\n'),
    };
  }

  private async restoreBackup(input: Record<string, unknown>): Promise<SkillResult> {
    const backupId = input.backup_id as string;
    if (!backupId) return this.listBackups(input);

    const localPath = this.config.local_path ?? '/root/alfred/backups';
    const backupDir = join(localPath, backupId);

    try {
      const metaRaw = await readFile(join(backupDir, 'meta.json'), 'utf-8');
      const meta = JSON.parse(metaRaw) as BackupMeta;
      const ageDays = Math.round((Date.now() - new Date(meta.timestamp).getTime()) / (24 * 60 * 60_000));
      const sizeMB = (meta.size_bytes / 1024 / 1024).toFixed(1);

      if (!this.config.restore_via_chat) {
        return {
          success: true,
          display: [
            '## Backup-Details',
            '',
            `**ID:** ${meta.id}`,
            meta.label ? `**Label:** ${meta.label}` : '',
            `**Datum:** ${meta.timestamp}`,
            `**Alter:** ${ageDays} Tage`,
            `**Größe:** ${sizeMB} MB`,
            `**Inhalt:** ${meta.includes.join(', ')}`,
            `**DB-Typ:** ${meta.db_type}`,
            '',
            '⚠️ Restore per Chat ist deaktiviert. Restore nur per SSH/CLI möglich.',
            `Pfad: \`${backupDir}\``,
          ].filter(Boolean).join('\n'),
        };
      }

      // Restore via chat enabled — this will go through confirmation queue (HIGH_RISK)
      return {
        success: true,
        data: { ...meta, backupDir, requiresConfirmation: true },
        display: [
          '## Restore vorbereitet',
          '',
          `**Backup:** ${meta.id} (${ageDays} Tage alt, ${sizeMB} MB)`,
          `**Inhalt:** ${meta.includes.join(', ')}`,
          '',
          '⚠️ **WARNUNG:** Die aktuelle Datenbank wird überschrieben!',
          'Bitte bestätige den Restore.',
        ].filter(Boolean).join('\n'),
      };
    } catch {
      return { success: false, error: `Backup "${backupId}" nicht gefunden.` };
    }
  }

  private async listBackups(input: Record<string, unknown>): Promise<SkillResult> {
    const localPath = this.config.local_path ?? '/root/alfred/backups';
    const limit = (input.limit as number) ?? 10;

    try {
      const dirs = await readdir(localPath);
      const metas: BackupMeta[] = [];
      for (const d of dirs.sort().reverse().slice(0, limit)) {
        try {
          const raw = await readFile(join(localPath, d, 'meta.json'), 'utf-8');
          metas.push(JSON.parse(raw));
        } catch { /* skip invalid */ }
      }

      if (metas.length === 0) return { success: true, display: 'Keine Backups vorhanden.' };

      const lines = ['## Verfügbare Backups', ''];
      for (const m of metas) {
        const ageDays = Math.round((Date.now() - new Date(m.timestamp).getTime()) / (24 * 60 * 60_000));
        const sizeMB = (m.size_bytes / 1024 / 1024).toFixed(1);
        const flag = m.permanent ? '📌' : m.type === 'scheduled' ? '⏰' : '✋';
        lines.push(`${flag} **${m.id}** — ${sizeMB} MB, ${ageDays}d alt${m.label ? `, "${m.label}"` : ''}`);
      }
      return { success: true, data: metas, display: lines.join('\n') };
    } catch {
      return { success: true, display: 'Kein Backup-Verzeichnis vorhanden.' };
    }
  }

  private async getStatus(): Promise<SkillResult> {
    const localPath = this.config.local_path ?? '/root/alfred/backups';
    let lastBackup: BackupMeta | null = null;
    let totalSize = 0;
    let count = 0;

    try {
      const dirs = await readdir(localPath);
      for (const d of dirs.sort().reverse()) {
        try {
          const raw = await readFile(join(localPath, d, 'meta.json'), 'utf-8');
          const meta = JSON.parse(raw) as BackupMeta;
          if (!lastBackup) lastBackup = meta;
          totalSize += meta.size_bytes;
          count++;
        } catch { /* skip */ }
      }
    } catch { /* no backups yet */ }

    const totalMB = (totalSize / 1024 / 1024).toFixed(1);
    return {
      success: true,
      display: [
        '## Backup-Status',
        '',
        `**Letztes Backup:** ${lastBackup ? `${lastBackup.id}${lastBackup.label ? ` ("${lastBackup.label}")` : ''}` : 'keins'}`,
        `**Anzahl Backups:** ${count}`,
        `**Gesamtgröße:** ${totalMB} MB`,
        `**Zeitplan:** ${this.config.schedule ?? '0 3 * * *'}`,
        `**Retention:** ${this.config.retention_days ?? 30} Tage`,
        `**Speicherort:** ${this.config.storage ?? 'local'}`,
        `**Restore per Chat:** ${this.config.restore_via_chat ? 'aktiviert' : 'deaktiviert'}`,
      ].join('\n'),
    };
  }

  private async configure(input: Record<string, unknown>): Promise<SkillResult> {
    const changes: string[] = [];
    if (input.schedule !== undefined) { this.config.schedule = input.schedule as string; changes.push(`Zeitplan: ${input.schedule}`); }
    if (input.retention_days !== undefined) { this.config.retention_days = input.retention_days as number; changes.push(`Retention: ${input.retention_days} Tage`); }
    if (input.storage !== undefined) { this.config.storage = input.storage as any; changes.push(`Speicher: ${input.storage}`); }
    if (input.restore_via_chat !== undefined) { this.config.restore_via_chat = input.restore_via_chat as boolean; changes.push(`Restore per Chat: ${input.restore_via_chat}`); }

    if (changes.length === 0) return { success: false, error: 'Keine Änderungen angegeben.' };
    return { success: true, display: `## Backup-Konfiguration geändert\n\n${changes.map(c => `- ${c}`).join('\n')}` };
  }

  private async deleteBackup(input: Record<string, unknown>): Promise<SkillResult> {
    const backupId = input.backup_id as string;
    if (!backupId) return { success: false, error: 'Missing backup_id' };

    const localPath = this.config.local_path ?? '/root/alfred/backups';
    const backupDir = join(localPath, backupId);
    try {
      await rm(backupDir, { recursive: true });
      return { success: true, display: `Backup **${backupId}** gelöscht.` };
    } catch {
      return { success: false, error: `Backup "${backupId}" nicht gefunden.` };
    }
  }

  private async cleanupExpired(localPath: string): Promise<void> {
    try {
      const dirs = await readdir(localPath);
      for (const d of dirs) {
        try {
          const raw = await readFile(join(localPath, d, 'meta.json'), 'utf-8');
          const meta = JSON.parse(raw) as BackupMeta;
          if (meta.permanent) continue;
          const expiresAt = new Date(meta.timestamp).getTime() + meta.retention_days * 24 * 60 * 60_000;
          if (Date.now() > expiresAt) {
            await rm(join(localPath, d), { recursive: true });
          }
        } catch { /* skip */ }
      }
    } catch { /* no backups dir */ }
  }

  private async uploadToS3(backupDir: string, id: string): Promise<void> {
    if (!this.config.s3_bucket) return;
    const S3 = await (Function('return import("@aws-sdk/client-s3")')() as Promise<typeof import('@aws-sdk/client-s3')>);
    const client = new S3.S3Client({});
    const files = await readdir(backupDir);
    for (const f of files) {
      const body = await readFile(join(backupDir, f));
      await client.send(new S3.PutObjectCommand({
        Bucket: this.config.s3_bucket,
        Key: `${id}/${f}`,
        Body: body,
      }));
    }
  }
}
```

- [ ] **Step 2: Export from skills index**

Add to `packages/skills/src/index.ts`:
```typescript
export { SystemBackupSkill } from './built-in/system-backup.js';
```

- [ ] **Step 3: Build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/built-in/system-backup.ts packages/skills/src/index.ts
git commit -m "feat: System-Backup-Skill — backup/restore/list/status/configure/delete"
```

---

### Task 7: Skill-Registrierung + Cron-Scheduler in alfred.ts

**Files:**
- Modify: `packages/core/src/alfred.ts`

- [ ] **Step 1: Import and register SystemBackupSkill**

After the Database-Skill registration block (~line 1410), add:

```typescript
    // 4v. System Backup (optional)
    if (this.config.backup?.enabled) {
      const { SystemBackupSkill } = await import('@alfred/skills');
      const backupSkill = new SystemBackupSkill(
        this.config.backup,
        adapter,
        this.config.cluster?.nodeId ?? 'single',
        pkg.version,
      );
      this.skillRegistry.register(backupSkill);
    }
```

- [ ] **Step 2: Add cron scheduler for automatic backups**

In the `start()` method, after the existing schedulers (~line 2213), add:

```typescript
    // Scheduled system backups
    if (this.config.backup?.enabled && this.config.backup?.storage !== 'none') {
      const backupSkill = this.skillRegistry.get('system_backup') as any;
      if (backupSkill) {
        const schedule = this.config.backup.schedule ?? '0 3 * * *';
        // Parse cron: check every 60s if it's time
        setInterval(async () => {
          const now = new Date();
          const [min, hour, dom, mon, dow] = schedule.split(' ');
          if (!this.matchCron(now, min, hour, dom, mon, dow)) return;
          // Cluster-aware: only one node runs backup
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('system-backup');
            if (!claimed) return;
          }
          try {
            await backupSkill.createBackup({}, 'scheduled');
            this.logger.info('Scheduled system backup completed');
          } catch (err) {
            this.logger.warn({ err }, 'Scheduled system backup failed');
          }
        }, 60_000);
      }
    }
```

- [ ] **Step 3: Add matchCron helper**

```typescript
  private matchCron(now: Date, min: string, hour: string, dom: string, mon: string, dow: string): boolean {
    const m = (f: string, v: number) => {
      if (f === '*') return true;
      if (f.includes('/')) { const [, step] = f.split('/'); return v % parseInt(step) === 0; }
      return f.split(',').some(p => parseInt(p) === v);
    };
    return m(min, now.getMinutes()) && m(hour, now.getHours()) && m(dom, now.getDate()) && m(mon, now.getMonth() + 1) && m(dow, now.getDay());
  }
```

- [ ] **Step 4: Register platform for ClaimManager failover**

In the AdapterClaimManager section, add:
```typescript
    if (this.adapterClaimManager && this.config.backup?.enabled) {
      this.adapterClaimManager.registerPlatform('system-backup');
    }
```

- [ ] **Step 5: Build**

```bash
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/alfred.ts
git commit -m "feat: System-Backup Registrierung + Cron-Scheduler + HA ClaimManager"
```

---

### Task 8: Version bump, CHANGELOG, Bundle, Push

- [ ] **Step 1: Version bump**

```bash
npm --no-git-tag-version version 0.19.0-multi-ha.475 --prefix packages/cli
```

- [ ] **Step 2: CHANGELOG**

Add entry for the new version with all backup features.

- [ ] **Step 3: Build + Bundle**

```bash
pnpm build && node scripts/bundle.mjs
```

- [ ] **Step 4: Commit + Push**

```bash
git add packages/cli/package.json CHANGELOG.md packages/cli/bundle/
git commit -m "feat: Backup & Restore — Database-Skill + System-Backup-Skill"
git push gitlab feature/multi-user && git push github feature/multi-user
```
