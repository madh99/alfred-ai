import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { SocialRepository, SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { SocialProvider } from './social-provider.js';
import { appendUtm, composePostText, effectiveSlots, extractTrailingHashtags, languageName, mergeHashtags } from './social-provider.js';
import { isNearDuplicateTitle } from './dedup.js';
import { applyImageOverlays, cropToRatio, resolveImageBranding } from './image-overlay.js';
import { parsePublicMediaConfig, publishPublicMedia } from './public-media.js';

/** v1009 — Ergebnis eines Kommentar-Einsammel-Laufs je Kanal (inkl. Copilot-Triage). */
export interface CommentBatchInfo {
  channel: string;
  channelId: string;
  count: number;
  /** v1009 — automatisch ignorierter Spam */
  spamIgnored?: number;
  /** v1009 — automatisch ignorierte Hass-Kommentare (auf der Plattform prüfen/löschen!) */
  hassFlagged?: number;
  /** v1009 — Antwort-Vorschläge für echte Fragen (max. 3) */
  suggestions?: Array<{ id: string; author?: string; text: string; draft: string }>;
}

type SocialAction =
  | 'create_channel' | 'list_channels' | 'update_channel' | 'set_channel_status'
  | 'validate_auth' | 'auth_check' | 'health_check' | 'pause_all' | 'resume_channel'
  | 'add_content' | 'list_content' | 'schedule_content' | 'approve_content'
  | 'reject_content' | 'publish_now' | 'mark_published' | 'delete_remote' | 'delete_item' | 'attach_media'
  | 'generate_content' | 'render_video' | 'crosspost' | 'link_topic' | 'unlink_topic'
  | 'list_comments' | 'reply_comment' | 'ignore_comment' | 'suggest_reply' | 'regenerate_image' | 'revise_content'
  | 'get_content' | 'edit_content' | 'add_lesson' | 'replan_channel';

/** Formatiert die prepare-Aufbereitung: alles, was der User zum 2-Tap-Posten braucht. */
export function formatPreparedPost(item: ContentItem, channel: SocialChannel): string {
  const lines: string[] = [
    `📤 **Fertig aufbereitet für ${channel.name}** (${channel.platform}, manuell posten):`,
    '',
    '```',
    // v985 — auch der prepare-Text trägt die KI-Kennzeichnung
    composePostText(item, undefined, channel),
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
 * v963 — update_channel-Config FELDWEISE mergen, auch verschachtelt: bisher
 * ersetzte {config: {body_template: {status: "PUBLISHED"}}} das KOMPLETTE
 * body_template und zerstörte title/content/tags-Mapping (Realfall-Gefahr
 * 03.07., User musste das volle Template mitschicken). Regeln: plain objects
 * rekursiv mergen; Arrays/Primitive ersetzen; `null` löscht den Schlüssel.
 */
export function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergeConfig(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
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
    description: 'Social-Media-Kanäle betreiben: Kanäle verwalten (Telegram-Kanal, YouTube, Instagram/Facebook/Threads, X, eigene Plattform via REST), Content-Pipeline (Entwurf → geplant → freigegeben → veröffentlicht), sofort posten (publish_now) oder fertig aufbereiten (prepare-Modus). WICHTIG: JEDE Kanal-Einstellung (Modus, Posting-Slots, Persona, Blacklist, Limits, generate_images, config-Werte wie chat_id/base_url) wird AUSSCHLIESSLICH über action=update_channel geändert — NIEMALS über Datenbank, Shell, delegate oder Sub-Agents. "Erzeuge/generiere Content für <Kanal>" = action=generate_content (Content-Studio). "Social-Stopp" = pause_all. "Poste auf <Kanal>" = add_content + publish_now. "Übernimm/poste das auch auf <Kanal>" = action=crosspost (kopiert ein Item formatgerecht auf andere Kanäle). "Verknüpfe Thema X mit Kanal Y" = action=link_topic — ein Kanal kann MEHRERE Interessen-Themen speisen. "Korrigiere Beitrag X" = erst get_content (voller Text), dann edit_content mit korrigiertem title/body/hashtags UND einer lesson (was künftig zu beachten ist — der Kanal lernt daraus). "Merke dir für Kanal X: …" = add_lesson. "Zeig die Kommentare (auf Kanal X)" = list_comments; "Antworte auf Kommentar Y: …" = reply_comment (Antwort geht LIVE auf die Plattform); ignore_comment verwirft. "Prüf die Social-Gesundheit / Health-Check / alles ok nach dem Deploy?" = action=health_check (sharp/Overlays, Medien-Ablage, LLM, Auth je Kanal, public_media, Stats-Endpoint — nur lesen).',
    riskLevel: 'write',
    version: '1.0.0',
    // v949 — 10 min: generate_content erzeugt bis zu ~10 Posts inkl. je ~20s
    // Bild-Generierung (Realfall: 5 Posts ≈ 2-3 min); der alte 120s-Timeout
    // brach die Chat-Antwort ab, während die Arbeit im Hintergrund fertig
    // lief („wieder Timeout nach 120s, aber 5 Beiträge terminiert").
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_channel', 'list_channels', 'update_channel', 'set_channel_status',
            'validate_auth', 'auth_check', 'health_check', 'pause_all', 'resume_channel',
            'add_content', 'list_content', 'schedule_content', 'approve_content',
            'reject_content', 'publish_now', 'mark_published', 'delete_remote', 'delete_item', 'attach_media',
            'generate_content', 'render_video', 'crosspost', 'link_topic', 'unlink_topic',
            'list_comments', 'reply_comment', 'ignore_comment', 'suggest_reply', 'regenerate_image', 'revise_content',
            'get_content', 'edit_content', 'add_lesson', 'replan_channel'],
          description: 'Kanal-Verwaltung, Content-Pipeline oder Veröffentlichung. pause_all = Not-Aus für alle Kanäle ("Social-Stopp"). generate_content = Content-Studio sofort laufen lassen. render_video = Slideshow-Video (Bilder+Voiceover+Untertitel) aus einem Item rendern (ffmpeg, kostenlos). replan_channel = bereits geplante Beiträge in die aktuellen Posting-Slots umverteilen ("Plane die Beiträge um").',
        },
        channel: { type: 'string', description: 'Kanal-Name/-Handle/-Plattform (fuzzy) oder Kanal-ID' },
        platform: { type: 'string', enum: ['telegram_channel', 'rest', 'youtube', 'instagram', 'facebook', 'threads', 'x', 'bluesky'], description: 'create_channel: Plattform. instagram/facebook/threads brauchen META_ACCESS_TOKEN (ENV-Stage social) + config ig_user_id/page_id/threads_user_id; youtube OAuth2-Secrets; x X_ACCESS_TOKEN; bluesky config.handle + Secret BLUESKY_APP_PASSWORD (App-Passwort, Bilder werden direkt hochgeladen — kein public_media nötig, Links klickbar). Instagram: Posts brauchen IMMER ein Medium mit ÖFFENTLICHER http-URL (kein reiner Text).' },
        name: { type: 'string', description: 'create_channel: Anzeigename des Kanals' },
        project: { type: 'string', description: 'create_channel: optional Projekt-Name/-ID (Kanal hängt am Projekt, Secrets aus dessen ENVs)' },
        config: { type: 'object', description: 'create_channel/update_channel: Provider-/Kanal-Config, wird FELDWEISE gemergt (auch verschachtelt: {body_template: {status: "PUBLISHED"}} ändert NUR status, übrige Template-Felder bleiben; null löscht einen Schlüssel) — z.B. {generate_images: true}, {image_policy: "symbolic"|"people_ok" — symbolic=Default: keine realen Personen/Logos in generierten Bildern (Bildnisrecht), people_ok=explizites Opt-in}, {image_budget_per_month: 30}, {language: "de" — Inhaltssprache des Kanals (ISO-Code, Default de)}, {translate_to: ["en","fr"] — NUR rest-Kanäle: beim Publish werden Titel+Body übersetzt und als translations ins Payload gelegt (Website-Sprachversionen)}, telegram_channel: {chat_id}, rest: {base_url, publish_path?, body_template?, id_field?, url_template?, insecure_tls?, env_stage?}, youtube: {privacy_status?}, instagram: {ig_user_id, auto_story: true — postet beim Publish des Familien-Lead-Artikels automatisch eine IG-Story (9:16, Titel+Link-im-Profil-CTA als Overlay), OHNE Einzelfreigabe, zählt aufs Tages-Limit; story_cta_text ersetzt den CTA; auto_reel: true — erstellt beim Lead-Publish ein 20-30s-Reel (Sprecher+Untertitel+Story-Bilder) als ENTWURF mit Freigabe, max reel_max_per_week (Default 2), braucht ffmpeg}, facebook: {page_id}, threads: {threads_user_id}, x: {max_posts_per_month}. instagram/facebook/threads mit generierten Bildern brauchen zusätzlich public_media (Medien-Ablageort des Kanals): {provider: "rest", base_url, path?, url_field?} = Medienbibliothek der Projekt-Website (fussball.cc: base_url https://fussball.cc, path /api/integrations/media) ODER {provider: "s3", endpoint, bucket, region?, public_base_url?} = S3-kompatibler Cloud-Bucket (Secrets S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)' },
        mode: { type: 'string', enum: ['suggest', 'approve', 'autonomous'], description: 'update_channel: Arbeitsmodus (Automatik ab v934)' },
        publish_mode: { type: 'string', enum: ['api', 'prepare'], description: 'api = Alfred veröffentlicht selbst; prepare = Alfred bereitet auf, User postet' },
        persona: { type: 'string', description: 'update_channel: Tonalität/Persona für Content-Erstellung' },
        model_tier: { type: 'string', enum: ['fast', 'medium', 'default', 'strong'], description: 'update_channel: LLM-Qualität für die Content-Erzeugung dieses Kanals (fast=Standard/billig, medium=hochwertige Serienproduktion z.B. Sonnet, strong=Topmodell)' },
        posting_slots: { type: 'array', items: { type: 'string' }, description: 'update_channel: bevorzugte Slots in Server-Ortszeit, z.B. ["Mo 18:00", "Sa 10:00"]. Leer/nicht gesetzt = Plattform-Best-Practice-Slots (inkl. Wochenende) gelten automatisch. Nach Änderung ggf. replan_channel für bereits geplante Beiträge.' },
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
        topic: { type: 'string', description: 'link_topic/unlink_topic: Interessen-Thema (Name, fuzzy) — ein Kanal kann MEHRERE Themen speisen (z.B. „WM 2026" + „Panini-Sammelalbum")' },
        lesson: { type: 'string', description: 'edit_content/add_lesson: Lektion für künftige Studio-Läufe des Kanals, z.B. "Es ist die WM 2026, nicht die EM — auch in Hashtags" — wird zwingend in künftige Prompts aufgenommen' },
        comment_id: { type: 'string', description: 'reply_comment/ignore_comment: ID des Kommentars (aus list_comments)' },
        reply: { type: 'string', description: 'reply_comment: die Antwort — geht LIVE auf die Plattform (FB/IG)' },
        hint: { type: 'string', description: 'regenerate_image: optionaler Bild-Hinweis, z.B. "beide Flaggen zeigen, ohne Menschen"' },
        instruction: { type: 'string', description: 'revise_content: Überarbeitungs-Anweisung, z.B. "halb so lang, ohne Superlative" — das Kanal-LLM schreibt Titel/Text/Hashtags um (Status/Termin bleiben)' },
        scheduled_at: { type: 'string', description: 'schedule_content: ISO-Zeitpunkt der Veröffentlichung' },
        content_status: { type: 'string', description: 'list_content: Filter (draft|scheduled|approved|published|failed|…)' },
        external_url: { type: 'string', description: 'mark_published: URL des manuell geposteten Beitrags' },
        force: { type: 'boolean', description: 'publish_now: bewusster Re-Post trotz sehr ähnlichem, kürzlich veröffentlichtem Beitrag (Doppel-Publish-Gate übergehen)' },
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

  /** v951 — Interessen-Topic-Resolver für link_topic/unlink_topic (vom Kern injiziert). */
  private topicResolver?: (nameOrId: string) => Promise<{ id: string; name: string } | null>;

  setTopicResolver(fn: (nameOrId: string) => Promise<{ id: string; name: string } | null>): void {
    this.topicResolver = fn;
  }

  constructor(private readonly repo: SocialRepository) {
    super();
  }

  setStudio(fn: (channel: SocialChannel) => Promise<number>): void {
    this.studioFn = fn;
  }

  /** v959 — Umplanen bestehender scheduled-Items in die aktuellen Slots. */
  private replanFn?: (channel: SocialChannel) => Promise<number>;

  setReplanner(fn: (channel: SocialChannel) => Promise<number>): void {
    this.replanFn = fn;
  }

  /** v962 — Bild-Generierung für Ad-hoc-Items (Studio-Leitplanken, vom Kern injiziert; v991: optionaler bildidee-Hinweis). */
  private imageFn?: (channel: SocialChannel, item: { title?: string; body: string; bildidee?: string; performance?: Record<string, unknown> }) => Promise<ContentMedia[]>;
  /** v1011 — Ablage generierter Bilder (nur für den Health-Check-Schreibtest). */
  private mediaDir?: string;

  setImageGenerator(fn: (channel: SocialChannel, item: { title?: string; body: string; bildidee?: string; performance?: Record<string, unknown> }) => Promise<ContentMedia[]>): void {
    this.imageFn = fn;
  }

  /** v962 — Bild für Ad-hoc-Item, wenn der Kanal generate_images hat (best-effort). */
  private async maybeAdhocImage(channel: SocialChannel, item: { title?: string; body: string }): Promise<ContentMedia[]> {
    if (channel.config.generate_images !== true || !this.imageFn) return [];
    try {
      return await this.imageFn(channel, item);
    } catch {
      return []; // Bild ist nice-to-have — der Post selbst darf nie daran scheitern
    }
  }

  registerProvider(provider: SocialProvider): void {
    this.providers.set(provider.platform, provider);
  }

  setSecretsResolver(fn: (channel: SocialChannel) => Promise<Record<string, string>>): void {
    this.resolveSecretsFn = fn;
  }

  /** v984 — Secrets ZURÜCKschreiben (Token-Refresh): patch wird in die ENV-Stage des Kanals gemergt. */
  private secretsWriterFn?: (channel: SocialChannel, patch: Record<string, string>) => Promise<void>;

  setSecretsWriter(fn: (channel: SocialChannel, patch: Record<string, string>) => Promise<void>): void {
    this.secretsWriterFn = fn;
  }

  /**
   * v984 — Auth-Health-Check über alle aktiven Kanäle (täglich vom Kern
   * aufgerufen, manuell via action auth_check).
   *
   * Kern-Anlass: Instagram-Long-lived-Tokens der „Instagram-Anmeldung"-Apps
   * (IG…-Präfix) laufen nach 60 Tagen ab und MÜSSEN per refresh_access_token
   * verlängert werden — ohne Refresh fällt der Kanal eines Tages stumm aus.
   * Der Check erneuert solche Tokens (Meta erlaubt Refresh erst ab 24h
   * Token-Alter — „too new" ist deshalb KEIN Fehler) und validiert danach
   * jeden Kanal über provider.validateAuth.
   */
  async authHealthCheck(userId: string): Promise<{ checked: number; refreshed: string[]; failures: Array<{ channel: string; detail: string }> }> {
    const channels = await this.repo.listChannels(userId, 'active');
    const refreshed: string[] = [];
    const failures: Array<{ channel: string; detail: string }> = [];
    let checked = 0;
    for (const channel of channels) {
      const provider = this.providers.get(channel.platform);
      if (!provider) continue;
      const secrets = await this.secrets(channel);
      if (channel.platform === 'instagram' && secrets.META_ACCESS_TOKEN?.startsWith('IG') && this.secretsWriterFn) {
        try {
          const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(secrets.META_ACCESS_TOKEN)}`);
          const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: { message?: string } };
          if (res.ok && typeof data.access_token === 'string' && data.access_token) {
            await this.secretsWriterFn(channel, { META_ACCESS_TOKEN: data.access_token });
            secrets.META_ACCESS_TOKEN = data.access_token;
            refreshed.push(channel.name);
          } else {
            const msg = data.error?.message ?? `HTTP ${res.status}`;
            if (!/too new|24 hours/i.test(msg)) failures.push({ channel: channel.name, detail: `IG-Token-Refresh fehlgeschlagen: ${msg}` });
          }
        } catch (err) {
          failures.push({ channel: channel.name, detail: `IG-Token-Refresh: ${(err as Error).message}` });
        }
      }
      try {
        checked++;
        const v = await provider.validateAuth(channel, secrets);
        if (!v.ok) failures.push({ channel: channel.name, detail: v.detail ?? 'Auth ungültig' });
      } catch (err) {
        failures.push({ channel: channel.name, detail: (err as Error).message });
      }
    }
    return { checked, refreshed, failures };
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
        case 'auth_check': {
          // v984 — alle Kanäle prüfen + IG-Tokens erneuern (manueller Trigger)
          const r = await this.authHealthCheck(userId);
          const lines = [
            `🔑 Auth-Check: ${r.checked} Kanäle geprüft.`,
            ...(r.refreshed.length ? [`♻️ Token erneuert: ${r.refreshed.join(', ')}`] : []),
            ...(r.failures.length ? r.failures.map(f => `❌ ${f.channel}: ${f.detail}`) : ['✅ Alle Kanäle in Ordnung.']),
          ];
          return { success: r.failures.length === 0, data: r, display: lines.join('\n'), ...(r.failures.length ? { error: lines.join('\n') } : {}) };
        }
        case 'health_check': return await this.healthCheck(userId);
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
        case 'delete_item': return await this.deleteItemLocal(userId, input);
        case 'regenerate_image': return await this.regenerateImage(userId, input);
        case 'revise_content': return await this.reviseContent(userId, input);
        case 'attach_media': return await this.attachMedia(userId, input);
        case 'generate_content': return await this.generateContent(userId, input);
        case 'render_video': return await this.renderVideo(userId, input);
        case 'crosspost': return await this.crosspost(userId, input);
        case 'list_comments': return await this.listCommentsAction(userId, input);
        case 'reply_comment': return await this.replyComment(userId, input);
        case 'suggest_reply': return await this.suggestReply(userId, input);
        case 'ignore_comment': {
          const comment = await this.repo.getComment(userId, typeof input.comment_id === 'string' ? input.comment_id : '');
          if (!comment) return { success: false, error: `Kommentar nicht gefunden: ${String(input.comment_id ?? '')}` };
          await this.repo.setCommentStatus(userId, comment.id, 'ignored');
          return { success: true, display: `Kommentar [${comment.id.slice(0, 8)}] ignoriert.` };
        }
        case 'link_topic': return await this.linkTopic(userId, input, true);
        case 'unlink_topic': return await this.linkTopic(userId, input, false);
        case 'get_content': return await this.getContent(userId, input);
        case 'edit_content': return await this.editContent(userId, input);
        case 'add_lesson': return await this.addLesson(userId, input);
        case 'replan_channel': return await this.replanChannel(userId, input);
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
    const eff = effectiveSlots(channel);
    // v969 — Meta-Plattformen holen Medien per öffentlicher URL: ohne
    // public_media können generierte Bilder im api-Modus nicht posten
    const needsPublicMedia = ['instagram', 'facebook', 'threads'].includes(platform)
      && channel.publishMode === 'api' && !channel.config.public_media;
    return {
      success: true,
      data: { channel },
      display: `📣 Kanal **${name}** (${platform}) angelegt — Modus: suggest, Publish: ${channel.publishMode}${projectId ? `, Projekt-gebunden` : ''}.\n`
        + `Posting-Slots (Plattform-Best-Practice, anpassbar via posting_slots): ${eff.slots.join(', ')}.\n`
        + (needsPublicMedia ? `⚠️ ${platform} holt Medien per öffentlicher URL: für generierte Bilder public_media konfigurieren (Medien-Ablageort — Projekt-Medienbibliothek oder S3-Bucket), sonst schlagen Bild-Posts fehl.\n` : '')
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
    // v979 — Modell-Tier für die Content-Erzeugung (landet in config.model_tier)
    if (input.model_tier === 'fast' || input.model_tier === 'medium' || input.model_tier === 'default' || input.model_tier === 'strong') {
      patch.config = deepMergeConfig(channel.config, { model_tier: input.model_tier });
    }
    if (input.config && typeof input.config === 'object') patch.config = deepMergeConfig((patch.config as Record<string, unknown>) ?? channel.config, input.config as Record<string, unknown>);
    if (typeof input.name === 'string' && input.name.trim()) patch.name = input.name.trim();
    if (Object.keys(patch).length === 0) return { success: false, error: 'Nichts zu ändern übergeben.' };
    await this.repo.updateChannel(userId, channel.id, patch);
    let note = '';
    if (patch.mode === 'autonomous' && channel.approvedStreak < 5) {
      note = `\n⚠️ Erstpost-Sperre: autonomous wird erst nach 5 Freigaben ohne Korrektur wirksam (aktuell ${channel.approvedStreak}/5) — bis dahin verhält sich der Kanal wie approve.`;
    }
    if (patch.postingSlots) {
      note += `\nℹ️ Bereits geplante Beiträge behalten ihre Termine — mit „Plane die Beiträge von ${channel.name} um" (replan_channel) werden sie in die neuen Slots verteilt.`;
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
    const title = typeof input.title === 'string' ? input.title : undefined;
    let media: ContentMedia[] = typeof input.media_url === 'string' && input.media_url.trim()
      ? [{ type: (input.media_type === 'video' || input.media_type === 'audio' ? input.media_type : 'image'), source: 'user', pathOrUrl: input.media_url.trim() }]
      : [];
    // v962 — Kanal mit generate_images: auch Ad-hoc-Posts bekommen ein Bild
    // (Studio-Leitplanken: Bildnisrecht-Policy, Vision-Gate, Monats-Budget)
    if (media.length === 0) media = await this.maybeAdhocImage(channel, { title, body });
    const item = await this.repo.createItem(userId, channel.id, {
      title,
      body,
      hashtags: Array.isArray(input.hashtags) ? input.hashtags.map(String) : [],
      media,
      scheduledAt: typeof input.scheduled_at === 'string' ? input.scheduled_at : undefined,
    });
    const withImage = media.some(m => m.source === 'generated') ? ' — mit generiertem Bild' : '';
    const noImageWarn = channel.config.generate_images === true && media.length === 0
      ? '\n⚠️ Kein Bild: Generierung nicht möglich (Budget/Bildprüfung) — Post geht ohne Bild raus.' : '';
    return {
      success: true,
      data: { item },
      display: `📝 Entwurf [${item.id.slice(0, 8)}] für **${channel.name}** angelegt${item.scheduledAt ? `, Wunschtermin ${item.scheduledAt.slice(0, 16).replace('T', ' ')}` : ''}${withImage}.${noImageWarn}\nWeiter mit schedule_content (terminieren) oder publish_now.`,
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
    const iso = new Date(at).toISOString();
    // v964 — Umterminieren STATUSERHALTEND: scheduled bleibt scheduled, approved
    // bleibt approved (vorher scheiterte scheduled→scheduled an der
    // Transition-Validierung, und approved hätte die Freigabe verloren).
    if (item.status === 'scheduled' || item.status === 'approved') {
      const ok = await this.repo.reschedule(userId, item.id, iso, ['scheduled', 'approved']);
      if (!ok) return { success: false, error: 'Umterminieren fehlgeschlagen.' };
      return { success: true, data: { item: { ...item, scheduledAt: iso } }, display: `⏰ [${item.id.slice(0, 8)}] umterminiert auf ${iso.slice(0, 16).replace('T', ' ')} (Status bleibt ${item.status}).` };
    }
    const updated = await this.repo.transition(userId, item.id, 'scheduled', { scheduledAt: iso });
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
    // Leitplanke 3 — Blacklist-Scan (v983: permanent — der Text ändert sich
    // nicht von allein; die Engine soll das nicht alle 5 min neu versuchen)
    const haystack = `${item.title ?? ''} ${item.body}`.toLowerCase();
    const hit = channel.blacklist.find(w => w.trim().length > 0 && haystack.includes(w.toLowerCase()));
    if (hit) {
      return { success: false, data: { permanent: true }, error: `Blacklist-Treffer „${hit}" — Post nicht veröffentlicht. Text anpassen oder Blacklist ändern.` };
    }
    // v973 — Doppel-Publish-Gate für ALLE Pfade (Studio/add_content/crosspost/
    // Buttons): dieselbe Story wurde auf dem Kanal in den letzten 7 Tagen schon
    // veröffentlicht → Fehler statt Doppel-Post. Bewusster Re-Post: force: true.
    // v983 — Termin-Posts (performance.terminBis) haben TERMIN-Identität:
    // Ankündigung und Spielvorschau derselben Partie dürfen koexistieren
    // (Realfall 04.07.: die Vorschau „Kanada – Marokko: Der Kampf um den
    // nächsten Schritt" blockierte die Public-Viewing-Ankündigung 11 Stunden
    // lang im 5-Minuten-Takt). Nur derselbe TERMIN doppelt ist ein Duplikat —
    // und ein abgelaufener Termin wird gar nicht mehr veröffentlicht.
    // Gate-Fehler sind PERMANENT (data.permanent): die Engine stellt das Item
    // auf failed statt endlos zu retryen.
    if (input.force !== true) {
      const nowIso = new Date().toISOString();
      const itemTermin = typeof item.performance?.terminBis === 'string' ? item.performance.terminBis : undefined;
      if (itemTermin && itemTermin <= nowIso) {
        return {
          success: false, data: { permanent: true },
          error: `Termin ist bereits vorbei (${itemTermin}) — die Ankündigung ist nicht mehr sinnvoll. Bewusst trotzdem posten: force: true.`,
        };
      }
      const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
      const recentPublished = await this.repo.listItems(userId, {
        channelId: channel.id, status: 'published', updatedSince: weekAgo, limit: 200,
      });
      const terminOf = (p: ContentItem): string | undefined =>
        typeof p.performance?.terminBis === 'string' ? p.performance.terminBis : undefined;
      const candidateTitle = item.title ?? item.body.slice(0, 60);
      const dupOf = itemTermin
        ? recentPublished.find(p => p.id !== item.id && terminOf(p) === itemTermin)
        : recentPublished.find(p => p.id !== item.id && terminOf(p) === undefined
          && isNearDuplicateTitle(candidateTitle, [p.title ?? p.body.slice(0, 60)]));
      if (dupOf) {
        return {
          success: false, data: { permanent: true },
          error: `${itemTermin ? 'Dieser Termin wurde' : 'Sehr ähnlicher Beitrag wurde'} auf ${channel.name} bereits veröffentlicht: „${(dupOf.title ?? dupOf.body.slice(0, 60))}" [${dupOf.id.slice(0, 8)}]${dupOf.externalUrl ? ` (${dupOf.externalUrl})` : ''}. Bewusster Re-Post: force: true.`,
        };
      }
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
      // v1006 — Mehrsprachigkeit: Übersetzungen VOR dem Publish erzeugen (rest + translate_to)
      const translated = await this.applyTranslations(userId, publishing, channel);
      // v999 — Traffic: Follower-Posts verlinken den Lead-Artikel (nur der
      // gesendete Text wird ergänzt, das gespeicherte Item bleibt unverändert)
      const outgoing = await this.applyTrafficCta(userId, translated, channel);
      const result = await provider.publish(outgoing, channel, await this.secrets(channel));
      const published = await this.repo.transition(userId, publishing.id, 'published', {
        publishedAt: new Date().toISOString(),
        externalId: result.externalId,
        externalUrl: result.url,
        error: null,
      });
      // v1007 — Auto-Story: Lead ist live → IG-Familien-Kanal mit auto_story postet eine Story (best-effort)
      const storyNote = await this.maybeAutoStory(userId, published, channel).catch(() => undefined);
      // v1016 — Auto-Reel: Rendering dauert Minuten → fire-and-forget, der
      // Entwurf taucht in der Triage auf (bewusst MIT Freigabe, anders als Stories)
      void this.maybeAutoReel(userId, published, channel).catch(() => { /* best-effort */ });
      return {
        success: true,
        data: { item: published },
        display: `🚀 Veröffentlicht auf **${channel.name}**${result.url ? `: ${result.url}` : ` (ID ${result.externalId})`}${storyNote ? `\n${storyNote}` : ''}`,
      };
    } catch (err) {
      await this.repo.transition(userId, publishing.id, 'failed', { error: (err as Error).message.slice(0, 500) });
      return { success: false, error: `Publish fehlgeschlagen: ${(err as Error).message}` };
    }
  }

  /**
   * v999 — Traffic-CTA: Ist das Item ein FOLLOWER einer Story, deren Lead
   * bereits mit externalUrl veröffentlicht ist, wird der Artikel-Link (mit
   * UTM-Parametern) an den ausgehenden Text gehängt. Instagram (Captions
   * nicht klickbar) bekommt stattdessen einen „Link im Profil"-Hinweis.
   * config.traffic_cta=false schaltet ab, config.traffic_cta_text ersetzt
   * den Standardtext, config.utm=false lässt die URL nackt. Das gespeicherte
   * Item wird NIE verändert — nur die ausgehende Kopie.
   */
  /**
   * v1006 — Mehrsprachigkeit (Option A, Alfred-Seite): Vor dem Publish eines
   * rest-Kanals mit config.translate_to (z.B. ["en","fr","it"]) werden Titel
   * und Body per LLM übersetzt und als performance.translations persistiert —
   * der rest-Provider legt sie ins Payload, die Plattform macht daraus
   * Locale-Versionen. Cache über translationsOf (Länge+Ziele), damit Retries
   * nicht erneut zahlen. Best-effort: Fehler blockieren den Publish NIE
   * (der Artikel erscheint dann vorerst einsprachig).
   */
  private async applyTranslations(userId: string, item: ContentItem, channel: SocialChannel): Promise<ContentItem> {
    try {
      if (channel.platform !== 'rest' || !this.llm) return item;
      const targets = Array.isArray(channel.config.translate_to)
        ? (channel.config.translate_to as unknown[]).filter((l): l is string => typeof l === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(l)).map(l => l.toLowerCase())
        : [];
      if (targets.length === 0) return item;
      const marker = `${(item.title ?? '').length}:${item.body.length}:${targets.join(',')}`;
      const cached = item.performance?.translations;
      if (cached && typeof cached === 'object' && item.performance?.translationsOf === marker) return item;
      const source = typeof channel.config.language === 'string' ? channel.config.language : 'de';
      const prompt = `Übersetze den folgenden Artikel aus ${languageName(source)} in die Zielsprachen: ${targets.map(t => `"${t}" (${languageName(t)})`).join(', ')}.
Regeln: sinn- und tongetreu, KEINE Fakten ändern oder ergänzen, Eigennamen/Vereins-/Ortsnamen unverändert, Zahlen/Daten/Uhrzeiten exakt übernehmen. Zitate im Text mit \\" escapen.

TITEL: ${item.title ?? ''}
TEXT:
${item.body}

Antworte NUR mit einem VALIDEN JSON-Objekt, ein Schlüssel je Zielsprache:
{"${targets[0]}": {"title": "…", "body": "…"}${targets.length > 1 ? ', …' : ''}}`;
      const tierRaw = channel.config.model_tier;
      const tier = tierRaw === 'medium' || tierRaw === 'default' || tierRaw === 'strong' ? tierRaw : 'fast';
      const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 12_000, tier, reasoningEffort: 'low' });
      const raw = response.content ?? '';
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) return item;
      let parsed: Record<string, { title?: unknown; body?: unknown }>;
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return item; }
      const translations: Record<string, { title: string; body: string }> = {};
      for (const t of targets) {
        const e = parsed[t];
        if (e && typeof e.title === 'string' && typeof e.body === 'string' && e.body.trim().length > 10) {
          translations[t] = { title: e.title.slice(0, 300), body: e.body.slice(0, 20_000) };
        }
      }
      if (Object.keys(translations).length === 0) return item;
      await this.repo.mergePerformance(userId, item.id, { translations, translationsOf: marker }).catch(() => { /* Cache ist optional */ });
      return { ...item, performance: { ...item.performance, translations, translationsOf: marker } };
    } catch {
      return item; // Übersetzung darf einen Publish NIE verhindern
    }
  }

  /**
   * v1007 — Auto-Story: Wurde der LEAD einer Story veröffentlicht und hat die
   * Familie einen Instagram-Kanal mit config.auto_story=true, postet Alfred
   * dort eine IG-Story: Bild des IG-Follower-Items → Crop 9:16 → Overlay
   * (Titel, CTA „Link im Profil", Branding) → public_media-Upload →
   * publishStory. Opt-in (auto_story), zählt aufs Tages-Limit, dokumentiert
   * als eigenes content_item — und komplett best-effort: Fehler blockieren
   * den Lead-Publish nie. @returns Hinweis-Zeile fürs Display oder undefined.
   */
  private async maybeAutoStory(userId: string, leadItem: ContentItem, leadChannel: SocialChannel): Promise<string | undefined> {
    if (!leadItem.storyId) return undefined;
    const assigns = await this.repo.listAssignments(leadItem.storyId);
    const mine = assigns.find(a => a.itemId === leadItem.id);
    if (!mine || mine.role !== 'lead') return undefined;
    const familyOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    const channels = await this.repo.listChannels(userId, 'active');
    const ig = channels.find(c => c.id !== leadChannel.id && c.platform === 'instagram'
      && c.config.auto_story === true && familyOf(c) !== null && familyOf(c) === familyOf(leadChannel));
    if (!ig) return undefined;
    const provider = this.providers.get('instagram');
    if (!provider || provider.capabilities().supportsStories !== true) return undefined;
    // Tages-Limit gilt auch für Stories
    if (await this.repo.countPublishedToday(ig.id) >= ig.maxPostsPerDay) return undefined;
    // Bild: das IG-Follower-Item derselben Story hat bereits ein passendes Motiv
    const followerId = assigns.find(a => a.channelId === ig.id)?.itemId;
    const follower = followerId ? await this.repo.getItem(userId, followerId) : null;
    const image = follower?.media.find(m => m.type === 'image');
    if (!image) return undefined;
    let base: Buffer;
    if (image.pathOrUrl.startsWith('http')) {
      const res = await fetch(image.pathOrUrl);
      if (!res.ok) return undefined;
      base = Buffer.from(await res.arrayBuffer());
    } else {
      const { readFile } = await import('node:fs/promises');
      base = await readFile(image.pathOrUrl);
    }
    const framed = await cropToRatio(base, 9, 16);
    const withOverlay = await applyImageOverlays(framed, {
      title: leadItem.title ?? undefined,
      cta: typeof ig.config.story_cta_text === 'string' && ig.config.story_cta_text.trim() ? ig.config.story_cta_text.trim() : '🔗 Link im Profil',
      branding: resolveImageBranding(ig, channels),
    });
    // Upload über den Medien-Ablageort des IG-Kanals (Meta holt per URL ab)
    const pmCfg = parsePublicMediaConfig(ig.config.public_media);
    if (!pmCfg) return undefined;
    const { writeFile, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `alfred-story-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    await writeFile(tmpFile, withOverlay);
    let url: string;
    try {
      url = await publishPublicMedia(pmCfg, tmpFile, await this.secrets(ig), leadItem.title ?? undefined);
    } finally {
      await unlink(tmpFile).catch(() => { /* tmp */ });
    }
    const result = await provider.publishStory(url, ig, await this.secrets(ig));
    // Als eigenes Item dokumentieren (Verlauf, Metriken, delete_remote)
    try {
      const doc = await this.repo.createItem(userId, ig.id, {
        status: 'draft',
        title: `Story: ${leadItem.title ?? leadItem.body.slice(0, 60)}`,
        body: `Automatische IG-Story zum Lead-Artikel${leadItem.externalUrl ? ` (${leadItem.externalUrl})` : ''}.`,
        media: [{ type: 'image', source: 'generated', pathOrUrl: url }],
        source: 'studio',
        storyId: leadItem.storyId,
      });
      await this.repo.transition(userId, doc.id, 'approved');
      await this.repo.transition(userId, doc.id, 'published', {
        publishedAt: new Date().toISOString(), externalId: result.externalId, externalUrl: result.url, error: null,
      });
      await this.repo.mergePerformance(userId, doc.id, { format: 'story', autoStory: true }).catch(() => { /* optional */ });
    } catch { /* Doku ist best-effort — die Story ist bereits live */ }
    return `📱 IG-Story auf **${ig.name}** ausgelöst${result.url ? ` (${result.url})` : ''}.`;
  }

  /**
   * v1016 — Auto-Reel: Wurde der LEAD einer Story veröffentlicht und hat die
   * Familie einen Instagram-Kanal mit config.auto_reel=true, entsteht ein
   * 20–30s-Reel als ENTWURF (bewusst mit Freigabe — anders als die Story):
   * LLM-Sprecherskript + Caption, Bilder der Story (lokal), Slideshow-Render
   * (ffmpeg + TTS + Untertitel, videoTools aus dem Kern), Wochen-Limit
   * config.reel_max_per_week (Default 2). Läuft fire-and-forget nach dem
   * Lead-Publish — Fehler bleiben still, der Publish ist längst durch.
   */
  private async maybeAutoReel(userId: string, leadItem: ContentItem, leadChannel: SocialChannel): Promise<void> {
    if (!leadItem.storyId || !this.videoTools || !this.llm) return;
    const assigns = await this.repo.listAssignments(leadItem.storyId);
    const mine = assigns.find(a => a.itemId === leadItem.id);
    if (!mine || mine.role !== 'lead') return;
    const familyOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    const channels = await this.repo.listChannels(userId, 'active');
    const ig = channels.find(c => c.id !== leadChannel.id && c.platform === 'instagram'
      && c.config.auto_reel === true && familyOf(c) !== null && familyOf(c) === familyOf(leadChannel));
    if (!ig) return;
    // Wochen-Limit: Rendering + TTS kosten — Reels bleiben besondere Momente
    const cap = typeof ig.config.reel_max_per_week === 'number' && ig.config.reel_max_per_week >= 0 ? ig.config.reel_max_per_week : 2;
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    const recent = await this.repo.listItems(userId, { channelId: ig.id, limit: 100 });
    const reelsThisWeek = recent.filter(i => i.performance?.format === 'reel' && i.createdAt >= weekAgo).length;
    if (reelsThisWeek >= cap) return;
    // Bilder der Story (nur lokale Pfade — der Renderer liest kein http)
    const images: string[] = [];
    const followerId = assigns.find(a => a.channelId === ig.id)?.itemId;
    const follower = followerId ? await this.repo.getItem(userId, followerId) : null;
    for (const src of [follower, leadItem]) {
      for (const m of src?.media ?? []) {
        if (m.type === 'image' && !m.pathOrUrl.startsWith('http') && !images.includes(m.pathOrUrl)) images.push(m.pathOrUrl);
      }
    }
    if (images.length === 0) return;
    // Skript + Caption in EINEM LLM-Call
    const lang = languageName(typeof ig.config.language === 'string' ? ig.config.language : 'de');
    const prompt = `Erstelle aus diesem Artikel ein Instagram-Reel-Paket (${lang}):
1. "script": Sprechertext für 20-30 Sekunden (60-90 Wörter, gesprochene Sprache, packender Hook im ersten Satz, am Ende ein kurzer Verweis auf den ganzen Artikel — OHNE URL).
2. "caption": Reel-Caption (2-3 Sätze + Frage an die Community, keine Hashtags).
FAKTEN nur aus dem Artikel, nichts erfinden.

ARTIKEL: ${leadItem.title ?? ''}
${leadItem.body.slice(0, 1500)}

Antworte NUR mit einem VALIDEN JSON-Objekt: {"script": "…", "caption": "…"}`;
    const tierRaw = ig.config.model_tier;
    const tier = tierRaw === 'medium' || tierRaw === 'default' || tierRaw === 'strong' ? tierRaw : 'fast';
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 2_000, tier, reasoningEffort: 'low' });
    const raw = response.content ?? '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return;
    let pack: { script?: unknown; caption?: unknown };
    try { pack = JSON.parse(raw.slice(start, end + 1)); } catch { return; }
    if (typeof pack.script !== 'string' || pack.script.trim().length < 20) return;
    const script = pack.script.trim().slice(0, 1_000);
    const caption = typeof pack.caption === 'string' && pack.caption.trim() ? pack.caption.trim().slice(0, 1_500) : script.slice(0, 300);
    // Rendern (ffmpeg + TTS + Untertitel) — der teure Teil
    const pseudo: ContentItem = {
      ...leadItem, id: `reel-${leadItem.id.slice(0, 8)}`, body: script,
      media: images.map(p => ({ type: 'image' as const, source: 'generated' as const, pathOrUrl: p })),
    };
    const rendered = await this.videoTools.render(pseudo, ig, '9:16');
    // Als ENTWURF anlegen — Reels gehen bewusst durch die Freigabe
    const item = await this.repo.createItem(userId, ig.id, {
      status: 'draft',
      title: `Reel: ${leadItem.title ?? leadItem.body.slice(0, 60)}`,
      body: caption,
      hashtags: leadItem.hashtags.slice(0, 5),
      media: [{ type: 'video', source: 'generated', pathOrUrl: rendered.videoPath }],
      source: 'studio',
      storyId: leadItem.storyId,
    });
    await this.repo.mergePerformance(userId, item.id, {
      format: 'reel', autoReel: true, durationSec: rendered.durationSec, script,
    }).catch(() => { /* optional */ });
  }

  /** v1001 — Lead-Artikel einer Story finden (published, mit externalUrl); null wenn nicht auflösbar. */
  private async storyLeadUrl(userId: string, item: ContentItem): Promise<{ url: string; title?: string } | null> {
    if (!item.storyId) return null;
    const assigns = await this.repo.listAssignments(item.storyId);
    const mine = assigns.find(a => a.itemId === item.id);
    const lead = assigns.find(a => a.role === 'lead');
    if (!mine || mine.role === 'lead' || !lead?.itemId || lead.itemId === item.id) return null;
    const leadItem = await this.repo.getItem(userId, lead.itemId);
    if (!leadItem || leadItem.status !== 'published' || !leadItem.externalUrl) return null;
    return { url: leadItem.externalUrl, title: leadItem.title };
  }

  private async applyTrafficCta(userId: string, item: ContentItem, channel: SocialChannel): Promise<ContentItem> {
    try {
      if (channel.config.traffic_cta === false) return item;
      if (channel.platform === 'rest') return item; // die eigene Plattform IST das Ziel
      const lead = await this.storyLeadUrl(userId, item);
      if (!lead) return item;
      const url = channel.config.utm === false
        ? lead.url
        : appendUtm(lead.url, channel.platform, lead.title ?? item.title ?? 'social');
      const custom = typeof channel.config.traffic_cta_text === 'string' && channel.config.traffic_cta_text.trim().length > 0
        ? channel.config.traffic_cta_text.trim() : undefined;
      // v1001 — Telegram: Inline-Button statt Text-Link (URL via performance.trafficUrl an den Provider)
      if (channel.platform === 'telegram_channel') {
        return { ...item, performance: { ...item.performance, trafficUrl: url, ...(custom ? { trafficLabel: custom } : {}) } };
      }
      const cta = channel.platform === 'instagram'
        ? (custom ?? '🔗 Ganzer Artikel über den Link im Profil.')
        : `${custom ?? '👉 Ganzer Artikel:'} ${url}`;
      return { ...item, body: `${item.body}\n\n${cta}` };
    } catch {
      return item; // Traffic-CTA darf einen Publish NIE verhindern
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

  /**
   * v991 — Bild eines Entwurfs NEU generieren (optional mit User-Hinweis als
   * Bildidee). Läuft durch alle Studio-Leitplanken (v982-Text-Schrubber,
   * Bildnisrecht, Vision-Gate, Monats-Budget) und ERSETZT die generierten
   * Medien des Items; vom User angehängte/externe Medien bleiben.
   */
  private async regenerateImage(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (item.status === 'published') return { success: false, error: 'Bereits veröffentlicht — das Bild lässt sich nur vor dem Publish tauschen.' };
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    if (!this.imageFn) return { success: false, error: 'Bild-Generierung nicht verfügbar.' };
    const hint = typeof input.hint === 'string' && input.hint.trim().length > 0 ? input.hint.trim() : undefined;
    // v1003 — performance mitgeben: Termin-Felder (terminBis/ort/einlass) für die Bild-Karte
    const media = await this.imageFn(channel, { title: item.title, body: item.body, bildidee: hint, performance: item.performance });
    if (media.length === 0) {
      return { success: false, error: 'Kein Bild erzeugt — Budget erschöpft, generate_images aus oder Bild-Prüfung nicht bestanden. Ggf. mit anderem Hinweis erneut versuchen.' };
    }
    const kept = item.media.filter(m => m.source !== 'generated');
    await this.repo.updateItemContent(userId, item.id, { media: [...media, ...kept] });
    return { success: true, display: `🎨 [${item.id.slice(0, 8)}] Bild neu generiert${hint ? ` (Hinweis: „${hint.slice(0, 80)}")` : ''} — Status und Termin bleiben erhalten.` };
  }

  /**
   * v991 — Entwurf per Anweisung ÜBERARBEITEN LASSEN („kürzer", „Fokus auf X"):
   * das Kanal-LLM (model_tier/Persona/Lektionen) schreibt Titel/Body/Hashtags
   * um. Bewusst OHNE Story-Dedup-Gates (gleiche Story, gewollte Überarbeitung);
   * optional lernt der Kanal per lesson gleich mit.
   */
  private async reviseContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (item.status === 'published') return { success: false, error: 'Bereits veröffentlicht — nicht mehr überarbeitbar.' };
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    if (!instruction) return { success: false, error: 'instruction erforderlich (was soll geändert werden?)' };
    if (!this.llm) return { success: false, error: 'LLM nicht verfügbar.' };
    const channel = await this.repo.getChannel(userId, item.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    const lessons = Array.isArray(channel.config.lessons)
      ? (channel.config.lessons as unknown[]).filter((l): l is string => typeof l === 'string').slice(-10)
      : [];
    const tierRaw = channel.config.model_tier;
    const tier = tierRaw === 'medium' || tierRaw === 'default' || tierRaw === 'strong' ? tierRaw : 'fast';
    const prompt = `Du überarbeitest einen Social-Media-Entwurf für den Kanal "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}${lessons.length ? `KORREKTUREN AUS DER VERGANGENHEIT (zwingend): ${lessons.join(' | ')}\n` : ''}
AKTUELLER ENTWURF:
Titel: ${item.title ?? '(ohne)'}
Text: ${item.body}
Hashtags: ${item.hashtags.join(', ') || '(keine)'}

ANWEISUNG DES REDAKTEURS: ${instruction}

Regeln: Fakten beibehalten (nichts dazu erfinden), KEINE Meta-Zeilen, Hashtags AUSSCHLIESSLICH ins Feld.
Antworte NUR mit einem VALIDEN JSON-Objekt (Zitate typografisch „…“ oder escaped):
{"title": "…", "body": "…", "hashtags": ["…"]}`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 4000, tier, reasoningEffort: 'low' });
    const content = response.content ?? '';
    // robust parsen: direkte Form, sonst deutsches Zitat mit ASCII-Schlusszeichen reparieren (v978-Muster)
    let parsed: { title?: unknown; body?: unknown; hashtags?: unknown } | null = null;
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      for (const candidate of [match[0], match[0].replace(/„([^„"“]*)"/g, '„$1“')]) {
        try { parsed = JSON.parse(candidate); break; } catch { /* nächster Versuch */ }
      }
    }
    if (!parsed || typeof parsed.body !== 'string' || parsed.body.trim().length < 10) {
      return { success: false, error: 'Überarbeitung fehlgeschlagen (LLM-Antwort unbrauchbar) — bitte erneut versuchen.' };
    }
    const cleanBody = parsed.body
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
      .split('\n').filter(l => !/^\s*(bildidee|hinweis)\s*:/i.test(l)).join('\n').trim();
    const { body, tags: bodyTags } = extractTrailingHashtags(cleanBody);
    const fieldTags = Array.isArray(parsed.hashtags) ? (parsed.hashtags as unknown[]).map(String) : item.hashtags;
    await this.repo.updateItemContent(userId, item.id, {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.slice(0, 200) : item.title,
      body,
      hashtags: mergeHashtags(fieldTags, bodyTags),
    });
    let lessonNote = '';
    if (typeof input.lesson === 'string' && input.lesson.trim().length > 0) {
      const r = await this.addLesson(userId, { channel: item.channelId, lesson: input.lesson });
      if (r.success) lessonNote = '\n📚 Lektion gespeichert.';
    }
    return { success: true, display: `✨ [${item.id.slice(0, 8)}] überarbeitet („${instruction.slice(0, 80)}") — Status und Termin bleiben erhalten.${lessonNote}` };
  }

  /**
   * v987 — Item LOKAL löschen (Entwürfe/geplante/abgelehnte): anders als
   * reject OHNE Story-Sperre — das Studio darf den Stoff neu aufgreifen
   * (Realfall 04.07.: Item mit kaputtem Bild löschen + neu erzeugen ging
   * bisher nur per Hand in der DB). Published-Items sind ausgenommen: die
   * gehen über delete_remote bzw. bleiben als Dedup-Sperrliste erhalten.
   */
  private async deleteItemLocal(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (item.status === 'published') {
      return { success: false, error: 'Veröffentlichte Beiträge nicht lokal löschen — delete_remote entfernt sie auf der Plattform; der Eintrag bleibt als Duplikat-Sperre.' };
    }
    const ok = await this.repo.deleteItem(userId, item.id);
    return ok
      ? { success: true, display: `🗑 [${item.id.slice(0, 8)}] gelöscht (ohne Story-Sperre — das Studio darf den Stoff neu aufgreifen).` }
      : { success: false, error: 'Löschen fehlgeschlagen.' };
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
   * v1001 — Klick-Rückkanal: liest Artikel-Statistiken der eigenen Plattform
   * (rest-Kanäle, GET config.stats_path ?? /api/integrations/stats, Bearer
   * API_TOKEN) und legt sie als channel_metrics ab: kind 'views' auf dem
   * rest-Kanal (je Lead-Item via externalUrl-Match), kind 'clicks' je
   * utm_source auf dem passenden Familien-Kanal (je Follower-Item derselben
   * Story, falls auflösbar). Fehlender Endpoint (404) bleibt still — die
   * Plattform-Seite ist optional (Spec: docs/specs/fussball-cc-stats-api-spec.md).
   */
  async collectTrafficStats(userId: string): Promise<number> {
    const channels = await this.repo.listChannels(userId, 'active');
    const familyOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    let collected = 0;
    for (const channel of channels.filter(c => c.platform === 'rest')) {
      const base = typeof channel.config.base_url === 'string' ? channel.config.base_url.replace(/\/+$/, '') : '';
      if (!base || channel.config.traffic_stats === false) continue;
      const path = typeof channel.config.stats_path === 'string' && channel.config.stats_path.trim()
        ? channel.config.stats_path.trim() : '/api/integrations/stats';
      try {
        const secrets = await this.secrets(channel);
        const headers: Record<string, string> = {};
        if (secrets.API_TOKEN) headers.Authorization = `Bearer ${secrets.API_TOKEN}`;
        const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
        const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        if (channel.config.insecure_tls === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        let res: Response;
        try {
          res = await fetch(`${base}${path.startsWith('/') ? path : `/${path}`}?since=${encodeURIComponent(since)}`, { headers });
        } finally {
          if (channel.config.insecure_tls === true) {
            if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
          }
        }
        if (!res.ok) continue; // Endpoint (noch) nicht vorhanden — kein Fehler
        const data = await res.json().catch(() => null) as { data?: Array<{ date?: string; path?: string; views?: number; sources?: Record<string, number> }> } | null;
        const rows = Array.isArray(data?.data) ? data.data : [];
        if (rows.length === 0) continue;
        const published = await this.repo.listItems(userId, { channelId: channel.id, status: 'published', limit: 100 });
        const siblings = channels.filter(c => c.id !== channel.id && familyOf(c) !== null && familyOf(c) === familyOf(channel));
        for (const row of rows) {
          if (!row.path || !row.date) continue;
          const leadItem = published.find(i => i.externalUrl && i.externalUrl.includes(row.path!));
          if (typeof row.views === 'number' && row.views > 0 && leadItem) {
            await this.repo.upsertMetric(channel.id, { itemId: leadItem.id, date: row.date, kind: 'views', value: row.views });
            collected++;
          }
          for (const [source, clicks] of Object.entries(row.sources ?? {})) {
            if (typeof clicks !== 'number' || clicks <= 0) continue;
            const target = siblings.find(c => c.platform === source);
            if (!target) continue; // direct/organic/unbekannte Quellen ignorieren
            let followerId: string | undefined;
            if (leadItem?.storyId) {
              const assigns = await this.repo.listAssignments(leadItem.storyId).catch(() => []);
              followerId = assigns.find(a => a.channelId === target.id)?.itemId;
            }
            await this.repo.upsertMetric(target.id, { itemId: followerId, date: row.date, kind: 'clicks', value: clicks });
            collected++;
          }
        }
      } catch { /* Kanal-Fehler überspringen — nächster Kanal */ }
    }
    return collected;
  }

  /** v1011 — Ablage generierter Bilder (für den Health-Check-Schreibtest). */
  setMediaDir(dir: string): void {
    this.mediaDir = dir;
  }

  /**
   * v1011 — Deploy-Health-Check: prüft nach Deploy/Restart die komplette
   * Social-Kette — sharp (Overlays), mediaDir beschreibbar, LLM/Bild-Pipeline
   * verdrahtet, je Kanal Auth + public_media + Stats-Endpoint. Nur lesen und
   * ein Bericht — verändert nichts.
   */
  private async healthCheck(userId: string): Promise<SkillResult> {
    const lines: string[] = [];
    let problems = 0;
    // 1. sharp (Bild-Overlays/Crops)
    try {
      const { loadSharp } = await import('./image-overlay.js');
      const sharp = await loadSharp();
      if (sharp) lines.push('✅ sharp geladen — Wasserzeichen/Termin-Karten/Crops aktiv');
      else { lines.push('⚠️ sharp NICHT ladbar — Bilder laufen OHNE Overlays (npm install / Plattform-Binary prüfen)'); problems++; }
    } catch { lines.push('⚠️ sharp-Check fehlgeschlagen'); problems++; }
    // 2. mediaDir beschreibbar
    if (this.mediaDir) {
      try {
        const { mkdir, writeFile, unlink } = await import('node:fs/promises');
        const { join } = await import('node:path');
        await mkdir(this.mediaDir, { recursive: true });
        const probe = join(this.mediaDir, `.health-${Date.now()}`);
        await writeFile(probe, 'ok');
        await unlink(probe);
        lines.push(`✅ Medien-Ablage beschreibbar (${this.mediaDir})`);
      } catch (err) { lines.push(`❌ Medien-Ablage NICHT beschreibbar: ${(err as Error).message}`); problems++; }
    } else { lines.push('⚠️ Medien-Ablage nicht verdrahtet (setMediaDir fehlt)'); problems++; }
    // 3. LLM + Bild-Generierung
    lines.push(this.llm ? '✅ LLM verfügbar' : '❌ LLM fehlt — Studio/Übersetzungen/Triage laufen nicht');
    if (!this.llm) problems++;
    lines.push(this.imageFn ? '✅ Bild-Generierung verdrahtet' : '⚠️ Bild-Generierung nicht verdrahtet');
    // 4. je Kanal: Provider, Auth, public_media, Stats-Endpoint
    const channels = await this.repo.listChannels(userId, 'active');
    for (const channel of channels) {
      const provider = this.providers.get(channel.platform);
      if (!provider) { lines.push(`❌ ${channel.name}: kein Provider für ${channel.platform}`); problems++; continue; }
      try {
        const auth = await provider.validateAuth(channel, await this.secrets(channel));
        if (auth.ok) lines.push(`✅ ${channel.name}: Auth ok${auth.detail ? ` (${auth.detail})` : ''}`);
        else { lines.push(`❌ ${channel.name}: Auth fehlgeschlagen — ${auth.detail ?? '?'}`); problems++; }
      } catch (err) { lines.push(`❌ ${channel.name}: Auth-Check-Fehler — ${(err as Error).message}`); problems++; }
      const pm = parsePublicMediaConfig(channel.config.public_media);
      if (pm && pm.provider === 'rest') {
        try {
          const res = await fetch(pm.base_url);
          if (res.status < 500) lines.push(`✅ ${channel.name}: Medien-Ablageort erreichbar (${pm.base_url})`);
          else { lines.push(`⚠️ ${channel.name}: Medien-Ablageort antwortet mit HTTP ${res.status}`); problems++; }
        } catch { lines.push(`❌ ${channel.name}: Medien-Ablageort NICHT erreichbar (${pm.base_url}) — IG/FB-Bild-Posts scheitern`); problems++; }
      }
      if (channel.platform === 'rest' && typeof channel.config.base_url === 'string' && channel.config.traffic_stats !== false) {
        const base = channel.config.base_url.replace(/\/+$/, '');
        const statsPath = typeof channel.config.stats_path === 'string' && channel.config.stats_path.trim() ? channel.config.stats_path.trim() : '/api/integrations/stats';
        try {
          const secrets = await this.secrets(channel);
          const headers: Record<string, string> = {};
          if (secrets.API_TOKEN) headers.Authorization = `Bearer ${secrets.API_TOKEN}`;
          const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          if (channel.config.insecure_tls === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
          let res: Response;
          try {
            res = await fetch(`${base}${statsPath.startsWith('/') ? statsPath : `/${statsPath}`}?since=${encodeURIComponent(new Date(Date.now() - 24 * 3_600_000).toISOString())}`, { headers });
          } finally {
            if (channel.config.insecure_tls === true) {
              if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
              else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
            }
          }
          if (res.ok) lines.push(`✅ ${channel.name}: Klick-Rückkanal aktiv (Stats-Endpoint antwortet)`);
          else if (res.status === 404) lines.push(`ℹ️ ${channel.name}: Stats-Endpoint noch nicht vorhanden (Plattform-Seite offen) — Klick-Rückkanal wartet`);
          else if (res.status === 401 || res.status === 403) { lines.push(`⚠️ ${channel.name}: Stats-Endpoint verweigert (HTTP ${res.status}) — API-Key-Scope prüfen (z. B. stats:read)`); problems++; }
          else { lines.push(`⚠️ ${channel.name}: Stats-Endpoint HTTP ${res.status}`); problems++; }
        } catch { lines.push(`⚠️ ${channel.name}: Stats-Endpoint nicht erreichbar`); problems++; }
      }
    }
    const header = problems === 0 ? '🩺 Social-Health-Check: alles in Ordnung.' : `🩺 Social-Health-Check: ${problems} Problem(e) gefunden.`;
    return { success: true, data: { problems }, display: `${header}\n${lines.join('\n')}` };
  }

  /**
   * v1010 — Lessons-Hygiene (monatlich vom Kern aufgerufen): Kanäle mit mehr
   * als 5 Lektionen bekommen einen Konsolidierungs-VORSCHLAG (LLM fasst
   * Duplikate/Verwandtes zusammen, erfindet nichts, verliert keine Regel).
   * Es wird NIE automatisch angewendet — der Kern legt den Vorschlag als
   * Insight vor, angewendet wird per update_channel/UI.
   */
  async consolidateLessons(userId: string): Promise<Array<{ channel: string; channelId: string; before: string[]; after: string[] }>> {
    if (!this.llm) return [];
    const channels = await this.repo.listChannels(userId, 'active');
    const proposals: Array<{ channel: string; channelId: string; before: string[]; after: string[] }> = [];
    for (const channel of channels) {
      const lessons = Array.isArray(channel.config.lessons)
        ? (channel.config.lessons as unknown[]).map(String).map(s => s.trim()).filter(Boolean)
        : [];
      if (lessons.length <= 5) continue;
      try {
        const prompt = `Diese Redaktions-Lektionen fließen in JEDEN Content-Prompt des Kanals "${channel.name}" ein. Konsolidiere sie auf höchstens 5:
- Duplikate und Verwandtes zu EINER präzisen Regel zusammenfassen.
- KEINE Regel inhaltlich verlieren, NICHTS erfinden, Widersprüche zugunsten der spezifischeren Regel auflösen.
- Jede Regel ein kurzer, direkt befolgbarer Satz.

LEKTIONEN:
${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Antworte NUR mit einem VALIDEN JSON-Array aus Strings: ["Regel 1", "Regel 2"]`;
        const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 2_000, tier: 'fast', reasoningEffort: 'low' });
        const raw = response.content ?? '';
        const start = raw.indexOf('[');
        const end = raw.lastIndexOf(']');
        if (start < 0 || end <= start) continue;
        let after: unknown;
        try { after = JSON.parse(raw.slice(start, end + 1)); } catch { continue; }
        if (!Array.isArray(after)) continue;
        const cleaned = after.map(String).map(s => s.trim()).filter(s => s.length > 5).slice(0, 5);
        if (cleaned.length === 0 || cleaned.length >= lessons.length) continue; // kein Gewinn → kein Vorschlag
        proposals.push({ channel: channel.name, channelId: channel.id, before: lessons, after: cleaned });
      } catch { /* Kanal-Fehler überspringen */ }
    }
    return proposals;
  }

  /**
   * v989 — Kommentare einsammeln (stündlich vom Kern aufgerufen): published
   * Items mit externalId je Kanal mit supportsComments → fetchComments →
   * dedupliziert ablegen. @returns neue Kommentare gesamt + je Kanal.
   */
  async collectComments(userId: string): Promise<{ collected: number; byChannel: Array<CommentBatchInfo> }> {
    const channels = await this.repo.listChannels(userId, 'active');
    let collected = 0;
    const byChannel: CommentBatchInfo[] = [];
    for (const channel of channels) {
      const provider = this.providers.get(channel.platform);
      if (!provider || provider.capabilities().supportsComments !== true) continue;
      const published = (await this.repo.listItems(userId, { channelId: channel.id, status: 'published', limit: 20 }))
        .filter(i => i.externalId)
        .map(i => ({ id: i.id, externalId: i.externalId! }));
      if (published.length === 0) continue;
      try {
        const comments = await provider.fetchComments(published, channel, await this.secrets(channel));
        let fresh = 0;
        for (const c of comments) {
          const isNew = await this.repo.upsertComment({
            userId, channelId: channel.id, itemId: c.itemId,
            externalCommentId: c.externalCommentId, externalPostId: c.externalPostId,
            author: c.author, text: c.text, remoteCreatedAt: c.createdAt,
          });
          if (isNew) fresh++;
        }
        if (fresh > 0) {
          collected += fresh;
          // v1009 — Kommentar-Copilot: Spam/Hass aussortieren, Fragen mit Antwort-Vorschlag
          const triage = await this.triageNewComments(userId, channel).catch(() => undefined);
          byChannel.push({ channel: channel.name, channelId: channel.id, count: fresh, ...(triage ?? {}) });
        }
      } catch { /* Kanal-Fehler überspringen — nächster Kanal */ }
    }
    return { collected, byChannel };
  }

  /**
   * v1009 — Kommentar-Copilot: klassifiziert die offenen Kommentare eines
   * Kanals (LLM-Batch: spam/hass/frage). Spam und Hass werden automatisch auf
   * 'ignored' gestellt (nur AUSBLENDEN in Alfred — auf der Plattform bleibt
   * der Kommentar; Hass wird zum Handeln gemeldet). Für bis zu 3 echte Fragen
   * entsteht direkt ein Antwort-Vorschlag. config.comment_triage=false
   * schaltet ab; best-effort — Fehler stören das Einsammeln nie.
   */
  private async triageNewComments(userId: string, channel: SocialChannel): Promise<Omit<CommentBatchInfo, 'channel' | 'channelId' | 'count'> | undefined> {
    if (!this.llm || channel.config.comment_triage === false) return undefined;
    const fresh = await this.repo.listComments(userId, { channelId: channel.id, status: 'new', limit: 15 });
    if (fresh.length === 0) return undefined;
    const prompt = `Du moderierst die Kommentare des Social-Kanals "${channel.name}". Klassifiziere JEDEN Kommentar:
- spam: Werbung, Link-Schleudern, Bot-Müll, themenfremde Massenware
- hass: Beleidigung, Hetze, Drohung (im Zweifel false — lieber ein Spam/Hass-Fall zu wenig als eine echte Stimme weg)
- frage: eine echte Frage, die eine Antwort verdient

${fresh.map((c, i) => `${i}: [${c.author ?? 'anonym'}] ${c.text.slice(0, 200)}`).join('\n')}

Antworte NUR mit einem VALIDEN JSON-Array: [{"index": 0, "spam": false, "hass": false, "frage": true}]`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1_500, tier: 'fast', reasoningEffort: 'low' });
    const raw = response.content ?? '';
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end <= start) return undefined;
    let verdicts: Array<{ index?: unknown; spam?: unknown; hass?: unknown; frage?: unknown }>;
    try { verdicts = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
    let spamIgnored = 0;
    let hassFlagged = 0;
    const suggestions: NonNullable<CommentBatchInfo['suggestions']> = [];
    for (const v of verdicts) {
      if (typeof v.index !== 'number' || !fresh[v.index]) continue;
      const comment = fresh[v.index];
      if (v.spam === true || v.hass === true) {
        await this.repo.setCommentStatus(userId, comment.id, 'ignored').catch(() => { /* Einzelfehler */ });
        if (v.hass === true) hassFlagged++; else spamIgnored++;
        continue;
      }
      if (v.frage === true && suggestions.length < 3) {
        const r = await this.suggestReply(userId, { comment_id: comment.id }).catch(() => null);
        const draft = (r?.data as { draft?: string } | undefined)?.draft;
        if (r?.success && draft) {
          suggestions.push({ id: comment.id, author: comment.author, text: comment.text.slice(0, 160), draft });
        }
      }
    }
    if (spamIgnored === 0 && hassFlagged === 0 && suggestions.length === 0) return undefined;
    return { spamIgnored, hassFlagged, suggestions };
  }

  /** v989 — offene/beantwortete Kommentare anzeigen. */
  private async listCommentsAction(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = typeof input.channel === 'string' && input.channel ? await this.resolveChannel(userId, input) : null;
    const status = input.status === 'replied' || input.status === 'ignored' || input.status === 'new'
      ? input.status : (typeof input.status === 'string' && input.status ? undefined : 'new');
    const comments = await this.repo.listComments(userId, {
      channelId: channel?.id, status: status as 'new' | undefined, limit: 30,
    });
    if (comments.length === 0) {
      return { success: true, data: { comments: [] }, display: `Keine ${status ?? ''} Kommentare${channel ? ` auf ${channel.name}` : ''}.` };
    }
    const lines = comments.map(c =>
      `• [${c.id.slice(0, 8)}] ${c.author ?? 'anonym'}${c.status !== 'new' ? ` (${c.status})` : ''}: "${c.text.slice(0, 140)}"`);
    return {
      success: true, data: { comments },
      display: `💬 ${comments.length} Kommentar(e)${channel ? ` auf **${channel.name}**` : ''}:\n${lines.join('\n')}\n\nAntworten: reply_comment mit comment_id + reply. Ignorieren: ignore_comment.`,
    };
  }

  /**
   * v992 — Antwort-VORSCHLAG zu einem Kommentar (kein Side-Effect): das
   * Kanal-LLM entwirft in Persona/Tonalität; gesendet wird erst über
   * reply_comment (User editiert/bestätigt).
   */
  private async suggestReply(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const comment = await this.repo.getComment(userId, typeof input.comment_id === 'string' ? input.comment_id : '');
    if (!comment) return { success: false, error: `Kommentar nicht gefunden: ${String(input.comment_id ?? '')}` };
    if (!this.llm) return { success: false, error: 'LLM nicht verfügbar.' };
    const channel = await this.repo.getChannel(userId, comment.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    const item = comment.itemId ? await this.repo.getItem(userId, comment.itemId) : null;
    // v1001 — Traffic: Wenn der Beitrag zu einer Story mit veröffentlichtem
    // Lead-Artikel gehört, darf die Antwort den Artikel-Link enthalten (mit UTM).
    const lead = item ? await this.storyLeadUrl(userId, item).catch(() => null) : null;
    const articleUrl = lead
      ? (channel.config.utm === false ? lead.url : appendUtm(lead.url, channel.platform, lead.title ?? 'kommentar'))
      : undefined;
    const tierRaw = channel.config.model_tier;
    const tier = tierRaw === 'medium' || tierRaw === 'default' || tierRaw === 'strong' ? tierRaw : 'fast';
    const prompt = `Du bist Community-Manager des Kanals "${channel.name}" (${channel.platform}).
${channel.persona ? `Persona/Tonalität: ${channel.persona}\n` : ''}${item ? `UNSER BEITRAG: ${item.title ?? ''} — ${item.body.slice(0, 300)}\n` : ''}${articleUrl ? `AUSFÜHRLICHER ARTIKEL ZUM BEITRAG: ${articleUrl}\n` : ''}
KOMMENTAR von ${comment.author ?? 'einem Fan'}: "${comment.text}"

Formuliere EINE freundliche, konkrete Antwort (${languageName(typeof channel.config.language === 'string' ? channel.config.language : 'de')}, max. 300 Zeichen, keine Hashtags, keine Emojis-Flut).
Erfinde KEINE Fakten — wenn die Frage Informationen braucht, die du nicht hast, formuliere einen freundlichen Verweis auf den Artikel bzw. eine Rückfrage.
${articleUrl ? `Wird die Frage im ausführlichen Artikel beantwortet, DARFST du die Artikel-URL oben wörtlich in die Antwort aufnehmen. ` : ''}NIEMALS andere URLs erfinden.
Antworte NUR mit dem Antwort-Text, ohne Anführungszeichen drumherum.`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 500, tier, reasoningEffort: 'low' });
    const draft = (response.content ?? '').trim().replace(/^["„]|["“]$/g, '').slice(0, 500);
    if (draft.length < 2) return { success: false, error: 'Kein Vorschlag erzeugt — bitte erneut versuchen.' };
    return { success: true, data: { draft }, display: `💡 Vorschlag: "${draft}"\n\nSenden: reply_comment mit comment_id ${comment.id.slice(0, 8)} (Text anpassbar).` };
  }

  /** v989 — auf einen Kommentar antworten (Antwort geht LIVE auf die Plattform). */
  private async replyComment(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const commentId = typeof input.comment_id === 'string' ? input.comment_id.trim() : '';
    const reply = typeof input.reply === 'string' ? input.reply.trim() : '';
    if (!commentId || !reply) return { success: false, error: 'comment_id und reply erforderlich' };
    const comment = await this.repo.getComment(userId, commentId);
    if (!comment) return { success: false, error: `Kommentar nicht gefunden: ${commentId}` };
    if (comment.status === 'replied') return { success: false, error: 'Bereits beantwortet.' };
    const channel = await this.repo.getChannel(userId, comment.channelId);
    if (!channel) return { success: false, error: 'Kanal nicht gefunden' };
    const provider = this.providers.get(channel.platform);
    if (!provider || provider.capabilities().supportsComments !== true) {
      return { success: false, error: `${channel.platform} unterstützt keine Kommentar-Antworten.` };
    }
    const ok = await provider.replyToComment(comment.externalCommentId, reply, channel, await this.secrets(channel));
    if (!ok) return { success: false, error: 'Antwort auf der Plattform fehlgeschlagen.' };
    await this.repo.setCommentStatus(userId, comment.id, 'replied', reply);
    return { success: true, display: `💬 Antwort auf ${comment.author ?? 'Kommentar'} veröffentlicht (**${channel.name}**): "${reply.slice(0, 120)}"` };
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
      // v962 — Quelle ohne Medien + Ziel-Kanal mit generate_images: Bild erzeugen
      const media = item.media.length > 0 ? item.media
        : await this.maybeAdhocImage(target, { title: title ?? undefined, body });
      const copy = await this.repo.createItem(userId, target.id, {
        title, body, hashtags,
        media,
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

Regeln: Inhalt und Fakten beibehalten, nur Form/Länge/Ton an den Ziel-Kanal anpassen. Keine Meta-Zeilen. Hashtags AUSSCHLIESSLICH ins Feld "hashtags", niemals in den Text.
Antworte NUR mit JSON: {"title": "…", "body": "…", "hashtags": ["…"]}`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1500, tier: 'fast' });
    const match = response.content?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.body !== 'string' || parsed.body.trim().length < 10) return null;
      // v961 — Hashtags am Body-Ende deterministisch abtrennen (gleiche Schicht wie im Studio)
      const { body, tags } = extractTrailingHashtags(parsed.body.slice(0, 10_000));
      return {
        title: typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title.slice(0, 200) : item.title,
        body,
        hashtags: mergeHashtags(Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : item.hashtags, tags),
      };
    } catch {
      return null;
    }
  }

  /**
   * v951 — Interessen-Thema an einen Kanal koppeln/lösen. Ein Kanal kann
   * MEHRERE Themen speisen (config.topic_ids[]): das Studio zieht dann aus
   * allen Dossiers und verteilt die Posts über die Themen.
   */
  private async linkTopic(userId: string, input: Record<string, unknown>, link: boolean): Promise<SkillResult> {
    if (!this.topicResolver) return { success: false, error: 'Interessen-Modul nicht verfügbar.' };
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const topicQuery = typeof input.topic === 'string' ? input.topic.trim() : '';
    if (!topicQuery) return { success: false, error: 'topic erforderlich (Themen-Name)' };
    const topic = await this.topicResolver(topicQuery);
    if (!topic) return { success: false, error: `Interessen-Thema nicht gefunden: ${topicQuery} — mit interests create_topic anlegen.` };

    const current = new Set<string>();
    if (Array.isArray(channel.config.topic_ids)) {
      for (const id of channel.config.topic_ids) if (typeof id === 'string') current.add(id);
    }
    if (typeof channel.config.topic_id === 'string' && channel.config.topic_id) current.add(channel.config.topic_id);

    if (link) {
      if (current.has(topic.id)) return { success: true, display: `Thema **${topic.name}** ist bereits mit **${channel.name}** verknüpft.` };
      current.add(topic.id);
    } else {
      if (!current.has(topic.id)) return { success: false, error: `Thema ${topic.name} ist nicht mit ${channel.name} verknüpft.` };
      current.delete(topic.id);
    }
    const config = { ...channel.config, topic_ids: [...current] };
    delete (config as Record<string, unknown>).topic_id; // Legacy-Feld in topic_ids überführt
    await this.repo.updateChannel(userId, channel.id, { config });
    return {
      success: true,
      data: { topicIds: [...current] },
      display: link
        ? `🔗 Thema **${topic.name}** mit **${channel.name}** verknüpft (${current.size} Thema/Themen gesamt) — das Studio zieht ab dem nächsten Lauf aus allen Dossiers.`
        : `Thema **${topic.name}** von **${channel.name}** gelöst (${current.size} verbleibend).`,
    };
  }

  /** v959 — bestehende geplante Beiträge in die aktuellen Slots umplanen. */
  private async replanChannel(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.replanFn) return { success: false, error: 'Umplanung nicht verfügbar.' };
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const moved = await this.replanFn(channel);
    const eff = effectiveSlots(channel);
    return {
      success: true,
      data: { moved },
      display: `📅 ${moved} Beitrag/Beiträge von **${channel.name}** in die aktuellen Slots umgeplant (${eff.slots.join(', ')}${eff.source === 'best-practice' ? ' — Plattform-Best-Practice' : ''}). Freigegebene/veröffentlichte Termine bleiben unberührt.`,
    };
  }

  /** v955 — vollständigen Item-Inhalt lesen (für gezielte Korrekturen). */
  private async getContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    return {
      success: true,
      data: { item },
      display: `[${item.id.slice(0, 8)}] ${item.status.toUpperCase()}${item.scheduledAt ? ` ⏰ ${item.scheduledAt.slice(0, 16).replace('T', ' ')}` : ''}\n**${item.title ?? '(ohne Titel)'}**\n\n${item.body}\n\nHashtags: ${item.hashtags.join(', ') || '(keine)'}`,
    };
  }

  /**
   * v955 — Item korrigieren (Titel/Text/Hashtags), z.B. „EM" → „WM".
   * Mit optionaler `lesson` lernt der Kanal daraus: die Lektion landet
   * zwingend in allen künftigen Studio-Prompts (config.lessons).
   */
  private async editContent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const item = await this.resolveItem(userId, input);
    if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
    if (item.status === 'published') return { success: false, error: 'Veröffentlichte Beiträge können nicht mehr editiert werden (delete_remote + neu posten).' };
    const patch: { title?: string; body?: string; hashtags?: string[] } = {};
    if (typeof input.title === 'string') patch.title = input.title;
    if (typeof input.body === 'string' && input.body.trim().length > 0) patch.body = input.body;
    if (Array.isArray(input.hashtags)) patch.hashtags = input.hashtags.map(String);
    if (Object.keys(patch).length === 0) return { success: false, error: 'Nichts zu ändern übergeben (title/body/hashtags).' };
    await this.repo.updateItemContent(userId, item.id, patch);
    let lessonNote = '';
    if (typeof input.lesson === 'string' && input.lesson.trim().length > 0) {
      const lessonResult = await this.addLesson(userId, { channel: item.channelId, lesson: input.lesson });
      if (lessonResult.success) lessonNote = `\n📚 Lektion gespeichert — künftige Entwürfe beachten sie.`;
    }
    return { success: true, display: `✏️ [${item.id.slice(0, 8)}] korrigiert (${Object.keys(patch).join(', ')}).${lessonNote}` };
  }

  /** v955 — Kanal-Lektion speichern (fließt zwingend in künftige Studio-Prompts). */
  private async addLesson(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const channel = await this.resolveChannel(userId, input);
    if (!channel) return { success: false, error: `Kanal nicht gefunden: ${String(input.channel ?? '')}` };
    const lesson = typeof input.lesson === 'string' ? input.lesson.trim() : '';
    if (!lesson) return { success: false, error: 'lesson erforderlich' };
    const lessons = Array.isArray(channel.config.lessons)
      ? (channel.config.lessons as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];
    if (!lessons.includes(lesson)) lessons.push(lesson);
    await this.repo.updateChannel(userId, channel.id, { config: { ...channel.config, lessons: lessons.slice(-20) } });
    return { success: true, display: `📚 Lektion für **${channel.name}** gespeichert (${lessons.length} gesamt): „${lesson}"` };
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
