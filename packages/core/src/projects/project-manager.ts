import type { Logger } from 'pino';
import type {
  Project, ProjectRepository, ProjectSession, ProjectSessionSummary, ProjectSessionType,
} from '@alfred/storage';
import type { SessionSummarizer, SummarizerInput } from './session-summarizer.js';

export interface AttachSessionParams {
  userId: string;
  /** Identifies the originating session (e.g. project-agent taskId). */
  sourceId: string;
  sessionType: ProjectSessionType;
  /** Goal/title of the work, used to seed an auto-created project. */
  goal: string;
  /** Working directory — primary key for auto-binding to existing projects. */
  cwd?: string;
  /** Optional repo URL. */
  repoUrl?: string;
}

export interface FinishSessionParams {
  userId: string;
  sessionType: ProjectSessionType;
  sourceId: string;
  goal: string;
  cwd?: string;
  milestones?: string[];
  totalFilesChanged?: number;
  success?: boolean;
  transcript?: string;
  files?: string[];
}

/**
 * v616 NA1 — Derive a semantic project name. Priorität:
 *   1. basename(cwd) wenn cwd vorhanden (z.B. "alpbyte-games")
 *   2. erste sinnvolle Phrase aus goal-text (LLM-Boilerplate "Starte einen ...",
 *      "Erstelle ein ...", "Bearbeite das ..." entfernt; max 60 Zeichen)
 *   3. Fallback: "Session <kurz-id>"
 *
 * Exportiert + auch von der Startup-Cleanup-Funktion (rebuildProjectNames) genutzt.
 */
