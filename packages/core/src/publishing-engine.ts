import type { Logger } from 'pino';
import type { Platform } from '@alfred/types';
import type { MessagingAdapter } from '@alfred/messaging';
import type { SocialRepository, SocialChannel, ContentItem, InsightsRepository } from '@alfred/storage';
import type { AsyncDbAdapter } from '@alfred/storage';
import type { NotificationRouter } from './notification-router.js';
import { ContentStudio } from './content-studio.js';

export interface PublishFnResult {
  success: boolean;
  error?: string;
  display?: string;
  /** v983 — dauerhafter Leitplanken-Block (Duplikat/Blacklist/Termin vorbei): Retry ändert nichts. */
  permanent?: boolean;
}

/**
 * v934 — Publishing-Engine (Stufe 2 des Social-Plans).
 *
 * Läuft im 5-Minuten-Raster und setzt die drei Kanal-Modi um:
 * - **approve** (und autonomous mit Erstpost-Streak < 5): fällige geplante
 *   Items werden EINMAL zur Freigabe ausgespielt — Telegram-Nachricht mit
 *   Buttons (`content:<id>:approve|reject`, Quick-Action-Muster v924) UND
 *   Insight (category 'social-approval', Aktion „Freigeben" in der UI).
 *   Dedupe über den Insight-dedupeKey: nur bei neu angelegtem Insight wird
 *   die Button-Nachricht gesendet.
 * - **autonomous** (Streak ≥ 5): fällige Items werden automatisch freigegeben
 *   und veröffentlicht; die Leitplanken (Tages-Limit, Blacklist, paused)
 *   prüft der social-Skill in CODE — schlägt eine an, geht das Item in die
 *   Freigabe-Queue statt live. Jeder autonome Post läuft still über den
 *   Notification-Router (lückenlos in der Insights-UI).
 * - **suggest**: die Engine published nur explizit freigegebene Items —
 *   Vorschläge erzeugt erst das Content-Studio (v935).
 *
 * Bereits freigegebene Items (approved) werden in JEDEM Modus zum geplanten
 * Zeitpunkt veröffentlicht. HA: exactly-once pro Item über reasoning_slots
 * (`social-item:<id>`), nicht über Zeitfenster. Fehlgeschlagene Publishes
 * werden nach 15 Minuten genau EINMAL erneut versucht.
 */
