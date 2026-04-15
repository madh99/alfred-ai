import type { Logger } from 'pino';
import type { ActivityRepository, MemoryRepository } from '@alfred/storage';
import type { AsyncDbAdapter } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { ReflectionResult } from './types.js';

type ConversationConfig = {
  repeatQueryThreshold: number;
  repeatSequenceThreshold: number;
  analysisWindowDays: number;
};

export class ConversationReflector {
  constructor(
    private readonly llm: LLMProvider,
    private readonly activityRepo: ActivityRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly adapter: AsyncDbAdapter | undefined,
    private readonly logger: Logger,
    private readonly config: ConversationConfig,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult[]> {
    const results: ReflectionResult[] = [];

    try {
      const seqResults = await this.checkRepeatedSequences();
      results.push(...seqResults);
    } catch (err) {
      this.logger.warn({ err }, 'ConversationReflector: repeated sequences check failed');
    }

    try {
      const queryResults = await this.checkRepeatedQueries(userId);
      results.push(...queryResults);
    } catch (err) {
      this.logger.warn({ err }, 'ConversationReflector: repeated queries check failed');
    }

    return results;
  }

  /**
   * Check 1: Repeated skill sequences (rule-based, no LLM).
   * Groups consecutive skill_exec events within 5-minute windows,
   * counts pattern occurrences, and suggests workflow creation.
   */
  private async checkRepeatedSequences(): Promise<ReflectionResult[]> {
    const since = new Date(
      Date.now() - this.config.analysisWindowDays * 86400_000,
    ).toISOString();

    const events = await this.activityRepo.query({
      eventType: 'skill_exec',
      since,
      limit: 500,
    });

    if (events.length < 3) return [];

    // Group consecutive skills within 5-minute windows
    const sequences: string[][] = [];
    let current: string[] = [];
    let lastTime = 0;

    for (const event of events) {
      const t = new Date(event.timestamp).getTime();
      if (current.length > 0 && t - lastTime > 5 * 60_000) {
        if (current.length >= 3) sequences.push(current);
        current = [];
      }
      current.push(event.action);
      lastTime = t;
    }
    if (current.length >= 3) sequences.push(current);

    // Count patterns (sorted first 3 skills as key)
    const patternCounts = new Map<string, { count: number; skills: string[] }>();
    for (const seq of sequences) {
      const key = seq.slice(0, 3).sort().join('|');
      const existing = patternCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        patternCounts.set(key, { count: 1, skills: seq.slice(0, 3) });
      }
    }

    const results: ReflectionResult[] = [];
    for (const [, { count, skills }] of patternCounts) {
      if (count >= this.config.repeatSequenceThreshold) {
        const skillList = skills.join(' → ');
        results.push({
          target: { type: 'workflow', name: `Auto: ${skillList}` },
          finding: `Skill-Sequenz "${skillList}" wurde ${count}x wiederholt`,
          action: 'suggest',
          params: { skills, occurrences: count },
          risk: 'confirm',
          reasoning: `Die Sequenz ${skillList} wurde ${count}x in ${this.config.analysisWindowDays} Tagen ausgefuehrt (Schwellwert: ${this.config.repeatSequenceThreshold}). Workflow-Erstellung vorgeschlagen.`,
        });
      }
    }

    return results;
  }

  /**
   * Check 2: Repeated queries (LLM-based).
   * Queries user messages from the DB, sends to LLM for pattern detection.
   */
  private async checkRepeatedQueries(userId: string): Promise<ReflectionResult[]> {
    if (!this.adapter) return [];

    const since = new Date(
      Date.now() - this.config.analysisWindowDays * 86400_000,
    ).toISOString();

    const rows = await this.adapter.query(
      `SELECT m.content FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.role = 'user' AND m.created_at >= ?
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [userId, since],
    ) as { content: string }[];

    if (rows.length < 10) return [];

    const messageList = rows
      .map((r, i) => `${i + 1}. ${r.content}`)
      .join('\n');

    const prompt = `Analysiere diese User-Nachrichten und finde wiederkehrende Absichten/Fragen. Nur Muster die >= ${this.config.repeatQueryThreshold}x vorkommen. Antworte NUR als JSON-Array: [{"intent": "...", "count": N, "example": "..."}]. Wenn keine Muster: leeres Array [].

Nachrichten:
${messageList}`;

    let response;
    try {
      response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        system: 'Du bist ein Pattern-Erkennungs-Modul. Antworte ausschliesslich mit validem JSON.',
        maxTokens: 512,
        tier: 'fast',
      });
    } catch (err) {
      this.logger.warn({ err }, 'ConversationReflector: LLM call failed');
      return [];
    }

    let patterns: { intent: string; count: number; example: string }[];
    try {
      // Strip markdown code fences if present
      let raw = response.content.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }
      patterns = JSON.parse(raw);
      if (!Array.isArray(patterns)) return [];
    } catch {
      this.logger.debug('ConversationReflector: Could not parse LLM response as JSON');
      return [];
    }

    const results: ReflectionResult[] = [];
    for (const p of patterns) {
      if (p.count >= this.config.repeatQueryThreshold) {
        results.push({
          target: { type: 'suggestion', name: p.intent },
          finding: `Wiederkehrende Frage: "${p.intent}" (${p.count}x, z.B. "${p.example}")`,
          action: 'suggest',
          params: { intent: p.intent, count: p.count, example: p.example },
          risk: 'confirm',
          reasoning: `User fragt ${p.count}x nach "${p.intent}" (Schwellwert: ${this.config.repeatQueryThreshold}). Automatisierung oder Shortcut vorgeschlagen.`,
        });
      }
    }

    return results;
  }
}
