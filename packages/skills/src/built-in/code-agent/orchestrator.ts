import type { LLMProvider } from '@alfred/llm';
import type { CodeAgentDefinitionConfig, ForgeConfig } from '@alfred/types';
import { executeAgent, type AgentExecutionResult } from './agent-executor.js';
import {
  gitStatus,
  gitCreateBranch,
  gitStageAll,
  gitCommit,
  gitPush,
  slugifyBranch,
  type GitCommitResult,
} from './git-ops.js';
import { createForgeClient, type PullRequestResult } from './forge-client.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  agent: string;
  prompt: string;
  description: string;
}

export interface OrchestrationPlan {
  subtasks: SubTask[];
  reasoning: string;
}

export interface SubTaskResult {
  subtask: SubTask;
  execution: AgentExecutionResult;
}

export interface OrchestrationResult {
  plan: OrchestrationPlan;
  iterations: number;
  subtaskResults: SubTaskResult[];
  allModifiedFiles: string[];
  summary: string;
  totalDurationMs: number;
}

export interface OrchestrationOptions {
  maxIterations?: number;
  maxConcurrent?: number;
  onProgress?: (status: string) => void;
}

export interface GitOrchestrationOptions extends OrchestrationOptions {
  forge?: ForgeConfig;
  prTitle?: string;
  baseBranch?: string;
  cwd?: string;
}

export interface GitInfo {
  branch?: string;
  commit?: GitCommitResult;
  pullRequest?: PullRequestResult;
  warnings: string[];
}

export interface GitOrchestrationResult extends OrchestrationResult {
  git: GitInfo;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ITERATIONS_LIMIT = 5;
const DEFAULT_MAX_CONCURRENT = 3;
const STDOUT_LIMIT = 2048;
const STDERR_LIMIT = 1024;

// ── LLM Prompt Templates ───────────────────────────────────────────────────

const PLANNING_SYSTEM = `You are a task planner for a multi-agent coding system.
You receive a high-level task and a list of available coding agents.
Your job is to decompose the task into concrete subtasks, each assigned to an agent.

Rules:
- Each subtask must specify an agent name from the available agents list.
- Each subtask prompt must be self-contained: the agent has no context beyond the prompt.
- Keep subtasks independent when possible so they can run in parallel.
- Use as few subtasks as needed — do not over-decompose.

Respond with ONLY valid JSON (no markdown fences):
{
  "reasoning": "Brief explanation of your decomposition strategy",
  "subtasks": [
    { "id": "task-1", "agent": "<agent-name>", "prompt": "<detailed prompt>", "description": "<short description>" }
  ]
}`;

const VALIDATION_SYSTEM = `You are a code review validator for a multi-agent coding system.
You receive the original task and the results from each subtask execution.
Your job is to determine if the task was completed successfully.

If all subtasks succeeded and the original task is fulfilled, approve.
If there are failures or missing work, provide fix tasks.

Respond with ONLY valid JSON (no markdown fences):
{
  "approved": true/false,
  "summary": "Overall summary of what was accomplished",
  "fixTasks": [
    { "id": "fix-1", "agent": "<agent-name>", "prompt": "<detailed fix prompt>", "description": "<short description>" }
  ]
}`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n[...truncated]';
}

function parseJSON<T>(raw: string): T {
  // Strip markdown code fences if the LLM wraps them
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
  return JSON.parse(cleaned) as T;
}

// ── Semaphore for concurrency control ───────────────────────────────────────

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── Planning ────────────────────────────────────────────────────────────────

async function planSubtasks(
  task: string,
  agents: CodeAgentDefinitionConfig[],
  llm: LLMProvider,
): Promise<OrchestrationPlan> {
  const agentList = agents
    .map((a) => `- ${a.name}: command="${a.command}"`)
    .join('\n');

  const userPrompt = `Available agents:\n${agentList}\n\nTask:\n${task}`;

  const response = await llm.complete({
    system: PLANNING_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.2,
    tier: 'strong',
  });

  const plan = parseJSON<OrchestrationPlan>(response.content);

  if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    throw new Error('LLM returned an empty plan with no subtasks');
  }

  // Validate agent names
  const agentNames = new Set(agents.map((a) => a.name));
  for (const st of plan.subtasks) {
    if (!agentNames.has(st.agent)) {
      throw new Error(
        `Plan references unknown agent "${st.agent}". Available: ${[...agentNames].join(', ')}`,
      );
    }
  }

  return plan;
}

