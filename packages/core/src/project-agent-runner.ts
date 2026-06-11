import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

/** v651 — Async-context für die aktuelle Project-Agent-Session, damit sendProgress
 *  ohne Signatur-Änderung in alle 46 Call-Sites die sessionId für Output-Buffer findet. */
const currentSession = new AsyncLocalStorage<{ sessionId: string }>();
import type { Logger } from 'pino';
import type { Platform, ProjectAgentMeta, CodeAgentDefinitionConfig, ForgeConfig } from '@alfred/types';
import type { ProjectAgentSessionRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import { executeAgent, isTransientApiFailure, getAgentVersion, validateBuild, createProjectPlan, drainInterjections, registerAbortController, removeAbortController, extractBuildError, stageAssetsForProject, appendOutputLine, appendOutputEvent, markOutputEnded, assessPlanProgress, applyMutation, typicalPhaseRange } from '@alfred/skills';
import type { ProjectPlan, PlanMutation } from '@alfred/skills';
import type { FileStore } from '@alfred/storage';

const execFileAsync = promisify(execFile);

/**
 * v846 — Erzeugt ein kompaktes Conventional-Commits Subject aus einer (oft
 * sehr langen) Phase-Beschreibung.
 *
 * Strategie:
 *  1. Conventional-Commit-Prefix anhand Keywords erkennen (feat/fix/test/...)
 *  2. Den ersten Satz oder die ersten 60-72 Zeichen der Phase als Subject nehmen
 *  3. Bei "X: Y" Pattern den Teil vor dem `:` als Topic, den Rest als Body
 *
 * Eingabe: "Channel-Leave/Rejoin-Logik korrigieren: beim expliziten Channel-Verlassen Membership beenden..."
 * Ausgabe Subject: "fix: Channel-Leave/Rejoin-Logik korrigieren"
 */
export function buildCommitSubject(phase: string, phaseNum: number, convention?: string): string {
  const lower = phase.toLowerCase();
  let type = 'feat';
  if (/fix|bug|repariere|behebe|error|correct|korrigier/.test(lower)) type = 'fix';
  else if (/refactor|umstrukturier|cleanup|aufr(?:ä|ae)umen/.test(lower)) type = 'refactor';
  else if (/test|spec/.test(lower)) type = 'test';
  else if (/doc|readme|comment/.test(lower)) type = 'docs';
  else if (/style|format|lint/.test(lower)) type = 'style';
  else if (/perf|optimier/.test(lower)) type = 'perf';
  else if (/chore|setup|config/.test(lower)) type = 'chore';

  // Extract topic: first sentence or "X: Y" prefix
  let topic = phase.trim();
  const colonIdx = topic.indexOf(':');
  if (colonIdx > 0 && colonIdx < 80) {
    topic = topic.slice(0, colonIdx).trim();
  } else {
    // Split on first sentence end
    const sentEnd = topic.search(/[.!?](?:\s|$)/);
    if (sentEnd >= 5 && sentEnd < 80) topic = topic.slice(0, sentEnd).trim();
  }
  // Hard cap at 60 chars for the topic so total subject fits in 72
  if (topic.length > 60) topic = topic.slice(0, 59).trimEnd() + '…';

  if (convention === 'conventional') {
    return `${type}: ${topic}`;
  }
  return `Phase ${phaseNum}: ${topic}`;
}

/** Run a git command, optionally as a different user via sudo -u. */
async function gitExec(args: string[], cwd: string, runAsUser?: string): Promise<string> {
  // Inject git identity for commit/init commands when running as another user
  const needsIdentity = runAsUser && (args[0] === 'commit' || args[0] === 'init');
  const gitArgs = needsIdentity
    ? ['-c', 'user.name=Alfred', '-c', 'user.email=alfred@local', ...args]
    : args;
  const cmd = runAsUser ? 'sudo' : 'git';
  const cmdArgs = runAsUser ? ['-u', runAsUser, 'git', ...gitArgs] : gitArgs;
  const { stdout } = await execFileAsync(cmd, cmdArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * v650 — Secret-Scan auf den staged diff. Verwendet bekannte Patterns für API-Keys,
 * Tokens, private Keys. Konservativ — blockt nur bei klaren Treffern, nicht bei
 * ambiguen Hex-Strings.
 */
async function scanDiffForSecrets(cwd: string, runAsUser?: string): Promise<string[]> {
  let diff: string;
  try {
    // Hole UNSTAGED diff (das was gleich committed wird via git add -A)
    diff = await gitExec(['diff', 'HEAD', '--unified=0'], cwd, runAsUser).catch(() => '');
    if (!diff) {
      // Fallback: alle Diffs untracked + staged
      diff = await gitExec(['diff', '--unified=0'], cwd, runAsUser).catch(() => '');
    }
  } catch { return []; }
  if (!diff) return [];

  const PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'AWS Secret Key', re: /\b[A-Za-z0-9/+=]{40}\b/g }, // muss zusammen mit AKIA gechecked werden, sonst zu falsch-positiv — skippen unten
    { name: 'GitHub Token', re: /\bghp_[A-Za-z0-9]{36}\b/g },
    { name: 'GitHub OAuth', re: /\bgho_[A-Za-z0-9]{36}\b/g },
    { name: 'GitHub PAT', re: /\bghs_[A-Za-z0-9]{36}\b/g },
    { name: 'GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
    { name: 'OpenAI API Key', re: /\bsk-[A-Za-z0-9]{48,}\b/g },
    { name: 'Anthropic API Key', re: /\bsk-ant-[A-Za-z0-9-_]{24,}\b/g },
    { name: 'Stripe Secret', re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
    { name: 'Slack Token', re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'Private RSA Key', re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: 'JWT Token', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  ];
  const findings: string[] = [];
  const lines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of lines) {
    for (const { name, re } of PATTERNS) {
      if (name === 'AWS Secret Key') continue; // skip standalone — needs context
      const m = line.match(re);
      if (m) findings.push(`${name} in: ${line.slice(0, 120).trim()}`);
    }
  }
  return findings.slice(0, 20);
}

/**
 * v643 — Like gitExec but returns both stdout AND stderr. Needed for `git push`
 * because GitLab/GitHub MR/PR-creation hints come through stderr.
 */
async function gitExecBoth(args: string[], cwd: string, runAsUser?: string): Promise<{ stdout: string; stderr: string }> {
  const cmd = runAsUser ? 'sudo' : 'git';
  const cmdArgs = runAsUser ? ['-u', runAsUser, 'git', ...args] : args;
  const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * v643 — Parse MR/PR-creation URL out of `git push` output.
 * GitLab: "remote: To create a merge request for X, visit:\nremote:   https://gitlab.../merge_requests/new?..."
 * GitHub: "remote: Create a pull request for 'X' on GitHub by visiting:\nremote:   https://github.com/.../pull/new/X"
 * Gitea:  "remote: Create a new pull request for 'X':\nremote:   https://gitea.../compare/main...X"
 * Returns the first URL after one of these prefixes, or undefined.
 */
function extractPushUrl(stderr: string): string | undefined {
  const lines = stderr.split('\n');
  const prefixPatterns = [
    /create a merge request/i,
    /create a pull request/i,
    /create a new pull request/i,
    /visit:/i,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (prefixPatterns.some(re => re.test(lines[i]))) {
      // URL kann auf gleicher oder nächster Zeile sein
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const m = lines[j].match(/https?:\/\/[^\s]+/);
        if (m) {
          // Sanitize trailing punctuation
          return m[0].replace(/[.,;:]+$/, '');
        }
      }
    }
  }
  return undefined;
}

export interface ProjectAgentConfig {
  goal: string;
  cwd: string;
  agentName: string;
  buildCommands: string[];
  testCommands: string[];
  maxDurationHours: number;
  maxFixAttempts: number;
  buildTimeoutMs: number;
  /** v650 — opt-in: erstellt feature/agent-<taskId>-Branch statt direkt auf default branch */
  branchPerSession?: boolean;
  /** v650 — opt-in: User-Confirmation des Plans vor Phase 1 */
  confirmPlan?: boolean;
  /** v652 — opt-in: bei terminal-failure 30s warten dann automatisch resume.
   *  Hardlimit max 2 Auto-Resumes pro Session-Kette gegen Infinite-Loops. */
  autoResume?: boolean;
  /** v862 — Self-Healing-Run (cwd wurde auf Repo-Checkout umgeleitet).
   *  Nach erfolgreichem Push: MR (GitLab) + PR (GitHub) gegen den base-Branch
   *  erstellen statt nur zu pushen. branchPerSession ist dabei erzwungen. */
  selfHeal?: boolean;
  /** v862 — Checkout-Lock-Release, vom Skill injiziert. Wird im finally gerufen. */
  selfHealReleaseLock?: () => void;
  /** v862.1 — MR/PR-Ziel-Branch für Self-Healing (= selfHealing.baseBranch).
   *  NICHT forge.baseBranch verwenden: das ist der Default-Branch der
   *  USER-Projekte (z.B. master) und würde Self-Heal-MRs falsch targeten. */
  selfHealBaseBranch?: string;
  /** v866 — auslösender User (masterUserId) für CLI-Usage-Tracking + Session-Start. */
  userId?: string;
}

export type ProjectAgentCompletionCallback = (
  sessionId: string,
  config: { goal: string; cwd: string },
  state: { milestonesReached: string[]; totalFilesChanged: number; projectIteration: number },
  success: boolean,
) => Promise<void>;

/**
 * v867 — Hauptbranch-Namen für den Push-Guard. Ein Push von einem dieser
 * Branches auf ein Projekt, das von einem ANDEREN Hauptbranch deployed,
 * ist praktisch immer eine Verwechslung (Vorfall alpbyte 11.06.: Workspace
 * stand nach einem Incident auf `main`, Projekt deployed von `master` —
 * alle Agent-Pushes des Tages landeten unbemerkt auf main).
 */
const MAINLINE_BRANCHES = ['main', 'master', 'trunk'];

/**
 * v867 — Entscheidung: Mainline-Push blockieren?
 * Pure Function für Testbarkeit. Blockiert NUR die Hauptbranch-Verwechslung:
 *  - Feature-Branches (branchPerSession/selfHeal oder Nicht-Mainline-Name)
 *    pushen immer durch — das ist gewollte Arbeitsweise.
 *  - Ohne bekannten Deploy-Branch keine Blockade (kein Raten).
 */
export function shouldBlockMainlinePush(input: {
  currentBranch: string;
  deployBranch?: string;
  branchPerSession?: boolean;
  selfHeal?: boolean;
}): { block: boolean; reason?: string } {
  if (input.branchPerSession || input.selfHeal) return { block: false };
  if (!input.deployBranch) return { block: false };
  if (input.currentBranch === input.deployBranch) return { block: false };
  if (!MAINLINE_BRANCHES.includes(input.currentBranch)) return { block: false };
  return {
    block: true,
    reason: `Workspace-Branch "${input.currentBranch}" ist ein Hauptbranch, aber dieses Projekt deployed von "${input.deployBranch}"`,
  };
}

/**
 * v864 — Delay der auf ein AbortSignal hört (für API-Retry-Backoff).
 * Returnt true wenn abgebrochen wurde, false wenn die Zeit normal ablief.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(true); return; }
    const onAbort = (): void => { cleanup(); resolve(true); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, ms);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ProjectAgentRunner {
  private lastProgressAt = 0;
  private readonly throttleMs = 30_000;
  private completionCallback?: ProjectAgentCompletionCallback;
  /** Optional file-store for asset-bridging (v604 L8). */
  private fileStore?: FileStore;

  /** Injected by alfred.ts when a file-store is configured. */
  setFileStore(fs: FileStore): void {
    this.fileStore = fs;
  }

  /**
   * v810 — Liefert die letzten Zeilen dev-server-stdout für einen Worktree-cwd.
   * Wird in den Fix-Prompt eingespeist wenn die App nicht antwortet (curl-Fail),
   * damit der Agent den echten Runtime-Crash sieht statt blind zu raten.
   * Gesetzt von alfred.ts (verdrahtet zu sandboxManager.getDevServerLog).
   */
  private devServerLogProvider?: (cwd: string, tail?: number) => Promise<string | null>;
  setDevServerLogProvider(fn: (cwd: string, tail?: number) => Promise<string | null>): void {
    this.devServerLogProvider = fn;
  }

  /**
   * v816 — Liefert eine ContainerExec-Funktion für eine Session (oder undefined
   * bei klassischem Run ohne Sandbox). Wird in validateBuild als 6. Param
   * verwendet, damit Test-Commands per `docker exec` IM Container laufen statt
   * auf dem Host. Behebt das musl/glibc-ABI-Problem das v813 zwang Tests aus
   * der per-Phase-Validierung rauszunehmen.
   * Gesetzt von alfred.ts (verdrahtet zu sandboxRepo + docker.runContainerCommand).
   */
  private containerExecLookup?: (sessionId: string) => Promise<((cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>) | undefined>;
  setContainerExecLookup(fn: (sessionId: string) => Promise<((cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>) | undefined>): void {
    this.containerExecLookup = fn;
  }

  /**
   * v825 — Lessons-Loop-Hook: wird gerufen wenn der Plan-Agent in awaiting_user landet
   * (nach maxFixAttempts) ODER eine Phase nach mehreren Fix-Versuchen schließlich passed.
   * Source unterscheidet: 'plan-awaiting-user' (high trust) vs 'plan-fix-loop-resolved' (lower).
   */
  private onLessonOpportunity?: (input: {
    sessionId: string;
    projectId?: string;
    cwd: string;
    source: 'plan-awaiting-user' | 'plan-fix-loop-resolved';
    buildOutput: string;
    diagnosis?: string;
    fixAttempts: number;
  }) => Promise<void>;
  setLessonOpportunityHook(fn: typeof this.onLessonOpportunity): void {
    this.onLessonOpportunity = fn;
  }

  constructor(
    private readonly agents: Map<string, CodeAgentDefinitionConfig>,
    private readonly llm: LLMProvider,
    private readonly sessionRepo: ProjectAgentSessionRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly forgeConfig?: ForgeConfig,
  ) {}

  /** Called when a session completes (success or failure). Set by alfred.ts for runbook capture. */
  setCompletionCallback(cb: ProjectAgentCompletionCallback): void {
    this.completionCallback = cb;
  }

  /** v643 — Set by alfred.ts: persist per-phase commits with project_id resolution. */
  private commitsRepo?: import('@alfred/storage').ProjectAgentCommitsRepository;
  private projectIdResolver?: (cwd: string) => Promise<string | undefined>;
  setCommitsRepository(repo: import('@alfred/storage').ProjectAgentCommitsRepository, resolver?: (cwd: string) => Promise<string | undefined>): void {
    this.commitsRepo = repo;
    this.projectIdResolver = resolver;
  }

  /** v648 — Set by alfred.ts: persist planned phases with status/timings. */
  private plansRepo?: import('@alfred/storage').ProjectAgentPlansRepository;
  setPlansRepository(repo: import('@alfred/storage').ProjectAgentPlansRepository): void {
    this.plansRepo = repo;
  }

  /** v851 — Set by alfred.ts: Feature-Library für Auto-Extractor nach Run-Done. */
  private featuresRepo?: import('@alfred/storage').ProjectFeaturesRepository;
  setFeaturesRepository(repo: import('@alfred/storage').ProjectFeaturesRepository): void {
    this.featuresRepo = repo;
  }
  /** v851 — Owner-Master-UserId für feature.userId beim Auto-Insert. */
  private ownerMasterUserId?: string;
  setOwnerMasterUserId(id: string | undefined): void { this.ownerMasterUserId = id; }
  /** v851.1 — EmbeddingService für semantic search + feature-embedding storage. */
  private embeddingService?: {
    embedAndStore(userId: string, content: string, sourceType: string, sourceId: string): Promise<string | undefined>;
    semanticSearch(userId: string, query: string, limit?: number): Promise<Array<{ category: string; key: string; value: string; score: number; }>>;
  };
  setEmbeddingService(s: typeof this.embeddingService): void { this.embeddingService = s; }

  /** v652 — Set by alfred.ts: Lessons-Learned-Store für Pattern-Memorierung. */
  private lessonsRepo?: import('@alfred/storage').ProjectAgentLessonsRepository;
  setLessonsRepository(repo: import('@alfred/storage').ProjectAgentLessonsRepository): void {
    this.lessonsRepo = repo;
  }

  /** v663a — Conventions-Lookup pro Projekt (cwd → Project mit conventions). */
  private projectConventionsResolver?: (cwd: string) => Promise<import('@alfred/storage').ProjectConventions | undefined>;
  setProjectConventionsResolver(resolver: (cwd: string) => Promise<import('@alfred/storage').ProjectConventions | undefined>): void {
    this.projectConventionsResolver = resolver;
  }

  /** v665a — Cluster-Lock-Hooks. Bei shared Projekten ist Lock zwingend, bei local optional. */
  private projectLockAcquire?: (cwd: string, sessionId: string) => Promise<{ acquired: boolean; reason?: string }>;
  private projectLockRelease?: (cwd: string, sessionId: string) => Promise<void>;
  setProjectLockHooks(
    acquire: (cwd: string, sessionId: string) => Promise<{ acquired: boolean; reason?: string }>,
    release: (cwd: string, sessionId: string) => Promise<void>,
  ): void {
    this.projectLockAcquire = acquire;
    this.projectLockRelease = release;
  }

  /** v652 — Set by alfred.ts: Callback der Auto-Resume triggert (project_agent.resume Action). */
  private autoResumeCallback?: (failedTaskId: string, notes?: string) => Promise<void>;
  setAutoResumeCallback(cb: (failedTaskId: string, notes?: string) => Promise<void>): void {
    this.autoResumeCallback = cb;
  }

  /** v866 — Set by alfred.ts: CLI-Usage-Recording (cli_agent_runs, getrennt von llm_usage). */
  private cliRunsRepo?: import('@alfred/storage').CliAgentRunsRepository;
  setCliRunsRepository(repo: import('@alfred/storage').CliAgentRunsRepository): void {
    this.cliRunsRepo = repo;
  }

  /** v867 — Set by alfred.ts: Deploy-Branch eines Projekts (projects.default_branch,
   *  Fallback conventions.branching.prTarget). Für Push-Guard + Start-Warnung. */
  private deployBranchResolver?: (cwd: string) => Promise<string | undefined>;
  setDeployBranchResolver(fn: (cwd: string) => Promise<string | undefined>): void {
    this.deployBranchResolver = fn;
  }

  /** v866 — Set by alfred.ts: Session-Start-Hook → projectManager.attachSession.
   *  Legt die project_sessions-Zeile beim START an (ended_at NULL) damit der
   *  "Laufend"-Zähler der Arbeitszeit-Statistik echte Live-Runs zeigt. Vorher
   *  wurde die Zeile erst bei finishSession erstellt → Laufend war immer 0. */
  private sessionStartCallback?: (info: { sessionId: string; goal: string; cwd: string; userId?: string; startedAt: string }) => Promise<void>;
  setSessionStartCallback(cb: typeof this.sessionStartCallback): void {
    this.sessionStartCallback = cb;
  }

  async run(sessionId: string, configInput: Record<string, unknown>, platform: string, chatId: string): Promise<void> {
    return currentSession.run({ sessionId }, () => this._runInner(sessionId, configInput, platform, chatId));
  }

  private async _runInner(sessionId: string, configInput: Record<string, unknown>, platform: string, chatId: string): Promise<void> {
    const config: ProjectAgentConfig = {
      goal: configInput.goal as string,
      cwd: configInput.cwd as string,
      agentName: configInput.agentName as string,
      buildCommands: configInput.buildCommands as string[],
      testCommands: configInput.testCommands as string[],
      maxDurationHours: (configInput.maxDurationHours as number) ?? 8,
      maxFixAttempts: (configInput.maxFixAttempts as number) ?? 3,
      buildTimeoutMs: (configInput.buildTimeoutMs as number) ?? 300_000,
      branchPerSession: configInput.branchPerSession === true,
      confirmPlan: configInput.confirmPlan === true,
      autoResume: configInput.autoResume === true,
      // v862 — Self-Healing-Flags (Funktions-Referenz wird direkt durchgereicht,
      // config geht nicht durch JSON)
      selfHeal: configInput.selfHeal === true,
      selfHealReleaseLock: configInput.selfHealReleaseLock as (() => void) | undefined,
      selfHealBaseBranch: configInput.selfHealBaseBranch as string | undefined,
    };

    const agentDef = this.agents.get(config.agentName);
    if (!agentDef) {
      this.logger.error({ sessionId, agent: config.agentName }, 'Project agent not found');
      await this.sendProgress(platform, chatId, `💥 Agent "${config.agentName}" nicht gefunden.`);
      return;
    }

    // Detect if agent runs as a different user (sudo -u <user>) — build commands must run as same user
    const runAsUser = (agentDef.command === 'sudo' && agentDef.argsTemplate[0] === '-u' && agentDef.argsTemplate[1])
      ? agentDef.argsTemplate[1]
      : undefined;

    // v816 — ContainerExec einmal pro Run auflösen. Wenn die Session in einer
    // Sandbox läuft, liefert lookup eine Funktion die test-Commands via
    // `docker exec` im Container ausführt (musl-ABI-konform). Klassische Runs
    // ohne Sandbox → undefined → validateBuild fällt auf Host zurück.
    const containerExec = this.containerExecLookup
      ? await this.containerExecLookup(sessionId).catch(() => undefined)
      : undefined;
    if (containerExec) {
      this.logger.info({ sessionId }, 'v816 container-exec available for per-phase tests');
    }

    // v665a — Cluster-Lock acquire (für shared Projekte zwingend, für local no-op wenn Hook
    // nicht gesetzt). Bei Konflikt: Abort vor Session-Aufbau.
    if (this.projectLockAcquire) {
      const lock = await this.projectLockAcquire(config.cwd, sessionId).catch(() => ({ acquired: true } as { acquired: boolean; reason?: string }));
      if (!lock.acquired) {
        await this.sendProgress(platform, chatId, `🔒 Projekt-Lock nicht erworben: ${lock.reason ?? 'andere Node hält den Lock'}. Bitte später erneut oder erst andere Session beenden.`);
        this.logger.warn({ sessionId, cwd: config.cwd, reason: lock.reason }, 'project-lock acquire failed');
        return;
      }
    }

    // Register abort controller for stop signals
    const abortController = new AbortController();
    registerAbortController(sessionId, abortController);

    // v866 — CLI-Usage-Tracking (getrennt von llm_usage: eigene Subscription/Key).
    // Summiert über alle executeAgent-Läufe der Session (Phasen + Fix-Versuche).
    const runStartedAtIso = new Date().toISOString();
    const cliUsage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0 };
    let cliModel: string | undefined;
    const accumulateCliUsage = (r: { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd?: number }; model?: string }): void => {
      if (r.model) cliModel = r.model;
      if (r.usage) {
        cliUsage.tokensIn += r.usage.inputTokens;
        cliUsage.tokensOut += r.usage.outputTokens;
        cliUsage.cacheRead += r.usage.cacheReadTokens;
        cliUsage.costUsd += r.usage.costUsd ?? 0;
      }
    };
    // Binary-Version best-effort (gecached, 1 Spawn pro Prozess-Lifetime)
    const cliAgentVersion = getAgentVersion(agentDef);

    // v866 — Session beim START an den Projekt-Container binden (project_sessions
    // mit ended_at NULL) → "Laufend"-Zähler + Live-Gesamtzeit in der Statistik.
    if (this.sessionStartCallback) {
      try {
        await this.sessionStartCallback({ sessionId, goal: config.goal, cwd: config.cwd, userId: config.userId, startedAt: runStartedAtIso });
      } catch (err) {
        this.logger.debug({ err, sessionId }, 'v866 sessionStartCallback failed (non-fatal)');
      }
    }

    // v867 — Branch-Mismatch-Warnung beim START (Vorfall alpbyte 11.06.: Workspace
    // stand seit einem Incident auf `main`, Projekt deployed von `master` — der
    // User sah es erst NACH dem Deploy). Kein Auto-Switch (History-Schutz), nur
    // sofortige Sichtbarkeit. Der harte Stopp sitzt im Push-Guard (pushToRemote).
    if (this.deployBranchResolver && existsSync(path.join(config.cwd, '.git'))) {
      try {
        const deployBranch = await this.deployBranchResolver(config.cwd);
        if (deployBranch) {
          const current = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], config.cwd, runAsUser).catch(() => undefined);
          if (current && current !== deployBranch && MAINLINE_BRANCHES.includes(current)) {
            await this.sendProgress(platform, chatId,
              `⚠️ **Branch-Achtung**: Workspace steht auf "${current}" — dieses Projekt deployed von "${deployBranch}". ` +
              `Der Agent arbeitet auf "${current}" und der finale Push wird verweigert werden. ` +
              `Falls das falsch ist: 'stop' senden und Branch wechseln (\`git checkout ${deployBranch}\`).`);
            this.logger.warn({ sessionId, current, deployBranch, cwd: config.cwd }, 'v867 workspace on wrong mainline branch');
          }
        }
      } catch (err) {
        this.logger.debug({ err, sessionId }, 'v867 start branch-check failed (non-fatal)');
      }
    }

    const state: ProjectAgentMeta = {
      projectPhase: 'planning',
      projectIteration: 0,
      projectGoal: config.goal,
      buildCommands: config.buildCommands,
      testCommands: config.testCommands,
      projectCwd: config.cwd,
      lastBuildOutput: '',
      injectedMessages: [],
      totalFilesChanged: 0,
      milestonesReached: [],
      consecutiveFixFailures: 0,
      agentName: config.agentName,
    };

    let lastBuildActuallyPassed = false;
    // v810 — Tracking ob completionCallback schon gefeuert wurde. Diverse return-Pfade
    // (abort, max-duration, pre-flight) verließen den Runner ohne completion + ohne
    // terminal-Phase → Session hing in DB auf 'fixing'/'coding' → UI zeigte ewig "läuft".
    // Der finally-Guard setzt garantiert terminal + feuert completion falls noch offen.
    let completionFired = false;
    // v652 — Lessons aus früheren Failed-Runs in derselben cwd. Wird einmal pro
    // Run geladen und in jeder Phase per assemblePrompt eingespeist.
    let lessonsHint: string[] = [];
    if (this.lessonsRepo) {
      try {
        const lessons = await this.lessonsRepo.listByCwd(config.cwd, 2, 5);
        lessonsHint = lessons.map(l => `[${l.occurrences}× erlebt] ${l.pattern} → ${l.advice}`);
      } catch (err) {
        this.logger.debug({ err }, 'lessons-load skipped');
      }
    }

    // v663a — Project-Conventions laden (README/CHANGELOG/Commits/Versioning).
    // Conventions sind opt-in; bei nicht gesetztem Resolver oder unbekanntem cwd → undefined.
    let projectConventions: import('@alfred/storage').ProjectConventions | undefined;
    if (this.projectConventionsResolver) {
      try {
        projectConventions = await this.projectConventionsResolver(config.cwd);
        if (projectConventions) {
          this.logger.info({ cwd: config.cwd, conventions: Object.keys(projectConventions) }, 'Project-Conventions geladen');
        }
        // Implizit: branching=feature-branches → branchPerSession=true
        if (projectConventions?.branching?.strategy === 'feature-branches' && !config.branchPerSession) {
          config.branchPerSession = true;
          this.logger.info({ cwd: config.cwd }, 'feature-branches Convention → branchPerSession aktiviert');
        }
      } catch (err) {
        this.logger.debug({ err }, 'conventions-load skipped');
      }
    }
    // L2 (v604) — global counter for consecutive phases that produced 0 files AND no
    // build pass. After 3 such phases in a row we abort instead of slogging through
    // all 13. Counter resets to 0 on any phase that produced files or passed build.
    let consecutiveCompletePhaseFailures = 0;
    const MAX_CONSECUTIVE_PHASE_FAILURES = 3;
    // L3 (v604) — track if ANY phase actually changed files. Used to compute the
    // honest success-flag at completion time. The old runner emitted success=true
    // unconditionally after the loop ended, even with 0 file changes.
    let anyPhaseProducedFiles = false;
    // v636 — runFailed Flag. Wird true bei harten Failures (Coding-Phase exitCode≠0,
    // fail-fast 3 empty phases, expliziter abort). Verhindert dass der Post-Loop-Code
    // den schon-auf-'failed'-gesetzten state durch overallSuccess wieder auf 'done'
    // zieht — denn lastBuildActuallyPassed ist sticky (einmal true von früherer Phase
    // → immer true). v630 hat diesen Fall übersehen.
    let runFailed = false;
    // v864 — Fakten des letzten harten Abbruchs für generateFailureInsight.
    // Vorher bekam der Insight-LLM nur Goal/Status/Build-Output (der grün sein
    // konnte!) und halluzinierte Root-Causes ("Komponente nicht gebaut") während
    // die echte Ursache ein API-529 war — diese falsche Analyse vergiftete dann
    // das Continuation-Goal des Resume-Runs (siehe 494ae636 → b67ed039).
    let lastHardFailure: { phase: number; exitCode: number; stderrTail: string; stdoutTail: string; transientApi: boolean } | undefined;

    try {
      await this.sendProgress(platform, chatId, `🚀 Project Agent gestartet: ${config.goal}`);

      // ── PLANNING ──
      state.projectPhase = 'planning';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);
      await this.sendProgress(platform, chatId, '📋 Erstelle Projekt-Plan...');

      const previousSessions = await this.sessionRepo.getCompletedByCwd(config.cwd).catch(() => []);

      // v846 — Recent commits (last 7d) so the planner sees what was already done.
      // Wichtig für Resume/Continue-Sessions: ohne diese Info hat der Planner
      // empirisch routinemäßig Phase 1-3 dupliziert. Wir holen max 30 commits.
      let recentChanges: Array<{ sha: string; message: string; files: string[] }> = [];
      if (existsSync(path.join(config.cwd, '.git'))) {
        try {
          const log = await gitExec(['log', '--since=7.days.ago', '--pretty=format:%H%x09%s', '--name-only', '--max-count=30'], config.cwd, runAsUser).catch(() => '');
          if (log) {
            // Parse: "SHA<TAB>Message\nFile1\nFile2\n\nSHA<TAB>Message\n..."
            const blocks = log.split(/\n\n+/).filter(Boolean);
            for (const block of blocks) {
              const lines = block.split('\n').filter(Boolean);
              if (lines.length === 0) continue;
              const header = lines[0].split('\t');
              if (header.length < 2) continue;
              const files = lines.slice(1).filter(l => !l.includes('\t')).slice(0, 20);
              recentChanges.push({ sha: header[0], message: header[1], files });
              if (recentChanges.length >= 30) break;
            }
          }
        } catch (err) {
          this.logger.debug({ err, cwd: config.cwd }, 'v846 git log for recent changes failed (non-fatal)');
        }
      }

      // v851.1 — Goal-Match-Phase: prüfe ob ähnliche Features in anderen
      // Projekten bereits implementiert wurden (cross-project knowledge).
      // Bei Match: User-Hinweis im Chat + Plan-Prompt-Enrichment.
      let goalMatchHints: string[] = [];
      if (this.featuresRepo && this.ownerMasterUserId) {
        try {
          const { findGoalMatches } = await import('./features/goal-matcher.js');
          const projectId = this.projectIdResolver ? await this.projectIdResolver(config.cwd).catch(() => undefined) : undefined;
          const matches = await findGoalMatches({
            goal: config.goal,
            userId: this.ownerMasterUserId,
            repo: this.featuresRepo,
            excludeProjectId: projectId,
            embeddingService: this.embeddingService,
          });
          if (matches.length > 0) {
            const lines = matches.map((m, i) => {
              return `  ${i + 1}. **${m.feature.name}** (Projekt: ${m.feature.projectId.slice(0, 8)}…, conf ${Math.round(m.matchScore * 100)}%, ${m.reason})\n     ${m.feature.description.slice(0, 120)}\n     Stack: ${m.feature.techStack.slice(0, 4).join(', ')}\n     Files: ${m.feature.sourceFiles.slice(0, 3).join(', ')}${m.feature.sourceFiles.length > 3 ? ` (+${m.feature.sourceFiles.length - 3} more)` : ''}`;
            }).join('\n\n');
            await this.sendProgress(platform, chatId,
              `🔗 **Cross-Project Match gefunden** — diese Features wurden bereits in anderen Projekten implementiert:\n\n${lines}\n\nDer Plan wird mit diesem Wissen erstellt. Falls du eines davon explizit übernehmen willst: nutze \`project_agent.import_feature\` Action mit feature-id.`);
            // Plan-Prompt-Enrichment: Hint an LLM dass es ähnliche Implementierungen gibt
            goalMatchHints = matches.map(m =>
              `Ähnliches Feature "${m.feature.name}" existiert bereits in Projekt ${m.feature.projectId.slice(0, 8)} (${m.feature.techStack.join(', ')}). Source: ${m.feature.sourceFiles.join(', ')}`
            );
          }
        } catch (err) {
          this.logger.debug({ err: (err as Error).message, sessionId }, 'v851.1 goal-match failed (non-critical)');
        }
      }

      const planGoal = goalMatchHints.length > 0
        ? `${config.goal}\n\n--- CROSS-PROJECT KNOWLEDGE ---\n${goalMatchHints.join('\n')}\n--- /KNOWLEDGE ---`
        : config.goal;
      const plan = await createProjectPlan(planGoal, this.llm, previousSessions, recentChanges);

      // v846 — Plan-Banner mit Klassifikation + reasoning + Größen-Bias-Hinweis
      const kindLabel = plan.goalKind && plan.goalKind !== 'unknown' ? plan.goalKind : 'undefiniert';
      const typical = typicalPhaseRange(plan.goalKind);
      const overSized = plan.phases.length > typical.max;
      const banner = [
        `📋 Plan erstellt: ${plan.phases.length} Phasen (Goal-Typ: ${kindLabel}, typisch ${typical.min}-${typical.max})`,
        overSized
          ? `⚠ Plan deutlich größer als typisch für ${kindLabel}. Begründung: ${plan.reasoning ?? '(keine angegeben)'}`
          : '',
        ...plan.phases.map((p, i) => `  ${i + 1}. ${p}`),
      ].filter(Boolean).join('\n');
      await this.sendProgress(platform, chatId, banner);
      if (overSized) {
        this.logger.warn({ sessionId, goalKind: plan.goalKind, phaseCount: plan.phases.length, typicalMax: typical.max },
          'Project agent: plan oversized vs goal-kind heuristic');
      }
      state.milestonesReached.push('Plan erstellt');
      await this.sessionRepo.addMilestone(sessionId, 'Plan erstellt');

      // v648 — Plan persistieren mit allen Phasen als 'planned'.
      if (this.plansRepo) {
        try {
          await this.plansRepo.bulkInsert(sessionId, plan.phases.map((p, i) => ({ phaseIdx: i + 1, description: p })));
        } catch (err) { this.logger.debug({ err, sessionId }, 'Plan-persist failed (non-fatal)'); }
      }

      // v650 — Plan-Review-Step (opt-in via confirmPlan=true)
      if (config.confirmPlan) {
        await this.sendProgress(platform, chatId,
          `📋 **Plan-Review** — antworte "ok" / "approve" um zu starten, "stop" um abzubrechen, oder schreib was dich am Plan stört (wird als Hint genutzt).`);
        const reviewTimeout = 30 * 60_000; // 30min review window
        const reviewStart = Date.now();
        let approved = false;
        while (Date.now() - reviewStart < reviewTimeout) {
          await new Promise(r => setTimeout(r, 5_000));
          const msgs = await drainInterjections(sessionId);
          if (msgs.includes('__STOP__')) {
            // v773 — Session als failed markieren damit UI nicht ewig "läuft" zeigt
            state.projectPhase = 'failed';
            await this.updateSession(sessionId, state, false);
            await this.sendProgress(platform, chatId, `⏹ Plan abgelehnt — Project Agent gestoppt.`);
            return;
          }
          const reply = msgs.find(m => m && m !== '__STOP__');
          if (!reply) continue;
          if (/^\s*(ok|approve|approved|go|los|start|ja)\s*$/i.test(reply)) {
            approved = true;
            await this.sendProgress(platform, chatId, `✅ Plan bestätigt — starte Phase 1.`);
            break;
          }
          // Non-approval reply → treat as feedback hint, abort and let user re-start
          await this.sendProgress(platform, chatId,
            `📝 Plan-Feedback notiert. Bitte starte neu mit angepasstem Goal:\n> "${reply.slice(0, 200)}"`);
          return;
        }
        if (!approved) {
          await this.sendProgress(platform, chatId, `⏰ Plan-Review-Timeout (30min) — Run abgebrochen.`);
          return;
        }
      }

      // v650 — Branch-pro-Session (opt-in)
      if (config.branchPerSession && existsSync(path.join(config.cwd, '.git'))) {
        try {
          const sessionShort = sessionId.slice(0, 8);
          const branchName = `feature/agent-${sessionShort}`;
          await gitExec(['checkout', '-b', branchName], config.cwd, runAsUser);
          await this.sendProgress(platform, chatId, `🌿 Branch \`${branchName}\` erstellt — alle Commits laufen jetzt hier rein.`);
        } catch (err) {
          this.logger.warn({ err, sessionId }, 'Branch-per-Session: checkout -b failed');
          await this.sendProgress(platform, chatId, `⚠️ Branch-Erstellung fehlgeschlagen — Commits gehen auf default branch.`);
        }
      }

      const startTime = Date.now();
      // v846 — Adaptive Caps. KEIN starres Limit mehr.
      //  - softCap     = max(2h, phases × 30min + 1h Buffer)
      //  - warn80      = Warnung wenn 80% softCap erreicht
      //  - warn100     = Warnung wenn softCap erreicht (kein Kill)
      //  - hardCap     = config.maxDurationHours (default 8h, kann user-überschrieben werden)
      //                  ODER min(24h, plan.phases.length × 60min + 1h) wenn config nicht gesetzt
      //  - emergency   = 24h absolutes Safety-Net gegen infinite Loops
      // Bei Plan-Mutation (extend) wird softCap dynamisch neu berechnet.
      const computeSoftCapMs = (): number =>
        Math.max(2 * 3600_000, plan.phases.length * 30 * 60_000 + 60 * 60_000);
      let softCapMs = computeSoftCapMs();
      const emergencyHardCapMs = 24 * 3600_000;
      const configuredHardCapMs = config.maxDurationHours * 3600_000;
      let warned80 = false;
      let warned100 = false;

      // ── L1 (v604) PRE-FLIGHT: cwd reachability check ─────────────────────
      // When the code-agent runs as a different user (e.g. sudo -u madh) we have
      // to verify that user can actually traverse into cwd. A common pitfall is
      // cwd=/root/xyz which is root-owned even after chown — /root itself has
      // drwx------ so non-root users get EACCES on every npm/build call.
      if (runAsUser) {
        try {
          if (!existsSync(config.cwd)) {
            mkdirSync(config.cwd, { recursive: true });
            try { execFileSync('chown', ['-R', `${runAsUser}:${runAsUser}`, config.cwd], { timeout: 5000 }); }
            catch { /* best effort */ }
          }
          const probe = await this.probeCwdReachable(config.cwd, runAsUser);
          if (!probe.ok) {
            const msg = `❌ Pre-Flight Check fehlgeschlagen: User "${runAsUser}" kann \`${config.cwd}\` nicht erreichen.\n\n` +
              `Detail: ${probe.reason}\n\n` +
              `Ursache: Code-Agent läuft als "${runAsUser}", aber der Pfad ist nicht traversierbar oder beschreibbar für diesen User. ` +
              `Häufiger Grund: cwd liegt unter /root/ (drwx------) — wähle einen Pfad unter /home/${runAsUser}/.`;
            await this.sendProgress(platform, chatId, msg);
            this.logger.error({ cwd: config.cwd, runAsUser, reason: probe.reason }, 'Project agent: cwd pre-flight failed');
            state.projectPhase = 'failed';
            await this.updateSession(sessionId, state, lastBuildActuallyPassed);
            if (this.completionCallback) {
              try {
                await this.completionCallback(sessionId,
                  { goal: config.goal, cwd: config.cwd },
                  { milestonesReached: state.milestonesReached, totalFilesChanged: 0, projectIteration: 0 },
                  false);
                completionFired = true;
              } catch { /* swallow */ }
            }
            return;
          }
        } catch (err) {
          this.logger.warn({ err }, 'Pre-Flight probe threw — continuing optimistically');
        }
      }

      // ── L8 (v604) STAGE ATTACHED ASSETS ─────────────────────────────────
      // If the goal references file-store keys (typical pattern when user
      // attached a file in chat), copy them into <cwd>/uploads/ so the agent
      // can actually read them. The goal text gets rewritten with concrete
      // relative paths replacing the opaque keys.
      if (this.fileStore) {
        try {
          // No requestingUserId — runner operates system-wide; access check is
          // implicit because only the configured owner triggers project-agent.
          const stage = await stageAssetsForProject(config.goal, config.cwd, this.fileStore);
          if (stage.staged.length > 0) {
            await this.sendProgress(platform, chatId,
              `📎 ${stage.staged.length} angehängte Datei(en) nach uploads/ kopiert: ${stage.staged.map(a => a.relativePath).join(', ')}`);
            config.goal = stage.rewrittenGoal; // agents now see usable paths
            // re-chown so agent-user can read the staged files
            if (runAsUser) {
              try { execFileSync('chown', ['-R', `${runAsUser}:${runAsUser}`, path.join(config.cwd, 'uploads')], { timeout: 5000 }); }
              catch { /* best effort */ }
            }
          }
          if (stage.errors.length > 0) {
            this.logger.warn({ errors: stage.errors }, 'Asset-bridge: some files failed to stage');
          }
        } catch (err) {
          this.logger.debug({ err }, 'Asset-bridge: non-critical failure');
        }
      }

      // ── ENSURE GIT REPO EXISTS (before any phase commits) ──
      if (!existsSync(path.join(config.cwd, '.git'))) {
        try {
          if (!existsSync(config.cwd)) {
            mkdirSync(config.cwd, { recursive: true });
          }
          await gitExec(['init'], config.cwd, runAsUser);
          this.logger.info({ cwd: config.cwd }, 'Project agent: git repo initialized');
        } catch (err) {
          this.logger.warn({ err, cwd: config.cwd }, 'Project agent: git init failed (commits will be skipped)');
        }
      }

      // v846 — Per-phase tracking für PlanAssessor + File-Thrash-Warner.
      //  completedPhases  → wird in den Assessor gefüttert
      //  fileModCount     → Counter pro Datei für Thrash-Warning
      const completedPhases: Array<{ index: number; description: string; modifiedFiles: string[]; resultSummary?: string }> = [];
      const fileModCount = new Map<string, number>();

      // ── MAIN LOOP ──
      // v846 — plan.phases ist jetzt MUTABLE: PlanAssessor (Mid-Run-Mutation)
      // kann Phasen skippen/mergen/extenden/replacen. Wir laufen weiter so lange
      // bis phaseIdx == plan.phases.length erreicht ist; mutations passieren
      // VOR dem next-iteration-tick.
      for (let phaseIdx = 0; phaseIdx < plan.phases.length; phaseIdx++) {
        // Check abort signal
        if (abortController.signal.aborted) {
          await this.sendProgress(platform, chatId, `⏹ Project Agent abgebrochen.`);
          return;
        }

        // v846 — Adaptive duration check (kein starres Limit).
        const elapsed = Date.now() - startTime;
        // Hard emergency safety-net — schützt vor infinite Loops
        if (elapsed > emergencyHardCapMs) {
          await this.sendProgress(platform, chatId, `🛑 Notfall-Limit (24h) erreicht — Session sicherheitshalber gestoppt. Falls legitim: neu starten.`);
          this.logger.error({ sessionId, elapsedHours: (elapsed / 3600_000).toFixed(1) },
            'Project agent: emergency hard cap hit (>24h)');
          return;
        }
        // User-konfigurierter hard cap (default 8h). User kann maxDurationHours
        // hochsetzen (z.B. 48h) wenn lange legitime sessions erwartet werden.
        if (elapsed > configuredHardCapMs) {
          await this.sendProgress(platform, chatId, `⏰ Konfiguriertes Max-Dauer-Limit (${config.maxDurationHours}h) erreicht. Falls die Session legitim länger laufen soll: maxDurationHours in der Config hochsetzen. Session wird gestoppt.`);
          return;
        }
        // Soft-Cap-Warnungen (kein Kill)
        if (!warned100 && elapsed > softCapMs) {
          warned100 = true;
          const hrs = (softCapMs / 3600_000).toFixed(1);
          await this.sendProgress(platform, chatId, `⚠ Session läuft über Plan-Budget hinaus (${hrs}h für ${plan.phases.length} Phasen vorgesehen). Falls noch sinnvoll: läuft weiter. Falls nicht: 'stop' senden.`);
        } else if (!warned80 && elapsed > softCapMs * 0.8) {
          warned80 = true;
          const hrs = (softCapMs / 3600_000).toFixed(1);
          await this.sendProgress(platform, chatId, `ℹ 80 % des Plan-Zeitbudgets (${hrs}h) erreicht.`);
        }
        // softCap kann durch Plan-Mutation (extend) gewachsen sein — recalc
        const newSoftCap = computeSoftCapMs();
        if (newSoftCap !== softCapMs) {
          softCapMs = newSoftCap;
          warned80 = warned80 && elapsed > softCapMs * 0.8;
          warned100 = warned100 && elapsed > softCapMs;
        }

        state.projectIteration = phaseIdx + 1;
        state.projectPhase = 'coding';
        state.consecutiveFixFailures = 0;
        // v864 — KEIN Reset von lastBuildActuallyPassed mehr pro Phase (war seit
        // v0.15.2 drin und machte die v636-"sticky"-Kommentare unwahr). Folge des
        // Resets: Coding-Failure VOR der Validierung (z.B. API-529 in Phase 4 von
        // 494ae636) → DB last_build_passed=0 → Resume-Goal behauptete "Build-Status:
        // zuletzt rot" obwohl der letzte echte Build 5485 grüne Tests hatte → der
        // Continuation-Planner plante eine "Buildfehler beheben"-Phase für Fehler
        // die nie existierten. Jetzt: Flag spiegelt den letzten TATSÄCHLICHEN
        // validateBuild-Ausgang (true bei pass Z.~905, false bei fail unten im
        // Fix-Loop). Für overallSuccess ist das safe: harte Abbrüche setzen
        // weiterhin runFailed=true (v636-Guard).
        const filesBeforePhase = state.totalFilesChanged;
        await this.updateSession(sessionId, state, lastBuildActuallyPassed);

        const phase = plan.phases[phaseIdx];

        // Drain interjections before each coding step (per-iteration, not per-phase)
        const messages = await drainInterjections(sessionId);
        if (messages.includes('__STOP__')) {
          // v650 — abortController.abort() killt auch laufende Sub-Process-Tree
          abortController.abort();
          // v773 — Session als failed markieren damit UI nicht ewig "läuft" zeigt
          state.projectPhase = 'failed';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
          await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt vor Phase ${phaseIdx + 1}/${plan.phases.length}.`);
          return;
        }
        const userMessages = messages.filter(m => m !== '__STOP__');

        const prompt = this.assemblePrompt(config.goal, phase, state, userMessages, lessonsHint, projectConventions);
        await this.sendProgress(platform, chatId, `🔨 Phase ${phaseIdx + 1}/${plan.phases.length}: ${phase}`);

        // v648 — Phase als running markieren
        if (this.plansRepo) {
          try { await this.plansRepo.markRunning(sessionId, phaseIdx + 1); } catch { /* skip */ }
        }

        // v624 D — Phase-Type-aware Inactivity-Timeout. Die meisten Phasen (Inspect,
        // Edit, kleine Patches) laufen <2min und sollen schnell fail-detected werden
        // wenn der Agent hängt. Validierungs-Phasen mit npm install/build/test/lint
        // brauchen aber 5-10min Sub-Process-Time während der Agent kein eigenes
        // stdout produziert (er wartet auf npm). Erkennung über Phase-Text-Keywords.
        // v624 D — Long-phase keywords (deutsch + englisch). v635 erweitert um
        // Datenmodell/Migration/Schema/Refactor/Gallery-Schema — diese Phasen
        // schreiben oft viele Dateien in stiller Folge (LLM-Thinking → File-Write
        // → kein stdout), wurden vorher mit 10min-Default fälschlich gekillt.
        // v844 — Audit/Recherche/Identify-Phasen brauchen ebenfalls 20min. Vorher
        // wurden Phase 1 "Projektstruktur identifizieren" oder "Repo-Audit"
        // routinemäßig als Normal-Phase (10min) klassifiziert und nach 600s
        // stdout-Stille gekillt obwohl claude noch fleißig Read/Glob/Grep machte.
        // Empirisch: in 14 Tagen 30 fails — 18 davon auf alpbyte-games, viele in
        // Phase 1/2/4 mit `last-activity=initial` (siehe v844-Analyse).
        const longPhasePattern = /\bnpm\s+(install|run\s+build|run\s+lint|run\s+typecheck|test|run\s+test|ci)\b|\bvalidier|\bvalidation\b|\bvalidate\b|\bbuild-?fehler\b|\breproduzieren\b|\bdatenmodell\b|\bdata\s*model\b|\bdatamodel\b|\bmigration(?:en|s)?\b|\bschema\b|\brefactor(?:ing)?\b|\bumbau\b|\btypsystem\b|\btype\s*system\b|\baudit\b|\brecherche\b|\banalyse\b|\banalysis\b|\binventar\b|\binventory\b|\bscan(?:nen|ning)?\b|\bpr(?:ü|ue)fung\b|\breview\b|\bexploration\b|\bprojektstruktur\b|\brepo-?stand\b|\bidentifizier\b|\blokalisier\b|\bisolier\b|\bauflisten\b|\bcleanup\b|\bbereinigen\b|\bgallery-?schema\b/i;
        const isLongPhase = longPhasePattern.test(phase);
        // v625 — Normal-Phase auf 10min angehoben (war 5min); Long-Phase bleibt 20min.
        const phaseTimeout = isLongPhase ? 20 * 60_000 : 10 * 60_000;
        if (isLongPhase) {
          this.logger.info({ sessionId, phase: phaseIdx + 1, timeoutMs: phaseTimeout },
            'Project agent: long-phase detected, extended inactivity timeout');
        }

        // ── CODING ──
        this.logger.info({ sessionId, phase: phaseIdx + 1, description: phase }, 'Project agent: coding phase');
        // v864 — Coding-Lauf mit Transient-API-Retry. Vorfall 494ae636: Anthropic
        // 529 Overloaded in Phase 4 → CLI gab nach internen Retries auf (exitCode 1)
        // → Runner wertete das als harten Crash und warf 3 grüne Phasen weg.
        const codeResult = await this.executeAgentWithApiRetry(agentDef, prompt, {
          cwd: config.cwd,
          timeoutMs: phaseTimeout,
          signal: abortController.signal,
          taskId: sessionId,
          onProgress: (status) => {
            this.sendProgressThrottled(platform, chatId, `  [${config.agentName}] ${status}`);
          },
        }, platform, chatId, `Phase ${phaseIdx + 1}`);
        accumulateCliUsage(codeResult); // v866 — Tokens/Modell der Phase einsammeln

        state.totalFilesChanged += codeResult.modifiedFiles.length;

        // v618 B1 — coding-agent ExitCode prüfen BEVOR Build-Validate startet.
        // Vorher: codeResult.exitCode wurde ignoriert. Folge: wenn der Agent
        // wegen Auth-Fehler (codex 401), fehlender Binary oder Timeout abbrach
        // und 0 Files änderte, lief der Build trotzdem (existing Code baut)
        // und der Runner committete leer per --allow-empty. → Fake-Success.
        // Jetzt: bei exitCode != 0 wird die Phase als Failure behandelt und der
        // Lauf abgebrochen. Logs/stderr werden dem User mit Diagnose-Hinweis
        // (Auth-Fehler, Binary-Fehler, Timeout) zurückgemeldet.
        if (codeResult.exitCode !== 0) {
          // v619 D2 — Pattern-Match nur auf die letzten 2000 Zeichen vom stderr.
          // Vorher wurde der GESAMTE stderr (oft 100k+ Zeichen mit Code-Diffs)
          // durchsucht und matchte zufällig auf "auth"/"Unauthorized" im
          // Code-Inhalt — produzierte false-positive "Auth-Fehler"-Diagnosen
          // selbst bei reinem Timeout (siehe v618 alpbyte-games Phase 2).
          const stderr = codeResult.stderr ?? '';
          const stderrTail = stderr.slice(-2000);
          let hint = '';
          // v619 D1 — exitCode-spezifische Hints ZUERST. exitCode ist ein harter
          // Fakt aus agent-executor, stderr-Pattern ist nur Indiz. Inactivity-
          // vs absolute-timeout wird über die explizite annotation am stderr-Ende
          // unterschieden (siehe agent-executor v619 D0).
          if (codeResult.exitCode === 124) {
            const secs = Math.round((codeResult.durationMs ?? 0) / 1000);
            if (/absolute cap reached/i.test(stderrTail)) {
              hint = `\n\n⏱ **Diagnose: Absolute Laufzeit-Grenze erreicht.** Der Agent lief ${secs}s und produzierte kontinuierlich Output, aber überschritt die absolute Sicherheits-Grenze (60min). Phase ist zu groß — bitte in kleinere Schritte zerlegen.`;
            } else if (/inactivity timeout/i.test(stderrTail)) {
              hint = `\n\n⏱ **Diagnose: Inactivity-Timeout.** Der Agent produzierte ${secs}s lang keinen Output mehr und wurde abgebrochen. Wahrscheinlich: hung HTTP-Request, eingefrorenes Tool oder Auth-Wait. Logs prüfen.`;
            } else {
              hint = `\n\n⏱ **Diagnose: Timeout (Legacy-Pfad).** Der Agent wurde nach ${secs}s abgebrochen. Sollte mit v619 nicht mehr vorkommen — falls doch, agent-executor.ts Logs checken.`;
            }
          } else if (/401|Unauthorized|Missing bearer|auth\.json|not authenticated/i.test(stderrTail)) {
            hint = `\n\n🔑 **Diagnose: Auth-Fehler.** Der Code-Agent "${config.agentName}" konnte sich nicht beim LLM-Provider anmelden. Login als Runtime-User (sudo -u ${runAsUser ?? 'madh'} ${config.agentName} login) durchführen oder API-Key in der agent-Config setzen.`;
          } else if (/command not found|ENOENT|not found in PATH/i.test(stderrTail)) {
            hint = `\n\n🔍 **Diagnose: Binary fehlt.** Der Befehl "${agentDef.command}" ist im PATH von User "${runAsUser ?? 'process-owner'}" nicht erreichbar. Installation prüfen oder Pfad in der agent-Config absolut angeben.`;
          } else if (isTransientApiFailure(codeResult)) {
            // v864 — nach 2 erfolglosen Retries (executeAgentWithApiRetry) landen
            // wir hier: ehrlich sagen dass es die API war, nicht der Code.
            hint = `\n\n🌐 **Diagnose: LLM-API-Fehler (Overload/Rate-Limit/Netz).** Der Provider war trotz 2 Retries (90s/180s Wartezeit) nicht erreichbar. Die bisherige Arbeit ist committed — Session später per Resume fortsetzen, der Code ist NICHT das Problem.`;
          }
          await this.sendProgress(platform, chatId,
            `❌ Phase ${phaseIdx + 1}/${plan.phases.length} fehlgeschlagen — Coding-Agent exitCode=${codeResult.exitCode}.\n\n` +
            `**Phase**: ${phase.slice(0, 200)}\n\n` +
            `**stderr (letzte 400 Zeichen)**:\n\`\`\`\n${stderr.slice(-400) || '(leer)'}\n\`\`\`` +
            hint,
          );
          this.logger.error({
            sessionId, phase: phaseIdx + 1, agentName: config.agentName,
            exitCode: codeResult.exitCode, stderrTail: stderr.slice(-400),
            transientApi: isTransientApiFailure(codeResult),
          }, 'Project agent: coding phase exited non-zero — aborting');
          // v864 — Fakten für den Failure-Insight festhalten (statt LLM-Spekulation)
          lastHardFailure = {
            phase: phaseIdx + 1,
            exitCode: codeResult.exitCode,
            stderrTail: stderr.slice(-400),
            stdoutTail: (codeResult.stdout ?? '').trim().slice(-600),
            transientApi: isTransientApiFailure(codeResult),
          };
          // v620 — 'failed' ist jetzt im Type erlaubt (vorher Workaround mit 'done').
          // Die UI zeigt 'failed' rot mit 🔴-Build-Icon. Die Post-Loop-Logik
          // (anyPhaseProducedFiles + lastBuildActuallyPassed) ist unabhängig
          // davon — sendet sowieso ❌-Final-Message bei Failure.
          // v636 — runFailed Flag setzen, damit der Post-Loop-Code NICHT mit
          // sticky lastBuildActuallyPassed=true (von früherer Phase) auf 'done'
          // zurückspringt. v630-Fix war richtig im Konzept aber lastBuildActuallyPassed
          // wird nie auf false zurückgesetzt sobald eine Phase mal grün baute.
          runFailed = true;
          state.projectPhase = 'failed';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
          if (this.plansRepo) { try { await this.plansRepo.markFailed(sessionId, phaseIdx + 1); } catch { /* skip */ } }
          break; // exit the for-loop over phases; finally-block handles cleanup
        }

        // ── VALIDATE + FIX LOOP ──
        let buildPassed = false;
        for (let fixAttempt = 0; fixAttempt <= config.maxFixAttempts; fixAttempt++) {
          if (abortController.signal.aborted) break;

          state.projectPhase = 'validating';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);

          if (config.buildCommands.length === 0 && config.testCommands.length === 0) {
            buildPassed = true;
            break;
          }

          const buildResult = await validateBuild(
            config.cwd, config.buildCommands, config.testCommands, config.buildTimeoutMs, runAsUser, containerExec,
          );
          state.lastBuildOutput = buildResult.combinedOutput;

          if (buildResult.passed) {
            buildPassed = true;
            lastBuildActuallyPassed = true;
            await this.sendProgress(platform, chatId,
              `✅ Build passed (Phase ${phaseIdx + 1}). ${codeResult.modifiedFiles.length} Dateien geändert.`);
            // v825 — Lessons-Loop: wenn der Build NACH Fix-Versuchen passed (also fixAttempt > 0),
            // ist möglicherweise eine Lesson dabei. Lower-trust als awaiting_user (transient mocks,
            // flaky tests), aber wert anzubieten. Hook entscheidet wie aggressiv gelernt wird.
            if (this.onLessonOpportunity && fixAttempt > 0 && state.lastBuildOutput) {
              this.onLessonOpportunity({
                sessionId,
                cwd: config.cwd,
                source: 'plan-fix-loop-resolved',
                buildOutput: state.lastBuildOutput,
                fixAttempts: fixAttempt,
              }).catch(err => this.logger.debug({ err, sessionId }, 'v825 onLessonOpportunity (fix-resolved) failed (non-fatal)'));
            }
            break;
          }

          // Build failed
          // v864 — echter roter Build überschreibt den letzten Build-Status
          // (vorher per-Phase-Reset; siehe Kommentar am Phasen-Anfang).
          lastBuildActuallyPassed = false;
          state.consecutiveFixFailures++;
          if (fixAttempt >= config.maxFixAttempts) {
            // L5 (v604) — intelligent error extraction instead of blind .slice(-500)
            const extracted = extractBuildError(buildResult.combinedOutput);
            await this.sendProgress(platform, chatId,
              `❌ Build failed nach ${config.maxFixAttempts} Fix-Versuchen.\n\n` +
              `${extracted.recognized ? '**Diagnose:**\n' + extracted.summary + '\n\n' : ''}` +
              `**Kontext:**\n\`\`\`\n${extracted.contextSnippet}\n\`\`\`\n` +
              `Sende "interject" mit Hinweisen oder "stop" zum Abbrechen.`);
            state.projectPhase = 'awaiting_user';
            await this.updateSession(sessionId, state, lastBuildActuallyPassed);
            // v825 — Lessons-Loop: awaiting_user nach maxFixAttempts ist ein zuverlässiger
            // Lesson-Trigger (das Problem ist strukturell, nicht transient).
            if (this.onLessonOpportunity) {
              this.onLessonOpportunity({
                sessionId,
                cwd: config.cwd,
                source: 'plan-awaiting-user',
                buildOutput: buildResult.combinedOutput,
                diagnosis: extracted.recognized ? extracted.summary : undefined,
                fixAttempts: config.maxFixAttempts,
              }).catch(err => this.logger.debug({ err, sessionId }, 'v825 onLessonOpportunity (awaiting_user) failed (non-fatal)'));
            }
            break;
          }

          // ── FIXING ──
          state.projectPhase = 'fixing';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);

          // Drain interjections before fix step
          const fixMessages = await drainInterjections(sessionId);
          if (fixMessages.includes('__STOP__')) {
            abortController.abort();
            // v773 — Session als failed markieren damit UI nicht ewig "läuft" zeigt
            state.projectPhase = 'failed';
            await this.updateSession(sessionId, state, lastBuildActuallyPassed);
            await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt während Fix-Versuch.`);
            return;
          }
          const fixUserMessages = fixMessages.filter(m => m !== '__STOP__');

          await this.sendProgress(platform, chatId,
            `🔧 Fix-Versuch ${fixAttempt + 1}/${config.maxFixAttempts}...`);

          // v810 — Wenn die App nicht antwortet (curl-Health-Check fehlgeschlagen),
          // den dev-server-stdout holen damit der Agent den echten Runtime-Crash
          // (Stacktrace, ReferenceError, Render-Loop, …) sieht statt nur "build failed".
          // Vorher: curl-Fail → Agent rät blind → fixt Lint-Debt statt des Crashes.
          let devServerCrashLog = '';
          if (this.devServerLogProvider && /\bcurl\b/.test(buildResult.combinedOutput)) {
            try {
              const log = await this.devServerLogProvider(config.cwd, 120);
              if (log && log.trim()) {
                devServerCrashLog = `\n\n--- dev-server Log (letzte Zeilen, App antwortete nicht) ---\n${log.slice(-4000)}\n--- Ende dev-server Log ---\nFokus: Wenn hier ein Runtime-Fehler/Crash steht, behebe DIESEN — nicht Lint-Warnungen.`;
              }
            } catch (err) {
              this.logger.debug({ err, sessionId }, 'v810 devServerLogProvider failed (non-fatal)');
            }
          }

          // v854 — Test-Runner-Mismatch erkennen und den Agent darauf hinweisen.
          // Wenn der Build-Output typische "unknown CLI flag"-Fehler eines Test-
          // Runners zeigt (Vitest bekam --runInBand, Jest bekam --no-threads etc.),
          // ist die Ursache eine vom Caller extern übergebene testCommand-Liste die
          // der Agent NICHT verändern kann. Statt blind weiter zu reparieren soll
          // er das dem User mitteilen oder ohne diese Flags weiterfahren.
          let testRunnerMismatchHint = '';
          try {
            const { looksLikeTestRunnerFlagMismatch } = await import('@alfred/skills');
            if (looksLikeTestRunnerFlagMismatch(buildResult.combinedOutput)) {
              testRunnerMismatchHint =
                `\n\n--- v854 Test-Runner-Hinweis ---\n` +
                `Der Test-Command wurde extern als Parameter übergeben und ist Session-konstant. ` +
                `Wenn das hier eine Test-Runner-Inkompatibilität ist (Vitest-Projekt erhält Jest-Flag oder umgekehrt), ` +
                `kannst DU den Test-Command NICHT für die nächste Phase ändern. Optionen:\n` +
                `  1. Test überspringen und im phase-summary klar erwähnen dass externer testCommand falsch konfiguriert ist\n` +
                `  2. NICHT package.json scripts.test umschreiben — der Konflikt liegt in der CLI-Argument-Liste, nicht im script\n` +
                `  3. Wenn möglich: nur die korrekten Tests in src/ ändern, Build sollte sonst durchlaufen\n` +
                `--- /Hinweis ---`;
            }
          } catch { /* import-Fehler darf den Fix-Prompt nicht blockieren */ }

          const fixPrompt = `Der Build ist fehlgeschlagen. Hier ist der Output:\n\n${buildResult.combinedOutput}${devServerCrashLog}${testRunnerMismatchHint}\n\nBitte behebe die Fehler. Das Ziel war: ${phase}${fixUserMessages.length > 0 ? '\n\nUser-Hinweise:\n' + fixUserMessages.map(m => `- ${m}`).join('\n') : ''}`;
          // v864 — auch Fix-Läufe nicht an transienten API-Fehlern sterben lassen
          // (ein 529 hätte sonst einen Fix-Versuch verbrannt → maxFixAttempts →
          // awaiting_user mit irreführender Build-Diagnose).
          const fixResult = await this.executeAgentWithApiRetry(agentDef, fixPrompt, {
            cwd: config.cwd,
            // v624 D — Fix-Läufe rufen oft `npm run build` zum Reparieren auf → langer Timeout
            timeoutMs: 20 * 60_000,
            signal: abortController.signal,
            taskId: sessionId,
            onProgress: (status) => {
              this.sendProgressThrottled(platform, chatId, `  [fix] ${status}`);
            },
          }, platform, chatId, `Fix-Versuch ${fixAttempt + 1}`);
          accumulateCliUsage(fixResult); // v866 — auch Fix-Läufe zählen zur Usage
          // v618 B1 — auch der Fix-Lauf darf nicht still durchrutschen wenn der
          // Agent crashte. Bei exitCode != 0: Fix-Loop verlassen, Build wird im
          // nächsten Iteration-Check als gescheitert behandelt und nach maxFixAttempts
          // bricht der Loop sauber ab.
          if (fixResult.exitCode !== 0) {
            this.logger.warn({
              sessionId, phase: phaseIdx + 1, fixAttempt,
              exitCode: fixResult.exitCode, stderrTail: (fixResult.stderr ?? '').slice(-200),
            }, 'Project agent: fix attempt exited non-zero');
            await this.sendProgress(platform, chatId,
              `⚠️ Fix-Versuch ${fixAttempt + 1} fehlgeschlagen (agent exitCode=${fixResult.exitCode}). Build wird erneut probiert oder Phase wird nach Max-Attempts abgebrochen.`);
            // continue to next iteration; buildPassed stays false, loop will hit maxFixAttempts and break
          }
          state.totalFilesChanged += fixResult.modifiedFiles.length;
        }

        // ── COMMITTING (async, no event loop blocking) ──
        if (buildPassed) {
          state.projectPhase = 'committing';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);

          try {
            // v650 — Secret-Scan auf Diff vor Commit. Blockt nur bei harten Treffern.
            const secretIssues = await scanDiffForSecrets(config.cwd, runAsUser).catch(() => [] as string[]);
            if (secretIssues.length > 0) {
              await this.sendProgress(platform, chatId,
                `🚨 **Secret-Scan**: ${secretIssues.length} potenzielle Secrets im Diff gefunden — Commit ABGEBROCHEN.\n${secretIssues.slice(0, 5).map(s => `  - ${s}`).join('\n')}\n\nBitte manuell prüfen und ggf. \`git checkout -- <file>\` oder \`.gitignore\` setzen.`);
              this.logger.error({ sessionId, phase: phaseIdx + 1, issueCount: secretIssues.length }, 'Secret-scan blocked commit');
              runFailed = true;
              state.projectPhase = 'failed';
              await this.updateSession(sessionId, state, lastBuildActuallyPassed);
              if (this.plansRepo) { try { await this.plansRepo.markFailed(sessionId, phaseIdx + 1); } catch { /* skip */ } }
              break;
            }
            await gitExec(['add', '-A'], config.cwd, runAsUser);
            // v663a — Conventional Commits: Präfix anhand Heuristik
            // v846 — Subject (max 72 Zeichen) + body separat. Vorher wurden 40+ Wörter
            // Phasen-Beschreibungen direkt als Subject genutzt → `git log --oneline` unbrauchbar.
            const subject = buildCommitSubject(phase, phaseIdx + 1, projectConventions?.commits?.convention);
            const body = phase.length > subject.length - 10 ? phase : '';
            const commitMsg = body ? `${subject}\n\n${body}` : subject;
            const stdout = await gitExec(['commit', '-m', commitMsg, '--allow-empty'], config.cwd, runAsUser);
            const shaMatch = stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/);
            state.lastCommitSha = shaMatch?.[1];
            if (state.lastCommitSha) {
              await this.sendProgress(platform, chatId, `📦 Commit: ${state.lastCommitSha} — ${phase}`);
              // v643 — Per-Phase Commit-Eintrag persistieren
              if (this.commitsRepo) {
                try {
                  let branch: string | undefined;
                  try { branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], config.cwd, runAsUser); } catch { /* skip */ }
                  const projectId = this.projectIdResolver ? await this.projectIdResolver(config.cwd).catch(() => undefined) : undefined;
                  await this.commitsRepo.record({
                    sessionId,
                    projectId,
                    sha: state.lastCommitSha,
                    message: commitMsg,
                    phaseIdx: phaseIdx + 1,
                    phaseDescription: phase.slice(0, 500),
                    filesChanged: codeResult.modifiedFiles.length,
                    branch,
                  });
                } catch (err) { this.logger.debug({ err, sessionId }, 'Project agent: commit-record failed (non-fatal)'); }
              }
            }
          } catch (err) {
            this.logger.warn({ err, sessionId }, 'Project agent: git commit failed');
          }

          const milestone = `Phase ${phaseIdx + 1}: ${phase}`;
          state.milestonesReached.push(milestone);
          await this.sessionRepo.addMilestone(sessionId, milestone);
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
          // v648 — Phase als done markieren
          if (this.plansRepo) { try { await this.plansRepo.markDone(sessionId, phaseIdx + 1); } catch { /* skip */ } }
        }

        // v846 — Phase abgeschlossen: record completion + thrash-check.
        // codeResult.modifiedFiles enthält die Files die der Agent in DIESER
        // Phase angefasst hat. Fix-Iterations und Test-Runs sind NICHT hier
        // enthalten (würden zu sehr aufblähen).
        completedPhases.push({
          index: phaseIdx,
          description: phase,
          modifiedFiles: codeResult.modifiedFiles,
          // v864 — Abschluss-Text des Agents (Ende) für den PlanAssessor. Beim
          // stream-json-Format ist stdout der extrahierte finale Assistant-Text.
          // Ohne das konnte der Assessor ein Audit-Fazit wie "Feature war bereits
          // fertig, keine offenen Arbeiten" nie sehen und skippte nichts (b67ed039).
          resultSummary: (codeResult.stdout ?? '').trim().slice(-500),
        });
        // File-Thrash-Counter (E)
        for (const f of codeResult.modifiedFiles) {
          fileModCount.set(f, (fileModCount.get(f) ?? 0) + 1);
        }
        // Thrash-Warning nach 3+ Modifikationen derselben Datei
        const thrashed = Array.from(fileModCount.entries()).filter(([, c]) => c >= 3);
        if (thrashed.length > 0 && phaseIdx % 2 === 0) {
          // Nur jede 2. Phase warnen damit der Chat nicht spammt
          const list = thrashed.slice(0, 3).map(([f, c]) => `${f}: ${c}x`).join(', ');
          await this.sendProgress(platform, chatId,
            `⚠ File-Thrash erkannt — dieselbe(n) Datei(en) in mehreren Phasen geändert: ${list}. Eventuell überschreibt sich der Plan selbst.`);
        }

        // v846 — Mid-Run Plan-Assessor (B'/B''/H).
        // Nur bei buildPassed=true; bei failed Phasen ist die State unklar.
        // Bei Plan mit <=1 verbleibender Phase überspringen (nichts zu mutieren).
        if (buildPassed) {
          const remaining = plan.phases.slice(phaseIdx + 1);
          if (remaining.length > 0) {
            try {
              const mutation = await assessPlanProgress(this.llm, {
                goal: config.goal,
                completedPhases,
                remainingPhases: remaining,
                buildPassed: true,
                buildOutput: undefined,
              });
              const isDone = mutation.kind === 'done';
              if (mutation.kind !== 'proceed') {
                await this.applyPlanMutation(plan, phaseIdx, mutation, platform, chatId, sessionId);
              }
              if (isDone) {
                // Goal erfüllt — schleife sofort verlassen
                this.logger.info({
                  sessionId, completedAfterPhase: phaseIdx + 1,
                  reasoning: mutation.kind === 'done' ? mutation.reasoning : undefined,
                }, 'Project agent: assessor declared goal done, ending loop early');
                break;
              }
            } catch (err) {
              this.logger.warn({ err, sessionId, phaseIdx }, 'Project agent: assessor failed, proceeding as planned');
            }
          }
        }

        // L2 (v604) — track per-phase success for fail-fast
        const phaseFilesDelta = state.totalFilesChanged - filesBeforePhase;
        if (buildPassed) {
          consecutiveCompletePhaseFailures = 0;
          anyPhaseProducedFiles = true;
        } else if (phaseFilesDelta === 0) {
          // No build pass AND no file changes from this phase → it contributed nothing
          consecutiveCompletePhaseFailures++;
          if (consecutiveCompletePhaseFailures >= MAX_CONSECUTIVE_PHASE_FAILURES) {
            const extracted = extractBuildError(state.lastBuildOutput ?? '');
            await this.sendProgress(platform, chatId,
              `⚠️ Abbruch: ${MAX_CONSECUTIVE_PHASE_FAILURES} Phasen in Folge haben weder gebaut noch Dateien produziert.\n\n` +
              `${extracted.recognized ? '**Diagnose:** ' + extracted.summary + '\n\n' : ''}` +
              `**Kontext:**\n\`\`\`\n${extracted.contextSnippet}\n\`\`\``);
            this.logger.warn({
              sessionId, phasesAttempted: phaseIdx + 1, totalPhases: plan.phases.length,
              errorCode: extracted.code,
            }, 'Project agent: fail-fast triggered');
            // v636 — fail-fast ist ein hartes Failure → runFailed setzen damit Post-Loop
            // nicht auf 'done' zurückschwenkt (lastBuildActuallyPassed kann sticky-true sein).
            runFailed = true;
            break;
          }
        } else {
          // Build failed but at least some files changed → reset counter (progress)
          consecutiveCompletePhaseFailures = 0;
          anyPhaseProducedFiles = true;
        }
      }

      // ── DONE ──
      // v630/v636 — Phase MUSS abhängig vom tatsächlichen Erfolg gesetzt werden.
      // v630 hat lastBuildActuallyPassed && anyPhaseProducedFiles geprüft — übersah
      // dass lastBuildActuallyPassed sticky-true ist sobald eine frühere Phase grün
      // baute. Bei phase-fail in Phase 24 von 28 mit grünen Phasen 1-23 hätte das
      // immer noch overallSuccess=true ergeben und auf 'done' zurück gesprungen.
      // v636: runFailed wird VOR jedem harten break-Pfad gesetzt, schließt den Bug.
      const overallSuccess = !runFailed && anyPhaseProducedFiles && lastBuildActuallyPassed;
      state.projectPhase = overallSuccess ? 'done' : 'failed';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);

      // v851 — Auto-Feature-Extractor: nach erfolgreichem Run mit goalKind ∈
      // {feature, refactor} UND >= 5 files: LLM-Call der erkennt welche
      // Features implementiert wurden, persistiert in project_features.
      if (overallSuccess && this.featuresRepo && this.projectIdResolver) {
        try {
          const { extractFeaturesFromSession } = await import('./features/auto-extractor.js');
          const projectId = await this.projectIdResolver(config.cwd).catch(() => undefined);
          if (projectId) {
            const commitMessages = completedPhases.map(p => p.description).slice(-10);
            const collectedFiles: string[] = [];
            for (const p of completedPhases) for (const f of p.modifiedFiles) {
              if (!collectedFiles.includes(f)) collectedFiles.push(f);
            }
            const result = await extractFeaturesFromSession({
              goal: config.goal,
              goalKind: plan.goalKind,
              modifiedFiles: collectedFiles,
              commitMessages,
              buildPassed: lastBuildActuallyPassed,
              repo: this.featuresRepo,
              llm: this.llm,
              logger: this.logger,
              projectId,
              userId: this.ownerMasterUserId ?? '',
              gitSha: state.lastCommitSha ?? undefined,
              embeddingService: this.embeddingService, // v851.1 — Embedding-Generierung
            });
            this.logger.info({ sessionId, projectId, ...result }, 'v851 feature extractor done');
          }
        } catch (err) {
          this.logger.debug({ err: (err as Error).message, sessionId }, 'v851 feature extractor failed (non-critical)');
        }
      }

      // ── GIT PUSH ── (only on success — pushing an empty repo is just noise)
      if (overallSuccess) {
        const pushUrl = await this.pushToRemote(config.cwd, platform, chatId, runAsUser,
          { branchPerSession: config.branchPerSession, selfHeal: config.selfHeal }); // v867 — Guard-Kontext
        // v643 — Push-URL auf der Session + auf allen pending Commits speichern
        if (pushUrl || true) {
          try { await this.sessionRepo.updateProgress(sessionId, { lastPushUrl: pushUrl ?? undefined }); } catch { /* skip */ }
        }
        if (this.commitsRepo) {
          try { await this.commitsRepo.markSessionPushed(sessionId, pushUrl); } catch { /* skip */ }
        }

        // v862 — Self-Healing: nach Push MR (GitLab) + PR (GitHub) erstellen.
        // Der MR enthält NUR Code+Tests (kein Version-Bump/Bundle — die
        // Release-Mechanik bleibt ein bewusster Schritt nach dem Review).
        if (config.selfHeal && this.forgeConfig) {
          try {
            const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], config.cwd, runAsUser);
            // v862.1 — selfHealBaseBranch (z.B. feature/multi-user) hat Vorrang;
            // forge.baseBranch zeigt auf den Default der USER-Projekte (master).
            const baseBranch = config.selfHealBaseBranch ?? this.forgeConfig.baseBranch ?? 'main';
            const { createForgeClient, parseRemoteUrl, gitGetRemoteUrl } = await import('@alfred/skills');
            const prTitle = `Self-Healing: ${config.goal.slice(0, 100)}`;
            const prBody = `Automatisch erstellter Fix-Vorschlag (Self-Healing-Pipeline v862).\n\n` +
              `**Goal:** ${config.goal.slice(0, 800)}\n\n` +
              `**Session:** ${sessionId}\n` +
              `**Milestones:**\n${state.milestonesReached.map(m => `- ${m}`).join('\n')}\n\n` +
              `Enthält nur Code + Tests — Version-Bump/CHANGELOG/Bundle folgen beim offiziellen Release nach Review.`;
            const prUrls: string[] = [];
            for (const provider of ['gitlab', 'github'] as const) {
              try {
                if (!this.forgeConfig[provider]) continue;
                // gitlab = primäres Remote "origin"; github hängt als zweites Remote
                // namens "github" (Konvention aus gitExecBoth/pushToRemote)
                const remoteName = provider === 'gitlab' ? 'origin' : 'github';
                const remoteUrl = await gitGetRemoteUrl(remoteName, { cwd: config.cwd }).catch(() => null);
                if (!remoteUrl) continue;
                const repoId = parseRemoteUrl(remoteUrl);
                if (!repoId) continue;
                const client = createForgeClient({ ...this.forgeConfig, provider });
                const pr = await client.createPullRequest(
                  { owner: repoId.owner, repo: repoId.repo },
                  { title: prTitle, body: prBody, head: branch, base: baseBranch },
                );
                prUrls.push(pr.url);
              } catch (err) {
                this.logger.warn({ err: (err as Error).message?.slice(0, 200), provider, sessionId }, 'v862 self-heal PR creation failed (non-fatal)');
              }
            }
            if (prUrls.length > 0) {
              await this.sendProgress(platform, chatId,
                `🩺 **Self-Healing abgeschlossen** — Fix liegt als Review-Vorschlag bereit:\n` +
                prUrls.map(u => `- ${u}`).join('\n') +
                `\n\nKein Live-Patch angewendet — die Installation ist unverändert. ` +
                `Nach Review + Merge: offizielles Release wie gewohnt.`);
            } else {
              await this.sendProgress(platform, chatId,
                `🩺 Self-Healing: Branch \`${branch}\` gepusht, aber MR/PR-Erstellung fehlgeschlagen — bitte manuell anlegen (Basis: ${baseBranch}).`);
            }
          } catch (err) {
            this.logger.warn({ err, sessionId }, 'v862 self-heal MR/PR block failed (non-fatal)');
          }
        }
        // v663a — Auto-Tag bei aktivierter Convention (SemVer-Patch-Bump)
        if (projectConventions?.versioning?.autoTag && projectConventions.versioning.scheme === 'semver') {
          try {
            const latest = await gitExec(['tag', '--sort=-v:refname'], config.cwd, runAsUser).catch(() => '');
            const lastTag = latest.split('\n').find(t => /^v?\d+\.\d+\.\d+/.test(t.trim()));
            let nextTag = 'v0.1.0';
            if (lastTag) {
              const m = lastTag.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
              if (m) {
                const prefix = m[1];
                const major = Number(m[2]); const minor = Number(m[3]); const patch = Number(m[4]) + 1;
                nextTag = `${prefix}${major}.${minor}.${patch}`;
              }
            }
            await gitExec(['tag', nextTag], config.cwd, runAsUser);
            await gitExecBoth(['push', 'origin', nextTag], config.cwd, runAsUser).catch(() => null);
            await this.sendProgress(platform, chatId, `🏷 Auto-Tag: ${nextTag} (semver patch-bump)`);
          } catch (err) {
            this.logger.warn({ err }, 'Project agent: auto-tag failed (non-fatal)');
          }
        }
      }

      // L6 (v604) — honest end-message: don't celebrate failures
      if (overallSuccess) {
        await this.sendProgress(platform, chatId,
          `🎉 Project Agent fertig!\n` +
          `${state.projectIteration} Phasen, ${state.totalFilesChanged} Dateien geändert.\n` +
          `Milestones: ${state.milestonesReached.join(', ')}`);
      } else {
        const failedReason = consecutiveCompletePhaseFailures >= MAX_CONSECUTIVE_PHASE_FAILURES
          ? `Abgebrochen nach ${consecutiveCompletePhaseFailures} ergebnislosen Phasen in Folge`
          : `${plan.phases.length - state.projectIteration} Phasen nicht durchlaufen, kein erfolgreicher Build`;
        const extracted = state.lastBuildOutput ? extractBuildError(state.lastBuildOutput) : null;
        await this.sendProgress(platform, chatId,
          `❌ Project Agent fehlgeschlagen.\n` +
          `${state.projectIteration}/${plan.phases.length} Phasen versucht, ${state.totalFilesChanged} Dateien geändert.\n` +
          `${failedReason}.\n\n` +
          (extracted?.recognized ? `**Diagnose:** ${extracted.summary}\n` : '') +
          (extracted ? `**Letzter Build-Output:**\n\`\`\`\n${extracted.contextSnippet}\n\`\`\`` : ''));
      }

      // v652 — #19 Failure-Insight: LLM generiert kompakten Lessons-Learned-Text
      // v652 — #16 Pattern-Memorierung: häufige Failure-Pattern werden im Lessons-Store
      // gespeichert damit zukünftige Runs in derselben cwd den Pattern vermeiden
      try {
        const insight = await this.generateFailureInsight(
          config,
          state,
          plan.phases,
          { overallSuccess, runFailed, lastBuildOutput: state.lastBuildOutput, hardFailure: lastHardFailure },
        );
        if (insight) {
          await this.sessionRepo.setFailureInsight(sessionId, insight);
          await this.sendProgress(platform, chatId,
            (overallSuccess ? '💡 Lessons:\n' : '💡 Insight:\n') + insight);
        }
        if (!overallSuccess && this.lessonsRepo) {
          const extracted = state.lastBuildOutput ? extractBuildError(state.lastBuildOutput) : null;
          if (extracted?.recognized && extracted.summary) {
            await this.lessonsRepo.upsert({
              cwd: config.cwd,
              pattern: extracted.summary.slice(0, 200),
              advice: insight ?? extracted.summary,
            });
          }
        }
      } catch (err) {
        this.logger.debug({ err, sessionId }, 'failure-insight generation skipped');
      }

      // v652 — #9 Auto-Resume opt-in: bei terminal-failure und autoResume=true
      // wird die Session-Kette automatisch fortgesetzt. Hardlimit 2 pro Kette.
      if (!overallSuccess && config.autoResume && this.autoResumeCallback) {
        try {
          const sess = await this.sessionRepo.getByTaskId(sessionId);
          const chainCount = sess?.autoResumeCount ?? 0;
          if (chainCount >= 2) {
            await this.sendProgress(platform, chatId, `🛑 Auto-Resume Limit (2) erreicht — keine weitere automatische Fortsetzung.`);
          } else {
            await this.sessionRepo.incrementAutoResumeCount(sessionId);
            await this.sendProgress(platform, chatId, `⏳ Auto-Resume in 30s … (Resume ${chainCount + 1}/2 — abbrechen mit Stop in der WebUI)`);
            setTimeout(() => {
              this.autoResumeCallback!(sessionId, `Auto-Resume Versuch ${chainCount + 1}/2 nach Failure.`).catch(err => {
                this.logger.warn({ err, sessionId }, 'auto-resume callback failed');
              });
            }, 30_000);
          }
        } catch (err) {
          this.logger.warn({ err, sessionId }, 'auto-resume scheduling failed');
        }
      }

      // Trigger B: completion callback with honest success-flag
      if (this.completionCallback) {
        try {
          await this.completionCallback(sessionId,
            { goal: config.goal, cwd: config.cwd },
            { milestonesReached: state.milestonesReached, totalFilesChanged: state.totalFilesChanged, projectIteration: state.projectIteration },
            overallSuccess);
          completionFired = true;
        } catch (err) { this.logger.debug({ err }, 'Project-agent completion callback failed'); }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, sessionId }, 'Project agent failed');
      // v630 — Exception ist ein harter Failure, nicht 'done'.
      state.projectPhase = 'failed';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);
      await this.sendProgress(platform, chatId, `💥 Project Agent Fehler: ${msg}`);
      if (this.completionCallback) {
        try {
          await this.completionCallback(sessionId,
            { goal: config.goal, cwd: config.cwd },
            { milestonesReached: state.milestonesReached, totalFilesChanged: state.totalFilesChanged, projectIteration: state.projectIteration },
            false);
          completionFired = true;
        } catch (cbErr) { this.logger.debug({ err: cbErr }, 'Project-agent completion callback (failure path) failed'); }
      }
    } finally {
      // v810 — Lifecycle-Guard: garantiert dass die Session NIE non-terminal hängt.
      // Mehrere return-Pfade (abort Z.475, max-duration Z.481) verließen den Runner
      // ohne terminal-Phase → DB blieb 'fixing'/'coding' → UI zeigte ewig "läuft".
      // Hier: bei Exit prüfen ob die Phase noch aktiv ist, dann auf 'failed' zwingen
      // und completion nachholen falls noch nicht gefeuert. 'awaiting_user' ist ein
      // gewollter Wartezustand (Resume per Interject) und bleibt unangetastet.
      try {
        const sess = await this.sessionRepo.getByTaskId(sessionId);
        const phase = sess?.currentPhase;
        const ACTIVE = ['planning', 'coding', 'fixing', 'validating', 'committing'];
        if (phase && ACTIVE.includes(phase)) {
          state.projectPhase = 'failed';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
          this.logger.warn({ sessionId, prevPhase: phase }, 'v810 lifecycle-guard: forced terminal phase on runner exit');
          if (!completionFired && this.completionCallback) {
            try {
              await this.completionCallback(sessionId,
                { goal: config.goal, cwd: config.cwd },
                { milestonesReached: state.milestonesReached, totalFilesChanged: state.totalFilesChanged, projectIteration: state.projectIteration },
                false);
              completionFired = true;
            } catch { /* best-effort */ }
          }
        }
      } catch (err) {
        this.logger.warn({ err, sessionId }, 'v810 lifecycle-guard failed');
      }
      // v866 — CLI-Usage-Run persistieren (auch bei Failure/Abort — die Zeit/Tokens
      // fielen an). user_id: auslösender User, Fallback Owner. Best-effort.
      if (this.cliRunsRepo) {
        try {
          const projectId = this.projectIdResolver ? await this.projectIdResolver(config.cwd).catch(() => undefined) : undefined;
          await this.cliRunsRepo.record({
            userId: config.userId ?? this.ownerMasterUserId ?? '',
            projectId,
            sessionType: 'project_agent',
            sourceId: sessionId,
            agentName: config.agentName,
            agentVersion: cliAgentVersion,
            model: cliModel,
            tokensIn: cliUsage.tokensIn,
            tokensOut: cliUsage.tokensOut,
            cacheReadTokens: cliUsage.cacheRead,
            costUsd: cliUsage.costUsd,
            durationS: Math.floor((Date.now() - new Date(runStartedAtIso).getTime()) / 1000),
            success: state.projectPhase === 'done',
            startedAt: runStartedAtIso,
            endedAt: new Date().toISOString(),
          });
        } catch (err) {
          this.logger.debug({ err, sessionId }, 'v866 cli-usage record failed (non-fatal)');
        }
      }
      removeAbortController(sessionId);
      this.lastEmittedPhase.delete(sessionId); // v818 PL2 — Phase-Cache aufräumen
      try { markOutputEnded(sessionId); } catch { /* best-effort */ }
      // v665a — Projekt-Lock freigeben
      if (this.projectLockRelease) {
        try { await this.projectLockRelease(config.cwd, sessionId); } catch { /* skip */ }
      }
      // v862 — Self-Healing-Checkout-Lock freigeben (auch bei Failure/Abort)
      if (config.selfHealReleaseLock) {
        try { config.selfHealReleaseLock(); } catch { /* best-effort */ }
      }
      // v605 M5 — drain the interjection inbox so any messages that arrive after
      // session termination (e.g. user thinks the agent still runs and sends
      // another file) don't accumulate as orphans. Without this, late
      // interjections silently buffer forever in the inbox map / DB.
      try {
        const orphans = await drainInterjections(sessionId);
        if (orphans.length > 0) {
          this.logger.warn({ sessionId, count: orphans.length },
            'Project-agent: drained orphan interjections after session end');
        }
      } catch { /* non-critical */ }
    }
  }

  /**
   * L1 (v604) — probe whether the code-agent's runAsUser can traverse into AND
   * write into cwd. Returns ok=true if both checks pass.
   *
   * Linux pitfall this addresses: a directory can be chown'd to user X, but if
   * its parent has no 'x' permission for others (e.g. /root drwx------), X
   * still can't traverse to it. npm install then fails with EACCES on every call.
   */
  private async probeCwdReachable(cwd: string, runAsUser: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const enter = await execFileAsync('sudo', ['-n', '-u', runAsUser, 'test', '-d', cwd], { timeout: 5000 })
        .then(() => ({ ok: true })).catch(() => ({ ok: false }));
      if (!enter.ok) return { ok: false, reason: `cannot enter ${cwd} (Parent-Verzeichnis nicht traversierbar)` };
      const write = await execFileAsync('sudo', ['-n', '-u', runAsUser, 'test', '-w', cwd], { timeout: 5000 })
        .then(() => ({ ok: true })).catch(() => ({ ok: false }));
      if (!write.ok) return { ok: false, reason: `cannot write into ${cwd} (Schreibrechte fehlen)` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `probe error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Push the current branch to the git remote after all phases are done.
   * - If no .git/ directory → git init + create repo on forge if configured
   * - If .git/ but no remote → create repo on forge if configured
   * - If remote exists → push, embedding forge token temporarily if needed
   */
  private async pushToRemote(cwd: string, platform: string, chatId: string, runAsUser?: string,
    guardCtx?: { branchPerSession?: boolean; selfHeal?: boolean }): Promise<string | undefined> {
    // Check if this is a git repository — if not, initialize one
    const hasGitDir = existsSync(path.join(cwd, '.git'));
    if (!hasGitDir) {
      // Always init git — even without forge (local repo is valuable)
      try {
        await gitExec(['init'], cwd, runAsUser);
        await gitExec(['add', '-A'], cwd, runAsUser);
        await gitExec(['commit', '-m', 'Initial commit'], cwd, runAsUser);
        this.logger.info({ cwd }, 'Project agent: git init + initial commit');
      } catch (err) {
        this.logger.warn({ err, cwd }, 'Project agent: git init failed');
        if (!this.forgeConfig) return;
      }
    }

    if (!this.forgeConfig) {
      this.logger.debug({ cwd }, 'Project agent: no forge config — local git repo only');
      return;
    }

    // Get remote URL
    let remoteUrl: string | null;
    try {
      remoteUrl = (await gitExec(['remote', 'get-url', 'origin'], cwd, runAsUser)) || null;
    } catch {
      remoteUrl = null;
    }

    // No remote → create repo on forge and add remote
    if (!remoteUrl && this.forgeConfig) {
      const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
      if (token) {
        // Derive repo name from directory name
        const repoName = path.basename(cwd);
        const baseUrl = this.forgeConfig.gitlab?.baseUrl ?? this.forgeConfig.github?.baseUrl ?? 'https://gitlab.com';
        const providerLabel = this.forgeConfig.provider === 'gitlab' ? 'GitLab' : 'GitHub';

        try {
          // Try to create repo (ignore error if already exists)
          if (this.forgeConfig.provider === 'gitlab') {
            await fetch(`${baseUrl}/api/v4/projects`, {
              method: 'POST',
              headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: repoName, visibility: 'private' }),
            });
          } else {
            const ghBase = this.forgeConfig.github?.baseUrl ?? 'https://api.github.com';
            await fetch(`${ghBase}/user/repos`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: repoName, private: true }),
            });
          }
          this.logger.info({ repoName, provider: providerLabel }, 'Project agent: repo created or already exists');
        } catch (err) {
          this.logger.debug({ err, repoName }, 'Project agent: repo creation failed (may already exist)');
        }

        // Determine remote URL — extract username from API
        let remoteBase: string;
        if (this.forgeConfig.provider === 'gitlab') {
          // GitLab: get current user namespace
          try {
            const userRes = await fetch(`${baseUrl}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } });
            const userData = await userRes.json() as { username?: string };
            remoteBase = `${baseUrl}/${userData.username ?? 'user'}/${repoName}.git`;
          } catch {
            remoteBase = `${baseUrl}/user/${repoName}.git`;
          }
        } else {
          try {
            const ghBase = this.forgeConfig.github?.baseUrl ?? 'https://api.github.com';
            const userRes = await fetch(`${ghBase}/user`, { headers: { 'Authorization': `Bearer ${token}` } });
            const userData = await userRes.json() as { login?: string };
            remoteBase = `https://github.com/${userData.login ?? 'user'}/${repoName}.git`;
          } catch {
            remoteBase = `https://github.com/user/${repoName}.git`;
          }
        }

        try {
          await gitExec(['remote', 'add', 'origin', remoteBase], cwd, runAsUser);
          remoteUrl = remoteBase;
          await this.sendProgress(platform, chatId, `📦 ${providerLabel}-Repo "${repoName}" erstellt.`);
        } catch (err) {
          this.logger.warn({ err, cwd }, 'Project agent: failed to add remote');
          await this.sendProgress(platform, chatId, `⚠️ Remote konnte nicht gesetzt werden.`);
          return;
        }
      }
    }

    if (!remoteUrl) {
      this.logger.warn({ cwd }, 'Project agent: no remote and no forge config — skipping push');
      await this.sendProgress(platform, chatId, '⚠️ Kein Git-Remote konfiguriert — Push übersprungen.');
      return;
    }

    // Inject forge token into existing HTTP remote if no auth present
    const existingHasAuth = /^https?:\/\/[^@/]+@/.test(remoteUrl);
    if (!existingHasAuth && remoteUrl.startsWith('http') && this.forgeConfig) {
      const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
      if (token) {
        try {
          const urlObj = new URL(remoteUrl);
          urlObj.username = 'oauth2';
          urlObj.password = token;
          await gitExec(['remote', 'set-url', 'origin', urlObj.toString()], cwd, runAsUser);
          this.logger.info({ cwd }, 'Project agent: injected forge token into remote URL');
        } catch { /* proceed without token */ }
      }
    }

    // Detect current branch
    let branch: string;
    try {
      branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, runAsUser);
    } catch {
      this.logger.warn({ cwd }, 'Project agent: could not determine current branch');
      return;
    }

    // v867 — Push-Guard: Hauptbranch-Verwechslung hart stoppen. Vorfall alpbyte
    // 11.06.: Workspace stand auf `main`, Projekt deployed von `master` — alle
    // Runner-Pushes des Tages gingen still auf main, der User fand es erst nach
    // dem Deploy ("keine Änderung erkennbar"). Feature-Branch-Pushes
    // (branchPerSession/selfHeal oder Nicht-Mainline-Name) bleiben unberührt.
    if (this.deployBranchResolver) {
      try {
        const deployBranch = await this.deployBranchResolver(cwd);
        const verdict = shouldBlockMainlinePush({
          currentBranch: branch,
          deployBranch,
          branchPerSession: guardCtx?.branchPerSession,
          selfHeal: guardCtx?.selfHeal,
        });
        if (verdict.block) {
          this.logger.warn({ cwd, branch, deployBranch }, 'v867 mainline push blocked (branch mismatch)');
          await this.sendProgress(platform, chatId,
            `⛔ **Push VERWEIGERT**: ${verdict.reason}.\n` +
            `Die Commits sind lokal auf "${branch}" vorhanden — nichts ist verloren.\n` +
            `Korrektur (manuell prüfen!):\n` +
            `\`git checkout ${deployBranch} && git merge ${branch} && git push origin ${deployBranch}\`\n` +
            `Oder, falls "${branch}" wirklich das Ziel sein soll: default_branch des Projekts anpassen und erneut pushen.`);
          return undefined;
        }
      } catch (err) {
        // Resolver-Fehler darf den Push nicht verhindern (Guard ist best-effort)
        this.logger.debug({ err, cwd }, 'v867 push-guard resolver failed (push continues)');
      }
    }

    // Check if remote URL already contains credentials (token embedded)
    const urlAlreadyHasAuth = /^https?:\/\/[^@]+@/.test(remoteUrl);

    if (urlAlreadyHasAuth) {
      // Remote URL already has credentials → push directly
      try {
        await this.sendProgress(platform, chatId, `📤 Pushe nach Remote...`);
        const result = await gitExecBoth(['push', '-u', 'origin', branch], cwd, runAsUser);
        const prUrl = extractPushUrl(result.stderr);
        await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}${prUrl ? `\n🔀 MR/PR: ${prUrl}` : ''}`);
        return prUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err, cwd }, 'Project agent: git push failed');
        await this.sendProgress(platform, chatId, `⚠️ Push fehlgeschlagen: ${msg}`);
      }
      return undefined;
    }

    // No auth in URL — try to inject forge token temporarily
    if (this.forgeConfig) {
      const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
      if (token) {
        let authedUrl: string | null = null;
        let prUrl: string | undefined;
        try {
          // Parse remote URL to inject token: http(s)://host/path → http(s)://oauth2:token@host/path
          const urlObj = new URL(remoteUrl);
          urlObj.username = 'oauth2';
          urlObj.password = token;
          authedUrl = urlObj.toString();

          // Temporarily set authenticated URL
          await gitExec(['remote', 'set-url', 'origin', authedUrl], cwd, runAsUser);

          const providerLabel = this.forgeConfig.provider === 'gitlab' ? 'GitLab' : 'GitHub';
          await this.sendProgress(platform, chatId, `📤 Pushe nach ${providerLabel}...`);
          const result = await gitExecBoth(['push', '-u', 'origin', branch], cwd, runAsUser);
          prUrl = extractPushUrl(result.stderr);
          await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}${prUrl ? `\n🔀 MR/PR: ${prUrl}` : ''}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err, cwd }, 'Project agent: git push with forge token failed');
          await this.sendProgress(platform, chatId, `⚠️ Push fehlgeschlagen: ${msg}`);
        } finally {
          // ALWAYS restore original URL (without token)
          try {
            await gitExec(['remote', 'set-url', 'origin', remoteUrl], cwd, runAsUser);
          } catch (restoreErr) {
            this.logger.error({ err: restoreErr, cwd }, 'Project agent: failed to restore remote URL after push');
          }
        }
        return prUrl;
      }
    }

    // No forge config, no auth in URL → try push anyway (might work with credential helper)
    try {
      await this.sendProgress(platform, chatId, `📤 Pushe nach Remote...`);
      const result = await gitExecBoth(['push', '-u', 'origin', branch], cwd, runAsUser);
      const prUrl = extractPushUrl(result.stderr);
      await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}${prUrl ? `\n🔀 MR/PR: ${prUrl}` : ''}`);
      return prUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, cwd }, 'Project agent: git push failed (no credentials)');
      await this.sendProgress(platform, chatId, `⚠️ Push fehlgeschlagen: ${msg}`);
    }
    return undefined;
  }

  /** Strip credentials from a URL for safe display. */
  private sanitizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * v846 — Wendet eine Plan-Mutation IN-PLACE auf plan.phases an und
   * sendet einen Chat-Banner damit der User die Änderung sieht.
   *
   * Wichtig: plan.phases ist by-reference. Die Mutation passiert hier
   * synchron; der Main-Loop sieht im nächsten Iteration-tick das neue
   * Array (für skip/merge/replace verkleinert, für extend vergrößert).
   */
  private async applyPlanMutation(
    plan: ProjectPlan,
    currentPhaseIdx: number,
    mutation: PlanMutation,
    platform: string,
    chatId: string,
    sessionId: string,
  ): Promise<void> {
    const remaining = plan.phases.slice(currentPhaseIdx + 1);
    const { newRemaining } = applyMutation(remaining, currentPhaseIdx + 1, mutation);

    // Mutate plan.phases in place: keep first (currentPhaseIdx+1) phases (the
    // completed ones), then append newRemaining.
    const completedSlice = plan.phases.slice(0, currentPhaseIdx + 1);
    plan.phases.length = 0;
    plan.phases.push(...completedSlice, ...newRemaining);

    // User-facing banner
    let bannerHeader = '';
    switch (mutation.kind) {
      case 'done':
        bannerHeader = '🏁 Plan-Assessor: Goal bereits erfüllt — Session beendet';
        break;
      case 'skip':
        bannerHeader = `✂ Plan-Assessor: ${mutation.phaseIndices.length} Phase(n) übersprungen`;
        break;
      case 'merge':
        bannerHeader = `🔀 Plan-Assessor: ${mutation.phaseIndices.length} Phasen zusammengefasst`;
        break;
      case 'extend':
        bannerHeader = `➕ Plan-Assessor: Neue Phase eingefügt`;
        break;
      case 'replace':
        bannerHeader = `🔁 Plan-Assessor: ${mutation.phaseIndices.length} Phase(n) ersetzt durch ${mutation.newPhases.length}`;
        break;
      case 'proceed':
        return;
    }
    // After the switch we're guaranteed mutation.kind !== 'proceed' (early-return above).
    const reasoning = (mutation as { reasoning?: string }).reasoning;
    const reasoningBlock = reasoning ? `\n  → ${reasoning}` : '';
    const newSizeBlock = `\n  Plan-Größe nun: ${plan.phases.length} Phasen (${plan.phases.length - currentPhaseIdx - 1} verbleiben)`;
    await this.sendProgress(platform, chatId, bannerHeader + reasoningBlock + newSizeBlock);

    this.logger.info({
      sessionId,
      mutation: mutation.kind,
      reasoning,
      newPlanLength: plan.phases.length,
      remainingAfter: plan.phases.length - currentPhaseIdx - 1,
    }, 'Project agent: plan mutation applied');
  }

  private assemblePrompt(
    goal: string,
    currentPhase: string,
    state: ProjectAgentMeta,
    userMessages: string[],
    lessonsHint: string[] = [],
    conventions?: import('@alfred/storage').ProjectConventions,
  ): string {
    const parts = [
      `PROJEKT-ZIEL: ${goal}`,
      `AKTUELLE PHASE (${state.projectIteration}): ${currentPhase}`,
      `ARBEITSVERZEICHNIS: ${state.projectCwd}`,
    ];

    if (state.lastBuildOutput) {
      parts.push(`LETZTER BUILD-OUTPUT:\n${state.lastBuildOutput.slice(-2000)}`);
    }

    // v652 — Lessons aus früheren Runs: was hier schon schief ging, vermeide jetzt.
    if (lessonsHint.length > 0) {
      parts.push(`LESSONS aus früheren Runs in dieser cwd:\n${lessonsHint.map(l => `- ${l}`).join('\n')}`);
    }

    if (userMessages.length > 0) {
      parts.push(`USER-ANFORDERUNGEN:\n${userMessages.map(m => `- ${m}`).join('\n')}`);
    }

    // v663a — Project-Conventions als zusätzliche Anweisungen
    const conventionInstructions: string[] = [];
    if (conventions?.readme?.autoUpdate) {
      const template = conventions.readme.template ?? 'default';
      conventionInstructions.push(`- README.md pflegen (Template: ${template}). Wenn neue Features/Skripte/Setup-Schritte: README.md aktualisieren (Sections: Features / Setup / Usage).`);
    }
    if (conventions?.changelog?.autoUpdate) {
      const fmt = conventions.changelog.format ?? 'keepachangelog';
      conventionInstructions.push(`- CHANGELOG.md pflegen (Format: ${fmt}). Trage eine Zeile unter "## [Unreleased]" ein die diese Phase beschreibt (z.B. "### Added/Changed/Fixed").`);
    }
    if (conventions?.commits?.convention === 'conventional') {
      const scope = conventions.commits.scopePolicy;
      conventionInstructions.push(`- Commits: Conventional Commits Format (feat: / fix: / refactor: / test: / docs: / style: / perf: / chore:)${scope === 'required' ? ' mit Scope: feat(scope): …' : scope === 'forbidden' ? ' OHNE Scope' : ''}.`);
    }

    parts.push(
      'ANWEISUNGEN:',
      '- Implementiere nur diese Phase, nicht das ganze Projekt',
      '- Erstelle alle nötigen Dateien und Verzeichnisse',
      '- Wenn ein package.json existiert, nutze die vorhandene Struktur',
      '- Wenn Build-Fehler im Output stehen, behebe sie zuerst',
      '- Schreibe produktionsreifen Code',
      ...conventionInstructions,
    );

    return parts.join('\n\n');
  }

  /**
   * v652 — Generiert einen kompakten Lessons-Learned-Text per LLM. Wird bei
   * Done UND Failed aufgerufen (Erfolg = "was war effektiv", Misserfolg = "was
   * blockierte und wie weiter"). 5 Zeilen, deutsch, konkret.
   */
  /**
   * v864 — executeAgent mit Retry bei TRANSIENTEN LLM-API-Fehlern (529 Overloaded,
   * Rate-Limit, Netzwerk). Der CLI-Agent retried intern und gibt dann mit
   * exitCode≠0 auf — solche Exits sind kein Code-Problem. Hier: bis zu 2 weitere
   * Versuche mit Backoff (90s, dann 180s), abbrechbar via AbortSignal.
   * Permanente Fehler (Auth 401, Binary fehlt, Inactivity-Kill 124) gehen
   * unverändert durch. Vorfall: 494ae636 — ein 529 in Phase 4 warf 3 grüne
   * Phasen + 5485 grüne Tests weg.
   */
  private async executeAgentWithApiRetry(
    agentDef: CodeAgentDefinitionConfig,
    prompt: string,
    options: Parameters<typeof executeAgent>[2],
    platform: string,
    chatId: string,
    label: string,
  ): Promise<Awaited<ReturnType<typeof executeAgent>>> {
    let result = await executeAgent(agentDef, prompt, options);
    let delayMs = 90_000;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (result.exitCode === 0 || !isTransientApiFailure(result)) break;
      if (options?.signal?.aborted) break;
      this.logger.warn(
        { taskId: options?.taskId, attempt, delayMs, exitCode: result.exitCode },
        'v864 Project agent: transient LLM-API failure — retrying agent run',
      );
      await this.sendProgress(platform, chatId,
        `🌐 ${label}: transienter LLM-API-Fehler (Overload/Rate-Limit) — Retry ${attempt}/2 in ${Math.round(delayMs / 1000)}s …`);
      const aborted = await abortableDelay(delayMs, options?.signal);
      if (aborted) break;
      result = await executeAgent(agentDef, prompt, options);
      delayMs *= 2;
    }
    return result;
  }

  private async generateFailureInsight(
    config: ProjectAgentConfig,
    state: ProjectAgentMeta,
    phases: string[],
    final: {
      overallSuccess: boolean;
      runFailed: boolean;
      lastBuildOutput?: string;
      /** v864 — Fakten des harten Abbruchs (Coding-Agent exitCode≠0). */
      hardFailure?: { phase: number; exitCode: number; stderrTail: string; stdoutTail: string; transientApi: boolean };
    },
  ): Promise<string | null> {
    try {
      const extracted = final.lastBuildOutput ? extractBuildError(final.lastBuildOutput) : null;
      const reachedPhases = phases.slice(0, state.projectIteration);
      const remainingPhases = phases.slice(state.projectIteration);
      // v864 — Spekulationsverbot: vorher bekam der LLM nur STATUS=failed + einen
      // (oft GRÜNEN) Build-Output und erfand Root-Causes wie "Komponente nicht
      // gebaut, keine Tests" während die echte Ursache ein API-529 war (494ae636).
      const sys = `Du bist Senior-Engineer. Analysiere kurz (max 5 Zeilen, deutsch) was der Project-Agent ${final.overallSuccess ? 'gut gemacht' : 'verfehlt'} hat. Konkret, nicht generisch. Bei Fehlschlag: nenne Root-Cause + konkretem nächsten Schritt.
WICHTIG: Wenn ein Block ABBRUCH-URSACHE (FAKTEN) vorhanden ist, ist das die verbindliche Root-Cause — übernimm sie wörtlich. Bei "transienter LLM-API-Fehler: ja" lautet die Root-Cause IMMER "LLM-Provider-Ausfall (Overload/Rate-Limit), kein Code-Problem" und der nächste Schritt "Session per Resume fortsetzen". Spekuliere in diesem Fall NICHT über Build-, Test- oder Code-Qualität.`;
      const hardFailureBlock = final.hardFailure
        ? [
            `ABBRUCH-URSACHE (FAKTEN):`,
            `Coding-Agent in Phase ${final.hardFailure.phase} mit exitCode=${final.hardFailure.exitCode} beendet.`,
            `Transienter LLM-API-Fehler: ${final.hardFailure.transientApi ? 'ja' : 'nein'}`,
            final.hardFailure.stdoutTail ? `Agent-Output (Ende): ${final.hardFailure.stdoutTail}` : '',
            final.hardFailure.stderrTail ? `stderr (Ende): ${final.hardFailure.stderrTail}` : '',
          ].filter(Boolean).join('\n')
        : '';
      const user = [
        `ZIEL: ${config.goal}`,
        `CWD: ${config.cwd}`,
        `STATUS: ${final.overallSuccess ? 'done' : 'failed'}`,
        `PHASEN GEPLANT: ${phases.length}`,
        `PHASEN VERSUCHT: ${state.projectIteration}`,
        `DATEIEN GEÄNDERT: ${state.totalFilesChanged}`,
        `MILESTONES: ${state.milestonesReached.join(', ') || '—'}`,
        hardFailureBlock,
        reachedPhases.length ? `ERREICHTE PHASEN:\n${reachedPhases.slice(-5).map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
        remainingPhases.length ? `OFFENE PHASEN:\n${remainingPhases.slice(0, 5).map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
        extracted?.recognized ? `BUILD-FEHLER: ${extracted.summary}` : '',
        extracted ? `BUILD-OUTPUT (Auszug):\n${extracted.contextSnippet}` : '',
      ].filter(Boolean).join('\n\n');
      const resp = await this.llm.complete({
        system: sys,
        messages: [{ role: 'user', content: user }],
        tier: 'fast',
        maxTokens: 600,
        temperature: 0.3,
      });
      const text = (resp.content ?? '').trim();
      return text.length > 10 ? text.slice(0, 1200) : null;
    } catch (err) {
      this.logger.debug({ err }, 'generateFailureInsight failed');
      return null;
    }
  }

  // v818 PL2 — Cache der zuletzt emittierten Phase pro Session damit wir nur
  // bei tatsächlichem Wechsel ein Event pushen (statt bei jedem updateSession).
  private lastEmittedPhase = new Map<string, string>();

  private async updateSession(sessionId: string, state: ProjectAgentMeta, buildPassed: boolean): Promise<void> {
    try {
      await this.sessionRepo.updateProgress(sessionId, {
        currentPhase: state.projectPhase,
        currentIteration: state.projectIteration,
        totalFilesChanged: state.totalFilesChanged,
        lastBuildPassed: buildPassed,
        lastCommitSha: state.lastCommitSha,
      });
      // v818 PL2 — Phase-Event in den SSE-Stream pushen damit das Sandbox-Chat-UI
      // den Phase-Badge ohne 4s-Polling sofort sieht. Nur bei Phase-Wechsel emittieren
      // — sonst flutet jeder updateSession-Call (mehrfach pro Phase) den Stream.
      const last = this.lastEmittedPhase.get(sessionId);
      if (last !== state.projectPhase) {
        this.lastEmittedPhase.set(sessionId, state.projectPhase);
        try {
          appendOutputEvent(sessionId, 'phase', {
            phase: state.projectPhase,
            iteration: state.projectIteration,
            buildPassed,
          });
        } catch { /* buffer best-effort */ }
      }
    } catch (err) {
      this.logger.warn({ err, sessionId }, 'Project agent: session update failed');
    }
  }

  private async sendProgress(platform: string, chatId: string, text: string): Promise<void> {
    this.lastProgressAt = Date.now();
    const ctx = currentSession.getStore();
    if (ctx?.sessionId) {
      try { appendOutputLine(ctx.sessionId, 'system', text); } catch { /* buffer best-effort */ }
    }
    const adapter = this.adapters.get(platform as Platform);
    if (adapter) {
      try { await adapter.sendMessage(chatId, text); } catch { /* ignore */ }
    }
  }

  private sendProgressThrottled(platform: string, chatId: string, text: string): void {
    if (Date.now() - this.lastProgressAt < this.throttleMs) return;
    this.sendProgress(platform, chatId, text).catch(() => {});
  }
}