export class PublishingEngine {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly repo: SocialRepository,
    /** Führt die Veröffentlichung über den social-Skill aus (inkl. Leitplanken). */
    private readonly publishItem: (itemId: string) => Promise<PublishFnResult>,
    private readonly insightsRepo: InsightsRepository | undefined,
    private readonly router: NotificationRouter | undefined,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly opts: {
      ownerUserId: string;
      chatId: string;
      platform: Platform;
      dbAdapter?: AsyncDbAdapter;
      nodeId?: string;
      intervalMs?: number;
      retryAfterMs?: number;
      /** v987 — Zombie-Watchdog: Items laenger als N ms in 'publishing' -> failed. */
      stuckAfterMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs ?? 5 * 60_000);
    this.logger.info('v934 publishing engine started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Ein Durchlauf (auch direkt aufrufbar/testbar). */
  async tick(): Promise<{ published: number; asked: number; retried: number; rescued: number }> {
    if (this.running) return { published: 0, asked: 0, retried: 0, rescued: 0 };
    this.running = true;
    const result = { published: 0, asked: 0, retried: 0, rescued: 0 };
    try {
      const now = new Date().toISOString();
      const owner = this.opts.ownerUserId;
      const channels = new Map((await this.repo.listChannels(owner)).map(c => [c.id, c]));

      // 0) v987 — Zombie-Rettung: stirbt der Prozess MITTEN im Publish
      // (zwischen transition('publishing') und dem Provider-Ergebnis), hängt
      // das Item für immer in 'publishing' — die Engine fragt sonst nur
      // approved/scheduled/failed ab. Nach 15 min → failed (der reguläre
      // Einmal-Retry unten übernimmt), Slot freigeben.
      const stuckAfter = this.opts.stuckAfterMs ?? 15 * 60_000;
      const stuck = await this.repo.listItems(owner, { status: 'publishing' });
      for (const item of stuck) {
        if (Date.now() - Date.parse(item.updatedAt) < stuckAfter) continue;
        try {
          await this.repo.transition(owner, item.id, 'failed', { error: 'Publish-Prozess abgebrochen (hing in publishing) — vom Watchdog eingesammelt.' });
          await this.releaseItemSlot(`social-item:${item.id}`);
          result.rescued++;
          this.logger.warn({ itemId: item.id, updatedAt: item.updatedAt }, 'v987 stuck-in-publishing rescued → failed');
        } catch (err) {
          this.logger.warn({ itemId: item.id, err: (err as Error).message }, 'v987 stuck rescue failed');
        }
      }

      // 1) Fällige FREIGEGEBENE Items veröffentlichen (jeder Modus)
      const dueApproved = await this.repo.listItems(owner, { status: 'approved', scheduledBefore: now });
      for (const item of dueApproved) {
        const channel = channels.get(item.channelId);
        if (!channel || channel.status !== 'active') continue;
        // v1044 — Shelf-Life-Gate: ein approved-Item, dessen Haltbarkeit beim
        // (verspäteten) Fälligwerden längst abgelaufen ist, geht NICHT mehr
        // live (Engine-Ausfall/Catch-up publishte sonst tagealte News).
        const art = typeof item.performance?.art === 'string' ? item.performance.art : undefined;
        const shelf = ContentStudio.shelfLifeHours(art, channel);
        if (shelf !== undefined && Date.parse(item.createdAt) + shelf * 3_600_000 < Date.now()) {
          try {
            await this.repo.transition(owner, item.id, 'rejected');
            this.logger.warn({ itemId: item.id, art, shelf }, 'v1044 approved-Item überaltert beim Fälligwerden → zurückgezogen statt publiziert');
          } catch { /* Einzelfehler überspringen */ }
          continue;
        }
        if (await this.claimItemSlot(`social-item:${item.id}`)) {
          if (await this.doPublish(item, channel)) {
            result.published++;
          } else {
            // Slot freigeben — sonst blockiert der konsumierte Slot jeden
            // späteren Publish-Versuch dieses Items (nach Fix + Re-Approve)
            await this.releaseItemSlot(`social-item:${item.id}`);
          }
        }
      }

      // 2) Fällige GEPLANTE Items je Modus behandeln
      const dueScheduled = await this.repo.listItems(owner, { status: 'scheduled', scheduledBefore: now });
      for (const item of dueScheduled) {
        const channel = channels.get(item.channelId);
        if (!channel || channel.status !== 'active') continue;
        const autonomousUnlocked = channel.mode === 'autonomous' && channel.approvedStreak >= 5;
        if (autonomousUnlocked) {
          if (await this.claimItemSlot(`social-item:${item.id}`)) {
            const r = await this.publishItem(item.id);
            if (r.success) {
              result.published++;
              await this.router?.store({
                source: 'social', urgency: 'low',
                title: `Autonom veröffentlicht: ${(item.title ?? item.body).slice(0, 80)}`,
                body: `Kanal **${channel.name}** (${channel.platform}), Item ${item.id.slice(0, 8)}.\n${r.display ?? ''}`,
                chatId: this.opts.chatId, platform: this.opts.platform,
                dedupeKey: `social-published:${item.id}`,
              });
            } else {
              // Leitplanke hat gegriffen (Limit/Blacklist/…) → Freigabe-Queue;
              // Slot freigeben, damit der spätere manuelle/Engine-Publish nicht blockiert
              await this.releaseItemSlot(`social-item:${item.id}`);
              if (await this.askApproval(item, channel, `Autonom-Publish blockiert: ${r.error ?? 'Leitplanke'}`)) result.asked++;
            }
          }
        } else if (channel.mode === 'approve' || channel.mode === 'autonomous') {
          if (await this.askApproval(item, channel)) result.asked++;
        }
        // suggest: kein aktives Nachfragen — Freigabe kommt vom User/Studio
      }

      // 3) Retry: fehlgeschlagene Publishes genau einmal nach 15 min
      const failed = await this.repo.listItems(owner, { status: 'failed' });
      const retryAfter = this.opts.retryAfterMs ?? 15 * 60_000;
      for (const item of failed) {
        const channel = channels.get(item.channelId);
        if (!channel || channel.status !== 'active') continue;
        if (item.performance?.retried === true) continue;
        if (Date.now() - Date.parse(item.updatedAt) < retryAfter) continue;
        if (!(await this.claimItemSlot(`social-retry:${item.id}`))) continue;
        await this.repo.mergePerformance(owner, item.id, { retried: true, retriedAt: now });
        const r = await this.publishItem(item.id);
        result.retried++;
        if (!r.success) {
          await this.insightsRepo?.upsertCandidate(owner, {
            category: 'social',
            title: `Publish endgültig fehlgeschlagen: ${(item.title ?? item.body).slice(0, 60)}`,
            body: `Kanal **${channel.name}**, Item ${item.id.slice(0, 8)} — auch der Retry schlug fehl:\n${r.error ?? 'unbekannt'}\n\nItem bleibt auf failed; publish_now versucht es erneut.`,
            confidence: 0.9,
            sourceData: { router: true, urgency: 'high', itemId: item.id },
            dedupeKey: `social-failed:${item.id}`,
          }).catch(() => { /* non-critical */ });
        }
      }

      if (result.published + result.asked + result.retried + result.rescued > 0) {
        this.logger.info(result, 'v934 publishing tick');
      }
    } catch (err) {
      this.logger.warn({ err }, 'v934 publishing tick failed');
    } finally {
      this.running = false;
    }
    return result;
  }

  private async doPublish(item: ContentItem, channel: SocialChannel): Promise<boolean> {
    const r = await this.publishItem(item.id);
    if (r.success) {
      await this.router?.store({
        source: 'social', urgency: 'low',
        title: `Veröffentlicht: ${(item.title ?? item.body).slice(0, 80)}`,
        body: `Kanal **${channel.name}** (${channel.platform}).\n${r.display ?? ''}`,
        chatId: this.opts.chatId, platform: this.opts.platform,
        dedupeKey: `social-published:${item.id}`,
      });
      return true;
    }
    // v983 — dauerhafte Leitplanken-Blocks (Duplikat/Blacklist/Termin vorbei)
    // NICHT alle 5 Minuten neu versuchen (Realfall 04.07.: zwei Items hingen
    // 11 Stunden „überfällig" im Retry-Loop): Item auf failed stellen,
    // retried-Marker setzen (kein 15-min-Auto-Retry) und den User EINMAL
    // benachrichtigen. Reaktivieren geht über Bearbeiten/erneutes Freigeben
    // oder publish_now mit force.
    if (r.permanent === true) {
      const owner = this.opts.ownerUserId;
      try {
        await this.repo.transition(owner, item.id, 'publishing');
        await this.repo.transition(owner, item.id, 'failed');
        await this.repo.mergePerformance(owner, item.id, { retried: true, blockReason: (r.error ?? '').slice(0, 300) });
      } catch (err) {
        this.logger.warn({ itemId: item.id, err: (err as Error).message }, 'v983 failed-transition nach permanentem Block fehlgeschlagen');
      }
      await this.insightsRepo?.upsertCandidate(owner, {
        category: 'social',
        title: `Publish blockiert: ${(item.title ?? item.body).slice(0, 60)}`,
        body: `Kanal **${channel.name}**, Item ${item.id.slice(0, 8)} — Leitplanke greift dauerhaft:\n${r.error ?? 'unbekannt'}\n\nItem steht auf failed. Bewusst posten: publish_now mit force, sonst bearbeiten oder ablehnen.`,
        confidence: 0.9,
        sourceData: { router: true, urgency: 'high', itemId: item.id },
        dedupeKey: `social-blocked:${item.id}`,
      }).catch(() => { /* non-critical */ });
      this.logger.warn({ itemId: item.id, error: r.error }, 'v983 publish permanently blocked — Item auf failed');
      return false;
    }
    this.logger.warn({ itemId: item.id, error: r.error }, 'v934 scheduled publish failed');
    return false;
  }

  /**
   * Freigabe EINMAL ausspielen: Insight (Dedupe-Anker + UI-Aktion) und — nur
   * wenn der Insight NEU ist — die Telegram-Nachricht mit Buttons.
   */
  private async askApproval(item: ContentItem, channel: SocialChannel, reason?: string): Promise<boolean> {
    if (!this.insightsRepo) return false;
    const preview = `${item.title ? `**${item.title}**\n` : ''}${item.body.slice(0, 400)}${item.hashtags.length ? `\n${item.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}` : ''}`;
    const r = await this.insightsRepo.upsertCandidate(this.opts.ownerUserId, {
      category: 'social-approval',
      title: `Freigabe: ${(item.title ?? item.body).slice(0, 70)}`,
      body: `Geplanter Post für **${channel.name}** (${channel.platform})${item.scheduledAt ? `, ${item.scheduledAt.slice(0, 16).replace('T', ' ')}` : ''}${reason ? `\n⚠️ ${reason}` : ''}:\n\n${preview}`,
      confidence: 0.7,
      sourceData: {
        actionLabel: 'Freigeben & veröffentlichen',
        itemId: item.id, channelId: channel.id,
        ...(reason ? { blockedReason: reason } : {}),
      },
      actionSkill: 'social',
      actionParams: { action: 'publish_now', item_id: item.id },
      // v1044 — Dedupe je SLOT statt je Item: wird ein verpasstes Item vom
      // Plan-Review neu terminiert, kommt die Freigabe-Anfrage erneut
      // (vorher wurde exakt einmal gefragt und das Item hing für immer fest).
      dedupeKey: `social-approval:${item.id}:${item.scheduledAt ?? 'x'}`,
    });
    if (!r.inserted) return false; // schon gefragt — nicht erneut senden

    const adapter = this.adapters.get(this.opts.platform);
    if (adapter) {
      try {
        await adapter.sendMessage(this.opts.chatId,
          `📤 **Freigabe nötig** — ${channel.name}${item.scheduledAt ? ` (geplant ${item.scheduledAt.slice(0, 16).replace('T', ' ')})` : ''}${reason ? `\n⚠️ ${reason}` : ''}\n\n${preview}`,
          {
            replyMarkup: {
              inlineKeyboard: [[
                { text: '✅ Freigeben', callbackData: `content:${item.id}:approve` },
                { text: '🚀 Sofort posten', callbackData: `content:${item.id}:publish` },
                { text: '✕ Ablehnen', callbackData: `content:${item.id}:reject` },
              ]],
            },
          } as Record<string, unknown>);
      } catch (err) {
        this.logger.warn({ err, itemId: item.id }, 'v934 approval message failed (Insight bleibt)');
      }
    }
    return true;
  }

  /** HA exactly-once pro Item (reasoning_slots; SQLite/Single-Node → immer true). */
  private async claimItemSlot(slotKey: string): Promise<boolean> {
    if (this.opts.dbAdapter?.type !== 'postgres') return true;
    try {
      const r = await this.opts.dbAdapter.execute(
        'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [slotKey, this.opts.nodeId ?? 'single', new Date().toISOString()],
      );
      return (r.changes ?? 0) > 0;
    } catch {
      return true;
    }
  }

  /** Slot nach fehlgeschlagenem Publish freigeben (sonst blockiert er Wiederholungen). */
  private async releaseItemSlot(slotKey: string): Promise<void> {
    if (this.opts.dbAdapter?.type !== 'postgres') return;
    try {
      await this.opts.dbAdapter.execute('DELETE FROM reasoning_slots WHERE slot_key = ?', [slotKey]);
    } catch { /* non-critical */ }
  }
}
