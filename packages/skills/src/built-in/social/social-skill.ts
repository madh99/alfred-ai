import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { SocialRepository, SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import type { SocialProvider } from './social-provider.js';
import { composePostText } from './social-provider.js';

type SocialAction =
  | 'create_channel' | 'list_channels' | 'update_channel' | 'set_channel_status'
  | 'validate_auth' | 'pause_all' | 'resume_channel'
  | 'add_content' | 'list_content' | 'schedule_content' | 'approve_content'
  | 'reject_content' | 'publish_now' | 'mark_published' | 'delete_remote' | 'attach_media'
  | 'generate_content';

/** Formatiert die prepare-Aufbereitung: alles, was der User zum 2-Tap-Posten braucht. */
export function formatPreparedPost(item: ContentItem, channel: SocialChannel): string {
  const lines: string[] = [
    `📤 **Fertig aufbereitet für ${channel.name}** (${channel.platform}, manuell posten):`,
    '',
    '```',
    composePostText(item),
    '```',
  ];
  if (item.media.length > 0) {
    lines.push('', `**Medien (${item.media.length}):**`);
    for (const m of item.media) lines.push(`• ${m.type}: ${m.pathOrUrl}`);
  }
  if (item.scheduledAt) lines.push('', `⏰ Geplanter Zeitpunkt: ${item.scheduledAt.slice(0, 16).replace('T', ' ')}`);
  lines.push('', `_Nach dem Posten: mark_published mit item_id ${item.id.slice(0, 8)} (optional external_url) — dann trackt Alfred den Post._`);
  return lines.join('\n');
}

/**
 * v933 — Social-Media-Betrieb: Kanäle verwalten, Content-Pipeline
 * (idea→draft→scheduled→approved→published), publishen via Provider (api-Modus)
 * oder fertig aufbereiten (prepare-Modus). Publishing-Engine/Modi-Automatik
 * folgt in v934, Content-Studio in v935 (Plan: docs/specs/social-media-plan-v933-v938.md).
 */
export class SocialSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'social',
    category: 'automation',
    description: 'Social-Media-Kanäle betreiben: Kanäle je Projekt oder standalone verwalten (Telegram-Kanal, eigene Plattform via REST; weitere folgen), Content-Pipeline (Entwurf → geplant → freigegeben → veröffentlicht), sofort posten (publish_now) oder fertig aufbereiten zum manuellen Posten (prepare-Modus). "Social-Stopp" = pause_all. Bei "poste auf <Kanal>" oder "plane einen Post": diesen Skill nutzen.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_channel', 'list_channels', 'update_channel', 'set_channel_status',
            'validate_auth', 'pause_all', 'resume_channel',
            'add_content', 'list_content', 'schedule_content', 'approve_content',
            'reject_content', 'publish_now', 'mark_published', 'delete_remote', 'attach_media',
            'generate_content'],
          description: 'Kanal-Verwaltung, Content-Pipeline oder Veröffentlichung. pause_all = Not-Aus für alle Kanäle ("Social-Stopp"). generate_content = Content-Studio sofort für einen Kanal laufen lassen (Ideen/Entwürfe erzeugen).',
        },
        channel: { type: 'string', description: 'Kanal-Name/-Handle/-Plattform (fuzzy) oder Kanal-ID' },
        platform: { type: 'string', enum: ['telegram_channel', 'rest'], description: 'create_channel: Plattform (v933: telegram_channel, rest; YouTube/Meta folgen)' },
        name: { type: 'string', description: 'create_channel: Anzeigename des Kanals' },
        project: { type: 'string', description: 'create_channel: optional Projekt-Name/-ID (Kanal hängt am Projekt, Secrets aus dessen ENVs)' },
        config: { type: 'object', description: 'create_channel/update_channel: Provider-Config (telegram_channel: {chat_id}; rest: {base_url, publish_path?, insecure_tls?, env_stage?})' },
        mode: { type: 'string', enum: ['suggest', 'approve', 'autonomous'], description: 'update_channel: Arbeitsmodus (Automatik ab v934)' },
        publish_mode: { type: 'string', enum: ['api', 'prepare'], description: 'api = Alfred veröffentlicht selbst; prepare = Alfred bereitet auf, User postet' },
        persona: { type: 'string', description: 'update_channel: Tonalität/Persona für Content-Erstellung' },
        posting_slots: { type: 'array', items: { type: 'string' }, description: 'update_channel: bevorzugte Slots, z.B. ["Mo 18:00", "Do 19:30"]' },
        blacklist: { type: 'array', items: { type: 'string' }, description: 'update_channel: Tabu-Wörter/-Themen (Leitplanke)' },
        max_posts_per_day: { type: 'number', description: 'update_channel: Tages-Limit (Default 3)' },
        planning_horizon_days: { type: 'number', description: 'update_channel: wie weit Alfred vorausplant (Default 14)' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'set_channel_status' },
        item_id: { type: 'string', description: 'Content-Item-ID (Kurzform 8 Zeichen reicht)' },
        title: { type: 'string', description: 'add_content: Titel (optional)' },
        body: { type: 'string', description: 'add_content: Post-Text' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'add_content: Hashtags' },
        media_url: { type: 'string', description: 'add_content/attach_media: Bild-/Video-URL oder lokaler Pfad' },
        media_type: { type: 'string', enum: ['image', 'video', 'audio'], description: 'attach_media: Medientyp (Default image)' },
        scheduled_at: { type: 'string', description: 'schedule_content: ISO-Zeitpunkt der Veröffentlichung' },
        content_status: { type: 'string', description: 'list_content: Filter (draft|scheduled|approved|published|failed|…)' },
        external_url: { type: 'string', description: 'mark_published: URL des manuell geposteten Beitrags' },
      },
      required: ['action'],
    },
  };

  /** Provider-Registry (vom Kern befüllt). */
  private providers = new Map<string, SocialProvider>();
  /** Secrets-Resolver (vom Kern injiziert; project_environments, verschlüsselt). */
  private resolveSecretsFn?: (channel: SocialChannel) => Promise<Record<string, string>>;
  /** Projekt-Resolver: Name/ID → Projekt-ID (optional). */
  private resolveProjectFn?: (nameOrId: string) => Promise<string | null>;
  /** v935 — Content-Studio-Aufruf für generate_content (vom Kern injiziert). */
  private studioFn?: (channel: SocialChannel) => Promise<number>;

  constructor(private readonly repo: SocialRepository) {
    super();
  }

  setStudio(fn: (channel: SocialChannel) => Promise<number>): void {
    this.studioFn = fn;
  }

  registerProvider(provider: SocialProvider): void {
    this.providers.set(provider.platform, provider);
  }

  setSecretsResolver(fn: (channel: SocialChannel) => Promise<Record<string, string>>): void {
    this.resolveSecretsFn = fn;
  }

  setProjectResolver(fn: (nameOrId: string) => Promise<string | null>): void {
    this.resolveProjectFn = fn;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as SocialAction;
    const userId = (context as { masterUserId?: string }).masterUserId ?? context.userId;
    try {
      switch (action) {
        case 'create_channel': return await this.createChannel(userId, input);
        case 'list_channels': return await this.listChannels(userId);
        case 'update_channel': return await this.updateChannel(userId, input);
        case 'set_channel_status': return await this.setChannelStatus(userId, input);
        case 'validate_auth': return await this.validateAuth(userId, input);
        case 'pause_all': return await this.pauseAll(userId);
        case 'resume_channel': return await this.setChannelStatus(userId, { ...input, status: 'active' });
        case 'add_content': return await this.addContent(userId, input);
        case 'list_content': return await this.listContent(userId, input);
        case 'schedule_content': return await this.scheduleContent(userId, input);
        case 'approve_content': return await this.approveContent(userId, input);
        case 'reject_content': return await this.transitionSimple(userId, input, 'rejected', 'Abgelehnt — Item bleibt als rejected erhalten (kann als Entwurf reaktiviert werden).');
        case 'publish_now': return await this.publishNow(userId, input);
        case 'mark_published': return await this.markPublished(userId, input);
        case 'delete_remote': return await this.deleteRemote(userId, input);
        case 'attach_media': return await this.attachMedia(userId, input);
        case 'generate_content': return await this.generateContent(userId, input);
        default: return { success: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ── Kanäle ────────────────────────────────────────────────────────────

  private async createChannel(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const platform = typeof input.platform === 'string' ? input.platform : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!platform || !name) return { success: false, error: 'platform und name erforderlich' };
    if (!this.providers.has(platform)) {
      return { success: false, error: `Plattform ${platform} nicht verfügbar — vorhanden: ${[...this.providers.keys()].join(', ')}` };
    }
    let projectId: string | undefined;
    if (typeof input.project === 'string' && input.project.trim() && this.resolveProjectFn) {
      const resolved = await this.resolveProjectFn(input.project.trim());
      if (!resolved) return { success: false, error: `Projekt nicht gefunden: ${input.project}` };
      projectId = resolved;
    }
    const channel = await this.repo.createChannel(userId, {
      platform, name, projectId,
      publishMode: input.publish_mode === 'api' ? 'api' : 'prepare',
      config: (input.config && typeof input.config === 'object' ? input.config : {}) as Record<string, unknown>,
    });
    return {
      success: true,
      data: { channel },
      display: `📣 Kanal **${name}** (${platform}) angelegt — Modus: suggest, Publish: ${channel.publishMode}${projectId ? `, Projekt-gebunden` : ''}.\n`
        + `Erstpost-Sperre aktiv: die ersten 5 Posts brauchen deine Freigabe. Auth prüfen: validate_auth.`,
    };
  }

  private async resolveChannel(userId: string, input: Record<string, unknown>): Promise<SocialChannel | null> {
    const q = typeof input.channel === 'string' ? input.channel.trim() : '';
    if (!q) return null;
    const byId = await this.repo.getChannel(userId, q);
    if (byId) return byId;
    return this.repo.findChannelByName(userId, q);
  }

  private async listChannels(userId: string): Promise<SkillResult> {
    const channels = await this.repo.listChannels(userId);
    if (channels.length === 0) {
      return { success: true, data: { channels: [] }, display: 'Keine Social-Kanäle angelegt. create_channel startet (telegram_channel oder rest).' };
    }
    const lines = [`📣 **Social-Kanäle (${channels.length}):**`];
    for (const c of channels) {
      const drafts = await this.repo.listItems(userId, { channelId: c.id, status: ['draft', 'scheduled', 'approved'] });
      lines.push(`• **${c.name}** [${c.id.slice(0, 8)}] — ${c.platform}, ${c.mode}/${c.publishMode}, ${c.status}`
        + `${c.projectId ? ', Projekt-gebunden' : ''} — ${drafts.length} offene Items, Streak ${c.approvedStreak}/5`);
    }
    return { success: true, data: { channels }, display: lines.join('\n') };
  }

  private async updateChannel(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const patch: Record<string, unknown> = {};
    if (input.mode === 'suggest' || input.mode === 'approve' || input.mode === 'autonomous') patch.mode = input.mode;
    if (input.publish_mode === 'api' || input.publish_mode === 'prepare') patch.publishMode = input.publish_mode;
    if (typeof input.persona === 'string') patch.persona = input.persona;
    if (Array.isArray(input.posting_slots)) patch.postingSlots = input.posting_slots.map(String);
    if (Array.isArray(input.blacklist)) patch.blacklist = input.blacklist.map(String);
    if (typeof input.max_posts_per_day === 'number') patch.maxPostsPerDay = input.max_posts_per_day;
    if (typeof input.planning_horizon_days === 'number') patch.planningHorizonDays = input.planning_horizon_days;
    if (input.config && typeof input.config === 'object') patch.config = { ...channel.config, ...(input.config as Record<string, unknown>) };
    if (typeof input.name === 'string' && input.name.trim()) patch.name = input.name.trim();
    if (Object.keys(patch).length === 0) return { success: false, error: 'Nichts zu ändern übergeben.' };
    await this.repo.updateChannel(userId, channel.id, patch);
    let note = '';
    if (patch.mode === 'autonomous' && channel.approvedStreak < 5) {
      note = `\n⚠️ Erstpost-Sperre: autonomous wird erst nach 5 Freigaben ohne Korrektur wirksam (aktuell ${channel.approvedStreak}/5) — bis dahin verhält sich der Kanal wie approve.`;
    }
    return { success: true, display: `Kanal **${channel.name}** aktualisiert (${Object.keys(patch).join(', ')}).${note}` };
  }

  private async setChannelStatus(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const status = input.status === 'active' || input.status === 'paused' || input.status === 'archived' ? input.status : undefined;
    if (!status) return { success: false, error: 'status erforderlich (active|paused|archived)' };
    await this.repo.updateChannel(userId, channel.id, { status });
    return { success: true, display: `Kanal **${channel.name}** ist jetzt ${status}.` };
  }

  private async pauseAll(userId: string): Promise<SkillResult> {
    const n = await this.repo.pauseAll(userId);
    return { success: true, data: { paused: n }, display: `🛑 Social-Stopp: ${n} Kanal/Kanäle pausiert. Reaktivieren je Kanal mit resume_channel.` };
  }

  private async validateAuth(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const provider = this.providers.get(channel.platform);
    if (!provider) return { success: false, error: `Kein Provider für ${channel.platform}` };
    const secrets = await this.secrets(channel);
    const r = await provider.validateAuth(channel, secrets);
    return {
      success: r.ok,
      data: r,
      display: r.ok ? `✅ ${channel.name}: Zugang ok${r.detail ? ` (${r.detail})` : ''}` : `❌ ${channel.name}: ${r.detail ?? 'Zugang fehlgeschlagen'}`,
      ...(r.ok ? {} : { error: r.detail ?? 'auth failed' }),
    };
  }

  // ── Content-Pipeline ──────────────────────────────────────────────────

  private async addContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const body = typeof input.body === 'string' ? input.body : '';
    if (!body.trim()) return { success: false, error: 'body erforderlich' };
    const media: ContentMedia[] = typeof input.media_url === 'string' && input.media_url.trim()
      ? [{ type: (input.media_type === 'video' || input.media_type === 'audio' ? input.media_type : 'image'), source: 'user', pathOrUrl: input.media_url.trim() }]
      : [];
    const item = await this.repo.createItem(userId, channel.id, {
      title: typeof input.title === 'string' ? input.title : undefined,
      body,
      hashtags: Array.isArray(input.hashtags) ? input.hashtags.map(String) : [],
      media,
      scheduledAt: typeof input.scheduled_at === 'string' ? input.scheduled_at : undefined,
    });
    return {
      success: true,
      data: { item },
      display: `📝 Entwurf [${item.id.slice(0, 8)}] für **${channel.name}** angelegt${item.scheduledAt ? `, Wunschtermin ${item.scheduledAt.slice(0, 16).replace('T', ' ')}` : ''}.\nWeiter mit schedule_content (terminieren) oder publish_now.`,
    };
  }

  private async resolveItem(userId: string, input: Record<string, unknown>): Promise<ContentItem | null> {
    const q = typeof input.item_id === 'string' ? input.item_id.trim() : '';
    if (!q) return null;
    const exact = await this.repo.getItem(userId, q);
    if (exact) return exact;
    const all = await this.repo.listItems(userId, { limit: 300 });
    return all.find(i => i.id.startsWith(q)) ?? null;
  }

  private async listContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = typeof input.channel === 'string' && input.channel.trim()
      ? await this.resolveChannel(userId, input) : null;
    if (input.channel && !channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel)}` };
    const status = typeof input.content_status === 'string' ? input.content_status as ContentItem['status'] : undefined;
    const items = await this.repo.listItems(userId, { channelId: channel?.id, status, limit: 50 });
    if (items.length === 0) return { success: true, data: { items: [] }, display: 'Keine Content-Items gefunden.' };
    const channels = await this.repo.listChannels(userId);
    const nameOf = (id: string) => channels.find(c => c.id === id)?.name ?? id.slice(0, 8);
    const lines = [`🗂 **Content (${items.length}):**`];
    for (const i of items) {
      const when = i.scheduledAt ? ` ⏰ ${i.scheduledAt.slice(0, 16).replace('T', ' ')}` : '';
      lines.push(`• [${i.id.slice(0, 8)}] ${i.status.toUpperCase()} @${nameOf(i.channelId)}${when} — ${(i.title ?? i.body).slice(0, 60)}`);
    }
    return { success: true, data: { items }, display: lines.join('\n') };
  }

  private async scheduleContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const at = typeof input.scheduled_at === 'string' ? input.scheduled_at : '';
    if (!at || Number.isNaN(Date.parse(at))) return { success: false, error: 'scheduled_at (ISO) erforderlich' };
    const updated = await this.repo.transition(userId, item.id, 'scheduled', { scheduledAt: new Date(at).toISOString() });
    return { success: true, data: { item: updated }, display: `⏰ [${item.id.slice(0, 8)}] geplant für ${updated.scheduledAt!.slice(0, 16).replace('T', ' ')}. Freigabe: approve_content.` };
  }

  private async approveContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const updated = await this.repo.transition(userId, item.id, 'approved');
    // Erstpost-Sperre: Freigabe ohne Korrektur zählt für den Streak
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (channel && channel.approvedStreak < 5) {
      await this.repo.updateChannel(userId, channel.id, { approvedStreak: channel.approvedStreak + 1 });
    }
    return {
      success: true,
      data: { item: updated },
      display: `✅ [${item.id.slice(0, 8)}] freigegeben${updated.scheduledAt ? ` — wird zum geplanten Zeitpunkt veröffentlicht (Engine ab v934), bis dahin: publish_now` : ' — veröffentlichen mit publish_now'}.`,
    };
  }

  private async transitionSimple(userId: string, input: Record<string, unknown>, to: ContentItem['status'], msg: string): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    // Ablehnung = Korrektur → Erstpost-Streak zurücksetzen
    if (to === 'rejected') {
      const channel = await this.repo.getChannel(userId, item.channelId);
      if (channel && channel.approvedStreak > 0 && channel.approvedStreak < 5) {
        await this.repo.updateChannel(userId, channel.id, { approvedStreak: 0 });
      }
    }
    await this.repo.transition(userId, item.id, to);
    return { success: true, display: `[${item.id.slice(0, 8)}] → ${to}. ${msg}` };
  }

  // ── Veröffentlichung ──────────────────────────────────────────────────

  private async secrets(channel: SocialChannel): Promise<Record<string, string>> {
    if (!this.resolveSecretsFn) return {};
    try { return await this.resolveSecretsFn(channel); } catch { return {}; }
  }

  private async publishNow(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (!channel) return { success: false, error: 'Kanal des Items nicht gefunden' };
    if (channel.status !== 'active') return { success: false, error: `Kanal ${channel.name} ist ${channel.status} — erst reaktivieren.` };

    // Leitplanke 2 — Tages-Limit gilt auch für manuelles publish_now
    const publishedToday = await this.repo.countPublishedToday(channel.id);
    if (publishedToday >= channel.maxPostsPerDay) {
      return { success: false, error: `Tages-Limit erreicht (${publishedToday}/${channel.maxPostsPerDay} auf ${channel.name}) — max_posts_per_day anpassen oder morgen posten.` };
    }
    // Leitplanke 3 — Blacklist-Scan
    const haystack = `${item.title ?? ''} ${item.body}`.toLowerCase();
    const hit = channel.blacklist.find(w => w.trim().length > 0 && haystack.includes(w.toLowerCase()));
    if (hit) {
      return { success: false, error: `Blacklist-Treffer „${hit}" — Post nicht veröffentlicht. Text anpassen oder Blacklist ändern.` };
    }

    // In den approved-Zustand bringen (falls noch draft/scheduled)
    let current = item;
    if (current.status === 'draft' || current.status === 'scheduled' || current.status === 'failed') {
      current = await this.repo.transition(userId, current.id, 'approved');
    }
    if (current.status !== 'approved') {
      return { success: false, error: `Item ist ${current.status} — nur draft/scheduled/approved/failed können veröffentlicht werden.` };
    }

    if (channel.publishMode === 'prepare') {
      return {
        success: true,
        data: { item: current, prepared: true },
        display: formatPreparedPost(current, channel),
      };
    }

    const provider = this.providers.get(channel.platform);
    if (!provider) return { success: false, error: `Kein Provider für ${channel.platform}` };
    const publishing = await this.repo.transition(userId, current.id, 'publishing');
    try {
      const result = await provider.publish(publishing, channel, await this.secrets(channel));
      const published = await this.repo.transition(userId, publishing.id, 'published', {
        publishedAt: new Date().toISOString(),
        externalId: result.externalId,
        externalUrl: result.url,
        error: null,
      });
      return {
        success: true,
        data: { item: published },
        display: `🚀 Veröffentlicht auf **${channel.name}**${result.url ? `: ${result.url}` : ` (ID ${result.externalId})`}`,
      };
    } catch (err) {
      await this.repo.transition(userId, publishing.id, 'failed', { error: (err as Error).message.slice(0, 500) });
      return { success: false, error: `Publish fehlgeschlagen: ${(err as Error).message}` };
    }
  }

  private async markPublished(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (item.status === 'published') return { success: true, display: 'Bereits als veröffentlicht markiert.' };
    let current = item;
    if (current.status === 'draft' || current.status === 'scheduled') {
      current = await this.repo.transition(userId, current.id, 'approved');
    }
    const updated = await this.repo.transition(userId, current.id, 'published', {
      publishedAt: new Date().toISOString(),
      externalUrl: typeof input.external_url === 'string' ? input.external_url : undefined,
    });
    return { success: true, data: { item: updated }, display: `✅ [${item.id.slice(0, 8)}] als manuell veröffentlicht getrackt${updated.externalUrl ? ` (${updated.externalUrl})` : ''}.` };
  }

  private async deleteRemote(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (!item.externalId) return { success: false, error: 'Item hat keine externe Post-ID (nicht via API veröffentlicht).' };
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    const provider = this.providers.get(channel.platform);
    if (!provider) return { success: false, error: `Kein Provider für ${channel.platform}` };
    const ok = await provider.deletePost(item.externalId, channel, await this.secrets(channel));
    return ok
      ? { success: true, display: `🗑 Post [${item.id.slice(0, 8)}] auf ${channel.name} gelöscht.` }
      : { success: false, error: `Löschen auf ${channel.platform} fehlgeschlagen oder nicht unterstützt.` };
  }

  /** v935 — Content-Studio sofort für einen Kanal laufen lassen. */
  private async generateContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.studioFn) return { success: false, error: 'Content-Studio nicht verfügbar.' };
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const created = await this.studioFn(channel);
    return {
      success: true,
      data: { created },
      display: created > 0
        ? `🎨 Content-Studio: ${created} neue Entwürfe für **${channel.name}** erstellt${channel.mode === 'suggest' ? ' (list_content zeigt sie; terminieren mit schedule_content)' : ' und terminiert — die Freigabe kommt zum geplanten Zeitpunkt'}.`
        : `Content-Studio: Planungshorizont von **${channel.name}** ist bereits gefüllt (oder keine Ideen erzeugbar).`,
    };
  }

  private async attachMedia(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const url = typeof input.media_url === 'string' ? input.media_url.trim() : '';
    if (!url) return { success: false, error: 'media_url erforderlich' };
    const media: ContentMedia[] = [...item.media, {
      type: (input.media_type === 'video' || input.media_type === 'audio' ? input.media_type : 'image'),
      source: 'user', pathOrUrl: url,
    }];
    await this.repo.updateItemContent(userId, item.id, { media });
    return { success: true, display: `📎 Medium an [${item.id.slice(0, 8)}] angehängt (${media.length} gesamt).` };
  }
}
