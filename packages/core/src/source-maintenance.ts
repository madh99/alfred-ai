import type { Logger } from 'pino';
import type { InterestsRepository, InsightsRepository } from '@alfred/storage';
import type { SourceProvisioner } from './source-provisioner.js';

export interface FeedProbeResult {
  ok: boolean;
  /** ISO-Datum des neuesten Feed-Items (für Staleness-Erkennung). */
  newestIso?: string;
  detail?: string;
}

/**
 * v940 — Quellen-Pflege für den Interessen-Radar (wöchentlich, Muster v925-
 * Selbstheilung):
 *
 * 1. **Ausmisten:** jeder aktivierte RSS-Feed wird direkt geprobt (Parse) und
 *    auf Staleness geprüft (neuestes Item älter als 45 Tage). Ein Fehlschlag
 *    ist EIN Strike (persistiert in source.config._strikes) — erst der zweite
 *    Strike in Folge deaktiviert die Quelle (transiente Ausfälle killen also
 *    nichts). Gesunde Probe setzt Strikes zurück. Deaktivierte Quellen bleiben
 *    sichtbar (Interessen-UI) und sind reaktivierbar.
 * 2. **Nachbestücken:** hat ein Thema danach weniger als 2 funktionierende
 *    RSS-Feeds, läuft der Source-Provisioner erneut (neue Websuche, Probe-
 *    Parse-Validierung, Dedupe gegen Bestand — auch Such-Queries werden nicht
 *    dupliziert).
 * 3. **Transparenz:** Änderungen landen als EIN stiller Insights-Eintrag
 *    („Thema X: 2 Feeds neu, 1 toter deaktiviert").
 */
export class SourceMaintenance {
  constructor(
    private readonly repo: InterestsRepository,
    private readonly provisioner: SourceProvisioner | undefined,
    private readonly insightsRepo: InsightsRepository | undefined,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
    /** Testbar: Feed-Probe injizierbar (Default: rss-parser parseURL). */
    private readonly probe: (url: string) => Promise<FeedProbeResult> = defaultFeedProbe,
    private readonly opts: {
      minRssSources?: number;
      staleDays?: number;
      strikesToDisable?: number;
    } = {},
  ) {}

  async runWeekly(): Promise<{ checked: number; disabled: number; added: number }> {
    const minRss = this.opts.minRssSources ?? 2;
    const staleDays = this.opts.staleDays ?? 45;
    const strikesToDisable = this.opts.strikesToDisable ?? 2;
    const staleCutoff = Date.now() - staleDays * 24 * 3_600_000;

    const result = { checked: 0, disabled: 0, added: 0 };
    const reportLines: string[] = [];
    const topics = await this.repo.listAllActiveTopics();

    for (const topic of topics) {
      try {
        const sources = await this.repo.listSources(topic.id);
        const topicNotes: string[] = [];

        // (1) Ausmisten — nur aktivierte RSS-Feeds proben
        for (const source of sources.filter(s => s.enabled && s.kind === 'rss')) {
          const url = typeof source.config.url === 'string' ? source.config.url : '';
          if (!url) continue;
          result.checked++;
          const p = await this.probe(url).catch((err): FeedProbeResult => ({ ok: false, detail: (err as Error).message }));
          const stale = p.ok && p.newestIso !== undefined && Date.parse(p.newestIso) < staleCutoff;
          const prevStrikes = Number(source.config._strikes ?? 0);

          if (!p.ok || stale) {
            const strikes = prevStrikes + 1;
            const reason = !p.ok ? `nicht erreichbar (${p.detail ?? 'Parse-Fehler'})` : `keine neuen Beiträge seit >${staleDays} Tagen`;
            if (strikes >= strikesToDisable) {
              await this.repo.setSourceEnabled(source.id, false);
              await this.repo.updateSourceConfig(source.id, { ...source.config, _strikes: strikes, _disabledReason: reason });
              result.disabled++;
              topicNotes.push(`✕ Feed deaktiviert: ${url} — ${reason} (${strikes}. Strike)`);
            } else {
              await this.repo.updateSourceConfig(source.id, { ...source.config, _strikes: strikes });
              this.logger.info({ topic: topic.name, url, strikes, reason }, 'v940 feed strike');
            }
          } else if (prevStrikes > 0) {
            await this.repo.updateSourceConfig(source.id, { ...source.config, _strikes: 0 });
          }
        }

        // (2) Nachbestücken — unter Mindestbestand? Provisioner erneut
        if (this.provisioner) {
          const healthyRss = (await this.repo.listSources(topic.id, true)).filter(s => s.kind === 'rss').length;
          if (healthyRss < minRss) {
            const r = await this.provisioner.provision(topic);
            if (r.rssAdded.length > 0) {
              result.added += r.rssAdded.length;
              topicNotes.push(`+ ${r.rssAdded.length} neue(r) Feed(s): ${r.rssAdded.join(', ')}`);
            }
          }
        }

        if (topicNotes.length > 0) {
          reportLines.push(`**${topic.name}:**\n${topicNotes.join('\n')}`);
        }
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, topic: topic.name }, 'v940 source maintenance topic failed');
      }
    }

    // (3) Stiller Report — nur wenn sich etwas geändert hat
    if (reportLines.length > 0 && this.insightsRepo) {
      await this.insightsRepo.upsertCandidate(this.ownerUserId, {
        category: 'interests',
        title: `Quellen-Pflege: ${result.added} Feed(s) neu, ${result.disabled} deaktiviert`,
        body: `${reportLines.join('\n\n')}\n\n_Deaktivierte Quellen bleiben in der Interessen-UI sichtbar und sind reaktivierbar._`,
        confidence: 0.6,
        sourceData: { router: true, urgency: 'low', storedAt: new Date().toISOString() },
        dedupeKey: `source-maintenance:${new Date().toISOString().slice(0, 10)}`,
      }).catch(() => { /* non-critical */ });
    }

    if (result.checked > 0) this.logger.info(result, 'v940 source maintenance done');
    return result;
  }
}

async function defaultFeedProbe(url: string): Promise<FeedProbeResult> {
  let RSSParser: any;
  try {
    RSSParser = (await import('rss-parser')).default;
  } catch {
    const { createRequire } = await import('node:module');
    const { realpathSync } = await import('node:fs');
    RSSParser = createRequire(realpathSync(process.argv[1] || ''))('rss-parser');
  }
  try {
    const parser = new RSSParser({ timeout: 15_000 });
    const feed = await parser.parseURL(url);
    const items: any[] = feed.items ?? [];
    if (items.length === 0) return { ok: true }; // leer aber erreichbar — Staleness greift nicht
    const newest = items
      .map(i => Date.parse(i.isoDate ?? i.pubDate ?? ''))
      .filter(t => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    return { ok: true, newestIso: newest ? new Date(newest).toISOString() : undefined };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 120) };
  }
}
