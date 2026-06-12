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
  /** Working directory — fallback primary key for auto-binding when projectId is unknown. */
  cwd?: string;
  /**
   * v798 — Explicit project-ID. Wenn gesetzt überspringt findOrCreate die
   * cwd-basierte Heuristik komplett und nimmt direkt das Projekt mit dieser ID.
   * Verhindert orphan-Projekte bei sandbox-runs (worktree-cwd matched sonst kein
   * existing project → neuer orphan-Eintrag).
   */
  projectId?: string;
  /** Optional repo URL. */
  repoUrl?: string;
  /**
   * v668 — Echte Startzeit der Session (ISO-String).
   * Wird benutzt wenn die Session zum ersten Mal angelegt wird.
   * Ohne diesen Wert nimmt createSession() now() und die Arbeitszeit-Statistik
   * zeigt nur die Dauer der Summary-Erstellung statt der echten Agent-Laufzeit.
   */
  startedAt?: string;
  /** v812 — Merge-State für Sandbox-Runs: 'pending' = noch nicht gemerged. Default 'applied'. */
  mergeState?: 'applied' | 'pending' | 'merged' | 'discarded';
  /** v812 — Sandbox-ID für Merge/Discard-Cleanup-Verknüpfung. */
  sandboxId?: string;
}

export interface FinishSessionParams {
  userId: string;
  sessionType: ProjectSessionType;
  sourceId: string;
  goal: string;
  cwd?: string;
  /** v798 — Explicit project-ID, siehe AttachSessionParams.projectId. */
  projectId?: string;
  milestones?: string[];
  totalFilesChanged?: number;
  success?: boolean;
  transcript?: string;
  files?: string[];
  /** v668 — Echte Startzeit (siehe AttachSessionParams.startedAt). */
  startedAt?: string;
  /** v812 — Merge-State für Sandbox-Runs: 'pending' = noch nicht gemerged. Default 'applied'. */
  mergeState?: 'applied' | 'pending' | 'merged' | 'discarded';
  /** v812 — Sandbox-ID für Merge/Discard-Cleanup-Verknüpfung. */
  sandboxId?: string;
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
 * v869 — Titel-Ähnlichkeit für Open-Item-Dedup (Jaccard über normalisierte
 * Wort-Tokens, Stopwort-arm durch Mindestlänge 3). 0.7 ≈ "im Kern derselbe
 * Punkt, anders formuliert". Exportiert für Tests.
 */
const TITLE_STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'für', 'fuer', 'von', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'mit', 'bei', 'auf', 'aus', 'nach',
  'zum', 'zur', 'sich', 'nicht', 'noch', 'auch', 'als', 'wird', 'werden',
  'sind', 'ist', 'soll', 'sollen', 'the', 'and', 'for', 'with',
]);

