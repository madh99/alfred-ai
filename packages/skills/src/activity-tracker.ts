/**
 * Tracks agent activity for intelligent timeout management.
 *
 * Instead of a hard timeout, the sandbox polls the tracker:
 * if the agent pinged recently, it's still working → extend.
 * If it went silent for too long → kill it.
 *
 * Also relays status updates to a progress callback so the
 * parent (and ultimately the user) can see what the agent is doing.
 */
export type AgentState = 'starting' | 'llm_call' | 'tool_call' | 'processing' | 'done';

export interface ActivitySnapshot {
  state: AgentState;
  iteration: number;
  maxIterations: number;
  lastPingAt: number;
  idleMs: number;
  currentTool?: string;
  totalElapsedMs: number;
  history: ActivityEntry[];
}

export interface ActivityEntry {
  state: AgentState;
  tool?: string;
  iteration: number;
  timestamp: number;
}

export type ProgressCallback = (status: string) => void;

export class ActivityTracker {
  private state: AgentState = 'starting';
  private iteration = 0;
  private maxIterations = 0;
  private currentTool?: string;
  private lastPingAt: number;
  private readonly startedAt: number;
  private readonly history: ActivityEntry[] = [];
  private readonly onProgress?: ProgressCallback;

  constructor(onProgress?: ProgressCallback) {
    this.startedAt = Date.now();
    this.lastPingAt = Date.now();
    this.onProgress = onProgress;
  }

  /**
   * Called by the agent at every meaningful step.
   * Resets the inactivity timer and reports status upward.
   */
  ping(state: AgentState, meta?: { iteration?: number; maxIterations?: number; tool?: string }): void {
    this.state = state;
    this.lastPingAt = Date.now();
    if (meta?.iteration !== undefined) this.iteration = meta.iteration;
    if (meta?.maxIterations !== undefined) this.maxIterations = meta.maxIterations;
    this.currentTool = meta?.tool;

    this.history.push({
      state,
      tool: meta?.tool,
      iteration: this.iteration,
      timestamp: this.lastPingAt,
    });

    // Report to parent
    if (this.onProgress) {
      this.onProgress(this.formatStatus());
    }
  }

  /** How long since last activity, in ms. */
  getIdleMs(): number {
    return Date.now() - this.lastPingAt;
  }

  /** Total elapsed time since agent started. */
  getTotalElapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Current human-readable status string. */
  formatStatus(): string {
    const iter = this.maxIterations > 0
      ? ` (${this.iteration}/${this.maxIterations})`
      : '';

    switch (this.state) {
      case 'starting':
        return `Sub-agent starting...`;
      case 'llm_call':
        return `Sub-agent thinking...${iter}`;
      case 'tool_call':
        return this.currentTool
          ? `Sub-agent using ${this.currentTool}${iter}`
          : `Sub-agent using tool...${iter}`;
      case 'processing':
        return `Sub-agent processing...${iter}`;
      case 'done':
        return `Sub-agent done${iter}`;
      default:
        return `Sub-agent working...${iter}`;
    }
  }

  /** Full snapshot for logging / debugging. */
  getSnapshot(): ActivitySnapshot {
    return {
      state: this.state,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      lastPingAt: this.lastPingAt,
      idleMs: this.getIdleMs(),
      currentTool: this.currentTool,
      totalElapsedMs: this.getTotalElapsedMs(),
      history: [...this.history],
    };
  }
}
