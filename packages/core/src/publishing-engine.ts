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
 * v1075 — menschlicher Takt: deterministischer Publish-Jitter je Item
 * (FNV-1a-Hash → 0 bis maxMs). Kein Math.random: derselbe Wert bei jedem
 * Tick, das Item wird also GENAU EINMAL um diesen Versatz verschoben —
 * die exakten :01/:04-Engine-Zeiten waren ein Bot-Erkennungsmuster
 * (Realfall 09.07.: Instagram-Kontoeinschränkung).
 */
export function itemPublishJitterMs(itemId: string, maxMs = 10 * 60_000): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < itemId.length; i++) {
    h ^= itemId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % maxMs;
}

/**
 * v1075 — Publish-Fenster je Kanal: config.publish_window = [von, bis)
 * (lokale Stunden), false = kein Fenster. Default 7–22 Uhr; die eigene
 * Website (rest) darf rund um die Uhr veröffentlichen.
 */
export function publishWindowFor(channel: Pick<SocialChannel, 'platform' | 'config'>): { from: number; to: number } | null {
  const raw = channel.config.publish_window;
  if (raw === false) return null;
  if (Array.isArray(raw) && raw.length === 2 && raw.every(n => typeof n === 'number')) {
    return { from: Number(raw[0]), to: Number(raw[1]) };
  }
  if (channel.platform === 'rest') return null;
  return { from: 7, to: 22 };
}

