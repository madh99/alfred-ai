import type { RiskLevel } from './security.js';

export interface SkillMetadata {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  version: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillContext {
  userId: string;
  chatId: string;
  chatType?: string;
  platform: string;
  conversationId: string;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
  display?: string;
}