// ── Parallel Execution ──────────────────────────────────────────────────────

async function executeSubtasksParallel(
  subtasks: SubTask[],
  agentMap: Map<string, CodeAgentDefinitionConfig>,
  maxConcurrent: number,
  onProgress?: (status: string) => void,
): Promise<SubTaskResult[]> {
  const semaphore = new Semaphore(maxConcurrent);
  const results: SubTaskResult[] = [];

  const promises = subtasks.map(async (subtask) => {
    await semaphore.acquire();
    try {
      onProgress?.(`Running ${subtask.id}: ${subtask.description}`);
      const agentDef = agentMap.get(subtask.agent)!;
      const execution = await executeAgent(agentDef, subtask.prompt, {
        onProgress: onProgress
          ? (status: string) => onProgress(`[${subtask.id}] ${status}`)
          : undefined,
      });
      const result: SubTaskResult = { subtask, execution };
      results.push(result);
      onProgress?.(
        `Completed ${subtask.id}: exit=${execution.exitCode}, ${execution.modifiedFiles.length} files modified`,
      );
      return result;
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(promises);
  return results;
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ValidationResult {
  approved: boolean;
  summary: string;
  fixTasks: SubTask[];
}

async function validateResults(
  task: string,
  results: SubTaskResult[],
  llm: LLMProvider,
): Promise<ValidationResult> {
  const resultSummaries = results
    .map((r) => {
      const stdout = truncate(r.execution.stdout, STDOUT_LIMIT);
      const stderr = truncate(r.execution.stderr, STDERR_LIMIT);
      return [
        `### ${r.subtask.id} (${r.subtask.description})`,
        `Agent: ${r.subtask.agent}`,
        `Exit code: ${r.execution.exitCode}`,
        `Modified files: ${r.execution.modifiedFiles.join(', ') || 'none'}`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const userPrompt = `Original task:\n${task}\n\nResults:\n${resultSummaries}`;

  const response = await llm.complete({
    system: VALIDATION_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.2,
    tier: 'strong',
  });

  try {
    const parsed = parseJSON<ValidationResult>(response.content);
    return {
      approved: parsed.approved ?? true,
      summary: parsed.summary ?? '',
      fixTasks: Array.isArray(parsed.fixTasks) ? parsed.fixTasks : [],
    };
  } catch {
    // If validation JSON is unparseable, assume approved to avoid infinite loops
    return { approved: true, summary: response.content, fixTasks: [] };
  }
}

// ── Main Orchestration Loop ─────────────────────────────────────────────────

export async function orchestrate(
  task: string,
  agents: CodeAgentDefinitionConfig[],
  llm: LLMProvider,
  options: OrchestrationOptions = {},
): Promise<OrchestrationResult> {
  const maxIterations = Math.min(
    options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    MAX_ITERATIONS_LIMIT,
  );
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const onProgress = options.onProgress;

  const startTime = Date.now();
  const agentMap = new Map(agents.map((a) => [a.name, a]));

  // Step 1: Plan
  onProgress?.('Planning subtasks...');
  const plan = await planSubtasks(task, agents, llm);
  onProgress?.(`Plan created: ${plan.subtasks.length} subtask(s) — ${plan.reasoning}`);

  let allResults: SubTaskResult[] = [];
  let currentTasks = plan.subtasks;
  let iteration = 0;
  let summary = '';

  while (iteration < maxIterations) {
    iteration++;

    // Step 2: Execute
    onProgress?.(`Iteration ${iteration}: executing ${currentTasks.length} subtask(s)...`);
    const iterationResults = await executeSubtasksParallel(
      currentTasks,
      agentMap,
      maxConcurrent,
      onProgress,
    );
    allResults = allResults.concat(iterationResults);

    // Step 3: Validate
    onProgress?.(`Iteration ${iteration}: validating results...`);
    const validation = await validateResults(task, allResults, llm);
    summary = validation.summary;

    if (validation.approved || validation.fixTasks.length === 0) {
      break;
    }

    // Validate fix task agent names
    const validFixTasks = validation.fixTasks.filter((ft) => {
      if (!agentMap.has(ft.agent)) {
        onProgress?.(`Warning: fix task "${ft.id}" references unknown agent "${ft.agent}", skipping`);
        return false;
      }
      return true;
    });

    if (validFixTasks.length === 0) {
      break;
    }

    currentTasks = validFixTasks;
    onProgress?.(`Validation requested ${validFixTasks.length} fix task(s), iterating...`);
  }

  // Collect all modified files (deduplicated)
  const allModifiedFiles = [
    ...new Set(allResults.flatMap((r) => r.execution.modifiedFiles)),
  ].sort();

  return {
    plan,
    iterations: iteration,
    subtaskResults: allResults,
    allModifiedFiles,
    summary,
    totalDurationMs: Date.now() - startTime,
  };
}

// ── Git-aware Orchestration Wrapper ─────────────────────────────────────────

export async function orchestrateWithGit(
  task: string,
  agents: CodeAgentDefinitionConfig[],
  llm: LLMProvider,
  options: GitOrchestrationOptions = {},
): Promise<GitOrchestrationResult> {
  const onProgress = options.onProgress;
  const cwd = options.cwd ?? process.cwd();
  const gitInfo: GitInfo = { warnings: [] };

  // 1. Check git status
  const status = await gitStatus({ cwd });
  if (!status.isRepo) {
    gitInfo.warnings.push('Not a git repository — skipping git operations');
    onProgress?.('Warning: not a git repository, skipping git operations');
    const result = await orchestrate(task, agents, llm, options);
    return { ...result, git: gitInfo };
  }

  // 2. Create branch
  const branchName = slugifyBranch(task);
  try {
    await gitCreateBranch(branchName, { cwd });
    gitInfo.branch = branchName;
    onProgress?.(`Created branch: ${branchName}`);
  } catch (err) {
    // Branch already exists — this is fatal per the plan
    throw new Error(`Failed to create branch "${branchName}": ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Run orchestration (unchanged)
  const result = await orchestrate(task, agents, llm, options);

  // 4. Stage + commit
  try {
    await gitStageAll({ cwd });
    const commitMsg = `feat: ${task.slice(0, 72)}\n\nOrchestrated by Alfred (${result.iterations} iteration(s), ${result.allModifiedFiles.length} file(s))`;
    const commitResult = await gitCommit(commitMsg, { cwd });
    gitInfo.commit = commitResult;
    onProgress?.(`Committed: ${commitResult.sha} (${commitResult.filesChanged} files changed)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gitInfo.warnings.push(`Commit failed: ${msg}`);
    onProgress?.(`Warning: commit failed — ${msg}`);
    return { ...result, git: gitInfo };
  }

  // 5. Push + PR (only if forge is configured)
  const forgeConfig = options.forge;
  if (!forgeConfig) {
    gitInfo.warnings.push('No forge configured — skipping push and PR creation');
    onProgress?.('No forge configured, skipping push and PR');
    return { ...result, git: gitInfo };
  }

  try {
    await gitPush('origin', branchName, { cwd });
    onProgress?.(`Pushed branch: ${branchName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gitInfo.warnings.push(`Push failed: ${msg}`);
    onProgress?.(`Warning: push failed — ${msg}`);
    return { ...result, git: gitInfo };
  }

  try {
    const forge = createForgeClient(forgeConfig);
    const baseBranch = options.baseBranch ?? forgeConfig.baseBranch ?? 'main';
    const prTitle = options.prTitle ?? `feat: ${task.slice(0, 72)}`;
    const prBody = [
      `## Summary`,
      result.summary,
      '',
      `**Iterations:** ${result.iterations}`,
      `**Modified files:** ${result.allModifiedFiles.length}`,
      result.allModifiedFiles.map((f) => `- \`${f}\``).join('\n'),
      '',
      '_Automated by Alfred_',
    ].join('\n');

    const pr = await forge.createPullRequest({
      title: prTitle,
      body: prBody,
      head: branchName,
      base: baseBranch,
    });
    gitInfo.pullRequest = pr;
    onProgress?.(`PR created: ${pr.url}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gitInfo.warnings.push(`PR creation failed: ${msg}`);
    onProgress?.(`Warning: PR creation failed — ${msg}`);
  }

  return { ...result, git: gitInfo };
}
