import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig, ForgeConfig } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Skill } from '../../skill.js';
import { executeAgent } from './agent-executor.js';
import { orchestrate, orchestrateWithGit, type OrchestrationResult, type GitOrchestrationResult } from './orchestrator.js';

const execFileAsync = promisify(execFile);

export interface CodeAgentSkillConfig {
  agents: CodeAgentDefinitionConfig[];
  forge?: ForgeConfig;
}

export class CodeAgentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'code_agent',
    category: 'automation',
    description:
      'Run a CLI-based coding agent (e.g. Claude Code, Codex, Gemini CLI, Aider) as a subprocess. ' +
      'Use action "list_agents" to see available agents, "run" to execute one with a prompt, ' +
      '"orchestrate" to have the LLM decompose a task into parallel subtasks, ' +
      'or "push" to commit and push a project to GitLab/GitHub. ' +
      'IMPORTANT: For git push, ALWAYS use "push" action — NOT "run" with a git prompt. ' +
      'The "push" action handles authentication automatically.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_agents', 'run', 'orchestrate', 'push'],
          description: 'The action to perform. Use "push" for git commit+push (handles auth automatically).',
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
        git: {
          type: 'boolean',
          description: 'Enable git workflow: auto-branch, commit, push, and PR creation (for "orchestrate")',
        },
        prTitle: {
          type: 'string',
          description: 'Custom PR/MR title (used with git=true)',
        },
        baseBranch: {
          type: 'string',
          description: 'Target branch for the PR/MR (default: "main")',
        },
        branch: {
          type: 'string',
          description: 'Branch name for "push" action. If set, creates/switches to this branch before pushing. If not set, pushes the current branch.',
        },
        commitMessage: {
          type: 'string',
          description: 'Commit message for "push" action (default: auto-generated)',
        },
      },
      required: ['action'],
    },
  };

  private readonly agents: Map<string, CodeAgentDefinitionConfig>;
  private readonly forgeConfig?: ForgeConfig;

  constructor(
    config: CodeAgentSkillConfig,
    private readonly llm?: LLMProvider,
  ) {
    super();
    this.agents = new Map(config.agents.map((a) => [a.name, a]));
    this.forgeConfig = config.forge;
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
      case 'push':
        return this.pushProject(input);
      default:
        return {
          success: false,
          error: `Unknown action "${action}". Use "list_agents", "run", "orchestrate", or "push".`,
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
    const useGit = input.git === true;
    const prTitle = typeof input.prTitle === 'string' ? input.prTitle : undefined;
    const baseBranch = typeof input.baseBranch === 'string' ? input.baseBranch : undefined;

    try {
      if (useGit) {
        const result: GitOrchestrationResult = await orchestrateWithGit(
          task,
          selectedAgents,
          this.llm,
          {
            maxIterations,
            onProgress: context.onProgress,
            forge: this.forgeConfig,
            prTitle,
            baseBranch,
          },
        );
        return this.formatGitOrchestrationResult(result);
      }

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

  private formatGitOrchestrationResult(result: GitOrchestrationResult): SkillResult {
    const base = this.formatOrchestrationResult(result);
    const gitParts: string[] = [];
    const { git } = result;

    if (git.branch) {
      gitParts.push(`**Branch:** ${git.branch}`);
    }
    if (git.commit) {
      gitParts.push(`**Commit:** ${git.commit.sha} (${git.commit.filesChanged} files changed)`);
    }
    if (git.pullRequest) {
      gitParts.push(`**PR:** ${git.pullRequest.url} (#${git.pullRequest.number})`);
    }
    for (const warning of git.warnings) {
      gitParts.push(`**Warning:** ${warning}`);
    }

    const gitDisplay = gitParts.length > 0
      ? `\n\n**Git:**\n${gitParts.join('\n')}`
      : '';

    return {
      ...base,
      data: {
        ...(base.data as Record<string, unknown>),
        git: {
          branch: git.branch,
          commit: git.commit,
          pullRequest: git.pullRequest,
          warnings: git.warnings,
        },
      },
      display: (base.display ?? '') + gitDisplay,
    };
  }

  // ── Push Action ──────────────────────────────────────────────

  private async pushProject(input: Record<string, unknown>): Promise<SkillResult> {
    const cwd = (input.cwd as string) ?? process.cwd();
    const branch = input.branch as string | undefined;
    const commitMessage = input.commitMessage as string | undefined;
    const warnings: string[] = [];

    try {
      // 1. Ensure git repo exists
      const hasGitDir = existsSync(path.join(cwd, '.git'));
      if (!hasGitDir) {
        // Init new repo
        await execFileAsync('git', ['init'], { cwd });
        await execFileAsync('git', ['add', '-A'], { cwd });
        await execFileAsync('git', ['commit', '-m', commitMessage ?? 'Initial commit'], { cwd });
        warnings.push('Git repository initialized');
      }

      // 2. Switch/create branch if requested
      if (branch) {
        try {
          await execFileAsync('git', ['checkout', '-b', branch], { cwd });
        } catch {
          // Branch might already exist
          try { await execFileAsync('git', ['checkout', branch], { cwd }); } catch { /* stay on current */ }
        }
      }

      // 3. Get current branch
      const { stdout: currentBranch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      const branchName = currentBranch.trim();

      // 4. Stage + commit if there are changes
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
      let commitSha: string | null = null;
      if (statusOut.trim()) {
        await execFileAsync('git', ['add', '-A'], { cwd });
        const msg = commitMessage ?? `feat: update ${path.basename(cwd)}`;
        const { stdout: commitOut } = await execFileAsync('git', ['commit', '-m', msg], { cwd });
        const shaMatch = commitOut.match(/\[[\w/-]+ ([a-f0-9]+)\]/);
        commitSha = shaMatch?.[1] ?? null;
      }

      // 5. Ensure remote exists
      let remoteUrl: string | null = null;
      try {
        const { stdout: remOut } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
        remoteUrl = remOut.trim() || null;
      } catch { remoteUrl = null; }

      // 6. No remote → create repo on forge
      if (!remoteUrl && this.forgeConfig) {
        const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
        if (token) {
          const repoName = path.basename(cwd);
          const baseUrl = this.forgeConfig.gitlab?.baseUrl ?? this.forgeConfig.github?.baseUrl ?? 'https://gitlab.com';

          // Create repo (ignore "already exists" errors)
          try {
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
          } catch { /* might already exist */ }

          // Get username for remote URL
          let username = 'user';
          try {
            if (this.forgeConfig.provider === 'gitlab') {
              const res = await fetch(`${baseUrl}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } });
              const data = await res.json() as { username?: string };
              username = data.username ?? 'user';
            } else {
              const ghBase = this.forgeConfig.github?.baseUrl ?? 'https://api.github.com';
              const res = await fetch(`${ghBase}/user`, { headers: { 'Authorization': `Bearer ${token}` } });
              const data = await res.json() as { login?: string };
              username = data.login ?? 'user';
            }
          } catch { /* use default */ }

          remoteUrl = `${baseUrl}/${username}/${repoName}.git`;
          await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd });
          warnings.push(`Repo "${repoName}" erstellt auf ${this.forgeConfig.provider === 'gitlab' ? 'GitLab' : 'GitHub'}`);
        }
      }

      if (!remoteUrl) {
        return {
          success: false,
          error: 'Kein Git-Remote und keine Forge-Config — Push nicht möglich.',
          data: { branch: branchName, commitSha, warnings },
        };
      }

      // 7. Push with token injection
      const urlHasAuth = /^https?:\/\/[^@]+@/.test(remoteUrl);
      let pushSucceeded = false;

      if (urlHasAuth) {
        await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd });
        pushSucceeded = true;
      } else if (this.forgeConfig) {
        const token = this.forgeConfig.github?.token ?? this.forgeConfig.gitlab?.token;
        if (token) {
          const urlObj = new URL(remoteUrl);
          urlObj.username = 'oauth2';
          urlObj.password = token;
          try {
            await execFileAsync('git', ['remote', 'set-url', 'origin', urlObj.toString()], { cwd });
            await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd });
            pushSucceeded = true;
          } finally {
            // Always restore original URL
            try { await execFileAsync('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd }); } catch { /* best effort */ }
          }
        }
      }

      if (!pushSucceeded) {
        // Try without auth (credential helper might work)
        try {
          await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd });
          pushSucceeded = true;
        } catch (err) {
          return {
            success: false,
            error: `Push fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
            data: { branch: branchName, commitSha, remoteUrl, warnings },
          };
        }
      }

      // Sanitize URL for display
      const displayUrl = remoteUrl.replace(/\/\/[^@]+@/, '//');

      return {
        success: true,
        data: { branch: branchName, commitSha, remoteUrl: displayUrl, pushSucceeded, warnings },
        display: `Git Push erfolgreich:\n` +
          `- Branch: ${branchName}\n` +
          (commitSha ? `- Commit: ${commitSha}\n` : '- Keine neuen Änderungen\n') +
          `- Remote: ${displayUrl}\n` +
          (warnings.length > 0 ? `- Hinweise: ${warnings.join(', ')}` : ''),
      };
    } catch (err) {
      return {
        success: false,
        error: `Git Push fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        data: { warnings },
      };
    }
  }
}
