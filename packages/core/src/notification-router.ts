import type { Logger } from 'pino';
import type { Platform } from '@alfred/types';
import type { MessagingAdapter } from '@alfred/messaging';
import type { InsightsRepository } from '@alfred/storage';

export type NotificationUrgency = 'urgent' | 'high' | 'normal' | 'low';

export interface RouterConfig {
  /** Ab dieser Dringlichkeit wird gesendet; darunter still ins Wissen. Default 'high'. */
  minUrgency?: NotificationUrgency;
  /** Schwellen-Override je Quelle (z.B. { reasoning: 'urgent' }). */
  perSource?: Record<string, NotificationUrgency>;
  /** true = Dev-Mode: alles senden wie früher (Router nur Durchreicher). */
  devMode?: boolean;
}

export interface RoutedNotification {
  source: string; // 'reasoning' | 'itsm-reflection' | 'automation' | …
  urgency: NotificationUrgency;
  title: string;
  body: string;
  /** Begründung der Wichtigkeits-Einstufung (Score v1) — wird sichtbar gespeichert. */
  reasons?: string[];
  chatId: string;
  platform: Platform;
  actionSkill?: string;
  actionParams?: Record<string, unknown>;
  dedupeKey?: string;
  confidence?: number;
}

const URGENCY_RANK: Record<NotificationUrgency, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/**
 * v927 — Zentraler Notification-Router (Paket 1, „Stiller Modus").
 *
 * Vorher sendeten ~14 Komponenten direkt an Telegram (Reasoning alle ~30 Min,
 * Reflexionen, Reports …) — ohne gemeinsame Schwelle. Der Router entscheidet:
 * Dringlichkeit ≥ Schwelle → senden wie bisher; darunter → STILL als Insight in
 * alfred_insights ablegen (erscheint in der Insights-UI, ist per silent_digest
 * abrufbar, geht NIE verloren). Alfred arbeitet unverändert weiter — nur der
 * Ausgang wechselt von „Nachricht" zu „internes Wissen".
 */
export class NotificationRouter {
  constructor(
    private readonly insightsRepo: InsightsRepository | undefined,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private config: RouterConfig,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
  ) {}

  /** v930 — aktuelle Einstellungen (für die UI). */
  getConfig(): RouterConfig {
    return {
      minUrgency: this.config.minUrgency ?? 'high',
      perSource: { ...(this.config.perSource ?? {}) },
      devMode: this.config.devMode === true,
    };
  }

  /** v930 — Laufzeit-Update aus der UI (Persistenz macht der Aufrufer). */
  updateConfig(patch: Partial<RouterConfig>): RouterConfig {
    this.config = {
      minUrgency: patch.minUrgency ?? this.config.minUrgency,
      perSource: patch.perSource !== undefined ? patch.perSource : this.config.perSource,
      devMode: patch.devMode !== undefined ? patch.devMode : this.config.devMode,
    };
    this.logger.info(this.getConfig(), 'v930 notification router config updated');
    return this.getConfig();
  }

  /** Entscheidung ohne Seiteneffekt (für Aufrufer, die den Sendepfad selbst besitzen). */
  shouldSend(source: string, urgency: NotificationUrgency): boolean {
    if (this.config.devMode === true) return true;
    if (!this.insightsRepo) return true; // ohne Ablage nichts verschlucken
    const threshold = this.config.perSource?.[source] ?? this.config.minUrgency ?? 'high';
    return URGENCY_RANK[urgency] >= URGENCY_RANK[threshold];
  }

  /** Routet: sendet ODER legt still als Insight ab. @returns was passiert ist. */
  async route(n: RoutedNotification): Promise<'sent' | 'stored' | 'dropped'> {
    if (this.shouldSend(n.source, n.urgency)) {
      const adapter = this.adapters.get(n.platform);
      if (adapter) {
        await adapter.sendMessage(n.chatId, n.body);
        return 'sent';
      }
      // kein Adapter → wenigstens ablegen
    }
    return this.store(n);
  }

  /** Stille Ablage in alfred_insights (Insights-UI + silent_digest). */
  async store(n: RoutedNotification): Promise<'stored' | 'dropped'> {
    if (!this.insightsRepo) return 'dropped';
    try {
      const reasonsSuffix = n.reasons && n.reasons.length > 0
        ? `\n\n_Einstufung (${n.urgency}): ${n.reasons.join(' · ')}_`
        : '';
      await this.insightsRepo.upsertCandidate(this.ownerUserId, {
        category: n.source,
        title: n.title.slice(0, 200),
        body: `${n.body}${reasonsSuffix}`,
        confidence: n.confidence ?? 0.6,
        sourceData: { router: true, urgency: n.urgency, storedAt: new Date().toISOString() },
        actionSkill: n.actionSkill,
        actionParams: n.actionParams,
        dedupeKey: n.dedupeKey,
      });
      this.logger.debug({ source: n.source, urgency: n.urgency, title: n.title.slice(0, 60) }, 'v927 router: stored silently');
      return 'stored';
    } catch (err) {
      this.logger.warn({ err, source: n.source }, 'v927 router: store failed');
      return 'dropped';
    }
  }
}
