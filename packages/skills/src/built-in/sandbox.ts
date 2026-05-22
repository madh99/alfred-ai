import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { SandboxRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action = 'status' | 'list' | 'pause' | 'resume' | 'destroy' | 'discard' | 'cleanup_idle';

export interface SandboxSkillCallbacks {
  /** Liefert den aktuellen Status des Sandbox-Managers (von alfred.ts gesetzt). */
  getStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  pause?: (sandboxId: string) => Promise<void>;
  resume?: (sandboxId: string) => Promise<void>;
  destroy?: (sandboxId: string) => Promise<void>;
  discard?: (sandboxId: string) => Promise<void>;
  cleanupIdle?: () => Promise<{ paused: number; cleaned: number }>;
}

/**
 * v697 — Sandbox-Skill: Wrapper über den SandboxManager für CLI-Tests,
 * Memory-Skill-Trigger, und (v700) periodischen Cleanup via Watch-Skill.
 *
 * Wenn die Callbacks nicht gesetzt sind (Feature disabled), liefert der Skill
 * eine klare Fehlermeldung — kein Crash.
 */
export class SandboxSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'sandbox',
    riskLevel: 'destructive',
    version: '1.0.0',
    category: 'automation',
    description:
      'Verwaltet Project-Agent-Sandboxes (Worktree + Container + Live-Preview). ' +
      '"status" zeigt Feature-Verfügbarkeit. ' +
      '"list" listet aktive Sandboxes. ' +
      '"pause sandbox_id=…" stoppt den Container, Worktree bleibt. ' +
      '"resume sandbox_id=…" startet pausierten Container neu. ' +
      '"discard sandbox_id=…" entfernt Container + Worktree + Branch (Änderungen weg). ' +
      '"destroy sandbox_id=…" Cleanup ohne Result-Marker. ' +
      '"cleanup_idle" prüft idle/stale Sandboxes (für Cleanup-Worker).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'pause', 'resume', 'destroy', 'discard', 'cleanup_idle'] },
        sandbox_id: { type: 'string' },
      },
    },
  };

  private callbacks: SandboxSkillCallbacks = {};

  constructor(private readonly repo: SandboxRepository) {
    super();
  }

  setCallbacks(cb: SandboxSkillCallbacks): void {
    this.callbacks = cb;
  }

  async execute(input: Record<string, unknown>, _ctx: SkillContext): Promise<SkillResult> {
    const action = (input.action ?? 'status') as Action;
    const sandboxId = typeof input.sandbox_id === 'string' ? input.sandbox_id : undefined;

    switch (action) {
      case 'status': {
        const status = await (this.callbacks.getStatus?.() ?? Promise.resolve({ enabled: false, available: false, reason: 'no-manager' }));
        return { success: true, data: status, display: `Sandbox-Status: available=${(status as Record<string, unknown>).available}` };
      }
      case 'list': {
        const userId = _ctx.userId;
        if (!userId) return { success: false, error: 'user-context missing' };
        const sandboxes = await this.repo.listActiveByUser(userId);
        return {
          success: true,
          data: { sandboxes, count: sandboxes.length },
          display: sandboxes.length === 0
            ? 'Keine aktiven Sandboxes.'
            : sandboxes.map(s => `${s.id.slice(0, 8)} · ${s.status} · ${s.projectType} · port ${s.hostPort ?? '—'} · branch ${s.branchName}`).join('\n'),
        };
      }
      case 'pause': {
        if (!sandboxId) return { success: false, error: 'sandbox_id required' };
        if (!this.callbacks.pause) return { success: false, error: 'Sandbox-Feature disabled' };
        await this.callbacks.pause(sandboxId);
        return { success: true, display: `Sandbox ${sandboxId.slice(0, 8)} pausiert.` };
      }
      case 'resume': {
        if (!sandboxId) return { success: false, error: 'sandbox_id required' };
        if (!this.callbacks.resume) return { success: false, error: 'Sandbox-Feature disabled' };
        await this.callbacks.resume(sandboxId);
        return { success: true, display: `Sandbox ${sandboxId.slice(0, 8)} resumed.` };
      }
      case 'discard': {
        if (!sandboxId) return { success: false, error: 'sandbox_id required' };
        if (!this.callbacks.discard) return { success: false, error: 'Sandbox-Feature disabled' };
        await this.callbacks.discard(sandboxId);
        return { success: true, display: `Sandbox ${sandboxId.slice(0, 8)} verworfen — Worktree + Branch entfernt.` };
      }
      case 'destroy': {
        if (!sandboxId) return { success: false, error: 'sandbox_id required' };
        if (!this.callbacks.destroy) return { success: false, error: 'Sandbox-Feature disabled' };
        await this.callbacks.destroy(sandboxId);
        return { success: true, display: `Sandbox ${sandboxId.slice(0, 8)} destroyed.` };
      }
      case 'cleanup_idle': {
        if (!this.callbacks.cleanupIdle) return { success: true, data: { paused: 0, cleaned: 0 }, display: 'Sandbox-Feature disabled — no cleanup needed.' };
        const r = await this.callbacks.cleanupIdle();
        return { success: true, data: r, display: `Cleanup: ${r.paused} pausiert, ${r.cleaned} entfernt.` };
      }
      default:
        return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }
}
