import type { Logger } from 'pino';
import type { ProjectRepository, MemoryRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, ConfirmationExtraAction } from '@alfred/types';
import type { ConfirmationQueue } from '../confirmation-queue.js';

/**
 * v614 L1 + L5 — Open-Items-Reflector
 *
 * Closes the "Alfred sees open items but does nothing" gap:
 *   - HOURLY: for high-priority items aged >4h and not yet escalated, send a
 *     one-time Telegram message asking if Alfred should tackle them. Dedup via
 *     a memory-marker so the same item is not re-asked every hour.
 *   - DAILY at 09:00 LOCAL: send a digest of ALL open items grouped by project.
 *
 * Why memory markers and not a separate table:
 *   - we already have a precedent (insight_delivered:* keys, type=feedback)
 *   - one less migration to maintain
 */

const ESCALATION_AGE_HOURS = 4;
const ESCALATION_DEDUP_PREFIX = 'open_item_escalated:';
/** v616 L8 — max Eskalationen pro stündlichem Sweep um eine Flood-Welle bei vielen
 *  alten high-prio Items zu vermeiden (am 2026-05-20 waren 11 Items eligible auf
 *  einmal). Älteste-zuerst-Sortierung sorgt dafür dass die brennendsten Themen
 *  zuerst dran kommen. Über mehrere Stunden wird der Backlog dann abgearbeitet. */
const MAX_ESCALATIONS_PER_SWEEP = 3;

export interface OpenItemsReflectorDeps {
  projectRepo: ProjectRepository;
  memoryRepo: MemoryRepository;
  adapters: Map<Platform, MessagingAdapter>;
  defaultPlatform: Platform;
  defaultChatId: string;
  ownerUserId: string;
  logger: Logger;
  /** v657 — optional: confirmationQueue für Multi-Action-Buttons (Eskalation als Confirmation enqueued). */
  confirmationQueue?: ConfirmationQueue;
}

export class OpenItemsReflector {
  constructor(private readonly deps: OpenItemsReflectorDeps) {}

  /**
   * Send escalation for each high-priority open item older than ESCALATION_AGE_HOURS
   * that has not yet been escalated. One Telegram message per item, deduped by
   * the escalation marker memory.
   */
  async hourlySweep(): Promise<void> {
    const { projectRepo, memoryRepo, logger, ownerUserId } = this.deps;
    if (!ownerUserId) { logger.debug('OpenItemsReflector.hourlySweep: no ownerUserId'); return; }

    let items;
    try {
      items = await projectRepo.listOpenItems(ownerUserId, { status: 'open', priority: 'high', limit: 50 });
    } catch (err) {
      logger.debug({ err }, 'OpenItemsReflector: listOpenItems failed');
      return;
    }

    if (items.length === 0) return;

    const cutoff = Date.now() - ESCALATION_AGE_HOURS * 3600_000;

    // v616 L8 — älteste-zuerst sortieren, dann durch MAX_ESCALATIONS_PER_SWEEP
    // limitieren. Verhindert Flood-Welle wenn viele Items gleichzeitig
    // eskalations-fällig sind (z.B. Erstdeploy nach v615 hätte 11 Nachrichten
    // auf einmal produziert).
    items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let sentThisSweep = 0;

    for (const item of items) {
      if (sentThisSweep >= MAX_ESCALATIONS_PER_SWEEP) {
        logger.info({ remaining: items.length - sentThisSweep, sentThisSweep },
          'OpenItemsReflector L8: rate-limit reached, deferring rest to next sweep');
        break;
      }
      const itemAge = Date.now() - new Date(item.createdAt).getTime();
      if (itemAge < ESCALATION_AGE_HOURS * 3600_000) continue;
      if (new Date(item.createdAt).getTime() < cutoff - 7 * 24 * 3600_000) {
        // older than a week — skip; user clearly doesn't want it tackled
        continue;
      }

      const markerKey = `${ESCALATION_DEDUP_PREFIX}${item.id}`;
      let alreadyEscalated = false;
      try {
        const existing = await memoryRepo.search(ownerUserId, markerKey);
        alreadyEscalated = existing.some(m => m.key === markerKey);
      } catch { /* fall through, send anyway */ }

      if (alreadyEscalated) continue;

      // v657 — Snooze-Check: wenn der User „⏰ Zurückstellen" gewählt hat, ist ein
      //   open_item_snoozed:<id> Memory bis zur snoozeUntil-Zeit vorhanden.
      try {
        const snoozeKey = `open_item_snoozed:${item.id}`;
        const snoozeMems = await memoryRepo.search(ownerUserId, snoozeKey);
        const snooze = snoozeMems.find(m => m.key === snoozeKey);
        if (snooze) {
          // value: "Snoozed bis 2026-05-22T18:00:00.000Z"
          const m = /Snoozed bis (\S+)/.exec(snooze.value);
          if (m && new Date(m[1]).getTime() > Date.now()) {
            continue; // noch nicht abgelaufen
          }
          // Snooze abgelaufen → Memory löschen (best effort)
          try { await memoryRepo.delete(ownerUserId, snoozeKey); } catch { /* skip */ }
        }
      } catch { /* skip snooze check */ }

      const hours = Math.floor(itemAge / 3600_000);
      const project = await projectRepo.getById(ownerUserId, item.projectId).catch(() => null);
      const projectName = project?.name?.slice(0, 60) ?? 'unbekanntes Projekt';

      // v657 — Wenn ConfirmationQueue verfügbar: enqueue mit 4 Actions
      //   ja (approve)  → project_agent.start mit Goal
      //   nein (reject) → keine Aktion, Eskalation deduped (Marker bleibt)
      //   ablehnen      → Open-Item.status = cancelled
      //   zurückstellen → Snooze für 24h
      const description =
        `🔴 High-Priority Open Item (${hours}h offen)\n\n` +
        `📋 ${item.title}\n` +
        `📂 Projekt: ${projectName}` +
        (item.description ? `\n\nBeschreibung: ${item.description.slice(0, 300)}` : '');

      try {
        if (this.deps.confirmationQueue) {
          const extraActions: ConfirmationExtraAction[] = [
            { key: 'cancel_item', label: '🗑 Open-Item ablehnen', kind: 'cancel-item', openItemId: item.id },
            { key: 'snooze_24h', label: '⏰ 24h zurückstellen', kind: 'defer', openItemId: item.id, deferHours: 24 },
          ];
          await this.deps.confirmationQueue.enqueue({
            chatId: this.deps.defaultChatId,
            platform: this.deps.defaultPlatform,
            source: 'reasoning',
            sourceId: `open_item:${item.id}`,
            description,
            // 'ja' startet einen Project-Agent für genau dieses Item
            skillName: 'project_agent',
            skillParams: {
              action: 'start',
              goal: item.title + (item.description ? `\n\n${item.description}` : ''),
              cwd: project?.cwd,
              link_open_item_id: item.id,
            },
            extraActions,
            timeoutMinutes: 24 * 60,
          });
        } else {
          // Fallback ohne ConfirmationQueue (legacy): plain text
          await this.send(
            `🔴 **High-Priority Open Item — ${hours}h offen**\n\n` +
            `📋 ${item.title}\n📂 Projekt: ${projectName}\n\n` +
            (item.description ? `Beschreibung: ${item.description.slice(0, 300)}\n\n` : '') +
            `Soll ich mich darum kümmern? Antworte mit "ja" / "nein" oder lass es liegen.`,
          );
        }
        sentThisSweep++;
        await memoryRepo.saveWithMetadata(
          ownerUserId,
          markerKey,
          `Eskaliert: ${item.title.slice(0, 100)} (${hours}h)`,
          'general',
          'feedback',
          1.0,
          'auto',
        );
        logger.info({ itemId: item.id, hours, title: item.title.slice(0, 60) },
          'OpenItemsReflector: high-priority item escalated');
      } catch (err) {
        logger.debug({ err, itemId: item.id }, 'OpenItemsReflector: send failed');
      }
    }
  }

