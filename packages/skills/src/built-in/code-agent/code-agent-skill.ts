import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import { Skill } from '../../skill.js';
import { executeAgent } from './agent-executor.js';
import { orchestrate, type OrchestrationResult } from './orchestrator.js';

export interface CodeAgentSkillConfig {
  agents: CodeAgentDefinitionConfig[];
}

export class CodeAgentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'code_agent',
    description:
      'Run a CLI-based coding agent (e.g. Claude Code, Codex, Gemini CLI, Aider) as a subprocess. ' +
      'Use action "list_agents" to see available agents, "run" to execute one with a prompt, ' +
      'or "orchestrate" to have the LLM decompose a task into parallel subtasks. ' +
      'The agent runs in a specified working directory and returns stdout, stderr, exit code, ' +
      'duration, and a list of files it modified.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_agents', 'run', 'orchestrate'],
          description: 'The action to perform',
        },
        task: {
          type: 'string',
          description: 'High-level task description for "orchestrate" action',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional agent name filter for "orchestrate" (uses all agents if omitted)',
        },
        maxIterations: {
          type: 'number',
          description: 'Max validation iterations for "orchestrate" (1-5, default 3)',
        },
        agent: {
          type: 'string',
          description: 'Name of the agent to run (required for "run" action)',
        },
        prompt: {
          type: 'string',
          description: 'The prompt / task description to send to the agent (required for "run" action)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the agent (optional, uses agent default or process.cwd())',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (optional, max 900000)',
        },
      },
      required: ['action'],
    },
  };

  private readonly agents: Map<string, CodeAgentDefinitionConfig>;

  constructor(
    config: CodeAgentSkillConfig,
    private readonly llm?: LLMProvider,
  ) {
    super();
    this.agents = new Map(config.agents.map((a) => [a.name, a]));
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'list_agents':
        return this.listAgents();
      case 'run':
        return this.runAgent(input, context);
      case 'orchestrate':
        return this.orchestrateTask(input, context);
      default:
        return {
          success: false,
          error: `Unknown action "${action}". Use "list_agents", "run", or "orchestrate".`,
        };
    }
  }

  private listAgents(): SkillResult {
    const agentList = [...this.agents.values()].map((a) => ({
      name: a.name,
      command: a.command,
      promptVia: a.promptVia ?? 'arg',
      timeoutMs: a.timeoutMs,
    }));

    const display = agentList.length === 0
      ? 'No code agents configured.'
      : agentList
          .map((a) => `- **${a.name}**: \`${a.command}\` (prompt via ${a.promptVia})`)
          .join('\n');

    return {
      success: true,
      data: { agents: agentList },
      display: `Available code agents:\n${display}`,
    };
  }

  private async runAgent(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const agentName = input.agent as string | undefined;
    const prompt = input.prompt as string | undefined;

    if (!agentName || typeof agentName !== 'string') {
      return { success: false, error: 'Missing required field "agent"' };
    }
    if (!prompt || typeof prompt !== 'string') {
      return { success: false, error: 'Missing required field "prompt"' };
    }

    const agentDef = this.agents.get(agentName);
    if (!agentDef) {
      const available = [...this.agents.keys()].join(', ');
      return {
        success: false,
        error: `Unknown agent "${agentName}". Available: ${available}`,
      };
    }

    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
    const timeoutMs = typeof input.timeout === 'number' ? input.timeout : undefined;

    const result = await executeAgent(agentDef, prompt, {
      cwd,
      timeoutMs,
      onProgress: context.onProgress,
    });

    const parts: string[] = [];
    if (result.stdout) parts.push(`**stdout:**\n\`\`\`\n${result.stdout}\n\`\`\``);
    if (result.stderr) parts.push(`**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\``);
    if (parts.length === 0) parts.push('(no output)');
    parts.push(`**Exit code:** ${result.exitCode}`);
    parts.push(`**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.modifiedFiles.length > 0) {
      parts.push(`**Modified files:**\n${result.modifiedFiles.map((f) => `- ${f}`).join('\n')}`);
    }

    return {
      success: result.exitCode === 0,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        modifiedFiles: result.modifiedFiles,
      },
      display: parts.join('\n\n'),
      ...(result.exitCode !== 0 && {
        error: result.exitCode === 124
          ? `Agent "${agentName}" timed out`
          : `Agent "${agentName}" exited with code ${result.exitCode}`,
      }),
    };
  }

  private async orchestrateTask(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    if (!this.llm) {
      return {
        success: false,
        error: 'Orchestration requires an LLM provider but none was configured.',
      };
    }

    const task = input.task as string | undefined;
    if (!task || typeof task !== 'string') {
      return { success: false, error: 'Missing required field "task" for orchestrate action.' };
    }

    // Resolve agent filter
    let selectedAgents = [...this.agents.values()];
    const agentFilter = input.agents as string[] | undefined;
    if (Array.isArray(agentFilter) && agentFilter.length > 0) {
      selectedAgents = agentFilter
        .map((name) => this.agents.get(name))
        .filter((a): a is CodeAgentDefinitionConfig => a !== undefined);
      if (selectedAgents.length === 0) {
        const available = [...this.agents.keys()].join(', ');
        return {
          success: false,
          error: `None of the specified agents exist. Available: ${available}`,
        };
      }
    }

    const maxIterations = typeof input.maxIterations === 'number'
      ? input.maxIterations
      : undefined;

    try {
      const result: OrchestrationResult = await orchestrate(
        task,
        selectedAgents,
        this.llm,
        {
          maxIterations,
          onProgress: context.onProgress,
        },
      );

      return this.formatOrchestrationResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Orchestration failed: ${message}` };
    }
  }

  private formatOrchestrationResult(result: OrchestrationResult): SkillResult {
    const parts: string[] = [];

    parts.push(`**Orchestration completed in ${result.iterations} iteration(s)**`);
    parts.push(`**Plan:** ${result.plan.reasoning}`);
    parts.push(`**Duration:** ${(result.totalDurationMs / 1000).toFixed(1)}s`);

    for (const sr of result.subtaskResults) {
      const status = sr.execution.exitCode === 0 ? 'OK' : `FAIL (exit ${sr.execution.exitCode})`;
      parts.push(`- **${sr.subtask.id}** [${sr.subtask.agent}]: ${sr.subtask.description} — ${status}`);
    }

    if (result.allModifiedFiles.length > 0) {
      parts.push(`\n**Modified files:**\n${result.allModifiedFiles.map((f) => `- ${f}`).join('\n')}`);
    }

    if (result.summary) {
      parts.push(`\n**Summary:** ${result.summary}`);
    }

    const hasFailures = result.subtaskResults.some((r) => r.execution.exitCode !== 0);

    return {
      success: !hasFailures,
      data: {
        plan: result.plan,
        iterations: result.iterations,
        subtaskResults: result.subtaskResults.map((sr) => ({
          id: sr.subtask.id,
          agent: sr.subtask.agent,
          description: sr.subtask.description,
          exitCode: sr.execution.exitCode,
          modifiedFiles: sr.execution.modifiedFiles,
          durationMs: sr.execution.durationMs,
        })),
        allModifiedFiles: result.allModifiedFiles,
        summary: result.summary,
        totalDurationMs: result.totalDurationMs,
      },
      display: parts.join('\n'),
    };
  }
}
