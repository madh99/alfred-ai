import type { Logger } from 'pino';
import type { WatchRepository, ActivityRepository } from '@alfred/storage';
import type { ReflectionResult, ReflectionConfig } from './types.js';
import { spaetestesDatumImText } from '../reasoning-context-collector.js';

type WatchConfig = {
  staleAfterDays: number;
  deleteAfterDays: number;
  maxTriggersPerDay: number;
  ignoredAlertsBeforePause: number;
  failedActionsBeforeDisable: number;
};

export class WatchReflector {
  constructor(
    private readonly watchRepo: WatchRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly logger: Logger,
    private readonly config: WatchConfig,
  ) {}

  /**
   * v925 — Duplikat-Erkennung: gleiche skill+entity_id ODER ≥3 gemeinsame
   * Namens-Keywords. Realfall: „Daily Sensor Battery Check" existierte 2× mit
   * jeweils geratenen (unterschiedlichen, nicht existenten) Entity-Namen — der
   * Reflector räumte nur einzelne stale Watches ab, nie Duplikate.
   */
  static findDuplicateGroups(watches: Array<{ id: string; name: string; skillName: string; skillParams?: Record<string, unknown>; createdAt: string }>): Array<{ keep: { id: string; name: string }; drop: Array<{ id: string; name: string }> }> {
    const tokens = (s: string) => new Set((s ?? '').toLowerCase().split(/[^a-zä-ü0-9]+/i).filter(w => w.length >= 4));
    const groups: Array<{ keep: { id: string; name: string }; drop: Array<{ id: string; name: string }> }> = [];
    const assigned = new Set<string>();
    const sorted = [...watches].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')); // neueste zuerst

    for (let i = 0; i < sorted.length; i++) {
      if (assigned.has(sorted[i].id)) continue;
      const a = sorted[i];
      const aEntity = a.skillParams?.entity_id as string | undefined;
      const aTokens = tokens(a.name);
      const dups: Array<{ id: string; name: string }> = [];
      for (let j = i + 1; j < sorted.length; j++) {
        if (assigned.has(sorted[j].id)) continue;
        const b = sorted[j];
        const bEntity = b.skillParams?.entity_id as string | undefined;
        const sameTarget = a.skillName === b.skillName && !!aEntity && aEntity === bEntity;
        const bTokens = tokens(b.name);
        let common = 0;
        for (const t of aTokens) if (bTokens.has(t)) common++;
        if (sameTarget || common >= 3) {
          dups.push({ id: b.id, name: b.name });
          assigned.add(b.id);
        }
      }
      if (dups.length > 0) groups.push({ keep: { id: a.id, name: a.name }, drop: dups });
    }
    return groups;
  }

  async reflect(userId: string): Promise<ReflectionResult[]> {
    const results: ReflectionResult[] = [];
    // Use getEnabled() since there's no user-scoped listAll
    const watches = await this.watchRepo.getEnabled();
    const now = Date.now();

    // v925 — Selbstheilung 1: Duplikat-Watches mergen (neueste behalten, Rest löschen)
    const dupGroups = WatchReflector.findDuplicateGroups(watches as any);
    const droppedIds = new Set<string>();
    for (const g of dupGroups) {
      for (const d of g.drop) {
        droppedIds.add(d.id);
        results.push({
          target: { type: 'watch', id: d.id, name: d.name },
          finding: `Watch "${d.name}" ist ein Duplikat von "${g.keep.name}"`,
          action: 'delete',
          risk: 'proactive',
          reasoning: `v925 Duplikat-Merge: überwacht dasselbe wie "${g.keep.name}" (\`${g.keep.id.slice(0, 8)}\`). Neueste bleibt, Duplikat wird gelöscht.`,
        });
      }
    }

    for (const watch of watches) {
      if (droppedIds.has(watch.id)) continue; // v925 — bereits als Duplikat markiert

      // v925 — Selbstheilung 2: Watch liefert dauerhaft unknown/unavailable und hat
      // nie getriggert → prüft vermutlich eine geratene/nicht existente Entity
      // (Realfall: sensor.garage_temp_batterie existierte nicht in HA). Deaktivieren
      // + melden statt still weiterlaufen lassen.
      const deadAgeDays = (now - new Date(watch.createdAt).getTime()) / 86400_000;
      // v1147 — M2: 'null' ergänzt — der wörtliche Marker der undefined-Extraktion
      // (39/40 stumme Watches trugen ihn, die v925-Heilung übersah ihn).
      const deadValue = watch.lastValue !== null && ['unknown', 'unavailable', '', 'null'].includes(String(watch.lastValue).trim().toLowerCase());
      if (deadValue && !watch.lastTriggeredAt && watch.lastCheckedAt && deadAgeDays >= 3) {
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" liefert seit Erstellung nur "${watch.lastValue}" — Ziel-Entity existiert vermutlich nicht`,
          action: 'deactivate',
          risk: 'proactive',
          reasoning: `v925: skill_params zeigen vermutlich auf eine nicht existente Entity (Wert dauerhaft "${watch.lastValue}", nie getriggert, ${Math.round(deadAgeDays)}d alt). Deaktiviert — bitte Entity-Namen prüfen.`,
        });
        continue;
      }

