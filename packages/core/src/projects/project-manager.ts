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

  /** Called when a session finishes — runs the summarizer and persists the structured outcome. */
  async finishSession(params: FinishSessionParams): Promise<void> {
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

  private async findOrCreate(params: AttachSessionParams): Promise<Project> {
    if (this.autoBindByCwd && params.cwd) {
      const existing = await this.repo.findByCwd(params.userId, params.cwd);
      if (existing) return existing;
    }
    const name = params.goal.length > 0 ? params.goal.slice(0, 80) : `Session ${params.sourceId.slice(0, 8)}`;
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
