import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository } from '@alfred/storage';
import type { ActivityRepository } from '@alfred/storage';

export class PatternAnalyzer {
  constructor(
    private readonly llm: LLMProvider,
    private readonly memoryRepo: MemoryRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Analyze last 7 days of activity and extract behavioral patterns.
   * Called once daily by MemoryConsolidator (3:00 AM).
   */
  async analyze(userId: string): Promise<number> {
    try {
      // 1. Load activity stats for last 7 days
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      const stats = await this.activityRepo.stats(since);
      if (stats.length === 0) return 0;

      // 2. Build analysis prompt
      const statsText = stats.map(s => `- ${s.eventType} (${s.outcome}): ${s.count}x`).join('\n');

      const prompt = `Analysiere das Nutzungsverhalten eines AI-Assistenten-Users über die letzten 7 Tage.

Aktivitätsstatistik:
${statsText}

Extrahiere Verhaltensmuster. Beispiele:
- Timing: "User ist abends (18-23h) am aktivsten"
- Themen: "User interessiert sich stark für Crypto-Preise (8x/Woche)"
- Routine: "User prüft jeden Morgen den Kalender"
- Kommunikation: "User bevorzugt kurze, direkte Antworten"

Regeln:
- Nur Muster mit Konfidenz >= 0.6
- Jedes Muster: key (snake_case), value (1 Satz Deutsch), type="pattern", confidence, category
- Categories: timing, topic_affinity, communication_style, routine
- Max 5 Muster
- Wenn keine klaren Muster erkennbar: return []

Return NUR ein JSON-Array:`;

      // 3. LLM call (fast tier, cheap)
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        tier: 'fast',
        maxTokens: 512,
      });

      // 4. Parse and save patterns
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return 0;

      let patterns: any[];
      try { patterns = JSON.parse(jsonMatch[0]); } catch { return 0; }
      if (!Array.isArray(patterns)) return 0;

      let saved = 0;
      for (const p of patterns) {
        if (!p.key || !p.value || (p.confidence ?? 0) < 0.6) continue;
        try {
          await this.memoryRepo.saveWithMetadata(
            userId, `pattern_${p.key}`, p.value,
            p.category ?? 'behavior', 'pattern',
            p.confidence ?? 0.7, 'auto',
          );
          saved++;
          this.logger.info({ key: p.key, confidence: p.confidence }, 'Behavioral pattern saved');
        } catch { /* skip duplicates */ }
      }
      return saved;
    } catch (err) {
      this.logger.warn({ err }, 'Pattern analysis failed');
      return 0;
    }
  }
}
