import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig, ProjectAgentsConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { BackgroundTaskRepository, ProjectAgentSessionRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

/** In-memory interjection inbox keyed by task ID. */
const interjectionInbox = new Map<string, string[]>();

export function pushInterjection(taskId: string, message: string): void {
  const inbox = interjectionInbox.get(taskId) ?? [];
  inbox.push(message);
  interjectionInbox.set(taskId, inbox);
}

export function drainInterjections(taskId: string): string[] {
  const messages = interjectionInbox.get(taskId) ?? [];
  interjectionInbox.delete(taskId);
  return messages;
}

export class ProjectAgentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'project_agent',
    category: 'automation',
    description: `Autonomous coding agent that creates and develops software projects end-to-end. Runs indefinitely until the goal is reached.
Actions:
- start: Start a new project agent session. Params: goal (what to build), cwd (directory), agent (which code agent to use, e.g. "claude-code"), buildCommands (optional, e.g. ["npm install", "npm run build"]), testCommands (optional), template (optional, e.g. "nextjs")
- status: Check current status of a running project agent. Params: task_id
- interject: Send a message to a running project agent (e.g. "add feature X"). Params: task_id, message
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

  constructor(
    config: ProjectAgentsConfig & { agents: CodeAgentDefinitionConfig[] },
    private readonly llm: LLMProvider,
    private readonly taskRepo: BackgroundTaskRepository,
    private readonly sessionRepo: ProjectAgentSessionRepository,
  ) {
    super();
    this.config = config;
    this.agents = new Map(config.agents.map(a => [a.name, a]));
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'start':
        return this.startProject(input, context);
      case 'status':
        return this.getStatus(input);
      case 'interject':
        return this.interject(input);
      case 'stop':
        return this.stopProject(input);
      default:
        return { success: false, error: `Unknown action "${action}". Use start, status, interject, or stop.` };
    }
  }

  private async startProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const goal = input.goal as string | undefined;
    const cwd = input.cwd as string | undefined;
    const agentName = (input.agent as string) ?? [...this.agents.keys()][0];

    if (!goal) return { success: false, error: 'Missing required field "goal"' };
    if (!cwd) return { success: false, error: 'Missing required field "cwd"' };

    const agentDef = this.agents.get(agentName);
    if (!agentDef) {
      return { success: false, error: `Unknown agent "${agentName}". Available: ${[...this.agents.keys()].join(', ')}` };
    }

    // Resolve build/test commands from input, template, or defaults
    const template = this.config.templates?.find(t => t.name === input.template);
    const buildCommands = (input.buildCommands as string[]) ?? template?.buildCommands ?? ['npm install', 'npm run build'];
    const testCommands = (input.testCommands as string[]) ?? template?.testCommands ?? [];

    const maxDurationHours = this.config.defaultMaxDurationHours ?? 8;

    // Create background task
    const task = this.taskRepo.create(
      context.userId,
      context.platform,
      context.chatId,
      `Project Agent: ${goal.slice(0, 100)}`,
      'project_agent',
      JSON.stringify({
        goal, cwd, agentName, buildCommands, testCommands, maxDurationHours,
        maxFixAttempts: this.config.maxFixAttemptsPerIteration ?? 3,
        buildTimeoutMs: this.config.buildCommandTimeoutMs ?? 300_000,
      }),
    );

    // Create session tracking
    this.sessionRepo.create({
      taskId: task.id,
      goal,
      cwd,
      agentName,
    });

    return {
      success: true,
      data: { taskId: task.id, goal, cwd, agentName, buildCommands, testCommands },
      display: `🚀 Project Agent gestartet (${task.id})\n` +
        `Ziel: ${goal}\n` +
        `Verzeichnis: ${cwd}\n` +
        `Agent: ${agentName}\n` +
        `Build: ${buildCommands.join(' && ')}\n` +
        `Fortschritt wird via Chat gemeldet.`,
    };
  }

  private getStatus(input: Record<string, unknown>): SkillResult {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    const session = this.sessionRepo.getByTaskId(taskId);
    if (!session) return { success: false, error: `No project agent session found for task ${taskId}` };

    const task = this.taskRepo.getById(taskId);

    return {
      success: true,
      data: session,
      display: `📊 Project Agent Status (${taskId})\n` +
        `Phase: ${session.currentPhase}\n` +
        `Iteration: ${session.currentIteration}\n` +
        `Dateien geändert: ${session.totalFilesChanged}\n` +
        `Letzter Build: ${session.lastBuildPassed ? '✅ passed' : '❌ failed'}\n` +
        `Letzter Commit: ${session.lastCommitSha ?? '—'}\n` +
        `Task-Status: ${task?.status ?? 'unknown'}\n` +
        (session.milestones.length > 0 ? `Milestones: ${session.milestones.join(', ')}` : ''),
    };
  }

  private interject(input: Record<string, unknown>): SkillResult {
    const taskId = input.task_id as string | undefined;
    const message = input.message as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };
    if (!message) return { success: false, error: 'Missing "message"' };

    pushInterjection(taskId, message);
    return {
      success: true,
      data: { taskId, message },
      display: `📝 Nachricht eingereiht für Project Agent (${taskId}). Wird in der nächsten Iteration berücksichtigt.`,
    };
  }

  private stopProject(input: Record<string, unknown>): SkillResult {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    pushInterjection(taskId, '__STOP__');
    return {
      success: true,
      data: { taskId, stopped: true },
      display: `⏹ Stop-Signal gesendet an Project Agent (${taskId}). Agent wird nach dem aktuellen Schritt sauber beendet.`,
    };
  }
}
