import fs from 'node:fs';
import path from 'node:path';
import { ConfigLoader } from '@alfred/config';
import { Database, AuditRepository, ActivityRepository } from '@alfred/storage';
import type { AuditEntry, ActivityEntry } from '@alfred/types';

export async function logsCommand(tail: number, opts?: {
  activity?: boolean;
  type?: string;
  source?: string;
  outcome?: string;
  since?: string;
  stats?: boolean;
}): Promise<void> {
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
    console.log('No log entries. Alfred has not been run yet, or the database path is incorrect.');
    return;
  }

  let database: Database | undefined;
  try {
    database = new Database(dbPath);

    if (opts?.activity) {
      showActivityLog(database, tail, opts);
    } else {
      showAuditLog(database, tail);
    }
  } catch (error) {
    console.error('Failed to read log:', (error as Error).message);
    process.exit(1);
  } finally {
    if (database) {
      database.close();
    }
  }
}

function showAuditLog(database: Database, tail: number): void {
  const auditRepo = new AuditRepository(database.getDb());

  const totalCount = auditRepo.count({});
  const entries: AuditEntry[] = auditRepo.query({ limit: tail });

  console.log('Alfred — Audit Log (Security)');
  console.log('==============================');
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
}

function showActivityLog(database: Database, tail: number, opts: {
  type?: string;
  source?: string;
  outcome?: string;
  since?: string;
  stats?: boolean;
}): void {
  const activityRepo = new ActivityRepository(database.getDb());

  if (opts.stats) {
    const stats = activityRepo.stats(opts.since);
    console.log('Alfred — Activity Stats');
    console.log('========================');
    if (opts.since) console.log(`Since: ${opts.since}`);
    console.log('');

    if (stats.length === 0) {
      console.log('No activity entries found.');
      return;
    }

    const maxType = Math.max(...stats.map(s => s.eventType.length), 10);
    const maxOutcome = Math.max(...stats.map(s => s.outcome.length), 7);
    console.log(`  ${'EVENT TYPE'.padEnd(maxType)}  ${'OUTCOME'.padEnd(maxOutcome)}  COUNT`);
    console.log(`  ${'─'.repeat(maxType)}  ${'─'.repeat(maxOutcome)}  ─────`);
    for (const s of stats) {
      console.log(`  ${s.eventType.padEnd(maxType)}  ${s.outcome.padEnd(maxOutcome)}  ${s.count}`);
    }
    return;
  }

  const totalCount = activityRepo.count({
    eventType: opts.type,
    source: opts.source,
    outcome: opts.outcome,
  });
  const entries: ActivityEntry[] = activityRepo.query({
    eventType: opts.type,
    source: opts.source,
    outcome: opts.outcome,
    since: opts.since,
    limit: tail,
  });

  console.log('Alfred — Activity Log');
  console.log('======================');
  console.log(`Total entries: ${totalCount}`);
  if (opts.type) console.log(`Filter: type=${opts.type}`);
  if (opts.source) console.log(`Filter: source=${opts.source}`);
  if (opts.outcome) console.log(`Filter: outcome=${opts.outcome}`);
  console.log(`Showing last ${Math.min(tail, totalCount)} entries:`);
  console.log('');

  if (entries.length === 0) {
    console.log('No activity entries found.');
    return;
  }

  for (const entry of entries) {
    const outcomeLabel = formatOutcome(entry.outcome);
    const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';
    console.log(`  ${entry.timestamp}  [${outcomeLabel}]  ${entry.eventType}: ${entry.action}${duration}`);
    console.log(`    source: ${entry.source}${entry.sourceId ? ` (${entry.sourceId.slice(0, 8)})` : ''} | platform: ${entry.platform ?? '-'}`);
    if (entry.userId) {
      console.log(`    user: ${entry.userId}`);
    }
    if (entry.errorMessage) {
      console.log(`    error: ${entry.errorMessage.slice(0, 200)}`);
    }
    if (entry.details) {
      console.log(`    details: ${JSON.stringify(entry.details)}`);
    }
    console.log('');
  }
}

function formatOutcome(outcome: string): string {
  switch (outcome) {
    case 'success': return '\x1b[32mSUCCESS\x1b[0m';
    case 'error': return '\x1b[31mERROR  \x1b[0m';
    case 'denied': return '\x1b[31mDENIED \x1b[0m';
    case 'approved': return '\x1b[32mAPPROVED\x1b[0m';
    case 'rejected': return '\x1b[33mREJECTED\x1b[0m';
    case 'expired': return '\x1b[33mEXPIRED\x1b[0m';
    case 'skipped': return '\x1b[90mSKIPPED\x1b[0m';
    default: return outcome.toUpperCase();
  }
}
