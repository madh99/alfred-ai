import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Platform, ProjectAgentMeta, CodeAgentDefinitionConfig, ForgeConfig } from '@alfred/types';
import type { ProjectAgentSessionRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import { executeAgent, validateBuild, createProjectPlan, drainInterjections, registerAbortController, removeAbortController } from '@alfred/skills';

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

export interface ProjectAgentConfig {
  goal: string;
  cwd: string;
  agentName: string;
  buildCommands: string[];
  testCommands: string[];
  maxDurationHours: number;
  maxFixAttempts: number;
  buildTimeoutMs: number;
}

export class ProjectAgentRunner {
  private lastProgressAt = 0;
  private readonly throttleMs = 30_000;

  constructor(
    private readonly agents: Map<string, CodeAgentDefinitionConfig>,
    private readonly llm: LLMProvider,
    private readonly sessionRepo: ProjectAgentSessionRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly forgeConfig?: ForgeConfig,
  ) {}

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

    try {
      await this.sendProgress(platform, chatId, `🚀 Project Agent gestartet: ${config.goal}`);

      // ── PLANNING ──
      state.projectPhase = 'planning';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);
      await this.sendProgress(platform, chatId, '📋 Erstelle Projekt-Plan...');

      const plan = await createProjectPlan(config.goal, this.llm);
      await this.sendProgress(platform, chatId,
        `📋 Plan erstellt: ${plan.phases.length} Phasen\n${plan.phases.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
      state.milestonesReached.push('Plan erstellt');
      await this.sessionRepo.addMilestone(sessionId, 'Plan erstellt');

      const startTime = Date.now();
      const maxDurationMs = config.maxDurationHours * 60 * 60 * 1000;

      // ── ENSURE GIT REPO EXISTS (before any phase commits) ──
      if (!existsSync(path.join(config.cwd, '.git'))) {
        try {
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

        // Check for stop signal in inbox
        const messages = await drainInterjections(sessionId);
        if (messages.includes('__STOP__')) {
          await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt nach Phase ${phaseIdx}/${plan.phases.length}.`);
          return;
        }

        state.projectIteration = phaseIdx + 1;
        state.projectPhase = 'coding';
        state.consecutiveFixFailures = 0;
        lastBuildActuallyPassed = false;
        await this.updateSession(sessionId, state, lastBuildActuallyPassed);

        const phase = plan.phases[phaseIdx];
        const userMessages = messages.filter(m => m !== '__STOP__');

        const prompt = this.assemblePrompt(config.goal, phase, state, userMessages);
        await this.sendProgress(platform, chatId, `🔨 Phase ${phaseIdx + 1}/${plan.phases.length}: ${phase}`);

        // ── CODING ──
        this.logger.info({ sessionId, phase: phaseIdx + 1, description: phase }, 'Project agent: coding phase');
        const codeResult = await executeAgent(agentDef, prompt, {
          cwd: config.cwd,
          onProgress: (status) => {
            this.sendProgressThrottled(platform, chatId, `  [${config.agentName}] ${status}`);
          },
        });

        state.totalFilesChanged += codeResult.modifiedFiles.length;

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
            await this.sendProgress(platform, chatId,
              `❌ Build failed nach ${config.maxFixAttempts} Fix-Versuchen.\n` +
              `Letzter Fehler:\n${buildResult.combinedOutput.slice(-500)}\n` +
              `Sende "interject" mit Hinweisen oder "stop" zum Abbrechen.`);
            state.projectPhase = 'awaiting_user';
            await this.updateSession(sessionId, state, lastBuildActuallyPassed);
            break;
          }

          // ── FIXING ──
          state.projectPhase = 'fixing';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
          await this.sendProgress(platform, chatId,
            `🔧 Fix-Versuch ${fixAttempt + 1}/${config.maxFixAttempts}...`);

          const fixPrompt = `Der Build ist fehlgeschlagen. Hier ist der Output:\n\n${buildResult.combinedOutput}\n\nBitte behebe die Fehler. Das Ziel war: ${phase}`;
          const fixResult = await executeAgent(agentDef, fixPrompt, {
            cwd: config.cwd,
            onProgress: (status) => {
              this.sendProgressThrottled(platform, chatId, `  [fix] ${status}`);
            },
          });
          state.totalFilesChanged += fixResult.modifiedFiles.length;
        }

        // ── COMMITTING (async, no event loop blocking) ──
        if (buildPassed) {
          state.projectPhase = 'committing';
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);

          try {
            await gitExec(['add', '-A'], config.cwd, runAsUser);
            const commitMsg = `Phase ${phaseIdx + 1}: ${phase}`;
            const stdout = await gitExec(['commit', '-m', commitMsg, '--allow-empty'], config.cwd, runAsUser);
            const shaMatch = stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/);
            state.lastCommitSha = shaMatch?.[1];
            if (state.lastCommitSha) {
              await this.sendProgress(platform, chatId, `📦 Commit: ${state.lastCommitSha} — ${phase}`);
            }
          } catch (err) {
            this.logger.warn({ err, sessionId }, 'Project agent: git commit failed');
          }

          const milestone = `Phase ${phaseIdx + 1}: ${phase}`;
          state.milestonesReached.push(milestone);
          await this.sessionRepo.addMilestone(sessionId, milestone);
          await this.updateSession(sessionId, state, lastBuildActuallyPassed);
        }
      }

      // ── DONE ──
      state.projectPhase = 'done';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);

      // ── GIT PUSH ──
      await this.pushToRemote(config.cwd, platform, chatId, runAsUser);

      await this.sendProgress(platform, chatId,
        `🎉 Project Agent fertig!\n` +
        `${state.projectIteration} Phasen, ${state.totalFilesChanged} Dateien geändert.\n` +
        `Milestones: ${state.milestonesReached.join(', ')}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, sessionId }, 'Project agent failed');
      state.projectPhase = 'done';
      await this.updateSession(sessionId, state, lastBuildActuallyPassed);
      await this.sendProgress(platform, chatId, `💥 Project Agent Fehler: ${msg}`);
    } finally {
      removeAbortController(sessionId);
    }
  }

  /**
   * Push the current branch to the git remote after all phases are done.
   * - If no .git/ directory → git init + create repo on forge if configured
   * - If .git/ but no remote → create repo on forge if configured
   * - If remote exists → push, embedding forge token temporarily if needed
   */
  private async pushToRemote(cwd: string, platform: string, chatId: string, runAsUser?: string): Promise<void> {
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
        await gitExec(['push', '-u', 'origin', branch], cwd, runAsUser);
        await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err, cwd }, 'Project agent: git push failed');
        await this.sendProgress(platform, chatId, `⚠️ Push fehlgeschlagen: ${msg}`);
      }
      return;
    }

    // No auth in URL — try to inject forge token temporarily
    if (this.forgeConfig) {
      const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
      if (token) {
        let authedUrl: string | null = null;
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
          await gitExec(['push', '-u', 'origin', branch], cwd, runAsUser);
          await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}`);
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
        return;
      }
    }

    // No forge config, no auth in URL → try push anyway (might work with credential helper)
    try {
      await this.sendProgress(platform, chatId, `📤 Pushe nach Remote...`);
      await gitExec(['push', '-u', 'origin', branch], cwd, runAsUser);
      await this.sendProgress(platform, chatId, `📤 Gepusht: ${this.sanitizeUrl(remoteUrl)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, cwd }, 'Project agent: git push failed (no credentials)');
      await this.sendProgress(platform, chatId, `⚠️ Push fehlgeschlagen: ${msg}`);
    }
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
