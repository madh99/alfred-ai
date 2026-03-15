import type { Logger } from 'pino';
import type { Platform, ProjectAgentMeta, CodeAgentDefinitionConfig } from '@alfred/types';
import type { BackgroundTaskRepository, ProjectAgentSessionRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { LLMProvider } from '@alfred/llm';
import { executeAgent, validateBuild, createProjectPlan, drainInterjections } from '@alfred/skills';

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
    private readonly taskRepo: BackgroundTaskRepository,
    private readonly sessionRepo: ProjectAgentSessionRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
  ) {}

  async run(taskId: string, config: ProjectAgentConfig, platform: string, chatId: string): Promise<void> {
    const agentDef = this.agents.get(config.agentName);
    if (!agentDef) {
      this.logger.error({ taskId, agent: config.agentName }, 'Project agent not found');
      this.taskRepo.updateStatus(taskId, 'failed', undefined, `Agent "${config.agentName}" not found`);
      return;
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

    try {
      await this.sendProgress(platform, chatId, `🚀 Project Agent gestartet: ${config.goal}`);

      // ── PLANNING ──
      state.projectPhase = 'planning';
      this.updateSession(taskId, state);
      await this.sendProgress(platform, chatId, '📋 Erstelle Projekt-Plan...');

      const plan = await createProjectPlan(config.goal, this.llm);
      await this.sendProgress(platform, chatId,
        `📋 Plan erstellt: ${plan.phases.length} Phasen\n${plan.phases.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
      state.milestonesReached.push('Plan erstellt');

      // ── MAIN LOOP ──
      for (let phaseIdx = 0; phaseIdx < plan.phases.length; phaseIdx++) {
        // Check for stop signal
        const messages = drainInterjections(taskId);
        if (messages.includes('__STOP__')) {
          await this.sendProgress(platform, chatId, `⏹ Project Agent gestoppt nach Phase ${phaseIdx}/${plan.phases.length}.`);
          this.taskRepo.updateStatus(taskId, 'completed', JSON.stringify({ stopped: true, phase: phaseIdx }));
          return;
        }

        state.projectIteration = phaseIdx + 1;
        state.projectPhase = 'coding';
        state.consecutiveFixFailures = 0;
        this.updateSession(taskId, state);

        const phase = plan.phases[phaseIdx];
        const userMessages = messages.filter(m => m !== '__STOP__');

        // Assemble prompt for the code agent
        const prompt = this.assemblePrompt(config.goal, phase, state, userMessages);
        await this.sendProgress(platform, chatId, `🔨 Phase ${phaseIdx + 1}/${plan.phases.length}: ${phase}`);

        // ── CODING ──
        this.logger.info({ taskId, phase: phaseIdx + 1, description: phase }, 'Project agent: coding phase');
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
          state.projectPhase = 'validating';
          this.updateSession(taskId, state);

          if (config.buildCommands.length === 0 && config.testCommands.length === 0) {
            buildPassed = true;
            break;
          }

          const buildResult = await validateBuild(
            config.cwd, config.buildCommands, config.testCommands, config.buildTimeoutMs,
          );
          state.lastBuildOutput = buildResult.combinedOutput;

          if (buildResult.passed) {
            buildPassed = true;
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
            this.updateSession(taskId, state);
            // Continue to next phase anyway — let the agent try to recover
            break;
          }

          // ── FIXING ──
          state.projectPhase = 'fixing';
          this.updateSession(taskId, state);
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

        // ── COMMITTING ──
        if (buildPassed) {
          state.projectPhase = 'committing';
          this.updateSession(taskId, state);

          try {
            const { execSync } = await import('node:child_process');
            execSync('git add -A', { cwd: config.cwd, stdio: 'pipe' });
            const commitMsg = `Phase ${phaseIdx + 1}: ${phase}`;
            const output = execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}" --allow-empty`, {
              cwd: config.cwd, stdio: 'pipe',
            }).toString();
            const shaMatch = output.match(/\[[\w-]+ ([a-f0-9]+)\]/);
            state.lastCommitSha = shaMatch?.[1];
            if (state.lastCommitSha) {
              await this.sendProgress(platform, chatId, `📦 Commit: ${state.lastCommitSha} — ${phase}`);
            }
          } catch (err) {
            this.logger.warn({ err, taskId }, 'Project agent: git commit failed');
          }

          state.milestonesReached.push(`Phase ${phaseIdx + 1}: ${phase}`);
          this.updateSession(taskId, state);
        }

        // Checkpoint
        this.taskRepo.checkpoint(taskId, JSON.stringify({ metadata: state }));
      }

      // ── DONE ──
      state.projectPhase = 'done';
      this.updateSession(taskId, state);
      this.taskRepo.updateStatus(taskId, 'completed', JSON.stringify({
        totalFilesChanged: state.totalFilesChanged,
        iterations: state.projectIteration,
        milestones: state.milestonesReached,
      }));

      await this.sendProgress(platform, chatId,
        `🎉 Project Agent fertig!\n` +
        `${state.projectIteration} Phasen, ${state.totalFilesChanged} Dateien geändert.\n` +
        `Milestones: ${state.milestonesReached.join(', ')}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, taskId }, 'Project agent failed');
      this.taskRepo.updateStatus(taskId, 'failed', undefined, msg);
      await this.sendProgress(platform, chatId, `💥 Project Agent Fehler: ${msg}`);
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

  private updateSession(taskId: string, state: ProjectAgentMeta): void {
    try {
      this.sessionRepo.updateProgress(taskId, {
        currentPhase: state.projectPhase,
        currentIteration: state.projectIteration,
        totalFilesChanged: state.totalFilesChanged,
        lastBuildPassed: state.consecutiveFixFailures === 0,
        lastCommitSha: state.lastCommitSha,
      });
    } catch (err) {
      this.logger.warn({ err, taskId }, 'Project agent: session update failed');
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
