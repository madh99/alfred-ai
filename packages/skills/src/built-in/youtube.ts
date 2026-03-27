import type { SkillMetadata, SkillContext, SkillResult, YouTubeConfig } from '@alfred/types';
import { Skill } from '../skill.js';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_TRANSCRIPT_CHARS = 15_000;

/** Parse Google API error body for detailed reason */
async function ytErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    const reason = body.error?.errors?.[0]?.reason;
    const msg = body.error?.message;
    if (reason) return `YouTube API: ${res.status} (${reason}: ${msg})`;
    if (msg) return `YouTube API: ${res.status} (${msg})`;
  } catch { /* ignore parse error */ }
  return `YouTube API: ${res.status} ${res.statusText}`;
}

export class YouTubeSkill extends Skill {
  /** Cache: channelName → channelId (avoids repeated Search API calls, saves 100 quota units per hit) */
  private readonly channelIdCache = new Map<string, string>();

  readonly metadata: SkillMetadata = {
    name: 'youtube',
    category: 'information',
    description: `YouTube video search, info, transcripts, and summaries.
Actions:
- search: Search YouTube videos. Params: query, maxResults (default 5)
- info: Get video details. Params: videoId or url
- transcript: Get video transcript with timestamps. Params: videoId or url, lang (optional, default "de")
- channel: Get latest videos from a channel. Params: channelId or channelName, maxResults (default 5)
Watch-compatible: channel action returns "newCount" for new video alerts.`,
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'info', 'transcript', 'channel'],
          description: 'YouTube action',
        },
        query: { type: 'string', description: 'Search query (for search)' },
        videoId: { type: 'string', description: 'YouTube video ID or URL (for info/transcript)' },
        url: { type: 'string', description: 'YouTube video URL (alternative to videoId)' },
        channelId: { type: 'string', description: 'Channel ID (for channel)' },
        channelName: { type: 'string', description: 'Channel name to search for (for channel)' },
        maxResults: { type: 'number', description: 'Max results (default 5)' },
        lang: { type: 'string', description: 'Transcript language (default "de", fallback "en")' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly config: YouTubeConfig) {
    super();
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    // Auto-detect: if info/transcript is called with a channel URL, redirect to channel action
    if ((action === 'info' || action === 'transcript') && !this.extractVideoId(input)) {
      const urlStr = (input.url as string) ?? (input.videoId as string) ?? '';
      if (urlStr.includes('@') || urlStr.includes('/channel/') || urlStr.includes('/c/') || urlStr.includes('/user/')) {
        return this.channelVideos({ ...input, action: 'channel', channelName: urlStr });
      }
    }

    switch (action) {
      case 'search': return this.search(input);
      case 'info': return this.videoInfo(input);
      case 'transcript': return this.transcript(input);
      case 'channel': return this.channelVideos(input);
      default:
        return { success: false, error: `Unknown action "${action}". Use search, info, transcript, or channel.` };
    }
  }

  private extractVideoId(input: Record<string, unknown>): string | null {
    const videoId = input.videoId as string | undefined;
    const url = input.url as string | undefined;
    if (videoId && !videoId.includes('/')) return videoId;
    const urlStr = videoId ?? url;
    if (!urlStr) return null;
    // Extract from various YouTube URL formats
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const match = p.exec(urlStr);
      if (match) return match[1];
    }
    return null;
  }

  // ── Search ──────────────────────────────────────────────────

  private async search(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string | undefined;
    if (!query) return { success: false, error: 'Missing "query"' };
    const maxResults = Math.min((input.maxResults as number) ?? 5, 20);

    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: String(maxResults),
      key: this.config.apiKey,
    });

    const res = await fetch(`${YT_API_BASE}/search?${params}`);
    if (!res.ok) return { success: false, error: await ytErrorDetail(res) };
    const data = await res.json() as { items?: Array<{ id: { videoId: string }; snippet: Record<string, unknown> }> };

    const videos = (data.items ?? []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      publishedAt: (item.snippet.publishedAt as string)?.slice(0, 10),
      url: `https://youtube.com/watch?v=${item.id.videoId}`,
      thumbnail: (item.snippet.thumbnails as Record<string, { url: string }>)?.medium?.url,
    }));

    const display = videos.map((v, i) =>
      `${i + 1}. **${v.title}**\n   ${v.channel} • ${v.publishedAt}\n   ${v.url}`
    ).join('\n\n');

    return {
      success: true,
      data: { count: videos.length, videos },
      display: `**YouTube Suche: "${query}"** (${videos.length} Ergebnisse)\n\n${display}`,
    };
  }

  // ── Video Info ──────────────────────────────────────────────

  private async videoInfo(input: Record<string, unknown>): Promise<SkillResult> {
    const videoId = this.extractVideoId(input);
    if (!videoId) return { success: false, error: 'Missing "videoId" or "url"' };

    const params = new URLSearchParams({
      part: 'snippet,statistics,contentDetails',
      id: videoId,
      key: this.config.apiKey,
    });

    const res = await fetch(`${YT_API_BASE}/videos?${params}`);
    if (!res.ok) return { success: false, error: await ytErrorDetail(res) };
    const data = await res.json() as { items?: Array<{ snippet: Record<string, unknown>; statistics: Record<string, string>; contentDetails: Record<string, string> }> };

    const item = data.items?.[0];
    if (!item) return { success: false, error: `Video ${videoId} not found` };

    const duration = this.parseDuration(item.contentDetails.duration);
    const info = {
      videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      publishedAt: (item.snippet.publishedAt as string)?.slice(0, 10),
      description: (item.snippet.description as string)?.slice(0, 500),
      duration,
      views: parseInt(item.statistics.viewCount ?? '0', 10),
      likes: parseInt(item.statistics.likeCount ?? '0', 10),
      comments: parseInt(item.statistics.commentCount ?? '0', 10),
      url: `https://youtube.com/watch?v=${videoId}`,
    };

    return {
      success: true,
      data: info,
      display: `**${info.title}**\n${info.channel} • ${info.publishedAt} • ${info.duration}\n` +
        `${info.views.toLocaleString('de-DE')} Views • ${info.likes.toLocaleString('de-DE')} Likes\n` +
        `${info.url}\n\n${info.description}`,
    };
  }

  // ── Transcript ──────────────────────────────────────────────

  private async transcript(input: Record<string, unknown>): Promise<SkillResult> {
    const videoId = this.extractVideoId(input);
    if (!videoId) return { success: false, error: 'Missing "videoId" or "url"' };
    const lang = (input.lang as string) ?? 'de';

    // Try self-hosted transcript extraction first
    try {
      const transcript = await this.fetchTranscriptSelfHosted(videoId, lang);
      if (transcript) {
        const text = transcript.map(t => t.text).join(' ');
        const truncated = text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) + '...' : text;
        return {
          success: true,
          data: { videoId, lang, charCount: text.length, segments: transcript.length, transcript: truncated },
          display: `**Transkript** (${videoId}, ${transcript.length} Segmente, ${text.length} Zeichen)\n\n${truncated}`,
        };
      }
    } catch { /* fallback below */ }

    // Fallback: Supadata API (if configured)
    if (this.config.supadata?.enabled && this.config.supadata.apiKey) {
      try {
        const transcript = await this.fetchTranscriptSupadata(videoId, lang);
        if (transcript) {
          const truncated = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '...' : transcript;
          return {
            success: true,
            data: { videoId, lang, charCount: transcript.length, source: 'supadata', transcript: truncated },
            display: `**Transkript** (${videoId}, via Supadata)\n\n${truncated}`,
          };
        }
      } catch { /* no transcript available */ }
    }

    return { success: false, error: `No transcript available for video ${videoId} (lang: ${lang})` };
  }

  private async fetchTranscriptSelfHosted(videoId: string, lang: string): Promise<Array<{ text: string; offset: number; duration: number }> | null> {
    try {
      const mod = await (Function('return import("youtube-transcript/dist/youtube-transcript.esm.js")')() as Promise<{ fetchTranscript: (id: string, opts?: { lang?: string }) => Promise<Array<{ text: string; offset: number; duration: number }>> }>);
      const segments = await mod.fetchTranscript(videoId, { lang });
      if (segments && segments.length > 0) {
        return segments.map((s: { text: string; offset: number; duration: number }) => ({
          text: s.text,
          offset: s.offset,
          duration: s.duration,
        }));
      }
    } catch {
      // Try English fallback
      if (lang !== 'en') {
        try {
          const mod = await (Function('return import("youtube-transcript/dist/youtube-transcript.esm.js")')() as Promise<{ fetchTranscript: (id: string, opts?: { lang?: string }) => Promise<Array<{ text: string; offset: number; duration: number }>> }>);
          const segments = await mod.fetchTranscript(videoId, { lang: 'en' });
          if (segments && segments.length > 0) {
            return segments.map((s: { text: string; offset: number; duration: number }) => ({
              text: s.text,
              offset: s.offset,
              duration: s.duration,
            }));
          }
        } catch { /* no fallback */ }
      }
    }
    return null;
  }

  private async fetchTranscriptSupadata(videoId: string, lang: string): Promise<string | null> {
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=${lang}`, {
      headers: { 'x-api-key': this.config.supadata!.apiKey! },
    });
    if (!res.ok) return null;
    const data = await res.json() as { transcript?: string; content?: Array<{ text: string }> };
    if (data.transcript) return data.transcript;
    if (data.content) return data.content.map(c => c.text).join(' ');
    return null;
  }

  // ── Channel ─────────────────────────────────────────────────

  private async channelVideos(input: Record<string, unknown>): Promise<SkillResult> {
    let channelId = input.channelId as string | undefined;
    const channelName = input.channelName as string | undefined;
    const maxResults = Math.min((input.maxResults as number) ?? 5, 20);

    // Extract handle or channel ID from URL
    const urlInput = channelName ?? channelId ?? '';
    const handleMatch = /@([\w.-]+)/.exec(urlInput);
    const channelIdMatch = /(?:channel\/)(UC[\w-]{22})/.exec(urlInput);

    if (channelIdMatch) {
      channelId = channelIdMatch[1];
    }

    // Check cache before any API calls (saves quota, prevents inconsistent Search results)
    const cacheKey = (channelName ?? '').toLowerCase().trim();
    if (!channelId && cacheKey && this.channelIdCache.has(cacheKey)) {
      channelId = this.channelIdCache.get(cacheKey);
    }

    // Resolve handle (@...) via Channels API (1 unit)
    if (!channelId && handleMatch) {
      const handleParams = new URLSearchParams({
        part: 'snippet',
        forHandle: handleMatch[1],
        key: this.config.apiKey,
      });
      const handleRes = await fetch(`${YT_API_BASE}/channels?${handleParams}`);
      if (handleRes.ok) {
        const handleData = await handleRes.json() as { items?: Array<{ id: string; snippet: Record<string, unknown> }> };
        channelId = handleData.items?.[0]?.id;
      }
    }

    // Resolve channel name via Search API (100 units — last resort)
    if (!channelId && channelName) {
      const cleanName = channelName.replace(/^@/, '').replace(/https?:\/\/.*youtube\.com\//, '');
      const searchParams = new URLSearchParams({
        part: 'snippet',
        q: cleanName,
        type: 'channel',
        maxResults: '1',
        key: this.config.apiKey,
      });
      const searchRes = await fetch(`${YT_API_BASE}/search?${searchParams}`);
      if (searchRes.ok) {
        const searchData = await searchRes.json() as { items?: Array<{ id: { channelId: string }; snippet: Record<string, unknown> }> };
        channelId = searchData.items?.[0]?.id?.channelId;
      }
    }

    if (!channelId) return { success: false, error: `Could not resolve channel "${channelName ?? channelId}". Try a channel ID (starts with UC) or handle (@name).` };

    // Cache resolved channelId for future calls (Watch polls every 30-60 min)
    if (cacheKey) this.channelIdCache.set(cacheKey, channelId);

    const params = new URLSearchParams({
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: String(maxResults),
      key: this.config.apiKey,
    });

    const res = await fetch(`${YT_API_BASE}/search?${params}`);
    if (!res.ok) return { success: false, error: await ytErrorDetail(res) };
    const data = await res.json() as { items?: Array<{ id: { videoId: string }; snippet: Record<string, unknown> }> };

    const videos = (data.items ?? []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      publishedAt: (item.snippet.publishedAt as string)?.slice(0, 10),
      url: `https://youtube.com/watch?v=${item.id.videoId}`,
    }));

    const channelTitle = data.items?.[0]?.snippet?.channelTitle ?? channelName ?? channelId;

    const display = videos.map((v, i) =>
      `${i + 1}. **${v.title}** (${v.publishedAt})\n   ${v.url}`
    ).join('\n\n');

    const channelHint = channelName && channelId !== channelName
      ? `\n\n💡 Channel-ID: \`${channelId}\` — für stabilere Watches \`channelId\` statt \`channelName\` verwenden.`
      : '';

    return {
      success: true,
      data: { channelId, channelName: channelTitle, count: videos.length, newCount: videos.length, videos },
      display: `**${channelTitle}** — letzte ${videos.length} Videos\n\n${display}${channelHint}`,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────

  private parseDuration(iso: string): string {
    const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso ?? '');
    if (!match) return iso ?? '';
    const h = match[1] ? `${match[1]}:` : '';
    const m = (match[2] ?? '0').padStart(h ? 2 : 1, '0');
    const s = (match[3] ?? '0').padStart(2, '0');
    return `${h}${m}:${s}`;
  }
}
