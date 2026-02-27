import type { RiskLevel } from './security.js';

export interface SkillMetadata {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  version: string;
  inputSchema: Record<string, unknown>;
  /** Custom timeout in ms. Skills that make LLM calls (e.g. delegate) need more time. */
  timeoutMs?: number;
}

export interface SkillContext {
  userId: string;
  chatId: string;
  chatType?: string;
  platform: string;
  conversationId: string;
  /** User timezone (from profile) or server timezone as fallback. */
  timezone?: string;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  display?: string;
}
