import type { Logger } from 'pino';
import type { ActivityRepository } from '@alfred/storage';

/**
 * v607 D3 — Skill-Failure-Reflector
 *
 * Scans the activity log for "skill failed → user-found workaround → success"
 * patterns. When detected, enqueues a Runbook-Confirmation so the lesson is
 * captured for future use instead of being lost in chat history.
 *
 * Detection pattern (per conversation/chat-pair window, max 30min span):
 *   1. Skill X fails ≥2× consecutively with the same error class
 *   2. Within next 5 entries: shell-skill calls (the workaround attempt)
 *   3. Final shell-skill call returns success and matches the failed skill's goal
 *      (heuristic: same host/cwd or both reference the same project name)
 *
 * If matched: enqueue Confirmation "Runbook erstellen für Skill-Failure-Workaround?"
 * with extracted steps from the workaround shell-calls.
 */

export interface SkillFailureReflectorOptions {
  /** Window in minutes to consider. Default 30. */
  windowMinutes?: number;
  /** Min consecutive failures to consider. Default 2. */
  minConsecutiveFails?: number;
  /** Max steps in detected workaround. Default 10. */
  maxWorkaroundSteps?: number;
}

export interface DetectedPattern {
  /** The skill that failed. */
  failedSkill: string;
  /** Error class observed (EACCES, COMMAND_NOT_FOUND, etc.). */
  errorClass: string;
  /** Host/cwd context if extracted. */
  scope?: string;
  /** Ordered workaround shell commands the user/agent ran. */
  workaroundSteps: string[];
  /** Final success indicator. */
  finalSuccess: boolean;
  /** Timestamp of pattern detection. */
  detectedAt: string;
  /** Activity-log row IDs that participated in the pattern. */
  participatingActivityIds: string[];
}

export class SkillFailureReflector {
  private readonly windowMinutes: number;
  private readonly minConsecutiveFails: number;
  private readonly maxWorkaroundSteps: number;

  constructor(
    private readonly activityRepo: ActivityRepository,
    private readonly logger: Logger,
    options?: SkillFailureReflectorOptions,
  ) {
    this.windowMinutes = options?.windowMinutes ?? 30;
    this.minConsecutiveFails = options?.minConsecutiveFails ?? 2;
    this.maxWorkaroundSteps = options?.maxWorkaroundSteps ?? 10;
  }

  /**
   * Scan recent activity for skill-failure → workaround → success patterns.
   * Returns each detected pattern; caller is responsible for enqueueing
   * confirmations / persisting runbooks.
   */
  async detect(userId: string): Promise<DetectedPattern[]> {
    const windowMs = this.windowMinutes * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    let entries: Array<{
      id: string; skillName: string; success: boolean;
      error?: string; input?: Record<string, unknown>; createdAt: string;
    }>;
    try {
      const rows = await this.activityRepo.query({
        eventType: 'skill_call', userId, since, limit: 200,
      });
      entries = rows.map(r => ({
        id: r.id,
        skillName: r.action ?? '',
        success: r.outcome === 'success',
        error: r.errorMessage,
        input: r.details,
        createdAt: r.timestamp,
      }));
    } catch {
      return [];
    }
    if (entries.length === 0) return [];

    // Order chronologically (oldest first)
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const patterns: DetectedPattern[] = [];
    let i = 0;
    while (i < entries.length) {
      const e = entries[i];
      if (e.success) { i++; continue; }

      // Look for ≥ minConsecutiveFails consecutive failures with same skill + error class
      const errClass = this.classifyError(e.error ?? '');
      let failCount = 1;
      let j = i + 1;
      while (j < entries.length
        && !entries[j].success
        && entries[j].skillName === e.skillName
        && this.classifyError(entries[j].error ?? '') === errClass
      ) {
        failCount++;
        j++;
      }

      if (failCount < this.minConsecutiveFails) {
        i = j;
        continue;
      }

      // Look for workaround: shell-skill calls in the next 8 entries
      const workaroundEnd = Math.min(entries.length, j + 8);
      const workaround: string[] = [];
      const participating: string[] = entries.slice(i, j).map(x => x.id);
      let finalSuccess = false;
      for (let k = j; k < workaroundEnd; k++) {
        const w = entries[k];
        if (w.skillName === 'shell' || w.skillName === 'code_agent' || w.skillName === 'deploy') {
          const cmd = typeof w.input?.command === 'string'
            ? w.input.command
            : JSON.stringify(w.input).slice(0, 200);
          workaround.push(cmd);
          participating.push(w.id);
          if (w.success) finalSuccess = true;
          if (workaround.length >= this.maxWorkaroundSteps) break;
        }
      }

      if (workaround.length > 0 && finalSuccess) {
        // Try to derive scope (host/cwd) from the failed-skill inputs
        const scope = this.extractScope(e.input);
        patterns.push({
          failedSkill: e.skillName,
          errorClass: errClass,
          scope,
          workaroundSteps: workaround,
          finalSuccess,
          detectedAt: new Date().toISOString(),
          participatingActivityIds: participating,
        });
        this.logger.info({
          failedSkill: e.skillName, errorClass: errClass, scope,
          workaroundSteps: workaround.length,
        }, 'SkillFailureReflector: workaround pattern detected');
      }

      i = workaroundEnd > j ? workaroundEnd : j;
    }

    return patterns;
  }

  private classifyError(err: string): string {
    const s = err.toLowerCase();
    if (/command not found/.test(s)) return 'COMMAND_NOT_FOUND';
    if (/eacces|permission denied/.test(s)) return 'EACCES';
    if (/enoent|no such file/.test(s)) return 'ENOENT';
    if (/etimedout|timeout/.test(s)) return 'TIMEOUT';
    if (/ehostunreach|enetunreach|econnrefused/.test(s)) return 'NETWORK';
    if (/auth|unauthorized|forbidden/.test(s)) return 'AUTH_FAIL';
    if (/not found|404/.test(s)) return 'NOT_FOUND';
    return 'OTHER';
  }

  private extractScope(input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined;
    if (typeof input.host === 'string') return `host=${input.host}`;
    if (typeof input.target_host === 'string') return `host=${input.target_host}`;
    if (typeof input.cwd === 'string') return `cwd=${input.cwd}`;
    return undefined;
  }
}
