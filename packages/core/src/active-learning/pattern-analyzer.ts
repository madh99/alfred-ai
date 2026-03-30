import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository } from '@alfred/storage';
import type { ActivityRepository } from '@alfred/storage';
import { createHash } from 'node:crypto';

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
      // Cleanup: enforce max 30 rules total
      await this.cleanupExcessRules(userId);

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

Antworte in der Sprache des Users. Hinweis: Bisherige Memories und Patterns sind auf Deutsch.
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

      // 5. Skill error learning: extract rules from recurring skill failures
      try {
        const errorRules = await this.analyzeSkillErrors(userId, since);
        saved += errorRules;
      } catch (err) {
        this.logger.debug({ err }, 'Skill error learning failed');
      }

      // 6. Rule confidence boost: rules that were in prompts without corrections get +0.05
      try {
        await this.boostUncontestedRules(userId, since);
      } catch (err) {
        this.logger.debug({ err }, 'Rule confidence boost failed');
      }

      return saved;
    } catch (err) {
      this.logger.warn({ err }, 'Pattern analysis failed');
      return 0;
    }
  }

  /**
   * Analyze recurring skill errors and derive avoidance rules.
   */
  private async analyzeSkillErrors(userId: string, since: string): Promise<number> {
    // Load all skill execution errors in the last 7 days
    const errorRows = await this.activityRepo.query({
      eventType: 'skill_exec',
      outcome: 'error',
      since,
      limit: 500,
    });

    if (errorRows.length === 0) return 0;

    // Group by skill + error fingerprint
    const groups = new Map<string, { skillName: string; errorMessage: string; count: number }>();
    for (const row of errorRows) {
      const skillName = row.action ?? 'unknown';
      const errorMsg = (row.errorMessage ?? 'unknown error').slice(0, 80);
      const fingerprint = `${skillName}::${errorMsg}`;
      const existing = groups.get(fingerprint);
      if (existing) {
        existing.count++;
      } else {
        groups.set(fingerprint, { skillName, errorMessage: errorMsg, count: 1 });
      }
    }

    let saved = 0;

    // Pre-load all existing rules for limit checks
    const allRules = await this.memoryRepo.getByType(userId, 'rule', 200);
    const totalRuleCount = allRules.length;
    const perSkillCounts = new Map<string, number>();
    for (const r of allRules) {
      const match = r.key.match(/^rule_skill_([^_]+)_/);
      if (match) {
        perSkillCounts.set(match[1], (perSkillCounts.get(match[1]) ?? 0) + 1);
      }
    }

    for (const [fingerprint, group] of groups) {
      // Only derive rules for errors that occurred >= 3 times
      if (group.count < 3) continue;

      // Max 30 rules total
      if (totalRuleCount + saved >= 30) break;

      // Max 3 rules per skill
      const skillRuleCount = perSkillCounts.get(group.skillName) ?? 0;
      if (skillRuleCount >= 3) continue;

      // Check if we already have a rule for this error pattern
      const hash = createHash('md5').update(fingerprint).digest('hex').slice(0, 12);
      const ruleKey = `rule_skill_${group.skillName}_${hash}`;
      const existing = await this.memoryRepo.recall(userId, ruleKey);
      if (existing) continue; // Already have a rule for this

      try {
        const prompt = `Skill '${group.skillName}' ist ${group.count}x mit folgendem Fehler fehlgeschlagen: '${group.errorMessage}'. Leite eine kurze Verhaltensregel ab (max 1 Satz) die Alfred helfen würde, diesen Fehler in Zukunft zu vermeiden oder zu umgehen. Antworte in der Sprache des Users (bisherige Daten sind auf Deutsch).
Regel:`;

        const response = await this.llm.complete({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          tier: 'fast',
          maxTokens: 128,
        });

        const rule = response.content.trim();
        if (rule && rule.length >= 5 && rule.length <= 200) {
          await this.memoryRepo.saveWithMetadata(
            userId, ruleKey, rule,
            'behavior', 'rule',
            0.7, 'auto',
          );
          saved++;
          perSkillCounts.set(group.skillName, (perSkillCounts.get(group.skillName) ?? 0) + 1);
          this.logger.info({ ruleKey, rule, errorCount: group.count }, 'Skill error rule saved');
        }
      } catch (err) {
        this.logger.debug({ err, skill: group.skillName }, 'Failed to derive rule from skill error');
      }
    }

    return saved;
  }

  /**
   * Boost confidence of rules that were active (in prompts) during the last 7 days
   * without triggering corrections. If the user didn't correct → the rule worked.
   */
  private async boostUncontestedRules(userId: string, since: string): Promise<void> {
    const rules = await this.memoryRepo.getByType(userId, 'rule', 50);
    if (rules.length === 0) return;

    // Load feedback memories from the last 7 days (corrections)
    const feedbackMemories = await this.memoryRepo.getByType(userId, 'feedback', 100);
    const sinceDate = new Date(since);
    const recentFeedback = feedbackMemories.filter(
      f => new Date(f.updatedAt) >= sinceDate,
    );

    // Tokenize feedback values for similarity comparison
    const feedbackTokenSets = recentFeedback.map(f =>
      new Set(f.value.toLowerCase().split(/\s+/).filter(t => t.length >= 3)),
    );

    for (const rule of rules) {
      if (rule.confidence >= 1.0) continue;

      // Only boost rules that existed before the analysis period
      const ruleDate = new Date(rule.updatedAt);
      if (ruleDate >= sinceDate) continue;

      // Race condition guard: skip if already boosted today (updated_at < 20h ago)
      const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60_000);
      if (ruleDate >= twentyHoursAgo) continue;

      // Check if any recent feedback is semantically similar to this rule
      const ruleTokens = new Set(rule.value.toLowerCase().split(/\s+/).filter(t => t.length >= 3));
      const hasSimilarFeedback = feedbackTokenSets.some(feedbackTokens => {
        if (ruleTokens.size === 0 || feedbackTokens.size === 0) return false;
        let intersection = 0;
        for (const t of ruleTokens) { if (feedbackTokens.has(t)) intersection++; }
        const union = ruleTokens.size + feedbackTokens.size - intersection;
        return union > 0 && (intersection / union) >= 0.3;
      });

      if (hasSimilarFeedback) {
        this.logger.debug({ ruleKey: rule.key }, 'Rule boost skipped (similar feedback exists)');
        continue;
      }

      // Boost via saveWithMetadata (UPSERT) to avoid double-boost race condition on multi-node
      const newConfidence = Math.min(1.0, rule.confidence + 0.05);
      await this.memoryRepo.saveWithMetadata(
        userId, rule.key, rule.value,
        rule.category, 'rule',
        newConfidence, rule.source,
      );
      this.logger.debug({ ruleKey: rule.key, newConfidence }, 'Rule confidence boosted (uncontested)');
    }
  }

  /**
   * Cleanup excess rules: enforce max 30 total.
   * First delete all with confidence < 0.5, then oldest until <= 30 remain.
   */
  private async cleanupExcessRules(userId: string): Promise<void> {
    const allRules = await this.memoryRepo.getByType(userId, 'rule', 200);
    if (allRules.length <= 30) return;

    this.logger.info({ ruleCount: allRules.length }, 'Too many rules, cleaning up (max 30)');

    // Phase 1: delete low-confidence rules (< 0.5)
    const lowConfidence = allRules.filter(r => r.confidence < 0.5);
    for (const r of lowConfidence) {
      try {
        await this.memoryRepo.delete(userId, r.key);
        this.logger.debug({ ruleKey: r.key, confidence: r.confidence }, 'Deleted low-confidence rule');
      } catch { /* skip */ }
    }

    // Phase 2: if still over 30, delete oldest by updatedAt
    const remaining = allRules
      .filter(r => r.confidence >= 0.5)
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

    let toDelete = remaining.length - 30;
    for (const r of remaining) {
      if (toDelete <= 0) break;
      try {
        await this.memoryRepo.delete(userId, r.key);
        toDelete--;
        this.logger.debug({ ruleKey: r.key }, 'Deleted oldest rule (over limit)');
      } catch { /* skip */ }
    }
  }
}
