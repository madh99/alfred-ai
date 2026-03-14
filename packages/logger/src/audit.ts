import pino from 'pino';
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

  constructor(auditLogPath: string = './data/audit.log') {
    const dest = pino.destination(auditLogPath);
    this.logger = pino({ name: 'audit', redact: auditRedactOpts }, dest);
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
