import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry } from '@alfred/types';
import { RotatingFileStream } from './rotating-file-stream.js';

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
    try { mkdirSync(dirname(auditLogPath), { recursive: true }); } catch { /* exists */ }

    // v843 — replaced pino.transport({ target: 'pino-roll' }) with a main-thread
    // RotatingFileStream. Same daily+size rotation behaviour, no worker-thread
    // race at midnight. See packages/logger/src/rotating-file-stream.ts.
    const stream = new RotatingFileStream({
      filePath: auditLogPath,
      maxSize: 10 * 1024 * 1024,
      maxFiles: 30,
      symlink: true,
    });
    stream.on('error', (err) => {
      try { process.stderr.write(`[audit] file stream error: ${(err as Error).message}\n`); } catch { /* */ }
    });
    this.logger = pino({ name: 'audit', redact: auditRedactOpts }, stream);
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
