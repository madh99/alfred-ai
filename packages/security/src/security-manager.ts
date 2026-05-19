import crypto from 'node:crypto';
import type { SecurityEvaluation, AuditEntry } from '@alfred/types';
import type { AuditRepository } from '@alfred/storage';
import type { EvaluationContext } from './rule-engine.js';
import { RuleEngine } from './rule-engine.js';

/** Minimal logger interface compatible with pino.Logger */
export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** File-based audit sink (v603) — optional second-tier audit log. Loose coupling so
 *  the @alfred/logger AuditLogger can be injected without security pulling on logger. */
export interface AuditFileSink {
  log(entry: AuditEntry): void;
}

export class SecurityManager {
  private ruleEngine: RuleEngine;
  private auditRepository: AuditRepository;
  private logger: Logger;
  private fileSink?: AuditFileSink;

  constructor(ruleEngine: RuleEngine, auditRepository: AuditRepository, logger: Logger, fileSink?: AuditFileSink) {
    this.ruleEngine = ruleEngine;
    this.auditRepository = auditRepository;
    this.logger = logger;
    this.fileSink = fileSink;
  }

  evaluate(context: EvaluationContext & { chatId?: string }): SecurityEvaluation {
    const evaluation = this.ruleEngine.evaluate(context);

    const auditEntry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: evaluation.timestamp,
      userId: context.userId,
      action: context.action,
      riskLevel: context.riskLevel,
      ruleId: evaluation.matchedRule?.id,
      effect: evaluation.allowed ? 'allow' : 'deny',
      platform: context.platform,
      chatId: context.chatId,
      context: {
        chatType: context.chatType,
        reason: evaluation.reason,
      },
    };

    try {
      this.auditRepository.log(auditEntry);
    } catch (err) {
      this.logger.error({ err, auditEntry }, 'Failed to write audit log entry');
    }
    // v603 — additional file-based audit sink (when configured). Errors are
    // swallowed so a broken file-sink never blocks security evaluations.
    if (this.fileSink) {
      try { this.fileSink.log(auditEntry); } catch { /* non-critical */ }
    }

    this.logger.debug(
      {
        userId: context.userId,
        action: context.action,
        allowed: evaluation.allowed,
        ruleId: evaluation.matchedRule?.id,
        reason: evaluation.reason,
      },
      'Security evaluation completed',
    );

    return evaluation;
  }
}