      // v1143 — J3: Selbstheilung 3 — eventgebundene Watches überleben ihr
      // Ereignis nicht mehr. Ein Datum im Namen/Template, das >48 h zurückliegt
      // (und NACH der Watch-Erstellung lag, also wirklich der Zieltermin war),
      // deaktiviert den Watch (Realfall: „BMW SoC gamescom-Fahrt" ×3 aktiv,
      // zwei Tage nach der Rückkehr — jeder Trigger erneuerte den Reisekontext).
      const bezugsDatum = spaetestesDatumImText(`${watch.name} ${watch.messageTemplate ?? ''}`);
      if (bezugsDatum
        && now - bezugsDatum.getTime() > 48 * 3_600_000
        && bezugsDatum.getTime() > new Date(watch.createdAt).getTime() - 14 * 86_400_000) {
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" bezieht sich auf ein Ereignis am ${bezugsDatum.toISOString().slice(0, 10)} — das ist vorbei`,
          action: 'deactivate',
          risk: 'proactive',
          reasoning: `v1143 Event-Ablauf: der Bezugstermin liegt >48 h zurück. Deaktiviert, damit der veraltete Kontext nicht weiter ins Reasoning fließt.`,
        });
        continue;
      }

      const ageDays = (now - new Date(watch.createdAt).getTime()) / 86400_000;
      const lastTriggerDays = watch.lastTriggeredAt
        ? (now - new Date(watch.lastTriggeredAt).getTime()) / 86400_000
        : ageDays;

      // 1. Never triggered or stale for too long → delete
      if (lastTriggerDays >= this.config.deleteAfterDays) {
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" hat seit ${Math.round(lastTriggerDays)} Tagen nicht getriggert`,
          action: 'delete',
          risk: 'proactive',
          reasoning: `Kein Trigger seit ${Math.round(lastTriggerDays)} Tagen (Schwellwert: ${this.config.deleteAfterDays}). Watch wird geloescht.`,
        });
        continue;
      }

      // 2. Stale → adjust (double interval, max 24h)
      if (lastTriggerDays >= this.config.staleAfterDays) {
        const newInterval = Math.min((watch.intervalMinutes ?? 30) * 2, 1440);
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" hat seit ${Math.round(lastTriggerDays)} Tagen nicht getriggert`,
          action: 'adjust',
          params: { intervalMinutes: newInterval },
          risk: 'auto',
          reasoning: `Kein Trigger seit ${Math.round(lastTriggerDays)} Tagen. Intervall von ${watch.intervalMinutes ?? 30}min auf ${newInterval}min erhoeht.`,
        });
        continue;
      }

      // 3. Triggering too often (last 24h)
      try {
        const since = new Date(now - 86400_000).toISOString();
        const triggers = await this.activityRepo.query({
          eventType: 'watch_trigger',
          since,
          limit: 200,
        });
        const watchTriggers = triggers.filter(
          (t) => t.action === watch.id || t.action === watch.name,
        );
        if (watchTriggers.length > this.config.maxTriggersPerDay) {
          const newCooldown = Math.max(
            (watch as any).cooldownMinutes ?? 0,
            60,
          );
          results.push({
            target: { type: 'watch', id: watch.id, name: watch.name },
            finding: `Watch "${watch.name}" triggert zu oft (${watchTriggers.length}x in 24h)`,
            action: 'adjust',
            params: { cooldownMinutes: newCooldown },
            risk: 'auto',
            reasoning: `${watchTriggers.length} Trigger in 24h (Schwellwert: ${this.config.maxTriggersPerDay}). Cooldown auf ${newCooldown}min gesetzt.`,
          });
        }
      } catch {
        this.logger.debug(
          { watchId: watch.id },
          'Could not query watch triggers',
        );
      }

      // 4. Failed actions (last 7 days)
      try {
        const since = new Date(now - 7 * 86400_000).toISOString();
        const actions = await this.activityRepo.query({
          eventType: 'watch_action',
          since,
          limit: 50,
        });
        const watchActions = actions.filter(
          (t) => t.action === watch.id || t.action === watch.name,
        );
        const failures = watchActions.filter((a) => a.outcome === 'error');
        if (failures.length >= this.config.failedActionsBeforeDisable) {
          results.push({
            target: { type: 'watch', id: watch.id, name: watch.name },
            finding: `Watch "${watch.name}" Action fehlgeschlagen ${failures.length}x in 7 Tagen`,
            action: 'deactivate',
            risk: 'proactive',
            reasoning: `${failures.length} fehlgeschlagene Actions (Schwellwert: ${this.config.failedActionsBeforeDisable}). Watch deaktiviert.`,
          });
        }
      } catch {
        this.logger.debug(
          { watchId: watch.id },
          'Could not query watch actions',
        );
      }
    }

    return results;
  }
}
