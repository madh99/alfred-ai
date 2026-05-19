import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig, ProjectAgentsConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { ProjectAgentSessionRepository, ProjectAgentInterjectionRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

/**
 * v607 D5 — strip LLM-introduced boilerplate prefixes from the goal-text.
 *
 * The v605 PromptBuilder tells the LLM "always use action='start' with a fresh
 * goal", which the LLM tends to take literally and prepend phrases like
 * "Starte einen NEUEN Projekt-Agent-Lauf für ..." to the actual project
 * description. This pollutes project-names and runbook-titles downstream.
 *
 * Strips repeatedly to handle layered prefixes. Returns the cleaned goal.
 */
export function stripGoalPrefix(goal: string): string {
  const prefixes = [
    /^Starte\s+(einen\s+)?(NEUE[NRS]?\s+)?Projekt-Agent-Lauf\s+(für|fuer)\s+/i,
    /^Bitte\s+(starte|erstelle|baue)\s+/i,
    /^Starte\s+(einen\s+)?(neuen\s+)?Project[-\s]Agent[-\s]Lauf\s+/i,
    /^Erstelle\s+(ein\s+)?(neues\s+)?Projekt\s+(für|für\s+|fuer\s+)?/i,
    /^Bitte\s+/i,
  ];
  let result = goal.trim();
  let changed = true;
  let iters = 0;
  while (changed && iters++ < 4) {
    changed = false;
    for (const re of prefixes) {
      if (re.test(result)) {
        result = result.replace(re, '').trim();
        // Strip leading quotes around the project name if any
        result = result.replace(/^["'"„"](.+?)["'"""]/, '$1').trim();
        changed = true;
      }
    }
  }
  return result.length > 0 ? result : goal.trim();
}

/** Fallback in-memory inbox (used when no DB repository is available). */
const interjectionInboxFallback = new Map<string, string[]>();

/** DB-backed interjection repository — set via setInterjectionRepo(). */
let interjectionRepo: ProjectAgentInterjectionRepository | undefined;

export function setInterjectionRepo(repo: ProjectAgentInterjectionRepository): void {
  interjectionRepo = repo;
}

/** Active runner abort controllers keyed by session ID. */
const activeAbortControllers = new Map<string, AbortController>();

export async function pushInterjection(taskId: string, message: string): Promise<void> {
  if (interjectionRepo) {
    await interjectionRepo.push(taskId, message);
  } else {
    const inbox = interjectionInboxFallback.get(taskId) ?? [];
    inbox.push(message);
    interjectionInboxFallback.set(taskId, inbox);
  }
}

export async function drainInterjections(taskId: string): Promise<string[]> {
  if (interjectionRepo) {
    return interjectionRepo.drain(taskId);
  }
  const messages = interjectionInboxFallback.get(taskId) ?? [];
  interjectionInboxFallback.delete(taskId);
  return messages;
}

export function registerAbortController(sessionId: string, controller: AbortController): void {
  activeAbortControllers.set(sessionId, controller);
}

export function removeAbortController(sessionId: string): void {
  activeAbortControllers.delete(sessionId);
}

export class ProjectAgentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'project_agent',
    category: 'automation',
    description: `Autonomous coding agent that creates and develops software projects end-to-end. Runs indefinitely until the goal is reached.
Actions:
- start: Start a NEW project agent session. Use this whenever the user requests a new project or wants to retry after a previous session ended. Params: goal (what to build), cwd (directory), agent (which code agent to use, e.g. "claude-code"), buildCommands (optional, e.g. ["npm install", "npm run build"]), testCommands (optional), template (optional, e.g. "nextjs")
- status: Check current status of a project agent session. Params: task_id. Returns currentPhase — if 'done' or 'failed', the session has ENDED and interject will not work; start a fresh one instead.
- interject: Send a message to a CURRENTLY RUNNING project agent (e.g. "add feature X"). Params: task_id, message. DO NOT use interject if the session is already finished/done/failed — start a new session with action='start' instead. The skill will reject interject on terminated sessions with a clear error.
- stop: Stop a running project agent. Params: task_id`,
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'interject', 'stop'],
          description: 'Project agent action',
        },
        goal: { type: 'string', description: 'What to build (for start)' },
        cwd: { type: 'string', description: 'Working directory for the project (for start)' },
        agent: { type: 'string', description: 'Code agent to use, e.g. "claude-code" or "codex" (for start)' },
        buildCommands: {
          type: 'array', items: { type: 'string' },
          description: 'Commands to validate build (for start). Default: ["npm install", "npm run build"]',
        },
        testCommands: {
          type: 'array', items: { type: 'string' },
          description: 'Commands to run tests (for start). Default: ["npm test"]',
        },
        template: { type: 'string', description: 'Project template name (for start, optional)' },
        task_id: { type: 'string', description: 'Task ID (for status/interject/stop)' },
        message: { type: 'string', description: 'Message to inject (for interject)' },
      },
      required: ['action'],
    },
  };

  private readonly agents: Map<string, CodeAgentDefinitionConfig>;
  private readonly config: ProjectAgentsConfig;
  /** Set by alfred.ts after construction — the runner that executes the loop. */
  private runner?: { run(sessionId: string, config: Record<string, unknown>, platform: string, chatId: string): Promise<void> };

  constructor(
    config: ProjectAgentsConfig & { agents: CodeAgentDefinitionConfig[] },
    private readonly llm: LLMProvider,
    private readonly sessionRepo: ProjectAgentSessionRepository,
  ) {
    super();
    this.config = config;
    this.agents = new Map(config.agents.map(a => [a.name, a]));
  }

  setRunner(runner: { run(sessionId: string, config: Record<string, unknown>, platform: string, chatId: string): Promise<void> }): void {
    this.runner = runner;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'start':
        return this.startProject(input, context);
      case 'status':
        return this.getStatus(input, context);
      case 'interject':
        return this.interject(input, context);
      case 'stop':
        return this.stopProject(input, context);
      default:
        return { success: false, error: `Unknown action "${action}". Use start, status, interject, or stop.` };
    }
  }

  private async startProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const rawGoal = input.goal as string | undefined;
    let cwd = input.cwd as string | undefined;
    const agentName = (input.agent as string) ?? [...this.agents.keys()][0];

    if (!rawGoal) return { success: false, error: 'Missing required field "goal"' };
    if (!cwd) return { success: false, error: 'Missing required field "cwd"' };
    if (!this.runner) return { success: false, error: 'Project agent runner not configured' };

    // v607 D5 — strip boilerplate prefixes the LLM tends to prepend (driven by
    // the v605 PromptBuilder rule "use action='start' with fresh goal"). Without
    // this, project-names + runbook-titles look like
    // "Starte einen NEUEN Projekt-Agent-Lauf für 'X' unter ..."
    // instead of just the project description.
    const goal = stripGoalPrefix(rawGoal);

    const agentDef = this.agents.get(agentName);
    if (!agentDef) {
      return { success: false, error: `Unknown agent "${agentName}". Available: ${[...this.agents.keys()].join(', ')}` };
    }

    // L4 (v604) — Smart cwd-Default: when the chosen agent runs as a different
    // (non-root) user via `sudo -u X`, a cwd under /root/ creates an unreachable
    // path (parent /root is drwx------ → traversal blocked → constant EACCES).
    // We auto-rewrite to /home/X/projects/<last-segment> and surface a hint.
    const runAsUser = (agentDef.command === 'sudo' && agentDef.argsTemplate[0] === '-u' && agentDef.argsTemplate[1])
      ? agentDef.argsTemplate[1]
      : undefined;
    let cwdRewriteHint: string | undefined;
    if (runAsUser && runAsUser !== 'root' && /^\/root(\/|$)/.test(cwd)) {
      const lastSegment = cwd.replace(/\/+$/, '').split('/').pop() || 'project';
      const newCwd = `/home/${runAsUser}/projects/${lastSegment}`;
      cwdRewriteHint = `Hinweis: cwd \`${cwd}\` wurde automatisch auf \`${newCwd}\` umgeleitet, weil Agent "${agentName}" als User "${runAsUser}" läuft und /root nicht traversierbar ist.`;
      cwd = newCwd;
    }

    // Check if a session is already running for this cwd
    const existing = await this.sessionRepo.findActiveByCwd(cwd);
    if (existing) {
      return {
        success: false,
        error: `In "${cwd}" läuft bereits ein Project Agent (Task: ${existing.taskId}, Phase: ${existing.currentPhase}). ` +
          `Stoppe ihn zuerst mit action=stop, task_id=${existing.taskId}.`,
      };
    }

    // v605 M6 — surface any previous (completed/failed) sessions for the same
    // cwd as informational hint. Not a blocker — just makes it clear that this
    // is a retry, and what the previous attempt's outcome was.
    let previousAttemptHint: string | undefined;
    try {
      const previous = await this.sessionRepo.getCompletedByCwd(cwd);
      if (previous.length > 0) {
        previousAttemptHint = `Vorheriger Versuch in diesem Verzeichnis existiert (Ziel: "${previous[0].goal.slice(0, 80)}..."). Diese neue Session läuft frisch — keine Daten werden weitergeführt.`;
      }
    } catch { /* non-critical */ }

    // Resolve build/test commands from input, template, or defaults
    const template = this.config.templates?.find(t => t.name === input.template);
    const buildCommands = (input.buildCommands as string[]) ?? template?.buildCommands ?? ['npm install', 'npm run build'];
    const testCommands = (input.testCommands as string[]) ?? template?.testCommands ?? [];

    // Create session tracking
    const session = await this.sessionRepo.create({
      taskId: crypto.randomUUID(),
      goal,
      cwd,
      agentName,
    });

    const config = {
      goal, cwd, agentName, buildCommands, testCommands,
      maxDurationHours: this.config.defaultMaxDurationHours ?? 8,
      maxFixAttempts: this.config.maxFixAttemptsPerIteration ?? 3,
      buildTimeoutMs: this.config.buildCommandTimeoutMs ?? 300_000,
    };

    // Fire-and-forget: start the runner loop asynchronously
    this.runner.run(session.taskId, config, context.platform, context.chatId).catch((err) => {
      console.error('[project-agent] Runner failed:', err);
    });

    return {
      success: true,
      data: { taskId: session.taskId, goal, cwd, agentName, buildCommands, testCommands, cwdRewriteHint, previousAttemptHint },
      display: `🚀 Project Agent gestartet (${session.taskId})\n` +
        `Ziel: ${goal}\n` +
        `Verzeichnis: ${cwd}\n` +
        `Agent: ${agentName}\n` +
        `Build: ${buildCommands.join(' && ')}\n` +
        (cwdRewriteHint ? `\n⚠️ ${cwdRewriteHint}\n` : '') +
        (previousAttemptHint ? `\nℹ️ ${previousAttemptHint}\n` : '') +
        `Fortschritt wird via Chat gemeldet.`,
    };
  }

  /** Verify the caller owns or is admin for this task. */
  private async verifyTaskAccess(taskId: string, context: SkillContext): Promise<import('@alfred/storage').ProjectAgentSession | null> {
    const session = await this.sessionRepo.getByTaskId(taskId);
    if (!session) return null;
    // Task was started from the same chat, or user is admin
    if (context.chatId === (session as any).chatId) return session;
    if (context.userRole === 'admin') return session;
    return null;
  }

  private async getStatus(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // v605 M4 — explicit "session ended" hint when phase is terminal
    const isTerminal = session.currentPhase === 'done' || session.currentPhase === 'failed';
    const terminalHint = isTerminal
      ? `\n\n⚠️ **Diese Session ist ABGESCHLOSSEN** (phase: ${session.currentPhase}). ` +
        `Interject hat hier keine Wirkung. Für neue Arbeit: \`project_agent action='start'\` mit neuem Goal.`
      : '';
    return {
      success: true,
      data: { ...session, terminated: isTerminal },
      display: `📊 Project Agent Status (${taskId})\n` +
        `Phase: ${session.currentPhase}${isTerminal ? ' (TERMINATED)' : ''}\n` +
        `Iteration: ${session.currentIteration}\n` +
        `Dateien geändert: ${session.totalFilesChanged}\n` +
        `Letzter Build: ${session.lastBuildPassed ? '✅ passed' : '❌ failed'}\n` +
        `Letzter Commit: ${session.lastCommitSha ?? '—'}\n` +
        (session.milestones.length > 0 ? `Milestones: ${session.milestones.join(', ')}` : '') +
        terminalHint,
    };
  }

  private async interject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    const message = input.message as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };
    if (!message) return { success: false, error: 'Missing "message"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // v605 M1 — reject interjections to terminated sessions. Previously the
    // alfred-hallucination "ich habe nachgereicht" happened because interject
    // returned success on completed sessions, leaving messages in an
    // orphan-inbox that no runner ever drained.
    const terminal = session.currentPhase === 'done' || session.currentPhase === 'failed';
    if (terminal) {
      return {
        success: false,
        error: `Project-Agent-Session ${taskId} ist bereits beendet (phase: ${session.currentPhase}). ` +
          `Interject geht nur an LAUFENDE Sessions. Starte eine NEUE Session mit action='start' und neuem Goal.`,
        data: { taskId, sessionPhase: session.currentPhase, terminated: true },
      };
    }

    await pushInterjection(taskId, message);
    return {
      success: true,
      data: { taskId, message },
      display: `📝 Nachricht eingereiht für Project Agent (${taskId}). Wird in der nächsten Iteration berücksichtigt.`,
    };
  }

  private async stopProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // Push stop signal to inbox
    await pushInterjection(taskId, '__STOP__');
    // Also abort via controller if available
    const controller = activeAbortControllers.get(taskId);
    if (controller) controller.abort();

    return {
      success: true,
      data: { taskId, stopped: true },
      display: `⏹ Stop-Signal gesendet an Project Agent (${taskId}). Agent wird nach dem aktuellen Schritt sauber beendet.`,
    };
  }
}
