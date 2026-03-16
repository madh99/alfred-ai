import type { RiskLevel } from './security.js';

export type SkillCategory =
  | 'core'           // memory, profile, configure, delegate — always included
  | 'productivity'   // todo, note, reminder, calendar, contacts, email
  | 'information'    // web_search, weather, calculator, system_info
  | 'media'          // tts, screenshot, clipboard, browser
  | 'automation'     // background_task, scheduled_task, shell, code_sandbox, code_agent
  | 'files'          // file, document, http
  | 'infrastructure' // proxmox, unifi, homeassistant, docker
  | 'identity'       // cross_platform
  | 'mcp';           // MCP-based skills

export interface SkillMetadata {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  version: string;
  inputSchema: Record<string, unknown>;
  /** Custom timeout in ms. Skills that make LLM calls (e.g. delegate) need more time. */
  timeoutMs?: number;
  /** Skill category for context-based filtering. Defaults to 'core' if omitted. */
  category?: SkillCategory;
}

export interface SkillContext {
  userId: string;
  chatId: string;
  chatType?: string;
  platform: string;
  conversationId: string;
  /** Resolved cross-platform master user ID (internal DB UUID of the linked master).
   *  Falls back to userId when accounts are not linked. Use this for data storage
   *  (memories, notes, embeddings) so linked accounts share data. */
  masterUserId?: string;
  /** All platform user IDs for linked accounts (e.g. ["5060785419", "@user:matrix.org"]).
   *  Used to find data stored under any linked platform ID (backward compat). */
  linkedPlatformUserIds?: string[];
  /** User timezone (from profile) or server timezone as fallback. */
  timezone?: string;
  /** Alfred user role (admin/user/family/guest). Undefined = unregistered. */
  userRole?: string;
  /** Alfred user ID (internal UUID from alfred_users table). */
  alfredUserId?: string;
  /** Resolver for per-user service configs (email, bmw, calendar etc.). */
  userServiceResolver?: {
    getServiceConfig(alfredUserId: string | undefined, serviceType: string, serviceName?: string): Promise<Record<string, unknown> | null>;
    getUserServices(alfredUserId: string | undefined, serviceType?: string): Promise<Array<{ serviceType: string; serviceName: string; config: Record<string, unknown> }>>;
    saveServiceConfig(alfredUserId: string, serviceType: string, serviceName: string, config: Record<string, unknown>): Promise<void>;
    removeServiceConfig(alfredUserId: string, serviceType: string, serviceName: string): Promise<boolean>;
  };
  /** HA cluster node ID (set when cluster.enabled). */
  nodeId?: string;
  /** Whether HA cluster mode is active. */
  clusterEnabled?: boolean;
  /** ActivityTracker instance (avoid circular dep with skills package). */
  tracker?: unknown;
  /** Progress callback for reporting status updates. */
  onProgress?: (status: string) => void;
  /** Iteration callback for checkpoint support in persistent agents.
   *  Called by DelegateSkill after each tool-use iteration. */
  onIteration?: (data: { iteration: number; maxIterations: number; messages: unknown[]; dataStore?: Record<string, string> }) => void;
  /** Saved checkpoint state for resuming a persistent agent from where it left off.
   *  When set, DelegateSkill restores conversation history, iteration counter, and data store. */
  resumeState?: {
    conversationHistory: unknown[];
    currentIteration: number;
    totalIterations: number;
    dataStore?: Record<string, string>;
  };
  /** AbortSignal for cooperative cancellation (e.g. pause). */
  abortSignal?: AbortSignal;
}

export interface SkillResultAttachment {
  fileName: string;
  data: Buffer;
  mimeType: string;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  display?: string;
  attachments?: SkillResultAttachment[];
}

export interface SkillHealth {
  skillName: string;
  successCount: number;
  failCount: number;
  consecutiveFails: number;
  lastError?: string;
  lastErrorAt?: string;
  disabledUntil?: string;
  updatedAt: string;
}