  /**
   * Daily 09:00 LOCAL: send a digest of all open items grouped by project.
   * Dedup: only send if we have NOT sent a digest today (memory marker).
   */
  async dailyDigest(): Promise<void> {
    const { projectRepo, memoryRepo, logger, ownerUserId } = this.deps;
    if (!ownerUserId) return;

    const today = new Date().toISOString().slice(0, 10);
    const digestMarkerKey = `open_items_digest_sent:${today}`;
    try {
      const existing = await memoryRepo.search(ownerUserId, digestMarkerKey);
      if (existing.some(m => m.key === digestMarkerKey)) {
        logger.debug({ today }, 'OpenItemsReflector: daily digest already sent today');
        return;
      }
    } catch { /* fall through, send anyway */ }

    let items;
    try {
      items = await projectRepo.listOpenItems(ownerUserId, { status: 'open', limit: 100 });
    } catch (err) {
      logger.debug({ err }, 'OpenItemsReflector dailyDigest: listOpenItems failed');
      return;
    }
    if (items.length === 0) return;

    // Group by project
    const byProject = new Map<string, typeof items>();
    for (const item of items) {
      const arr = byProject.get(item.projectId) ?? [];
      arr.push(item);
      byProject.set(item.projectId, arr);
    }

    const lines: string[] = [`📋 **Tägliche Open-Items-Übersicht**\n`];
    let totalHigh = 0;
    for (const [projectId, projItems] of byProject) {
      const proj = await projectRepo.getById(ownerUserId, projectId).catch(() => null);
      const name = proj?.name?.slice(0, 60) ?? 'Unbekanntes Projekt';
      const highCount = projItems.filter(i => i.priority === 'high').length;
      totalHigh += highCount;
      lines.push(`\n**${name}** (${projItems.length} offen${highCount > 0 ? `, ${highCount} hoch` : ''})`);
      for (const item of projItems.slice(0, 5)) {
        const icon = item.priority === 'high' ? '🔴' : item.priority === 'low' ? '⚪' : '🟡';
        const ageDays = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 86400_000);
        const ageStr = ageDays === 0 ? 'heute' : ageDays === 1 ? 'gestern' : `vor ${ageDays}d`;
        lines.push(`  ${icon} ${item.title.slice(0, 80)} (${ageStr})`);
      }
      if (projItems.length > 5) lines.push(`  … und ${projItems.length - 5} weitere`);
    }
    lines.push(`\n${totalHigh > 0
      ? `Welche der ${totalHigh} hoch-priorisierten möchtest du heute angehen?`
      : 'Welche möchtest du heute angehen?'}`);

    try {
      await this.send(lines.join('\n'));
      await memoryRepo.saveWithMetadata(
        ownerUserId, digestMarkerKey,
        `Digest gesendet: ${items.length} items, ${totalHigh} high`,
        'general', 'feedback', 1.0, 'auto',
      );
      logger.info({ total: items.length, totalHigh }, 'OpenItemsReflector: daily digest sent');
    } catch (err) {
      logger.debug({ err }, 'OpenItemsReflector: digest send failed');
    }
  }

  private async send(text: string): Promise<void> {
    const adapter = this.deps.adapters.get(this.deps.defaultPlatform);
    if (!adapter) return;
    await adapter.sendMessage(this.deps.defaultChatId, text);
  }
}
