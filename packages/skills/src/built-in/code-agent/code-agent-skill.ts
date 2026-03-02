import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import { executeAgent } from './agent-executor.js';

export interface CodeAgentSkillConfig {
  agents: CodeAgentDefinitionConfig[];
}

export class CodeAgentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'code_agent',
    description:
      'Run a CLI-based coding agent (e.g. Claude Code, Codex, Gemini CLI, Aider) as a subprocess. ' +
      'Use action "list_agents" to see available agents, or "run" to execute one with a prompt. ' +
      'The agent runs in a specified working directory and returns stdout, stderr, exit code, ' +
      'duration, and a list of files it modified.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 300_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_agents', 'run'],
          description: 'The action to perform',
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

  constructor(config: CodeAgentSkillConfig) {
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
      default:
        return {
          success: false,
          error: `Unknown action "${action}". Use "list_agents" or "run".`,
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
}