/** v1075 — liegt „jetzt" im Fenster? (auch Über-Mitternacht-Fenster wie [22, 6)) */
export function isWithinWindow(win: { from: number; to: number } | null, now = new Date()): boolean {
  if (!win) return true;
  const h = now.getHours();
  return win.from <= win.to ? h >= win.from && h < win.to : (h >= win.from || h < win.to);
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
    private readonly publishItem: (itemId: string, opts?: { limitOverride?: boolean }) => Promise<PublishFnResult>,
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
      /** v1075 — menschlicher Takt (Jitter/Fenster/Mindestabstand) abschaltbar (Tests). */
      disableHumanPacing?: boolean;
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

  /**
   * v1075 — menschlicher Takt vor jedem Publish: Jitter (Item wird erst
   * scheduledAt + 0–10 min fällig), Publish-Fenster (Default 7–22 Uhr,
   * rest frei) und Mindestabstand je Kanal (Default 20 min; Realfall:
   * drei Stories in derselben Minute + Publishes um Mitternacht →
   * Instagram-Kontoeinschränkung). Alles nur AUFSCHUB — kein Item geht
   * verloren, der nächste Tick versucht es erneut.
   */
  private async humanPacingGate(item: ContentItem, channel: SocialChannel): Promise<boolean> {
    if (this.opts.disableHumanPacing === true) return true;
    // v1077 — Termin-Nähe-Schutz: würde weiterer Aufschub den Termin reißen
    // (terminBis in < 45 min), sofort durchlassen — lieber exakt am Tick als
    // verloren (das Publish-Gate verwirft abgelaufene Termine dauerhaft).
    const terminBis = typeof item.performance?.terminBis === 'string' ? Date.parse(item.performance.terminBis) : NaN;
    if (Number.isFinite(terminBis) && terminBis - Date.now() < 45 * 60_000 && terminBis > Date.now()) return true;
    // v1077 — „Wichtiges geht immer": Eilmeldungen (News-Desk-Marker) und
    // frische Recaps (< 90 min alt) überstimmen Fenster + Mindestabstand —
    // mit kurzem Eigen-Jitter (1–4 min) und Nacht-Deckel (max. 2 pro
    // Kanal/Tag außerhalb des Fensters), damit kein neues Bot-Muster entsteht.
    const isBreaking = PublishingEngine.isBreakingItem(item);
    if (isBreaking) {
      if (channel.config.publish_jitter !== false && item.scheduledAt
        && Date.now() < Date.parse(item.scheduledAt) + 60_000 + itemPublishJitterMs(item.id, 3 * 60_000)) return false;
      if (!isWithinWindow(publishWindowFor(channel)) && !(await this.nightExceptionAvailable(channel))) return false;
      return true;
    }
    if (channel.config.publish_jitter !== false && item.scheduledAt) {
      if (Date.now() < Date.parse(item.scheduledAt) + itemPublishJitterMs(item.id)) return false;
    }
    if (!isWithinWindow(publishWindowFor(channel))) return false;
    const gapMin = typeof channel.config.min_publish_gap_minutes === 'number' ? channel.config.min_publish_gap_minutes : 20;
    if (gapMin > 0) {
      const since = new Date(Date.now() - (gapMin + 15) * 60_000).toISOString();
      const recent = await this.repo.listItems(this.opts.ownerUserId, {
        channelId: channel.id, status: 'published', updatedSince: since, limit: 10,
      }).catch(() => [] as ContentItem[]);
      const cutoff = Date.now() - gapMin * 60_000;
      if (recent.some(p => p.publishedAt && Date.parse(p.publishedAt) > cutoff)) return false;
    }
    return true;
  }

  /** v1077 — Nacht-Ausnahmen-Deckel: max. 2 Publishes außerhalb des Fensters je Kanal und Tag. */
  private async nightExceptionAvailable(channel: SocialChannel): Promise<boolean> {
    try {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const recent = await this.repo.listItems(this.opts.ownerUserId, {
        channelId: channel.id, status: 'published', updatedSince: midnight.toISOString(), limit: 50,
      });
      const win = publishWindowFor(channel);
      const outside = recent.filter(p => p.publishedAt && !isWithinWindow(win, new Date(p.publishedAt))).length;
      return outside < 2;
    } catch { return false; }
  }

  /** v1100 — Eilmeldungs-Prädikat (geteilt: Nacht-Ausnahme + Limit-Override). */
  static isBreakingItem(item: ContentItem): boolean {
    return item.performance?.breaking === true
      || (item.performance?.art === 'recap' && Date.now() - Date.parse(item.createdAt) < 90 * 60_000);
  }

  /** v1100 — Ziel des Tages-Limit-Aufschubs: morgen Fensterbeginn + Item-Jitter. */
  private deferTarget(item: ContentItem, channel: SocialChannel): Date {
    const win = publishWindowFor(channel) ?? { from: 7, to: 22 };
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(win.from, Math.floor(itemPublishJitterMs(item.id, 45 * 60_000) / 60_000), 0, 0);
    return next;
  }

  /**
   * v1100 — „Wichtiges stirbt nicht am Limit": Eilmeldungen, frische Recaps
   * und Termin-Posts, deren Termin VOR dem Aufschub-Ziel läge, dürfen das
   * Tages-Limit einmalig überstimmen (der Skill deckelt hart auf +2/Tag).
   */
  private qualifiesForLimitOverride(item: ContentItem, channel: SocialChannel): boolean {
    if (PublishingEngine.isBreakingItem(item)) return true;
    const terminBis = typeof item.performance?.terminBis === 'string' ? Date.parse(item.performance.terminBis) : NaN;
    return Number.isFinite(terminBis) && terminBis > Date.now()
      && terminBis <= this.deferTarget(item, channel).getTime();
  }

  /** v1100 — Tages-Limit-Behandlung an beiden Publish-Pfaden: erst Override
   *  für Wichtiges versuchen, dann termin-bewusst verschieben. */
  private async handleDailyLimit(item: ContentItem, channel: SocialChannel): Promise<'published' | 'deferred' | 'rejected'> {
    if (this.qualifiesForLimitOverride(item, channel)) {
      const retry = await this.publishItem(item.id, { limitOverride: true });
      if (retry.success) {
        await this.router?.store({
          source: 'social', urgency: 'low',
          title: `Limit-Override: Wichtiges ging trotz Tages-Limit raus — ${(item.title ?? item.body).slice(0, 60)}`,
          body: `Kanal **${channel.name}**: Eilmeldung/Termin-Post wurde trotz erreichtem max_posts_per_day veröffentlicht (harter Deckel: +2/Tag).\n${retry.display ?? ''}`,
          chatId: this.opts.chatId, platform: this.opts.platform,
          dedupeKey: `social-limit-override:${item.id}`,
        });
        return 'published';
      }
    }
    return await this.deferToNextWindow(item, channel) ? 'deferred' : 'rejected';
  }

  /**
   * v1077 — Tages-Limit sanft: statt failed-Reibung rutscht das freigegebene
   * Item automatisch auf morgen früh (Fensterbeginn + Item-Jitter) — der
   * Mensch würde es morgen posten, nicht wegwerfen.
   * v1100 — termin-bewusst: liegt der Termin des Items VOR dem Aufschub-Ziel,
   * wäre der Post nach dem Event sinnlos → zurückziehen + laute Meldung
   * (der Override-Versuch ist an diesem Punkt bereits gescheitert).
   */
  private async deferToNextWindow(item: ContentItem, channel: SocialChannel): Promise<boolean> {
    const next = this.deferTarget(item, channel);
    const terminBis = typeof item.performance?.terminBis === 'string' ? Date.parse(item.performance.terminBis) : NaN;
    if (Number.isFinite(terminBis) && terminBis <= next.getTime()) {
      await this.repo.transition(this.opts.ownerUserId, item.id, 'rejected').catch(() => { /* best-effort */ });
      await this.router?.store({
        source: 'social', urgency: 'high',
        title: `Termin-Post am Tages-Limit gescheitert: ${(item.title ?? item.body).slice(0, 60)}`,
        body: `Kanal **${channel.name}**: Der Termin (${new Date(terminBis).toLocaleString('de-AT')}) liegt vor dem nächsten freien Fenster — Verschieben wäre nach dem Event. Das Item wurde zurückgezogen. max_posts_per_day prüfen oder manuell mit force posten.`,
        chatId: this.opts.chatId, platform: this.opts.platform,
        dedupeKey: `social-deferred:${item.id}`,
      });
      return false;
    }
    // v1100 — Füller-Verdrängung: ist morgen bereits voll verplant, weicht das
    // späteste Evergreen-Item (+1 Tag) — sonst liefe die wichtige Meldung
    // morgen wieder ins selbe Limit, nur weil der Tag mit Füllern belegt ist.
    if (PublishingEngine.isBreakingItem(item) || Number.isFinite(terminBis)) {
      await this.displaceEvergreenIfFull(channel, next).catch(() => { /* best-effort */ });
    }
    const ok = await this.repo.reschedule(this.opts.ownerUserId, item.id, next.toISOString(), [item.status]).catch(() => false);
    if (ok) {
      await this.router?.store({
        source: 'social', urgency: 'low',
        title: `Tages-Limit erreicht — auf morgen verschoben: ${(item.title ?? item.body).slice(0, 70)}`,
        body: `Kanal **${channel.name}**: max_posts_per_day ist ausgeschöpft. Der Beitrag ist automatisch auf ${next.toLocaleString('de-AT')} umterminiert (Freigabe bleibt erhalten).`,
        chatId: this.opts.chatId, platform: this.opts.platform,
        dedupeKey: `social-deferred:${item.id}`,
      });
    }
    return ok === true;
  }

  /** v1100 — späteste Evergreen-Planung des Zieltags um einen Tag schieben,
   *  wenn der Zieltag das Tages-Limit bereits voll ausschöpft. */
  private async displaceEvergreenIfFull(channel: SocialChannel, target: Date): Promise<void> {
    const dayStart = new Date(target); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const planned = await this.repo.listItems(this.opts.ownerUserId, {
      channelId: channel.id, status: ['scheduled', 'approved'], limit: 100,
    });
    const thatDay = planned.filter(i => i.scheduledAt
      && i.scheduledAt >= dayStart.toISOString() && i.scheduledAt < dayEnd.toISOString());
    if (thatDay.length < channel.maxPostsPerDay) return;
    const victim = thatDay
      .filter(i => i.performance?.art === 'evergreen' && typeof i.performance?.terminBis !== 'string')
      .sort((a, b) => b.scheduledAt!.localeCompare(a.scheduledAt!))[0];
    if (!victim) return;
    const to = new Date(Date.parse(victim.scheduledAt!) + 24 * 3_600_000).toISOString();
    if (await this.repo.reschedule(this.opts.ownerUserId, victim.id, to, [victim.status])) {
      this.logger.info({ channel: channel.name, victim: victim.id, to },
        'v1100 evergreen verdrängt (wichtige Meldung braucht das Tagesbudget)');
    }
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
        // v1075 — menschlicher Takt (Jitter/Fenster/Mindestabstand): nur Aufschub
        if (!(await this.humanPacingGate(item, channel))) continue;
        if (await this.claimItemSlot(`social-item:${item.id}`)) {
          const pub = await this.doPublish(item, channel);
          if (pub.ok) {
            result.published++;
          } else {
            // Slot freigeben — sonst blockiert der konsumierte Slot jeden
            // späteren Publish-Versuch dieses Items (nach Fix + Re-Approve)
            await this.releaseItemSlot(`social-item:${item.id}`);
            // v1077 — Tages-Limit: automatisch auf morgen früh umterminieren
            // statt failed-Reibung (Freigabe bleibt erhalten)
            // v1100 — Wichtiges (Eilmeldung/Termin) versucht vorher den Limit-Override
            if (/Tages-Limit/.test(pub.error ?? '')) {
              if (await this.handleDailyLimit(item, channel) === 'published') result.published++;
            }
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
          // v1075 — menschlicher Takt auch für autonome Publishes
          if (!(await this.humanPacingGate(item, channel))) continue;
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
              // v1077 — Tages-Limit: still auf morgen früh statt Freigabe-Lärm
              // v1096 — „Video wird gerendert": der Skill hat bereits +15 min
              // umterminiert — kein Nachfragen, die Engine kommt einfach wieder
              // v1100 — Wichtiges (Eilmeldung/Termin) versucht vorher den Limit-Override
              if (/Tages-Limit/.test(r.error ?? '')) {
                if (await this.handleDailyLimit(item, channel) === 'published') result.published++;
              } else if (/Video wird gerendert/.test(r.error ?? '')) {
                /* bereits umterminiert */
              } else if (await this.askApproval(item, channel, `Autonom-Publish blockiert: ${r.error ?? 'Leitplanke'}`)) result.asked++;
            }
          }
        } else if (channel.mode === 'approve' || channel.mode === 'autonomous') {
          if (await this.askApproval(item, channel)) result.asked++;
        }
        // suggest: kein aktives Nachfragen — Freigabe kommt vom User/Studio
      }

      // 3) Retry: fehlgeschlagene Publishes einmal nach 15 min — Rate-Limit-
      //    Fehler sind TRANSIENT und bekommen bis zu 3 weitere Anläufe mit
      //    wachsendem Abstand (v1123; Realfall 17.07.: Meta „Application
      //    request limit" — der Einmal-Retry fiel ins selbe Limit-Fenster,
      //    drei Posts blieben bis zum User-Eingriff liegen).
      const failed = await this.repo.listItems(owner, { status: 'failed' });
      const retryAfter = this.opts.retryAfterMs ?? 15 * 60_000;
      for (const item of failed) {
        const channel = channels.get(item.channelId);
        if (!channel || channel.status !== 'active') continue;
        const isRateLimit = /request limit|rate limit|too many requests/i.test(item.error ?? '');
        const limitRetries = typeof item.performance?.limitRetries === 'number' ? item.performance.limitRetries : 0;
        if (item.performance?.retried === true) {
          if (!isRateLimit || limitRetries >= 3) continue;
          // Backoff: nach dem 15-min-Erstretry 60 min, danach 120 min
          const delayMs = (limitRetries <= 1 ? 60 : 120) * 60_000;
          if (Date.now() - Date.parse(item.updatedAt) < delayMs) continue;
        } else if (Date.now() - Date.parse(item.updatedAt) < retryAfter) continue;
        // v1075 — auch Retries respektieren Fenster + Mindestabstand
        if (!(await this.humanPacingGate(item, channel))) continue;
        const attemptKey = item.performance?.retried === true ? `social-retry:${item.id}:r${limitRetries + 1}` : `social-retry:${item.id}`;
        if (!(await this.claimItemSlot(attemptKey))) continue;
        await this.repo.mergePerformance(owner, item.id, {
          retried: true, retriedAt: now,
          ...(isRateLimit ? { limitRetries: limitRetries + 1 } : {}),
        });
        const r = await this.publishItem(item.id);
        result.retried++;
        if (!r.success) {
          const nochOffen = /request limit|rate limit|too many requests/i.test(r.error ?? '') && limitRetries + 1 < 3;
          if (nochOffen) {
            this.logger.info({ itemId: item.id, attempt: limitRetries + 1 }, 'v1123 rate-limit retry fehlgeschlagen — nächster Anlauf mit Backoff');
          } else {
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

  private async doPublish(item: ContentItem, channel: SocialChannel): Promise<{ ok: boolean; error?: string }> {
    const r = await this.publishItem(item.id);
    if (r.success) {
      await this.router?.store({
        source: 'social', urgency: 'low',
        title: `Veröffentlicht: ${(item.title ?? item.body).slice(0, 80)}`,
        body: `Kanal **${channel.name}** (${channel.platform}).\n${r.display ?? ''}`,
        chatId: this.opts.chatId, platform: this.opts.platform,
        dedupeKey: `social-published:${item.id}`,
      });
      return { ok: true };
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
      return { ok: false, error: r.error };
    }
    this.logger.warn({ itemId: item.id, error: r.error }, 'v934 scheduled publish failed');
    return { ok: false, error: r.error };
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
