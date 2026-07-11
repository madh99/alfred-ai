import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { SocialRepository, SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { SocialProvider } from './social-provider.js';
import { appendUtm, composePostText, effectiveSlots, extractTrailingHashtags, isInternalUrl, languageName, mergeHashtags } from './social-provider.js';
import { tlsFetch } from './tls-fetch.js';
import { createHash } from 'node:crypto';
import { isNearDuplicateTitle } from './dedup.js';
import { applyImageOverlays, bakeReelEndCard, buildVideoWatermark, cropToRatio, loadSharp, parseOverlayCorner, resolveImageBranding } from './image-overlay.js';
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
  | 'get_content' | 'edit_content' | 'add_lesson' | 'replan_channel' | 'plan_story' | 'refresh_overlays' | 'dedup_library' | 'render_reel' | 'post_from_video' | 'edit_video' | 'animate_image' | 'find_highlights';

/**
 * v1035/v1056 — Begleitformate (Auto-Story, Reels): keine regulären Posts —
 * vom Duplikat-Gate ausgenommen und bei Freigabe ad-hoc terminiert (sie
 * hängen nicht am Artikel-Slot-Raster).
 */
export function isCompanionFormat(x: Pick<ContentItem, 'performance'>): boolean {
  return x.performance?.autoStory === true || x.performance?.autoReel === true
    || x.performance?.format === 'story' || x.performance?.format === 'reel';
}

/**
 * v1068 — GEMEINSAME Duplikat-Suche (eine Quelle der Wahrheit): findet einen
 * in den letzten 7 Tagen auf dem Kanal veröffentlichten, sehr ähnlichen
 * Beitrag. Genutzt vom Publish-Gate (Enforcement, v973) UND vom
 * plan_story-Vorab-Check (beratend) — beide können nie auseinanderlaufen.
 * Termin-Posts haben Termin-Identität (v983), Story-Geschwister
 * Story-Identität (v1023), Begleitformate sind ausgenommen (v1035).
 */
export async function findRecentChannelDuplicate(
  repo: Pick<SocialRepository, 'listItems'>,
  userId: string,
  channelId: string,
  cand: Pick<ContentItem, 'body'> & { id?: string; title?: string | null; storyId?: string | null; performance?: ContentItem['performance'] },
): Promise<ContentItem | undefined> {
  if (isCompanionFormat(cand as Pick<ContentItem, 'performance'>)) return undefined;
  const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const recentPublished = await repo.listItems(userId, {
    channelId, status: 'published', updatedSince: weekAgo, limit: 200,
  });
  const terminOf = (p: ContentItem): string | undefined =>
    typeof p.performance?.terminBis === 'string' ? p.performance.terminBis : undefined;
  const candTermin = typeof cand.performance?.terminBis === 'string' ? cand.performance.terminBis : undefined;
  const candidateTitle = cand.title ?? cand.body.slice(0, 60);
  return candTermin
    ? recentPublished.find(p => p.id !== cand.id && terminOf(p) === candTermin)
    : recentPublished.find(p => {
      if (p.id === cand.id || terminOf(p) !== undefined || isCompanionFormat(p)) return false;
      if (cand.storyId && p.storyId) return p.storyId === cand.storyId;
      return isNearDuplicateTitle(candidateTitle, [p.title ?? p.body.slice(0, 60)]);
    });
}

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
            'get_content', 'edit_content', 'add_lesson', 'replan_channel', 'plan_story', 'refresh_overlays', 'dedup_library', 'render_reel', 'post_from_video', 'edit_video', 'animate_image', 'find_highlights'],
          description: 'Kanal-Verwaltung, Content-Pipeline oder Veröffentlichung. pause_all = Not-Aus für alle Kanäle ("Social-Stopp"). generate_content = Content-Studio sofort laufen lassen. render_video = Slideshow-Video (Bilder+Voiceover+Untertitel) aus einem Item rendern (ffmpeg, kostenlos). replan_channel = bereits geplante Beiträge in die aktuellen Posting-Slots umverteilen ("Plane die Beiträge um"). plan_story = Ad-hoc-Story auf User-Zuruf ("Mach eine Story zu X für alle Kanäle"): der Stoff (Feld stoff, Fakten inklusive!) wird als echte Redaktions-Story auf ALLEN Familien-Kanälen ausgespielt — je Kanal eigener Text/Persona/Sprache + Bild, Lead-Slot +30 min, Follower +90 min, Freigaben nach Kanal-Modus. refresh_overlays = Bilder aller UNVERÖFFENTLICHTEN Beiträge aus dem Basis-Asset mit der AKTUELLEN Overlay-Config neu zusammensetzen (nach Look-/Logo-Änderungen; ohne Bild-Budget; optional channel). dedup_library = Fast-Duplikate in der Bild-Bibliothek aufräumen: ähnliche Basis-Bilder (gleicher Pool/Stil/Format) werden zusammengefasst, pro Gruppe bleibt eines (gepinnt > meistgenutzt > neuestes), der Rest wird gelöscht. render_reel = Reel für einen Beitrag (item_id) anstoßen — funktioniert für JEDEN Beitrag mit lokalen Bildern (Studio- oder User-erstellt, mit oder ohne Story, published oder geplant); Ziel ist der Instagram-Kanal der Familie, gleiche Leitplanken wie beim Auto-Reel (Wochen-Cap, KI-Clips, Entwurf mit Freigabe, Zweitverwertung). post_from_video = Beitrag aus einem Video der Bibliothek (asset_id) für einen oder mehrere Kanäle (channels): Alfred schreibt Titel/Caption je Kanal-Persona (optionaler stoff-Hinweis fließt ein), Entwürfe mit Freigabe. edit_video = Basis-Schnitt: 1-8 Bibliotheks-Videos (clips mit asset_id + optional von/bis in Sekunden) trimmen und mit Übergängen verketten, optionaler titel als Overlay — das Ergebnis landet als neues Video in der Bibliothek (ffmpeg, kostenlos). animate_image = Bild beleben: aus einem Bibliotheks-BILD (asset_id) einen bewegten KI-Clip machen (Image-to-Video, KOSTENPFLICHTIG je Clip, gleiches Monatsbudget wie die Reel-KI-Clips); optionale regie beschreibt die Bewegung (sonst schlaegt Alfred sie aus der Bildbeschreibung vor) — der Clip landet in der Video-Bibliothek. find_highlights = Auto-Highlights: die besten Momente eines Bibliotheks-Videos (asset_id) automatisch finden (Lautheits-Spitzen + Szenenwechsel) und als einzelne Highlight-Clips schneiden (anzahl, Default 3) — kostenlos (ffmpeg), Clips landen in der Bibliothek.',
        },
        channel: { type: 'string', description: 'Kanal-Name/-Handle/-Plattform (fuzzy) oder Kanal-ID' },
        platform: { type: 'string', enum: ['telegram_channel', 'rest', 'youtube', 'instagram', 'facebook', 'threads', 'x', 'bluesky'], description: 'create_channel: Plattform. instagram/facebook/threads brauchen META_ACCESS_TOKEN (ENV-Stage social) + config ig_user_id/page_id/threads_user_id; youtube OAuth2-Secrets; x X_ACCESS_TOKEN/X_REFRESH_TOKEN+X_CLIENT_ID (OAuth2; Bild-Posts via v1.1: zusätzlich X_CONSUMER_KEY/X_CONSUMER_SECRET/X_OAUTH1_ACCESS_TOKEN/X_OAUTH1_ACCESS_SECRET — der OAuth2-Scope media.write wird oft nicht gewährt); bluesky config.handle + Secret BLUESKY_APP_PASSWORD (App-Passwort, Bilder werden direkt hochgeladen — kein public_media nötig, Links klickbar). Instagram: Posts brauchen IMMER ein Medium mit ÖFFENTLICHER http-URL (kein reiner Text).' },
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
        channels: { type: 'array', items: { type: 'string' }, description: 'crosspost/post_from_video: Ziel-Kanäle (Namen/IDs)' },
        asset_id: { type: 'string', description: 'post_from_video: Video-ID aus der Bibliothek. animate_image: Bild-ID aus der Bibliothek' },
        regie: { type: 'string', description: 'animate_image: Bewegungs-Regie fuer den Clip (englisch oder deutsch; ohne: Alfred schlaegt sie aus der Bildbeschreibung vor)' },
        anzahl: { type: 'number', description: 'find_highlights: wie viele Highlight-Clips (1-8, Default 3)' },
        clips: { type: 'array', items: { type: 'object', properties: { asset_id: { type: 'string' }, von: { type: 'number' }, bis: { type: 'number' }, tempo: { type: 'number' }, look: { type: 'string', enum: ['kino', 'warm', 'kalt', 'sw', 'lebendig'] }, text: { type: 'string' } } }, description: 'edit_video: Schnitt-Liste in Reihenfolge — je Clip asset_id (Bibliotheks-Video) + optional von/bis (Sekunden), tempo (0,25-4: <1 Zeitlupe, >1 Zeitraffer), look (Farb-Preset) und text (Einblendung waehrend des Clips)' },
        adapt: { type: 'boolean', description: 'crosspost: Text formatgerecht je Ziel-Kanal umschreiben (Default true; false = wörtliche Kopie)' },
        topic: { type: 'string', description: 'link_topic/unlink_topic: Interessen-Thema (Name, fuzzy) — ein Kanal kann MEHRERE Themen speisen (z.B. „WM 2026" + „Panini-Sammelalbum")' },
        lesson: { type: 'string', description: 'edit_content/add_lesson: Lektion für künftige Studio-Läufe des Kanals, z.B. "Es ist die WM 2026, nicht die EM — auch in Hashtags" — wird zwingend in künftige Prompts aufgenommen' },
        comment_id: { type: 'string', description: 'reply_comment/ignore_comment: ID des Kommentars (aus list_comments)' },
        reply: { type: 'string', description: 'reply_comment: die Antwort — geht LIVE auf die Plattform (FB/IG)' },
        hint: { type: 'string', description: 'regenerate_image: optionaler Bild-Hinweis, z.B. "beide Flaggen zeigen, ohne Menschen"' },
        instruction: { type: 'string', description: 'revise_content: Überarbeitungs-Anweisung, z.B. "halb so lang, ohne Superlative" — das Kanal-LLM schreibt Titel/Text/Hashtags um (Status/Termin bleiben)' },
        stoff: { type: 'string', description: 'plan_story: der Stoff der Story in 1-6 Sätzen MIT allen Fakten (Wer/Was/Wann/Kontext) — NUR daraus wird je Kanal getextet, nichts wird dazuerfunden' },
        titel: { type: 'string', description: 'plan_story: optionaler Arbeitstitel der Story (sonst aus dem Stoff abgeleitet). edit_video: optionaler Titel als Overlay über den ersten Sekunden' },
        family: { type: 'string', description: 'plan_story: optional Familien-Schlüssel (project:<id>/family:<name>) — nur nötig, wenn mehrere Familien existieren' },
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
    // v1058 — opts: Hook-Karte (intro) und End-Card (outro) fürs Reel
    render: (item: ContentItem, channel: SocialChannel, format: '9:16' | '16:9', opts?: { introImage?: string; outroImage?: string; music?: { volume?: number } | false; clips?: Array<{ index: number; path: string; durationSec: number }>; overlayImage?: string; voiceId?: string }) => Promise<{ videoPath: string; durationSec: number }>;
    /** v1060 — Stufe 3: Image-to-Video-Clip (Sora/Runway/Veo, kostenpflichtig). */
    generateClip?: (req: { imagePath: string; prompt: string; provider: 'sora' | 'runway' | 'veo'; model?: string; secrets: Record<string, string>; format: '9:16' | '16:9' }) => Promise<{ clipPath: string; durationSec: number }>;
    probe?: (path: string) => Promise<{ ok: boolean; durationSec?: number; detail?: string }>;
    /** v1094 — Auto-Highlights: beste Fenster (Lautheit + Szenenwechsel) aus langem Material. */
    analyze?: (path: string, opts?: { count?: number; maxLenSec?: number }) => Promise<Array<{ start: number; end: number; score: number }>>;
    /** v1088/v1092 — Basis-Schnitt: Clips trimmen + verketten (Crossfade), Titel-Overlay, Tempo/Look/Text je Clip. */
    edit?: (opts: { clips: Array<{ path: string; startSec?: number; endSec?: number; speed?: number; look?: string; overlayImage?: string }>; format: '9:16' | '16:9'; overlayImage?: string; outBaseName?: string }) => Promise<{ videoPath: string; durationSec: number }>;
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

  /** v1022 — laufende Auto-Reel-Renders je IG-Kanal (TOCTOU-Guard fürs Wochen-Limit). */
  private readonly reelsRendering = new Map<string, number>();

  setStudio(fn: (channel: SocialChannel) => Promise<number>): void {
    this.studioFn = fn;
  }

  /** v959 — Umplanen bestehender scheduled-Items in die aktuellen Slots. */
  private replanFn?: (channel: SocialChannel) => Promise<number>;

  setReplanner(fn: (channel: SocialChannel) => Promise<number>): void {
    this.replanFn = fn;
  }

  /** v1024 — Ad-hoc-Story auf User-Zuruf (ContentStudio.planAdhocStory, vom Kern injiziert). */
  private storyPlannerFn?: (titel: string | undefined, stoff: string, family?: string) => Promise<{ created: number; channels: string[]; family: string; storyTitle: string; warnings?: string[] }>;

  setStoryPlanner(fn: (titel: string | undefined, stoff: string, family?: string) => Promise<{ created: number; channels: string[]; family: string; storyTitle: string; warnings?: string[] }>): void {
    this.storyPlannerFn = fn;
  }

  /** v1026 — Overlays unveröffentlichter Beiträge neu anwenden (ContentStudio.refreshOverlays, vom Kern injiziert). */
  private overlayRefresherFn?: (channel?: string) => Promise<{ refreshed: number; skipped: number; channels: string[] }>;

  setOverlayRefresher(fn: (channel?: string) => Promise<{ refreshed: number; skipped: number; channels: string[] }>): void {
    this.overlayRefresherFn = fn;
  }

  /** v1039 — Fast-Duplikate der Bild-Bibliothek aufräumen (ContentStudio.dedupMediaLibrary, vom Kern injiziert). */
  private libraryDeduperFn?: () => Promise<{ scanned: number; groups: number; removed: number }>;

  setLibraryDeduper(fn: () => Promise<{ scanned: number; groups: number; removed: number }>): void {
    this.libraryDeduperFn = fn;
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
          // v1022 — der Token steht in der Refresh-URL (Meta-API-Vorgabe):
          // aus Fehlermeldungen tilgen, bevor sie in Insights/Logs landen
          const msg = (err as Error).message.replace(/access_token=[^&\s]+/g, 'access_token=***');
          failures.push({ channel: channel.name, detail: `IG-Token-Refresh: ${msg}` });
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
        case 'reject_content': {
          const res = await this.transitionSimple(userId, input, 'rejected', 'Abgelehnt — Item bleibt als rejected erhalten (kann als Entwurf reaktiviert werden).');
          // v1064 — Video-Zwillinge (FB-Zweitverwertung nutzt DIESELBE Datei)
          // mit-ablehnen: sonst bleibt der Zwilling als Waise liegen und
          // könnte mit dem verworfenen Video freigegeben werden (Realfall
          // 09.07.: zwei verwaiste FB-Entwürfe der Test-Reels).
          if (res.success) {
            const twinNote = await this.rejectVideoTwins(userId, input).catch(() => undefined);
            if (twinNote) res.display = `${res.display ?? ''}\n${twinNote}`;
          }
          return res;
        }
        case 'publish_now': return await this.publishNow(userId, input);
        case 'mark_published': return await this.markPublished(userId, input);
        case 'delete_remote': return await this.deleteRemote(userId, input);
        case 'delete_item': return await this.deleteItemLocal(userId, input);
        case 'regenerate_image': return await this.regenerateImage(userId, input);
        case 'revise_content': return await this.reviseContent(userId, input);
        case 'attach_media': return await this.attachMedia(userId, input);
        case 'generate_content': return await this.generateContent(userId, input);
        case 'render_video': return await this.renderVideo(userId, input);
        case 'render_reel': {
          // v1062/v1076 — Reel manuell anstoßen (gleicher Pfad wie beim
          // Lead-Publish: Familien-IG-Kanal, Wochen-Cap, KI-Clips, Entwurf
          // mit Freigabe). Funktioniert für JEDEN Beitrag mit Bildern —
          // auch User-erstellt, auch ohne Story, published oder geplant.
          const item = await this.resolveItem(userId, input);
          if (!item) return { success: false, error: `Item nicht gefunden: ${String(input.item_id ?? '')}` };
          if (item.status === 'rejected') return { success: false, error: 'Item ist abgelehnt — erst reaktivieren (Bearbeiten) oder anderes Item wählen.' };
          // Ohne Story liefern NUR die eigenen Bilder die Slides — mit Story
          // kommen sie auch vom Familien-Follower (wie beim Auto-Reel).
          if (!item.storyId && !item.media.some(m => m.type === 'image' && !m.pathOrUrl.startsWith('http'))) {
            return { success: false, error: 'render_reel braucht mindestens ein lokales Bild am Beitrag (generiert oder angehängt) — daraus entstehen die Slides.' };
          }
          const leadChannel = await this.repo.getChannel(userId, item.channelId);
          if (!leadChannel) return { success: false, error: 'Kanal des Items nicht gefunden.' };
          void this.maybeAutoReel(userId, item, leadChannel, { manual: true }).catch(() => { /* best-effort wie beim Publish */ });
          return { success: true, display: `🎬 Reel-Rendering für [${item.id.slice(0, 8)}] angestoßen — der Entwurf erscheint in einigen Minuten in der Queue (Freigabe nötig). Kommt keiner: Wochen-Limit (reel_max_per_week) prüfen oder kein Instagram-Kanal in der Familie.` };
        }
        case 'crosspost': return await this.crosspost(userId, input);
        case 'post_from_video': return await this.postFromVideo(userId, input);
        case 'edit_video': return await this.editVideoFromLibrary(userId, input);
        case 'animate_image': return await this.animateImage(userId, input);
        case 'find_highlights': return await this.findHighlights(userId, input);
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
        case 'plan_story': return await this.planStory(input);
        case 'refresh_overlays': {
          if (!this.overlayRefresherFn) return { success: false, error: 'Overlay-Refresh nicht verfügbar (Content-Studio nicht verdrahtet).' };
          const r = await this.overlayRefresherFn(typeof input.channel === 'string' ? input.channel : undefined);
          return {
            success: true, data: r,
            display: `🖌️ Overlays neu angewandt: ${r.refreshed} Bild(er)${r.channels.length ? ` (${r.channels.join(', ')})` : ''}${r.skipped ? ` — ${r.skipped} übersprungen (Karussell, ohne Basis-Asset oder anderer Node)` : ''}.`,
          };
        }
        case 'dedup_library': {
          if (!this.libraryDeduperFn) return { success: false, error: 'Bibliotheks-Aufräumen nicht verfügbar (Content-Studio nicht verdrahtet).' };
          const r = await this.libraryDeduperFn();
          return {
            success: true, data: r,
            display: r.removed > 0
              ? `🧹 Bild-Bibliothek aufgeräumt: ${r.removed} Fast-Duplikat(e) aus ${r.groups} Gruppe(n) entfernt (${r.scanned} Bilder geprüft).`
              : `🧹 Bild-Bibliothek geprüft (${r.scanned} Bilder) — keine Fast-Duplikate gefunden.`,
          };
        }
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
    // v1076 — Video-Erkennung an der Endung: der Composer schickt nur eine
    // URL/einen Pfad — mp4/mov/webm werden automatisch als Video angelegt
    const inferredType = typeof input.media_url === 'string' && /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(input.media_url.trim()) ? 'video' as const : 'image' as const;
    let media: ContentMedia[] = typeof input.media_url === 'string' && input.media_url.trim()
      ? [{ type: (input.media_type === 'video' || input.media_type === 'audio' ? input.media_type : inferredType), source: 'user', pathOrUrl: input.media_url.trim() }]
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
    let updated = await this.repo.transition(userId, item.id, 'approved');
    // v1056 — slotlose BEGLEITFORMATE (Auto-Reel/-Story) bekommen bei der
    // Freigabe einen Ad-hoc-Termin (+15 min): sie hängen bewusst NICHT am
    // Artikel-Slot-Raster, aber ein approved-Item OHNE Termin ist für die
    // Publish-Engine unsichtbar (Realfall 08.07.: zwei fertige Reels vom
    // 06.07. hingen still fest). Tages-Limit/Leitplanken greifen beim Publish.
    if (!updated.scheduledAt && isCompanionFormat(item)) {
      const adhoc = new Date(Date.now() + 15 * 60_000).toISOString();
      if (await this.repo.reschedule(userId, item.id, adhoc, ['approved'])) {
        updated = { ...updated, scheduledAt: adhoc };
      }
    }
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
      // v1068 — Suche in den gemeinsamen Helfer extrahiert (gleiche Kriterien
      // für Publish-Gate UND plan_story-Vorab-Check; Historie: v983-Termin-
      // Identität, v1023-Story-Identität, v1035-Begleitformate ausgenommen).
      const dupOf = await findRecentChannelDuplicate(this.repo, userId, channel.id, item);
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
      // v1081 — Reel ist live → Video best-effort an den BESTEHENDEN
      // Lead-Artikel der Story hängen (rest-Kanäle mit attach_reel_video)
      void this.maybeAttachArticleVideo(userId, published, channel).catch(() => { /* best-effort */ });
      // v1076 — Transparenz: hat das Item ein Video, der Kanal-Provider aber
      // keine Video-Fähigkeit, ging der Beitrag OHNE Video raus — sagen statt
      // still weglassen.
      const videoDropped = item.media.some(m => m.type === 'video') && provider.capabilities().video !== true
        ? `\n⚠️ ${channel.name} unterstützt keine Videos — der Beitrag ging ohne Video raus.` : '';
      return {
        success: true,
        data: { item: published },
        display: `🚀 Veröffentlicht auf **${channel.name}**${result.url ? `: ${result.url}` : ` (ID ${result.externalId})`}${storyNote ? `\n${storyNote}` : ''}${videoDropped}`,
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
   * Locale-Versionen. Cache über translationsOf (v1022: Content-HASH+Ziele —
   * vorher nur Längen: eine längengleiche Korrektur wie „EM"→„WM" traf den
   * Cache und die VERALTETE Übersetzung ging live), damit Retries nicht
   * erneut zahlen. Best-effort: Fehler blockieren den Publish NIE
   * (der Artikel erscheint dann vorerst einsprachig).
   */
  private async applyTranslations(userId: string, item: ContentItem, channel: SocialChannel): Promise<ContentItem> {
    try {
      if (channel.platform !== 'rest' || !this.llm) return item;
      const targets = Array.isArray(channel.config.translate_to)
        ? (channel.config.translate_to as unknown[]).filter((l): l is string => typeof l === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(l)).map(l => l.toLowerCase())
        : [];
      if (targets.length === 0) return item;
      // v1045 — QUELLSPRACHE gehört in den Marker: ein language-Wechsel bei
      // gleichem Text/Zielen traf sonst den Cache aus der alten Quellsprache
      const source = typeof channel.config.language === 'string' ? channel.config.language : 'de';
      const marker = `${createHash('sha256').update(`${item.title ?? ''}\u0000${item.body}`).digest('hex').slice(0, 16)}:${source}:${targets.join(',')}`;
      const cached = item.performance?.translations;
      if (cached && typeof cached === 'object' && item.performance?.translationsOf === marker) return item;
      const prompt = `Übersetze den folgenden Artikel aus ${languageName(source)} in die Zielsprachen: ${targets.map(t => `"${t}" (${languageName(t)})`).join(', ')}.
Regeln: sinn- und tongetreu, KEINE Fakten ändern oder ergänzen, Eigennamen/Vereins-/Ortsnamen unverändert, Zahlen/Daten/Uhrzeiten exakt übernehmen. Die ABSATZ-Struktur (Leerzeilen) exakt beibehalten. Zitate im Text mit \\" escapen.

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
    // v1022 — gleiche Leitplanken wie publishNow: die Story geht LIVE raus,
    // Monats-Limit und Blacklist des IG-Kanals dürfen nicht umgangen werden
    const igMonthlyCap = typeof ig.config.max_posts_per_month === 'number' ? ig.config.max_posts_per_month : undefined;
    if (igMonthlyCap !== undefined) {
      const monthStart = `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`;
      if (await this.repo.countPublishedSince(ig.id, monthStart) >= igMonthlyCap) return undefined;
    }
    const storyHaystack = `${leadItem.title ?? ''} ${leadItem.body}`.toLowerCase();
    if (ig.blacklist.some(w => w.trim().length > 0 && storyHaystack.includes(w.toLowerCase()))) return undefined;
    // Bild: das IG-Follower-Item derselben Story hat bereits ein passendes Motiv
    const followerId = assigns.find(a => a.channelId === ig.id)?.itemId;
    const follower = followerId ? await this.repo.getItem(userId, followerId) : null;
    const image = follower?.media.find(m => m.type === 'image');
    if (!image) return undefined;
    let base: Buffer;
    let alreadyBranded = false; // v1026 — Follower-Bild trägt schon Wasserzeichen → nicht doppelt stempeln
    if (image.pathOrUrl.startsWith('http')) {
      // v1022 — Timeout: eine hängende Medien-URL darf den (längst verbuchten)
      // publishNow-Aufruf nicht bis zum Skill-Timeout blockieren
      const res = await fetch(image.pathOrUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return undefined;
      base = Buffer.from(await res.arrayBuffer());
      alreadyBranded = true;
    } else {
      const { readFile } = await import('node:fs/promises');
      // v1026 — sauberes Basis-Asset bevorzugen (asset-Zwilling der studio-Datei):
      // vorher wurde das bereits gestempelte Follower-Bild erneut gestempelt —
      // Realfall 06.07.: doppeltes, am Rand abgeschnittenes Wasserzeichen in der Story
      const assetTwin = image.pathOrUrl.replace(/([\\/])studio-/, '$1asset-');
      try {
        base = await readFile(assetTwin);
      } catch {
        base = await readFile(image.pathOrUrl);
        alreadyBranded = true;
      }
    }
    const framed = await cropToRatio(base, 9, 16);
    const withOverlay = await applyImageOverlays(framed, {
      title: leadItem.title ?? undefined,
      cta: typeof ig.config.story_cta_text === 'string' && ig.config.story_cta_text.trim() ? ig.config.story_cta_text.trim() : '🔗 Link im Profil',
      branding: alreadyBranded ? undefined : resolveImageBranding(ig, channels),
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
  /**
   * v1081 — Reel-Video an den bestehenden Lead-Artikel hängen: Der Artikel
   * geht Minuten VOR dem fertig gerenderten Reel live — sobald ein Video-
   * Beitrag der Story veröffentlicht ist, bekommen rest-Kanäle der Familie
   * mit attach_reel_video:true das Video per PATCH nachgereicht (die
   * Plattform rendert daraus einen Player). Einmalig je Artikel
   * (performance.articleVideo), best-effort — scheitert der PATCH (z. B.
   * Plattform kann noch kein video-Feld), bleibt der Artikel unverändert.
   */
  private async maybeAttachArticleVideo(userId: string, published: ContentItem, channel: SocialChannel): Promise<void> {
    if (!published.storyId) return;
    const video = published.media.find(m => m.type === 'video')?.pathOrUrl;
    if (!video) return;
    const familyOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    const channels = await this.repo.listChannels(userId, 'active');
    const targets = channels.filter(c => c.config.attach_reel_video === true
      && familyOf(c) !== null && familyOf(c) === familyOf(channel));
    if (targets.length === 0) return;
    const assigns = await this.repo.listAssignments(published.storyId);
    for (const target of targets) {
      const leadAssign = assigns.find(a => a.channelId === target.id && a.role === 'lead');
      if (!leadAssign?.itemId || leadAssign.itemId === published.id) continue;
      const lead = await this.repo.getItem(userId, leadAssign.itemId);
      if (!lead || lead.status !== 'published' || !lead.externalId) continue;
      if (typeof lead.performance?.articleVideo === 'string') continue; // schon angehängt
      const provider = this.providers.get(target.platform);
      if (!provider) continue;
      const ok = await provider.attachVideo(lead.externalId, video, target, await this.secrets(target)).catch(() => false);
      if (ok) {
        await this.repo.mergePerformance(userId, lead.id, { articleVideo: video }).catch(() => { /* optional */ });
      }
    }
  }

  private async maybeAutoReel(userId: string, leadItem: ContentItem, leadChannel: SocialChannel, opts?: { manual?: boolean }): Promise<void> {
    if (!this.videoTools || !this.llm) return;
    // v1076 — storyId ist keine Pflicht mehr: manuell angestoßene Reels
    // (render_reel) funktionieren auch für User-Beiträge ohne Story — dann
    // liefern die Bilder des Items selbst die Slides. Der AUTOMATISCHE Pfad
    // (Lead-Publish) verlangt weiterhin die Lead-Rolle einer Story.
    let assigns: Awaited<ReturnType<SocialRepository['listAssignments']>> = [];
    if (leadItem.storyId) {
      assigns = await this.repo.listAssignments(leadItem.storyId);
      const mine = assigns.find(a => a.itemId === leadItem.id);
      if (!opts?.manual && (!mine || mine.role !== 'lead')) return;
    } else if (!opts?.manual) {
      return;
    }
    const familyOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    const channels = await this.repo.listChannels(userId, 'active');
    // v1076 — manueller Anstoß darf auch vom IG-Kanal selbst kommen; der
    // automatische Pfad schließt den Quell-Kanal weiter aus (sonst würde
    // jeder IG-Feed-Post ein Reel von sich selbst erzeugen).
    const ig = channels.find(c => (opts?.manual || c.id !== leadChannel.id) && c.platform === 'instagram'
      && (c.config.auto_reel === true || opts?.manual === true) && familyOf(c) !== null && familyOf(c) === familyOf(leadChannel));
    if (!ig) return;
    // Wochen-Limit: Rendering + TTS kosten — Reels bleiben besondere Momente
    const cap = typeof ig.config.reel_max_per_week === 'number' && ig.config.reel_max_per_week >= 0 ? ig.config.reel_max_per_week : 2;
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    const recent = await this.repo.listItems(userId, { channelId: ig.id, limit: 100 });
    const reelsThisWeek = recent.filter(i => i.performance?.format === 'reel' && i.createdAt >= weekAgo).length;
    // v1022 — TOCTOU-Guard: das Item entsteht erst NACH dem minutenlangen
    // Render — zwei Lead-Publishes im Render-Fenster lasen beide den alten
    // Zählerstand und überschritten das Wochen-Limit. In-flight-Renders
    // zählen jetzt mit (fire-and-forget läuft im selben Prozess).
    const inFlight = this.reelsRendering.get(ig.id) ?? 0;
    if (reelsThisWeek + inFlight >= cap) return;
    this.reelsRendering.set(ig.id, inFlight + 1);
    try {
      await this.renderAutoReel(userId, leadItem, ig, assigns);
    } finally {
      const n = (this.reelsRendering.get(ig.id) ?? 1) - 1;
      if (n <= 0) this.reelsRendering.delete(ig.id);
      else this.reelsRendering.set(ig.id, n);
    }
  }

  /** v1022 — eigentliches Reel-Rendern (aus maybeAutoReel ausgelagert, läuft unter dem In-flight-Guard). */
  /**
   * v1064 — Begleitformat-Zwillinge mit derselben Videodatei (FB-Reel-
   * Zweitverwertung, v1056) auf anderen Kanälen mit-ablehnen. Nur
   * unveröffentlichte Stadien; best-effort.
   */
  private async rejectVideoTwins(userId: string, input: Record<string, unknown>): Promise<string | undefined> {
    const item = await this.resolveItem(userId, input);
    if (!item || !isCompanionFormat(item)) return undefined;
    const video = item.media.find(m => m.type === 'video')?.pathOrUrl;
    if (!video) return undefined;
    const channels = await this.repo.listChannels(userId, 'active');
    const notes: string[] = [];
    for (const ch of channels) {
      if (ch.id === item.channelId) continue;
      const siblings = await this.repo.listItems(userId, { channelId: ch.id, limit: 50 });
      for (const s of siblings) {
        if (s.id === item.id || !['draft', 'scheduled', 'approved'].includes(s.status)) continue;
        if (!s.media.some(m => m.type === 'video' && m.pathOrUrl === video)) continue;
        try {
          await this.repo.transition(userId, s.id, 'rejected');
          notes.push(`↳ Zwilling [${s.id.slice(0, 8)}] auf ${ch.name} mit-abgelehnt (gleiche Videodatei).`);
        } catch { /* Einzelfehler überspringen */ }
      }
    }
    return notes.length > 0 ? notes.join('\n') : undefined;
  }

  /**
   * v1059 — Musik-Bett-Optionen aus der Kanal-Config: reel_music:false
   * schaltet es ab, reel_music_volume (0–1) regelt die Lautstärke. Die
   * Track-Auswahl (Ordner reel-music im Datenverzeichnis) macht der Kern.
   */
  private reelMusicOpts(channel: SocialChannel): { volume?: number } | false {
    if (channel.config.reel_music === false) return false;
    const vol = channel.config.reel_music_volume;
    return typeof vol === 'number' && vol > 0 && vol <= 1 ? { volume: vol } : {};
  }

  private async renderAutoReel(
    userId: string, leadItem: ContentItem, ig: SocialChannel,
    assigns: Awaited<ReturnType<SocialRepository['listAssignments']>>,
  ): Promise<void> {
    if (!this.videoTools || !this.llm) return;
    // Bilder der Story (nur lokale Pfade — der Renderer liest kein http).
    // v1058 — SAUBERE Slides: der asset-Zwilling (ohne eingebrannte Titel-
    // Boxen/Wasserzeichen) wird bevorzugt — vorher trugen die Slides die
    // Studio-Overlays und kollidierten mit den Video-Untertiteln (Realfall
    // 08.07.: Titel-Balken UND Untertitel übereinander im Live-Reel).
    const { access } = await import('node:fs/promises');
    const images: string[] = [];
    const followerId = assigns.find(a => a.channelId === ig.id)?.itemId;
    const follower = followerId ? await this.repo.getItem(userId, followerId) : null;
    for (const src of [follower, leadItem]) {
      for (const m of src?.media ?? []) {
        if (m.type !== 'image' || m.pathOrUrl.startsWith('http')) continue;
        const twin = m.pathOrUrl.replace(/([\\/])studio-/, '$1asset-');
        const path = twin !== m.pathOrUrl && await access(twin).then(() => true).catch(() => false) ? twin : m.pathOrUrl;
        if (!images.includes(path)) images.push(path);
      }
    }
    if (images.length === 0) return;
    // Skript + Caption in EINEM LLM-Call
    const lang = languageName(typeof ig.config.language === 'string' ? ig.config.language : 'de');
    const prompt = `Erstelle aus diesem Artikel ein Instagram-Reel-Paket (${lang}):
1. "script": Sprechertext für 20-30 Sekunden (60-90 Wörter, gesprochene Sprache, packender Hook im ersten Satz, am Ende ein kurzer Verweis auf den ganzen Artikel — OHNE URL). Der Text wird von einer TTS-Stimme gesprochen, die ihre Betonung aus der ZEICHENSETZUNG ableitet — schreibe wie ein Sportmoderator: kurze, punchige Sätze statt Schachtelsätze, eine rhetorische Frage oder ein Ausruf wo es passt, bewusste Pausen mit Gedankenstrichen — Zahlen und Namen an betonter Stelle. KEINE Regieanweisungen, keine Klammern, nur sprechbarer Text.
2. "caption": Reel-Caption (2-3 Sätze, keine Hashtags; nur GELEGENTLICH mit Frage an die Community — nicht standardmäßig).
3. "motion": kurze ENGLISCHE Kamera-/Bewegungsbeschreibung, um das Artikelbild zum Leben zu erwecken (z.B. "slow cinematic camera push-in, crowd waving flags, natural stadium light" — KEINE Texteinblendungen, KEINE realen/erkennbaren Personen, KEINE Logos).
FAKTEN nur aus dem Artikel, nichts erfinden.

ARTIKEL: ${leadItem.title ?? ''}
${leadItem.body.slice(0, 1500)}

Antworte NUR mit einem VALIDEN JSON-Objekt: {"script": "…", "caption": "…", "motion": "…"}`;
    const tierRaw = ig.config.model_tier;
    const tier = tierRaw === 'medium' || tierRaw === 'default' || tierRaw === 'strong' ? tierRaw : 'fast';
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 2_000, tier, reasoningEffort: 'low' });
    const raw = response.content ?? '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return;
    let pack: { script?: unknown; caption?: unknown; motion?: unknown };
    try { pack = JSON.parse(raw.slice(start, end + 1)); } catch { return; }
    if (typeof pack.script !== 'string' || pack.script.trim().length < 20) return;
    const script = pack.script.trim().slice(0, 1_000);
    const caption = typeof pack.caption === 'string' && pack.caption.trim() ? pack.caption.trim().slice(0, 1_500) : script.slice(0, 300);
    const motion = typeof pack.motion === 'string' && pack.motion.trim()
      ? pack.motion.trim().slice(0, 400)
      : 'slow cinematic camera push-in, subtle natural motion, no text overlays, no recognizable people';
    // Rendern (ffmpeg + TTS + Untertitel) — der teure Teil
    const pseudo: ContentItem = {
      ...leadItem, id: `reel-${leadItem.id.slice(0, 8)}`, body: script,
      media: images.map(p => ({ type: 'image' as const, source: 'generated' as const, pathOrUrl: p })),
    };
    // v1058 — Hook-Karte (Titel eingebrannt) + End-Card (CTA) best-effort:
    // scheitert die Backerei, rendert das Reel schlicht ohne die Karten.
    let introImage: string | undefined;
    let outroImage: string | undefined;
    let overlayImage: string | undefined;
    const tmpFiles: string[] = [];
    // v1066 — Dauer-Branding (Opt-in): reel_watermark 'text'|'logo'|'both',
    // Ecke wie beim Bild. Aktiv → Branding NICHT zusätzlich in Hook/End-Card
    // einbrennen (stünde sonst doppelt im Bild).
    const wmRaw = ig.config.reel_watermark;
    const wmMode = wmRaw === 'text' || wmRaw === 'logo' || wmRaw === 'both' ? wmRaw : undefined;
    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const channelsForBranding = await this.repo.listChannels(userId, 'active');
      const branding = resolveImageBranding(ig, channelsForBranding);
      const hookTitle = leadItem.title ?? leadItem.body.slice(0, 70);
      // v1062 — ERST auf 9:16 zuschneiden, DANN Overlays: vorher wurden die
      // Boxen aufs Querformat gebacken und vom Cover-Crop seitlich
      // abgeschnitten (Realfall: End-Card „…er Artikel auf fussb…").
      const first = await cropToRatio(await readFile(images[0]), 9, 16);
      // v1065 — engerer Umbruch: gestaffelte kurze Boxen statt bildbreiter
      // Balken-Zeile (Realfall: 27-Zeichen-Zeile = 88% Bildbreite wirkte
      // wie ein durchgehender Balken).
      const hook = await applyImageOverlays(first, { title: hookTitle, titleMaxWidthRatio: 0.75, ...(branding && !wmMode ? { branding } : {}) });
      introImage = join(tmpdir(), `alfred-reel-hook-${leadItem.id.slice(0, 8)}.png`);
      await writeFile(introImage, hook);
      tmpFiles.push(introImage);
      const ctaText = typeof ig.config.reel_cta_text === 'string' && ig.config.reel_cta_text.trim()
        ? ig.config.reel_cta_text.trim()
        : `Ganzer Artikel auf ${branding ?? 'unserer Seite'}`;
      const last = await cropToRatio(await readFile(images[images.length - 1]), 9, 16);
      const endCard = await bakeReelEndCard(last, ctaText, wmMode ? undefined : branding);
      outroImage = join(tmpdir(), `alfred-reel-end-${leadItem.id.slice(0, 8)}.png`);
      await writeFile(outroImage, endCard);
      tmpFiles.push(outroImage);
      if (wmMode) {
        const overlayCfg = (ig.config.image_overlay ?? {}) as { logo?: { svg?: string; corner?: string; color?: string } };
        const corner = parseOverlayCorner(ig.config.reel_watermark_corner, 'bottom-right');
        // v1067 — Anordnung bei Text+Logo: stack (Block) | stack_fit (Text auf
        // Logo-Breite) | split (getrennte Ecken wie bei den Bildern)
        const layoutRaw = ig.config.reel_watermark_layout;
        const layout = layoutRaw === 'stack_fit' || layoutRaw === 'split' ? layoutRaw : 'stack';
        const wm = await buildVideoWatermark(1080, 1920, {
          ...(wmMode !== 'logo' && branding ? { branding } : {}),
          ...(wmMode !== 'text' && overlayCfg.logo?.svg ? { logo: { svg: overlayCfg.logo.svg, ...(overlayCfg.logo.color ? { color: overlayCfg.logo.color } : {}) } } : {}),
          corner,
          layout,
          ...(layout === 'split' ? { logoCorner: parseOverlayCorner(ig.config.reel_watermark_logo_corner, 'top-left') } : {}),
        });
        if (wm) {
          overlayImage = join(tmpdir(), `alfred-reel-wm-${leadItem.id.slice(0, 8)}.png`);
          await writeFile(overlayImage, wm);
          tmpFiles.push(overlayImage);
        }
      }
    } catch {
      introImage = undefined;
      outroImage = undefined;
      overlayImage = undefined;
    }
    // v1060 — Stufe 3 (Opt-in!): KI-Clips für die ersten 1-2 Bilder. Nur wenn
    // der Kanal reel_ai_clips gesetzt hat, Monats-Budget noch Luft hat und der
    // Kern den Generator anbietet. JEDER Fehlschlag fällt still auf die
    // Ken-Burns-Standbild-Slide zurück — das Reel kommt immer raus.
    const clips: Array<{ index: number; path: string; durationSec: number }> = [];
    const clipNotes: string[] = [];
    const aiClipsWanted = typeof ig.config.reel_ai_clips === 'number' ? Math.min(Math.max(Math.floor(ig.config.reel_ai_clips), 0), 2) : 0;
    if (aiClipsWanted > 0 && this.videoTools.generateClip) {
      const provRaw = ig.config.reel_ai_provider;
      const provider = provRaw === 'runway' || provRaw === 'veo' ? provRaw : 'sora';
      const model = typeof ig.config.reel_ai_model === 'string' && ig.config.reel_ai_model.trim() ? ig.config.reel_ai_model.trim() : undefined;
      const clipBudget = typeof ig.config.ai_clip_budget_per_month === 'number' ? ig.config.ai_clip_budget_per_month : 8;
      const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
      let clipsUsed = (await this.repo.listMetrics(ig.id, { kind: 'gen_ai_clip', sinceDate: monthStart }))
        .reduce((sum, m) => sum + m.value, 0);
      const secrets = await this.secrets(ig);
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < Math.min(aiClipsWanted, images.length); i++) {
        if (clipsUsed >= clipBudget) {
          clipNotes.push(`KI-Clip-Monatsbudget erreicht (${clipsUsed}/${clipBudget}) — Standbild-Slides.`);
          break;
        }
        try {
          const clip = await this.videoTools.generateClip({
            imagePath: images[i], prompt: motion, provider, ...(model ? { model } : {}), secrets, format: '9:16',
          });
          clips.push({ index: i, path: clip.clipPath, durationSec: clip.durationSec });
          clipsUsed += 1;
          // Budget-Ehrlichkeit (v1055-Lektion): JEDER gestartete, gelieferte
          // Clip zählt sofort — auch wenn das Reel danach scheitern sollte.
          const dayUsed = (await this.repo.listMetrics(ig.id, { kind: 'gen_ai_clip', sinceDate: today }))
            .find(m => m.date === today && !m.itemId)?.value ?? 0;
          await this.repo.upsertMetric(ig.id, { date: today, kind: 'gen_ai_clip', value: dayUsed + 1 });
        } catch (err) {
          clipNotes.push(`KI-Clip ${i + 1} (${provider}) fehlgeschlagen: ${(err as Error).message.slice(0, 150)} — Standbild-Slide.`);
        }
      }
    }
    let rendered: { videoPath: string; durationSec: number };
    try {
      // v1078 — Sprecherstimme je Kanal (Mistral-Custom-Voice-ID)
      const voiceId = typeof ig.config.reel_voice_id === 'string' && ig.config.reel_voice_id.trim() ? ig.config.reel_voice_id.trim() : undefined;
      rendered = await this.videoTools.render(pseudo, ig, '9:16', {
        introImage, outroImage, music: this.reelMusicOpts(ig),
        ...(voiceId ? { voiceId } : {}),
        ...(clips.length > 0 ? { clips } : {}),
        ...(overlayImage ? { overlayImage } : {}),
      });
    } finally {
      const { unlink } = await import('node:fs/promises');
      for (const f of tmpFiles) await unlink(f).catch(() => { /* tmp best-effort */ });
    }
    // Als ENTWURF anlegen — Reels gehen bewusst durch die Freigabe.
    // v1022 — Titel OHNE „Reel: "-Präfix: der Titel läuft beim Publish über
    // composePostText in die ÖFFENTLICHE Caption (Kennzeichnung in der UI
    // übernimmt performance.format='reel' + Video-Badge).
    const item = await this.repo.createItem(userId, ig.id, {
      status: 'draft',
      title: leadItem.title ?? leadItem.body.slice(0, 60),
      body: caption,
      hashtags: leadItem.hashtags.slice(0, 5),
      media: [{ type: 'video', source: 'generated', pathOrUrl: rendered.videoPath }],
      source: 'studio',
      storyId: leadItem.storyId,
    });
    await this.repo.mergePerformance(userId, item.id, {
      format: 'reel', autoReel: true, durationSec: rendered.durationSec, script,
      // v1060 — KI-Clip-Protokoll: was gekostet hat und was auf Standbild
      // zurückfiel, sichtbar am Entwurf (Freigabe-Entscheidung).
      ...(clips.length > 0 ? { aiClips: clips.length } : {}),
      ...(clipNotes.length > 0 ? { aiClipNotes: clipNotes } : {}),
    }).catch(() => { /* optional */ });
    // v1086 — jedes gerenderte Reel landet in der Video-Bibliothek
    // (Werkstatt-Baustein: wiederverwendbar für Beiträge/Schnitt)
    const igFamily = typeof ig.config.family === 'string' && ig.config.family.trim()
      ? `family:${ig.config.family.trim().toLowerCase()}` : (ig.projectId ? `project:${ig.projectId}` : undefined);
    await this.repo.createMediaAsset(userId, {
      channelId: ig.id, ...(igFamily ? { family: igFamily } : {}),
      path: rendered.videoPath, motif: (leadItem.title ?? script).slice(0, 200),
      kind: 'video', model: 'reel', format: '9:16', durationSec: rendered.durationSec,
    }).catch(() => { /* Bibliothek best-effort */ });

    // v1056/v1076 — Zweitverwertung: DASSELBE gerenderte Video als
    // Reel-ENTWURF auf ALLEN video-fähigen Familien-Kanälen mit
    // auto_reel:true (Facebook /videos, X chunked-Upload, Telegram
    // sendVideo, Bluesky Video-Embed). Kein zweites Rendering, gleiche
    // Freigabe-Pflicht — ohne Opt-in am Kanal ändert sich nichts.
    try {
      const familyOf = (c: SocialChannel): string | null => {
        if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
        return c.projectId ? `project:${c.projectId}` : null;
      };
      const channels = await this.repo.listChannels(userId, 'active');
      const twins = channels.filter(c => c.id !== ig.id && c.config.auto_reel === true
        && familyOf(c) !== null && familyOf(c) === familyOf(ig)
        && this.providers.get(c.platform)?.capabilities().video === true);
      for (const twin of twins) {
        const twinItem = await this.repo.createItem(userId, twin.id, {
          status: 'draft',
          title: leadItem.title ?? leadItem.body.slice(0, 60),
          body: caption,
          hashtags: leadItem.hashtags.slice(0, 5),
          media: [{ type: 'video', source: 'generated', pathOrUrl: rendered.videoPath }],
          source: 'studio',
          storyId: leadItem.storyId,
        });
        await this.repo.mergePerformance(userId, twinItem.id, {
          format: 'reel', autoReel: true, durationSec: rendered.durationSec, script,
        }).catch(() => { /* optional */ });
      }
    } catch { /* Zweitverwertung ist best-effort — das IG-Reel steht bereits */ }
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
      // v1022 — interne Lead-URLs (IP/localhost) NIE veröffentlichen: für
      // Follower tot + leakt das LAN (Realfall 06.07.: Bluesky-Post mit
      // „192.168.1.96:3003/news…"). Tritt auf, wenn url_template/url_field
      // des Lead-Kanals auf die interne base_url zeigt statt auf die Domain.
      if (isInternalUrl(lead.url)) return item;
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
        // v1022 — request-lokales insecure_tls (tlsFetch) statt prozessweitem ENV-Flag
        const res = await tlsFetch(`${base}${path.startsWith('/') ? path : `/${path}`}?since=${encodeURIComponent(since)}`, { headers }, channel.config.insecure_tls === true);
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
          // v1022 — request-lokales insecure_tls (tlsFetch) statt prozessweitem ENV-Flag
          const res = await tlsFetch(`${base}${statsPath.startsWith('/') ? statsPath : `/${statsPath}`}?since=${encodeURIComponent(new Date(Date.now() - 24 * 3_600_000).toISOString())}`, { headers }, channel.config.insecure_tls === true);
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
   * v1019 — Kanalwachstum: täglicher Follower-/Abonnenten-Stand je Kanal als
   * channel_metrics kind 'followers' (Level-Wert, ein Datenpunkt pro Tag).
   * Historie entsteht ab Aktivierung — die Plattform-APIs liefern keine
   * Vergangenheit. Best-effort je Kanal.
   */
  async collectAudience(userId: string): Promise<{ collected: number; milestones: Array<{ channel: string; channelId: string; milestone: number; followers: number }> }> {
    const channels = await this.repo.listChannels(userId, 'active');
    const today = new Date().toISOString().slice(0, 10);
    const MILESTONES = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
    let collected = 0;
    const milestones: Array<{ channel: string; channelId: string; milestone: number; followers: number }> = [];
    for (const channel of channels) {
      const provider = this.providers.get(channel.platform);
      if (!provider || provider.capabilities().supportsAudience !== true) continue;
      try {
        const audience = await provider.fetchAudience(channel, await this.secrets(channel));
        if (!audience || !Number.isFinite(audience.followers) || audience.followers < 0) continue;
        // v1021 — Meilenstein: letzter bekannter Stand VOR heute (Vergleichsbasis)
        const history = await this.repo.listMetrics(channel.id, { kind: 'followers', limit: 10 });
        const prev = history.filter(m => !m.itemId && m.date < today).sort((a, b) => b.date.localeCompare(a.date))[0]?.value;
        await this.repo.upsertMetric(channel.id, { date: today, kind: 'followers', value: audience.followers });
        collected++;
        if (typeof prev === 'number') {
          const crossed = MILESTONES.filter(m => prev < m && audience.followers >= m).pop();
          if (crossed) milestones.push({ channel: channel.name, channelId: channel.id, milestone: crossed, followers: audience.followers });
        }
      } catch { /* Kanal überspringen — nächster */ }
    }
    return { collected, milestones };
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

  /**
   * v1087 — Beitrag aus einem Bibliotheks-Video: Alfred textet Titel/Caption
   * je Ziel-Kanal (Persona, Zeichenlimit; optionaler stoff-Hinweis fließt
   * ein), die Entwürfe durchlaufen die normale Freigabe. Video-unfähige
   * Kanäle werden übersprungen und benannt.
   */
  private async postFromVideo(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const assetId = typeof input.asset_id === 'string' ? input.asset_id.trim() : '';
    if (!assetId) return { success: false, error: 'asset_id erforderlich (Video aus der Bibliothek).' };
    const asset = (await this.repo.listMediaAssets(userId, { limit: 500, kind: 'video' })).find(a => a.id === assetId);
    if (!asset) return { success: false, error: 'Video-Asset nicht gefunden — Bibliothek → Tab Videos.' };
    const channelNames = Array.isArray(input.channels) ? input.channels.map(String).filter(Boolean) : [];
    if (channelNames.length === 0) return { success: false, error: 'channels erforderlich (Ziel-Kanäle).' };

    const targets: SocialChannel[] = [];
    for (const name of channelNames) {
      const c = (await this.repo.getChannel(userId, name)) ?? (await this.repo.findChannelByName(userId, name));
      if (!c) return { success: false, error: `Ziel-Kanal nicht gefunden: ${name}` };
      if (!targets.some(t => t.id === c.id)) targets.push(c);
    }

    const stoff = typeof input.stoff === 'string' && input.stoff.trim() ? input.stoff.trim().slice(0, 1_000) : undefined;
    const created: string[] = [];
    const skipped: string[] = [];
    for (const target of targets) {
      if (this.providers.get(target.platform)?.capabilities().video !== true) {
        skipped.push(`${target.name} (kann kein Video)`);
        continue;
      }
      let title: string | undefined;
      let body = stoff ?? asset.motif;
      let hashtags: string[] = [];
      if (this.llm) {
        try {
          const caps = this.providers.get(target.platform)?.capabilities();
          const lang = languageName(typeof target.config.language === 'string' ? target.config.language : 'de');
          const prompt = `Schreibe einen Social-Media-Beitrag (${lang}) zu einem VIDEO für den Kanal "${target.name}" (Plattform ${target.platform})${caps?.maxTextLength ? `, MAXIMAL ${Math.min(caps.maxTextLength, 2_000)} Zeichen Text` : ''}.${target.persona ? `\nPersona/Tonalität: ${target.persona}` : ''}
VIDEO-INHALT (Beschreibung): ${asset.motif}${asset.durationSec ? ` (${Math.round(asset.durationSec)} Sekunden)` : ''}
${stoff ? `ZUSATZ-STOFF vom User (Fakten daraus verwenden): ${stoff}\n` : ''}FAKTEN nur aus Beschreibung/Stoff — nichts erfinden. Der Text begleitet das Video (kein „seht das Video"-Meta).
Antworte NUR mit VALIDEM JSON: {"titel": "…", "text": "…", "hashtags": ["…"]}`;
          const r = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 800, tier: 'fast' });
          const raw = r.content ?? '';
          const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
          const parsed = JSON.parse(json) as { titel?: unknown; text?: unknown; hashtags?: unknown };
          if (typeof parsed.text === 'string' && parsed.text.trim()) {
            body = parsed.text.trim();
            title = typeof parsed.titel === 'string' && parsed.titel.trim() ? parsed.titel.trim().slice(0, 120) : undefined;
            hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 6) : [];
          }
        } catch { /* best-effort — Motiv/Stoff als Fallback-Text */ }
      }
      const copy = await this.repo.createItem(userId, target.id, {
        title, body, hashtags,
        media: [{ type: 'video', source: asset.model === 'upload' ? 'user' : 'generated', pathOrUrl: asset.path }],
        source: 'manual',
      });
      await this.repo.mergePerformance(userId, copy.id, { format: 'video', fromAsset: asset.id }).catch(() => { /* optional */ });
      await this.repo.touchMediaAsset(userId, asset.id, target.id).catch(() => { /* optional */ });
      created.push(`[${copy.id.slice(0, 8)}] → ${target.name}`);
    }
    if (created.length === 0) {
      return { success: false, error: `Kein Beitrag angelegt${skipped.length ? ` — übersprungen: ${skipped.join(', ')}` : ''}.` };
    }
    return {
      success: true,
      data: { created: created.length },
      display: `🎬 Beitrag aus Video angelegt:\n${created.map(c => `• ${c}`).join('\n')}${skipped.length ? `\nÜbersprungen: ${skipped.join(', ')}` : ''}\nJeder Entwurf durchläuft die normale Freigabe des Ziel-Kanals.`,
    };
  }

  /**
   * v1088 — Basis-Schnitt der Video-Werkstatt: 1–8 Bibliotheks-Videos
   * trimmen (von/bis) und mit Crossfades verketten, optionaler Titel als
   * Overlay über den ersten Sekunden. Das Ergebnis landet als neues Video
   * (model 'schnitt') zurück in der Bibliothek — kostenlos (ffmpeg).
   */
  private async editVideoFromLibrary(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.videoTools?.edit) return { success: false, error: 'Video-Schnitt nicht verfügbar (ffmpeg/Video-Pipeline fehlt).' };
    const rawClips = Array.isArray(input.clips) ? input.clips : [];
    if (rawClips.length === 0 || rawClips.length > 8) return { success: false, error: 'clips erforderlich: 1–8 Einträge mit asset_id (+ optional von/bis in Sekunden).' };
    const format = input.format === '16:9' ? '16:9' as const : '9:16' as const;
    const titel = typeof input.titel === 'string' && input.titel.trim() ? input.titel.trim().slice(0, 90) : undefined;
    const [w, h] = format === '9:16' ? [1080, 1920] : [1920, 1080];

    // Overlays (Titel + Clip-Texte) auf transparenter Leinwand backen (gleicher
    // Boxen-Look wie die Reel-Hook-Karte) — best-effort: ohne sharp ohne Texte.
    const tmpFiles: string[] = [];
    const bakeOverlay = async (text: string): Promise<string | undefined> => {
      try {
        const sharp = await loadSharp();
        if (!sharp) return undefined;
        const blank = await (sharp as unknown as (o: object) => { png(): { toBuffer(): Promise<Buffer> } })({
          create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).png().toBuffer();
        const withText = await applyImageOverlays(blank, { title: text, titleMaxWidthRatio: 0.75 });
        const { writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const file = join(tmpdir(), `alfred-edit-ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
        await writeFile(file, withText);
        tmpFiles.push(file);
        return file;
      } catch { return undefined; }
    };

    const library = await this.repo.listMediaAssets(userId, { limit: 500, kind: 'video' });
    const clips: Array<{ path: string; startSec?: number; endSec?: number; speed?: number; look?: string; overlayImage?: string }> = [];
    const used: Array<{ id: string; motif: string }> = [];
    for (const raw of rawClips) {
      const c = raw as { asset_id?: unknown; von?: unknown; bis?: unknown; tempo?: unknown; look?: unknown; text?: unknown };
      const asset = library.find(a => a.id === String(c.asset_id ?? ''));
      if (!asset) return { success: false, error: `Video-Asset nicht gefunden: ${String(c.asset_id ?? '?')}` };
      // v1092 — Effekte je Clip: Tempo (Zeitlupe/Zeitraffer), Farb-Look, Text-Einblendung
      clips.push({
        path: asset.path,
        ...(typeof c.von === 'number' && c.von >= 0 ? { startSec: c.von } : {}),
        ...(typeof c.bis === 'number' && c.bis > 0 ? { endSec: c.bis } : {}),
        ...(typeof c.tempo === 'number' && c.tempo >= 0.25 && c.tempo <= 4 && c.tempo !== 1 ? { speed: c.tempo } : {}),
        ...(typeof c.look === 'string' && c.look.trim() ? { look: c.look.trim() } : {}),
      });
      if (typeof c.text === 'string' && c.text.trim()) {
        const ov = await bakeOverlay(c.text.trim().slice(0, 90));
        if (ov) clips[clips.length - 1].overlayImage = ov;
      }
      used.push({ id: asset.id, motif: asset.motif });
    }

    const overlayImage = titel ? await bakeOverlay(titel) : undefined;
    try {
      const result = await this.videoTools.edit({ clips, format, ...(overlayImage ? { overlayImage } : {}), outBaseName: `edit-${Date.now().toString(36)}` });
      const motif = titel ?? `Schnitt aus ${used.length} Clip${used.length > 1 ? 's' : ''}: ${used.map(u => u.motif.slice(0, 60)).join(' + ')}`.slice(0, 300);
      const asset = await this.repo.createMediaAsset(userId, {
        path: result.videoPath, motif, kind: 'video', model: 'schnitt', format, durationSec: result.durationSec,
      });
      return {
        success: true,
        data: { asset_id: asset.id, videoPath: result.videoPath, durationSec: result.durationSec },
        display: `✂️ Schnitt fertig: ${Math.round(result.durationSec)}s (${format}${titel ? `, Titel „${titel}"` : ''}) — liegt als neues Video in der Bibliothek [${asset.id.slice(0, 8)}]. Von dort per 📤 „Beitrag aus Video" ausspielen.`,
      };
    } finally {
      const { unlink } = await import('node:fs/promises');
      for (const f of tmpFiles) await unlink(f).catch(() => { /* tmp best-effort */ });
    }
  }

  /**
   * v1094 — Auto-Highlights: die besten Momente eines Bibliotheks-Videos
   * finden (Lautheits-Spitzen = Jubel/Kommentator + Szenenwechsel als
   * saubere Einstiege) und als einzelne Clips schneiden — jeder landet als
   * eigenes Video (model 'highlight') in der Bibliothek, von dort per
   * Schnitt kombinierbar oder per Beitrag direkt ausspielbar. Kostenlos.
   */
  private async findHighlights(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.videoTools?.analyze || !this.videoTools.edit) return { success: false, error: 'Highlight-Analyse nicht verfügbar (Video-Pipeline fehlt).' };
    const assetId = typeof input.asset_id === 'string' ? input.asset_id.trim() : '';
    if (!assetId) return { success: false, error: 'asset_id erforderlich (Video aus der Bibliothek).' };
    const asset = (await this.repo.listMediaAssets(userId, { limit: 500, kind: 'video' })).find(a => a.id === assetId);
    if (!asset) return { success: false, error: 'Video-Asset nicht gefunden — Bibliothek → Tab Videos.' };
    const count = typeof input.anzahl === 'number' && input.anzahl >= 1 && input.anzahl <= 8 ? Math.round(input.anzahl) : 3;
    const format = input.format === '16:9' ? '16:9' as const : '9:16' as const;

    const windows = await this.videoTools.analyze(asset.path, { count });
    if (windows.length === 0) return { success: false, error: 'Keine Highlight-Momente gefunden (zu gleichförmiges Material?).' };
    const created: string[] = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      try {
        const result = await this.videoTools.edit({
          clips: [{ path: asset.path, startSec: w.start, endSec: w.end }],
          format, outBaseName: `highlight-${asset.id.slice(0, 6)}-${i + 1}`,
        });
        const clip = await this.repo.createMediaAsset(userId, {
          path: result.videoPath, kind: 'video', model: 'highlight', format, durationSec: result.durationSec,
          motif: `Highlight ${i + 1}/${windows.length} (${Math.round(w.start)}–${Math.round(w.end)}s) aus: ${asset.motif.slice(0, 150)}`,
        });
        created.push(`• [${clip.id.slice(0, 8)}] ${Math.round(w.start)}–${Math.round(w.end)}s (${Math.round(result.durationSec)}s)`);
      } catch (err) {
        created.push(`• Fenster ${Math.round(w.start)}–${Math.round(w.end)}s fehlgeschlagen: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    await this.repo.touchMediaAsset(userId, asset.id).catch(() => { /* optional */ });
    return {
      success: true,
      data: { count: windows.length },
      display: `⭐ ${windows.length} Highlight${windows.length > 1 ? 's' : ''} geschnitten (${format}):\n${created.join('\n')}\nAlle liegen in der Bibliothek — per ✂️ kombinieren oder 📤 ausspielen.`,
    };
  }

  /**
   * v1089 — „Bild beleben": aus einem Bibliotheks-Bild einen bewegten
   * KI-Clip machen (Image-to-Video wie bei den Reel-KI-Clips). Provider,
   * Secrets und das gemeinsame Monatsbudget (gen_ai_clip /
   * ai_clip_budget_per_month) kommen vom Familien-Instagram-Kanal — EIN
   * Budget-Topf für alle bezahlten Clips. Die Bewegungs-Regie kommt vom
   * User oder Alfred schlägt sie aus der Bildbeschreibung vor.
   */
  private async animateImage(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.videoTools?.generateClip) return { success: false, error: 'KI-Clips nicht verfügbar (Video-Pipeline fehlt).' };
    const assetId = typeof input.asset_id === 'string' ? input.asset_id.trim() : '';
    if (!assetId) return { success: false, error: 'asset_id erforderlich (Bild aus der Bibliothek).' };
    const asset = (await this.repo.listMediaAssets(userId, { limit: 500, kind: 'image' })).find(a => a.id === assetId);
    if (!asset) return { success: false, error: 'Bild-Asset nicht gefunden — Bibliothek → Tab Bilder.' };
    if (asset.path.startsWith('http')) return { success: false, error: 'Nur lokale Bibliotheks-Bilder können belebt werden.' };

    // Clip-Kanal: liefert Provider, Secrets und den Budget-Topf
    const channels = await this.repo.listChannels(userId, 'active');
    const clipChannel = channels.find(c => c.platform === 'instagram' && typeof c.config.reel_ai_provider === 'string')
      ?? channels.find(c => c.platform === 'instagram')
      ?? channels.find(c => c.projectId);
    if (!clipChannel) return { success: false, error: 'Kein Kanal mit KI-Clip-Konfiguration gefunden (Instagram-Kanal mit reel_ai_provider).' };
    const provRaw = clipChannel.config.reel_ai_provider;
    const provider = provRaw === 'runway' || provRaw === 'veo' ? provRaw : 'sora';
    const model = typeof clipChannel.config.reel_ai_model === 'string' && clipChannel.config.reel_ai_model.trim() ? clipChannel.config.reel_ai_model.trim() : undefined;

    // Gemeinsames Monatsbudget mit den Reel-KI-Clips (Budget-Ehrlichkeit v1055)
    const clipBudget = typeof clipChannel.config.ai_clip_budget_per_month === 'number' ? clipChannel.config.ai_clip_budget_per_month : 8;
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const clipsUsed = (await this.repo.listMetrics(clipChannel.id, { kind: 'gen_ai_clip', sinceDate: monthStart }))
      .reduce((sum, m) => sum + m.value, 0);
    if (clipsUsed >= clipBudget) {
      return { success: false, error: `KI-Clip-Monatsbudget erreicht (${clipsUsed}/${clipBudget} auf ${clipChannel.name}) — ai_clip_budget_per_month anpassen.` };
    }

    // Bewegungs-Regie: User-Vorgabe oder Alfred-Vorschlag aus der Bildbeschreibung
    let motion = typeof input.regie === 'string' && input.regie.trim() ? input.regie.trim().slice(0, 400) : '';
    if (!motion && this.llm) {
      try {
        const r = await this.llm.complete({
          messages: [{ role: 'user', content: `Beschreibe in EINEM englischen Satz eine subtile, filmische Kamera-/Szenen-Bewegung, um dieses Standbild zum Leben zu erwecken (z.B. "slow cinematic camera push-in, flags waving, natural light shifting"). KEINE Texteinblendungen, KEINE realen/erkennbaren Personen, KEINE Logos.\nBILD: ${asset.motif}\nAntworte NUR mit dem Satz.` }],
          maxTokens: 120, tier: 'fast',
        });
        motion = (r.content ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 400);
      } catch { /* Fallback unten */ }
    }
    if (!motion) motion = 'slow cinematic camera push-in, subtle natural motion, no text overlays, no recognizable people';

    const format = input.format === '16:9' ? '16:9' as const : '9:16' as const;
    const secrets = await this.secrets(clipChannel);
    const clip = await this.videoTools.generateClip({ imagePath: asset.path, prompt: motion, provider, ...(model ? { model } : {}), secrets, format });
    // Budget sofort zählen (jeder gelieferte Clip hat gekostet)
    const today = new Date().toISOString().slice(0, 10);
    const dayUsed = (await this.repo.listMetrics(clipChannel.id, { kind: 'gen_ai_clip', sinceDate: today }))
      .find(m => m.date === today && !m.itemId)?.value ?? 0;
    await this.repo.upsertMetric(clipChannel.id, { date: today, kind: 'gen_ai_clip', value: dayUsed + 1 });

    const newAsset = await this.repo.createMediaAsset(userId, {
      path: clip.clipPath, motif: `Belebt: ${asset.motif}`.slice(0, 300), kind: 'video', model: provider, format, durationSec: clip.durationSec,
    });
    await this.repo.touchMediaAsset(userId, asset.id).catch(() => { /* optional */ });
    return {
      success: true,
      data: { asset_id: newAsset.id, durationSec: clip.durationSec, motion },
      display: `✨🎬 Bild belebt (${provider}, ${Math.round(clip.durationSec)}s, Budget ${clipsUsed + 1}/${clipBudget}): „${motion.slice(0, 120)}" — liegt als Video in der Bibliothek [${newAsset.id.slice(0, 8)}]. Von dort per ✂️ Schnitt oder 📤 Beitrag weiterverwenden.`,
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
  /**
   * v1024 — Ad-hoc-Story auf User-Zuruf: „Mach eine Story zu X für alle
   * Kanäle" — der Stoff wird als echte Redaktions-Story über den
   * News-Desk-Familienpfad ausgespielt (Lead +30 min, Follower +90 min,
   * Freigaben nach Kanal-Modus). Bewusst ohne Score-Schwelle/Nachtruhe.
   */
  private async planStory(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.storyPlannerFn) return { success: false, error: 'Story-Planung nicht verfügbar (Content-Studio nicht verdrahtet).' };
    const stoff = typeof input.stoff === 'string' && input.stoff.trim().length >= 20 ? input.stoff.trim() : undefined;
    if (!stoff) return { success: false, error: 'stoff fehlt — beschreibe die Story in 1-6 Sätzen MIT den Fakten (min. 20 Zeichen); nur daraus wird getextet.' };
    const titel = typeof input.titel === 'string' && input.titel.trim() ? input.titel.trim() : undefined;
    const family = typeof input.family === 'string' && input.family.trim() ? input.family.trim() : undefined;
    try {
      const r = await this.storyPlannerFn(titel, stoff, family);
      if (r.created === 0) return { success: false, error: 'Kein Beitrag entstanden (Render je Kanal fehlgeschlagen) — Stoff präzisieren und erneut versuchen.' };
      return {
        success: true, data: r,
        display: `⚡ Story „${r.storyTitle}" angestoßen: ${r.created} Beiträge (${r.channels.join(', ')}) — Lead in ~30 min, Follower in ~90 min; Freigaben kommen je nach Kanal-Modus.${Array.isArray(r.warnings) && r.warnings.length > 0 ? `\n${r.warnings.join('\n')}` : ''}`,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

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
    const famOf = (c: SocialChannel): string | null => {
      if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
      return c.projectId ? `project:${c.projectId}` : null;
    };
    const familyIg = (await this.repo.listChannels(userId, 'active')).find(c =>
      c.platform === 'instagram' && famOf(c) !== null && famOf(c) === famOf(channel));
    // v1059 — auch manuell gerenderte Videos bekommen das Musik-Bett
    // v1091 — Stimmen-Kaskade: eigener Kanal → Familien-Instagram (eine
    // Marke, eine Stimme; Realfall 11.07.: YouTube-Videos sprachen mit der
    // Standard-Stimme, weil nur der IG-Kanal reel_voice_id hatte) → Standard.
    let manualVoice = typeof channel.config.reel_voice_id === 'string' && channel.config.reel_voice_id.trim() ? channel.config.reel_voice_id.trim() : undefined;
    if (!manualVoice && typeof familyIg?.config.reel_voice_id === 'string' && familyIg.config.reel_voice_id.trim()) {
      manualVoice = familyIg.config.reel_voice_id.trim();
    }
    // v1095 — KI-Clips auch in der Eigenproduktion/render_video: Anzahl kommt
    // BEWUSST nur vom eigenen Kanal (Kosten sind explizit, kein stilles
    // Erben); Provider/Modell fallen auf Familien-Instagram zurück, Budget-
    // Topf ist der GEMEINSAME gen_ai_clip-Zähler (auf dem Familien-IG, wie
    // bei Reels und „Beleben" — eine Zahl deckelt alles Bezahlte).
    const clips: Array<{ index: number; path: string; durationSec: number }> = [];
    const clipNotes: string[] = [];
    const clipsWanted = typeof channel.config.reel_ai_clips === 'number' ? Math.min(Math.max(0, channel.config.reel_ai_clips), 2) : 0;
    if (clipsWanted > 0 && this.videoTools.generateClip && this.llm) {
      const provRaw = channel.config.reel_ai_provider ?? familyIg?.config.reel_ai_provider;
      const provider = provRaw === 'runway' || provRaw === 'veo' ? provRaw : 'sora';
      const modelRaw = channel.config.reel_ai_model ?? familyIg?.config.reel_ai_model;
      const model = typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : undefined;
      const budgetChannel = familyIg ?? channel;
      const clipBudget = typeof budgetChannel.config.ai_clip_budget_per_month === 'number' ? budgetChannel.config.ai_clip_budget_per_month : 8;
      const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
      let clipsUsed = (await this.repo.listMetrics(budgetChannel.id, { kind: 'gen_ai_clip', sinceDate: monthStart }))
        .reduce((sum, m) => sum + m.value, 0);
      const images = item.media.filter(m => m.type === 'image' && !m.pathOrUrl.startsWith('http')).map(m => m.pathOrUrl);
      let motion = 'slow cinematic camera push-in, subtle natural motion, no text overlays, no recognizable people';
      try {
        const r = await this.llm.complete({
          messages: [{ role: 'user', content: `Beschreibe in EINEM englischen Satz eine subtile, filmische Kamera-/Szenen-Bewegung passend zu diesem Beitrag (z.B. "slow cinematic camera push-in, flags waving"). KEINE Texteinblendungen, KEINE realen/erkennbaren Personen, KEINE Logos.\nBEITRAG: ${item.title ?? ''} — ${item.body.slice(0, 300)}\nAntworte NUR mit dem Satz.` }],
          maxTokens: 120, tier: 'fast',
        });
        const m = (r.content ?? '').trim().replace(/^["']|["']$/g, '');
        if (m) motion = m.slice(0, 400);
      } catch { /* Default-Motion */ }
      const secrets = await this.secrets(budgetChannel);
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < Math.min(clipsWanted, images.length); i++) {
        if (clipsUsed >= clipBudget) {
          clipNotes.push(`KI-Clip-Monatsbudget erreicht (${clipsUsed}/${clipBudget}) — Standbild-Slides.`);
          break;
        }
        try {
          const clip = await this.videoTools.generateClip({ imagePath: images[i], prompt: motion, provider, ...(model ? { model } : {}), secrets, format });
          clips.push({ index: i, path: clip.clipPath, durationSec: clip.durationSec });
          clipsUsed += 1;
          const dayUsed = (await this.repo.listMetrics(budgetChannel.id, { kind: 'gen_ai_clip', sinceDate: today }))
            .find(m => m.date === today && !m.itemId)?.value ?? 0;
          await this.repo.upsertMetric(budgetChannel.id, { date: today, kind: 'gen_ai_clip', value: dayUsed + 1 });
        } catch (err) {
          clipNotes.push(`KI-Clip ${i + 1} (${provider}) fehlgeschlagen: ${(err as Error).message.slice(0, 120)} — Standbild-Slide.`);
        }
      }
    }
    const result = await this.videoTools.render(item, channel, format, {
      music: this.reelMusicOpts(channel),
      ...(manualVoice ? { voiceId: manualVoice } : {}),
      ...(clips.length > 0 ? { clips } : {}),
    });
    const media: ContentMedia[] = [...item.media, { type: 'video', source: 'generated', pathOrUrl: result.videoPath }];
    await this.repo.updateItemContent(userId, item.id, { media });
    // v1086 — auch manuell gerenderte Videos landen in der Video-Bibliothek
    const vidFamily = typeof channel.config.family === 'string' && channel.config.family.trim()
      ? `family:${channel.config.family.trim().toLowerCase()}` : (channel.projectId ? `project:${channel.projectId}` : undefined);
    await this.repo.createMediaAsset(userId, {
      channelId: channel.id, ...(vidFamily ? { family: vidFamily } : {}),
      path: result.videoPath, motif: (item.title ?? item.body).slice(0, 200),
      kind: 'video', model: 'slideshow', format, durationSec: result.durationSec,
    }).catch(() => { /* Bibliothek best-effort */ });
    const today = new Date().toISOString().slice(0, 10);
    const todayUsed = (await this.repo.listMetrics(channel.id, { kind: 'gen_video', sinceDate: today }))
      .find(m => m.date === today && !m.itemId)?.value ?? 0;
    await this.repo.upsertMetric(channel.id, { date: today, kind: 'gen_video', value: todayUsed + 1 });
    return {
      success: true,
      data: { videoPath: result.videoPath, durationSec: result.durationSec, ...(clips.length > 0 ? { aiClips: clips.length } : {}) },
      display: `🎬 Video gerendert (${format}, ${Math.round(result.durationSec)}s${clips.length > 0 ? `, ${clips.length} KI-Clip${clips.length > 1 ? 's' : ''}` : ''}) und an [${item.id.slice(0, 8)}] angehängt:\n${result.videoPath}${clipNotes.length > 0 ? `\n${clipNotes.join('\n')}` : ''}\nVeröffentlichen mit publish_now.`,
    };
  }
}
