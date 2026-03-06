import type {
  SkillMetadata,
  SkillContext,
  SkillResult,
  LLMMessage,
  LLMContentBlock,
  ToolCall,
  ToolDefinition,
} from '@alfred/types';
import { Skill } from '../skill.js';
import type { LLMProvider } from '@alfred/llm';
import type { SkillRegistry } from '../skill-registry.js';
import type { SkillSandbox } from '../skill-sandbox.js';
import type { SecurityManager } from '@alfred/security';
import { ActivityTracker } from '../activity-tracker.js';
import type { ProgressCallback } from '../activity-tracker.js';

const DEFAULT_MAX_ITERATIONS = 5;
const MAX_ALLOWED_ITERATIONS = 15;

/**
 * The initial timeout before inactivity-polling kicks in.
 * On fast hardware this is plenty; on slow hardware the
 * ActivityTracker will keep extending as long as there's progress.
 */
const INITIAL_TIMEOUT_MS = 120_000; // 2 minutes

export class DelegateSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'delegate',
    category: 'core',
    description:
      'Delegate a complex sub-task to an autonomous sub-agent that has full tool access. ' +
      'The sub-agent can use shell, web search, calculator, memory, email, and all other tools. ' +
      'Use when a task is independent enough to run in parallel or when it requires a focused, ' +
      'multi-step workflow (e.g. "research X and summarize", "find all TODO files and list them", ' +
      '"check the weather and draft a packing list"). ' +
      'Control depth with max_iterations (default 5, max 15).',
    riskLevel: 'write',
    version: '3.0.0',
    timeoutMs: INITIAL_TIMEOUT_MS,
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task to delegate to the sub-agent. Be specific about what you want.',
        },
        context: {
          type: 'string',
          description: 'Additional context the sub-agent needs (optional)',
        },
        max_iterations: {
          type: 'number',
          description: 'Max tool iterations (1-15). Use higher values for complex multi-step tasks. Default: 5.',
        },
      },
      required: ['task'],
    },
  };

  private onProgress?: ProgressCallback;

  constructor(
    private readonly llm: LLMProvider,
    private readonly skillRegistry?: SkillRegistry,
    private readonly skillSandbox?: SkillSandbox,
    private readonly securityManager?: SecurityManager,
  ) {
    super();
  }

  /**
   * Set a progress callback before execution.
   * The pipeline calls this so the user sees live status updates
   * like "Sub-agent using web_search (2/5)".
   */
  setProgressCallback(cb: ProgressCallback): void {
    this.onProgress = cb;
  }

  /**
   * Create an ActivityTracker for this execution.
   * The sandbox uses this to decide whether to extend or kill.
   */
  createTracker(): ActivityTracker {
    return new ActivityTracker(this.onProgress);
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const task = input.task as string | undefined;
    const additionalContext = input.context as string | undefined;

    if (!task || typeof task !== 'string') {
      return {
        success: false,
        error: 'Missing required field "task"',
      };
    }

    // LLM can control depth — clamp between 1 and max
    const requestedIterations = input.max_iterations as number | undefined;
    const maxIterations = requestedIterations
      ? Math.max(1, Math.min(MAX_ALLOWED_ITERATIONS, Math.round(requestedIterations)))
      : DEFAULT_MAX_ITERATIONS;

    // Use context-level progress callback if available, fall back to instance-level
    const progressCb = context.onProgress ?? this.onProgress;
    const tracker = context.tracker
      ? context.tracker as ActivityTracker
      : new ActivityTracker(progressCb);
    tracker.ping('starting', { maxIterations });

    // Build tools list — exclude 'delegate' to prevent recursion
    const tools = this.buildSubAgentTools();

    const systemPrompt =
      'You are a sub-agent of Alfred, a personal AI assistant. ' +
      'Complete the assigned task using the tools available to you. ' +
      'Work step by step: use tools to gather information, then synthesize a clear result. ' +
      'Be concise and return only the final answer when done.';

    let userContent = task;
    if (additionalContext && typeof additionalContext === 'string') {
      userContent = `${task}\n\nAdditional context: ${additionalContext}`;
    }

    const messages: LLMMessage[] = [
      { role: 'user', content: userContent },
    ];

    try {
      let iteration = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (true) {
        tracker.ping('llm_call', { iteration, maxIterations });

        const response = await this.llm.complete({
          messages,
          system: systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: 8192,
          tier: 'strong',
        });

        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;

        tracker.ping('processing', { iteration, maxIterations });

        // No tool calls or max iterations — we're done
        if (
          !response.toolCalls ||
          response.toolCalls.length === 0 ||
          iteration >= maxIterations
        ) {
          tracker.ping('done', { iteration, maxIterations });
          return {
            success: true,
            data: {
              response: response.content,
              iterations: iteration,
              usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            },
            display: response.content,
          };
        }

        iteration++;

        // Build assistant message with text + tool_use blocks
        const assistantContent: LLMContentBlock[] = [];
        if (response.content) {
          assistantContent.push({ type: 'text', text: response.content });
        }
        for (const tc of response.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // Execute each tool call
        const toolResultBlocks: LLMContentBlock[] = [];
        for (const toolCall of response.toolCalls) {
          tracker.ping('tool_call', { iteration, maxIterations, tool: toolCall.name });

          const result = await this.executeSubAgentTool(toolCall, context);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        messages.push({ role: 'user', content: toolResultBlocks });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Sub-agent failed: ${errorMessage}`,
      };
    }
  }

  private buildSubAgentTools(): ToolDefinition[] {
    if (!this.skillRegistry) return [];

    return this.skillRegistry
      .getAll()
      .filter(s => s.metadata.name !== 'delegate') // prevent recursion
      .map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        inputSchema: s.metadata.inputSchema,
      }));
  }

  private async executeSubAgentTool(
    toolCall: ToolCall,
    context: SkillContext,
  ): Promise<{ content: string; isError?: boolean }> {
    const skill = this.skillRegistry?.get(toolCall.name);
    if (!skill) {
      return { content: `Error: Unknown tool "${toolCall.name}"`, isError: true };
    }

    // Security check
    if (this.securityManager) {
      const evaluation = this.securityManager.evaluate({
        userId: context.userId,
        action: toolCall.name,
        riskLevel: skill.metadata.riskLevel,
        platform: context.platform,
        chatId: context.chatId,
        chatType: context.chatType,
      });

      if (!evaluation.allowed) {
        return {
          content: `Access denied: ${evaluation.reason}`,
          isError: true,
        };
      }
    }

    // Execute via sandbox if available
    if (this.skillSandbox) {
      const result = await this.skillSandbox.execute(skill, toolCall.input, context);
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
      };
    }

    // Fallback: direct execution
    try {
      const result = await skill.execute(toolCall.input, context);
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Skill execution failed: ${msg}`, isError: true };
    }
  }
}