export function deriveProjectName(cwd: string | undefined, goal: string, sourceId: string): string {
  if (cwd && cwd.trim().length > 0) {
    const last = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    if (last && last.length > 0 && last !== 'home' && last !== 'root') {
      return last.slice(0, 80);
    }
  }
  const trimmed = (goal ?? '').trim();
  if (trimmed.length > 0) {
    const boilerplatePatterns = [
      /^Starte\s+(einen\s+)?(NEUEN\s+)?Projekt-Agent-Lauf\s+(für|fuer)\s+["'„""]?/i,
      /^Starte\s+(einen\s+)?(neuen\s+)?Project[-\s]Agent[-\s]Lauf\s+/i,
      /^Erstelle\s+(ein\s+)?(neues\s+)?Projekt\s+(für|fuer)?\s*["'„""]?/i,
      /^Bearbeite\s+(das\s+)?(bestehende\s+)?Projekt\s+["'„""]?/i,
      /^Im\s+Projekt\s+\/?[\w\/.-]+\s+(soll|wird)\s+/i,
      /^Bitte\s+(starte|erstelle|baue)\s+/i,
    ];
    let cleaned = trimmed;
    for (const re of boilerplatePatterns) cleaned = cleaned.replace(re, '');
    cleaned = cleaned.replace(/[.!?]\s+\S.*$/s, ''); // ersten Satz behalten
    cleaned = cleaned.replace(/^["'„""]|["'""„""]\s*$/g, '');
    cleaned = cleaned.trim();
    if (cleaned.length >= 3) return cleaned.slice(0, 60);
    return trimmed.slice(0, 60);
  }
  return `Session ${sourceId.slice(0, 8)}`;
}

/**
 * Glue layer: binds incoming sessions to long-lived Project containers,
 * runs the LLM summarizer on completion, and persists extracted open items + decisions.
 */
export class ProjectManager {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly summarizer: SessionSummarizer,
    private readonly logger: Logger,
    private readonly autoBindByCwd: boolean = true,
  ) {}

  /** Find-or-create the Project for an incoming session and persist the session row. */
  async attachSession(params: AttachSessionParams): Promise<{ project: Project; session: ProjectSession }> {
    const project = await this.findOrCreate(params);
    let session = await this.repo.findSessionBySource(params.sessionType, params.sourceId);
    if (!session) {
      session = await this.repo.createSession(project.id, {
        sessionType: params.sessionType,
        sourceId: params.sourceId,
      });
    }
    await this.repo.touch(project.id);
    return { project, session };
  }

  /** Called when a session finishes — runs the summarizer and persists the structured outcome.
   *
   * v604 L9: when the session failed AND produced no file changes, we skip the
   * auto-create. The old behavior left "active" Projects in the DB for total-
   * failure runs (alpbyte-games 19.05.) — those then show up in the project
   * list, get health-probed every 6h, and pollute the reasoning context.
   */
  async finishSession(params: FinishSessionParams): Promise<void> {
    if (params.success === false && (params.totalFilesChanged ?? 0) === 0) {
      this.logger.info({
        sourceId: params.sourceId, sessionType: params.sessionType, goal: params.goal.slice(0, 80),
      }, 'project-manager: skipping auto-create (session failed without changes)');
      return;
    }
    try {
      const { project, session } = await this.attachSession({
        userId: params.userId,
        sourceId: params.sourceId,
        sessionType: params.sessionType,
        goal: params.goal,
        cwd: params.cwd,
      });

      const summarizerInput: SummarizerInput = {
        goal: params.goal,
        sessionType: params.sessionType,
        cwd: params.cwd,
        milestones: params.milestones,
        totalFilesChanged: params.totalFilesChanged,
        success: params.success,
        transcript: params.transcript,
        files: params.files,
      };

      let summary: ProjectSessionSummary | null = null;
      try {
        summary = await this.summarizer.summarize(summarizerInput);
      } catch (err) {
        this.logger.debug({ err, sourceId: params.sourceId }, 'project-manager: summarizer threw');
      }

      if (!summary) {
        summary = this.fallbackSummary(params);
      }

      await this.repo.updateSessionSummary(session.id, summary, new Date().toISOString());

      if (summary.openItems && summary.openItems.length > 0) {
        for (const item of summary.openItems) {
          await this.repo.addOpenItem(project.id, {
            title: item.title,
            description: item.description,
            priority: item.priority ?? 'normal',
            sessionId: session.id,
            linkedIncidentId: item.linkedIncidentId,
          });
        }
      }

      if (summary.keyDecisions && summary.keyDecisions.length > 0) {
        for (const dec of summary.keyDecisions) {
          await this.repo.addDecision(project.id, {
            title: dec.choice.slice(0, 100),
            choice: dec.choice,
            rationale: dec.rationale,
            sessionId: session.id,
          });
        }
      }

      if (summary.nextCheckInDays && project.healthMode !== 'off') {
        const next = new Date(Date.now() + summary.nextCheckInDays * 24 * 60 * 60 * 1000).toISOString();
        await this.repo.update(params.userId, project.id, { nextCheckAt: next });
      }

      this.logger.info({
        projectId: project.id,
        sourceId: params.sourceId,
        sessionType: params.sessionType,
        openItems: summary.openItems?.length ?? 0,
        decisions: summary.keyDecisions?.length ?? 0,
      }, 'project-manager: session finished + summarized');
    } catch (err) {
      this.logger.warn({ err, sourceId: params.sourceId }, 'project-manager: finishSession failed');
    }
  }

  /**
   * v616 NA1 — One-shot cleanup für Projekt-Namen die aus der alten
   * goal.slice(0,80)-Logik stammen. Erkennungs-Heuristik: Name beginnt mit
   * einem der LLM-Boilerplate-Prefixe ODER ist länger als 50 Zeichen UND
   * enthält das cwd-Basename nicht. Sicher idempotent — läuft mehrfach OK.
   * Returns: { renamed: <count>, skipped: <count> }.
   */
  async rebuildLongProjectNames(userId: string): Promise<{ renamed: number; skipped: number }> {
    const all = await this.repo.list(userId, { limit: 500 });
    const BOILERPLATE_RE = /^(Starte\s+(einen\s+)?(NEUEN\s+)?Projekt-Agent-Lauf|Erstelle\s+(ein\s+)?(neues\s+)?Projekt|Bearbeite\s+(das\s+)?(bestehende\s+)?Projekt|Im\s+Projekt\s+\/|Bitte\s+(starte|erstelle|baue))/i;
    let renamed = 0;
    let skipped = 0;
    for (const p of all) {
      const looksBoilerplate = BOILERPLATE_RE.test(p.name) || (p.name.length > 50 && p.cwd && !p.name.toLowerCase().includes((p.cwd.split('/').pop() ?? '').toLowerCase()));
      if (!looksBoilerplate) { skipped++; continue; }
      const newName = deriveProjectName(p.cwd, p.description ?? p.name, p.id);
      if (newName === p.name || newName.length < 2) { skipped++; continue; }
      try {
        await this.repo.update(userId, p.id, { name: newName });
        this.logger.info({ projectId: p.id, oldName: p.name.slice(0, 60), newName }, 'project-manager: project name rebuilt');
        renamed++;
      } catch (err) {
        this.logger.debug({ err, projectId: p.id }, 'project-manager: rename failed');
        skipped++;
      }
    }
    return { renamed, skipped };
  }

  private async findOrCreate(params: AttachSessionParams): Promise<Project> {
    if (this.autoBindByCwd && params.cwd) {
      const existing = await this.repo.findByCwd(params.userId, params.cwd);
      if (existing) return existing;
    }
    // v616 NA1 — semantischer Projekt-Name. Vorher: goal.slice(0,80), was
    // unleserliche Stümpfe wie "Starte einen NEUEN Projekt-Agent-Lauf für..."
    // produzierte. Jetzt: wenn cwd existiert, nimm das Basename als Name
    // (z.B. "alpbyte-games"). uniqueSlug() im Repo handhabt Duplikate.
    // Fallback bei fehlendem cwd: gekürzte Goal-Slice.
    const name = deriveProjectName(params.cwd, params.goal, params.sourceId);
    return this.repo.create(params.userId, {
      name,
      cwd: params.cwd,
      repoUrl: params.repoUrl,
      status: 'active',
    });
  }

  /**
   * Find-or-create the single "Misc" project bucket for orphan sessions
   * (delegate calls without cwd, ad-hoc code-agent runs etc.).
   * Single project per user — sessions stack up there instead of polluting
   * the project list with one project per ad-hoc task.
   */
  async ensureMiscBucket(userId: string): Promise<Project> {
    const existing = await this.repo.getBySlug(userId, 'misc');
    if (existing) return existing;
    return this.repo.create(userId, {
      name: 'Misc',
      description: 'Sammel-Bucket für Delegate/Code-Agent Sessions ohne expliziten Projekt-Kontext.',
      status: 'active',
      tags: ['system'],
    });
  }

  /**
   * Convenience: attach + finalize an orphan session in the Misc bucket.
   * The standard finishSession() goes via attachSession() which auto-creates per cwd —
   * for orphans we deliberately route to the single misc-bucket instead.
   */
  async finishOrphanSession(params: Omit<FinishSessionParams, 'cwd'>): Promise<void> {
    // v604 L9 — skip orphan-bucket-attach when the session failed with 0 files
    if (params.success === false && (params.totalFilesChanged ?? 0) === 0) {
      this.logger.info({
        sourceId: params.sourceId, sessionType: params.sessionType,
      }, 'project-manager: skipping misc-bucket attach (orphan session failed without changes)');
      return;
    }
    try {
      const misc = await this.ensureMiscBucket(params.userId);
      let session = await this.repo.findSessionBySource(params.sessionType, params.sourceId);
      if (!session) {
        session = await this.repo.createSession(misc.id, {
          sessionType: params.sessionType,
          sourceId: params.sourceId,
        });
      }
      await this.repo.touch(misc.id);

      let summary = await this.summarizer.summarize({
        goal: params.goal,
        sessionType: params.sessionType,
        milestones: params.milestones,
        totalFilesChanged: params.totalFilesChanged,
        success: params.success,
        transcript: params.transcript,
        files: params.files,
      }).catch(() => null);
      if (!summary) {
        summary = {
          whatWasDone: params.milestones?.join('; ').slice(0, 600) ?? `Orphan ${params.sessionType}-Session.`,
          status: params.success === true ? 'success' : params.success === false ? 'failed' : 'partial',
        };
      }
      await this.repo.updateSessionSummary(session.id, summary, new Date().toISOString());

      if (summary.openItems && summary.openItems.length > 0) {
        for (const item of summary.openItems) {
          await this.repo.addOpenItem(misc.id, {
            title: item.title, description: item.description,
            priority: item.priority ?? 'normal', sessionId: session.id,
            linkedIncidentId: item.linkedIncidentId,
          });
        }
      }
      this.logger.info({
        projectId: misc.id, sourceId: params.sourceId, sessionType: params.sessionType,
      }, 'project-manager: orphan session attached to misc bucket');
    } catch (err) {
      this.logger.warn({ err, sourceId: params.sourceId }, 'project-manager: finishOrphanSession failed');
    }
  }

  private fallbackSummary(params: FinishSessionParams): ProjectSessionSummary {
    const what = params.milestones && params.milestones.length > 0
      ? `Erreichte Meilensteine: ${params.milestones.slice(0, 5).join('; ')}`
      : `Session ${params.sessionType} abgeschlossen.`;
    return {
      whatWasDone: what,
      filesTouched: params.files?.slice(0, 20),
      status: params.success === true ? 'success' : params.success === false ? 'failed' : 'partial',
    };
  }
}
