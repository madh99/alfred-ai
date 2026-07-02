import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { InterestsRepository, InterestTopic, TopicItem } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

type InterestsAction = 'create_topic' | 'list_topics' | 'add_source' | 'remove_source'
  | 'topic_briefing' | 'collect_now' | 'set_status';

/** v929 — Formatiert das Themen-Dossier + neueste Items (pure, testbar). */
export function formatTopicBriefing(
  topic: InterestTopic,
  digest: { summary: string; updatedAt: string } | null,
  items: TopicItem[],
): string {
  const lines: string[] = [`📡 **${topic.name}**`];
  if (topic.keywords.length > 0) lines.push(`_Stichwörter: ${topic.keywords.join(', ')}_`);
  lines.push('');
  if (digest) {
    lines.push(digest.summary.trim());
    lines.push('');
    lines.push(`_Dossier-Stand: ${digest.updatedAt.slice(0, 16).replace('T', ' ')}_`);
  } else if (items.length === 0) {
    lines.push('Noch keine gesammelten Beiträge — Quellen hinzufügen oder den nächsten Sammellauf abwarten.');
  }
  if (items.length > 0) {
    lines.push('');
    lines.push(`**Neueste Beiträge (${items.length}):**`);
    for (const i of items.slice(0, 10)) {
      const when = (i.publishedAt ?? i.createdAt).slice(0, 10);
      lines.push(`• ${i.title}${i.url ? `\n  ${i.url}` : ''} _(${when})_`);
    }
  }
  return lines.join('\n');
}

/**
 * v929 — Interessen-Radar: Themen verwalten, Quellen abonnieren, Dossier abrufen.
 * Der stündliche TopicCollector (core) sammelt still; dieser Skill ist die
 * Chat-Schnittstelle („Was gibt's Neues zu Claude Fable?" → topic_briefing).
 */
