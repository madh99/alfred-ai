import fs from 'node:fs';
import path from 'node:path';
import { ConfigLoader } from '@alfred/config';
import { Database, AuditRepository } from '@alfred/storage';
import type { AuditEntry } from '@alfred/types';

export async function logsCommand(tail: number): Promise<void> {
  const configLoader = new ConfigLoader();

  let config;
  try {
    config = configLoader.loadConfig();
  } catch (error) {
    console.error('Failed to load configuration:', (error as Error).message);
    process.exit(1);
  }

  const dbPath = path.resolve(config.storage.path);

  if (!fs.existsSync(dbPath)) {
    console.log(`Database not found at: ${dbPath}`);
    console.log('No audit log entries. Alfred has not been run yet, or the database path is incorrect.');
    return;
  }

  let database: Database | undefined;
  try {
    database = new Database(dbPath);
    const auditRepo = new AuditRepository(database.getDb());

    const totalCount = auditRepo.count({});
    const entries: AuditEntry[] = auditRepo.query({ limit: tail });

    console.log('Alfred — Audit Log');
    console.log('===================');
    console.log(`Total entries: ${totalCount}`);
    console.log(`Showing last ${Math.min(tail, totalCount)} entries:`);
    console.log('');

    if (entries.length === 0) {
      console.log('No audit log entries found.');
      return;
    }

    for (const entry of entries) {
      const timestamp = entry.timestamp.toISOString();
      const effect = entry.effect === 'allow' ? 'ALLOW' : 'DENY ';
      console.log(`  ${timestamp}  [${effect}]  ${entry.action}`);
      console.log(`    user: ${entry.userId} | platform: ${entry.platform} | risk: ${entry.riskLevel}`);
      if (entry.ruleId) {
        console.log(`    rule: ${entry.ruleId}`);
      }
      if (entry.chatId) {
        console.log(`    chat: ${entry.chatId}`);
      }
      if (entry.context) {
        console.log(`    context: ${JSON.stringify(entry.context)}`);
      }
      console.log('');
    }
  } catch (error) {
    console.error('Failed to read audit log:', (error as Error).message);
    process.exit(1);
  } finally {
    if (database) {
      database.close();
    }
  }
}
