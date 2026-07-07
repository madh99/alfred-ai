/**
 * v1048 — Wiederverwendbare YouTube-Bausteine, 1:1 aus dem YouTube-Skill
 * extrahiert (Kanal-Auflösung, Kanal-Videos, Transcript). Der Skill delegiert
 * hierher und verhält sich UNVERÄNDERT; zusätzlich nutzt der Topic-Collector
 * (Quellart `youtube`, @alfred/core) dieselben Funktionen — ein Codepfad für
 * Chat-Skill, Watch und Interessen-Radar.
 */

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Google-API-Fehlerkörper in eine lesbare Meldung übersetzen. */
export async function ytErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    const reason = body.error?.errors?.[0]?.reason;
    const msg = body.error?.message;
    if (reason) return `YouTube API: ${res.status} (${reason}: ${msg})`;
    if (msg) return `YouTube API: ${res.status} (${msg})`;
  } catch { /* ignore parse error */ }
  return `YouTube API: ${res.status} ${res.statusText}`;
}

/** Video-ID aus gängigen YouTube-URL-Formaten oder nackter 11-Zeichen-ID. */
export function extractYoutubeVideoId(videoIdOrUrl: string | null | undefined): string | null {
  if (!videoIdOrUrl) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const match = p.exec(videoIdOrUrl);
    if (match) return match[1];
  }
  return null;
}

/**
 * Kanal-Auflösung (Name/@Handle/Kanal-URL → Channel-ID) — identische Semantik
 * und Quota-Schonung wie im Skill: erst URL-Parsing, dann Cache, dann
 * forHandle (1 Unit), zuletzt Search (100 Units). Aufgelöste Namen landen im
 * übergebenen Cache.
 */