export function openItemTitleSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => new Set(
    s.toLowerCase()
      .replace(/[^a-zà-ž0-9äöüß\s-]/gi, ' ')
      .split(/[\s-]+/)
      .filter(w => w.length >= 3 && !TITLE_STOPWORDS.has(w)),
  );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * v869.2 — Zentraler Echo-/Duplikat-Filter für Summarizer-Open-Items.
 *
 * Vorfall 11.06. (Session 85f9d56e): der Summarizer echote die ABGESCHLOSSENEN
 * Phasen-Milestones wörtlich als "offene" Punkte zurück ("Phase 1: Chat-Komponente
 * … lokalisieren" → Open-Item "Chat-Komponente … lokalisieren"). Der v869-Prompt-
 * Appell allein ist auf LLM-Gehorsam angewiesen — dieser Filter ist die
 * deterministische Schicht dahinter. Drei Regeln:
 *
 *  1. milestone-echo: Titel ≈ erreichter Milestone (≥0.7, "Phase N:"-Präfix
 *     gestrippt) → skip. Milestones enthalten NUR abgeschlossene Phasen
 *     (markDone ist build-gated), gilt daher auch bei failed Sessions.
 *  2. goal-echo (NUR bei success=true): Titel ≈ einer Goal-Zeile (≥0.7,
 *     Listen-Marker gestrippt) → skip. Bei Erfolg beschreibt das Goal erledigte
 *     Arbeit (work_on_open_items listet jeden Punkt als Goal-Zeile). Bei
 *     failed/partial NICHT filtern — dort kann Goal-Inhalt legitim offen sein.
 *  3. duplicate: Titel ≈ bestehendes offenes Item oder früheres Item desselben
 *     Batches (≥0.7) → skip (v869, jetzt zentralisiert — gilt neu auch für den
 *     Orphan-/Misc-Pfad, der vorher GAR KEINEN Dedup hatte).
 */
export function filterEchoOpenItems<T extends { title: string }>(
  items: T[],
  ctx: { milestones?: string[]; goal?: string; success?: boolean; existingTitles?: string[] },
): { kept: T[]; skipped: Array<{ title: string; reason: 'milestone-echo' | 'goal-echo' | 'duplicate' }> } {
  const milestoneTexts = (ctx.milestones ?? [])
    .filter(m => m !== 'Plan erstellt')
    .map(m => m.replace(/^Phase\s+\d+\s*:\s*/i, ''));
  const goalLines = ctx.success === true && ctx.goal
    ? ctx.goal.split('\n')
        .map(l => l.replace(/^\s*(?:\d+\.|[-*•])\s*/, '').replace(/\*\*/g, '').trim())
        .filter(l => l.length >= 20)
    : [];
  const seenTitles = [...(ctx.existingTitles ?? [])];

  const kept: T[] = [];
  const skipped: Array<{ title: string; reason: 'milestone-echo' | 'goal-echo' | 'duplicate' }> = [];
  for (const item of items) {
    if (milestoneTexts.some(m => openItemTitleSimilarity(m, item.title) >= 0.7)) {
      skipped.push({ title: item.title, reason: 'milestone-echo' });
      continue;
    }
    if (goalLines.some(l => openItemTitleSimilarity(l, item.title) >= 0.7)) {
      skipped.push({ title: item.title, reason: 'goal-echo' });
      continue;
    }
    if (seenTitles.some(t => openItemTitleSimilarity(t, item.title) >= 0.7)) {
      skipped.push({ title: item.title, reason: 'duplicate' });
      continue;
    }
    seenTitles.push(item.title);
    kept.push(item);
  }
  return { kept, skipped };
}

/**
 * v869.5 — Doku-only-Erkennung: Session hat AUSSCHLIESSLICH Markdown-Dateien
 * geändert (Analyse-/Proposal-Lauf). Gate bewusst hart: eine einzige
 * Nicht-.md-Datei → false → Verhalten exakt wie bisher. Leere Liste → false.
 */
export function isDocsOnlyRun(files: string[] | undefined): boolean {
  if (!files || files.length === 0) return false;
  return files.every(f => /\.(md|markdown)$/i.test(f.trim()));
}

/**
 * v869.5 — Aus einem Doku-only-Lauf das Haupt-Dokument bestimmen (erstes .md
 * das nicht CHANGELOG/README ist) für das "Umsetzen:"-Open-Item.
 */
export function pickPrimaryDoc(files: string[]): string | undefined {
  const candidates = files.filter(f => !/(^|\/)(CHANGELOG|README)\.md$/i.test(f.trim()));
  return candidates[0] ?? undefined;
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
        startedAt: params.startedAt, // v668 — echte Startzeit durchreichen falls bekannt
        mergeState: params.mergeState, // v812 — 'pending' für Sandbox-Runs
        sandboxId: params.sandboxId,   // v812 — Sandbox-Verknüpfung
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
    // v815 CM3 — Retry-Loop bei transientem DB-/LLM-Fehler. Vorher: einmal,
    // bei Fail → warn + silent return → Chat zeigt "fertig" aber Session existiert
    // nicht in project_sessions → analytics + open-items broken.
    await this.finishSessionWithRetry(params, 3);
  }

  private async finishSessionWithRetry(params: FinishSessionParams, maxAttempts: number): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.finishSessionImpl(params);
        if (attempt > 1) this.logger.info({ sourceId: params.sourceId, attempt }, 'v815 finishSession succeeded on retry');
        return;
      } catch (err) {
        if (attempt < maxAttempts) {
          const delayMs = 500 * attempt;
          this.logger.warn({ err, sourceId: params.sourceId, attempt, maxAttempts, delayMs }, 'v815 finishSession failed, retrying');
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          this.logger.error({ err, sourceId: params.sourceId, maxAttempts }, 'v815 finishSession failed after all retries — session NOT persisted (analytics/open-items will miss this run)');
        }
      }
    }
  }

  private async finishSessionImpl(params: FinishSessionParams): Promise<void> {
    const { project, session } = await this.attachSession({
        userId: params.userId,
        sourceId: params.sourceId,
        sessionType: params.sessionType,
        goal: params.goal,
        cwd: params.cwd,
        projectId: params.projectId, // v798 — explicit project-Linking (verhindert orphan-Creation bei sandbox-runs)
        startedAt: params.startedAt, // v668 — echte Startzeit für korrekte Arbeitszeit-Statistik
        mergeState: params.mergeState, // v812 — Sandbox-Runs als 'pending'
        sandboxId: params.sandboxId,   // v812 — Sandbox-Verknüpfung
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
        // v869/v869.2 — Echo- + Duplikat-Filter (deterministisch, zusätzlich zum
        // Prompt-Appell): Milestone-Echos, Goal-Echos (bei success) und Duplikate
        // gegen Bestand/Batch werden verworfen. Siehe filterEchoOpenItems.
        let existingTitles: string[] = [];
        try {
          const existing = await this.repo.listOpenItemsForProject(project.id, ['open', 'in_progress']);
          existingTitles = existing.map(e => e.title);
        } catch { /* Dedup best-effort — ohne Bestand wird normal eingefügt */ }
        const { kept, skipped } = filterEchoOpenItems(summary.openItems, {
          milestones: params.milestones,
          goal: params.goal,
          success: params.success,
          existingTitles,
        });
        for (const item of kept) {
          await this.repo.addOpenItem(project.id, {
            title: item.title,
            description: item.description,
            priority: item.priority ?? 'normal',
            sessionId: session.id,
            linkedIncidentId: item.linkedIncidentId,
          });
        }
        if (skipped.length > 0) {
          this.logger.info(
            { projectId: project.id, skipped, total: summary.openItems.length },
            'v869.2 open-item filter: Echos/Duplikate übersprungen',
          );
        }
      }

      // v869.5 — Doku-only-Lauf (Analyse/Proposal): genau EIN "Umsetzen:"-Item
      // anlegen, damit der Folge-Schritt nicht verloren geht (Vorfall f3a8d888:
      // 500-Zeilen-Proposal erzeugt, aber kein Item/Hinweis zur Umsetzung — die
      // v869-Anti-Geister-Regel unterdrückt LLM-"Nachfolgeschritte" bewusst).
      // Gate hart: nur wenn ALLE geänderten Dateien .md sind UND success.
      // Nicht-Doku-Läufe: exakt unverändertes Verhalten.
      if (params.success === true && isDocsOnlyRun(params.files)) {
        try {
          const doc = pickPrimaryDoc(params.files ?? []);
          if (doc) {
            const base = doc.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? doc;
            const title = `Umsetzen: ${base} (${doc})`;
            const existing = await this.repo.listOpenItemsForProject(project.id, ['open', 'in_progress']).catch(() => []);
            const isDup = existing.some(e => openItemTitleSimilarity(e.title, title) >= 0.7);
            if (!isDup) {
              await this.repo.addOpenItem(project.id, {
                title: title.slice(0, 200),
                description: `Dieser Lauf hat nur Analyse/Dokumentation erzeugt (${(params.files ?? []).join(', ').slice(0, 300)}). Die dort beschriebene Roadmap/Lösung ist noch NICHT implementiert — per Abarbeiten-Button starten oder Resume mit Notiz.`,
                priority: 'normal',
                sessionId: session.id,
              });
              this.logger.info({ projectId: project.id, doc }, 'v869.5 Doku-only-Lauf → Umsetzen-Item angelegt');
            }
          }
        } catch (err) {
          this.logger.debug({ err }, 'v869.5 Umsetzen-Item skipped (non-fatal)');
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
    // v798 — Explicit projectId hat Vorrang vor cwd-Heuristik. Wenn der caller
    // weiß zu welchem Project die Session gehört (z.B. sandbox-flow kennt
    // sandbox.projectId), wird direkt geladen — keine orphan-Erstellung möglich.
    // v800 — getByIdAnyOwner (statt getById) für Multi-User-Setup. Ein admin-user
    // kann via Sandbox an einem madh-Projekt arbeiten; sandbox.userId != project.userId.
    // getById(userId,...) filtert nach userId und gibt dann null zurück → Fallback
    // erstellte orphan-Projekt. getByIdAnyOwner ignoriert ownership-filter.
    // Session wird trotzdem unter project.id linked, owner bleibt unverändert.
    if (params.projectId) {
      try {
        const proj = await this.repo.getByIdAnyOwner(params.projectId);
        if (proj) return proj;
        this.logger.warn({ projectId: params.projectId, userId: params.userId }, 'v800 explicit projectId not found (any-owner-lookup), falling back to cwd-heuristik');
      } catch (err) {
        this.logger.warn({ err, projectId: params.projectId }, 'v800 getByIdAnyOwner for explicit projectId failed, falling back to cwd-heuristik');
      }
    }
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
          startedAt: params.startedAt, // v668 — echte Startzeit auch für orphan-bucket
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
        // v869.2 — Echo-/Duplikat-Filter auch im Orphan-/Misc-Pfad (hatte vorher
        // GAR KEINEN Dedup — v869-Lücke).
        let existingTitles: string[] = [];
        try {
          const existing = await this.repo.listOpenItemsForProject(misc.id, ['open', 'in_progress']);
          existingTitles = existing.map(e => e.title);
        } catch { /* best-effort */ }
        const { kept, skipped } = filterEchoOpenItems(summary.openItems, {
          milestones: params.milestones,
          goal: params.goal,
          success: params.success,
          existingTitles,
        });
        for (const item of kept) {
          await this.repo.addOpenItem(misc.id, {
            title: item.title, description: item.description,
            priority: item.priority ?? 'normal', sessionId: session.id,
            linkedIncidentId: item.linkedIncidentId,
          });
        }
        if (skipped.length > 0) {
          this.logger.info({ projectId: misc.id, skipped }, 'v869.2 open-item filter (orphan): Echos/Duplikate übersprungen');
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

  /**
   * v798 — One-shot Migration: orphan-Projekte (cwd unter sandbox-worktrees/)
   * an ihre parent-Projekte re-linken und dann archivieren.
   *
   * Vorher hat `findOrCreate(cwd=worktree-path)` orphan-Projekte mit
   * name=basename(worktree-path) (z.B. "ipk73ad8") angelegt. Dadurch landeten
   * sessions/items/decisions unter dem orphan statt unter dem echten Parent.
   *
   * Migration-Strategie:
   *  1. Finde alle orphan-Projekte mit cwd LIKE %sandbox-worktrees%
   *  2. Für jeden: lookup sandbox via worktree_path → parent project_id
   *  3. Re-link project_sessions, project_open_items, project_decisions,
   *     project_environments, project_db_seeds an parent
   *  4. orphan-project status='archived' setzen
   *
   * Idempotent — kann mehrfach gerufen werden, archived orphans werden übersprungen.
   *
   * @returns Statistik: {migrated: int, relinkedSessions, relinkedItems, relinkedDecisions}
   */
  async migrateOrphanProjects(repo: {
    adapter: { execute: (sql: string, params?: unknown[]) => Promise<{ changes?: number; rows?: unknown[] }>; query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  }): Promise<{ migrated: number; relinkedSessions: number; relinkedItems: number; relinkedDecisions: number; errors: string[] }> {
    const stats = { migrated: 0, relinkedSessions: 0, relinkedItems: 0, relinkedDecisions: 0, errors: [] as string[] };
    try {
      // 1. Finde orphan-Projekte (cwd unter sandbox-worktrees/, status active)
      const orphans = await repo.adapter.query(
        `SELECT id, user_id, cwd, name FROM projects WHERE status = 'active' AND cwd LIKE '%/sandbox-worktrees/%'`,
        [],
      ) as Array<{ id: string; user_id: string; cwd: string; name: string }>;
      if (orphans.length === 0) {
        this.logger.debug('v798 migrateOrphanProjects: keine orphans gefunden');
        return stats;
      }
      this.logger.info({ count: orphans.length, names: orphans.map(o => o.name).slice(0, 10) }, 'v798 migrateOrphanProjects: orphans gefunden');

      // 2. Für jeden orphan: parent project finden + re-link
      for (const orphan of orphans) {
        try {
          const sbRows = await repo.adapter.query(
            `SELECT project_id FROM project_agent_sandboxes WHERE worktree_path = ? LIMIT 1`,
            [orphan.cwd],
          ) as Array<{ project_id: string }>;
          const parentId = sbRows[0]?.project_id;
          if (!parentId) {
            this.logger.warn({ orphanId: orphan.id, orphanCwd: orphan.cwd }, 'v798 no sandbox→parent found, skipping orphan');
            continue;
          }
          if (parentId === orphan.id) {
            this.logger.warn({ orphanId: orphan.id }, 'v798 sandbox.project_id matches orphan id — likely already healthy, skipping');
            continue;
          }

          // Re-link FK-references. Best-effort, sammle changes-count.
          const movedSessions = (await repo.adapter.execute(`UPDATE project_sessions SET project_id = ? WHERE project_id = ?`, [parentId, orphan.id])).changes ?? 0;
          const movedItems = (await repo.adapter.execute(`UPDATE project_open_items SET project_id = ? WHERE project_id = ?`, [parentId, orphan.id])).changes ?? 0;
          const movedDecisions = (await repo.adapter.execute(`UPDATE project_decisions SET project_id = ? WHERE project_id = ?`, [parentId, orphan.id])).changes ?? 0;
          // project_environments + project_db_seeds: best-effort, manche DBs haben evt. nicht alle Tabellen
          try { await repo.adapter.execute(`UPDATE project_environments SET project_id = ? WHERE project_id = ?`, [parentId, orphan.id]); } catch { /* table missing OK */ }
          try { await repo.adapter.execute(`UPDATE project_db_seeds SET project_id = ? WHERE project_id = ?`, [parentId, orphan.id]); } catch { /* */ }
          // project_health_log: löschen statt re-linken — parent hat eigene fresh checks
          try { await repo.adapter.execute(`DELETE FROM project_health_log WHERE project_id = ?`, [orphan.id]); } catch { /* */ }
          // Orphan archivieren statt löschen (FK-CASCADE würde sonst die re-linked rows mit löschen falls eine FK vergessen wurde)
          await repo.adapter.execute(`UPDATE projects SET status = 'archived', name = ? WHERE id = ?`, [`[ORPHAN-v798] ${orphan.name}`, orphan.id]);

          stats.migrated++;
          stats.relinkedSessions += movedSessions;
          stats.relinkedItems += movedItems;
          stats.relinkedDecisions += movedDecisions;
          this.logger.info({ orphanId: orphan.id, orphanName: orphan.name, parentId, movedSessions, movedItems, movedDecisions }, 'v798 migrated orphan');
        } catch (err) {
          const msg = `${orphan.name}: ${(err as Error).message}`;
          stats.errors.push(msg);
          this.logger.warn({ err, orphanId: orphan.id }, 'v798 migrate orphan failed');
        }
      }
      this.logger.info(stats, 'v798 migrateOrphanProjects done');
    } catch (err) {
      this.logger.warn({ err }, 'v798 migrateOrphanProjects top-level failed');
    }
    return stats;
  }
}
