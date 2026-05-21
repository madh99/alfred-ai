import type { MetricSamplesRepository, ItsmRepository, ProblemRepository } from '@alfred/storage';
import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';

/**
 * v638 — Verkettet Capacity-Forecast (v633) × Pattern-Detection (v633) × Service-Health (v634).
 *
 * Erzeugt Insights wenn drei Signale gleichzeitig hochgehen:
 *  - Forecast sagt eine Metrik wird in ≤30d die Schwelle reißen
 *  - Es gibt schon Pattern-Detection-Cluster (offene oder bereits-promotierte Problems) zum selben Asset
 *  - Service-Health-Score eines verbundenen Services ist <70
 *
 * Ein gezielter "Server X braucht JETZT Upgrade, nicht erst wenn er voll ist"-Insight.
 */
export class InfraForecastAdapter implements DomainAdapter {
  readonly name = 'infra-forecast';

  constructor(
    private readonly metrics: MetricSamplesRepository,
    private readonly itsm: ItsmRepository,
    private readonly problems: ProblemRepository,
  ) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    const out: InsightCandidate[] = [];

    let forecasts: Awaited<ReturnType<typeof this.metrics.forecast>> = [];
    try { forecasts = await this.metrics.forecast(ctx.userId, { windowDays: 30, threshold: 95 }); } catch { return out; }
    const urgent = forecasts.filter(f => f.daysUntilThreshold != null && f.daysUntilThreshold <= 30);
    if (urgent.length === 0) return out;

    // Service-Score nur einmal holen
    let serviceScores: Awaited<ReturnType<typeof this.itsm.serviceHealthScore>> = [];
    try { serviceScores = await this.itsm.serviceHealthScore(ctx.userId, { windowDays: 30 }); } catch { /* skip */ }
    const lowScoreAssetIds = new Set<string>();
    for (const s of serviceScores.filter(s => s.score < 70)) {
      // services haben affected asset_ids — wir nehmen alle Assets in <70-Services als "potentially-related"
      try {
        const svcRaw = await this.itsm.getServiceById(ctx.userId, s.serviceId);
        if (svcRaw?.assetIds) for (const aid of svcRaw.assetIds) lowScoreAssetIds.add(aid);
      } catch { /* skip */ }
    }

    // Pattern-Detection: existierende Patterns/Problems je Asset
    let patterns: Awaited<ReturnType<typeof this.problems.detectPatterns>> = [];
    try { patterns = await this.problems.detectPatterns(ctx.userId, { windowDays: 14, minIncidents: 2 }); } catch { /* skip */ }
    const assetsWithPattern = new Set<string>();
    for (const p of patterns) for (const aid of p.assetIds) assetsWithPattern.add(aid);

    for (const f of urgent) {
      const aid = f.assetId;
      const hasLowScoreService = aid ? lowScoreAssetIds.has(aid) : false;
      const hasPattern = aid ? assetsWithPattern.has(aid) : false;
      // Confidence basiert auf Anzahl Co-Signals
      const signals = [
        true, // forecast itself
        hasLowScoreService,
        hasPattern,
      ].filter(Boolean).length;
      const confidence = signals === 3 ? 0.95 : signals === 2 ? 0.75 : 0.55;

      const days = f.daysUntilThreshold ?? 0;
      const urgency = days <= 7 ? '🔴 dringlich' : days <= 14 ? '⚠️ baldig' : '🟡 mittelfristig';
      const title = `${urgency}: ${f.metricName}${aid ? ` @ Asset ${aid.slice(0, 8)}` : ''} erreicht ${f.threshold}% in ~${days}d`;

      const lines: string[] = [];
      lines.push(`**Trend**: aktuell ${f.latestValue.toFixed(1)}%, ${f.slopePerDay >= 0 ? '+' : ''}${f.slopePerDay.toFixed(2)}%/Tag, Schwelle ${f.threshold}%.`);
      if (hasPattern) lines.push(`**Pattern**: bereits ${patterns.find(p => p.assetIds.includes(aid!))?.incidentCount ?? '?'} Incidents am selben Asset (Pattern-Detection).`);
      if (hasLowScoreService) lines.push(`**Service-Health**: Asset gehört zu Service(s) mit Health-Score <70.`);
      if (signals === 3) lines.push('');
      if (signals === 3) lines.push(`Drei Signale gleichzeitig → Capacity-Upgrade jetzt einplanen ist deutlich günstiger als Notfall-Migration nach Schwellen-Bruch.`);
      else if (hasPattern || hasLowScoreService) lines.push('');
      else lines.push('');

      lines.push(`**Empfohlene Aktion**: Change-Request für Capacity-Upgrade (RAM/Disk je nach Metrik) erstellen.`);

      out.push({
        category: 'infra-forecast',
        title,
        body: lines.join('\n'),
        confidence,
        sourceData: {
          metric: f.metricName,
          assetId: aid,
          latestValue: f.latestValue,
          daysUntilThreshold: days,
          hasPattern, hasLowScoreService,
        },
        actionSkill: 'itsm',
        actionParams: {
          action: 'create_change_request',
          title: `Capacity-Upgrade: ${f.metricName}${aid ? ' @ ' + aid.slice(0, 8) : ''}`,
          type: 'capacity',
          risk_level: signals === 3 ? 'high' : 'medium',
          implementation_plan: `Erkennung über InfraForecastAdapter (${signals} Signale). Aktueller Wert ${f.latestValue.toFixed(1)}%, Trend ${f.slopePerDay.toFixed(2)}%/d → Schwelle ${f.threshold}% in ~${days}d.`,
          affected_asset_ids: aid ? [aid] : [],
        },
        dedupeKey: `infra-forecast:${aid ?? 'no-asset'}:${f.metricName}`,
      });
    }
    return out;
  }
}
