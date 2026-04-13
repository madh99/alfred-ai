import type { SkillMetadata, SkillContext, SkillResult, BackupConfig, FileStoreConfig } from '@alfred/types';
import type { AsyncDbAdapter } from '@alfred/storage';
import { Skill } from '../skill.js';
import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
        label: { type: 'string', description: 'Backup-Label' },
        retention_days: { type: 'number', description: 'Individuelle Retention für dieses Backup' },
        permanent: { type: 'boolean', description: 'Backup niemals automatisch löschen' },
        backup_id: { type: 'string', description: 'Backup-ID (für restore/delete)' },
        limit: { type: 'number', description: 'Anzahl Backups in Liste (default 10)' },
        schedule: { type: 'string', description: 'Neuer Cron-Zeitplan (für configure)' },
        storage: { type: 'string', description: 'Speicherort: local/s3/both/none' },
        restore_via_chat: { type: 'boolean', description: 'Restore per Chat erlauben' },
      },
      required: ['action'],
    },
  };

  private config: BackupConfig;
  private readonly dbAdapter: AsyncDbAdapter;
  private readonly nodeId: string;
  private readonly alfredVersion: string;
  private readonly fileStoreConfig?: FileStoreConfig;

  constructor(config: BackupConfig, dbAdapter: AsyncDbAdapter, nodeId: string, alfredVersion: string, fileStoreConfig?: FileStoreConfig) {
    super();
    this.config = { ...config };
    this.dbAdapter = dbAdapter;
    this.nodeId = nodeId;
    this.alfredVersion = alfredVersion;
    this.fileStoreConfig = fileStoreConfig;
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

  async createBackup(input: Record<string, unknown>, type: 'manual' | 'scheduled' = 'manual'): Promise<SkillResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = timestamp;
    const localPath = this.config.local_path ?? '/root/alfred/backups';
    const backupDir = join(localPath, id);
    await mkdir(backupDir, { recursive: true });

    const includes: string[] = [];
    let totalSize = 0;
    const start = Date.now();

    // 1. Database
    try {
      if (this.dbAdapter.type === 'postgres') {
        const connStr = (this.dbAdapter as any).connString as string | undefined;
        const outFile = join(backupDir, 'alfred.dump');
        if (connStr) {
          // pg_dump supports connection string directly via --dbname
          const args = ['--format', 'custom', '--file', outFile, '--dbname', connStr];
          await execFileAsync('pg_dump', args, { timeout: 300_000 });
        } else {
          // Fallback: try default local connection
          await execFileAsync('pg_dump', ['--format', 'custom', '--file', outFile, '--dbname', 'alfred'], { timeout: 300_000 });
        }
        const st = await stat(outFile);
        totalSize += st.size;
        includes.push('database');
      } else {
        // SQLite — better-sqlite3 Database has .name property = file path
        const dbPath = (this.dbAdapter as any).db?.name as string | undefined;
        const outFile = join(backupDir, 'alfred.sqlite');
        if (dbPath) {
          // Direct file copy is safest for SQLite backup
          await copyFile(dbPath, outFile);
          const st = await stat(outFile);
          totalSize += st.size;
          includes.push('database');
        }
      }
    } catch { /* DB backup failed — continue with files */ }

    // 2. Tokens
    if (this.config.include_tokens !== false) {
      try {
        const alfredDir = join(homedir(), '.alfred');
        const tokenDir = join(backupDir, 'tokens');
        await mkdir(tokenDir, { recursive: true });
        const files = await readdir(alfredDir);
        for (const f of files) {
          if (f.endsWith('.json')) {
            await copyFile(join(alfredDir, f), join(tokenDir, f));
            const st = await stat(join(alfredDir, f));
            totalSize += st.size;
          }
        }
        includes.push('tokens');
      } catch { /* no tokens */ }
    }

    // 3. Config
    if (this.config.include_config !== false) {
      for (const cfgName of ['config.yaml', 'config.yml', '.env', 'alfred.env']) {
        try {
          const cfgPath = join(process.cwd(), cfgName);
          await stat(cfgPath);
          await copyFile(cfgPath, join(backupDir, cfgName));
          includes.push('config');
          break;
        } catch { /* not found */ }
      }
    }

    // 4. Metadata
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

    // 5. S3 upload
    if (this.config.storage === 's3' || this.config.storage === 'both') {
      try { await this.uploadToS3(backupDir, id); } catch { /* non-fatal */ }
    }

    // 6. Cleanup expired
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
    } catch { /* no backups */ }

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
    try {
      await rm(join(localPath, backupId), { recursive: true });
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
          if (Date.now() > expiresAt) await rm(join(localPath, d), { recursive: true });
        } catch { /* skip */ }
      }
    } catch { /* no backups */ }
  }

  private async uploadToS3(backupDir: string, id: string): Promise<void> {
    const bucket = this.config.s3_bucket;
    if (!bucket) return;

    const S3 = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);

    // Use FileStore S3 credentials if available, otherwise fall back to AWS env vars
    const s3Options: Record<string, unknown> = {};
    const endpoint = this.fileStoreConfig?.s3Endpoint;
    const accessKey = this.fileStoreConfig?.s3AccessKey;
    const secretKey = this.fileStoreConfig?.s3SecretKey;
    const region = this.fileStoreConfig?.s3Region ?? 'us-east-1';

    if (endpoint) s3Options.endpoint = endpoint;
    if (accessKey && secretKey) {
      s3Options.credentials = { accessKeyId: accessKey, secretAccessKey: secretKey };
    }
    s3Options.region = region;
    s3Options.forcePathStyle = true; // MinIO needs path-style

    const client = new S3.S3Client(s3Options);
    const files = await readdir(backupDir);
    for (const f of files) {
      const body = await readFile(join(backupDir, f));
      await client.send(new S3.PutObjectCommand({ Bucket: bucket, Key: `${id}/${f}`, Body: body }));
    }
  }
}
