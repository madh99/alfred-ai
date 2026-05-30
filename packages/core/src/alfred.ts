import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import type { AlfredConfig, NormalizedMessage, Platform, SecurityRule } from '@alfred/types';
import type { Logger } from 'pino';
import type { MessagingAdapter } from '@alfred/messaging';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository, AuditRepository, MemoryRepository, ReminderRepository, NoteRepository, EmbeddingRepository, LinkTokenRepository, BackgroundTaskRepository, ScheduledActionRepository, DocumentRepository, TodoRepository, WatchRepository, SummaryRepository, UsageRepository, CalendarNotificationRepository, ConfirmationRepository, ActivityRepository, SkillHealthRepository, WorkflowRepository, FeedbackRepository, SkillStateRepository, KnowledgeGraphRepository, BmwTelematicRepository, ServiceUsageRepository, CmdbRepository, ItsmRepository, AgentConventionsRepository, type AsyncDbAdapter } from '@alfred/storage';
import { ConfigLoader, reloadDotenv } from '@alfred/config';
import { createModelRouter } from '@alfred/llm';
import { RuleEngine, SecurityManager, RuleLoader } from '@alfred/security';
import {
  SkillRegistry,
  SkillSandbox,
  CalculatorSkill,
  SystemInfoSkill,
  WebSearchSkill,
  ReminderSkill,
  NoteSkill,
  WeatherSkill,
  ShellSkill,
  MemorySkill,
  DelegateSkill,
  EmailSkill,
  createEmailProvider,
  HttpSkill,
  FileSkill,
  ClipboardSkill,
  ScreenshotSkill,
  BrowserSkill,
  ProfileSkill,
  CalendarSkill,
  createCalendarProvider,
  CrossPlatformSkill,
  BackgroundTaskSkill,
  ScheduledTaskSkill,
  WatchSkill,
  WorkflowSkill,
  DocumentSkill,
  TTSSkill,
  VoiceSkill,
  ImageGenerateSkill,
  TransitSkill,
  ConfigureSkill,
  TodoSkill,
  FeedReaderSkill,
  HelpSkill,
  // v792 — Project-Agent-Skill internal output buffer helpers.
  // Müssen statisch importiert werden — dynamic subpath imports (`@alfred/skills/built-in/...`)
  // funktionieren NICHT im bundle (esbuild leaves them as runtime imports, package.json exports
  // declares only `.` → ERR_MODULE_NOT_FOUND at runtime, try-catch swallows → null functions).
  appendOutputLine,
  appendOutputEvent,
  markOutputEnded,
  createForgeClient,
} from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';
import { MessagePipeline } from './message-pipeline.js';
import { ReminderScheduler } from './reminder-scheduler.js';
import { SpeechTranscriber } from './speech-transcriber.js';
import { SpeechSynthesizer } from './speech-synthesizer.js';
import { ImageGenerator } from './image-generator.js';
import { TransitClient } from './transit-client.js';
import { ResponseFormatter } from './response-formatter.js';
import { EmbeddingService } from './embedding-service.js';
import { DocumentProcessor } from './document-processor.js';
import { BackgroundTaskRunner } from './background-task-runner.js';
import { PersistentAgentRunner } from './persistent-agent-runner.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { WatchEngine } from './watch-engine.js';
import { ConfirmationQueue } from './confirmation-queue.js';
import { ActiveLearningService } from './active-learning/active-learning-service.js';
import { FeedbackService } from './feedback/feedback-service.js';
import { MemoryRetriever } from './active-learning/memory-retriever.js';
import { MemoryConsolidator } from './active-learning/memory-consolidator.js';
import { PatternAnalyzer } from './active-learning/pattern-analyzer.js';
import { TemporalAnalyzer } from './active-learning/temporal-analyzer.js';
import { KnowledgeGraphService } from './knowledge-graph.js';
import { ActionFeedbackTracker } from './action-feedback-tracker.js';
import { ConversationSummarizer } from './conversation-summarizer.js';
import { CalendarWatcher } from './calendar-watcher.js';
import { TodoWatcher } from './todo-watcher.js';
import { ActivityLogger } from './activity-logger.js';
import { SkillHealthTracker } from './skill-health-tracker.js';
import { WorkflowRunner } from './workflow-runner.js';
import { ScriptExecutor } from './workflow/script-executor.js';
import { DbQueryExecutor } from './workflow/db-query-executor.js';
import { PromptParser } from './workflow/prompt-parser.js';
import { TriggerManager } from './workflow/trigger-manager.js';
import { GuardEvaluator } from './workflow/guard-evaluator.js';
import { ReasoningEngine } from './reasoning-engine.js';
import { InsightTracker } from './insight-tracker.js';
import { ReflectionEngine } from './reflection-engine.js';
import { resolveReflectionConfig } from './reflection/index.js';

/**
 * v633 T3.2 — Look up a known-error Problem whose keyword footprint matches the new
 * alert message. Used to surface the known workaround at incident-creation time so the
 * user sees "Bekannte Lösung: …" immediately instead of re-investigating.
 *
 * Match criteria: problem is marked `is_known_error=true`, has a `workaround` or
 * `knownErrorDescription` set, and shares ≥2 distinguishing keywords with the alert.
 */
async function findKnownErrorMatch(
  problemRepo: { listProblems: (uid: string, f?: { isKnownError?: boolean; limit?: number }) => Promise<Array<{ id: string; title: string; workaround?: string; knownErrorDescription?: string; linkedIncidentIds: string[] }>> },
  userId: string,
  alertMessage: string,
  alertKeywords: string[],
): Promise<{ id: string; title: string; workaround?: string; knownErrorDescription?: string } | null> {
  const knownErrors = await problemRepo.listProblems(userId, { isKnownError: true, limit: 50 });
  if (knownErrors.length === 0) return null;
  const msgLower = alertMessage.toLowerCase();
  const kwLower = alertKeywords.map(k => k.toLowerCase()).filter(k => k.length >= 4);
  for (const p of knownErrors) {
    if (!p.workaround && !p.knownErrorDescription) continue;
    const titleLower = p.title.toLowerCase();
    // Cross-match: keywords from alert against problem title
    const matchCount = kwLower.filter(k => titleLower.includes(k) || msgLower.split(/\s+/).some(w => p.title.toLowerCase().includes(w.toLowerCase()) && w.length >= 4)).length;
    if (matchCount >= 2) return p;
  }
  return null;
}

/** Get ISO week number for a date. */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export class Alfred {
  private readonly logger: Logger;
  private database!: Database;
  private pipeline!: MessagePipeline;
  private llmProvider!: import('@alfred/llm').ModelRouter;
  private reminderScheduler?: ReminderScheduler;
  private backgroundTaskRunner?: BackgroundTaskRunner;
  private proactiveScheduler?: ProactiveScheduler;
  private watchEngine?: WatchEngine;
  private triggerManager?: TriggerManager;
  private confirmationQueue?: ConfirmationQueue;
  private readonly adapters: Map<Platform, MessagingAdapter> = new Map();
  private readonly formatter = new ResponseFormatter();
  private userRepo!: UserRepository;
  private skillRegistry!: SkillRegistry;
  private skillSandbox?: SkillSandbox;
  private mcpManager?: import('@alfred/skills').MCPManager;
  private calendarSkill?: CalendarSkill;
  private calendarWatcher?: CalendarWatcher;
  private todoWatcher?: TodoWatcher;
  private reasoningEngine?: ReasoningEngine;
  private reflectionEngine?: ReflectionEngine;
  private chatSessionRunbookReflector?: import('./reflection/chat-session-runbook-reflector.js').ChatSessionRunbookReflector;
  private usageRepo?: UsageRepository;
  private serviceUsageRepo?: ServiceUsageRepository;
  private auditRepo?: AuditRepository;
  private summaryRepo?: SummaryRepository;
  private activityRepo?: ActivityRepository;
  private memoryRepo?: MemoryRepository;
  private runbookRepo?: import('@alfred/storage').RunbookRepository;
  private projectRepo?: import('@alfred/storage').ProjectRepository;
  /** v824 — Agent-Conventions Repository für CLAUDE.md/AGENTS.md-Lifecycle. */
  private agentConventionsRepo?: import('@alfred/storage').AgentConventionsRepository;
  /** v824 — Agent-Conventions Skill-Instance (für API-Endpoints + Background-Jobs). */
  private agentConventionsSkillRef?: import('@alfred/skills').AgentConventionsSkill;

  /**
   * v830 Phase 4.5 — Embedding-Lookup-Helper für AgentSessionManager.embeddingLookup.
   * Berechnet ein Prompt-Embedding, vergleicht via Cosine-Similarity gegen alle
   * Lessons des Projekts, liefert Top-K Matches mit Similarity-Score zurück.
   * Analog OpenItemMatcher.prefilterByEmbedding-Pattern.
   * Returns undefined wenn embedding-service nicht verfügbar oder kein passendes Projekt.
   */
  private buildConventionsEmbeddingLookup(projectId: string | undefined, ownerUserId: string | undefined): ((prompt: string, cwd: string) => Promise<Array<{ text: string; source: string; similarity: number }>>) | undefined {
    if (!projectId || !ownerUserId) return undefined;
    if (!this.embeddingServiceRef || !this.embeddingRepoRef) return undefined;
    if (!this.agentConventionsRepo) return undefined;
    const cfg = (this.config as { agentConventions?: import('@alfred/types').AgentConventionsConfig }).agentConventions;
    if (!cfg?.embeddingInjection) return undefined;

    const convRepo = this.agentConventionsRepo;
    const llmProvider = this.llmProvider;

    return async (prompt: string, _cwd: string): Promise<Array<{ text: string; source: string; similarity: number }>> => {
      try {
        if (!llmProvider || !llmProvider.supportsEmbeddings?.()) return [];
        const convList = await convRepo.listForProject(projectId).catch(() => []);
        const lessons = convList.flatMap(c => c.neutralFormat.lessons.map(l => ({ ...l, packagePath: c.packagePath })));
        if (lessons.length === 0) return [];

        // In-memory: für jeden Lookup neu embedden. Bei mehr als ~50 Lessons sollte
        // ein eigenes lesson_embeddings-Cache her — für jetzt pragmatisch.
        const promptEmbResult = await llmProvider.embed(prompt.slice(0, 800));
        if (!promptEmbResult) return [];
        const promptEmb = promptEmbResult.embedding;

        const lessonEmbs: Array<{ lesson: typeof lessons[0]; emb: number[] }> = [];
        for (const l of lessons.slice(0, 50)) { // cap auf 50 lessons
          const r = await llmProvider.embed(l.text.slice(0, 800)).catch(() => null);
          if (r) lessonEmbs.push({ lesson: l, emb: r.embedding });
        }
        const cosine = (a: number[], b: number[]): number => {
          let dot = 0, magA = 0, magB = 0;
          for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
          const denom = Math.sqrt(magA) * Math.sqrt(magB);
          return denom === 0 ? 0 : dot / denom;
        };

        return lessonEmbs
          .map(({ lesson, emb }) => ({
            text: lesson.text,
            source: `lesson:${lesson.source}:conf=${lesson.confidence.toFixed(2)}`,
            similarity: cosine(promptEmb, emb),
          }))
          .filter(x => x.similarity > 0.55)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 5);
      } catch (err) {
        this.logger.debug({ err, projectId }, 'v830 conventions-embedding-lookup failed (non-fatal)');
        return [];
      }
    };
  }
  /** v813c — für OpenItemMatcher Embedding-Pre-Filter (vermeidet 12k-Truncation bei vielen Items). */
  private embeddingServiceRef?: EmbeddingService;
  private embeddingRepoRef?: EmbeddingRepository;
  /** v722 — Self-Learning: LearnedRecipeRepo (Pre-Hook + Action) */
  private learnedRecipeRepo?: import('@alfred/storage').LearnedRecipeRepository;
  /** v726 — Environment-Management */
  private envRepoRef?: import('@alfred/storage').EnvironmentRepository;
  private envCryptoRef?: import('@alfred/security').EnvCryptoService;
  private dbSeedRepoRef?: import('@alfred/storage').DbSeedRepository;
  private envSkillFactory?: (projectRepo: import('@alfred/storage').ProjectRepository, ownerUid: string) => unknown;
  /** v658 — Projekt-Chat: ConversationRepository für chatHistory-Endpoint */
  private conversationRepo?: import('@alfred/storage').ConversationRepository;
  private insightsRepo?: import('@alfred/storage').InsightsRepository;
  private insightEngine?: import('./insights/insight-engine.js').InsightEngine;
  /** v694 — Legacy-Daten-UIDs: pre-multi-user user-ids die KG/Conversation-Daten halten
   *  aber nicht (mehr) in alfred_users stehen. Werden nur dann via linkedUserIds in
   *  Sweeps/Question-Generator gemerged, wenn der sweepende UID === ownerMasterUserId. */
  private legacyDataUids: string[] = [];
  private projectManager?: import('./projects/project-manager.js').ProjectManager;
  private projectHealthMonitor?: import('./projects/health-monitor.js').HealthMonitor;
  private projectSkillRef?: import('@alfred/skills').ProjectSkill;
  /** v727 — Late-Wiring von SandboxRepo an Project-Agent-Skill (für dev-safe Build-Detection) */
  private projectAgentSkillRef?: import('@alfred/skills').ProjectAgentSkill;
  /** v762 — Aktive Code-Agent-Runs pro synthetischer task_id, damit Stop-Signal sie killen kann */
  private codeAgentTaskAborts = new Map<string, AbortController>();

  /**
   * v795/v796 — git command in einem worktree als dessen Owner ausführen.
   *
   * Wenn alfred als root läuft + repo gehört einem anderen User → wrap in
   * `sudo -u <owner>`. Sonst direkter git-Aufruf. Behebt:
   * "fatal: detected dubious ownership in repository" (CVE-2022-24765 safety).
   *
   * **v796**: Korrektur der Ownership-Detection.
   *
   * Ein git-worktree hat einen `.git`-FILE (nicht dir) im worktree-root, der auf
   * das tatsächliche gitdir in main-repo's `.git/worktrees/<name>/` zeigt.
   * Die dubious-ownership-Prüfung von git inspiziert das gitdir-TARGET — nicht
   * das worktree-Verzeichnis selbst.
   *
   * v795 hat `statSync(worktreePath).uid` benutzt — der Pfad ist root-owned
   * (von alfred erstellt mit mkdir), gitdir-target dagegen madh-owned. Resultat:
   * v795 hat "ownerUid === 0" gesehen, früh-return ohne sudo-wrap, git als root
   * gerufen → dubious-ownership-error.
   *
   * v796: parse `.git`-File für `gitdir:`-pointer, stat dessen Target. Fallback
   * auf worktreePath-uid wenn keine .git-File-Variante (regular non-worktree repo).
   */
  private async gitInWorktree(
    cwd: string,
    args: string[],
    opts: { timeout?: number; maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const execAsync = promisify(execFile);
    const timeout = opts.timeout ?? 30_000;
    const maxBuffer = opts.maxBuffer ?? 1024 * 1024;

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (!isRoot) {
      return execAsync('git', args, { cwd, timeout, maxBuffer });
    }

    // v796 — Determine the EFFECTIVE git-repo-owner. Für worktrees ist das nicht
    // der worktree-cwd (root-owned, nur Container), sondern das gitdir-target.
    let effectiveUid = 0;
    try {
      const dotGitPath = path.join(cwd, '.git');
      const dotGitStat = fs.statSync(dotGitPath);
      if (dotGitStat.isFile()) {
        // worktree-case: .git ist eine File mit "gitdir: <pfad>"
        const content = fs.readFileSync(dotGitPath, 'utf8').trim();
        const match = /^gitdir:\s*(.+)$/.exec(content);
        if (match) {
          const gitdirPath = match[1].trim();
          // Resolve relative gitdirs
          const absGitdir = path.isAbsolute(gitdirPath) ? gitdirPath : path.resolve(cwd, gitdirPath);
          effectiveUid = fs.statSync(absGitdir).uid;
        } else {
          effectiveUid = dotGitStat.uid;
        }
      } else {
        // regular repo: .git ist ein dir
        effectiveUid = dotGitStat.uid;
      }
    } catch {
      // Fallback: try worktreePath itself
      try { effectiveUid = fs.statSync(cwd).uid; } catch { /* */ }
    }

    if (effectiveUid === 0) {
      // Repo gehört root → direkter Call ok (auch wenn worktree-dir andere UID hat)
      return execAsync('git', args, { cwd, timeout, maxBuffer });
    }

    try {
      const { stdout: nameRaw } = await execAsync('id', ['-nu', String(effectiveUid)], { timeout: 3_000 });
      const ownerName = nameRaw.trim();
      if (!ownerName) throw new Error(`uid ${effectiveUid} resolves to empty name`);
      return execAsync('sudo', ['-u', ownerName, 'git', ...args], { cwd, timeout, maxBuffer });
    } catch (err) {
      this.logger.warn({ err, cwd, effectiveUid }, 'v796 gitInWorktree sudo-wrap setup failed, falling back to direct git (may hit dubious-ownership)');
      return execAsync('git', args, { cwd, timeout, maxBuffer });
    }
  }

  /** v779 — AgentSessionManager für persistente CLI-Coding-Agent-Sessions (claude/vibe/codex/...). Optional, nur initialisiert wenn config.codeAgents.enabled. */
  private agentSessionManager?: import('@alfred/skills').AgentSessionManager;
  private projectAgentRunnerRef?: import('./project-agent-runner.js').ProjectAgentRunner;
  private commitsRepoRef?: import('@alfred/storage').ProjectAgentCommitsRepository;
  private plansRepoRef?: import('@alfred/storage').ProjectAgentPlansRepository;
  private delegateSkillRef?: import('@alfred/skills').DelegateSkill;
  private codeAgentSkillRef?: import('@alfred/skills').CodeAgentSkill;
  private watchRepo?: WatchRepository;
  private scheduledActionRepo?: ScheduledActionRepository;
  private skillHealthRepo?: SkillHealthRepository;
  private clusterManager?: import('./cluster/cluster-manager.js').ClusterManager;
  private adapterClaimManager?: import('./adapter-claim-manager.js').AdapterClaimManager;
  private webAuthCallback?: {
    loginWithCode: (code: string) => Promise<{ success: boolean; userId?: string; username?: string; role?: string; token?: string; error?: string }>;
    getUserByToken: (token: string) => Promise<{ userId: string; username: string; role: string } | null>;
  };
  private reminderRepo?: ReminderRepository;
  /** v661 — Todos + Notes für WebUI-API */
  private todoRepo?: TodoRepository;
  private noteRepo?: NoteRepository;
  // v673 — Attachments
  private attachmentRepo?: import('@alfred/storage').AttachmentRepository;
  private documentRepoRef?: DocumentRepository;
  private fileStoreRef?: import('@alfred/storage').FileStore;
  /** v663b — Project Automations */
  private projectAutomationsRepo?: import('@alfred/storage').ProjectAutomationsRepository;
  private automationEngine?: import('./automation/automation-engine.js').AutomationEngine;
  /** v665a — Cluster-Share Manager (NFS/SMB/etc.) */
  private shareManager?: import('./cluster/share-manager.js').ShareManager;
  /** v665b — Project-Move (rsync + DB-Update + Cleanup) */
  private projectMoveService?: import('./cluster/project-move.js').ProjectMoveService;
  private spotifySkill?: import('@alfred/skills').SpotifySkill;
  private bmwSkill?: import('@alfred/skills').BMWSkill;
  private bmwTelematicRepo?: BmwTelematicRepository;
  private memorySkillRef?: MemorySkill;
  private kgServiceRef?: import('./knowledge-graph.js').KnowledgeGraphService;
  private sonosSkill?: import('@alfred/skills').SonosSkill;
  private skillHealthTracker?: SkillHealthTracker;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private memoryConsolidatorTimer?: ReturnType<typeof setInterval>;
  private patternAnalyzerTimer?: ReturnType<typeof setInterval>;
  private temporalAnalyzerTimer?: ReturnType<typeof setInterval>;
  private insightExpiryTimer?: ReturnType<typeof setInterval>;
  private clusterMonitorTimer?: ReturnType<typeof setInterval>;
  private cmdbDiscoveryTimer?: ReturnType<typeof setInterval>;
  private cmdbHealthCheckTimer?: ReturnType<typeof setInterval>;
  /** v825 — Periodischer Drift-Check für Agent-Conventions (Phase 2). */
  private agentConventionsDriftTimer?: ReturnType<typeof setInterval>;
  /** v827 — Wöchentliches Pattern-Mining für Cross-Project-Conventions (Phase 3.3). */
  private agentConventionsPatternMiningTimer?: ReturnType<typeof setInterval>;
  /** v828 — Periodischer Self-Modify-Agent für CLAUDE.md-Refactor (Phase 4.3). */
  private agentConventionsSelfModifyTimer?: ReturnType<typeof setInterval>;
  private insightTracker?: InsightTracker;
  /** v696 — Project-Agent Sandbox (opt-in). NUR initialisiert wenn `config.sandbox?.enabled === true` */
  private sandboxManager?: import('./sandbox-manager.js').SandboxManager;
  // v804 — Branded type. Garantiert UUID-Format ab init() durch IdentityResolver.
  // Vorher: optional `string` mit gemischtem Format (Telegram-ID/UUID-Mix) — Quelle
  // der v798/v800/v803-Orphan-Bugs.
  private ownerMasterUserId?: import('@alfred/types').UserUUID;
  /** v804 — Single entry-point für User-ID-Resolution. Late-bound in init(). */
  private identityResolver?: import('./identity/resolver.js').IdentityResolver;

  /**
   * v807 — Helper: garantiert UserUUID, wirft wenn init() noch nicht durchgelaufen.
   *
   * Ersetzt das OR-Fallback-Pattern `this.tryOwner()`
   * — das war vor v804 die Quelle der Multi-User-Bugs (Telegram-ID rutschte in
   * UUID-only-DB-Queries). Nach v804 ist `ownerMasterUserId` garantiert UUID
   * sobald init() complete ist; der Fallback war nur noch defensive Code der
   * im Edge-Case (sehr früher Init-Race) wieder Telegram-ID zurückgegeben hätte.
   *
   * Wer diese Methode vor init() ruft → bekommt sofort einen klaren Stack-Trace
   * statt silent fallback zu Telegram-ID. Das ist gewollt.
   */
  private requireOwner(): import('@alfred/types').UserUUID {
    if (!this.ownerMasterUserId) {
      throw new Error(
        'Alfred.requireOwner() called before init() completed. ' +
        'Check that this code path runs AFTER alfred.initialize() — ' +
        'see ADR-0001 (docs/adr/0001-user-identity-model.md) for the init-order requirement.',
      );
    }
    return this.ownerMasterUserId;
  }

  /**
   * v807 — Wie requireOwner aber ohne throw — gibt undefined zurück bei nicht-initialisiert.
   * Für Background-Tasks die VOR init laufen können (z.B. early-startup-hooks).
   * In den meisten Fällen `requireOwner()` bevorzugen.
   */
  private tryOwner(): import('@alfred/types').UserUUID | undefined {
    return this.ownerMasterUserId;
  }
  private userServiceResolverRef?: { getServiceConfig: Function; getUserServices: Function; saveServiceConfig: Function; removeServiceConfig: Function };
  private readonly startedAt = new Date().toISOString();

  /**
   * v694 — Erweitert eine linkedUserIds-Liste um Legacy-Daten-UIDs, ABER nur wenn der
   * sweepende UID === ownerMasterUserId. Verhindert dass Gast-User auf Owner-Daten zugreifen.
   */
  private withLegacyForOwner(uid: string, linkedIds: string[]): string[] {
    if (!this.ownerMasterUserId || uid !== this.ownerMasterUserId) return linkedIds;
    if (this.legacyDataUids.length === 0) return linkedIds;
    const merged = [...linkedIds];
    for (const lid of this.legacyDataUids) if (!merged.includes(lid)) merged.push(lid);
    return merged;
  }

  constructor(private config: AlfredConfig) {
    this.logger = createLogger('alfred', config.logger.level);
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Alfred...');

    // 1. Initialize storage
    this.database = await Database.create({
      backend: this.config.storage.backend ?? 'sqlite',
      path: this.config.storage.path,
      connectionString: this.config.storage.connectionString,
    });
    const adapter = this.database.getAdapter();

    // v767/v768 — Universal Startup-Cleanup für nicht-terminale Agent-Tasks.
    // Läuft direkt nach DB-Create, unabhängig von Sandbox-Manager-State.
    // Zwei Tabellen:
    //  - sandbox_chat_messages (taskPhase) — Interactive-Chat-View
    //  - project_agent_sessions (currentPhase) — Project-Agents-Page + Projects "Aktuell laufend"
    // Beide werden nach Restart als orphan markiert (Runner ist tot, kein Auto-Resume).
    try {
      const { SandboxChatRepository: SandboxChatRepoStartup, ProjectAgentSessionRepository: PASRStartup } = await import('@alfred/storage');
      const sandboxChatRepoStartup = new SandboxChatRepoStartup(adapter);
      const orphanedChat = await sandboxChatRepoStartup.failOrphanedCodeAgentTasks();
      if (orphanedChat > 0) this.logger.info({ count: orphanedChat }, 'v767 startup: marked orphaned chat-tasks as failed');
      const sessRepoStartup = new PASRStartup(adapter);
      const orphanedSess = await sessRepoStartup.failOrphanedSessions();
      if (orphanedSess > 0) this.logger.info({ count: orphanedSess }, 'v768 startup: marked orphaned project-agent-sessions as failed');
    } catch (err) {
      this.logger.warn({ err }, 'v767/v768 startup orphan-cleanup failed (non-fatal)');
    }

    const conversationRepo = new ConversationRepository(adapter);
    this.conversationRepo = conversationRepo;
    const userRepo = new UserRepository(adapter);
    this.userRepo = userRepo;
    const auditRepo = new AuditRepository(adapter);
    this.auditRepo = auditRepo;
    const memoryRepo = new MemoryRepository(adapter);
    this.memoryRepo = memoryRepo;
    const skillStateRepo = new SkillStateRepository(adapter);
    const reminderRepo = new ReminderRepository(adapter);
    this.reminderRepo = reminderRepo;
    const noteRepo = new NoteRepository(adapter);
    this.noteRepo = noteRepo;
    const embeddingRepo = new EmbeddingRepository(adapter);
    const linkTokenRepo = new LinkTokenRepository(adapter);
    const backgroundTaskRepo = new BackgroundTaskRepository(adapter);
    const scheduledActionRepo = new ScheduledActionRepository(adapter);
    this.scheduledActionRepo = scheduledActionRepo;
    const activityRepo = new ActivityRepository(adapter);
    this.activityRepo = activityRepo;
    const activityLogger = new ActivityLogger(activityRepo, this.logger.child({ component: 'activity' }));
    const skillHealthRepo = new SkillHealthRepository(adapter);
    this.skillHealthRepo = skillHealthRepo;
    const skillHealthTracker = new SkillHealthTracker(
      skillHealthRepo,
      this.logger.child({ component: 'skill-health' }),
      activityLogger,
    );
    this.skillHealthTracker = skillHealthTracker;
    this.logger.info('Storage initialized');

    // 2. Initialize security — load rules from YAML files
    const ruleEngine = new RuleEngine();
    const rules = this.loadSecurityRules();
    ruleEngine.loadRules(rules);
    // v603 — file-based audit sink (rotates daily, configurable path via
    // logger.auditLogPath). Wires alongside the DB-backed AuditRepository so
    // every security evaluation gets tail-able + queryable.
    let auditFileSink: import('@alfred/logger').AuditLogger | undefined;
    try {
      const { AuditLogger } = await import('@alfred/logger');
      const auditPath = this.config.logger.auditLogPath ?? './data/logs/audit.log';
      auditFileSink = new AuditLogger(auditPath);
      this.logger.info({ path: auditPath }, 'File-based audit logger initialized');
    } catch (err) {
      this.logger.warn({ err }, 'File-based audit logger init failed — DB-audit still active');
    }
    const securityManager = new SecurityManager(
      ruleEngine,
      auditRepo,
      this.logger.child({ component: 'security' }),
      auditFileSink,
    );
    this.logger.info({ ruleCount: rules.length }, 'Security engine initialized');

    // 3. Initialize LLM provider (multi-model router)
    const llmProvider = createModelRouter(this.config.llm, this.logger.child({ component: 'llm' }));
    await llmProvider.initialize();
    this.llmProvider = llmProvider;

    // Wire SQLite usage persistence
    const usageRepo = new UsageRepository(adapter);
    this.usageRepo = usageRepo;
    llmProvider.setPersist((model, inp, out, cacheR, cacheW, cost) => {
      usageRepo.record(model, inp, out, cacheR, cacheW, cost).catch(() => {});
    });

    // Service usage tracking (STT, TTS, OCR, Moderation)
    const serviceUsageRepo = new ServiceUsageRepository(adapter);
    this.serviceUsageRepo = serviceUsageRepo;

    // Create embedding service
    const embeddingService = new EmbeddingService(
      llmProvider,
      embeddingRepo,
      this.logger.child({ component: 'embeddings' }),
    );
    // v813c — auf this. legen damit Callbacks außerhalb dieses Closures
    // (z.B. reMatchOpenItems API) darauf zugreifen können.
    this.embeddingServiceRef = embeddingService;
    this.embeddingRepoRef = embeddingRepo;

    // Validate embedding model consistency — invalidate + re-embed if model changed
    const embeddingModelName = this.config.llm.embeddings?.model
      ?? this.config.llm.default?.model
      ?? 'unknown';
    if (llmProvider.supportsEmbeddings()) {
      try {
        const deleted = await embeddingService.validateModelConsistency(embeddingModelName);
        if (deleted > 0) {
          // Re-embed all memories in the background (non-blocking)
          setTimeout(async () => {
            try {
              const users = await userRepo.listAll();
              let total = 0;
              for (const user of users) {
                const memories = await memoryRepo.listAll(user.id);
                for (const mem of memories) {
                  await embeddingService.embedAndStore(
                    user.id,
                    `${mem.key}: ${mem.value}`,
                    'memory',
                    mem.id,
                  );
                  total++;
                }
              }
              this.logger.info(
                { count: total, model: embeddingModelName },
                'Re-embedded all memories with new model',
              );
            } catch (err) {
              this.logger.error({ err }, 'Background re-embedding failed');
            }
          }, 5000);
        }
      } catch (err) {
        this.logger.error({ err }, 'Embedding model consistency check failed');
      }
    }

    // 3b. Active learning & memory retriever
    const activeLearningEnabled = this.config.activeLearning?.enabled !== false;
    let activeLearning: ActiveLearningService | undefined;
    let memoryRetriever: MemoryRetriever | undefined;

    if (activeLearningEnabled) {
      activeLearning = new ActiveLearningService({
        llm: llmProvider,
        memoryRepo,
        logger: this.logger.child({ component: 'active-learning' }),
        embeddingService,
        minMessageLength: this.config.activeLearning?.minMessageLength,
        minConfidence: this.config.activeLearning?.minConfidence,
        maxExtractionsPerMinute: this.config.activeLearning?.maxExtractionsPerMinute,
      });

      memoryRetriever = new MemoryRetriever(
        memoryRepo,
        this.logger.child({ component: 'memory-retriever' }),
        embeddingService,
      );

      this.logger.info('Active learning & memory retriever initialized');
    }

    // 3c. Conversation summarizer
    const summaryRepo = new SummaryRepository(adapter);
    this.summaryRepo = summaryRepo;
    const conversationSummarizer = new ConversationSummarizer(
      llmProvider,
      summaryRepo,
      this.logger.child({ component: 'summarizer' }),
    );
    this.logger.info('Conversation summarizer initialized');

    // 4. Initialize skills
    const skillSandbox = this.skillSandbox = new SkillSandbox(
      this.logger.child({ component: 'sandbox' }),
    );
    const skillRegistry = this.skillRegistry = new SkillRegistry();
    skillRegistry.register(new CalculatorSkill());
    skillRegistry.register(new SystemInfoSkill());
    skillRegistry.register(new WebSearchSkill(this.config.search ? {
      provider: this.config.search.provider,
      apiKey: this.config.search.apiKey,
      baseUrl: this.config.search.baseUrl,
    } : undefined));
    skillRegistry.register(new ReminderSkill(reminderRepo));
    const noteSkill = new NoteSkill(noteRepo);
    skillRegistry.register(noteSkill);
    const todoRepo = new TodoRepository(adapter);
    this.todoRepo = todoRepo;
    const todoSkill = new TodoSkill(todoRepo);
    skillRegistry.register(todoSkill);
    skillRegistry.register(new WeatherSkill());
    skillRegistry.register(new ShellSkill());
    const memorySkill = new MemorySkill(memoryRepo, embeddingService);
    skillRegistry.register(memorySkill);
    this.memorySkillRef = memorySkill;
    const delegateSkill = new DelegateSkill(llmProvider, skillRegistry, skillSandbox, securityManager);
    skillRegistry.register(delegateSkill);
    this.delegateSkillRef = delegateSkill;

    // Full-text chat history search (FTS5 / tsvector, migration v59/v62)
    {
      const { ChatHistorySkill } = await import('@alfred/skills');
      skillRegistry.register(new ChatHistorySkill(conversationRepo));
    }

    // 3b. Brainstorming skill
    {
      const { BrainstormingSkill } = await import('@alfred/skills');
      const { BrainstormingRepository } = await import('@alfred/storage');
      const brainstormRepo = new BrainstormingRepository(adapter);
      const brainstormSkill = new BrainstormingSkill(brainstormRepo);
      // Wire KG context fetcher
      brainstormSkill.setKgContextFn(async (_userId: string, topic: string) => {
        if (!this.kgServiceRef) return '';
        // Always use ownerMasterUserId — alfredUserId is different from KG user_id
        const resolvedUid = this.ownerMasterUserId ?? _userId;
        const graph = await new KnowledgeGraphRepository(adapter).getFullGraph(resolvedUid);
        const topicLower = topic.toLowerCase();
        const relevant = graph.entities.filter(e =>
          e.name.toLowerCase().includes(topicLower) ||
          e.normalizedName.includes(topicLower) ||
          (e.attributes?.value && String(e.attributes.value).toLowerCase().includes(topicLower)),
        );
        // Also get entities connected to relevant ones
        const relevantIds = new Set(relevant.map(e => e.id));
        const connectedRelations = graph.relations.filter(r => relevantIds.has(r.sourceEntityId) || relevantIds.has(r.targetEntityId));
        const connectedIds = new Set<string>();
        for (const r of connectedRelations) { connectedIds.add(r.sourceEntityId); connectedIds.add(r.targetEntityId); }
        const allRelevant = graph.entities.filter(e => relevantIds.has(e.id) || connectedIds.has(e.id));

        const lines = allRelevant.slice(0, 20).map(e => {
          const attrs = Object.entries(e.attributes ?? {}).filter(([k]) => !['skillName', 'type', 'memoryKey', 'memoryConfidence'].includes(k)).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
          return `- [${e.entityType}] ${e.name}${attrs ? ` (${attrs})` : ''}`;
        });
        const relLines = connectedRelations.slice(0, 15).map(r => {
          const src = allRelevant.find(e => e.id === r.sourceEntityId)?.name ?? '?';
          const tgt = allRelevant.find(e => e.id === r.targetEntityId)?.name ?? '?';
          return `- ${src} → ${r.relationType} → ${tgt}`;
        });
        // Also fetch relevant memories
        let memContext = '';
        try {
          const mems = await memoryRepo.search(resolvedUid, topic);
          memContext = mems.slice(0, 5).map(m => `- [memory] ${m.key}: ${m.value.slice(0, 100)}`).join('\n');
        } catch { /* skip */ }

        return `Entities:\n${lines.join('\n')}\n\nRelationen:\n${relLines.join('\n')}${memContext ? `\n\nMemories:\n${memContext}` : ''}`;
      });
      // Wire LLM call
      brainstormSkill.setLlmCallFn(async (prompt: string, tier: 'default' | 'strong') => {
        const response = await llmProvider.complete({
          messages: [{ role: 'user', content: prompt }],
          tier,
          maxTokens: 2000,
        });
        return response.content;
      });
      skillRegistry.register(brainstormSkill);
      this.logger.info('Brainstorming skill registered');
    }

    // 3c. v726 — Environments skill (Project-ENV-Management mit AES-GCM-Encryption).
    // Crypto-Key aus Config oder auto-generated bei erstem Start.
    try {
      const { EnvironmentsSkill } = await import('@alfred/skills');
      const { EnvironmentRepository, DbSeedRepository } = await import('@alfred/storage');
      const { EnvCryptoService } = await import('@alfred/security');
      const envRepo = new EnvironmentRepository(adapter);
      const dbSeedRepo = new DbSeedRepository(adapter);
      let envKey = this.config.security?.envEncryptionKey;
      if (!envKey) {
        envKey = EnvCryptoService.generateMasterKey();
        this.logger.warn({ keyPreview: envKey.slice(0, 8) + '…' }, 'v726 envEncryptionKey nicht in Config — auto-generated (volatile! In Config persistieren um Daten zu behalten)');
      }
      const envCrypto = new EnvCryptoService(envKey);
      this.envRepoRef = envRepo;
      this.envCryptoRef = envCrypto;
      this.dbSeedRepoRef = dbSeedRepo;
      // Wird unten nach projectRepo-Init verdrahtet (siehe Late-Bind in initialize())
      this.envSkillFactory = (projectRepo, ownerUid) => {
        const s = new EnvironmentsSkill(envRepo, envCrypto, projectRepo, ownerUid, dbSeedRepo);
        skillRegistry.register(s);
        this.logger.info('v726 Environments skill registered');
        return s;
      };
    } catch (err) {
      this.logger.warn({ err }, 'v726 Environments skill init failed (non-fatal)');
    }

    // 4a-email. Initialize email (optional, multi-account)
    if (this.config.email?.accounts?.length) {
      const providers = new Map<string, import('@alfred/skills').EmailProvider>();
      for (const account of this.config.email.accounts) {
        try {
          // Share Microsoft credentials from calendar if not set
          if (account.provider === 'microsoft' && !account.microsoft?.clientId) {
            if (this.config.calendar?.microsoft) {
              account.microsoft = { ...this.config.calendar.microsoft };
            }
          }
          const provider = await createEmailProvider(account);
          providers.set(account.name, provider);
          this.logger.info({ account: account.name, provider: account.provider ?? 'imap-smtp' }, 'Email account initialized');
        } catch (err) {
          this.logger.warn({ err, account: account.name }, 'Email account initialization failed, skipping');
        }
      }
      const emailSkill = providers.size > 0 ? new EmailSkill(providers) : new EmailSkill();
      emailSkill.setLLM(llmProvider);
      skillRegistry.register(emailSkill);
    } else {
      const emailSkill = new EmailSkill();
      emailSkill.setLLM(llmProvider);
      skillRegistry.register(emailSkill);
    }
    skillRegistry.register(new HttpSkill());
    skillRegistry.register(new FileSkill());
    const configureSkill = new ConfigureSkill();
    configureSkill.setReloadCallback((service) => this.reloadService(service as 'proxmox' | 'unifi' | 'homeassistant' | 'todo'));
    configureSkill.setHealthAdapter(skillHealthTracker);
    skillRegistry.register(configureSkill);
    skillRegistry.register(new ClipboardSkill());
    skillRegistry.register(new ScreenshotSkill());
    skillRegistry.register(new BrowserSkill());
    skillRegistry.register(new ProfileSkill(userRepo));
    const crossPlatformSkill = new CrossPlatformSkill(userRepo, linkTokenRepo, this.adapters, (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId));
    skillRegistry.register(crossPlatformSkill);
    const backgroundTaskSkill = new BackgroundTaskSkill(backgroundTaskRepo, skillRegistry);
    skillRegistry.register(backgroundTaskSkill);
    skillRegistry.register(new ScheduledTaskSkill(scheduledActionRepo, skillRegistry));

    // 4a. Document intelligence
    const documentRepo = new DocumentRepository(adapter);
    this.documentRepoRef = documentRepo;
    // v673 — AttachmentRepository für Todos + Notes (Lazy-Import um Bundle-Reihenfolge zu schonen)
    const { AttachmentRepository } = await import('@alfred/storage');
    this.attachmentRepo = new AttachmentRepository(adapter);
    const documentProcessor = new DocumentProcessor(documentRepo, embeddingService, this.logger.child({ component: 'documents' }));

    // 4a-ocr. Wire up Mistral OCR if a Mistral LLM provider is configured
    const mistralApiKey = this.detectMistralApiKey();
    if (mistralApiKey) {
      const { OcrService } = await import('@alfred/skills');
      const ocrService = new OcrService(mistralApiKey);
      ocrService.setUsageCallback((model, units) => {
        serviceUsageRepo.record('ocr', model, units).catch(() => {});
      });
      documentProcessor.setOcrService(ocrService);
      this.logger.info('Mistral OCR enabled for document processing');
    }

    // SharedResourceRepo for document sharing — created later, set after user management init
    const documentSkill = new DocumentSkill(documentRepo, documentProcessor, embeddingService);
    skillRegistry.register(documentSkill);

    // 4b. Initialize calendar (optional)
    let calendarSkill: CalendarSkill | undefined;
    let calendarProvider: import('@alfred/skills').CalendarProvider | undefined;
    if (this.config.calendar) {
      try {
        calendarProvider = await createCalendarProvider(this.config.calendar);
        calendarSkill = new CalendarSkill(calendarProvider);
        skillRegistry.register(calendarSkill);
        this.logger.info({ provider: this.config.calendar.provider }, 'Calendar initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Calendar initialization failed, continuing without calendar');
      }
    }
    this.calendarSkill = calendarSkill;

    // Determine the default platform for proactive notifications (watchers, reasoning)
    const defaultProactivePlatform = ([...this.adapters.keys()][0] ?? 'telegram') as Platform;

    // 4b2. Initialize calendar vorlauf watcher (optional)
    if (calendarProvider && this.config.calendar?.vorlauf?.enabled) {
      const calNotifRepo = new CalendarNotificationRepository(adapter);
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId) {
        this.calendarWatcher = new CalendarWatcher(
          calendarProvider,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          defaultProactivePlatform,
          this.config.calendar.vorlauf,
          this.logger.child({ component: 'calendar-watcher' }),
          activityLogger,
        );
      }
    }

    // 4b3. Initialize todo watcher — reminds about upcoming/overdue todos
    {
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId) {
        const calNotifRepo = new CalendarNotificationRepository(adapter);
        this.todoWatcher = new TodoWatcher(
          todoRepo,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          defaultProactivePlatform,
          { minutesBefore: 30 },
          this.logger.child({ component: 'todo-watcher' }),
          activityLogger,
          ownerUserId,
        );
      }
    }


    // 4c. Initialize MCP servers (optional)
    if (this.config.mcp?.servers?.length) {
      const { MCPManager } = await import('@alfred/skills');
      this.mcpManager = new MCPManager(this.logger.child({ component: 'mcp' }));
      await this.mcpManager.initialize(this.config.mcp);
      for (const skill of this.mcpManager.getSkills()) {
        skillRegistry.register(skill);
      }
      this.logger.info({ mcpSkills: this.mcpManager.getSkills().length }, 'MCP skills registered');
    }

    // 4d. Code sandbox (optional, requires explicit enable)
    if (this.config.codeSandbox?.enabled) {
      const { CodeExecutionSkill } = await import('@alfred/skills');
      skillRegistry.register(new CodeExecutionSkill({
        allowedLanguages: this.config.codeSandbox.allowedLanguages,
        maxTimeoutMs: this.config.codeSandbox.maxTimeoutMs,
      }));
      this.logger.info('Code sandbox enabled');
    }

    // 4e. Code agents (optional, requires explicit enable)
    if (this.config.codeAgents?.enabled) {
      const { CodeAgentSkill } = await import('@alfred/skills');
      const codeAgentSkill = new CodeAgentSkill(
        { agents: this.config.codeAgents.agents, forge: this.config.codeAgents.forge },
        llmProvider,
      );
      skillRegistry.register(codeAgentSkill);
      this.codeAgentSkillRef = codeAgentSkill;
      this.logger.info({ agents: this.config.codeAgents.agents.map(a => a.name) }, 'Code agent skill enabled');

      // v779 — AgentSessionManager initialisieren.
      // v780 — ClaudeCodeAdapter registriert wenn claude-code in agents-config vorhanden.
      // v784 — VibeAdapter registriert wenn vibe in agents-config vorhanden.
      // v785 — CodexAdapter registriert wenn codex in agents-config vorhanden.
      // v786 — GenericPlainAdapter als Fallback für alle restlichen Agents (kilo, opencode, pi-code, etc.).
      try {
        const { AgentSessionManager, ClaudeCodeAdapter, VibeAdapter, CodexAdapter, GenericPlainAdapter } = await import('@alfred/skills');
        const { AgentSessionRepository: AgentSessionRepo } = await import('@alfred/storage');
        const agentSessionRepo = new AgentSessionRepo(adapter);
        this.agentSessionManager = new AgentSessionManager({
          adapters: new Map(),
          repo: agentSessionRepo,
          logger: this.logger.child({ component: 'agent-session' }),
        });
        // Helper: extract real command + args wenn agent via `sudo -u <user>` gewrappt ist.
        // GenericPlainAdapter wendet sudo selbst an (basierend auf opts.runAsUser) — wir
        // brauchen also die un-gewrappte Variante als Adapter-Config.
        const unwrapSudo = (agent: { command: string; argsTemplate: string[] }) => {
          if (agent.command === 'sudo' && agent.argsTemplate[0] === '-u' && agent.argsTemplate[1]) {
            return { command: agent.argsTemplate[2], argsTemplate: agent.argsTemplate.slice(3) };
          }
          return { command: agent.command, argsTemplate: agent.argsTemplate };
        };
        // v780 — Claude-Adapter registrieren wenn `claude-code` Agent in config existiert
        const hasClaudeAgent = this.config.codeAgents.agents.some(a =>
          a.name === 'claude-code' || a.command === 'claude' || a.command === 'claude-code',
        );
        if (hasClaudeAgent) {
          this.agentSessionManager.registerAdapter(new ClaudeCodeAdapter(this.logger.child({ component: 'claude-code-adapter' })));
        }
        // v784 — Vibe-Adapter registrieren wenn `vibe` Agent in config existiert (Mistral Vibe)
        const hasVibeAgent = this.config.codeAgents.agents.some(a =>
          a.name === 'vibe' || a.name === 'mistral-vibe' || a.command === 'vibe',
        );
        if (hasVibeAgent) {
          this.agentSessionManager.registerAdapter(new VibeAdapter(this.logger.child({ component: 'vibe-adapter' })));
        }
        // v785 — Codex-Adapter registrieren wenn `codex` Agent in config existiert (OpenAI Codex CLI)
        const hasCodexAgent = this.config.codeAgents.agents.some(a =>
          a.name === 'codex' || a.name === 'openai-codex' || a.command === 'codex',
        );
        if (hasCodexAgent) {
          this.agentSessionManager.registerAdapter(new CodexAdapter(this.logger.child({ component: 'codex-adapter' })));
        }
        // v786 — GenericPlainAdapter für alle übrigen Agents.
        // Liste der "specialized" Adapter-Identifier (nach Agent-Name oder Command).
        const SPECIALIZED = new Set(['claude-code', 'vibe', 'mistral-vibe', 'codex', 'openai-codex']);
        const SPECIALIZED_COMMANDS = new Set(['claude', 'claude-code', 'vibe', 'codex']);
        for (const agent of this.config.codeAgents.agents) {
          const baseCmd = unwrapSudo(agent).command;
          if (SPECIALIZED.has(agent.name) || SPECIALIZED_COMMANDS.has(baseCmd)) continue;
          if (this.agentSessionManager.listAdapters().some(a => a.name === agent.name)) continue;
          const unwrapped = unwrapSudo(agent);
          this.agentSessionManager.registerAdapter(new GenericPlainAdapter(
            this.logger.child({ component: `generic-adapter:${agent.name}` }),
            {
              name: agent.name,
              command: unwrapped.command,
              argsTemplate: unwrapped.argsTemplate,
              promptVia: agent.promptVia ?? 'arg',
              env: agent.env,
              cwd: agent.cwd,
            },
          ));
        }
        this.agentSessionManager.startHealthMonitor();
        this.logger.info({ adapters: this.agentSessionManager.listAdapters().map(a => a.name) }, 'v779/v780/v784/v785/v786 AgentSessionManager initialized');
      } catch (err) {
        this.logger.warn({ err }, 'v779/v780/v784/v785/v786 AgentSessionManager init failed (non-fatal, falls back to legacy executeAgent)');
      }
    }

    // 4e1. Projects — long-lived containers for project-agent / code-agent / delegate sessions.
    // Registered BEFORE the project-agent block so its completion-callback can reference
    // this.projectManager lazily (callback fires later when projectManager is in place).
    if (this.config.projects?.enabled !== false) {
      const { ProjectRepository } = await import('@alfred/storage');
      const { ProjectManager } = await import('./projects/project-manager.js');
      const { SessionSummarizer } = await import('./projects/session-summarizer.js');
      const projectRepo = new ProjectRepository(adapter);
      // v824 — Agent-Conventions Repository (Phase 1 wire)
      const agentConventionsRepo = new AgentConventionsRepository(adapter);
      this.agentConventionsRepo = agentConventionsRepo;
      const summarizer = new SessionSummarizer(llmProvider, this.config.projects?.summarizerLlmTier ?? 'strong');
      const projectManager = new ProjectManager(
        projectRepo,
        summarizer,
        this.logger.child({ component: 'project-manager' }),
        this.config.projects?.autoBindByCwd ?? true,
      );
      this.projectRepo = projectRepo;
      this.projectManager = projectManager;

      // v726 — Late-Wire EnvironmentsSkill, jetzt da projectRepo da ist
      if (this.envSkillFactory) {
        const ownerUid = this.tryOwner() ?? '';
        if (ownerUid) {
          try { this.envSkillFactory(projectRepo, ownerUid); } catch (err) {
            this.logger.warn({ err }, 'v726 EnvironmentsSkill late-wire failed');
          }
        }
      }

      // v665a — Cluster-Share Manager: Startup-Check auf konfigurierte Shares (NFS/SMB).
      // Bei Single-Node-Setup ohne Shares: no-op. Bei Cluster ohne Mounts: warnt aber blockt nicht.
      try {
        const sharesConfig = this.config.infra?.shares ?? [];
        const { ShareManager } = await import('./cluster/share-manager.js');
        const shareManager = new ShareManager(
          sharesConfig as import('./cluster/share-manager.js').ShareConfig[],
          this.logger.child({ component: 'share-manager' }),
        );
        await shareManager.checkAll();
        this.shareManager = shareManager;

        // v665b — ProjectMoveService aufsetzen
        const { ProjectMoveService } = await import('./cluster/project-move.js');
        const localBase = this.config.projects?.localBase ?? path.join(os.homedir(), 'projects');
        const defaultExcludes = this.config.projects?.rsyncExcludes ?? ['node_modules', 'dist', 'build', '.next', '__pycache__', '.cache', 'target', 'coverage'];
        const myNodeId = this.config.cluster?.nodeId ?? 'single';
        this.projectMoveService = new ProjectMoveService(
          projectRepo, shareManager, localBase, defaultExcludes, myNodeId,
          this.logger.child({ component: 'project-move' }),
        );

        // Periodischer Stale-Lock-Sweep alle 5min
        setInterval(() => {
          projectRepo.sweepStaleLocks().then(n => {
            if (n > 0) this.logger.info({ released: n }, 'v665a: stale project-locks freigegeben');
          }).catch(err => this.logger.debug({ err }, 'sweepStaleLocks failed'));
        }, 5 * 60_000);
      } catch (err) {
        this.logger.warn({ err }, 'ShareManager wiring failed (non-fatal)');
      }

      // v663b — Project Automations Repo + Engine
      try {
        const { ProjectAutomationsRepository } = await import('@alfred/storage');
        const automationsRepo = new ProjectAutomationsRepository(adapter);
        this.projectAutomationsRepo = automationsRepo;
        const { AutomationEngine } = await import('./automation/automation-engine.js');
        const ownerChatIdForAuto = this.config.security?.ownerUserId ?? '';
        const ownerPlatformForAuto = (this.config.telegram?.enabled ? 'telegram'
          : this.config.matrix?.enabled ? 'matrix'
          : 'api') as Platform;
        const engine = new AutomationEngine(
          automationsRepo,
          projectRepo,
          conversationRepo,
          this.llmProvider,
          this.adapters,
          this.logger.child({ component: 'automation-engine' }),
          ownerChatIdForAuto,
          ownerPlatformForAuto,
        );
        this.automationEngine = engine;
        engine.start();
        this.logger.info('Automation Engine started (v663b)');
      } catch (err) {
        this.logger.warn({ err }, 'AutomationEngine wiring failed (non-fatal)');
      }

      // v616 NA1 — One-shot cleanup für unleserliche Projekt-Namen aus dem alten
      // goal.slice(0,80) Format. Idempotent — läuft sicher mehrfach. Fire-and-forget
      // damit Startup nicht blockiert wird. Memory-Marker verhindert dass es bei
      // jedem Start läuft.
      (async () => {
        try {
          const ownerUid = this.tryOwner();
          if (!ownerUid) return;
          if (this.memoryRepo) {
            const markerKey = 'project_names_rebuilt_v616';
            const existing = await this.memoryRepo.search(ownerUid, markerKey).catch(() => []);
            if (existing.some(m => m.key === markerKey)) return; // already done
          }
          const result = await projectManager.rebuildLongProjectNames(ownerUid);
          this.logger.info({ ...result }, 'v616 NA1: project names rebuild complete');
          if (this.memoryRepo) {
            await this.memoryRepo.saveWithMetadata(
              ownerUid, 'project_names_rebuilt_v616',
              `Rebuild: ${result.renamed} renamed, ${result.skipped} skipped`,
              'general', 'feedback', 1.0, 'auto',
            ).catch(() => {});
          }
        } catch (err) { this.logger.debug({ err }, 'v616 NA1 startup rebuild failed (non-critical)'); }
      })().catch(() => {});

      // v798 — One-shot Migration für orphan-Projekte (sandbox-worktree cwd → parent-project).
      // Idempotent — bei jedem Startup geprüft, aber nur orphans mit status='active' werden bearbeitet.
      // Nach erfolgreichem Migrate werden orphans archived → keine erneute Bearbeitung.
      (async () => {
        try {
          if (!this.database) return;
          const result = await projectManager.migrateOrphanProjects({ adapter: this.database.getAdapter() as any });
          if (result.migrated > 0 || result.errors.length > 0) {
            this.logger.info(result, 'v798 orphan-project migration complete');
          }
        } catch (err) { this.logger.debug({ err }, 'v798 orphan-migration startup failed (non-critical)'); }
      })().catch(() => {});

      const { ProjectSkill } = await import('@alfred/skills');
      const projectSkill = new ProjectSkill(projectRepo);
      // v602 P4 — forward open-item resolve to ITSM (best-effort, errors swallowed).
      // Bound late via runtime lookup of itsmSkill registered in the CMDB-block.
      projectSkill.setIncidentCascade(async (incidentId, status) => {
        try {
          const itsmSkill = skillRegistry.get('itsm');
          if (!itsmSkill) return false;
          const userId = this.tryOwner() ?? '';
          if (!userId) return false;
          const ctx = { userId, masterUserId: userId, chatId: this.config.security?.ownerUserId ?? '', platform: 'api' } as unknown as import('@alfred/types').SkillContext;
          await itsmSkill.execute({ action: status === 'closed' ? 'close_incident' : 'update_incident', incident_id: incidentId, status }, ctx);
          return true;
        } catch { return false; }
      });
      skillRegistry.register(projectSkill);
      this.projectSkillRef = projectSkill;

      // T4 wiring — Delegate + Code-Agent Lifecycle into the Project-Manager.
      // Threshold gate prevents trivial single-tool-call sessions from polluting
      // the project list. CodeAgent sessions auto-bind by cwd; Delegate sessions
      // (no cwd) route into the Misc-bucket.
      const { isSubstantialSession } = await import('./projects/session-thresholds.js');
      const { WorkflowExtractor } = await import('./projects/workflow-extractor.js');
      const thresholdConfig = {
        toolCallsThreshold: this.config.projects?.orphanDelegateThresholdToolCalls,
        minutesThreshold: this.config.projects?.orphanDelegateThresholdMinutes,
      };

      // v602 P2 — WorkflowExtractor: analyzes substantial Delegate-Sessions and
      // proposes a reusable Workflow if the sequence is structured + parametrizable.
      const workflowExtractor = new WorkflowExtractor(
        llmProvider,
        this.config.projects?.summarizerLlmTier ?? 'strong',
      );

      // Helper: given a substantial session, run extractor + enqueue a Workflow-Confirmation
      // (in parallel to the runbook flow — both artifacts are intentionally separate).
      const proposeWorkflowFromSession = async (params: {
        userId: string;
        goal: string;
        toolCalls: Array<{ name: string; input: Record<string, unknown>; success: boolean; output?: string }>;
        sourceId: string;
      }): Promise<void> => {
        if (!this.confirmationQueue) return;
        try {
          const availableSkills = new Set(skillRegistry.getAll().map(s => s.metadata.name));
          const extracted = await workflowExtractor.analyze({
            goal: params.goal,
            toolCalls: params.toolCalls,
            availableSkills,
          });
          if (!extracted.reusable || !extracted.steps || !extracted.suggestedName) return;
          const ownerPlatformForWf = (this.config.telegram?.enabled ? 'telegram'
            : this.config.discord?.enabled ? 'discord'
            : this.config.whatsapp?.enabled ? 'whatsapp'
            : 'api');
          await this.confirmationQueue.enqueue({
            chatId: this.config.security?.ownerUserId ?? '',
            platform: ownerPlatformForWf,
            source: 'reasoning',
            sourceId: `workflow-from-session-${params.sourceId.slice(0, 16)}`,
            description: `Workflow '${extracted.suggestedName}' (${extracted.steps.length} Schritte) aus der Session erkannt — als wiederverwendbar speichern?\n\n${extracted.suggestedDescription ?? ''}`,
            skillName: 'workflow',
            skillParams: {
              action: 'create',
              name: extracted.suggestedName,
              description: extracted.suggestedDescription,
              steps: extracted.steps,
              triggerType: 'manual',
              autoExtracted: true,
              sourceSessionId: params.sourceId,
            },
            timeoutMinutes: 24 * 60,
          });
          this.logger.info({ name: extracted.suggestedName, steps: extracted.steps.length, sourceId: params.sourceId }, 'Workflow extraction enqueued');
        } catch (err) {
          this.logger.debug({ err }, 'WorkflowExtractor failed (non-critical)');
        }
      };

      if (this.delegateSkillRef) {
        this.delegateSkillRef.setSessionCompletionCallback(async (info) => {
          if (!isSubstantialSession({
            toolCalls: info.toolCalls, filesChanged: info.filesChanged, durationMs: info.durationMs,
          }, thresholdConfig)) {
            return;
          }
          const userId = info.context.masterUserId ?? this.tryOwner() ?? '';
          if (!userId) return;
          const sourceId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // v668 — echte Startzeit aus durationMs ableiten
          const startedAt = info.durationMs != null
            ? new Date(Date.now() - info.durationMs).toISOString()
            : undefined;
          try {
            await projectManager.finishOrphanSession({
              userId,
              sessionType: 'delegate',
              sourceId,
              goal: info.task,
              success: info.success,
              transcript: info.finalResponse,
              totalFilesChanged: info.filesChanged,
              startedAt,
            });
          } catch (err) { this.logger.debug({ err }, 'delegate completion → project-manager failed'); }

          // v602 P2 — Workflow extraction (only on success, tool-call names are known)
          if (info.success && info.toolNames.length > 0) {
            try {
              const reconstructed = info.toolNames.map(name => ({ name, input: {}, success: true }));
              await proposeWorkflowFromSession({
                userId, goal: info.task, toolCalls: reconstructed, sourceId,
              });
            } catch (err) { this.logger.debug({ err }, 'delegate workflow-extraction failed'); }
          }
        });
      }

      if (this.codeAgentSkillRef) {
        this.codeAgentSkillRef.setSessionCompletionCallback(async (info) => {
          if (!isSubstantialSession({
            toolCalls: info.toolCalls, filesChanged: info.filesChanged, durationMs: info.durationMs,
          }, thresholdConfig)) {
            return;
          }
          const userId = info.context.masterUserId ?? this.tryOwner() ?? '';
          if (!userId) return;
          try {
            // v668 — echte Startzeit aus durationMs ableiten
            const startedAt = info.durationMs != null
              ? new Date(Date.now() - info.durationMs).toISOString()
              : undefined;
            if (info.cwd) {
              // v798 — Sandbox→Project Resolution wenn info.cwd unter sandbox-worktrees liegt.
              // Vorher: code-agent runs im sandbox-worktree erstellten orphan-Projekte
              // (ipk73ad8 etc.) weil findByCwd auf worktree-cwd kein parent-project findet.
              // Jetzt: lookup sandbox→project, übergibt projectId explicit an finishSession.
              let resolvedCodeCwd = info.cwd;
              let resolvedCodeProjectId: string | undefined;
              try {
                if (info.cwd.includes('/sandbox-worktrees/') && this.database) {
                  const adapter = this.database.getAdapter();
                  const sbRow = await adapter.queryOne(
                    `SELECT project_id FROM project_agent_sandboxes WHERE worktree_path = ?`,
                    [info.cwd],
                  ).catch(() => null) as { project_id?: string } | null;
                  if (sbRow?.project_id && this.projectRepo) {
                    // v803 — getByIdAnyOwner statt getById (siehe v721-resolution comment).
                    const proj = await this.projectRepo.getByIdAnyOwner(sbRow.project_id).catch(() => null);
                    if (proj?.cwd) {
                      resolvedCodeCwd = proj.cwd;
                      resolvedCodeProjectId = proj.id;
                    }
                  }
                }
              } catch (err) {
                this.logger.debug({ err, cwd: info.cwd }, 'v798/v803 code-agent sandbox→project resolution failed');
              }
              // cwd present → standard auto-bind by cwd (creates or joins a project)
              await projectManager.finishSession({
                userId,
                sessionType: 'code_agent',
                sourceId: `code-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                goal: info.agentOrTask,
                cwd: resolvedCodeCwd,
                projectId: resolvedCodeProjectId, // v798 — explicit, verhindert orphan
                success: info.success,
                transcript: info.finalOutput,
                files: info.modifiedFiles,
                totalFilesChanged: info.filesChanged,
                startedAt,
              });
            } else {
              await projectManager.finishOrphanSession({
                userId,
                sessionType: 'code_agent',
                sourceId: `code-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                goal: info.agentOrTask,
                success: info.success,
                transcript: info.finalOutput,
                files: info.modifiedFiles,
                totalFilesChanged: info.filesChanged,
                startedAt,
              });
            }
          } catch (err) { this.logger.debug({ err }, 'code-agent completion → project-manager failed'); }

          // v614 L3 — Workflow extraction for code_agent sessions (mirror of delegate path).
          // Previously only delegate-path triggered workflow extraction; code_agent runs were
          // ignored, which is why auto_extracted=0 in production despite many code-agent runs.
          // The extractor's pre-filter (>=2 distinct skills OR >=4 calls) means trivial
          // 1-skill code-agent runs still get skipped.
          if (info.success && (info.toolCalls ?? 0) > 0) {
            try {
              // We don't have full per-tool-call inputs from emitCompletion — just toolCalls count.
              // For now pass a synthetic reconstruction using agentOrTask as the only "call".
              // This is intentionally conservative; the extractor's pre-filter will likely
              // reject most code-agent sessions until we track full inputs (future work).
              const reconstructed = [
                { name: 'code_agent', input: { task: info.agentOrTask, cwd: info.cwd }, success: info.success },
              ];
              await proposeWorkflowFromSession({
                userId,
                goal: info.agentOrTask,
                toolCalls: reconstructed,
                sourceId: `code-agent-wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              });
            } catch (err) { this.logger.debug({ err }, 'code-agent workflow-extraction failed'); }
          }
        });
      }

      // T3 — Health Monitor (background task)
      if (this.config.projects?.healthCheckEnabled !== false) {
        const { HealthMonitor } = await import('./projects/health-monitor.js');
        const healthMonitor = new HealthMonitor(
          projectRepo,
          () => this.tryOwner(),
          this.logger.child({ component: 'project-health-monitor' }),
          {
            intervalHours: this.config.projects?.healthCheckIntervalHours,
            probeTimeoutMs: this.config.projects?.healthProbeTimeoutMs,
          },
          // v602 P1 — cluster-claim resolver: at cycle-fire time, ask the (late-init)
          // adapterClaimManager if this node holds the claim. Single-node SQLite gets
          // undefined here which falls back to "always run".
          () => this.adapterClaimManager,
        );

        // On degradation: enqueue a confirmation so the user can decide
        // whether to delegate a repair (e.g. via code-agent).
        healthMonitor.onStatusChange(async (event) => {
          if (!this.confirmationQueue) return;
          const ownerUid = this.tryOwner() ?? '';
          if (!ownerUid) return;
          const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
            : this.config.discord?.enabled ? 'discord'
            : this.config.whatsapp?.enabled ? 'whatsapp'
            : 'api');
          const suggestion = event.probe === 'build'
            ? `Build von Projekt "${event.project.name}" ist kaputt (${event.from} → ${event.to}). Code-Agent zur Reparatur starten?`
            : event.probe === 'deps'
            ? `Dependencies von "${event.project.name}" sind veraltet. Updates prüfen?`
            : event.probe === 'http'
            ? `Deploy-URL von "${event.project.name}" antwortet nicht mehr (${event.from} → ${event.to}). Prüfen?`
            : `Health-Probe "${event.probe}" für "${event.project.name}" hat sich verschlechtert (${event.from} → ${event.to}).`;
          try {
            await this.confirmationQueue.enqueue({
              chatId: this.config.security?.ownerUserId ?? '',
              platform: ownerPlatform,
              source: 'reasoning',
              sourceId: `project-health-${event.project.id}-${event.probe}-${Date.now()}`,
              description: suggestion,
              skillName: 'project',
              skillParams: { action: 'get', project_id: event.project.id },
              timeoutMinutes: 24 * 60,
            });
          } catch (err) { this.logger.debug({ err }, 'project-health confirmation enqueue failed'); }
        });

        healthMonitor.start();
        this.projectHealthMonitor = healthMonitor;
        this.logger.info({ intervalHours: this.config.projects?.healthCheckIntervalHours ?? 6 }, 'Project HealthMonitor started');
      }

      this.logger.info('Projects skill + manager enabled (T4 delegate + code-agent hooks active)');
    }

    // 4e2. Project agent (optional, requires code agents)
    if (this.config.projectAgents?.enabled && this.config.codeAgents?.agents) {
      const { ProjectAgentSkill, setInterjectionRepo } = await import('@alfred/skills');
      const { ProjectAgentSessionRepository, ProjectAgentInterjectionRepository } = await import('@alfred/storage');
      const projectSessionRepo = new ProjectAgentSessionRepository(adapter);
      setInterjectionRepo(new ProjectAgentInterjectionRepository(adapter));
      const projectAgentSkill = new ProjectAgentSkill(
        { ...this.config.projectAgents, agents: this.config.codeAgents.agents },
        llmProvider,
        projectSessionRepo,
      );

      // Wire the runner and connect it to the skill
      const { ProjectAgentRunner } = await import('./project-agent-runner.js');
      const projectRunner = new ProjectAgentRunner(
        new Map(this.config.codeAgents.agents.map(a => [a.name, a])),
        llmProvider,
        projectSessionRepo,
        this.adapters,
        this.logger.child({ component: 'project-agent' }),
        this.config.codeAgents.forge,
      );
      projectAgentSkill.setRunner(projectRunner);
      // v727 — Ref für späte SandboxRepo-Verdrahtung
      this.projectAgentSkillRef = projectAgentSkill;
      // v604 L8 — file-store is initialized later in init(), so we hold a ref
      // here and inject it once available.
      this.projectAgentRunnerRef = projectRunner;

      // v648 — Plans-Repo
      try {
        const { ProjectAgentPlansRepository } = await import('@alfred/storage');
        const plansRepo = new ProjectAgentPlansRepository(adapter);
        projectRunner.setPlansRepository(plansRepo);
        this.plansRepoRef = plansRepo;
      } catch (err) { this.logger.warn({ err }, 'Plans-Repo wiring failed (non-fatal)'); }

      // v652 — Lessons-Repo + Auto-Resume-Callback
      try {
        const { ProjectAgentLessonsRepository } = await import('@alfred/storage');
        const lessonsRepo = new ProjectAgentLessonsRepository(adapter);
        projectRunner.setLessonsRepository(lessonsRepo);
        projectRunner.setAutoResumeCallback(async (failedTaskId: string, notes?: string) => {
          try {
            const skill = this.skillRegistry?.get('project_agent');
            if (!skill) {
              this.logger.warn({ failedTaskId }, 'Auto-Resume: project_agent skill not registered');
              return;
            }
            const uid = this.tryOwner() ?? '';
            const ownerChatId = this.config.security?.ownerUserId ?? '';
            const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
              : this.config.matrix?.enabled ? 'matrix'
              : 'api');
            const ctx = { userId: uid, masterUserId: uid, chatId: ownerChatId, platform: ownerPlatform, conversationId: '' } as any;
            await skill.execute({ action: 'resume', failed_task_id: failedTaskId, notes }, ctx);
          } catch (err) {
            this.logger.warn({ err, failedTaskId }, 'Auto-Resume callback exec failed');
          }
        });
      } catch (err) { this.logger.warn({ err }, 'Lessons-Repo / Auto-Resume wiring failed (non-fatal)'); }

      // v643 — Commits-Repo + Project-Id-Resolver für Per-Phase-Commit-Persistence
      try {
        const { ProjectAgentCommitsRepository } = await import('@alfred/storage');
        const commitsRepo = new ProjectAgentCommitsRepository(adapter);
        const projectIdResolver = async (cwd: string): Promise<string | undefined> => {
          if (!this.projectRepo) return undefined;
          const uid = this.tryOwner();
          if (!uid) return undefined;
          try {
            const list = await this.projectRepo.list(uid);
            const proj = list.find(p => p.cwd === cwd) ?? list.find(p => p.cwd && cwd.startsWith(p.cwd));
            return proj?.id;
          } catch { return undefined; }
        };
        projectRunner.setCommitsRepository(commitsRepo, projectIdResolver);
        this.commitsRepoRef = commitsRepo;
        // v663a — Conventions-Resolver: cwd → Project.conventions
        projectRunner.setProjectConventionsResolver(async (cwd: string) => {
          if (!this.projectRepo) return undefined;
          const uid = this.tryOwner();
          if (!uid) return undefined;
          try {
            const list = await this.projectRepo.list(uid);
            const proj = list.find(p => p.cwd === cwd) ?? list.find(p => p.cwd && cwd.startsWith(p.cwd));
            return proj?.conventions;
          } catch { return undefined; }
        });

        // v665a — Cluster-Lock-Hooks: bei shared Projekten zwingend, bei local skip.
        // Routing-Reject: bei storage_type='local' + falsche node_id → Lock-Verweigerung mit Erklärung.
        const myNodeId = this.config.cluster?.nodeId ?? 'single';
        projectRunner.setProjectLockHooks(
          async (cwd: string, _sessionId: string) => {
            if (!this.projectRepo) return { acquired: true };
            const uid = this.tryOwner();
            if (!uid) return { acquired: true };
            try {
              const list = await this.projectRepo.list(uid);
              const proj = list.find(p => p.cwd === cwd) ?? list.find(p => p.cwd && cwd.startsWith(p.cwd));
              if (!proj) return { acquired: true }; // Projekt nicht persistent — no-op
              // Routing-Check: local Projekt auf anderer Node
              if (proj.storageType === 'local' && proj.nodeId && proj.nodeId !== myNodeId) {
                return { acquired: false, reason: `Projekt liegt lokal auf node "${proj.nodeId}" — diese Node ist "${myNodeId}". Bitte per project.move auf einen shared Mount verschieben.` };
              }
              // Lock-Acquire (für shared sowie multi-trigger-Safety auf local)
              const lock = await this.projectRepo.tryLock(proj.id, myNodeId, 180);
              if (!lock.acquired) {
                return { acquired: false, reason: `Lock gehalten von node "${lock.holderNodeId}" bis ${lock.holderUntil ?? '?'}` };
              }
              return { acquired: true };
            } catch { return { acquired: true }; }
          },
          async (cwd: string, _sessionId: string) => {
            if (!this.projectRepo) return;
            const uid = this.tryOwner();
            if (!uid) return;
            try {
              const list = await this.projectRepo.list(uid);
              const proj = list.find(p => p.cwd === cwd) ?? list.find(p => p.cwd && cwd.startsWith(p.cwd));
              if (proj) await this.projectRepo.releaseLock(proj.id, myNodeId);
            } catch { /* skip */ }
          },
        );
      } catch (err) { this.logger.warn({ err }, 'Commits-Repo wiring failed (non-fatal)'); }

      // v642 — LLM-Callback für deep audit der project-skill
      if (this.projectSkillRef && this.llmProvider) {
        this.projectSkillRef.setLlmCallback(async (prompt: string, tier?: string) => {
          const res = await this.llmProvider!.complete({
            messages: [{ role: 'user', content: prompt }],
            tier: (tier as any) ?? 'default',
            maxTokens: 3000,
          });
          return res.content;
        });
      }

      // v641 — wire ProjectSkill.setProjectAgentStarter so `project work_on_open_items`
      // kann den Project-Agent direkt starten ohne LLM-Round-Trip.
      if (this.projectSkillRef) {
        this.projectSkillRef.setProjectAgentStarter(async ({ cwd, goal, projectId }) => {
          const ownerChatId = this.config.security?.ownerUserId ?? '';
          const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
            : this.config.matrix?.enabled ? 'matrix'
            : this.config.discord?.enabled ? 'discord'
            : 'api');
          const ctx = { userId: this.ownerMasterUserId ?? ownerChatId, masterUserId: this.ownerMasterUserId ?? ownerChatId, chatId: ownerChatId, platform: ownerPlatform, conversationId: '' } as unknown as import('@alfred/types').SkillContext;
          const result = await projectAgentSkill.execute({ action: 'start', goal, cwd }, ctx);
          if (!result.success) throw new Error(result.error ?? 'project-agent start failed');
          const taskId = (result.data as any)?.taskId as string;
          if (!taskId) throw new Error('no taskId returned');
          void projectId;
          return { taskId };
        });
      }

      // v615 M1 — Wire project-lookup so startProject can reject a cwd that
      // conflicts with an existing project's known workspace. ProjectRepo is
      // set later in init(); we pass `this` as ref-holder and the skill
      // re-reads it at call time. ownerMasterUserId is resolved similarly.
      if (this.projectRepo) {
        projectAgentSkill.setProjectLookup(this.projectRepo, this.tryOwner());
      } else {
        // Late binding: set once the ProjectRepository exists. We do this from
        // the same init phase that constructs projectRepo (see further below).
        // For now register an empty ref so the skill doesn't crash.
      }

      // On every project-agent completion (success OR failure): hand the session over to
      // the ProjectManager so it auto-binds to a long-lived Project, runs the LLM
      // summarizer, and persists open items + decisions. This is what gives Alfred
      // post-session awareness ("what happened in project X, what's still open").
      projectRunner.setCompletionCallback(async (sessionId, cfg, state, success) => {
        // v721 — Sandbox→Project Resolution: wenn diese Session aus einem Interactive-Sandbox-Chat
        // gestartet wurde (worktree-cwd), zum Original-Project umrouten damit das Ghost-Project
        // mit dem Worktree-Pfad als cwd vermieden wird. Best-effort — Resolution-Fehler darf den
        // Completion-Flow nicht abbrechen.
        let resolvedCwd = cfg.cwd;
        let resolvedProjectId: string | undefined;
        let resolvedSandboxId: string | undefined; // v812 — Sandbox-Origin-Marker für pending/suppress
        try {
          const adapter = this.database?.getAdapter();
          if (adapter) {
            const sessRow = await adapter.queryOne(
              `SELECT sandbox_id FROM project_agent_sessions WHERE task_id = ?`,
              [sessionId],
            ).catch(() => null) as { sandbox_id?: string } | null;
            const sandboxId = sessRow?.sandbox_id;
            resolvedSandboxId = sandboxId ?? undefined;
            if (sandboxId) {
              const sbRow = await adapter.queryOne(
                `SELECT project_id FROM project_agent_sandboxes WHERE id = ?`,
                [sandboxId],
              ).catch(() => null) as { project_id?: string } | null;
              if (sbRow?.project_id && this.projectRepo) {
                // v803 — getByIdAnyOwner statt getById: ownerMasterUserId/ownerUserId können
                // Telegram-IDs (5060785419) sein, aber project.user_id ist UUID (z.B. f165df7a).
                // getById mit user-filter scheitert dann → resolvedProjectId bleibt undefined
                // → finishSession ohne projectId → findOrCreate fällt zurück auf cwd-Heuristik
                // → ORPHAN-Projekt mit worktree-name. v800 hatte das nur in findOrCreate gefixt;
                // hier in der v721-resolution ist die gleiche Quelle.
                const proj = await this.projectRepo.getByIdAnyOwner(sbRow.project_id).catch(() => null);
                if (proj?.cwd) {
                  resolvedCwd = proj.cwd;
                  resolvedProjectId = proj.id;
                  this.logger.debug({ sessionId, sandboxId, projectId: proj.id, originalCwd: cfg.cwd, resolvedCwd }, 'v721/v803 sandbox→project resolved');
                }
              }
            }
          }
        } catch (err) {
          this.logger.debug({ err, sessionId }, 'v721 sandbox→project resolution failed (continuing with worktree cwd)');
        }

        // v615 M3 (L6) — Auto-Memory der Workspace-Info bei JEDEM Project-Agent-Lauf
        // (success ODER failure). Dual zu v609 V2 deploy-Memory: speichert wo gearbeitet
        // wurde, damit der nächste "weiter am Projekt X"-Request den richtigen cwd
        // findet. Best-effort — Memory-Fehler bricht den Completion-Flow nicht ab.
        // v812 — Bei Sandbox-Runs NICHT speichern: resolvedCwd wäre zwar das Projekt,
        // aber die Arbeit ist erst bei Merge angewendet — Workspace-Memory wird dann
        // im onMergeApplied-Callback gesetzt. Vor Merge kein "applied"-Signal.
        if (this.memoryRepo && resolvedCwd && !resolvedSandboxId) {
          try {
            const userId = this.tryOwner() ?? '';
            const projectName = (resolvedCwd ?? '').replace(/\/+$/, '').split('/').filter(Boolean).pop();
            if (userId && projectName) {
              const safeKey = `project_workspace_${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
              const latestSession = await this.database?.getAdapter().queryOne(
                `SELECT last_commit_sha, last_build_passed FROM project_agent_sessions WHERE task_id = ?`,
                [sessionId],
              ).catch(() => null) as { last_commit_sha?: string; last_build_passed?: number } | null;
              const parts = [
                `Dev-Workspace für Projekt "${projectName}": ${resolvedCwd} (lokal auf Alfred-Node)`,
                `last_run=${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
                `phases=${state.projectIteration}`,
                `files_changed=${state.totalFilesChanged}`,
                `build_passed=${success ? 'yes' : 'no'}`,
              ];
              if (latestSession?.last_commit_sha) parts.push(`last_commit=${latestSession.last_commit_sha.slice(0, 8)}`);
              parts.push(`HINWEIS: Das ist der LOKALE Workspace zum Entwickeln, NICHT der Deploy-Target-Pfad`);
              // v689 — system-managed Key, override Guards (siehe upsertSystemMemory)
              const upsertWS = (this.memoryRepo as { upsertSystemMemory?: (uid: string, k: string, v: string, c: string, t?: string, conf?: number) => Promise<unknown> }).upsertSystemMemory;
              if (upsertWS) await upsertWS.call(this.memoryRepo, userId, safeKey, parts.join(', '), 'workspace', 'fact', 0.95);
              else await this.memoryRepo.saveWithMetadata(userId, safeKey, parts.join(', '), 'workspace', 'fact', 0.95, 'auto');
            }
          } catch (err) { this.logger.debug({ err }, 'project-agent workspace-memory auto-save failed'); }
        }

        if (this.projectManager) {
          try {
            const userId = this.tryOwner() ?? '';
            if (userId) {
              // v668/v686 — echte Startzeit aus project_agent_sessions lesen damit
              // Arbeitszeit-Statistik die Agent-Laufzeit zeigt (nicht nur die
              // Summary-Erstellung). v686-Fix: das Feld heißt `created_at` nicht
              // `started_at` — die alte Query throw'd silent, fallback war now().
              let startedAt: string | undefined;
              try {
                const row = await this.database?.getAdapter().queryOne(
                  `SELECT created_at FROM project_agent_sessions WHERE task_id = ?`,
                  [sessionId],
                ) as { created_at?: string } | null;
                if (row?.created_at) startedAt = row.created_at;
              } catch (err) {
                this.logger.debug({ err, sessionId }, 'project_agent_sessions created_at lookup failed');
              }
              await this.projectManager.finishSession({
                userId,
                sessionType: 'project_agent',
                sourceId: sessionId,
                goal: cfg.goal,
                // v721 — resolvedCwd zeigt bei Sandbox-Sessions auf das Original-Project (statt worktree)
                cwd: resolvedCwd,
                // v798 — explicit projectId (verhindert orphan-Creation auch wenn resolvedCwd nicht matched)
                projectId: resolvedProjectId,
                milestones: state.milestonesReached,
                totalFilesChanged: state.totalFilesChanged,
                success,
                startedAt,
                // v812 — Sandbox-Run → 'pending' (erst bei Merge in die Historie). Analytik
                // (Arbeitszeit/Agent) zählt trotzdem. Klassischer Run → undefined = 'applied'.
                mergeState: resolvedSandboxId ? 'pending' : undefined,
                sandboxId: resolvedSandboxId,
              });
            }
          } catch (err) { this.logger.debug({ err }, 'project-manager finishSession failed'); }
        }

        // v686 — A) Telegram-DM bei Completion (egal welcher Trigger-Channel),
        // damit der User nicht in die Project-Agents-Page wechseln muss um den Status zu sehen.
        // Nur bei Telegram-konfiguriertem Owner; Erfolg + Fehler.
        if (this.adapters && this.config.security?.ownerUserId) {
          try {
            const tg = this.adapters.get('telegram');
            const owner = this.config.security.ownerUserId;
            if (tg && 'sendDirectMessage' in tg) {
              const projectName = (resolvedCwd ?? '').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'Projekt';
              const milestonesText = state.milestonesReached.length > 0
                ? `\nMilestones: ${state.milestonesReached.slice(0, 5).join(', ')}`
                : '';
              const msg = success
                ? `🎉 Project-Agent fertig — *${projectName}*\n${state.projectIteration} Phasen, ${state.totalFilesChanged} Files geändert.${milestonesText}\n\nTask-ID: \`${sessionId.slice(0, 8)}\``
                : `❌ Project-Agent fehlgeschlagen — *${projectName}*\n${state.projectIteration} Phasen versucht, ${state.totalFilesChanged} Files geändert.\n\nTask-ID: \`${sessionId.slice(0, 8)}\``;
              await (tg as { sendDirectMessage(userId: string, text: string, opts?: { parseMode?: string }): Promise<unknown> })
                .sendDirectMessage(owner, msg, { parseMode: 'markdown' });
            }
          } catch (tgErr) { this.logger.debug({ tgErr }, 'project-agent completion Telegram-DM failed'); }
        }

        // v686 — B) Completion-Message in die Project-Chat-Conversation persistieren.
        // Damit beim nächsten Öffnen des Project-Chats die History den Run-Abschluss zeigt.
        if (this.conversationRepo && resolvedCwd && this.projectRepo) {
          try {
            const userId = this.tryOwner() ?? '';
            if (userId) {
              // v721/v804 — Direkt-Match via resolvedProjectId. getByIdAnyOwner für
              // System-internal lookup (sandbox-completion-callback ist owner-agnostisch).
              let proj = resolvedProjectId
                ? await this.projectRepo.getByIdAnyOwner(resolvedProjectId).catch(() => null)
                : null;
              if (!proj) {
                const projects = await this.projectRepo.list(userId);
                proj = projects.find(p => p.cwd === resolvedCwd) ?? projects.find(p => p.cwd && resolvedCwd?.startsWith(p.cwd)) ?? null;
              }
              if (proj) {
                // v804 — Conversation wird unter dem Project-Owner angelegt (nicht
                // unter ownerMasterUserId — die könnten verschieden sein im Multi-User-Setup).
                const projOwnerId = proj.userId ?? userId;
                const conv = await this.conversationRepo.findOrCreateForProject(projOwnerId, proj.id);
                // v812 — Sandbox-Runs sind noch NICHT im Projekt (erst bei Merge). Klar
                // kennzeichnen statt "✅ fertig" das fälschlich "im Projekt" suggeriert.
                const summary = !success
                  ? `❌ **Project-Agent fehlgeschlagen**\n\n` +
                    `- Phasen versucht: ${state.projectIteration}\n` +
                    `- Geänderte Dateien: ${state.totalFilesChanged}\n` +
                    `- Task-ID: \`${sessionId.slice(0, 8)}\``
                  : resolvedSandboxId
                    ? `🧪 **Sandbox-Plan fertig — Review & Merge ausstehend**\n\n` +
                      `- Phasen: ${state.projectIteration}\n` +
                      `- Geänderte Dateien: ${state.totalFilesChanged} (im Sandbox-Branch, noch NICHT im Projekt)\n` +
                      (state.milestonesReached.length > 0 ? `- Milestones: ${state.milestonesReached.slice(0, 5).join(', ')}\n` : '') +
                      `- Im Sandbox-Chat reviewen, dann **Merge** (übernehmen) oder **Discard** (verwerfen).\n` +
                      `- Task-ID: \`${sessionId.slice(0, 8)}\``
                    : `✅ **Project-Agent fertig**\n\n` +
                      `- Phasen: ${state.projectIteration}\n` +
                      `- Geänderte Dateien: ${state.totalFilesChanged}\n` +
                      (state.milestonesReached.length > 0 ? `- Milestones: ${state.milestonesReached.slice(0, 5).join(', ')}\n` : '') +
                      `- Task-ID: \`${sessionId.slice(0, 8)}\``;
                await this.conversationRepo.addMessage(conv.id, 'assistant', summary);
              }
            }
          } catch (convErr) { this.logger.debug({ convErr }, 'project-agent completion Project-Chat persist failed'); }
        }

        // v643 — Repo-URL + Default-Branch auto-detect aus cwd
        if (this.projectRepo && resolvedCwd) {
          try {
            const userId = this.tryOwner() ?? '';
            if (userId) {
              const { execFile } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const exec = promisify(execFile);
              // v721/v804 — getByIdAnyOwner für system-internal sandbox→project lookup.
              let proj = resolvedProjectId
                ? await this.projectRepo.getByIdAnyOwner(resolvedProjectId).catch(() => null)
                : null;
              if (!proj) {
                const projects = await this.projectRepo.list(userId);
                proj = projects.find(p => p.cwd === resolvedCwd) ?? projects.find(p => p.cwd && resolvedCwd?.startsWith(p.cwd)) ?? null;
              }
              if (proj) {
                const patch: { repoUrl?: string; defaultBranch?: string } = {};
                if (!proj.repoUrl) {
                  try {
                    const { stdout } = await exec('git', ['-C', cfg.cwd, 'remote', 'get-url', 'origin'], { timeout: 5000 });
                    const url = stdout.trim();
                    if (url) patch.repoUrl = url.replace(/^https?:\/\/[^@/]+@/, 'https://'); // strip embedded creds
                  } catch { /* no remote */ }
                }
                if (!proj.defaultBranch) {
                  try {
                    const { stdout } = await exec('git', ['-C', cfg.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 });
                    const branch = stdout.trim();
                    if (branch && branch !== 'HEAD') patch.defaultBranch = branch;
                  } catch { /* skip */ }
                }
                if (Object.keys(patch).length > 0) {
                  await this.projectRepo.update(userId, proj.id, patch);
                  this.logger.debug({ projectId: proj.id, patch }, 'Project: repo-url/branch auto-detected');
                }
              }
            }
          } catch (err) { this.logger.debug({ err }, 'Project repo-url auto-detect failed (non-fatal)'); }
        }

        // v731 — Auto-Done-Mark für explizit user-referenzierte Items aus der Sandbox-Chat-Message.
        // Wenn der User per 📋-Picker Items zur Chat-Message gehängt hat und der Agent erfolgreich
        // beendet hat, gelten diese Items als implementiert → Status 'done'. Konservativer als
        // OpenItemMatcher weil hier User-Intention explizit war.
        // v812 — Bei Sandbox-Runs aufgeschoben bis Merge (mutiert bestehende Projekt-Items;
        // bei Discard wäre das nicht rückgängig zu machen). Läuft dann in onMergeApplied.
        if (success && this.projectRepo && !resolvedSandboxId) {
          try {
            const sessRow = await this.database?.getAdapter().queryOne(
              `SELECT mentioned_item_ids FROM project_agent_sessions WHERE task_id = ?`,
              [sessionId],
            ).catch(() => null) as { mentioned_item_ids?: string | null } | null;
            const raw = sessRow?.mentioned_item_ids;
            if (raw) {
              let ids: string[] = [];
              try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) ids = parsed.filter((x: unknown): x is string => typeof x === 'string'); } catch { /* */ }
              let updated = 0;
              for (const id of ids) {
                try {
                  await this.projectRepo.updateOpenItemStatus(id, 'done');
                  updated++;
                } catch (err) {
                  this.logger.debug({ err, itemId: id }, 'v731 mentioned item auto-done failed (might be decision, not open-item)');
                }
              }
              if (updated > 0) {
                this.logger.info({ sessionId, updated, total: ids.length }, 'v731 auto-marked mentioned items as done');
              }
            }
          } catch (err) {
            this.logger.debug({ err, sessionId }, 'v731 auto-done-mark failed (non-fatal)');
          }
        }

        // v641 — OpenItemMatcher: nach erfolgreichem Lauf prüfen welche der bestehenden
        // open Items des Projekts durch die Milestones+Files erledigt wurden. LLM-Pass
        // mit konservativer Confidence (≥0.6 → auto-done, sonst nur markieren).
        // v812 — Bei Sandbox-Runs aufgeschoben bis Merge: dieser Matcher mutiert
        // BESTEHENDE Projekt-Items auf 'done'. Bei Discard wäre das schwer rückgängig.
        // Läuft daher erst in onMergeApplied gegen den gemergten Diff.
        if (success && this.projectRepo && this.llmProvider && !resolvedSandboxId) {
          try {
            const userId = this.tryOwner() ?? '';
            if (userId) {
              // Find project for this cwd (project-manager.finishSession attached it via cwd)
              // v721 — Direkt-Match via resolvedProjectId wenn Sandbox-Resolution erfolgt ist
              const projects = await this.projectRepo.list(userId);
              const proj = resolvedProjectId
                ? projects.find(p => p.id === resolvedProjectId)
                : (projects.find(p => p.cwd === resolvedCwd) ?? projects.find(p => resolvedCwd?.includes(p.cwd ?? '')));
              if (proj) {
                const { OpenItemMatcher } = await import('./projects/open-item-matcher.js');
                const matcher = new OpenItemMatcher(this.projectRepo, this.llmProvider, this.logger.child({ component: 'open-item-matcher' }), { service: embeddingService, repo: embeddingRepo });
                // Best-effort fetch changed files from the latest session row
                let changedFiles: string[] = [];
                try {
                  const sessRow = await this.database?.getAdapter().queryOne(
                    `SELECT total_files_changed FROM project_agent_sessions WHERE task_id = ?`,
                    [sessionId],
                  );
                  void sessRow;
                } catch { /* skip */ }
                const matchResult = await matcher.matchAfterSession({
                  projectId: proj.id,
                  sessionId,
                  goal: cfg.goal,
                  milestones: state.milestonesReached,
                  changedFiles,
                  totalFilesChanged: state.totalFilesChanged,
                });
                // v818 P3 — UI-Feedback: bei resolved > 0 einen kurzen Chat-Eintrag
                // im Project-Chat damit der User SIEHT was auto-resolved wurde.
                // Vorher: silent. Bedingung: matched > 0 (LLM hat überhaupt geantwortet)
                // damit kein leerer "0 resolved"-Hinweis bei kompletten Silent-Failures.
                if (matchResult.resolved > 0 && this.conversationRepo) {
                  try {
                    const projOwnerId = proj.userId ?? userId;
                    const conv = await this.conversationRepo.findOrCreateForProject(projOwnerId, proj.id);
                    await this.conversationRepo.addMessage(conv.id, 'assistant',
                      `🤖 **OpenItemMatcher**: ${matchResult.resolved} offene Punkt(e) automatisch als erledigt markiert (von ${matchResult.matched} analysiert).`);
                  } catch { /* non-fatal */ }
                }
              }
            }
          } catch (err) { this.logger.debug({ err, sessionId }, 'OpenItemMatcher failed (non-fatal)'); }
        }

        // v705 — Explizit zugewiesene Open-Items (via implementMilestone / workOnOpenItems)
        // auflösen oder zurücksetzen, unabhängig vom LLM-Matcher.
        // Marker: auto_resolved_by = `implementing:${taskId}` (während Lauf)
        //   → success: auto_resolved_by = `implemented:${taskId}` + status='done' + confidence=0.8
        //   → failure: status='open', auto_resolved_by=NULL
        if (this.projectRepo) {
          try {
            if (success) {
              const resolved = await this.projectRepo.resolveItemsForSession(sessionId, 0.8);
              if (resolved > 0) this.logger.info({ sessionId, resolved }, 'v705 implementMilestone-Items als done markiert');
            } else {
              const reverted = await this.projectRepo.revertItemsForSession(sessionId);
              if (reverted > 0) this.logger.info({ sessionId, reverted }, 'v705 implementMilestone-Items auf open zurückgesetzt (Session fehlgeschlagen)');
            }
          } catch (err) { this.logger.debug({ err, sessionId }, 'v705 resolve/revert items failed (non-fatal)'); }
        }

        // v610 G5 — On failure, neither runbook nor deploy proposal makes sense.
        // We keep the runbook gated additionally by milestone-count, but the
        // deploy-suggestion does NOT need many milestones — just a green build.
        if (!success) return;

        // Trigger B (existing): with ≥3 milestones, propose a runbook.
        if (state.milestonesReached.length >= 3 && this.runbookRepo && this.confirmationQueue) {
        try {
          const userId = this.tryOwner() ?? '';
          if (!userId) { /* skip runbook */ } else {
          // Avoid duplicate suggestion if a runbook already exists for this session
          const existing = await this.runbookRepo.findBySource(userId, 'project_agent', sessionId);
          if (existing) { /* skip runbook */ } else {
          const ownerPlatformForRb = (this.config.telegram?.enabled ? 'telegram'
            : this.config.discord?.enabled ? 'discord'
            : this.config.whatsapp?.enabled ? 'whatsapp'
            : 'api');
          // v607 D6 — short LLM-generated runbook title instead of goal.slice(0, 100)
          // which produced things like "Projekt: Starte einen NEUEN Projekt-Agent-Lauf..."
          let rbTitle = `Projekt: ${cfg.goal.slice(0, 100)}`;
          try {
            const summaryResp = await llmProvider.complete({
              messages: [{ role: 'user', content:
                `Fasse das folgende Projekt-Ziel in einem klaren, prägnanten Titel zusammen (max 60 Zeichen, ohne Quotes, ohne "Projekt:" Prefix, ohne "Starte einen ..." Boilerplate). Antworte NUR mit dem Titel.\n\nZiel:\n${cfg.goal.slice(0, 600)}` }],
              tier: 'fast', maxTokens: 30, temperature: 0.1,
            });
            const cleaned = summaryResp.content.trim().replace(/^["'"„""]|["'"„""]$/g, '').slice(0, 60);
            if (cleaned.length >= 8) rbTitle = cleaned;
          } catch { /* fallback to raw slice */ }
          await this.confirmationQueue.enqueue({
            chatId: this.config.security?.ownerUserId ?? '',
            platform: ownerPlatformForRb,
            source: 'reasoning',
            sourceId: `runbook-from-project-${sessionId.slice(0, 8)}`,
            description: `Runbook aus Project-Agent-Session erstellen: "${rbTitle}"?`,
            skillName: 'runbook',
            skillParams: {
              action: 'create',
              title: rbTitle,
              symptom: `Initialer Goal: ${cfg.goal}`,
              steps: state.milestonesReached,
              source_type: 'project_agent',
              source_id: sessionId,
              status: 'draft',
              tags: ['project-agent', 'auto'],
            },
            timeoutMinutes: 24 * 60,
          });
          this.logger.info({ sessionId, milestones: state.milestonesReached.length, title: rbTitle }, 'Project-agent runbook suggestion enqueued');
          }}
        } catch (err) { this.logger.debug({ err }, 'Runbook suggestion (project-agent) failed'); }
        }

        // v610 G5 — Auto-Deploy-Suggestion: if the project just completed
        // a successful build AND we have a remembered deploy-target for the
        // same project (from v609 V2 auto-memory), propose redeploying.
        // Without this the user has to manually re-state host/port/user/pm
        // every time after a project-agent run. The suggestion is opt-in via
        // the existing ConfirmationQueue, so the user keeps full control.
        if (success && this.memoryRepo && this.confirmationQueue) {
          try {
            const userId = this.tryOwner() ?? '';
            if (!userId) return;
            // v721 — resolvedCwd zeigt bei Sandbox-Sessions auf das Original-Project
            const projectName = (resolvedCwd ?? '').replace(/\/+$/, '').split('/').filter(Boolean).pop();
            if (!projectName) return;
            // Find latest deploy memory for this project
            const memHits = await this.memoryRepo.search(userId, `deploy_${projectName}_`);
            // Filter to deployment-category memories only and keep the most recent
            const deployMems = memHits.filter(m =>
              m.category === 'deployment' && m.key.startsWith(`deploy_${projectName}_`),
            ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const lastDeploy = deployMems[0];
            if (!lastDeploy) return;
            // Parse host/user/port/pm from the structured value string.
            // Format (from deploy.ts): "Deployed X → HOST (user=U, runtime=R, pm=P, port=N, ...)"
            const v = lastDeploy.value;
            const hostMatch = v.match(/→\s*([\w.-]+)\s*\(/);
            const userMatch = v.match(/user=([^,)]+)/);
            const portMatch = v.match(/port=(\d+)/);
            const pmMatch = v.match(/pm=([^,)]+)/);
            const runtimeMatch = v.match(/runtime=([^,)]+)/);
            if (!hostMatch) return;
            const host = hostMatch[1];
            const deployUser = userMatch?.[1] ?? 'root';
            const port = portMatch ? Number(portMatch[1]) : undefined;
            const pm = pmMatch?.[1];
            const runtime = runtimeMatch?.[1];
            // Avoid stacking suggestions for the same session
            const dedupSourceId = `auto-deploy-from-project-${sessionId.slice(0, 8)}`;
            const ownerPlatformForDp = (this.config.telegram?.enabled ? 'telegram'
              : this.config.discord?.enabled ? 'discord'
              : this.config.whatsapp?.enabled ? 'whatsapp'
              : 'api');
            const skillParams: Record<string, unknown> = {
              action: 'deploy',
              host,
              user: deployUser,
              project: projectName,
            };
            if (port !== undefined) skillParams.app_port = port;
            if (pm) skillParams.process_manager = pm;
            if (runtime) skillParams.runtime = runtime;
            await this.confirmationQueue.enqueue({
              chatId: this.config.security?.ownerUserId ?? '',
              platform: ownerPlatformForDp,
              source: 'reasoning',
              sourceId: dedupSourceId,
              description: `Project Agent fertig — auch nach \`${host}\`${port ? `:${port}` : ''} (user \`${deployUser}\`${pm ? `, pm ${pm}` : ''}) deployen wie letztes Mal?`,
              skillName: 'deploy',
              skillParams,
              timeoutMinutes: 60,
            });
            this.logger.info({ sessionId, host, projectName, port }, 'Project-agent auto-deploy suggestion enqueued');
          } catch (err) { this.logger.debug({ err }, 'Auto-deploy suggestion (project-agent) failed'); }
        }
      });

      skillRegistry.register(projectAgentSkill);
      this.logger.info('Project agent skill enabled');
    }

    // 4f. Proxmox (optional)
    if (this.config.proxmox) {
      const { ProxmoxSkill } = await import('@alfred/skills');
      const pxSkill = new ProxmoxSkill(this.config.proxmox);
      const sshKeyPath = this.config.infra?.sshKeyPath ?? `${process.env['HOME'] ?? '/root'}/.ssh/id_ed25519`;
      pxSkill.setSshKeyPath(sshKeyPath);
      pxSkill.setSshUser(this.config.infra?.sshUser ?? 'root');

      // Post-provision callback: SSH wait + runtime install after clone_vm with runtime parameter
      pxSkill.setPostProvisionCallback(async (host: string, user: string, runtime: string, isRhel: boolean, opts?: { dockerBridgeIp?: string }) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const steps: string[] = [];

        const runSsh = async (cmd: string) => {
          const { stdout } = await execFileAsync('ssh', [
            '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10',
            `${user}@${host}`, cmd,
          ], { maxBuffer: 5 * 1024 * 1024, timeout: 300_000 });
          return stdout.trim();
        };

        // Wait for SSH (Cloud-Init needs 60-120s)
        steps.push('⏳ Warte auf SSH + Cloud-Init...');
        let sshReady = false;
        const startTime = Date.now();
        await new Promise(r => setTimeout(r, 20_000)); // initial boot wait
        while (Date.now() - startTime < 180_000) {
          try { await runSsh('echo ok'); sshReady = true; break; } catch { /* retry */ }
          await new Promise(r => setTimeout(r, 15_000));
        }
        if (!sshReady) {
          steps.push(`❌ SSH nicht erreichbar nach ${Math.round((Date.now() - startTime) / 1000)}s`);
          return steps;
        }
        steps.push(`✅ SSH erreichbar nach ${Math.round((Date.now() - startTime) / 1000)}s`);

        // Install runtime
        try {
          if (runtime === 'docker') {
            await runSsh('curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER');
            if (isRhel) {
              await runSsh('sudo dnf install -y docker-compose-plugin').catch(() => {});
            } else {
              await runSsh('sudo apt-get install -y docker-compose-plugin || sudo apt-get install -y docker-compose').catch(() => {});
            }
            steps.push('🐳 Docker + Docker Compose installiert');
            // Configure Docker Bridge IP if specified
            if (opts?.dockerBridgeIp) {
              try {
                await runSsh(`echo '{"bip":"${opts.dockerBridgeIp}"}' | sudo tee /etc/docker/daemon.json && sudo systemctl restart docker`);
                steps.push(`🌐 Docker Bridge: ${opts.dockerBridgeIp}`);
              } catch { steps.push('⚠️ Docker Bridge IP Konfiguration fehlgeschlagen'); }
            }
          } else if (runtime === 'node') {
            if (isRhel) {
              await runSsh('curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs && sudo npm install -g pm2');
            } else {
              await runSsh('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs && sudo npm install -g pm2 && sudo pm2 startup systemd -u $USER --hp /home/$USER');
            }
            steps.push('📦 Node.js + pm2 installiert');
          } else if (runtime === 'python') {
            if (isRhel) {
              await runSsh('sudo dnf install -y python3 python3-pip');
            } else {
              await runSsh('sudo apt-get update && sudo apt-get install -y python3 python3-pip python3-venv');
            }
            steps.push('🐍 Python installiert');
          }
        } catch (err: any) {
          steps.push(`⚠️ Runtime-Installation: ${err.message?.slice(0, 100)}`);
        }

        // qemu-guest-agent
        try {
          if (isRhel) {
            await runSsh('sudo dnf install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent');
          } else {
            await runSsh('sudo apt-get install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent');
          }
          steps.push('📡 qemu-guest-agent installiert');
        } catch { steps.push('⚠️ qemu-guest-agent Installation fehlgeschlagen'); }

        // docker group
        try { await runSsh('id -nG | grep -q docker || sudo usermod -aG docker $USER 2>/dev/null'); } catch { /* ok */ }

        return steps;
      });

      skillRegistry.register(pxSkill);
      this.logger.info({ baseUrl: this.config.proxmox.baseUrl, sshKeyPath }, 'Proxmox skill enabled');
    }

    // 4g. UniFi (optional)
    if (this.config.unifi) {
      const { UniFiSkill } = await import('@alfred/skills');
      skillRegistry.register(new UniFiSkill(this.config.unifi));
      this.logger.info({ baseUrl: this.config.unifi.baseUrl }, 'UniFi skill enabled');
    }

    // 4h. Home Assistant (optional)
    if (this.config.homeassistant) {
      const { HomeAssistantSkill } = await import('@alfred/skills');
      skillRegistry.register(new HomeAssistantSkill(this.config.homeassistant));
      this.logger.info({ baseUrl: this.config.homeassistant.baseUrl }, 'Home Assistant skill enabled');
    }

    // 4i. Contacts (optional)
    if (this.config.contacts) {
      try {
        const { ContactsSkill, createContactsProvider } = await import('@alfred/skills');
        const contactsProvider = await createContactsProvider(this.config.contacts);
        skillRegistry.register(new ContactsSkill(contactsProvider));
        this.logger.info({ provider: this.config.contacts.provider }, 'Contacts skill enabled');
      } catch (err) {
        this.logger.warn({ err }, 'Contacts initialization failed, continuing without contacts');
      }
    }

    // 4j. Docker (optional — auto-detect socket if no explicit config)
    if (this.config.docker) {
      const { DockerSkill } = await import('@alfred/skills');
      skillRegistry.register(new DockerSkill(this.config.docker));
      this.logger.info('Docker skill enabled');
    }

    // 4k. BMW CarData (optional)
    if (this.config.bmw) {
      const { BMWSkill } = await import('@alfred/skills');
      this.bmwSkill = new BMWSkill(this.config.bmw);
      skillRegistry.register(this.bmwSkill);
      this.logger.info('BMW CarData skill enabled');
    }

    // 4l. go-e Charger (optional)
    if (this.config.goeCharger?.host) {
      const { GoeChargerSkill } = await import('@alfred/skills');
      skillRegistry.register(new GoeChargerSkill(this.config.goeCharger, this.config.energy));
      this.logger.info({ host: this.config.goeCharger.host }, 'go-e Charger skill registered');
    }

    // 4m. Routing (optional)
    if (this.config.routing) {
      const { RoutingSkill } = await import('@alfred/skills');
      skillRegistry.register(new RoutingSkill(this.config.routing));
      this.logger.info('Routing skill enabled');
    }

    // 4m. Microsoft To Do (optional)
    if (this.config.todo) {
      const { MicrosoftTodoSkill } = await import('@alfred/skills');
      skillRegistry.register(new MicrosoftTodoSkill(this.config.todo));
      this.logger.info('Microsoft To Do skill enabled');
    }

    // OneDrive (uses same MS Graph token as Microsoft Todo)
    if (this.config.todo) {
      const { OneDriveSkill } = await import('@alfred/skills');
      skillRegistry.register(new OneDriveSkill(this.config.todo));
      this.logger.info('OneDrive skill registered');
    }

    // 4n. Infrastructure Monitor (auto-enabled when any infra skill is configured)
    if (this.config.proxmox || this.config.unifi || this.config.homeassistant || this.config.proxmoxBackup) {
      const { MonitorSkill } = await import('@alfred/skills');
      skillRegistry.register(new MonitorSkill({
        proxmox: this.config.proxmox,
        unifi: this.config.unifi,
        homeassistant: this.config.homeassistant,
        proxmoxBackup: this.config.proxmoxBackup,
      }));
      this.logger.info('Infrastructure monitor skill enabled');
    }

    // 4o. Energy price / aWATTar (always available, config optional for grid costs)
    {
      const { EnergyPriceSkill } = await import('@alfred/skills');
      skillRegistry.register(new EnergyPriceSkill(this.config.energy));
      this.logger.info({ grid: this.config.energy?.gridName }, 'Energy price skill registered');
    }

    // 4p2. Crypto price (CoinGecko — always available, no API key needed)
    {
      const { CryptoPriceSkill } = await import('@alfred/skills');
      skillRegistry.register(new CryptoPriceSkill());
      this.logger.info('Crypto price skill registered');
    }

    // 4p3. Bitpanda (portfolio — always registered, API key optional for ticker)
    {
      const { BitpandaSkill } = await import('@alfred/skills');
      skillRegistry.register(new BitpandaSkill(this.config.bitpanda));
      this.logger.info({ hasApiKey: !!this.config.bitpanda?.apiKey }, 'Bitpanda skill registered');
    }

    // 4p4. Trading / CCXT (exchange trading — registered if exchanges configured)
    if (this.config.trading?.exchanges && Object.keys(this.config.trading.exchanges).length > 0) {
      const { TradingSkill } = await import('@alfred/skills');
      skillRegistry.register(new TradingSkill(this.config.trading));
      this.logger.info({ exchanges: Object.keys(this.config.trading.exchanges) }, 'Trading skill registered');
    }

    // Recipe
    {
      const { RecipeSkill } = await import('@alfred/skills');
      const { RecipeFavoriteRepository, MealPlanRepository, AlfredUserRepository } = await import('@alfred/storage');
      const recipeFavRepo = new RecipeFavoriteRepository(adapter);
      const mealPlanRepo = new MealPlanRepository(adapter);
      const recipeUserRepo = new AlfredUserRepository(adapter);
      skillRegistry.register(new RecipeSkill(this.config.recipe, {
        favorites: recipeFavRepo,
        mealPlans: mealPlanRepo,
        userRepo: recipeUserRepo,
      }));
      this.logger.info({
        hasSpoonacular: !!this.config.recipe?.spoonacular?.apiKey,
        hasEdamam: !!this.config.recipe?.edamam?.appId,
      }, 'Recipe skill registered');
    }

    // 4p5. Spotify (playback, search, playlists — needs client ID, OAuth PKCE)
    if (this.config.spotify?.clientId) {
      const { SpotifySkill } = await import('@alfred/skills');
      const apiPublicUrl = this.config.api?.publicUrl ?? `http://${this.config.api?.host ?? 'localhost'}:${this.config.api?.port ?? 3420}`;
      this.spotifySkill = new SpotifySkill(this.config.spotify, apiPublicUrl);
      skillRegistry.register(this.spotifySkill);
      this.logger.info('Spotify skill registered');
    }

    // Sonos (always registered — local discovery needs no config)
    {
      const { SonosSkill } = await import('@alfred/skills');
      const sonosApiUrl = this.config.api?.publicUrl ?? `http://${this.config.api?.host ?? 'localhost'}:${this.config.api?.port ?? 3420}`;
      this.sonosSkill = new SonosSkill(this.config.sonos, sonosApiUrl, memoryRepo, skillStateRepo);
      skillRegistry.register(this.sonosSkill);
      this.logger.info({ hasCloud: !!this.config.sonos?.cloud }, 'Sonos skill registered');
    }

    // Travel (requires at least one search API)
    if (this.config.travel?.booking?.rapidApiKey) {
      const { TravelSkill } = await import('@alfred/skills');
      const { TravelPlanRepository } = await import('@alfred/storage');
      const travelPlanRepo = new TravelPlanRepository(adapter);
      skillRegistry.register(new TravelSkill(this.config.travel, { plans: travelPlanRepo }));
      this.logger.info({
        hasFlights: true,
        hasHotels: true,
      }, 'Travel skill registered');
    }

    // MQTT (requires broker URL)
    if (this.config.mqtt?.brokerUrl) {
      const { MqttSkill } = await import('@alfred/skills');
      skillRegistry.register(new MqttSkill(this.config.mqtt));
      this.logger.info({ broker: this.config.mqtt.brokerUrl }, 'MQTT skill registered');
    }

    // 4o2. Cloudflare DNS (optional)
    if (this.config.cloudflare?.apiToken) {
      const { CloudflareDnsSkill } = await import('@alfred/skills');
      skillRegistry.register(new CloudflareDnsSkill(this.config.cloudflare));
      this.logger.info('Cloudflare DNS skill registered');
    }

    // 4o3. Nginx Proxy Manager (optional)
    if (this.config.nginxProxyManager?.baseUrl) {
      const { NginxProxyManagerSkill } = await import('@alfred/skills');
      skillRegistry.register(new NginxProxyManagerSkill(this.config.nginxProxyManager));
      this.logger.info({ baseUrl: this.config.nginxProxyManager.baseUrl }, 'Nginx Proxy Manager skill registered');
    }

    // 4o4. pfSense Firewall (optional)
    if (this.config.pfsense?.baseUrl) {
      const { PfSenseSkill } = await import('@alfred/skills');
      skillRegistry.register(new PfSenseSkill(this.config.pfsense));
      this.logger.info({ baseUrl: this.config.pfsense.baseUrl, auth: this.config.pfsense.authMethod ?? 'apikey' }, 'pfSense Firewall skill registered');
    }

    // 4o5. Deploy Skill (always available — uses SSH + orchestration)
    {
      const { DeploySkill } = await import('@alfred/skills');
      const deploySkill = new DeploySkill(this.config.infra);
      // Wire orchestration callbacks for full_deploy
      const orchCallbacks: Record<string, ((input: Record<string, unknown>) => Promise<any>) | undefined> = {};
      if (skillRegistry.has('proxmox')) orchCallbacks.proxmox = (i) => skillSandbox.execute(skillRegistry.get('proxmox')!, i, {} as any);
      if (skillRegistry.has('cloudflare_dns')) orchCallbacks.cloudflare = (i) => skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, i, {} as any);
      if (skillRegistry.has('nginx_proxy_manager')) orchCallbacks.npm = (i) => skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, i, {} as any);
      if (skillRegistry.has('pfsense')) orchCallbacks.firewall = (i) => skillSandbox.execute(skillRegistry.get('pfsense')!, i, {} as any);
      if (skillRegistry.has('unifi')) orchCallbacks.unifi = (i) => skillSandbox.execute(skillRegistry.get('unifi')!, i, {} as any);
      deploySkill.setOrchestrationCallbacks(orchCallbacks);
      // Wire forge config for auto-injecting Git tokens
      if (this.config.codeAgents?.forge) {
        deploySkill.setForgeConfig(this.config.codeAgents.forge);
      }
      // v608 F6 — persistent compose-variant memory across restarts/failover
      if (this.database) {
        const { HostCapabilitiesRepository } = await import('@alfred/storage');
        deploySkill.setHostCapabilitiesRepo(new HostCapabilitiesRepository(this.database.getAdapter()));
      }
      // v609 — auto-save a fact-memory after each successful deploy
      // v807 — Nutzt tryOwner() statt manueller findOrCreate-Resolution.
      // Vorher: catch-Fallback gab raw env-var (Telegram-ID) zurück.
      // Jetzt: UserUUID oder undefined — Branded Type catched falsche Casts.
      if (this.memoryRepo) {
        deploySkill.setMemoryRepo(this.memoryRepo, this.tryOwner());
      }
      // v733 — ENV-Provider: liefert ENVs aus project_environments[stage] für Auto-.env-Write beim Deploy
      deploySkill.setEnvProvider(async (projectName: string, stage: string) => {
        if (!this.envRepoRef || !this.envCryptoRef || !this.projectRepo) return undefined;
        const ownerUid = this.tryOwner();
        if (!ownerUid) return undefined;
        try {
          const projects = await this.projectRepo.list(ownerUid);
          const proj = projects.find(p => p.slug === projectName || p.name.toLowerCase() === projectName.toLowerCase());
          if (!proj) return undefined;
          const entry = await this.envRepoRef.get(proj.id, stage);
          if (!entry) return undefined;
          return this.envCryptoRef.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
        } catch (err) {
          this.logger.debug({ err, projectName, stage }, 'v733 deploy env-provider lookup failed');
          return undefined;
        }
      });
      skillRegistry.register(deploySkill);
      this.logger.info('Deploy skill registered (with orchestration, v733: +env-provider)');

      // 4o5-mikrotik. MikroTik RouterOS (optional — before CMDB so discovery source is available)
      if (this.config.mikrotik?.enabled) {
        const { MikroTikSkill } = await import('@alfred/skills');
        const mtSkill = new MikroTikSkill(this.config.mikrotik);
        skillRegistry.register(mtSkill);
        this.logger.info('MikroTik skill registered');
      }

      // 4o6. CMDB + ITSM + InfraDocs (auto-enabled when any infra skill is configured)
      if (this.config.cmdb?.enabled !== false && (this.config.proxmox || this.config.unifi || this.config.docker || this.config.cloudflare || this.config.nginxProxyManager || this.config.pfsense || this.config.homeassistant || this.config.mikrotik)) {
        const cmdbRepo = new CmdbRepository(adapter);
        const itsmRepo = new ItsmRepository(adapter);
        itsmRepo.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const { ProblemRepository, RunbookRepository, MetricSamplesRepository } = await import('@alfred/storage');
        const problemRepo = new ProblemRepository(adapter);
        const runbookRepo = new RunbookRepository(adapter);
        const metricSamplesRepo = new MetricSamplesRepository(adapter);
        this.runbookRepo = runbookRepo;

        const { CmdbSkill, ItsmSkill, InfraDocsSkill, RunbookSkill } = await import('@alfred/skills');
        const cmdbSkill = new CmdbSkill(cmdbRepo, this.config.cmdb?.staleThresholdDays ?? 7);
        const itsmSkill = new ItsmSkill(itsmRepo, cmdbRepo, problemRepo);
        itsmSkill.setMetricSamplesRepo(metricSamplesRepo);
        const infraDocsSkill = new InfraDocsSkill(cmdbRepo, itsmRepo);
        const runbookSkill = new RunbookSkill(runbookRepo);

        // Wire LLM callback for ITSM service description parsing + doc generation
        itsmSkill.setLlmCallback(async (prompt: string, tier?: string) => {
          if (!this.llmProvider) throw new Error('LLM nicht verfügbar');
          const res = await this.llmProvider.complete({ messages: [{ role: 'user', content: prompt }], tier: (tier as any) ?? 'default', maxTokens: 3000 });
          return res.content;
        });

        // v602 P4 — Reverse-Cascade: when an incident is resolved/closed, also mark
        // linked project-open-items as done (only the most recent linkage is touched).
        itsmSkill.setProjectItemCascade(async (incidentId: string) => {
          if (!this.projectRepo) return;
          try {
            const items = await this.projectRepo.findOpenItemsByLinkedIncident(incidentId);
            for (const it of items) {
              await this.projectRepo.updateOpenItemStatus(it.id, 'done');
            }
          } catch (err) {
            this.logger.debug({ err, incidentId }, 'ITSM→project cascade failed (non-critical)');
          }
        });

        // Wire LLM callback for runbook generation
        infraDocsSkill.setLlmCallback(async (prompt: string, tier?: string) => {
          if (!this.llmProvider) throw new Error('LLM nicht verfügbar');
          const res = await this.llmProvider.complete({ messages: [{ role: 'user', content: prompt }], tier: (tier as any) ?? 'default', maxTokens: 3000 });
          return res.content;
        });

        // Wire SSH callback for deep system scans
        if (skillRegistry.has('shell')) {
          infraDocsSkill.setSshCallback(async (host: string, command: string, user?: string) => {
            const shellSkill = skillRegistry.get('shell')!;
            const sshUser = user ?? this.config.infra?.sshUser;
            const sshCmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshUser ? sshUser + '@' : ''}${host} '${command.replace(/'/g, "'\\''")}'`;
            const result = await skillSandbox.execute(shellSkill, { command: sshCmd }, { userId: '', platform: 'api', chatId: '', conversationId: '' } as any);
            if (!result.success) return '';
            const data = result.data as { stdout?: string } | undefined;
            return data?.stdout ?? result.display ?? '';
          });
        }

        // Wire discovery sources from registered infra skills
        const wrapSkillAsSource = (skillName: string, discoverFn: () => Promise<{ assets: any[]; relations: any[] }>) => {
          if (skillRegistry.has(skillName)) cmdbSkill.registerDiscoverySource(skillName, discoverFn);
        };

        wrapSkillAsSource('proxmox', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const pxSkill = skillRegistry.get('proxmox')!;
          const nodeIpMap = new Map<string, string>(); // node name → IP from cluster/status
          let clusterSourceId: string | undefined;
          try {
            // 1. Cluster status (optional — fails gracefully on single-node)
            try {
              const clusterResult = await skillSandbox.execute(pxSkill, { action: 'cluster_status' }, {} as any);
              if (clusterResult.success && Array.isArray(clusterResult.data)) {
                const clusterEntry = (clusterResult.data as any[]).find((e: any) => e.type === 'cluster');
                if (clusterEntry) {
                  clusterSourceId = `cluster:${clusterEntry.name}`;
                  assets.push({
                    name: clusterEntry.name, assetType: 'cluster', sourceSkill: 'proxmox', sourceId: clusterSourceId,
                    status: clusterEntry.quorate ? 'active' : 'degraded',
                    attributes: { nodes: clusterEntry.nodes, version: clusterEntry.version, quorate: clusterEntry.quorate },
                  });
                }
                // Extract node IPs from cluster/status node entries
                for (const entry of clusterResult.data as any[]) {
                  if (entry.type === 'node' && entry.name && entry.ip) {
                    nodeIpMap.set(entry.name, entry.ip);
                  }
                }
              }
            } catch { /* single-node or cluster API not available */ }

            // 2. Nodes
            const nodesResult = await skillSandbox.execute(pxSkill, { action: 'list_nodes' }, {} as any);
            if (nodesResult.success && Array.isArray(nodesResult.data)) {
              for (const n of nodesResult.data) {
                assets.push({ name: n.node, assetType: 'server', sourceSkill: 'proxmox', sourceId: `node:${n.node}`, ipAddress: nodeIpMap.get(n.node), status: n.status === 'online' ? 'active' : 'inactive', attributes: { cpu: n.cpu, maxcpu: n.maxcpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime } });
                if (clusterSourceId) {
                  relations.push({ sourceKey: `proxmox:node:${n.node}`, targetKey: `proxmox:${clusterSourceId}`, relationType: 'part_of' as const });
                }
              }
            }

            // 3. Storage (cluster-wide)
            try {
              const storageResult = await skillSandbox.execute(pxSkill, { action: 'list_storage', node: '' }, {} as any);
              if (storageResult.success && Array.isArray(storageResult.data)) {
                for (const s of storageResult.data as any[]) {
                  if (s.enabled === false || s.enabled === 0) continue;
                  assets.push({
                    name: s.storage, assetType: 'storage', sourceSkill: 'proxmox', sourceId: `storage:${s.storage}`,
                    status: s.active ? 'active' : 'inactive',
                    attributes: { storageType: s.type, content: s.content, used: s.used, total: s.total },
                  });
                  // Shared storage → connects_to each node (cluster-wide storage has no node restriction)
                  // Node-specific storage from /nodes/{n}/storage would need per-node calls — skip for now
                  if (clusterSourceId) {
                    relations.push({ sourceKey: `proxmox:${clusterSourceId}`, targetKey: `proxmox:storage:${s.storage}`, relationType: 'connects_to' as const });
                  }
                }
              }
            } catch { /* storage listing failed */ }

            // 4. VMs/LXCs
            const vmsResult = await skillSandbox.execute(pxSkill, { action: 'list_vms' }, {} as any);
            if (vmsResult.success && Array.isArray(vmsResult.data)) {
              for (const v of vmsResult.data) {
                const type = v.type === 'lxc' ? 'lxc' : 'vm';
                let vmIp: string | undefined;
                let vmMac: string | undefined;
                // Try to get IP from VM config (LXC: net0 has ip=..., QEMU: net0 has MAC)
                try {
                  const configPath = type === 'lxc'
                    ? `/nodes/${v.node}/lxc/${v.vmid}/config`
                    : `/nodes/${v.node}/qemu/${v.vmid}/config`;
                  const cfgResult = await skillSandbox.execute(skillRegistry.get('proxmox')!, { action: 'api_raw', path: configPath }, {} as any);
                  const cfg = cfgResult.success ? cfgResult.data as Record<string, unknown> : null;
                  if (cfg) {
                    const net0 = String(cfg.net0 ?? '');
                    // LXC: ip=192.168.1.92/24
                    const ipMatch = net0.match(/ip=([0-9.]+)/);
                    if (ipMatch) vmIp = ipMatch[1];
                    // MAC: virtio=BC:24:11:...,bridge=... or hwaddr=BC:24:11:...
                    const macMatch = net0.match(/(?:virtio|hwaddr)=([0-9A-Fa-f:]+)/);
                    if (macMatch) vmMac = macMatch[1].toLowerCase();
                  }
                } catch { /* skip — config not accessible */ }
                // Try QEMU guest agent for running VMs without static IP
                if (!vmIp && type === 'vm' && v.status === 'running') {
                  try {
                    const agentResult = await skillSandbox.execute(skillRegistry.get('proxmox')!, { action: 'api_raw', path: `/nodes/${v.node}/qemu/${v.vmid}/agent/network-get-interfaces` }, {} as any);
                    if (agentResult.success && agentResult.data) {
                      const ifaces = (agentResult.data as any).result ?? agentResult.data;
                      if (Array.isArray(ifaces)) {
                        for (const iface of ifaces) {
                          const addrs = iface['ip-addresses'] ?? [];
                          for (const addr of addrs) {
                            if (addr['ip-address-type'] === 'ipv4' && !String(addr['ip-address']).startsWith('127.')) {
                              vmIp = addr['ip-address'];
                              break;
                            }
                          }
                          if (vmIp) break;
                        }
                      }
                    }
                  } catch { /* guest agent not available */ }
                }
                assets.push({ name: v.name || `${type}-${v.vmid}`, assetType: type, sourceSkill: 'proxmox', sourceId: `${v.node}:${v.vmid}`, identifier: `vmid:${v.vmid}`, ipAddress: vmIp, status: v.status === 'running' ? 'active' : 'inactive', attributes: { vmid: v.vmid, node: v.node, cpus: v.cpus, maxmem: v.maxmem, maxdisk: v.maxdisk, mac: vmMac } });
                relations.push({ sourceKey: `proxmox:${v.node}:${v.vmid}`, targetKey: `proxmox:node:${v.node}`, relationType: 'hosted_on' as const });
              }
            }
          } catch { /* skip source on error */ }
          return { assets, relations };
        });

        wrapSkillAsSource('docker', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const hostIp = this.config.docker?.host?.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
          try {
            const result = await skillSandbox.execute(skillRegistry.get('docker')!, { action: 'containers' }, {} as any);
            if (result.success && Array.isArray(result.data)) {
              for (const c of result.data) {
                const name = (c.Names?.[0] ?? c.Id ?? '').replace(/^\//, '');
                const sourceId = (c.Id ?? '').slice(0, 12);
                assets.push({ name, assetType: 'container', sourceSkill: 'docker', sourceId, status: c.State === 'running' ? 'active' : 'inactive', ipAddress: hostIp, attributes: { image: c.Image, status: c.Status, ports: c.Ports, host_ip: hostIp } });
                // Link container → host VM by IP match (resolved during CMDB upsert)
                if (hostIp) {
                  relations.push({ sourceKey: `docker:${sourceId}`, targetKey: `ip:${hostIp}`, relationType: 'runs_on' as const });
                }
              }
            }
          } catch { /* skip */ }
          return { assets, relations };
        });

        wrapSkillAsSource('unifi', async () => {
          const assets: any[] = [];
          try {
            const devResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_devices' }, {} as any);
            if (devResult.success && Array.isArray(devResult.data)) {
              for (const d of devResult.data) {
                assets.push({ name: d.name || d.mac, assetType: 'network_device', sourceSkill: 'unifi', sourceId: `device:${d.mac ?? d._id}`, ipAddress: d.ip, status: d.state === 1 ? 'active' : 'inactive', attributes: { mac: d.mac, model: d.model, type: d.type, version: d.version } });
              }
            }
            const netResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_networks' }, {} as any);
            if (netResult.success && Array.isArray(netResult.data)) {
              for (const n of netResult.data) {
                assets.push({ name: n.name || n._id, assetType: 'network', sourceSkill: 'unifi', sourceId: `net:${n._id}`, attributes: { vlan: n.vlan_enabled ? n.vlan : undefined, subnet: n.ip_subnet } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('cloudflare_dns', async () => {
          const assets: any[] = [];
          try {
            const zonesResult = await skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, { action: 'list_zones' }, {} as any);
            if (zonesResult.success && Array.isArray(zonesResult.data)) {
              for (const z of zonesResult.data) {
                const recsResult = await skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, { action: 'list_records', domain: z.name }, {} as any);
                if (recsResult.success && Array.isArray(recsResult.data)) {
                  for (const r of recsResult.data) {
                    assets.push({ name: `${r.name} (${r.type})`, assetType: 'dns_record', sourceSkill: 'cloudflare_dns', sourceId: `${z.id}:${r.id}`, fqdn: r.name, attributes: { type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, zone: z.name } });
                  }
                }
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('nginx_proxy_manager', async () => {
          const assets: any[] = [];
          try {
            const hostsResult = await skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, { action: 'list_hosts' }, {} as any);
            if (hostsResult.success && Array.isArray(hostsResult.data)) {
              for (const h of hostsResult.data) {
                assets.push({ name: h.domain_names?.[0] ?? `host-${h.id}`, assetType: 'proxy_host', sourceSkill: 'nginx_proxy_manager', sourceId: `host:${h.id}`, attributes: { domain_names: h.domain_names, forward_host: h.forward_host, forward_port: h.forward_port, forward_scheme: h.forward_scheme, ssl_forced: h.ssl_forced } });
              }
            }
            const certsResult = await skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, { action: 'list_certificates' }, {} as any);
            if (certsResult.success && Array.isArray(certsResult.data)) {
              for (const c of certsResult.data) {
                assets.push({ name: c.nice_name || c.domain_names?.[0] || `cert-${c.id}`, assetType: 'certificate', sourceSkill: 'nginx_proxy_manager', sourceId: `cert:${c.id}`, attributes: { domain_names: c.domain_names, expires_on: c.expires_on, provider: c.provider } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('pfsense', async () => {
          const assets: any[] = [];
          const pfSkill = skillRegistry.get('pfsense')!;
          // Firewall Rules
          try {
            const rulesResult = await skillSandbox.execute(pfSkill, { action: 'list_rules' }, {} as any);
            if (rulesResult.success && Array.isArray(rulesResult.data)) {
              for (const r of rulesResult.data) {
                assets.push({ name: r.descr || `rule-${r.id}`, assetType: 'firewall_rule', sourceSkill: 'pfsense', sourceId: `rule:${r.id}`, attributes: { type: r.type, interface: r.interface, protocol: r.protocol, source: r.source, destination: r.destination, destination_address: r.destination?.address } });
              }
            }
          } catch { /* skip */ }
          // Interfaces (network segments with IP/Subnet)
          try {
            const ifResult = await skillSandbox.execute(pfSkill, { action: 'list_interfaces' }, {} as any);
            if (ifResult.success && Array.isArray(ifResult.data)) {
              for (const i of ifResult.data) {
                const name = i.descr || i.name || i.if || 'unknown';
                const ip = i.ipaddr && i.ipaddr !== 'dhcp' ? i.ipaddr : undefined;
                const subnet = i.subnet ? `${ip ?? ''}/${i.subnet}` : undefined;
                assets.push({ name, assetType: 'network', sourceSkill: 'pfsense', sourceId: `if:${i.if ?? name}`, ipAddress: ip, attributes: { interface: i.if, subnet, vlan: i.tag, enable: i.enable, gateway: i.gateway } });
              }
            }
          } catch { /* skip */ }
          // VLANs
          try {
            const vlanResult = await skillSandbox.execute(pfSkill, { action: 'list_vlans' }, {} as any);
            if (vlanResult.success && Array.isArray(vlanResult.data)) {
              for (const v of vlanResult.data) {
                assets.push({ name: v.descr || `VLAN ${v.tag}`, assetType: 'network', sourceSkill: 'pfsense', sourceId: `vlan:${v.tag}`, attributes: { vlan_tag: v.tag, parent_if: v.parentif ?? v.if?.split('.')[0], vlanif: v.vlanif ?? v.if } });
              }
            }
          } catch { /* skip */ }
          // Gateways
          try {
            const gwResult = await skillSandbox.execute(pfSkill, { action: 'list_gateways' }, {} as any);
            if (gwResult.success && Array.isArray(gwResult.data)) {
              for (const g of gwResult.data) {
                assets.push({ name: g.name || `gw-${g.interface}`, assetType: 'network', sourceSkill: 'pfsense', sourceId: `gw:${g.name ?? g.interface}`, ipAddress: g.gateway as string, attributes: { interface: g.interface, monitor: g.monitor, status: g.status, default: g.defaultgw } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('homeassistant', async () => {
          const assets: any[] = [];
          try {
            const statesResult = await skillSandbox.execute(skillRegistry.get('homeassistant')!, { action: 'states' }, {} as any);
            if (statesResult.success && Array.isArray(statesResult.data)) {
              for (const s of statesResult.data) {
                const entityId = s.entity_id as string;
                if (!entityId) continue;
                const domain = entityId.split('.')[0];
                // Only discover physical devices and automations, skip transient states
                if (!['automation', 'switch', 'light', 'sensor', 'binary_sensor', 'climate', 'cover', 'fan', 'media_player', 'camera'].includes(domain)) continue;
                const type = domain === 'automation' ? 'automation' as const : 'iot_device' as const;
                assets.push({ name: s.attributes?.friendly_name || entityId, assetType: type, sourceSkill: 'homeassistant', sourceId: entityId, status: s.state === 'unavailable' ? 'inactive' : 'active', attributes: { entity_id: entityId, domain, state: s.state } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('mikrotik', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const mtSkill = skillRegistry.get('mikrotik')! as any;
          const routers = mtSkill.getRouters?.() ?? [];
          for (const cfg of routers) {
            const conn = { name: cfg.name, cfg };
            try {
              // Router as network_device asset
              const res = await mtSkill.api(conn, 'GET', '/system/resource');
              const identity = await mtSkill.api(conn, 'GET', '/system/identity');
              const routerName = identity?.name ?? cfg.name;
              const routerAsset = { name: routerName, assetType: 'network_device' as const, sourceSkill: 'mikrotik', sourceId: `router:${cfg.name}`, ipAddress: cfg.host, status: 'active' as const, attributes: { version: res.version, architecture: res['architecture-name'], board: res['board-name'], cpu_count: res['cpu-count'], total_memory: res['total-memory'], uptime: res.uptime } };
              assets.push(routerAsset);

              // Interfaces as network assets
              const ifaces = await mtSkill.api(conn, 'GET', '/interface');
              for (const i of (ifaces as any[])) {
                if (i.type === 'bridge' || i.type === 'loopback') continue;
                assets.push({ name: `${routerName}/${i.name}`, assetType: 'network' as const, sourceSkill: 'mikrotik', sourceId: `if:${cfg.name}:${i.name}`, attributes: { type: i.type, mac: i['mac-address'], running: i.running, mtu: i['actual-mtu'] } });
                relations.push({ sourceEntityName: `${routerName}/${i.name}`, targetEntityName: routerName, relationType: 'part_of' });
              }

              // Firewall rules
              const fwRules = await mtSkill.api(conn, 'GET', '/ip/firewall/filter');
              for (const r of (fwRules as any[]).slice(0, 50)) {
                const ruleName = r.comment || `${r.chain}-${r.action}-${r['.id']}`;
                assets.push({ name: `${routerName}/fw/${ruleName}`, assetType: 'firewall_rule' as const, sourceSkill: 'mikrotik', sourceId: `fw:${cfg.name}:${r['.id']}`, attributes: { chain: r.chain, action: r.action, src: r['src-address'], dst: r['dst-address'], protocol: r.protocol, port: r['dst-port'], disabled: r.disabled } });
              }

              // DHCP leases as discovered devices
              const leases = await mtSkill.api(conn, 'GET', '/ip/dhcp-server/lease');
              for (const l of (leases as any[])) {
                if (l.status !== 'bound') continue;
                const deviceName = l['host-name'] || l['mac-address'] || l.address;
                assets.push({ name: deviceName, assetType: 'network_device' as const, sourceSkill: 'mikrotik', sourceId: `dhcp:${cfg.name}:${l['mac-address'] ?? l.address}`, ipAddress: l.address, attributes: { mac: l['mac-address'], hostname: l['host-name'], server: l.server, dynamic: l.dynamic } });
              }
            } catch { /* router unreachable — skip */ }
          }
          return { assets, relations };
        });

        // Wire CMDB registration callback for full_deploy
        deploySkill.setCmdbCallback?.(async (result: Record<string, unknown>) => {
          try {
            const userId = this.config.security?.ownerUserId ?? '';
            const user = await this.userRepo?.findOrCreate('telegram' as any, userId);
            const uid = user?.masterUserId ?? user?.id ?? userId;
            // Register deployed assets
            if (result.host) {
              await cmdbRepo.upsertAsset(uid, { name: result.project as string ?? 'deployed-app', assetType: 'application', sourceSkill: 'deploy', sourceId: `deploy:${result.host}:${result.project}`, ipAddress: result.host as string, status: 'active', attributes: result });
            }
            await cmdbRepo.logChange(uid, null, 'created', 'deploy', undefined, undefined, undefined, `Full deploy: ${result.project ?? 'app'} auf ${result.host ?? '?'}`, 'deploy_skill');
          } catch { /* non-critical */ }
        });

        // Wire post-deploy callback: CMDB discovery + Deep Scan + Service creation
        deploySkill.setPostDeployCallback?.(async (host: string, project: string) => {
          try {
            const userId = this.tryOwner() || '';

            // Step 1: CMDB Discovery — register VM/LXC as asset
            const cmdbSkill = skillRegistry.get('cmdb');
            if (cmdbSkill) {
              await skillSandbox.execute(cmdbSkill, { action: 'discover_source', source: 'proxmox' }, { userId, masterUserId: userId } as any);
              this.logger.info({ host, project }, 'Post-deploy: CMDB Proxmox discovery completed');
            }

            // Step 2: Find the asset by IP → Deep Scan for system docs + Docker container registration
            const hostAsset = (await cmdbRepo.listAssets(userId, { search: host } as any))?.[0];
            if (hostAsset) {
              const docsSkill = skillRegistry.get('infra_docs');
              if (docsSkill) {
                await skillSandbox.execute(docsSkill, { action: 'generate_system_doc', asset_id: hostAsset.id, deep_scan: true }, { userId, masterUserId: userId } as any);
                this.logger.info({ host, project, assetId: hostAsset.id }, 'Post-deploy: Deep Scan completed');
              }

              // Step 3: Auto-create service from project name + discovered components
              const itsmSkill = skillRegistry.get('itsm');
              if (itsmSkill) {
                const description = `Service "${project}" deployed auf ${hostAsset.name} (${host}). ` +
                  `Host-Asset: ${hostAsset.name}, IP: ${host}. ` +
                  `Automatisch erstellt nach full_deploy.`;
                await skillSandbox.execute(itsmSkill, { action: 'create_service_from_description', description }, { userId, masterUserId: userId } as any);
                this.logger.info({ host, project }, 'Post-deploy: Service auto-created');
              }
            } else {
              this.logger.warn({ host, project }, 'Post-deploy: Host asset not found in CMDB — skipping Deep Scan + Service');
            }
          } catch (err) {
            this.logger.warn({ err, host: host, project }, 'Post-deploy callback failed');
          }
        });

        // Wire monitor alert → auto-incident creation with batch-aware dedup + linking
        if (this.config.cmdb?.autoIncidentFromMonitor !== false && skillRegistry.has('monitor')) {
          const origMonitor = skillRegistry.get('monitor')!;
          const origExecute = origMonitor.execute.bind(origMonitor);
          origMonitor.execute = async (input: Record<string, unknown>, ctx: any) => {
            const result = await origExecute(input, ctx);
            if (result.success) {
              const userId = this.ownerMasterUserId || ctx.masterUserId || ctx.userId;
              const alerts = Array.isArray(result.data)
                ? result.data as Array<{ source: string; message: string }>
                : [];

              // ── 1. Alert processing: create/append incidents ──
              if (alerts.length > 0) {
                // Track first incident per source within this batch for relatedIncidentId linking
                const batchFirstBySource = new Map<string, string>();
                // Track new incident IDs created in this batch so we can run pattern-detection afterwards
                const newIncidentIds: string[] = [];

                // Patch B: pre-load asset name index for O(1) lookup during the loop.
                // Used to populate `affectedAssetIds` on each created incident, which makes
                // pattern-detection clustering by asset work (`problem-repository.detectPatterns`).
                const allAssets = await cmdbRepo.listAssets(userId);
                const assetByLowerName = new Map<string, string>(); // normalized name → asset.id
                for (const a of allAssets) {
                  if (a.name) assetByLowerName.set(a.name.toLowerCase(), a.id);
                  if (a.hostname) assetByLowerName.set(a.hostname.toLowerCase(), a.id);
                }

                for (const alert of alerts) {
                  try {
                    // Filter out generic alert words so device/entity names become the distinguishing keywords
                    const GENERIC_ALERT_WORDS = new Set(['device', 'connected', 'state', 'status', 'failed', 'error', 'warning', 'health', 'check', 'entities', 'unavailable', 'subsystem', 'battery', 'settings', 'offline', 'online']);
                    const keywords = alert.message.split(/[\s"()]+/).filter(w => w.length >= 4 && !GENERIC_ALERT_WORDS.has(w.toLowerCase())).map(w => w.toLowerCase());
                    const severity = alert.message.toLowerCase().includes('offline') || alert.message.toLowerCase().includes('critical') ? 'critical' as const : alert.message.toLowerCase().includes('high') || alert.message.toLowerCase().includes('cpu') ? 'high' as const : 'medium' as const;

                    // Patch B: resolve affected assets by scanning alert message for known asset names.
                    // This finally populates `affected_asset_ids` so pattern-detection can cluster
                    // recurring incidents on the same asset (e.g. 8× "git-server RAM" → Problem).
                    const messageLower = alert.message.toLowerCase();
                    const matchedAssetIds = new Set<string>();
                    for (const [name, id] of assetByLowerName) {
                      // Word-boundary match to avoid "git" matching "github" etc.
                      if (name.length >= 3 && new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(messageLower)) {
                        matchedAssetIds.add(id);
                      }
                    }
                    const affectedAssetIds = [...matchedAssetIds];

                    // v633 T3.4 — Persist numeric sample (xx.x%) into cmdb_metric_samples
                    // for trend / capacity-forecast (regression über windowDays).
                    try {
                      const numMatch = /\b(\d{1,3}(?:[.,]\d{1,3})?)\s*(%|MB|GB|ms|s)\b/i.exec(alert.message);
                      if (numMatch && metricSamplesRepo) {
                        const value = parseFloat(numMatch[1].replace(',', '.'));
                        const unit = numMatch[2];
                        // Try to derive metric name from message: "RAM usage", "CPU usage", "disk usage"
                        const metricMatch = /\b(RAM|CPU|disk|memory|GPU|swap|load|temperature)\b\s*(usage|util(?:isation)?|free|used)?/i.exec(alert.message);
                        const metricName = metricMatch ? `${metricMatch[1].toLowerCase()}${metricMatch[2] ? '_' + metricMatch[2].toLowerCase() : ''}` : 'value';
                        for (const aid of (affectedAssetIds.length > 0 ? affectedAssetIds : [undefined])) {
                          await metricSamplesRepo.record(userId, { assetId: aid, metricName, value, unit, source: alert.source });
                        }
                      }
                    } catch (err) { this.logger.debug({ err: (err as Error).message }, 'Metric-sample record failed (non-fatal)'); }

                    // v633 T3.5 — Re-Open statt Duplicate: wenn ein resolved/closed Incident
                    // mit demselben Pattern in den letzten 24h existiert, re-open + recurrence++
                    // statt neuen Incident anlegen. Verhindert Flapping-Spam.
                    const reopenCandidate = await itsmRepo.findRecentResolvedDuplicate(userId, alert.source, keywords, 24);
                    if (reopenCandidate) {
                      const reopened = await itsmRepo.reopenIncident(userId, reopenCandidate.id, alert.message);
                      if (reopened) {
                        if (!batchFirstBySource.has(alert.source)) batchFirstBySource.set(alert.source, reopened.id);
                        // High recurrence (≥3 within 24h) → also flag as new for pattern detection
                        if ((reopened.recurrenceCount ?? 0) >= 3) newIncidentIds.push(reopened.id);
                        continue;
                      }
                    }

                    // 1. Check keyword-match against existing open incidents → duplicate → append symptoms
                    const existingInc = await itsmRepo.findOpenIncidentForAsset(userId, alert.source, keywords);
                    if (existingInc) {
                      await itsmRepo.appendSymptoms(userId, existingInc.id, alert.message);
                      if (!batchFirstBySource.has(alert.source)) batchFirstBySource.set(alert.source, existingInc.id);
                      continue;
                    }

                    // 2. No keyword match → create new incident, link to batch-first or recent same-source
                    let relatedId = batchFirstBySource.get(alert.source);
                    if (!relatedId) {
                      const recent = await itsmRepo.findRecentIncidentForSource(userId, alert.source, 4);
                      if (recent) relatedId = recent.id;
                    }

                    // v633 T3.2 — Known-Error-Auto-Apply: matched ein bekanntes Problem mit
                    // is_known_error=true → bekannte Lösung in Symptoms vorabhängen, sodass
                    // der User direkt sieht was der Workaround ist.
                    let symptoms = alert.message;
                    try {
                      const knownErrorMatch = await findKnownErrorMatch(problemRepo, userId, alert.message, keywords);
                      if (knownErrorMatch) {
                        symptoms = `🔁 **Bekannte Lösung aus Problem ${knownErrorMatch.id.slice(0, 8)}** ("${knownErrorMatch.title.slice(0, 60)}"):\n${knownErrorMatch.workaround ?? knownErrorMatch.knownErrorDescription ?? '(siehe Problem-Details)'}\n\n---\n\n${alert.message}`;
                      }
                    } catch { /* best effort */ }

                    const newInc = await itsmRepo.createIncident(userId, {
                      title: `${alert.source}: ${alert.message.slice(0, 100)}`,
                      severity,
                      symptoms,
                      detectedBy: 'monitor',
                      relatedIncidentId: relatedId,
                      affectedAssetIds,
                    });

                    if (!batchFirstBySource.has(alert.source)) batchFirstBySource.set(alert.source, newInc.id);
                    newIncidentIds.push(newInc.id);

                    // v634 T4.2 — Cascade observation: if there's a different-service incident
                    // resolved/closed within the last 30 minutes, record the (source→target)
                    // transition. Over time, repeated observations build a service-dependency
                    // graph from actual failure patterns (not just configured CMDB relations).
                    try {
                      if (newInc.affectedServiceIds.length > 0) {
                        const cascadeWindow = new Date(Date.now() - 30 * 60_000).toISOString();
                        const recentRows = await itsmRepo.listIncidents(userId, { limit: 30 });
                        for (const earlier of recentRows) {
                          if (earlier.id === newInc.id) continue;
                          if (!earlier.resolvedAt && !earlier.closedAt) continue;
                          const resolvedAt = earlier.resolvedAt ?? earlier.closedAt;
                          if (!resolvedAt || resolvedAt < cascadeWindow) continue;
                          // Different service?
                          for (const targetSid of newInc.affectedServiceIds) {
                            for (const sourceSid of earlier.affectedServiceIds) {
                              if (sourceSid !== targetSid) {
                                const delayMin = (new Date(newInc.openedAt).getTime() - new Date(resolvedAt).getTime()) / 60_000;
                                if (delayMin >= 0 && delayMin <= 30) {
                                  await itsmRepo.observeCascade(userId, sourceSid, targetSid, delayMin);
                                }
                              }
                            }
                          }
                        }
                      }
                    } catch (err) { this.logger.debug({ err: (err as Error).message }, 'Cascade-observation failed (non-fatal)'); }
                  } catch (err) { this.logger.warn({ err: (err as Error).message, source: alert.source }, 'Auto-incident creation failed'); }
                }

                // Patch A: run pattern detection if we created NEW incidents in this batch.
                // v631 T1.3 — Zwei-Stufen-Promotion statt nur Confirmation:
                //   - cluster ≥5 in 7d (oder critical-Severity ≥3): AUTOMATISCH Problem erstellen,
                //     User wird informiert (kein Round-Trip). Reasoning: solche Cluster sind
                //     eindeutige Wiederholungs-Patterns, die Confirmation-Reibung lohnt nicht.
                //   - cluster 3-4 in 14d: weiterhin Confirmation für User-Approval
                if (newIncidentIds.length > 0 && this.confirmationQueue) {
                  try {
                    const patterns = await problemRepo.detectPatterns(userId, { windowDays: 14, minIncidents: 3 });
                    const ownerPlatformForPattern = (this.config.telegram?.enabled ? 'telegram'
                      : this.config.discord?.enabled ? 'discord'
                      : this.config.whatsapp?.enabled ? 'whatsapp'
                      : 'api');
                    const ownerChatId = this.config.security?.ownerUserId ?? '';
                    for (const p of patterns.slice(0, 5)) {
                      if (p.existingProblemId) continue;
                      const overlapsBatch = p.incidentIds.some(id => newIncidentIds.includes(id));
                      if (!overlapsBatch) continue;

                      const windowDaysSpan = Math.max(1, Math.ceil((Date.now() - new Date(p.firstSeen).getTime()) / 86400000));
                      const within7d = (Date.now() - new Date(p.firstSeen).getTime()) <= 7 * 86400000;
                      const autoPromote = (p.incidentCount >= 5 && within7d) || p.incidentCount >= 8;

                      const title = `Wiederkehrende Incidents: ${p.keywordCluster.slice(0, 4).join(', ') || 'unbenannt'} (${p.incidentCount}× in ${windowDaysSpan}d)`;

                      if (autoPromote) {
                        try {
                          const problem = await problemRepo.createProblem(userId, {
                            title,
                            description: `Automatisch promoviert aus ${p.incidentCount} ähnlichen Incidents (Threshold: ≥5 in 7d).\nSymptoms: ${p.keywordCluster.join(', ')}`,
                            priority: p.incidentCount >= 8 ? 'high' : 'medium',
                            linkedIncidentIds: p.incidentIds,
                            affectedAssetIds: p.assetIds,
                            affectedServiceIds: p.serviceIds,
                            detectedBy: 'pattern_detection',
                            detectionMethod: `cluster ${p.incidentCount}×/${windowDaysSpan}d, keywords=${p.keywordCluster.slice(0, 3).join('+')}`,
                          });
                          // Backfill problem_id on all linked incidents
                          for (const incId of p.incidentIds) {
                            try { await problemRepo.linkIncident(userId, problem.id, incId); } catch { /* best effort */ }
                          }
                          // v633 T3.1 — Auto-RCA: fire-and-forget LLM call to seed root-cause hypothesis
                          this.runProblemRca(userId, problem.id, problemRepo, itsmRepo).catch(err =>
                            this.logger.debug({ err, problemId: problem.id }, 'Auto-RCA failed (non-fatal)'));
                          // Notify owner — no confirmation needed
                          const adapter = this.adapters.get(ownerPlatformForPattern as any);
                          if (adapter && ownerChatId) {
                            try {
                              await adapter.sendMessage(ownerChatId,
                                `🔁 **Auto-Problem erstellt**: ${title}\n\n` +
                                `${p.incidentCount} ähnliche Incidents wurden automatisch verlinkt. Problem-ID \`${problem.id.slice(0, 8)}\` öffnet in der Web-UI: \`/alfred/itsm/\``);
                            } catch { /* non-critical */ }
                          }
                          this.logger.info({ patternKey: p.patternKey, problemId: problem.id, incidentCount: p.incidentCount },
                            'ITSM pattern-detection: auto-promoted to problem');
                        } catch (err) {
                          this.logger.warn({ err: (err as Error).message }, 'Auto-promote failed, falling back to confirmation');
                        }
                      } else {
                        const description = `Pattern erkannt: ${p.incidentCount} ähnliche Incidents [${p.keywordCluster.slice(0, 5).join(', ')}]. Problem-Ticket erstellen für Root-Cause-Analyse?`;
                        await this.confirmationQueue.enqueue({
                          chatId: ownerChatId,
                          platform: ownerPlatformForPattern,
                          source: 'reasoning',
                          sourceId: `itsm-pattern-${p.patternKey}`,
                          description,
                          skillName: 'itsm',
                          skillParams: {
                            action: 'create_problem',
                            title,
                            priority: p.incidentCount >= 5 ? 'high' : 'medium',
                            linked_incident_ids: p.incidentIds,
                            symptoms: p.keywordCluster.join(', '),
                          },
                          timeoutMinutes: 24 * 60,
                        });
                        this.logger.info({ pattern: p.patternKey, incidentCount: p.incidentCount }, 'ITSM pattern-detection: problem-creation suggested');
                      }
                    }
                  } catch (err) { this.logger.warn({ err: (err as Error).message }, 'Pattern-detection failed'); }
                }
                // After all incidents processed, trigger service health re-evaluation
                try {
                  const itsmSkillRef = skillRegistry.get('itsm');
                  if (itsmSkillRef) {
                    await skillSandbox.execute(itsmSkillRef, { action: 'health_check' }, { userId, masterUserId: userId } as any);
                  }
                } catch { /* non-critical */ }
              }

              // ── 2. Auto-Recovery scan (runs on every successful monitor run) ──
              // Resolves monitor-created incidents whose underlying condition
              // is no longer present: clean source + no user interaction + 60min quiet.
              try {
                // Sources that were actually attempted in this run
                const requestedChecks = (input.checks as string[] | undefined) ?? [];
                const configuredSources: string[] = [];
                if (this.config.proxmox) configuredSources.push('proxmox');
                if (this.config.unifi) configuredSources.push('unifi');
                if (this.config.homeassistant) configuredSources.push('homeassistant');
                if (this.config.proxmoxBackup) configuredSources.push('proxmox_backup');
                const checkedSources = requestedChecks.length > 0 ? requestedChecks : configuredSources;

                // Sources whose check itself failed (e.g. API timeout) — skip recovery for those
                const failedSources = new Set<string>();
                for (const a of alerts) {
                  if (a.message.startsWith('Health check failed')) failedSources.add(a.source);
                }
                const cleanSources = checkedSources.filter(s => !failedSources.has(s));

                if (cleanSources.length > 0) {
                  const RECOVERY_MIN_AGE_MIN = 60;
                  const candidates = await itsmRepo.findRecoveryCandidates(userId, RECOVERY_MIN_AGE_MIN);

                  let resolvedCount = 0;
                  for (const inc of candidates) {
                    const titleLower = inc.title.toLowerCase();
                    const matchedSource = cleanSources.find(s => titleLower.startsWith(`${s}:`));
                    if (!matchedSource) continue;

                    const ageMinutes = Math.floor(
                      (Date.now() - new Date(inc.updatedAt).getTime()) / 60_000,
                    );

                    try {
                      await itsmRepo.updateIncident(userId, inc.id, {
                        status: 'resolved',
                        resolution: `🔄 Auto-resolved: Monitor-Bedingung für "${matchedSource}" ist seit ${ageMinutes}min nicht mehr aufgetreten. Finaler Close liegt beim User.`,
                      });
                      resolvedCount++;
                      this.logger.info(
                        { incidentId: inc.id, source: matchedSource, ageMinutes },
                        'ITSM auto-recovery: incident resolved',
                      );
                    } catch (err) {
                      this.logger.warn(
                        { err: (err as Error).message, incidentId: inc.id },
                        'ITSM auto-recovery: update failed',
                      );
                    }
                  }

                  if (resolvedCount > 0) {
                    this.logger.info(
                      { resolvedCount, cleanSources },
                      `ITSM auto-recovery: ${resolvedCount} incident(s) resolved`,
                    );
                  }
                }
              } catch (err) {
                this.logger.warn(
                  { err: (err as Error).message },
                  'ITSM auto-recovery scan failed',
                );
              }
            }
            return result;
          };
        }

        // v631 T1.4 — Periodische Pattern-Sweep (alle 30min), unabhängig vom Monitor-Batch.
        // Fängt Cluster auch wenn keine neuen Monitor-Alerts kommen (z.B. nur tägliche
        // Alerts → minIncidents=3 in 14d gehört dazu). Auto-Promote-Logik ist mit der
        // Monitor-Path-Logik identisch (≥5 in 7d oder ≥8 absolut → automatisch Problem).
        if (this.config.cmdb?.autoIncidentFromMonitor !== false) {
          const ownerUidForSweep = this.tryOwner();
          if (ownerUidForSweep) {
            const ownerPlatformForSweep = (this.config.telegram?.enabled ? 'telegram'
              : this.config.discord?.enabled ? 'discord'
              : this.config.whatsapp?.enabled ? 'whatsapp'
              : 'api');
            const sweepInterval = setInterval(async () => {
              try {
                const patterns = await problemRepo.detectPatterns(ownerUidForSweep, { windowDays: 14, minIncidents: 3 });
                for (const p of patterns.slice(0, 5)) {
                  if (p.existingProblemId) continue;
                  const windowDaysSpan = Math.max(1, Math.ceil((Date.now() - new Date(p.firstSeen).getTime()) / 86400000));
                  const within7d = (Date.now() - new Date(p.firstSeen).getTime()) <= 7 * 86400000;
                  const autoPromote = (p.incidentCount >= 5 && within7d) || p.incidentCount >= 8;
                  if (!autoPromote) continue; // sweep only auto-promotes — Confirmations laufen via Monitor-Path
                  const title = `Wiederkehrende Incidents: ${p.keywordCluster.slice(0, 4).join(', ') || 'unbenannt'} (${p.incidentCount}× in ${windowDaysSpan}d)`;
                  try {
                    const problem = await problemRepo.createProblem(ownerUidForSweep, {
                      title,
                      description: `Periodische Pattern-Sweep promoviert (${p.incidentCount} Incidents).\nKeywords: ${p.keywordCluster.join(', ')}`,
                      priority: p.incidentCount >= 8 ? 'high' : 'medium',
                      linkedIncidentIds: p.incidentIds,
                      affectedAssetIds: p.assetIds,
                      affectedServiceIds: p.serviceIds,
                      detectedBy: 'pattern_detection',
                      detectionMethod: `sweep ${p.incidentCount}×/${windowDaysSpan}d`,
                    });
                    for (const incId of p.incidentIds) {
                      try { await problemRepo.linkIncident(ownerUidForSweep, problem.id, incId); } catch { /* best effort */ }
                    }
                    // v633 T3.1 — Auto-RCA für Sweep-promoted Problems
                    this.runProblemRca(ownerUidForSweep, problem.id, problemRepo, itsmRepo).catch(err =>
                      this.logger.debug({ err, problemId: problem.id }, 'Auto-RCA (sweep) failed (non-fatal)'));
                    const adapter = this.adapters.get(ownerPlatformForSweep as any);
                    if (adapter) {
                      try {
                        await adapter.sendMessage(this.config.security?.ownerUserId ?? '',
                          `🔁 **Auto-Problem (Sweep)**: ${title}\n\n${p.incidentCount} ähnliche Incidents wurden automatisch verlinkt (\`${problem.id.slice(0, 8)}\`).`);
                      } catch { /* non-critical */ }
                    }
                    this.logger.info({ patternKey: p.patternKey, problemId: problem.id, incidentCount: p.incidentCount }, 'ITSM pattern-sweep: auto-promoted to problem');
                  } catch (err) { this.logger.warn({ err: (err as Error).message }, 'Pattern-sweep auto-promote failed'); }
                }
              } catch (err) { this.logger.debug({ err: (err as Error).message }, 'ITSM pattern-sweep failed (non-fatal)'); }
            }, 30 * 60_000);
            (sweepInterval as { unref?: () => void }).unref?.();
            this.logger.info('ITSM pattern-sweep registered (30min interval)');

            // v633 T3.7 — Daily ITSM-Reflection (täglich ~23:00 lokal): Top-Wiederkehrer,
            // neue Problems, MTTR-Trend, Capacity-Forecast → Insight an Owner-Chat.
            const dailyReflection = async () => {
              try {
                const since = new Date(Date.now() - 7 * 86400_000).toISOString();
                const recentIncidents = await itsmRepo.listIncidents(ownerUidForSweep, { limit: 200 });
                const last7d = recentIncidents.filter(i => i.openedAt >= since);
                const closedLast7d = last7d.filter(i => i.status === 'closed' || i.status === 'resolved');
                const recurrenceTop = last7d
                  .filter(i => (i.recurrenceCount ?? 0) >= 2)
                  .sort((a, b) => (b.recurrenceCount ?? 0) - (a.recurrenceCount ?? 0))
                  .slice(0, 5);
                const mttr = await itsmRepo.mttrReport(ownerUidForSweep, { windowDays: 7 });
                const mttrAll = mttr.find(m => m.scope === 'all');
                const forecast = await metricSamplesRepo.forecast(ownerUidForSweep, { windowDays: 30, threshold: 95 });
                const urgentForecasts = forecast.filter(f => f.daysUntilThreshold != null && f.daysUntilThreshold <= 30).slice(0, 5);

                const lines: string[] = [];
                lines.push(`📊 **ITSM Tagesreflexion** (${new Date().toISOString().slice(0, 10)})`);
                lines.push('');
                lines.push(`**Letzte 7d**: ${last7d.length} Incidents · ${closedLast7d.length} geschlossen`);
                if (mttrAll) lines.push(`**MTTR**: ⌀ ${mttrAll.meanMinutes}min · Median ${mttrAll.medianMinutes}min · p95 ${mttrAll.p95Minutes}min`);
                if (recurrenceTop.length > 0) {
                  lines.push('');
                  lines.push(`**Top Wiederkehrer:**`);
                  for (const r of recurrenceTop) {
                    lines.push(`- ${r.recurrenceCount}× ${r.title.slice(0, 80)}`);
                  }
                }
                if (urgentForecasts.length > 0) {
                  lines.push('');
                  lines.push(`**Capacity-Vorhersage (≤30d zu 95%):**`);
                  for (const f of urgentForecasts) {
                    lines.push(`- ${f.metricName}${f.assetId ? ` @ ${f.assetId.slice(0, 8)}` : ''}: aktuell ${f.latestValue.toFixed(1)}%, ${f.daysUntilThreshold}d bis Schwelle`);
                  }
                }

                // v634 T4.1 — Worst Service-Health-Scores
                let worstServices: Array<{ serviceName: string; score: number }> = [];
                try {
                  const allScores = await itsmRepo.serviceHealthScore(ownerUidForSweep, { windowDays: 30 });
                  worstServices = allScores.filter(s => s.score < 70).slice(0, 3).map(s => ({ serviceName: s.serviceName, score: s.score }));
                } catch { /* skip */ }
                if (worstServices.length > 0) {
                  lines.push('');
                  lines.push(`**Service-Health <70:**`);
                  for (const s of worstServices) {
                    lines.push(`- ${s.serviceName}: ${s.score}/100`);
                  }
                }

                // v634 T4.4 — SLA-Breach-Risk
                let slaRisks: Awaited<ReturnType<typeof itsmRepo.slaBreachRisk>> = [];
                try { slaRisks = await itsmRepo.slaBreachRisk(ownerUidForSweep); } catch { /* skip */ }
                if (slaRisks.length > 0) {
                  lines.push('');
                  lines.push(`**SLA-Risiko (${slaRisks.length}):**`);
                  for (const r of slaRisks.slice(0, 3)) {
                    const flag = r.minutesUntilBreach < 0 ? '🔴' : r.minutesUntilBreach < 30 ? '⚠️' : '🟡';
                    lines.push(`- ${flag} ${r.incidentTitle.slice(0, 50)}: noch ${r.minutesUntilBreach}min Budget`);
                  }
                }

                // v634 T4.3 — Post-Incident-Review pending
                let pirPending: Awaited<ReturnType<typeof itsmRepo.findClosedIncidentsWithoutPir>> = [];
                try { pirPending = await itsmRepo.findClosedIncidentsWithoutPir(ownerUidForSweep, 72); } catch { /* skip */ }
                if (pirPending.length > 0) {
                  lines.push('');
                  lines.push(`**Post-Incident-Review offen (${pirPending.length}):**`);
                  for (const inc of pirPending.slice(0, 3)) {
                    lines.push(`- ${inc.title.slice(0, 60)}`);
                  }
                  lines.push(`_Mit \`itsm pir_pending\` siehst du alle._`);
                }

                if (last7d.length === 0 && recurrenceTop.length === 0 && urgentForecasts.length === 0 && worstServices.length === 0 && slaRisks.length === 0 && pirPending.length === 0) return;

                const adapter = this.adapters.get(ownerPlatformForSweep as any);
                if (adapter) {
                  await adapter.sendMessage(this.config.security?.ownerUserId ?? '', lines.join('\n'));
                }
                this.logger.info({ incidents: last7d.length }, 'ITSM daily-reflection sent');
              } catch (err) { this.logger.debug({ err: (err as Error).message }, 'ITSM daily-reflection failed (non-fatal)'); }
            };
            // Schedule for ~23:00 local each day. Compute initial delay so first fire is at the next 23:00.
            const now = new Date();
            const next23 = new Date(now);
            next23.setHours(23, 0, 0, 0);
            if (next23.getTime() <= now.getTime()) next23.setDate(next23.getDate() + 1);
            const initialDelay = next23.getTime() - now.getTime();
            setTimeout(() => {
              dailyReflection();
              const dailyInterval = setInterval(dailyReflection, 24 * 3600_000);
              (dailyInterval as { unref?: () => void }).unref?.();
            }, initialDelay).unref?.();
            this.logger.info({ firstRunIn: Math.round(initialDelay / 60_000) + 'min' }, 'ITSM daily-reflection scheduled (23:00 local)');
          }
        }

        // Wire IP resolver callback (pfSense ARP/DHCP + UniFi clients → MAC-to-IP)
        cmdbSkill.setIpResolverCallback(async () => {
          const entries: Array<{ mac: string; ip: string; hostname?: string; source: string }> = [];
          // pfSense ARP table
          if (skillRegistry.has('pfsense')) {
            try {
              const arpResult = await skillSandbox.execute(skillRegistry.get('pfsense')!, { action: 'list_arp' }, {} as any);
              if (arpResult.success && Array.isArray(arpResult.data)) {
                for (const e of arpResult.data) {
                  if (e.mac && e.ip) entries.push({ mac: String(e.mac), ip: String(e.ip), hostname: e.hostname as string, source: 'pfsense_arp' });
                }
              }
            } catch { /* skip */ }
          }
          // pfSense DHCP leases
          if (skillRegistry.has('pfsense')) {
            try {
              const dhcpResult = await skillSandbox.execute(skillRegistry.get('pfsense')!, { action: 'list_dhcp_leases' }, {} as any);
              if (dhcpResult.success && Array.isArray(dhcpResult.data)) {
                for (const l of dhcpResult.data) {
                  if (l.mac && l.ip) entries.push({ mac: String(l.mac), ip: String(l.ip), hostname: l.hostname as string, source: 'pfsense_dhcp' });
                }
              }
            } catch { /* skip */ }
          }
          // UniFi clients (all known clients with MAC + IP)
          if (skillRegistry.has('unifi')) {
            try {
              const clientResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_clients' }, {} as any);
              if (clientResult.success && Array.isArray(clientResult.data)) {
                for (const c of clientResult.data) {
                  if (c.mac && c.ip) entries.push({ mac: String(c.mac), ip: String(c.ip), hostname: (c.hostname ?? c.name) as string, source: 'unifi' });
                }
              }
            } catch { /* skip */ }
          }
          return entries;
        });

        // Wire KG sync callback (CMDB → KG)
        if (this.config.cmdb?.kgSync !== false) {
          cmdbSkill.setKgSyncCallback(async (uid: string) => {
            if (!this.kgServiceRef) return;
            const allAssets = await cmdbRepo.listAssets(uid);
            const allRels = await cmdbRepo.getAllRelations(uid);
            const relMapped = allRels.map(r => {
              const src = allAssets.find(a => a.id === r.sourceAssetId);
              const tgt = allAssets.find(a => a.id === r.targetAssetId);
              return { sourceEntityName: src?.name ?? '', targetEntityName: tgt?.name ?? '', relationType: r.relationType };
            }).filter(r => r.sourceEntityName && r.targetEntityName);
            await this.kgServiceRef.syncFromCmdb(uid, allAssets, relMapped);
          });
        }

        // Patch D: wrap ITSM skill to suggest a Change-Request when an incident transitions
        // to resolved/closed with a clear root_cause + resolution. Permanent fixes belong in
        // a Change-Request workflow — not buried in incident notes.
        {
          const origItsmExecute = itsmSkill.execute.bind(itsmSkill);
          itsmSkill.execute = async (input: Record<string, unknown>, ctx: any) => {
            const result = await origItsmExecute(input, ctx);
            try {
              const isResolveAction = input.action === 'update_incident' || input.action === 'close_incident';
              const newStatus = (input.status as string | undefined) ?? '';
              const becomesResolved = isResolveAction && (newStatus === 'resolved' || newStatus === 'closed');
              const rootCause = (input.root_cause as string | undefined) ?? '';
              const resolution = (input.resolution as string | undefined) ?? '';
              const isManualWorkaround = /workaround|temporary|tempor[äa]r|kurzfristig|notfall|manuell.*neustart/i.test(resolution);
              if (
                result.success && becomesResolved
                && rootCause.length >= 20 && resolution.length >= 20
                && !isManualWorkaround
                && this.confirmationQueue
              ) {
                const incident = (result.data as { id?: string; title?: string }) ?? {};
                const incTitle = incident.title ?? '(unbenannt)';
                const incId = incident.id ?? '';
                const ownerPlatformForChange = (this.config.telegram?.enabled ? 'telegram'
                  : this.config.discord?.enabled ? 'discord'
                  : this.config.whatsapp?.enabled ? 'whatsapp'
                  : 'api');
                await this.confirmationQueue.enqueue({
                  chatId: this.config.security?.ownerUserId ?? '',
                  platform: ownerPlatformForChange,
                  source: 'reasoning',
                  sourceId: `itsm-fix-change-${incId.slice(0, 8)}`,
                  description: `Permanenten Fix als Change-Request anlegen für: ${incTitle.slice(0, 80)}?`,
                  skillName: 'itsm',
                  skillParams: {
                    action: 'create_change_request',
                    title: `Fix: ${incTitle.slice(0, 100)}`,
                    type: 'normal',
                    risk_level: 'medium',
                    description: `Root Cause: ${rootCause}\n\nLösung im Incident: ${resolution}\n\nUrsprünglicher Incident: ${incId}`,
                    related_incident_id: incId,
                  },
                  timeoutMinutes: 24 * 60,
                });
                this.logger.info({ incidentId: incId, title: incTitle.slice(0, 60) }, 'ITSM auto-change suggestion enqueued');

                // Trigger A: also suggest a Runbook from this resolution — dedup check first
                // so we don't enqueue both if user already created a runbook for this incident.
                try {
                  const rbUserId = (ctx?.masterUserId as string | undefined) ?? (ctx?.userId as string | undefined) ?? this.ownerMasterUserId ?? '';
                  if (!rbUserId) throw new Error('no user for runbook lookup');
                  const existing = await runbookRepo.findBySource(rbUserId, 'itsm_incident', incId);
                  if (!existing) {
                    await this.confirmationQueue.enqueue({
                      chatId: this.config.security?.ownerUserId ?? '',
                      platform: ownerPlatformForChange,
                      source: 'reasoning',
                      sourceId: `runbook-from-incident-${incId.slice(0, 8)}`,
                      description: `Runbook aus Incident-Lösung erstellen: "${incTitle.slice(0, 80)}"?`,
                      skillName: 'runbook',
                      skillParams: {
                        action: 'create',
                        title: incTitle.slice(0, 120),
                        symptom: (input.symptoms as string | undefined) ?? incTitle,
                        cause: rootCause,
                        // LLM-side we let it formulate the steps; we pre-fill with the resolution text
                        // split by line as a starting point. User can refine.
                        steps: resolution.split(/\n+/).filter(s => s.trim().length > 0),
                        source_type: 'itsm_incident',
                        source_id: incId,
                        status: 'draft',
                      },
                      timeoutMinutes: 24 * 60,
                    });
                    this.logger.info({ incidentId: incId }, 'ITSM auto-runbook suggestion enqueued');
                  }
                } catch (err) { this.logger.debug({ err: (err as Error).message }, 'Auto-runbook suggestion failed'); }
              }
            } catch (err) { this.logger.debug({ err: (err as Error).message }, 'ITSM auto-change-suggestion hook failed'); }
            return result;
          };
        }

        skillRegistry.register(cmdbSkill);
        skillRegistry.register(itsmSkill);
        skillRegistry.register(infraDocsSkill);
        skillRegistry.register(runbookSkill);

        // v824 — AgentConventionsSkill (Phase 1 vollständig: detect/generate/apply/refresh/drift/rollback/history)
        try {
          const { AgentConventionsSkill } = await import('@alfred/skills');
          const { RepoScanner } = await import('./agent-conventions/repo-scanner.js');
          const { ConventionsGenerator } = await import('./agent-conventions/conventions-generator.js');
          if (!this.agentConventionsRepo) {
            this.logger.warn({}, 'v824 agent-conventions: repo not initialized, skipping skill registration');
          } else if (!this.llmProvider) {
            this.logger.warn({}, 'v824 agent-conventions: llmProvider not initialized, skipping skill registration');
          } else {
            const scanner = new RepoScanner(this.logger.child({ component: 'repo-scanner' }));
            const generator = new ConventionsGenerator(this.llmProvider, this.logger.child({ component: 'conventions-generator' }));
            // v835 Phase 4.4 — Multi-Provider Quorum: weitere LLM-Provider durchreichen wenn config.llm.strong / fast verschiedene Anbieter sind
            try {
              const extras: import('@alfred/llm').LLMProvider[] = [];
              const llmCfg = this.config.llm as Record<string, unknown> | undefined;
              if (llmCfg && (llmCfg.strong || llmCfg.fast || llmCfg.embeddings)) {
                const { createLLMProvider } = await import('@alfred/llm');
                for (const tier of ['strong', 'fast', 'default'] as const) {
                  const sub = llmCfg[tier] as Record<string, unknown> | undefined;
                  if (sub && sub.provider && sub.provider !== (llmCfg.provider as string | undefined)) {
                    try {
                      const p = createLLMProvider(sub as never);
                      extras.push(p);
                    } catch { /* invalid sub-config */ }
                  }
                }
              }
              if (extras.length > 0) {
                generator.setExtraProviders(extras);
                this.logger.info({ count: extras.length }, 'v835 conventions multi-provider quorum: extra-providers wired');
              }
            } catch (err) {
              this.logger.debug({ err }, 'v835 multi-provider wiring failed (non-fatal, quorum will use primary N-times)');
            }
            const agentConvSkill = new AgentConventionsSkill({
              scanner,
              generator,
              conventionsRepo: this.agentConventionsRepo,
              logger: this.logger.child({ component: 'agent-conventions-skill' }),
              resolveProject: async (projectId: string) => {
                if (!this.projectRepo) return null;
                const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                if (!proj || !proj.cwd) return null;
                return { id: proj.id, cwd: proj.cwd, userId: proj.userId };
              },
              config: () => (this.config as { agentConventions?: import('@alfred/types').AgentConventionsConfig }).agentConventions ?? {},
              // v827 Phase 3.3 — Cross-Project-Pattern-Mining braucht alle Projekte des Master-Users
              listProjectsForUser: async (masterUserId: string) => {
                if (!this.projectRepo) return [];
                try {
                  const projs = await this.projectRepo.list(masterUserId).catch(() => []);
                  return projs.filter(p => p.cwd).map(p => ({ id: p.id, userId: p.userId, cwd: p.cwd! }));
                } catch { return []; }
              },
              // v833 Phase 4.5-Upgrade — Embedding für Pattern-Mining (Embedding-basierte
              // Cluster statt Jaccard). Wenn llmProvider keine embeddings supportet:
              // Fallback zu Jaccard.
              embed: this.llmProvider?.supportsEmbeddings?.()
                ? async (text: string): Promise<number[] | null> => {
                    try {
                      const r = await this.llmProvider!.embed(text);
                      return r?.embedding ?? null;
                    } catch { return null; }
                  }
                : undefined,
            });
            this.agentConventionsSkillRef = agentConvSkill;
            skillRegistry.register(agentConvSkill);
            this.logger.info({}, 'v824 agent-conventions skill registered');

            // v831 Phase 3.6 — Default-Skill-Contributions registrieren
            try {
              const { DEFAULT_CONTRIBUTIONS } = await import('@alfred/skills');
              for (const c of DEFAULT_CONTRIBUTIONS) {
                agentConvSkill.addSkillContribution(c);
              }
              this.logger.info({ count: DEFAULT_CONTRIBUTIONS.length }, 'v831 default skill-contributions registered');
            } catch (err) {
              this.logger.warn({ err }, 'v831 default-contributions register failed (non-fatal)');
            }

            // v825 — Periodischer Drift-Check (Phase 2). Default 24h. 5min nach Startup
            // initial-Lauf damit Boot nicht blockt.
            const cfg = (this.config as { agentConventions?: import('@alfred/types').AgentConventionsConfig }).agentConventions;
            const driftHours = cfg?.driftCheckIntervalHours ?? 24;
            if (driftHours > 0 && cfg?.enabled !== false) {
              const driftMs = driftHours * 3_600_000;
              const runDriftCycle = async () => {
                if (!this.agentConventionsSkillRef || !this.agentConventionsRepo) return;
                try {
                  const all = await this.agentConventionsRepo.listAllForDriftCheck();
                  this.logger.info({ count: all.length }, 'v825 agent-conventions drift cycle start');
                  for (const item of all) {
                    try {
                      const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
                      await this.agentConventionsSkillRef.execute({
                        action: 'drift_check',
                        project_id: item.projectId,
                        package_path: item.packagePath,
                      }, ctx);
                    } catch (err) {
                      this.logger.debug({ err, projectId: item.projectId }, 'v825 drift-check failed for project (non-fatal)');
                    }
                  }
                } catch (err) {
                  this.logger.debug({ err }, 'v825 drift cycle failed (non-fatal)');
                }
              };
              setTimeout(() => {
                runDriftCycle();
                this.agentConventionsDriftTimer = setInterval(runDriftCycle, driftMs);
              }, 5 * 60_000); // 5 min nach Startup
              this.logger.info({ intervalHours: driftHours }, 'v825 agent-conventions drift-check scheduled');
            }

            // v827 Phase 3.3 — Wöchentliches Cross-Project-Pattern-Mining
            if (cfg?.crossProjectPool && cfg.crossProjectPool !== 'off') {
              const miningMs = 7 * 24 * 3_600_000;
              const runMiningCycle = async () => {
                if (!this.agentConventionsSkillRef) return;
                const uid = this.tryOwner();
                if (!uid) return;
                try {
                  const ctx = { userId: uid, masterUserId: uid, chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
                  const r = await this.agentConventionsSkillRef.execute({
                    action: 'mine_patterns',
                    project_id: 'system', // not used for mining
                    master_user_id: uid,
                  }, ctx);
                  this.logger.info({ data: r.data }, 'v827 cross-project pattern-mining cycle complete');
                } catch (err) {
                  this.logger.debug({ err }, 'v827 pattern-mining cycle failed (non-fatal)');
                }
              };
              setTimeout(() => {
                runMiningCycle();
                this.agentConventionsPatternMiningTimer = setInterval(runMiningCycle, miningMs);
              }, 10 * 60_000); // 10 min nach Startup, danach wöchentlich
              this.logger.info({}, 'v827 cross-project pattern-mining scheduled (weekly)');
            }

            // v828 Phase 4.3 — Self-Modifying-Agent: periodischer Refactor der CLAUDE.md
            // mit allen Lessons + Violations + Drift-Erkennung als Kontext.
            if (cfg?.selfModifyAgent?.enabled) {
              const selfModifyDays = cfg.selfModifyAgent.intervalDays ?? 7;
              const selfModifyMs = selfModifyDays * 24 * 3_600_000;
              const runSelfModifyCycle = async () => {
                if (!this.agentConventionsSkillRef || !this.agentConventionsRepo) return;
                try {
                  const all = await this.agentConventionsRepo.listAllForDriftCheck();
                  this.logger.info({ count: all.length, intervalDays: selfModifyDays }, 'v828 self-modify cycle start');
                  for (const item of all) {
                    try {
                      const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
                      await this.agentConventionsSkillRef.execute({
                        action: 'self_modify',
                        project_id: item.projectId,
                        package_path: item.packagePath,
                      }, ctx);
                    } catch (err) {
                      this.logger.debug({ err, projectId: item.projectId }, 'v828 self-modify failed for project (non-fatal)');
                    }
                  }
                } catch (err) {
                  this.logger.debug({ err }, 'v828 self-modify cycle failed (non-fatal)');
                }
              };
              setTimeout(() => {
                runSelfModifyCycle();
                this.agentConventionsSelfModifyTimer = setInterval(runSelfModifyCycle, selfModifyMs);
              }, 15 * 60_000); // 15 min nach Startup
              this.logger.info({ intervalDays: selfModifyDays }, 'v828 self-modify-agent scheduled');
            }
          }
        } catch (err) {
          this.logger.warn({ err }, 'v824 agent-conventions skill setup failed (non-fatal)');
        }

        // v638 — Insight-Engine (Cross-Domain). Lebt im selben Block weil sie auf
        // CMDB/ITSM/Problem/MetricSamples zugreift. Adapter registriert sich selbst.
        try {
          const { InsightsRepository: InsightsRepo } = await import('@alfred/storage');
          const { InsightEngine } = await import('./insights/insight-engine.js');
          const { InfraForecastAdapter } = await import('./insights/adapters/infra-forecast-adapter.js');
          const { OpenLoopAdapter } = await import('./insights/adapters/open-loop-adapter.js');
          const { CrossSourceMentionAdapter } = await import('./insights/adapters/cross-source-mention-adapter.js');
          const { KgGapAdapter } = await import('./insights/adapters/kg-gap-adapter.js');
          const { CalendarMismatchAdapter } = await import('./insights/adapters/calendar-mismatch-adapter.js');
          const { ConversationRepository: ConvRepoForInsights } = await import('@alfred/storage');

          const insightsRepo = new InsightsRepo(adapter);
          this.insightsRepo = insightsRepo;
          const insightEngine = new InsightEngine(insightsRepo, this.logger.child({ component: 'insight-engine' }));
          this.insightEngine = insightEngine;
          insightEngine.register(new InfraForecastAdapter(metricSamplesRepo, itsmRepo, problemRepo));
          insightEngine.register(new OpenLoopAdapter(new ConvRepoForInsights(adapter)));

          // Calendar facade — bündelt was MS-Calendar/Google/CalDAV liefert (sofern aktiviert)
          const calendarFacade = this.skillRegistry?.has('calendar') ? {
            listUpcoming: async (uid: string, days: number) => {
              try {
                const r = await this.skillRegistry!.get('calendar')!.execute(
                  { action: 'list_events', days } as Record<string, unknown>,
                  { userId: uid, masterUserId: uid } as any,
                );
                if (Array.isArray(r.data)) return r.data.map((e: any) => ({
                  id: String(e.id ?? ''), title: String(e.title ?? ''),
                  startAt: String(e.start ?? e.startAt ?? ''), location: e.location as string | undefined,
                }));
              } catch { /* skip */ }
              return [];
            },
          } : undefined;
          insightEngine.register(new CrossSourceMentionAdapter(new ConvRepoForInsights(adapter), calendarFacade));

          // BMW facade — pulls latest snapshot from BMW telematic log
          const bmwFacade = this.skillRegistry?.has('bmw') ? {
            latestStatus: async (uid: string) => {
              try {
                const r = await this.skillRegistry!.get('bmw')!.execute(
                  { action: 'status' } as Record<string, unknown>,
                  { userId: uid, masterUserId: uid } as any,
                );
                if (r.data && typeof r.data === 'object') {
                  const d = r.data as any;
                  return {
                    rangeKm: typeof d.rangeKm === 'number' ? d.rangeKm : (typeof d.range_km === 'number' ? d.range_km : undefined),
                    soc: typeof d.soc === 'number' ? d.soc : (typeof d.stateOfCharge === 'number' ? d.stateOfCharge : undefined),
                    mileage: typeof d.mileage === 'number' ? d.mileage : undefined,
                    updatedAt: d.updatedAt as string | undefined,
                  };
                }
              } catch { /* skip */ }
              return null;
            },
          } : undefined;
          if (calendarFacade) insightEngine.register(new CalendarMismatchAdapter(calendarFacade, bmwFacade));

          // KG facade — uses KnowledgeGraphRepository (iterates known types)
          if (this.database) {
            try {
              const { KnowledgeGraphRepository } = await import('@alfred/storage');
              const kgRepoForInsights = new KnowledgeGraphRepository(this.database.getAdapter());
              const KG_TYPES = ['person', 'location', 'item', 'vehicle', 'event', 'metric', 'organization'] as const;
              // v694 — Canonical-merge per (type + normalized_name) across alle uids.
              // Verhindert Insight-Spam wenn User Birthday auf einem uid-Zwilling füllt aber
              // der andere ohne Birthday bleibt.
              const kgFacade = {
                listEntities: async (uids: string[]) => {
                  const byKey = new Map<string, { id: string; name: string; entityType: string; mentionCount: number; confidence: number; attributes: Record<string, unknown> }>();
                  for (const uid of uids) {
                    for (const t of KG_TYPES) {
                      try {
                        const list = await kgRepoForInsights.getEntitiesByType(uid, t as any);
                        for (const e of list) {
                          const norm = ((e as any).normalizedName ?? e.name).toString().toLowerCase().trim();
                          const key = `${e.entityType}::${norm}`;
                          const incoming = {
                            id: e.id, name: e.name, entityType: e.entityType,
                            mentionCount: (e as any).mentionCount ?? 0,
                            confidence: (e as any).confidence ?? 0.5,
                            attributes: ((e as any).attributes ?? {}) as Record<string, unknown>,
                          };
                          const existing = byKey.get(key);
                          if (!existing) { byKey.set(key, incoming); continue; }
                          // Merge attributes: existing non-null wins, incoming fills gaps
                          const mergedAttrs = { ...existing.attributes };
                          for (const [k, v] of Object.entries(incoming.attributes)) {
                            if ((mergedAttrs[k] == null || mergedAttrs[k] === '') && v != null && v !== '') mergedAttrs[k] = v;
                          }
                          // Stable id: lowest alphabetical → deterministic dedupeKey across sweeps
                          const stableId = existing.id < incoming.id ? existing.id : incoming.id;
                          byKey.set(key, {
                            ...existing,
                            id: stableId,
                            attributes: mergedAttrs,
                            mentionCount: Math.max(existing.mentionCount, incoming.mentionCount),
                            confidence: Math.max(existing.confidence, incoming.confidence),
                          });
                        }
                      } catch { /* skip type */ }
                    }
                  }
                  return Array.from(byKey.values());
                },
              };
              // v695 — Data-Facade für ehrliche Existenz-Checks (Name/KG-Relations/Memory)
              // verhindert Spam für Beziehungen/Geburtstage/Adressen die woanders schon stehen.
              const gapData = (async () => {
                try {
                  const { MemoryRepository: MemRepoForGap } = await import('@alfred/storage');
                  const memRepoForGap = new MemRepoForGap(adapter);
                  return {
                    listMemoryValues: async (uids: string[]) => {
                      const out: Array<{ value: string }> = [];
                      for (const uid of uids) {
                        try {
                          const list = await memRepoForGap.listAll(uid);
                          for (const m of list) out.push({ value: m.value ?? '' });
                        } catch { /* skip uid */ }
                      }
                      return out;
                    },
                    listRelationsForEntity: async (uids: string[], entityId: string) => {
                      const out: Array<{ relationType: string; sourceEntityId: string; targetEntityId: string }> = [];
                      for (const uid of uids) {
                        try {
                          const list = await kgRepoForInsights.getRelationsForEntity(uid, entityId);
                          for (const r of list) out.push({ relationType: (r as any).relationType, sourceEntityId: (r as any).sourceEntityId, targetEntityId: (r as any).targetEntityId });
                        } catch { /* skip uid */ }
                      }
                      return out;
                    },
                  };
                } catch (err) {
                  this.logger.debug({ err }, 'KG-Gap data-facade wiring skipped (legacy attribute-only mode)');
                  return undefined;
                }
              });
              const resolvedGapData = await gapData();
              insightEngine.register(new KgGapAdapter(kgFacade, resolvedGapData));
            } catch (err) {
              this.logger.debug({ err }, 'KG-Gap adapter wiring skipped');
            }
          }

          // v639 — Goals: Repository + Skill + DriftAdapter
          let goalsRepo: import('@alfred/storage').GoalsRepository | undefined;
          try {
            const { GoalsRepository } = await import('@alfred/storage');
            goalsRepo = new GoalsRepository(adapter);
            const { GoalsSkill } = await import('@alfred/skills');
            skillRegistry.register(new GoalsSkill(goalsRepo));
            const { GoalDriftAdapter } = await import('./insights/adapters/goal-drift-adapter.js');
            insightEngine.register(new GoalDriftAdapter(goalsRepo));
            this.logger.info('Goals subsystem wired');
          } catch (err) {
            this.logger.warn({ err }, 'Goals wiring failed (non-fatal)');
          }

          // v640 — Daily KG-Question-Generator (18:00 lokal, max 3 Fragen/Tag)
          if (this.llmProvider && this.database) {
            try {
              const { KgQuestionsRepository, ConfirmationRepository: ConfRepoQg, KnowledgeGraphRepository: KGRepoQg } = await import('@alfred/storage');
              const { KgQuestionGenerator } = await import('./insights/question-generator.js');
              const kgQuestRepo = new KgQuestionsRepository(adapter);
              const kgRepoForQg = new KGRepoQg(adapter);
              const KG_TYPES_QG = ['person', 'location', 'organization'] as const;
              // v694 — Canonical-merge wie kgFacade oben, damit der Question-Generator
              // nicht für jeden uid-Zwilling separat fragt.
              const facadeQg = {
                listEntities: async (uids: string[]) => {
                  const byKey = new Map<string, { id: string; name: string; entityType: string; mentionCount: number; attributes: Record<string, unknown> }>();
                  for (const uid of uids) {
                    for (const t of KG_TYPES_QG) {
                      try {
                        for (const e of await kgRepoForQg.getEntitiesByType(uid, t as any)) {
                          const norm = ((e as any).normalizedName ?? e.name).toString().toLowerCase().trim();
                          const key = `${e.entityType}::${norm}`;
                          const incoming = { id: e.id, name: e.name, entityType: e.entityType, mentionCount: (e as any).mentionCount ?? 0, attributes: ((e as any).attributes ?? {}) as Record<string, unknown> };
                          const existing = byKey.get(key);
                          if (!existing) { byKey.set(key, incoming); continue; }
                          const mergedAttrs = { ...existing.attributes };
                          for (const [k, v] of Object.entries(incoming.attributes)) {
                            if ((mergedAttrs[k] == null || mergedAttrs[k] === '') && v != null && v !== '') mergedAttrs[k] = v;
                          }
                          byKey.set(key, { ...existing, id: existing.id < incoming.id ? existing.id : incoming.id, attributes: mergedAttrs, mentionCount: Math.max(existing.mentionCount, incoming.mentionCount) });
                        }
                      } catch { /* skip */ }
                    }
                  }
                  return Array.from(byKey.values());
                },
              };
              const generator = new KgQuestionGenerator(facadeQg, kgQuestRepo, new ConfRepoQg(adapter), this.logger.child({ component: 'kg-question-gen' }));
              const ownerUidQg = this.tryOwner();
              const ownerPlatformQg = (this.config.telegram?.enabled ? 'telegram'
                : this.config.matrix?.enabled ? 'matrix'
                : this.config.discord?.enabled ? 'discord'
                : 'api');
              if (ownerUidQg && this.config.security?.ownerUserId) {
                const ownerChat = this.config.security.ownerUserId;
                // v694 — linkedUserIds inkl. Legacy-Data-UIDs durchreichen
                const linkedQgBase = this.userRepo ? (await this.userRepo.getLinkedUsers(ownerUidQg)).map(u => u.id) : [ownerUidQg];
                if (!linkedQgBase.includes(ownerUidQg)) linkedQgBase.push(ownerUidQg);
                const linkedQg = this.withLegacyForOwner(ownerUidQg, linkedQgBase);
                const runDailyQg = () => generator.run(ownerUidQg, { platform: ownerPlatformQg, chatId: ownerChat, maxPerRun: 3, linkedUserIds: linkedQg }).catch(err =>
                  this.logger.debug({ err }, 'KG-question-generator failed (non-fatal)'));
                // Schedule next 18:00 local
                const next18 = new Date();
                next18.setHours(18, 0, 0, 0);
                if (next18.getTime() <= Date.now()) next18.setDate(next18.getDate() + 1);
                const delayQg = next18.getTime() - Date.now();
                setTimeout(() => {
                  runDailyQg();
                  const intv = setInterval(runDailyQg, 24 * 3600_000);
                  (intv as { unref?: () => void }).unref?.();
                }, delayQg).unref?.();
                this.logger.info({ firstRunIn: Math.round(delayQg / 60_000) + 'min', platform: ownerPlatformQg }, 'KG-Question-Generator scheduled (daily 18:00, max 3/run)');
              }
            } catch (err) {
              this.logger.warn({ err }, 'KG-Question-Generator wiring failed (non-fatal)');
            }
          }

          // v639 — Weekly Goal-Extraction (Sonntag 21:00 lokal)
          if (goalsRepo && this.llmProvider && this.database) {
            try {
              const { GoalExtractor } = await import('./insights/goal-extractor.js');
              const { ConversationRepository: ConvRepoForGoal, ConfirmationRepository } = await import('@alfred/storage');
              const extractor = new GoalExtractor(
                goalsRepo,
                new ConvRepoForGoal(adapter),
                this.llmProvider,
                new ConfirmationRepository(adapter),
                this.logger.child({ component: 'goal-extractor' }),
              );
              const ownerUidForGoals = this.tryOwner();
              if (ownerUidForGoals) {
                const linkedForGoals = this.userRepo ? (await this.userRepo.getLinkedUsers(ownerUidForGoals)).map(u => u.id) : [ownerUidForGoals];
                if (!linkedForGoals.includes(ownerUidForGoals)) linkedForGoals.push(ownerUidForGoals);
                const linkedForGoalsWithLegacy = this.withLegacyForOwner(ownerUidForGoals, linkedForGoals);
                const runWeekly = async () => {
                  try { await extractor.run(ownerUidForGoals, linkedForGoalsWithLegacy, { lookbackDays: 7 }); }
                  catch (err) { this.logger.debug({ err }, 'Weekly goal-extraction failed (non-fatal)'); }
                };
                // Next Sunday 21:00
                const now = new Date();
                const next = new Date(now);
                next.setHours(21, 0, 0, 0);
                const daysToSun = (7 - next.getDay()) % 7;
                next.setDate(next.getDate() + (daysToSun === 0 && next.getTime() <= now.getTime() ? 7 : daysToSun));
                const delay = next.getTime() - now.getTime();
                setTimeout(() => {
                  runWeekly();
                  const intv = setInterval(runWeekly, 7 * 86400_000);
                  (intv as { unref?: () => void }).unref?.();
                }, delay).unref?.();
                this.logger.info({ firstRunIn: Math.round(delay / 60_000 / 60) + 'h' }, 'Goal-Extractor scheduled (Sun 21:00)');
              }
            } catch (err) {
              this.logger.warn({ err }, 'Goal-Extractor wiring failed (non-fatal)');
            }
          }

          // Skill
          const { InsightsSkill } = await import('@alfred/skills');
          const insightsSkill = new InsightsSkill(insightsRepo);
          insightsSkill.setSweepCallback(async (uid: string) => {
            const linked = this.userRepo ? (await this.userRepo.getLinkedUsers(uid)).map(u => u.id) : [uid];
            if (!linked.includes(uid)) linked.push(uid);
            const linkedWithLegacy = this.withLegacyForOwner(uid, linked);
            return insightEngine.sweep({ userId: uid, linkedUserIds: linkedWithLegacy, logger: this.logger });
          });
          skillRegistry.register(insightsSkill);

          // Daily sweep at 09:00 local
          // v805 — Nur ownerMasterUserId (UUID nach v804). Vorher OR-Fallback führte
          // bei missing master-uid zu raw env-var, also Telegram-ID statt UUID.
          const ownerUidForInsights = this.ownerMasterUserId;
          if (ownerUidForInsights) {
            const linked = this.userRepo ? (await this.userRepo.getLinkedUsers(ownerUidForInsights)).map(u => u.id) : [ownerUidForInsights];
            if (!linked.includes(ownerUidForInsights)) linked.push(ownerUidForInsights);
            const linkedWithLegacy = this.withLegacyForOwner(ownerUidForInsights, linked);
            const sweepNow = async () => {
              try {
                await insightEngine.sweep({ userId: ownerUidForInsights, linkedUserIds: linkedWithLegacy, logger: this.logger });
              } catch (err) { this.logger.debug({ err }, 'Insight daily-sweep failed (non-fatal)'); }
            };
            // Schedule next 09:00 local, then 24h interval
            const next09 = new Date();
            next09.setHours(9, 0, 0, 0);
            if (next09.getTime() <= Date.now()) next09.setDate(next09.getDate() + 1);
            const delay = next09.getTime() - Date.now();
            setTimeout(() => {
              sweepNow();
              const intv = setInterval(sweepNow, 24 * 3600_000);
              (intv as { unref?: () => void }).unref?.();
            }, delay).unref?.();
            this.logger.info({ firstSweepIn: Math.round(delay / 60_000) + 'min', adapters: insightEngine.listRegistered() }, 'Insight-Engine scheduled (daily 09:00)');
          }
        } catch (err) {
          this.logger.warn({ err }, 'Insight-Engine wiring failed (non-fatal)');
        }

        // v696 — Project-Agent Sandbox + Live-Preview Foundation.
        // v697 — Lifecycle (Worktree + Container) + Sandbox-Skill.
        // Opt-in via config.sandbox.enabled. Solange disabled oder Docker fehlt:
        // sandboxManager bleibt undefined → ProjectAgentRunner sieht es nicht → classic-Pfad.
        if (this.config.sandbox?.enabled) {
          try {
            const { SandboxRepository: SandboxRepo } = await import('@alfred/storage');
            const { SandboxManager } = await import('./sandbox-manager.js');
            const sandboxRepo = new SandboxRepo(adapter);
            // v727 — SandboxRepo an Project-Agent-Skill geben damit der build-detection
            // dev-safe arbeiten kann (running Sandbox → kein `next build` mehr)
            if (this.projectAgentSkillRef) {
              try { this.projectAgentSkillRef.setSandboxRepo(sandboxRepo); } catch { /* */ }
            }
            const nodeIdForSandbox = this.config.cluster?.nodeId ?? 'single';
            const sandboxManager = new SandboxManager({
              config: this.config.sandbox,
              repo: sandboxRepo,
              logger: this.logger.child({ component: 'sandbox-manager' }),
              nodeId: nodeIdForSandbox,
              // v726 — Project-ENV-Injection + DB-Seed-Support
              envRepo: this.envRepoRef,
              envCrypto: this.envCryptoRef,
              dbSeedRepo: this.dbSeedRepoRef,
              uploadSeedsPath: this.config.sandbox.uploadSeedsPath ?? undefined,
              // v755/v804 — Per-Project-Quota-Lookup. getByIdAnyOwner weil Quota
              // unabhängig vom Anrufer-User auf das Projekt bezogen ist.
              projectQuotaLookup: async (projectId: string) => {
                if (!this.projectRepo) return null;
                try {
                  const p = await this.projectRepo.getByIdAnyOwner(projectId);
                  return p?.maxConcurrentSandboxes ?? null;
                } catch { return null; }
              },
              // v812 — Merge bestätigt: pending Sessions → merged, OpenItemMatcher gegen
              // gemergten Stand, Workspace-Memory + "applied"-Chat.
              onMergeApplied: async ({ sandboxId, projectId }) => {
                if (!this.projectRepo) return;
                try {
                  // v815 CC1 — Race-Retry: project-manager.finishSession kann noch
                  // laufen wenn der Merge-Callback feuert → 0 pending Sessions →
                  // OpenItemMatcher würde silent gar nicht laufen. 3 Retries à 500ms.
                  // CC2 — markSessionsMergedBySandbox filtert atomar auf 'pending':
                  // ein evtl. zweiter Aufruf (Reconnect/Retry) findet 0 Rows → exit
                  // ohne OpenItemMatcher-Duplikate. Idempotenz inhärent in der Query.
                  let merged = await this.projectRepo.markSessionsMergedBySandbox(sandboxId);
                  for (let attempt = 0; merged.length === 0 && attempt < 3; attempt++) {
                    await new Promise((r) => setTimeout(r, 500));
                    merged = await this.projectRepo.markSessionsMergedBySandbox(sandboxId);
                  }
                  if (merged.length === 0) {
                    this.logger.info({ sandboxId, projectId }, 'v815 onMergeApplied: no pending sessions after retries — nothing to confirm');
                    return;
                  }
                  const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                  if (!proj) return;
                  // Aggregierte Inhalte aus den gemergten Sessions (Summary-Felder)
                  const changedFiles = merged.flatMap(s => s.summary?.filesTouched ?? []);
                  const goal = merged.map(s => s.summary?.whatWasDone ?? '').filter(Boolean).join('; ').slice(0, 500) || 'Sandbox merge';
                  // OpenItemMatcher gegen den jetzt angewendeten Stand (mutiert bestehende Items)
                  // v818 P3 — Result capturen damit Chat-Eintrag unten den Resolved-Count zeigt
                  let postMergeMatcherResolved = 0;
                  if (this.llmProvider) {
                    try {
                      const { OpenItemMatcher } = await import('./projects/open-item-matcher.js');
                      const matcher = new OpenItemMatcher(this.projectRepo, this.llmProvider, this.logger.child({ component: 'open-item-matcher' }), { service: embeddingService, repo: embeddingRepo });
                      const matchResult = await matcher.matchAfterSession({
                        projectId: proj.id,
                        sessionId: merged[0].id,
                        goal,
                        milestones: [],
                        changedFiles,
                        totalFilesChanged: changedFiles.length,
                      });
                      postMergeMatcherResolved = matchResult.resolved;
                    } catch (err) { this.logger.debug({ err, sandboxId }, 'v812 post-merge OpenItemMatcher failed'); }
                  }
                  // Workspace-Memory (jetzt ist die Arbeit wirklich im Projekt)
                  if (this.memoryRepo && proj.cwd) {
                    try {
                      const uid = proj.userId ?? this.tryOwner() ?? '';
                      const pname = proj.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop();
                      if (uid && pname) {
                        const key = `project_workspace_${pname.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                        const val = `Dev-Workspace für Projekt "${pname}": ${proj.cwd} (lokal). last_merge=${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
                        const up = (this.memoryRepo as { upsertSystemMemory?: (u: string, k: string, v: string, c: string, t?: string, cf?: number) => Promise<unknown> }).upsertSystemMemory;
                        if (up) await up.call(this.memoryRepo, uid, key, val, 'workspace', 'fact', 0.95);
                      }
                    } catch (err) { this.logger.debug({ err }, 'v812 post-merge workspace-memory failed'); }
                  }
                  // "applied"-Chat in den Project-Chat
                  if (this.conversationRepo) {
                    try {
                      const uid = proj.userId ?? this.tryOwner() ?? '';
                      if (uid) {
                        const conv = await this.conversationRepo.findOrCreateForProject(uid, proj.id);
                        await this.conversationRepo.addMessage(conv.id, 'assistant',
                          `✅ **Sandbox gemerged** — ${merged.length} Session(s) ins Projekt übernommen.${changedFiles.length > 0 ? `\n- Geänderte Dateien: ${changedFiles.length}` : ''}${postMergeMatcherResolved > 0 ? `\n- 🤖 ${postMergeMatcherResolved} offene Punkt(e) automatisch erledigt` : ''}`);
                      }
                    } catch (err) { this.logger.debug({ err }, 'v812 post-merge chat failed'); }
                  }
                  this.logger.info({ sandboxId, projectId, mergedSessions: merged.length }, 'v812 merge applied — sessions confirmed + matched');
                } catch (err) {
                  this.logger.warn({ err, sandboxId }, 'v812 onMergeApplied failed');
                }
              },
              // v825 — Merge-Gate-Failure → Lesson aus Test-Output ableiten (Lessons-Loop Phase 2).
              // Höchste Confidence-Trust-Source ("merge-gate-failure" → trust 0.9).
              onMergeGateFailed: async ({ sandboxId, projectId, testSummary, rawOutputTail }) => {
                if (!this.agentConventionsSkillRef || !this.llmProvider) return;
                try {
                  // LLM extrahiert die generalisierbare Lesson aus dem Test-Output.
                  // Constraint: nur wenn der Fehler eine Pattern hat das wiederholbar wäre
                  // (nicht "test X failed weil mock falsch") sondern strukturell.
                  const prompt = `Hier ist ein Test-Failure-Output aus einem Coding-Agent-Run:

${testSummary}

Vollständiger Output-Tail:
${rawOutputTail.slice(0, 3000)}

Frage: Lässt sich daraus eine PROJEKT-SPEZIFISCHE Konvention ableiten die der Agent in zukünftigen Sessions wissen sollte, damit dieser Fehler nicht wieder passiert?

Antworte STRENG in diesem JSON-Format (keine Erklärung drumherum):
{"learnable": true|false, "confidence": 0.0-1.0, "lesson_text": "1-3 Sätze, direkt an den Agent gerichtet, deutsch"}

Falls nicht learnable (z.B. einmaliger Mock-Issue, Flaky-Test, Infrastruktur-Problem): {"learnable": false, "confidence": 0, "lesson_text": ""}.

Beispiel für eine gute Lesson: "Wenn du eine Migration in migrations/*.sql hinzufügst, MUSS src/__tests__/setup.ts mit den neuen Tabellen-Definitionen erweitert werden. Sonst failen Tests die diese Tabellen anfragen mit 'no such table'."`;

                  const res = await this.llmProvider.complete({
                    messages: [{ role: 'user', content: prompt }],
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    tier: 'default' as any,
                    maxTokens: 500,
                    temperature: 0.2,
                  });
                  const cleaned = res.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
                  const start = cleaned.indexOf('{');
                  const end = cleaned.lastIndexOf('}');
                  if (start < 0 || end <= start) return;
                  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { learnable: boolean; confidence: number; lesson_text: string };
                  if (!parsed.learnable || !parsed.lesson_text || parsed.confidence < 0.5) {
                    this.logger.debug({ sandboxId, projectId, learnable: parsed.learnable, confidence: parsed.confidence }, 'v825 merge-gate-failure: not learnable (skipped)');
                    return;
                  }
                  const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
                  const lesson = await this.agentConventionsSkillRef.execute({
                    action: 'learn',
                    project_id: projectId,
                    package_path: '',
                    lesson_text: parsed.lesson_text,
                    lesson_source: 'merge-gate-failure',
                    lesson_confidence: Math.min(0.95, parsed.confidence * 0.9 + 0.1), // base 0.9 trust * model-confidence
                    lesson_session_id: sandboxId,
                  }, ctx);
                  this.logger.info({ sandboxId, projectId, lessonId: (lesson.data as { lessonId?: string })?.lessonId }, 'v825 lesson learned from merge-gate-failure');

                  // v826 Phase 3.2 — Auto-Apply-Check: wenn config erlaubt, direkt consolidate
                  // (das wiederum entscheidet via autoApplyAllowedByMode ob's geschrieben wird).
                  const acfg = (this.config as { agentConventions?: import('@alfred/types').AgentConventionsConfig }).agentConventions;
                  let autoApplyResult: { autoApplied?: { filePath: string; historyId: string } } | undefined;
                  if (acfg?.autoApplyMode && acfg.autoApplyMode !== 'off') {
                    try {
                      const consolidateResult = await this.agentConventionsSkillRef.execute({
                        action: 'consolidate_lessons',
                        project_id: projectId,
                        package_path: '',
                      }, ctx);
                      if (consolidateResult.success && consolidateResult.data) {
                        autoApplyResult = consolidateResult.data as typeof autoApplyResult;
                      }
                    } catch (err) {
                      this.logger.debug({ err, projectId }, 'v826 auto-apply-after-merge-fail-lesson failed (non-fatal)');
                    }
                  }

                  // Optional: ChatBubble in Project-Chat damit User sieht
                  try {
                    if (this.conversationRepo && this.projectRepo) {
                      const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                      if (proj) {
                        const conv = await this.conversationRepo.findOrCreateForProject(proj.userId, projectId);
                        const autoApplyLine = autoApplyResult?.autoApplied
                          ? `\n\n✅ **Auto-Applied** in \`${autoApplyResult.autoApplied.filePath}\` (Rollback via History-Tab möglich, ID: \`${autoApplyResult.autoApplied.historyId.slice(0, 12)}\`)`
                          : '\n\n_Wird beim nächsten Conventions-Refresh in CLAUDE.md vorgeschlagen._';
                        await this.conversationRepo.addMessage(conv.id, 'assistant',
                          `💡 **Lesson Learned aus Merge-Gate-Failure**\n\n${parsed.lesson_text}${autoApplyLine}`);
                      }
                    }
                  } catch (err) {
                    this.logger.debug({ err, projectId }, 'v825 lesson-chat-notice failed (non-fatal)');
                  }
                } catch (err) {
                  this.logger.debug({ err, sandboxId, projectId }, 'v825 onMergeGateFailed handling failed (non-fatal)');
                }
              },
              // v812 — Discard: pending Sessions → discarded, tentative Open-Items/Decisions löschen.
              onSandboxDiscarded: async ({ sandboxId, projectId }) => {
                if (!this.projectRepo) return;
                try {
                  const r = await this.projectRepo.discardSandboxSessionArtifacts(sandboxId);
                  // v818 CM2 — Persistenz-Asymmetrie reparieren: project_agent_sessions
                  // (Plan-Runtime-State, separate Tabelle) blieb nach Discard als
                  // current_phase='done' stehen → Project-Agents-Page zeigte historische
                  // Done-Runs deren Code verworfen ist. Wir setzen failure_insight als
                  // Discard-Marker, current_phase bleibt für byAgent-Analytik intakt.
                  try {
                    const adapter = this.database?.getAdapter();
                    if (adapter) {
                      await adapter.execute(
                        `UPDATE project_agent_sessions SET failure_insight = ?, updated_at = ? WHERE sandbox_id = ? AND (failure_insight IS NULL OR failure_insight = '')`,
                        ['Sandbox discarded — code not merged', new Date().toISOString(), sandboxId],
                      );
                    }
                  } catch (err) {
                    this.logger.debug({ err, sandboxId }, 'v818 CM2 project_agent_sessions discard-mark failed (non-fatal)');
                  }
                  if (r.sessions > 0) {
                    this.logger.info({ sandboxId, ...r }, 'v812 sandbox discarded — pending session-artefacts cleaned');
                    if (this.conversationRepo) {
                      try {
                        const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                        const uid = proj?.userId ?? this.tryOwner() ?? '';
                        if (proj && uid) {
                          const conv = await this.conversationRepo.findOrCreateForProject(uid, proj.id);
                          await this.conversationRepo.addMessage(conv.id, 'assistant',
                            `🗑 **Sandbox verworfen** — ${r.sessions} ungemmergte Session(s) entfernt (Code nicht übernommen). Arbeitszeit bleibt in der Statistik.`);
                        }
                      } catch { /* non-fatal */ }
                    }
                  }
                } catch (err) {
                  this.logger.warn({ err, sandboxId }, 'v812 onSandboxDiscarded failed');
                }
              },
            });
            const hc = await sandboxManager.runHealthCheck();
            if (hc.dockerAvailable && hc.worktreeBaseWritable) {
              this.sandboxManager = sandboxManager;
              this.logger.info({ ...sandboxManager.getStatus() }, 'v697 Sandbox-Manager initialized');

              // v810 — dev-server-Log-Provider an den Project-Agent-Runner verdrahten.
              // Bei curl-Health-Check-Fail im Fix-Loop holt der Runner so den echten
              // Runtime-Crash-Stacktrace statt den Agent blind raten zu lassen.
              if (this.projectAgentRunnerRef) {
                this.projectAgentRunnerRef.setDevServerLogProvider(
                  (cwd: string, tail?: number) => sandboxManager.getDevServerLog(cwd, tail ?? 120),
                );

                // v816 — ContainerExec-Lookup: für Sandbox-Sessions liefert er eine Funktion
                // die test-Commands via `docker exec` IM Container laufen lässt. Behebt
                // das musl/glibc-ABI-Problem das v813 zwang Tests aus per-Phase rauszunehmen.
                // Plan-Agent sieht damit Test-Failures im Fix-Versuch-Loop und kann sie
                // sofort beheben statt Merge-Gate-Failure am Ende.
                const adapter = this.database?.getAdapter();
                this.projectAgentRunnerRef.setContainerExecLookup(async (sessionId: string) => {
                  if (!adapter) return undefined;
                  try {
                    const sessRow = await adapter.queryOne(
                      `SELECT sandbox_id FROM project_agent_sessions WHERE task_id = ?`,
                      [sessionId],
                    ).catch(() => null) as { sandbox_id?: string } | null;
                    const sandboxId = sessRow?.sandbox_id;
                    if (!sandboxId) return undefined;
                    const sb = await sandboxRepo.getById(sandboxId).catch(() => null);
                    if (!sb?.containerId) return undefined;
                    const containerId = sb.containerId;
                    const { runContainerCommand } = await import('./sandbox/docker.js');
                    return (cmd: string, timeoutMs: number) =>
                      runContainerCommand(containerId, cmd, { cwd: '/workspace', timeoutMs });
                  } catch (err) {
                    this.logger.debug({ err, sessionId }, 'v816 containerExecLookup failed (non-fatal)');
                    return undefined;
                  }
                });

                // v825 — Lessons-Loop-Hook für Plan-Agent. awaiting_user (high trust) + fix-resolved
                // (low trust) → LLM extrahiert Lesson + persistiert via agent_conventions skill.
                this.projectAgentRunnerRef.setLessonOpportunityHook(async ({ sessionId, cwd, source, buildOutput, diagnosis, fixAttempts }) => {
                  if (!this.agentConventionsSkillRef || !this.llmProvider) return;
                  try {
                    // ProjectId aus cwd ableiten
                    if (!this.projectRepo) return;
                    const userId = this.tryOwner() ?? '';
                    if (!userId) return;
                    const projects = await this.projectRepo.list(userId).catch(() => []);
                    const proj = projects.find(p => p.cwd === cwd) ?? projects.find(p => p.cwd && cwd.startsWith(p.cwd));
                    if (!proj) return;

                    const baseTrust = source === 'plan-awaiting-user' ? 0.7 : 0.5;
                    const minLLMConfidence = source === 'plan-awaiting-user' ? 0.5 : 0.7;

                    const prompt = `Hier ist ein Build/Test-Failure aus einem Plan-Agent-Run (${source}, nach ${fixAttempts} Fix-Versuchen):

${diagnosis ? `Diagnose: ${diagnosis}\n\n` : ''}Output-Tail:
${buildOutput.slice(-3500)}

Frage: Lässt sich daraus eine PROJEKT-SPEZIFISCHE Konvention ableiten die der Agent in zukünftigen Sessions wissen sollte?

STRENG JSON: {"learnable": true|false, "confidence": 0.0-1.0, "lesson_text": "1-3 Sätze, direkt an den Agent gerichtet, deutsch"}

Bei Mock-Issues/Flaky-Tests/Infra-Problemen: {"learnable": false, "confidence": 0, "lesson_text": ""}.`;

                    const res = await this.llmProvider.complete({
                      messages: [{ role: 'user', content: prompt }],
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      tier: 'default' as any,
                      maxTokens: 400,
                      temperature: 0.2,
                    });
                    const cleaned = res.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
                    const start = cleaned.indexOf('{');
                    const end = cleaned.lastIndexOf('}');
                    if (start < 0 || end <= start) return;
                    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { learnable: boolean; confidence: number; lesson_text: string };
                    if (!parsed.learnable || !parsed.lesson_text || parsed.confidence < minLLMConfidence) {
                      this.logger.debug({ sessionId, source, confidence: parsed.confidence }, 'v825 plan-agent-lesson: not learnable (skipped)');
                      return;
                    }
                    const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
                    await this.agentConventionsSkillRef.execute({
                      action: 'learn',
                      project_id: proj.id,
                      package_path: '',
                      lesson_text: parsed.lesson_text,
                      lesson_source: source,
                      lesson_confidence: Math.min(0.95, baseTrust * parsed.confidence + 0.1),
                      lesson_session_id: sessionId,
                    }, ctx);
                    this.logger.info({ sessionId, projectId: proj.id, source }, 'v825 lesson learned from plan-agent');

                    // v830 Phase 4.2 — Auto-Violation-Trigger: prüfe ob der Fehler eine
                    // EXISTING-Convention verletzt hat. Wenn ja → record_violation für
                    // Health-Tracking (Inverse Learning). Lower-Trust-Source nur tracken
                    // wenn Fix-Loop resolved hat (= Convention war evtl. zu eng).
                    if (this.agentConventionsRepo && this.llmProvider) {
                      try {
                        const convs = await this.agentConventionsRepo.listForProject(proj.id);
                        const rootConv = convs.find(c => c.packagePath === '');
                        if (rootConv?.content) {
                          // Kompakter LLM-Check: gegen welche Section ggf. verstoßen?
                          const violationPrompt = `Aktuelle CLAUDE.md Auszug:\n${rootConv.content.slice(0, 4000)}\n\nFailure-Output:\n${buildOutput.slice(-2000)}\n\nHat der Agent gegen eine bestehende Konvention verstoßen? STRENG JSON: {"violated": true|false, "section": "stack|commands|testSetup|architecture|style|gotchas|doNotTouch", "excerpt": "betroffene Convention 1 Zeile", "confidence": 0..1}`;
                          const vres = await this.llmProvider.complete({
                            messages: [{ role: 'user', content: violationPrompt }],
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            tier: 'fast' as any,
                            maxTokens: 250,
                            temperature: 0.1,
                          });
                          const cleaned = vres.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
                          const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
                          if (s >= 0 && e > s) {
                            const v = JSON.parse(cleaned.slice(s, e + 1)) as { violated: boolean; section?: string; excerpt?: string; confidence?: number };
                            if (v.violated && v.section && v.excerpt && (v.confidence ?? 0) >= 0.5) {
                              await this.agentConventionsSkillRef.execute({
                                action: 'record_violation',
                                project_id: proj.id,
                                package_path: '',
                                section: v.section,
                                excerpt: v.excerpt,
                                session_id: sessionId,
                                resolved_anyway: source === 'plan-fix-loop-resolved',
                                manual_override: false,
                                detection_source: `auto:${source}`,
                              }, ctx);
                              this.logger.info({ sessionId, projectId: proj.id, section: v.section, resolvedAnyway: source === 'plan-fix-loop-resolved' }, 'v830 convention-violation recorded');
                            }
                          }
                        }
                      } catch (err) {
                        this.logger.debug({ err, sessionId }, 'v830 auto-violation-check failed (non-fatal)');
                      }
                    }
                  } catch (err) {
                    this.logger.debug({ err, sessionId, source }, 'v825 lesson-opportunity-hook failed (non-fatal)');
                  }
                });
              }

              // v749 — Auto-Cleanup stuck Sandboxes beim Startup + periodisch.
              // v815 SB5 — Threshold + Interval konfigurierbar (langsame Infra braucht
              // höhere Werte; Defaults wie bisher: 10min stuck, 5min Interval).
              const stuckThresholdMin = (this.config.sandbox as { stuckThresholdMinutes?: number }).stuckThresholdMinutes ?? 10;
              const stuckIntervalMs = ((this.config.sandbox as { stuckCleanupIntervalMinutes?: number }).stuckCleanupIntervalMinutes ?? 5) * 60_000;
              sandboxManager.cleanupStuckSandboxes(stuckThresholdMin).then(n => {
                if (n > 0) this.logger.info({ cleaned: n, threshold: stuckThresholdMin }, 'v749 Startup-Cleanup: stuck sandboxes marked as failed');
              }).catch(() => { /* */ });
              setInterval(() => {
                sandboxManager.cleanupStuckSandboxes(stuckThresholdMin).catch(() => { /* */ });
              }, stuckIntervalMs).unref?.();

              // v700 — NFS-Detection (best-effort, nur logging — hilft bei HA-Cluster-Diagnose)
              try {
                const { readFileSync } = await import('node:fs');
                const mounts = readFileSync('/proc/mounts', 'utf-8');
                const wtBase = this.config.sandbox.worktreeBasePath ?? '/var/alfred/worktrees';
                const onNfs = mounts.split('\n').some(line => {
                  const parts = line.split(/\s+/);
                  if (parts.length < 3) return false;
                  return wtBase.startsWith(parts[1]) && (parts[2] === 'nfs' || parts[2] === 'nfs4');
                });
                if (onNfs) {
                  this.logger.info({ worktreeBase: wtBase }, 'v700 Worktree-Base ist auf NFS — HA-Failover-Migration möglich (Container neu starten auf anderem Node)');
                }
              } catch { /* not on Linux or no /proc/mounts — ignore */ }

              // v700 — Cleanup-Worker via setInterval (alle 15 min). Pausiert idle-running,
              // entfernt stale-paused. Lebt nur auf einem Node via Adapter-Claim wäre besser,
              // aber für jetzt: jeder Node arbeitet nur die Sandboxes mit eigener node_id.
              const cleanupIntervalMs = 15 * 60 * 1000;
              const runCleanup = async () => {
                try {
                  await sandboxManager.cleanupIdle(async (pid: string) => {
                    if (!this.projectRepo) return null;
                    try { const p = await this.projectRepo.getByIdAnyOwner(pid); return p?.cwd ?? null; }
                    catch { return null; }
                  });
                } catch (err) { this.logger.debug({ err }, 'v700 Sandbox cleanup-worker tick failed (non-fatal)'); }
              };
              // Erster Tick nach 5 Minuten Startup-Pause
              setTimeout(() => {
                runCleanup();
                const t = setInterval(runCleanup, cleanupIntervalMs);
                (t as { unref?: () => void }).unref?.();
              }, 5 * 60 * 1000).unref?.();
              this.logger.info({ intervalMin: 15 }, 'v700 Sandbox cleanup-worker scheduled');

              // v697 — Sandbox-Skill für CLI-Trigger/Memory-Skill/Cleanup-Worker registrieren.
              try {
                const { SandboxSkill } = await import('@alfred/skills');
                const sandboxSkill = new SandboxSkill(sandboxRepo);
                const projectsRepo = this.projectRepo;
                const resolveProjectCwd = async (projectId: string): Promise<string | null> => {
                  if (!projectsRepo) return null;
                  try {
                    const proj = await projectsRepo.getByIdAnyOwner(projectId);
                    return proj?.cwd ?? null;
                  } catch { return null; }
                };
                sandboxSkill.setCallbacks({
                  getStatus: () => sandboxManager.getStatus(),
                  pause: (sid) => sandboxManager.pause(sid),
                  resume: (sid) => sandboxManager.resume(sid),
                  discard: async (sid) => {
                    const sb = await sandboxRepo.getById(sid);
                    if (!sb) throw new Error(`Sandbox not found: ${sid}`);
                    const cwd = await resolveProjectCwd(sb.projectId);
                    if (!cwd) throw new Error(`Project cwd unknown for project ${sb.projectId}`);
                    await sandboxManager.discard(sid, cwd);
                  },
                  destroy: async (sid) => {
                    const sb = await sandboxRepo.getById(sid);
                    if (!sb) return;
                    const cwd = await resolveProjectCwd(sb.projectId);
                    if (!cwd) throw new Error(`Project cwd unknown for project ${sb.projectId}`);
                    await sandboxManager.destroy(sid, cwd);
                  },
                  cleanupIdle: async () => {
                    // v700 — pausiert idle-running Sandboxes + entfernt stale-paused
                    return sandboxManager.cleanupIdle(async (pid: string) => {
                      if (!projectsRepo) return null;
                      try { const p = await projectsRepo.getByIdAnyOwner(pid); return p?.cwd ?? null; }
                      catch { return null; }
                    });
                  },
                });
                skillRegistry.register(sandboxSkill);
              } catch (err) {
                this.logger.warn({ err }, 'v697 Sandbox-Skill registration failed (non-fatal)');
              }

              // v699/v698 Sandbox-API-Callbacks wären HIER richtig platziert wenn
              // der api-Adapter schon existieren würde — tut er aber nicht zu diesem
              // Zeitpunkt (Sandbox-Init läuft VOR Adapter-Setup). Die echten Callbacks
              // werden weiter unten registriert nachdem `apiAdapter` definiert ist.
              // siehe: "// v699/v700 — Wire Sandbox API" ~Zeile 5275
              // Folgender Block bleibt deaktiviert (kein Effekt — `this.adapters.get('api')`
              // returnt undefined an dieser Stelle):
              try {
                const httpAdapterCrud = this.adapters.get('api') as { setSandboxCallbacks?: (cb: Record<string, unknown>) => void } | undefined;
                if (httpAdapterCrud && typeof httpAdapterCrud.setSandboxCallbacks === 'function') {
                  const { execFile: execFileFn } = await import('node:child_process');
                  const { promisify: promisifyFn } = await import('node:util');
                  const execFileAsync = promisifyFn(execFileFn);
                  const projectsRepoCrud = this.projectRepo;
                  const resolveProjectCwdCrud = async (projectId: string): Promise<string | null> => {
                    if (!projectsRepoCrud) return null;
                    try { const p = await projectsRepoCrud.getByIdAnyOwner(projectId); return p?.cwd ?? null; } catch { return null; }
                  };
                  httpAdapterCrud.setSandboxCallbacks({
                    status: async () => sandboxManager.getStatus(),
                    list: async (filter: { projectId?: string; sessionId?: string }) => {
                      if (filter.sessionId) {
                        const sb = await sandboxRepo.getBySessionId(filter.sessionId);
                        return sb ? [sb] : [];
                      }
                      if (filter.projectId) {
                        return sandboxRepo.listByProject(filter.projectId);
                      }
                      return [];
                    },
                    getById: async (sandboxId: string) => {
                      const sb = await sandboxRepo.getById(sandboxId);
                      if (!sb) return null;
                      // v723 — DefaultBranch anreichern für korrekten Frontend-Merge-Dialog
                      let defaultBranch: string | undefined;
                      if (projectsRepoCrud) {
                        try {
                          const p = await projectsRepoCrud.getByIdAnyOwner(sb.projectId);
                          defaultBranch = p?.defaultBranch ?? undefined;
                        } catch { /* non-critical */ }
                      }
                      defaultBranch = defaultBranch ?? this.config.codeAgents?.forge?.baseBranch ?? 'main';
                      return { ...sb, defaultBranch };
                    },
                    create: async (input: { projectId: string; sessionId: string; mode: string; slug?: string }) => {
                      const cwd = await resolveProjectCwdCrud(input.projectId);
                      if (!cwd) throw new Error(`Project cwd unknown for project ${input.projectId}`);
                      const proj = projectsRepoCrud ? await projectsRepoCrud.getByIdAnyOwner(input.projectId) : null;
                      const userId = proj?.userId ?? this.ownerMasterUserId;
                      if (!userId) throw new Error('Cannot determine user for sandbox');
                      const r = await sandboxManager.createForSession({
                        sessionId: input.sessionId,
                        projectId: input.projectId,
                        userId,
                        projectCwd: cwd,
                        mode: input.mode as 'sandbox' | 'sandbox-preview' | 'interactive-chat',
                        slug: input.slug,
                      });
                      return r.sandbox;
                    },
                    pause: (sandboxId: string) => sandboxManager.pause(sandboxId),
                    resume: (sandboxId: string) => sandboxManager.resume(sandboxId),
                    discard: async (sandboxId: string) => {
                      const sb = await sandboxRepo.getById(sandboxId);
                      if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
                      const cwd = await resolveProjectCwdCrud(sb.projectId);
                      if (!cwd) throw new Error(`Project cwd unknown`);
                      await sandboxManager.discard(sandboxId, cwd);
                    },
                    merge: async (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string; confirmDirect?: boolean }) => {
                      const sb = await sandboxRepo.getById(sandboxId);
                      if (!sb) return { ok: false, reason: 'Sandbox not found' };
                      const cwd = await resolveProjectCwdCrud(sb.projectId);
                      if (!cwd) return { ok: false, reason: 'Project cwd unknown' };
                      const proj = projectsRepoCrud ? await projectsRepoCrud.getByIdAnyOwner(sb.projectId) : null;
                      const strat = (opts.strategy === 'direct' ? 'direct' : 'pr') as 'direct' | 'pr';
                      // v723 — Safety: direct-merge erfordert explizite Bestätigung
                      if (strat === 'direct' && opts.confirmDirect !== true) {
                        return { ok: false, reason: 'Direct-Merge erfordert explizite Bestätigung (confirmDirect=true im Request).' };
                      }
                      return sandboxManager.merge(sandboxId, {
                        strategy: strat,
                        commitMessage: opts.commitMessage,
                        prTitle: opts.prTitle,
                        prBody: opts.prBody,
                        projectCwd: cwd,
                        forgeConfig: this.config.codeAgents?.forge,
                        defaultBranch: proj?.defaultBranch ?? this.config.codeAgents?.forge?.baseBranch,
                        repoUrl: proj?.repoUrl,
                      });
                    },
                    diff: async (sandboxId: string) => {
                      const sb = await sandboxRepo.getById(sandboxId);
                      if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
                      try {
                        // v795 — gitInWorktree() für sudo-u-wrap (dubious-ownership-safe)
                        const { stdout } = await this.gitInWorktree(sb.worktreePath, ['diff', `${sb.baseCommitSha}..HEAD`], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
                        return stdout || '(no changes)';
                      } catch (err) {
                        return `# git diff failed: ${(err as Error).message}`;
                      }
                    },
                    // v728 — Restart/Logs/Stats für Toolbar im Interactive-Chat
                    restart: (sandboxId: string) => sandboxManager.restart(sandboxId),
                    getLogs: (sandboxId: string, tail: number) => sandboxManager.getLogs(sandboxId, tail),
                    getStats: (sandboxId: string) => sandboxManager.getStats(sandboxId),
                    // v748 — Force-Fail für stuck sandboxes
                    forceFail: (sandboxId: string, reason?: string) => sandboxManager.forceFail(sandboxId, reason),
                  });
                  this.logger.info('v699 Sandbox CRUD-API registered (v728: +restart/logs/stats)');
                }
              } catch (err) {
                this.logger.warn({ err }, 'v699 Sandbox CRUD-API registration failed (non-fatal)');
              }
            } else {
              this.logger.warn({ reasons: hc.reasons }, 'v697 Sandbox-Manager disabled (health-check failed) — classic-only mode');
            }

            // v755b — Storage-only callbacks (env, templates, seeds) + Sandbox-Proxy laufen
            // unabhängig vom Docker-Health-Check: das sind reine DB-Operationen die nicht
            // an einem laufenden Docker-Daemon hängen. Vorher 501-Fehler wenn Docker offline.

            // v728 — Environments-CRUD-API (WebUI-Zugriff auf project_environments via REST)
              try {
                const envHttpAdapter = this.adapters.get('api') as { setEnvironmentsCallbacks?: (cb: Record<string, unknown>) => void } | undefined;
                if (envHttpAdapter && typeof envHttpAdapter.setEnvironmentsCallbacks === 'function' && this.envRepoRef && this.envCryptoRef) {
                  const envRepoLocal = this.envRepoRef;
                  const envCryptoLocal = this.envCryptoRef;
                  envHttpAdapter.setEnvironmentsCallbacks({
                    listStages: async (projectId: string) => {
                      const entries = await envRepoLocal.listForProject(projectId);
                      return entries.map(e => {
                        let keyCount = 0;
                        try { keyCount = Object.keys(envCryptoLocal.decrypt(e.varsEncrypted, e.iv, e.authTag)).length; } catch { keyCount = -1; }
                        return { stage: e.stage, keyCount, updatedAt: e.updatedAt };
                      });
                    },
                    getVars: async (projectId: string, stage: string, reveal: boolean) => {
                      const entry = await envRepoLocal.get(projectId, stage);
                      if (!entry) return {};
                      const vars = envCryptoLocal.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
                      if (reveal) return vars;
                      const masked: Record<string, string> = {};
                      for (const [k, v] of Object.entries(vars)) {
                        masked[k] = v.length <= 4 ? '****' : v.slice(0, 2) + '****' + v.slice(-2);
                      }
                      return masked;
                    },
                    setVars: async (projectId: string, stage: string, vars: Record<string, string>, replace: boolean) => {
                      // Key-Format-Validation
                      for (const k of Object.keys(vars)) {
                        if (!/^[A-Z][A-Z0-9_]*$/.test(k)) {
                          return { ok: false, count: 0, reason: `Ungültiger Key "${k}" (erlaubt: A-Z, 0-9, _; muss mit Buchstabe beginnen)` };
                        }
                      }
                      const current = replace ? {} : (await (async () => {
                        const entry = await envRepoLocal.get(projectId, stage);
                        if (!entry) return {} as Record<string, string>;
                        return envCryptoLocal.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
                      })());
                      const merged = { ...current, ...vars };
                      const { ciphertext, iv, authTag } = envCryptoLocal.encrypt(merged);
                      await envRepoLocal.upsert({ projectId, stage, varsEncrypted: ciphertext, iv, authTag, encryptionVersion: 1 });
                      return { ok: true, count: Object.keys(merged).length };
                    },
                    deleteStage: async (projectId: string, stage: string) => {
                      await envRepoLocal.delete(projectId, stage);
                    },
                    // v732 — Repo-Scan via direkt-Lookup (re-implementiert die scan_repo-Logik aus environments-skill)
                    scanRepo: async (projectId: string) => {
                      if (!this.projectRepo) return { ok: false, reason: 'projectRepo nicht initialisiert' };
                      const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                      if (!proj || !proj.cwd) return { ok: false, reason: 'project oder cwd nicht gefunden' };
                      const { existsSync: ex, readFileSync, readdirSync, statSync } = await import('node:fs');
                      const pth = await import('node:path');
                      if (!ex(proj.cwd)) return { ok: false, reason: `cwd existiert nicht: ${proj.cwd}` };
                      const found = new Map<string, { sources: Set<string> }>();
                      for (const fn of ['.env.example', '.env.sample', '.env.template']) {
                        const p = pth.join(proj.cwd, fn);
                        if (!ex(p)) continue;
                        try {
                          const content = readFileSync(p, 'utf8');
                          for (const line of content.split('\n')) {
                            const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
                            if (m) {
                              const e = found.get(m[1]) ?? { sources: new Set<string>() };
                              e.sources.add(fn); found.set(m[1], e);
                            }
                          }
                        } catch { /* */ }
                      }
                      const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);
                      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.alfred-data', '.alfred-uploads', 'coverage']);
                      const walk = (dir: string, depth: number) => {
                        if (depth > 4) return;
                        let entries: import('node:fs').Dirent[] = [];
                        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
                        for (const e of entries) {
                          if (skipDirs.has(e.name)) continue;
                          const full = pth.join(dir, e.name);
                          if (e.isDirectory()) { walk(full, depth + 1); continue; }
                          const ext = pth.extname(e.name);
                          if (!codeExts.has(ext)) continue;
                          try {
                            if (statSync(full).size > 512 * 1024) continue;
                            const content = readFileSync(full, 'utf8');
                            const regexes = [
                              /process\.env\.([A-Z][A-Z0-9_]*)/g,
                              /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
                              /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
                              /\bos\.environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
                              /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
                            ];
                            for (const r of regexes) {
                              let m: RegExpExecArray | null;
                              while ((m = r.exec(content)) !== null) {
                                const key = m[1];
                                const e2 = found.get(key) ?? { sources: new Set<string>() };
                                e2.sources.add(pth.relative(proj.cwd!, full));
                                found.set(key, e2);
                              }
                            }
                          } catch { /* */ }
                        }
                      };
                      walk(proj.cwd, 0);
                      const keys = Array.from(found.entries())
                        .sort((a, b) => a[0].localeCompare(b[0]))
                        .map(([key, info]) => ({ key, sources: Array.from(info.sources).slice(0, 5) }));
                      return { ok: true, keys };
                    },
                  });
                  this.logger.info('v728 Environments CRUD-API registered (v732: +scanRepo)');
                }
              } catch (err) {
                this.logger.warn({ err }, 'v728 Environments API registration failed (non-fatal)');
              }

              // v751 — Sandbox-Templates-CRUD-API
              try {
                const tplHttpAdapter = this.adapters.get('api') as { setSandboxTemplatesCallbacks?: (cb: Record<string, unknown>) => void } | undefined;
                if (tplHttpAdapter && typeof tplHttpAdapter.setSandboxTemplatesCallbacks === 'function') {
                  const { SandboxTemplateRepository } = await import('@alfred/storage');
                  const tplRepo = new SandboxTemplateRepository(adapter);
                  const ownerUid = () => this.tryOwner() ?? '';
                  tplHttpAdapter.setSandboxTemplatesCallbacks({
                    list: async (projectId: string | null | undefined) => {
                      const uid = ownerUid();
                      if (!uid) return [];
                      const templates = await tplRepo.listForUser(uid, projectId === undefined ? undefined : projectId);
                      return templates.map(t => ({
                        id: t.id, projectId: t.projectId, name: t.name, description: t.description,
                        mode: t.mode, envStage: t.envStage, dbSeedId: t.dbSeedId, initialGoal: t.initialGoal,
                        tags: t.tags, createdAt: t.createdAt, updatedAt: t.updatedAt,
                      }));
                    },
                    create: async (input: {
                      projectId?: string | null;
                      name: string;
                      description?: string;
                      mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
                      envStage?: string;
                      dbSeedId?: string;
                      initialGoal?: string;
                      tags?: string[];
                    }) => {
                      const uid = ownerUid();
                      if (!uid) return { ok: false, reason: 'Kein Owner-User' };
                      try {
                        const t = await tplRepo.create({ ...input, userId: uid });
                        return { ok: true, id: t.id };
                      } catch (err) { return { ok: false, reason: (err as Error).message }; }
                    },
                    update: async (id: string, patch: Record<string, unknown>) => {
                      try {
                        const ok = await tplRepo.update(id, patch as never);
                        return ok ? { ok: true } : { ok: false, reason: 'Template nicht gefunden' };
                      } catch (err) { return { ok: false, reason: (err as Error).message }; }
                    },
                    delete: async (id: string) => {
                      try { await tplRepo.delete(id); return { ok: true }; }
                      catch (err) { return { ok: false, reason: (err as Error).message }; }
                    },
                  });
                  this.logger.info('v751 Sandbox-Templates CRUD-API registered');
                }
              } catch (err) {
                this.logger.warn({ err }, 'v751 Sandbox-Templates API registration failed (non-fatal)');
              }

              // v732 — DB-Seeds-CRUD-API
              try {
                const seedsHttpAdapter = this.adapters.get('api') as { setDbSeedsCallbacks?: (cb: Record<string, unknown>) => void } | undefined;
                if (seedsHttpAdapter && typeof seedsHttpAdapter.setDbSeedsCallbacks === 'function' && this.dbSeedRepoRef && this.projectRepo) {
                  const seedRepoLocal = this.dbSeedRepoRef;
                  const projRepoLocal = this.projectRepo;
                  const uploadsPath = this.config.sandbox?.uploadSeedsPath ?? '/var/alfred/db-seeds';
                  // v808 — Defense-in-depth: prüft ob projectId dem aktuellen Owner gehört.
                  const verifyProjectOwner = async (projectId: string): Promise<boolean> => {
                    const ownerId = this.tryOwner();
                    if (!ownerId) return false;
                    try {
                      const proj = await projRepoLocal.getByIdAnyOwner(projectId);
                      return !!proj && proj.userId === ownerId;
                    } catch { return false; }
                  };
                  seedsHttpAdapter.setDbSeedsCallbacks({
                    list: async (projectId: string) => {
                      if (!(await verifyProjectOwner(projectId))) return [];
                      const seeds = await seedRepoLocal.listForProject(projectId);
                      return seeds.map(s => ({
                        id: s.id,
                        name: s.name,
                        kind: s.kind,
                        storageRef: s.storageRef,
                        sizeBytes: s.sizeBytes,
                        createdAt: s.createdAt,
                      }));
                    },
                    upload: async (projectId: string, name: string, dataBase64: string) => {
                      try {
                        if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                        const fs = await import('node:fs');
                        const pth2 = await import('node:path');
                        // Filename sanitization
                        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
                        const projDir = pth2.join(uploadsPath, projectId);
                        fs.mkdirSync(projDir, { recursive: true, mode: 0o755 });
                        const target = pth2.join(projDir, `${Date.now()}_${safeName}`);
                        const buf = Buffer.from(dataBase64, 'base64');
                        if (buf.length > 100 * 1024 * 1024) {
                          return { ok: false, reason: 'Seed-File zu groß (max 100 MB)' };
                        }
                        fs.writeFileSync(target, buf, { mode: 0o644 });
                        // storage_ref = relative pfad zu uploadsPath
                        const relRef = pth2.relative(uploadsPath, target);
                        const seed = await seedRepoLocal.create({
                          projectId,
                          name: safeName,
                          kind: 'upload',
                          storageRef: relRef,
                          sizeBytes: buf.length,
                        });
                        return { ok: true, seedId: seed.id };
                      } catch (err) {
                        return { ok: false, reason: (err as Error).message };
                      }
                    },
                    registerRepoPath: async (projectId: string, name: string, repoPath: string) => {
                      try {
                        if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                        const proj = await projRepoLocal.getByIdAnyOwner(projectId).catch(() => null);
                        if (!proj || !proj.cwd) return { ok: false, reason: 'project oder cwd nicht gefunden' };
                        const fs = await import('node:fs');
                        const pth3 = await import('node:path');
                        const fullPath = pth3.resolve(proj.cwd, repoPath);
                        if (!fullPath.startsWith(pth3.resolve(proj.cwd))) {
                          return { ok: false, reason: 'repoPath verlässt projectCwd' };
                        }
                        let sizeBytes = 0;
                        try { sizeBytes = fs.statSync(fullPath).size; } catch { return { ok: false, reason: `Datei nicht gefunden: ${repoPath}` }; }
                        const seed = await seedRepoLocal.create({
                          projectId,
                          name: name.slice(0, 150),
                          kind: 'repo_path',
                          storageRef: repoPath,
                          sizeBytes,
                        });
                        return { ok: true, seedId: seed.id };
                      } catch (err) {
                        return { ok: false, reason: (err as Error).message };
                      }
                    },
                    delete: async (projectId: string, seedId: string) => {
                      try {
                        if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                        const seed = await seedRepoLocal.getById(seedId);
                        if (!seed) return { ok: false, reason: 'Seed nicht gefunden' };
                        if (seed.projectId !== projectId) return { ok: false, reason: 'Seed gehört zu anderem Project' };
                        if (seed.kind === 'upload') {
                          try {
                            const pth4 = await import('node:path');
                            const fs2 = await import('node:fs');
                            const fullPath = pth4.resolve(uploadsPath, seed.storageRef);
                            if (fullPath.startsWith(pth4.resolve(uploadsPath)) && fs2.existsSync(fullPath)) {
                              fs2.unlinkSync(fullPath);
                            }
                          } catch (err) {
                            this.logger.warn({ err, seedId }, 'v732 upload-file unlink failed (continuing)');
                          }
                        }
                        // Wenn dieser Seed der project.default_db_seed_id war: zurücksetzen
                        try {
                          await this.database!.getAdapter().execute(
                            `UPDATE projects SET default_db_seed_id = NULL WHERE default_db_seed_id = ?`,
                            [seedId],
                          );
                        } catch { /* */ }
                        await seedRepoLocal.delete(seedId);
                        return { ok: true };
                      } catch (err) {
                        return { ok: false, reason: (err as Error).message };
                      }
                    },
                    setDefault: async (projectId: string, seedId: string | null) => {
                      try {
                        if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                        if (seedId) {
                          const seed = await seedRepoLocal.getById(seedId);
                          if (!seed) return { ok: false, reason: 'Seed nicht gefunden' };
                          if (seed.projectId !== projectId) return { ok: false, reason: 'Seed gehört zu anderem Project' };
                        }
                        await this.database!.getAdapter().execute(
                          `UPDATE projects SET default_db_seed_id = ? WHERE id = ?`,
                          [seedId, projectId],
                        );
                        return { ok: true };
                      } catch (err) {
                        return { ok: false, reason: (err as Error).message };
                      }
                    },
                  });
                  this.logger.info('v732 DB-Seeds CRUD-API registered');
                }
              } catch (err) {
                this.logger.warn({ err }, 'v732 DB-Seeds API registration failed (non-fatal)');
              }

              // v698 — Sandbox-Preview-Proxy-Resolver registrieren. Validiert pro Request:
              // (a) Token → User, (b) Sandbox-Ownership, (c) Status === 'running'.
              try {
                const httpAdapter = this.adapters.get('api') as { setSandboxProxyResolver?: (fn: (id: string, token: string | null) => Promise<unknown>) => void } | undefined;
                if (httpAdapter && typeof httpAdapter.setSandboxProxyResolver === 'function' && this.webAuthCallback) {
                  const authCb = this.webAuthCallback;
                  httpAdapter.setSandboxProxyResolver(async (sandboxId, token) => {
                    if (!token) return { ok: false, status: 401, message: 'Missing token' };
                    const user = await authCb.getUserByToken(token);
                    if (!user) return { ok: false, status: 401, message: 'Invalid or expired token' };
                    const sb = await sandboxRepo.getById(sandboxId);
                    if (!sb) return { ok: false, status: 404, message: 'Sandbox not found' };
                    if (sb.userId !== user.userId) return { ok: false, status: 403, message: 'You do not own this sandbox' };
                    if (sb.status !== 'running') return { ok: false, status: 409, message: `Sandbox is ${sb.status} — not running` };
                    if (typeof sb.hostPort !== 'number') return { ok: false, status: 503, message: 'Sandbox has no host port' };
                    // Activity-Touch (idle-timer-Reset)
                    sandboxRepo.touchActivity(sandboxId).catch(() => { /* */ });
                    return { ok: true, hostPort: sb.hostPort, userId: sb.userId };
                  });
                  this.logger.info('v698 Sandbox-Preview-Proxy registered (/preview/<sandboxId>/*)');
                }
              } catch (err) {
                this.logger.warn({ err }, 'v698 Sandbox-Proxy resolver registration failed (non-fatal)');
              }
          } catch (err) {
            this.logger.warn({ err }, 'v697 Sandbox-Manager wiring failed (non-fatal, classic-only mode)');
          }
        }

        // Schedule periodic auto-discovery
        const discoveryIntervalH = this.config.cmdb?.autoDiscoveryIntervalHours ?? 24;
        if (discoveryIntervalH > 0) {
          const discoveryMs = discoveryIntervalH * 3_600_000;
          setTimeout(() => {
            const uid = this.tryOwner() || '';
            if (uid) cmdbSkill.execute({ action: 'discover' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            this.cmdbDiscoveryTimer = setInterval(() => {
              if (uid) cmdbSkill.execute({ action: 'discover' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            }, discoveryMs);
          }, 120_000);
          this.logger.info({ intervalHours: discoveryIntervalH }, 'CMDB auto-discovery scheduled');
        }

        // Schedule periodic health checks
        const healthCheckMin = this.config.cmdb?.healthCheckIntervalMinutes ?? 60;
        if (healthCheckMin > 0) {
          const healthMs = healthCheckMin * 60_000;
          setTimeout(() => {
            const uid = this.tryOwner() || '';
            const runHealthCheck = () => {
              if (uid) itsmSkill.execute({ action: 'health_check' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            };
            runHealthCheck();
            this.cmdbHealthCheckTimer = setInterval(runHealthCheck, healthMs);
          }, 180_000); // 3 min after startup
        }

        this.logger.info('CMDB + ITSM + InfraDocs skills registered');
      }
    }

    // 4p. Marketplace (willhaben + eBay — willhaben always available, eBay needs credentials)
    {
      const { MarketplaceSkill } = await import('@alfred/skills');
      skillRegistry.register(new MarketplaceSkill(this.config.marketplace));
      this.logger.info('Marketplace skill registered');
    }

    // Shopping / Preisvergleich (immer registriert — Geizhals braucht keinen Key)
    {
      const { ShoppingSkill } = await import('@alfred/skills');
      skillRegistry.register(new ShoppingSkill());
      this.logger.info('Shopping skill registered');
    }

    // 4q. Briefing (always available — gathers data from registered skills, reads memories for addresses)
    {
      const { BriefingSkill } = await import('@alfred/skills');
      skillRegistry.register(new BriefingSkill(skillRegistry, this.config, memoryRepo));
      this.logger.info('Briefing skill registered');
    }

    // 4s. Feed reader (always available — stores subscriptions in skill_state)
    skillRegistry.register(new FeedReaderSkill(skillStateRepo));
    this.logger.info('Feed reader skill registered');

    // 4s2. Help skill (always available — shows available skills)
    // ROLE_SKILL_ACCESS is imported later; we set it after user management init
    const helpSkill = new HelpSkill(skillRegistry);
    skillRegistry.register(helpSkill);

    // 4s3. Onboarding (always available)
    {
      const { OnboardingSkill } = await import('@alfred/skills');
      const onboardingSkill = new OnboardingSkill();
      if (memoryRepo) {
        const uid = this.ownerMasterUserId || '';
        onboardingSkill.setMemoryCallback(async (key, value, type, category) => {
          await memoryRepo.saveWithMetadata(uid, key, value, category, type as any, 1.0, 'manual');
        });
      }
      skillRegistry.register(onboardingSkill);
    }

    // 4t. User Management (always available)
    {
      const { AlfredUserRepository } = await import('@alfred/storage');
      const { UserManagementSkill } = await import('@alfred/skills');
      const alfredUserRepo = new AlfredUserRepository(adapter);

      // Auto-create admin user from ownerUserId if not exists
      // Link to ALL enabled platforms (not just Telegram)
      if (this.config.security?.ownerUserId) {
        const ownerUid = this.config.security.ownerUserId;
        const allUsers = await alfredUserRepo.getAll();
        const admins = allUsers.filter(u => u.role === 'admin');
        let adminUser = admins[0];

        if (!adminUser) {
          adminUser = await alfredUserRepo.create({ username: 'admin', role: 'admin', displayName: 'Admin' });
          await alfredUserRepo.clearInviteCode(adminUser.id);
          this.logger.info({ userId: ownerUid }, 'Auto-created admin user from ownerUserId');
        }

        // Link to all configured platforms with the ownerUserId
        const platforms = ['telegram', 'discord', 'matrix', 'signal', 'api'] as const;
        for (const platform of platforms) {
          const existing = await alfredUserRepo.getUserByPlatform(platform, ownerUid);
          if (!existing) {
            try { await alfredUserRepo.linkPlatform(adminUser.id, platform, ownerUid); } catch { /* already linked */ }
          }
        }
        // Resolve the MASTER user ID (from `users` table, not `alfred_users` table)
        // adminUser.id is the alfred_users ID — we need the users.master_user_id instead
        // v804 — IdentityResolver: behandelt UUID + Platform-ID Format automatisch.
        // Vorher hardcoded 'telegram' platform → wenn env-var UUID war, wurde ein neuer
        // user mit platform='telegram' + platform_user_id=UUID erstellt (Doppel-User-Bug).
        try {
          const { IdentityResolver } = await import('./identity/resolver.js');
          this.identityResolver = new IdentityResolver(userRepo, this.projectRepo, this.logger.child({ component: 'identity-resolver' }));
          const ownerPlatformHint = (this.config.security as { ownerPlatform?: string })?.ownerPlatform ?? 'telegram';
          const resolvedOwner = await this.identityResolver.resolveOwnerFromConfig(
            this.config.security.ownerUserId,
            ownerPlatformHint,
          );
          // Apply master-id resolution für linked-account-Setups
          this.ownerMasterUserId = await this.identityResolver.resolveMasterId(resolvedOwner);
          this.logger.info({
            envValue: this.config.security.ownerUserId.slice(0, 12) + '…',
            resolved: this.ownerMasterUserId.slice(0, 8) + '…',
            platformHint: ownerPlatformHint,
          }, 'v804 ownerMasterUserId resolved via IdentityResolver');
        } catch (err) {
          this.logger.error({ err, ownerUserId: this.config.security.ownerUserId }, 'v804 IdentityResolver failed — fallback to adminUser.id (may not be valid UUID for Project-Lookups)');
          // Fallback: best-effort cast
          const { tryUserUUID } = await import('@alfred/types');
          this.ownerMasterUserId = tryUserUUID(adminUser.id);
        }

        // v808 — UserIdAuditScanner: scannt DB-Tabellen mit user_id-Spalten, flaggt
        // non-UUID-Werte in user_id_format_audit. Best-effort, non-blocking.
        try {
          const { UserIdAuditScanner } = await import('./identity/audit-scanner.js');
          const scanner = new UserIdAuditScanner(adapter, this.logger.child({ component: 'user-id-audit' }));
          // Fire-and-forget — der Scan darf den Startup nicht blockieren.
          void scanner.scan().catch((err) => {
            this.logger.debug({ err }, 'v808 UserIdAuditScanner background-scan failed (non-fatal)');
          });
        } catch (err) {
          this.logger.debug({ err }, 'v808 UserIdAuditScanner import/init failed (non-fatal)');
        }

        // v694 — Legacy-Daten-UIDs aufspüren. Pre-multi-user-Migration hat KG/Conversation-
        // Daten unter alten user-ids hinterlassen, die nicht (mehr) in alfred_users stehen.
        // Wir ziehen sie nur dann in Sweeps/Question-Generator rein, wenn der sweepende UID
        // === ownerMasterUserId (sonst würde Gast-User Owner-Daten sehen).
        try {
          const rows = await adapter.query(`
            SELECT user_id, SUM(n) AS total FROM (
              SELECT user_id, COUNT(*) AS n FROM kg_entities GROUP BY user_id
              UNION ALL
              SELECT user_id, COUNT(*) AS n FROM conversations GROUP BY user_id
            ) t
            WHERE user_id NOT IN (SELECT id FROM alfred_users)
              AND user_id != ?
            GROUP BY user_id
            HAVING SUM(n) > 50
          `, [this.ownerMasterUserId]);
          this.legacyDataUids = rows.map(r => String(r.user_id)).filter(Boolean);
          if (this.legacyDataUids.length > 0) {
            this.logger.info({ legacyUids: this.legacyDataUids, count: this.legacyDataUids.length }, 'v694 Legacy data UIDs discovered — will be merged into owner sweeps');
          }
        } catch (err) {
          this.logger.debug({ err }, 'v694 Legacy-UID discovery skipped');
        }
      }

      // Resolve Microsoft App credentials for Device Code Flow + shared resource setup
      const msAppCredentials = (() => {
        const ms = this.config.email?.accounts?.[0]?.microsoft
          ?? (this.config.email as any)?.microsoft
          ?? this.config.calendar?.microsoft
          ?? this.config.contacts?.microsoft
          ?? (this.config.todo as any);
        if (ms?.clientId && ms?.clientSecret) return { clientId: ms.clientId as string, clientSecret: ms.clientSecret as string, tenantId: ms.tenantId as string | undefined };
        return undefined;
      })();
      // Collect full MS configs per service type for add_shared_resource
      const msGlobalConfigs: Record<string, Record<string, unknown>> = {};
      if (this.config.calendar?.microsoft) msGlobalConfigs.calendar = { provider: 'microsoft', microsoft: this.config.calendar.microsoft };
      if (this.config.contacts?.microsoft) msGlobalConfigs.contacts = { provider: 'microsoft', microsoft: this.config.contacts.microsoft };
      const emailMs = this.config.email?.accounts?.[0]?.microsoft ?? (this.config.email as any)?.microsoft;
      if (emailMs) msGlobalConfigs.email = { provider: 'microsoft', microsoft: emailMs };
      if (this.config.todo?.clientId) msGlobalConfigs.todo = { ...(this.config.todo as unknown as Record<string, unknown>) };
      skillRegistry.register(new UserManagementSkill(alfredUserRepo, msAppCredentials, Object.keys(msGlobalConfigs).length > 0 ? msGlobalConfigs : undefined));
      this.logger.info('User management skill registered');

      // Wire Alfred user lookup into CrossPlatformSkill for send_to_user
      crossPlatformSkill.setAlfredUserLookup(alfredUserRepo);

      // Sharing skill
      const { SharingSkill } = await import('@alfred/skills');
      const { SharedResourceRepository } = await import('@alfred/storage');
      const sharedResourceRepo = new SharedResourceRepository(adapter);
      skillRegistry.register(new SharingSkill(sharedResourceRepo, alfredUserRepo));
      // Wire shared resources into skills for visibility checks
      (documentSkill as any).sharedResourceRepo = sharedResourceRepo;
      (noteSkill as any).sharedResourceRepo = sharedResourceRepo;
      (todoSkill as any).sharedResourceRepo = sharedResourceRepo;
      this.logger.info('Sharing skill registered');

      // Setup web auth callback for HTTP API login (persistent via link_tokens table)
      const webLinkTokenRepo = linkTokenRepo;
      this.webAuthCallback = {
        loginWithCode: async (code: string) => {
          const tempWebId = `web-pending-${Date.now()}`;
          const user = await alfredUserRepo.consumeInviteCode(code, 'api', tempWebId);
          if (!user) return { success: false, error: 'Ungültiger oder abgelaufener Code' };

          const token = `alf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          // Persist session token (expires in 30 days)
          const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
          await webLinkTokenRepo.createSession(token, user.id, 'web-session', expires);

          return { success: true, userId: user.id, username: user.username, role: user.role, token };
        },
        getUserByToken: async (token: string) => {
          const entry = await webLinkTokenRepo.findByToken(token);
          if (!entry) return null;
          // Check expiry
          if (new Date(entry.expiresAt) < new Date()) return null;
          const user = await alfredUserRepo.getById(entry.userId);
          if (!user) return null;
          return { userId: user.id, username: user.username, role: user.role };
        },
      };
    }

    // 4u. Database (optional)
    if (this.config.database?.enabled) {
      const { DatabaseSkill } = await import('@alfred/skills');
      const { DatabaseConnectionRepository } = await import('@alfred/storage');
      const dbConnRepo = new DatabaseConnectionRepository(adapter);
      const dbSkill = new DatabaseSkill(this.config.database, dbConnRepo);

      // Pre-load connections from config
      if (this.config.database.connections) {
        for (const conn of this.config.database.connections) {
          if (!(await dbConnRepo.getByName(conn.name))) {
            await dbConnRepo.create({
              name: conn.name, type: conn.type, host: conn.host, port: conn.port,
              databaseName: conn.database, username: conn.username,
              authConfig: conn.password ? { password: conn.password } : undefined,
              options: { readOnly: conn.options?.readOnly ?? true, rowLimit: conn.options?.rowLimit, timeoutMs: conn.options?.timeoutMs },
            });
          }
        }
      }

      skillRegistry.register(dbSkill);
      this.logger.info('Database skill registered');
    }

    // 4u-backup. System Backup (optional)
    if (this.config.backup?.enabled) {
      const { SystemBackupSkill } = await import('@alfred/skills');
      const pkg = await import('../../cli/package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: 'unknown' } }));
      const backupSkill = new SystemBackupSkill(
        this.config.backup,
        adapter,
        this.config.cluster?.nodeId ?? 'single',
        pkg.default.version ?? 'unknown',
        this.config.fileStore,
      );
      skillRegistry.register(backupSkill);
      this.logger.info('System Backup skill registered');
    }

    // 4u-commvault. Commvault Backup Management (optional)
    if (this.config.commvault?.enabled) {
      const { CommvaultSkill } = await import('@alfred/skills');
      const cvSkill = new CommvaultSkill(this.config.commvault);
      // Wire ITSM callback for auto-incident creation
      if (this.config.cmdb?.autoIncidentFromMonitor) {
        const itsmSkill = skillRegistry.get('itsm');
        if (itsmSkill) {
          cvSkill.setItsmCallback(async (input) => {
            return itsmSkill.execute(input, { alfredUserId: this.ownerMasterUserId } as any);
          });
        }
      }
      skillRegistry.register(cvSkill);
      this.logger.info('Commvault skill registered');
    }

    // MikroTik ITSM callback wiring (skill already registered before CMDB)
    if (this.config.mikrotik?.enabled && this.config.cmdb?.autoIncidentFromMonitor) {
      const mtSkill = skillRegistry.get('mikrotik') as any;
      const itsmSkill = skillRegistry.get('itsm');
      if (mtSkill && itsmSkill) {
        mtSkill.setItsmCallback(async (input: Record<string, unknown>) => {
          return itsmSkill.execute(input, { alfredUserId: this.ownerMasterUserId } as any);
        });
      }
    }

    // 4u. YouTube (optional, requires API key)
    if (this.config.youtube?.apiKey) {
      const { YouTubeSkill } = await import('@alfred/skills');
      skillRegistry.register(new YouTubeSkill(this.config.youtube));
      this.logger.info('YouTube skill registered');
    }

    this.logger.info({ skills: skillRegistry.getAll().map(s => s.metadata.name) }, 'Skills registered');

    // 5. Initialize speech-to-text (optional)
    // Auto-populate STT/TTS API keys from Mistral LLM provider when not explicitly set
    if (this.config.speech) {
      if (this.config.speech.sttProvider === 'mistral' && !this.config.speech.sttApiKey && mistralApiKey) {
        this.config.speech.sttApiKey = mistralApiKey;
      }
      if (this.config.speech.ttsProvider === 'mistral' && !this.config.speech.ttsApiKey && mistralApiKey) {
        this.config.speech.ttsApiKey = mistralApiKey;
      }
    }

    let speechTranscriber: SpeechTranscriber | undefined;
    if (this.config.speech?.apiKey) {
      speechTranscriber = new SpeechTranscriber(
        this.config.speech,
        this.logger.child({ component: 'speech' }),
      );
      speechTranscriber.setUsageCallback((model, units) => {
        serviceUsageRepo.record('stt', model, units).catch(() => {});
      });
      const effectiveSttProvider = this.config.speech.sttProvider ?? this.config.speech.provider;
      this.logger.info({ provider: effectiveSttProvider }, 'Speech-to-text initialized');

      // v644 — Wire transcribe endpoint into HTTP-Adapter
      const apiAdapterForStt = this.adapters.get('api');
      if (apiAdapterForStt && 'setTranscribeCallback' in apiAdapterForStt) {
        (apiAdapterForStt as any).setTranscribeCallback(async (audio: Buffer, mimeType: string) => {
          return speechTranscriber!.transcribe(audio, mimeType);
        });
        this.logger.info('Transcribe API endpoint registered (/api/transcribe)');
      }
    }

    // 5b. Initialize text-to-speech (optional)
    if (this.config.speech?.ttsEnabled) {
      const synthesizer = new SpeechSynthesizer(
        this.config.speech,
        this.logger.child({ component: 'tts' }),
      );
      synthesizer.setSkillState(skillStateRepo);
      synthesizer.setUsageCallback((model, units) => {
        serviceUsageRepo.record('tts', model, units).catch(() => {});
      });
      skillRegistry.register(new TTSSkill(synthesizer));
      const effectiveTtsProvider = this.config.speech.ttsProvider ?? 'openai';
      this.logger.info({ provider: effectiveTtsProvider }, 'Text-to-speech skill registered');
    }

    // 5b2. Initialize voice management skill (optional — requires Mistral TTS + API key)
    {
      const speechCfg = this.config.speech;
      const voiceMgmtEnabled = speechCfg?.ttsProvider === 'mistral'
        && speechCfg.voiceManagement !== false;
      const voiceApiKey = speechCfg?.ttsApiKey ?? mistralApiKey;
      if (voiceMgmtEnabled && voiceApiKey && memoryRepo) {
        // Determine announce base URL for Sonos TTS integration
        // IMPORTANT: Sonos speakers cannot access HTTPS with self-signed certs.
        // Always use HTTP for announce URLs. Sonos and Alfred are on the same LAN.
        let announceBaseUrl: string;
        // Find first non-loopback IPv4 address for LAN accessibility
        let lanIp = 'localhost';
        const interfaces = os.networkInterfaces();
        for (const nets of Object.values(interfaces)) {
          if (!nets) continue;
          for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) {
              lanIp = net.address;
              break;
            }
          }
          if (lanIp !== 'localhost') break;
        }
        const port = this.config.api?.port ?? 3420;
        // When TLS is enabled, the HTTP fallback for Sonos runs on port+2 (e.g., 3422; port+1 is cluster discovery)
        const announcePort = this.config.api?.tls?.enabled ? port + 2 : port;
        announceBaseUrl = `http://${lanIp}:${announcePort}`;
        skillRegistry.register(new VoiceSkill(
          voiceApiKey, 'https://api.mistral.ai/v1', 'voxtral-mini-tts-2603',
          memoryRepo, skillRegistry, announceBaseUrl, skillStateRepo,
        ));
        this.logger.info({ announceBaseUrl }, 'Voice management skill registered');
      }
    }

    // 5c. Initialize image generation (auto-detect from LLM config)
    const imageGenProvider = this.detectImageGenProvider();
    if (imageGenProvider) {
      const generator = new ImageGenerator(imageGenProvider, this.logger.child({ component: 'image-gen' }));
      skillRegistry.register(new ImageGenerateSkill(generator));
      this.logger.info({ provider: imageGenProvider.provider }, 'Image generation skill registered');
    }

    // 5d. Initialize public transit (always available, no config needed)
    try {
      const transitClient = new TransitClient(this.logger.child({ component: 'transit' }));
      skillRegistry.register(new TransitSkill(transitClient));
      this.logger.info('Public transit skill registered');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to register transit skill');
    }

    // 5f. Initialize file store (optional — defaults to local fs)
    let fileStore: import('@alfred/storage').FileStore | undefined;
    if (this.config.fileStore) {
      const { createFileStore } = await import('@alfred/storage');
      fileStore = createFileStore(this.config.fileStore);
      this.fileStoreRef = fileStore; // v673 — auch im Adapter-Wiring nutzbar
      this.logger.info({ backend: this.config.fileStore.backend }, 'File store initialized');
    }
    // v604 L8 — inject file-store into project-agent-runner if both are present.
    // Enables asset-bridge (chat-attached files become uploads/ in cwd).
    if (fileStore && this.projectAgentRunnerRef) {
      this.projectAgentRunnerRef.setFileStore(fileStore);
      this.logger.info('Project-agent runner connected to file-store for asset-bridge');
    }

    // 6. Create conversation manager and pipeline
    const conversationManager = new ConversationManager(conversationRepo);
    // Derive inbox path from storage path (e.g. ./data/alfred.db → ./data/inbox)
    const inboxPath = path.resolve(path.dirname(this.config.storage.path), 'inbox');
    this.pipeline = new MessagePipeline({
      llm: llmProvider,
      conversationManager,
      users: userRepo,
      logger: this.logger.child({ component: 'pipeline' }),
      skillRegistry,
      skillSandbox,
      securityManager,
      memoryRepo,
      speechTranscriber,
      inboxPath,
      fileStore,
      processedMessageRepo: this.config.cluster?.enabled
        ? new (await import('@alfred/storage')).ProcessedMessageRepository(adapter)
        : undefined,
      nodeId: this.config.cluster?.nodeId ?? 'single',
      embeddingService,
      activeLearning,
      memoryRetriever,
      maxHistoryMessages: this.config.conversation?.maxHistoryMessages ?? 100,
      documentProcessor,
      conversationSummarizer,
      personality: this.config.personality,
    });

    // 5e. Initialize cluster manager BEFORE schedulers
    if (this.config.cluster?.enabled) {
      // HA requires PostgreSQL
      if (adapter.type !== 'postgres') {
        throw new Error('HA Cluster erfordert storage.backend: "postgres". SQLite ist nicht für Multi-Node geeignet.');
      }
      if (!this.config.cluster.nodeId) {
        throw new Error('HA Cluster erfordert cluster.nodeId. Jeder Node braucht eine eindeutige ID.');
      }
      // FileStore warning
      if (!this.config.fileStore || this.config.fileStore.backend === 'local') {
        this.logger.warn('HA Cluster ohne S3/NFS FileStore — Datei-Uploads sind nur auf dem empfangenden Node sichtbar. Empfohlen: fileStore.backend: "s3" oder "nfs"');
      }

      const { ClusterManager } = await import('./cluster/cluster-manager.js');
      this.clusterManager = new ClusterManager(
        this.config.cluster,
        this.logger.child({ component: 'cluster' }),
      );
      await this.clusterManager.connect();
      if (!this.clusterManager.isConnected) {
        this.logger.warn('Redis nicht erreichbar — Cross-Node Pub/Sub und Echtzeit-Heartbeat deaktiviert. PG-Heartbeat als Fallback aktiv.');
      }
      // Run PG migrations BEFORE heartbeat (tables must exist first)
      const { PgMigrator, PG_MIGRATIONS } = await import('@alfred/storage');
      const pgMigrator = new PgMigrator(adapter);
      await pgMigrator.migrate(PG_MIGRATIONS);
      // Start PG heartbeat as fallback
      this.clusterManager.startPgHeartbeat(adapter);

      this.logger.info({ nodeId: this.config.cluster.nodeId }, 'Cluster manager initialized (Active-Active)');
    }

    // 6. Initialize reminder scheduler
    this.reminderScheduler = new ReminderScheduler(
      reminderRepo,
      async (platform, chatId, text) => {
        const adapter = this.adapters.get(platform);
        if (adapter) {
          await adapter.sendMessage(chatId, text);
        } else {
          this.logger.warn({ platform, chatId }, 'No adapter for reminder platform');
        }
      },
      this.logger.child({ component: 'reminders' }),
      15_000,
      {
        getMasterUserId: (userId) => userRepo.getMasterUserId(userId),
        getLinkedUsers: (masterUserId) => userRepo.getLinkedUsers(masterUserId),
        findConversation: (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId),
      },
      this.config.cluster?.nodeId ?? 'single',
    );

    // 7b. Initialize background task runner
    this.backgroundTaskRunner = new BackgroundTaskRunner(
      skillRegistry,
      skillSandbox,
      backgroundTaskRepo,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'background-tasks' }),
      activityLogger,
      skillHealthTracker,
    );

    // 7b2. Initialize persistent agent runner (checkpoint/resume for long-running tasks)
    const persistentRunner = new PersistentAgentRunner(
      skillRegistry,
      skillSandbox,
      backgroundTaskRepo,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'persistent-agents' }),
      activityLogger,
    );
    this.backgroundTaskRunner.setPersistentRunner(persistentRunner);
    backgroundTaskSkill.setPersistentRunner(persistentRunner);

    // 7c. Initialize proactive scheduler
    this.proactiveScheduler = new ProactiveScheduler(
      scheduledActionRepo,
      skillRegistry,
      skillSandbox,
      llmProvider,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'proactive-scheduler' }),
      this.pipeline,
      this.formatter,
      conversationManager,
      activityLogger,
      this.config.cluster?.nodeId ?? 'single',
    );

    // 7d. Initialize watch engine (condition-based alerts)
    const watchRepo = new WatchRepository(adapter);
    this.watchRepo = watchRepo;
    skillRegistry.register(new WatchSkill(watchRepo, skillRegistry));

    // 7e. Initialize confirmation queue (human-in-the-loop for watch actions)
    const confirmRepo = new ConfirmationRepository(adapter);
    this.confirmationQueue = new ConfirmationQueue(
      confirmRepo,
      skillRegistry,
      skillSandbox,
      this.adapters,
      this.logger.child({ component: 'confirmation-queue' }),
      activityLogger,
    );

    // 7e2. Initialize feedback service (rejection/correction tracking)
    const feedbackRepo = new FeedbackRepository(adapter);
    const feedbackService = new FeedbackService(
      feedbackRepo,
      memoryRepo,
      this.logger.child({ component: 'feedback' }),
    );
    feedbackService.setLLM(llmProvider);
    // v606 K4 — embedding-based dedup for new corrections/preferences/rules.
    // Uses llmProvider.embed() directly (returns { embedding: number[] }).
    if (llmProvider.supportsEmbeddings()) {
      feedbackService.setEmbeddingService(llmProvider);
    }
    // v606 K5 — one-shot migration of existing feedback:correction memories.
    // Re-classifies via LLM and routes to correct memory-type (or deletes).
    // Gated by an internal marker memory so it runs at most once per user.
    setTimeout(() => {
      const ownerUid = this.tryOwner();
      if (ownerUid) {
        feedbackService.migrateCorrectionMemories(ownerUid)
          .then(stats => this.logger.info({ ...stats }, 'Feedback: correction-migration completed'))
          .catch(err => this.logger.debug({ err }, 'Feedback: correction-migration failed (non-critical)'));
      }
    }, 30_000); // delay so init completes first
    this.confirmationQueue.setFeedbackService(feedbackService);
    if (activeLearning) {
      activeLearning.setFeedbackService(feedbackService);
    }
    // v657 — ProjectRepo + MemoryRepo für Multi-Action-Handler (cancel-item / defer) verkabeln
    if (this.projectRepo) this.confirmationQueue.setProjectRepo(this.projectRepo);
    if (this.memoryRepo) this.confirmationQueue.setMemoryRepo(this.memoryRepo);

    this.watchEngine = new WatchEngine(
      watchRepo,
      skillRegistry,
      skillSandbox,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'watch-engine' }),
      this.confirmationQueue,
      activityLogger,
      skillHealthTracker,
      llmProvider,
      this.config.cluster?.nodeId ?? 'single',
    );

    // 7f. Initialize workflow chains
    const workflowRepo = new WorkflowRepository(adapter);
    const workflowSkill = new WorkflowSkill(workflowRepo, skillRegistry);

    // v602 P2 — Workflow Run-Confirmation: when a workflow without auto_run is
    // invoked, enqueue a confirmation instead of running directly. The user can
    // approve → confirmation re-invokes 'workflow run' with confirmed=true.
    workflowSkill.setRunConfirmationCallback(async ({ chain, context }: { chain: import('@alfred/types').WorkflowChain; context: import('@alfred/types').SkillContext }) => {
      if (!this.confirmationQueue) throw new Error('ConfirmationQueue not available');
      const ownerPlatformForWf = (this.config.telegram?.enabled ? 'telegram'
        : this.config.discord?.enabled ? 'discord'
        : this.config.whatsapp?.enabled ? 'whatsapp'
        : context.platform ?? 'api');
      await this.confirmationQueue.enqueue({
        chatId: this.config.security?.ownerUserId ?? '',
        platform: ownerPlatformForWf,
        source: 'reasoning',
        sourceId: `workflow-run-${chain.id.slice(0, 8)}-${Date.now()}`,
        description: `Workflow '${chain.name}' (${chain.steps.length} Schritte) ausführen?` +
          (chain.description ? `\n\n${chain.description}` : ''),
        skillName: 'workflow',
        skillParams: {
          action: 'run',
          workflow_id: chain.id,
          confirmed: true,
        },
        timeoutMinutes: 60,
      });
    });

    skillRegistry.register(workflowSkill);

    const scriptExecutor = new ScriptExecutor(
      './data/scripts',
      this.logger.child({ component: 'script-executor' }),
    );
    const dbQueryExecutor = new DbQueryExecutor(
      adapter,
      this.logger.child({ component: 'db-query-executor' }),
    );
    const workflowRunner = new WorkflowRunner(
      workflowRepo,
      skillRegistry,
      skillSandbox,
      this.logger.child({ component: 'workflow-runner' }),
      activityLogger,
      skillHealthTracker,
      scriptExecutor,
      dbQueryExecutor,
    );
    workflowSkill.setRunner(workflowRunner);

    const promptParser = new PromptParser(
      llmProvider,
      skillRegistry,
      this.logger.child({ component: 'prompt-parser' }),
    );
    workflowSkill.setPromptParser(promptParser);

    // 7f-ii. TriggerManager — evaluates cron/watch triggers for workflows
    {
      const guardEvaluator = new GuardEvaluator(skillRegistry, skillSandbox);
      const triggerManager = new TriggerManager(
        workflowRepo,
        guardEvaluator,
        async (wfId, triggerData) => {
          const wf = await workflowRepo.getById(wfId);
          if (!wf) return;
          const { context } = await (await import('./context-factory.js')).buildSkillContext(
            userRepo,
            { userId: this.config.security?.ownerUserId ?? '', platform: 'api' as Platform, chatId: '' },
          );
          return workflowRunner.run(wf, context, triggerData);
        },
        this.logger.child({ component: 'trigger-manager' }),
      );
      triggerManager.start();
      this.triggerManager = triggerManager;
    }

    // 7g. Initialize reasoning engine — proactive cross-domain insights
    let insightTracker: InsightTracker | undefined;
    let kgServiceInstance: KnowledgeGraphService | undefined;
    {
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId && this.config.reasoning?.enabled !== false) {
        insightTracker = new InsightTracker(
          memoryRepo,
          this.logger.child({ component: 'insight-tracker' }),
          skillStateRepo,
        );
        this.insightTracker = insightTracker;
        const reasoningNotifRepo = new CalendarNotificationRepository(adapter);
        kgServiceInstance = new KnowledgeGraphService(
          new KnowledgeGraphRepository(adapter),
          this.logger.child({ component: 'knowledge-graph' }),
          memoryRepo, skillRegistry, skillSandbox, userRepo,
          ownerUserId, defaultProactivePlatform,
        );
        // Optional LLM-based entity linker
        const llmLinkingCfg = this.config.reasoning?.llmLinking;
        if (llmLinkingCfg?.enabled) {
          const llmLinkProvider = llmLinkingCfg.provider ?? 'mistral';
          let llmLinkApiKey = this.config.mistralApiKey;
          if (!llmLinkApiKey) {
            for (const tier of ['fast', 'default', 'strong'] as const) {
              const t = this.config.llm[tier];
              if (t?.provider === llmLinkProvider && t.apiKey) { llmLinkApiKey = t.apiKey; break; }
            }
          }
          if (llmLinkApiKey) {
            const { LLMEntityLinker } = await import('./llm-entity-linker.js');
            const baseUrl = llmLinkProvider === 'openai' ? 'https://api.openai.com/v1'
              : llmLinkProvider === 'anthropic' ? 'https://api.anthropic.com/v1'
              : 'https://api.mistral.ai/v1';
            const llmLinker = new LLMEntityLinker(
              new KnowledgeGraphRepository(adapter), llmLinkingCfg,
              this.logger.child({ component: 'llm-entity-linker' }), llmLinkApiKey, baseUrl,
            );
            llmLinker.setUsageCallback((_service, model, inp, out) => {
              usageRepo.record(model, inp, out, 0, 0, 0).catch(() => {});
            });
            llmLinker.setDocumentRepo(documentRepo);
            kgServiceInstance.setLLMLinker(llmLinker);
            this.logger.info({ provider: llmLinkProvider, model: llmLinkingCfg.model ?? 'mistral-small-latest' }, 'LLM entity linker enabled');
          }
        }
        // Resolve user timezone for reasoning engine
        let userTimezone: string | undefined;
        try {
          const ownerProfile = await userRepo.getProfile?.(this.ownerMasterUserId || ownerUserId);
          userTimezone = ownerProfile?.timezone;
        } catch { /* fallback to server TZ */ }

        // v656 — Timezone an Usage-Repos reichen, damit Tages/Stunden-Buckets in
        // Lokalzeit fallen. Vorher: UTC → "kein neuer Tag um 00:00 lokal".
        try {
          usageRepo.setTimezone(userTimezone);
          serviceUsageRepo.setTimezone(userTimezone);
        } catch { /* repo-Variante ohne setTimezone, ignorierbar */ }

        this.reasoningEngine = new ReasoningEngine(
          calendarProvider,
          todoRepo,
          watchRepo,
          memoryRepo,
          activityRepo,
          skillHealthRepo,
          reasoningNotifRepo,
          skillRegistry,
          skillSandbox,
          llmProvider,
          this.adapters,
          userRepo,
          ownerUserId,
          defaultProactivePlatform,
          this.config.reasoning,
          this.logger.child({ component: 'reasoning-engine' }),
          activityLogger,
          this.config.briefing?.location,
          feedbackRepo,
          this.confirmationQueue,
          this.config.cluster?.nodeId ?? 'single',
          adapter,
          insightTracker,
          undefined, // collector (auto-created internally)
          kgServiceInstance,
          workflowRepo,
          this.bmwTelematicRepo,
          noteRepo,
          this.reminderRepo,
          documentRepo,
          userTimezone,
          conversationRepo,
          this.runbookRepo,
          this.projectRepo,
        );
      }
    }

    // Wire PlanningAgent into ReasoningEngine
    if (this.reasoningEngine) {
      const { PlanRepository } = await import('@alfred/storage');
      const { PlanningAgent } = await import('./planning-agent.js');
      const planRepo = new PlanRepository(adapter);
      const planningAgent = new PlanningAgent(
        planRepo,
        llmProvider,
        {
          execute: async (skillName, params, userId) => {
            const skill = skillRegistry.get(skillName);
            if (!skill) return { success: false, error: `Skill "${skillName}" not found` };
            return skillSandbox.execute(skill, params, { userId, masterUserId: userId } as any);
          },
        },
        this.logger.child({ component: 'planning-agent' }),
      );
      this.reasoningEngine.setPlanningAgent(planningAgent);
      // Also wire into context collector for active plans display
      if ((this.reasoningEngine as any).collector?.setPlanningAgent) {
        (this.reasoningEngine as any).collector.setPlanningAgent(planningAgent);
      }
    }

    // Wire KG service into pipeline for dynamic device context in chat prompts
    if (kgServiceInstance) {
      this.pipeline.setKnowledgeGraphService(kgServiceInstance);
      this.kgServiceRef = kgServiceInstance;

      // Wire KG analyze callback into Memory skill
      if (this.memorySkillRef) {
        this.memorySkillRef.setKgAnalyzeCallback(async (_userId: string) => {
          // Always use the owner's masterUserId — not the alfredUserId from context
          // This prevents duplicate entities under different user IDs
          const resolvedUserId = this.ownerMasterUserId ?? _userId;

          const kgRepo = new KnowledgeGraphRepository(this.database.getAdapter());

          // 1. Memory-Sync + Cross-Extractor + Family Inference + Generic Links
          try { await (kgServiceInstance as any).syncMemoryEntities(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildCrossExtractorRelations(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildFamilyInference(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildGenericEntityLinks(resolvedUserId); } catch { /* continue */ }

          // 2. LLM linker (bypass daily schedule)
          const llmLinker = kgServiceInstance.getLLMLinker();
          let llmStats = { relations: 0, newEntities: 0, corrections: 0 };
          if (llmLinker) {
            try { llmStats = await llmLinker.run(resolvedUserId); } catch { /* continue */ }
          }

          // 3. Maintenance (dedup, prune)
          // 3. Maintenance (dedup, prune, phantom cleanup)
          try { await kgServiceInstance.maintenance(resolvedUserId); } catch (err) { this.logger.warn({ err: (err as Error).message }, 'KG maintenance in kg_analyze failed'); }

          // 4. Get totals
          const graph = await kgRepo.getFullGraph(resolvedUserId);
          return {
            entities: graph.entities.length,
            relations: graph.relations.length,
            newEntities: llmStats.newEntities,
            corrections: llmStats.corrections,
          };
        });
      }
    }

    // Wire watch events -> reasoning engine + trigger manager for event-triggered reasoning
    {
      const existingCallback = this.watchEngine.onWatchTriggered;
      this.watchEngine.onWatchTriggered = (name, value, data, skillName) => {
        existingCallback?.(name, value, data, skillName);

        // Forward to TriggerManager for watch-triggered workflows
        if (this.triggerManager) {
          this.triggerManager.onWatchTriggered(name, value).catch(() => {});
        }

        // Skip event-reasoning for feed_reader watches — RSS articles are evaluated
        // in the scheduled hourly reasoning pass via the feeds section instead.
        if (skillName === 'feed_reader') return;
        if (this.reasoningEngine) {
          this.reasoningEngine.triggerOnEvent('watch_alert', `Watch "${name}" ausgelöst: ${value}`, data)
            .catch(err => this.logger.warn({ err }, 'Event-triggered reasoning failed'));
        }
      };
    }

    // Wire calendar/todo watcher events → reasoning engine for holistic reasoning
    if (this.reasoningEngine && this.calendarWatcher) {
      this.calendarWatcher.onEventNotified = (event) => {
        this.reasoningEngine!.triggerOnEvent(
          'calendar_upcoming',
          `Termin in Kürze: ${event.title}${event.location ? ` (${event.location})` : ''}`,
          { eventId: event.id, title: event.title, location: event.location, start: event.start.toISOString() },
        ).catch(err => this.logger.warn({ err }, 'Calendar-triggered reasoning failed'));
      };
    }

    if (this.reasoningEngine && this.todoWatcher) {
      this.todoWatcher.onTodoNotified = (todoId, title, kind) => {
        this.reasoningEngine!.triggerOnEvent(
          `todo_${kind}`,
          `Todo ${kind === 'overdue' ? 'überfällig' : 'bald fällig'}: ${title}`,
          { todoId, title, kind },
        ).catch(err => this.logger.warn({ err }, 'Todo-triggered reasoning failed'));
      };
    }

    // Wire confirmation queue, activity logger, skill health tracker, and insight tracker into pipeline
    this.pipeline.setConfirmationQueue(this.confirmationQueue);
    this.pipeline.setActivityLogger(activityLogger);
    this.pipeline.setSkillHealthTracker(skillHealthTracker);
    // v685 — Owner-Master-User-ID an Pipeline durchreichen für Role-Fallback.
    // Wenn ein User ohne alfred_users-Eintrag (z.B. WebUI-User) der gelinkte Owner ist,
    // erbt er admin-Rechte statt auf 'guest' zu fallen.
    if (this.pipeline.setOwnerMasterUserId) {
      this.pipeline.setOwnerMasterUserId(this.ownerMasterUserId);
    }
    if (this.skillHealthRepo) this.pipeline.setSkillHealthRepo(this.skillHealthRepo);
    if (insightTracker) this.pipeline.setInsightTracker(insightTracker);

    // Wire reasoning engine into pipeline for post-skill triggers
    if (this.reasoningEngine) {
      this.pipeline.setReasoningEngine(this.reasoningEngine);
    }

    // Wire runbook-repo so chat-pipeline can inject matching Runbooks into system prompt
    if (this.runbookRepo) {
      this.pipeline.setRunbookRepo(this.runbookRepo);
    }

    // v658 — Projekt-Repo damit die Pipeline bei projectId-Messages den Kontext lädt
    if (this.projectRepo) {
      this.pipeline.setProjectRepo(this.projectRepo);
    }

    // v605 M7 — feed pipeline the project-agent-session repo so the system
    // prompt enumerates currently running sessions (valid interject targets).
    if (this.config.projectAgents?.enabled && this.config.codeAgents?.agents) {
      try {
        const { ProjectAgentSessionRepository } = await import('@alfred/storage');
        this.pipeline.setProjectAgentSessionRepo(new ProjectAgentSessionRepository(adapter));
      } catch (err) {
        this.logger.debug({ err }, 'Could not wire project-agent-session repo into pipeline (non-critical)');
      }
    }

    // v722 — Self-Learning: LearnedRecipeRepo an die Pipeline (Pre-Hook für Recipe-Augmentation)
    // + an die MemorySkill (learn_recipe Action).
    try {
      const { LearnedRecipeRepository } = await import('@alfred/storage');
      this.learnedRecipeRepo = new LearnedRecipeRepository(adapter);
      this.pipeline.setLearnedRecipeRepo(this.learnedRecipeRepo);
      if (this.memorySkillRef) {
        this.memorySkillRef.setLearnedRecipeRepo(this.learnedRecipeRepo);
      }
      this.logger.info('v722 LearnedRecipeRepo wired (pipeline pre-hook + memory.learn_recipe)');
    } catch (err) {
      this.logger.debug({ err }, 'Could not wire learned-recipe repo (non-critical)');
    }

    // 7a2. Wire optional moderation service into pipeline
    if (this.config.security?.moderation?.enabled) {
      const modConfig = this.config.security.moderation;
      const provider = modConfig.provider ?? 'mistral';
      const baseUrl = provider === 'mistral'
        ? 'https://api.mistral.ai/v1'
        : 'https://api.openai.com/v1';
      const model = modConfig.model ?? (provider === 'mistral'
        ? 'mistral-moderation-latest'
        : 'omni-moderation-latest');

      // Derive API key: dedicated mistralApiKey → matching LLM tier → default tier
      let apiKey: string | undefined;
      if (provider === 'mistral' && this.config.mistralApiKey) {
        apiKey = this.config.mistralApiKey;
      }
      if (!apiKey) {
        for (const tier of ['default', 'strong', 'fast'] as const) {
          const tierConfig = this.config.llm[tier];
          if (tierConfig?.provider === provider && tierConfig.apiKey) {
            apiKey = tierConfig.apiKey;
            break;
          }
        }
      }
      // Fallback: use default provider's API key
      if (!apiKey) {
        apiKey = this.config.llm.default?.apiKey;
      }

      if (apiKey) {
        const { ModerationService } = await import('@alfred/security');
        const moderationService = new ModerationService(
          apiKey,
          baseUrl,
          model,
          this.logger.child({ component: 'moderation' }),
        );
        moderationService.setUsageCallback((m, units) => {
          this.serviceUsageRepo?.record('moderation', m, units).catch(() => {});
        });
        this.pipeline.setModerationService(moderationService);
        this.logger.info({ provider, model }, 'Moderation service enabled');
      } else {
        this.logger.warn('Moderation enabled but no API key found — skipping');
      }
    }

    // 7b. Wire multi-user support into pipeline
    {
      // Reuse the alfredUserRepo from User Management skill init (same db handle)
      const { AlfredUserRepository, UsageRepository: UsageRepoClass } = await import('@alfred/storage');
      const { ROLE_SKILL_ACCESS } = await import('@alfred/skills');
      const pipelineUserRepo = new AlfredUserRepository(adapter);
      const { UserServiceResolver } = await import('./user-service-resolver.js');
      const serviceResolver = new UserServiceResolver(pipelineUserRepo);
      this.userServiceResolverRef = serviceResolver;
      this.pipeline.setAlfredUserRepo(pipelineUserRepo, ROLE_SKILL_ACCESS, this.usageRepo, serviceResolver);
      // Wire role access into help skill
      (helpSkill as any).roleAccess = ROLE_SKILL_ACCESS;
      // Inject service resolver into Spotify skill for HA-safe token persistence
      if (this.spotifySkill && 'setServiceResolver' in this.spotifySkill) {
        (this.spotifySkill as any).setServiceResolver(serviceResolver);
      }
      // Inject service resolver + telematic repo into BMW skill
      if (this.bmwSkill && 'setServiceResolver' in this.bmwSkill) {
        (this.bmwSkill as any).setServiceResolver(serviceResolver, this.ownerMasterUserId);
        const bmwTelematicRepo = new BmwTelematicRepository(adapter);
        (this.bmwSkill as any).setTelematicRepo(bmwTelematicRepo);
        this.bmwTelematicRepo = bmwTelematicRepo;
      }
      // BMW MQTT streaming is started in start() after AdapterClaimManager is available
    }

    // 7c2. Wire cluster cross-node messaging (needs adapters to be populated later)
    if (this.clusterManager) {
      await this.clusterManager.subscribe('messages', (data) => {
        const { targetPlatform, chatId, text } = data as { targetPlatform: string; chatId: string; text: string };
        const adapter = this.adapters.get(targetPlatform as any);
        if (adapter) {
          adapter.sendMessage(chatId, text).catch(err => {
            this.logger.warn({ err, targetPlatform, chatId }, 'Cross-node message delivery failed');
          });
        }
      });

      // Start UDP discovery broadcast (any node can broadcast)
      if (this.config.cluster) {
        const { ClusterDiscovery } = await import('./cluster/discovery.js');
        const discovery = new ClusterDiscovery(this.logger.child({ component: 'cluster-discovery' }));
        discovery.startBroadcasting({
          nodeId: this.config.cluster.nodeId,
          host: '0.0.0.0',
          port: this.config.api?.port ?? 3420,
          role: this.config.cluster?.role ?? 'node',
        });
      }
    }

    // 8. Initialize messaging adapters
    await this.initializeAdapters();

    this.logger.info('Alfred initialized');
  }

  private async initializeAdapters(): Promise<void> {
    const { config } = this;

    if (config.telegram.enabled && config.telegram.token) {
      const { TelegramAdapter } = await import('@alfred/messaging');
      this.adapters.set('telegram', new TelegramAdapter(config.telegram.token));
      this.logger.info('Telegram adapter registered');
    }

    if (config.discord?.enabled && config.discord.token) {
      const { DiscordAdapter } = await import('@alfred/messaging');
      this.adapters.set('discord', new DiscordAdapter(config.discord.token));
      this.logger.info('Discord adapter registered');
    }

    if (config.whatsapp?.enabled) {
      const { WhatsAppAdapter } = await import('@alfred/messaging');
      this.adapters.set('whatsapp', new WhatsAppAdapter(config.whatsapp.dataPath));
      this.logger.info('WhatsApp adapter registered');
    }

    if (config.matrix?.enabled && config.matrix.accessToken) {
      const { MatrixAdapter } = await import('@alfred/messaging');
      this.adapters.set('matrix', new MatrixAdapter(
        config.matrix.homeserverUrl,
        config.matrix.accessToken,
        config.matrix.userId,
      ));
      this.logger.info('Matrix adapter registered');
    }

    if (config.signal?.enabled && config.signal.phoneNumber) {
      const { SignalAdapter } = await import('@alfred/messaging');
      this.adapters.set('signal', new SignalAdapter(
        config.signal.apiUrl,
        config.signal.phoneNumber,
      ));
      this.logger.info('Signal adapter registered');
    }

    if (config.msteams?.enabled && config.msteams.appId) {
      const { MSTeamsAdapter } = await import('@alfred/messaging');
      const teamsAdapter = new MSTeamsAdapter(config.msteams);

      // Wire ConversationReference persistence via skill_state table (cluster-aware)
      const dbAdapter = this.database.getAdapter();
      const SKILL_KEY = 'msteams';
      const REF_PREFIX = 'conv_ref:';
      const systemUserId = '_system';
      teamsAdapter.setDbCallback({
        async saveConversationRef(chatId: string, ref: Record<string, unknown>): Promise<void> {
          const id = `msteams-ref-${chatId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;
          const now = new Date().toISOString();
          await dbAdapter.execute(
            `INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, skill, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [id, systemUserId, SKILL_KEY, `${REF_PREFIX}${chatId}`, JSON.stringify(ref), now],
          );
        },
        async loadAllConversationRefs(): Promise<Map<string, Record<string, unknown>>> {
          const rows = await dbAdapter.query(
            `SELECT key, value FROM skill_state WHERE user_id = ? AND skill = ? AND key LIKE ?`,
            [systemUserId, SKILL_KEY, `${REF_PREFIX}%`],
          );
          const map = new Map<string, Record<string, unknown>>();
          for (const row of rows) {
            const chatId = (row.key as string).slice(REF_PREFIX.length);
            try { map.set(chatId, JSON.parse(row.value as string)); } catch { /* skip malformed */ }
          }
          return map;
        },
      });

      this.adapters.set('msteams', teamsAdapter);
      this.logger.info({ port: config.msteams.webhookPort ?? 3978 }, 'MS Teams adapter registered (cluster-aware ConversationRef persistence)');
    }

    if (config.api?.enabled !== false) {
      const { HttpAdapter } = await import('@alfred/messaging');
      const port = config.api?.port ?? 3420;
      const host = config.api?.host ?? '127.0.0.1';
      if (config.api?.token) {
        this.logger.info('HTTP API authentication enabled');
      } else {
        this.logger.warn('HTTP API has no authentication token configured (api.token). API is open.');
      }
      this.adapters.set('api', new HttpAdapter(port, host, {
        apiToken: config.api?.token,
        corsOrigin: config.api?.corsOrigin,
        publicUrl: config.api?.publicUrl,
        tls: config.api?.tls,
        authCallback: this.webAuthCallback,
        healthCheck: async () => {
          let diskUsage: { path: string; sizeBytes: number } | undefined;
          try {
            const dbPath = this.config.storage.path;
            const stat = fs.statSync(dbPath);
            diskUsage = { path: dbPath, sizeBytes: stat.size };
          } catch { /* ignore */ }

          return {
            db: !!this.database,
            uptime: Math.floor(process.uptime()),
            startedAt: this.startedAt,
            adapters: Object.fromEntries([...this.adapters].map(([p, a]) => [p, a.getStatus()])),
            metrics: this.pipeline.getMetrics(),
            costs: this.llmProvider.getCostSummary(),
            todayUsage: await this.usageRepo?.getDaily(new Date().toISOString().slice(0, 10)),
            watchesActive: await this.watchRepo?.countEnabled() ?? 0,
            schedulersActive: await this.scheduledActionRepo?.countEnabled() ?? 0,
            llmProviders: this.llmProvider.getProviderStatuses(),
            diskUsage,
          };
        },
        metricsCallback: () => this.buildPrometheusMetrics(),
        dashboardCallback: async (opts?: { range?: string; granularity?: string; date?: string }) => {
          // v622 — range-aware Dashboard. Default 'week' für Backwärts-Kompatibilität.
          // Berechnung des Datums-Fensters + Bucket-Granularität:
          //   today  → 1 Tag (heute), daily-buckets
          //   week   → 7 Tage, daily-buckets
          //   month  → 30 Tage, daily-buckets
          //   year   → 365 Tage, MONATS-buckets (12 statt 365 Balken)
          //   all    → ab earliest llm_usage.date, MONATS-buckets
          // v656 — today wird jetzt lokal aufgelöst (Owner-Timezone), Bug-Fix für
          // "kein neuer Tag um 00:00 lokal" (vorher: UTC).
          const ownerTz = await (async () => {
            try {
              const ownerIdLocal = this.tryOwner() || '';
              const p = await this.userRepo?.getProfile?.(ownerIdLocal);
              return p?.timezone;
            } catch { return undefined; }
          })();
          const localToday = (() => {
            try {
              return new Intl.DateTimeFormat('en-CA', { timeZone: ownerTz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            } catch {
              return new Date().toISOString().slice(0, 10);
            }
          })();
          const today = localToday;
          const range = (opts?.range ?? 'week') as 'today' | 'week' | 'month' | 'year' | 'all';
          const granularity = (opts?.granularity ?? 'day') as 'day' | 'hour' | 'month';

          // v656 — Hourly-Modus: 24 Stunden-Buckets für einen lokalen Tag.
          //   Datum wählbar via opts.date (Format YYYY-MM-DD), default = today.
          //   Retention 62d (siehe cleanupHourly()).
          //   Ersetzt nur usageBuckets + bucketGranularity, rest des Dashboards bleibt gleich.
          let hourlyMode = false;
          let hourlyTargetDate = '';
          if (granularity === 'hour') {
            hourlyMode = true;
            hourlyTargetDate = opts?.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : today;
          }

          let startDate: string;
          let useMonthBuckets = false;
          if (range === 'today') {
            startDate = today;
          } else if (range === 'week') {
            // 7 Tages-Fenster relativ zur Lokal-TZ
            const past = new Date(Date.now() - 6 * 24 * 60 * 60_000);
            startDate = (() => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: ownerTz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(past); } catch { return past.toISOString().slice(0, 10); } })();
          } else if (range === 'month') {
            const past = new Date(Date.now() - 29 * 24 * 60 * 60_000);
            startDate = (() => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: ownerTz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(past); } catch { return past.toISOString().slice(0, 10); } })();
          } else if (range === 'year') {
            const past = new Date(Date.now() - 364 * 24 * 60 * 60_000);
            startDate = (() => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: ownerTz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(past); } catch { return past.toISOString().slice(0, 10); } })();
            useMonthBuckets = true;
          } else { // 'all'
            startDate = (await this.usageRepo?.getEarliestDate()) ?? today;
            useMonthBuckets = true;
          }

          const usageBuckets = hourlyMode
            ? (await this.usageRepo?.getHourly(hourlyTargetDate)) ?? []
            : useMonthBuckets
              ? (await this.usageRepo?.getRangeByMonth(startDate, today)) ?? []
              : (await this.usageRepo?.getRange(startDate, today)) ?? [];

          // Service-usage uses the daily getRange; for monthly views we still render
          // them as a flat aggregate (Tabelle nach Range gefiltert, kein Stacking).
          // Keeps the existing service-usage tabular display working unchanged.
          const serviceUsageRange = await this.serviceUsageRepo?.getRange(startDate, today) ?? [];

          return {
            range,
            startDate: hourlyMode ? hourlyTargetDate : startDate,
            endDate: hourlyMode ? hourlyTargetDate : today,
            bucketGranularity: (hourlyMode ? 'hour' : (useMonthBuckets ? 'month' : 'day')) as 'hour' | 'day' | 'month',
            hourlyDate: hourlyMode ? hourlyTargetDate : undefined,
            watches: await this.watchRepo?.getEnabled() ?? [],
            scheduled: await this.scheduledActionRepo?.getAll() ?? [],
            skillHealth: await this.skillHealthRepo?.getAll() ?? [],
            reminders: await this.reminderRepo?.getAllPending() ?? [],
            usage: {
              today: await this.usageRepo?.getDaily(hourlyMode ? hourlyTargetDate : today) ?? null,
              buckets: usageBuckets,
              // Legacy field für non-updated Clients
              week: !hourlyMode && range === 'week' ? usageBuckets : [],
              total: await this.usageRepo?.getTotal() ?? [],
            },
            uptime: Math.floor(process.uptime()),
            startedAt: this.startedAt,
            adapters: Object.fromEntries(
              [...this.adapters.entries()].map(([p, a]) => [p, a.getStatus()]),
            ),
            llmProviders: this.llmProvider.getProviderStatuses(),
            services: this.getConfiguredServices(),
            serviceUsage: {
              today: await this.serviceUsageRepo?.getDaily(today) ?? [],
              range: serviceUsageRange,
              week: range === 'week' ? serviceUsageRange : (await this.serviceUsageRepo?.getRange(
                new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString().slice(0, 10), today,
              )) ?? [],
              total: await this.serviceUsageRepo?.getTotal() ?? [],
            },
            userUsage: await this.usageRepo?.getByUser(startDate, today) ?? [],
            userSkillUsage: await this.activityRepo?.skillUsageByUser(startDate) ?? [],
          };
        },
        webUiPath: config.api?.webUi !== false ? this.resolveWebUiPath() : undefined,
      }));
      this.logger.info({ port, host, webUi: config.api?.webUi !== false }, 'HTTP API adapter registered');
    }
  }

  async start(): Promise<void> {
    this.logger.info('Starting Alfred...');

    // In HA mode: claim adapters via DB (only one node per adapter).
    // In single mode: connect all adapters directly.
    if (this.config.cluster?.enabled && this.database.getAdapter().type === 'postgres') {
      const { AdapterClaimManager } = await import('./adapter-claim-manager.js');
      this.adapterClaimManager = new AdapterClaimManager(
        this.database.getAdapter(),
        this.config.cluster.nodeId,
        this.logger.child({ component: 'adapter-claims' }),
      );

      // Try to claim each adapter, only connect if claimed
      for (const [platform, adapter] of this.adapters) {
        // HTTP API always connects (both nodes serve API behind load balancer)
        if (platform === 'api') {
          this.setupAdapterHandlers(platform, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (always-on)'); }
          catch (err) { this.logger.error({ platform, err }, 'Adapter connection failed'); }
          continue;
        }

        this.adapterClaimManager.registerPlatform(platform);
        const claimed = await this.adapterClaimManager.tryClaim(platform);
        if (claimed) {
          this.setupAdapterHandlers(platform, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (claimed)'); }
          catch (err) { this.logger.error({ platform, err }, 'Adapter connection failed'); }
        } else {
          this.logger.info({ platform }, 'Adapter claimed by another node, skipping');
        }
      }

      // When expired claims become available, connect the adapter (or start BMW streaming)
      this.adapterClaimManager.onAcquired(async (platform) => {
        if (platform === 'bmw-streaming') {
          if (this.bmwSkill) {
            this.logger.info('BMW MQTT streaming acquired from dead node, starting...');
            (this.bmwSkill as any).startStreaming()
              .then(() => this.logger.info('BMW MQTT streaming started (failover)'))
              .catch((err: unknown) => this.logger.warn({ err }, 'BMW MQTT streaming failover failed'));
          }
          return;
        }
        const adapter = this.adapters.get(platform as any);
        if (adapter && adapter.getStatus() === 'disconnected') {
          this.setupAdapterHandlers(platform as any, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (failover)'); }
          catch (err) { this.logger.error({ platform, err }, 'Failover adapter connection failed'); }
        }
      });

      this.adapterClaimManager.start();
    } else {
      // Single instance: connect all adapters
      for (const [platform, adapter] of this.adapters) {
        this.setupAdapterHandlers(platform, adapter);
        try {
          await adapter.connect();
          this.logger.info({ platform }, 'Adapter connected');
        } catch (err) {
          this.logger.error({ platform, err }, 'Adapter connection failed — skipping');
        }
      }
    }

    // Project HealthMonitor — cluster-aware claim (v602 P1)
    if (this.adapterClaimManager && this.projectHealthMonitor) {
      this.adapterClaimManager.registerPlatform('project-health-monitor');
    }

    // Start BMW MQTT streaming — cluster-aware with failover
    if (this.bmwSkill && this.config.bmw?.streaming?.enabled) {
      if (this.adapterClaimManager) {
        this.adapterClaimManager.registerPlatform('bmw-streaming');
      }
      const canStream = !this.adapterClaimManager || await this.adapterClaimManager.tryClaim('bmw-streaming');
      if (canStream) {
        this.logger.info({ username: this.config.bmw.streaming.username, topic: this.config.bmw.streaming.topic }, 'Starting BMW MQTT streaming...');
        (this.bmwSkill as any).startStreaming()
          .then(() => this.logger.info('BMW MQTT streaming started'))
          .catch((err: unknown) => this.logger.warn({ err }, 'BMW MQTT streaming failed to start'));
      } else {
        this.logger.info('BMW MQTT streaming claimed by another node, skipping');
      }
    }

    // Start schedulers
    this.reminderScheduler?.start();
    this.backgroundTaskRunner?.start();
    this.proactiveScheduler?.start();
    this.watchEngine?.start();
    this.confirmationQueue?.start();
    this.calendarWatcher?.start();
    this.todoWatcher?.start();
    this.reasoningEngine?.start();

    // Scheduled system backups
    if (this.config.backup?.enabled && this.config.backup?.storage !== 'none') {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('system-backup');
      const backupSkill = this.skillRegistry.get('system_backup') as any;
      if (backupSkill) {
        let lastBackupMinute = -1;
        setInterval(async () => {
          const now = new Date();
          if (now.getMinutes() === lastBackupMinute) return;
          const schedule = this.config.backup?.schedule ?? '0 3 * * *';
          const [min, hour] = schedule.split(' ');
          const minMatch = min === '*' || (min.includes('/') ? now.getMinutes() % parseInt(min.split('/')[1]) === 0 : min.split(',').some(p => parseInt(p) === now.getMinutes()));
          const hourMatch = hour === '*' || (hour.includes('/') ? now.getHours() % parseInt(hour.split('/')[1]) === 0 : hour.split(',').some(p => parseInt(p) === now.getHours()));
          if (!minMatch || !hourMatch) return;
          lastBackupMinute = now.getMinutes();
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('system-backup');
            if (!claimed) return;
          }
          try {
            await backupSkill.createBackup({}, 'scheduled');
            this.logger.info('Scheduled system backup completed');
          } catch (err) {
            this.logger.warn({ err }, 'Scheduled system backup failed');
          }
        }, 60_000);
        this.logger.info({ schedule: this.config.backup.schedule ?? '0 3 * * *' }, 'System backup scheduler started');
      }
    }

    // Commvault proactive monitoring
    if (this.config.commvault?.enabled && (this.config.commvault.polling_interval ?? 30) > 0) {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('commvault-monitor');
      const cvSkill = this.skillRegistry.get('commvault') as any;
      if (cvSkill?.pollAndReport) {
        const intervalMs = (this.config.commvault.polling_interval ?? 30) * 60_000;
        setInterval(async () => {
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('commvault-monitor');
            if (!claimed) return;
          }
          try {
            const result = await cvSkill.pollAndReport();
            if (result.failed > 0 || result.storageWarnings.length > 0 || result.slaViolations.length > 0) {
              this.logger.info({ ...result }, 'Commvault monitoring alert');
            }
          } catch (err) {
            this.logger.debug({ err }, 'Commvault monitoring poll failed');
          }
        }, intervalMs);
        this.logger.info({ interval: `${this.config.commvault.polling_interval ?? 30}min` }, 'Commvault monitoring started');
      }
    }

    // MikroTik proactive monitoring
    if (this.config.mikrotik?.enabled && (this.config.mikrotik.polling_interval ?? 5) > 0) {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('mikrotik-monitor');
      const mtSkill = this.skillRegistry.get('mikrotik') as any;
      if (mtSkill?.pollAndReport) {
        const intervalMs = (this.config.mikrotik.polling_interval ?? 5) * 60_000;
        setInterval(async () => {
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('mikrotik-monitor');
            if (!claimed) return;
          }
          try {
            const result = await mtSkill.pollAndReport();
            if (result.downInterfaces.length > 0 || result.cpuWarnings.length > 0) {
              this.logger.info({ ...result }, 'MikroTik monitoring alert');
            }
          } catch (err) {
            this.logger.debug({ err }, 'MikroTik monitoring poll failed');
          }
        }, intervalMs);
        this.logger.info({ interval: `${this.config.mikrotik.polling_interval ?? 5}min` }, 'MikroTik monitoring started');
      }
    }

    // Wire inbound webhooks (if configured)
    if (this.config.webhooks?.length && this.watchEngine) {
      const apiAdapter = this.adapters.get('api');
      if (apiAdapter && 'addWebhook' in apiAdapter) {
        const httpAdapter = apiAdapter as import('@alfred/messaging').HttpAdapter;
        for (const wh of this.config.webhooks) {
          httpAdapter.addWebhook({
            name: wh.name,
            secret: wh.secret,
            callback: async (payload) => {
              if (wh.watchId && this.watchEngine) {
                await this.watchEngine.triggerWatch(wh.watchId);
              }
              // Optionally send payload info to chat
              if (wh.chatId && wh.platform) {
                const adapter = this.adapters.get(wh.platform as Platform);
                if (adapter) {
                  const summary = `🔔 Webhook "${wh.name}" triggered` + (payload.action ? `: ${payload.action}` : '');
                  await adapter.sendMessage(wh.chatId, summary);
                }
              }
            },
          });
          this.logger.info({ name: wh.name, watchId: wh.watchId }, 'Webhook registered');
        }
      }
    }

    // Register OAuth callbacks on HTTP adapter
    {
      const apiAdapter = this.adapters.get('api');
      if (apiAdapter && 'registerOAuthCallback' in apiAdapter) {
        if (this.spotifySkill) {
          (apiAdapter as any).registerOAuthCallback('spotify', (code: string, state: Record<string, unknown>) =>
            this.spotifySkill!.handleOAuthCallback(code, state)
          );
          this.logger.info('Spotify OAuth callback registered');
        }
        if (this.sonosSkill && this.config.sonos?.cloud?.clientId) {
          (apiAdapter as any).registerOAuthCallback('sonos', (code: string, state: Record<string, unknown>) =>
            this.sonosSkill!.handleOAuthCallback(code, state)
          );
          this.logger.info('Sonos Cloud OAuth callback registered');
        }
      }
    }

    // Wire Knowledge Graph API on HTTP adapter
    {
      const apiAdapter = this.adapters.get('api');
      const dbAdapter = this.database.getAdapter();
      if (apiAdapter && 'setKnowledgeGraphCallbacks' in apiAdapter) {
        const kgRepoForApi = new KnowledgeGraphRepository(dbAdapter);
        (apiAdapter as any).setKnowledgeGraphCallbacks({
          getGraph: async (userId?: string) => {
            const uid = userId ?? this.config.security?.ownerUserId ?? '';
            try {
              const user = await this.userRepo!.findOrCreate('telegram' as any, uid);
              const resolvedId = user.masterUserId ?? user.id;
              return kgRepoForApi.getFullGraph(resolvedId);
            } catch {
              return kgRepoForApi.getFullGraph(uid);
            }
          },
          deleteEntity: async (entityId: string) => {
            const result = await dbAdapter.execute('DELETE FROM kg_entities WHERE id = ?', [entityId]);
            return result.changes > 0;
          },
          deleteRelation: async (relationId: string) => {
            const result = await dbAdapter.execute('DELETE FROM kg_relations WHERE id = ?', [relationId]);
            return result.changes > 0;
          },
          updateEntity: async (entityId: string, data: Record<string, unknown>) => {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); sets.push('normalized_name = ?'); params.push(String(data.name).trim().toLowerCase()); }
            if (data.entityType !== undefined) { sets.push('entity_type = ?'); params.push(data.entityType); }
            if (data.attributes !== undefined) { sets.push('attributes = ?'); params.push(JSON.stringify(data.attributes)); }
            if (sets.length === 0) return false;
            sets.push('last_seen_at = ?'); params.push(new Date().toISOString());
            params.push(entityId);
            try {
              const result = await dbAdapter.execute(`UPDATE kg_entities SET ${sets.join(', ')} WHERE id = ?`, params);
              return result.changes > 0;
            } catch { return false; }
          },
          updateRelation: async (relationId: string, data: Record<string, unknown>) => {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (data.relationType !== undefined) { sets.push('relation_type = ?'); params.push(data.relationType); }
            if (data.strength !== undefined) { sets.push('strength = ?'); params.push(data.strength); }
            if (data.context !== undefined) { sets.push('context = ?'); params.push(data.context); }
            if (sets.length === 0) return false;
            sets.push('last_seen_at = ?'); params.push(new Date().toISOString());
            params.push(relationId);
            try {
              const result = await dbAdapter.execute(`UPDATE kg_relations SET ${sets.join(', ')} WHERE id = ?`, params);
              return result.changes > 0;
            } catch { return false; }
          },
        });
        this.logger.info('Knowledge Graph API registered');
      }

      // Memory API for the Corrections viewer (list + delete)
      if (apiAdapter && this.memoryRepo && 'setMemoryCallbacks' in apiAdapter) {
        const memRepoForApi = this.memoryRepo;
        const dbAdapterForMem = dbAdapter;
        (apiAdapter as any).setMemoryCallbacks({
          list: async (filter?: { type?: string }) => {
            try {
              const ownerId = this.config.security?.ownerUserId ?? '';
              const user = await this.userRepo!.findOrCreate('telegram' as any, ownerId);
              const resolvedId = user.masterUserId ?? user.id;
              if (filter?.type) {
                return await memRepoForApi.getByType(resolvedId, filter.type as any, 200);
              }
              return await memRepoForApi.getAllForUser(resolvedId);
            } catch (err) {
              this.logger.warn({ err }, 'Memories API list failed');
              return [];
            }
          },
          delete: async (memoryId: string) => {
            const result = await dbAdapterForMem.execute('DELETE FROM memories WHERE id = ?', [memoryId]);
            return result.changes > 0;
          },
          // v606 K6 — type-patch for WebUI reclassification
          updateType: async (memoryId: string, type: string) => {
            return await memRepoForApi.updateType(memoryId, type);
          },
        });
        this.logger.info('Memories API registered');
      }

      // Wire Runbook API on HTTP adapter
      if (apiAdapter && this.runbookRepo && 'setRunbookCallbacks' in apiAdapter) {
        const rbRepo = this.runbookRepo;
        // v805 — IdentityResolver-Path statt direkter findOrCreate.
        // Vorher: catch-Fallback gab RAW env-var-String zurück (Telegram-ID)
        // → repo.list/get/update filterte nach user_id = telegram-id → null.
        // Jetzt: bevorzugt ownerMasterUserId (garantiert UUID nach v804-init),
        // falls undefined log + leerer Fallback (kein raw-string-leak mehr).
        const resolveOwner = async () => {
          if (this.ownerMasterUserId) return this.ownerMasterUserId;
          if (this.identityResolver && this.config.security?.ownerUserId) {
            try {
              return await this.identityResolver.resolveOwnerFromConfig(
                this.config.security.ownerUserId,
                (this.config.security as { ownerPlatform?: string })?.ownerPlatform ?? 'telegram',
              );
            } catch (err) {
              this.logger.warn({ err }, 'v805 Runbook resolveOwner via IdentityResolver failed');
            }
          }
          this.logger.warn({}, 'v805 Runbook resolveOwner returned empty (no ownerMasterUserId, no resolver)');
          return '';
        };
        (apiAdapter as any).setRunbookCallbacks({
          list: async (filter?: { status?: string; sourceType?: string }) => {
            try {
              const uid = await resolveOwner();
              return await rbRepo.list(uid, filter as any);
            } catch (err) {
              this.logger.warn({ err }, 'Runbook API list failed');
              return [];
            }
          },
          get: async (id: string) => {
            try {
              const uid = await resolveOwner();
              return await rbRepo.getById(uid, id);
            } catch { return null; }
          },
          update: async (id: string, patch: Record<string, unknown>) => {
            try {
              const uid = await resolveOwner();
              return await rbRepo.update(uid, id, patch as any);
            } catch (err) {
              this.logger.warn({ err }, 'Runbook API update failed');
              return null;
            }
          },
          delete: async (id: string) => {
            try {
              const uid = await resolveOwner();
              return await rbRepo.delete(uid, id);
            } catch { return false; }
          },
        });
        this.logger.info('Runbook API registered');
      }

      // v609 — Wire Project-Agent-Sessions API on HTTP adapter (WebUI inspector)
      // v787/v788/v789 — Agent-Session-Adapters API (für Multi-Agent-Picker + Stats + Reset im Frontend)
      if (apiAdapter && this.agentSessionManager && 'setAgentSessionCallbacks' in apiAdapter) {
        const mgr = this.agentSessionManager;
        const dbForSessionStats = this.database!.getAdapter();
        (apiAdapter as any).setAgentSessionCallbacks({
          listAvailable: () => mgr.listAdapters(),
          listSessionsForSandbox: async (sandboxId: string) => {
            try {
              const { AgentSessionRepository: ASR } = await import('@alfred/storage');
              const repo = new ASR(dbForSessionStats);
              const sessions = await repo.listBySandbox(sandboxId);
              return sessions.map(s => ({
                id: s.id,
                agentName: s.agentName,
                cliSessionId: s.cliSessionId,
                status: s.status,
                messageCount: s.messageCount,
                totalTokensInput: s.totalTokensInput,
                totalTokensOutput: s.totalTokensOutput,
                totalCachedTokens: s.totalCachedTokens,
                totalCostUsd: s.totalCostUsd,
                lastHealthOk: s.lastHealthOk,
                startedAt: s.startedAt,
                lastUsedAt: s.lastUsedAt,
                capabilities: s.capabilities,
              }));
            } catch (err) {
              this.logger.warn({ err, sandboxId }, 'v788 listSessionsForSandbox failed');
              return [];
            }
          },
          // v791 — Event-Replay: alle persistierten Events einer Session
          listEventsForSession: async (sessionId: string, limit?: number) => {
            try {
              const { AgentSessionRepository: ASR } = await import('@alfred/storage');
              const repo = new ASR(dbForSessionStats);
              const events = await repo.listEvents(sessionId, undefined, limit ?? 500);
              return events.map(e => ({
                id: e.id,
                iteration: e.iteration,
                eventType: e.eventType,
                eventData: e.eventData,
                createdAt: e.createdAt,
              }));
            } catch (err) {
              this.logger.warn({ err, sessionId }, 'v791 listEventsForSession failed');
              return [];
            }
          },
          // v789 — Session-Reset: agentSessionManager.resetSession() macht adapter.destroy + repo.delete
          resetSession: async (sandboxId: string, agentName: string) => {
            try {
              // Run-As-User aus Agent-Config bestimmen (gleiche Logik wie chatSendMessage)
              const agentDef = this.config.codeAgents?.agents.find(a => a.name === agentName);
              const runAsUser = (agentDef?.command === 'sudo' && agentDef.argsTemplate?.[0] === '-u' && agentDef.argsTemplate?.[1])
                ? agentDef.argsTemplate[1]
                : undefined;
              await mgr.resetSession(sandboxId, agentName, runAsUser);
              this.logger.info({ sandboxId, agentName, runAsUser }, 'v789 Session manually reset');
              return { ok: true };
            } catch (err) {
              this.logger.warn({ err, sandboxId, agentName }, 'v789 resetSession failed');
              return { ok: false, reason: (err as Error).message };
            }
          },
        });
      }

      if (apiAdapter && this.database && 'setProjectAgentCallbacks' in apiAdapter) {
        const { ProjectAgentSessionRepository } = await import('@alfred/storage');
        const sessionRepo = new ProjectAgentSessionRepository(this.database.getAdapter());
        const { pushInterjection, subscribeOutput, subscribeOutputEvents } = await import('@alfred/skills');
        (apiAdapter as any).setProjectAgentCallbacks({
          list: async (filter?: { phase?: string }) => {
            try {
              return await sessionRepo.listAll({ phase: filter?.phase, limit: 200 });
            } catch (err) {
              this.logger.warn({ err }, 'Project-Agent API list failed');
              return [];
            }
          },
          get: async (taskId: string) => {
            try {
              return await sessionRepo.getByTaskId(taskId);
            } catch { return null; }
          },
          stop: async (taskId: string) => {
            try {
              const session = await sessionRepo.getByTaskId(taskId);
              if (!session) return false;
              if (session.currentPhase === 'done' || session.currentPhase === 'failed') return true;
              // pushInterjection with a special STOP token; runner picks it up and aborts.
              await pushInterjection(taskId, '__STOP__');
              return true;
            } catch (err) {
              this.logger.warn({ err, taskId }, 'Project-Agent API stop failed');
              return false;
            }
          },
          // v649 — Resume via Skill-Action
          resume: async (taskId: string, notes?: string) => {
            try {
              const skill = this.skillRegistry?.get('project_agent');
              if (!skill) return { ok: false, error: 'project_agent-Skill nicht registriert' };
              const uid = this.tryOwner() ?? '';
              const ownerChatId = this.config.security?.ownerUserId ?? '';
              const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
                : this.config.matrix?.enabled ? 'matrix'
                : 'api');
              const ctx = { userId: uid, masterUserId: uid, chatId: ownerChatId, platform: ownerPlatform, conversationId: '' } as any;
              const r = await skill.execute({ action: 'resume', failed_task_id: taskId, notes }, ctx);
              if (!r.success) return { ok: false, error: r.error };
              return { ok: true, taskId: (r.data as any)?.taskId };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          },
          // v649 — Persisted plan listing
          plan: async (taskId: string) => {
            try {
              if (!this.plansRepoRef) return [];
              const session = await sessionRepo.getByTaskId(taskId);
              if (!session) return [];
              return await this.plansRepoRef.listBySession(session.id);
            } catch (err) {
              this.logger.warn({ err, taskId }, 'Project-Agent API plan failed');
              return [];
            }
          },
          // v651 — Live Output-Stream (SSE)
          subscribeOutput: (taskId: string, cb: (line: { ts: number; source: string; text: string }) => void) => {
            try {
              return subscribeOutput(taskId, cb);
            } catch (err) {
              this.logger.warn({ err, taskId }, 'Project-Agent API subscribeOutput failed');
              return null;
            }
          },
          // v782 — Strukturierter AgentEvent-Stream (parallel zu Text-Lines, für Card-Rendering)
          subscribeEvents: (taskId: string, cb: (entry: { ts: number; type: string; data: unknown }) => void) => {
            try {
              return subscribeOutputEvents(taskId, cb);
            } catch (err) {
              this.logger.warn({ err, taskId }, 'v782 subscribeEvents failed');
              return null;
            }
          },
          // v651 — Live-Interjection
          interject: async (taskId: string, text: string) => {
            try {
              const session = await sessionRepo.getByTaskId(taskId);
              if (!session) return { ok: false, error: 'Session nicht gefunden' };
              if (session.currentPhase === 'done' || session.currentPhase === 'failed') {
                return { ok: false, error: 'Session bereits beendet' };
              }
              await pushInterjection(taskId, text);
              return { ok: true };
            } catch (err) {
              this.logger.warn({ err, taskId }, 'Project-Agent API interject failed');
              return { ok: false, error: (err as Error).message };
            }
          },
        });
        this.logger.info('Project-Agent API registered');
      }

      // v623 — Wire Background-Tasks API on HTTP adapter (WebUI inspector)
      if (apiAdapter && this.database && 'setBackgroundTaskCallbacks' in apiAdapter) {
        const { BackgroundTaskRepository } = await import('@alfred/storage');
        const taskRepo = new BackgroundTaskRepository(this.database.getAdapter());
        (apiAdapter as any).setBackgroundTaskCallbacks({
          list: async (filter?: { status?: string }) => {
            try {
              const ownerId = this.tryOwner();
              if (!ownerId) return [];
              // v808 — Filter zum Owner. listAll war zuvor admin-uneingeschränkt.
              const all = await taskRepo.listAll({ status: filter?.status as any, limit: 1000 });
              return all.filter(t => t.userId === ownerId).slice(0, 200);
            } catch (err) {
              this.logger.warn({ err }, 'Background-Tasks API list failed');
              return [];
            }
          },
          get: async (id: string) => {
            try {
              const ownerId = this.tryOwner();
              if (!ownerId) return null;
              return await taskRepo.getByIdForUser(id, ownerId) ?? null;
            } catch { return null; }
          },
          cancel: async (id: string) => {
            try {
              const ownerId = this.tryOwner();
              if (!ownerId) return false;
              const t = await taskRepo.getByIdForUser(id, ownerId);
              if (!t) return false;
              return await taskRepo.cancel(id);
            } catch (err) {
              this.logger.warn({ err, id }, 'Background-Tasks API cancel failed');
              return false;
            }
          },
        });
        this.logger.info('Background-Tasks API registered');
      }

      // v627 — Wire Conversation-History API on HTTP adapter
      if (apiAdapter && this.database && 'setConversationCallbacks' in apiAdapter) {
        const { ConversationRepository, SummaryRepository } = await import('@alfred/storage');
        const convRepo = new ConversationRepository(this.database.getAdapter());
        const summaryRepo = new SummaryRepository(this.database.getAdapter());
        const ownerUid = this.tryOwner();
        // v637 — Resolve linked user-IDs for matrix/discord/whatsapp etc.
        // `conversations.user_id` stores the platform-specific user UUID, not the
        // master. ohne diese Auflösung wurden Matrix/Discord-Chats des Owners als
        // "fremd" gefiltert und versteckt.
        const resolveLinkedUserIds = async (): Promise<string[]> => {
          if (!ownerUid || !this.userRepo) return ownerUid ? [ownerUid] : [];
          try {
            const linked = await this.userRepo.getLinkedUsers(ownerUid);
            const ids = linked.map(u => u.id);
            if (!ids.includes(ownerUid)) ids.push(ownerUid);
            return ids;
          } catch { return [ownerUid]; }
        };
        (apiAdapter as any).setConversationCallbacks({
          list: async (filter?: { platform?: string; limit?: number; offset?: number; sortBy?: string; sinceIso?: string; untilIso?: string; includeDeleted?: boolean }) => {
            try {
              const userIds = await resolveLinkedUserIds();
              return await convRepo.listConversations({
                userIds,
                platform: filter?.platform as any,
                limit: filter?.limit ?? 100,
                offset: filter?.offset ?? 0,
                sortBy: (filter?.sortBy as any) ?? 'pinned_first',
                sinceIso: filter?.sinceIso,
                untilIso: filter?.untilIso,
                includeDeleted: filter?.includeDeleted ?? false,
              });
            } catch (err) {
              this.logger.warn({ err }, 'Conversation-History API list failed');
              return [];
            }
          },
          messages: async (id: string, opts?: { beforeIso?: string; limit?: number }) => {
            try {
              return await convRepo.getMessagesPaged(id, opts);
            } catch { return []; }
          },
          summary: async (id: string) => {
            try {
              return (await summaryRepo.get(id)) ?? null;
            } catch { return null; }
          },
          search: async (query: string, opts?: { limit?: number }) => {
            try {
              const userIds = await resolveLinkedUserIds();
              if (userIds.length === 0) return [];
              return await convRepo.searchMessages(userIds, query, {
                limit: opts?.limit ?? 30,
                timeDecay: true,
              });
            } catch (err) {
              this.logger.warn({ err }, 'Conversation-History API search failed');
              return [];
            }
          },
          // v644 — Lifecycle
          patch: async (id: string, patch: { customLabel?: string | null; pinned?: boolean }) => {
            await convRepo.updateLifecycle(id, patch);
          },
          deleteConv: async (id: string, hard?: boolean) => {
            if (hard) await convRepo.hardDelete(id);
            else await convRepo.softDelete(id);
          },
          branch: async (id: string, atMessageId: string) => {
            const userIds = await resolveLinkedUserIds();
            // Use the first available user-id (typically the owner-master). If a different
            // user owns the source conversation we'll re-attribute the branch to the same.
            const sourceConv = await convRepo.findById(id);
            const ownerId = sourceConv?.userId ?? userIds[0];
            if (!ownerId) throw new Error('no user-id for branching');
            const newConversationId = await convRepo.branchAtMessage(id, atMessageId, { userId: ownerId });
            return { newConversationId };
          },
          exportConv: async (ids: string[]) => {
            const entries: Array<{ id: string; filename: string; content: string }> = [];
            for (const id of ids) {
              try {
                const conv = await convRepo.findById(id);
                if (!conv) continue;
                const msgs = await convRepo.getMessages(id, 5000);
                const safeName = (conv.customLabel ?? conv.chatId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
                const lines = [
                  `# ${conv.customLabel ?? conv.chatId}`,
                  `Platform: ${conv.platform} · ChatId: ${conv.chatId}`,
                  `Created: ${conv.createdAt} · Messages: ${msgs.length}`,
                  '',
                  ...msgs.map(m => `## ${m.role.toUpperCase()} — ${m.createdAt}\n${m.content}${m.toolCalls ? `\n\n[tool-calls]\n${m.toolCalls}` : ''}`),
                ];
                entries.push({ id, filename: `conversation-${safeName}-${id.slice(0, 8)}.md`, content: lines.join('\n') });
              } catch { /* skip */ }
            }
            return { format: 'markdown' as const, entries };
          },
          replay: async (conversationId: string, messageId: string) => {
            try {
              // Find the message; if it has tool_calls, parse and re-execute via SkillSandbox
              const msgs = await convRepo.getMessages(conversationId, 5000);
              const msg = msgs.find(m => m.id === messageId);
              if (!msg) return { ok: false, reason: 'message not found' };
              if (!msg.toolCalls) return { ok: false, reason: 'message has no tool calls' };
              let toolCalls: Array<{ name?: string; tool?: string; function?: string; parameters?: any; arguments?: any; params?: any }> = [];
              try {
                const parsed = JSON.parse(msg.toolCalls);
                toolCalls = Array.isArray(parsed) ? parsed : [parsed];
              } catch { return { ok: false, reason: 'cannot parse tool_calls' }; }
              const uid = this.tryOwner() ?? '';
              const results: any[] = [];
              for (const tc of toolCalls) {
                const skillName = (tc.name ?? tc.tool ?? tc.function) as string | undefined;
                const params = (tc.parameters ?? tc.arguments ?? tc.params ?? {}) as Record<string, unknown>;
                if (!skillName || !this.skillRegistry) { results.push({ skill: skillName, ok: false, reason: 'skill not found' }); continue; }
                const skill = this.skillRegistry.get(skillName);
                if (!skill) { results.push({ skill: skillName, ok: false, reason: 'skill not registered' }); continue; }
                try {
                  const r = await skill.execute(params, { userId: uid, masterUserId: uid } as any);
                  results.push({ skill: skillName, ok: r.success, result: r });
                } catch (err) {
                  results.push({ skill: skillName, ok: false, reason: (err as Error).message });
                }
              }
              return { ok: results.some(r => r.ok), result: results };
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
          },
        });
        this.logger.info('Conversation-History API registered');
      }

      // v629 — Wire Confirmations + Reminders Side-Panel API
      if (apiAdapter && this.confirmationQueue && 'setConfirmationCallbacks' in apiAdapter) {
        // Give the ConfirmationQueue access to ConversationRepository so it can
        // resolve a `conversationId` for the SkillContext when the web flow approves.
        if (this.database) {
          try {
            const { ConversationRepository } = await import('@alfred/storage');
            const convRepo = new ConversationRepository(this.database.getAdapter());
            this.confirmationQueue.setConversationRepository(convRepo);
          } catch (err) {
            this.logger.warn({ err }, 'ConversationRepository wiring for ConfirmationQueue failed');
          }
        }
        const ownerUid = this.tryOwner();
        const resolveLinkedConfirmUserIds = async (): Promise<string[]> => {
          if (!ownerUid || !this.userRepo) return ownerUid ? [ownerUid] : [];
          try {
            const linked = await this.userRepo.getLinkedUsers(ownerUid);
            const ids = linked.map(u => u.id);
            if (!ids.includes(ownerUid)) ids.push(ownerUid);
            return ids;
          } catch { return [ownerUid]; }
        };
        (apiAdapter as any).setConfirmationCallbacks({
          list: async () => {
            try {
              const userIds = await resolveLinkedConfirmUserIds();
              if (userIds.length === 0) return [];
              return await this.confirmationQueue!.listPendingForUser(userIds, 50);
            } catch (err) {
              this.logger.warn({ err }, 'Confirmations API list failed');
              return [];
            }
          },
          decide: async (id: string, decision: 'approve' | 'reject' | string) => {
            try {
              if (!ownerUid) return { ok: false, reason: 'no-owner' };
              return await this.confirmationQueue!.handleWebDecision({ id, decision, userId: ownerUid });
            } catch (err) {
              this.logger.warn({ err, id, decision }, 'Confirmation web-decision failed');
              return { ok: false, reason: 'error' };
            }
          },
        });
        this.logger.info('Confirmations Side-Panel API registered');
      }
      // v638 — Wire Insights API
      if (apiAdapter && this.insightsRepo && this.insightEngine && 'setInsightsCallbacks' in apiAdapter) {
        const insightsRepo = this.insightsRepo;
        const insightEngine = this.insightEngine;
        // v805 — Nur ownerMasterUserId (UUID nach v804-init).
        const ownerUidForInsights = this.ownerMasterUserId;
        const resolveLinked = async (): Promise<string[]> => {
          if (!ownerUidForInsights || !this.userRepo) return ownerUidForInsights ? [ownerUidForInsights] : [];
          try {
            const linked = await this.userRepo.getLinkedUsers(ownerUidForInsights);
            const ids = linked.map(u => u.id);
            if (!ids.includes(ownerUidForInsights)) ids.push(ownerUidForInsights);
            return this.withLegacyForOwner(ownerUidForInsights, ids);
          } catch { return this.withLegacyForOwner(ownerUidForInsights, [ownerUidForInsights]); }
        };
        (apiAdapter as any).setInsightsCallbacks({
          list: async (filter?: { category?: string; status?: string; limit?: number }) => {
            if (!ownerUidForInsights) return [];
            return insightsRepo.list(ownerUidForInsights, {
              category: filter?.category as any,
              status: filter?.status as any,
              limit: filter?.limit ?? 100,
            });
          },
          dismiss: async (id: string) => { if (ownerUidForInsights) await insightsRepo.dismiss(ownerUidForInsights, id); },
          snooze: async (id: string, hours: number) => { if (ownerUidForInsights) await insightsRepo.snooze(ownerUidForInsights, id, hours); },
          act: async (id: string) => {
            if (!ownerUidForInsights) return { ok: false, reason: 'no-owner' };
            const insight = await insightsRepo.getById(ownerUidForInsights, id);
            if (!insight) return { ok: false, reason: 'not-found' };
            if (!insight.actionSkill) return { ok: false, reason: 'no-action' };
            const skill = this.skillRegistry?.get(insight.actionSkill);
            if (!skill) return { ok: false, reason: `skill ${insight.actionSkill} not registered` };
            try {
              const result = await skill.execute(insight.actionParams ?? {}, { userId: ownerUidForInsights, masterUserId: ownerUidForInsights } as any);
              await insightsRepo.markActed(ownerUidForInsights, id);
              return { ok: true, result };
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
          },
          sweep: async () => {
            if (!ownerUidForInsights) return { inserted: 0, refreshed: 0, perAdapter: {}, errors: ['no-owner'] };
            const linked = await resolveLinked();
            return insightEngine.sweep({ userId: ownerUidForInsights, linkedUserIds: linked, logger: this.logger });
          },
          stats: async () => {
            if (!ownerUidForInsights) return {};
            return insightsRepo.stats(ownerUidForInsights);
          },
          // v695 — Bulk-Dismiss aller offenen Insights einer Kategorie (für „kg-gap" nach v695-Cleanup)
          dismissCategory: async (category: string) => {
            if (!ownerUidForInsights) return 0;
            return insightsRepo.dismissCategory(ownerUidForInsights, category as any);
          },
        });
        this.logger.info('Insights API registered');
      }

      // v770 — Storage-Only-Callbacks (env / db-seeds / sandbox-templates) UNABHÄNGIG von sandboxManager registrieren.
      // Bugfix: vorher waren sie inline im `if (sandbox.enabled)` Block versteckt UND wurden bei Zeile ~3543 aufgerufen
      // BEVOR der api-Adapter existierte (der wird erst bei Zeile 4975 erzeugt). Folge: `this.adapters.get('api')`
      // lieferte undefined, Callback-Registrierung lief still ins Nichts, ALLE 3 Endpoints lieferten permanent 501.
      // Jetzt: hier, nach apiAdapter und Database vorhanden, ohne sandboxManager-Dependency.
      if (apiAdapter && this.database) {
        const adapter = this.database.getAdapter();

        // v728 — Environments-CRUD-API (WebUI-Zugriff auf project_environments via REST)
        try {
          const envHttpAdapter = apiAdapter as { setEnvironmentsCallbacks?: (cb: Record<string, unknown>) => void };
          if (typeof envHttpAdapter.setEnvironmentsCallbacks === 'function' && this.envRepoRef && this.envCryptoRef) {
            const envRepoLocal = this.envRepoRef;
            const envCryptoLocal = this.envCryptoRef;
            envHttpAdapter.setEnvironmentsCallbacks({
              listStages: async (projectId: string) => {
                const entries = await envRepoLocal.listForProject(projectId);
                return entries.map(e => {
                  let keyCount = 0;
                  try { keyCount = Object.keys(envCryptoLocal.decrypt(e.varsEncrypted, e.iv, e.authTag)).length; } catch { keyCount = -1; }
                  return { stage: e.stage, keyCount, updatedAt: e.updatedAt };
                });
              },
              getVars: async (projectId: string, stage: string, reveal: boolean) => {
                const entry = await envRepoLocal.get(projectId, stage);
                if (!entry) return {};
                const vars = envCryptoLocal.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
                if (reveal) return vars;
                const masked: Record<string, string> = {};
                for (const [k, v] of Object.entries(vars)) {
                  masked[k] = v.length <= 4 ? '****' : v.slice(0, 2) + '****' + v.slice(-2);
                }
                return masked;
              },
              setVars: async (projectId: string, stage: string, vars: Record<string, string>, replace: boolean) => {
                for (const k of Object.keys(vars)) {
                  if (!/^[A-Z][A-Z0-9_]*$/.test(k)) {
                    return { ok: false, count: 0, reason: `Ungültiger Key "${k}" (erlaubt: A-Z, 0-9, _; muss mit Buchstabe beginnen)` };
                  }
                }
                const current = replace ? {} : (await (async () => {
                  const entry = await envRepoLocal.get(projectId, stage);
                  if (!entry) return {} as Record<string, string>;
                  return envCryptoLocal.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
                })());
                const merged = { ...current, ...vars };
                const { ciphertext, iv, authTag } = envCryptoLocal.encrypt(merged);
                await envRepoLocal.upsert({ projectId, stage, varsEncrypted: ciphertext, iv, authTag, encryptionVersion: 1 });
                return { ok: true, count: Object.keys(merged).length };
              },
              deleteStage: async (projectId: string, stage: string) => {
                await envRepoLocal.delete(projectId, stage);
              },
              scanRepo: async (projectId: string) => {
                if (!this.projectRepo) return { ok: false, reason: 'projectRepo nicht initialisiert' };
                const proj = await this.projectRepo.getByIdAnyOwner(projectId).catch(() => null);
                if (!proj || !proj.cwd) return { ok: false, reason: 'project oder cwd nicht gefunden' };
                const { existsSync: ex, readFileSync, readdirSync, statSync } = await import('node:fs');
                const pth = await import('node:path');
                if (!ex(proj.cwd)) return { ok: false, reason: `cwd existiert nicht: ${proj.cwd}` };
                const found = new Map<string, { sources: Set<string> }>();
                for (const fn of ['.env.example', '.env.sample', '.env.template']) {
                  const p = pth.join(proj.cwd, fn);
                  if (!ex(p)) continue;
                  try {
                    const content = readFileSync(p, 'utf8');
                    for (const line of content.split('\n')) {
                      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
                      if (m) {
                        const e = found.get(m[1]) ?? { sources: new Set<string>() };
                        e.sources.add(fn); found.set(m[1], e);
                      }
                    }
                  } catch { /* */ }
                }
                const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);
                const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.alfred-data', '.alfred-uploads', 'coverage']);
                const walk = (dir: string, depth: number) => {
                  if (depth > 4) return;
                  let entries: import('node:fs').Dirent[] = [];
                  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
                  for (const e of entries) {
                    if (skipDirs.has(e.name)) continue;
                    const full = pth.join(dir, e.name);
                    if (e.isDirectory()) { walk(full, depth + 1); continue; }
                    const ext = pth.extname(e.name);
                    if (!codeExts.has(ext)) continue;
                    try {
                      if (statSync(full).size > 512 * 1024) continue;
                      const content = readFileSync(full, 'utf8');
                      const regexes = [
                        /process\.env\.([A-Z][A-Z0-9_]*)/g,
                        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
                        /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
                        /\bos\.environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
                        /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
                      ];
                      for (const r of regexes) {
                        let m: RegExpExecArray | null;
                        while ((m = r.exec(content)) !== null) {
                          const key = m[1];
                          const e2 = found.get(key) ?? { sources: new Set<string>() };
                          e2.sources.add(pth.relative(proj.cwd!, full));
                          found.set(key, e2);
                        }
                      }
                    } catch { /* */ }
                  }
                };
                walk(proj.cwd, 0);
                const keys = Array.from(found.entries())
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([key, info]) => ({ key, sources: Array.from(info.sources).slice(0, 5) }));
                return { ok: true, keys };
              },
            });
            this.logger.info('v770 Environments CRUD-API registered');
          } else {
            this.logger.warn({ hasEnvRepo: !!this.envRepoRef, hasCrypto: !!this.envCryptoRef }, 'v770 Environments API skipped — Pre-conditions missing');
          }
        } catch (err) {
          this.logger.warn({ err }, 'v770 Environments API registration failed (non-fatal)');
        }

        // v751 — Sandbox-Templates-CRUD-API
        try {
          const tplHttpAdapter = apiAdapter as { setSandboxTemplatesCallbacks?: (cb: Record<string, unknown>) => void };
          if (typeof tplHttpAdapter.setSandboxTemplatesCallbacks === 'function') {
            const { SandboxTemplateRepository } = await import('@alfred/storage');
            const tplRepo = new SandboxTemplateRepository(adapter);
            const ownerUid = () => this.tryOwner() ?? '';
            tplHttpAdapter.setSandboxTemplatesCallbacks({
              list: async (projectId: string | null | undefined) => {
                const uid = ownerUid();
                if (!uid) return [];
                const templates = await tplRepo.listForUser(uid, projectId === undefined ? undefined : projectId);
                return templates.map(t => ({
                  id: t.id, projectId: t.projectId, name: t.name, description: t.description,
                  mode: t.mode, envStage: t.envStage, dbSeedId: t.dbSeedId, initialGoal: t.initialGoal,
                  tags: t.tags, createdAt: t.createdAt, updatedAt: t.updatedAt,
                }));
              },
              create: async (input: {
                projectId?: string | null;
                name: string;
                description?: string;
                mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
                envStage?: string;
                dbSeedId?: string;
                initialGoal?: string;
                tags?: string[];
              }) => {
                const uid = ownerUid();
                if (!uid) return { ok: false, reason: 'Kein Owner-User' };
                try {
                  const t = await tplRepo.create({ ...input, userId: uid });
                  return { ok: true, id: t.id };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
              update: async (id: string, patch: Record<string, unknown>) => {
                try {
                  const ok = await tplRepo.update(id, patch as never);
                  return ok ? { ok: true } : { ok: false, reason: 'Template nicht gefunden' };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
              delete: async (id: string) => {
                try { await tplRepo.delete(id); return { ok: true }; }
                catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
            });
            this.logger.info('v770 Sandbox-Templates CRUD-API registered');
          }
        } catch (err) {
          this.logger.warn({ err }, 'v770 Sandbox-Templates API registration failed (non-fatal)');
        }

        // v732 — DB-Seeds-CRUD-API
        try {
          const seedsHttpAdapter = apiAdapter as { setDbSeedsCallbacks?: (cb: Record<string, unknown>) => void };
          if (typeof seedsHttpAdapter.setDbSeedsCallbacks === 'function' && this.dbSeedRepoRef && this.projectRepo) {
            const seedRepoLocal = this.dbSeedRepoRef;
            const projRepoLocal = this.projectRepo;
            const uploadsPath = this.config.sandbox?.uploadSeedsPath ?? '/var/alfred/db-seeds';
            // v808 — Defense-in-depth: prüft ob projectId dem aktuellen Owner gehört.
            const verifyProjectOwner = async (projectId: string): Promise<boolean> => {
              const ownerId = this.tryOwner();
              if (!ownerId) return false;
              try {
                const proj = await projRepoLocal.getByIdAnyOwner(projectId);
                return !!proj && proj.userId === ownerId;
              } catch { return false; }
            };
            seedsHttpAdapter.setDbSeedsCallbacks({
              list: async (projectId: string) => {
                if (!(await verifyProjectOwner(projectId))) return [];
                const seeds = await seedRepoLocal.listForProject(projectId);
                return seeds.map(s => ({
                  id: s.id, name: s.name, kind: s.kind, storageRef: s.storageRef,
                  sizeBytes: s.sizeBytes, createdAt: s.createdAt,
                }));
              },
              upload: async (projectId: string, name: string, dataBase64: string) => {
                try {
                  if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                  const fs = await import('node:fs');
                  const pth2 = await import('node:path');
                  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
                  const projDir = pth2.join(uploadsPath, projectId);
                  fs.mkdirSync(projDir, { recursive: true, mode: 0o755 });
                  const target = pth2.join(projDir, `${Date.now()}_${safeName}`);
                  const buf = Buffer.from(dataBase64, 'base64');
                  if (buf.length > 100 * 1024 * 1024) return { ok: false, reason: 'Seed-File zu groß (max 100 MB)' };
                  fs.writeFileSync(target, buf, { mode: 0o644 });
                  const relRef = pth2.relative(uploadsPath, target);
                  const seed = await seedRepoLocal.create({ projectId, name: safeName, kind: 'upload', storageRef: relRef, sizeBytes: buf.length });
                  return { ok: true, seedId: seed.id };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
              registerRepoPath: async (projectId: string, name: string, repoPath: string) => {
                try {
                  if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                  const proj = await projRepoLocal.getByIdAnyOwner(projectId).catch(() => null);
                  if (!proj || !proj.cwd) return { ok: false, reason: 'project oder cwd nicht gefunden' };
                  const fs = await import('node:fs');
                  const pth3 = await import('node:path');
                  const fullPath = pth3.resolve(proj.cwd, repoPath);
                  if (!fullPath.startsWith(pth3.resolve(proj.cwd))) return { ok: false, reason: 'repoPath verlässt projectCwd' };
                  let sizeBytes = 0;
                  try { sizeBytes = fs.statSync(fullPath).size; } catch { return { ok: false, reason: `Datei nicht gefunden: ${repoPath}` }; }
                  const seed = await seedRepoLocal.create({ projectId, name: name.slice(0, 150), kind: 'repo_path', storageRef: repoPath, sizeBytes });
                  return { ok: true, seedId: seed.id };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
              delete: async (projectId: string, seedId: string) => {
                try {
                  if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                  const seed = await seedRepoLocal.getById(seedId);
                  if (!seed) return { ok: false, reason: 'Seed nicht gefunden' };
                  if (seed.projectId !== projectId) return { ok: false, reason: 'Seed gehört zu anderem Project' };
                  if (seed.kind === 'upload') {
                    try {
                      const pth4 = await import('node:path');
                      const fs2 = await import('node:fs');
                      const fullPath = pth4.resolve(uploadsPath, seed.storageRef);
                      if (fullPath.startsWith(pth4.resolve(uploadsPath)) && fs2.existsSync(fullPath)) {
                        fs2.unlinkSync(fullPath);
                      }
                    } catch (err) { this.logger.warn({ err, seedId }, 'v770 upload-file unlink failed (continuing)'); }
                  }
                  try {
                    await this.database!.getAdapter().execute(`UPDATE projects SET default_db_seed_id = NULL WHERE default_db_seed_id = ?`, [seedId]);
                  } catch { /* */ }
                  await seedRepoLocal.delete(seedId);
                  return { ok: true };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
              setDefault: async (projectId: string, seedId: string | null) => {
                try {
                  if (!(await verifyProjectOwner(projectId))) return { ok: false, reason: 'Project nicht gefunden oder nicht autorisiert' };
                  if (seedId) {
                    const seed = await seedRepoLocal.getById(seedId);
                    if (!seed) return { ok: false, reason: 'Seed nicht gefunden' };
                    if (seed.projectId !== projectId) return { ok: false, reason: 'Seed gehört zu anderem Project' };
                  }
                  await this.database!.getAdapter().execute(`UPDATE projects SET default_db_seed_id = ? WHERE id = ?`, [seedId, projectId]);
                  return { ok: true };
                } catch (err) { return { ok: false, reason: (err as Error).message }; }
              },
            });
            this.logger.info('v770 DB-Seeds CRUD-API registered');
          }
        } catch (err) {
          this.logger.warn({ err }, 'v770 DB-Seeds API registration failed (non-fatal)');
        }
      }

      // v699/v700/v703 — Wire Sandbox API + Preview-Proxy + Chat
      if (apiAdapter && this.sandboxManager && this.database && 'setSandboxCallbacks' in apiAdapter) {
        try {
          const { SandboxRepository: SandboxRepoForApi, SandboxChatRepository: SandboxChatRepo } = await import('@alfred/storage');
          const sandboxRepoForApi = new SandboxRepoForApi(this.database.getAdapter());
          const sandboxChatRepo = new SandboxChatRepo(this.database.getAdapter());
          // v763 — Orphan-Cleanup: nicht-terminale Code-Agent-Tasks aus vorherigem Lauf als failed markieren
          try {
            const orphaned = await sandboxChatRepo.failOrphanedCodeAgentTasks();
            if (orphaned > 0) this.logger.info({ count: orphaned }, 'v763 marked orphaned code-agent chat-tasks as failed');
          } catch (err) {
            this.logger.warn({ err }, 'v763 orphan-cleanup failed (non-fatal)');
          }
          const sbMgr = this.sandboxManager;
          const projectsRepoForSb = this.projectRepo;
          const resolveCwdForSb = async (projectId: string): Promise<string | null> => {
            if (!projectsRepoForSb) return null;
            try { const p = await projectsRepoForSb.getByIdAnyOwner(projectId); return p?.cwd ?? null; } catch { return null; }
          };
          const { execFile: execFileForDiff } = await import('node:child_process');
          const { promisify: promisifyForDiff } = await import('node:util');
          const execFileAsyncForDiff = promisifyForDiff(execFileForDiff);

          (apiAdapter as any).setSandboxCallbacks({
            status: async () => sbMgr.getStatus(),
            list: async (filter: { projectId?: string; sessionId?: string }) => {
              if (filter.sessionId) {
                const sb = await sandboxRepoForApi.getBySessionId(filter.sessionId);
                return sb ? [sb] : [];
              }
              if (filter.projectId) {
                return sandboxRepoForApi.listByProject(filter.projectId);
              }
              return [];
            },
            listAll: async (userId: string) => {
              const uid = userId || this.tryOwner();
              if (!uid) return [];
              return sandboxRepoForApi.listActiveByUser(uid);
            },
            getById: async (sandboxId: string) => {
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) return null;
              // v723 — DefaultBranch aus dem Project anreichern damit das Frontend
              // den echten Branch-Namen im Merge-Dialog zeigen kann (statt hardcoded 'main').
              let defaultBranch: string | undefined;
              if (projectsRepoForSb) {
                try {
                  const p = await projectsRepoForSb.getByIdAnyOwner(sb.projectId);
                  defaultBranch = p?.defaultBranch ?? undefined;
                } catch { /* non-critical */ }
              }
              defaultBranch = defaultBranch ?? this.config.codeAgents?.forge?.baseBranch ?? 'main';
              return { ...sb, defaultBranch };
            },
            create: async (input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string; envStage?: string; dbSeedId?: string | null }) => {
              const cwd = await resolveCwdForSb(input.projectId);
              if (!cwd) throw new Error(`Project cwd unknown for project ${input.projectId}`);
              // v714 — Priorität: requestUserId (vom HTTP-Token) > project.userId > ownerMasterUserId.
              const proj = projectsRepoForSb ? await projectsRepoForSb.getByIdAnyOwner(input.projectId) : null;
              const userId = input.requestUserId || proj?.userId || this.ownerMasterUserId;
              if (!userId) throw new Error('Cannot determine user for sandbox');

              // v733 — envStage + dbSeed-Wahl: Default aus project, sonst input-override
              const envStage = input.envStage || proj?.defaultEnvStage || 'sandbox';
              const seedIdToUse = input.dbSeedId === null ? null : (input.dbSeedId ?? proj?.defaultDbSeedId ?? null);
              let dbSeed: { kind: 'empty' } | { kind: 'repo_path'; path: string } | { kind: 'upload'; seedId: string } = { kind: 'empty' };
              if (seedIdToUse && this.dbSeedRepoRef) {
                try {
                  const seed = await this.dbSeedRepoRef.getById(seedIdToUse);
                  if (seed && seed.projectId === input.projectId) {
                    if (seed.kind === 'upload') dbSeed = { kind: 'upload', seedId: seed.id };
                    else if (seed.kind === 'repo_path') dbSeed = { kind: 'repo_path', path: seed.storageRef };
                  }
                } catch { /* fallback to empty */ }
              }

              const r = await sbMgr.createForSession({
                sessionId: input.sessionId ?? null,
                projectId: input.projectId,
                userId,
                projectCwd: cwd,
                mode: input.mode as 'sandbox' | 'sandbox-preview' | 'interactive-chat',
                slug: input.slug,
                envStage,
                dbSeed,
              });
              return r.sandbox;
            },
            pause: (sandboxId: string) => sbMgr.pause(sandboxId),
            resume: (sandboxId: string) => sbMgr.resume(sandboxId),
            discard: async (sandboxId: string) => {
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
              const cwd = await resolveCwdForSb(sb.projectId);
              if (!cwd) throw new Error(`Project cwd unknown`);
              await sbMgr.discard(sandboxId, cwd);
            },
            merge: async (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string; confirmDirect?: boolean }) => {
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) return { ok: false, reason: 'Sandbox not found' };
              const cwd = await resolveCwdForSb(sb.projectId);
              if (!cwd) return { ok: false, reason: 'Project cwd unknown' };
              const proj = projectsRepoForSb ? await projectsRepoForSb.getByIdAnyOwner(sb.projectId) : null;
              const strat = (opts.strategy === 'direct' ? 'direct' : 'pr') as 'direct' | 'pr';
              // v723 — Safety: direct-merge erfordert explizite Bestätigung. Verhindert dass ein
              // verirrter Frontend-Call (siehe v722 confirm()-UX-Bug) versehentlich auf main pusht.
              if (strat === 'direct' && opts.confirmDirect !== true) {
                return { ok: false, reason: 'Direct-Merge erfordert explizite Bestätigung (confirmDirect=true im Request).' };
              }
              return sbMgr.merge(sandboxId, {
                strategy: strat,
                commitMessage: opts.commitMessage,
                prTitle: opts.prTitle,
                prBody: opts.prBody,
                projectCwd: cwd,
                forgeConfig: this.config.codeAgents?.forge,
                defaultBranch: proj?.defaultBranch ?? this.config.codeAgents?.forge?.baseBranch,
                repoUrl: proj?.repoUrl,
              });
            },
            diff: async (sandboxId: string) => {
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
              try {
                // v795 — gitInWorktree() für sudo-u-wrap (dubious-ownership-safe)
                const { stdout } = await this.gitInWorktree(sb.worktreePath, ['diff', `${sb.baseCommitSha}..HEAD`], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
                return stdout || '(no changes)';
              } catch (err) {
                return `# git diff failed: ${(err as Error).message}`;
              }
            },
            // v728 — Restart/Logs/Stats für Toolbar im Interactive-Chat
            restart: (sandboxId: string) => sbMgr.restart(sandboxId),
            getLogs: (sandboxId: string, tail: number) => sbMgr.getLogs(sandboxId, tail),
            getStats: (sandboxId: string) => sbMgr.getStats(sandboxId),
            // v748 — Force-Fail für stuck sandboxes
            forceFail: (sandboxId: string, reason?: string) => sbMgr.forceFail(sandboxId, reason),
            // v703/v704 — Sandbox-Chat (Interactive-Mode) mit Live-Enrichment
            chatList: async (sandboxId: string) => {
              const messages = await sandboxChatRepo.list(sandboxId);
              // v704 — Für jede Agent-Message mit task_id: aktuellen Project-Agent-Status holen
              // und phase + text live anreichern (done → Summary, failed → Error, sonst Phase).
              if (!this.database) return messages;
              try {
                const { ProjectAgentSessionRepository } = await import('@alfred/storage');
                const sessRepo = new ProjectAgentSessionRepository(this.database.getAdapter());
                const enriched: typeof messages = [];
                for (const m of messages) {
                  if (m.role !== 'agent' || !m.taskId) { enriched.push(m); continue; }
                  try {
                    const sess = await sessRepo.getByTaskId(m.taskId);
                    if (!sess) { enriched.push(m); continue; }
                    const phase = sess.currentPhase;
                    let text = m.text;
                    // Bei terminal-State: Summary aus Milestones + Commit + Files-Changed bauen
                    if (phase === 'done' || phase === 'failed') {
                      const milestones = Array.isArray(sess.milestones) ? sess.milestones : [];
                      const lastMs = milestones[milestones.length - 1] ?? '';
                      const commitSha = sess.lastCommitSha ? sess.lastCommitSha.slice(0, 8) : null;
                      const lines: string[] = [];
                      if (phase === 'done') {
                        lines.push(`✅ Fertig nach ${sess.currentIteration ?? 0} Iteration(en).`);
                      } else {
                        lines.push(`❌ Failed: ${(sess as any).failureInsight ?? 'unknown'}`);
                      }
                      if (sess.totalFilesChanged > 0) lines.push(`📝 ${sess.totalFilesChanged} Datei(en) geändert`);
                      if (commitSha) lines.push(`📦 Commit ${commitSha}`);
                      if (lastMs) lines.push(`\n${lastMs}`);
                      text = lines.join(' · ').replace(' · \n', '\n');
                    }
                    enriched.push({ ...m, text, taskPhase: phase });
                  } catch { enriched.push(m); }
                }
                return enriched;
              } catch { return messages; }
            },
            chatSendMessage: async (
              sandboxId: string,
              message: string,
              attachments?: Array<{ name: string; mime: string; dataUrl: string; dropInWorktree: boolean }>,
              mentions?: Array<{ id: string; type: 'open_item' | 'decision'; title: string; priority?: string; status?: string }>,
              engine?: 'project-agent' | 'code-agent' | 'discuss',
              /** v787 — Optional CLI-Agent-Override aus Frontend-Picker */
              agentNameOverride?: string,
            ) => {
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) return { ok: false, reason: 'Sandbox not found' };
              if (sb.status !== 'running' && sb.status !== 'paused') {
                return { ok: false, reason: `Sandbox in status ${sb.status} — kann keine Messages annehmen` };
              }
              // v704 — Concurrent-Block: prüfen ob bereits ein nicht-terminal Agent-Task läuft
              try {
                const { ProjectAgentSessionRepository: PASR } = await import('@alfred/storage');
                const sessRepo2 = new PASR(this.database!.getAdapter());
                const existing = await sandboxChatRepo.list(sandboxId);
                for (const m of existing.slice(-10)) {
                  if (m.role === 'agent' && m.taskId) {
                    const s = await sessRepo2.getByTaskId(m.taskId);
                    if (s && s.currentPhase !== 'done' && s.currentPhase !== 'failed') {
                      return { ok: false, reason: `Vorheriger Agent-Task läuft noch (phase=${s.currentPhase}). Bitte abwarten oder im Project-Chat stoppen.` };
                    }
                  }
                }
              } catch (err) { this.logger.debug({ err }, 'concurrent-check failed (continuing)'); }

              // v729a — Attachments verarbeiten BEVOR Project-Agent gestartet wird:
              //  (a) Audio (audio/*) → STT-Transkription → an message text appendieren
              //  (b) Files mit dropInWorktree=true → in /workspace/.alfred-uploads/ im worktree ablegen
              //  (c) Andere Files → als Goal-Hinweise an den Agent geben (Pfad-Referenz)
              let augmentedMessage = message;
              const droppedFiles: string[] = [];
              const contextFiles: Array<{ name: string; mime: string; sizeKB: number }> = [];
              const imageDescriptions: Array<{ name: string; description: string }> = [];
              if (attachments && attachments.length > 0) {
                const path = await import('node:path');
                const fs = await import('node:fs');
                const uploadsDir = path.join(sb.worktreePath, '.alfred-uploads');
                let uploadsDirReady = false;
                try { fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o755 }); uploadsDirReady = true; } catch (err) {
                  this.logger.warn({ err, uploadsDir }, 'v729a uploads-dir mkdir failed');
                }
                // .gitignore-Append damit Uploads nicht ins Repo committed werden
                try {
                  const gitignorePath = path.join(sb.worktreePath, '.gitignore');
                  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
                  if (!existing.includes('.alfred-uploads')) {
                    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
                    fs.writeFileSync(gitignorePath, existing + sep + '.alfred-uploads/\n', 'utf8');
                  }
                } catch { /* non-critical */ }

                for (const att of attachments) {
                  const isAudio = att.mime.startsWith('audio/');
                  // dataUrl ist "data:<mime>;base64,<payload>"
                  const commaIdx = att.dataUrl.indexOf(',');
                  if (commaIdx < 0) continue;
                  const payload = att.dataUrl.slice(commaIdx + 1);
                  let buf: Buffer;
                  try { buf = Buffer.from(payload, 'base64'); } catch { continue; }

                  if (isAudio) {
                    // (a) Audio → STT via Pipeline
                    try {
                      const transcript = await this.pipeline.transcribeAudioBuffer(buf, att.mime);
                      if (transcript) augmentedMessage = (augmentedMessage + ' ' + transcript).trim();
                      else this.logger.warn({ mime: att.mime }, 'v729a audio transcript empty or transcriber not configured');
                    } catch (err) {
                      this.logger.warn({ err }, 'v729a audio transcription failed');
                    }
                    continue;
                  }

                  if (att.dropInWorktree && uploadsDirReady) {
                    // (b) Datei in worktree ablegen
                    try {
                      const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
                      const target = path.join(uploadsDir, safeName);
                      fs.writeFileSync(target, buf, { mode: 0o644 });
                      droppedFiles.push(`.alfred-uploads/${safeName}`);
                    } catch (err) {
                      this.logger.warn({ err, name: att.name }, 'v729a file-drop failed');
                    }
                  } else {
                    // (c) Nur als Kontext-Referenz an den Agent
                    contextFiles.push({ name: att.name, mime: att.mime, sizeKB: Math.round(buf.length / 1024) });
                  }
                  // v736 — Image-Vision-Pass für ALLE Bilder (worktree + nicht-worktree).
                  // Vorher (v730) wurde Vision nur bei non-worktree-Bildern gemacht — Inkonsistenz,
                  // weil Agent ein Mockup im Worktree zwar findet aber Inhalt nicht sieht.
                  // Jetzt: Pfad-Referenz UND Description landen im Goal — Agent kann beim Code
                  // sowohl die Datei im Worktree referenzieren als auch wissen was drin ist.
                  if (att.mime.startsWith('image/') && this.llmProvider) {
                    try {
                      const result = await this.llmProvider.complete({
                        messages: [{
                          role: 'user',
                          content: [
                            { type: 'text', text: 'Beschreibe dieses Bild präzise auf Deutsch in 2-4 Sätzen für einen Code-Generator (Layout, Farben, sichtbare UI-Elemente, Text-Inhalte falls erkennbar). Keine Einleitung, direkt Beschreibung.' },
                            { type: 'image', source: { type: 'base64', media_type: att.mime, data: payload } },
                          ],
                        }],
                        maxTokens: 400,
                        tier: 'default',
                      });
                      const desc = result.content?.trim();
                      if (desc) {
                        imageDescriptions.push({ name: att.name, description: desc.slice(0, 1000) });
                      }
                    } catch (err) {
                      this.logger.debug({ err, name: att.name }, 'v730/v736 image-vision-pass failed (continuing without description)');
                    }
                  }
                }
                if (droppedFiles.length > 0) {
                  augmentedMessage += `\n\n[User-bereitgestellte Dateien im Worktree:]\n${droppedFiles.map(f => `- ${f}`).join('\n')}`;
                }
                if (contextFiles.length > 0) {
                  augmentedMessage += `\n\n[User-Referenz-Dateien (nicht im Worktree):]\n${contextFiles.map(f => `- ${f.name} (${f.mime}, ${f.sizeKB} KB)`).join('\n')}`;
                }
                if (imageDescriptions.length > 0) {
                  augmentedMessage += `\n\n[Bild-Beschreibungen vom Vision-LLM:]\n${imageDescriptions.map(i => `- ${i.name}: ${i.description}`).join('\n')}`;
                }
              }

              // v730 — Mentions: Open-Items / Decisions die der User explizit referenziert hat
              // werden ans Goal angehängt damit der Project-Agent klar weiß auf welchen Punkt
              // sich die Anfrage bezieht. Full-Item-Details (description) werden lazy aus DB
              // geladen falls nötig — hier nur Title+ID damit Goal kompakt bleibt.
              if (mentions && mentions.length > 0) {
                const lines: string[] = [];
                for (const m of mentions) {
                  const icon = m.type === 'open_item' ? (m.priority === 'high' ? '🔴' : m.priority === 'low' ? '⚪' : '🟡') : '🎯';
                  const typeLabel = m.type === 'open_item' ? 'Open-Item' : 'Decision';
                  const statusLabel = m.status ? ` [${m.status}]` : '';
                  lines.push(`- ${icon} ${typeLabel} \`${m.id.slice(0, 8)}\`${statusLabel}: ${m.title}`);
                }
                augmentedMessage += `\n\n[Bezug auf folgende Items aus der Projekt-Roadmap:]\n${lines.join('\n')}\n\nWICHTIG: Implementiere konkret diese Items. Wenn ein Item erledigt wird, melde es im Done-Output damit es automatisch als done markiert wird.`;
              }

              // (1) User-Message persistieren (mit augmented text falls Voice/Files dazu)
              const userMsg = await sandboxChatRepo.append({
                sandboxId,
                userId: sb.userId,
                role: 'user',
                text: augmentedMessage,
              });
              // v769 — Branch 'discuss': Read-Only Code-Agent für Beratung statt Implementation
              if (engine === 'discuss') {
                const cAgent = this.codeAgentSkillRef;
                const codeAgents = this.config.codeAgents?.agents ?? [];
                if (!cAgent || codeAgents.length === 0) {
                  return { ok: false, userMessageId: userMsg.id, reason: 'code-agent nicht konfiguriert (config.codeAgents.enabled + agents) — Discuss-Modus braucht ihn für Codebase-Zugriff' };
                }
                const defaultAgent = codeAgents[0].name;

                // Chat-History als Context (gleiche Hybrid-Cap wie code-agent)
                const allHistoryD = await sandboxChatRepo.list(sandboxId);
                const MAX_MSGS_D = 15, MAX_CHARS_D = 16000, MIN_KEEP_D = 3;
                let trimmedD = allHistoryD.filter(m => m.id !== userMsg.id).slice(-MAX_MSGS_D);
                let totalD = trimmedD.reduce((s, m) => s + (m.text || '').length, 0);
                while (totalD > MAX_CHARS_D && trimmedD.length > MIN_KEEP_D) {
                  const r = trimmedD.shift();
                  totalD -= (r?.text || '').length;
                }
                const historyTextD = trimmedD.map(m => `${m.role === 'user' ? 'User:' : 'Agent:'} ${(m.text || '').slice(0, 1500)}`).join('\n\n');

                const discussPrompt = `READ-ONLY DISKUSSIONS-MODUS

Du bist ein Code-Berater. Diese Anfrage ist eine FRAGE oder BESPRECHUNG, KEINE Implementations-Anweisung.

DEINE AUFGABE:
1. Nutze deine Tools (Read, Glob, Grep) um die relevanten Code-Files im worktree zu LESEN und den aktuellen Stand zu verstehen
2. Antworte TEXTUELL strukturiert:
   - **Aktueller Stand**: Was findest du in der Codebase relevant für die Frage
   - **Optionen** (2-4): jeweils mit Trade-offs und Code-Skizze (kurz!)
   - **Empfehlung**: welche Option du nehmen würdest und warum
3. STRENGSTENS VERBOTEN:
   - KEINE Files editieren (kein Write, kein Edit)
   - KEINE git-Operations
   - KEINE Installs / Commands die State ändern
4. Der User wird danach mit "ja Option B" oder ähnlich antworten — DAS triggert dann eine separate Implementations-Runde im Quick-Modus.

Chat-Verlauf:
${historyTextD || '(noch keine vorherigen Nachrichten)'}

Aktuelle Frage des Users:
${augmentedMessage}`;

                const taskId = `code-${randomUUID()}`;
                // v802 — Capture initial-msg-id für in-place-update (gleich wie v793 Quick-Mode)
                const initialAgentMsg = await sandboxChatRepo.append({
                  sandboxId,
                  userId: sb.userId,
                  role: 'agent',
                  text: `💬 Berater liest Codebase …`,
                  taskId,
                  taskPhase: 'coding',
                });

                const abortController = new AbortController();
                this.codeAgentTaskAborts.set(taskId, abortController);

                // v792 — direkter Aufruf (static import oben)
                try { appendOutputLine(taskId, 'system', `💬 Discuss-Modus (read-only) startet im worktree ${sb.worktreePath}`); } catch { /* */ }

                // v802 — AgentSession-Path bevorzugt (Live-Cards, finishSession, --permission-mode=plan).
                // v818 Q1-Audit: Legacy cAgent.execute() bleibt aktiver Fallback.
                // Wird erreicht wenn: (a) agentSessionManager fehlt (selten),
                // (b) der gewählte Adapter nicht registriert ist (config-Fehler),
                // (c) der Adapter capabilities.structuredOutput=false hat (z.B. einige
                // codex/vibe-Varianten ohne stream-json). v792's subpath-import-Issue
                // betraf NUR appendOutputLine (live-output) — nicht den Skill selbst.
                const sessionAdapterD = this.agentSessionManager?.listAdapters().find(a => a.name === defaultAgent);
                const agentDefD = this.config.codeAgents?.agents.find(a => a.name === defaultAgent);
                const runAsUserD = (agentDefD?.command === 'sudo' && agentDefD.argsTemplate?.[0] === '-u' && agentDefD.argsTemplate?.[1])
                  ? agentDefD.argsTemplate[1]
                  : undefined;
                const useAgentSessionD = !!(this.agentSessionManager && sessionAdapterD && sessionAdapterD.capabilities.structuredOutput);

                (async () => {
                  try {
                    let resultSuccess = false;
                    let resultDisplay = '';
                    let resultError: string | undefined;

                    if (useAgentSessionD && this.agentSessionManager) {
                      // v802 — NEW PATH: AgentSession mit readOnly=true → live Cards, --permission-mode=plan
                      const collectedTextsD: string[] = [];
                      const collectedErrorsD: string[] = [];
                      const onEventD = (e: import('@alfred/skills').AgentEvent) => {
                        // Forward strukturierter Event ins Event-Stream (für Card-Rendering)
                        try { appendOutputEvent(taskId, e.type, e); } catch { /* */ }
                        // Text-Fallback für Backward-Compat
                        try {
                          switch (e.type) {
                            case 'session_id': appendOutputLine(taskId, 'system', `🔗 Session: ${(e.value as string).slice(0, 8)}…`); break;
                            case 'progress': appendOutputLine(taskId, 'system', `▸ ${e.phase}${e.detail ? ` (${e.detail})` : ''}`); break;
                            case 'text':
                              collectedTextsD.push(e.text);
                              appendOutputLine(taskId, 'stdout', e.text);
                              break;
                            case 'thinking': appendOutputLine(taskId, 'system', `🤔 ${e.text.slice(0, 200)}${e.text.length > 200 ? '…' : ''}`); break;
                            case 'tool_call': appendOutputLine(taskId, 'system', `🔧 ${e.tool}(${JSON.stringify(e.input).slice(0, 200)})`); break;
                            case 'edit': appendOutputLine(taskId, 'system', `✏️ ${e.path} (+${e.linesAdded}/-${e.linesRemoved})`); break;
                            case 'shell':
                              if (e.status === 'running') appendOutputLine(taskId, 'system', `$ ${e.command.slice(0, 200)}`);
                              else appendOutputLine(taskId, 'system', `  ↳ exit=${e.exitCode ?? '?'}`); break;
                            case 'usage':
                              appendOutputLine(taskId, 'system', `📊 tokens: ${e.inputTokens}in/${e.outputTokens}out, cached=${e.cachedTokens ?? 0}${e.costUsd ? `, $${e.costUsd.toFixed(4)}` : ''}`);
                              sandboxChatRepo.updateTaskPhase(taskId, 'finalizing').catch(() => { /* */ });
                              break;
                            case 'error':
                              collectedErrorsD.push(e.message);
                              appendOutputLine(taskId, 'stderr', e.message); break;
                          }
                        } catch { /* */ }
                      };
                      try {
                        const r = await this.agentSessionManager.invoke({
                          sandboxId,
                          agentName: defaultAgent,
                          prompt: discussPrompt,
                          cwd: sb.worktreePath,
                          runAsUser: runAsUserD,
                          signal: abortController.signal,
                          onEvent: onEventD,
                          readOnly: true, // v802 — claude bekommt --permission-mode=plan
                          embeddingLookup: this.buildConventionsEmbeddingLookup(sb.projectId, sb.userId), // v830
                        });
                        resultSuccess = r.exitCode === 0;
                        resultError = resultSuccess ? undefined : (collectedErrorsD.join('; ') || 'discuss run failed');
                        resultDisplay = r.finalText ?? collectedTextsD.join('\n');
                      } catch (err) {
                        resultSuccess = false;
                        resultError = (err as Error).message;
                        resultDisplay = '';
                      }
                    } else {
                      // LEGACY PATH: cAgent.execute (kein Live-Feedback, no stream-json)
                      const ctxD = { userId: sb.userId, masterUserId: sb.userId, chatId: '', platform: 'api', conversationId: '', abortSignal: abortController.signal } as any;
                      const r = await cAgent.execute({
                        action: 'run',
                        agent: defaultAgent,
                        prompt: discussPrompt,
                        cwd: sb.worktreePath,
                        taskId,
                      }, ctxD);
                      resultSuccess = !!r.success;
                      resultError = r.error;
                      resultDisplay = r.display ?? '';
                    }

                    // Safety-Net: hat der Agent trotz Verbot was geändert?
                    // v795 — gitInWorktree() für sudo-u-wrap (dubious-ownership-safe)
                    let revertNote = '';
                    try {
                      const { stdout: porcelainD } = await this.gitInWorktree(sb.worktreePath, ['status', '--porcelain'], { maxBuffer: 1024 * 1024, timeout: 10_000 });
                      if (porcelainD.trim()) {
                        this.logger.warn({ sandboxId, taskId, dirty: porcelainD.slice(0, 500) }, 'v769 Discuss-Modus: Agent hat Files geändert obwohl read-only — Revert');
                        try { await this.gitInWorktree(sb.worktreePath, ['checkout', '--', '.'], { timeout: 20_000 }); } catch { /* */ }
                        try { await this.gitInWorktree(sb.worktreePath, ['clean', '-fd'], { timeout: 20_000 }); } catch { /* */ }
                        revertNote = `\n\n⚠️ **Hinweis**: Der Agent hat versucht Files zu ändern obwohl Read-Only — Änderungen wurden automatisch revertiert. Bei Bedarf wechsle in ⚡ Quick-Modus für tatsächliche Implementation.`;
                      }
                    } catch (err) {
                      this.logger.warn({ err }, 'v769 Discuss safety-revert failed (non-fatal)');
                    }

                    const display = (resultDisplay ?? '').slice(0, 6000);
                    // v802 — In-Place-Update der initialen Bubble (statt separater Append)
                    await sandboxChatRepo.updateMessage(initialAgentMsg.id, {
                      text: `💬 Beratung${resultSuccess ? '' : ' (mit Fehler)'}\n\n${display}${revertNote}`,
                      phase: resultSuccess ? 'done' : 'failed',
                    });

                    // v802 — finishSession damit Discuss unter "Letzte Sessions" sichtbar wird (gleich wie v799 Quick-Mode)
                    if (useAgentSessionD && this.projectManager) {
                      try {
                        await this.projectManager.finishSession({
                          userId: sb.userId,
                          sessionType: 'code_agent',
                          sourceId: taskId,
                          goal: augmentedMessage,
                          cwd: sb.worktreePath,
                          projectId: sb.projectId,
                          success: resultSuccess,
                          transcript: display,
                          files: [],
                          totalFilesChanged: 0,
                          startedAt: initialAgentMsg.createdAt,
                        });
                      } catch (err) {
                        this.logger.warn({ err, taskId }, 'v802 finishSession after Discuss run failed (non-critical)');
                      }
                    }
                  } catch (err) {
                    const aborted = abortController.signal.aborted;
                    await sandboxChatRepo.updateMessage(initialAgentMsg.id, {
                      text: aborted ? '⏹ Discuss vom User gestoppt.' : `❌ Discuss-Fehler: ${(err as Error).message}`,
                      phase: aborted ? 'stopped' : 'failed',
                    });
                  } finally {
                    this.codeAgentTaskAborts.delete(taskId);
                    // v792 — direkter Aufruf (static import oben)
                    try { markOutputEnded(taskId); } catch { /* */ }
                  }
                })().catch(err => this.logger.warn({ err }, 'v769 discuss fire-and-forget failed'));

                return { ok: true, userMessageId: userMsg.id, taskId };
              }

              // v760 — Branch nach engine: 'code-agent' = light/iterativ, sonst project-agent (default)
              if (engine === 'code-agent') {
                const cAgent = this.codeAgentSkillRef;
                const codeAgents = this.config.codeAgents?.agents ?? [];
                if (!cAgent || codeAgents.length === 0) {
                  return { ok: false, userMessageId: userMsg.id, reason: 'code-agent nicht konfiguriert (config.codeAgents.enabled + agents)' };
                }
                // v787 — Frontend kann via agentNameOverride eine spezifische CLI wählen.
                // Wir nehmen die nur wenn sie tatsächlich konfiguriert ist (sonst silent fallback auf default).
                const requestedAgent = agentNameOverride && codeAgents.some(a => a.name === agentNameOverride)
                  ? agentNameOverride
                  : codeAgents[0].name;
                const defaultAgent = requestedAgent;

                // Hybrid-Cap: letzte 15 Messages ODER ~4000 Tokens (~16000 chars), min 3 behalten
                const allHistory = await sandboxChatRepo.list(sandboxId);
                const MAX_MSGS = 15, MAX_CHARS = 16000, MIN_KEEP = 3;
                let trimmedHistory = allHistory.filter(m => m.id !== userMsg.id).slice(-MAX_MSGS);
                let totalChars = trimmedHistory.reduce((s, m) => s + (m.text || '').length, 0);
                while (totalChars > MAX_CHARS && trimmedHistory.length > MIN_KEEP) {
                  const removed = trimmedHistory.shift();
                  totalChars -= (removed?.text || '').length;
                }
                const historyText = trimmedHistory.map(m => {
                  const prefix = m.role === 'user' ? 'User:' : 'Agent:';
                  return `${prefix} ${(m.text || '').slice(0, 1500)}`;
                }).join('\n\n');
                const prompt = `Du arbeitest iterativ in einem Sandbox-Container an einem Projekt. Bisheriger Chat-Verlauf:

${historyText || '(noch keine vorherigen Nachrichten)'}

Neue Aufgabe:
${augmentedMessage}

Wichtig:
- Implementiere fokussiert nur diese eine Änderung. Keine Refactoring-Tangenten.
- Halte dich strikt an die Anfrage.
- Du arbeitest in einem git worktree — Änderungen werden am Ende automatisch committed.
- Wenn unklar was gemeint ist, nimm die plausibelste Interpretation, frag NICHT nach.`;

                const taskId = `code-${randomUUID()}`;
                // v793 — Capture initial agent-msg-id für In-Place-Update beim Run-Ende.
                const initialAgentMsg = await sandboxChatRepo.append({
                  sandboxId,
                  userId: sb.userId,
                  role: 'agent',
                  text: `⚡ Code-Agent läuft (${defaultAgent}) …`,
                  taskId,
                  taskPhase: 'coding',
                });

                // v762 — AbortController für Stop-Support registrieren
                const abortController = new AbortController();
                this.codeAgentTaskAborts.set(taskId, abortController);

                // v769 — Initial-System-Line damit User sieht "verbunden"
                // v792 — direkter Aufruf (static import oben)
                try { appendOutputLine(taskId, 'system', `▶ Code-Agent (${defaultAgent}) startet im worktree ${sb.worktreePath}`); } catch { /* */ }

                // v781 — Determine if AgentSession-Path is available (claude-code adapter registered)
                const sessionAdapter = this.agentSessionManager?.listAdapters().find(a => a.name === defaultAgent);
                const agentDef = this.config.codeAgents?.agents.find(a => a.name === defaultAgent);
                const runAsUser = (agentDef?.command === 'sudo' && agentDef.argsTemplate?.[0] === '-u' && agentDef.argsTemplate?.[1])
                  ? agentDef.argsTemplate[1]
                  : undefined;
                const useAgentSession = !!(this.agentSessionManager && sessionAdapter);

                if (useAgentSession) {
                  this.logger.info({ agent: defaultAgent, runAsUser, sandbox: sandboxId }, 'v781 using AgentSession-path (persistent CLI session)');
                }

                /** Normalisierte Run-Result-Shape, unabhängig vom Pfad. */
                interface NormalizedRunResult { success: boolean; error?: string; stderr?: string; modifiedFiles: string[]; display: string; }

                const runOnce = async (currentPrompt: string): Promise<NormalizedRunResult> => {
                  if (useAgentSession && this.agentSessionManager) {
                    // v781 — NEW PATH: AgentSessionManager mit persistent CLI-Session
                    // v792 — direkter Aufruf der static-imports statt dynamic subpath imports.
                    // Letztere failten zur Laufzeit (ERR_MODULE_NOT_FOUND wegen package.json
                    // exports nur "."), wurden vom try-catch silent geschluckt → buffer leer.
                    const collectedTexts: string[] = [];
                    const collectedErrors: string[] = [];
                    const appendOutputLineFn = appendOutputLine;
                    const appendOutputEventFn = appendOutputEvent;
                    const onEvent = (e: import('@alfred/skills').AgentEvent) => {
                      // v782 — Auch strukturierten Event ins Event-Stream pushen (für Card-Rendering)
                      try { appendOutputEventFn(taskId, e.type, e); } catch { /* */ }
                      // Forward to live-output text-lines (Backward-compat)
                      try {
                        switch (e.type) {
                          case 'session_id':
                            appendOutputLineFn(taskId, 'system', `🔗 Session: ${(e.value as string).slice(0, 8)}…`); break;
                          case 'progress':
                            appendOutputLineFn(taskId, 'system', `▸ ${e.phase}${e.detail ? ` (${e.detail})` : ''}`); break;
                          case 'text':
                            collectedTexts.push(e.text);
                            appendOutputLineFn(taskId, 'stdout', e.text); break;
                          case 'thinking':
                            appendOutputLineFn(taskId, 'system', `🤔 ${e.text.slice(0, 200)}${e.text.length > 200 ? '…' : ''}`); break;
                          case 'tool_call':
                            appendOutputLineFn(taskId, 'system', `🔧 ${e.tool}(${JSON.stringify(e.input).slice(0, 200)})`); break;
                          case 'tool_result':
                            appendOutputLineFn(taskId, 'system', `  ↳ result`); break;
                          case 'edit':
                            appendOutputLineFn(taskId, 'system', `✏️  ${e.path} (+${e.linesAdded}/-${e.linesRemoved})`); break;
                          case 'shell':
                            if (e.status === 'running') appendOutputLineFn(taskId, 'system', `$ ${e.command.slice(0, 200)}`);
                            else appendOutputLineFn(taskId, 'system', `  ↳ exit=${e.exitCode ?? '?'}`); break;
                          case 'usage':
                            appendOutputLineFn(taskId, 'system', `📊 tokens: ${e.inputTokens}in/${e.outputTokens}out, cached=${e.cachedTokens ?? 0}${e.costUsd ? `, $${e.costUsd.toFixed(4)}` : ''}`);
                            // v793 — Agent intern fertig (usage = letztes adapter-event vor close).
                            // Stop-Button + CODING-Badge sofort weg. Final-Update mit Summary kommt
                            // nach auto-commit (in-place auf initialAgentMsg.id).
                            sandboxChatRepo.updateTaskPhase(taskId, 'finalizing').catch(err => {
                              this.logger.warn({ err, taskId }, 'v793 finalizing flip failed');
                            });
                            break;
                          case 'error':
                            collectedErrors.push(e.message);
                            appendOutputLineFn(taskId, 'stderr', e.message); break;
                        }
                      } catch { /* */ }
                    };
                    try {
                      const r = await this.agentSessionManager.invoke({
                        sandboxId,
                        agentName: defaultAgent,
                        prompt: currentPrompt,
                        cwd: sb.worktreePath,
                        runAsUser,
                        signal: abortController.signal,
                        onEvent,
                        embeddingLookup: this.buildConventionsEmbeddingLookup(sb.projectId, sb.userId), // v830
                      });
                      const success = r.exitCode === 0;
                      return {
                        success,
                        error: success ? undefined : (collectedErrors.join('; ') || 'agent run failed'),
                        stderr: collectedErrors.join('\n'),
                        modifiedFiles: r.modifiedFiles,
                        display: (r.finalText ?? collectedTexts.join('\n')).slice(0, 3000),
                      };
                    } catch (err) {
                      return {
                        success: false,
                        error: (err as Error).message,
                        stderr: (err as Error).message,
                        modifiedFiles: [],
                        display: '',
                      };
                    }
                  }
                  // LEGACY PATH: cAgent.execute mit frischem subprocess pro call (kein session-cache)
                  const ctxCa = { userId: sb.userId, masterUserId: sb.userId, chatId: '', platform: 'api', conversationId: '', abortSignal: abortController.signal } as any;
                  const r = await cAgent.execute({
                    action: 'run',
                    agent: defaultAgent,
                    prompt: currentPrompt,
                    cwd: sb.worktreePath,
                    taskId,
                  }, ctxCa);
                  return {
                    success: !!r.success,
                    error: r.error,
                    stderr: (r.data as any)?.stderr,
                    modifiedFiles: (r.data as any)?.modifiedFiles ?? [],
                    display: r.display ?? '',
                  };
                };

                // Fire-and-forget — User-Chat pollt nachträglich via fetchSandboxChat
                (async () => {
                  try {
                    // v760 Phase 3 — Retry-Loop: bei Agent-Fail bis zu 2 Versuche mit Error-Context
                    const MAX_ATTEMPTS = 2;
                    let attempts = 0;
                    let currentPrompt = prompt;
                    let result: NormalizedRunResult = { success: false, modifiedFiles: [], display: '' };
                    while (attempts < MAX_ATTEMPTS) {
                      attempts++;
                      if (attempts > 1) {
                        await sandboxChatRepo.append({
                          sandboxId,
                          userId: sb.userId,
                          role: 'agent',
                          text: `🔁 Fix-Versuch ${attempts}/${MAX_ATTEMPTS} …`,
                          taskId,
                          taskPhase: 'coding',
                        });
                      }
                      result = await runOnce(currentPrompt);
                      if (result.success) break;
                      // Failure → Retry-Prompt mit Error-Context bauen (falls noch Versuche übrig)
                      if (attempts < MAX_ATTEMPTS) {
                        const errOutput = (result.stderr || result.error || '').slice(0, 1500);
                        currentPrompt = `Der vorherige Versuch (${attempts}/${MAX_ATTEMPTS}) ist fehlgeschlagen. Fehler:

${errOutput || '(kein Fehler-Output)'}

Original-Aufgabe:
${prompt}

Bitte korrigiere den Fehler und implementiere die Aufgabe nochmal. Falls die Aufgabe selbst unklar ist, nimm die plausibelste Interpretation.`;
                      }
                    }

                    // v760 Phase 2 — Auto-Commit nach erfolgreichem Run
                    // v795 — gitInWorktree() statt direkter execFile-git → sudo -u <owner> wrap
                    // wenn alfred als root läuft + worktree gehört einem anderen User.
                    // Behebt "fatal: detected dubious ownership in repository".
                    let commitNote = '';
                    let commitSha = ''; // v794 — separat tracken: nur bei echtem Success setzen
                    if (result.success) {
                      try {
                        const { stdout: porcelain } = await this.gitInWorktree(sb.worktreePath, ['status', '--porcelain'], { maxBuffer: 1024 * 1024, timeout: 15_000 });
                        if (porcelain.trim()) {
                          // Commit-Msg aus User-Message (erste Zeile, sanitized, capped)
                          const firstLine = augmentedMessage.split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 72) || 'iteration';
                          const commitMsg = `[alfred-code-agent] ${firstLine}`;
                          await this.gitInWorktree(sb.worktreePath, ['add', '-A'], { timeout: 30_000 });
                          await this.gitInWorktree(sb.worktreePath, ['commit', '-m', commitMsg], { timeout: 30_000 });
                          const { stdout: shaRaw } = await this.gitInWorktree(sb.worktreePath, ['rev-parse', 'HEAD'], { timeout: 10_000 });
                          commitSha = shaRaw.trim().slice(0, 8);
                          commitNote = ` · commit \`${commitSha}\``;
                        } else {
                          commitNote = ' · keine Änderungen';
                        }
                      } catch (err) {
                        this.logger.warn({ err, sandboxId }, 'v760 auto-commit failed (continuing)');
                        commitNote = ` · (commit fehlgeschlagen: ${(err as Error).message.slice(0, 60)})`;
                      }
                    }

                    const attemptNote = attempts > 1 ? ` (nach ${attempts} Versuchen)` : '';
                    // v794 — commitNote zurück in Summary-Zeile (war in v793 unterschlagen → commit-fail nicht mehr sichtbar)
                    const summary = result.success
                      ? `✓ Fertig${attemptNote}${result.modifiedFiles.length ? ` — ${result.modifiedFiles.length} Dateien geändert` : ''}${commitNote}${useAgentSession ? ' · 🔗' : ''}`
                      : `❌ Fehlgeschlagen nach ${attempts} Versuchen: ${result.error ?? 'unbekannt'}`;
                    const display = (result.display ?? '').slice(0, 3000);
                    // v793 — In-Place-Update der initialen "läuft"-Bubble statt separater Append.
                    // Eine Bubble pro Run, transitioniert von "läuft" → "✓ Fertig".
                    await sandboxChatRepo.updateMessage(initialAgentMsg.id, {
                      text: `${summary}${display ? `\n\n${display}` : ''}`,
                      phase: result.success ? 'done' : 'failed',
                    });
                    // v793/v794 — Separate kompakte Notiz-Bubble NUR bei echtem commit-sha
                    // (nicht bei "keine Änderungen" oder commit-Failure — die stehen schon inline).
                    if (commitSha) {
                      await sandboxChatRepo.append({
                        sandboxId,
                        userId: sb.userId,
                        role: 'agent',
                        text: `🔧 · commit \`${commitSha}\``,
                        taskId,
                        taskPhase: 'done',
                      });
                    }

                    // v799 — Im v781 NEW PATH (AgentSession) wird `codeAgentSkill.execute()`
                    // bypassed → der `setSessionCompletionCallback` (alfred.ts:1110) feuert
                    // NICHT → keine project_sessions-Row, keine Open-Items-Extraction.
                    // Folge: Quick-Mode-Arbeit war unsichtbar unter "Letzte Sessions" und
                    // Items wurden nicht ge-summarized.
                    // Fix: nach NEW-PATH-Run manuell finishSession() rufen.
                    // Legacy-Path (cAgent.execute) erhält weiterhin Callback → KEIN double-insert.
                    if (useAgentSession && this.projectManager) {
                      try {
                        await this.projectManager.finishSession({
                          userId: sb.userId,
                          sessionType: 'code_agent',
                          sourceId: taskId,
                          goal: augmentedMessage,
                          cwd: sb.worktreePath,
                          projectId: sb.projectId, // v798 — explicit, verhindert orphan
                          success: result.success,
                          transcript: display,
                          files: result.modifiedFiles,
                          totalFilesChanged: result.modifiedFiles.length,
                          startedAt: initialAgentMsg.createdAt,
                          // v812 — Quick-Run läuft IMMER in einer Sandbox → 'pending' bis Merge.
                          // Analytik (Arbeitszeit/Agent) zählt trotzdem; Open-Items werden bei
                          // Discard entfernt, bei Merge bestätigt.
                          mergeState: 'pending',
                          sandboxId,
                        });
                      } catch (err) {
                        this.logger.warn({ err, taskId, sandboxId }, 'v799 finishSession after AgentSession run failed (non-critical, run results still in git)');
                      }
                    }
                  } catch (err) {
                    const aborted = abortController.signal.aborted;
                    // v793 — Auch bei Fehler: in-place-Update statt append.
                    await sandboxChatRepo.updateMessage(initialAgentMsg.id, {
                      text: aborted
                        ? '⏹ Vom User gestoppt.'
                        : `❌ Code-Agent-Fehler: ${(err as Error).message}`,
                      phase: aborted ? 'stopped' : 'failed',
                    });
                  } finally {
                    // v762 — Cleanup: AbortController-Eintrag entfernen
                    this.codeAgentTaskAborts.delete(taskId);
                    // v769 — Output-Buffer als ended markieren (retain 5min für nachladende UIs)
                    // v792 — direkter Aufruf (static import oben)
                    try { markOutputEnded(taskId); } catch { /* */ }
                  }
                })().catch(err => this.logger.warn({ err }, 'v760 code-agent fire-and-forget failed'));

                return { ok: true, userMessageId: userMsg.id, taskId };
              }

              // (2) Project-Agent-Task starten mit cwd=worktree
              const skill = this.skillRegistry?.get('project_agent');
              if (!skill) return { ok: false, userMessageId: userMsg.id, reason: 'project_agent-Skill nicht registriert' };
              const ownerChat = this.config.security?.ownerUserId ?? '';
              const ownerPlatform = (this.config.telegram?.enabled ? 'telegram' : this.config.matrix?.enabled ? 'matrix' : 'api');
              const ctx = { userId: sb.userId, masterUserId: sb.userId, chatId: ownerChat, platform: ownerPlatform, conversationId: '' } as any;
              // Activity-Touch (sandbox idle-timer reset)
              sandboxRepoForApi.touchActivity(sandboxId).catch(() => { /* */ });

              // v802 — Plan-Mode bekommt Chat-Verlauf als Kontext (vorher: nur "option c" ohne Bezug).
              // Wenn User von Discuss→Plan wechselt mit kurzer Antwort "option c", wusste der
              // project-agent nicht was "option c" sich bezieht. Jetzt: history wird ans goal
              // prepended (gleiche Hybrid-Cap-Logik wie Quick/Discuss).
              const allHistoryP = await sandboxChatRepo.list(sandboxId);
              const MAX_MSGS_P = 15, MAX_CHARS_P = 16000, MIN_KEEP_P = 3;
              let trimmedP = allHistoryP.filter(m => m.id !== userMsg.id).slice(-MAX_MSGS_P);
              let totalP = trimmedP.reduce((s, m) => s + (m.text || '').length, 0);
              while (totalP > MAX_CHARS_P && trimmedP.length > MIN_KEEP_P) {
                const r = trimmedP.shift();
                totalP -= (r?.text || '').length;
              }
              const historyTextP = trimmedP.map(m => `${m.role === 'user' ? 'User:' : 'Agent:'} ${(m.text || '').slice(0, 1500)}`).join('\n\n');
              const planGoal = trimmedP.length > 0
                ? `Bisheriger Chat-Verlauf (für Kontext):\n\n${historyTextP}\n\nAktuelle Aufgabe:\n${augmentedMessage}`
                : augmentedMessage;

              // v815 PL3 — Start-Retry: bei transientem Start-Fail (z.B. LLM-Provider
                // gerade nicht erreichbar während des project-planner-Calls) ein Mal mit
                // 2s Pause neu versuchen. Quick hatte das seit v760, Plan nicht — der
                // Audit deckte diese Asymmetrie auf.
              try {
                let result = await skill.execute({
                  action: 'start',
                  goal: planGoal,
                  cwd: sb.worktreePath,
                  // v721 — sandbox_id mitgeben damit Completion-Callback zum Original-Project bindet statt Ghost-Project zu erzeugen
                  sandbox_id: sandboxId,
                  // v731 — mention-IDs ans skill → session-Persist → completion-callback macht Auto-Done-Mark
                  mentioned_item_ids: mentions && mentions.length > 0 ? mentions.map(m => m.id) : undefined,
                }, ctx);
                if (!result.success) {
                  this.logger.warn({ taskId: undefined, sandboxId, error: result.error }, 'v815 PL3 plan start failed, retrying once in 2s');
                  await new Promise((r) => setTimeout(r, 2000));
                  result = await skill.execute({
                    action: 'start',
                    goal: planGoal,
                    cwd: sb.worktreePath,
                    sandbox_id: sandboxId,
                    mentioned_item_ids: mentions && mentions.length > 0 ? mentions.map(m => m.id) : undefined,
                  }, ctx);
                }
                const taskId = (result.data as any)?.taskId;
                if (taskId) {
                  await sandboxChatRepo.append({
                    sandboxId,
                    userId: sb.userId,
                    role: 'agent',
                    text: '⏳ Agent läuft …',
                    taskId,
                    taskPhase: 'planning',
                  });
                }
                return { ok: !!result.success, userMessageId: userMsg.id, taskId, reason: result.error };
              } catch (err) {
                return { ok: false, userMessageId: userMsg.id, reason: (err as Error).message };
              }
            },
            // v771 — Resume failed/stopped Project-Agent-Task via project_agent.execute(resume).
            // Code-Agent-Tasks (code-*) können NICHT resumed werden — die sind fire-and-forget ohne Plan-Tracking.
            chatResumeTask: async (sandboxIdR: string, failedTaskId: string) => {
              if (failedTaskId.startsWith('code-')) {
                return { ok: false, reason: 'Code-Agent-Tasks können nicht resumed werden — neuen ⚡ Quick-Run starten.' };
              }
              if (!this.projectAgentSkillRef) {
                return { ok: false, reason: 'Project-Agent-Skill nicht registriert' };
              }
              try {
                const ownerUid = this.tryOwner() ?? '';
                // v772 — userRole='admin' für Konsistenz mit stop, falls Resume später auch verifyTaskAccess nutzt
                const ctx = { userId: ownerUid, masterUserId: ownerUid, chatId: '', platform: 'api', conversationId: '', userRole: 'admin' } as any;
                const r = await this.projectAgentSkillRef.execute({ action: 'resume', failed_task_id: failedTaskId }, ctx);
                if (!r.success) {
                  return { ok: false, reason: r.error ?? 'Resume fehlgeschlagen' };
                }
                const newTaskId = (r.data as any)?.taskId;
                if (newTaskId) {
                  // User sieht eine neue "Resume gestartet"-Message im Chat
                  await sandboxChatRepo.append({
                    sandboxId: sandboxIdR,
                    userId: this.ownerMasterUserId ?? ownerUid,
                    role: 'agent',
                    text: `🔄 Resume von Task \`${failedTaskId.slice(0, 8)}…\` gestartet. Neue Task-ID: \`${newTaskId.slice(0, 8)}…\``,
                    taskId: newTaskId,
                    taskPhase: 'planning',
                  });
                }
                return { ok: true, taskId: newTaskId };
              } catch (err) {
                return { ok: false, reason: (err as Error).message };
              }
            },

            // v762 — Stop einen laufenden Task. taskId aus chatSendMessage-Response.
            // v763 — Robust: auch wenn nicht im Memory-Map (z.B. nach Alfred-Restart), DB als stopped markieren
            // v765 — Funktioniert auch für Project-Agent-Tasks (UUID ohne Prefix): falls Code-Agent-Map kein
            //        Match → check ob es ein laufender Project-Agent-Task ist und delegiere; sonst DB-only stop.
            chatStopTask: async (sandboxId: string, taskId: string) => {
              // 1) Code-Agent Live-Task im Memory-Map?
              const ctrl = this.codeAgentTaskAborts.get(taskId);
              if (ctrl) {
                ctrl.abort();
                this.codeAgentTaskAborts.delete(taskId);
                return { ok: true };
              }
              // 2) Status in DB checken
              const stillActive = await sandboxChatRepo.hasActiveTaskPhase(taskId);
              if (!stillActive) {
                return { ok: false, reason: `Task ${taskId} ist bereits beendet` };
              }
              // 3) v765 — Falls Project-Agent: versuche dort sauber zu stoppen
              if (!taskId.startsWith('code-') && this.projectAgentSkillRef) {
                try {
                  const ownerUid = this.tryOwner() ?? '';
                  // v772 — userRole='admin' damit verifyTaskAccess in project-agent-skill durchlässt
                  // (sonst chatId=='' Check schlägt fehl → falsch-orphan-marking, Agent läuft echt weiter)
                  const ctx = { userId: ownerUid, masterUserId: ownerUid, chatId: '', platform: 'api', conversationId: '', userRole: 'admin' } as any;
                  const r = await this.projectAgentSkillRef.execute({ action: 'stop', task_id: taskId }, ctx);
                  if (!r.success) {
                    this.logger.warn({ taskId, error: r.error }, 'v772 project_agent.stop returned failure — falling back to orphan-mark');
                  }
                  if (r.success) {
                    await sandboxChatRepo.updateTaskPhase(taskId, 'stopped');
                    await sandboxChatRepo.append({
                      sandboxId,
                      userId: ownerUid || 'unknown',
                      role: 'agent',
                      text: '⏹ Project-Agent-Task gestoppt (User-Request).',
                      taskId,
                      taskPhase: 'stopped',
                    });
                    return { ok: true };
                  }
                } catch (err) {
                  this.logger.warn({ err, taskId }, 'v765 project_agent.stop failed, falling back to DB-only mark');
                }
              }
              // 4) Orphan (Restart-Überrest oder unbekannter Task-Typ): DB-only-Mark
              await sandboxChatRepo.updateTaskPhase(taskId, 'stopped');
              await sandboxChatRepo.append({
                sandboxId,
                userId: this.tryOwner() ?? 'unknown',
                role: 'agent',
                text: '⏹ Task war verwaist und wurde als gestoppt markiert.',
                taskId,
                taskPhase: 'stopped',
              });
              return { ok: true };
            },
          });
          this.logger.info('v699 Sandbox CRUD-API + v703 Chat registered');

          // v698 — Sandbox-Preview-Proxy-Resolver
          if ('setSandboxProxyResolver' in apiAdapter && this.webAuthCallback) {
            const authCb = this.webAuthCallback;
            (apiAdapter as any).setSandboxProxyResolver(async (sandboxId: string, token: string | null) => {
              if (!token) return { ok: false, status: 401, message: 'Missing token' };
              const user = await authCb.getUserByToken(token);
              if (!user) return { ok: false, status: 401, message: 'Invalid or expired token' };
              const sb = await sandboxRepoForApi.getById(sandboxId);
              if (!sb) return { ok: false, status: 404, message: 'Sandbox not found' };
              // v714 — Ownership: direkter Match ODER Owner-mit-Legacy-UID-Bridge (alte Sandboxes)
              const directMatch = sb.userId === user.userId;
              const isOwnerLegacyBridge = (user.userId === this.ownerMasterUserId) && this.legacyDataUids.includes(sb.userId);
              if (!directMatch && !isOwnerLegacyBridge) {
                return { ok: false, status: 403, message: 'You do not own this sandbox' };
              }
              if (sb.status !== 'running') return { ok: false, status: 409, message: `Sandbox is ${sb.status} — not running` };
              if (typeof sb.hostPort !== 'number') return { ok: false, status: 503, message: 'Sandbox has no host port' };
              sandboxRepoForApi.touchActivity(sandboxId).catch(() => { /* */ });
              return { ok: true, hostPort: sb.hostPort, userId: sb.userId };
            });
            this.logger.info('v698 Sandbox-Preview-Proxy registered (/preview/<sandboxId>/*)');
          }
        } catch (err) {
          this.logger.warn({ err }, 'v699 Sandbox API wiring failed (non-fatal)');
        }
      }

      // v639 — Wire Goals API
      if (apiAdapter && this.database && 'setGoalsCallbacks' in apiAdapter) {
        try {
          const { GoalsRepository: GoalsRepo } = await import('@alfred/storage');
          const goalsRepoForApi = new GoalsRepo(this.database.getAdapter());
          // v805 — Nur ownerMasterUserId (UUID nach v804-init). Fallback zu
          // config.ownerUserId entfernt — der war Telegram-ID-Format und
          // matched user_id=UUID nicht → leere Listen.
          const ownerForGoals = this.ownerMasterUserId;
          if (!ownerForGoals) {
            this.logger.warn({}, 'v805 Goals API: ownerMasterUserId undefined — skipping wire-up');
          }
          (apiAdapter as any).setGoalsCallbacks({
            list: async (filter?: { status?: string; category?: string }) => {
              if (!ownerForGoals) return [];
              return goalsRepoForApi.list(ownerForGoals, {
                status: filter?.status as any,
                category: filter?.category as any,
              });
            },
            get: async (id: string) => {
              if (!ownerForGoals) return null;
              const goal = await goalsRepoForApi.getById(ownerForGoals, id);
              if (!goal) return null;
              const checkpoints = await goalsRepoForApi.listCheckpoints(id, 30);
              return { goal, checkpoints };
            },
            add: async (data: Record<string, unknown>) => {
              if (!ownerForGoals) throw new Error('no owner');
              return goalsRepoForApi.create(ownerForGoals, {
                title: data.title as string,
                description: data.description as string | undefined,
                category: data.category as any,
                cadence: data.cadence as any,
                targetMetric: data.target_metric as string | undefined,
                checkFrequencyDays: (data.check_frequency_days as number) ?? 7,
                source: 'user',
              });
            },
            update: async (id: string, data: Record<string, unknown>) => {
              if (!ownerForGoals) return null;
              return goalsRepoForApi.update(ownerForGoals, id, data as any);
            },
            check: async (id: string, status: string, notes?: string) => {
              await goalsRepoForApi.recordCheckpoint(id, status as any, undefined, notes);
            },
          });
          this.logger.info('Goals API registered');
        } catch (err) {
          this.logger.warn({ err }, 'Goals API wiring failed (non-fatal)');
        }
      }

      if (apiAdapter && this.reminderRepo && 'setRemindersCallback' in apiAdapter) {
        (apiAdapter as any).setRemindersCallback(async () => {
          try {
            return await this.reminderRepo!.getAllPending();
          } catch (err) {
            this.logger.warn({ err }, 'Reminders API list failed');
            return [];
          }
        });
        this.logger.info('Reminders Side-Panel API registered');
      }

      // v661 — Todos + Notes API
      if (apiAdapter && 'setTodosCallbacks' in apiAdapter) {
        const resolveOwnerTodo = async (): Promise<string> => {
          return this.tryOwner() ?? '';
        };
        (apiAdapter as any).setTodosCallbacks({
          list: async (opts?: { list?: string; includeCompleted?: boolean }) => {
            try {
              const uid = await resolveOwnerTodo();
              if (!this.todoRepo) return [];
              return await this.todoRepo.list(uid, opts?.list, opts?.includeCompleted ?? false);
            } catch (err) { this.logger.warn({ err }, 'Todos API list failed'); return []; }
          },
          add: async (input: { title: string; description?: string; priority?: string; dueDate?: string; list?: string; projectId?: string }) => {
            try {
              if (!this.todoRepo) return null;
              const uid = await resolveOwnerTodo();
              const todo = await this.todoRepo.add(uid, input.title, {
                list: input.list, description: input.description,
                priority: input.priority, dueDate: input.dueDate,
              });
              // v671 — wenn projectId angegeben: parallel Open-Item anlegen + bidirektional verlinken
              if (input.projectId && this.projectRepo) {
                try {
                  const proj = await this.projectRepo.getById(uid, input.projectId);
                  if (proj) {
                    const oi = await this.projectRepo.addOpenItem(proj.id, {
                      title: todo.title,
                      description: todo.description,
                      priority: (todo.priority === 'urgent' ? 'high' : todo.priority) as 'low' | 'normal' | 'high',
                      dueAt: todo.dueDate,
                    });
                    await this.projectRepo.setOpenItemTodoLink(oi.id, todo.id);
                    await this.todoRepo.setLink(todo.id, proj.id, oi.id);
                    return { ...todo, linkedProjectId: proj.id, linkedOpenItemId: oi.id };
                  }
                } catch (err) { this.logger.warn({ err, projectId: input.projectId }, 'Todo→OpenItem mirror create failed'); }
              }
              return todo;
            } catch (err) { this.logger.warn({ err }, 'Todos API add failed'); return null; }
          },
          update: async (id: string, input: Record<string, unknown>) => {
            try {
              if (!this.todoRepo) return null;
              const uid = await resolveOwnerTodo();
              const before = await this.todoRepo.getByIdForUser(id, uid);
              // v670 — completed weiterhin via complete/uncomplete (eigene Audit-Pfade)
              if (typeof input.completed === 'boolean') {
                if (input.completed) await this.todoRepo.complete(id);
                else await this.todoRepo.uncomplete(id);
                // v671 — Status-Sync zum gelinkten Open-Item (nur Übergang offen↔done)
                if (before?.linkedOpenItemId && this.projectRepo) {
                  try {
                    const oi = await this.projectRepo.getOpenItemByIdRaw(before.linkedOpenItemId);
                    if (oi) {
                      const targetStatus = input.completed ? 'done' : 'open';
                      // Nur syncen wenn nötig (Idempotenz)
                      if (oi.status !== targetStatus) {
                        await this.projectRepo.updateOpenItemStatus(oi.id, targetStatus);
                      }
                    }
                  } catch (err) { this.logger.debug({ err }, 'Todo→OpenItem status-sync failed'); }
                }
              }
              // v670 — alle anderen bearbeitbaren Felder
              const patch: Record<string, unknown> = {};
              if (typeof input.title === 'string') patch.title = input.title;
              if (input.description === null || typeof input.description === 'string') patch.description = input.description;
              if (typeof input.priority === 'string') patch.priority = input.priority;
              if (input.dueDate === null || typeof input.dueDate === 'string') patch.dueDate = input.dueDate;
              if (typeof input.list === 'string') patch.list = input.list;
              let updated: typeof before | null = before ?? null;
              if (Object.keys(patch).length > 0) {
                updated = await this.todoRepo.update(id, uid, patch);
                // v671 — Edit-Sync (Titel + Beschreibung) zum gelinkten Open-Item
                if (updated?.linkedOpenItemId && this.projectRepo && (patch.title !== undefined || patch.description !== undefined)) {
                  try {
                    const oi = await this.projectRepo.getOpenItemByIdRaw(updated.linkedOpenItemId);
                    if (oi) {
                      const oiPatch: { title?: string; description?: string | null } = {};
                      if (patch.title !== undefined && oi.title !== updated.title) oiPatch.title = updated.title;
                      if (patch.description !== undefined && oi.description !== (updated.description ?? undefined)) {
                        oiPatch.description = updated.description === undefined ? null : updated.description;
                      }
                      if (Object.keys(oiPatch).length > 0) {
                        await this.projectRepo.updateOpenItemFields(oi.id, oiPatch);
                      }
                    }
                  } catch (err) { this.logger.debug({ err }, 'Todo→OpenItem field-sync failed'); }
                }
              }
              return updated ?? (await this.todoRepo.getByIdForUser(id, uid));
            } catch (err) { this.logger.warn({ err }, 'Todos API update failed'); return null; }
          },
          complete: async (id: string) => {
            try {
              if (!this.todoRepo) return false;
              const uid = await resolveOwnerTodo();
              const before = await this.todoRepo.getByIdForUser(id, uid);
              if (!before) return false;
              const ok = await this.todoRepo.complete(id);
              // v671 — Status-Sync zum gelinkten Open-Item
              if (ok && before?.linkedOpenItemId && this.projectRepo) {
                try {
                  const oi = await this.projectRepo.getOpenItemByIdRaw(before.linkedOpenItemId);
                  if (oi && oi.status !== 'done') {
                    await this.projectRepo.updateOpenItemStatus(oi.id, 'done');
                  }
                } catch { /* sync-best-effort */ }
              }
              return ok;
            } catch { return false; }
          },
          delete: async (id: string) => {
            try {
              if (!this.todoRepo) return false;
              const uid = await resolveOwnerTodo();
              const before = await this.todoRepo.getByIdForUser(id, uid);
              if (!before) return false;
              const ok = await this.todoRepo.delete(id);
              // v671 — beim Delete NUR Verlinkung entfernen (Open-Item bleibt)
              if (ok && before?.linkedOpenItemId && this.projectRepo) {
                try { await this.projectRepo.setOpenItemTodoLink(before.linkedOpenItemId, null); }
                catch { /* best-effort */ }
              }
              return ok;
            } catch { return false; }
          },
          // v670 — Arbeitsnotizen / Fortschritte
          listNotes: async (todoId: string) => {
            try { return this.todoRepo ? await this.todoRepo.listNotes(todoId) : []; }
            catch (err) { this.logger.warn({ err }, 'Todo-Notes list failed'); return []; }
          },
          addNote: async (todoId: string, content: string) => {
            try {
              if (!this.todoRepo) return null;
              const uid = await resolveOwnerTodo();
              const todo = await this.todoRepo.getByIdForUser(todoId, uid);
              if (!todo) return null;
              return await this.todoRepo.addNote(todoId, uid, content);
            } catch (err) { this.logger.warn({ err }, 'Todo-Notes add failed'); return null; }
          },
          deleteNote: async (noteId: string) => {
            try {
              if (!this.todoRepo) return false;
              const uid = await resolveOwnerTodo();
              return await this.todoRepo.deleteNote(noteId, uid);
            } catch (err) { this.logger.warn({ err }, 'Todo-Notes delete failed'); return false; }
          },
          // v672 — Todo ↔ Note M:N Verknüpfung (User-Notes aus notes-Tabelle)
          listLinkedNotes: async (todoId: string) => {
            try {
              if (!this.todoRepo || !this.noteRepo) return [];
              const uid = await resolveOwnerTodo();
              const owningTodo = await this.todoRepo.getByIdForUser(todoId, uid);
              if (!owningTodo) return [];
              const ids = await this.todoRepo.listLinkedNoteIds(todoId);
              const notes: any[] = [];
              for (const nid of ids) {
                const n = await this.noteRepo.getByIdForUser(nid, uid);
                if (n) notes.push(n);
              }
              return notes;
            } catch (err) { this.logger.warn({ err }, 'Todo linked-notes list failed'); return []; }
          },
          linkNote: async (todoId: string, noteId: string) => {
            try {
              if (!this.todoRepo || !this.noteRepo) return false;
              const uid = await resolveOwnerTodo();
              // beide müssen dem User gehören (Anti-Tampering)
              const todo = await this.todoRepo.getByIdForUser(todoId, uid);
              const note = await this.noteRepo.getByIdForUser(noteId, uid);
              if (!todo || !note) return false;
              return await this.todoRepo.linkNote(todoId, noteId);
            } catch (err) { this.logger.warn({ err }, 'Todo-Note link failed'); return false; }
          },
          unlinkNote: async (todoId: string, noteId: string) => {
            try {
              if (!this.todoRepo) return false;
              const uid = await resolveOwnerTodo();
              const todo = await this.todoRepo.getByIdForUser(todoId, uid);
              if (!todo) return false;
              return await this.todoRepo.unlinkNote(todoId, noteId);
            } catch (err) { this.logger.warn({ err }, 'Todo-Note unlink failed'); return false; }
          },
          listLinkedTodos: async (noteId: string) => {
            try {
              if (!this.todoRepo || !this.noteRepo) return [];
              const uid = await resolveOwnerTodo();
              const owningNote = await this.noteRepo.getByIdForUser(noteId, uid);
              if (!owningNote) return [];
              const ids = await this.todoRepo.listLinkedTodoIds(noteId);
              const todos: any[] = [];
              for (const tid of ids) {
                const t = await this.todoRepo.getByIdForUser(tid, uid);
                if (t) todos.push(t);
              }
              return todos;
            } catch (err) { this.logger.warn({ err }, 'Note linked-todos list failed'); return []; }
          },
        });
        this.logger.info('Todos API registered');
      }
      if (apiAdapter && 'setNotesCallbacks' in apiAdapter) {
        const resolveOwnerNote = async (): Promise<string> => {
          return this.tryOwner() ?? '';
        };
        (apiAdapter as any).setNotesCallbacks({
          list: async (opts?: { query?: string; limit?: number }) => {
            try {
              if (!this.noteRepo) return [];
              const uid = await resolveOwnerNote();
              if (opts?.query) return await this.noteRepo.search(uid, opts.query);
              return await this.noteRepo.list(uid, opts?.limit ?? 100);
            } catch (err) { this.logger.warn({ err }, 'Notes API list failed'); return []; }
          },
          add: async (input: { title: string; content: string }) => {
            try {
              if (!this.noteRepo) return null;
              const uid = await resolveOwnerNote();
              return await this.noteRepo.save(uid, input.title, input.content);
            } catch (err) { this.logger.warn({ err }, 'Notes API add failed'); return null; }
          },
          update: async (id: string, input: { title?: string; content?: string }) => {
            try { return this.noteRepo ? await this.noteRepo.update(id, input.title, input.content) : null; } catch { return null; }
          },
          delete: async (id: string) => {
            try { return this.noteRepo ? await this.noteRepo.delete(id) : false; } catch { return false; }
          },
        });
        this.logger.info('Notes API registered');
      }

      // v673 — Attachments API (Documents/Files/URLs/Uploads für Todos + Notes)
      if (apiAdapter && 'setAttachmentsCallbacks' in apiAdapter) {
        const resolveOwnerAtt = async (): Promise<string> => {
          return this.tryOwner() ?? '';
        };
        (apiAdapter as any).setAttachmentsCallbacks({
          list: async (entityType: 'todo' | 'note', entityId: string) => {
            try {
              if (!this.attachmentRepo) return [];
              return await this.attachmentRepo.listForEntity(entityType, entityId);
            } catch (err) { this.logger.warn({ err }, 'Attachments list failed'); return []; }
          },
          add: async (input: { entityType: 'todo' | 'note'; entityId: string; sourceKind: string; sourceRef: string; label?: string; mimeType?: string; sizeBytes?: number }) => {
            try {
              if (!this.attachmentRepo) return null;
              const uid = await resolveOwnerAtt();
              // Anti-Tampering: Entity muss dem User gehören
              if (input.entityType === 'todo') {
                const t = await this.todoRepo?.getByIdForUser(input.entityId, uid);
                if (!t) return null;
              } else if (input.entityType === 'note') {
                const n = await this.noteRepo?.getByIdForUser(input.entityId, uid);
                if (!n) return null;
              }
              // URL-Quellen: nur http(s)
              if (input.sourceKind === 'url' && !/^https?:\/\//i.test(input.sourceRef)) {
                return null;
              }
              return await this.attachmentRepo.add({
                userId: uid,
                entityType: input.entityType,
                entityId: input.entityId,
                sourceKind: input.sourceKind as any,
                sourceRef: input.sourceRef,
                label: input.label, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
              });
            } catch (err) { this.logger.warn({ err }, 'Attachment add failed'); return null; }
          },
          delete: async (id: string) => {
            try {
              if (!this.attachmentRepo) return false;
              const uid = await resolveOwnerAtt();
              return await this.attachmentRepo.delete(id, uid);
            } catch (err) { this.logger.warn({ err }, 'Attachment delete failed'); return false; }
          },
          listDocuments: async () => {
            try {
              if (!this.documentRepoRef) return [];
              const uid = await resolveOwnerAtt();
              return await this.documentRepoRef.listByUser(uid);
            } catch (err) { this.logger.warn({ err }, 'Documents list failed'); return []; }
          },
          listFiles: async () => {
            try {
              if (!this.fileStoreRef) return [];
              const uid = await resolveOwnerAtt();
              return await this.fileStoreRef.list(uid);
            } catch (err) { this.logger.warn({ err }, 'Files list failed'); return []; }
          },
          uploadFile: async (input: { filename: string; mimeType: string; base64Data: string }) => {
            try {
              if (!this.fileStoreRef) return null;
              const uid = await resolveOwnerAtt();
              // Base64 → Buffer + Size-Limit (25 MB)
              const buf = Buffer.from(input.base64Data, 'base64');
              if (buf.length > 25 * 1024 * 1024) {
                this.logger.warn({ size: buf.length, filename: input.filename }, 'Upload rejected: size > 25MB');
                return null;
              }
              const saved = await this.fileStoreRef.save(uid, input.filename, buf);
              return { ...saved, mimeType: input.mimeType };
            } catch (err) { this.logger.warn({ err }, 'Upload failed'); return null; }
          },
          // v674 — Download mit User-Scope-Check (FileStore prüft das key-Prefix)
          readFile: async (key: string) => {
            try {
              if (!this.fileStoreRef) return null;
              const uid = await resolveOwnerAtt();
              const data = await this.fileStoreRef.read(key, uid);
              // Filename aus key extrahieren (key-Format: <userId>/<timestamp>_<filename>)
              const lastSlash = key.lastIndexOf('/');
              const rawName = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
              // timestamp-Prefix entfernen wenn vorhanden (Format: YYYY-MM-DDTHH-MM-SS-MMMZ_filename)
              const tsMatch = rawName.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z_(.+)$/);
              const fileName = tsMatch ? tsMatch[1] : rawName;
              // Best-effort MIME aus Extension
              const ext = fileName.toLowerCase().split('.').pop() ?? '';
              const mimeMap: Record<string, string> = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
                webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
                txt: 'text/plain', md: 'text/markdown', json: 'application/json',
                csv: 'text/csv', html: 'text/html', mp4: 'video/mp4', mp3: 'audio/mpeg',
                docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              };
              return { data, fileName, mimeType: mimeMap[ext] };
            } catch (err) {
              this.logger.debug({ err, key }, 'File download denied/failed');
              return null;
            }
          },
        });
        this.logger.info('Attachments API registered');
      }

      // Wire Projects API on HTTP adapter
      if (apiAdapter && this.projectRepo && 'setProjectsCallbacks' in apiAdapter) {
        const projRepo = this.projectRepo;
        const resolveOwnerProj = async (): Promise<string> => {
          const ownerId = this.config.security?.ownerUserId ?? '';
          try {
            const user = await this.userRepo!.findOrCreate('telegram' as any, ownerId);
            return user.masterUserId ?? user.id;
          } catch { return ownerId; }
        };
        (apiAdapter as any).setProjectsCallbacks({
          list: async (filter?: { status?: string }) => {
            try {
              const uid = await resolveOwnerProj();
              return await projRepo.list(uid, filter as any);
            } catch (err) { this.logger.warn({ err }, 'Projects API list failed'); return []; }
          },
          get: async (id: string) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return null;
              const [sessions, openItems, decisions, health] = await Promise.all([
                projRepo.listSessions(project.id, 50),
                projRepo.listOpenItems(uid, { projectId: project.id, limit: 200 }),
                projRepo.listDecisions(project.id, 50),
                projRepo.getCurrentHealthSummary(project.id),
              ]);
              return { project, sessions, openItems, decisions, health };
            } catch (err) { this.logger.warn({ err }, 'Projects API get failed'); return null; }
          },
          create: async (input: Record<string, unknown>) => {
            try {
              const uid = await resolveOwnerProj();
              return await projRepo.create(uid, input as any);
            } catch (err) { this.logger.warn({ err }, 'Projects API create failed'); return null; }
          },
          update: async (id: string, patch: Record<string, unknown>) => {
            try {
              const uid = await resolveOwnerProj();
              return await projRepo.update(uid, id, patch as any);
            } catch (err) { this.logger.warn({ err }, 'Projects API update failed'); return null; }
          },
          archive: async (id: string) => {
            try {
              const uid = await resolveOwnerProj();
              const updated = await projRepo.update(uid, id, { status: 'archived' });
              return !!updated;
            } catch { return false; }
          },
          addOpenItem: async (projectId: string, input: Record<string, unknown>) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, projectId);
              if (!project) return null;
              return await projRepo.addOpenItem(project.id, input as any);
            } catch (err) { this.logger.warn({ err }, 'Projects API addOpenItem failed'); return null; }
          },
          // v815 P1 — manuelle Decision-Erstellung. Vorher gab es im Backend
          // projRepo.addDecision aber kein API-Endpoint → Decisions entstanden nur
          // via Session-Summary, nie manuell.
          addDecision: async (projectId: string, input: { title: string; choice: string; rationale?: string }) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, projectId);
              if (!project) return null;
              return await projRepo.addDecision(project.id, {
                title: input.title.slice(0, 200),
                choice: input.choice.slice(0, 500),
                rationale: input.rationale?.slice(0, 1000),
              });
            } catch (err) { this.logger.warn({ err }, 'Projects API addDecision failed'); return null; }
          },
          // v704 — Erweitert: status + title + description
          updateOpenItem: async (itemId: string, patch: { status?: string; title?: string; description?: string | null }) => {
            try {
              let anyChange = false;
              // Field-Update (title/description) zuerst
              if (patch.title != null || patch.description !== undefined) {
                const fieldPatch: { title?: string; description?: string | null } = {};
                if (patch.title != null) fieldPatch.title = patch.title;
                if (patch.description !== undefined) fieldPatch.description = patch.description;
                const ok = await projRepo.updateOpenItemFields(itemId, fieldPatch);
                if (ok) anyChange = true;
              }
              // Status-Update + Todo-Sync (v671)
              if (patch.status) {
                const ok = await projRepo.updateOpenItemStatus(itemId, patch.status as any);
                if (ok) anyChange = true;
                if (ok && this.todoRepo) {
                  try {
                    const uid = await resolveOwnerProj();
                    const oi = await projRepo.getOpenItemByIdRaw(itemId);
                    if (oi?.linkedTodoId) {
                      const t = await this.todoRepo.getByIdForUser(oi.linkedTodoId, uid);
                      if (t) {
                        if (patch.status === 'done' && !t.completed) await this.todoRepo.complete(t.id);
                        else if (patch.status === 'open' && t.completed) await this.todoRepo.uncomplete(t.id);
                      }
                    }
                  } catch (err) { this.logger.debug({ err }, 'OpenItem→Todo status-sync failed'); }
                }
              }
              return anyChange;
            } catch { return false; }
          },
          listHealthLog: async (id: string, limit: number) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return [];
              return await projRepo.listHealthLog(project.id, limit);
            } catch { return []; }
          },
          // v641 — Bulk-Work-On-Items + Audit
          workOnOpenItems: async (projectId: string, itemIds: string[], maxItems: number) => {
            try {
              const uid = await resolveOwnerProj();
              const skill = this.skillRegistry?.get('project');
              if (!skill) return { ok: false, reason: 'project-skill not registered' };
              const result = await skill.execute(
                { action: 'work_on_open_items', project_id: projectId, item_ids: itemIds, max_items: maxItems },
                { userId: uid, masterUserId: uid } as any,
              );
              if (!result.success) return { ok: false, reason: result.error };
              return { ok: true, taskId: (result.data as any)?.taskId };
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
          },
          auditOpenItems: async (projectId: string) => {
            try {
              const uid = await resolveOwnerProj();
              const skill = this.skillRegistry?.get('project');
              if (!skill) return { display: 'project-skill nicht registriert' };
              const result = await skill.execute(
                { action: 'audit_open_items', project_id: projectId },
                { userId: uid, masterUserId: uid } as any,
              );
              return { data: result.data, display: result.display ?? '' };
            } catch (err) {
              return { display: `Audit fehlgeschlagen: ${(err as Error).message}` };
            }
          },
          // v642 — Bulk-Close
          bulkCloseItems: async (projectId: string, itemIds: string[]) => {
            void projectId;
            let closed = 0;
            const failed: string[] = [];
            for (const id of itemIds) {
              try {
                const ok = await projRepo.updateOpenItemStatus(id, 'done');
                if (ok) closed++; else failed.push(id);
              } catch { failed.push(id); }
            }
            return { closed, failed };
          },
          // v643 — Commits per Project + Session
          listProjectCommits: async (projectId: string, limit: number) => {
            if (!this.commitsRepoRef) return [];
            try { return await this.commitsRepoRef.listByProject(projectId, limit); } catch { return []; }
          },
          listSessionCommits: async (sessionId: string) => {
            if (!this.commitsRepoRef) return [];
            try { return await this.commitsRepoRef.listBySession(sessionId); } catch { return []; }
          },
          // v742 — Re-Match Open-Items gegen letzten Session-Lauf (manuell triggern)
          reMatchOpenItems: async (projectId: string) => {
            if (!this.projectRepo || !this.llmProvider || !this.database) {
              return { ok: false, reason: 'projectRepo, llmProvider oder database nicht initialisiert' };
            }
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, projectId);
              if (!project) return { ok: false, reason: 'Project nicht gefunden' };
              if (!project.cwd) return { ok: false, reason: 'Project hat kein cwd' };
              // Letzte successful project_agent_session für diesen cwd
              const row = await this.database.getAdapter().queryOne(
                `SELECT task_id, goal, milestones, total_files_changed
                 FROM project_agent_sessions
                 WHERE cwd = ? AND last_build_passed = 1 AND total_files_changed > 0
                 ORDER BY updated_at DESC LIMIT 1`,
                [project.cwd],
              ).catch(() => null) as { task_id: string; goal: string; milestones: string; total_files_changed: number } | null;
              if (!row) {
                return { ok: false, reason: 'Keine erfolgreiche project_agent_session mit Datei-Änderungen gefunden (Matcher braucht Diff-Kontext)' };
              }
              let milestones: string[] = [];
              try { const parsed = JSON.parse(row.milestones); if (Array.isArray(parsed)) milestones = parsed; } catch { /* */ }

              // v820 — Echte Changed-Files aus git ziehen damit der LLM-Matcher
              // Diff-Kontext bekommt. Vorher: changedFiles=[] → LLM hatte nur
              // goal+milestones+open_items → meist 0 strukturierte Ergebnisse →
              // "0 Items analysiert" obwohl 100+ offene Punkte da waren.
              let changedFiles: string[] = [];
              try {
                const commits = await this.database.getAdapter().query(
                  `SELECT sha FROM project_agent_commits WHERE session_id = ? ORDER BY committed_at ASC`,
                  [row.task_id],
                ).catch(() => []) as Array<{ sha: string }>;
                if (commits.length > 0) {
                  const { execFile } = await import('node:child_process');
                  const { promisify } = await import('node:util');
                  const exec = promisify(execFile);
                  const fileSet = new Set<string>();
                  const cwd = project.cwd;
                  for (const c of commits.slice(0, 20)) { // cap auf 20 commits
                    try {
                      const { stdout } = await exec(
                        'git', ['-C', cwd, 'show', '--name-only', '--pretty=format:', c.sha],
                        { timeout: 8000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
                      );
                      for (const line of String(stdout).split('\n')) {
                        const f = line.trim();
                        if (f) fileSet.add(f);
                      }
                    } catch { /* einzelner commit unreadable → skip */ }
                    if (fileSet.size > 200) break; // cap auf 200 files
                  }
                  changedFiles = Array.from(fileSet);
                }
              } catch (err) {
                this.logger.debug({ err, sessionId: row.task_id }, 'v820 reMatch: changedFiles-extract aus git fehlgeschlagen (non-fatal, weiter ohne Files)');
              }

              const { OpenItemMatcher } = await import('./projects/open-item-matcher.js');
              const embedDeps = this.embeddingServiceRef && this.embeddingRepoRef
                ? { service: this.embeddingServiceRef, repo: this.embeddingRepoRef }
                : undefined;
              const matcher = new OpenItemMatcher(this.projectRepo, this.llmProvider, this.logger.child({ component: 'open-item-matcher' }), embedDeps);
              const result = await matcher.matchAfterSession({
                projectId,
                sessionId: row.task_id,
                goal: row.goal,
                milestones,
                changedFiles,
                totalFilesChanged: row.total_files_changed,
              });
              return {
                ok: true,
                matched: result.matched,
                resolved: result.resolved,
                considered: result.considered,
                candidates: result.candidates,
                filesUsed: changedFiles.length,
              };
            } catch (err) {
              return { ok: false, reason: (err as Error).message };
            }
          },
          // v824 — Agent-Conventions Callbacks (Phase 1 vollständig, alle 7 Actions)
          conventionsStatus: async (projectId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'status', project_id: projectId, package_path: packagePath ?? '' }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsGenerate: async (projectId: string, opts: { packagePath?: string; language?: 'de' | 'en'; tier?: 'fast' | 'default' | 'strong' }) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({
              action: 'generate',
              project_id: projectId,
              package_path: opts.packagePath ?? '',
              language: opts.language,
              tier: opts.tier,
            }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsApply: async (projectId: string, opts: { packagePath?: string; content?: string; commitToGit?: boolean; outputs?: string[] }) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({
              action: 'apply',
              project_id: projectId,
              package_path: opts.packagePath ?? '',
              content: opts.content,
              commit_to_git: opts.commitToGit,
              outputs: opts.outputs,
            }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsRefresh: async (projectId: string, opts: { packagePath?: string; language?: 'de' | 'en' }) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({
              action: 'refresh',
              project_id: projectId,
              package_path: opts.packagePath ?? '',
              language: opts.language,
            }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsDriftCheck: async (projectId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'drift_check', project_id: projectId, package_path: packagePath ?? '' }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsHistory: async (projectId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'history', project_id: projectId, package_path: packagePath ?? '' }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsRollback: async (projectId: string, historyId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'rollback', project_id: projectId, package_path: packagePath ?? '', history_id: historyId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsListLessons: async (projectId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'list_lessons', project_id: projectId, package_path: packagePath ?? '' }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsConsolidateLessons: async (projectId: string, packagePath?: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'consolidate_lessons', project_id: projectId, package_path: packagePath ?? '' }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsListPackages: async (projectId: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'list_packages', project_id: projectId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsGenerateAllPackages: async (projectId: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'generate_all_packages', project_id: projectId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsEffectiveness: async (projectId: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'effectiveness_metrics', project_id: projectId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsSectionHealth: async (projectId: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'section_health', project_id: projectId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsGlobalPatterns: async () => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const uid = this.tryOwner() ?? '';
            if (!uid) return { ok: false, reason: 'no owner' };
            const ctx = { userId: uid, masterUserId: uid, chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'list_patterns', project_id: 'system', master_user_id: uid }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsGetConfigOverrides: async (projectId: string) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'get_config_overrides', project_id: projectId }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          conventionsSetConfigOverrides: async (projectId: string, overrides: Record<string, unknown>) => {
            if (!this.agentConventionsSkillRef) return { ok: false, reason: 'agent-conventions skill not initialized' };
            const ctx = { userId: '', masterUserId: '', chatId: '', platform: 'api', conversationId: '' } as unknown as import('@alfred/types').SkillContext;
            const r = await this.agentConventionsSkillRef.execute({ action: 'set_config_overrides', project_id: projectId, overrides }, ctx);
            return { ok: !!r.success, data: r.data, reason: r.error };
          },
          // v797 — Manueller Health-Check (statt 6h-Schedule warten)
          triggerHealthCheck: async (projectId: string) => {
            if (!this.projectHealthMonitor) {
              return { ok: false, reason: 'HealthMonitor nicht initialisiert' };
            }
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, projectId);
              if (!project) return { ok: false, reason: 'Project nicht gefunden' };
              const probes = await this.projectHealthMonitor.checkProject(project);
              return {
                ok: true,
                probes: probes.map(p => ({ probe: p.probe, status: p.status, details: p.details })),
              };
            } catch (err) {
              this.logger.warn({ err, projectId }, 'v797 triggerHealthCheck failed');
              return { ok: false, reason: (err as Error).message };
            }
          },
          // v658 — Work-Stats Aggregation
          workStats: async (id: string) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return null;
              return await projRepo.getWorkStats(project.id);
            } catch (err) { this.logger.warn({ err, id }, 'Projects API workStats failed'); return null; }
          },
          // v665b — Cluster-Shares + Project-Move
          listClusterShares: async () => {
            if (!this.shareManager) return [];
            return this.shareManager.listStatuses().map(s => ({
              id: s.config.id,
              name: s.config.name,
              mountPath: s.config.mountPath,
              type: s.config.type,
              readOnly: !!s.config.readOnly,
              available: s.available,
              writable: s.writable,
              reason: s.reason,
            }));
          },
          moveProjectPreflight: async (projectId: string, target: { storageType: string; shareId?: string; nodeId?: string }) => {
            if (!this.projectMoveService) return { ok: false, checks: [{ name: 'service', passed: false, detail: 'MoveService nicht initialisiert' }] };
            const uid = await resolveOwnerProj();
            const project = await projRepo.getById(uid, projectId);
            if (!project) return { ok: false, checks: [{ name: 'project_exists', passed: false }] };
            return await this.projectMoveService.preflight(project, target as any, {});
          },
          moveProject: async (projectId: string, target: { storageType: string; shareId?: string; nodeId?: string }, opts: { excludes?: string[]; keepSource?: boolean }) => {
            if (!this.projectMoveService) return { ok: false, error: 'MoveService nicht initialisiert' };
            const uid = await resolveOwnerProj();
            const project = await projRepo.getById(uid, projectId);
            if (!project) return { ok: false, error: 'Projekt nicht gefunden' };
            // Pre-Flight noch einmal validieren bevor wir ausführen
            const pre = await this.projectMoveService.preflight(project, target as any, opts);
            if (!pre.ok) {
              const failed = pre.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail ?? 'failed'}`).join('; ');
              return { ok: false, error: `Pre-Flight nicht bestanden — ${failed}` };
            }
            return await this.projectMoveService.execute(project, target as any, opts, uid);
          },

          // v663b — Automations CRUD + Templates + Run-Now
          // v675 — Inline Object.values(AUTOMATION_TEMPLATES) + Diagnostik-Log um
          // Bundler-Tree-Shaking-Edge-Cases sicher zu vermeiden + bei zukünftigen
          // Leere-Templates-Reports sofort zu sehen ob's am Backend oder Frontend liegt.
          listAutomationTemplates: async () => {
            try {
              const mod = await import('./automation/automation-templates.js');
              const templates = Object.values(mod.AUTOMATION_TEMPLATES);
              // v675 — info-level (temporär) bis das WebUI-Modal stabil 22 Templates zeigt.
              // Beim nächsten Empty-Report sehen wir sofort ob das Backend liefert
              // oder ob das Frontend den Response falsch verarbeitet.
              this.logger.info(
                { count: templates.length, sample: templates[0]?.kind ?? null },
                'listAutomationTemplates served',
              );
              return templates;
            } catch (err) {
              this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'listAutomationTemplates failed');
              return [];
            }
          },
          listAutomations: async (projectId: string) => {
            try {
              if (!this.projectAutomationsRepo) return [];
              return await this.projectAutomationsRepo.listByProject(projectId);
            } catch { return []; }
          },
          addAutomation: async (projectId: string, input: Record<string, unknown>) => {
            try {
              if (!this.projectAutomationsRepo) return null;
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, projectId);
              if (!project) return null;
              const created = await this.projectAutomationsRepo.create({
                projectId, userId: uid,
                name: String(input.name ?? 'Automation'),
                templateKind: String(input.templateKind ?? 'custom') as any,
                schedule: input.schedule ? String(input.schedule) : undefined,
                promptOverride: input.promptOverride ? String(input.promptOverride) : undefined,
                outputDestination: (input.outputDestination as any) ?? 'telegram',
                enabled: input.enabled !== false,
              });
              // nextRunAt aus schedule berechnen + speichern
              if (this.automationEngine && created.schedule) {
                const next = this.automationEngine.computeNextRun(created.schedule);
                if (next) await this.projectAutomationsRepo.update(created.id, { nextRunAt: next });
                return { ...created, nextRunAt: next };
              }
              return created;
            } catch (err) { this.logger.warn({ err }, 'Automations API add failed'); return null; }
          },
          updateAutomation: async (id: string, patch: Record<string, unknown>) => {
            try {
              if (!this.projectAutomationsRepo) return false;
              const mappedPatch: Record<string, unknown> = {};
              if (typeof patch.name === 'string') mappedPatch.name = patch.name;
              if (typeof patch.schedule === 'string' || patch.schedule === null) mappedPatch.schedule = patch.schedule;
              if (typeof patch.promptOverride === 'string' || patch.promptOverride === null) mappedPatch.promptOverride = patch.promptOverride;
              if (typeof patch.outputDestination === 'string') mappedPatch.outputDestination = patch.outputDestination;
              if (typeof patch.enabled === 'boolean') mappedPatch.enabled = patch.enabled;
              const ok = await this.projectAutomationsRepo.update(id, mappedPatch as any);
              // nextRunAt neu berechnen wenn schedule geändert
              if (ok && this.automationEngine && typeof patch.schedule === 'string') {
                const next = this.automationEngine.computeNextRun(patch.schedule);
                await this.projectAutomationsRepo.update(id, { nextRunAt: next });
              }
              return ok;
            } catch { return false; }
          },
          deleteAutomation: async (id: string) => {
            try { return this.projectAutomationsRepo ? await this.projectAutomationsRepo.delete(id) : false; } catch { return false; }
          },
          runAutomationNow: async (id: string) => {
            try {
              if (!this.projectAutomationsRepo || !this.automationEngine) return { ok: false, error: 'Engine nicht verfügbar' };
              const auto = await this.projectAutomationsRepo.getById(id);
              if (!auto) return { ok: false, error: 'Automation nicht gefunden' };
              // v808 — Defense-in-depth: Automation muss dem aktuellen Owner gehören.
              const ownerId = this.tryOwner();
              if (ownerId && auto.userId !== ownerId) return { ok: false, error: 'Automation nicht autorisiert' };
              const output = await this.automationEngine.runAutomation(auto);
              return { ok: true, output };
            } catch (err) { return { ok: false, error: (err as Error).message }; }
          },

          // v663a — Roadmap-Items grouped by milestone
          listRoadmap: async (id: string) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return {};
              const grouped = await projRepo.listRoadmap(project.id);
              const obj: Record<string, any[]> = {};
              for (const [ms, items] of grouped) obj[ms] = items;
              return obj;
            } catch (err) { this.logger.warn({ err, id }, 'Projects API listRoadmap failed'); return {}; }
          },
          // v663a — Roadmap-Felder eines Items setzen
          updateOpenItemRoadmap: async (itemId: string, patch: { milestone?: string | null; order?: number | null; estimatedHours?: number | null }) => {
            try { return await projRepo.updateOpenItemRoadmap(itemId, patch); } catch { return false; }
          },
          // v663a — Implement-Milestone: aggregiert open items als Goal + startet project_agent
          implementMilestone: async (id: string, milestone: string) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return { ok: false, error: 'Projekt nicht gefunden' };
              const items = await projRepo.listMilestoneItems(project.id, milestone);
              if (items.length === 0) return { ok: false, error: `Keine offenen Items im Milestone "${milestone}"` };
              const skill = this.skillRegistry?.get('project_agent');
              if (!skill) return { ok: false, error: 'project_agent-Skill nicht registriert' };
              const itemList = items.map((it, i) => `${i + 1}. ${it.title}${it.description ? `\n   ${it.description.slice(0, 200)}` : ''}${it.estimatedHours ? ` (~${it.estimatedHours}h)` : ''}`).join('\n');
              // v702 — Sanitize project.name: alte User-Messages als Projekt-Name (z.B.
              // "Erstelle ein neues Projekt für ... unter /root/alpbyte-ga...") verschmutzten
              // den Goal-Text und führten dazu dass der Agent falsche Pfade in seinen Plan
              // übernahm. Wir nehmen den ersten Satz / max 60 Zeichen + slug-Fallback.
              const shortProjectLabel = (() => {
                const raw = (project.name || project.slug || 'Project').trim();
                // Wenn name kurz und ohne Pfad-Artefakte: direkt verwenden
                if (raw.length <= 60 && !raw.includes('/')) return raw;
                // Sonst: erstes Satzende ODER 60-Zeichen-Cut, vor pfad-artigen Strings stoppen
                const firstSentence = raw.split(/[.\n!?]/)[0] ?? raw;
                const beforePath = firstSentence.split(/\s+(?:unter|in|im|für|bei)\s+\/(?:root|home|var|mnt|opt|tmp)\//i)[0] ?? firstSentence;
                const capped = beforePath.slice(0, 60).trim();
                return capped.replace(/[„""'`]/g, '').trim() || (project.slug ?? 'Project');
              })();
              const goal = `Implementiere folgende Roadmap-Items für Milestone "${milestone}" im Projekt "${shortProjectLabel}" (Working Directory: ${project.cwd ?? '?'}):\n\n${itemList}\n\nBitte arbeite die Items in der angegebenen Reihenfolge ab. Für jeden Item: Implementierung + Test + Commit. Alle Pfad-Referenzen in Item-Texten sind ggf. veraltet — verwende ausschließlich den Working Directory oben für File-Operationen.`;
              const ownerChatId = this.config.security?.ownerUserId ?? '';
              const ownerPlatform = (this.config.telegram?.enabled ? 'telegram' : this.config.matrix?.enabled ? 'matrix' : 'api');
              const ctx = { userId: uid, masterUserId: uid, chatId: ownerChatId, platform: ownerPlatform, conversationId: '' } as any;
              const r = await skill.execute({ action: 'start', goal, cwd: project.cwd, link_open_item_ids: items.map(i => i.id) }, ctx);
              const taskId = (r.data as any)?.taskId;
              // v705 — Items beim Start als "in_progress" markieren damit der Completion-Callback
              // sie als zur Session gehörig erkennen kann (auch wenn der LLM-Matcher sie nicht
              // erkennt). Auf Success werden sie aufgelöst, auf Failure zurückgesetzt.
              if (r.success && taskId) {
                try {
                  const marked = await projRepo.markItemsWorkingOnSession(items.map(i => i.id), taskId);
                  this.logger.info({ taskId, marked, total: items.length }, 'v705 implementMilestone: items als in_progress markiert');
                } catch (err) {
                  this.logger.debug({ err, taskId }, 'v705 mark in_progress failed (non-fatal)');
                }
              }
              return { ok: !!r.success, taskId, itemCount: items.length, error: r.error };
            } catch (err) { return { ok: false, error: (err as Error).message }; }
          },

          // v659 — Letzte Deploys aus deploy_*-Memories + Runtime-Auto-Detect aus cwd.
          // Memory-Format (siehe packages/skills/.../deploy.ts:425):
          //   key: `deploy_<projectName>_<host_normalized>`
          //   value: `Deployed X → HOST (user=U, runtime=R, pm=P, compose=…, port=N, verified=ok, am=YYYY-MM-DD)`
          lastDeploys: async (id: string) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return { deploys: [] };
              // v677 — Slug konsistent mit triggerDeploy ableiten, sonst niemals Treffer
              // (Deploy-Skill schreibt Memory mit Slug, nicht mit project.name).
              const sanitizeSlugLD = (s: string): string => s
                .normalize('NFKD').replace(/[̀-ͯ]/g, '')
                .replace(/[^a-zA-Z0-9.\-]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .toLowerCase()
                .slice(0, 60);
              const cwdBaseLD = project.cwd ? project.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() : undefined;
              const slugLooksSemanticLD = project.slug
                && /^[a-zA-Z0-9.\-]+$/.test(project.slug)
                && project.slug.length <= 30
                && !/^(starte|erstelle|bearbeite|im-|bitte-)/i.test(project.slug);
              const deployProjectKey = cwdBaseLD
                ? sanitizeSlugLD(cwdBaseLD)
                : (slugLooksSemanticLD ? project.slug : sanitizeSlugLD(project.name));

              // v659 — Runtime aus cwd auto-detecten
              let detectedRuntime: string | undefined;
              let detectionReason: string | undefined;
              if (project.cwd) {
                const { existsSync } = await import('node:fs');
                const path = await import('node:path');
                const cwd = project.cwd;
                // Reihenfolge: Docker > Node > Python > Static (Docker hat Vorrang weil oft Container-Wrap)
                if (existsSync(path.join(cwd, 'docker-compose.yml')) || existsSync(path.join(cwd, 'docker-compose.yaml')) || existsSync(path.join(cwd, 'compose.yaml')) || existsSync(path.join(cwd, 'compose.yml'))) {
                  detectedRuntime = 'docker';
                  detectionReason = 'docker-compose.yml gefunden';
                } else if (existsSync(path.join(cwd, 'Dockerfile'))) {
                  detectedRuntime = 'docker';
                  detectionReason = 'Dockerfile gefunden';
                } else if (existsSync(path.join(cwd, 'package.json'))) {
                  detectedRuntime = 'node';
                  detectionReason = 'package.json gefunden';
                } else if (existsSync(path.join(cwd, 'pyproject.toml')) || existsSync(path.join(cwd, 'requirements.txt')) || existsSync(path.join(cwd, 'setup.py'))) {
                  detectedRuntime = 'python';
                  detectionReason = existsSync(path.join(cwd, 'pyproject.toml')) ? 'pyproject.toml gefunden' : existsSync(path.join(cwd, 'requirements.txt')) ? 'requirements.txt gefunden' : 'setup.py gefunden';
                } else if (existsSync(path.join(cwd, 'index.html'))) {
                  detectedRuntime = 'static';
                  detectionReason = 'index.html gefunden (static site)';
                }
              }

              let deploys: Array<{ host: string; user: string; runtime?: string; processManager?: string; composeVariant?: string; port?: number; verified?: boolean; date?: string; updatedAt?: string }> = [];
              if (this.memoryRepo) {
                const keyPrefix = `deploy_${deployProjectKey}_`;
                const mems = await this.memoryRepo.search(uid, keyPrefix);
                const filtered = mems.filter(m => m.key.startsWith(keyPrefix) && (m.category === 'deployment' || m.category === 'deploy'));
                deploys = filtered.map(m => {
                  const v = m.value;
                  const hostMatch = v.match(/→\s*([\w.-]+)\s*\(/);
                  const userMatch = v.match(/user=([^,)]+)/);
                  const runtimeMatch = v.match(/runtime=([^,)]+)/);
                  const pmMatch = v.match(/pm=([^,)]+)/);
                  const composeMatch = v.match(/compose=([^,)]+)/);
                  const portMatch = v.match(/port=(\d+)/);
                  const verifiedMatch = /verified=ok/.test(v);
                  const dateMatch = v.match(/am=([\d-]+)/);
                  // v677 — failed-Memory hat 'FAILED' im Text + category='deploy' (Success: 'deployment')
                  const failed = m.category === 'deploy' || /Deploy FAILED/i.test(v);
                  const errorMatch = failed ? v.match(/\):\s*(.+)$/) : null;
                  return {
                    host: hostMatch?.[1] ?? '',
                    user: userMatch?.[1]?.trim() ?? 'root',
                    runtime: runtimeMatch?.[1]?.trim(),
                    processManager: pmMatch?.[1]?.trim(),
                    composeVariant: composeMatch?.[1]?.trim(),
                    port: portMatch ? Number(portMatch[1]) : undefined,
                    verified: verifiedMatch,
                    date: dateMatch?.[1],
                    updatedAt: m.updatedAt,
                    failed,
                    error: errorMatch?.[1]?.trim(),
                  };
                }).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
              }

              return { deploys, detectedRuntime, detectionReason };
            } catch (err) {
              this.logger.warn({ err, id }, 'Projects API lastDeploys failed');
              return { deploys: [] };
            }
          },

          // v659 — Deploy-Trigger via deploy-Skill mit Form-Params.
          // Validiert Felder, ruft skillSandbox.execute(deploySkill, params, ctx).
          triggerDeploy: async (id: string, input: Record<string, unknown>) => {
            try {
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return { success: false, error: 'Projekt nicht gefunden' };
              const skill = this.skillRegistry?.get('deploy');
              if (!skill) return { success: false, error: 'Deploy-Skill nicht registriert' };
              // Mandatory: host. Defaults: action=deploy, user=root, pm aus input.
              const host = String(input.host ?? '').trim();
              if (!host) return { success: false, error: 'host ist erforderlich' };
              // v677 — Der Deploy-Skill verlangt einen "project"-Slug (nur a-z, 0-9, ., -).
              // Priorität: input.project (User-Override) → basename(cwd) → project.slug (falls
              // sinnvoll kurz) → name-sanitized. basename(cwd) ist semantisch der ECHTE
              // Projekt-Ordnername am Target-Host — der LLM-generierte slug aus dem
              // ursprünglichen Goal-Text wäre zwar validate-konform, ist aber praktisch
              // nutzlos (z.B. "starte-einen-neuen-projekt-agent-lauf-...").
              const sanitizeSlug = (s: string): string => s
                .normalize('NFKD').replace(/[̀-ͯ]/g, '') // Umlaute → ascii
                .replace(/[^a-zA-Z0-9.\-]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .toLowerCase()
                .slice(0, 60);
              const cwdBase = project.cwd ? project.cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() : undefined;
              const slugLooksSemantic = project.slug
                && /^[a-zA-Z0-9.\-]+$/.test(project.slug)
                && project.slug.length <= 30
                && !/^(starte|erstelle|bearbeite|im-|bitte-)/i.test(project.slug);
              const projectSlug = (typeof input.project === 'string' && input.project.trim())
                ? sanitizeSlug(input.project as string)
                : (cwdBase
                    ? sanitizeSlug(cwdBase)
                    : (slugLooksSemantic ? project.slug : sanitizeSlug(project.name)));
              if (!projectSlug) return { success: false, error: 'Projekt-Slug konnte nicht abgeleitet werden' };
              const params: Record<string, unknown> = {
                action: 'deploy',
                project: projectSlug,
                host,
                user: input.user ?? 'root',
              };
              if (input.process_manager) params.process_manager = input.process_manager;
              if (input.runtime) params.runtime = input.runtime;
              if (input.app_port) params.app_port = Number(input.app_port);
              if (input.branch) params.branch = input.branch;
              if (input.repo_url) params.repo_url = input.repo_url;
              else if (project.repoUrl) params.repo_url = project.repoUrl;
              if (input.install_command) params.install_command = input.install_command;
              if (input.build_command) params.build_command = input.build_command;
              if (input.start_command) params.start_command = input.start_command;
              // v736 — ENV-Stage durchreichen (Deploy-Skill liest die als .env aufs Target)
              if (typeof input.env_stage === 'string' && input.env_stage.length > 0) params.env_stage = input.env_stage;
              if (input.skip_env === true) params.skip_env = true;
              if (!this.skillSandbox) return { success: false, error: 'SkillSandbox nicht verfügbar' };
              const ownerChatId = this.config.security?.ownerUserId ?? '';
              const ctx = { userId: uid, masterUserId: uid, chatId: ownerChatId, platform: 'api', conversationId: '' } as any;
              const result = await this.skillSandbox.execute(skill, params, ctx);

              // v689 — Backup-Memory via upsertSystemMemory() ohne manual-/correction-
              // Guards: deploy_*-Keys sind system-managed. Vorher überschrieb saveWithMetadata
              // einen früher vom User manuell angelegten Eintrag NICHT (Guard) → lastDeploys
              // las den alten freitext-Eintrag mit category='general' und filterte ihn raus.
              if (this.memoryRepo) {
                try {
                  const safeHost = host.replace(/[^a-zA-Z0-9]/g, '_');
                  const memKey = `deploy_${projectSlug}_${safeHost}`;
                  const now = new Date().toISOString().slice(0, 10);
                  const upsert = (this.memoryRepo as { upsertSystemMemory?: (uid: string, k: string, v: string, c: string, t?: string, conf?: number) => Promise<unknown> }).upsertSystemMemory;
                  if (result.success) {
                    const parts = [
                      `Deployed ${projectSlug} → ${host} (user=${input.user ?? 'root'}`,
                      `runtime=${input.runtime ?? '?'}`,
                      `pm=${input.process_manager ?? '?'}`,
                      ...(input.app_port ? [`port=${input.app_port}`] : []),
                      `verified=ok`,
                      `am=${now})`,
                    ];
                    if (upsert) await upsert.call(this.memoryRepo, uid, memKey, parts.join(', '), 'deployment', 'fact', 0.95);
                    else await this.memoryRepo.saveWithMetadata(uid, memKey, parts.join(', '), 'deployment', 'fact', 0.95, 'auto');
                  } else {
                    const errSnippet = (result.error ?? 'unknown').split('\n')[0].slice(0, 300);
                    const msg = `Deploy FAILED → ${host} (user=${input.user ?? 'root'}, runtime=${input.runtime ?? '?'}, pm=${input.process_manager ?? '?'}${input.app_port ? `, port=${input.app_port}` : ''}, am=${now}): ${errSnippet}`;
                    if (upsert) await upsert.call(this.memoryRepo, uid, memKey, msg, 'deploy', 'fact', 0.95);
                    else await this.memoryRepo.saveWithMetadata(uid, memKey, msg, 'deploy', 'fact', 0.95, 'auto');
                  }
                  this.logger.info({ memKey, success: result.success }, 'Deploy memory written');
                } catch (memErr) {
                  this.logger.warn({ err: memErr instanceof Error ? memErr.message : String(memErr) }, 'Deploy memory write failed');
                }
              }

              // v677 — Bei Deploy-Fehler optional Telegram-DM an den Owner senden.
              // Erfolgs-Notifications nicht (würde spammen) — nur Fehler, weil der User
              // im WebUI das Feedback bekommt, aber bei Off-WebUI-Triggern (Skill) keine
              // andere Rückmeldung hätte.
              if (!result.success && this.adapters && this.config.security?.ownerUserId) {
                try {
                  const tg = this.adapters.get('telegram');
                  if (tg && 'sendDirectMessage' in tg) {
                    const owner = this.config.security.ownerUserId;
                    const errSnippet = (result.error ?? 'unknown').split('\n')[0].slice(0, 300);
                    await (tg as { sendDirectMessage(userId: string, text: string): Promise<unknown> })
                      .sendDirectMessage(owner, `🚨 Deploy fehlgeschlagen\n\nProjekt: ${project.name.slice(0, 60)}\nHost: ${host}\nSlug: ${projectSlug}\n\nFehler: ${errSnippet}`);
                  }
                } catch (tgErr) { this.logger.debug({ tgErr }, 'Deploy-Failure Telegram-DM failed'); }
              }

              return {
                success: result.success,
                data: result.data,
                error: result.error,
                display: result.display,
              };
            } catch (err) {
              this.logger.warn({ err, id }, 'Projects API triggerDeploy failed');
              return { success: false, error: (err as Error).message };
            }
          },

          // v658 — Chat-History für Projekt-Conversation
          chatHistory: async (id: string, limit: number) => {
            try {
              if (!this.conversationRepo) return { conversationId: '', messages: [] };
              const uid = await resolveOwnerProj();
              const project = await projRepo.getById(uid, id);
              if (!project) return null;
              const conv = await this.conversationRepo.findOrCreateForProject(uid, project.id);
              const rawMessages = await this.conversationRepo.getMessages(conv.id, limit);
              return {
                conversationId: conv.id,
                messages: rawMessages.map((m: { id: string; role: string; content: string; createdAt: string }) => ({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  createdAt: m.createdAt,
                })),
              };
            } catch (err) {
              this.logger.warn({ err, id }, 'Projects API chatHistory failed');
              return null;
            }
          },
        });
        this.logger.info('Projects API registered');

        // v764 — Project-Wizard-Callbacks (LLM-Suggest + Plan-Gen + Validator + Create)
        if ('setProjectWizardCallbacks' in apiAdapter && this.projectRepo) {
          const projRepo = this.projectRepo;
          const llm = this.llmProvider;
          const resolveOwnerWiz = async (): Promise<string> => {
            const ownerId = this.config.security?.ownerUserId ?? '';
            try {
              const user = await this.userRepo!.findOrCreate('telegram' as any, ownerId);
              return user.masterUserId ?? user.id;
            } catch { return ownerId; }
          };

          async function callJson(prompt: string, systemPrompt: string): Promise<Record<string, unknown>> {
            if (!llm) throw new Error('LLM-Provider nicht verfügbar');
            const resp = await llm.complete({
              tier: 'strong',
              system: systemPrompt,
              messages: [
                { role: 'user', content: prompt },
              ],
              maxTokens: 4000,
            });
            const text = (resp.content ?? '').trim();
            // JSON extrahieren (LLMs umrahmen oft mit ```json…```)
            const jsonMatch = text.match(/```json\s*([\s\S]+?)\s*```/) ?? text.match(/```\s*([\s\S]+?)\s*```/);
            const raw = jsonMatch ? jsonMatch[1] : text;
            try { return JSON.parse(raw); } catch (err) {
              throw new Error(`LLM-Output war kein gültiges JSON: ${(err as Error).message.slice(0, 100)} — Output: ${raw.slice(0, 200)}`);
            }
          }

          (apiAdapter as any).setProjectWizardCallbacks({
            suggestStack: async (description: string) => {
              const sys = 'Du bist ein erfahrener Software-Architekt. Schlage einen sinnvollen, modernen Tech-Stack für ein Projekt vor. Antworte AUSSCHLIESSLICH als gültiges JSON ohne weiteren Text. Bevorzuge populäre, gut dokumentierte Optionen.';
              const usr = `Projekt-Beschreibung:\n${description}\n\nGib JSON zurück:\n{\n  "frontend": "z.B. Next.js, Vite+React, Astro, SvelteKit, oder 'None - backend only'",\n  "backend": "z.B. Node/Express, Hono, FastAPI, Bun, oder 'None - frontend only'",\n  "database": "z.B. SQLite, PostgreSQL, MongoDB, oder 'None'",\n  "extras": ["TypeScript", "Tailwind", "Auth", "Docker", ...],\n  "rationale": "kurze Begründung warum dieser Stack passt (max 300 Zeichen)"\n}`;
              const out = await callJson(usr, sys);
              return {
                frontend: String(out.frontend ?? 'Unbekannt'),
                backend: String(out.backend ?? 'None'),
                database: String(out.database ?? 'None'),
                extras: Array.isArray(out.extras) ? out.extras.map(String) : [],
                rationale: String(out.rationale ?? '').slice(0, 500),
              };
            },
            generatePlan: async (description: string, stack: { frontend: string; backend: string; database: string; extras: string[]; rationale: string }) => {
              const sys = 'Du bist ein erfahrener Tech-Lead. Erstelle einen realistischen Implementierungs-Plan als Roadmap. Antworte AUSSCHLIESSLICH als gültiges JSON ohne weiteren Text.';
              const usr = `Projekt-Beschreibung:\n${description}\n\nTech-Stack:\n- Frontend: ${stack.frontend}\n- Backend: ${stack.backend}\n- Database: ${stack.database}\n- Extras: ${stack.extras.join(', ') || '(keine)'}\n\nErstelle JSON mit 8-15 Open-Items gruppiert in 3-5 Milestones:\n{\n  "items": [\n    { "title": "max 80 Zeichen", "description": "konkrete Tasks", "priority": "low|normal|high", "roadmapMilestone": "Milestone-Name", "roadmapOrder": 1 }\n  ],\n  "decisions": [\n    { "choice": "Entscheidung kurz", "rationale": "Warum, max 200 Zeichen" }\n  ]\n}\nDecisions: 2-4 wichtige Tech-Stack- oder Architektur-Entscheidungen. roadmapOrder ist die Reihenfolge innerhalb des Milestones (1,2,3...).`;
              const out = await callJson(usr, sys);
              const itemsRaw = Array.isArray(out.items) ? out.items : [];
              const decisionsRaw = Array.isArray(out.decisions) ? out.decisions : [];
              return {
                items: itemsRaw.slice(0, 20).map((it: Record<string, unknown>, idx: number) => ({
                  title: String(it.title ?? `Item ${idx + 1}`).slice(0, 200),
                  description: it.description ? String(it.description).slice(0, 1000) : undefined,
                  priority: (it.priority === 'low' || it.priority === 'high') ? it.priority : 'normal',
                  roadmapMilestone: String(it.roadmapMilestone ?? 'Setup').slice(0, 100),
                  roadmapOrder: Number(it.roadmapOrder) || idx + 1,
                })),
                decisions: decisionsRaw.slice(0, 8).map((d: Record<string, unknown>) => ({
                  choice: String(d.choice ?? '').slice(0, 300),
                  rationale: String(d.rationale ?? '').slice(0, 500),
                })),
              };
            },
            validate: async (description: string, stack: { frontend: string; backend: string; database: string; extras: string[]; rationale: string }, items: Array<{ title: string }>) => {
              const sys = 'Du bist ein kritischer Senior-Architekt. Hinterfrage einen Implementierungs-Plan. Antworte AUSSCHLIESSLICH als gültiges JSON ohne weiteren Text. Sei knapp und konkret.';
              const itemsStr = items.map((it, i) => `${i + 1}. ${it.title}`).join('\n');
              const usr = `Projekt: ${description}\n\nStack: ${stack.frontend} / ${stack.backend} / ${stack.database}\n\nGeplante Items:\n${itemsStr}\n\nKritik als JSON:\n{\n  "ok": true wenn keine größeren Probleme,\n  "issues": ["maximal 5 konkrete Probleme, max 200 Zeichen pro Stück"],\n  "suggestions": ["maximal 5 Verbesserungs-Vorschläge, max 200 Zeichen pro Stück"]\n}\nFokus: Lücken, Übertechnisierung, falsche Prioritäten, unrealistischer Scope.`;
              const out = await callJson(usr, sys);
              return {
                ok: out.ok === true,
                issues: Array.isArray(out.issues) ? out.issues.slice(0, 5).map((s: unknown) => String(s).slice(0, 300)) : [],
                suggestions: Array.isArray(out.suggestions) ? out.suggestions.slice(0, 5).map((s: unknown) => String(s).slice(0, 300)) : [],
              };
            },
            create: async (input: {
              name: string;
              slug?: string;
              description: string;
              stack: { frontend: string; backend: string; database: string; extras: string[]; rationale: string };
              items: Array<{ title: string; description?: string; priority: 'low' | 'normal' | 'high'; roadmapMilestone: string; roadmapOrder: number }>;
              decisions: Array<{ choice: string; rationale: string }>;
              tags?: string[];
              repoMode?: 'gitlab' | 'github' | 'local';
              scaffoldMode?: 'template' | 'agent' | 'none';
              repoVisibility?: 'private' | 'public';
            }) => {
              try {
                const uid = await resolveOwnerWiz();
                if (!uid) return { ok: false, reason: 'Kein Owner-User' };
                const slug = (input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 80);

                // v766 — Project-CWD generieren (default ~/.alfred/projects/<slug>)
                const fs = await import('node:fs');
                const path = await import('node:path');
                const projectsBase = process.env.ALFRED_PROJECTS_BASE ?? path.join(os.homedir(), '.alfred', 'projects');
                const projectCwd = path.join(projectsBase, slug);

                // v766 — Repo-Create im Forge (wenn gewählt UND Forge konfiguriert)
                let repoUrl: string | undefined;
                let cloneUrl: string | undefined;
                if (input.repoMode === 'gitlab' || input.repoMode === 'github') {
                  const forge = this.config.codeAgents?.forge;
                  if (!forge) {
                    return { ok: false, reason: 'codeAgents.forge nicht konfiguriert — Repo-Erstellung nicht möglich' };
                  }
                  if (forge.provider !== input.repoMode) {
                    return { ok: false, reason: `Konfigurierter Forge-Provider ist '${forge.provider}', User wählte '${input.repoMode}' — Mismatch.` };
                  }
                  try {
                    // v792 — direkter Aufruf (static import oben)
                    const fc = createForgeClient(forge);
                    const r = await fc.createProject({
                      name: slug,
                      description: input.description.slice(0, 300),
                      visibility: input.repoVisibility ?? 'private',
                    });
                    repoUrl = r.url;
                    cloneUrl = r.cloneUrl;
                  } catch (err) {
                    this.logger.warn({ err }, 'v766 Forge createProject failed');
                    return { ok: false, reason: `Forge-Repo-Create fehlgeschlagen: ${(err as Error).message.slice(0, 200)}` };
                  }
                }

                // v766 — Project-CWD anlegen + git init + Template-Scaffold (wenn gewählt)
                if (input.scaffoldMode === 'template' || input.scaffoldMode === 'agent' || input.repoMode !== 'local') {
                  try {
                    fs.mkdirSync(projectCwd, { recursive: true, mode: 0o755 });
                  } catch (err) {
                    this.logger.warn({ err, projectCwd }, 'v766 mkdir projectCwd failed');
                    return { ok: false, reason: `Konnte CWD nicht anlegen (${projectCwd}): ${(err as Error).message.slice(0, 120)}` };
                  }
                  // git init falls noch nicht
                  try {
                    const { execFile } = await import('node:child_process');
                    const { promisify } = await import('node:util');
                    const execAsync = promisify(execFile);
                    if (!fs.existsSync(path.join(projectCwd, '.git'))) {
                      await execAsync('git', ['init', '-b', 'main'], { cwd: projectCwd, timeout: 10_000 });
                    }
                    // Template-Files
                    if (input.scaffoldMode === 'template' || input.scaffoldMode === 'agent') {
                      const readmePath = path.join(projectCwd, 'README.md');
                      if (!fs.existsSync(readmePath)) {
                        const stack = input.stack;
                        const readme = `# ${input.name}\n\n${input.description}\n\n## Tech-Stack\n\n- **Frontend:** ${stack.frontend}\n- **Backend:** ${stack.backend}\n- **Database:** ${stack.database}\n- **Extras:** ${stack.extras.join(', ') || '(keine)'}\n\n${stack.rationale}\n\n## Roadmap\n\n${input.items.slice(0, 20).map(it => `- [ ] **${it.roadmapMilestone}** — ${it.title}`).join('\n')}\n\n---\n_Generated by Alfred Wizard_\n`;
                        fs.writeFileSync(readmePath, readme, 'utf8');
                      }
                      const gitignorePath = path.join(projectCwd, '.gitignore');
                      if (!fs.existsSync(gitignorePath)) {
                        const isNode = /node|next|vite|react|sveltekit|nuxt|astro|remix|hono|fastify|express|bun/i.test(input.stack.frontend + ' ' + input.stack.backend);
                        const isPython = /fastapi|django|flask|python/i.test(input.stack.backend);
                        const lines = ['# Alfred-generated .gitignore', '', '.alfred-data/', '.alfred-uploads/', '.env', '.env.local', '*.log', '.DS_Store', ''];
                        if (isNode) lines.push('# Node', 'node_modules/', 'dist/', 'build/', '.next/', '.cache/', '.turbo/', '*.tsbuildinfo', '');
                        if (isPython) lines.push('# Python', '__pycache__/', '*.pyc', '.venv/', 'venv/', '*.egg-info/', '');
                        fs.writeFileSync(gitignorePath, lines.join('\n'), 'utf8');
                      }
                      // Initial commit
                      try {
                        await execAsync('git', ['add', '-A'], { cwd: projectCwd, timeout: 10_000 });
                        // Sicherstellen, dass git user gesetzt ist
                        try { await execAsync('git', ['config', 'user.email'], { cwd: projectCwd, timeout: 5_000 }); }
                        catch { await execAsync('git', ['config', 'user.email', 'alfred@local'], { cwd: projectCwd, timeout: 5_000 }); }
                        try { await execAsync('git', ['config', 'user.name'], { cwd: projectCwd, timeout: 5_000 }); }
                        catch { await execAsync('git', ['config', 'user.name', 'Alfred'], { cwd: projectCwd, timeout: 5_000 }); }
                        await execAsync('git', ['commit', '-m', `[alfred-wizard] initial scaffold for ${input.name}`], { cwd: projectCwd, timeout: 15_000 });
                      } catch (err) {
                        this.logger.warn({ err }, 'v766 initial commit failed (continuing)');
                      }
                    }
                    // Remote origin + erster Push (wenn Repo erstellt)
                    if (cloneUrl) {
                      try {
                        await execAsync('git', ['remote', 'add', 'origin', cloneUrl], { cwd: projectCwd, timeout: 10_000 }).catch(() => undefined);
                        await execAsync('git', ['push', '-u', 'origin', 'main'], { cwd: projectCwd, timeout: 60_000 });
                      } catch (err) {
                        this.logger.warn({ err }, 'v766 initial push failed (non-fatal — repo existiert, manuell pushen)');
                      }
                    }
                  } catch (err) {
                    this.logger.warn({ err }, 'v766 scaffold failed');
                  }
                }

                // v767 — AI-Scaffold: fire-and-forget code_agent in projectCwd
                // läuft im Hintergrund, schreibt Files, committed + pusht selbst.
                let aiScaffoldKicked = false;
                if (input.scaffoldMode === 'agent') {
                  const cAgent = this.codeAgentSkillRef;
                  const codeAgents = this.config.codeAgents?.agents ?? [];
                  if (!cAgent || codeAgents.length === 0) {
                    this.logger.warn({ scaffoldMode: 'agent' }, 'v767 AI-Scaffold gewählt aber code-agent nicht konfiguriert — skip');
                  } else {
                    const defaultAgent = codeAgents[0].name;
                    const scaffoldGoal = `Scaffold the initial structure for a new project.

PROJECT
- Name: ${input.name}
- Description: ${input.description}

TECH-STACK
- Frontend: ${input.stack.frontend}
- Backend: ${input.stack.backend}
- Database: ${input.stack.database}
- Extras: ${input.stack.extras.join(', ') || '(none)'}

TASKS
1. Create the initial project structure: package.json (or equivalent), basic folder layout, entry-point files, config files.
2. Install dependencies (run npm/pnpm/yarn install as needed).
3. Set up minimum config so the dev-server starts without errors.
4. DO NOT implement business logic — only scaffolding. The roadmap will be tackled in later iterations.
5. Respect existing README.md and .gitignore — do not overwrite, only add to them if necessary.

A clean, idiomatic scaffold matching the stack. After this, "npm run dev" (or equivalent) should work.`;

                    (async () => {
                      try {
                        const ctxScaffold = { userId: uid, masterUserId: uid, chatId: '', platform: 'api', conversationId: '' } as any;
                        await cAgent.execute({
                          action: 'run',
                          agent: defaultAgent,
                          prompt: scaffoldGoal,
                          cwd: projectCwd,
                          timeout: 900_000, // 15min
                        }, ctxScaffold);
                        // Auto-Commit + Auto-Push der Scaffold-Files
                        try {
                          const { execFile: execFileScaf } = await import('node:child_process');
                          const { promisify: promisifyScaf } = await import('node:util');
                          const execAsync2 = promisifyScaf(execFileScaf);
                          const { stdout: porcelain } = await execAsync2('git', ['status', '--porcelain'], { cwd: projectCwd, maxBuffer: 1024 * 1024, timeout: 15_000 });
                          if (porcelain.trim()) {
                            await execAsync2('git', ['add', '-A'], { cwd: projectCwd, timeout: 30_000 });
                            await execAsync2('git', ['commit', '-m', '[alfred-wizard] AI-scaffold by code-agent'], { cwd: projectCwd, timeout: 30_000 });
                            if (cloneUrl) {
                              try { await execAsync2('git', ['push', 'origin', 'main'], { cwd: projectCwd, timeout: 120_000 }); }
                              catch (err) { this.logger.warn({ err }, 'v767 AI-scaffold push failed (commit lokal vorhanden)'); }
                            }
                          }
                        } catch (err) {
                          this.logger.warn({ err }, 'v767 AI-scaffold commit/push failed');
                        }
                        this.logger.info({ projectName: input.name, cwd: projectCwd }, 'v767 AI-Scaffold completed');
                      } catch (err) {
                        this.logger.warn({ err }, 'v767 AI-Scaffold code-agent run failed');
                      }
                    })().catch(err => this.logger.warn({ err }, 'v767 AI-Scaffold fire-and-forget caught'));
                    aiScaffoldKicked = true;
                  }
                }

                const project = await projRepo.create(uid, {
                  name: input.name,
                  slug,
                  description: input.description.slice(0, 2000),
                  cwd: (input.scaffoldMode !== 'none' || input.repoMode !== 'local') ? projectCwd : undefined,
                  repoUrl,
                  defaultBranch: 'main',
                  tags: input.tags ?? [],
                } as any);
                // Open-Items
                for (const it of input.items) {
                  try {
                    await projRepo.addOpenItem(project.id, {
                      title: it.title,
                      description: it.description,
                      priority: it.priority,
                      roadmapMilestone: it.roadmapMilestone,
                      roadmapOrder: it.roadmapOrder,
                    } as any);
                  } catch (err) {
                    this.logger.warn({ err, title: it.title }, 'v764 wizard addOpenItem failed (continuing)');
                  }
                }
                // Decisions
                for (const d of input.decisions) {
                  try {
                    await projRepo.addDecision(project.id, {
                      title: d.choice.slice(0, 100),
                      choice: d.choice,
                      rationale: d.rationale,
                    });
                  } catch (err) {
                    this.logger.warn({ err, choice: d.choice }, 'v764 wizard addDecision failed (continuing)');
                  }
                }
                // Stack-Info als Convention speichern (für späteres Scaffold)
                try {
                  await projRepo.update(uid, project.id, {
                    conventions: {
                      techStack: {
                        frontend: input.stack.frontend,
                        backend: input.stack.backend,
                        database: input.stack.database,
                        extras: input.stack.extras,
                      },
                      stackRationale: input.stack.rationale,
                    } as any,
                  } as any);
                } catch (err) {
                  this.logger.warn({ err }, 'v764 wizard conventions update failed (continuing)');
                }
                return { ok: true, projectId: project.id };
              } catch (err) {
                return { ok: false, reason: (err as Error).message };
              }
            },
          });
          this.logger.info('v764 Project-Wizard API registered');
        }
      }
    }

    // Wire CMDB/ITSM/Docs API on HTTP adapter (only when CMDB skills are registered)
    if (this.config.cmdb?.enabled !== false && (this.config.proxmox || this.config.unifi || this.config.docker || this.config.cloudflare || this.config.nginxProxyManager || this.config.pfsense || this.config.homeassistant)) {
      const apiAdapter = this.adapters.get('api');
      const dbAdapter = this.database.getAdapter();
      if (apiAdapter && 'setCmdbCallbacks' in apiAdapter) {
        const cmdbRepo = new CmdbRepository(dbAdapter);
        const itsmRepo = new ItsmRepository(dbAdapter);
        itsmRepo.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const { ProblemRepository: ProblemRepo } = await import('@alfred/storage');
        const problemRepo = new ProblemRepo(dbAdapter);

        const resolveUser = async (userId: string) => {
          if (!userId && this.config.security?.ownerUserId && this.userRepo) {
            try {
              const user = await this.userRepo.findOrCreate('telegram' as any, this.config.security.ownerUserId);
              return user.masterUserId ?? user.id ?? this.config.security.ownerUserId;
            } catch { return this.config.security.ownerUserId; }
          }
          return userId || this.tryOwner() || '';
        };

        (apiAdapter as any).setCmdbCallbacks({
          listAssets: async (uid: string, filters?: Record<string, unknown>) => cmdbRepo.listAssets(await resolveUser(uid), filters as any),
          getAsset: async (uid: string, id: string) => {
            const ruid = await resolveUser(uid);
            const asset = await cmdbRepo.getAssetById(ruid, id);
            const relations = asset ? await cmdbRepo.getRelationsForAsset(ruid, id) : [];
            const changes = asset ? await cmdbRepo.getChangesForAsset(ruid, id, 20) : [];
            return { asset, relations, changes };
          },
          createAsset: async (uid: string, data: Record<string, unknown>) => cmdbRepo.upsertAsset(await resolveUser(uid), data as any),
          updateAsset: async (uid: string, id: string, data: Record<string, unknown>) => cmdbRepo.updateAsset(await resolveUser(uid), id, data as any),
          deleteAsset: async (uid: string, id: string) => cmdbRepo.decommissionAsset(await resolveUser(uid), id),
          listRelations: async (uid: string) => cmdbRepo.getAllRelations(await resolveUser(uid)),
          createRelation: async (uid: string, data: Record<string, unknown>) => cmdbRepo.upsertRelation(await resolveUser(uid), data.source_asset_id as string, data.target_asset_id as string, data.relation_type as any),
          deleteRelation: async (uid: string, id: string) => cmdbRepo.removeRelation(await resolveUser(uid), id),
          discover: async (uid: string) => {
            // Trigger discovery via skill execution
            const cmdbSkill = this.skillRegistry?.get('cmdb');
            if (cmdbSkill) {
              return cmdbSkill.execute({ action: 'discover' }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            }
            return { success: false, error: 'CMDB skill not registered' };
          },
          getStats: async (uid: string) => cmdbRepo.getStats(await resolveUser(uid)),
          getChanges: async (uid: string, assetId: string) => cmdbRepo.getChangesForAsset(await resolveUser(uid), assetId),
          listDocuments: async (uid: string, filters?: Record<string, unknown>) => cmdbRepo.listDocuments(await resolveUser(uid), filters as any),
          getDocument: async (uid: string, id: string) => cmdbRepo.getDocumentById(await resolveUser(uid), id),
          getDocumentTree: async (uid: string) => cmdbRepo.getDocumentTree(await resolveUser(uid)),
          saveDocument: async (uid: string, data: Record<string, unknown>) => cmdbRepo.saveDocument(await resolveUser(uid), data as any),
          updateDocument: async (uid: string, id: string, data: Record<string, unknown>) => cmdbRepo.updateDocument(await resolveUser(uid), id, data as any),
          deleteDocument: async (uid: string, id: string) => cmdbRepo.deleteDocument(await resolveUser(uid), id),
          getDocumentVersions: async (uid: string, entityType: string, entityId: string, docType: string) =>
            cmdbRepo.getDocumentVersions(await resolveUser(uid), entityType, entityId, docType),
          searchDocuments: async (uid: string, query: string, filters?: Record<string, unknown>) =>
            cmdbRepo.searchDocuments(await resolveUser(uid), query, filters as any),
        });

        (apiAdapter as any).setItsmCallbacks({
          listIncidents: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listIncidents(await resolveUser(uid), filters as any),
          getIncident: async (uid: string, id: string) => itsmRepo.getIncidentById(await resolveUser(uid), id),
          createIncident: async (uid: string, data: Record<string, unknown>) => itsmRepo.createIncident(await resolveUser(uid), data as any),
          updateIncident: async (uid: string, id: string, data: Record<string, unknown>) => {
            // snake_case → camelCase for API/WebUI callers
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) {
              mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            }
            return itsmRepo.updateIncident(await resolveUser(uid), id, mapped as any);
          },
          listChanges: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listChangeRequests(await resolveUser(uid), filters as any),
          createChange: async (uid: string, data: Record<string, unknown>) => itsmRepo.createChangeRequest(await resolveUser(uid), data as any),
          updateChange: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return itsmRepo.updateChangeRequest(await resolveUser(uid), id, mapped as any);
          },
          listServices: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listServices(await resolveUser(uid), filters as any),
          createService: async (uid: string, data: Record<string, unknown>) => {
            const userId = await resolveUser(uid);
            const svc = await itsmRepo.createService(userId, data as any);
            // Persist JSON fields that createService doesn't handle (components, failureModes, sla)
            const jsonUpdates: Record<string, unknown> = {};
            if (data.components) jsonUpdates.components = data.components;
            if (data.failureModes) jsonUpdates.failureModes = data.failureModes;
            if (data.sla) jsonUpdates.sla = data.sla;
            if (Object.keys(jsonUpdates).length > 0) {
              return itsmRepo.updateService(userId, svc.id, jsonUpdates as any) ?? svc;
            }
            return svc;
          },
          updateService: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return itsmRepo.updateService(await resolveUser(uid), id, mapped as any);
          },
          healthCheck: async (uid: string) => {
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) return itsmSkill.execute({ action: 'health_check' }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'ITSM skill not registered' };
          },
          getDashboard: async (uid: string) => itsmRepo.getDashboard(await resolveUser(uid)),
          // Service Management
          getService: async (uid: string, id: string) => itsmRepo.getServiceById(await resolveUser(uid), id),
          deleteService: async (uid: string, id: string) => itsmRepo.deleteService(await resolveUser(uid), id),
          getServicesForAsset: async (uid: string, assetId: string) => itsmRepo.getServicesForAsset(await resolveUser(uid), assetId),
          generateDocs: async (uid: string, serviceId: string) => {
            const skill = this.skillRegistry?.get('infra_docs');
            if (skill) return skill.execute({ action: 'generate_service_doc', service_id: serviceId }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs not available' };
          },
          // Problem Management
          listProblems: async (uid: string, filters?: Record<string, unknown>) => problemRepo.listProblems(await resolveUser(uid), filters as any),
          getProblem: async (uid: string, id: string) => problemRepo.getProblemById(await resolveUser(uid), id),
          createProblem: async (uid: string, data: Record<string, unknown>) => problemRepo.createProblem(await resolveUser(uid), data as any),
          updateProblem: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return problemRepo.updateProblem(await resolveUser(uid), id, mapped as any);
          },
          linkIncidentToProblem: async (uid: string, problemId: string, incidentId: string) => problemRepo.linkIncident(await resolveUser(uid), problemId, incidentId),
          unlinkIncidentFromProblem: async (uid: string, problemId: string, incidentId: string) => problemRepo.unlinkIncident(await resolveUser(uid), problemId, incidentId),
          createFixChange: async (uid: string, problemId: string, data: Record<string, unknown>) => {
            const cr = await itsmRepo.createChangeRequest(await resolveUser(uid), { ...data, linkedProblemId: problemId } as any);
            await problemRepo.linkChangeRequest(await resolveUser(uid), problemId, cr.id);
            return { problem: await problemRepo.getProblemById(await resolveUser(uid), problemId), changeRequest: cr };
          },
          detectPatterns: async (uid: string, data: Record<string, unknown>) => problemRepo.detectPatterns(await resolveUser(uid), data as any),
          getProblemDashboard: async (uid: string) => problemRepo.getDashboard(await resolveUser(uid)),
          // v632 — Bulk-Merge + Promote + Backfill
          bulkLinkToProblem: async (uid: string, problemId: string, incidentIds: string[]) => {
            const userId = await resolveUser(uid);
            let linked = 0;
            const failed: string[] = [];
            for (const incId of incidentIds) {
              try {
                const r = await problemRepo.linkIncident(userId, problemId, incId);
                if (r) linked++; else failed.push(incId);
              } catch { failed.push(incId); }
            }
            return { linked, failed };
          },
          promoteIncidentsToProblem: async (uid: string, data: { title: string; priority?: string; incidentIds: string[] }) => {
            const userId = await resolveUser(uid);
            const problem = await problemRepo.createProblem(userId, {
              title: data.title,
              description: `WebUI-Bulk-Promote aus ${data.incidentIds.length} Incidents.`,
              priority: (data.priority as any) ?? 'medium',
              linkedIncidentIds: data.incidentIds,
              detectedBy: 'manual',
              detectionMethod: 'webui-bulk-promote',
            });
            for (const incId of data.incidentIds) {
              try { await problemRepo.linkIncident(userId, problem.id, incId); } catch { /* best effort */ }
            }
            return problem;
          },
          backfillAssets: async (uid: string) => {
            const userId = await resolveUser(uid);
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (!itsmSkill) return { updated: 0, skipped: 0, unmatched: 0, total: 0 };
            const result = await itsmSkill.execute({ action: 'backfill_assets' }, { userId, masterUserId: userId } as any);
            return result.data ?? { updated: 0, skipped: 0, unmatched: 0, total: 0 };
          },
          // v645 — Generic Bulk-Actions
          bulkIncidents: async (uid: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => {
            const userId = await resolveUser(uid);
            let ok = 0; const failed: string[] = [];
            for (const id of data.ids) {
              try {
                const params: Record<string, unknown> = { ...(data.params ?? {}) };
                let updates: Record<string, unknown>;
                switch (data.action) {
                  case 'acknowledge': updates = { status: 'acknowledged' }; break;
                  case 'close': updates = { status: 'closed', resolution: (params.resolution as string) ?? 'Bulk-Close', closedAt: new Date().toISOString() }; break;
                  case 'change_severity': updates = { severity: params.severity }; break;
                  case 'update': updates = params; break;
                  default: failed.push(id); continue;
                }
                const r = await itsmRepo.updateIncident(userId, id, updates as any);
                if (r) ok++; else failed.push(id);
              } catch { failed.push(id); }
            }
            return { ok, failed };
          },
          bulkChanges: async (uid: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => {
            const userId = await resolveUser(uid);
            let ok = 0; const failed: string[] = [];
            for (const id of data.ids) {
              try {
                let updates: Record<string, unknown>;
                switch (data.action) {
                  case 'approve': updates = { status: 'approved' }; break;
                  case 'reject': updates = { status: 'rejected' }; break;
                  case 'update': updates = (data.params ?? {}); break;
                  default: failed.push(id); continue;
                }
                const r = await itsmRepo.updateChangeRequest(userId, id, updates as any);
                if (r) ok++; else failed.push(id);
              } catch { failed.push(id); }
            }
            return { ok, failed };
          },
          bulkProblems: async (uid: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => {
            const userId = await resolveUser(uid);
            let ok = 0; const failed: string[] = [];
            for (const id of data.ids) {
              try {
                let updates: Record<string, unknown>;
                switch (data.action) {
                  case 'change_status': updates = { status: (data.params ?? {}).status }; break;
                  case 'mark_known_error': updates = { isKnownError: true, knownErrorDescription: ((data.params ?? {}) as any).description ?? 'Bulk-marked' }; break;
                  case 'update': updates = data.params ?? {}; break;
                  default: failed.push(id); continue;
                }
                const r = await problemRepo.updateProblem(userId, id, updates as any);
                if (r) ok++; else failed.push(id);
              } catch { failed.push(id); }
            }
            return { ok, failed };
          },
          bulkServices: async (uid: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => {
            const userId = await resolveUser(uid);
            void userId;
            let ok = 0; const failed: string[] = [];
            for (const id of data.ids) {
              try {
                if (data.action === 'health_check') {
                  const itsmSkill = this.skillRegistry?.get('itsm');
                  if (itsmSkill) {
                    const ctx = { userId, masterUserId: userId, chatId: '', platform: 'api', conversationId: '' } as any;
                    const r = await itsmSkill.execute({ action: 'health_check', service_id: id }, ctx);
                    if (r.success) ok++; else failed.push(id);
                  } else { failed.push(id); }
                } else { failed.push(id); }
              } catch { failed.push(id); }
            }
            return { ok, failed };
          },
          // SLA Management
          setSla: async (uid: string, targetType: string, targetId: string, sla: Record<string, unknown>) => {
            const userId = await resolveUser(uid);
            if (targetType === 'service') {
              return itsmRepo.updateService(userId, targetId, { sla } as any);
            } else {
              return cmdbRepo.updateAsset(userId, targetId, { sla } as any);
            }
          },
          getSlaReport: async (uid: string, targetType: string, targetId: string, period?: string) => {
            const userId = await resolveUser(uid);
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) {
              return itsmSkill.execute({ action: 'get_sla_report', sla_target_type: targetType, sla_target_id: targetId, sla_period: period }, { userId, masterUserId: userId } as any);
            }
            return { success: false, error: 'ITSM skill not registered' };
          },
          checkSlaCompliance: async (uid: string) => {
            const userId = await resolveUser(uid);
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) return itsmSkill.execute({ action: 'check_sla_compliance' }, { userId, masterUserId: userId } as any);
            return { success: false, error: 'ITSM skill not registered' };
          },
          getSlaBreaches: async (uid: string, period?: string) => {
            const userId = await resolveUser(uid);
            return itsmRepo.getSlaBreaches(userId, period ? new Date(period).toISOString() : undefined);
          },
        });

        (apiAdapter as any).setDocsCallbacks({
          generate: async (uid: string, type: string, params?: Record<string, unknown>) => {
            const docsSkill = this.skillRegistry?.get('infra_docs');
            if (docsSkill) return docsSkill.execute({ action: type, ...params }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs skill not registered' };
          },
          exportData: async (uid: string, format?: string) => {
            const docsSkill = this.skillRegistry?.get('infra_docs');
            if (docsSkill) return docsSkill.execute({ action: 'export', format }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs skill not registered' };
          },
        });

        this.logger.info('CMDB/ITSM/Docs API registered');
      }
    }

    // ── Log Viewer + Cluster Operations API ──────────────────
    const logApiAdapter = this.adapters.get('api');
    if (logApiAdapter && 'setLogCallbacks' in logApiAdapter) {
      const logFilePath = this.config.logger.file?.path ?? process.env.ALFRED_LOG_FILE_PATH ?? './data/logs/alfred.log';
      const auditLogPath = this.config.logger.auditLogPath ?? './data/logs/audit.log';
      const fs = await import('node:fs');
      const readline = await import('node:readline');

      const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
      const LEVEL_NUMS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

      /** List all available log files for a base path, sorted newest first. */
      const listLogFiles = (filePath: string): Array<{ name: string; path: string; size: number; modified: string }> => {
        const files: Array<{ name: string; path: string; size: number; modified: string; mtime: number }> = [];
        // v612 — Scan directory for all log files. Supports BOTH naming schemes:
        //   pino-roll v2: "<base>.log.<date>.<num>"  e.g. alfred.log.2026-05-19.1
        //   pino-roll v4: "<stem>.<date>.<num>.<ext>" e.g. alfred.2026-05-20.1.log
        //   plus the active "<base>" itself (e.g. alfred.log) and the symlink "current.log"
        // Before this fix only the v2 scheme was matched, so after the v611
        // upgrade to pino-roll@4 today's log files were invisible in the WebUI.
        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath);          // "alfred.log"
        const ext = path.extname(baseName);                 // ".log"
        const stem = ext ? baseName.slice(0, -ext.length) : baseName; // "alfred"
        try {
          for (const entry of fs.readdirSync(dir)) {
            const isOldStyle = entry === baseName || entry.startsWith(baseName + '.');
            const isNewStyle = ext !== '' && stem !== baseName
              && entry.startsWith(stem + '.')
              && entry.endsWith(ext);
            if (isOldStyle || isNewStyle) {
              const fullPath = path.join(dir, entry);
              try {
                const s = fs.statSync(fullPath);
                if (s.isFile()) {
                  files.push({ name: entry, path: fullPath, size: s.size, modified: new Date(s.mtimeMs).toISOString(), mtime: s.mtimeMs });
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* dir not found */ }
        files.sort((a, b) => b.mtime - a.mtime);
        return files.map(({ mtime: _, ...rest }) => rest);
      };

      // v681 — since (Unix-ms cutoff) + offsetFromTail (Pagination: skip die N neuesten Zeilen)
      const readLogFile = async (filePath: string, maxLines: number, levelFilter?: string, textFilter?: string, fileIndex?: number, since?: number, offsetFromTail?: number) => {
        const allFiles = listLogFiles(filePath);
        if (allFiles.length === 0) return { lines: [], total: 0, file: filePath, files: [] };
        const idx = Math.min(fileIndex ?? 0, allFiles.length - 1);
        const actualFile = allFiles[idx].path;

        const content = fs.readFileSync(actualFile, 'utf-8');
        const rawLines = content.split('\n').filter(Boolean);
        let parsed = rawLines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) as Array<Record<string, unknown>>;

        if (levelFilter) {
          const minLevel = LEVEL_NUMS[levelFilter] ?? 30;
          parsed = parsed.filter(l => (l.level as number) >= minLevel);
        }
        if (textFilter) {
          const lower = textFilter.toLowerCase();
          parsed = parsed.filter(l => {
            const msg = ((l.msg as string) ?? '').toLowerCase();
            const comp = ((l.component as string) ?? '').toLowerCase();
            return msg.includes(lower) || comp.includes(lower) || JSON.stringify(l).toLowerCase().includes(lower);
          });
        }
        if (since != null && since > 0) {
          parsed = parsed.filter(l => typeof l.time === 'number' && l.time >= since);
        }

        const total = parsed.length;
        // Pagination: erst die N neuesten überspringen, dann die nächsten maxLines davor nehmen.
        // offset=0 = newest chunk; offset=5000 = ältere 5000 dahinter; etc.
        const offset = Math.max(0, offsetFromTail ?? 0);
        const end = total - offset;
        const start = Math.max(0, end - maxLines);
        const lines = parsed.slice(start, end);
        return { lines, total, file: actualFile, files: allFiles };
      };

      (logApiAdapter as any).setLogCallbacks({
        readAppLog: (lines: number, level?: string, filter?: string, fileIndex?: number, since?: number, offsetFromTail?: number) =>
          readLogFile(logFilePath, lines, level, filter, fileIndex, since, offsetFromTail),
        readAuditLog: (lines: number, _level?: string, _filter?: string, fileIndex?: number, since?: number, offsetFromTail?: number) =>
          readLogFile(auditLogPath, lines, undefined, undefined, fileIndex, since, offsetFromTail),
        streamAppLog: (res: import('http').ServerResponse, level?: string, filter?: string) => {
          // Find the current (newest) log file via listLogFiles
          const logFilesList = listLogFiles(logFilePath);
          const actualFile = logFilesList.length > 0 ? logFilesList[0].path : logFilePath;

          const minLevel = level ? (LEVEL_NUMS[level] ?? 30) : 0;
          const lowerFilter = filter?.toLowerCase();

          // Watch for changes and stream new lines
          let lastSize = 0;
          try { lastSize = fs.statSync(actualFile).size; } catch { /* new file */ }

          const watcher = fs.watch(actualFile, () => {
            try {
              const stat = fs.statSync(actualFile);
              if (stat.size <= lastSize) { lastSize = stat.size; return; }

              const stream = fs.createReadStream(actualFile, { start: lastSize, encoding: 'utf-8' });
              let buffer = '';
              stream.on('data', (chunk: string | Buffer) => { buffer += String(chunk); });
              stream.on('end', () => {
                for (const line of buffer.split('\n').filter(Boolean)) {
                  try {
                    const parsed = JSON.parse(line);
                    if (minLevel && (parsed.level as number) < minLevel) continue;
                    if (lowerFilter) {
                      const str = JSON.stringify(parsed).toLowerCase();
                      if (!str.includes(lowerFilter)) continue;
                    }
                    if (!res.writableEnded) {
                      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                    }
                  } catch { /* skip malformed */ }
                }
                lastSize = stat.size;
              });
            } catch { /* file may have rotated */ }
          });

          return () => { watcher.close(); };
        },
      });
    }

    if (logApiAdapter && 'setClusterCallbacks' in logApiAdapter) {
      const dbAdapter = this.database?.getAdapter();
      const nodeId = this.config.cluster?.nodeId ?? 'single';
      const clusterEnabled = this.config.cluster?.enabled === true;
      const reasoningSchedule = this.config.reasoning?.schedule ?? 'hourly';
      const startedAt = this.startedAt;

      (logApiAdapter as any).setClusterCallbacks({
        getHealth: async () => {
          const nodes: Array<Record<string, unknown>> = [];
          const claims: Array<Record<string, unknown>> = [];
          const reasoningSlots: Array<Record<string, unknown>> = [];

          if (dbAdapter) {
            try {
              const nodeRows = await dbAdapter.query('SELECT * FROM node_heartbeats ORDER BY last_seen_at DESC', []);
              const now = Date.now();
              for (const row of nodeRows as any[]) {
                nodes.push({
                  nodeId: row.node_id,
                  host: row.host ?? '',
                  lastSeenAt: row.last_seen_at,
                  startedAt: row.started_at,
                  uptimeS: row.uptime_s ?? 0,
                  adapters: JSON.parse(row.adapters ?? '[]'),
                  version: row.version ?? '',
                  alive: (now - new Date(row.last_seen_at).getTime()) < 60_000,
                });
              }
            } catch { /* table may not exist in SQLite mode */ }

            try {
              const claimRows = await dbAdapter.query('SELECT * FROM adapter_claims ORDER BY platform', []);
              const now = new Date().toISOString();
              for (const row of claimRows as any[]) {
                claims.push({
                  platform: row.platform,
                  nodeId: row.node_id,
                  claimedAt: row.claimed_at,
                  expiresAt: row.expires_at,
                  active: row.expires_at > now,
                });
              }
            } catch { /* table may not exist */ }

            try {
              const slotRows = await dbAdapter.query(
                'SELECT * FROM reasoning_slots ORDER BY claimed_at DESC LIMIT 20', [],
              );
              for (const row of slotRows as any[]) {
                reasoningSlots.push({
                  slotKey: row.slot_key,
                  nodeId: row.node_id,
                  claimedAt: row.claimed_at,
                });
              }
            } catch { /* table may not exist */ }
          }

          // If single mode, create a synthetic node entry
          if (!clusterEnabled && nodes.length === 0) {
            const uptimeS = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
            const adapterList = [...(this.adapters?.keys() ?? [])];
            nodes.push({
              nodeId, host: require('os').hostname(), lastSeenAt: new Date().toISOString(),
              startedAt, uptimeS, adapters: adapterList, version: '', alive: true,
            });
          }

          return {
            clusterEnabled,
            thisNodeId: nodeId,
            nodes,
            claims,
            recentReasoningSlots: reasoningSlots,
            operations: {
              reasoning: { schedule: reasoningSchedule },
              backup: this.config.backup?.schedule ? { schedule: this.config.backup.schedule } : undefined,
            },
          };
        },
      });
    }

    // Startup cleanup — retain audit/summary/activity/usage data
    try {
      const cleaned = {
        audit: await this.auditRepo?.cleanup(90) ?? 0,
        summaries: await this.summaryRepo?.cleanup(180) ?? 0,
        activity: await this.activityRepo?.cleanup(90) ?? 0,
        usage: await this.usageRepo?.cleanup(365) ?? 0,
        // v656 — Hourly Buckets: aktueller + Vormonat (≥ 62d) reicht für Dashboard
        usageHourly: await this.usageRepo?.cleanupHourly(62) ?? 0,
        expiredMemories: await this.memoryRepo?.cleanupExpired() ?? 0,
        processedMessages: this.config.cluster?.enabled
          ? await new (await import('@alfred/storage')).ProcessedMessageRepository(this.database.getAdapter()).cleanup()
          : 0,
      };
      if (cleaned.audit || cleaned.summaries || cleaned.activity || cleaned.usage || cleaned.usageHourly) {
        this.logger.info(cleaned, 'Startup DB cleanup completed');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Startup DB cleanup failed');
    }

    // Skill health: periodic re-enable check (every 5 minutes)
    if (this.skillHealthTracker) {
      this.healthCheckTimer = setInterval(() => this.skillHealthTracker!.checkReEnables(), 5 * 60_000);
    }

    // Memory consolidation: daily cleanup of stale + duplicate memories (runs at ~3:00 AM)
    if (this.config.activeLearning?.enabled !== false && this.memoryRepo) {
      const consolidator = new MemoryConsolidator(this.llmProvider, this.memoryRepo, this.logger.child({ component: 'memory-consolidator' }));
      if (this.database) {
        const { EmbeddingRepository } = await import('@alfred/storage');
        const embRepo = new EmbeddingRepository(this.database.getAdapter());
        consolidator.setEmbeddingRepo(embRepo);
      }
      const userRepoRef = this.userRepo;

      // ── One-shot legacy migration v582 ────────────────────────────────────
      // Backfill relevant_until / source_event_refs and re-resolve relative-date
      // phrases against each memory's updated_at. Idempotent (marker-protected).
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const users = await userRepoRef.listAll();
        for (const user of users) {
          const result = await consolidator.migrateLegacyMemoriesV582(user.id, tz);
          if (result.resolved > 0 || result.relevantUntilSet > 0 || result.refsSet > 0 || result.resolvedExpirySet > 0) {
            this.logger.info({ userId: user.id, ...result }, 'Legacy memory migration v582 applied');
          }
        }
      } catch (err) {
        this.logger.warn({ err }, 'Legacy memory migration v582 startup hook failed');
      }

      let lastConsolidationDay = '';
      this.memoryConsolidatorTimer = setInterval(async () => {
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (now.getHours() !== 3 || lastConsolidationDay === today) return;
        lastConsolidationDay = today;
        try {
          const users = await userRepoRef.listAll();
          for (const user of users) {
            const result = await consolidator.consolidate(user.id);
            if (result.deleted > 0 || result.merged > 0) {
              this.logger.info({ userId: user.id, ...result }, 'Memory consolidation completed');
            }
          }
        } catch (err) {
          this.logger.warn({ err }, 'Memory consolidation failed');
        }
      }, 60 * 60_000); // Check every hour, only acts once at 3 AM

      // Pattern analysis: daily extraction of behavioral patterns (runs at ~3:30 AM, after consolidation)
      if (this.activityRepo) {
        const patternAnalyzer = new PatternAnalyzer(this.llmProvider, this.memoryRepo, this.activityRepo, this.logger.child({ component: 'pattern-analyzer' }));
        let lastPatternDay = '';
        this.patternAnalyzerTimer = setInterval(async () => {
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          if (now.getHours() !== 3 || now.getMinutes() < 30 || lastPatternDay === today) return;
          lastPatternDay = today;
          try {
            const users = await userRepoRef.listAll();
            for (const user of users) {
              const count = await patternAnalyzer.analyze(user.id);
              if (count > 0) {
                this.logger.info({ userId: user.id, patterns: count }, 'Pattern analysis completed');
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'Pattern analysis failed');
          }
        }, 60 * 60_000); // Check every hour, only acts at 3:30 AM

        // Temporal analysis: weekly trends + anomalies (Sunday 4:00 AM)
        const temporalAnalyzer = new TemporalAnalyzer(this.activityRepo, this.memoryRepo, this.logger.child({ component: 'temporal-analyzer' }));
        let lastTemporalWeek = '';
        this.temporalAnalyzerTimer = setInterval(async () => {
          const now = new Date();
          const isoWeek = `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;
          // Only run on Sundays at 4:00 AM, once per week
          if (now.getDay() !== 0 || now.getHours() !== 4 || lastTemporalWeek === isoWeek) return;
          lastTemporalWeek = isoWeek;

          // HA distributed dedup: only one node runs weekly maintenance
          if (this.database.getAdapter().type === 'postgres') {
            try {
              const slotKey = `maintenance:${isoWeek}`;
              const slotResult = await this.database.getAdapter().execute(
                'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
                [slotKey, this.config.cluster?.nodeId ?? 'single', now.toISOString()],
              );
              if (slotResult.changes === 0) {
                this.logger.debug('Weekly maintenance slot already claimed by another node');
                return;
              }
            } catch { /* proceed on error (table might not exist yet) */ }
          }

          try {
            const users = await userRepoRef.listAll();
            const kgService = this.reasoningEngine
              ? new KnowledgeGraphService(new KnowledgeGraphRepository(this.database.getAdapter()), this.logger.child({ component: 'knowledge-graph' }), this.memoryRepo)
              : undefined;
            for (const user of users) {
              const report = await temporalAnalyzer.analyze(user.id);
              if (report.trends.length > 0 || report.anomalies.length > 0) {
                this.logger.info({ userId: user.id, trends: report.trends.length, anomalies: report.anomalies.length }, 'Temporal analysis completed');
              }
              // KG maintenance: decay old entities, prune weak ones
              if (kgService) await kgService.maintenance(user.id);
              // Action feedback: acceptance rates → memories
              if (this.activityRepo && this.memoryRepo) {
                const feedbackTracker = new ActionFeedbackTracker(this.activityRepo, this.memoryRepo, this.logger.child({ component: 'action-feedback' }));
                await feedbackTracker.analyze(user.id);
              }
              // Cleanup expired memories (connection_*, event-bound, TTL-based)
              if (this.memoryRepo) {
                try {
                  const cleaned = await this.memoryRepo.cleanupExpired();
                  if (cleaned > 0) this.logger.info({ cleaned }, 'Expired memories cleaned up');
                } catch (err) { this.logger.warn({ err: (err as Error).message }, 'Memory cleanup failed'); }
              }
              // Prune old BMW telematic history (keep 90 days)
              if (this.bmwTelematicRepo) {
                const pruned = await this.bmwTelematicRepo.prune(90);
                if (pruned > 0) this.logger.info({ pruned }, 'BMW telematic history pruned');
              }
              // Weekly chat LLM analysis: extract implicit knowledge from recent conversations
              if (kgService?.getLLMLinker()) {
                try {
                  const dbAdapter = this.database.getAdapter();
                  const recentMsgs = await dbAdapter.query(
                    `SELECT role, content FROM messages WHERE conversation_id IN (
                      SELECT id FROM conversations WHERE user_id = ?
                    ) ORDER BY created_at DESC LIMIT 100`,
                    [user.id],
                  ) as Array<{ role: string; content: string }>;
                  if (recentMsgs.length > 10) {
                    const chatStats = await kgService.getLLMLinker()!.analyzeRecentChats(user.id, recentMsgs.reverse());
                    if (chatStats.relations > 0 || chatStats.newEntities > 0) {
                      this.logger.info({ ...chatStats }, 'Weekly chat analysis completed');
                    }
                  }
                } catch (err) {
                  this.logger.debug({ err }, 'Weekly chat analysis failed');
                }
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'Temporal analysis failed');
          }

          // Patch E: weekly Service-Discovery from CMDB Assets.
          // Derives Service entries from server/vm/lxc/container/application assets so that
          // ITSM impact-analysis, SLA tracking, and health rollup have meaningful Service
          // objects. Idempotent: skips assets that already have a matching Service.
          try {
            if (this.config.cmdb?.enabled !== false && this.database) {
              const dbAdapter = this.database.getAdapter();
              const { CmdbRepository, ItsmRepository } = await import('@alfred/storage');
              const cmdbRepoSD = new CmdbRepository(dbAdapter);
              const itsmRepoSD = new ItsmRepository(dbAdapter);

              const ownerProfileSD = this.userRepo
                ? await this.userRepo.findOrCreate('telegram' as any, this.config.security?.ownerUserId ?? '')
                : undefined;
              const userIdSD = ownerProfileSD?.masterUserId ?? ownerProfileSD?.id ?? this.config.security?.ownerUserId ?? '';
              if (userIdSD) {
                const allAssets = await cmdbRepoSD.listAssets(userIdSD);
                const serviceCandidates = allAssets.filter(a =>
                  ['server', 'vm', 'lxc', 'container', 'application', 'service'].includes(a.assetType)
                  && a.status === 'active'
                );
                const existingServices = await itsmRepoSD.listServices(userIdSD);
                const existingServiceAssetIds = new Set<string>();
                for (const s of existingServices) {
                  for (const aid of s.assetIds ?? []) existingServiceAssetIds.add(aid);
                }

                let createdServices = 0;
                for (const asset of serviceCandidates) {
                  if (existingServiceAssetIds.has(asset.id)) continue; // already covered
                  // Map asset type → service category
                  const category = ['server', 'vm', 'lxc'].includes(asset.assetType) ? 'infrastructure'
                    : asset.assetType === 'container' ? 'application'
                    : asset.assetType === 'application' ? 'application'
                    : 'infrastructure';
                  // Map asset criticality from environment (prod = high, others = medium)
                  const criticality = asset.environment === 'production' ? 'high' : 'medium';
                  try {
                    await itsmRepoSD.createService(userIdSD, {
                      name: `${asset.name} Service`,
                      description: `Automatisch abgeleitet aus CMDB-Asset (${asset.assetType}). ${asset.purpose ?? ''}`.trim(),
                      category: category as any,
                      environment: asset.environment as any,
                      criticality: criticality as any,
                      assetIds: [asset.id],
                      tags: 'auto-discovered',
                    });
                    createdServices++;
                  } catch { /* dup name → skip */ }
                }
                if (createdServices > 0) {
                  this.logger.info({ createdServices, totalAssets: allAssets.length }, 'Weekly service-discovery completed');
                }
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'Weekly service-discovery failed');
          }
        }, 60 * 60_000); // Check every hour, only acts on Sunday 4 AM
      }
    }

    // ── Reflection Engine (self-optimization) ────────────────
    if (this.config.reflection?.enabled !== false && this.watchRepo && this.memoryRepo && this.activityRepo && this.skillRegistry && this.skillSandbox) {
      try {
        const reflectionConfig = resolveReflectionConfig(this.config.reflection);
        const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
          : this.config.discord?.enabled ? 'discord'
          : this.config.whatsapp?.enabled ? 'whatsapp'
          : 'api') as Platform;

        const reflectionAdapter = this.database?.getAdapter();
        const reflectionCmdbRepo = this.config.cmdb?.enabled !== false && reflectionAdapter
          ? new CmdbRepository(reflectionAdapter)
          : undefined;

        // v614 L1 — resolve ownerChatId for Open-Items-Reflector (Telegram chat to send digest to)
        const ownerChatIdForReflection = this.config.telegram?.enabled
          ? (this.config.security?.ownerUserId ?? '')
          : '';

        this.reflectionEngine = new ReflectionEngine({
          watchRepo: this.watchRepo,
          memoryRepo: this.memoryRepo,
          activityRepo: this.activityRepo,
          cmdbRepo: reflectionCmdbRepo,
          projectRepo: this.projectRepo, // v614 L1
          runbookRepo: this.runbookRepo, // v614 L2 (passed for symmetry, used elsewhere)
          ownerUserId: this.tryOwner(), // v614 L1
          confirmationQueue: this.confirmationQueue, // v657 — für Multi-Action-Open-Item-Eskalation
          skillRegistry: this.skillRegistry,
          skillSandbox: this.skillSandbox,
          llm: this.llmProvider,
          adapters: this.adapters,
          logger: this.logger.child({ component: 'reflection-engine' }),
          defaultChatId: ownerChatIdForReflection,
          defaultPlatform: ownerPlatform,
          nodeId: this.config.cluster?.nodeId ?? 'single',
          config: reflectionConfig,
        }, this.database?.getAdapter());
        this.reflectionEngine.start();
        this.logger.info('Reflection engine initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Reflection engine initialization failed');
      }
    }

    // Trigger C: Chat-session runbook reflector — polls every 5 min for "quiet" sessions
    // (≥30min no activity, ≥10 messages, ≥1 tool-call) and asks LLM to extract a runbook.
    // High-confidence (≥0.8) goes to ConfirmationQueue; 0.5-0.8 auto-saves as draft.
    if (
      this.runbookRepo
      && this.memoryRepo
      && this.confirmationQueue
      && this.database
      && this.llmProvider
    ) {
      try {
        const { ChatSessionRunbookReflector } = await import('./reflection/chat-session-runbook-reflector.js');
        const { ConversationRepository: ConvRepoForRb } = await import('@alfred/storage');
        const dbAdapter = this.database.getAdapter();
        const convRepoForRb = new ConvRepoForRb(dbAdapter);
        const ownerPlatformForRb = (this.config.telegram?.enabled ? 'telegram'
          : this.config.discord?.enabled ? 'discord'
          : this.config.whatsapp?.enabled ? 'whatsapp'
          : 'api');
        this.chatSessionRunbookReflector = new ChatSessionRunbookReflector(
          dbAdapter, convRepoForRb, this.runbookRepo, this.memoryRepo,
          this.confirmationQueue, this.llmProvider, this.logger.child({ component: 'runbook-reflector' }),
          ownerPlatformForRb, this.config.security?.ownerUserId ?? '',
        );
        this.chatSessionRunbookReflector.start();
        this.logger.info('Chat-session runbook reflector started');
      } catch (err) {
        this.logger.warn({ err }, 'Chat-session runbook reflector init failed');
      }
    }

    // v607 D3 — Skill-Failure-Reflector. Detects "skill failed → workaround → success"
    // patterns in the recent activity log and proposes a Runbook for the lesson.
    if (this.activityRepo && this.confirmationQueue && this.runbookRepo) {
      try {
        const { SkillFailureReflector } = await import('./reflection/skill-failure-reflector.js');
        const failureReflector = new SkillFailureReflector(
          this.activityRepo,
          this.logger.child({ component: 'skill-failure-reflector' }),
        );
        // Sweep every 15 minutes — patterns need a few minutes to form anyway
        setInterval(async () => {
          const ownerUid = this.tryOwner();
          if (!ownerUid || !this.confirmationQueue) return;
          try {
            const patterns = await failureReflector.detect(ownerUid);
            for (const p of patterns) {
              const dedupSourceId = `skill-failure-runbook-${p.failedSkill}-${(p.scope ?? '').replace(/[^a-z0-9]/gi, '_').slice(0, 30)}-${p.errorClass}`;
              // Avoid spamming the same lesson — dedup via sourceId (Confirmation-Queue handles this)
              const titleCore = `Skill "${p.failedSkill}" auf ${p.scope ?? '?'} → Workaround`;
              const ownerPlatformForRb = (this.config.telegram?.enabled ? 'telegram'
                : this.config.discord?.enabled ? 'discord'
                : this.config.whatsapp?.enabled ? 'whatsapp'
                : 'api');
              await this.confirmationQueue.enqueue({
                chatId: this.config.security?.ownerUserId ?? '',
                platform: ownerPlatformForRb,
                source: 'reasoning',
                sourceId: dedupSourceId,
                description: `Runbook aus Skill-Failure-Workaround erstellen: "${titleCore}"?`,
                skillName: 'runbook',
                skillParams: {
                  action: 'create',
                  title: titleCore,
                  symptom: `Skill "${p.failedSkill}" scheiterte ${p.errorClass} bei ${p.scope ?? '(unbekannter Scope)'}`,
                  steps: p.workaroundSteps.map((s, i) => `${i + 1}. ${s}`),
                  source_type: 'chat_session',
                  source_id: dedupSourceId,
                  status: 'draft',
                  tags: ['skill-failure', 'workaround', 'auto', p.failedSkill, p.errorClass.toLowerCase()],
                },
                timeoutMinutes: 24 * 60,
              });
              this.logger.info({ skill: p.failedSkill, scope: p.scope, errorClass: p.errorClass },
                'SkillFailureReflector: runbook-confirmation enqueued');

              // v607 D4 — parallel Workflow-Vorschlag wenn Sequence parametrisierbar wirkt.
              // Heuristik: nur wenn >= 2 shell-steps UND scope=host → könnte ein
              // wiederverwendbarer Workflow sein
              if (p.workaroundSteps.length >= 2 && p.scope?.startsWith('host=')) {
                const wfName = `${p.failedSkill}-workaround-${p.errorClass.toLowerCase()}`
                  .replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').slice(0, 40);
                const wfSteps = p.workaroundSteps.map((cmd) => ({
                  type: 'action' as const,
                  skillName: 'shell',
                  inputMapping: { command: cmd },
                  onError: 'stop' as const,
                }));
                await this.confirmationQueue.enqueue({
                  chatId: this.config.security?.ownerUserId ?? '',
                  platform: ownerPlatformForRb,
                  source: 'reasoning',
                  sourceId: `${dedupSourceId}-workflow`,
                  description: `Workflow '${wfName}' aus Skill-Failure-Workaround speichern (${wfSteps.length} Schritte)?`,
                  skillName: 'workflow',
                  skillParams: {
                    action: 'create',
                    name: wfName,
                    description: `Auto-extrahiert aus Workaround für ${p.failedSkill}/${p.errorClass} auf ${p.scope}`,
                    steps: wfSteps,
                    triggerType: 'manual',
                    autoExtracted: true,
                  },
                  timeoutMinutes: 24 * 60,
                });
                this.logger.info({ workflowName: wfName, steps: wfSteps.length },
                  'SkillFailureReflector: workflow-confirmation enqueued (D4)');
              }
            }
          } catch (err) { this.logger.debug({ err }, 'SkillFailureReflector sweep failed (non-critical)'); }
        }, 15 * 60_000);
        this.logger.info('Skill-failure reflector started (15min sweep interval)');
      } catch (err) {
        this.logger.warn({ err }, 'Skill-failure reflector init failed');
      }
    }

    // v722 — RefusalCorrectionReflector. Scannt Conversations nach
    // "Refusal → User-Korrektur → erfolgreicher Skill-Call"-Triplets und legt
    // entsprechende LearnedRecipes mit confidence=0.5 an.
    if (this.conversationRepo && this.learnedRecipeRepo) {
      try {
        const { RefusalCorrectionReflector } = await import('./reflection/refusal-correction-reflector.js');
        const refusalReflector = new RefusalCorrectionReflector(
          this.conversationRepo,
          this.learnedRecipeRepo,
          this.logger.child({ component: 'refusal-correction-reflector' }),
        );
        // Sweep every 30 minutes — Pattern braucht User-Reaktion + Skill-Erfolg
        setInterval(async () => {
          const ownerUid = this.tryOwner();
          if (!ownerUid) return;
          try {
            const detected = await refusalReflector.scanForUser(ownerUid);
            if (detected.length > 0) {
              this.logger.info({ count: detected.length }, 'v722 refusal-correction patterns → recipes persisted');
            }
          } catch (err) {
            this.logger.debug({ err }, 'v722 refusal-correction sweep failed (non-critical)');
          }
        }, 30 * 60_000);
        this.logger.info('v722 RefusalCorrectionReflector started (30min sweep interval)');
      } catch (err) {
        this.logger.warn({ err }, 'v722 RefusalCorrectionReflector init failed');
      }
    }

    // v722 — Auto-Rules Audit beim Startup. Findet prosaische "merke dir wie ..."
    // Memories und enqueued eine Confirmation den User zu fragen ob daraus ein
    // strukturiertes Recipe werden soll. Single-Pass, kein Interval — der User soll
    // einmal Klarheit schaffen, nicht permanent gestört werden.
    if (this.memoryRepo && this.confirmationQueue && this.learnedRecipeRepo) {
      // Fire-and-forget, leicht verzögert damit der Startup-Pfad nicht blockiert
      setTimeout(async () => {
        const ownerUid = this.tryOwner();
        if (!ownerUid || !this.confirmationQueue || !this.memoryRepo) return;
        try {
          const existingRecipes = await this.learnedRecipeRepo!.list(ownerUid, { includeInvalidated: true, limit: 500 });
          const seenTriggers = new Set(existingRecipes.map(r => r.triggerPhrase.toLowerCase().trim()));
          const candidates = await this.memoryRepo.search(ownerUid, 'wie');
          const proseRulePattern = /\b(merke dir|wenn der user|wenn ich sage|du sollst dann)\b/i;
          const ownerPlatformForAudit = (this.config.telegram?.enabled ? 'telegram'
            : this.config.discord?.enabled ? 'discord'
            : this.config.whatsapp?.enabled ? 'whatsapp'
            : 'api');
          let enqueued = 0;
          for (const m of candidates.slice(0, 20)) {
            if (!proseRulePattern.test(m.value)) continue;
            const triggerKey = (m.key + ' ' + m.value).toLowerCase().slice(0, 200).trim();
            if (seenTriggers.has(triggerKey)) continue;
            const dedupSourceId = `audit-prose-rule-${m.key}`;
            await this.confirmationQueue.enqueue({
              chatId: this.config.security?.ownerUserId ?? '',
              platform: ownerPlatformForAudit,
              source: 'reasoning',
              sourceId: dedupSourceId,
              description: `Audit (v722): Memory "${m.key}" sieht aus wie eine prosaische Regel — soll daraus ein strukturiertes Recipe werden? Inhalt: "${m.value.slice(0, 120)}..."`,
              skillName: 'memory',
              skillParams: {
                action: 'learn_recipe',
                trigger_phrase: m.key.replace(/^(?:rule_|behavior_|auto_)/, '').replace(/_/g, ' '),
                action_sequence: '[]', // User soll im Confirmation-Dialog präzisieren
                context_hint: `Quelle: bestehende Memory "${m.key}". Original-Text: ${m.value.slice(0, 200)}`,
              },
              timeoutMinutes: 7 * 24 * 60,
            });
            enqueued++;
            if (enqueued >= 5) break; // Don't spam — max 5 per audit-run
          }
          if (enqueued > 0) {
            this.logger.info({ enqueued }, 'v722 auto-rules audit: enqueued recipe-creation confirmations');
          } else {
            this.logger.debug('v722 auto-rules audit: no prose rules found');
          }
        } catch (err) {
          this.logger.warn({ err }, 'v722 auto-rules audit failed (non-fatal)');
        }
      }, 30_000); // 30s nach Startup
    }

    // Dead-node monitoring (observability only — adapter failover handled by AdapterClaimManager)
    if (this.clusterManager) {
      this.clusterMonitorTimer = setInterval(async () => {
        try {
          const nodes = await this.clusterManager!.getNodesAny();
          if (nodes.length > 0) {
            this.logger.debug({ liveNodes: nodes.map(n => n.id) }, 'Cluster node status');
          }
        } catch { /* ignore */ }
      }, 60_000);
    }

    // Insight expiry: process expired insights every 30 minutes for preference learning
    if (this.insightTracker && this.ownerMasterUserId) {
      const ownerMasterUserId = this.ownerMasterUserId;
      this.insightExpiryTimer = setInterval(() => {
        this.insightTracker!.processExpired(ownerMasterUserId).catch(err => {
          this.logger.warn({ err }, 'Insight expiry processing failed');
        });
      }, 30 * 60_000);
    }

    if (this.adapters.size === 0) {
      this.logger.warn('No messaging adapters enabled. Configure at least one platform.');
    }

    this.logger.info(`Alfred is running with ${this.adapters.size} adapter(s)`);
  }

  async startWithCLI(): Promise<void> {
    // Clear any adapters registered during initialize() — CLI mode
    // should NOT start Telegram/Discord/etc. to avoid conflicts
    // with a running `alfred start` instance.
    this.adapters.clear();

    const { CLIAdapter } = await import('@alfred/messaging');
    const cli = new CLIAdapter();
    this.adapters.set('cli', cli);
    cli.on('disconnected', () => {
      this.stop().then(() => process.exit(0));
    });
    await this.start();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Alfred...');

    // Stop BMW streaming
    if (this.bmwSkill && 'stopStreaming' in this.bmwSkill) {
      (this.bmwSkill as any).stopStreaming();
    }

    // Stop schedulers
    this.reminderScheduler?.stop();
    this.backgroundTaskRunner?.stop();
    this.proactiveScheduler?.stop();
    this.watchEngine?.stop();
    this.triggerManager?.stop();
    this.confirmationQueue?.stop();
    this.calendarWatcher?.stop();
    this.todoWatcher?.stop();
    this.reasoningEngine?.stop();
    this.projectHealthMonitor?.stop();
    this.adapterClaimManager?.stop();
    this.clusterManager?.stopPgHeartbeat();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    if (this.memoryConsolidatorTimer) {
      clearInterval(this.memoryConsolidatorTimer);
      this.memoryConsolidatorTimer = undefined;
    }
    if (this.patternAnalyzerTimer) {
      clearInterval(this.patternAnalyzerTimer);
      this.patternAnalyzerTimer = undefined;
    }
    if (this.temporalAnalyzerTimer) {
      clearInterval(this.temporalAnalyzerTimer);
      this.temporalAnalyzerTimer = undefined;
    }
    if (this.insightExpiryTimer) {
      clearInterval(this.insightExpiryTimer);
      this.insightExpiryTimer = undefined;
    }
    if (this.clusterMonitorTimer) {
      clearInterval(this.clusterMonitorTimer);
      this.clusterMonitorTimer = undefined;
    }
    if (this.cmdbDiscoveryTimer) {
      clearInterval(this.cmdbDiscoveryTimer);
      this.cmdbDiscoveryTimer = undefined;
    }
    if (this.agentConventionsDriftTimer) {
      clearInterval(this.agentConventionsDriftTimer);
      this.agentConventionsDriftTimer = undefined;
    }
    if (this.agentConventionsPatternMiningTimer) {
      clearInterval(this.agentConventionsPatternMiningTimer);
      this.agentConventionsPatternMiningTimer = undefined;
    }
    if (this.agentConventionsSelfModifyTimer) {
      clearInterval(this.agentConventionsSelfModifyTimer);
      this.agentConventionsSelfModifyTimer = undefined;
    }
    if (this.cmdbHealthCheckTimer) {
      clearInterval(this.cmdbHealthCheckTimer);
      this.cmdbHealthCheckTimer = undefined;
    }
    this.reflectionEngine?.stop();

    // Shutdown MCP servers
    if (this.mcpManager) {
      await this.mcpManager.shutdown();
    }

    // Disconnect adapters with individual timeouts
    const adapterTimeout = 5_000;
    for (const [platform, adapter] of this.adapters) {
      try {
        await Promise.race([
          adapter.disconnect(),
          new Promise(resolve => setTimeout(resolve, adapterTimeout)),
        ]);
        this.logger.info({ platform }, 'Adapter disconnected');
      } catch (error) {
        this.logger.error({ platform, err: error }, 'Failed to disconnect adapter');
      }
    }

    // WAL checkpoint before close
    try {
      if (this.database) {
        this.database.getDb().pragma('wal_checkpoint(TRUNCATE)');
        this.database.close();
      }
    } catch {}
    this.logger.info('Alfred stopped');
  }

  async reloadService(service: 'proxmox' | 'unifi' | 'homeassistant' | 'contacts' | 'docker' | 'bmw' | 'goe_charger' | 'routing' | 'todo'): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Reload .env → process.env updated
      reloadDotenv();

      // 2. Reload config from env + yaml
      const freshConfig = new ConfigLoader().loadConfig();

      // 3. Unregister old skill if present
      if (this.skillRegistry.has(service)) {
        this.skillRegistry.unregister(service);
      }

      // 4. Register new skill if config is present
      if (service === 'proxmox' && freshConfig.proxmox) {
        const { ProxmoxSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new ProxmoxSkill(freshConfig.proxmox));
        this.config.proxmox = freshConfig.proxmox;
        this.logger.info({ baseUrl: freshConfig.proxmox.baseUrl }, 'Proxmox skill hot-reloaded');
      }
      if (service === 'unifi' && freshConfig.unifi) {
        const { UniFiSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new UniFiSkill(freshConfig.unifi));
        this.config.unifi = freshConfig.unifi;
        this.logger.info({ baseUrl: freshConfig.unifi.baseUrl }, 'UniFi skill hot-reloaded');
      }
      if (service === 'homeassistant' && freshConfig.homeassistant) {
        const { HomeAssistantSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new HomeAssistantSkill(freshConfig.homeassistant));
        this.config.homeassistant = freshConfig.homeassistant;
        this.logger.info({ baseUrl: freshConfig.homeassistant.baseUrl }, 'Home Assistant skill hot-reloaded');
      }
      if (service === 'contacts' && freshConfig.contacts) {
        const { ContactsSkill, createContactsProvider } = await import('@alfred/skills');
        const contactsProvider = await createContactsProvider(freshConfig.contacts);
        this.skillRegistry.register(new ContactsSkill(contactsProvider));
        this.config.contacts = freshConfig.contacts;
        this.logger.info({ provider: freshConfig.contacts.provider }, 'Contacts skill hot-reloaded');
      }
      if (service === 'docker' && freshConfig.docker) {
        const { DockerSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new DockerSkill(freshConfig.docker));
        this.config.docker = freshConfig.docker;
        this.logger.info('Docker skill hot-reloaded');
      }
      if (service === 'bmw' && freshConfig.bmw) {
        const { BMWSkill } = await import('@alfred/skills');
        this.bmwSkill = new BMWSkill(freshConfig.bmw);
        this.skillRegistry.register(this.bmwSkill);
        // Re-inject service resolver + telematic repo for HA-safe persistence
        if (this.userServiceResolverRef && 'setServiceResolver' in this.bmwSkill) {
          (this.bmwSkill as any).setServiceResolver(this.userServiceResolverRef, this.ownerMasterUserId);
        }
        if (this.bmwTelematicRepo && 'setTelematicRepo' in this.bmwSkill) {
          (this.bmwSkill as any).setTelematicRepo(this.bmwTelematicRepo);
        }
        this.config.bmw = freshConfig.bmw;
        this.logger.info('BMW CarData skill hot-reloaded');
      }
      if (service === 'goe_charger' && freshConfig.goeCharger?.host) {
        const { GoeChargerSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new GoeChargerSkill(freshConfig.goeCharger, freshConfig.energy));
        this.config.goeCharger = freshConfig.goeCharger;
        this.logger.info('go-e Charger skill hot-reloaded');
      }
      if (service === 'routing' && freshConfig.routing) {
        const { RoutingSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new RoutingSkill(freshConfig.routing));
        this.config.routing = freshConfig.routing;
        this.logger.info('Routing skill hot-reloaded');
      }
      if (service === 'todo' && freshConfig.todo) {
        const { MicrosoftTodoSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new MicrosoftTodoSkill(freshConfig.todo));
        this.config.todo = freshConfig.todo;
        this.logger.info('Microsoft To Do skill hot-reloaded');
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, service }, 'Failed to hot-reload service');
      return { success: false, error: message };
    }
  }

  private getConfiguredServices(): Array<{ name: string; provider: string; model: string; status: string }> {
    const services: Array<{ name: string; provider: string; model: string; status: string }> = [];
    const speech = this.config.speech;
    if (speech) {
      const sttProvider = speech.sttProvider ?? speech.provider;
      const ttsProvider = speech.ttsProvider ?? speech.provider;
      if (sttProvider) {
        const model = sttProvider === 'mistral' ? 'voxtral-mini-latest' : sttProvider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
        services.push({ name: 'Speech-to-Text', provider: sttProvider, model, status: 'active' });
      }
      if (speech.ttsEnabled !== false && ttsProvider) {
        const model = ttsProvider === 'mistral' ? 'voxtral-mini-tts-2603' : 'tts-1';
        services.push({ name: 'Text-to-Speech', provider: ttsProvider, model, status: 'active' });
      }
    }
    if (this.config.mistralApiKey) {
      services.push({ name: 'OCR', provider: 'mistral', model: 'mistral-ocr-latest', status: 'active' });
    }
    if (this.config.security?.moderation?.enabled) {
      const provider = this.config.security.moderation.provider ?? 'mistral';
      const model = this.config.security.moderation.model ?? (provider === 'mistral' ? 'mistral-moderation-latest' : 'omni-moderation-latest');
      services.push({ name: 'Moderation', provider, model, status: 'active' });
    }
    const embTier = (this.config.llm as Record<string, unknown>).embeddings as Record<string, unknown> | undefined;
    if (embTier?.provider) {
      services.push({ name: 'Embeddings', provider: embTier.provider as string, model: embTier.model as string ?? 'unknown', status: 'active' });
    }
    if (this.config.reasoning?.llmLinking?.enabled) {
      const llmLinkCfg = this.config.reasoning.llmLinking;
      services.push({ name: 'KG Entity-Linking', provider: llmLinkCfg.provider ?? 'mistral', model: llmLinkCfg.model ?? 'mistral-small-latest', status: 'active' });
    }
    return services;
  }

  private resolveWebUiPath(): string | undefined {
    // ESM-safe: use import.meta.url instead of __dirname
    let selfDir: string;
    try {
      selfDir = path.dirname(new URL(import.meta.url).pathname);
      // Windows: remove leading slash from /C:/...
      if (process.platform === 'win32' && selfDir.startsWith('/')) selfDir = selfDir.slice(1);
    } catch {
      selfDir = process.cwd();
    }

    const candidates = [
      path.join(process.cwd(), 'web-ui'),                     // CWD/web-ui (manual deploy)
      path.join(selfDir, '..', 'web-ui'),                     // bundle/index.js → bundle/web-ui/
      path.join(selfDir, 'web-ui'),                            // same dir as bundle
      path.join(selfDir, '..', '..', 'web-ui'),               // global npm package
      path.join(selfDir, '..', '..', 'apps', 'web', 'out'),   // monorepo dev
    ];
    for (const candidate of candidates) {
      try {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(path.join(resolved, 'index.html'))) {
          this.logger.info({ path: resolved }, 'Web UI found');
          return resolved;
        }
      } catch { /* skip */ }
    }
    this.logger.debug('Web UI not found — serving API only');
    return undefined;
  }

  /**
   * v633 T3.1 — Run an LLM-based root-cause hypothesis for a freshly-created problem.
   * Fire-and-forget: builds a focused prompt with linked incident titles+symptoms,
   * sends to the LLM (default tier), persists the response as `analysis_notes` and
   * tentative `proposedFix`. Skipped if LLM not configured or fewer than 2 linked
   * incidents (not enough signal to be useful).
   */
  private async runProblemRca(
    userId: string,
    problemId: string,
    problemRepo: { getProblemById: (uid: string, id: string) => Promise<any>; updateProblem: (uid: string, id: string, u: Record<string, unknown>) => Promise<any>; appendAnalysisNotes: (uid: string, id: string, note: string) => Promise<void> },
    itsmRepo: { getIncidentById: (uid: string, id: string) => Promise<any> },
  ): Promise<void> {
    if (!this.llmProvider) return;
    const problem = await problemRepo.getProblemById(userId, problemId);
    if (!problem || (problem.linkedIncidentIds?.length ?? 0) < 2) return;
    if (problem.rootCauseDescription) return; // already analyzed

    const incidentDetails: string[] = [];
    for (const incId of problem.linkedIncidentIds.slice(0, 8)) {
      try {
        const inc = await itsmRepo.getIncidentById(userId, incId);
        if (!inc) continue;
        incidentDetails.push(`- **${inc.title}** (${inc.openedAt?.slice(0, 16) ?? '?'})\n  Symptoms: ${(inc.symptoms ?? '').slice(0, 200)}`);
      } catch { /* skip */ }
    }
    if (incidentDetails.length === 0) return;

    const prompt = `Du bist ein erfahrener Site-Reliability-Engineer. Analysiere die folgenden ${incidentDetails.length} ähnlichen Incidents und formuliere eine Root-Cause-Hypothese.

**Problem-Titel:** ${problem.title}

**Linked Incidents:**
${incidentDetails.join('\n')}

Antworte präzise in **3 Abschnitten**, jeder ≤3 Sätze:

1. **Root-Cause-Hypothese:** Was ist die wahrscheinlichste Ursache?
2. **Untersuchungs-Schritte:** Welche 2-3 konkreten Checks würdest du jetzt machen?
3. **Vorgeschlagener Fix:** Welche Maßnahme behebt das Problem dauerhaft?

Antworte auf Deutsch, fokussiert auf den hier sichtbaren Pattern. Keine generischen Floskeln.`;

    try {
      const res = await this.llmProvider.complete({ messages: [{ role: 'user', content: prompt }], tier: 'default' as any, maxTokens: 800 });
      const note = `🤖 Auto-RCA (${new Date().toISOString().slice(0, 16)})\n${res.content}`;
      await problemRepo.appendAnalysisNotes(userId, problemId, note);
      // Try to extract the "Vorgeschlagener Fix" section into proposedFix
      const fixMatch = /Vorgeschlagener Fix[:\s]*([\s\S]+?)(?:\n\n|$)/i.exec(res.content);
      if (fixMatch) {
        await problemRepo.updateProblem(userId, problemId, { proposedFix: fixMatch[1].trim().slice(0, 500) });
      }
      this.logger.info({ problemId, incidentsAnalyzed: incidentDetails.length }, 'Auto-RCA completed');
    } catch (err) {
      this.logger.debug({ err: (err as Error).message, problemId }, 'Auto-RCA LLM call failed');
    }
  }

  private async buildPrometheusMetrics(): Promise<string> {
    const lines: string[] = [];
    const uptime = Math.floor(process.uptime());

    // Process info
    lines.push('# HELP alfred_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE alfred_uptime_seconds gauge');
    lines.push(`alfred_uptime_seconds ${uptime}`);

    // Pipeline metrics (in-memory, current session)
    const m = this.pipeline.getMetrics();
    lines.push('# HELP alfred_requests_total Total messages processed');
    lines.push('# TYPE alfred_requests_total counter');
    lines.push(`alfred_requests_total ${m.requestsTotal}`);
    lines.push('# HELP alfred_requests_success_total Successful requests');
    lines.push('# TYPE alfred_requests_success_total counter');
    lines.push(`alfred_requests_success_total ${m.requestsSuccess}`);
    lines.push('# HELP alfred_requests_failed_total Failed requests');
    lines.push('# TYPE alfred_requests_failed_total counter');
    lines.push(`alfred_requests_failed_total ${m.requestsFailed}`);
    lines.push('# HELP alfred_request_duration_avg_ms Average request duration');
    lines.push('# TYPE alfred_request_duration_avg_ms gauge');
    lines.push(`alfred_request_duration_avg_ms ${m.avgDurationMs}`);

    // Session token/cost metrics
    const costs = this.llmProvider.getCostSummary();
    lines.push('# HELP alfred_llm_input_tokens_total Total LLM input tokens (session)');
    lines.push('# TYPE alfred_llm_input_tokens_total counter');
    lines.push(`alfred_llm_input_tokens_total ${costs.totalInputTokens}`);
    lines.push('# HELP alfred_llm_output_tokens_total Total LLM output tokens (session)');
    lines.push('# TYPE alfred_llm_output_tokens_total counter');
    lines.push(`alfred_llm_output_tokens_total ${costs.totalOutputTokens}`);
    lines.push('# HELP alfred_llm_cost_usd_total Total LLM cost in USD (session)');
    lines.push('# TYPE alfred_llm_cost_usd_total counter');
    lines.push(`alfred_llm_cost_usd_total ${costs.totalCostUsd}`);

    // Per-model breakdown
    lines.push('# HELP alfred_llm_calls_total LLM calls by model');
    lines.push('# TYPE alfred_llm_calls_total counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      const label = `model="${model}"`;
      lines.push(`alfred_llm_calls_total{${label}} ${entry.calls}`);
    }
    lines.push('# HELP alfred_llm_cost_usd LLM cost by model');
    lines.push('# TYPE alfred_llm_cost_usd counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_cost_usd{model="${model}"} ${entry.costUsd}`);
    }
    lines.push('# HELP alfred_llm_input_tokens LLM input tokens by model');
    lines.push('# TYPE alfred_llm_input_tokens counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_input_tokens{model="${model}"} ${entry.inputTokens}`);
    }
    lines.push('# HELP alfred_llm_output_tokens LLM output tokens by model');
    lines.push('# TYPE alfred_llm_output_tokens counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_output_tokens{model="${model}"} ${entry.outputTokens}`);
    }

    // Watches & scheduled actions
    if (this.watchRepo) {
      lines.push('# HELP alfred_watches_active Number of enabled watches');
      lines.push('# TYPE alfred_watches_active gauge');
      lines.push(`alfred_watches_active ${await this.watchRepo.countEnabled()}`);
    }
    if (this.scheduledActionRepo) {
      lines.push('# HELP alfred_schedulers_active Number of enabled scheduled actions');
      lines.push('# TYPE alfred_schedulers_active gauge');
      lines.push(`alfred_schedulers_active ${await this.scheduledActionRepo.countEnabled()}`);
    }

    // Persisted daily totals from DB
    if (this.usageRepo) {
      const today = new Date().toISOString().slice(0, 10);
      const daily = await this.usageRepo.getDaily(today);
      lines.push('# HELP alfred_llm_today_cost_usd Total LLM cost today (persisted)');
      lines.push('# TYPE alfred_llm_today_cost_usd gauge');
      lines.push(`alfred_llm_today_cost_usd ${daily.totalCostUsd}`);
      lines.push('# HELP alfred_llm_today_calls Total LLM calls today (persisted)');
      lines.push('# TYPE alfred_llm_today_calls gauge');
      lines.push(`alfred_llm_today_calls ${daily.totalCalls}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private async autoLinkApiUser(message: NormalizedMessage): Promise<void> {
    if (message.platform !== 'api') return;

    try {
      const apiUser = await this.userRepo.findOrCreate('api', message.userId, message.userName);
      const masterUserId = await this.userRepo.getMasterUserId(apiUser.id);

      // Already linked to another user
      if (masterUserId !== apiUser.id) return;

      // v667 — Sicherheits-Guard gegen Multi-User-Identity-Leak.
      // Bisheriges Verhalten: api/cli-User wurden BLIND an den ersten beliebigen
      // Non-bot User gelinkt. In Multi-User-Setups (matrix + telegram + ...) führte
      // das dazu, dass ein neuer WebUI-Login die Identität eines FREMDEN Users
      // übernommen hat — inkl. dessen Memories, KG, etc.
      //
      // Neues Verhalten:
      //  • Wenn EXAKT 1 Master-User existiert → safe auto-link (Single-User-Setup).
      //  • Wenn mehrere Master-User existieren → KEIN Auto-Link mehr. Der User
      //    muss sich explizit über /link verbinden.
      //  • Override via config.users.apiAutoLink = true (Opt-In, falls Legacy-Setup).
      const apiAutoLink = (this.config as { users?: { apiAutoLink?: boolean } }).users?.apiAutoLink;
      const masterCount = await (this.userRepo as { countMasterUsersNotIn?: (excl: Array<'api' | 'cli'>) => Promise<number> }).countMasterUsersNotIn?.(['api', 'cli']) ?? 0;
      if (masterCount > 1 && apiAutoLink !== true) {
        this.logger.debug(
          { apiUserId: apiUser.id, masterCount },
          'Auto-link skipped: multiple master users — explicit /link required (Multi-User Safety)',
        );
        return;
      }

      // Find the first non-API/non-CLI user to link with
      const existingUser = await this.userRepo.findFirstByPlatformNotIn(['api', 'cli']);
      if (existingUser) {
        const targetMasterId = await this.userRepo.getMasterUserId(existingUser.id);
        await this.userRepo.setMasterUser(apiUser.id, targetMasterId);
        this.logger.info({ apiUserId: apiUser.id, masterUserId: targetMasterId, masterCount }, 'Auto-linked API user');
      }
    } catch (err) {
      this.logger.debug({ err }, 'Auto-link API user failed');
    }
  }

  private setupAdapterHandlers(platform: Platform, adapter: MessagingAdapter): void {
    adapter.on('message', async (message: NormalizedMessage) => {
      try {
        // Handle /stop command — cancel active request for this user
        if (message.text?.trim().toLowerCase() === '/stop') {
          const cancelled = this.pipeline.cancelRequest(message.chatId, message.userId);
          const reply = cancelled ? '⏹ Anfrage abgebrochen.' : 'Keine laufende Anfrage zum Abbrechen.';
          try { await adapter.sendMessage(message.chatId, reply); } catch { /* ignore */ }
          return;
        }

        // Auto-link API user with existing platform user
        this.autoLinkApiUser(message);

        // Send a placeholder message and update it with progress
        let statusMessageId: string | undefined;
        let lastStatus = '';

        const onProgress = async (status: string) => {
          if (status === lastStatus) return;
          lastStatus = status;
          try {
            if (platform === 'api') {
              // API adapter: always use editMessage (sends 'status' SSE event, not 'response')
              await adapter.editMessage(message.chatId, statusMessageId ?? '', status);
            } else if (!statusMessageId) {
              statusMessageId = await adapter.sendMessage(message.chatId, status);
            } else {
              await adapter.editMessage(message.chatId, statusMessageId, status);
            }
          } catch (err) {
            this.logger.debug({ err, chatId: message.chatId }, 'Status message edit failed');
          }
        };

        const result = await this.pipeline.process(message, onProgress);

        // Group privacy: redirect sensitive skill responses to DM
        const PRIVATE_SKILLS = new Set([
          'email', 'calendar', 'contacts', 'bmw', 'todo', 'microsoft_todo', 'onedrive',
          'database', 'memory', 'note', 'reminder', 'file', 'shell',
        ]);
        const isGroup = message.chatType === 'group';
        const usedPrivateSkill = isGroup && result.usedSkills?.some(s => PRIVATE_SKILLS.has(s));

        if (usedPrivateSkill && result.text) {
          // Send response as DM instead of in the group
          try {
            const formatted = this.formatter.format(result.text, message.platform);
            const sendOpts = formatted.parseMode !== 'text'
              ? { parseMode: formatted.parseMode as 'markdown' | 'html' }
              : undefined;
            const dmResult = await adapter.sendDirectMessage(message.userId, formatted.text, sendOpts);
            if (dmResult) {
              // Notify the group
              await adapter.sendMessage(message.chatId, `@${message.userName ?? message.userId}, Antwort per DM gesendet (persönliche Daten).`);
              // Send attachments via DM too
              if (result.attachments) {
                for (const att of result.attachments) {
                  try {
                    await adapter.sendDirectMessage(message.userId, att.fileName ?? 'file');
                  } catch { /* skip */ }
                }
              }
            } else {
              // DM failed — send in group as fallback
              await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
            }
          } catch (err) {
            this.logger.warn({ err, chatId: message.chatId }, 'Group privacy DM redirect failed, sending in group');
            // Fallback: send in group anyway
            const formatted = this.formatter.format(result.text, message.platform);
            await adapter.sendMessage(message.chatId, formatted.text);
          }
          if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
          return;
        }

        // Empty text means the message was handled internally (e.g. confirmation response)
        // — skip sending to avoid empty Telegram messages
        if (result.text) {
          const formatted = this.formatter.format(result.text, message.platform);
          const sendOpts = formatted.parseMode !== 'text'
            ? { parseMode: formatted.parseMode as 'markdown' | 'html' }
            : undefined;

          // Replace status message with final response, or send new if no status was shown.
          // For the API adapter, always use sendMessage so the client receives a 'response' event.
          try {
            if (statusMessageId && platform !== 'api') {
              try {
                await adapter.editMessage(message.chatId, statusMessageId, formatted.text, sendOpts);
              } catch (err) {
                this.logger.debug({ err, chatId: message.chatId }, 'Final response edit failed, sending as new message');
                await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
              }
            } else {
              await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
            }
          } catch (fmtErr) {
            // HTML/Markdown parsing failed (e.g. stray < in text) — retry as plain text
            this.logger.warn({ err: fmtErr, chatId: message.chatId }, 'Formatted send failed, retrying as plain text');
            const plain = this.formatter.format(result.text, 'signal'); // strips all formatting
            await adapter.sendMessage(message.chatId, plain.text);
          }
        }

        // Send file attachments (e.g. from code_sandbox) after the text reply
        if (result.attachments) {
          for (const att of result.attachments) {
            try {
              const isImage = att.mimeType?.startsWith('image/') ?? false;
              const isAudio = att.mimeType?.startsWith('audio/') ?? false;
              const isVoice = att.mimeType === 'audio/ogg' || att.mimeType === 'audio/opus';
              if (isImage) {
                await adapter.sendPhoto(message.chatId, att.data, att.fileName);
              } else if (isVoice) {
                await adapter.sendVoice(message.chatId, att.data);
              } else if (isAudio) {
                // Send as audio (playable in Telegram) — MP3, WAV, etc.
                await adapter.sendVoice(message.chatId, att.data);
              } else {
                await adapter.sendFile(message.chatId, att.data, att.fileName);
              }
            } catch (err) {
              this.logger.warn({ err, fileName: att.fileName, chatId: message.chatId }, 'Failed to send attachment');
            }
          }
        }

        // Signal end of stream (closes SSE for HttpAdapter, no-op for others)
        if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
      } catch (error) {
        this.logger.error({ platform, err: error, chatId: message.chatId }, 'Failed to handle message');
        try {
          await adapter.sendMessage(message.chatId, 'Sorry, I encountered an error processing your message. Please try again.');
        } catch (sendError) {
          this.logger.error({ err: sendError }, 'Failed to send error message');
        }
        if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
      }
    });

    // v662 — Telegram-Reactions als Feedback-Signal
    // Wenn der User auf eine Alfred-Antwort mit 👍/❤️/etc. reagiert, speichern
    // wir das als Memory (type='feedback'). Da wir kein Telegram-msg-id → DB-id
    // Mapping haben, nehmen wir pragmatisch die LETZTE assistant-Message in der
    // Conversation als Bezug — funktioniert für den 99%-Fall (User reagiert auf
    // die jüngste Antwort).
    adapter.on('reaction', async (reaction) => {
      try {
        this.logger.info({
          platform: reaction.platform, chatId: reaction.chatId,
          added: reaction.added, removed: reaction.removed, sentiment: reaction.sentiment,
        }, 'Reaction received');

        if (reaction.sentiment === 'neutral' || !this.memoryRepo || !this.conversationRepo) return;

        // Conversation finden + letzte assistant-Message holen
        const conv = await this.conversationRepo.findByPlatformChat(reaction.platform as Platform, reaction.chatId);
        if (!conv) return;
        const recent = await this.conversationRepo.getMessages(conv.id, 20);
        const lastAssistant = [...recent].reverse().find((m: { role: string }) => m.role === 'assistant');
        if (!lastAssistant) return;

        // Owner-Master-User-ID resolven
        const ownerUid = this.tryOwner() ?? '';
        if (!ownerUid) return;

        // Memory speichern: snippet der assistant-message + sentiment
        const snippet = (lastAssistant as { content: string }).content.slice(0, 200).replace(/\s+/g, ' ').trim();
        const emojis = reaction.added.join(' ') || '∅';
        const key = `reaction_${reaction.sentiment}_${reaction.chatId}_${reaction.messageId}`;
        const value = reaction.sentiment === 'positive'
          ? `User reagierte positiv (${emojis}) auf Alfred-Antwort: "${snippet}". Vorgehen merken, ähnliche Situation analog handhaben.`
          : `User reagierte negativ (${emojis}) auf Alfred-Antwort: "${snippet}". Vorgehen ÜBERDENKEN, ähnliche Situation anders angehen.`;

        await this.memoryRepo.saveWithMetadata(
          ownerUid,
          key,
          value,
          'feedback',
          reaction.sentiment === 'positive' ? 'pattern' : 'correction',
          0.85,
          'auto',
        );
        this.logger.info({ sentiment: reaction.sentiment, snippet: snippet.slice(0, 60) },
          'Reaction-Feedback als Memory gespeichert');
      } catch (err) {
        this.logger.warn({ err }, 'Reaction-Handler fehlgeschlagen (non-fatal)');
      }
    });

    adapter.on('error', (error: Error) => {
      this.logger.error({ platform, err: error }, 'Adapter error');
    });

    adapter.on('connected', () => {
      this.logger.info({ platform }, 'Adapter connected');
    });

    adapter.on('disconnected', () => {
      this.logger.warn({ platform }, 'Adapter disconnected');
    });
  }

  private detectImageGenProvider(): { provider: 'openai' | 'google'; apiKey: string; baseUrl?: string } | undefined {
    const tiers = ['default', 'strong', 'fast', 'embeddings', 'local'] as const;
    // Prefer OpenAI (better image quality), then Google
    for (const preferred of ['openai', 'google'] as const) {
      for (const tier of tiers) {
        const tierConfig = this.config.llm[tier];
        if (tierConfig?.provider === preferred && tierConfig.apiKey) {
          return { provider: preferred, apiKey: tierConfig.apiKey, baseUrl: tierConfig.baseUrl };
        }
      }
    }
    return undefined;
  }

  /** Find a Mistral API key. Checks dedicated mistralApiKey first, then LLM tiers.
   *  This allows using Mistral services (OCR, moderation, STT, TTS, embeddings)
   *  independently of the main LLM provider. */
  private detectMistralApiKey(): string | undefined {
    // 1. Dedicated standalone key (ALFRED_MISTRAL_API_KEY → config.mistralApiKey)
    if (this.config.mistralApiKey) {
      return this.config.mistralApiKey;
    }
    // 2. Any LLM tier using Mistral as provider
    const tiers = ['default', 'strong', 'fast', 'embeddings', 'local'] as const;
    for (const tier of tiers) {
      const tierConfig = this.config.llm[tier];
      if (tierConfig?.provider === 'mistral' && tierConfig.apiKey) {
        return tierConfig.apiKey;
      }
    }
    return undefined;
  }

  private loadSecurityRules(): SecurityRule[] {
    const rulesPath = path.resolve(this.config.security.rulesPath);
    const rules: SecurityRule[] = [];

    if (!fs.existsSync(rulesPath)) {
      this.logger.warn({ rulesPath }, 'Security rules directory not found, using default deny');
      return rules;
    }

    const stat = fs.statSync(rulesPath);
    if (!stat.isDirectory()) {
      this.logger.warn({ rulesPath }, 'Security rules path is not a directory');
      return rules;
    }

    const files = fs.readdirSync(rulesPath).filter(
      f => f.endsWith('.yml') || f.endsWith('.yaml'),
    );

    for (const file of files) {
      try {
        const filePath = path.join(rulesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(content) as { rules?: unknown[] };
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          const ruleLoader = new RuleLoader();
          const validated = ruleLoader.loadFromObject({ rules: parsed.rules });
          rules.push(...validated);
          this.logger.info({ file, count: validated.length }, 'Loaded security rules');
        }
      } catch (err) {
        this.logger.error({ err, file }, 'Failed to load security rules file');
      }
    }

    return rules;
  }
}
