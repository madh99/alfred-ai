import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Platform, ProjectAgentMeta, CodeAgentDefinitionConfig, ForgeConfig } from '@alfred/types';
import type { ProjectAgentSessionRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import { executeAgent, validateBuild, createProjectPlan, drainInterjections, registerAbortController, removeAbortController, extractBuildError, stageAssetsForProject } from '@alfred/skills';
import type { FileStore } from '@alfred/storage';

const execFileAsync = promisify(execFile);

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
}

export type ProjectAgentCompletionCallback = (
  sessionId: string,
  config: { goal: string; cwd: string },
  state: { milestonesReached: string[]; totalFilesChanged: number; projectIteration: number },
  success: boolean,
) => Promise<void>;

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

  async run(sessionId: string, configInput: Record<string, unknown>, platform: string, chatId: string): Promise<void> {
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

    // Register abort controller for stop signals
    const abortController = new AbortController();
    registerAbortController(sessionId, abortController);

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

    try {
      await this.sendProgress(platform, chatId, `🚀 Project Agent gestartet: ${config.goal}`);

      // ── PLANNING ──
      state.projectPhase = 'planning';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);
      await this.sendProgress(platform, chatId, '📋 Erstelle Projekt-Plan...');

      const previousSessions = await this.sessionRepo.getCompletedByCwd(config.cwd).catch(() => []);
      const plan = await createProjectPlan(config.goal, this.llm, previousSessions);
      await this.sendProgress(platform, chatId,
        `📋 Plan erstellt: ${plan.phases.length} Phasen\n${plan.phases.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
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
      const maxDurationMs = config.maxDurationHours * 60 * 60 * 1000;

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

      // ── MAIN LOOP ──
      for (let phaseIdx = 0; phaseIdx < plan.phases.length; phaseIdx++) {
        // Check abort signal
        if (abortController.signal.aborted) {
          await this.sendProgress(platform, chatId, `⏹ Project Agent abgebrochen.`);
          return;
        }

        // Check duration limit
        if (Date.now() - startTime > maxDurationMs) {
          await this.sendProgress(platform, chatId, `⏰ Max-Dauer (${config.maxDurationHours}h) überschritten. Agent gestoppt.`);
          return;
        }

        state.projectIteration = phaseIdx + 1;
        state.projectPhase = 'coding';
        state.consecutiveFixFailures = 0;
        lastBuildActuallyPassed = false;
        const filesBeforePhase = state.totalFilesChanged;
        await this.updateSession(sessionId, state, lastBuildActuallyPassed);

        const phase = plan.phases[phaseIdx];

        // Drain interjections before each coding step (per-iteration, not per-phase)
        const messages = await drainInterjections(sessionId);
        if (messages.includes('__STOP__')) {
          // v650 — abortController.abort() killt auch laufende Sub-Process-Tree
          abortController.abort();
          await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt vor Phase ${phaseIdx + 1}/${plan.phases.length}.`);
          return;
        }
        const userMessages = messages.filter(m => m !== '__STOP__');

        const prompt = this.assemblePrompt(config.goal, phase, state, userMessages);
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
        const longPhasePattern = /\bnpm\s+(install|run\s+build|run\s+lint|run\s+typecheck|test|run\s+test|ci)\b|\bvalidier|\bvalidation\b|\bvalidate\b|\bbuild-?fehler\b|\breproduzieren\b|\bdatenmodell\b|\bdata\s*model\b|\bdatamodel\b|\bmigration(?:en|s)?\b|\bschema\b|\brefactor(?:ing)?\b|\bumbau\b|\btypsystem\b|\btype\s*system\b/i;
        const isLongPhase = longPhasePattern.test(phase);
        // v625 — Normal-Phase auf 10min angehoben (war 5min); Long-Phase bleibt 20min.
        const phaseTimeout = isLongPhase ? 20 * 60_000 : 10 * 60_000;
        if (isLongPhase) {
          this.logger.info({ sessionId, phase: phaseIdx + 1, timeoutMs: phaseTimeout },
            'Project agent: long-phase detected, extended inactivity timeout');
        }

        // ── CODING ──
        this.logger.info({ sessionId, phase: phaseIdx + 1, description: phase }, 'Project agent: coding phase');
        const codeResult = await executeAgent(agentDef, prompt, {
          cwd: config.cwd,
          timeoutMs: phaseTimeout,
          signal: abortController.signal,
          onProgress: (status) => {
            this.sendProgressThrottled(platform, chatId, `  [${config.agentName}] ${status}`);
          },
        });

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
          }, 'Project agent: coding phase exited non-zero — aborting');
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
            config.cwd, config.buildCommands, config.testCommands, config.buildTimeoutMs, runAsUser,
          );
          state.lastBuildOutput = buildResult.combinedOutput;

          if (buildResult.passed) {
            buildPassed = true;
            lastBuildActuallyPassed = true;
            await this.sendProgress(platform, chatId,
              `✅ Build passed (Phase ${phaseIdx + 1}). ${codeResult.modifiedFiles.length} Dateien geändert.`);
            break;
          }

          // Build failed
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
            break;
          }

          // ── FIXING ──
          state.projectPhase = 'fixing';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);

          // Drain interjections before fix step
          const fixMessages = await drainInterjections(sessionId);
          if (fixMessages.includes('__STOP__')) {
            abortController.abort();
            await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt während Fix-Versuch.`);
            return;
          }
          const fixUserMessages = fixMessages.filter(m => m !== '__STOP__');

          await this.sendProgress(platform, chatId,
            `🔧 Fix-Versuch ${fixAttempt + 1}/${config.maxFixAttempts}...`);

          const fixPrompt = `Der Build ist fehlgeschlagen. Hier ist der Output:\n\n${buildResult.combinedOutput}\n\nBitte behebe die Fehler. Das Ziel war: ${phase}${fixUserMessages.length > 0 ? '\n\nUser-Hinweise:\n' + fixUserMessages.map(m => `- ${m}`).join('\n') : ''}`;
          const fixResult = await executeAgent(agentDef, fixPrompt, {
            cwd: config.cwd,
            // v624 D — Fix-Läufe rufen oft `npm run build` zum Reparieren auf → langer Timeout
            timeoutMs: 20 * 60_000,
            signal: abortController.signal,
            onProgress: (status) => {
              this.sendProgressThrottled(platform, chatId, `  [fix] ${status}`);
            },
          });
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
            const commitMsg = `Phase ${phaseIdx + 1}: ${phase}`;
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

      // ── GIT PUSH ── (only on success — pushing an empty repo is just noise)
      if (overallSuccess) {
        const pushUrl = await this.pushToRemote(config.cwd, platform, chatId, runAsUser);
        // v643 — Push-URL auf der Session + auf allen pending Commits speichern
        if (pushUrl || true) {
          try { await this.sessionRepo.updateProgress(sessionId, { lastPushUrl: pushUrl ?? undefined }); } catch { /* skip */ }
        }
        if (this.commitsRepo) {
          try { await this.commitsRepo.markSessionPushed(sessionId, pushUrl); } catch { /* skip */ }
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

      // Trigger B: completion callback with honest success-flag
      if (this.completionCallback) {
        try {
          await this.completionCallback(sessionId,
            { goal: config.goal, cwd: config.cwd },
            { milestonesReached: state.milestonesReached, totalFilesChanged: state.totalFilesChanged, projectIteration: state.projectIteration },
            overallSuccess);
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
        } catch (cbErr) { this.logger.debug({ err: cbErr }, 'Project-agent completion callback (failure path) failed'); }
      }
    } finally {
      removeAbortController(sessionId);
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
  private async pushToRemote(cwd: string, platform: string, chatId: string, runAsUser?: string): Promise<string | undefined> {
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

  private assemblePrompt(
    goal: string,
    currentPhase: string,
    state: ProjectAgentMeta,
    userMessages: string[],
  ): string {
    const parts = [
      `PROJEKT-ZIEL: ${goal}`,
      `AKTUELLE PHASE (${state.projectIteration}): ${currentPhase}`,
      `ARBEITSVERZEICHNIS: ${state.projectCwd}`,
    ];

    if (state.lastBuildOutput) {
      parts.push(`LETZTER BUILD-OUTPUT:\n${state.lastBuildOutput.slice(-2000)}`);
    }

    if (userMessages.length > 0) {
      parts.push(`USER-ANFORDERUNGEN:\n${userMessages.map(m => `- ${m}`).join('\n')}`);
    }

    parts.push(
      'ANWEISUNGEN:',
      '- Implementiere nur diese Phase, nicht das ganze Projekt',
      '- Erstelle alle nötigen Dateien und Verzeichnisse',
      '- Wenn ein package.json existiert, nutze die vorhandene Struktur',
      '- Wenn Build-Fehler im Output stehen, behebe sie zuerst',
      '- Schreibe produktionsreifen Code',
    );

    return parts.join('\n\n');
  }

  private async updateSession(sessionId: string, state: ProjectAgentMeta, buildPassed: boolean): Promise<void> {
    try {
      await this.sessionRepo.updateProgress(sessionId, {
        currentPhase: state.projectPhase,
        currentIteration: state.projectIteration,
        totalFilesChanged: state.totalFilesChanged,
        lastBuildPassed: buildPassed,
        lastCommitSha: state.lastCommitSha,
      });
    } catch (err) {
      this.logger.warn({ err, sessionId }, 'Project agent: session update failed');
    }
  }

  private async sendProgress(platform: string, chatId: string, text: string): Promise<void> {
    this.lastProgressAt = Date.now();
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
