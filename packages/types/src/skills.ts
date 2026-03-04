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
  /** ActivityTracker instance (avoid circular dep with skills package). */
  tracker?: unknown;
  /** Progress callback for reporting status updates. */
  onProgress?: (status: string) => void;
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