export class InterestsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'interests',
    category: 'information',
    description: 'Interessen-Radar: verwaltet Themen die Alfred laufend beobachtet (RSS + Web-Suche, stündlich gesammelt). Bei Fragen wie "was gibt es Neues zu <Thema>" oder "aktuelle Entwicklungen rund um <Thema>" IMMER zuerst action=topic_briefing versuchen — dort liegt das gesammelte Dossier. Neue Dauer-Interessen des Users → create_topic + add_source.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_topic', 'list_topics', 'add_source', 'remove_source', 'topic_briefing', 'collect_now', 'set_status'],
          description: 'create_topic: neues Thema anlegen; list_topics: alle Themen; add_source/remove_source: Quelle (rss|web_search) verwalten; topic_briefing: Dossier + neueste Beiträge zu einem Thema; collect_now: sofort sammeln; set_status: active|paused|archived',
        },
        topic: { type: 'string', description: 'Themenname (fuzzy match) — für alle Aktionen außer create_topic/list_topics' },
        name: { type: 'string', description: 'create_topic: Name des Themas' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'create_topic: Stichwörter für Relevanz-Matching' },
        kind: { type: 'string', enum: ['rss', 'web_search'], description: 'add_source: Quellentyp' },
        url: { type: 'string', description: 'add_source kind=rss: Feed-URL' },
        query: { type: 'string', description: 'add_source kind=web_search: stehende Suchanfrage' },
        source_id: { type: 'string', description: 'remove_source: ID der Quelle (aus list_topics)' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'set_status: neuer Status' },
      },
      required: ['action'],
    },
  };

  /** v929 — Collector-Referenz für collect_now (vom Kern injiziert). */
  private collectNowFn?: (topic?: InterestTopic) => Promise<number>;

  constructor(
    private readonly repo: InterestsRepository,
    private readonly llm?: LLMProvider,
  ) {
    super();
  }

  setCollector(fn: (topic?: InterestTopic) => Promise<number>): void {
    this.collectNowFn = fn;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as InterestsAction;
    const userId = (context as { masterUserId?: string }).masterUserId ?? context.userId;

    switch (action) {
      case 'create_topic': return this.createTopic(userId, input);
      case 'list_topics': return this.listTopics(userId);
      case 'add_source': return this.addSource(userId, input);
      case 'remove_source': return this.removeSource(userId, input);
      case 'topic_briefing': return this.topicBriefing(userId, input);
      case 'collect_now': return this.collectNow(userId, input);
      case 'set_status': return this.setStatus(userId, input);
      default: return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private async createTopic(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const name = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : (typeof input.topic === 'string' ? input.topic.trim() : '');
    if (!name) return { success: false, error: 'name erforderlich' };
    const existing = await this.repo.findTopicByName(userId, name);
    if (existing) {
      return {
        success: true,
        data: { topic: existing, existed: true },
        display: `Thema **${existing.name}** existiert bereits (Status: ${existing.status}).`,
      };
    }
    const keywords = Array.isArray(input.keywords) ? input.keywords.map(String) : [];
    const topic = await this.repo.createTopic(userId, { name, keywords });
    return {
      success: true,
      data: { topic },
      display: `📡 Thema **${name}** angelegt${keywords.length ? ` (Stichwörter: ${keywords.join(', ')})` : ''}.\nQuellen hinzufügen mit add_source (rss-URL oder web_search-Query) — gesammelt wird stündlich.`,
    };
  }

  private async listTopics(userId: string): Promise<SkillResult> {
    const topics = await this.repo.listTopics(userId);
    if (topics.length === 0) {
      return { success: true, data: { topics: [] }, display: 'Keine Interessen-Themen angelegt. Mit create_topic startet die Beobachtung.' };
    }
    const lines: string[] = [`📡 **Interessen-Themen (${topics.length}):**`];
    for (const t of topics) {
      const sources = await this.repo.listSources(t.id);
      const digest = await this.repo.getDigest(t.id);
      const statusTag = t.status === 'active' ? '' : ` [${t.status}]`;
      lines.push(`• **${t.name}**${statusTag} — ${sources.length} Quelle(n)${digest ? `, Dossier vom ${digest.updatedAt.slice(0, 10)}` : ''}`);
      for (const s of sources) {
        const what = s.kind === 'rss' ? String(s.config.url ?? '') : `Suche: ${String(s.config.query ?? '')}`;
        lines.push(`   - [${s.id.slice(0, 8)}] ${s.kind}: ${what}${s.enabled ? '' : ' (deaktiviert)'}`);
      }
    }
    return { success: true, data: { topics }, display: lines.join('\n') };
  }

  private async resolveTopic(userId: string, input: Record<string, unknown>): Promise<InterestTopic | null> {
    const q = typeof input.topic === 'string' ? input.topic : (typeof input.name === 'string' ? input.name : '');
    if (!q) return null;
    return this.repo.findTopicByName(userId, q);
  }

  private async addSource(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const topic = await this.resolveTopic(userId, input);
    if (!topic) return { success: false, error: `Thema nicht gefunden: ${String(input.topic ?? '')}` };
    const kind = input.kind === 'rss' || input.kind === 'web_search' ? input.kind : undefined;
    if (!kind) return { success: false, error: 'kind erforderlich (rss | web_search)' };
    if (kind === 'rss' && typeof input.url !== 'string') return { success: false, error: 'url erforderlich für kind=rss' };
    if (kind === 'web_search' && typeof input.query !== 'string') return { success: false, error: 'query erforderlich für kind=web_search' };
    const config = kind === 'rss' ? { url: String(input.url) } : { query: String(input.query) };
    const source = await this.repo.addSource(topic.id, { kind, config, addedBy: 'manual' });
    return {
      success: true,
      data: { source },
      display: `Quelle zu **${topic.name}** hinzugefügt: ${kind === 'rss' ? config.url : `Suche „${config.query}"`}\nNächster stündlicher Sammellauf nimmt sie mit (oder collect_now).`,
    };
  }

  private async removeSource(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const topic = await this.resolveTopic(userId, input);
    if (!topic) return { success: false, error: `Thema nicht gefunden: ${String(input.topic ?? '')}` };
    const sourceId = typeof input.source_id === 'string' ? input.source_id : '';
    if (!sourceId) return { success: false, error: 'source_id erforderlich (aus list_topics)' };
    // Kurz-IDs (8 Zeichen aus list_topics) auflösen
    const sources = await this.repo.listSources(topic.id);
    const match = sources.find(s => s.id === sourceId || s.id.startsWith(sourceId));
    if (!match) return { success: false, error: `Quelle ${sourceId} nicht gefunden bei ${topic.name}` };
    await this.repo.removeSource(topic.id, match.id);
    return { success: true, display: `Quelle entfernt von **${topic.name}**.` };
  }

  private async topicBriefing(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const topic = await this.resolveTopic(userId, input);
    if (!topic) {
      const topics = await this.repo.listTopics(userId, 'active');
      return {
        success: false,
        error: `Thema nicht gefunden: ${String(input.topic ?? '')}${topics.length ? ` — vorhandene Themen: ${topics.map(t => t.name).join(', ')}` : ' — noch keine Themen angelegt (create_topic)'}`,
      };
    }
    const [digest, items] = await Promise.all([
      this.repo.getDigest(topic.id),
      this.repo.listItems(topic.id, { limit: 15 }),
    ]);

    // Lazy Dossier-Refresh: neue Items seit dem letzten Dossier → per LLM aktualisieren
    let effectiveDigest = digest;
    if (this.llm) {
      const newSince = digest ? await this.repo.countItemsSince(topic.id, digest.updatedAt) : items.length;
      if (newSince > 0 && items.length > 0) {
        try {
          const refreshed = await this.refreshDigest(topic, digest?.summary, items);
          if (refreshed) effectiveDigest = { topicId: topic.id, summary: refreshed, itemsSinceUpdate: 0, updatedAt: new Date().toISOString() };
        } catch { /* Dossier-Refresh best-effort — Items werden trotzdem gezeigt */ }
      }
    }

    return {
      success: true,
      data: { topic, digest: effectiveDigest, items },
      display: formatTopicBriefing(topic, effectiveDigest, items),
    };
  }

  private async refreshDigest(topic: InterestTopic, previousSummary: string | undefined, items: TopicItem[]): Promise<string | null> {
    if (!this.llm) return null;
    const itemLines = items.slice(0, 15).map(i =>
      `- ${i.title}${i.summary ? `: ${i.summary.slice(0, 200)}` : ''} (${(i.publishedAt ?? i.createdAt).slice(0, 10)})`,
    ).join('\n');
    const prompt = `Du pflegst ein rollendes Themen-Dossier für "${topic.name}".
${previousSummary ? `Bisheriges Dossier:\n${previousSummary}\n\n` : ''}Neue gesammelte Beiträge:
${itemLines}

Aktualisiere das Dossier: 4-8 Sätze, deutsch, sachlich, neueste Entwicklungen zuerst, Überholtes raus. Nur der Dossier-Text, keine Einleitung.`;
    const response = await this.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 600,
      tier: 'fast',
    });
    const summary = response.content?.trim();
    if (!summary || summary.length < 20) return null;
    await this.repo.upsertDigest(topic.id, summary);
    return summary;
  }

  private async collectNow(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.collectNowFn) return { success: false, error: 'Collector nicht verfügbar.' };
    const topic = typeof input.topic === 'string' && input.topic.trim().length > 0
      ? await this.resolveTopic(userId, input)
      : undefined;
    if (input.topic && !topic) return { success: false, error: `Thema nicht gefunden: ${String(input.topic)}` };
    const count = await this.collectNowFn(topic ?? undefined);
    return {
      success: true,
      data: { newItems: count },
      display: `Sammellauf fertig: ${count} neue Beiträge${topic ? ` zu **${topic.name}**` : ''}.`,
    };
  }

  private async setStatus(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const topic = await this.resolveTopic(userId, input);
    if (!topic) return { success: false, error: `Thema nicht gefunden: ${String(input.topic ?? '')}` };
    const status = input.status === 'active' || input.status === 'paused' || input.status === 'archived' ? input.status : undefined;
    if (!status) return { success: false, error: 'status erforderlich (active | paused | archived)' };
    await this.repo.updateTopic(userId, topic.id, { status });
    return { success: true, display: `Thema **${topic.name}** ist jetzt ${status}.` };
  }
}
