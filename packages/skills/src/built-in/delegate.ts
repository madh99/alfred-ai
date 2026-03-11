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

const DEFAULT_MAX_ITERATIONS = 15;
const MAX_ALLOWED_ITERATIONS = 25;

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
      'Delegate a sub-task to an autonomous sub-agent that requires ITERATIVE work — ' +
      'multiple rounds of tool calls with intermediate reasoning ' +
      '(e.g. "research X across multiple sources and synthesize", "search emails for invoices and compile a list"). ' +
      'Do NOT use for simple lookups or single-skill queries — call those skills directly. ' +
      'The sub-agent has full tool access (shell, web search, memory, email, etc.). ' +
      'Control depth with max_iterations (default 15, max 25).',
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
          description: 'Max tool iterations (1-25). Default: 15.',
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

    // Restore data store from checkpoint or start fresh
    const dataStore = new Map<string, string>();
    let dataStoreCounter = 0;

    if (context.resumeState?.dataStore) {
      for (const [key, value] of Object.entries(context.resumeState.dataStore)) {
        dataStore.set(key, value);
        // Track highest counter to avoid ID collisions
        const match = key.match(/^result_(\d+)$/);
        if (match) {
          dataStoreCounter = Math.max(dataStoreCounter, Number(match[1]));
        }
      }
    }

    const systemPrompt =
      'You are a sub-agent of Alfred, a personal AI assistant. ' +
      'Complete the assigned task using the tools available to you. ' +
      'Work step by step: use tools to gather information, then synthesize a clear result. ' +
      'Be concise and return only the final answer when done.\n\n' +
      'When tool results contain "[Data stored as result_N]", use code_sandbox with ' +
      'action "run_with_data" and data="result_N" to process the data. ' +
      'The data will be injected as INPUT_DATA (parsed array/object). Never hardcode data in code.\n' +
      'Available JS libraries in code_sandbox (no install needed): exceljs, pdfkit, pdf-parse.';

    let userContent = task;
    if (additionalContext && typeof additionalContext === 'string') {
      userContent = `${task}\n\nAdditional context: ${additionalContext}`;
    }

    // Restore from checkpoint if resuming, otherwise start fresh
    let messages: LLMMessage[];
    let startIteration: number;

    if (context.resumeState?.conversationHistory?.length) {
      messages = context.resumeState.conversationHistory as LLMMessage[];
      startIteration = context.resumeState.currentIteration;
    } else {
      messages = [{ role: 'user', content: userContent }];
      startIteration = 0;
    }

    try {
      let iteration = startIteration;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (true) {
        // Check for cooperative abort (pause/cancel)
        if (context.abortSignal?.aborted) {
          // Force a final checkpoint with latest state before returning
          context.onIteration?.({
            iteration,
            maxIterations,
            messages: [...messages],
            dataStore: Object.fromEntries(dataStore),
          });
          tracker.ping('done', { iteration, maxIterations });
          return {
            success: true,
            data: {
              response: 'Task paused — can be resumed later.',
              iterations: iteration,
              paused: true,
              usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            },
            display: 'Task paused — can be resumed later.',
          };
        }

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

          // Resolve data-store references for code_sandbox
          let execInput = toolCall.input;
          if (toolCall.name === 'code_sandbox' && toolCall.input.data) {
            const ref = String(toolCall.input.data);
            if (dataStore.has(ref)) {
              execInput = { ...toolCall.input, data: dataStore.get(ref)! };
              if (execInput.action === 'run') execInput.action = 'run_with_data';
            }
          }

          const result = await this.executeSubAgentTool(
            { ...toolCall, input: execInput }, context,
          );

          // Store large successful results with auto-ID
          let resultContent = result.content;
          if (!result.isError && resultContent.length > 500) {
            const refId = `result_${++dataStoreCounter}`;
            // Store raw JSON data (for code_sandbox injection), fall back to content
            const storeValue = result.rawData != null
              ? JSON.stringify(result.rawData)
              : resultContent;
            dataStore.set(refId, storeValue);
            resultContent +=
              `\n\n[Data stored as "${refId}" — use code_sandbox action "run_with_data" ` +
              `with data="${refId}" to process this data. Do NOT copy data into code.]`;
          }

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: resultContent,
            is_error: result.isError,
          });
        }

        messages.push({ role: 'user', content: toolResultBlocks });

        // Checkpoint callback for persistent agents
        context.onIteration?.({
          iteration,
          maxIterations,
          messages: [...messages],
          dataStore: Object.fromEntries(dataStore),
        });
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
  ): Promise<{ content: string; isError?: boolean; rawData?: unknown }> {
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
        rawData: result.data,
      };
    }

    // Fallback: direct execution
    try {
      const result = await skill.execute(toolCall.input, context);
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
        rawData: result.data,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Skill execution failed: ${msg}`, isError: true };
    }
  }
}
