import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { Platform, ProjectAgentMeta, CodeAgentDefinitionConfig } from '@alfred/types';
import type { ProjectAgentSessionRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import { executeAgent, validateBuild, createProjectPlan, drainInterjections, registerAbortController, removeAbortController } from '@alfred/skills';

const execFileAsync = promisify(execFile);

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
            await execFileAsync('git', ['add', '-A'], { cwd: config.cwd });
            const commitMsg = `Phase ${phaseIdx + 1}: ${phase}`;
            // Use execFile with array args to avoid shell injection
            const { stdout } = await execFileAsync('git', ['commit', '-m', commitMsg, '--allow-empty'], { cwd: config.cwd });
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
