import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { SocialRepository, SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { SocialProvider } from './social-provider.js';
import { composePostText } from './social-provider.js';

type SocialAction =
  | 'create_channel' | 'list_channels' | 'update_channel' | 'set_channel_status'
  | 'validate_auth' | 'pause_all' | 'resume_channel'
  | 'add_content' | 'list_content' | 'schedule_content' | 'approve_content'
  | 'reject_content' | 'publish_now' | 'mark_published' | 'delete_remote' | 'attach_media'
  | 'generate_content' | 'render_video' | 'crosspost';

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
    description: 'Social-Media-Kanäle betreiben: Kanäle verwalten (Telegram-Kanal, YouTube, Instagram/Facebook/Threads, X, eigene Plattform via REST), Content-Pipeline (Entwurf → geplant → freigegeben → veröffentlicht), sofort posten (publish_now) oder fertig aufbereiten (prepare-Modus). WICHTIG: JEDE Kanal-Einstellung (Modus, Posting-Slots, Persona, Blacklist, Limits, generate_images, config-Werte wie chat_id/base_url) wird AUSSCHLIESSLICH über action=update_channel geändert — NIEMALS über Datenbank, Shell, delegate oder Sub-Agents. "Erzeuge/generiere Content für <Kanal>" = action=generate_content (Content-Studio). "Social-Stopp" = pause_all. "Poste auf <Kanal>" = add_content + publish_now. "Übernimm/poste das auch auf <Kanal>" = action=crosspost (kopiert ein Item formatgerecht auf andere Kanäle).',
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
            'generate_content', 'render_video', 'crosspost'],
          description: 'Kanal-Verwaltung, Content-Pipeline oder Veröffentlichung. pause_all = Not-Aus für alle Kanäle ("Social-Stopp"). generate_content = Content-Studio sofort laufen lassen. render_video = Slideshow-Video (Bilder+Voiceover+Untertitel) aus einem Item rendern (ffmpeg, kostenlos).',
        },
        channel: { type: 'string', description: 'Kanal-Name/-Handle/-Plattform (fuzzy) oder Kanal-ID' },
        platform: { type: 'string', enum: ['telegram_channel', 'rest'], description: 'create_channel: Plattform (v933: telegram_channel, rest; YouTube/Meta folgen)' },
        name: { type: 'string', description: 'create_channel: Anzeigename des Kanals' },
        project: { type: 'string', description: 'create_channel: optional Projekt-Name/-ID (Kanal hängt am Projekt, Secrets aus dessen ENVs)' },
        config: { type: 'object', description: 'create_channel/update_channel: Provider-/Kanal-Config, wird gemergt — z.B. {generate_images: true}, {image_budget_per_month: 30}, telegram_channel: {chat_id}, rest: {base_url, publish_path?, body_template?, id_field?, url_template?, insecure_tls?, env_stage?}, youtube: {privacy_status?}, instagram: {ig_user_id}, facebook: {page_id}, threads: {threads_user_id}, x: {max_posts_per_month}' },
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
        format: { type: 'string', enum: ['9:16', '16:9'], description: 'render_video: Hochformat (Shorts/Reels, Default) oder Querformat' },
        channels: { type: 'array', items: { type: 'string' }, description: 'crosspost: Ziel-Kanäle (Namen/IDs), auf die das Item kopiert wird' },
        adapt: { type: 'boolean', description: 'crosspost: Text formatgerecht je Ziel-Kanal umschreiben (Default true; false = wörtliche Kopie)' },
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
  /** v938 — Video-Pipeline (Slideshow-Renderer + ffprobe-Check, vom Kern injiziert). */
  private videoTools?: {
    render: (item: ContentItem, channel: SocialChannel, format: '9:16' | '16:9') => Promise<{ videoPath: string; durationSec: number }>;
    probe?: (path: string) => Promise<{ ok: boolean; durationSec?: number; detail?: string }>;
  };

  setVideoTools(tools: NonNullable<SocialSkill['videoTools']>): void {
    this.videoTools = tools;
  }

  /** v946 — LLM für formatgerechtes Umschreiben beim Crossposting (vom Kern injiziert). */
  private llm?: LLMProvider;

  setLlm(llm: LLMProvider): void {
    this.llm = llm;
  }

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
        case 'render_video': return await this.renderVideo(userId, input);
        case 'crosspost': return await this.crosspost(userId, input);
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
    // v936 — optionales Monats-Limit (z.B. X-Free-Tier: config.max_posts_per_month=450)
    const monthlyCap = typeof channel.config.max_posts_per_month === 'number' ? channel.config.max_posts_per_month : undefined;
    if (monthlyCap !== undefined) {
      const monthStart = `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`;
      const publishedMonth = await this.repo.countPublishedSince(channel.id, monthStart);
      if (publishedMonth >= monthlyCap) {
        return { success: false, error: `Monats-Limit erreicht (${publishedMonth}/${monthlyCap} auf ${channel.name}) — API-Kontingent geschont.` };
      }
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

  /**
   * v936 — Analytics-Collector: Metriken für zuletzt veröffentlichte Posts
   * aller Kanäle holen (Provider mit supportsMetrics) → channel_metrics +
   * performance-JSON am Item. Vom Kern täglich aufgerufen (Lern-Loop-Futter).
   */
  async collectMetrics(userId: string): Promise<number> {
    const channels = await this.repo.listChannels(userId, 'active');
    const today = new Date().toISOString().slice(0, 10);
    let collected = 0;
    for (const channel of channels) {
      const provider = this.providers.get(channel.platform);
      if (!provider || !provider.capabilities().supportsMetrics) continue;
      const published = (await this.repo.listItems(userId, { channelId: channel.id, status: 'published', limit: 30 }))
        .filter(i => i.externalId)
        .map(i => ({ id: i.id, externalId: i.externalId! }));
      if (published.length === 0) continue;
      try {
        const metrics = await provider.fetchMetrics(published, channel, await this.secrets(channel));
        const perItem = new Map<string, Record<string, number>>();
        for (const m of metrics) {
          await this.repo.upsertMetric(channel.id, { itemId: m.itemId, date: today, kind: m.kind, value: m.value });
          perItem.set(m.itemId, { ...(perItem.get(m.itemId) ?? {}), [m.kind]: m.value });
          collected++;
        }
        for (const [itemId, perf] of perItem) {
          await this.repo.mergePerformance(userId, itemId, perf).catch(() => { /* non-critical */ });
        }
      } catch { /* Kanal-Fehler überspringen — nächster Kanal */ }
    }
    return collected;
  }

  /**
   * v946 — Crossposting: ein Item formatgerecht auf andere Kanäle kopieren.
   * Jede Kopie ist ein EIGENES Item auf dem Ziel-Kanal (eigene Freigabe,
   * eigene Leitplanken, eigenes Tracking). Mit LLM wird der Text an
   * Plattform-Limit + Persona des Ziel-Kanals angepasst (adapt=false oder
   * ohne LLM: wörtliche Kopie). Medien werden übernommen.
   */
  private async crosspost(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const channelNames = Array.isArray(input.channels) ? input.channels.map(String) : [];
    if (channelNames.length === 0) return { success: false, error: 'channels erforderlich (Ziel-Kanal-Namen)' };

    const targets: SocialChannel[] = [];
    for (const name of channelNames) {
      const c = (await this.repo.getChannel(userId, name)) ?? (await this.repo.findChannelByName(userId, name));
      if (!c) return { success: false, error: `Ziel-Kanal nicht gefunden: ${name}` };
      if (c.id === item.channelId) continue; // Quelle überspringen
      targets.push(c);
    }
    if (targets.length === 0) return { success: false, error: 'Keine gültigen Ziel-Kanäle (Quelle selbst zählt nicht).' };

    const adapt = input.adapt !== false;
    const created: string[] = [];
    for (const target of targets) {
      let title = item.title;
      let body = item.body;
      let hashtags = item.hashtags;
      if (adapt && this.llm) {
        try {
          const caps = this.providers.get(target.platform)?.capabilities();
          const rewritten = await this.adaptForChannel(item, target, caps?.maxTextLength);
          if (rewritten) ({ title, body, hashtags } = rewritten);
        } catch { /* Anpassung best-effort — wörtliche Kopie als Fallback */ }
      }
      const copy = await this.repo.createItem(userId, target.id, {
        title, body, hashtags,
        media: item.media,
        scheduledAt: typeof input.scheduled_at === 'string' ? input.scheduled_at : undefined,
        source: 'manual',
      });
      if (typeof input.scheduled_at === 'string' && !Number.isNaN(Date.parse(input.scheduled_at))) {
        await this.repo.transition(userId, copy.id, 'scheduled', { scheduledAt: new Date(input.scheduled_at).toISOString() });
      }
      created.push(`[${copy.id.slice(0, 8)}] → ${target.name}`);
    }
    return {
      success: true,
      data: { created: created.length },
      display: `🔁 Crosspost von [${item.id.slice(0, 8)}] angelegt:\n${created.map(c => `• ${c}`).join('\n')}\n${adapt && this.llm ? 'Texte wurden je Kanal angepasst. ' : ''}Jede Kopie durchläuft die normale Freigabe des Ziel-Kanals (publish_now zum Sofort-Posten).`,
    };
  }

  private async adaptForChannel(
    item: ContentItem, target: SocialChannel, maxLength?: number,
  ): Promise<{ title?: string; body: string; hashtags: string[] } | null> {
    if (!this.llm) return null;
    const prompt = `Passe diesen Social-Media-Beitrag für den Ziel-Kanal an.
Ziel: ${target.name} (Plattform ${target.platform})${maxLength ? `, MAXIMAL ${maxLength} Zeichen Text` : ''}${target.persona ? `\nPersona/Tonalität: ${target.persona}` : ''}

Original:
Titel: ${item.title ?? '(ohne)'}
Text: ${item.body}
Hashtags: ${item.hashtags.join(', ') || '(keine)'}

Regeln: Inhalt und Fakten beibehalten, nur Form/Länge/Ton an den Ziel-Kanal anpassen. Keine Meta-Zeilen.
Antworte NUR mit JSON: {"title": "…", "body": "…", "hashtags": ["…"]}`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1500, tier: 'fast' });
    const match = response.content?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.body !== 'string' || parsed.body.trim().length < 10) return null;
      return {
        title: typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title.slice(0, 200) : item.title,
        body: parsed.body.slice(0, 10_000),
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 10) : item.hashtags,
      };
    } catch {
      return null;
    }
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
    const type = (input.media_type === 'video' || input.media_type === 'audio' ? input.media_type : 'image');
    // v938 — Transcode-Check für lokale User-Videos (best-effort via ffprobe):
    // kaputte Dateien früh abweisen statt beim YouTube-Upload zu scheitern
    let probeNote = '';
    if (type === 'video' && !url.startsWith('http') && this.videoTools?.probe) {
      const probe = await this.videoTools.probe(url);
      if (!probe.ok) {
        return { success: false, error: `Videodatei nicht lesbar (${probe.detail ?? 'ffprobe-Fehler'}) — Pfad/Format prüfen.` };
      }
      probeNote = ` (geprüft, ${Math.round(probe.durationSec ?? 0)}s)`;
    }
    const media: ContentMedia[] = [...item.media, { type, source: 'user', pathOrUrl: url }];
    await this.repo.updateItemContent(userId, item.id, { media });
    return { success: true, display: `📎 Medium an [${item.id.slice(0, 8)}] angehängt${probeNote} (${media.length} gesamt).` };
  }

  /**
   * v938 — Slideshow-Video aus einem Item rendern (Bilder + TTS-Voiceover +
   * Untertitel via ffmpeg, kostenlos). Voiceover = Script-Teil vor '---'.
   * Monats-Budget: config.video_budget_per_month (Default 10).
   */
  private async renderVideo(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.videoTools) return { success: false, error: 'Video-Pipeline nicht verfügbar.' };
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    if (!item.media.some(m => m.type === 'image')) {
      return { success: false, error: 'Item hat keine Bilder — erst Bilder generieren/anhängen (das Video ist eine Bild-Slideshow mit Voiceover).' };
    }

    // Monats-Budget (Leitplanke 5)
    const budget = typeof channel.config.video_budget_per_month === 'number' ? channel.config.video_budget_per_month : 10;
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const used = (await this.repo.listMetrics(channel.id, { kind: 'gen_video', sinceDate: monthStart }))
      .reduce((sum, m) => sum + m.value, 0);
    if (used >= budget) {
      return { success: false, error: `Video-Monats-Budget erreicht (${used}/${budget} auf ${channel.name}) — config.video_budget_per_month anpassen.` };
    }

    const format = input.format === '16:9' ? '16:9' as const : '9:16' as const;
    const result = await this.videoTools.render(item, channel, format);
    const media: ContentMedia[] = [...item.media, { type: 'video', source: 'generated', pathOrUrl: result.videoPath }];
    await this.repo.updateItemContent(userId, item.id, { media });
    const today = new Date().toISOString().slice(0, 10);
    const todayUsed = (await this.repo.listMetrics(channel.id, { kind: 'gen_video', sinceDate: today }))
      .find(m => m.date === today && !m.itemId)?.value ?? 0;
    await this.repo.upsertMetric(channel.id, { date: today, kind: 'gen_video', value: todayUsed + 1 });
    return {
      success: true,
      data: { videoPath: result.videoPath, durationSec: result.durationSec },
      display: `🎬 Video gerendert (${format}, ${Math.round(result.durationSec)}s) und an [${item.id.slice(0, 8)}] angehängt:\n${result.videoPath}\nVeröffentlichen mit publish_now.`,
    };
  }
}
