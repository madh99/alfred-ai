import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter } from '../db-adapter.js';

/**
 * v663b — 22 vorgefertigte Automation-Templates pro Projekt.
 * Jedes Template hat:
 *   - prompt-template: Wird beim Lauf an den LLM gesendet (mit Projekt-Kontext)
 *   - default-schedule: empfohlene Cron-Expression (kann vom User überschrieben werden)
 *   - data-collectors: optionale Pre-Run-Steps (z.B. `git log`, `npm audit`)
 *   - output-format: text/markdown
 */
export type AutomationTemplateKind =
  // Core (v663b vollständig implementiert):
  | 'daily_standup'
  | 'weekly_progress'
  | 'release_prep'
  | 'code_review'
  | 'dependency_check'
  | 'open_items_triage'
  | 'documentation_drift'
  // Erweiterungen (Stub mit Projekt-Kontext-Prompt):
  | 'test_coverage_drift'
  | 'activity_digest'
  | 'auto_rebase'
  | 'brainstorming_pulse'
  | 'pr_pflege'
  | 'security_sentinel'
  | 'performance_baseline'
  | 'onboarding_doc'
  | 'cost_tracking'
  | 'stakeholder_briefing'
  | 'license_audit'
  | 'pre_mortem'
  | 'adr_decisions'
  | 'demo_day_prep'
  | 'recurring_bug_detector'
  // v882 — Agent-/Aktions-Templates (echte Läufe/Aktionen statt LLM-Text):
  | 'deep_code_review'
  | 'auto_rebase_execute'
  | 'security_incident_gate'
  // Custom:
  | 'custom';

export type AutomationOutputDestination = 'telegram' | 'project_chat' | 'email' | 'web_notification';
export type AutomationRunStatus = 'success' | 'failed' | 'skipped';

export interface ProjectAutomation {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  templateKind: AutomationTemplateKind;
  /** Cron-Expression (z.B. '0 8 * * *') oder null wenn nur manuell */
  schedule?: string;
  /** Überschreibt den Default-Prompt des Templates */
  promptOverride?: string;
  outputDestination: AutomationOutputDestination;
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: AutomationRunStatus;
  lastRunOutput?: string;
  nextRunAt?: string;
  createdAt: string;
}

export class ProjectAutomationsRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: Omit<ProjectAutomation, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunOutput' | 'nextRunAt' | 'enabled'> & { enabled?: boolean }): Promise<ProjectAutomation> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled ?? true;
    await this.adapter.execute(`
      INSERT INTO project_automations (id, project_id, user_id, name, template_kind, schedule, prompt_override, output_destination, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, input.projectId, input.userId, input.name, input.templateKind, input.schedule ?? null, input.promptOverride ?? null, input.outputDestination, enabled ? 1 : 0, now]);
    return { ...input, id, enabled, createdAt: now };
  }

  async listByProject(projectId: string): Promise<ProjectAutomation[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_automations WHERE project_id = ? ORDER BY created_at DESC`,
      [projectId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getById(id: string): Promise<ProjectAutomation | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_automations WHERE id = ?`, [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async update(id: string, patch: Partial<Pick<ProjectAutomation, 'name' | 'schedule' | 'promptOverride' | 'outputDestination' | 'enabled' | 'nextRunAt'>>): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.schedule !== undefined) { sets.push('schedule = ?'); params.push(patch.schedule); }
    if (patch.promptOverride !== undefined) { sets.push('prompt_override = ?'); params.push(patch.promptOverride); }
    if (patch.outputDestination !== undefined) { sets.push('output_destination = ?'); params.push(patch.outputDestination); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.nextRunAt !== undefined) { sets.push('next_run_at = ?'); params.push(patch.nextRunAt); }
    if (sets.length === 0) return false;
    params.push(id);
    const r = await this.adapter.execute(`UPDATE project_automations SET ${sets.join(', ')} WHERE id = ?`, params);
    return r.changes > 0;
  }

  async recordRun(id: string, status: AutomationRunStatus, output: string, nextRunAt?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      `UPDATE project_automations SET last_run_at = ?, last_run_status = ?, last_run_output = ?, next_run_at = ? WHERE id = ?`,
      [now, status, output.slice(0, 8000), nextRunAt ?? null, id],
    );
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.adapter.execute(`DELETE FROM project_automations WHERE id = ?`, [id]);
    return r.changes > 0;
  }

  /** Liste fälliger Automations (next_run_at <= now() AND enabled) für den Cron-Runner. */
  async listDue(): Promise<ProjectAutomation[]> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      `SELECT * FROM project_automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50`,
      [now],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): ProjectAutomation {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      userId: row.user_id as string,
      name: row.name as string,
      templateKind: row.template_kind as AutomationTemplateKind,
      schedule: (row.schedule as string | null) ?? undefined,
      promptOverride: (row.prompt_override as string | null) ?? undefined,
      outputDestination: (row.output_destination as AutomationOutputDestination) ?? 'telegram',
      enabled: (row.enabled as number) === 1,
      lastRunAt: (row.last_run_at as string | null) ?? undefined,
      lastRunStatus: (row.last_run_status as AutomationRunStatus | null) ?? undefined,
      lastRunOutput: (row.last_run_output as string | null) ?? undefined,
      nextRunAt: (row.next_run_at as string | null) ?? undefined,
      createdAt: row.created_at as string,
    };
  }
}
