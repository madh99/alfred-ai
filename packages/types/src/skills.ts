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
