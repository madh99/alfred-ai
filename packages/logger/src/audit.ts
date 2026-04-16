import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry } from '@alfred/types';

const auditRedactOpts = {
  paths: [
    '**.apiKey', '**.token', '**.password', '**.secret',
    '**.accessToken', '**.refreshToken', '**.clientSecret',
    '**.Authorization', '**.authorization',
    '**.bearer', '**.credential', '**.jwt',
    '**.x-api-key', '**.x-auth-token',
  ],
  censor: '[REDACTED]',
};

export class AuditLogger {
  private logger: pino.Logger;

  constructor(auditLogPath: string = './data/logs/audit.log') {
    // Ensure directory exists
    try { mkdirSync(dirname(auditLogPath), { recursive: true }); } catch { /* exists */ }

    const transport = pino.transport({
      target: 'pino-roll',
      options: {
        file: auditLogPath,
        size: '10m',
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        limit: { count: 30 }, // Audit logs: 30 days retention
      },
    });
    this.logger = pino({ name: 'audit', redact: auditRedactOpts }, transport);
  }

  log(entry: AuditEntry): void {
    this.logger.info({
      id: entry.id,
      timestamp: entry.timestamp,
      userId: entry.userId,
      action: entry.action,
      riskLevel: entry.riskLevel,
      ruleId: entry.ruleId,
      effect: entry.effect,
      platform: entry.platform,
      chatId: entry.chatId,
      context: entry.context,
    });
  }
}