export async function resolveYoutubeChannel(
  apiKey: string,
  opts: { channelId?: string; channelName?: string },
  cache?: Map<string, string>,
): Promise<string | undefined> {
  let channelId = opts.channelId;
  const channelName = opts.channelName;

  const urlInput = channelName ?? channelId ?? '';
  const handleMatch = /@([\w.-]+)/.exec(urlInput);
  const channelIdMatch = /(?:channel\/)(UC[\w-]{22})/.exec(urlInput);
  if (channelIdMatch) channelId = channelIdMatch[1];

  const cacheKey = (channelName ?? '').toLowerCase().trim();
  if (!channelId && cacheKey && cache?.has(cacheKey)) channelId = cache.get(cacheKey);

  if (!channelId && handleMatch) {
    const handleParams = new URLSearchParams({ part: 'snippet', forHandle: handleMatch[1], key: apiKey });
    const handleRes = await fetch(`${YT_API_BASE}/channels?${handleParams}`);
    if (handleRes.ok) {
      const handleData = await handleRes.json() as { items?: Array<{ id: string; snippet: Record<string, unknown> }> };
      channelId = handleData.items?.[0]?.id;
    }
  }

  if (!channelId && channelName) {
    const cleanName = channelName.replace(/^@/, '').replace(/https?:\/\/.*youtube\.com\//, '');
    const searchParams = new URLSearchParams({ part: 'snippet', q: cleanName, type: 'channel', maxResults: '1', key: apiKey });
    const searchRes = await fetch(`${YT_API_BASE}/search?${searchParams}`);
    if (searchRes.ok) {
      const searchData = await searchRes.json() as { items?: Array<{ id: { channelId: string }; snippet: Record<string, unknown> }> };
      channelId = searchData.items?.[0]?.id?.channelId;
    }
  }

  if (channelId && cacheKey) cache?.set(cacheKey, channelId);
  return channelId;
}

export interface YoutubeChannelVideo {
  videoId: string;
  title: string;
  publishedAt?: string;
  url: string;
  /** Snippet-Beschreibung (gekürzt von der API) — für den Collector oft schon brauchbarer Stoff. */
  description?: string;
}

/**
 * Neueste Videos eines Kanals. v1049 — primär über die UPLOADS-PLAYLIST
 * (`UU` + Kanal-ID-Suffix, playlistItems = 1 Quota-Unit): `search?channelId=`
 * kostete 100 Units und scheiterte bei manchen Kanälen mit 403
 * accountDelegationForbidden (Realfall „ServusTV On Sport", live 08.07.).
 * Das search-Verfahren bleibt als Fallback; Ergebnis-Form ist identisch.
 */
export async function fetchYoutubeChannelVideos(
  apiKey: string, channelId: string, maxResults: number,
): Promise<{ channelTitle?: string; videos: YoutubeChannelVideo[] } | { error: string }> {
  if (/^UC[\w-]{22}$/.test(channelId)) {
    const uploads = `UU${channelId.slice(2)}`;
    const plParams = new URLSearchParams({ part: 'snippet', playlistId: uploads, maxResults: String(maxResults), key: apiKey });
    const plRes = await fetch(`${YT_API_BASE}/playlistItems?${plParams}`);
    if (plRes.ok) {
      const data = await plRes.json() as { items?: Array<{ snippet: Record<string, unknown> }> };
      const videos: YoutubeChannelVideo[] = (data.items ?? []).flatMap(item => {
        const vid = (item.snippet.resourceId as { videoId?: string } | undefined)?.videoId;
        if (!vid) return [];
        return [{
          videoId: vid,
          title: String(item.snippet.title ?? ''),
          publishedAt: (item.snippet.publishedAt as string)?.slice(0, 10),
          url: `https://youtube.com/watch?v=${vid}`,
          ...(typeof item.snippet.description === 'string' && item.snippet.description.trim()
            ? { description: item.snippet.description.trim() } : {}),
        }];
      });
      if (videos.length > 0) {
        return { channelTitle: data.items?.[0]?.snippet?.channelTitle as string | undefined, videos };
      }
    }
    // Playlist nicht lesbar/leer → search-Fallback unten
  }
  const params = new URLSearchParams({
    part: 'snippet',
    channelId,
    type: 'video',
    order: 'date',
    maxResults: String(maxResults),
    key: apiKey,
  });
  const res = await fetch(`${YT_API_BASE}/search?${params}`);
  if (!res.ok) return { error: await ytErrorDetail(res) };
  const data = await res.json() as { items?: Array<{ id: { videoId: string }; snippet: Record<string, unknown> }> };
  const videos: YoutubeChannelVideo[] = (data.items ?? []).map(item => ({
    videoId: item.id.videoId,
    title: String(item.snippet.title ?? ''),
    publishedAt: (item.snippet.publishedAt as string)?.slice(0, 10),
    url: `https://youtube.com/watch?v=${item.id.videoId}`,
    ...(typeof item.snippet.description === 'string' && item.snippet.description.trim()
      ? { description: item.snippet.description.trim() } : {}),
  }));
  return { channelTitle: data.items?.[0]?.snippet?.channelTitle as string | undefined, videos };
}

/**
 * Transcript-Segmente via youtube-transcript (self-hosted Caption-Endpoints).
 *
 * v1050 — PLAIN-Import statt Deep-Path: youtube-transcript 1.3.x exportiert
 * `dist/youtube-transcript.esm.js` nicht mehr (ERR_PACKAGE_PATH_NOT_EXPORTED)
 * — der Transcript-Pfad war dadurch ÜBERALL still tot (Skill wie Collector,
 * live bewiesen 08.07.). Sprach-Kaskade: Wunschsprache → en → IRGENDEINE
 * verfügbare Sprache (Transcripts sind Fakten-Quelle; die Verdichtung bzw.
 * der Leser übersetzt ohnehin — besser Spanisch als gar nichts).
 */
export async function fetchYoutubeTranscriptSegments(
  videoId: string, lang: string,
): Promise<Array<{ text: string; offset: number; duration: number }> | null> {
  type Segment = { text: string; offset: number; duration: number };
  let fetchTranscript: (id: string, opts?: { lang?: string }) => Promise<Segment[]>;
  try {
    const mod = await (Function('return import("youtube-transcript")')() as Promise<Record<string, unknown>>);
    const api = (mod.YoutubeTranscript ?? (mod.default as Record<string, unknown> | undefined)?.YoutubeTranscript ?? mod) as { fetchTranscript?: (id: string, opts?: { lang?: string }) => Promise<Segment[]> };
    if (typeof api.fetchTranscript !== 'function') return null;
    fetchTranscript = api.fetchTranscript.bind(api);
  } catch {
    return null; // Lib nicht ladbar (Bundle-Kontext ohne Dependency)
  }
  const candidates: Array<string | undefined> = [...new Set([lang, 'en'])];
  candidates.push(undefined); // ohne lang = erste verfügbare Caption-Spur
  for (const tryLang of candidates) {
    try {
      const segments = await fetchTranscript(videoId, tryLang ? { lang: tryLang } : undefined);
      if (segments && segments.length > 0) {
        return segments.map(s => ({ text: s.text, offset: s.offset, duration: s.duration }));
      }
    } catch { /* nächste Sprache probieren */ }
  }
  return null;
}
