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
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

      // 1. Load detailed activity data (not just aggregated stats)
      // Skill usage: which skills, how often
      const skillRows = await this.activityRepo.query({
        eventType: 'skill_exec',
        since,
        limit: 500,
      });

      // Time distribution: group by hour
      const hourCounts = new Array(24).fill(0);
      const skillCounts = new Map<string, number>();
      for (const row of skillRows) {
        const hour = new Date(row.timestamp).getHours();
        hourCounts[hour]++;
        const skill = row.action ?? 'unknown';
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
      }

      // Watch/scheduled activity
      const watchRows = await this.activityRepo.query({
        eventType: 'watch_trigger',
        since,
        limit: 100,
      });

      // Build comprehensive stats text
      const topSkills = [...skillCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => `  ${name}: ${count}x`)
        .join('\n');

      const peakHours = hourCounts
        .map((count, hour) => ({ hour, count }))
        .filter(h => h.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(h => `  ${h.hour}:00-${h.hour + 1}:00 Uhr: ${h.count} Aktionen`)
        .join('\n');

      const totalActions = skillRows.length;
      const watchCount = watchRows.length;

      if (totalActions === 0 && watchCount === 0) return 0;

      const prompt = `Analysiere das Nutzungsverhalten eines AI-Assistenten-Users über die letzten 7 Tage.

Skill-Nutzung (${totalActions} Aufrufe gesamt):
${topSkills || '  (keine)'}

Zeitverteilung (Aktivste Stunden):
${peakHours || '  (keine Daten)'}

Watch-Alerts: ${watchCount} in 7 Tagen
${watchRows.slice(0, 5).map(w => `  - ${w.action}`).join('\n')}

Extrahiere Verhaltensmuster. Beispiele:
- "User nutzt häufig Kalender und Todos (je 15x/Woche) — Produktivitäts-orientiert"
- "User ist hauptsächlich abends aktiv (18-23 Uhr, 65% aller Aktionen)"
- "User interessiert sich für Crypto (crypto_price 8x, trading 5x)"
- "User nutzt Sonos und Spotify regelmäßig — Musik ist wichtig"
- "User hat aktive RSS-Watches — möchte über News informiert bleiben"

Regeln:
- Nur Muster mit Konfidenz >= 0.6
- Jedes Muster: key (snake_case), value (1 Satz Deutsch), confidence (0.6-0.95), category
- Categories: timing, topic_affinity, communication_style, routine
- Max 5 Muster, priorisiert nach Aussagekraft
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
